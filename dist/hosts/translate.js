"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hostRequest = hostRequest;
const claude_1 = require("./claude");
const codex_1 = require("./codex");
function hostRequest(host, input) {
    switch (host) {
        case "claude":
            return (0, claude_1.claudeRequest)(input);
        case "codex":
            return (0, codex_1.codexRequest)(input);
        case "opencode":
            return undefined;
    }
}
