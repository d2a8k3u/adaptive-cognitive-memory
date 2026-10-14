"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionInjectedIds = sessionInjectedIds;
exports.contextInjectedIds = contextInjectedIds;
exports.recentInjectionEventTimes = recentInjectionEventTimes;
exports.recordReceipt = recordReceipt;
exports.recordInjections = recordInjections;
const lifecycle_1 = require("./lifecycle");
function sessionInjectedIds(db, sessionId) {
    const rows = db
        .prepare("SELECT DISTINCT memory_id AS id FROM injections WHERE session_id = ?")
        .all(sessionId);
    return new Set(rows.map((row) => row.id));
}
function contextInjectedIds(db, sessionId) {
    const rows = db
        .prepare(`SELECT DISTINCT memory_id AS id FROM injections
       WHERE session_id = ? AND at >= COALESCE(
         (SELECT max(at) FROM injections WHERE session_id = ? AND event = 'SessionStart'), '')`)
        .all(sessionId, sessionId);
    return new Set(rows.map((row) => row.id));
}
function recentInjectionEventTimes(db, limit) {
    const rows = db
        .prepare("SELECT DISTINCT at, session_id, event FROM injections ORDER BY at DESC LIMIT ?")
        .all(limit);
    return rows.map((row) => row.at);
}
function recordReceipt(store, sessionId, at) {
    const { db } = store;
    db.transaction(() => {
        const firstReceipt = db
            .prepare("INSERT OR IGNORE INTO receipt_sessions (session_id, first_at) VALUES (?, ?)")
            .run(sessionId, at).changes === 1;
        if (firstReceipt) {
            (0, lifecycle_1.settleReceiptEvidence)(store, [...sessionInjectedIds(db, sessionId)], at);
        }
    }).immediate();
}
function recordInjections(store, record) {
    const { db } = store;
    if (record.memoryIds.length === 0) {
        return;
    }
    const insert = db.prepare("INSERT INTO injections (session_id, memory_id, event, at) VALUES (?, ?, ?, ?)");
    const countFirstInjection = db.prepare("UPDATE memories SET injection_count = injection_count + 1, last_injected_at = ? WHERE id = ?");
    const stampReinjection = db.prepare("UPDATE memories SET last_injected_at = ? WHERE id = ?");
    db.transaction(() => {
        const earlier = sessionInjectedIds(db, record.sessionId);
        const firstInSession = record.memoryIds.filter((memoryId) => !earlier.has(memoryId));
        for (const memoryId of record.memoryIds) {
            insert.run(record.sessionId, memoryId, record.event, record.at);
            const stamp = earlier.has(memoryId) ? stampReinjection : countFirstInjection;
            stamp.run(record.at, memoryId);
        }
        (0, lifecycle_1.settleReceiptEvidence)(store, firstInSession, record.at);
    }).immediate();
}
