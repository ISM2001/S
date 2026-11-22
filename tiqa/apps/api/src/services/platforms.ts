import { normalizeMoroccanPhone, randomToken } from "@tiqa/core";
import type { Integration } from "@tiqa/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Deps } from "../deps";
import { ApiError, unauthorized } from "../lib/errors";
import { decrypt, encrypt } from "../lib/crypto";
import { audit } from "./audit";
import { performLookup, type ScoreResponse } from "./lookup";
import type { Network } from "./network";

/** Shared plumbing for e-commerce platform apps (Shopify, YouCan). */

// ── OAuth state (signed, httpOnly cookie; survives the round trip to the platform) ──
const OAUTH_COOKIE = "tiqa_oauth";
interface OAuthState { nonce: string; merchantId: string; userId: string; kind: "shopify" | "youcan"; shop?: string }

export function startOAuth(reply: FastifyReply, deps: Deps, state: Omit<OAuthState, "nonce">): string {
  const nonce = randomToken(16);
  reply.setCookie(OAUTH_COOKIE, JSON.stringify({ ...state, nonce }), {
    signed: true, httpOnly: true, sameSite: "lax", secure: deps.env.NODE_ENV === "production", path: "/", maxAge: 600,
  });
  return nonce;
}

export function finishOAuth(req: FastifyRequest, reply: FastifyReply, kind: OAuthState["kind"], stateParam: string | undefined): OAuthState {
  const raw = req.cookies[OAUTH_COOKIE];
  reply.clearCookie(OAUTH_COOKIE, { path: "/" });
  if (!raw) throw unauthorized("OAUTH_STATE_MISSING");
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) throw unauthorized("OAUTH_STATE_INVALID");
  const st = JSON.parse(unsigned.value) as OAuthState;
  if (st.kind !== kind) throw unauthorized("OAUTH_STATE_INVALID");
  // If the platform echoes `state`, it must match. (Shopify always does; for YouCan this is not documented, so the signed cookie is the main check.)
  if (stateParam !== undefined && stateParam !== st.nonce) throw unauthorized("OAUTH_STATE_INVALID");
  if (kind === "shopify" && stateParam === undefined) throw unauthorized("OAUTH_STATE_INVALID");
  return st;
}

// ── Tokens (encrypted at rest; refreshed before expiry) ──
export interface StoredToken { access_token: string; expires_at: number | null; refresh_token: string | null; refresh_expires_at: number | null }

export function sealToken(deps: Deps, t: { access_token: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number }): string {
  const now = Date.now();
  const stored: StoredToken = {
    access_token: t.access_token,
    expires_at: t.expires_in ? now + t.expires_in * 1000 : null,
    refresh_token: t.refresh_token ?? null,
    refresh_expires_at: t.refresh_token_expires_in ? now + t.refresh_token_expires_in * 1000 : null,
  };
  return encrypt(JSON.stringify(stored), deps.env.INTEGRATION_ENC_KEY);
}

export function openToken(deps: Deps, integ: Pick<Integration, "tokenEnc">): StoredToken | null {
  return integ.tokenEnc ? (JSON.parse(decrypt(integ.tokenEnc, deps.env.INTEGRATION_ENC_KEY)) as StoredToken) : null;
}

export async function httpJson<T>(deps: Deps, url: string, init: RequestInit & { timeoutMs?: number }): Promise<T> {
  const res = await (deps.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 5000) });
  const text = await res.text();
  if (!res.ok) throw new ApiError(502, "PLATFORM_HTTP_ERROR", "PLATFORM_HTTP_ERROR", { status: res.status, url: new URL(url).pathname });
  return (text ? JSON.parse(text) : {}) as T;
}

// ── Raw-body JSON parser (webhook signatures are computed over the exact bytes) ──
declare module "fastify" {
  interface FastifyRequest { rawBody?: string }
}
export function useRawJson(app: FastifyInstance) {
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1024 * 1024 }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      (e as { statusCode?: number }).statusCode = 400;
      done(e as Error, undefined);
    }
  });
}

/** Webhook deliveries can be retried by the platform: process each delivery id once. */
export async function firstDelivery(deps: Deps, kind: string, deliveryId: string | undefined): Promise<boolean> {
  if (!deliveryId) return true;
  const ok = await deps.redis.set(`tiqa:wh:${kind}:${deliveryId}`, "1", "EX", 86_400, "NX").catch(() => "OK");
  return ok === "OK";
}

/** Score an incoming platform order for the merchant who installed the app. */
export async function scorePlatformOrder(
  deps: Deps,
  network: Network,
  integ: Integration,
  order: { phone: string | null; orderRef: string | null },
  channel: "shopify" | "youcan",
): Promise<{ scored: false; reason: string } | { scored: true; response: ScoreResponse }> {
  const e164 = order.phone ? normalizeMoroccanPhone(order.phone) : null;
  if (!e164) {
    await audit(deps, { actor: { type: "integration", id: integ.id }, merchantId: integ.merchantId, action: `${channel}_order_skipped`, result: { reason: order.phone ? "invalid_phone" : "no_phone", order_ref: order.orderRef } });
    return { scored: false, reason: order.phone ? "invalid_phone" : "no_phone" };
  }
  try {
    const { response } = await performLookup(deps, network, {
      merchantId: integ.merchantId, actor: { type: "integration", id: integ.id }, e164, orderRef: order.orderRef, channel,
    });
    await deps.prisma.integration.update({ where: { id: integ.id }, data: { lastEventAt: new Date() } });
    return { scored: true, response };
  } catch (e) {
    if (e instanceof ApiError && e.statusCode === 429) return { scored: false, reason: "rate_limited" };
    if (e instanceof ApiError && e.statusCode === 402) return { scored: false, reason: "quota_exceeded" };
    throw e;
  }
}

export const firstString = (...vals: unknown[]): string | null => {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return null;
};
