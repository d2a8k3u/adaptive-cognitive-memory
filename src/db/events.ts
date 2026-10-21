import type { Db } from "./database";

export const RECALL_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUseFailure",
] as const;

export type RecallEventName = (typeof RECALL_EVENT_NAMES)[number];

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
