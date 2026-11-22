import { describe, expect, it } from "vitest";
import { computeTrust, detectAnomalies, type AnomalyInputs } from "../src/index";

const clean = { carrierChecked: 0, contradicted: 0, upheldDisputes: 0, openFlagSeverities: [] as const };

describe("computeTrust", () => {
  it("a new merchant with no evidence keeps full trust", () => {
    expect(computeTrust({ ...clean, openFlagSeverities: [] }).trust).toBe(1);
  });

  it("a normal contradiction rate (~10%) is tolerated", () => {
    expect(computeTrust({ ...clean, openFlagSeverities: [], carrierChecked: 100, contradicted: 10 }).trust).toBe(1);
  });

  it("frequent contradictions lower trust; the prior protects small samples", () => {
    const small = computeTrust({ ...clean, openFlagSeverities: [], carrierChecked: 2, contradicted: 2 });
    const big = computeTrust({ ...clean, openFlagSeverities: [], carrierChecked: 100, contradicted: 50 });
    expect(small.trust).toBeGreaterThan(big.trust);
    // rate = 51/110 = 0.4636 → 1 - 2 × 0.3636 = 0.273
    expect(big.contradictionRate).toBeCloseTo(0.464, 3);
    expect(big.trust).toBeCloseTo(0.273, 3);
  });

  it("upheld disputes and open flags multiply in, never below minTrust", () => {
    expect(computeTrust({ ...clean, openFlagSeverities: [], upheldDisputes: 2 }).trust).toBeCloseTo(0.72, 2); // 0.85²
    expect(computeTrust({ ...clean, openFlagSeverities: ["medium", "high"] }).trust).toBeCloseTo(0.4, 3);
    expect(computeTrust({ carrierChecked: 100, contradicted: 100, upheldDisputes: 20, openFlagSeverities: ["high", "high"] }).trust).toBe(0.1);
  });

  it("is robust to nonsense inputs", () => {
    expect(computeTrust({ carrierChecked: -5, contradicted: 99, upheldDisputes: -1, openFlagSeverities: [] }).trust).toBe(1);
  });
});

describe("detectAnomalies", () => {
  const quiet: AnomalyInputs = {
    weekTotal: 100, weekRefused: 25, baselineTotal: 800, baselineRefused: 200,
    unlookedTotal: 200, unlookedRefused: 60, carrierChecked: 50, contradicted: 5, upheldDisputes90d: 0,
  };

  it("a normal merchant raises nothing (including a normal historical backfill)", () => {
    expect(detectAnomalies(quiet)).toEqual([]);
  });

  it("REFUSAL_SPIKE: high when the jump is large", () => {
    const r = detectAnomalies({ ...quiet, weekRefused: 70 });
    expect(r.map((x) => [x.kind, x.severity])).toEqual([["REFUSAL_SPIKE", "high"]]);
  });

  it("REFUSAL_SPIKE needs volume", () => {
    expect(detectAnomalies({ ...quiet, weekTotal: 10, weekRefused: 10 })).toEqual([]);
  });

  it("UNLOOKED_REFUSALS: dumping a list of refusals", () => {
    const r = detectAnomalies({ ...quiet, unlookedTotal: 120, unlookedRefused: 110 });
    expect(r[0]).toMatchObject({ kind: "UNLOOKED_REFUSALS", severity: "medium" });
  });

  it("CONTRADICTION_HIGH and DISPUTES_UPHELD", () => {
    const kinds = detectAnomalies({ ...quiet, carrierChecked: 40, contradicted: 20, upheldDisputes90d: 3 }).map((x) => x.kind);
    expect(kinds).toEqual(["CONTRADICTION_HIGH", "DISPUTES_UPHELD"]);
  });
});
