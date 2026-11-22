import { phoneLast2 } from "@tiqa/core";
import { bucketMerchants, bucketOutcomes, type Band, type ReasonCode } from "@tiqa/scoring";
import type { Deps } from "../deps";
import { period } from "../lib/time";
import { audit, type Actor } from "./audit";
import { getContribution } from "./contribution";
import type { Network } from "./network";
import { hit } from "./rate-limit";
import { emitEvent } from "./webhooks-out";
import { checkQuota } from "./billing";
import { ApiError } from "../lib/errors";

export type LookupChannel = "api" | "dashboard" | "webhook" | "shopify" | "youcan";

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
  args: { merchantId: string; actor: Actor; e164: string; orderRef?: string | null; channel: LookupChannel },
): Promise<{ response: ScoreResponse; rateRemaining: number }> {
  const contribution = await getContribution(deps, args.merchantId);
  const { remaining } = await hit(deps.redis, `lookup:${args.merchantId}`, contribution.limitPerMin);
  const quota = await checkQuota(deps.prisma, args.merchantId, period());
  if (quota.blocked) throw new ApiError(402, "QUOTA_EXCEEDED", "QUOTA_EXCEEDED", { included_lookups: quota.included });

  await network.migrateToCurrentKey([args.e164]);
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

  const response: ScoreResponse = {
    lookup_id: lookup.id,
    band: result.band,
    score: result.score,
    outcomes_count: outcomesBucket,
    merchants_count: merchantsBucket,
    reasons: result.reasons,
    score_version: result.scoreVersion,
  };
  // Outbound webhook (no phone number in the payload; the merchant matches on order_ref).
  void emitEvent(deps, args.merchantId, "score.created", { ...response, order_ref: args.orderRef ?? null, channel: args.channel }).catch(() => undefined);
  return { rateRemaining: remaining, response };
}
