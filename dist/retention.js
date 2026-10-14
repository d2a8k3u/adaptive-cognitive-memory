"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_HISTORY_RETENTION_DAYS = exports.RECALL_EVENTS_KEPT = void 0;
exports.daysBefore = daysBefore;
exports.RECALL_EVENTS_KEPT = 10_000;
exports.SESSION_HISTORY_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
function daysBefore(at, days) {
    return new Date(Date.parse(at) - days * DAY_MS).toISOString();
}
