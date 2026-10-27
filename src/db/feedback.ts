import {
  FEEDBACK_VERDICTS,
  type FeedbackVerdict,
  type FeedbackVerdicts,
  feedbackRejection,
  feedbackTransition,
} from "../lifecycle";
import { type MemoryState, reactivationVerdict } from "../policy";
import type { Db } from "./database";
import { applyTransition, refreshImportance } from "./lifecycle";
import { singleKeyHolders, slotRow } from "./memories";
import type { StateStore } from "./transitions";
import { VISIBLE_TO_PROJECT } from "./visibility";

export interface FeedbackMemory {
  readonly id: string;
  readonly state: MemoryState;
}

export interface FeedbackRequest {
  readonly projectId: string;
  readonly verdicts: FeedbackVerdicts;
  readonly at: string;
}

export type FeedbackOutcome =
  | { readonly outcome: "recorded"; readonly memories: readonly FeedbackMemory[] }
  | { readonly outcome: "rejected"; readonly reason: string };

interface JudgedMemory extends FeedbackMemory {
  readonly verdict: FeedbackVerdict;
}

const COUNTED_VERDICT_SQL: Readonly<Record<FeedbackVerdict, string | undefined>> = {
  used: "UPDATE memories SET used_count = used_count + 1 WHERE id = ?",
  wrong: "UPDATE memories SET wrong_count = wrong_count + 1 WHERE id = ?",
  not_applicable: undefined,
};

function countVerdicts(db: Db, judged: readonly JudgedMemory[]): void {
  for (const { id, verdict } of judged) {
    const sql = COUNTED_VERDICT_SQL[verdict];
    if (sql !== undefined) {
      db.prepare(sql).run(id);
    }
  }
}

function reactivationRejection(db: Db, judged: readonly JudgedMemory[]): string | undefined {
  const reasons = judged
    .filter((target) => feedbackTransition(target.state, target.verdict)?.toState === "active")
    .flatMap((target) => {
      const slot = slotRow(db, target.id);
      const reactivation = reactivationVerdict(slot, singleKeyHolders(db, slot));
      return reactivation.allowed ? [] : [reactivation.reason];
    });
  return reasons.length === 0 ? undefined : `no feedback recorded: ${reasons.join("; ")}`;
}

function feedbackMemories(db: Db, projectId: string, ids: readonly string[]): FeedbackMemory[] {
  const placeholders = ids.map(() => "?").join(", ");
  const visible = db
    .prepare(
      `SELECT m.id, m.state FROM memories m
       WHERE m.id IN (${placeholders}) AND ${VISIBLE_TO_PROJECT}`,
    )
    .all(...ids, projectId) as FeedbackMemory[];
  const stateById = new Map(visible.map((row) => [row.id, row.state]));
  return ids.flatMap((id) => {
    const state = stateById.get(id);
    return state === undefined ? [] : [{ id, state }];
  });
}

function judgedMemories(
  verdicts: FeedbackVerdicts,
  targets: readonly FeedbackMemory[],
): JudgedMemory[] {
  const stateById = new Map(targets.map((target) => [target.id, target.state]));
  return FEEDBACK_VERDICTS.flatMap((verdict) =>
    verdicts[verdict].flatMap((id) => {
      const state = stateById.get(id);
      return state === undefined ? [] : [{ id, state, verdict }];
    }),
  );
}

export function recordFeedback(store: StateStore, request: FeedbackRequest): FeedbackOutcome {
  const { db } = store;
  const { projectId, verdicts, at } = request;
  const requested = FEEDBACK_VERDICTS.flatMap((verdict) => verdicts[verdict]);
  return db
    .transaction((): FeedbackOutcome => {
      const targets = feedbackMemories(db, projectId, requested);
      const judged = judgedMemories(verdicts, targets);
      const rejection = feedbackRejection(requested, targets) ?? reactivationRejection(db, judged);
      if (rejection !== undefined) {
        return { outcome: "rejected", reason: rejection };
      }
      countVerdicts(db, judged);
      for (const target of judged) {
        const transition = feedbackTransition(target.state, target.verdict);
        if (transition !== undefined) {
          applyTransition(store, target.id, target.state, transition, at);
        }
      }
      refreshImportance(db, requested);
      return { outcome: "recorded", memories: feedbackMemories(db, projectId, requested) };
    })
    .immediate();
}
