/**
 * Tiqa scoring v1: explainable delivery-risk score.
 *
 * PURE: no I/O, no clock, no randomness. Same input → same output.
 * Swap this module for an ML model later as long as the ScoreResult contract holds.
 *
 * Formula (see docs/DESIGN.md §b):
 *   w_i  = decay(age_i) × sourceWeight_i × trust_m
 *   cap  : Σ w_i per merchant ≤ merchantCap × trust_m   (scaled down proportionally)
 *   n    = Σ w_i,  r = Σ w_i·y_i
 *   p    = (r + priorMean·priorStrength) / (n + priorStrength)
 */

export type OutcomeType = "delivered" | "refused" | "returned" | "unreachable";
export type OutcomeSource = "carrier_api" | "carrier_export" | "merchant_manual";
export type Band = "low" | "medium" | "high" | "insufficient_data";

export type ReasonCode =
  | "LIMITED_HISTORY"
  | "HISTORY_MOSTLY_OLD"
  | "REFUSALS_AT_MULTIPLE_STORES"
  | "RECENT_REFUSALS"
  | "UNREACHABLE_HISTORY"
  | "MOSTLY_DELIVERED"
  | "CARRIER_CONFIRMED_HISTORY";

export interface ScoringOutcome {
  merchantId: string;
  outcome: OutcomeType;
  source: OutcomeSource;
  occurredAt: Date;
}

export interface ScoringConfig {
  version: string;
  /** Network-average refusal rate used as the Bayesian prior mean. */
  priorMean: number;
  /** Prior strength in "pseudo-outcomes". */
  priorStrength: number;
  /** Half-life of an outcome's weight, in days. */
  halfLifeDays: number;
  sourceWeights: Record<OutcomeSource, number>;
  /** How much each outcome type counts as a refusal (0..1). */
  refusalValue: Record<OutcomeType, number>;
  /** Max total weight one merchant can contribute (multiplied by its trust). */
  merchantCap: number;
  /** Minimum raw number of outcomes to return a score. */
  minOutcomes: number;
  /** Minimum number of distinct merchants to return a score. */
  minMerchants: number;
  /** Minimum effective (decayed, weighted) evidence to return a score. */
  minEvidence: number;
  bands: { mediumFrom: number; highFrom: number };
  /** Trust used for merchants absent from the trust map. */
  defaultTrust: number;
  /** "Recent" window for the RECENT_REFUSALS reason, in days. */
  recentDays: number;
}

export const DEFAULT_CONFIG: ScoringConfig = Object.freeze({
  version: "v1.0",
  priorMean: 0.25,
  priorStrength: 4,
  halfLifeDays: 90,
  sourceWeights: { carrier_api: 1.0, carrier_export: 0.8, merchant_manual: 0.6 },
  refusalValue: { delivered: 0, refused: 1, returned: 1, unreachable: 0.5 },
  merchantCap: 2.0,
  minOutcomes: 3,
  minMerchants: 2,
  minEvidence: 1.0,
  bands: { mediumFrom: 0.2, highFrom: 0.4 },
  defaultTrust: 1.0,
  recentDays: 30,
}) as ScoringConfig;

export interface ScoreResult {
  band: Band;
  /** 0–100, null when band is insufficient_data. */
  score: number | null;
  /** Smoothed refusal probability (unrounded), null when insufficient. */
  p: number | null;
  /** Effective evidence n after decay, weights and caps. */
  evidence: number;
  /** Raw number of outcomes considered (merchants with trust 0 excluded). */
  outcomesCount: number;
  /** Distinct merchants considered. */
  merchantsCount: number;
  reasons: ReasonCode[];
  scoreVersion: string;
}

export type TrustMap = ReadonlyMap<string, number> | Readonly<Record<string, number>>;

const DAY_MS = 86_400_000;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function trustOf(trust: TrustMap, merchantId: string, fallback: number): number {
  const t = trust instanceof Map ? trust.get(merchantId) : (trust as Record<string, number>)[merchantId];
  return clamp(typeof t === "number" && Number.isFinite(t) ? t : fallback, 0, 1);
}

export function decay(ageDays: number, halfLifeDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

interface Weighted {
  merchantId: string;
  outcome: OutcomeType;
  source: OutcomeSource;
  ageDays: number;
  w: number; // final weight after cap
  wNoDecay: number; // weight if there were no decay (after cap scaling), for the "old history" reason
  y: number;
}

export function score(
  outcomes: readonly ScoringOutcome[],
  trust: TrustMap,
  now: Date,
  config: ScoringConfig = DEFAULT_CONFIG,
): ScoreResult {
  const nowMs = now.getTime();

  // 1. Per-outcome weights, grouped by merchant.
  const byMerchant = new Map<string, Weighted[]>();
  for (const o of outcomes) {
    const t = o.occurredAt instanceof Date ? o.occurredAt.getTime() : NaN;
    if (!Number.isFinite(t)) continue;
    const tm = trustOf(trust, o.merchantId, config.defaultTrust);
    if (tm <= 0) continue; // suspended / zero-trust merchants contribute nothing
    const ageDays = Math.max(0, (nowMs - t) / DAY_MS);
    const base = (config.sourceWeights[o.source] ?? 0) * tm;
    if (base <= 0) continue;
    const item: Weighted = {
      merchantId: o.merchantId,
      outcome: o.outcome,
      source: o.source,
      ageDays,
      w: base * decay(ageDays, config.halfLifeDays),
      wNoDecay: base,
      y: config.refusalValue[o.outcome] ?? 0,
    };
    const list = byMerchant.get(o.merchantId);
    if (list) list.push(item);
    else byMerchant.set(o.merchantId, [item]);
  }

  // 2. Per-merchant cap (anti-poisoning), proportional scaling keeps that merchant's own ratio.
  const all: Weighted[] = [];
  for (const [merchantId, list] of byMerchant) {
    const cap = config.merchantCap * trustOf(trust, merchantId, config.defaultTrust);
    const total = list.reduce((s, x) => s + x.w, 0);
    const totalNoDecay = list.reduce((s, x) => s + x.wNoDecay, 0);
    const f = total > cap ? cap / total : 1;
    const fNoDecay = totalNoDecay > cap ? cap / totalNoDecay : 1;
    for (const x of list) {
      x.w *= f;
      x.wNoDecay *= fNoDecay;
      all.push(x);
    }
  }

  // 3. Evidence.
  const n = all.reduce((s, x) => s + x.w, 0);
  const r = all.reduce((s, x) => s + x.w * x.y, 0);
  const nNoDecay = all.reduce((s, x) => s + x.wNoDecay, 0);
  const outcomesCount = all.length;
  const merchantsCount = byMerchant.size;

  const base = { evidence: round4(n), outcomesCount, merchantsCount, scoreVersion: config.version };

  // 4. Insufficient data?
  const tooFew = outcomesCount < config.minOutcomes || merchantsCount < config.minMerchants;
  if (tooFew || n < config.minEvidence) {
    return {
      ...base,
      band: "insufficient_data",
      score: null,
      p: null,
      reasons: tooFew ? ["LIMITED_HISTORY"] : ["HISTORY_MOSTLY_OLD"],
    };
  }

  // 5. Bayesian smoothing.
  const p = (r + config.priorMean * config.priorStrength) / (n + config.priorStrength);
  const band: Band = p >= config.bands.highFrom ? "high" : p >= config.bands.mediumFrom ? "medium" : "low";

  return { ...base, band, score: Math.round(p * 100), p, reasons: reasonsFor(all, n, nNoDecay, config) };
}

function reasonsFor(all: Weighted[], n: number, nNoDecay: number, config: ScoringConfig): ReasonCode[] {
  const reasons: ReasonCode[] = [];
  const isRefusal = (x: Weighted) => x.outcome === "refused" || x.outcome === "returned";

  const refusingMerchants = new Set(all.filter(isRefusal).map((x) => x.merchantId));
  if (refusingMerchants.size >= 2) reasons.push("REFUSALS_AT_MULTIPLE_STORES");

  if (all.some((x) => isRefusal(x) && x.ageDays <= config.recentDays)) reasons.push("RECENT_REFUSALS");

  const share = (pred: (x: Weighted) => boolean) => all.filter(pred).reduce((s, x) => s + x.w, 0) / n;

  if (share((x) => x.outcome === "unreachable") >= 0.25) reasons.push("UNREACHABLE_HISTORY");
  if (share((x) => x.outcome === "delivered") >= 0.75) reasons.push("MOSTLY_DELIVERED");
  if (share((x) => x.source !== "merchant_manual") >= 0.5) reasons.push("CARRIER_CONFIRMED_HISTORY");
  // Decay removed more than ~65% of the evidence → history is mostly old (median age > ~4.5 months).
  if (nNoDecay > 0 && n / nNoDecay < 0.35) reasons.push("HISTORY_MOSTLY_OLD");

  return reasons;
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

// ── Count buckets ────────────────────────────────────────────────────────────
// Exact counts would let a merchant subtract its own reports and learn about
// other stores (differencing). The API therefore only exposes coarse buckets.

export function bucketOutcomes(n: number): string {
  if (n <= 0) return "0";
  if (n <= 2) return "1-2";
  if (n <= 5) return "3-5";
  if (n <= 10) return "6-10";
  return "11+";
}

export function bucketMerchants(n: number): string {
  if (n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 3) return "2-3";
  if (n <= 5) return "4-5";
  return "6+";
}
