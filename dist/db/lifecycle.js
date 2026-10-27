"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyTransition = applyTransition;
exports.refreshImportance = refreshImportance;
exports.settleVerdictEvidence = settleVerdictEvidence;
const lifecycle_1 = require("../lifecycle");
const transitions_1 = require("./transitions");
const COUNTER_COLUMNS = `m.id, m.importance,
  m.used_count AS usedCount, m.wrong_count AS wrongCount,
  (SELECT count(DISTINCT i.session_id) FROM injections i
     JOIN receipt_sessions r ON r.session_id = i.session_id
   WHERE i.memory_id = m.id) AS receiptedInjections`;
const TRIAL_VERDICTS = `FROM verdicts v
   WHERE v.memory_id = m.id AND v.at > coalesce(m.trial_started_at, '')`;
const TRIAL_COLUMNS = `m.id, m.state, m.kind,
  (SELECT count(DISTINCT v.session_id) ${TRIAL_VERDICTS}) AS verdictSessions,
  (SELECT count(DISTINCT v.session_id) ${TRIAL_VERDICTS} AND v.verdict = 'used') AS usedSessions`;
function rowsByIds(db, columns, ids) {
    const distinct = [...new Set(ids)];
    if (distinct.length === 0) {
        return [];
    }
    const placeholders = distinct.map(() => "?").join(", ");
    return db
        .prepare(`SELECT ${columns} FROM memories m WHERE m.id IN (${placeholders})`)
        .all(...distinct);
}
function startTrial(db, id, at) {
    db.prepare("UPDATE memories SET trial_started_at = ? WHERE id = ?").run(at, id);
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
    for (const counters of rowsByIds(db, COUNTER_COLUMNS, ids)) {
        const importance = (0, lifecycle_1.derivedImportance)(counters);
        if (importance !== counters.importance) {
            db.prepare("UPDATE memories SET importance = ? WHERE id = ?").run(importance, counters.id);
        }
    }
}
function settleVerdictEvidence(store, ids, at) {
    for (const trial of rowsByIds(store.db, TRIAL_COLUMNS, ids)) {
        const transition = (0, lifecycle_1.trialEvidenceTransition)(trial);
        if (transition !== undefined) {
            applyTransition(store, trial.id, trial.state, transition, at);
        }
    }
}
