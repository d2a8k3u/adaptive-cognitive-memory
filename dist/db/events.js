"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordRecallEvent = recordRecallEvent;
exports.pruneRecallEvents = pruneRecallEvents;
function recordRecallEvent(db, recallEvent) {
    db.prepare("INSERT INTO recall_events (session_id, event, at, injected) VALUES (?, ?, ?, ?)").run(recallEvent.sessionId ?? null, recallEvent.event, recallEvent.at, recallEvent.injected);
}
function pruneRecallEvents(db, keep) {
    db.prepare("DELETE FROM recall_events WHERE id <= (SELECT id FROM recall_events ORDER BY id DESC LIMIT 1 OFFSET ?)").run(keep);
}
