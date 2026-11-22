import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  bucketMerchants,
  bucketOutcomes,
  decay,
  score,
  type OutcomeSource,
  type OutcomeType,
  type ScoringOutcome,
} from "../src/index";

const NOW = new Date("2026-11-22T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const o = (merchantId: string, outcome: OutcomeType, source: OutcomeSource, ageDays: number): ScoringOutcome => ({
  merchantId,
  outcome,
  source,
  occurredAt: daysAgo(ageDays),
});
const SRC = { api: "carrier_api", export: "carrier_export", manual: "merchant_manual" } as const;
const NO_TRUST = {};

describe("decay", () => {
  it("halves every half-life", () => {
    expect(decay(0, 90)).toBe(1);
    expect(decay(90, 90)).toBeCloseTo(0.5, 10);
    expect(decay(180, 90)).toBeCloseTo(0.25, 10);
  });
  it("treats future dates as age 0", () => {
    expect(decay(-10, 90)).toBe(1);
  });
});

describe("worked examples from docs/DESIGN.md", () => {
  it("A: serial refuser across 4 stores → HIGH 57", () => {
    const r = score(
      [
        o("m1", "refused", SRC.manual, 3),
        o("m1", "refused", SRC.manual, 20),
        o("m2", "refused", SRC.export, 10),
        o("m3", "refused", SRC.manual, 35),
        o("m4", "refused", SRC.api, 50),
        o("m4", "unreachable", SRC.manual, 60),
      ],
      NO_TRUST,
      NOW,
    );
    expect(r.band).toBe("high");
    expect(r.score).toBe(57);
    expect(r.p).toBeCloseTo(0.567, 3);
    expect(r.evidence).toBeCloseTo(3.358, 3);
    expect(r.outcomesCount).toBe(6);
    expect(r.merchantsCount).toBe(4);
    expect(r.reasons).toContain("REFUSALS_AT_MULTIPLE_STORES");
    expect(r.reasons).toContain("RECENT_REFUSALS");
  });

  it("B: good customer → LOW 16", () => {
    const r = score(
      [
        o("m1", "delivered", SRC.export, 5),
        o("m1", "delivered", SRC.manual, 40),
        o("m2", "delivered", SRC.api, 15),
        o("m2", "delivered", SRC.export, 70),
        o("m3", "delivered", SRC.manual, 25),
        o("m3", "refused", SRC.manual, 120),
        o("m3", "delivered", SRC.manual, 200),
        o("m2", "delivered", SRC.manual, 100),
      ],
      NO_TRUST,
      NOW,
    );
    expect(r.band).toBe("low");
    expect(r.score).toBe(16);
    expect(r.reasons).toContain("MOSTLY_DELIVERED");
    expect(r.reasons).not.toContain("REFUSALS_AT_MULTIPLE_STORES");
  });

  const poisoning = [
    ...Array.from({ length: 20 }, (_, i) => o("mX", "refused", SRC.manual, i + 1)),
    o("mY", "delivered", SRC.api, 10),
    o("mY", "delivered", SRC.api, 30),
    o("mZ", "delivered", SRC.export, 20),
  ];

  it("C: one store spamming refusals is capped → MEDIUM 36", () => {
    const r = score(poisoning, NO_TRUST, NOW);
    expect(r.band).toBe("medium");
    expect(r.score).toBe(36);
    expect(r.evidence).toBeCloseTo(4.405, 3);
  });

  it("C without the cap would have been HIGH (sanity check of the cap's effect)", () => {
    const r = score(poisoning, NO_TRUST, NOW, { ...DEFAULT_CONFIG, merchantCap: 1e9 });
    expect(r.band).toBe("high");
    expect(r.p!).toBeCloseTo(0.691, 3);
  });

  it("C with low trust (0.3) for the spamming store → 23", () => {
    const r = score(poisoning, { mX: 0.3 }, NOW);
    expect(r.score).toBe(23);
    expect(r.evidence).toBeCloseTo(3.005, 3);
  });

  it("C with the spamming store as the only reporter → insufficient data", () => {
    const r = score(poisoning.filter((x) => x.merchantId === "mX"), NO_TRUST, NOW);
    expect(r.band).toBe("insufficient_data");
    expect(r.score).toBeNull();
    expect(r.reasons).toEqual(["LIMITED_HISTORY"]);
  });

  it("D: only old history → insufficient data (HISTORY_MOSTLY_OLD)", () => {
    const r = score(
      [
        o("m1", "refused", SRC.manual, 300),
        o("m1", "refused", SRC.manual, 310),
        o("m2", "refused", SRC.manual, 280),
        o("m2", "refused", SRC.manual, 330),
      ],
      NO_TRUST,
      NOW,
    );
    expect(r.band).toBe("insufficient_data");
    expect(r.reasons).toEqual(["HISTORY_MOSTLY_OLD"]);
    expect(r.evidence).toBeCloseTo(0.231, 2);
  });
});

describe("insufficient data rules", () => {
  it("empty input", () => {
    const r = score([], NO_TRUST, NOW);
    expect(r).toMatchObject({ band: "insufficient_data", score: null, p: null, outcomesCount: 0, merchantsCount: 0 });
  });
  it("fewer than minOutcomes", () => {
    const r = score([o("a", "refused", SRC.api, 1), o("b", "refused", SRC.api, 1)], NO_TRUST, NOW);
    expect(r.band).toBe("insufficient_data");
  });
  it("enough outcomes but a single merchant", () => {
    const r = score(Array.from({ length: 10 }, () => o("a", "refused", SRC.api, 1)), NO_TRUST, NOW);
    expect(r.band).toBe("insufficient_data");
    expect(r.merchantsCount).toBe(1);
  });
  it("3 outcomes from 2 merchants is enough", () => {
    const r = score(
      [o("a", "refused", SRC.api, 1), o("a", "refused", SRC.api, 2), o("b", "refused", SRC.api, 1)],
      NO_TRUST,
      NOW,
    );
    expect(r.band).not.toBe("insufficient_data");
  });
  it("zero-trust (suspended) merchants are ignored entirely, including in counts", () => {
    const r = score(
      [o("a", "refused", SRC.api, 1), o("b", "refused", SRC.api, 1), o("b", "refused", SRC.api, 1)],
      { a: 0 },
      NOW,
    );
    expect(r.merchantsCount).toBe(1);
    expect(r.outcomesCount).toBe(2);
    expect(r.band).toBe("insufficient_data");
  });
});

describe("properties", () => {
  const baseline = [o("a", "delivered", SRC.export, 10), o("b", "delivered", SRC.export, 10), o("c", "delivered", SRC.export, 10)];

  it("adding a refusal never lowers the score; adding a delivery never raises it", () => {
    const s0 = score(baseline, NO_TRUST, NOW).p!;
    const sRefused = score([...baseline, o("d", "refused", SRC.manual, 5)], NO_TRUST, NOW).p!;
    const sDelivered = score([...baseline, o("d", "delivered", SRC.manual, 5)], NO_TRUST, NOW).p!;
    expect(sRefused).toBeGreaterThan(s0);
    expect(sDelivered).toBeLessThan(s0);
  });

  it("recent outcomes weigh more than old ones", () => {
    const recent = score([...baseline, o("d", "refused", SRC.api, 1)], NO_TRUST, NOW).p!;
    const old = score([...baseline, o("d", "refused", SRC.api, 200)], NO_TRUST, NOW).p!;
    expect(recent).toBeGreaterThan(old);
  });

  it("carrier-confirmed outcomes weigh more than merchant-entered ones", () => {
    const carrier = score([...baseline, o("d", "refused", SRC.api, 5)], NO_TRUST, NOW).p!;
    const manual = score([...baseline, o("d", "refused", SRC.manual, 5)], NO_TRUST, NOW).p!;
    expect(carrier).toBeGreaterThan(manual);
  });

  it("one merchant can never contribute more than merchantCap × trust evidence", () => {
    for (const k of [1, 5, 50, 500]) {
      const spam = Array.from({ length: k }, () => o("spam", "refused", SRC.api, 0));
      const r = score([...baseline, ...spam], NO_TRUST, NOW);
      const baselineEvidence = score(baseline, NO_TRUST, NOW).evidence;
      expect(r.evidence - baselineEvidence).toBeLessThanOrEqual(DEFAULT_CONFIG.merchantCap + 1e-9);
    }
  });

  it("score is always within [0,100] and p within (0,1)", () => {
    const outcomes: OutcomeType[] = ["delivered", "refused", "returned", "unreachable"];
    const sources: OutcomeSource[] = ["carrier_api", "carrier_export", "merchant_manual"];
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let iter = 0; iter < 500; iter++) {
      const list = Array.from({ length: 1 + Math.floor(rand() * 30) }, () =>
        o(`m${Math.floor(rand() * 6)}`, outcomes[Math.floor(rand() * 4)]!, sources[Math.floor(rand() * 3)]!, rand() * 365),
      );
      const r = score(list, { m0: rand(), m1: rand() }, NOW);
      if (r.score !== null) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(100);
        expect(r.p!).toBeGreaterThan(0);
        expect(r.p!).toBeLessThan(1);
      }
    }
  });

  it("is order-independent and deterministic", () => {
    const list = [o("a", "refused", SRC.api, 3), o("b", "delivered", SRC.manual, 9), o("c", "unreachable", SRC.export, 40)];
    const r1 = score(list, NO_TRUST, NOW);
    const r2 = score([...list].reverse(), NO_TRUST, NOW);
    expect(r1).toEqual(r2);
  });

  it("does not mutate its inputs", () => {
    const list = [o("a", "refused", SRC.api, 3), o("b", "delivered", SRC.manual, 9), o("c", "refused", SRC.export, 40)];
    const copy = structuredClone(list);
    score(list, NO_TRUST, NOW);
    expect(list).toEqual(copy);
  });

  it("'returned' counts the same as 'refused'", () => {
    const a = score([...baseline, o("d", "refused", SRC.api, 5)], NO_TRUST, NOW);
    const b = score([...baseline, o("d", "returned", SRC.api, 5)], NO_TRUST, NOW);
    expect(a.p).toBe(b.p);
  });

  it("ignores outcomes with invalid dates", () => {
    const r = score([...baseline, { merchantId: "x", outcome: "refused", source: "carrier_api", occurredAt: new Date("nope") }], NO_TRUST, NOW);
    expect(r.outcomesCount).toBe(3);
  });

  it("accepts a Map as trust input", () => {
    const list = [o("a", "refused", SRC.api, 3), o("b", "refused", SRC.api, 3), o("b", "refused", SRC.api, 3)];
    expect(score(list, new Map([["a", 0.5]]), NOW)).toEqual(score(list, { a: 0.5 }, NOW));
  });
});

describe("reasons", () => {
  it("UNREACHABLE_HISTORY and CARRIER_CONFIRMED_HISTORY", () => {
    const r = score(
      [o("a", "unreachable", SRC.api, 2), o("b", "unreachable", SRC.api, 3), o("c", "delivered", SRC.api, 4)],
      NO_TRUST,
      NOW,
    );
    expect(r.reasons).toContain("UNREACHABLE_HISTORY");
    expect(r.reasons).toContain("CARRIER_CONFIRMED_HISTORY");
  });
  it("HISTORY_MOSTLY_OLD can accompany a real score", () => {
    const r = score(
      Array.from({ length: 12 }, (_, i) => o(`m${i % 4}`, "refused", SRC.api, 200 + i)),
      NO_TRUST,
      NOW,
    );
    expect(r.band).not.toBe("insufficient_data");
    expect(r.reasons).toContain("HISTORY_MOSTLY_OLD");
  });
});

describe("count buckets", () => {
  it.each([
    [0, "0"], [1, "1-2"], [2, "1-2"], [3, "3-5"], [5, "3-5"], [6, "6-10"], [10, "6-10"], [11, "11+"], [500, "11+"],
  ])("outcomes %i → %s", (n, b) => expect(bucketOutcomes(n)).toBe(b));
  it.each([
    [0, "0"], [1, "1"], [2, "2-3"], [3, "2-3"], [4, "4-5"], [5, "4-5"], [6, "6+"],
  ])("merchants %i → %s", (n, b) => expect(bucketMerchants(n)).toBe(b));
});
