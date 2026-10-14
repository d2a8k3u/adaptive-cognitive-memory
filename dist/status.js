"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STATUS_LIST_LIMIT = exports.RECALL_RATE_WINDOW = void 0;
exports.statusReport = statusReport;
const policy_1 = require("./policy");
exports.RECALL_RATE_WINDOW = 500;
exports.STATUS_LIST_LIMIT = 10;
const MS_PER_SECOND = 1000;
function ratio(part, whole) {
    return whole === 0 ? null : part / whole;
}
function countOf(counts, scope, state, kind) {
    return counts
        .filter((row) => row.scope === scope && row.state === state && row.kind === kind)
        .reduce((sum, row) => sum + row.count, 0);
}
function stateCounts(counts, scope) {
    const kindCounts = (state) => Object.fromEntries(policy_1.MEMORY_KINDS.map((kind) => [kind, countOf(counts, scope, state, kind)]));
    return Object.fromEntries(policy_1.MEMORY_STATES.map((state) => [state, kindCounts(state)]));
}
function ageSeconds(openedAt, now) {
    return Math.floor((Date.parse(now) - Date.parse(openedAt)) / MS_PER_SECOND);
}
function statusReport(facts, now) {
    const { recallEvents, receiptInjections } = facts;
    return {
        project: { id: facts.projectId, recall: facts.recallEnabled ? "on" : "off" },
        memories: Object.fromEntries(policy_1.MEMORY_SCOPES.map((scope) => [scope, stateCounts(facts.memoryCounts, scope)])),
        transitions: Object.fromEntries(facts.transitionCounts.map((row) => [row.reason, row.count])),
        recall_events: {
            window: exports.RECALL_RATE_WINDOW,
            events: recallEvents.events,
            injecting: recallEvents.injecting,
            rate: ratio(recallEvents.injecting, recallEvents.events),
        },
        receipt_sessions: {
            memories_injected: receiptInjections.memories,
            never_used: receiptInjections.neverUsed,
            share: ratio(receiptInjections.neverUsed, receiptInjections.memories),
        },
        open_signals: facts.openSignals.map((signal) => ({
            session_id: signal.sessionId,
            kind: signal.kind,
            detail: signal.detail,
            age_seconds: ageSeconds(signal.openedAt, now),
        })),
        last_injections: facts.recentInjections,
    };
}
