import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { parseApiKey, randomToken, safeEqual, sha256 } from "@tiqa/core";
import type { Role } from "@tiqa/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Deps } from "../deps";
import { forbidden, unauthorized } from "../lib/errors";

export const SESSION_COOKIE = "tiqa_session";
const SESSION_DAYS = 30;
export const MAGIC_LINK_MINUTES = 15;

export const hashPassword = (pw: string) => argonHash(pw); // argon2id defaults
export const verifyPassword = async (hash: string, pw: string) => {
  try {
    return await argonVerify(hash, pw);
  } catch {
    return false;
  }
};

// ── Sessions ──────────────────────────────────────────────────────────────

export async function createSession(deps: Deps, reply: FastifyReply, userId: string) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await deps.prisma.session.create({ data: { idHash: sha256(token), userId, expiresAt } });
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: deps.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(deps: Deps, req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await deps.prisma.session.deleteMany({ where: { idHash: sha256(token) } });
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export interface SessionContext {
  userId: string;
  email: string;
  locale: string;
  isStaff: boolean;
  merchantId: string;
  merchantName: string;
  role: Role;
}

export async function requireSession(deps: Deps, req: FastifyRequest): Promise<SessionContext> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) throw unauthorized();
  const session = await deps.prisma.session.findUnique({
    where: { idHash: sha256(token) },
    include: { user: { include: { memberships: { include: { merchant: true }, orderBy: { createdAt: "asc" }, take: 1 } } } },
  });
  if (!session || session.expiresAt < new Date()) throw unauthorized("SESSION_EXPIRED");
  const m = session.user.memberships[0];
  if (!m) throw forbidden("NO_MERCHANT");
  if (m.merchant.status === "suspended") throw forbidden("MERCHANT_SUSPENDED");
  return {
    userId: session.user.id,
    email: session.user.email,
    locale: session.user.locale,
    isStaff: session.user.isStaff,
    merchantId: m.merchantId,
    merchantName: m.merchant.name,
    role: m.role,
  };
}

export function requireRole(ctx: SessionContext, roles: Role[]) {
  if (!roles.includes(ctx.role)) throw forbidden("INSUFFICIENT_ROLE");
}

// ── API keys ──────────────────────────────────────────────────────────────

export interface ApiKeyContext {
  apiKeyId: string;
  merchantId: string;
  scopes: string[];
}

export async function requireApiKey(deps: Deps, req: FastifyRequest, scope: string): Promise<ApiKeyContext> {
  const header = req.headers.authorization ?? "";
  const raw = header.startsWith("Bearer ") ? header.slice(7) : (req.headers["x-api-key"] as string | undefined) ?? "";
  const parsed = parseApiKey(raw);
  if (!parsed) throw unauthorized("INVALID_API_KEY");

  const key = await deps.prisma.apiKey.findUnique({
    where: { prefix: parsed.prefix },
    include: { merchant: { select: { status: true } } },
  });
  if (!key || key.revokedAt || !safeEqual(sha256(parsed.secret), Buffer.from(key.secretHash))) throw unauthorized("INVALID_API_KEY");
  if (key.merchant.status === "suspended") throw forbidden("MERCHANT_SUSPENDED");
  if (!key.scopes.includes(scope)) throw forbidden("MISSING_SCOPE");

  // Throttle last-used writes to once a minute per key.
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
    void deps.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  return { apiKeyId: key.id, merchantId: key.merchantId, scopes: key.scopes };
}
