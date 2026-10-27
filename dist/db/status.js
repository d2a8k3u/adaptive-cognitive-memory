"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.statusFacts = statusFacts;
const session_1 = require("../session");
const status_1 = require("../status");
const projects_1 = require("./projects");
const visibility_1 = require("./visibility");
function memoryCounts(db, projectId) {
    return db
        .prepare(`SELECT m.scope, m.state, m.kind, count(*) AS count FROM memories m
       WHERE ${visibility_1.VISIBLE_TO_PROJECT} GROUP BY m.scope, m.state, m.kind`)
        .all(projectId);
}
function transitionCounts(db, projectId) {
    return db
        .prepare(`SELECT t.reason, count(*) AS count FROM transitions t JOIN memories m ON m.id = t.memory_id
       WHERE ${visibility_1.VISIBLE_TO_PROJECT} GROUP BY t.reason ORDER BY t.reason`)
        .all(projectId);
}
function recallEventCounts(db) {
    return db
        .prepare(`SELECT event, count(*) AS events, coalesce(sum(injected > 0), 0) AS injecting
       FROM (SELECT event, injected FROM recall_events ORDER BY id DESC LIMIT ?)
       GROUP BY event ORDER BY event`)
        .all(status_1.RECALL_RATE_WINDOW);
}
function receiptInjections(db) {
    const pinnedKinds = session_1.PINNED_KINDS.map(() => "?").join(", ");
    return db
        .prepare(`SELECT count(*) AS memories, coalesce(sum(m.used_count = 0), 0) AS neverUsed
       FROM memories m WHERE m.kind NOT IN (${pinnedKinds}) AND m.id IN (
         SELECT i.memory_id FROM injections i
         JOIN receipt_sessions r ON r.session_id = i.session_id)`)
        .get(...session_1.PINNED_KINDS);
}
function verdictCoverage(db) {
    const pinnedKinds = session_1.PINNED_KINDS.map(() => "?").join(", ");
    return db
        .prepare(`SELECT count(*) AS injections,
         coalesce(sum(EXISTS (SELECT 1 FROM verdicts v
           WHERE v.session_id = pair.session_id AND v.memory_id = pair.memory_id)), 0) AS judged
       FROM (SELECT i.session_id, i.memory_id, max(i.at) AS lastAt FROM injections i
             JOIN memories m ON m.id = i.memory_id
             WHERE m.kind NOT IN (${pinnedKinds})
             GROUP BY i.session_id, i.memory_id ORDER BY lastAt DESC LIMIT ?) pair`)
        .get(...session_1.PINNED_KINDS, status_1.VERDICT_COVERAGE_WINDOW);
}
function openSignalFacts(db) {
    return db
        .prepare(`SELECT session_id AS sessionId, kind, detail, opened_at AS openedAt FROM session_signals
       WHERE closed_at IS NULL ORDER BY opened_at DESC, id DESC LIMIT ?`)
        .all(status_1.STATUS_LIST_LIMIT);
}
function recentInjections(db) {
    return db
        .prepare(`SELECT i.memory_id AS id, m.title, i.event, i.at FROM injections i
       JOIN memories m ON m.id = i.memory_id ORDER BY i.at DESC LIMIT ?`)
        .all(status_1.STATUS_LIST_LIMIT);
}
function statusFacts(db, projectId) {
    return {
        projectId,
        recallEnabled: (0, projects_1.recallEnabled)(db, projectId),
        memoryCounts: memoryCounts(db, projectId),
        transitionCounts: transitionCounts(db, projectId),
        recallEvents: recallEventCounts(db),
        receiptInjections: receiptInjections(db),
        verdictCoverage: verdictCoverage(db),
        openSignals: openSignalFacts(db),
        recentInjections: recentInjections(db),
    };
}
