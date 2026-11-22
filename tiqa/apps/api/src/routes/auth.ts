import { randomToken, sha256 } from "@tiqa/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import { ApiError, unauthorized } from "../lib/errors";
import { validate } from "../lib/validate";
import { audit } from "../services/audit";
import { createSession, destroySession, hashPassword, MAGIC_LINK_MINUTES, verifyPassword } from "../services/auth";
import { hit } from "../services/rate-limit";

export const TERMS_VERSION = "2026-11-draft";

const Email = z.string().trim().toLowerCase().email().max(200);
const Locale = z.enum(["fr", "ar"]);

const Signup = z.object({
  email: Email,
  password: z.string().min(10).max(200),
  merchantName: z.string().trim().min(2).max(120),
  locale: Locale.default("fr"),
  /** Must be true: merchant terms incl. the duty to inform customers about data sharing. */
  acceptTerms: z.literal(true),
});
const Login = z.object({ email: Email, password: z.string().min(1).max(200) });
const MagicRequest = z.object({ email: Email });
const MagicVerify = z.object({ token: z.string().min(20).max(200) });

export async function authRoutes(app: FastifyInstance, { deps }: { deps: Deps }) {
  const ipLimit = (req: { ip: string }, what: string, limit: number) => hit(deps.redis, `auth:${what}:${req.ip}`, limit);

  app.post("/app/auth/signup", async (req, reply) => {
    await ipLimit(req, "signup", 10);
    const body = validate(Signup, req.body);
    const exists = await deps.prisma.user.findUnique({ where: { email: body.email } });
    if (exists) throw new ApiError(409, "EMAIL_TAKEN");

    const passwordHash = await hashPassword(body.password);
    const freePlan = await deps.prisma.plan.findUnique({ where: { code: "free" } });
    const user = await deps.prisma.$transaction(async (tx) => {
      const merchant = await tx.merchant.create({
        data: { name: body.merchantName, termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION },
      });
      if (freePlan) await tx.subscription.create({ data: { merchantId: merchant.id, planId: freePlan.id } });
      return tx.user.create({
        data: {
          email: body.email,
          passwordHash,
          locale: body.locale,
          memberships: { create: { merchantId: merchant.id, role: "owner" } },
        },
      });
    });
    await createSession(deps, reply, user.id);
    reply.code(201);
    return { ok: true };
  });

  app.post("/app/auth/login", async (req, reply) => {
    await ipLimit(req, "login", 20);
    const body = validate(Login, req.body);
    await hit(deps.redis, `auth:login-email:${sha256(body.email).toString("hex")}`, 10);
    const user = await deps.prisma.user.findUnique({ where: { email: body.email } });
    // Same error whether the email exists or not.
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, body.password))) throw unauthorized("INVALID_CREDENTIALS");
    await createSession(deps, reply, user.id);
    return { ok: true };
  });

  app.post("/app/auth/magic-link", async (req) => {
    await ipLimit(req, "magic", 10);
    const { email } = validate(MagicRequest, req.body);
    const user = await deps.prisma.user.findUnique({ where: { email } });
    if (user) {
      const token = randomToken(32);
      await deps.prisma.magicLink.create({
        data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + MAGIC_LINK_MINUTES * 60_000) },
      });
      const url = `${deps.env.WEB_URL}/auth/magic?token=${encodeURIComponent(token)}`;
      const ar = user.locale === "ar";
      await deps.mailer.send({
        to: user.email,
        subject: ar ? "رابط الدخول إلى Tiqa" : "Votre lien de connexion Tiqa",
        text: ar
          ? `مرحبا،\n\nاضغط هنا باش تدخل لـ Tiqa (صالح لمدة ${MAGIC_LINK_MINUTES} دقيقة):\n${url}\n\nإلا ما طلبتيش هاد الرابط، تجاهل هاد الرسالة.`
          : `Bonjour,\n\nCliquez ici pour vous connecter à Tiqa (valable ${MAGIC_LINK_MINUTES} minutes) :\n${url}\n\nSi vous n'avez pas demandé ce lien, ignorez ce message.`,
      });
    }
    // Always the same response (no account enumeration).
    return { ok: true };
  });

  app.post("/app/auth/magic-link/verify", async (req, reply) => {
    await ipLimit(req, "magic-verify", 20);
    const { token } = validate(MagicVerify, req.body);
    // Atomic single use: only one request can flip usedAt from null.
    const link = await deps.prisma.magicLink.findUnique({ where: { tokenHash: sha256(token) } });
    if (!link || link.usedAt || link.expiresAt < new Date()) throw unauthorized("MAGIC_LINK_INVALID");
    const { count } = await deps.prisma.magicLink.updateMany({ where: { id: link.id, usedAt: null }, data: { usedAt: new Date() } });
    if (count !== 1) throw unauthorized("MAGIC_LINK_INVALID");
    await deps.prisma.user.update({ where: { id: link.userId }, data: { emailVerifiedAt: new Date() } });
    await createSession(deps, reply, link.userId);
    await audit(deps, { actor: { type: "user", id: link.userId }, action: "login_magic_link" });
    return { ok: true };
  });

  app.post("/app/auth/logout", async (req, reply) => {
    await destroySession(deps, req, reply);
    return { ok: true };
  });
}
