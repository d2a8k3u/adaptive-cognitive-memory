"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const node_path_1 = require("node:path");
const automemory_1 = require("./automemory");
const branch_1 = require("./branch");
const calibration_1 = require("./calibration");
const capture_1 = require("./capture");
const cfg_1 = require("./cfg");
const events_1 = require("./db/events");
const failures_1 = require("./db/failures");
const injections_1 = require("./db/injections");
const projects_1 = require("./db/projects");
const signals_1 = require("./db/signals");
const verdicts_1 = require("./db/verdicts");
const failure_1 = require("./failure");
const gate_1 = require("./gate");
const ids_1 = require("./ids");
const inject_1 = require("./inject");
const keys_1 = require("./keys");
const lifecycle_1 = require("./lifecycle");
const outage_1 = require("./outage");
const prompt_1 = require("./prompt");
const retention_1 = require("./retention");
const session_1 = require("./session");
const statusline_1 = require("./statusline");
const badge_1 = require("./statusline/badge");
const toolnames_1 = require("./toolnames");
const version_1 = require("./version");
const HOOK_EVENTS = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
];
const SESSION_EVENTS = ["PostToolUse", "Stop"];
const CLI_ENTRY = (0, node_path_1.join)(version_1.PLUGIN_ROOT, "dist", "cli.js");
const BASH_TOOL = "Bash";
const FEEDBACK_TOOL = (0, toolnames_1.hostToolName)("memory_feedback");
const STORE_RECEIPT_TOOLS = new Set([
    toolnames_1.STORE_TOOL,
    (0, toolnames_1.hostToolName)("memory_update"),
]);
function isHookEvent(value) {
    return typeof value === "string" && HOOK_EVENTS.includes(value);
}
function isSessionEvent(event) {
    return SESSION_EVENTS.includes(event);
}
function stringField(value) {
    return typeof value === "string" ? value : undefined;
}
function projectDirectory(sessionProjectDir, eventCwd) {
    return sessionProjectDir !== undefined && sessionProjectDir !== "" ? sessionProjectDir : eventCwd;
}
function hookOutput(event, reply) {
    const output = {
        ...(reply.notice === undefined ? {} : { systemMessage: reply.notice }),
        ...(reply.context === ""
            ? {}
            : { hookSpecificOutput: { hookEventName: event, additionalContext: reply.context } }),
    };
    return Object.keys(output).length === 0 ? undefined : JSON.stringify(output);
}
function contextOnly(text) {
    return text.then((context) => ({ context }));
}
function readStdin() {
    return new Promise((resolve, reject) => {
        if (process.stdin.isTTY) {
            resolve("");
            return;
        }
        const chunks = [];
        process.stdin.on("data", (chunk) => chunks.push(chunk));
        process.stdin.on("error", reject);
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
}
function errorClassName(error) {
    if (error instanceof Error) {
        return error.constructor.name;
    }
    return typeof error;
}
function reportFailure(event, error) {
    console.error(`memory hook ${event} failed: ${errorClassName(error)} — no injection`);
}
async function withDatabase(config, work) {
    const { openDatabase } = await import("./db/database.js");
    const opened = openDatabase(config);
    try {
        return await work(opened);
    }
    finally {
        opened.db.close();
    }
}
function alreadyInjected(opened, scope) {
    return scope.sessionId === undefined ? new Set() : (0, injections_1.contextInjectedIds)(opened.db, scope.sessionId);
}
function recordRecall(opened, scope, event, injectedIds) {
    if (scope.sessionId !== undefined) {
        (0, injections_1.recordInjections)(opened, {
            sessionId: scope.sessionId,
            event,
            at: scope.now,
            memoryIds: injectedIds,
        });
    }
    (0, events_1.recordRecallEvent)(opened.db, {
        sessionId: scope.sessionId,
        event,
        at: scope.now,
        injected: injectedIds.length,
    });
}
function injectAndRecord(opened, scope, selection) {
    const injection = (0, inject_1.renderInjection)(selection.rows, selection.budgetTokens, selection.degraded);
    recordRecall(opened, scope, selection.event, injection.injectedIds);
    return injection.text;
}
function recordAbstention(opened, scope, event) {
    recordRecall(opened, scope, event, []);
    return "";
}
function fsErrorCode(error) {
    return error instanceof Error &&
        "syscall" in error &&
        typeof error.syscall === "string" &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : undefined;
}
function whileStatuslineEnabled(scope, work) {
    const paths = (0, statusline_1.statuslinePaths)(scope.config.pluginData);
    if (!(0, statusline_1.statuslineEnabled)(paths)) {
        return;
    }
    try {
        work(paths);
    }
    catch (error) {
        const code = fsErrorCode(error);
        if (code === undefined) {
            throw error;
        }
        console.error(`statusline badge not written: ${code}`);
    }
}
function writeSessionBadge(paths, opened, scope, event, recallOn) {
    const sessionId = scope.sessionId;
    if (!(0, badge_1.isBadgeSessionId)(sessionId)) {
        return;
    }
    const state = {
        version: badge_1.BADGE_STATE_VERSION,
        session_id: sessionId,
        injected: (0, injections_1.sessionInjectedIds)(opened.db, sessionId).size,
        last_event: event,
        last_at: scope.now,
        recall: recallOn ? "on" : "off",
    };
    (0, statusline_1.writeBadgeState)(paths, state);
}
function updateBadge(opened, scope, event, recallOn) {
    whileStatuslineEnabled(scope, (paths) => writeSessionBadge(paths, opened, scope, event, recallOn));
}
function statuslineAtSessionStart(opened, scope, recallOn) {
    whileStatuslineEnabled(scope, (paths) => {
        (0, statusline_1.refreshShim)(paths, (0, statusline_1.distShim)());
        (0, statusline_1.pruneBadgeStates)(paths, (0, retention_1.daysBefore)(scope.now, retention_1.SESSION_HISTORY_RETENTION_DAYS));
        writeSessionBadge(paths, opened, scope, "SessionStart", recallOn);
    });
}
function keepHistoryBounded(db, now) {
    const cutoff = (0, retention_1.daysBefore)(now, retention_1.SESSION_HISTORY_RETENTION_DAYS);
    db.transaction(() => {
        (0, events_1.pruneRecallEvents)(db, retention_1.RECALL_EVENTS_KEPT);
        (0, signals_1.pruneSessionHistory)(db, cutoff);
        (0, failures_1.pruneFailureRecalls)(db, cutoff);
    }).immediate();
}
async function sessionStartRecall(opened, scope, location, source) {
    const { pinnedCandidates, sessionEarlierMemories, sessionStartLimit, TICKET_ROWS_MAX, ticketCandidates, } = await import("./search.js");
    const budgetTokens = scope.config.budgetTokens;
    const request = { projectId: location.projectId, now: scope.now };
    const rows = (0, session_1.sessionStartMemories)({
        source,
        pinned: pinnedCandidates(opened.db, request),
        ticket: location.ticket === undefined
            ? []
            : ticketCandidates(opened.db, {
                ...request,
                ticket: location.ticket,
                limit: TICKET_ROWS_MAX,
            }),
        earlier: scope.sessionId === undefined
            ? []
            : sessionEarlierMemories(opened.db, { ...request, sessionId: scope.sessionId }),
        recentEventTimes: (0, injections_1.recentInjectionEventTimes)(opened.db, session_1.STALE_AFTER_INJECTION_EVENTS + 1),
        limit: sessionStartLimit(budgetTokens),
    });
    return injectAndRecord(opened, scope, { event: "SessionStart", rows, budgetTokens });
}
function lessonRouting(scope, facts, source) {
    return (0, session_1.routesLessons)(source)
        ? (0, session_1.routingLine)((0, automemory_1.readAutoMemory)(scope.env, scope.projectDir, facts).enabled)
        : "";
}
function startModelDownload(env) {
    const child = (0, node_child_process_1.spawn)(process.execPath, [CLI_ENTRY, "model-init"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env,
    });
    child.on("error", (error) => {
        console.error(`memory hook SessionStart could not start the model download: ${errorClassName(error)}`);
    });
    child.unref();
}
async function setUpModel(scope) {
    const { modelNotice, observedModelSetup, readDownloadFailure } = await import("./modeldownload.js");
    const setup = observedModelSetup(scope.config, Date.parse(scope.now));
    if (setup === "ready") {
        return undefined;
    }
    if (setup === "start-download") {
        startModelDownload(scope.env);
    }
    return modelNotice(setup, readDownloadFailure(scope.config.pluginData));
}
async function sessionStartReply(scope, source) {
    const notice = await setUpModel(scope);
    return { context: await sessionStartText(scope, source), notice };
}
function sessionStartText(scope, source) {
    const facts = (0, ids_1.collectLocationFacts)(scope.projectDir);
    const location = { projectId: (0, ids_1.projectIdentity)(facts), ticket: (0, branch_1.ticketId)(facts.branch) };
    const routing = lessonRouting(scope, facts, source);
    return withDatabase(scope.config, async (opened) => {
        const recallOn = (0, projects_1.recallEnabled)(opened.db, location.projectId);
        const recall = recallOn ? await sessionStartRecall(opened, scope, location, source) : "";
        keepHistoryBounded(opened.db, scope.now);
        statuslineAtSessionStart(opened, scope, recallOn);
        return contextLines([routing, recall]);
    });
}
async function promptRecall(opened, scope, projectId, prompt) {
    const admission = (0, prompt_1.admitPrompt)(prompt, calibration_1.PROMPT_MIN_WORDS);
    if (!admission.admitted) {
        return recordAbstention(opened, scope, "UserPromptSubmit");
    }
    const { promptCandidates } = await import("./search.js");
    const found = await promptCandidates(opened, {
        projectId,
        modelCacheDir: scope.config.modelCacheDir,
        embedDeadlineMs: scope.config.embedDeadlineMs,
        prompt,
        tokens: admission.tokens,
        now: scope.now,
    });
    const rows = (0, gate_1.selectPromptMemories)(found.candidates, calibration_1.PROMPT_GATE, { neighbourhood: found.neighbourhood }, alreadyInjected(opened, scope));
    return injectAndRecord(opened, scope, {
        event: "UserPromptSubmit",
        rows,
        budgetTokens: scope.config.budgetTokens,
        degraded: found.degraded,
    });
}
function contextLines(parts) {
    return parts.filter((part) => part !== "").join("\n");
}
function promptText(scope, prompt) {
    const projectId = (0, ids_1.resolveProjectId)(scope.projectDir);
    return withDatabase(scope.config, async (opened) => {
        const recallOn = (0, projects_1.recallEnabled)(opened.db, projectId);
        const recall = recallOn ? await promptRecall(opened, scope, projectId, prompt) : "";
        updateBadge(opened, scope, "UserPromptSubmit", recallOn);
        return recall;
    });
}
async function gatedToolRows(opened, scope, projectId, lookup, gate) {
    const { toolCandidates } = await import("./search.js");
    const candidates = toolCandidates(opened.db, {
        projectId,
        lookup,
        keywordSignal: gate.keywordSignal,
        now: scope.now,
    });
    return (0, gate_1.selectToolMemories)(candidates, gate, alreadyInjected(opened, scope));
}
async function toolRecall(opened, scope, projectId, lookup) {
    if (lookup === undefined) {
        return recordAbstention(opened, scope, "PreToolUse");
    }
    return injectAndRecord(opened, scope, {
        event: "PreToolUse",
        rows: await gatedToolRows(opened, scope, projectId, lookup, calibration_1.TOOL_GATE),
        budgetTokens: scope.config.pretoolBudgetTokens,
    });
}
function toolText(scope, lookup) {
    const projectId = (0, ids_1.resolveProjectId)(scope.projectDir);
    return withDatabase(scope.config, async (opened) => {
        const recallOn = (0, projects_1.recallEnabled)(opened.db, projectId);
        const recall = recallOn ? await toolRecall(opened, scope, projectId, lookup) : "";
        updateBadge(opened, scope, "PreToolUse", recallOn);
        return recall;
    });
}
function recordFeedbackCall(opened, scope, toolInput) {
    const { sessionId, now } = scope;
    (0, injections_1.recordReceipt)(opened, sessionId, now);
    const parsed = (0, lifecycle_1.parseFeedbackVerdicts)(toolInput);
    if (parsed.outcome === "parsed") {
        (0, verdicts_1.recordVerdicts)(opened, { sessionId, verdicts: parsed.verdicts, at: now });
    }
}
function silently(config, work) {
    return withDatabase(config, async (opened) => {
        work(opened);
        return "";
    });
}
function bashHead(input) {
    const head = stringField(input.tool_name) === BASH_TOOL ? (0, keys_1.commandHead)(input.tool_input) : undefined;
    return head === undefined ? undefined : (0, capture_1.signalDetail)(head);
}
function launchedInBackground(toolInput) {
    return (typeof toolInput === "object" &&
        toolInput !== null &&
        "run_in_background" in toolInput &&
        toolInput.run_in_background === true);
}
function postToolText(scope, input) {
    const { config, sessionId, now } = scope;
    const toolName = stringField(input.tool_name) ?? "";
    if (toolName === FEEDBACK_TOOL) {
        return silently(config, (opened) => recordFeedbackCall(opened, scope, input.tool_input));
    }
    if (STORE_RECEIPT_TOOLS.has(toolName)) {
        return silently(config, ({ db }) => (0, signals_1.closeSessionSignals)(db, sessionId, "receipt", now));
    }
    const head = launchedInBackground(input.tool_input) ? undefined : bashHead(input);
    if (head === undefined) {
        return Promise.resolve("");
    }
    return silently(config, ({ db }) => (0, signals_1.resolveCommand)(db, { sessionId, head, at: now }));
}
function claimAndRecord(opened, scope, failure, injection) {
    return opened.db
        .transaction(() => {
        const claimed = (0, failures_1.claimFailureRecall)(opened.db, {
            sessionId: failure.sessionId,
            head: failure.head,
            at: scope.now,
        });
        recordRecall(opened, scope, "PostToolUseFailure", claimed ? injection.injectedIds : []);
        return claimed ? injection.text : "";
    })
        .immediate();
}
async function failureRecall(opened, scope, failure) {
    const lookup = failure.error === undefined ? undefined : (0, failure_1.failureLookup)((0, failure_1.failureSignature)(failure.error));
    if (lookup === undefined) {
        return recordAbstention(opened, scope, "PostToolUseFailure");
    }
    const rows = await gatedToolRows(opened, scope, failure.projectId, lookup, calibration_1.FAILURE_GATE);
    const injection = (0, inject_1.renderInjection)(rows, scope.config.pretoolBudgetTokens);
    if (injection.injectedIds.length === 0) {
        return recordAbstention(opened, scope, "PostToolUseFailure");
    }
    return claimAndRecord(opened, scope, failure, injection);
}
function failedToolText(scope, input) {
    const head = input.is_interrupt === true ? undefined : bashHead(input);
    const sessionId = scope.sessionId;
    if (head === undefined || sessionId === undefined) {
        return Promise.resolve("");
    }
    const failure = {
        sessionId,
        head,
        projectId: (0, ids_1.resolveProjectId)(scope.projectDir),
        error: stringField(input.error),
    };
    return withDatabase(scope.config, async (opened) => {
        (0, signals_1.recordCommandFailure)(opened.db, { sessionId, head, at: scope.now });
        const recallOn = (0, projects_1.recallEnabled)(opened.db, failure.projectId);
        const recall = recallOn ? await failureRecall(opened, scope, failure) : "";
        updateBadge(opened, scope, "PostToolUseFailure", recallOn);
        return recall;
    });
}
function stopText(scope, stopHookActive) {
    return withDatabase(scope.config, async ({ db }) => db
        .transaction(() => {
        const decided = (0, capture_1.checkpoint)((0, signals_1.openSignals)(db, scope.sessionId), stopHookActive);
        if (decided === undefined) {
            return "";
        }
        (0, signals_1.closeSignals)(db, decided.closedIds, "checkpoint", scope.now);
        return decided.text;
    })
        .immediate());
}
function sessionEventText(event, input, scope) {
    switch (event) {
        case "PostToolUse":
            return postToolText(scope, input);
        case "Stop":
            return stopText(scope, input.stop_hook_active === true);
    }
}
async function dispatch(event, input, env) {
    const sessionId = stringField(input.session_id);
    const now = new Date().toISOString();
    if (isSessionEvent(event)) {
        return sessionId === undefined
            ? { context: "" }
            : contextOnly(sessionEventText(event, input, { config: (0, cfg_1.loadConfig)(env), sessionId, now }));
    }
    const projectDir = projectDirectory(env.CLAUDE_PROJECT_DIR, stringField(input.cwd));
    if (projectDir === undefined) {
        return { context: "" };
    }
    const scope = { config: (0, cfg_1.loadConfig)(env), env, projectDir, sessionId, now };
    if (event === "UserPromptSubmit") {
        return contextOnly(promptText(scope, stringField(input.prompt)?.trim() ?? ""));
    }
    if (event === "PreToolUse") {
        return contextOnly(toolText(scope, (0, keys_1.toolLookup)(stringField(input.tool_name) ?? "", input.tool_input, projectDir)));
    }
    if (event === "PostToolUseFailure") {
        return contextOnly(failedToolText(scope, input));
    }
    return sessionStartReply(scope, stringField(input.source));
}
async function runHook() {
    let event = "unknown";
    try {
        const raw = await readStdin();
        if (raw.trim() === "") {
            return;
        }
        const input = JSON.parse(raw);
        const hookEvent = input.hook_event_name;
        if (!isHookEvent(hookEvent)) {
            return;
        }
        event = hookEvent;
        const output = hookOutput(hookEvent, await dispatch(hookEvent, input, process.env));
        if (output !== undefined) {
            console.log(output);
        }
    }
    catch (error) {
        const outage = (0, outage_1.storageOutage)(error);
        if (outage === undefined) {
            reportFailure(event, error);
        }
        else if (event === "SessionStart") {
            console.log(JSON.stringify({ systemMessage: (0, outage_1.sessionNotice)(outage) }));
        }
    }
}
if (require.main === module) {
    void runHook();
}
