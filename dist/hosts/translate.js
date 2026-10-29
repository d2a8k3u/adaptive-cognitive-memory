"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hostRequest = hostRequest;
const claude_1 = require("./claude");
function hostRequest(host, input) {
    switch (host) {
        case "claude":
            return (0, claude_1.claudeRequest)(input);
        case "codex":
        case "opencode":
            return undefined;
    }
}
