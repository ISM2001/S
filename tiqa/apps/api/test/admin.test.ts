import { describe, expect, it } from "vitest";
import { runTrustJob } from "../src/jobs/trust";
import { createMerchant, setupTestApp, signup, staffLogin } from "./helpers";

const ctx = setupTestApp();
const DAY = 86_400_000;

describe("admin access", () => {
  it("non-staff users and anonymous callers are refused", async () => {
    const { cookie } = await signup(ctx);
    for (const url of ["/admin/overview", "/admin/requests", "/admin/merchants", "/admin/flags"]) {
      expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method: "GET", url, headers: { cookie } })).statusCode).toBe(403);
    }
  });

  it("staff can override trust and suspend; changes apply to scoring immediately and are audited", async () => {
    const staff = await staffLogin(ctx);
    const [a, b, c] = [await createMerchant(ctx, "A"), await createMerchant(ctx, "B"), await createMerchant(ctx, "C")];
    const phone = "0677778888";
    for (const [m, ref] of [[a, "1"], [a, "2"], [b, "1"]] as const) {
      await ctx.app.inject({ method: "POST", url: "/v1/outcomes", headers: m.auth, payload: { phone, outcome: "refused", order_ref: ref } });
    }
    const score = async () => (await ctx.app.inject({ method: "POST", url: "/v1/score", headers: c.auth, payload: { phone } })).json();
    expect((await score()).band).toBe("high");

    const r = await ctx.app.inject({ method: "PATCH", url: `/admin/merchants/${b.merchant.id}`, headers: { cookie: staff.cookie }, payload: { status: "suspended" } });
    expect(r.statusCode).toBe(200);
    expect((await score()).band).toBe("insufficient_data");

    await ctx.app.inject({ method: "PATCH", url: `/admin/merchants/${b.merchant.id}`, headers: { cookie: staff.cookie }, payload: { status: "active", trust_override: 0.2 } });
    const list = (await ctx.app.inject({ method: "GET", url: "/admin/merchants", headers: { cookie: staff.cookie } })).json();
    expect(list.find((m: { id: string }) => m.id === b.merchant.id)).toMatchObject({ trust_override: 0.2, effective_trust: 0.2 });
    expect(await ctx.prisma.auditLog.count({ where: { action: "admin_update_merchant" } })).toBe(2);
  });
});

describe("trust job", () => {
  it("carrier exports that contradict a merchant's refusals lower its trust and raise a flag", async () => {
    const { merchant, auth } = await createMerchant(ctx, "Liar");
    // 30 manual refusals...
    const outcomes = Array.from({ length: 30 }, (_, i) => ({ phone: `06100000${String(i).padStart(2, "0")}`, outcome: "refused", order_ref: `R${i}` }));
    await ctx.app.inject({ method: "POST", url: "/v1/outcomes/batch", headers: auth, payload: { outcomes } });
    // ...then the carrier export for the same orders says 20 of them were delivered.
    const csv = ["ref;tel;statut", ...outcomes.map((o, i) => `${o.order_ref};${o.phone};${i < 20 ? "Livré" : "Refusé"}`)].join("\n");
    const owner = await signup(ctx, "liar@x.test", "Liar dashboard");
    await ctx.prisma.membership.updateMany({ where: { user: { email: "liar@x.test" } }, data: { merchantId: merchant.id } });
    const imp = await ctx.app.inject({
      method: "POST", url: "/app/outcomes/csv", headers: { cookie: owner.cookie },
      payload: { csv, mapping: { phone: "tel", status: "statut", order_ref: "ref" }, source_type: "carrier_export" },
    });
    expect(imp.json()).toMatchObject({ updated: 30 });
    expect(await ctx.prisma.outcome.count({ where: { merchantId: merchant.id, contradicted: true } })).toBe(20);
    expect(await ctx.prisma.outcome.count({ where: { merchantId: merchant.id, carrierChecked: true } })).toBe(30);

    await runTrustJob(ctx.prisma);
    const m = await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
    expect(m.trustWeight).toBeLessThan(0.3);
    const flags = await ctx.prisma.anomalyFlag.findMany({ where: { merchantId: merchant.id } });
    expect(flags.map((f) => f.kind)).toContain("CONTRADICTION_HIGH");

    // Idempotent: running again doesn't duplicate open flags.
    await runTrustJob(ctx.prisma);
    expect(await ctx.prisma.anomalyFlag.count({ where: { merchantId: merchant.id, kind: "CONTRADICTION_HIGH" } })).toBe(1);
  });

  it("dismissing a flag restores trust and the flag is not re-raised within 30 days", async () => {
    const staff = await staffLogin(ctx);
    const { merchant } = await createMerchant(ctx, "Flagged");
    const flag = await ctx.prisma.anomalyFlag.create({ data: { merchantId: merchant.id, kind: "UNLOOKED_REFUSALS", severity: "medium", details: {} } });
    await runTrustJob(ctx.prisma);
    expect((await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } })).trustWeight).toBeCloseTo(0.8, 3);

    const open = (await ctx.app.inject({ method: "GET", url: "/admin/flags", headers: { cookie: staff.cookie } })).json();
    expect(open[0]).toMatchObject({ id: flag.id, merchant_name: "Flagged" });
    await ctx.app.inject({ method: "PATCH", url: `/admin/flags/${flag.id}`, headers: { cookie: staff.cookie }, payload: { status: "dismissed" } });
    const res = await ctx.app.inject({ method: "POST", url: "/admin/trust/recompute", headers: { cookie: staff.cookie } });
    expect(res.statusCode).toBe(200);
    expect((await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } })).trustWeight).toBe(1);
  });

  it("dumping refusals for never-looked-up numbers raises UNLOOKED_REFUSALS", async () => {
    const { merchant, auth } = await createMerchant(ctx, "Dumper");
    const outcomes = Array.from({ length: 40 }, (_, i) => ({ phone: `06200000${String(i).padStart(2, "0")}`, outcome: "refused", order_ref: `D${i}` }));
    await ctx.app.inject({ method: "POST", url: "/v1/outcomes/batch", headers: auth, payload: { outcomes } });
    await runTrustJob(ctx.prisma);
    const kinds = (await ctx.prisma.anomalyFlag.findMany({ where: { merchantId: merchant.id } })).map((f) => f.kind);
    expect(kinds).toContain("UNLOOKED_REFUSALS");
    expect((await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } })).trustWeight).toBeLessThan(1);
  });

  it("a normal merchant keeps trust 1.0 and no flags", async () => {
    const { merchant, auth } = await createMerchant(ctx, "Normal", { createdAt: new Date(Date.now() - 100 * DAY) });
    const outcomes = Array.from({ length: 40 }, (_, i) => ({ phone: `06300000${String(i).padStart(2, "0")}`, outcome: i % 4 === 0 ? "refused" : "delivered", order_ref: `N${i}` }));
    await ctx.app.inject({ method: "POST", url: "/v1/outcomes/batch", headers: auth, payload: { outcomes } });
    await runTrustJob(ctx.prisma);
    expect(await ctx.prisma.anomalyFlag.count({ where: { merchantId: merchant.id } })).toBe(0);
    expect((await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } })).trustWeight).toBe(1);
  });
});
