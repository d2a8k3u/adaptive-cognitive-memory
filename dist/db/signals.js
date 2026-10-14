"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openSignals = openSignals;
exports.closeSignals = closeSignals;
exports.closeSessionSignals = closeSessionSignals;
exports.openSignal = openSignal;
exports.pruneSessionHistory = pruneSessionHistory;
exports.recordCommandFailure = recordCommandFailure;
exports.resolveCommand = resolveCommand;
function openSignals(db, sessionId) {
    return db
        .prepare("SELECT id, kind, detail FROM session_signals WHERE session_id = ? AND closed_at IS NULL ORDER BY id")
        .all(sessionId);
}
function closeSignals(db, ids, closedBy, at) {
    const close = db.prepare("UPDATE session_signals SET closed_at = ?, closed_by = ? WHERE id = ? AND closed_at IS NULL");
    for (const id of ids) {
        close.run(at, closedBy, id);
    }
}
function closeSessionSignals(db, sessionId, closedBy, at) {
    db.prepare("UPDATE session_signals SET closed_at = ?, closed_by = ? WHERE session_id = ? AND closed_at IS NULL").run(at, closedBy, sessionId);
}
function openSignal(db, opening) {
    db.prepare("INSERT INTO session_signals (session_id, kind, detail, opened_at) VALUES (?, ?, ?, ?)").run(opening.sessionId, opening.kind, opening.detail, opening.at);
}
function pruneSessionHistory(db, cutoff) {
    db.prepare("DELETE FROM session_signals WHERE closed_at < ?").run(cutoff);
    db.prepare("DELETE FROM command_failures WHERE failed_at < ?").run(cutoff);
}
function recordCommandFailure(db, failure) {
    db.prepare(`INSERT INTO command_failures (session_id, head, failed_at) VALUES (?, ?, ?)
     ON CONFLICT (session_id, head) DO UPDATE SET failed_at = excluded.failed_at`).run(failure.sessionId, failure.head, failure.at);
}
function resolveCommand(db, success) {
    db.transaction(() => {
        const cleared = db
            .prepare("DELETE FROM command_failures WHERE session_id = ? AND head = ?")
            .run(success.sessionId, success.head).changes;
        const resolvedBefore = db
            .prepare("SELECT 1 FROM session_signals WHERE session_id = ? AND kind = 'resolution' AND detail = ?")
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
