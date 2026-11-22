import type { Integration } from "@tiqa/db";
import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps";
import { ApiError, unauthorized } from "../lib/errors";
import { hmacSha256, signatureMatches } from "../lib/crypto";
import { audit } from "../services/audit";
import { requireRole, requireSession } from "../services/auth";
import type { Network } from "../services/network";
import { finishOAuth, firstDelivery, firstString, httpJson, openToken, scorePlatformOrder, sealToken, startOAuth, useRawJson } from "../services/platforms";

/**
 * YouCan app (Phase 3). ONLY endpoints found in YouCan's official developer docs (via search, 2026-11-22):
 *   authorize  https://seller-area.youcan.shop/admin/oauth/authorize   (scopes as repeated scope[] params)
 *   token      POST https://api.youcan.shop/oauth/token                 (authorization_code / refresh_token)
 *   subscribe  POST https://api.youcan.shop/resthooks/subscribe         {event, target_url}, scope edit-rest-hooks
 *   order      GET  https://api.youcan.shop/orders/{id}?include=…       scope read-orders
 *   webhook    POST envelope {event_name, event_happened_at, data}; X-YOUCAN-SIGNATURE = HMAC-SHA256(raw body, client secret);
 *              X-YOUCAN-DELIVERY-ID is stable across retries.
 * NOT FOUND in the docs → not implemented: writing a tag/note back on the order, the exact phone field on the order
 * object (we try several paths, then GET the order with include=customer,shipping), the signature encoding (hex vs
 * base64: both accepted), whether `state` is echoed back on the OAuth callback (a signed cookie protects the flow).
 */
const API = "https://api.youcan.shop";
const AUTHORIZE = "https://seller-area.youcan.shop/admin/oauth/authorize";

export async function youcanRoutes(app: FastifyInstance, { deps, network }: { deps: Deps; network: Network }) {
  const { prisma, env } = deps;
  const enabled = () => {
    if (!env.YOUCAN_CLIENT_ID || !env.YOUCAN_CLIENT_SECRET) throw new ApiError(503, "YOUCAN_NOT_CONFIGURED");
  };
  const redirectUri = () => `${env.API_PUBLIC_URL}/integrations/youcan/callback`;

  app.get("/integrations/youcan/install", async (req, reply) => {
    enabled();
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const nonce = startOAuth(reply, deps, { merchantId: s.merchantId, userId: s.userId, kind: "youcan" });
    const q = new URLSearchParams({ client_id: env.YOUCAN_CLIENT_ID, redirect_uri: redirectUri(), response_type: "code", state: nonce });
    for (const sc of env.YOUCAN_SCOPES.split(",").map((x) => x.trim()).filter(Boolean)) q.append("scope[]", sc);
    return reply.redirect(`${AUTHORIZE}?${q}`);
  });

  app.get("/integrations/youcan/callback", async (req, reply) => {
    enabled();
    const q = req.query as Record<string, string>;
    if (!q.code) throw unauthorized("YOUCAN_CALLBACK_INVALID");
    const st = finishOAuth(req, reply, "youcan", q.state);
    const token = await exchange({ grant_type: "authorization_code", code: q.code, redirect_uri: redirectUri() });

    // Webhooks are routed by integration id in the target URL (the documented payload doesn't identify the store).
    const integ = await prisma.integration.create({
      data: { merchantId: st.merchantId, kind: "youcan", tokenEnc: sealToken(deps, token), settings: {} },
    });
    const target = `${env.API_PUBLIC_URL}/integrations/youcan/webhooks/${integ.id}`;
    let subscription: unknown = null;
    try {
      subscription = await httpJson(deps, `${API}/resthooks/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token.access_token}` },
        body: JSON.stringify({ event: "order.created", target_url: target }),
      });
    } catch (e) {
      await prisma.integration.update({ where: { id: integ.id }, data: { settings: { subscription_error: (e as ApiError).code ?? "error" } } });
    }
    await audit(deps, { actor: { type: "user", id: st.userId }, merchantId: st.merchantId, action: "youcan_connected", result: { integration_id: integ.id, subscribed: !!subscription } });
    return reply.redirect(`${env.WEB_URL}/dashboard/integrations?connected=youcan`);
  });

  await app.register(async (scope) => {
    useRawJson(scope);
    scope.post("/integrations/youcan/webhooks/:id", async (req, reply) => {
      enabled();
      if (!signatureMatches(req.headers["x-youcan-signature"] as string | undefined, hmacSha256(env.YOUCAN_CLIENT_SECRET, req.rawBody ?? ""))) {
        return reply.code(401).send({ error: { code: "SIGNATURE_INVALID" } });
      }
      if (!(await firstDelivery(deps, "youcan", req.headers["x-youcan-delivery-id"] as string | undefined))) return { ok: true, duplicate: true };
      const { id } = req.params as { id: string };
      const integ = await prisma.integration.findFirst({ where: { id, kind: "youcan" } });
      if (!integ?.active) return { ok: true, ignored: "not_connected" };

      const body = req.body as { event_name?: string; data?: Record<string, any> };
      const event = body.event_name ?? (req.headers["x-youcan-topic"] as string | undefined);
      if (event === "app.uninstalled") {
        await prisma.integration.update({ where: { id: integ.id }, data: { active: false, tokenEnc: null } });
        return { ok: true };
      }
      if (event !== "order.created" && event !== "order.create") return { ok: true, ignored: event };

      const o = body.data ?? {};
      let phone = phoneFromOrder(o);
      if (!phone && o.id) phone = await fetchOrderPhone(integ, String(o.id)).catch(() => null);
      const r = await scorePlatformOrder(deps, network, integ, { phone, orderRef: firstString(o.ref, o.id != null ? String(o.id) : null) }, "youcan");
      return r.scored ? { ok: true, scored: true, band: r.response.band } : { ok: true, scored: false, reason: r.reason };
    });
  });

  async function exchange(params: Record<string, string>) {
    return httpJson<{ access_token: string; refresh_token?: string; expires_in?: number }>(deps, `${API}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ ...params, client_id: env.YOUCAN_CLIENT_ID, client_secret: env.YOUCAN_CLIENT_SECRET }),
    });
  }

  async function accessToken(integ: Integration) {
    const t = openToken(deps, integ);
    if (!t) throw new ApiError(409, "YOUCAN_NOT_CONNECTED");
    if (!t.expires_at || t.expires_at - 60_000 > Date.now()) return t.access_token;
    if (!t.refresh_token) throw new ApiError(409, "YOUCAN_TOKEN_EXPIRED");
    const fresh = await exchange({ grant_type: "refresh_token", refresh_token: t.refresh_token });
    await prisma.integration.update({ where: { id: integ.id }, data: { tokenEnc: sealToken(deps, fresh) } });
    return fresh.access_token;
  }

  async function fetchOrderPhone(integ: Integration, orderId: string) {
    const o = await httpJson<Record<string, any>>(deps, `${API}/orders/${encodeURIComponent(orderId)}?include=customer,shipping,payment`, {
      headers: { authorization: `Bearer ${await accessToken(integ)}`, accept: "application/json" },
    });
    return phoneFromOrder(o);
  }

  // Disconnect (also from the generic DELETE /app/integrations/:id). Kept here for symmetry with install.
  app.post("/app/integrations/youcan/:id/disconnect", async (req) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const { id } = req.params as { id: string };
    await prisma.integration.updateMany({ where: { id, merchantId: s.merchantId, kind: "youcan" }, data: { active: false, tokenEnc: null } });
    return { ok: true };
  });
}

/** Phone location on a YouCan order is not precisely documented: try the plausible places. */
export function phoneFromOrder(o: Record<string, any>): string | null {
  const addr = (x: unknown) => (Array.isArray(x) ? x[0] : x) as Record<string, any> | undefined;
  return firstString(
    o.customer?.phone,
    o.customer?.data?.phone,
    addr(o.shipping?.address)?.phone,
    addr(o.shipping?.data?.address)?.phone,
    addr(o.payment?.address)?.phone,
    o.phone,
  );
}
