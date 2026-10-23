import { RELEVANCE_FEATURES, type RelevanceFeatures } from "../../src/gate";

export interface LabelledFeatures {
  readonly features: RelevanceFeatures;
  readonly gold: boolean;
}

export interface LinearModel {
  readonly bias: number;
  readonly weights: RelevanceFeatures;
}

export interface FitOptions {
  readonly iterations: number;
  readonly learningRate: number;
  readonly l2: number;
}

export interface GateOutcome {
  readonly goldHits: number;
  readonly positives: number;
  readonly falseInjections: number;
  readonly negatives: number;
  readonly goldRows: number;
  readonly injectedRows: number;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function columnStats(rows: readonly LabelledFeatures[]): { mean: number[]; deviation: number[] } {
  const mean = RELEVANCE_FEATURES.map(
    (feature) => rows.reduce((sum, row) => sum + row.features[feature], 0) / rows.length,
  );
  const deviation = RELEVANCE_FEATURES.map((feature, index) => {
    const variance =
      rows.reduce((sum, row) => sum + (row.features[feature] - (mean[index] ?? 0)) ** 2, 0) /
      rows.length;
    return Math.sqrt(variance) || 1;
  });
  return { mean, deviation };
}

export function fitLogistic(rows: readonly LabelledFeatures[], options: FitOptions): LinearModel {
  if (rows.length === 0) {
    throw new Error("cannot fit a relevance model without training rows");
  }
  const { mean, deviation } = columnStats(rows);
  const standardised = rows.map((row) => ({
    x: RELEVANCE_FEATURES.map(
      (feature, index) => (row.features[feature] - (mean[index] ?? 0)) / (deviation[index] ?? 1),
    ),
    y: row.gold ? 1 : 0,
  }));
  let bias = 0;
  let weights = RELEVANCE_FEATURES.map(() => 0);
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    let biasGradient = 0;
    const gradient = weights.map(() => 0);
    for (const { x, y } of standardised) {
      const error =
        sigmoid(x.reduce((sum, value, index) => sum + value * (weights[index] ?? 0), bias)) - y;
      biasGradient += error;
      x.forEach((value, index) => {
        gradient[index] = (gradient[index] ?? 0) + error * value;
      });
    }
    bias -= (options.learningRate * biasGradient) / standardised.length;
    weights = weights.map(
      (weight, index) =>
        weight -
        options.learningRate * ((gradient[index] ?? 0) / standardised.length + options.l2 * weight),
    );
  }
  const raw = weights.map((weight, index) => weight / (deviation[index] ?? 1));
  return {
    bias: raw.reduce((sum, weight, index) => sum - weight * (mean[index] ?? 0), bias),
    weights: Object.fromEntries(
      RELEVANCE_FEATURES.map((feature, index) => [feature, raw[index] ?? 0]),
    ) as RelevanceFeatures,
  };
}

export function bestThreshold(
  thresholds: readonly number[],
  outcomeAt: (threshold: number) => GateOutcome,
  falseInjectionCap: number,
): number {
  let best: { threshold: number; outcome: GateOutcome } | undefined;
  for (const threshold of thresholds) {
    const outcome = outcomeAt(threshold);
    if (outcome.falseInjections / Math.max(outcome.negatives, 1) > falseInjectionCap) {
      continue;
    }
    const precision = (o: GateOutcome) => o.goldRows / Math.max(o.injectedRows, 1);
    if (
      best === undefined ||
      outcome.goldHits > best.outcome.goldHits ||
      (outcome.goldHits === best.outcome.goldHits && precision(outcome) > precision(best.outcome))
    ) {
      best = { threshold, outcome };
    }
  }
  if (best === undefined) {
    throw new Error(`no threshold keeps false injection within ${falseInjectionCap}`);
  }
  return best.threshold;
}
