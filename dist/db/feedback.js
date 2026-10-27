"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordFeedback = recordFeedback;
const lifecycle_1 = require("../lifecycle");
const policy_1 = require("../policy");
const lifecycle_2 = require("./lifecycle");
const memories_1 = require("./memories");
const visibility_1 = require("./visibility");
const COUNTED_VERDICT_SQL = {
    used: "UPDATE memories SET used_count = used_count + 1 WHERE id = ?",
    wrong: "UPDATE memories SET wrong_count = wrong_count + 1 WHERE id = ?",
    not_applicable: undefined,
};
function countVerdicts(db, judged) {
    for (const { id, verdict } of judged) {
        const sql = COUNTED_VERDICT_SQL[verdict];
        if (sql !== undefined) {
            db.prepare(sql).run(id);
        }
    }
}
function reactivationRejection(db, judged) {
    const reasons = judged
        .filter((target) => (0, lifecycle_1.feedbackTransition)(target.state, target.verdict)?.toState === "active")
        .flatMap((target) => {
        const slot = (0, memories_1.slotRow)(db, target.id);
        const reactivation = (0, policy_1.reactivationVerdict)(slot, (0, memories_1.singleKeyHolders)(db, slot));
        return reactivation.allowed ? [] : [reactivation.reason];
    });
    return reasons.length === 0 ? undefined : `no feedback recorded: ${reasons.join("; ")}`;
}
function feedbackMemories(db, projectId, ids) {
    const placeholders = ids.map(() => "?").join(", ");
    const visible = db
        .prepare(`SELECT m.id, m.state FROM memories m
       WHERE m.id IN (${placeholders}) AND ${visibility_1.VISIBLE_TO_PROJECT}`)
        .all(...ids, projectId);
    const stateById = new Map(visible.map((row) => [row.id, row.state]));
    return ids.flatMap((id) => {
        const state = stateById.get(id);
        return state === undefined ? [] : [{ id, state }];
    });
}
function judgedMemories(verdicts, targets) {
    const stateById = new Map(targets.map((target) => [target.id, target.state]));
    return lifecycle_1.FEEDBACK_VERDICTS.flatMap((verdict) => verdicts[verdict].flatMap((id) => {
        const state = stateById.get(id);
        return state === undefined ? [] : [{ id, state, verdict }];
    }));
}
function recordFeedback(store, request) {
    const { db } = store;
    const { projectId, verdicts, at } = request;
    const requested = lifecycle_1.FEEDBACK_VERDICTS.flatMap((verdict) => verdicts[verdict]);
    return db
        .transaction(() => {
        const targets = feedbackMemories(db, projectId, requested);
        const judged = judgedMemories(verdicts, targets);
        const rejection = (0, lifecycle_1.feedbackRejection)(requested, targets) ?? reactivationRejection(db, judged);
        if (rejection !== undefined) {
            return { outcome: "rejected", reason: rejection };
        }
        countVerdicts(db, judged);
        for (const target of judged) {
            const transition = (0, lifecycle_1.feedbackTransition)(target.state, target.verdict);
            if (transition !== undefined) {
                (0, lifecycle_2.applyTransition)(store, target.id, target.state, transition, at);
            }
        }
        (0, lifecycle_2.refreshImportance)(db, requested);
        return { outcome: "recorded", memories: feedbackMemories(db, projectId, requested) };
    })
        .immediate();
}
