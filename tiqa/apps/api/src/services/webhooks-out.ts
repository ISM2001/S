import { randomBytes } from "node:crypto";
import type { Prisma } from "@tiqa/db";
import type { Deps } from "../deps";
import { decrypt, encrypt, hmacSha256 } from "../lib/crypto";
import { assertSafeOutboundUrl } from "../lib/ssrf";

export const OUTBOUND_EVENTS = ["score.created"] as const;
export type OutboundEvent = (typeof OUTBOUND_EVENTS)[number] | "ping";

/** Retry schedule after a failed attempt (then the delivery is marked failed). */
const BACKOFF_S = [60, 300, 1800, 7200, 21600, 86400];
const TIMEOUT_MS = 10_000;
const DISABLE_AFTER_FAILURES = 100;

export function newSigningSecret(keyHex: string) {
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  return { secret, secretEnc: encrypt(secret, keyHex) };
}

/**
 * Signature header, Stripe-style:  Tiqa-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 * Receivers should reject timestamps older than 5 minutes (replay protection).
 */
export function signPayload(secret: string, body: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${hmacSha256(secret, `${t}.${body}`).toString("hex")}`;
}

/** Queue an event for every active endpoint of the merchant subscribed to it, then try to deliver right away. */
export async function emitEvent(deps: Deps, merchantId: string, event: OutboundEvent, data: Prisma.InputJsonObject) {
  const endpoints = await deps.prisma.webhookEndpoint.findMany({
    where: { merchantId, active: true, ...(event === "ping" ? {} : { events: { has: event } }) },
    select: { id: true },
  });
  if (!endpoints.length) return [];
  const created = await Promise.all(
    endpoints.map((e) =>
      deps.prisma.webhookDelivery.create({
        data: { endpointId: e.id, event, payload: { event, created_at: new Date().toISOString(), data } },
        select: { id: true },
      }),
    ),
  );
  // Fire-and-forget first attempt; the worker retries failures.
  for (const d of created) void attemptDelivery(deps, d.id).catch(() => undefined);
  return created.map((d) => d.id);
}

export async function attemptDelivery(deps: Deps, deliveryId: string) {
  const { prisma, env } = deps;
  const d = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { endpoint: true } });
  if (!d || d.status !== "pending" || !d.endpoint.active) return;

  const body = JSON.stringify({ id: d.id, ...(d.payload as object) });
  let status: number | null = null;
  let error: string | null = null;
  try {
    await assertSafeOutboundUrl(d.endpoint.url, env.NODE_ENV === "production");
    const secret = decrypt(d.endpoint.secretEnc, env.INTEGRATION_ENC_KEY);
    const res = await (deps.fetch ?? fetch)(d.endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Tiqa-Webhooks/1",
        "tiqa-event": d.event,
        "tiqa-delivery-id": d.id,
        "tiqa-signature": signPayload(secret, body),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (e) {
    error = (e as Error).message.slice(0, 200);
  }

  const attempts = d.attempts + 1;
  if (!error) {
    await prisma.$transaction([
      prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: "delivered", attempts, responseStatus: status, deliveredAt: new Date(), lastError: null } }),
      prisma.webhookEndpoint.update({ where: { id: d.endpointId }, data: { failureStreak: 0 } }),
    ]);
    return;
  }
  const delay = BACKOFF_S[attempts - 1];
  await prisma.webhookDelivery.update({
    where: { id: d.id },
    data: {
      attempts,
      responseStatus: status,
      lastError: error,
      status: delay === undefined ? "failed" : "pending",
      nextAttemptAt: new Date(Date.now() + (delay ?? 0) * 1000),
    },
  });
  const ep = await prisma.webhookEndpoint.update({ where: { id: d.endpointId }, data: { failureStreak: { increment: 1 } } });
  if (ep.failureStreak >= DISABLE_AFTER_FAILURES) await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { active: false } });
}

/** Worker job: retry due deliveries. */
export async function retryDueDeliveries(deps: Deps, limit = 200) {
  const due = await deps.prisma.webhookDelivery.findMany({
    // attempts = 0 rows are normally handled by the immediate attempt; pick them up only if that never happened.
    where: { status: "pending", nextAttemptAt: { lte: new Date() }, OR: [{ attempts: { gt: 0 } }, { createdAt: { lt: new Date(Date.now() - 60_000) } }] },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const d of due) await attemptDelivery(deps, d.id);
  return { retried: due.length };
}
