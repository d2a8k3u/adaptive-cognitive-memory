import type { Db } from "./database";
import { refreshImportance } from "./lifecycle";
import type { StateStore } from "./transitions";

export interface InjectionRecord {
  readonly sessionId: string;
  readonly event: string;
  readonly at: string;
  readonly memoryIds: readonly string[];
}

export function sessionInjectedIds(db: Db, sessionId: string): Set<string> {
  const rows = db
    .prepare("SELECT DISTINCT memory_id AS id FROM injections WHERE session_id = ?")
    .all(sessionId) as { id: string }[];
  return new Set(rows.map((row) => row.id));
}

export function contextInjectedIds(db: Db, sessionId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT memory_id AS id FROM injections
       WHERE session_id = ? AND at >= COALESCE(
         (SELECT max(at) FROM injections WHERE session_id = ? AND event = 'SessionStart'), '')`,
    )
    .all(sessionId, sessionId) as { id: string }[];
  return new Set(rows.map((row) => row.id));
}

export function recentInjectionEventTimes(db: Db, limit: number): string[] {
  const rows = db
    .prepare("SELECT DISTINCT at, session_id, event FROM injections ORDER BY at DESC LIMIT ?")
    .all(limit) as { at: string }[];
  return rows.map((row) => row.at);
}

export function recordReceipt(store: StateStore, sessionId: string, at: string): void {
  const { db } = store;
  db.transaction(() => {
    const firstReceipt =
      db
        .prepare("INSERT OR IGNORE INTO receipt_sessions (session_id, first_at) VALUES (?, ?)")
        .run(sessionId, at).changes === 1;
    if (firstReceipt) {
      refreshImportance(db, [...sessionInjectedIds(db, sessionId)]);
    }
  }).immediate();
}

export function recordInjections(store: StateStore, record: InjectionRecord): void {
  const { db } = store;
  if (record.memoryIds.length === 0) {
    return;
  }
  const insert = db.prepare(
    "INSERT INTO injections (session_id, memory_id, event, at) VALUES (?, ?, ?, ?)",
  );
  const countFirstInjection = db.prepare(
    "UPDATE memories SET injection_count = injection_count + 1, last_injected_at = ? WHERE id = ?",
  );
  const stampReinjection = db.prepare("UPDATE memories SET last_injected_at = ? WHERE id = ?");
  db.transaction(() => {
    const earlier = sessionInjectedIds(db, record.sessionId);
    const firstInSession = record.memoryIds.filter((memoryId) => !earlier.has(memoryId));
    for (const memoryId of record.memoryIds) {
      insert.run(record.sessionId, memoryId, record.event, record.at);
      const stamp = earlier.has(memoryId) ? stampReinjection : countFirstInjection;
      stamp.run(record.at, memoryId);
    }
    refreshImportance(db, firstInSession);
  }).immediate();
}
