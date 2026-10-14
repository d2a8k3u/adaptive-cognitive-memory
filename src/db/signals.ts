import type { OpenSignal, SignalKind } from "../capture";
import type { Db } from "./database";

export type SignalCloser = "checkpoint" | "receipt";

export interface SignalOpening {
  readonly sessionId: string;
  readonly kind: SignalKind;
  readonly detail: string;
  readonly at: string;
}

export interface CommandOutcome {
  readonly sessionId: string;
  readonly head: string;
  readonly at: string;
}

export function openSignals(db: Db, sessionId: string): OpenSignal[] {
  return db
    .prepare(
      "SELECT id, kind, detail FROM session_signals WHERE session_id = ? AND closed_at IS NULL ORDER BY id",
    )
    .all(sessionId) as OpenSignal[];
}

export function closeSignals(
  db: Db,
  ids: readonly number[],
  closedBy: SignalCloser,
  at: string,
): void {
  const close = db.prepare(
    "UPDATE session_signals SET closed_at = ?, closed_by = ? WHERE id = ? AND closed_at IS NULL",
  );
  for (const id of ids) {
    close.run(at, closedBy, id);
  }
}

export function closeSessionSignals(
  db: Db,
  sessionId: string,
  closedBy: SignalCloser,
  at: string,
): void {
  db.prepare(
    "UPDATE session_signals SET closed_at = ?, closed_by = ? WHERE session_id = ? AND closed_at IS NULL",
  ).run(at, closedBy, sessionId);
}

export function openSignal(db: Db, opening: SignalOpening): void {
  db.prepare(
    "INSERT INTO session_signals (session_id, kind, detail, opened_at) VALUES (?, ?, ?, ?)",
  ).run(opening.sessionId, opening.kind, opening.detail, opening.at);
}

export function pruneSessionHistory(db: Db, cutoff: string): void {
  db.prepare("DELETE FROM session_signals WHERE closed_at < ?").run(cutoff);
  db.prepare("DELETE FROM command_failures WHERE failed_at < ?").run(cutoff);
}

export function recordCommandFailure(db: Db, failure: CommandOutcome): void {
  db.prepare(
    `INSERT INTO command_failures (session_id, head, failed_at) VALUES (?, ?, ?)
     ON CONFLICT (session_id, head) DO UPDATE SET failed_at = excluded.failed_at`,
  ).run(failure.sessionId, failure.head, failure.at);
}

export function resolveCommand(db: Db, success: CommandOutcome): void {
  db.transaction(() => {
    const cleared = db
      .prepare("DELETE FROM command_failures WHERE session_id = ? AND head = ?")
      .run(success.sessionId, success.head).changes;
    const resolvedBefore =
      db
        .prepare(
          "SELECT 1 FROM session_signals WHERE session_id = ? AND kind = 'resolution' AND detail = ?",
        )
        .get(success.sessionId, success.head) !== undefined;
    if (cleared === 1 && !resolvedBefore) {
      openSignal(db, {
        sessionId: success.sessionId,
        kind: "resolution",
        detail: success.head,
        at: success.at,
      });
    }
  }).immediate();
}
