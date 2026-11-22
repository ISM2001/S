import { normalizeMoroccanPhone, randomToken, sha256, mapOutcomeStatus } from "@tiqa/core";
import type { Prisma } from "@tiqa/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import { badRequest, notFound, unauthorized, forbidden } from "../lib/errors";
import { assertSafeOutboundUrl } from "../lib/ssrf";
import { validate } from "../lib/validate";
import { audit } from "../services/audit";
import { requireRole, requireSession } from "../services/auth";
import { extractOrder, type ExtractConfig } from "../services/extract";
import { performLookup } from "../services/lookup";
import type { Network } from "../services/network";
import { ingestOutcomes } from "../services/outcomes";
import { hit } from "../services/rate-limit";
import { attemptDelivery, newSigningSecret, OUTBOUND_EVENTS } from "../services/webhooks-out";

const Path = z.string().trim().max(120).regex(/^[\w.-]+$/).nullable().optional();

/**
 * Generic webhook (any store / no-code tool / confirmation tool):
 *  - INBOUND  POST /v1/hooks/:token  : secret URL, no headers needed (works from Google Sheets, n8n, Make, custom stores).
 *      payload with a delivery status (Livré, Refusé, delivered…) → recorded as an outcome
 *      otherwise                                               → scored, result returned in the response
 *  - OUTBOUND webhook endpoints: Tiqa POSTs signed events (score.created) to the merchant's system.
 */
export async function integrationRoutes(app: FastifyInstance, { deps, network }: { deps: Deps; network: Network }) {
  const { prisma, env } = deps;

  // ── Inbound ─────────────────────────────────────────────────────────────
  app.post("/v1/hooks/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    if (token.length < 20 || token.length > 100) throw unauthorized("INVALID_HOOK");
    const integ = await prisma.integration.findUnique({ where: { inboundTokenHash: sha256(token) }, include: { merchant: { select: { status: true } } } });
    if (!integ || !integ.active || integ.kind !== "generic") throw unauthorized("INVALID_HOOK");
    if (integ.merchant.status === "suspended") throw forbidden("MERCHANT_SUSPENDED");
    await hit(deps.redis, `hook:${integ.id}`, 600);

    const cfg = (integ.settings ?? {}) as ExtractConfig;
    const { phone, orderRef, status } = extractOrder(req.body, cfg);
    if (!phone) throw badRequest("PHONE_NOT_FOUND", { hint: "Send a `phone` field or configure phone_path." });
    const e164 = normalizeMoroccanPhone(phone);
    if (!e164) throw badRequest("INVALID_MOROCCAN_PHONE");
    void prisma.integration.update({ where: { id: integ.id }, data: { lastEventAt: new Date() } }).catch(() => undefined);
    const actor = { type: "integration" as const, id: integ.id };

    const outcome = status ? mapOutcomeStatus(status) : null;
    if (outcome && outcome !== "skip") {
      const res = await ingestOutcomes(deps, network, integ.merchantId, [{ e164, outcome, occurredAt: new Date(), carrier: null, cityCode: null, orderRef }], "merchant_manual");
      await audit(deps, { actor, merchantId: integ.merchantId, action: "outcome_submit", phoneHash: network.hash(e164), result: { outcome, via: "generic_hook", ...res } });
      return { type: "outcome", outcome, order_ref: orderRef, ...res };
    }
    const { response, rateRemaining } = await performLookup(deps, network, { merchantId: integ.merchantId, actor, e164, orderRef, channel: "webhook" });
    reply.header("x-ratelimit-remaining", rateRemaining);
    return { type: "score", order_ref: orderRef, ...response };
  });

  // ── Dashboard management ────────────────────────────────────────────────
  app.get("/app/integrations", async (req) => {
    const s = await requireSession(deps, req);
    const [integrations, endpoints] = await Promise.all([
      prisma.integration.findMany({ where: { merchantId: s.merchantId }, orderBy: { createdAt: "asc" } }),
      prisma.webhookEndpoint.findMany({ where: { merchantId: s.merchantId }, orderBy: { createdAt: "asc" } }),
    ]);
    const generic = integrations.find((i) => i.kind === "generic");
    const conn = (kind: "shopify" | "youcan") =>
      integrations.filter((i) => i.kind === kind).map((i) => ({ id: i.id, shop: i.externalId, active: i.active, last_event_at: i.lastEventAt, settings: i.settings }));
    return {
      generic: generic ? { configured: true, active: generic.active, settings: generic.settings, last_event_at: generic.lastEventAt } : { configured: false },
      endpoints: endpoints.map((e) => ({ id: e.id, url: e.url, events: e.events, active: e.active, failure_streak: e.failureStreak, created_at: e.createdAt })),
      shopify: { available: !!(env.SHOPIFY_API_KEY && env.SHOPIFY_API_SECRET), connections: conn("shopify") },
      youcan: { available: !!(env.YOUCAN_CLIENT_ID && env.YOUCAN_CLIENT_SECRET), connections: conn("youcan") },
      events: OUTBOUND_EVENTS,
    };
  });

  /** Create the generic inbound URL, or rotate its secret token. The URL is shown ONCE. */
  app.post("/app/integrations/generic", async (req) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const token = `hk_${randomToken(24)}`;
    const existing = await prisma.integration.findFirst({ where: { merchantId: s.merchantId, kind: "generic" } });
    if (existing) await prisma.integration.update({ where: { id: existing.id }, data: { inboundTokenHash: sha256(token), active: true } });
    else await prisma.integration.create({ data: { merchantId: s.merchantId, kind: "generic", inboundTokenHash: sha256(token) } });
    await audit(deps, { actor: { type: "user", id: s.userId }, merchantId: s.merchantId, action: existing ? "hook_rotate" : "hook_create" });
    return { url: `${env.API_PUBLIC_URL}/v1/hooks/${token}` };
  });

  app.patch("/app/integrations/generic", async (req) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const body = validate(z.object({ active: z.boolean().optional(), settings: z.object({ phone_path: Path, order_ref_path: Path, status_path: Path }).optional() }), req.body);
    const { count } = await prisma.integration.updateMany({
      where: { merchantId: s.merchantId, kind: "generic" },
      data: { ...(body.active !== undefined ? { active: body.active } : {}), ...(body.settings ? { settings: body.settings as Prisma.InputJsonObject } : {}) },
    });
    if (!count) throw notFound();
    return { ok: true };
  });

  app.delete("/app/integrations/:id", async (req) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const { id } = req.params as { id: string };
    const { count } = await prisma.integration.deleteMany({ where: { id, merchantId: s.merchantId } });
    if (!count) throw notFound();
    await audit(deps, { actor: { type: "user", id: s.userId }, merchantId: s.merchantId, action: "integration_delete", result: { id } });
    return { ok: true };
  });

  // ── Outbound endpoints ──────────────────────────────────────────────────
  app.post("/app/webhook-endpoints", async (req, reply) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const body = validate(z.object({ url: z.string().url().max(500), events: z.array(z.enum(OUTBOUND_EVENTS)).min(1).default(["score.created"]) }), req.body);
    await assertSafeOutboundUrl(body.url, env.NODE_ENV === "production");
    if ((await prisma.webhookEndpoint.count({ where: { merchantId: s.merchantId } })) >= 5) throw badRequest("TOO_MANY_ENDPOINTS");
    const { secret, secretEnc } = newSigningSecret(env.INTEGRATION_ENC_KEY);
    const ep = await prisma.webhookEndpoint.create({ data: { merchantId: s.merchantId, url: body.url, events: body.events, secretEnc } });
    await audit(deps, { actor: { type: "user", id: s.userId }, merchantId: s.merchantId, action: "webhook_endpoint_create", result: { id: ep.id } });
    reply.code(201);
    return { id: ep.id, url: ep.url, events: ep.events, secret }; // secret shown once
  });

  app.delete("/app/webhook-endpoints/:id", async (req) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const { id } = req.params as { id: string };
    const { count } = await prisma.webhookEndpoint.deleteMany({ where: { id, merchantId: s.merchantId } });
    if (!count) throw notFound();
    return { ok: true };
  });

  app.post("/app/webhook-endpoints/:id/test", async (req) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const { id } = req.params as { id: string };
    const ep = await prisma.webhookEndpoint.findFirst({ where: { id, merchantId: s.merchantId } });
    if (!ep) throw notFound();
    await prisma.webhookEndpoint.update({ where: { id }, data: { active: true, failureStreak: 0 } });
    const d = await prisma.webhookDelivery.create({ data: { endpointId: id, event: "ping", payload: { event: "ping", created_at: new Date().toISOString(), data: { message: "Tiqa test event" } } } });
    await attemptDelivery(deps, d.id);
    return prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id }, select: { id: true, status: true, responseStatus: true, lastError: true } });
  });

  app.get("/app/webhook-endpoints/:id/deliveries", async (req) => {
    const s = await requireSession(deps, req);
    const { id } = req.params as { id: string };
    const ep = await prisma.webhookEndpoint.findFirst({ where: { id, merchantId: s.merchantId }, select: { id: true } });
    if (!ep) throw notFound();
    return prisma.webhookDelivery.findMany({
      where: { endpointId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, event: true, status: true, attempts: true, responseStatus: true, lastError: true, createdAt: true, deliveredAt: true },
    });
  });

}
