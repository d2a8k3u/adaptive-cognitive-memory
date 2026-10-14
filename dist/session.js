"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STALE_AFTER_INJECTION_EVENTS = exports.PINNED_KINDS = void 0;
exports.routesLessons = routesLessons;
exports.routingLine = routingLine;
exports.isStale = isStale;
exports.sessionStartMemories = sessionStartMemories;
const toolnames_1 = require("./toolnames");
exports.PINNED_KINDS = ["constraint", "preference"];
exports.STALE_AFTER_INJECTION_EVENTS = 500;
const REINJECTING_SOURCES = new Set(["resume", "compact"]);
const ROUTED_SOURCES = new Set(["startup", "clear", "compact"]);
const ROUTING_LINE = `Native auto memory is also on: store durable lessons with ${toolnames_1.STORE_TOOL}, not in the auto-memory MEMORY.md.`;
function routesLessons(source) {
    return ROUTED_SOURCES.has(source ?? "");
}
function routingLine(autoMemoryEnabled) {
    return autoMemoryEnabled ? ROUTING_LINE : "";
}
function isStale(lastActivityAt, recentEventTimes) {
    const eventsSince = recentEventTimes.filter((at) => at > lastActivityAt).length;
    return eventsSince > exports.STALE_AFTER_INJECTION_EVENTS;
}
function descendingText(a, b) {
    if (a === b) {
        return 0;
    }
    return a > b ? -1 : 1;
}
function byRank(a, b) {
    return (b.candidate.importance - a.candidate.importance ||
        Number(a.stale) - Number(b.stale) ||
        descendingText(a.candidate.createdAt, b.candidate.createdAt) ||
        -descendingText(a.candidate.id, b.candidate.id));
}
function rankedPinned(pinned, recentEventTimes) {
    return pinned
        .map((candidate) => ({ candidate, stale: isStale(candidate.lastActivityAt, recentEventTimes) }))
        .sort(byRank)
        .map((ranked) => ranked.candidate);
}
function firstOccurrences(rows) {
    const seen = new Set();
    return rows.filter((row) => {
        if (seen.has(row.id)) {
            return false;
        }
        seen.add(row.id);
        return true;
    });
}
function sessionStartMemories(input) {
    const carried = REINJECTING_SOURCES.has(input.source ?? "") ? input.earlier : [];
    return firstOccurrences([
        ...rankedPinned(input.pinned, input.recentEventTimes),
        ...carried,
    ]).slice(0, input.limit);
}
