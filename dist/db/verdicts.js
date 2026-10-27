"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordVerdicts = recordVerdicts;
const lifecycle_1 = require("../lifecycle");
const lifecycle_2 = require("./lifecycle");
function recordVerdicts(store, record) {
    const { db } = store;
    const insert = db.prepare(`INSERT INTO verdicts (session_id, memory_id, verdict, at)
     SELECT ?, id, ?, ? FROM memories WHERE id = ? AND state <> 'revoked'`);
    db.transaction(() => {
        const judged = [];
        for (const verdict of lifecycle_1.FEEDBACK_VERDICTS) {
            for (const id of record.verdicts[verdict]) {
                if (insert.run(record.sessionId, verdict, record.at, id).changes === 1) {
                    judged.push(id);
                }
            }
        }
        (0, lifecycle_2.settleVerdictEvidence)(store, judged, record.at);
    }).immediate();
}
