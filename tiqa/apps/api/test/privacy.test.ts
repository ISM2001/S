import { describe, expect, it } from "vitest";
import { runRetention } from "../src/jobs/retention";
import { createMerchant, setupTestApp, signup } from "./helpers";

const ctx = setupTestApp();

/**
 * Privacy guarantees, tested end-to-end:
 * a raw phone number submitted through ANY entry point must not appear anywhere in the database.
 */
describe("no raw phone numbers at rest", () => {
  it("score, outcomes, batch, CSV and dashboard lookups leave no trace of the raw number", async () => {
    const digits = "600000999";
    const { auth } = await createMerchant(ctx);
    const { cookie } = await signup(ctx);
    await ctx.app.inject({ method: "POST", url: "/v1/score", headers: auth, payload: { phone: `0${digits}`, order_ref: "o1" } });
    await ctx.app.inject({ method: "POST", url: "/v1/outcomes", headers: auth, payload: { phone: `+212${digits}`, outcome: "refused", order_ref: "o1" } });
    await ctx.app.inject({ method: "POST", url: "/v1/outcomes/batch", headers: auth, payload: { outcomes: [{ phone: `0${digits}`, outcome: "delivered", order_ref: "o2" }] } });
    await ctx.app.inject({ method: "POST", url: "/app/lookup", headers: { cookie }, payload: { phone: `0${digits}` } });
    await ctx.app.inject({
      method: "POST", url: "/app/outcomes/csv", headers: { cookie },
      payload: { csv: `tel;statut\n0${digits};Livré\n0${digits.slice(0, -1)};???`, mapping: { phone: "tel", status: "statut" } },
    });

    // Dump every text/json/bytea column of every table and search for the number in several encodings.
    const tables = await ctx.prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name <> '_prisma_migrations'`;
    let dump = "";
    for (const { table_name } of tables) {
      const rows = await ctx.prisma.$queryRawUnsafe<unknown[]>(`SELECT row_to_json(t)::text AS j FROM "${table_name}" t`);
      dump += JSON.stringify(rows);
    }
    expect(dump.length).toBeGreaterThan(1000);
    expect(dump).not.toContain(digits);
    expect(dump).not.toContain(Buffer.from(`+212${digits}`).toString("hex"));
    expect(dump).not.toContain(Buffer.from(`+212${digits}`).toString("base64"));
  });
});

describe("retention", () => {
  it("deletes outcomes and lookups older than RETENTION_MONTHS, keeps recent ones", async () => {
    const { merchant } = await createMerchant(ctx);
    const old = new Date(Date.now() - 400 * 86_400_000);
    const recent = new Date(Date.now() - 30 * 86_400_000);
    await ctx.prisma.outcome.createMany({
      data: [
        { merchantId: merchant.id, phoneHash: Buffer.alloc(32, 1), outcome: "refused", occurredAt: old, merchantOrderRef: "old" },
        { merchantId: merchant.id, phoneHash: Buffer.alloc(32, 2), outcome: "refused", occurredAt: recent, merchantOrderRef: "new" },
      ],
    });
    await ctx.prisma.lookup.create({
      data: { merchantId: merchant.id, phoneHash: Buffer.alloc(32, 1), phoneLast2: "00", band: "low", outcomesBucket: "0", merchantsBucket: "0", scoreVersion: "v1.0", createdAt: old },
    });
    await ctx.prisma.auditLog.create({ data: { actorType: "system", action: "x", at: new Date(Date.now() - 800 * 86_400_000) } });

    const res = await runRetention(ctx.prisma, { retentionMonths: 12, auditRetentionMonths: 24 });
    expect(res).toMatchObject({ outcomes: 1, lookups: 1, auditLogs: 1 });
    const left = await ctx.prisma.outcome.findMany();
    expect(left.map((o) => o.merchantOrderRef)).toEqual(["new"]);
  });

  it("the scorer ignores outcomes past retention even before the job runs", async () => {
    const a = await createMerchant(ctx, "A");
    const b = await createMerchant(ctx, "B");
    const c = await createMerchant(ctx, "C");
    const hash = ctx.app.network.hash("+212611112222");
    const old = new Date(Date.now() - 400 * 86_400_000);
    await ctx.prisma.outcome.createMany({
      data: [
        { merchantId: a.merchant.id, phoneHash: hash, outcome: "refused", occurredAt: old, merchantOrderRef: "1", source: "carrier_api" },
        { merchantId: a.merchant.id, phoneHash: hash, outcome: "refused", occurredAt: old, merchantOrderRef: "2", source: "carrier_api" },
        { merchantId: b.merchant.id, phoneHash: hash, outcome: "refused", occurredAt: old, merchantOrderRef: "1", source: "carrier_api" },
      ],
    });
    const r = await ctx.app.inject({ method: "POST", url: "/v1/score", headers: c.auth, payload: { phone: "0611112222" } });
    expect(r.json()).toMatchObject({ band: "insufficient_data", outcomes_count: "0" });
  });
});
