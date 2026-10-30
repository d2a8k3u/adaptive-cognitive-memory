"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.patchedFiles = patchedFiles;
exports.codexRequest = codexRequest;
const toolnames_1 = require("../toolnames");
const request_1 = require("./request");
const BASH_TOOL = "Bash";
const PATCH_TOOL = "apply_patch";
const FORK_SOURCE = "fork";
const STARTUP_SOURCE = "startup";
const PATCH_FILE_MARKERS = [
    "*** Add File: ",
    "*** Update File: ",
    "*** Delete File: ",
    "*** Move to: ",
];
const TRAILING_CARRIAGE_RETURN = /\r$/;
const FEEDBACK_TOOL = (0, toolnames_1.hostToolName)("codex", "memory_feedback");
const STORE_RECEIPT_TOOLS = new Set([
    (0, toolnames_1.hostToolName)("codex", "memory_store"),
    (0, toolnames_1.hostToolName)("codex", "memory_update"),
]);
const SESSION_EVENTS = new Set(["PostToolUse", "Stop"]);
function patchedPath(line) {
    const marker = PATCH_FILE_MARKERS.find((candidate) => line.startsWith(candidate));
    return marker === undefined ? undefined : line.slice(marker.length);
}
function patchedFiles(patch) {
    const paths = patch
        .split("\n")
        .flatMap((line) => patchedPath(line.replace(TRAILING_CARRIAGE_RETURN, "")) ?? []);
    return [...new Set(paths)];
}
function sessionSource(source) {
    return source === FORK_SOURCE ? STARTUP_SOURCE : source;
}
function toolTarget(toolName, toolInput) {
    if (toolName === BASH_TOOL) {
        return { kind: "command", toolInput };
    }
    const patch = toolName === PATCH_TOOL ? (0, request_1.stringField)((0, request_1.fieldOf)(toolInput, "command")) : undefined;
    return patch === undefined ? { kind: "none" } : { kind: "files", paths: patchedFiles(patch) };
}
function postToolActions(toolName, toolInput) {
    if (toolName === FEEDBACK_TOOL) {
        return [{ kind: "feedback-receipt", toolInput }];
    }
    if (toolName !== undefined && STORE_RECEIPT_TOOLS.has(toolName)) {
        return [{ kind: "store-receipt" }];
    }
    return [];
}
function eventActions(event, input) {
    const toolName = (0, request_1.stringField)(input.tool_name);
    switch (event) {
        case "SessionStart":
            return [{ kind: "session-start", source: sessionSource((0, request_1.stringField)(input.source)) }];
        case "UserPromptSubmit":
            return [{ kind: "prompt", prompt: (0, request_1.stringField)(input.prompt)?.trim() ?? "" }];
        case "PreToolUse":
            return [{ kind: "tool-recall", target: toolTarget(toolName, input.tool_input) }];
        case "PostToolUse":
            return postToolActions(toolName, input.tool_input);
        case "Stop":
            return [{ kind: "stop", stopHookActive: input.stop_hook_active === true }];
        default:
            return undefined;
    }
}
function codexRequest(input) {
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
