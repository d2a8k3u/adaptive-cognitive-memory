import {
  derivedImportance,
  type LifecycleSnapshot,
  type ReceiptCounters,
  receiptEvidenceTransition,
  type Transition,
} from "../lifecycle";
import type { MemoryKind, MemoryState } from "../policy";
import type { Db } from "./database";
import { recordTransition, type StateStore, setVecState } from "./transitions";

export interface StoredSnapshot extends ReceiptCounters {
  readonly id: string;
  readonly state: MemoryState;
  readonly kind: MemoryKind;
  readonly importance: number;
  readonly trialUsedCount: number;
  readonly trialReceiptedInjections: number;
}

const RECEIPTED_SESSIONS = `SELECT count(DISTINCT i.session_id) FROM injections i
     JOIN receipt_sessions r ON r.session_id = i.session_id
   WHERE i.memory_id = m.id`;

const SNAPSHOT_COLUMNS = `m.id, m.state, m.kind, m.importance,
  m.used_count AS usedCount, m.wrong_count AS wrongCount,
  (${RECEIPTED_SESSIONS}) AS receiptedInjections,
  m.used_count - m.trial_used_base AS trialUsedCount,
  (${RECEIPTED_SESSIONS} AND i.at > coalesce(m.trial_started_at, '')) AS trialReceiptedInjections`;

export function lifecycleSnapshots(db: Db, ids: readonly string[]): StoredSnapshot[] {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) {
    return [];
  }
  const placeholders = distinct.map(() => "?").join(", ");
  return db
    .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM memories m WHERE m.id IN (${placeholders})`)
    .all(...distinct) as StoredSnapshot[];
}

function trialSnapshot(snapshot: StoredSnapshot): LifecycleSnapshot {
  return {
    state: snapshot.state,
    kind: snapshot.kind,
    wrongCount: snapshot.wrongCount,
    usedCount: snapshot.trialUsedCount,
    receiptedInjections: snapshot.trialReceiptedInjections,
  };
}

function persistImportance(db: Db, snapshot: StoredSnapshot): void {
  const importance = derivedImportance(snapshot);
  if (importance !== snapshot.importance) {
    db.prepare("UPDATE memories SET importance = ? WHERE id = ?").run(importance, snapshot.id);
  }
}

function startTrial(db: Db, id: string, at: string): void {
  db.prepare(
    "UPDATE memories SET trial_started_at = ?, trial_used_base = used_count WHERE id = ?",
  ).run(at, id);
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
  for (const snapshot of lifecycleSnapshots(db, ids)) {
    persistImportance(db, snapshot);
  }
}

export function settleReceiptEvidence(store: StateStore, ids: readonly string[], at: string): void {
  for (const snapshot of lifecycleSnapshots(store.db, ids)) {
    persistImportance(store.db, snapshot);
    const transition = receiptEvidenceTransition(trialSnapshot(snapshot));
    if (transition !== undefined) {
      applyTransition(store, snapshot.id, snapshot.state, transition, at);
    }
  }
}
