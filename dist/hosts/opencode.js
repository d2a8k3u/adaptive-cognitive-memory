"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bashOutcome = bashOutcome;
exports.opencodeRequest = opencodeRequest;
const node_path_1 = require("node:path");
const toolnames_1 = require("../toolnames");
const request_1 = require("./request");
const BASH_TOOL = "bash";
const FILE_TOOLS = new Set(["read", "edit", "write"]);
const FEEDBACK_TOOL = (0, toolnames_1.hostToolName)("opencode", "memory_feedback");
const STORE_RECEIPT_TOOLS = new Set([
    (0, toolnames_1.hostToolName)("opencode", "memory_store"),
    (0, toolnames_1.hostToolName)("opencode", "memory_update"),
]);
const SESSION_EVENTS = new Set(["session.idle"]);
const STARTUP_SOURCE = "startup";
const COMPACT_SOURCE = "compact";
const PASSING_EXIT_CODE = 0;
function bashOutcome(exit) {
    if (!Number.isInteger(exit)) {
        return "unfinished";
    }
    return exit === PASSING_EXIT_CODE ? "passed" : "failed";
}
function bashActions(input) {
    const toolInput = { command: (0, request_1.stringField)((0, request_1.fieldOf)(input.args, "command")) };
    const recall = { kind: "tool-recall", target: { kind: "command", toolInput } };
    switch (bashOutcome(input.exit)) {
        case "failed":
            return [
                recall,
                { kind: "command-failed", toolInput, error: (0, request_1.stringField)(input.output), interrupted: false },
            ];
        case "passed":
            return [recall, { kind: "command-passed", toolInput }];
        case "unfinished":
            return [recall];
    }
}
function fileTarget(args, cwd) {
    const filePath = (0, request_1.stringField)((0, request_1.fieldOf)(args, "filePath"));
    if (filePath === undefined) {
        return { kind: "none" };
    }
    return { kind: "files", paths: [cwd === undefined ? filePath : (0, node_path_1.resolve)(cwd, filePath)] };
}
function toolActions(input, cwd) {
    const tool = (0, request_1.stringField)(input.tool);
    if (tool === undefined) {
        return undefined;
    }
    if (tool === BASH_TOOL) {
        return bashActions(input);
    }
    if (FILE_TOOLS.has(tool)) {
        return [{ kind: "tool-recall", target: fileTarget(input.args, cwd) }];
    }
    if (tool === FEEDBACK_TOOL) {
        return [{ kind: "feedback-receipt", toolInput: input.args }];
    }
    return STORE_RECEIPT_TOOLS.has(tool) ? [{ kind: "store-receipt" }] : undefined;
}
function promptActions(input) {
    const prompt = { kind: "prompt", prompt: (0, request_1.stringField)(input.prompt)?.trim() ?? "" };
    return input.session_start === true
        ? [{ kind: "session-start", source: STARTUP_SOURCE }, prompt]
        : [prompt];
}
function eventActions(event, input, cwd) {
    switch (event) {
        case "chat.message":
            return promptActions(input);
        case "tool.execute.after":
            return toolActions(input, cwd);
        case "session.idle":
            return [{ kind: "stop", stopHookActive: input.stop_hook_active === true }];
        case "experimental.session.compacting":
            return [{ kind: "session-start", source: COMPACT_SOURCE }];
        default:
            return undefined;
    }
}
function opencodeRequest(input) {
    const event = (0, request_1.stringField)(input.hook_event_name);
    const cwd = (0, request_1.stringField)(input.cwd);
    const actions = event === undefined ? undefined : eventActions(event, input, cwd);
    if (event === undefined || actions === undefined) {
        return undefined;
    }
    return {
        event,
        scope: SESSION_EVENTS.has(event) ? "session" : "project",
        sessionId: (0, request_1.stringField)(input.session_id),
        cwd,
        actions,
    };
}
