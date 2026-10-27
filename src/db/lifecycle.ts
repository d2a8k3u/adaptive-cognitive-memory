import {
  derivedImportance,
  type ReceiptCounters,
  type Transition,
  type TrialEvidence,
  trialEvidenceTransition,
} from "../lifecycle";
import type { MemoryState } from "../policy";
import type { Db } from "./database";
import { recordTransition, type StateStore, setVecState } from "./transitions";

interface StoredCounters extends ReceiptCounters {
  readonly id: string;
  readonly importance: number;
}

interface StoredTrial extends TrialEvidence {
  readonly id: string;
}

const COUNTER_COLUMNS = `m.id, m.importance,
  m.used_count AS usedCount, m.wrong_count AS wrongCount,
  (SELECT count(DISTINCT i.session_id) FROM injections i
     JOIN receipt_sessions r ON r.session_id = i.session_id
   WHERE i.memory_id = m.id) AS receiptedInjections`;

const TRIAL_VERDICTS = `FROM verdicts v
   WHERE v.memory_id = m.id AND v.at > coalesce(m.trial_started_at, '')`;

const TRIAL_COLUMNS = `m.id, m.state, m.kind,
  (SELECT count(DISTINCT v.session_id) ${TRIAL_VERDICTS}) AS verdictSessions,
  (SELECT count(DISTINCT v.session_id) ${TRIAL_VERDICTS} AND v.verdict = 'used') AS usedSessions`;

function rowsByIds<T>(db: Db, columns: string, ids: readonly string[]): T[] {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) {
    return [];
  }
  const placeholders = distinct.map(() => "?").join(", ");
  return db
    .prepare(`SELECT ${columns} FROM memories m WHERE m.id IN (${placeholders})`)
    .all(...distinct) as T[];
}

function startTrial(db: Db, id: string, at: string): void {
  db.prepare("UPDATE memories SET trial_started_at = ? WHERE id = ?").run(at, id);
}

export function applyTransition(
  store: StateStore,
  id: string,
  fromState: MemoryState,
  transition: Transition,
  at: string,
): void {
  store.db
    .prepare("UPDATE memories SET state = ?, updated_at = ? WHERE id = ?")
    .run(transition.toState, at, id);
  if (transition.toState === "active") {
    startTrial(store.db, id, at);
  }
  setVecState(store, id, transition.toState);
  recordTransition(store.db, {
    memoryId: id,
    fromState,
    toState: transition.toState,
    reason: transition.reason,
    evidence: transition.evidence,
    relatedId: null,
    at,
  });
}

export function refreshImportance(db: Db, ids: readonly string[]): void {
  for (const counters of rowsByIds<StoredCounters>(db, COUNTER_COLUMNS, ids)) {
    const importance = derivedImportance(counters);
    if (importance !== counters.importance) {
      db.prepare("UPDATE memories SET importance = ? WHERE id = ?").run(importance, counters.id);
    }
  }
}

export function settleVerdictEvidence(store: StateStore, ids: readonly string[], at: string): void {
  for (const trial of rowsByIds<StoredTrial>(store.db, TRIAL_COLUMNS, ids)) {
    const transition = trialEvidenceTransition(trial);
    if (transition !== undefined) {
      applyTransition(store, trial.id, trial.state, transition, at);
    }
  }
}
