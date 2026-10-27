import {
  derivedImportance,
  type LifecycleSnapshot,
  receiptEvidenceTransition,
  type Transition,
} from "../lifecycle";
import type { MemoryState } from "../policy";
import type { Db } from "./database";
import { recordTransition, type StateStore, setVecState } from "./transitions";

export interface StoredSnapshot extends LifecycleSnapshot {
  readonly id: string;
  readonly importance: number;
}

const SNAPSHOT_COLUMNS = `m.id, m.state, m.kind, m.importance,
  m.used_count AS usedCount, m.wrong_count AS wrongCount,
  (SELECT count(DISTINCT i.session_id) FROM injections i
     JOIN receipt_sessions r ON r.session_id = i.session_id
   WHERE i.memory_id = m.id) AS receiptedInjections`;

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

function persistImportance(db: Db, snapshot: StoredSnapshot): void {
  const importance = derivedImportance(snapshot);
  if (importance !== snapshot.importance) {
    db.prepare("UPDATE memories SET importance = ? WHERE id = ?").run(importance, snapshot.id);
  }
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
    const transition = receiptEvidenceTransition(snapshot);
    if (transition !== undefined) {
      applyTransition(store, snapshot.id, snapshot.state, transition, at);
    }
  }
}
