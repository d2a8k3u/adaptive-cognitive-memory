"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lifecycleSnapshots = lifecycleSnapshots;
exports.applyTransition = applyTransition;
exports.refreshImportance = refreshImportance;
exports.settleReceiptEvidence = settleReceiptEvidence;
const lifecycle_1 = require("../lifecycle");
const transitions_1 = require("./transitions");
const RECEIPTED_SESSIONS = `SELECT count(DISTINCT i.session_id) FROM injections i
     JOIN receipt_sessions r ON r.session_id = i.session_id
   WHERE i.memory_id = m.id`;
const SNAPSHOT_COLUMNS = `m.id, m.state, m.kind, m.importance,
  m.used_count AS usedCount, m.wrong_count AS wrongCount,
  (${RECEIPTED_SESSIONS}) AS receiptedInjections,
  m.used_count - m.trial_used_base AS trialUsedCount,
  (${RECEIPTED_SESSIONS} AND i.at > coalesce(m.trial_started_at, '')) AS trialReceiptedInjections`;
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
function trialSnapshot(snapshot) {
    return {
        state: snapshot.state,
        kind: snapshot.kind,
        wrongCount: snapshot.wrongCount,
        usedCount: snapshot.trialUsedCount,
        receiptedInjections: snapshot.trialReceiptedInjections,
    };
}
function persistImportance(db, snapshot) {
    const importance = (0, lifecycle_1.derivedImportance)(snapshot);
    if (importance !== snapshot.importance) {
        db.prepare("UPDATE memories SET importance = ? WHERE id = ?").run(importance, snapshot.id);
    }
}
function startTrial(db, id, at) {
    db.prepare("UPDATE memories SET trial_started_at = ?, trial_used_base = used_count WHERE id = ?").run(at, id);
}
function applyTransition(store, id, fromState, transition, at) {
    store.db
        .prepare("UPDATE memories SET state = ?, updated_at = ? WHERE id = ?")
        .run(transition.toState, at, id);
    if (transition.toState === "active") {
        startTrial(store.db, id, at);
    }
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
        const transition = (0, lifecycle_1.receiptEvidenceTransition)(trialSnapshot(snapshot));
        if (transition !== undefined) {
            applyTransition(store, snapshot.id, snapshot.state, transition, at);
        }
    }
}
