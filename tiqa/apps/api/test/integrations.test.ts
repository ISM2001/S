import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hmacSha256 } from "../src/lib/crypto";
import { retryDueDeliveries } from "../src/services/webhooks-out";
import { cookieFrom, createMerchant, setupTestApp, signup } from "./helpers";

const ctx = setupTestApp({ SHOPIFY_API_KEY: "shp_key", SHOPIFY_API_SECRET: "shp_secret", YOUCAN_CLIENT_ID: "yc_id", YOUCAN_CLIENT_SECRET: "yc_secret" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── A local receiver for outbound webhooks ──────────────────────────────────
const received: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];
let receiverStatus = 200;
const receiver = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    res.statusCode = receiverStatus;
    res.end("ok");
  });
});
let receiverUrl = "";
beforeAll(async () => {
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;
});
afterAll(() => receiver.close());

/** Mock platform HTTP: records calls and answers from a route table. */
function mockFetch(routes: Record<string, (body: any, init: RequestInit) => unknown>) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  ctx.deps.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, headers: (init.headers ?? {}) as Record<string, string> });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]!(body, init)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

async function historyFor(phone: string) {
  const [a, b] = [await createMerchant(ctx, "Hist A"), await createMerchant(ctx, "Hist B")];
  for (const [m, r] of [[a, "1"], [a, "2"], [b, "1"]] as const) {
    await ctx.app.inject({ method: "POST", url: "/v1/outcomes", headers: m.auth, payload: { phone, outcome: "refused", order_ref: r } });
  }
}

describe("generic webhook (inbound)", () => {
  it("scores an order sent to the secret URL and records a status update as an outcome", async () => {
    const { cookie } = await signup(ctx);
    await historyFor("0644445555");
    const created = await ctx.app.inject({ method: "POST", url: "/app/integrations/generic", headers: { cookie } });
    const url: string = created.json().url;
    expect(url).toMatch(/^https:\/\/tiqa\.test\/api\/v1\/hooks\/hk_/);
    const path = new URL(url).pathname.replace("/api", "");

    const scored = await ctx.app.inject({ method: "POST", url: path, payload: { order: { id: "WEB-1", customer: { phone: "06 44 44 55 55" } } } });
    expect(scored.statusCode).toBe(200);
    expect(scored.json()).toMatchObject({ type: "score", order_ref: "WEB-1", band: "high" });
    const lookup = await ctx.prisma.lookup.findFirstOrThrow({ where: { merchantOrderRef: "WEB-1" } });
    expect(lookup.channel).toBe("webhook");

    const outcome = await ctx.app.inject({ method: "POST", url: path, payload: { order_id: "WEB-1", phone: "0644445555", status: "Refusé" } });
    expect(outcome.json()).toMatchObject({ type: "outcome", outcome: "refused", inserted: 1 });
    expect(await ctx.prisma.auditLog.count({ where: { actorType: "integration" } })).toBe(2);
  });

  it("custom field paths, bad token, missing phone, rotation", async () => {
    const { cookie } = await signup(ctx);
    const path1 = new URL((await ctx.app.inject({ method: "POST", url: "/app/integrations/generic", headers: { cookie } })).json().url).pathname.replace("/api", "");
    await ctx.app.inject({ method: "PATCH", url: "/app/integrations/generic", headers: { cookie }, payload: { settings: { phone_path: "client.gsm", order_ref_path: "cmd" } } });
    const r = await ctx.app.inject({ method: "POST", url: path1, payload: { client: { gsm: "0612345678" }, cmd: 77 } });
    expect(r.json()).toMatchObject({ type: "score", order_ref: "77" });
    expect((await ctx.app.inject({ method: "POST", url: path1, payload: { foo: 1 } })).json().error.code).toBe("PHONE_NOT_FOUND");
    expect((await ctx.app.inject({ method: "POST", url: "/v1/hooks/hk_" + "x".repeat(30), payload: {} })).statusCode).toBe(401);
    // Rotating invalidates the old URL.
    await ctx.app.inject({ method: "POST", url: "/app/integrations/generic", headers: { cookie } });
    expect((await ctx.app.inject({ method: "POST", url: path1, payload: { phone: "0612345678" } })).statusCode).toBe(401);
  });
});

describe("outbound webhooks", () => {
  it("delivers signed score.created events without any phone number", async () => {
    received.length = 0;
    receiverStatus = 200;
    const { cookie } = await signup(ctx);
    const ep = await ctx.app.inject({ method: "POST", url: "/app/webhook-endpoints", headers: { cookie }, payload: { url: receiverUrl, events: ["score.created"] } });
    expect(ep.statusCode).toBe(201);
    const secret: string = ep.json().secret;
    expect(secret).toMatch(/^whsec_/);
    expect(JSON.stringify(await ctx.prisma.webhookEndpoint.findMany())).not.toContain(secret);

    await ctx.app.inject({ method: "POST", url: "/app/lookup", headers: { cookie }, payload: { phone: "0612345678", order_ref: "CMD-5" } });
    for (let i = 0; i < 50 && !received.length; i++) await sleep(20);
    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(headers["tiqa-event"]).toBe("score.created");
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(headers["tiqa-signature"]))!;
    expect(v1).toBe(hmacSha256(secret, `${t}.${body}`).toString("hex"));
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ event: "score.created", data: { order_ref: "CMD-5", band: "insufficient_data", channel: "dashboard" } });
    expect(body).not.toContain("612345678");

    // test ping
    const ping = await ctx.app.inject({ method: "POST", url: `/app/webhook-endpoints/${ep.json().id}/test`, headers: { cookie } });
    expect(ping.json()).toMatchObject({ status: "delivered", responseStatus: 200 });
  });

  it("retries failed deliveries with backoff", async () => {
    received.length = 0;
    receiverStatus = 500;
    const { cookie } = await signup(ctx);
    await ctx.app.inject({ method: "POST", url: "/app/webhook-endpoints", headers: { cookie }, payload: { url: receiverUrl } });
    await ctx.app.inject({ method: "POST", url: "/app/lookup", headers: { cookie }, payload: { phone: "0612345678" } });
    let d;
    for (let i = 0; i < 50; i++) {
      d = await ctx.prisma.webhookDelivery.findFirst();
      if (d?.attempts) break;
      await sleep(20);
    }
    expect(d).toMatchObject({ status: "pending", attempts: 1, responseStatus: 500 });
    expect(d!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50_000);

    receiverStatus = 200;
    await ctx.prisma.webhookDelivery.updateMany({ data: { nextAttemptAt: new Date() } });
    expect(await retryDueDeliveries(ctx.deps)).toEqual({ retried: 1 });
    expect(await ctx.prisma.webhookDelivery.findFirstOrThrow()).toMatchObject({ status: "delivered", attempts: 2 });
    const list = await ctx.app.inject({ method: "GET", url: `/app/webhook-endpoints/${d!.endpointId}/deliveries`, headers: { cookie } });
    expect(list.json()[0]).toMatchObject({ status: "delivered" });
  });

  it("members cannot manage endpoints; invalid URLs rejected", async () => {
    const { cookie } = await signup(ctx);
    expect((await ctx.app.inject({ method: "POST", url: "/app/webhook-endpoints", headers: { cookie }, payload: { url: "notaurl" } })).statusCode).toBe(400);
    await ctx.prisma.membership.updateMany({ data: { role: "member" } });
    expect((await ctx.app.inject({ method: "POST", url: "/app/webhook-endpoints", headers: { cookie }, payload: { url: receiverUrl } })).statusCode).toBe(403);
  });
});

describe("saved CSV mappings", () => {
  it("remembers the column mapping per file layout", async () => {
    const { cookie } = await signup(ctx);
    const csv = "Ref Colis;GSM Client;Etat Final\nX1;0600000201;LIVRE\n";
    const p1 = (await ctx.app.inject({ method: "POST", url: "/app/outcomes/csv/preview", headers: { cookie }, payload: { csv } })).json();
    expect(p1.mapping_source).toBe("guessed");
    const mapping = { phone: "GSM Client", status: "Etat Final", order_ref: "Ref Colis" };
    await ctx.app.inject({ method: "POST", url: "/app/outcomes/csv", headers: { cookie }, payload: { csv, mapping, source_type: "carrier_export", default_carrier: "Ozon" } });
    const p2 = (await ctx.app.inject({ method: "POST", url: "/app/outcomes/csv/preview", headers: { cookie }, payload: { csv: "Etat Final;Ref Colis;GSM Client\nLIVRE;X2;0600000202\n" } })).json();
    expect(p2).toMatchObject({ mapping_source: "saved", suggested_mapping: mapping, source_type: "carrier_export", default_carrier: "Ozon" });
    const tpl = await ctx.app.inject({ method: "GET", url: "/app/outcomes/csv/template", headers: { cookie } });
    expect(tpl.headers["content-type"]).toMatch(/text\/csv/);
    expect(tpl.body).toContain("Téléphone");
  });
});

// ── Shopify ─────────────────────────────────────────────────────────────────
const SHOP = "demo-store.myshopify.com";
function shopifyWebhook(topic: string, payload: object, opts: { secret?: string; id?: string } = {}) {
  const body = JSON.stringify(payload);
  return ctx.app.inject({
    method: "POST", url: "/integrations/shopify/webhooks", payload: body,
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": SHOP,
      "x-shopify-webhook-id": opts.id ?? crypto.randomUUID(),
      "x-shopify-hmac-sha256": hmacSha256(opts.secret ?? "shp_secret", body).toString("base64"),
    },
  });
}

async function connectShopify(expiresIn = 3600) {
  const { cookie } = await signup(ctx);
  const install = await ctx.app.inject({ method: "GET", url: `/integrations/shopify/install?shop=demo-store`, headers: { cookie } });
  expect(install.statusCode).toBe(302);
  const loc = new URL(install.headers.location as string);
  expect(loc.origin + loc.pathname).toBe(`https://${SHOP}/admin/oauth/authorize`);
  expect(loc.searchParams.get("client_id")).toBe("shp_key");
  expect(loc.searchParams.get("redirect_uri")).toBe("https://tiqa.test/api/integrations/shopify/callback");
  const state = loc.searchParams.get("state")!;
  const oauthCookie = cookieFrom(install.headers["set-cookie"]);

  const calls = mockFetch({
    "/admin/oauth/access_token": () => ({ access_token: "shpat_1", scope: "read_orders,write_orders", expires_in: expiresIn, refresh_token: "shprt_1", refresh_token_expires_in: 7776000 }),
    "/graphql.json": (b) => (b.query.includes("tagsAdd") ? { data: { tagsAdd: { userErrors: [] } } } : { data: { order: { phone: null, shippingAddress: { phone: "0655556666" }, billingAddress: null } } }),
  });
  const q: Record<string, string> = { code: "abc", shop: SHOP, state, timestamp: "1700000000" };
  q.hmac = hmacSha256("shp_secret", Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join("&")).toString("hex");
  const cb = await ctx.app.inject({ method: "GET", url: `/integrations/shopify/callback?${new URLSearchParams(q)}`, headers: { cookie: oauthCookie } });
  expect(cb.statusCode).toBe(302);
  expect(cb.headers.location).toBe("http://localhost:3000/dashboard/integrations?connected=shopify");
  return { cookie, calls };
}

describe("Shopify app", () => {
  it("OAuth: token exchanged with expiring=1 and stored encrypted", async () => {
    const { calls } = await connectShopify();
    expect(calls[0]!.body).toMatchObject({ client_id: "shp_key", client_secret: "shp_secret", code: "abc", expiring: 1 });
    const integ = await ctx.prisma.integration.findFirstOrThrow({ where: { kind: "shopify" } });
    expect(integ.externalId).toBe(SHOP);
    expect(integ.tokenEnc).not.toContain("shpat_1");
  });

  it("OAuth callback: rejects bad HMAC, missing state cookie and foreign shop domains", async () => {
    const { cookie } = await signup(ctx);
    const install = await ctx.app.inject({ method: "GET", url: `/integrations/shopify/install?shop=evil.com`, headers: { cookie } });
    expect(install.statusCode).toBe(400);
    const bad = await ctx.app.inject({ method: "GET", url: `/integrations/shopify/callback?code=a&shop=${SHOP}&state=x&hmac=00` });
    expect(bad.statusCode).toBe(401);
    const q: Record<string, string> = { code: "a", shop: SHOP, state: "x" };
    q.hmac = hmacSha256("shp_secret", Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join("&")).toString("hex");
    const noCookie = await ctx.app.inject({ method: "GET", url: `/integrations/shopify/callback?${new URLSearchParams(q)}` });
    expect(noCookie.json().error.code).toBe("OAUTH_STATE_MISSING");
  });

  it("orders/create (COD): scores, falls back to the Admin API for a redacted phone, tags the order", async () => {
    await historyFor("0655556666");
    const { calls } = await connectShopify();
    const r = await shopifyWebhook("orders/create", {
      id: 1, name: "#1001", admin_graphql_api_id: "gid://shopify/Order/1", payment_gateway_names: ["Cash on Delivery (COD)"],
      phone: null, customer: { phone: null }, shipping_address: { phone: null },
    });
    expect(r.json()).toMatchObject({ scored: true, band: "high", tagged: true });
    const tagCall = calls.find((c) => c.body?.query?.includes("tagsAdd"))!;
    expect(tagCall.body.variables).toEqual({ id: "gid://shopify/Order/1", tags: ["tiqa-risque-eleve"] });
    expect(tagCall.headers["x-shopify-access-token"]).toBe("shpat_1");
    expect(tagCall.url).toBe(`https://${SHOP}/admin/api/2026-10/graphql.json`);
    expect(await ctx.prisma.lookup.count({ where: { channel: "shopify", merchantOrderRef: "#1001" } })).toBe(1);
  });

  it("ignores non-COD orders (default), bad signatures and duplicate deliveries", async () => {
    await connectShopify();
    expect((await shopifyWebhook("orders/create", { name: "#2", payment_gateway_names: ["shopify_payments"], phone: "0612345678" })).json()).toMatchObject({ ignored: "not_cod" });
    expect((await shopifyWebhook("orders/create", { name: "#3" }, { secret: "wrong" })).statusCode).toBe(401);
    const o = { name: "#4", payment_gateway_names: ["Paiement à la livraison"], phone: "0612345678" };
    expect((await shopifyWebhook("orders/create", o, { id: "same" })).json()).toMatchObject({ scored: true });
    expect((await shopifyWebhook("orders/create", o, { id: "same" })).json()).toMatchObject({ duplicate: true });
  });

  it("refreshes an expired access token before calling Shopify", async () => {
    await connectShopify(1); // expires in 1 s → considered expired (60 s safety margin)
    const calls = mockFetch({
      "/admin/oauth/access_token": () => ({ access_token: "shpat_2", expires_in: 3600, refresh_token: "shprt_2" }),
      "/graphql.json": () => ({ data: { tagsAdd: { userErrors: [] } } }),
    });
    await shopifyWebhook("orders/create", { name: "#5", admin_graphql_api_id: "gid://shopify/Order/5", payment_gateway_names: ["cash_on_delivery"], phone: "0612345678" });
    expect(calls[0]!.body).toMatchObject({ grant_type: "refresh_token", refresh_token: "shprt_1" });
    expect(calls[1]!.headers["x-shopify-access-token"]).toBe("shpat_2");
  });

  it("compliance: customers/redact deletes this store's data for the customer; app/uninstalled and shop/redact clean up", async () => {
    await connectShopify();
    const integ = await ctx.prisma.integration.findFirstOrThrow({ where: { kind: "shopify" } });
    const other = await createMerchant(ctx, "Other");
    const hash = ctx.app.network.hash("+212612345678");
    await ctx.prisma.outcome.createMany({
      data: [
        { merchantId: integ.merchantId, phoneHash: hash, outcome: "refused", occurredAt: new Date(), merchantOrderRef: "s1" },
        { merchantId: other.merchant.id, phoneHash: hash, outcome: "refused", occurredAt: new Date(), merchantOrderRef: "o1" },
      ],
    });
    expect((await shopifyWebhook("customers/redact", { shop_domain: SHOP, customer: { id: 1, phone: "+212612345678" }, orders_to_redact: [] })).statusCode).toBe(200);
    expect(await ctx.prisma.outcome.count({ where: { phoneHash: hash } })).toBe(1);
    expect((await shopifyWebhook("customers/data_request", { shop_domain: SHOP })).statusCode).toBe(200);
    await shopifyWebhook("app/uninstalled", {});
    expect(await ctx.prisma.integration.findFirstOrThrow({ where: { kind: "shopify" } })).toMatchObject({ active: false, tokenEnc: null });
    await shopifyWebhook("shop/redact", { shop_domain: SHOP });
    expect(await ctx.prisma.integration.count({ where: { kind: "shopify" } })).toBe(0);
  });
});

// ── YouCan ──────────────────────────────────────────────────────────────────
function youcanWebhook(id: string, payload: object, secret = "yc_secret", encoding: "hex" | "base64" = "hex") {
  const body = JSON.stringify(payload);
  return ctx.app.inject({
    method: "POST", url: `/integrations/youcan/webhooks/${id}`, payload: body,
    headers: { "content-type": "application/json", "x-youcan-signature": hmacSha256(secret, body).toString(encoding), "x-youcan-delivery-id": crypto.randomUUID() },
  });
}

describe("YouCan app", () => {
  it("OAuth install → token → subscribes order.created to a per-integration URL; webhooks are scored", async () => {
    await historyFor("0677778888");
    const { cookie } = await signup(ctx);
    const install = await ctx.app.inject({ method: "GET", url: "/integrations/youcan/install", headers: { cookie } });
    const loc = new URL(install.headers.location as string);
    expect(loc.origin + loc.pathname).toBe("https://seller-area.youcan.shop/admin/oauth/authorize");
    expect(loc.searchParams.getAll("scope[]")).toEqual(["read-orders", "edit-rest-hooks"]);
    const calls = mockFetch({
      "api.youcan.shop/oauth/token": () => ({ access_token: "yc_at", refresh_token: "yc_rt", expires_in: 3600 }),
      "api.youcan.shop/resthooks/subscribe": () => ({ id: "sub_1" }),
      "api.youcan.shop/orders/": () => ({ id: "o2", customer: { phone: "0677778888" } }),
    });
    // YouCan may not echo `state` (undocumented): the signed cookie alone must be enough.
    const cb = await ctx.app.inject({ method: "GET", url: "/integrations/youcan/callback?code=xyz", headers: { cookie: cookieFrom(install.headers["set-cookie"]) } });
    expect(cb.statusCode).toBe(302);
    const integ = await ctx.prisma.integration.findFirstOrThrow({ where: { kind: "youcan" } });
    expect(calls[0]!.body).toMatchObject({ grant_type: "authorization_code", code: "xyz", client_id: "yc_id", client_secret: "yc_secret" });
    expect(calls[1]!.body).toEqual({ event: "order.created", target_url: `https://tiqa.test/api/integrations/youcan/webhooks/${integ.id}` });
    expect(calls[1]!.headers.authorization).toBe("Bearer yc_at");

    const r = await youcanWebhook(integ.id, { event_name: "order.created", event_happened_at: "2026-11-22T10:00:00Z", data: { id: "o1", ref: "YC-1", customer: { phone: "06 77 77 88 88" } } });
    expect(r.json()).toMatchObject({ scored: true, band: "high" });
    // phone missing in payload → GET order with includes
    const r2 = await youcanWebhook(integ.id, { event_name: "order.created", data: { id: "o2", ref: "YC-2" } }, "yc_secret", "base64");
    expect(r2.json()).toMatchObject({ scored: true });
    expect(calls.at(-1)!.url).toBe("https://api.youcan.shop/orders/o2?include=customer,shipping,payment");
    expect(await ctx.prisma.lookup.count({ where: { channel: "youcan" } })).toBe(2);
  });

  it("rejects bad signatures and unknown integrations", async () => {
    expect((await youcanWebhook("nope", { event_name: "order.created", data: {} }, "bad")).statusCode).toBe(401);
    expect((await youcanWebhook("nope", { event_name: "order.created", data: {} })).json()).toMatchObject({ ignored: "not_connected" });
  });

  it("integration listing shows platform availability", async () => {
    const { cookie } = await signup(ctx);
    const r = (await ctx.app.inject({ method: "GET", url: "/app/integrations", headers: { cookie } })).json();
    expect(r).toMatchObject({ generic: { configured: false }, shopify: { available: true, connections: [] }, youcan: { available: true } });
  });
});
