import { describe, expect, it } from "vitest";
import { createMerchant, daysAgo, setupTestApp } from "./helpers";

const ctx = setupTestApp();

async function submit(auth: Record<string, string>, payload: object) {
  return ctx.app.inject({ method: "POST", url: "/v1/outcomes", headers: auth, payload });
}

describe("API key auth", () => {
  it("rejects missing, malformed and revoked keys", async () => {
    const { auth, merchant } = await createMerchant(ctx);
    expect((await ctx.app.inject({ method: "POST", url: "/v1/score", payload: { phone: "0612345678" } })).statusCode).toBe(401);
    expect(
      (await ctx.app.inject({ method: "POST", url: "/v1/score", headers: { authorization: "Bearer nope" }, payload: { phone: "0612345678" } })).statusCode,
    ).toBe(401);
    await ctx.prisma.apiKey.updateMany({ where: { merchantId: merchant.id }, data: { revokedAt: new Date() } });
    expect((await ctx.app.inject({ method: "POST", url: "/v1/score", headers: auth, payload: { phone: "0612345678" } })).statusCode).toBe(401);
  });

  it("accepts the X-API-Key header too", async () => {
    const { key } = await createMerchant(ctx);
    const res = await ctx.app.inject({ method: "POST", url: "/v1/score", headers: { "x-api-key": key }, payload: { phone: "0612345678" } });
    expect(res.statusCode).toBe(200);
  });

  it("blocks suspended merchants", async () => {
    const { auth, merchant } = await createMerchant(ctx);
    await ctx.prisma.merchant.update({ where: { id: merchant.id }, data: { status: "suspended" } });
    const res = await ctx.app.inject({ method: "POST", url: "/v1/score", headers: auth, payload: { phone: "0612345678" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /v1/score", () => {
  it("returns insufficient_data for an unknown number, with bucketed counts", async () => {
    const { auth } = await createMerchant(ctx);
    const res = await ctx.app.inject({ method: "POST", url: "/v1/score", headers: auth, payload: { phone: "06 12 34 56 78" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      band: "insufficient_data",
      score: null,
      outcomes_count: "0",
      merchants_count: "0",
      reasons: ["LIMITED_HISTORY"],
      score_version: "v1.0",
    });
    expect(res.json().lookup_id).toBeTruthy();
  });

  it("validates the phone number", async () => {
    const { auth } = await createMerchant(ctx);
    const res = await ctx.app.inject({ method: "POST", url: "/v1/score", headers: auth, payload: { phone: "+33612345678" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("scores across merchants: a serial refuser at other stores is HIGH for a new store", async () => {
    const a = await createMerchant(ctx, "A");
    const b = await createMerchant(ctx, "B");
    const c = await createMerchant(ctx, "C");
    const phone = "0698765432";
    await submit(a.auth, { phone, outcome: "refused", occurred_at: daysAgo(5), order_ref: "A-1" });
    await submit(a.auth, { phone, outcome: "refused", occurred_at: daysAgo(15), order_ref: "A-2" });
    await submit(b.auth, { phone: "+212698765432", outcome: "refused", occurred_at: daysAgo(3), order_ref: "B-1" });
    await submit(b.auth, { phone: "00212698765432", outcome: "returned", occurred_at: daysAgo(20), order_ref: "B-2" });

    const res = await ctx.app.inject({ method: "POST", url: "/v1/score", headers: c.auth, payload: { phone } });
    const body = res.json();
    expect(body.band).toBe("high");
    expect(body.score).toBeGreaterThanOrEqual(40);
    expect(body.outcomes_count).toBe("3-5");
    expect(body.merchants_count).toBe("2-3");
    expect(body.reasons).toContain("REFUSALS_AT_MULTIPLE_STORES");
    // Never leaks which store reported what.
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${a.merchant.id}|${b.merchant.id}|A-1|B-1`));
  });

  it("a single merchant can never produce a score on its own", async () => {
    const a = await createMerchant(ctx, "A");
    const c = await createMerchant(ctx, "C");
    for (let i = 0; i < 30; i++) await submit(a.auth, { phone: "0611111111", outcome: "refused", order_ref: `x${i}` });
    const res = await ctx.app.inject({ method: "POST", url: "/v1/score", headers: c.auth, payload: { phone: "0611111111" } });
    expect(res.json().band).toBe("insufficient_data");
  });

  it("new outcomes invalidate the cache immediately", async () => {
    const [a, b, c] = [await createMerchant(ctx, "A"), await createMerchant(ctx, "B"), await createMerchant(ctx, "C")];
    const phone = "0622222222";
    const lookup = () => ctx.app.inject({ method: "POST", url: "/v1/score", headers: c.auth, payload: { phone } });
    expect((await lookup()).json().band).toBe("insufficient_data"); // populates cache
    await submit(a.auth, { phone, outcome: "delivered", order_ref: "1" });
    await submit(a.auth, { phone, outcome: "delivered", order_ref: "2" });
    await submit(b.auth, { phone, outcome: "delivered", order_ref: "1" });
    expect((await lookup()).json().band).toBe("low");
  });

  it("suspended merchants' outcomes are ignored", async () => {
    const [a, b, c] = [await createMerchant(ctx, "A"), await createMerchant(ctx, "B"), await createMerchant(ctx, "C")];
    const phone = "0633333333";
    await submit(a.auth, { phone, outcome: "refused", order_ref: "1" });
    await submit(a.auth, { phone, outcome: "refused", order_ref: "2" });
    await submit(b.auth, { phone, outcome: "refused", order_ref: "1" });
    await ctx.prisma.merchant.update({ where: { id: b.merchant.id }, data: { status: "suspended" } });
    await ctx.redis.flushdb();
    ctx.app.network["trustCache"].clear();
    const res = await ctx.app.inject({ method: "POST", url: "/v1/score", headers: c.auth, payload: { phone } });
    expect(res.json().band).toBe("insufficient_data");
  });

  it("frozen (disputed) outcomes are excluded", async () => {
    const [a, b, c] = [await createMerchant(ctx, "A"), await createMerchant(ctx, "B"), await createMerchant(ctx, "C")];
    const phone = "0644444444";
    await submit(a.auth, { phone, outcome: "refused", order_ref: "1" });
    await submit(a.auth, { phone, outcome: "refused", order_ref: "2" });
    await submit(b.auth, { phone, outcome: "refused", order_ref: "1" });
    await ctx.prisma.outcome.updateMany({ where: { merchantId: b.merchant.id }, data: { status: "frozen" } });
    await ctx.redis.flushdb();
    const res = await ctx.app.inject({ method: "POST", url: "/v1/score", headers: c.auth, payload: { phone } });
    expect(res.json().band).toBe("insufficient_data");
  });

  it("records an audit log entry, a lookup row and usage for every lookup", async () => {
    const { auth, merchant } = await createMerchant(ctx);
    await ctx.app.inject({ method: "POST", url: "/v1/score", headers: auth, payload: { phone: "0612345678", order_ref: "ORD-9" } });
    const logs = await ctx.prisma.auditLog.findMany({ where: { action: "score_lookup" } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorType: "api_key", merchantId: merchant.id });
    expect(logs[0]!.phoneHash).toHaveLength(32);
    expect(logs[0]!.result).toMatchObject({ band: "insufficient_data" });
    const lookup = await ctx.prisma.lookup.findFirstOrThrow({ where: { merchantId: merchant.id } });
    expect(lookup).toMatchObject({ phoneLast2: "78", merchantOrderRef: "ORD-9", channel: "api" });
    const usage = await ctx.prisma.usageMonthly.findFirstOrThrow({ where: { merchantId: merchant.id } });
    expect(usage.lookups).toBe(1);
  });
});

describe("POST /v1/outcomes", () => {
  it("upserts by order_ref (status update instead of duplicate)", async () => {
    const { auth, merchant } = await createMerchant(ctx);
    const r1 = await submit(auth, { phone: "0612345678", outcome: "unreachable", order_ref: "ORD-1" });
    expect(r1.json()).toMatchObject({ inserted: 1, updated: 0 });
    const r2 = await submit(auth, { phone: "0612345678", outcome: "delivered", order_ref: "ORD-1", carrier: "Amana" });
    expect(r2.json()).toMatchObject({ inserted: 0, updated: 1 });
    const rows = await ctx.prisma.outcome.findMany({ where: { merchantId: merchant.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "delivered", carrier: "amana", source: "merchant_manual" });
  });

  it("is idempotent without order_ref (same phone, outcome, day)", async () => {
    const { auth, merchant } = await createMerchant(ctx);
    const payload = { phone: "0612345678", outcome: "refused", occurred_at: "2026-10-01T10:00:00Z" };
    await submit(auth, payload);
    await submit(auth, payload);
    expect(await ctx.prisma.outcome.count({ where: { merchantId: merchant.id } })).toBe(1);
  });

  it("never overwrites a disputed (frozen) record", async () => {
    const { auth, merchant } = await createMerchant(ctx);
    await submit(auth, { phone: "0612345678", outcome: "refused", order_ref: "ORD-1" });
    await ctx.prisma.outcome.updateMany({ where: { merchantId: merchant.id }, data: { status: "frozen" } });
    const r = await submit(auth, { phone: "0612345678", outcome: "refused", order_ref: "ORD-1", occurred_at: daysAgo(1) });
    expect(r.json()).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it("rejects unknown outcomes and future dates", async () => {
    const { auth } = await createMerchant(ctx);
    expect((await submit(auth, { phone: "0612345678", outcome: "blacklist" })).statusCode).toBe(400);
    expect((await submit(auth, { phone: "0612345678", outcome: "refused", occurred_at: "2999-01-01" })).statusCode).toBe(400);
  });

  it("batch: accepts valid rows and reports invalid ones by index", async () => {
    const { auth, merchant } = await createMerchant(ctx);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/outcomes/batch",
      headers: auth,
      payload: {
        outcomes: [
          { phone: "0612345678", outcome: "delivered", order_ref: "1" },
          { phone: "bad", outcome: "delivered", order_ref: "2" },
          { phone: "0712345678", outcome: "refused", order_ref: "3", city: "Fès" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: 3, accepted: 2, rejected: 1, inserted: 2 });
    expect(res.json().errors[0].index).toBe(1);
    const row = await ctx.prisma.outcome.findFirstOrThrow({ where: { merchantId: merchant.id, merchantOrderRef: "3" } });
    expect(row.cityCode).toBe("fes");
  });

  it("batch: rejects more than 1000 rows", async () => {
    const { auth } = await createMerchant(ctx);
    const outcomes = Array.from({ length: 1001 }, (_, i) => ({ phone: "0612345678", outcome: "delivered", order_ref: String(i) }));
    const res = await ctx.app.inject({ method: "POST", url: "/v1/outcomes/batch", headers: auth, payload: { outcomes } });
    expect(res.statusCode).toBe(400);
  });
});

describe("rate limiting & contribution", () => {
  const ctxLimited = ctx;
  it("throttles merchants with a low contribution ratio after the grace period", async () => {
    const { merchant, auth } = await createMerchant(ctxLimited, "Taker", { createdAt: new Date(Date.now() - 60 * 86_400_000) });
    // 400 lookups 30 days ago, no outcomes reported back → ratio 0 → throttled (10/min).
    await ctx.prisma.lookup.createMany({
      data: Array.from({ length: 400 }, (_, i) => ({
        merchantId: merchant.id,
        phoneHash: Buffer.alloc(32, i % 256),
        phoneLast2: "00",
        band: "low" as const,
        outcomesBucket: "0",
        merchantsBucket: "0",
        scoreVersion: "v1.0",
        createdAt: new Date(Date.now() - 30 * 86_400_000),
      })),
    });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await ctx.app.inject({ method: "POST", url: "/v1/score", headers: auth, payload: { phone: "0612345678" } })).statusCode);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.at(-1)).toBe(429);
  });

  it("new merchants are in the grace period", async () => {
    const { auth } = await createMerchant(ctx);
    const res = await ctx.app.inject({ method: "POST", url: "/v1/score", headers: auth, payload: { phone: "0612345678" } });
    expect(res.statusCode).toBe(200);
    expect(Number(res.headers["x-ratelimit-remaining"])).toBe(999);
  });
});
