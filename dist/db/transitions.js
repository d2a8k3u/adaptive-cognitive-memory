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
const VECTOR_TABLES = ["memories_vec", "questions_vec"];
function driftedVectors(table) {
    return `FROM ${table} v JOIN memories m ON m.id = v.memory_id WHERE v.state IS NOT m.state`;
}
function setStateIn(db, id, state) {
    for (const table of VECTOR_TABLES) {
        db.prepare(`UPDATE ${table} SET state = ? WHERE memory_id = ?`).run(state, id);
    }
}
function setVecState(store, id, state) {
    if (store.vecLoaded) {
        setStateIn(store.db, id, state);
    }
}
function driftedVecStateCount(db) {
    return VECTOR_TABLES.reduce((sum, table) => sum +
        db
            .prepare(`SELECT count(*) ${driftedVectors(table)}`)
            .pluck()
            .get(), 0);
}
function reconcileVecStates(db) {
    return db
        .transaction(() => {
        const drifted = new Map();
        for (const table of VECTOR_TABLES) {
            const rows = db.prepare(`SELECT m.id, m.state ${driftedVectors(table)}`).all();
            for (const row of rows) {
                drifted.set(row.id, row.state);
            }
        }
        for (const [id, state] of drifted) {
            setStateIn(db, id, state);
        }
        return drifted.size;
    })
        .immediate();
}
