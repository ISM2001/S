import { phoneLast2 } from "@tiqa/core";
import { bucketMerchants, bucketOutcomes, type Band, type ReasonCode } from "@tiqa/scoring";
import type { Deps } from "../deps";
import { period } from "../lib/time";
import { audit, type Actor } from "./audit";
import { getContribution } from "./contribution";
import type { Network } from "./network";
import { hit } from "./rate-limit";

export interface ScoreResponse {
  lookup_id: string;
  band: Band;
  score: number | null;
  outcomes_count: string;
  merchants_count: string;
  reasons: ReasonCode[];
  score_version: string;
}

/**
 * One merchant lookup: rate limit → hash → score → record (audit + merchant history + usage).
 * `e164` must already be normalized. It is hashed here and never stored or logged.
 */
export async function performLookup(
  deps: Deps,
  network: Network,
  args: { merchantId: string; actor: Actor; e164: string; orderRef?: string | null; channel: "api" | "dashboard" },
): Promise<{ response: ScoreResponse; rateRemaining: number }> {
  const contribution = await getContribution(deps, args.merchantId);
  const { remaining } = await hit(deps.redis, `lookup:${args.merchantId}`, contribution.limitPerMin);

  const hash = network.hash(args.e164);
  const result = await network.scoreHash(hash);

  const outcomesBucket = bucketOutcomes(result.outcomesCount);
  const merchantsBucket = bucketMerchants(result.merchantsCount);

  const [lookup] = await Promise.all([
    deps.prisma.lookup.create({
      data: {
        merchantId: args.merchantId,
        phoneHash: hash,
        phoneLast2: phoneLast2(args.e164),
        merchantOrderRef: args.orderRef ?? null,
        band: result.band,
        score: result.score,
        outcomesBucket,
        merchantsBucket,
        scoreVersion: result.scoreVersion,
        channel: args.channel,
      },
      select: { id: true },
    }),
    audit(deps, {
      actor: args.actor,
      merchantId: args.merchantId,
      action: "score_lookup",
      phoneHash: hash,
      result: { band: result.band, score: result.score, n: result.evidence, v: result.scoreVersion },
    }),
    deps.prisma.usageMonthly.upsert({
      where: { merchantId_period: { merchantId: args.merchantId, period: period() } },
      create: { merchantId: args.merchantId, period: period(), lookups: 1 },
      update: { lookups: { increment: 1 } },
    }),
  ]);

  return {
    rateRemaining: remaining,
    response: {
      lookup_id: lookup.id,
      band: result.band,
      score: result.score,
      outcomes_count: outcomesBucket,
      merchants_count: merchantsBucket,
      reasons: result.reasons,
      score_version: result.scoreVersion,
    },
  };
}
