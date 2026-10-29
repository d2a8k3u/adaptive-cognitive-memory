"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.claudeRequest = claudeRequest;
const toolnames_1 = require("../toolnames");
const request_1 = require("./request");
const BASH_TOOL = "Bash";
const FILE_TOOLS = new Set(["Edit", "Write", "Read"]);
const FEEDBACK_TOOL = (0, toolnames_1.hostToolName)("claude", "memory_feedback");
const STORE_RECEIPT_TOOLS = new Set([
    (0, toolnames_1.hostToolName)("claude", "memory_store"),
    (0, toolnames_1.hostToolName)("claude", "memory_update"),
]);
const SESSION_EVENTS = new Set(["PostToolUse", "Stop"]);
function toolTarget(toolName, toolInput) {
    if (toolName === BASH_TOOL) {
        return { kind: "command", toolInput };
    }
    const filePath = toolName !== undefined && FILE_TOOLS.has(toolName)
        ? (0, request_1.stringField)((0, request_1.fieldOf)(toolInput, "file_path"))
        : undefined;
    return filePath === undefined ? { kind: "none" } : { kind: "files", paths: [filePath] };
}
function launchedInBackground(toolInput) {
    return (0, request_1.fieldOf)(toolInput, "run_in_background") === true;
}
function postToolActions(toolName, toolInput) {
    if (toolName === FEEDBACK_TOOL) {
        return [{ kind: "feedback-receipt", toolInput }];
    }
    if (toolName !== undefined && STORE_RECEIPT_TOOLS.has(toolName)) {
        return [{ kind: "store-receipt" }];
    }
    if (toolName === BASH_TOOL && !launchedInBackground(toolInput)) {
        return [{ kind: "command-passed", toolInput }];
    }
    return [];
}
function failedToolActions(input, toolName) {
    if (toolName !== BASH_TOOL) {
        return [];
    }
    return [
        {
            kind: "command-failed",
            toolInput: input.tool_input,
            error: (0, request_1.stringField)(input.error),
            interrupted: input.is_interrupt === true,
        },
    ];
}
function eventActions(event, input) {
    const toolName = (0, request_1.stringField)(input.tool_name);
    switch (event) {
        case "SessionStart":
            return [{ kind: "session-start", source: (0, request_1.stringField)(input.source) }];
        case "UserPromptSubmit":
            return [{ kind: "prompt", prompt: (0, request_1.stringField)(input.prompt)?.trim() ?? "" }];
        case "PreToolUse":
            return [{ kind: "tool-recall", target: toolTarget(toolName, input.tool_input) }];
        case "PostToolUse":
            return postToolActions(toolName, input.tool_input);
        case "PostToolUseFailure":
            return failedToolActions(input, toolName);
        case "Stop":
            return [{ kind: "stop", stopHookActive: input.stop_hook_active === true }];
        default:
            return undefined;
    }
}
function claudeRequest(input) {
    const event = (0, request_1.stringField)(input.hook_event_name);
    const actions = event === undefined ? undefined : eventActions(event, input);
    if (event === undefined || actions === undefined) {
        return undefined;
    }
    return {
        event,
        scope: SESSION_EVENTS.has(event) ? "session" : "project",
        sessionId: (0, request_1.stringField)(input.session_id),
        cwd: (0, request_1.stringField)(input.cwd),
        actions,
    };
}
