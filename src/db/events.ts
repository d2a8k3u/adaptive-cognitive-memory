import type { Db } from "./database";

export type RecallEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse";

export interface RecallEvent {
  readonly sessionId: string | undefined;
  readonly event: RecallEventName;
  readonly at: string;
  readonly injected: number;
}

export function recordRecallEvent(db: Db, recallEvent: RecallEvent): void {
  db.prepare("INSERT INTO recall_events (session_id, event, at, injected) VALUES (?, ?, ?, ?)").run(
    recallEvent.sessionId ?? null,
    recallEvent.event,
    recallEvent.at,
    recallEvent.injected,
  );
}

export function pruneRecallEvents(db: Db, keep: number): void {
  db.prepare(
    "DELETE FROM recall_events WHERE id <= (SELECT id FROM recall_events ORDER BY id DESC LIMIT 1 OFFSET ?)",
  ).run(keep);
}
