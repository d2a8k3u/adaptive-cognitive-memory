import type { Epistemic, MemoryKind, MemoryScope } from "./policy";
import type { PromptLanguage } from "./prompt";

export const KEY_MODES = ["disjunction", "conjunction", "ignored"] as const;
export type KeyMode = (typeof KEY_MODES)[number];
export const NEIGHBOURHOOD_SIZE = 10;

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

export interface SimilarityThresholds {
  readonly floor: number;
  readonly floorOpen: number;
  readonly margin: number;
  readonly fallbackTau: number;
  readonly fallbackTauOpen: number;
  readonly tauKey: number;
}

export interface PromptGate {
  readonly thresholds: Readonly<Record<PromptLanguage, SimilarityThresholds>>;
  readonly keyMode: KeyMode;
  readonly maxRows: number;
}

export interface PromptContext {
  readonly language: PromptLanguage;
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

const FAIL_OPEN_KINDS: ReadonlySet<MemoryKind> = new Set(["constraint", "preference"]);

function descending(a: number, b: number): number {
  return b - a;
}

export function neighbourhoodReference(partitionCosines: readonly number[]): number | undefined {
  if (partitionCosines.length < NEIGHBOURHOOD_SIZE) {
    return undefined;
  }
  const nearest = [...partitionCosines].sort(descending).slice(0, NEIGHBOURHOOD_SIZE);
  return nearest.reduce((sum, cosine) => sum + cosine, 0) / NEIGHBOURHOOD_SIZE;
}

function floorFor(kind: MemoryKind, thresholds: SimilarityThresholds): number {
  return FAIL_OPEN_KINDS.has(kind) ? thresholds.floorOpen : thresholds.floor;
}

function fallbackTauFor(kind: MemoryKind, thresholds: SimilarityThresholds): number {
  return FAIL_OPEN_KINDS.has(kind) ? thresholds.fallbackTauOpen : thresholds.fallbackTau;
}

function reachesSimilarity(
  candidate: PromptCandidate,
  thresholds: SimilarityThresholds,
  reference: number | undefined,
): boolean {
  const { cosine, kind } = candidate;
  if (cosine === undefined) {
    return false;
  }
  if (reference === undefined) {
    return cosine >= fallbackTauFor(kind, thresholds);
  }
  return cosine >= floorFor(kind, thresholds) && cosine - reference >= thresholds.margin;
}

function reaches(cosine: number | undefined, threshold: number): boolean {
  return cosine !== undefined && cosine >= threshold;
}

function requiresKeyHit(memory: RecalledMemory): boolean {
  return memory.kind === "belief" || memory.epistemic === "unverified";
}

function admittedByKey(
  candidate: PromptCandidate,
  keyMode: KeyMode,
  thresholds: SimilarityThresholds,
): boolean {
  switch (keyMode) {
    case "disjunction":
      return candidate.keyHit;
    case "conjunction":
      return candidate.keyHit && reaches(candidate.cosine, thresholds.tauKey);
    case "ignored":
      return false;
  }
}

function passesPromptGate(
  candidate: PromptCandidate,
  keyMode: KeyMode,
  thresholds: SimilarityThresholds,
  reference: number | undefined,
): boolean {
  if (requiresKeyHit(candidate) && !candidate.keyHit) {
    return false;
  }
  return (
    reachesSimilarity(candidate, thresholds, reference) ||
    admittedByKey(candidate, keyMode, thresholds)
  );
}

function descendingDefinedFirst(a: number | undefined, b: number | undefined): number {
  if (a === b) {
    return 0;
  }
  if (a === undefined) {
    return 1;
  }
  if (b === undefined) {
    return -1;
  }
  return b - a;
}

function byId(a: RecalledMemory, b: RecalledMemory): number {
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

function bm25Strength(candidate: PromptCandidate): number | undefined {
  return candidate.ftsRank === undefined ? undefined : -candidate.ftsRank;
}

function byRelevance(a: PromptCandidate, b: PromptCandidate): number {
  return (
    descendingDefinedFirst(a.cosine, b.cosine) ||
    Number(b.keyHit) - Number(a.keyHit) ||
    descendingDefinedFirst(bm25Strength(a), bm25Strength(b)) ||
    byId(a, b)
  );
}

export function selectPromptMemories(
  candidates: readonly PromptCandidate[],
  gate: PromptGate,
  context: PromptContext,
  alreadyInjected: ReadonlySet<string>,
): PromptCandidate[] {
  const thresholds = gate.thresholds[context.language];
  const reference = neighbourhoodReference(context.neighbourhood);
  return candidates
    .filter(
      (candidate) =>
        !alreadyInjected.has(candidate.id) &&
        passesPromptGate(candidate, gate.keyMode, thresholds, reference),
    )
    .sort(byRelevance)
    .slice(0, gate.maxRows);
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
