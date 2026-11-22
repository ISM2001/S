/**
 * Merchant trust weight & anomaly detection: PURE functions (no I/O).
 * The trust job (apps/api/src/jobs/trust.ts) gathers the counts with SQL and calls these.
 *
 * Trust t ∈ [minTrust, 1] multiplies every outcome a merchant reports AND that merchant's
 * per-phone cap in score(). New merchants start at 1.0.
 */

export type Severity = "low" | "medium" | "high";
export type AnomalyKind = "REFUSAL_SPIKE" | "UNLOOKED_REFUSALS" | "CONTRADICTION_HIGH" | "DISPUTES_UPHELD";

export interface TrustInputs {
  /** Merchant-entered records later checked by a carrier-sourced record for the same order. */
  carrierChecked: number;
  /** ...of which the carrier said "delivered" where the merchant reported refused/returned/unreachable. */
  contradicted: number;
  /** Consumer disputes upheld against this merchant in the last 12 months (distinct requests). */
  upheldDisputes: number;
  /** Severities of this merchant's OPEN (not yet reviewed) anomaly flags. */
  openFlagSeverities: Severity[];
}

export interface TrustConfig {
  /** Beta prior on the contradiction rate: (c + a) / (k + a + b). */
  priorA: number;
  priorB: number;
  /** Contradiction rate tolerated before trust starts dropping (carrier data is noisy too). */
  tolerance: number;
  /** How fast trust drops per point of excess contradiction rate. */
  slope: number;
  /** Each upheld dispute multiplies trust by this. */
  disputeFactor: number;
  flagFactor: Record<Severity, number>;
  minTrust: number;
}

export const DEFAULT_TRUST_CONFIG: TrustConfig = Object.freeze({
  priorA: 1,
  priorB: 9,
  tolerance: 0.1,
  slope: 2,
  disputeFactor: 0.85,
  flagFactor: { low: 0.95, medium: 0.8, high: 0.5 },
  minTrust: 0.1,
}) as TrustConfig;

export interface TrustResult {
  trust: number;
  contradictionRate: number;
  components: { contradiction: number; disputes: number; flags: number };
}

export function computeTrust(i: TrustInputs, c: TrustConfig = DEFAULT_TRUST_CONFIG): TrustResult {
  const k = Math.max(0, i.carrierChecked);
  const contradicted = Math.min(Math.max(0, i.contradicted), k);
  const contradictionRate = (contradicted + c.priorA) / (k + c.priorA + c.priorB);
  const contradiction = clamp(1 - c.slope * Math.max(0, contradictionRate - c.tolerance), 0, 1);
  const disputes = Math.pow(c.disputeFactor, Math.max(0, i.upheldDisputes));
  const flags = i.openFlagSeverities.reduce((acc, s) => acc * (c.flagFactor[s] ?? 1), 1);
  const trust = round3(clamp(contradiction * disputes * flags, c.minTrust, 1));
  return { trust, contradictionRate: round3(contradictionRate), components: { contradiction: round3(contradiction), disputes: round3(disputes), flags: round3(flags) } };
}

// ── Anomalies ──────────────────────────────────────────────────────────────

export interface AnomalyInputs {
  /** Outcomes this merchant reported in the last 7 days, and how many were refused/returned. */
  weekTotal: number;
  weekRefused: number;
  /** Same for the 8 weeks before that (baseline). */
  baselineTotal: number;
  baselineRefused: number;
  /** Last 30 days: outcomes for phones this merchant NEVER looked up, and how many were refusals. */
  unlookedTotal: number;
  unlookedRefused: number;
  carrierChecked: number;
  contradicted: number;
  /** Upheld disputes in the last 90 days. */
  upheldDisputes90d: number;
}

export interface Anomaly {
  kind: AnomalyKind;
  severity: Severity;
  details: Record<string, number>;
}

export function detectAnomalies(a: AnomalyInputs): Anomaly[] {
  const out: Anomaly[] = [];

  // 1. Refusal share this week far above the merchant's own baseline (binomial z-test, needs volume).
  if (a.weekTotal >= 30 && a.baselineTotal >= 50) {
    const p0 = a.baselineRefused / a.baselineTotal;
    const p1 = a.weekRefused / a.weekTotal;
    const se = Math.sqrt(Math.max(p0 * (1 - p0), 0.01) / a.weekTotal);
    const z = (p1 - p0) / se;
    if (z > 3 && p1 - p0 > 0.15) {
      out.push({ kind: "REFUSAL_SPIKE", severity: p1 - p0 > 0.35 ? "high" : "medium", details: { week_share: round3(p1), baseline_share: round3(p0), z: round3(z), week_total: a.weekTotal } });
    }
  }

  // 2. Lots of refusals reported for phones the merchant never scored. A normal historical backfill
  //    has a refusal share close to the market (~25–35%); dumping a "blacklist" is mostly refusals.
  if (a.unlookedRefused >= 30 && a.unlookedTotal > 0 && a.unlookedRefused / a.unlookedTotal >= 0.6) {
    out.push({ kind: "UNLOOKED_REFUSALS", severity: "medium", details: { unlooked_total: a.unlookedTotal, unlooked_refused: a.unlookedRefused, share: round3(a.unlookedRefused / a.unlookedTotal) } });
  }

  // 3. Carrier data often contradicts this merchant's refusals.
  if (a.carrierChecked >= 20 && a.contradicted / a.carrierChecked > 0.3) {
    out.push({ kind: "CONTRADICTION_HIGH", severity: "high", details: { checked: a.carrierChecked, contradicted: a.contradicted, rate: round3(a.contradicted / a.carrierChecked) } });
  }

  // 4. Several consumer disputes upheld recently.
  if (a.upheldDisputes90d >= 3) {
    out.push({ kind: "DISPUTES_UPHELD", severity: "medium", details: { upheld_90d: a.upheldDisputes90d } });
  }
  return out;
}

function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}
function round3(x: number) {
  return Math.round(x * 1000) / 1000;
}
