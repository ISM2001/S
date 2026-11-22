import type { PrismaClient } from "@tiqa/db";
import { computeTrust, detectAnomalies, type Severity } from "@tiqa/scoring";

const DAY = 86_400_000;
const FLAG_COOLDOWN_DAYS = 30;

type Row = { merchant_id: string } & Record<string, bigint | number | string>;
const n = (v: unknown) => Number(v ?? 0);

/**
 * Hourly: detect anomalies per merchant, then recompute every merchant's trust weight
 * from carrier contradictions, upheld consumer disputes and OPEN anomaly flags.
 * The math lives in @tiqa/scoring (pure, unit-tested); this file only gathers counts.
 */
export async function runTrustJob(prisma: PrismaClient, now = new Date()) {
  const since12m = new Date(now.getTime() - 365 * DAY);
  const d7 = new Date(now.getTime() - 7 * DAY);
  const d30 = new Date(now.getTime() - 30 * DAY);
  const d63 = new Date(now.getTime() - 63 * DAY);
  const d90 = new Date(now.getTime() - 90 * DAY);

  const [checks, activity, unlooked, disputes, merchants] = await Promise.all([
    prisma.$queryRaw<Row[]>`
      SELECT "merchantId" AS merchant_id,
             COUNT(*) FILTER (WHERE "carrierChecked") AS checked,
             COUNT(*) FILTER (WHERE "contradicted") AS contradicted
      FROM "Outcome" WHERE "createdAt" >= ${since12m} GROUP BY 1`,
    prisma.$queryRaw<Row[]>`
      SELECT "merchantId" AS merchant_id,
        COUNT(*) FILTER (WHERE "createdAt" >= ${d7}) AS week_total,
        COUNT(*) FILTER (WHERE "createdAt" >= ${d7} AND "outcome" IN ('refused','returned')) AS week_refused,
        COUNT(*) FILTER (WHERE "createdAt" < ${d7}) AS base_total,
        COUNT(*) FILTER (WHERE "createdAt" < ${d7} AND "outcome" IN ('refused','returned')) AS base_refused
      FROM "Outcome" WHERE "createdAt" >= ${d63} GROUP BY 1`,
    prisma.$queryRaw<Row[]>`
      SELECT o."merchantId" AS merchant_id, COUNT(*) AS total,
             COUNT(*) FILTER (WHERE o."outcome" IN ('refused','returned')) AS refused
      FROM "Outcome" o
      WHERE o."createdAt" >= ${d30}
        AND NOT EXISTS (SELECT 1 FROM "Lookup" l WHERE l."merchantId" = o."merchantId" AND l."phoneHash" = o."phoneHash")
      GROUP BY 1`,
    prisma.$queryRaw<Row[]>`
      SELECT i."merchantId" AS merchant_id,
             COUNT(DISTINCT r."id") AS upheld_12m,
             COUNT(DISTINCT r."id") FILTER (WHERE r."resolvedAt" >= ${d90}) AS upheld_90d
      FROM "RequestItem" i JOIN "DataSubjectRequest" r ON r."id" = i."requestId"
      WHERE r."type" = 'dispute' AND r."status" = 'upheld' AND r."resolvedAt" >= ${since12m}
      GROUP BY 1`,
    prisma.merchant.findMany({ select: { id: true } }),
  ]);
  const by = (rows: Row[]) => new Map(rows.map((r) => [r.merchant_id, r]));
  const C = by(checks), A = by(activity), U = by(unlooked), D = by(disputes);

  let flagsRaised = 0;
  const cooldown = new Date(now.getTime() - FLAG_COOLDOWN_DAYS * DAY);
  for (const { id } of merchants) {
    const c = C.get(id), a = A.get(id), u = U.get(id), d = D.get(id);
    const anomalies = detectAnomalies({
      weekTotal: n(a?.week_total), weekRefused: n(a?.week_refused),
      baselineTotal: n(a?.base_total), baselineRefused: n(a?.base_refused),
      unlookedTotal: n(u?.total), unlookedRefused: n(u?.refused),
      carrierChecked: n(c?.checked), contradicted: n(c?.contradicted),
      upheldDisputes90d: n(d?.upheld_90d),
    });
    for (const an of anomalies) {
      // One open flag per kind; after a human review, don't re-raise the same kind for 30 days.
      const existing = await prisma.anomalyFlag.findFirst({
        where: { merchantId: id, kind: an.kind, OR: [{ status: "open" }, { reviewedAt: { gte: cooldown } }] },
      });
      if (existing) continue;
      await prisma.anomalyFlag.create({ data: { merchantId: id, kind: an.kind, severity: an.severity, details: an.details } });
      flagsRaised++;
    }

    const open = await prisma.anomalyFlag.findMany({ where: { merchantId: id, status: "open" }, select: { severity: true } });
    const t = computeTrust({
      carrierChecked: n(c?.checked),
      contradicted: n(c?.contradicted),
      upheldDisputes: n(d?.upheld_12m),
      openFlagSeverities: open.map((f) => f.severity as Severity),
    });
    await prisma.merchant.update({
      where: { id },
      data: {
        trustWeight: t.trust,
        trustComputedAt: now,
        trustDetails: { ...t, carrierChecked: n(c?.checked), contradicted: n(c?.contradicted), upheldDisputes: n(d?.upheld_12m), openFlags: open.length },
      },
    });
  }
  return { merchants: merchants.length, flagsRaised };
}
