"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lifecycleSnapshots = lifecycleSnapshots;
exports.applyTransition = applyTransition;
exports.refreshImportance = refreshImportance;
exports.settleReceiptEvidence = settleReceiptEvidence;
const lifecycle_1 = require("../lifecycle");
const transitions_1 = require("./transitions");
const SNAPSHOT_COLUMNS = `m.id, m.state, m.kind, m.importance,
  m.used_count AS usedCount, m.wrong_count AS wrongCount,
  (SELECT count(DISTINCT i.session_id) FROM injections i
     JOIN receipt_sessions r ON r.session_id = i.session_id
   WHERE i.memory_id = m.id) AS receiptedInjections`;
function lifecycleSnapshots(db, ids) {
    const distinct = [...new Set(ids)];
    if (distinct.length === 0) {
        return [];
    }
    const placeholders = distinct.map(() => "?").join(", ");
    return db
        .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM memories m WHERE m.id IN (${placeholders})`)
        .all(...distinct);
}
function persistImportance(db, snapshot) {
    const importance = (0, lifecycle_1.derivedImportance)(snapshot);
    if (importance !== snapshot.importance) {
        db.prepare("UPDATE memories SET importance = ? WHERE id = ?").run(importance, snapshot.id);
    }
}
function applyTransition(store, id, fromState, transition, at) {
    store.db
        .prepare("UPDATE memories SET state = ?, updated_at = ? WHERE id = ?")
        .run(transition.toState, at, id);
    (0, transitions_1.setVecState)(store, id, transition.toState);
    (0, transitions_1.recordTransition)(store.db, {
        memoryId: id,
        fromState,
        toState: transition.toState,
        reason: transition.reason,
        evidence: transition.evidence,
        relatedId: null,
        at,
    });
}
function refreshImportance(db, ids) {
    for (const snapshot of lifecycleSnapshots(db, ids)) {
        persistImportance(db, snapshot);
    }
}
function settleReceiptEvidence(store, ids, at) {
    for (const snapshot of lifecycleSnapshots(store.db, ids)) {
        persistImportance(store.db, snapshot);
        const transition = (0, lifecycle_1.receiptEvidenceTransition)(snapshot);
        if (transition !== undefined) {
            applyTransition(store, snapshot.id, snapshot.state, transition, at);
        }
    }
}
