import { describe, expect, it } from "vitest";
import { consumerLogin, createMerchant, setupTestApp, staffLogin } from "./helpers";

const ctx = setupTestApp();
const PHONE = "0655554444";

async function seedHistory() {
  const a = await createMerchant(ctx, "Store A");
  const b = await createMerchant(ctx, "Store B");
  const c = await createMerchant(ctx, "Store C");
  const post = (auth: Record<string, string>, payload: object) => ctx.app.inject({ method: "POST", url: "/v1/outcomes", headers: auth, payload });
  await post(a.auth, { phone: PHONE, outcome: "refused", order_ref: "A1", city: "Rabat", carrier: "Amana" });
  await post(a.auth, { phone: PHONE, outcome: "refused", order_ref: "A2" });
  await post(b.auth, { phone: PHONE, outcome: "returned", order_ref: "B1" });
  const score = () => ctx.app.inject({ method: "POST", url: "/v1/score", headers: c.auth, payload: { phone: PHONE } }).then((r) => r.json());
  return { a, b, c, score };
}

describe("OTP", () => {
  it("sends a 6-digit code by SMS; wrong code fails; right code opens a session", async () => {
    const r = await ctx.app.inject({ method: "POST", url: "/public/otp/request", payload: { phone: "06 55 55 44 44" } });
    expect(r.statusCode).toBe(200);
    expect(ctx.sms).toHaveLength(1);
    expect(ctx.sms[0]!.to).toBe("+212655554444");
    const code = /(\d{6})/.exec(ctx.sms[0]!.text)![1]!;
    const wrong = await ctx.app.inject({ method: "POST", url: "/public/otp/verify", payload: { phone: PHONE, code: code === "000000" ? "111111" : "000000" } });
    expect(wrong.statusCode).toBe(401);
    const ok = await ctx.app.inject({ method: "POST", url: "/public/otp/verify", payload: { phone: PHONE, code } });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers["set-cookie"])).toMatch(/tiqa_consumer=.*HttpOnly.*SameSite=Strict/i);
    // single use
    const again = await ctx.app.inject({ method: "POST", url: "/public/otp/verify", payload: { phone: PHONE, code } });
    expect(again.statusCode).toBe(401);
  });

  it("locks the code after 5 wrong attempts", async () => {
    await ctx.app.inject({ method: "POST", url: "/public/otp/request", payload: { phone: PHONE } });
    const code = /(\d{6})/.exec(ctx.sms[0]!.text)![1]!;
    const wrongCode = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) await ctx.app.inject({ method: "POST", url: "/public/otp/verify", payload: { phone: PHONE, code: wrongCode } });
    const r = await ctx.app.inject({ method: "POST", url: "/public/otp/verify", payload: { phone: PHONE, code } });
    expect(r.statusCode).toBe(401);
  });

  it("limits SMS per number (3/hour)", async () => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await ctx.app.inject({ method: "POST", url: "/public/otp/request", payload: { phone: PHONE } })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  it("stores neither the phone nor the code", async () => {
    await ctx.app.inject({ method: "POST", url: "/public/otp/request", payload: { phone: PHONE } });
    const code = /(\d{6})/.exec(ctx.sms[0]!.text)![1]!;
    const rows = await ctx.prisma.$queryRawUnsafe<unknown[]>(`SELECT row_to_json(t)::text AS j FROM "OtpChallenge" t`);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("655554444");
    expect(dump).not.toContain(code);
  });

  it("answers 503 when no SMS provider is configured (production without provider)", async () => {
    ctx.deps.sms = { available: false, send: async () => undefined };
    try {
      const r = await ctx.app.inject({ method: "POST", url: "/public/otp/request", payload: { phone: PHONE } });
      expect(r.statusCode).toBe(503);
    } finally {
      ctx.deps.sms = { available: true, send: async (to, text) => void ctx.sms.push({ to, text }) };
    }
  });
});

describe("access, dispute, deletion", () => {
  it("summary shows the person's records without revealing stores", async () => {
    const { a, b } = await seedHistory();
    const { cookie } = await consumerLogin(ctx, PHONE);
    const me = await ctx.app.inject({ method: "GET", url: "/public/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.records).toHaveLength(3);
    expect(body.stores_count).toBe(2);
    expect(body.records[0]).toHaveProperty("month");
    const dump = JSON.stringify(body);
    for (const s of [a.merchant.id, b.merchant.id, "Store A", "A1", "B1"]) expect(dump).not.toContain(s);
    expect(await ctx.prisma.auditLog.count({ where: { action: "consumer_view" } })).toBe(1);
  });

  it("the consumer session only sees its own number", async () => {
    await seedHistory();
    const { cookie } = await consumerLogin(ctx, "0711112222");
    const me = (await ctx.app.inject({ method: "GET", url: "/public/me", headers: { cookie } })).json();
    expect(me.records).toHaveLength(0);
  });

  it("requires a consumer session", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/public/me" })).statusCode).toBe(401);
  });

  it("dispute freezes records immediately → excluded from scoring; rejection unfreezes", async () => {
    const { score } = await seedHistory();
    expect((await score()).band).toBe("high");
    const { cookie } = await consumerLogin(ctx, PHONE);
    const recs = (await ctx.app.inject({ method: "GET", url: "/public/me", headers: { cookie } })).json().records;
    const d = await ctx.app.inject({
      method: "POST", url: "/public/me/requests", headers: { cookie },
      payload: { type: "dispute", outcome_ids: [recs[0].id], message: "Je n'ai jamais commandé." },
    });
    expect(d.json()).toMatchObject({ type: "dispute", status: "open", frozen_records: 1 });
    expect(await ctx.prisma.outcome.count({ where: { status: "frozen" } })).toBe(1);
    expect((await score()).band).toBe("insufficient_data"); // 2 records from 1 store left

    const staff = await staffLogin(ctx);
    const r = await ctx.app.inject({ method: "POST", url: `/admin/requests/${d.json().id}/resolve`, headers: { cookie: staff.cookie }, payload: { decision: "rejected", note: "Carrier proof" } });
    expect(r.statusCode).toBe(200);
    expect(await ctx.prisma.outcome.count({ where: { status: "frozen" } })).toBe(0);
    expect((await score()).band).toBe("high");
  });

  it("upheld dispute deletes the disputed records and counts against the reporting merchant", async () => {
    const { a } = await seedHistory();
    const { cookie } = await consumerLogin(ctx, PHONE);
    const d = await ctx.app.inject({ method: "POST", url: "/public/me/requests", headers: { cookie }, payload: { type: "dispute" } });
    expect(d.json().frozen_records).toBe(3);
    const staff = await staffLogin(ctx);
    const list = (await ctx.app.inject({ method: "GET", url: "/admin/requests", headers: { cookie: staff.cookie } })).json();
    expect(list[0].items.map((i: { merchant_name: string }) => i.merchant_name).sort()).toEqual(["Store A", "Store A", "Store B"]);
    expect(JSON.stringify(list)).not.toContain("655554444");
    await ctx.app.inject({ method: "POST", url: `/admin/requests/${d.json().id}/resolve`, headers: { cookie: staff.cookie }, payload: { decision: "upheld" } });
    expect(await ctx.prisma.outcome.count()).toBe(0);
    const items = await ctx.prisma.requestItem.count({ where: { merchantId: a.merchant.id } });
    expect(items).toBe(2); // snapshot kept for trust computation
    const again = await ctx.app.inject({ method: "POST", url: `/admin/requests/${d.json().id}/resolve`, headers: { cookie: staff.cookie }, payload: { decision: "rejected" } });
    expect(again.statusCode).toBe(400);
  });

  it("upheld deletion removes everything linked to the number", async () => {
    const { c } = await seedHistory();
    await ctx.app.inject({ method: "POST", url: "/v1/score", headers: c.auth, payload: { phone: PHONE } }); // a lookup in C's history
    const { cookie } = await consumerLogin(ctx, PHONE);
    const d = await ctx.app.inject({ method: "POST", url: "/public/me/requests", headers: { cookie }, payload: { type: "deletion" } });
    const staff = await staffLogin(ctx);
    await ctx.app.inject({ method: "POST", url: `/admin/requests/${d.json().id}/resolve`, headers: { cookie: staff.cookie }, payload: { decision: "upheld" } });

    const hash = ctx.app.network.hash("+212655554444");
    expect(await ctx.prisma.outcome.count({ where: { phoneHash: hash } })).toBe(0);
    expect(await ctx.prisma.lookup.count({ where: { phoneHash: hash } })).toBe(0);
    expect(await ctx.prisma.lookup.count({ where: { merchantId: c.merchant.id } })).toBe(1); // merchant keeps its row, unlinked
    expect(await ctx.prisma.otpChallenge.count({ where: { phoneHash: hash } })).toBe(0);
    expect(await ctx.prisma.consumerSession.count({ where: { phoneHash: hash } })).toBe(0);
    expect(await ctx.prisma.dataSubjectRequest.count({ where: { phoneHash: hash } })).toBe(0);
    const req = await ctx.prisma.dataSubjectRequest.findUniqueOrThrow({ where: { id: d.json().id }, include: { items: true } });
    expect(req).toMatchObject({ status: "upheld", phoneHash: null, items: [] });
  });

  it("frozen records cannot be overwritten by merchants while under review", async () => {
    const { a } = await seedHistory();
    const { cookie } = await consumerLogin(ctx, PHONE);
    await ctx.app.inject({ method: "POST", url: "/public/me/requests", headers: { cookie }, payload: { type: "deletion" } });
    const r = await ctx.app.inject({ method: "POST", url: "/v1/outcomes", headers: a.auth, payload: { phone: PHONE, outcome: "refused", order_ref: "A1" } });
    expect(r.json()).toMatchObject({ unchanged: 1 });
  });
});
