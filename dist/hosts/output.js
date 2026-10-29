"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hostOutput = hostOutput;
function claudeOutput(event, replies) {
    if (replies.length > 1) {
        throw new Error(`a Claude ${event} hook prints one reply, got ${replies.length}`);
    }
    const [reply] = replies;
    if (reply === undefined) {
        return undefined;
    }
    const output = {
        ...(reply.notice === undefined ? {} : { systemMessage: reply.notice }),
        ...(reply.context === ""
            ? {}
            : { hookSpecificOutput: { hookEventName: event, additionalContext: reply.context } }),
    };
    return Object.keys(output).length === 0 ? undefined : JSON.stringify(output);
}
function hostOutput(host, event, replies) {
    switch (host) {
        case "claude":
            return claudeOutput(event, replies);
        case "codex":
        case "opencode":
            return undefined;
    }
}
