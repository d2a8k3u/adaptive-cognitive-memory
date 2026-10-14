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
function countVerdict(db, ids, verdict) {
    const sql = COUNTED_VERDICT_SQL[verdict];
    if (sql === undefined) {
        return;
    }
    const increment = db.prepare(sql);
    for (const id of ids) {
        increment.run(id);
    }
}
function reactivationRejection(db, targets, verdict) {
    const reasons = targets
        .filter((target) => (0, lifecycle_1.feedbackTransition)(target.state, verdict)?.toState === "active")
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
function recordFeedback(store, request) {
    const { db } = store;
    const { projectId, verdict, at } = request;
    const requested = [...new Set(request.ids)];
    return db
        .transaction(() => {
        const targets = feedbackMemories(db, projectId, requested);
        const rejection = (0, lifecycle_1.feedbackRejection)(requested, targets) ?? reactivationRejection(db, targets, verdict);
        if (rejection !== undefined) {
            return { outcome: "rejected", reason: rejection };
        }
        countVerdict(db, requested, verdict);
        for (const target of targets) {
            const transition = (0, lifecycle_1.feedbackTransition)(target.state, verdict);
            if (transition !== undefined) {
                (0, lifecycle_2.applyTransition)(store, target.id, target.state, transition, at);
            }
        }
        (0, lifecycle_2.refreshImportance)(db, requested);
        return { outcome: "recorded", memories: feedbackMemories(db, projectId, requested) };
    })
        .immediate();
}
