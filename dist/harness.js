"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HARNESS_MARKERS = void 0;
exports.harnessMarker = harnessMarker;
exports.HARNESS_MARKERS = [
    "<agent-message",
    "<system-reminder",
    "<task-notification",
    "[Subagent hand-back]",
    "Another Claude session sent a message:",
];
function harnessMarker(text) {
    return exports.HARNESS_MARKERS.find((marker) => text.includes(marker));
}
