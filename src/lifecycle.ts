import { ID_MAX_CHARS } from "./ids";
import type { MemoryKind, MemoryState } from "./policy";
import { PINNED_KINDS } from "./session";

export interface ReceiptCounters {
  readonly usedCount: number;
  readonly wrongCount: number;
  readonly receiptedInjections: number;
}

export const FEEDBACK_VERDICTS = ["used", "wrong", "not_applicable"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export type ReactivationReason = "feedback_used" | "store_noop" | "store_update";
export type TransitionReason = "unused_after_verdicts" | "feedback_wrong" | ReactivationReason;

export interface Transition {
  readonly toState: MemoryState;
  readonly reason: TransitionReason;
  readonly evidence: string;
}

export interface FeedbackTarget {
  readonly id: string;
  readonly state: MemoryState;
}

export type FeedbackVerdicts = Readonly<Record<FeedbackVerdict, readonly string[]>>;

export type ParsedFeedback =
  | { readonly outcome: "parsed"; readonly verdicts: FeedbackVerdicts }
  | { readonly outcome: "invalid"; readonly field?: FeedbackVerdict; readonly message: string };

export const FEEDBACK_IDS_MAX_ITEMS = 20;

type ParsedIdList =
  | { readonly outcome: "parsed"; readonly ids: readonly string[] }
  | { readonly outcome: "invalid"; readonly field: FeedbackVerdict; readonly message: string };

function isMemoryId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= ID_MAX_CHARS;
}

function parseIdList(fields: ReadonlyMap<string, unknown>, verdict: FeedbackVerdict): ParsedIdList {
  const value = fields.get(verdict);
  if (value === undefined) {
    return { outcome: "parsed", ids: [] };
  }
  if (!Array.isArray(value) || !value.every(isMemoryId)) {
    return {
      outcome: "invalid",
      field: verdict,
      message: `${verdict} must be a list of memory ids of at most ${ID_MAX_CHARS} characters`,
    };
  }
  return { outcome: "parsed", ids: [...new Set(value)] };
}

function idUnderTwoVerdicts(verdicts: FeedbackVerdicts): string | undefined {
  const verdictOf = new Map<string, FeedbackVerdict>();
  for (const verdict of FEEDBACK_VERDICTS) {
    for (const id of verdicts[verdict]) {
      const earlier = verdictOf.get(id);
      if (earlier !== undefined) {
        return `memory ${id} is under both ${earlier} and ${verdict}; give each id one verdict`;
      }
      verdictOf.set(id, verdict);
    }
  }
  return undefined;
}

function rawIdCount(fields: ReadonlyMap<string, unknown>): number {
  return FEEDBACK_VERDICTS.reduce((sum, verdict) => {
    const value = fields.get(verdict);
    return sum + (Array.isArray(value) ? value.length : 0);
  }, 0);
}

function inputFields(input: unknown): ReadonlyMap<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? new Map(Object.entries(input))
    : new Map();
}

export function parseFeedbackVerdicts(input: unknown): ParsedFeedback {
  const fields = inputFields(input);
  const lists: Partial<Record<FeedbackVerdict, readonly string[]>> = {};
  for (const verdict of FEEDBACK_VERDICTS) {
    const parsed = parseIdList(fields, verdict);
    if (parsed.outcome === "invalid") {
      return parsed;
    }
    lists[verdict] = parsed.ids;
  }
  const verdicts: FeedbackVerdicts = {
    used: lists.used ?? [],
    wrong: lists.wrong ?? [],
    not_applicable: lists.not_applicable ?? [],
  };
  const count = rawIdCount(fields);
  if (count === 0 || count > FEEDBACK_IDS_MAX_ITEMS) {
    return {
      outcome: "invalid",
      message: `give 1 to ${FEEDBACK_IDS_MAX_ITEMS} memory ids in total under ${FEEDBACK_VERDICTS.join(", ")}`,
    };
  }
  const conflict = idUnderTwoVerdicts(verdicts);
  return conflict === undefined
    ? { outcome: "parsed", verdicts }
    : { outcome: "invalid", message: conflict };
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

export interface TrialEvidence {
  readonly state: MemoryState;
  readonly kind: MemoryKind;
  readonly verdictSessions: number;
  readonly usedSessions: number;
}

export const DEMOTION_MIN_VERDICT_SESSIONS = 5;
const DEMOTION_MIN_USED_SHARE = 0.5;

export function trialEvidenceTransition(evidence: TrialEvidence): Transition | undefined {
  const { state, kind, verdictSessions, usedSessions } = evidence;
  if (
    state !== "active" ||
    PINNED_KINDS.includes(kind) ||
    verdictSessions < DEMOTION_MIN_VERDICT_SESSIONS
  ) {
    return undefined;
  }
  if (usedSessions / verdictSessions >= DEMOTION_MIN_USED_SHARE) {
    return undefined;
  }
  return {
    toState: "hypothesis",
    reason: "unused_after_verdicts",
    evidence: `used in ${usedSessions} of ${verdictSessions} sessions with a verdict`,
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
