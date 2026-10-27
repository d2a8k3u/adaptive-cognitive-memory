import type { MemoryKind, MemoryState } from "./policy";
import { PINNED_KINDS } from "./session";

export interface ReceiptCounters {
  readonly usedCount: number;
  readonly wrongCount: number;
  readonly receiptedInjections: number;
}

export interface LifecycleSnapshot extends ReceiptCounters {
  readonly state: MemoryState;
  readonly kind: MemoryKind;
}

export const FEEDBACK_VERDICTS = ["used", "wrong", "not_applicable"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export type ReactivationReason = "feedback_used" | "store_noop" | "store_update";
export type TransitionReason = "unused_after_receipts" | "feedback_wrong" | ReactivationReason;

export interface Transition {
  readonly toState: MemoryState;
  readonly reason: TransitionReason;
  readonly evidence: string;
}

export interface FeedbackTarget {
  readonly id: string;
  readonly state: MemoryState;
}

export function reactivation(
  state: MemoryState,
  reason: ReactivationReason,
  evidence: string,
): Transition | undefined {
  return state === "hypothesis" ? { toState: "active", reason, evidence } : undefined;
}

export function feedbackTransition(
  state: MemoryState,
  verdict: FeedbackVerdict,
): Transition | undefined {
  if (verdict === "wrong" && state === "active") {
    return { toState: "hypothesis", reason: "feedback_wrong", evidence: verdict };
  }
  return verdict === "used" ? reactivation(state, "feedback_used", verdict) : undefined;
}

export function feedbackRejection(
  requested: readonly string[],
  found: readonly FeedbackTarget[],
): string | undefined {
  const stateById = new Map(found.map((target) => [target.id, target.state]));
  const unknown = requested.filter((id) => !stateById.has(id));
  const revoked = requested.filter((id) => stateById.get(id) === "revoked");
  if (unknown.length === 0 && revoked.length === 0) {
    return undefined;
  }
  const problems = [
    ...(unknown.length === 0 ? [] : [`unknown memory ids ${unknown.join(", ")}`]),
    ...(revoked.length === 0 ? [] : [`revoked memory ids ${revoked.join(", ")}`]),
  ];
  return `no feedback recorded: ${problems.join("; ")}. Give feedback only on ids of active or hypothesis memories, exactly as recall printed them`;
}

export const DEMOTION_MIN_RECEIPTED_INJECTIONS = 5;
const DEMOTION_MIN_USED_SHARE = 0.5;

export function receiptEvidenceTransition(snapshot: LifecycleSnapshot): Transition | undefined {
  const { state, kind, usedCount, receiptedInjections } = snapshot;
  if (
    state !== "active" ||
    PINNED_KINDS.includes(kind) ||
    receiptedInjections < DEMOTION_MIN_RECEIPTED_INJECTIONS
  ) {
    return undefined;
  }
  if (usedCount / receiptedInjections >= DEMOTION_MIN_USED_SHARE) {
    return undefined;
  }
  return {
    toState: "hypothesis",
    reason: "unused_after_receipts",
    evidence: `used ${usedCount} of ${receiptedInjections} receipted injections`,
  };
}

export const FRESH_COUNTERS: ReceiptCounters = {
  usedCount: 0,
  wrongCount: 0,
  receiptedInjections: 0,
};

const WRONG_FAILURE_WEIGHT = 2;

export function derivedImportance(counters: ReceiptCounters): number {
  const unusedInjections = Math.max(0, counters.receiptedInjections - counters.usedCount);
  const failures = WRONG_FAILURE_WEIGHT * counters.wrongCount + unusedInjections;
  return (1 + counters.usedCount) / (2 + counters.usedCount + failures);
}
