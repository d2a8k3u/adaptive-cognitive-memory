import { describe, expect, it } from "vitest";
import {
  contradictionLeak,
  falseInjectionRate,
  fBeta,
  injectionSummary,
  ndcgAtK,
  percentile,
  precisionOf,
  ratioMetric,
  recallAtK,
  staleExposure,
  toolRecallHit,
  wilsonInterval,
  zeroEventUpperBound,
} from "./metrics";

describe("recallAtK", () => {
  it("counts each gold id once and only within the first k ranks", () => {
    expect(recallAtK(["x", "g1", "y", "g2"], ["g1", "g2"], 2)).toBe(0.5);
    expect(recallAtK(["x", "g1", "y", "g2"], ["g1", "g2"], 4)).toBe(1);
    expect(recallAtK(["g1", "g1"], ["g1", "g2"], 2)).toBe(0.5);
  });

  it("rejects an empty gold set because recall is undefined there", () => {
    expect(() => recallAtK(["a"], [], 3)).toThrowError(/empty gold/);
  });
});

describe("ndcgAtK", () => {
  it("discounts gold hits by rank against the ideal ordering", () => {
    expect(ndcgAtK(["x", "g1"], ["g1"], 10)).toBeCloseTo(0.6309, 4);
    expect(ndcgAtK(["g1", "x", "g2"], ["g1", "g2"], 3)).toBeCloseTo(0.9197, 4);
    expect(ndcgAtK(["x", "g1"], ["g1"], 1)).toBe(0);
  });
});

describe("precisionOf", () => {
  it("counts distinct injected rows that are gold", () => {
    expect(precisionOf(["g1", "x", "g1", "y"], ["g1", "g2"])).toEqual({
      numerator: 1,
      denominator: 3,
    });
    expect(precisionOf([], ["g1"])).toEqual({ numerator: 0, denominator: 0 });
  });
});

describe("falseInjectionRate", () => {
  it("counts negative prompts that received any row, not the rows", () => {
    expect(falseInjectionRate([["a", "b"], [], ["c"]])).toEqual({ numerator: 2, denominator: 3 });
  });
});

describe("staleExposure", () => {
  it("is the share of injected rows that are stale across probes", () => {
    expect(staleExposure([["old1", "new1"], ["new2"], ["old3"]], ["old1", "old2", "old3"])).toEqual(
      { numerator: 2, denominator: 4 },
    );
  });
});

describe("contradictionLeak", () => {
  it("counts probes that received a memory asserting a conflicting value", () => {
    expect(
      contradictionLeak([
        { injected: ["own"], conflicting: ["foreign"] },
        { injected: ["foreign"], conflicting: ["foreign"] },
        { injected: ["own", "foreign"], conflicting: ["foreign"] },
        { injected: [], conflicting: ["foreign"] },
      ]),
    ).toEqual({ numerator: 2, denominator: 4 });
  });
});

describe("toolRecallHit", () => {
  it("scores only inputs with gold and requires a gold row, not any row", () => {
    expect(
      toolRecallHit([
        { injected: ["unrelated"], gold: ["g1"] },
        { injected: ["g1", "x"], gold: ["g1"] },
        { injected: ["x"], gold: [] },
      ]),
    ).toEqual({ numerator: 1, denominator: 2 });
  });
});

describe("wilsonInterval", () => {
  it("matches the two-sided 95% interval for 10 of 200", () => {
    const [low, high] = wilsonInterval(10, 200);
    expect(low).toBeCloseTo(0.0274, 4);
    expect(high).toBeCloseTo(0.0896, 4);
  });

  it("starts exactly at zero for zero successes", () => {
    const [low, high] = wilsonInterval(0, 50);
    expect(low).toBe(0);
    expect(high).toBeCloseTo(0.0713, 4);
  });

  it("rejects an empty sample because the rate is unknown", () => {
    expect(() => wilsonInterval(0, 0)).toThrowError(/positive integer/);
  });
});

describe("zeroEventUpperBound", () => {
  it("gives the one-sided upper bound for zero observed events", () => {
    expect(zeroEventUpperBound(100)).toBeCloseTo(0.0295, 4);
    expect(zeroEventUpperBound(200)).toBeCloseTo(0.0149, 4);
    expect(zeroEventUpperBound(100, 0.99)).toBeCloseTo(0.045, 4);
  });
});

describe("percentile", () => {
  it("uses the nearest-rank definition on unsorted samples", () => {
    const samples = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6, 15, 14, 13, 12, 11, 20, 19, 18, 17, 16];
    expect(percentile(samples, 0.95)).toBe(19);
    expect(percentile(samples, 0.5)).toBe(10);
    expect(percentile([7], 0.95)).toBe(7);
  });
});

describe("ratioMetric", () => {
  it("adds the zero-event bound for zero counts and reports an empty sample as unknown", () => {
    const none = ratioMetric({ numerator: 0, denominator: 100 });
    expect(none.value).toBe(0);
    expect(none.n).toBe(100);
    expect(none.ci95?.[0]).toBe(0);
    expect(none.ci95?.[1]).toBeCloseTo(0.037, 4);
    expect(none.zero_event_upper95).toBeCloseTo(0.0295, 4);
    expect(ratioMetric({ numerator: 3, denominator: 4 }).zero_event_upper95).toBeUndefined();
    expect(ratioMetric({ numerator: 0, denominator: 0 })).toEqual({
      value: null,
      n: 0,
      numerator: 0,
      denominator: 0,
      ci95: null,
    });
  });
});

describe("injectionSummary", () => {
  it("scores gold hits on positives against every injected row, negatives included", () => {
    const summary = injectionSummary([
      { injected: ["g", "x"], gold: ["g"] },
      { injected: [], gold: ["h"] },
      { injected: ["y"], gold: [] },
      { injected: [], gold: [] },
    ]);
    expect(summary).toEqual({
      goldHit: { numerator: 1, denominator: 2 },
      precision: { numerator: 1, denominator: 2 },
      precisionAll: { numerator: 1, denominator: 3 },
      falseInjection: { numerator: 1, denominator: 2 },
      nonGoldRowsPerCase: 0.5,
      injectedRows: 3,
      f05: expect.closeTo(5 / 14, 10),
    });
  });
});

describe("fBeta", () => {
  it("weights precision above recall for beta 0.5 and is zero without hits", () => {
    expect(fBeta(0.8, 0.4, 0.5)).toBeCloseTo(0.6667, 4);
    expect(fBeta(0.4, 0.8, 0.5)).toBeCloseTo(0.4444, 4);
    expect(fBeta(0, 0, 0.5)).toBe(0);
  });
});
