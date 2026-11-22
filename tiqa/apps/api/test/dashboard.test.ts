import { describe, expect, it } from "vitest";
import { cookieFrom, createMerchant, setupTestApp, signup } from "./helpers";

const ctx = setupTestApp();

describe("auth", () => {
  it("signup creates merchant + owner membership + records terms acceptance", async () => {
    const { cookie } = await signup(ctx);
    const me = await ctx.app.inject({ method: "GET", url: "/app/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: "owner@store.test", locale: "fr" }, merchant: { name: "My Store", role: "owner" } });
    const merchant = await ctx.prisma.merchant.findFirstOrThrow();
    expect(merchant.termsAcceptedAt).toBeTruthy();
  });

  it("signup requires accepting the terms and a 10+ char password", async () => {
    const r1 = await ctx.app.inject({
      method: "POST", url: "/app/auth/signup",
      payload: { email: "a@b.test", password: "correct horse battery", merchantName: "S", acceptTerms: false },
    });
    expect(r1.statusCode).toBe(400);
    const r2 = await ctx.app.inject({
      method: "POST", url: "/app/auth/signup",
      payload: { email: "a@b.test", password: "short", merchantName: "Store", acceptTerms: true },
    });
    expect(r2.statusCode).toBe(400);
  });

  it("rejects duplicate emails", async () => {
    await signup(ctx);
    const r = await ctx.app.inject({
      method: "POST", url: "/app/auth/signup",
      payload: { email: "OWNER@store.test", password: "correct horse battery", merchantName: "Other", acceptTerms: true },
    });
    expect(r.statusCode).toBe(409);
  });

  it("password login and logout", async () => {
    await signup(ctx);
    const bad = await ctx.app.inject({ method: "POST", url: "/app/auth/login", payload: { email: "owner@store.test", password: "wrong password" } });
    expect(bad.statusCode).toBe(401);
    const ok = await ctx.app.inject({ method: "POST", url: "/app/auth/login", payload: { email: "owner@store.test", password: "correct horse battery" } });
    expect(ok.statusCode).toBe(200);
    const cookie = cookieFrom(ok.headers["set-cookie"]);
    expect((await ctx.app.inject({ method: "GET", url: "/app/me", headers: { cookie } })).statusCode).toBe(200);
    await ctx.app.inject({ method: "POST", url: "/app/auth/logout", headers: { cookie } });
    expect((await ctx.app.inject({ method: "GET", url: "/app/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("magic link: sends an email, logs in once, then the token is dead", async () => {
    await signup(ctx);
    const r = await ctx.app.inject({ method: "POST", url: "/app/auth/magic-link", payload: { email: "owner@store.test" } });
    expect(r.statusCode).toBe(200);
    expect(ctx.mails).toHaveLength(1);
    const token = /token=([^\s]+)/.exec(ctx.mails[0]!.text)![1]!;
    const v1 = await ctx.app.inject({ method: "POST", url: "/app/auth/magic-link/verify", payload: { token: decodeURIComponent(token) } });
    expect(v1.statusCode).toBe(200);
    expect(v1.headers["set-cookie"]).toBeTruthy();
    const v2 = await ctx.app.inject({ method: "POST", url: "/app/auth/magic-link/verify", payload: { token: decodeURIComponent(token) } });
    expect(v2.statusCode).toBe(401);
  });

  it("magic link: same response for unknown emails (no enumeration), no email sent", async () => {
    const r = await ctx.app.inject({ method: "POST", url: "/app/auth/magic-link", payload: { email: "nobody@x.test" } });
    expect(r.statusCode).toBe(200);
    expect(ctx.mails).toHaveLength(0);
  });

  it("session cookie is httpOnly and SameSite=Lax", async () => {
    const res = await ctx.app.inject({
      method: "POST", url: "/app/auth/signup",
      payload: { email: "c@d.test", password: "correct horse battery", merchantName: "Store", acceptTerms: true },
    });
    const c = String(res.headers["set-cookie"]);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
  });
});

describe("dashboard", () => {
  it("lookup tool records a dashboard lookup and shows it in history", async () => {
    const { cookie } = await signup(ctx);
    const r = await ctx.app.inject({ method: "POST", url: "/app/lookup", headers: { cookie }, payload: { phone: "0612345678", order_ref: "WA-77" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().band).toBe("insufficient_data");
    const hist = await ctx.app.inject({ method: "GET", url: "/app/lookups", headers: { cookie } });
    expect(hist.json().items).toHaveLength(1);
    expect(hist.json().items[0]).toMatchObject({ phoneLast2: "78", merchantOrderRef: "WA-77", channel: "dashboard" });
  });

  it("history is paginated and filterable by band", async () => {
    const { cookie } = await signup(ctx);
    for (let i = 0; i < 5; i++) await ctx.app.inject({ method: "POST", url: "/app/lookup", headers: { cookie }, payload: { phone: `061234567${i}` } });
    const p1 = (await ctx.app.inject({ method: "GET", url: "/app/lookups?limit=3", headers: { cookie } })).json();
    expect(p1.items).toHaveLength(3);
    const p2 = (await ctx.app.inject({ method: "GET", url: `/app/lookups?limit=3&cursor=${p1.next_cursor}`, headers: { cookie } })).json();
    expect(p2.items).toHaveLength(2);
    expect(p2.next_cursor).toBeNull();
    const high = (await ctx.app.inject({ method: "GET", url: "/app/lookups?band=high", headers: { cookie } })).json();
    expect(high.items).toHaveLength(0);
  });

  it("merchants cannot see or modify each other's history", async () => {
    const a = await signup(ctx, "a@a.test", "Store A");
    const b = await signup(ctx, "b@b.test", "Store B");
    const r = await ctx.app.inject({ method: "POST", url: "/app/lookup", headers: { cookie: a.cookie }, payload: { phone: "0612345678" } });
    const id = r.json().lookup_id;
    expect((await ctx.app.inject({ method: "GET", url: "/app/lookups", headers: { cookie: b.cookie } })).json().items).toHaveLength(0);
    const patch = await ctx.app.inject({ method: "PATCH", url: `/app/lookups/${id}`, headers: { cookie: b.cookie }, payload: { decision: "cancelled" } });
    expect(patch.statusCode).toBe(404);
  });

  it("stats: own refusal rate, by carrier, and money-saved estimate", async () => {
    const { cookie } = await signup(ctx);
    const merchant = await ctx.prisma.merchant.findFirstOrThrow();
    const { key } = await createMerchant(ctx, "Other"); // other merchant data must NOT appear in stats
    await ctx.app.inject({ method: "POST", url: "/v1/outcomes", headers: { authorization: `Bearer ${key}` }, payload: { phone: "0699999999", outcome: "refused" } });

    await ctx.prisma.outcome.createMany({
      data: [
        { merchantId: merchant.id, phoneHash: Buffer.alloc(32, 1), outcome: "delivered", occurredAt: new Date(), carrier: "amana", merchantOrderRef: "1" },
        { merchantId: merchant.id, phoneHash: Buffer.alloc(32, 2), outcome: "refused", occurredAt: new Date(), carrier: "amana", merchantOrderRef: "2" },
        { merchantId: merchant.id, phoneHash: Buffer.alloc(32, 3), outcome: "returned", occurredAt: new Date(), carrier: "sendit", merchantOrderRef: "3" },
        { merchantId: merchant.id, phoneHash: Buffer.alloc(32, 4), outcome: "delivered", occurredAt: new Date(), carrier: "sendit", merchantOrderRef: "4" },
      ],
    });
    await ctx.prisma.lookup.create({
      data: { merchantId: merchant.id, phoneHash: Buffer.alloc(32, 9), phoneLast2: "11", band: "high", score: 60, outcomesBucket: "3-5", merchantsBucket: "2-3", scoreVersion: "v1.0", decision: "cancelled" },
    });
    await ctx.app.inject({ method: "PATCH", url: "/app/merchant", headers: { cookie }, payload: { failed_order_cost_mad: 50 } });

    const s = (await ctx.app.inject({ method: "GET", url: "/app/stats", headers: { cookie } })).json();
    expect(s.outcomes).toMatchObject({ delivered: 2, refused: 1, returned: 1, total: 4, refusal_rate: 0.5 });
    expect(s.by_carrier).toEqual(expect.arrayContaining([{ carrier: "amana", total: 2, refused: 1 }]));
    expect(s.money_saved).toMatchObject({ orders_avoided: 1, expected_refusals_avoided: 0.6, failed_order_cost_mad: 50, estimate_mad: 30 });
    expect(s.contribution.tier).toBe("grace");
  });

  it("API keys: create (shown once), list without secret, use, revoke", async () => {
    const { cookie } = await signup(ctx);
    const created = await ctx.app.inject({ method: "POST", url: "/app/api-keys", headers: { cookie }, payload: { name: "Shop" } });
    expect(created.statusCode).toBe(201);
    const { key, id } = created.json();
    expect(key).toMatch(/^tq_test_/);
    const list = (await ctx.app.inject({ method: "GET", url: "/app/api-keys", headers: { cookie } })).json();
    expect(JSON.stringify(list)).not.toContain(key.split("_").at(-1));
    const use = await ctx.app.inject({ method: "POST", url: "/v1/score", headers: { authorization: `Bearer ${key}` }, payload: { phone: "0612345678" } });
    expect(use.statusCode).toBe(200);
    await ctx.app.inject({ method: "DELETE", url: `/app/api-keys/${id}`, headers: { cookie } });
    const after = await ctx.app.inject({ method: "POST", url: "/v1/score", headers: { authorization: `Bearer ${key}` }, payload: { phone: "0612345678" } });
    expect(after.statusCode).toBe(401);
  });

  it("members cannot manage API keys", async () => {
    const { cookie } = await signup(ctx);
    await ctx.prisma.membership.updateMany({ data: { role: "member" } });
    const r = await ctx.app.inject({ method: "POST", url: "/app/api-keys", headers: { cookie }, payload: { name: "x" } });
    expect(r.statusCode).toBe(403);
  });

  it("all dashboard routes require a session", async () => {
    for (const [method, url] of [["GET", "/app/me"], ["GET", "/app/stats"], ["GET", "/app/lookups"], ["POST", "/app/lookup"], ["GET", "/app/api-keys"], ["POST", "/app/outcomes/csv"]] as const) {
      expect((await ctx.app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode).toBe(401);
    }
  });
});
