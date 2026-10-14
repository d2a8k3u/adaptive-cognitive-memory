export interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
}

export interface ConflictProbe {
  readonly injected: readonly string[];
  readonly conflicting: readonly string[];
}

export interface GoldCase {
  readonly injected: readonly string[];
  readonly gold: readonly string[];
}

export interface MetricEntry {
  readonly value: number | null;
  readonly n: number;
  readonly numerator?: number;
  readonly denominator?: number;
  readonly ci95?: readonly [number, number] | null;
  readonly zero_event_upper95?: number;
}

const WILSON_Z_95 = 1.959963984540054;
const DEFAULT_CONFIDENCE = 0.95;

function requireRank(k: number): void {
  if (!(Number.isInteger(k) || k === Number.POSITIVE_INFINITY) || k < 1) {
    throw new RangeError(`k must be a positive integer or Infinity, got ${k}`);
  }
}

function requireGold(gold: readonly string[]): ReadonlySet<string> {
  if (gold.length === 0) {
    throw new RangeError("ranking metrics are undefined for an empty gold set");
  }
  return new Set(gold);
}

function distinctTopK(ranked: readonly string[], k: number): string[] {
  return [...new Set(ranked)].slice(0, k);
}

function intersects(values: readonly string[], members: ReadonlySet<string>): boolean {
  return values.some((value) => members.has(value));
}

export function ratioValue(ratio: Ratio): number | undefined {
  return ratio.denominator === 0 ? undefined : ratio.numerator / ratio.denominator;
}

export function sumRatios(ratios: readonly Ratio[]): Ratio {
  return ratios.reduce<Ratio>(
    (total, ratio) => ({
      numerator: total.numerator + ratio.numerator,
      denominator: total.denominator + ratio.denominator,
    }),
    { numerator: 0, denominator: 0 },
  );
}

export function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function recallAtK(ranked: readonly string[], gold: readonly string[], k: number): number {
  requireRank(k);
  const goldSet = requireGold(gold);
  const hits = distinctTopK(ranked, k).filter((id) => goldSet.has(id)).length;
  return hits / goldSet.size;
}

function discount(position: number): number {
  return 1 / Math.log2(position + 2);
}

export function ndcgAtK(ranked: readonly string[], gold: readonly string[], k: number): number {
  requireRank(k);
  const goldSet = requireGold(gold);
  const dcg = distinctTopK(ranked, k).reduce(
    (sum, id, position) => (goldSet.has(id) ? sum + discount(position) : sum),
    0,
  );
  const idealHits = Math.min(goldSet.size, k);
  let idealDcg = 0;
  for (let position = 0; position < idealHits; position += 1) {
    idealDcg += discount(position);
  }
  return dcg / idealDcg;
}

export function precisionOf(injected: readonly string[], gold: readonly string[]): Ratio {
  const goldSet = new Set(gold);
  const distinct = [...new Set(injected)];
  return {
    numerator: distinct.filter((id) => goldSet.has(id)).length,
    denominator: distinct.length,
  };
}

export function falseInjectionRate(injectedPerNegative: readonly (readonly string[])[]): Ratio {
  return {
    numerator: injectedPerNegative.filter((injected) => injected.length > 0).length,
    denominator: injectedPerNegative.length,
  };
}

export function staleExposure(
  injectedPerProbe: readonly (readonly string[])[],
  staleIds: readonly string[],
): Ratio {
  const stale = new Set(staleIds);
  const rows = injectedPerProbe.flatMap((injected) => [...new Set(injected)]);
  return { numerator: rows.filter((id) => stale.has(id)).length, denominator: rows.length };
}

export function contradictionLeak(probes: readonly ConflictProbe[]): Ratio {
  return {
    numerator: probes.filter((probe) => intersects(probe.injected, new Set(probe.conflicting)))
      .length,
    denominator: probes.length,
  };
}

export function toolRecallHit(cases: readonly GoldCase[]): Ratio {
  const scored = cases.filter((entry) => entry.gold.length > 0);
  return {
    numerator: scored.filter((entry) => recallAtK(entry.injected, entry.gold, Infinity) > 0).length,
    denominator: scored.length,
  };
}

export function wilsonInterval(successes: number, n: number): readonly [number, number] {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`n must be a positive integer, got ${n}`);
  }
  if (!Number.isInteger(successes) || successes < 0 || successes > n) {
    throw new RangeError(`successes must be an integer in [0, ${n}], got ${successes}`);
  }
  const z2 = WILSON_Z_95 * WILSON_Z_95;
  const rate = successes / n;
  const denominator = 1 + z2 / n;
  const center = (rate + z2 / (2 * n)) / denominator;
  const margin =
    (WILSON_Z_95 * Math.sqrt((rate * (1 - rate)) / n + z2 / (4 * n * n))) / denominator;
  const low = successes === 0 ? 0 : Math.max(0, center - margin);
  const high = successes === n ? 1 : Math.min(1, center + margin);
  return [low, high];
}

export function zeroEventUpperBound(n: number, confidence = DEFAULT_CONFIDENCE): number {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`n must be a positive integer, got ${n}`);
  }
  if (!(confidence > 0 && confidence < 1)) {
    throw new RangeError(`confidence must be in (0, 1), got ${confidence}`);
  }
  return 1 - (1 - confidence) ** (1 / n);
}

export function ratioMetric(ratio: Ratio): MetricEntry {
  const { numerator, denominator } = ratio;
  if (denominator === 0) {
    return { value: null, n: 0, numerator, denominator, ci95: null };
  }
  const entry: MetricEntry = {
    value: numerator / denominator,
    n: denominator,
    numerator,
    denominator,
    ci95: wilsonInterval(numerator, denominator),
  };
  return numerator === 0
    ? { ...entry, zero_event_upper95: zeroEventUpperBound(denominator) }
    : entry;
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    throw new RangeError("percentile of an empty sample is undefined");
  }
  if (!(fraction > 0 && fraction <= 1)) {
    throw new RangeError(`fraction must be in (0, 1], got ${fraction}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[rank - 1] as number;
}

export interface InjectionSummary {
  readonly goldHit: Ratio;
  readonly precision: Ratio;
  readonly precisionAll: Ratio;
  readonly falseInjection: Ratio;
  readonly nonGoldRowsPerCase: number | undefined;
  readonly injectedRows: number;
  readonly f05: number;
}

const PRECISION_WEIGHTED_BETA = 0.5;

export function injectionSummary(cases: readonly GoldCase[]): InjectionSummary {
  const positives = cases.filter((entry) => entry.gold.length > 0);
  const perCase = cases.map((entry) => precisionOf(entry.injected, entry.gold));
  const goldHit = toolRecallHit(cases);
  const precisionAll = sumRatios(perCase);
  return {
    goldHit,
    precision: sumRatios(positives.map((entry) => precisionOf(entry.injected, entry.gold))),
    precisionAll,
    falseInjection: falseInjectionRate(
      cases.filter((entry) => entry.gold.length === 0).map((entry) => entry.injected),
    ),
    nonGoldRowsPerCase: mean(perCase.map((ratio) => ratio.denominator - ratio.numerator)),
    injectedRows: precisionAll.denominator,
    f05: fBeta(ratioValue(precisionAll) ?? 0, ratioValue(goldHit) ?? 0, PRECISION_WEIGHTED_BETA),
  };
}

export function fBeta(precision: number, recall: number, beta: number): number {
  const beta2 = beta * beta;
  const denominator = beta2 * precision + recall;
  if (denominator === 0) {
    return 0;
  }
  return ((1 + beta2) * precision * recall) / denominator;
}
