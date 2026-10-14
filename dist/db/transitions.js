"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordTransition = recordTransition;
exports.setVecState = setVecState;
exports.driftedVecStateCount = driftedVecStateCount;
exports.reconcileVecStates = reconcileVecStates;
function recordTransition(db, transition) {
    db.prepare(`INSERT INTO transitions (memory_id, from_state, to_state, reason, evidence, related_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`).run(transition.memoryId, transition.fromState, transition.toState, transition.reason, transition.evidence, transition.relatedId, transition.at);
}
const DRIFTED_VECTORS = `FROM memories_vec v JOIN memories m ON m.id = v.memory_id
  WHERE v.state IS NOT m.state`;
function setVecState(store, id, state) {
    if (store.vecLoaded) {
        store.db.prepare("UPDATE memories_vec SET state = ? WHERE memory_id = ?").run(state, id);
    }
}
function driftedVecStateCount(db) {
    return db.prepare(`SELECT count(*) ${DRIFTED_VECTORS}`).pluck().get();
}
function reconcileVecStates(db) {
    return db
        .transaction(() => {
        const drifted = db.prepare(`SELECT m.id, m.state ${DRIFTED_VECTORS}`).all();
        const setState = db.prepare("UPDATE memories_vec SET state = ? WHERE memory_id = ?");
        for (const row of drifted) {
            setState.run(row.state, row.id);
        }
        return drifted.length;
    })
        .immediate();
}
