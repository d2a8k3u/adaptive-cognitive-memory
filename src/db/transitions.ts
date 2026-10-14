import type { MemoryState } from "../policy";
import type { Db } from "./database";

export interface StateStore {
  readonly db: Db;
  readonly vecLoaded: boolean;
}

export interface TransitionRecord {
  readonly memoryId: string;
  readonly fromState: MemoryState;
  readonly toState: MemoryState;
  readonly reason: string;
  readonly evidence: string;
  readonly relatedId: string | null;
  readonly at: string;
}

export function recordTransition(db: Db, transition: TransitionRecord): void {
  db.prepare(
    `INSERT INTO transitions (memory_id, from_state, to_state, reason, evidence, related_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    transition.memoryId,
    transition.fromState,
    transition.toState,
    transition.reason,
    transition.evidence,
    transition.relatedId,
    transition.at,
  );
}

const DRIFTED_VECTORS = `FROM memories_vec v JOIN memories m ON m.id = v.memory_id
  WHERE v.state IS NOT m.state`;

export function setVecState(store: StateStore, id: string, state: MemoryState): void {
  if (store.vecLoaded) {
    store.db.prepare("UPDATE memories_vec SET state = ? WHERE memory_id = ?").run(state, id);
  }
}

export function driftedVecStateCount(db: Db): number {
  return db.prepare(`SELECT count(*) ${DRIFTED_VECTORS}`).pluck().get() as number;
}

export function reconcileVecStates(db: Db): number {
  return db
    .transaction((): number => {
      const drifted = db.prepare(`SELECT m.id, m.state ${DRIFTED_VECTORS}`).all() as {
        id: string;
        state: MemoryState;
      }[];
      const setState = db.prepare("UPDATE memories_vec SET state = ? WHERE memory_id = ?");
      for (const row of drifted) {
        setState.run(row.state, row.id);
      }
      return drifted.length;
    })
    .immediate();
}
