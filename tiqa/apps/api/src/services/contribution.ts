import type { Deps } from "../deps";
import { daysAgo } from "../lib/time";

export type ContributionTier = "grace" | "full" | "reduced" | "throttled";

export interface Contribution {
  tier: ContributionTier;
  ratio: number | null;
  lookedUp: number;
  matched: number;
  /** Lookups per minute currently allowed. */
  limitPerMin: number;
}

const CACHE_TTL_S = 600;
export const GRACE_DAYS = 30;
export const GRACE_LOOKUPS = 300;
export const THROTTLED_LIMIT = 10;

/**
 * "Give data to get data".
 * ratio = (distinct phones this merchant scored 14–90 days ago AND later reported an outcome for)
 *       / (distinct phones this merchant scored 14–90 days ago)
 * The 14-day lag leaves time for deliveries to complete. Only outcomes for phones the merchant
 * actually scored count, so uploading junk rows can't game the ratio.
 */
export async function getContribution(deps: Deps, merchantId: string, opts: { fresh?: boolean } = {}): Promise<Contribution> {
  const key = `tiqa:contrib:${merchantId}`;
  if (!opts.fresh) {
    const cached = await deps.redis.get(key).catch(() => null);
    if (cached) return JSON.parse(cached) as Contribution;
  }
  const c = await computeContribution(deps, merchantId);
  await deps.redis.set(key, JSON.stringify(c), "EX", CACHE_TTL_S).catch(() => undefined);
  return c;
}

export async function computeContribution(deps: Deps, merchantId: string, now = new Date()): Promise<Contribution> {
  const base = deps.env.RATE_LIMIT_PER_MIN;
  const merchant = await deps.prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { createdAt: true } });
  const totalLookups = await deps.prisma.lookup.count({ where: { merchantId } });

  const from = daysAgo(90, now);
  const to = daysAgo(14, now);
  const [row] = await deps.prisma.$queryRaw<Array<{ looked_up: bigint; matched: bigint }>>`
    WITH looked AS (
      SELECT DISTINCT "phoneHash" FROM "Lookup"
      WHERE "merchantId" = ${merchantId} AND "createdAt" >= ${from} AND "createdAt" < ${to}
    )
    SELECT
      (SELECT COUNT(*) FROM looked) AS looked_up,
      (SELECT COUNT(*) FROM looked l WHERE EXISTS (
         SELECT 1 FROM "Outcome" o WHERE o."merchantId" = ${merchantId} AND o."phoneHash" = l."phoneHash"
      )) AS matched`;
  const lookedUp = Number(row?.looked_up ?? 0);
  const matched = Number(row?.matched ?? 0);
  const ratio = lookedUp > 0 ? matched / lookedUp : null;

  const inGrace = merchant.createdAt > daysAgo(GRACE_DAYS, now) || totalLookups < GRACE_LOOKUPS || lookedUp === 0;
  let tier: ContributionTier;
  let limitPerMin: number;
  if (inGrace) [tier, limitPerMin] = ["grace", base];
  else if (ratio! >= 0.5) [tier, limitPerMin] = ["full", base];
  else if (ratio! >= 0.2) [tier, limitPerMin] = ["reduced", Math.max(THROTTLED_LIMIT, Math.floor(base / 2))];
  else [tier, limitPerMin] = ["throttled", Math.min(THROTTLED_LIMIT, base)];

  return { tier, ratio, lookedUp, matched, limitPerMin };
}
