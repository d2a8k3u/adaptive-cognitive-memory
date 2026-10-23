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

const VECTOR_TABLES = ["memories_vec", "questions_vec"] as const;

function driftedVectors(table: (typeof VECTOR_TABLES)[number]): string {
  return `FROM ${table} v JOIN memories m ON m.id = v.memory_id WHERE v.state IS NOT m.state`;
}

function setStateIn(db: Db, id: string, state: MemoryState): void {
  for (const table of VECTOR_TABLES) {
    db.prepare(`UPDATE ${table} SET state = ? WHERE memory_id = ?`).run(state, id);
  }
}

export function setVecState(store: StateStore, id: string, state: MemoryState): void {
  if (store.vecLoaded) {
    setStateIn(store.db, id, state);
  }
}

export function driftedVecStateCount(db: Db): number {
  return VECTOR_TABLES.reduce(
    (sum, table) =>
      sum +
      (db
        .prepare(`SELECT count(*) ${driftedVectors(table)}`)
        .pluck()
        .get() as number),
    0,
  );
}

export function reconcileVecStates(db: Db): number {
  return db
    .transaction((): number => {
      const drifted = new Map<string, MemoryState>();
      for (const table of VECTOR_TABLES) {
        const rows = db.prepare(`SELECT m.id, m.state ${driftedVectors(table)}`).all() as {
          id: string;
          state: MemoryState;
        }[];
        for (const row of rows) {
          drifted.set(row.id, row.state);
        }
      }
      for (const [id, state] of drifted) {
        setStateIn(db, id, state);
      }
      return drifted.size;
    })
    .immediate();
}
