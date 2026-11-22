import type { Deps } from "../deps";
import { daysAgo, monthsAgo, period } from "../lib/time";
import { getContribution } from "./contribution";

/** Merchant dashboard stats, built ONLY from the merchant's own outcomes and lookups. */
export async function merchantStats(deps: Deps, merchantId: string) {
  const { prisma, env } = deps;
  const since = monthsAgo(env.RETENTION_MONTHS);

  const [byOutcome, monthly, byCarrier, bands, saved, merchant, usage, sub, contribution] = await Promise.all([
    prisma.outcome.groupBy({
      by: ["outcome"],
      where: { merchantId, occurredAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.$queryRaw<Array<{ month: string; total: bigint; refused: bigint }>>`
      SELECT to_char(date_trunc('month', "occurredAt"), 'YYYY-MM') AS month,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE "outcome" IN ('refused','returned')) AS refused
      FROM "Outcome"
      WHERE "merchantId" = ${merchantId} AND "occurredAt" >= ${monthsAgo(6)}
      GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<Array<{ carrier: string | null; total: bigint; refused: bigint }>>`
      SELECT "carrier", COUNT(*) AS total,
             COUNT(*) FILTER (WHERE "outcome" IN ('refused','returned')) AS refused
      FROM "Outcome"
      WHERE "merchantId" = ${merchantId} AND "occurredAt" >= ${since}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
    prisma.lookup.groupBy({
      by: ["band"],
      where: { merchantId, createdAt: { gte: daysAgo(30) } },
      _count: { _all: true },
    }),
    prisma.$queryRaw<Array<{ orders: bigint; expected_refusals: number | null }>>`
      SELECT COUNT(*) AS orders, SUM("score")::float / 100 AS expected_refusals
      FROM "Lookup"
      WHERE "merchantId" = ${merchantId} AND "decision" IN ('cancelled','prepaid_required') AND "score" IS NOT NULL`,
    prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { failedOrderCostCentimes: true } }),
    prisma.usageMonthly.findUnique({ where: { merchantId_period: { merchantId, period: period() } } }),
    prisma.subscription.findUnique({ where: { merchantId }, include: { plan: true } }),
    getContribution(deps, merchantId),
  ]);

  const counts = { delivered: 0, refused: 0, returned: 0, unreachable: 0 };
  for (const g of byOutcome) counts[g.outcome] = g._count._all;
  const total = counts.delivered + counts.refused + counts.returned + counts.unreachable;

  const expectedRefusals = saved[0]?.expected_refusals ?? 0;
  return {
    outcomes: {
      ...counts,
      total,
      refusal_rate: total ? (counts.refused + counts.returned) / total : null,
    },
    monthly: monthly.map((m) => ({ month: m.month, total: Number(m.total), refused: Number(m.refused) })),
    by_carrier: byCarrier.map((c) => ({ carrier: c.carrier ?? "unknown", total: Number(c.total), refused: Number(c.refused) })),
    lookups_30d: Object.fromEntries(bands.map((b) => [b.band, b._count._all])),
    money_saved: {
      orders_avoided: Number(saved[0]?.orders ?? 0),
      expected_refusals_avoided: Math.round(expectedRefusals * 10) / 10,
      failed_order_cost_mad: merchant.failedOrderCostCentimes / 100,
      estimate_mad: Math.round(expectedRefusals * merchant.failedOrderCostCentimes) / 100,
    },
    usage: {
      period: period(),
      lookups: usage?.lookups ?? 0,
      outcomes_submitted: usage?.outcomesSubmitted ?? 0,
      plan: sub ? { code: sub.plan.code, included_lookups: sub.plan.includedLookups } : null,
    },
    contribution,
  };
}
