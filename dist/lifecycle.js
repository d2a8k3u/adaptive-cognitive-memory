"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FRESH_COUNTERS = exports.DEMOTION_MIN_RECEIPTED_INJECTIONS = exports.FEEDBACK_VERDICTS = void 0;
exports.reactivation = reactivation;
exports.feedbackTransition = feedbackTransition;
exports.feedbackRejection = feedbackRejection;
exports.receiptEvidenceTransition = receiptEvidenceTransition;
exports.derivedImportance = derivedImportance;
const session_1 = require("./session");
exports.FEEDBACK_VERDICTS = ["used", "wrong", "not_applicable"];
function reactivation(state, reason, evidence) {
    return state === "hypothesis" ? { toState: "active", reason, evidence } : undefined;
}
function feedbackTransition(state, verdict) {
    if (verdict === "wrong" && state === "active") {
        return { toState: "hypothesis", reason: "feedback_wrong", evidence: verdict };
    }
    return verdict === "used" ? reactivation(state, "feedback_used", verdict) : undefined;
}
function feedbackRejection(requested, found) {
    const stateById = new Map(found.map((target) => [target.id, target.state]));
    const unknown = requested.filter((id) => !stateById.has(id));
    const revoked = requested.filter((id) => stateById.get(id) === "revoked");
    if (unknown.length === 0 && revoked.length === 0) {
        return undefined;
    }
    const problems = [
        ...(unknown.length === 0 ? [] : [`unknown memory ids ${unknown.join(", ")}`]),
        ...(revoked.length === 0 ? [] : [`revoked memory ids ${revoked.join(", ")}`]),
    ];
    return `no feedback recorded: ${problems.join("; ")}. Give feedback only on ids of active or hypothesis memories, exactly as recall printed them`;
}
exports.DEMOTION_MIN_RECEIPTED_INJECTIONS = 5;
const DEMOTION_MIN_USED_SHARE = 0.5;
function receiptEvidenceTransition(snapshot) {
    const { state, kind, usedCount, receiptedInjections } = snapshot;
    if (state !== "active" ||
        session_1.PINNED_KINDS.includes(kind) ||
        receiptedInjections < exports.DEMOTION_MIN_RECEIPTED_INJECTIONS) {
        return undefined;
    }
    if (usedCount / receiptedInjections >= DEMOTION_MIN_USED_SHARE) {
        return undefined;
    }
    return {
        toState: "hypothesis",
        reason: "unused_after_receipts",
        evidence: `used ${usedCount} of ${receiptedInjections} receipted injections`,
    };
}
exports.FRESH_COUNTERS = {
    usedCount: 0,
    wrongCount: 0,
    receiptedInjections: 0,
};
const WRONG_FAILURE_WEIGHT = 2;
function derivedImportance(counters) {
    const unusedInjections = Math.max(0, counters.receiptedInjections - counters.usedCount);
    const failures = WRONG_FAILURE_WEIGHT * counters.wrongCount + unusedInjections;
    return (1 + counters.usedCount) / (2 + counters.usedCount + failures);
}
