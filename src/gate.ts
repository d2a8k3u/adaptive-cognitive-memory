import type { Epistemic, MemoryKind, MemoryScope } from "./policy";

export const NEIGHBOURHOOD_SIZE = 10;
export const RELEVANCE_FEATURES = [
  "cosine",
  "gapToTop",
  "gapToNeighbourhood",
  "lexical",
  "top",
  "keyHit",
] as const;
export type RelevanceFeature = (typeof RELEVANCE_FEATURES)[number];
export type RelevanceFeatures = Readonly<Record<RelevanceFeature, number>>;

export interface RecalledMemory {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly epistemic: Epistemic;
  readonly scope: MemoryScope;
  readonly abstract: string;
  readonly validFrom: string;
}

export interface PromptCandidate extends RecalledMemory {
  readonly cosine: number | undefined;
  readonly ftsRank: number | undefined;
  readonly keyHit: boolean;
}

export interface PromptGate {
  readonly bias: number;
  readonly weights: RelevanceFeatures;
  readonly threshold: number;
  readonly maxRows: number;
  readonly neighbourhoodPrior: number;
}

export interface PromptContext {
  readonly neighbourhood: readonly number[];
}

export interface ToolCandidate extends RecalledMemory {
  readonly anchorHit: boolean;
  readonly keyHit: boolean;
}

export interface ToolGate {
  readonly kinds: readonly MemoryKind[];
  readonly keywordSignal: boolean;
}

interface ScoredCandidate {
  readonly candidate: PromptCandidate;
  readonly score: number;
}

function descending(a: number, b: number): number {
  return b - a;
}

export function nearestMean(cosines: readonly number[], neighbourhoodPrior: number): number {
  const nearest = [...cosines].sort(descending).slice(0, NEIGHBOURHOOD_SIZE);
  const missing = NEIGHBOURHOOD_SIZE - nearest.length;
  return (
    (nearest.reduce((sum, cosine) => sum + cosine, 0) + missing * neighbourhoodPrior) /
    NEIGHBOURHOOD_SIZE
  );
}

function bm25Strength(ftsRank: number | undefined): number {
  return ftsRank === undefined ? 0 : Math.max(0, -ftsRank);
}

export function relevanceFeatures(
  candidate: PromptCandidate,
  context: PromptContext,
  neighbourhoodPrior: number,
): RelevanceFeatures | undefined {
  const { cosine } = candidate;
  if (cosine === undefined) {
    return undefined;
  }
  const top = Math.max(cosine, ...context.neighbourhood);
  return {
    cosine,
    gapToTop: cosine - top,
    gapToNeighbourhood: cosine - nearestMean(context.neighbourhood, neighbourhoodPrior),
    lexical: Math.log1p(bm25Strength(candidate.ftsRank)),
    top: cosine === top ? 1 : 0,
    keyHit: candidate.keyHit ? 1 : 0,
  };
}

export function relevanceScore(features: RelevanceFeatures, gate: PromptGate): number {
  return RELEVANCE_FEATURES.reduce(
    (score, feature) => score + gate.weights[feature] * features[feature],
    gate.bias,
  );
}

function requiresKeyHit(memory: RecalledMemory): boolean {
  return memory.kind === "belief" || memory.epistemic === "unverified";
}

function byId(a: RecalledMemory, b: RecalledMemory): number {
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

function scored(
  candidate: PromptCandidate,
  gate: PromptGate,
  context: PromptContext,
): ScoredCandidate[] {
  if (requiresKeyHit(candidate) && !candidate.keyHit) {
    return [];
  }
  const features = relevanceFeatures(candidate, context, gate.neighbourhoodPrior);
  if (features === undefined) {
    return [];
  }
  const score = relevanceScore(features, gate);
  return score >= gate.threshold ? [{ candidate, score }] : [];
}

export function selectPromptMemories(
  candidates: readonly PromptCandidate[],
  gate: PromptGate,
  context: PromptContext,
  alreadyInjected: ReadonlySet<string>,
): PromptCandidate[] {
  return candidates
    .filter((candidate) => !alreadyInjected.has(candidate.id))
    .flatMap((candidate) => scored(candidate, gate, context))
    .sort((a, b) => b.score - a.score || byId(a.candidate, b.candidate))
    .slice(0, gate.maxRows)
    .map(({ candidate }) => candidate);
}

export function passesToolGate(candidate: ToolCandidate, gate: ToolGate): boolean {
  return (
    gate.kinds.includes(candidate.kind) &&
    (candidate.anchorHit || (gate.keywordSignal && candidate.keyHit))
  );
}

function byAnchorThenId(a: ToolCandidate, b: ToolCandidate): number {
  return Number(b.anchorHit) - Number(a.anchorHit) || byId(a, b);
}

export function selectToolMemories(
  candidates: readonly ToolCandidate[],
  gate: ToolGate,
  alreadyInjected: ReadonlySet<string>,
): ToolCandidate[] {
  return candidates
    .filter((candidate) => !alreadyInjected.has(candidate.id) && passesToolGate(candidate, gate))
    .sort(byAnchorThenId);
}
