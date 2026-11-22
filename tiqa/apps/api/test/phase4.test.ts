import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { computeInvoice, generateInvoices } from "../src/services/billing";
import { base32Decode, base32Encode, hotp, totpStep, verifyTotp } from "../src/lib/totp";
import { createMerchant, PEPPER, setupTestApp, signup, staffLogin } from "./helpers";

const ctx = setupTestApp();
const PLANS = [
  { code: "free", nameFr: "Gratuit", nameAr: "مجاني", monthlyFeeCentimes: 0, includedLookups: 3, overageCentimesPerLookup: 0, rateLimitPerMin: 30 },
  { code: "starter", nameFr: "Starter", nameAr: "ستارتر", monthlyFeeCentimes: 19_900, includedLookups: 2, overageCentimesPerLookup: 15, rateLimitPerMin: 120 },
];
const seedPlans = () => Promise.all(PLANS.map((p) => ctx.prisma.plan.create({ data: p })));

describe("TOTP (RFC 6238 test vectors, SHA-1)", () => {
  const secret = Buffer.from("12345678901234567890");
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ])("T=%i → %s", (t, code) => expect(hotp(secret, Math.floor(t / 30), 8)).toBe(code));
  it("base32 round trip and ±1 step drift", () => {
    const b32 = base32Encode(secret);
    expect(b32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(b32).equals(secret)).toBe(true);
    const now = 1_800_000_000_000;
    const code = hotp(secret, totpStep(now) - 1);
    expect(verifyTotp(b32, code, now)).toBe(totpStep(now) - 1);
    expect(verifyTotp(b32, hotp(secret, totpStep(now) - 3), now)).toBeNull();
    expect(verifyTotp(b32, "abc", now)).toBeNull();
  });
});

describe("billing", () => {
  it("computeInvoice: fee + overage + 20% VAT", () => {
    const c = computeInvoice(PLANS[1]!, 12, 2000);
    expect(c.lines).toHaveLength(2);
    expect(c.overage).toBe(10);
    expect(c.subtotalCentimes).toBe(19_900 + 150);
    expect(c.vatCentimes).toBe(4010);
    expect(c.totalCentimes).toBe(24_060);
    expect(computeInvoice(PLANS[0]!, 999, 2000).totalCentimes).toBe(0);
  });

  it("free plan blocks lookups at the quota; paid plans continue (overage)", async () => {
    await seedPlans();
    const { cookie } = await signup(ctx); // gets the free plan (3 lookups)
    const look = () => ctx.app.inject({ method: "POST", url: "/app/lookup", headers: { cookie }, payload: { phone: "0612345678" } });
    for (let i = 0; i < 3; i++) expect((await look()).statusCode).toBe(200);
    const blocked = await look();
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().error.code).toBe("QUOTA_EXCEEDED");

    // upgrading requires a billing profile
    expect((await ctx.app.inject({ method: "PATCH", url: "/app/billing/plan", headers: { cookie }, payload: { code: "starter" } })).json().error.code).toBe("BILLING_PROFILE_REQUIRED");
    expect((await ctx.app.inject({ method: "PATCH", url: "/app/billing/profile", headers: { cookie }, payload: { legal_name: "My Store SARL", ice: "123" } })).statusCode).toBe(400);
    await ctx.app.inject({ method: "PATCH", url: "/app/billing/profile", headers: { cookie }, payload: { legal_name: "My Store SARL", ice: "001234567000089", city: "Casablanca" } });
    expect((await ctx.app.inject({ method: "PATCH", url: "/app/billing/plan", headers: { cookie }, payload: { code: "starter" } })).statusCode).toBe(200);
    expect((await look()).statusCode).toBe(200);

    const b = (await ctx.app.inject({ method: "GET", url: "/app/billing", headers: { cookie } })).json();
    expect(b).toMatchObject({ plan: { code: "starter" }, usage: { lookups: 4 }, estimate: { overage: 2, subtotalCentimes: 19_930 } });
  });

  it("monthly invoices: gapless numbering, idempotent, snapshots, paid & credit note flow", async () => {
    await seedPlans();
    const starter = await ctx.prisma.plan.findUniqueOrThrow({ where: { code: "starter" } });
    const ms = [];
    for (const name of ["A", "B", "C"]) {
      const { merchant } = await createMerchant(ctx, `Store ${name}`, { billingLegalName: `${name} SARL`, billingIce: "001234567000089" });
      await ctx.prisma.subscription.create({ data: { merchantId: merchant.id, planId: starter.id } });
      await ctx.prisma.usageMonthly.create({ data: { merchantId: merchant.id, period: "2026-10", lookups: 5 } });
      ms.push(merchant);
    }
    const now = new Date("2026-11-01T06:00:00Z");
    expect(await generateInvoices(ctx.prisma, ctx.deps.env, "2026-10", now)).toMatchObject({ issued: 3, skipped: 0 });
    expect(await generateInvoices(ctx.prisma, ctx.deps.env, "2026-10", now)).toMatchObject({ issued: 0, skipped: 3 });
    const invs = await ctx.prisma.invoice.findMany({ orderBy: { number: "asc" } });
    expect(invs.map((i) => i.number)).toEqual(["FAC-2026-00001", "FAC-2026-00002", "FAC-2026-00003"]);
    expect(invs[0]).toMatchObject({ totalCentimes: Math.round((19_900 + 45) * 1.2), vatRateBp: 2000, currency: "MAD" });
    expect(invs[0]!.buyer).toMatchObject({ ice: "001234567000089" });
    expect(invs[0]!.seller).toHaveProperty("ice");

    const staff = await staffLogin(ctx);
    const list = (await ctx.app.inject({ method: "GET", url: "/admin/invoices", headers: { cookie: staff.cookie } })).json();
    expect(list).toHaveLength(3);
    const paid = await ctx.app.inject({ method: "POST", url: `/admin/invoices/${invs[0]!.id}/mark-paid`, headers: { cookie: staff.cookie }, payload: { method: "bank_transfer", reference: "VIR-778" } });
    expect(paid.statusCode).toBe(200);
    const cancel = await ctx.app.inject({ method: "POST", url: `/admin/invoices/${invs[1]!.id}/cancel`, headers: { cookie: staff.cookie }, payload: { reason: "Erreur de plan" } });
    expect(cancel.json()).toEqual({ ok: true, credit_note: "AV-2026-00001" });
    expect((await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invs[1]!.id } })).status).toBe("cancelled");
    // Merchants only see their own invoices
    const { cookie } = await signup(ctx, "x@y.test", "Other store");
    expect((await ctx.app.inject({ method: "GET", url: `/app/billing/invoices/${invs[0]!.id}`, headers: { cookie } })).statusCode).toBe(404);
  });
});

describe("staff 2FA", () => {
  it("staff without verified TOTP can't use admin endpoints; codes can't be replayed", async () => {
    const { cookie } = await signup(ctx, "ops@tiqa.test", "Ops store");
    await ctx.prisma.user.update({ where: { email: "ops@tiqa.test" }, data: { isStaff: true } });
    expect((await ctx.app.inject({ method: "GET", url: "/admin/overview", headers: { cookie } })).json().error.code).toBe("MFA_SETUP_REQUIRED");
    expect((await ctx.app.inject({ method: "GET", url: "/admin/me", headers: { cookie } })).json()).toMatchObject({ mfa: "setup_required" });
    const setup = (await ctx.app.inject({ method: "POST", url: "/admin/mfa/setup", headers: { cookie } })).json();
    expect(setup.otpauth_uri).toMatch(/^otpauth:\/\/totp\/Tiqa%3Aops%40tiqa\.test\?secret=/);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: "ops@tiqa.test" } });
    expect(user.totpSecretEnc).not.toContain(setup.secret);
    expect((await ctx.app.inject({ method: "POST", url: "/admin/mfa/verify", headers: { cookie }, payload: { code: "000000" } })).statusCode).toBe(401);
    const code = hotp(base32Decode(setup.secret), totpStep());
    expect((await ctx.app.inject({ method: "POST", url: "/admin/mfa/verify", headers: { cookie }, payload: { code } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/admin/overview", headers: { cookie } })).statusCode).toBe(200);
    // Same code again (new login) is refused: replay protection
    const login = await ctx.app.inject({ method: "POST", url: "/app/auth/login", payload: { email: "ops@tiqa.test", password: "correct horse battery" } });
    const cookie2 = String(login.headers["set-cookie"]).split(";")[0]!;
    expect((await ctx.app.inject({ method: "GET", url: "/admin/me", headers: { cookie: cookie2 } })).json()).toMatchObject({ mfa: "required" });
    expect((await ctx.app.inject({ method: "POST", url: "/admin/mfa/verify", headers: { cookie: cookie2 }, payload: { code } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: "/admin/mfa/setup", headers: { cookie: cookie2 } })).json().error.code).toBe("MFA_ALREADY_ENABLED");
  });
});

describe("hardening", () => {
  it("rejects cross-site state-changing requests; allows same origin and server-to-server", async () => {
    const { cookie } = await signup(ctx);
    const evil = await ctx.app.inject({ method: "POST", url: "/app/lookup", headers: { cookie, origin: "https://evil.example" }, payload: { phone: "0612345678" } });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.code).toBe("BAD_ORIGIN");
    const ok = await ctx.app.inject({ method: "POST", url: "/app/lookup", headers: { cookie, origin: "http://localhost:3000" }, payload: { phone: "0612345678" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    const { auth } = await createMerchant(ctx);
    const api = await ctx.app.inject({ method: "POST", url: "/v1/score", headers: { ...auth, origin: "https://someone-else.example" }, payload: { phone: "0612345678" } });
    expect(api.statusCode).toBe(200); // public API is server-to-server, not cookie-based
  });

  it("pepper rotation: old-key records are re-keyed when the number is seen again", async () => {
    const [a, b] = [await createMerchant(ctx, "A"), await createMerchant(ctx, "B")];
    const phone = "0633334444";
    for (const [m, r] of [[a, "1"], [a, "2"], [b, "1"]] as const) {
      await ctx.app.inject({ method: "POST", url: "/v1/outcomes", headers: m.auth, payload: { phone, outcome: "refused", order_ref: r } });
    }
    // Rotate: new pepper is current, the old one is kept for migration.
    const NEW = "new_pepper_after_rotation_0123456789abcdefghijkl";
    const env2 = { ...ctx.deps.env, PHONE_HASH_PEPPER: NEW, PHONE_HASH_KEY_VERSION: 2, PHONE_HASH_PEPPERS_OLD: `1:${PEPPER}` };
    const app2 = await buildApp({ ...ctx.deps, env: env2 }, { logger: false });
    const c = await createMerchant(ctx, "C");
    const r = await app2.inject({ method: "POST", url: "/v1/score", headers: c.auth, payload: { phone } });
    expect(r.json().band).toBe("high"); // old records found and re-keyed before scoring
    const rows = await ctx.prisma.outcome.findMany();
    expect(rows.every((o) => o.hashKeyVersion === 2)).toBe(true);
    expect(rows.every((o) => Buffer.from(o.phoneHash).equals(app2.network.hash("+212633334444")))).toBe(true);
    await app2.close();
  });
});
