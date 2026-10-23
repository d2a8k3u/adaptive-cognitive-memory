import { describe, expect, it } from "vitest";
import { type RelevanceFeatures, relevanceScore } from "../../src/gate";
import { bestThreshold, fitLogistic, type GateOutcome, type LabelledFeatures } from "./fit";

function row(cosine: number, gold: boolean): LabelledFeatures {
  const features: RelevanceFeatures = {
    cosine,
    gapToTop: 0,
    gapToNeighbourhood: 0,
    lexical: 0,
    top: 0,
    keyHit: 0,
  };
  return { features, gold };
}

function outcome(goldHits: number, falseInjections: number, goldRows: number): GateOutcome {
  return { goldHits, positives: 10, falseInjections, negatives: 100, goldRows, injectedRows: 10 };
}

describe("fitLogistic", () => {
  it("learns a raw-scale model that scores every gold row above every other row when one feature separates them", () => {
    const rows = [
      row(0.9, true),
      row(0.8, true),
      row(0.75, true),
      row(0.4, false),
      row(0.3, false),
      row(0.2, false),
    ];

    const model = fitLogistic(rows, { iterations: 500, learningRate: 0.5, l2: 0 });
    const score = (item: LabelledFeatures) =>
      relevanceScore(item.features, { ...model, threshold: 0, maxRows: 3, neighbourhoodPrior: 0 });

    expect(Math.min(...rows.filter((item) => item.gold).map(score))).toBeGreaterThan(
      Math.max(...rows.filter((item) => !item.gold).map(score)),
    );
  });
});

describe("bestThreshold", () => {
  const outcomes = new Map<number, GateOutcome>([
    [0, outcome(9, 5, 9)],
    [1, outcome(8, 3, 8)],
    [2, outcome(8, 2, 9)],
    [3, outcome(6, 0, 6)],
  ]);
  const outcomeAt = (threshold: number) => outcomes.get(threshold) ?? outcome(0, 0, 0);

  it("keeps the most gold hits within the false-injection cap, breaking ties by precision", () => {
    expect(bestThreshold([0, 1, 2, 3], outcomeAt, 0.03)).toBe(2);
  });

  it("refuses to choose when no threshold stays within the cap", () => {
    expect(() => bestThreshold([0], outcomeAt, 0.01)).toThrow(/no threshold keeps false injection/);
  });
});
