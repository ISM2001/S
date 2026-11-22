import { normalizeMoroccanPhone } from "@tiqa/core";
import type { Integration } from "@tiqa/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import { ApiError, badRequest, unauthorized } from "../lib/errors";
import { hmacSha256, signatureMatches } from "../lib/crypto";
import { validate } from "../lib/validate";
import { audit } from "../services/audit";
import { requireRole, requireSession } from "../services/auth";
import type { Network } from "../services/network";
import {
  finishOAuth, firstDelivery, firstString, httpJson, openToken, scorePlatformOrder, sealToken, startOAuth, useRawJson,
} from "../services/platforms";

/**
 * Shopify app STUB (Phase 3). Based on shopify.dev docs as found via search on 2026-11-22. Re-check before the App Store review:
 *  - OAuth authorization-code grant, with `expiring=1` (new public apps must use expiring offline tokens: 1 h access, 90 d refresh).
 *  - Webhooks are declared in shopify.app.toml (see integrations/shopify/), verified with X-Shopify-Hmac-Sha256 (base64, raw body, app secret).
 *  - Reading the customer's phone needs "protected customer data" LEVEL 2 approval for public apps (review by Shopify).
 *  - Band written back as an order tag via the GraphQL `tagsAdd` mutation.
 */
export const SHOP_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
const TAG = { low: "tiqa-risque-faible", medium: "tiqa-risque-moyen", high: "tiqa-risque-eleve", insufficient_data: "tiqa-donnees-insuffisantes" } as const;
const COD_RE = /cash|cod\b|\(cod\)|livraison|paiement à la|الدفع عند/i;

export async function shopifyRoutes(app: FastifyInstance, { deps, network }: { deps: Deps; network: Network }) {
  const { prisma, env } = deps;
  const enabled = () => {
    if (!env.SHOPIFY_API_KEY || !env.SHOPIFY_API_SECRET) throw new ApiError(503, "SHOPIFY_NOT_CONFIGURED");
  };
  const adminUrl = (shop: string, path: string) => `https://${shop}/admin/${path}`;

  // 1. Install: started from the Tiqa dashboard (we know which merchant is connecting).
  app.get("/integrations/shopify/install", async (req, reply) => {
    enabled();
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const { shop } = validate(z.object({ shop: z.string().trim().toLowerCase() }), req.query);
    const domain = shop.includes(".") ? shop : `${shop}.myshopify.com`;
    if (!SHOP_RE.test(domain)) throw badRequest("SHOPIFY_SHOP_INVALID");
    const nonce = startOAuth(reply, deps, { merchantId: s.merchantId, userId: s.userId, kind: "shopify", shop: domain });
    const q = new URLSearchParams({
      client_id: env.SHOPIFY_API_KEY,
      scope: env.SHOPIFY_SCOPES,
      redirect_uri: `${env.API_PUBLIC_URL}/integrations/shopify/callback`,
      state: nonce,
    });
    return reply.redirect(adminUrl(domain, `oauth/authorize?${q}`));
  });

  // 2. Callback: verify HMAC + state + shop, exchange the code (expiring offline token).
  app.get("/integrations/shopify/callback", async (req, reply) => {
    enabled();
    const q = req.query as Record<string, string>;
    if (!verifyOAuthHmac(q, env.SHOPIFY_API_SECRET)) throw unauthorized("SHOPIFY_HMAC_INVALID");
    if (!q.shop || !SHOP_RE.test(q.shop) || !q.code) throw badRequest("SHOPIFY_CALLBACK_INVALID");
    const st = finishOAuth(req, reply, "shopify", q.state);
    if (st.shop !== q.shop) throw unauthorized("OAUTH_STATE_INVALID");

    const token = await httpJson<{ access_token: string; scope: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number }>(
      deps, adminUrl(q.shop, "oauth/access_token"),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: env.SHOPIFY_API_KEY, client_secret: env.SHOPIFY_API_SECRET, code: q.code, expiring: 1 }) },
    );
    const existing = await prisma.integration.findUnique({ where: { kind_externalId: { kind: "shopify", externalId: q.shop } } });
    if (existing && existing.merchantId !== st.merchantId) throw new ApiError(409, "SHOP_LINKED_TO_ANOTHER_ACCOUNT");
    const data = { tokenEnc: sealToken(deps, token), active: true };
    const integ = existing
      ? await prisma.integration.update({ where: { id: existing.id }, data })
      : await prisma.integration.create({ data: { ...data, merchantId: st.merchantId, kind: "shopify", externalId: q.shop, settings: { cod_only: true, tag_orders: true } } });
    await audit(deps, { actor: { type: "user", id: st.userId }, merchantId: st.merchantId, action: "shopify_connected", result: { integration_id: integ.id, shop: q.shop, scope: token.scope } });
    return reply.redirect(`${env.WEB_URL}/dashboard/integrations?connected=shopify`);
  });

  // 3. Settings (COD only / tag orders).
  app.patch("/app/integrations/shopify/:id", async (req) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const { id } = req.params as { id: string };
    const body = validate(z.object({ cod_only: z.boolean(), tag_orders: z.boolean() }), req.body);
    const { count } = await prisma.integration.updateMany({ where: { id, merchantId: s.merchantId, kind: "shopify" }, data: { settings: body } });
    if (!count) throw badRequest("NOT_FOUND");
    return { ok: true };
  });

  // 4. Webhooks (raw body for HMAC).
  await app.register(async (scope) => {
    useRawJson(scope);
    scope.post("/integrations/shopify/webhooks", async (req, reply) => {
      enabled();
      const sig = req.headers["x-shopify-hmac-sha256"] as string | undefined;
      if (!signatureMatches(sig, hmacSha256(env.SHOPIFY_API_SECRET, req.rawBody ?? ""))) return reply.code(401).send({ error: { code: "HMAC_INVALID" } });
      const topic = String(req.headers["x-shopify-topic"] ?? "");
      const shop = String(req.headers["x-shopify-shop-domain"] ?? "");
      if (!(await firstDelivery(deps, "shopify", req.headers["x-shopify-webhook-id"] as string | undefined))) return { ok: true, duplicate: true };
      const integ = await prisma.integration.findUnique({ where: { kind_externalId: { kind: "shopify", externalId: shop } } });
      const body = req.body as Record<string, any>;

      switch (topic) {
        case "orders/create":
          if (!integ?.active) return { ok: true, ignored: "not_connected" };
          return handleOrder(integ, body);
        case "app/uninstalled":
          if (integ) await prisma.integration.update({ where: { id: integ.id }, data: { active: false, tokenEnc: null } });
          return { ok: true };
        case "customers/data_request":
          // Tiqa keeps no Shopify customer profile: only pseudonymous delivery outcomes, viewable by the person on /consumer.
          await audit(deps, { actor: { type: "integration", id: integ?.id ?? null }, merchantId: integ?.merchantId, action: "shopify_customers_data_request", result: { shop } });
          return { ok: true };
        case "customers/redact": {
          if (integ) await redactCustomer(integ, body);
          return { ok: true };
        }
        case "shop/redact":
          if (integ) await prisma.integration.delete({ where: { id: integ.id } });
          await audit(deps, { actor: { type: "system", id: null }, merchantId: integ?.merchantId, action: "shopify_shop_redact", result: { shop } });
          return { ok: true };
        default:
          return { ok: true, ignored: topic };
      }
    });
  });

  async function handleOrder(integ: Integration, o: Record<string, any>) {
    const settings = (integ.settings ?? {}) as { cod_only?: boolean; tag_orders?: boolean };
    const gateways: string[] = Array.isArray(o.payment_gateway_names) ? o.payment_gateway_names : [];
    // COD detection by gateway name. TO VERIFY with real Moroccan stores (names vary by store/language).
    if (settings.cod_only !== false && !gateways.some((g) => COD_RE.test(g))) return { ok: true, ignored: "not_cod" };

    const gid: string | undefined = o.admin_graphql_api_id;
    let phone = firstString(o.phone, o.customer?.phone, o.shipping_address?.phone, o.billing_address?.phone);
    // Webhook payloads redact protected fields unless the app is approved; fall back to the Admin API.
    if (!phone && gid) phone = await fetchOrderPhone(integ, gid).catch(() => null);
    const orderRef = firstString(o.name, o.order_number != null ? String(o.order_number) : null, o.id != null ? String(o.id) : null);

    const r = await scorePlatformOrder(deps, network, integ, { phone, orderRef }, "shopify");
    if (!r.scored) return { ok: true, scored: false, reason: r.reason };
    let tagged = false;
    if (settings.tag_orders !== false && gid) tagged = await tagOrder(integ, gid, TAG[r.response.band]).catch(() => false);
    return { ok: true, scored: true, band: r.response.band, tagged };
  }

  async function accessToken(integ: Integration): Promise<string> {
    const t = openToken(deps, integ);
    if (!t) throw new ApiError(409, "SHOPIFY_NOT_CONNECTED");
    if (!t.expires_at || t.expires_at - 60_000 > Date.now()) return t.access_token;
    if (!t.refresh_token) throw new ApiError(409, "SHOPIFY_TOKEN_EXPIRED");
    const fresh = await httpJson<{ access_token: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number }>(
      deps, adminUrl(integ.externalId!, "oauth/access_token"),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: env.SHOPIFY_API_KEY, client_secret: env.SHOPIFY_API_SECRET, grant_type: "refresh_token", refresh_token: t.refresh_token }) },
    );
    await prisma.integration.update({ where: { id: integ.id }, data: { tokenEnc: sealToken(deps, fresh) } });
    return fresh.access_token;
  }

  async function graphql<T>(integ: Integration, query: string, variables: object): Promise<T> {
    const res = await httpJson<{ data?: T; errors?: unknown }>(deps, adminUrl(integ.externalId!, `api/${env.SHOPIFY_API_VERSION}/graphql.json`), {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": await accessToken(integ) },
      body: JSON.stringify({ query, variables }),
      timeoutMs: 4000,
    });
    if (!res.data) throw new ApiError(502, "SHOPIFY_GRAPHQL_ERROR");
    return res.data;
  }

  async function fetchOrderPhone(integ: Integration, gid: string) {
    // Field names TO VERIFY against the current Order object (some phone fields are being deprecated).
    const d = await graphql<{ order: { phone?: string; shippingAddress?: { phone?: string }; billingAddress?: { phone?: string } } | null }>(
      integ, "query($id: ID!) { order(id: $id) { phone shippingAddress { phone } billingAddress { phone } } }", { id: gid },
    );
    return firstString(d.order?.phone, d.order?.shippingAddress?.phone, d.order?.billingAddress?.phone);
  }

  async function tagOrder(integ: Integration, gid: string, tag: string) {
    const d = await graphql<{ tagsAdd: { userErrors: Array<{ message: string }> } }>(
      integ, "mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }", { id: gid, tags: [tag] },
    );
    return d.tagsAdd.userErrors.length === 0;
  }

  /** customers/redact: erase what THIS store contributed about the customer (the network keeps other stores' data). */
  async function redactCustomer(integ: Integration, body: Record<string, any>) {
    const e164 = normalizeMoroccanPhone(firstString(body.customer?.phone) ?? "");
    let deleted = 0;
    if (e164) {
      const hash = network.hash(e164);
      deleted = (await prisma.outcome.deleteMany({ where: { merchantId: integ.merchantId, phoneHash: hash } })).count;
      const lookups = await prisma.lookup.findMany({ where: { merchantId: integ.merchantId, phoneHash: hash }, select: { id: true } });
      const { randomBytes } = await import("node:crypto");
      for (const l of lookups) await prisma.lookup.update({ where: { id: l.id }, data: { phoneHash: randomBytes(32) } });
      await network.invalidate([hash]);
    }
    await audit(deps, { actor: { type: "integration", id: integ.id }, merchantId: integ.merchantId, action: "shopify_customers_redact", result: { outcomes_deleted: deleted, had_phone: !!e164 } });
  }
}

/** OAuth callback HMAC: drop `hmac`, sort the rest, join as k=v with &, HMAC-SHA256 (hex) with the app secret. */
export function verifyOAuthHmac(query: Record<string, string>, secret: string): boolean {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const msg = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("&");
  return signatureMatches(hmac, hmacSha256(secret, msg));
}
