"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FRESH_COUNTERS = exports.DEMOTION_MIN_VERDICT_SESSIONS = exports.FEEDBACK_IDS_MAX_ITEMS = exports.FEEDBACK_VERDICTS = void 0;
exports.parseFeedbackVerdicts = parseFeedbackVerdicts;
exports.reactivation = reactivation;
exports.feedbackTransition = feedbackTransition;
exports.feedbackRejection = feedbackRejection;
exports.trialEvidenceTransition = trialEvidenceTransition;
exports.derivedImportance = derivedImportance;
const ids_1 = require("./ids");
const session_1 = require("./session");
exports.FEEDBACK_VERDICTS = ["used", "wrong", "not_applicable"];
exports.FEEDBACK_IDS_MAX_ITEMS = 20;
function isMemoryId(value) {
    return typeof value === "string" && value !== "" && value.length <= ids_1.ID_MAX_CHARS;
}
function parseIdList(fields, verdict) {
    const value = fields.get(verdict);
    if (value === undefined) {
        return { outcome: "parsed", ids: [] };
    }
    if (!Array.isArray(value) || !value.every(isMemoryId)) {
        return {
            outcome: "invalid",
            field: verdict,
            message: `${verdict} must be a list of memory ids of at most ${ids_1.ID_MAX_CHARS} characters`,
        };
    }
    return { outcome: "parsed", ids: [...new Set(value)] };
}
function idUnderTwoVerdicts(verdicts) {
    const verdictOf = new Map();
    for (const verdict of exports.FEEDBACK_VERDICTS) {
        for (const id of verdicts[verdict]) {
            const earlier = verdictOf.get(id);
            if (earlier !== undefined) {
                return `memory ${id} is under both ${earlier} and ${verdict}; give each id one verdict`;
            }
            verdictOf.set(id, verdict);
        }
    }
    return undefined;
}
function rawIdCount(fields) {
    return exports.FEEDBACK_VERDICTS.reduce((sum, verdict) => {
        const value = fields.get(verdict);
        return sum + (Array.isArray(value) ? value.length : 0);
    }, 0);
}
function inputFields(input) {
    return typeof input === "object" && input !== null && !Array.isArray(input)
        ? new Map(Object.entries(input))
        : new Map();
}
function parseFeedbackVerdicts(input) {
    const fields = inputFields(input);
    const lists = {};
    for (const verdict of exports.FEEDBACK_VERDICTS) {
        const parsed = parseIdList(fields, verdict);
        if (parsed.outcome === "invalid") {
            return parsed;
        }
        lists[verdict] = parsed.ids;
    }
    const verdicts = {
        used: lists.used ?? [],
        wrong: lists.wrong ?? [],
        not_applicable: lists.not_applicable ?? [],
    };
    const count = rawIdCount(fields);
    if (count === 0 || count > exports.FEEDBACK_IDS_MAX_ITEMS) {
        return {
            outcome: "invalid",
            message: `give 1 to ${exports.FEEDBACK_IDS_MAX_ITEMS} memory ids in total under ${exports.FEEDBACK_VERDICTS.join(", ")}`,
        };
    }
    const conflict = idUnderTwoVerdicts(verdicts);
    return conflict === undefined
        ? { outcome: "parsed", verdicts }
        : { outcome: "invalid", message: conflict };
}
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
exports.DEMOTION_MIN_VERDICT_SESSIONS = 5;
const DEMOTION_MIN_USED_SHARE = 0.5;
function trialEvidenceTransition(evidence) {
    const { state, kind, verdictSessions, usedSessions } = evidence;
    if (state !== "active" ||
        session_1.PINNED_KINDS.includes(kind) ||
        verdictSessions < exports.DEMOTION_MIN_VERDICT_SESSIONS) {
        return undefined;
    }
    if (usedSessions / verdictSessions >= DEMOTION_MIN_USED_SHARE) {
        return undefined;
    }
    return {
        toState: "hypothesis",
        reason: "unused_after_verdicts",
        evidence: `used in ${usedSessions} of ${verdictSessions} sessions with a verdict`,
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
