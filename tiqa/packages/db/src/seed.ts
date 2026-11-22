/**
 * Development seed: FAKE Moroccan numbers only (see seed-utils.ts).
 *   pnpm db:seed
 *
 * Creates placeholder plans, 5 demo merchants, a demo login, a fixed dev API key,
 * ~3,000 fake customers with realistic outcome histories, and lookup history for the demo store.
 * Re-runnable: it first deletes previous seed merchants (isSeed = true) and their data.
 */
import { hash as argonHash } from "@node-rs/argon2";
import { phoneHash, sha256 } from "@tiqa/core";
import { bucketMerchants, bucketOutcomes, score, type OutcomeSource, type OutcomeType, type ScoringOutcome } from "@tiqa/scoring";
import { Prisma, PrismaClient } from "@prisma/client";
import { assertNotProduction, demoPhone, mulberry32 } from "./seed-utils";

const pepper = assertNotProduction();
const prisma = new PrismaClient();
const rand = mulberry32(2026);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const DAY = 86_400_000;
const now = Date.now();

export const DEMO_EMAIL = "demo@tiqa.test";
export const STAFF_EMAIL = "admin@tiqa.test";
export const STAFF_PASSWORD = "admin-password-123";
export const DEMO_PASSWORD = "demo-password-123";
/** Fixed development key so the README's curl examples work. Never valid in production (different DB). */
export const DEMO_API_KEY_PREFIX = "000000000000";
export const DEMO_API_KEY_SECRET = "demo_secret_do_not_use_in_production";
export const DEMO_API_KEY = `tq_test_${DEMO_API_KEY_PREFIX}_${DEMO_API_KEY_SECRET}`;

const CITIES = ["casablanca", "rabat", "marrakech", "fes", "tanger", "agadir", "meknes", "oujda", "kenitra", "tetouan", "sale", "el_jadida"];
const CARRIERS = ["amana", "cathedis", "sendit", "ozon_express", "speedaf"];

type Persona = { name: string; share: number; pRefuse: number; pUnreachable: number };
const PERSONAS: Persona[] = [
  { name: "good", share: 0.68, pRefuse: 0.05, pUnreachable: 0.03 },
  { name: "average", share: 0.2, pRefuse: 0.25, pUnreachable: 0.08 },
  { name: "bad", share: 0.08, pRefuse: 0.7, pUnreachable: 0.1 },
  { name: "ghost", share: 0.04, pRefuse: 0.15, pUnreachable: 0.6 },
];

async function main() {
  // ── Plans (placeholder MAD pricing, to be decided) ────────────────────
  const plans = [
    { code: "free", nameFr: "Gratuit", nameAr: "مجاني", monthlyFeeCentimes: 0, includedLookups: 200, overageCentimesPerLookup: 0, rateLimitPerMin: 30 },
    { code: "starter", nameFr: "Starter", nameAr: "ستارتر", monthlyFeeCentimes: 19_900, includedLookups: 2_000, overageCentimesPerLookup: 15, rateLimitPerMin: 120 },
    { code: "pro", nameFr: "Pro", nameAr: "برو", monthlyFeeCentimes: 59_900, includedLookups: 10_000, overageCentimesPerLookup: 8, rateLimitPerMin: 600 },
  ];
  for (const p of plans) await prisma.plan.upsert({ where: { code: p.code }, create: p, update: p });
  const free = await prisma.plan.findUniqueOrThrow({ where: { code: "free" } });
  const starter = await prisma.plan.findUniqueOrThrow({ where: { code: "starter" } });

  // ── Clean previous seed ───────────────────────────────────────────────
  const old = await prisma.merchant.findMany({ where: { isSeed: true }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { merchantId: { in: old.map((m) => m.id) } } });
  await prisma.merchant.deleteMany({ where: { isSeed: true } });
  await prisma.dataSubjectRequest.deleteMany({ where: { items: { some: { merchantId: { in: old.map((m) => m.id) } } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: "@tiqa.test" } } });

  // ── Merchants ─────────────────────────────────────────────────────────
  const names = ["Demo Store", "Bazar Casa", "Mode Rabat", "Tech Fès", "Beauté Marrakech", "Promo Flash"];
  const merchants = [];
  for (const [i, name] of names.entries()) {
    merchants.push(
      await prisma.merchant.create({
        data: {
          name,
          isSeed: true,
          termsAcceptedAt: new Date(),
          termsVersion: "2026-11-draft",
          createdAt: new Date(now - (120 - i * 10) * DAY),
          subscription: { create: { planId: i === 0 ? starter.id : free.id } },
        },
      }),
    );
  }
  const demo = merchants[0]!;

  await prisma.user.create({
    data: {
      email: DEMO_EMAIL,
      passwordHash: await argonHash(DEMO_PASSWORD),
      emailVerifiedAt: new Date(),
      memberships: { create: { merchantId: demo.id, role: "owner" } },
    },
  });
  await prisma.user.create({
    data: { email: STAFF_EMAIL, passwordHash: await argonHash(STAFF_PASSWORD), emailVerifiedAt: new Date(), isStaff: true },
  });
  await prisma.apiKey.create({
    data: { merchantId: demo.id, name: "Dev key (seed)", prefix: DEMO_API_KEY_PREFIX, secretHash: sha256(DEMO_API_KEY_SECRET) },
  });

  // ── Customers & outcomes ──────────────────────────────────────────────
  type GenOutcome = { phone: string; merchantId: string; outcome: OutcomeType; source: OutcomeSource; carrier: string; city: string; t: number; ref: string };
  const all: GenOutcome[] = [];
  const others = merchants.slice(1, 5);
  const promo = merchants[5]!; // suspicious merchant for the admin panel demo
  let refN = 0;
  const add = (phone: string, m: { id: string }, outcome: OutcomeType, ageDays: number, source: OutcomeSource, city = pick(CITIES)) =>
    all.push({ phone, merchantId: m.id, outcome, source, carrier: pick(CARRIERS), city, t: now - ageDays * DAY, ref: `SEED-${++refN}` });

  // Three well-known demo numbers (see README):
  // 0600000001: serial refuser at 3 other stores → HIGH
  add(demoPhone(1), others[0]!, "refused", 4, "carrier_export");
  add(demoPhone(1), others[0]!, "refused", 25, "merchant_manual");
  add(demoPhone(1), others[1]!, "refused", 9, "carrier_api");
  add(demoPhone(1), others[2]!, "returned", 40, "carrier_export");
  add(demoPhone(1), others[2]!, "unreachable", 60, "merchant_manual");
  // 0600000002: reliable customer → LOW
  for (const [i, m] of [others[0], others[1], others[2], others[3], others[1]].entries()) add(demoPhone(2), m!, "delivered", 10 + i * 30, "carrier_export");
  // 0600000003: never seen → INSUFFICIENT DATA (no outcomes)
  // 0600000004: refused at 2 stores, but the person disputed everything → records frozen → INSUFFICIENT DATA
  add(demoPhone(4), others[0]!, "refused", 12, "merchant_manual");
  add(demoPhone(4), others[1]!, "refused", 20, "merchant_manual");
  add(demoPhone(4), others[1]!, "refused", 33, "merchant_manual");

  for (let i = 100; i < 3100; i++) {
    const phone = demoPhone(i);
    let r = rand();
    const persona = PERSONAS.find((p) => (r -= p.share) < 0) ?? PERSONAS[0]!;
    const city = pick(CITIES);
    const nOrders = 1 + Math.floor(rand() * 6);
    for (let k = 0; k < nOrders; k++) {
      const x = rand();
      const outcome: OutcomeType =
        x < persona.pRefuse ? (rand() < 0.75 ? "refused" : "returned") : x < persona.pRefuse + persona.pUnreachable ? "unreachable" : "delivered";
      const s = rand();
      const source: OutcomeSource = s < 0.1 ? "carrier_api" : s < 0.6 ? "carrier_export" : "merchant_manual";
      add(phone, pick(merchants.slice(0, 5)), outcome, Math.floor(rand() * 330), source, city);
    }
  }

  const rows = all.map((o) => ({
    phoneHash: phoneHash(o.phone, pepper),
    merchantId: o.merchantId,
    outcome: o.outcome,
    source: o.source,
    carrier: o.carrier,
    cityCode: o.city,
    occurredAt: new Date(o.t),
    merchantOrderRef: o.ref,
  }));
  for (let i = 0; i < rows.length; i += 2000) await prisma.outcome.createMany({ data: rows.slice(i, i + 2000) });

  // ── "Promo Flash": reports refusals that its own carrier exports later contradict ──
  const promoRows = Array.from({ length: 40 }, (_, k) => ({
    phoneHash: phoneHash(demoPhone(5000 + k), pepper),
    merchantId: promo.id,
    outcome: k < 26 ? ("delivered" as const) : ("refused" as const),
    source: "carrier_export" as const,
    carrierChecked: true,
    contradicted: k < 26, // was entered as "refused", carrier says "delivered"
    carrier: "amana",
    occurredAt: new Date(now - (5 + k) * DAY),
    merchantOrderRef: `PF-${k}`,
  }));
  await prisma.outcome.createMany({ data: promoRows });

  // ── An open consumer dispute (shows in the admin panel) ──
  const disputed = await prisma.outcome.findMany({ where: { phoneHash: phoneHash(demoPhone(4), pepper) } });
  await prisma.dataSubjectRequest.create({
    data: {
      phoneHash: phoneHash(demoPhone(4), pepper),
      type: "dispute",
      message: "Je n'ai jamais passé ces commandes, quelqu'un a utilisé mon numéro.",
      items: {
        create: disputed.map((o) => ({
          outcomeId: o.id, merchantId: o.merchantId, outcome: o.outcome, source: o.source, occurredAt: o.occurredAt, merchantOrderRef: o.merchantOrderRef,
        })),
      },
    },
  });
  await prisma.outcome.updateMany({ where: { id: { in: disputed.map((o) => o.id) } }, data: { status: "frozen" } });

  // ── Lookup history for the demo store (bands computed with the real scorer) ──
  const byPhone = new Map<string, ScoringOutcome[]>();
  for (const o of all) {
    const list = byPhone.get(o.phone) ?? [];
    list.push({ merchantId: o.merchantId, outcome: o.outcome, source: o.source, occurredAt: new Date(o.t) });
    byPhone.set(o.phone, list);
  }
  const lookups: Prisma.LookupCreateManyInput[] = [];
  for (let j = 0; j < 180; j++) {
    const phone = demoPhone(j < 3 ? j + 1 : 100 + Math.floor(rand() * 3000));
    const at = now - Math.floor(rand() * 60) * DAY - Math.floor(rand() * DAY);
    const outcomesAtTime = (byPhone.get(phone) ?? []).filter((o) => o.occurredAt.getTime() < at);
    const res = score(outcomesAtTime, {}, new Date(at));
    lookups.push({
      merchantId: demo.id,
      phoneHash: phoneHash(phone, pepper),
      phoneLast2: phone.slice(-2),
      merchantOrderRef: `WA-${1000 + j}`,
      band: res.band,
      score: res.score,
      outcomesBucket: bucketOutcomes(res.outcomesCount),
      merchantsBucket: bucketMerchants(res.merchantsCount),
      scoreVersion: res.scoreVersion,
      channel: rand() < 0.7 ? "api" : "dashboard",
      decision: res.band === "high" ? (rand() < 0.6 ? "cancelled" : "prepaid_required") : res.band === "insufficient_data" ? null : "shipped",
      createdAt: new Date(at),
    });
  }
  await prisma.lookup.createMany({ data: lookups });

  const counts = await prisma.outcome.groupBy({ by: ["outcome"], where: { merchant: { isSeed: true } }, _count: { _all: true } });
  console.log("\n✅ Seed complete (fake numbers only)\n");
  console.log("  Outcomes:", Object.fromEntries(counts.map((c) => [c.outcome, c._count._all])));
  console.log("  Lookups (Demo Store):", lookups.length);
  console.log(`\n  Dashboard login:  ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  Admin (staff):    ${STAFF_EMAIL} / ${STAFF_PASSWORD}`);
  console.log(`  Dev API key:      ${DEMO_API_KEY}`);
  console.log("\n  Try: 0600000001 (HIGH) · 0600000002 (LOW) · 0600000003 (no history) · 0600000004 (disputed → frozen)");
  console.log("  Trust weights & anomaly flags are computed by the worker (`pnpm dev` starts it).\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
