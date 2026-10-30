"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
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
const host_1 = require("./host");
const output_1 = require("./hosts/output");
const translate_1 = require("./hosts/translate");
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
const storelocation_1 = require("./storelocation");
const toolnames_1 = require("./toolnames");
const UNKNOWN_EVENT = "unknown";
function projectDirectory(sessionProjectDir, eventCwd) {
    return sessionProjectDir !== undefined && sessionProjectDir !== "" ? sessionProjectDir : eventCwd;
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
    const injection = (0, inject_1.renderInjection)(selection.rows, selection.budgetTokens, scope.profile.doctorInstruction, selection.degraded);
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
    if (!scope.profile.statuslineBadge) {
        return;
    }
    const paths = (0, statusline_1.statuslinePaths)(scope.config.dataDir);
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
    return scope.profile.nativeAutoMemory && (0, session_1.routesLessons)(source)
        ? (0, session_1.routingLine)((0, automemory_1.readAutoMemory)(scope.env, scope.projectDir, facts).enabled)
        : "";
}
function startModelDownload(env) {
    const child = (0, node_child_process_1.spawn)(process.execPath, [host_1.CLI_ENTRY, "model-init"], {
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
    return modelNotice(setup, readDownloadFailure(scope.config.dataDir), scope.profile.doctorInstruction);
}
function joinedNotices(notices) {
    const present = notices.filter((notice) => notice !== undefined);
    return present.length === 0 ? undefined : present.join("\n");
}
async function sessionStartReply(scope, source, locationNotice) {
    const notice = joinedNotices([locationNotice, await setUpModel(scope)]);
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
function toolText(scope, target) {
    const lookup = (0, keys_1.targetLookup)(target, scope.projectDir);
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
function signalHead(toolInput) {
    const head = (0, keys_1.commandHead)(toolInput);
    return head === undefined ? undefined : (0, capture_1.signalDetail)(head);
}
function feedbackReceiptText(scope, toolInput) {
    return silently(scope.config, (opened) => recordFeedbackCall(opened, scope, toolInput));
}
function storeReceiptText(scope) {
    const { sessionId, now } = scope;
    return silently(scope.config, ({ db }) => (0, signals_1.closeSessionSignals)(db, sessionId, "receipt", now));
}
function commandPassedText(scope, toolInput) {
    const { sessionId, now } = scope;
    const head = signalHead(toolInput);
    if (head === undefined) {
        return Promise.resolve("");
    }
    return silently(scope.config, ({ db }) => (0, signals_1.resolveCommand)(db, { sessionId, head, at: now }));
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
    const injection = (0, inject_1.renderInjection)(rows, scope.config.pretoolBudgetTokens, scope.profile.doctorInstruction);
    if (injection.injectedIds.length === 0) {
        return recordAbstention(opened, scope, "PostToolUseFailure");
    }
    return claimAndRecord(opened, scope, failure, injection);
}
function failedToolText(scope, action) {
    const head = action.interrupted ? undefined : signalHead(action.toolInput);
    const sessionId = scope.sessionId;
    if (head === undefined || sessionId === undefined) {
        return Promise.resolve("");
    }
    const failure = {
        sessionId,
        head,
        projectId: (0, ids_1.resolveProjectId)(scope.projectDir),
        error: action.error,
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
        const decided = (0, capture_1.checkpoint)((0, signals_1.openSignals)(db, scope.sessionId), stopHookActive, (0, toolnames_1.hostToolName)(scope.profile.id, "memory_store"));
        if (decided === undefined) {
            return "";
        }
        (0, signals_1.closeSignals)(db, decided.closedIds, "checkpoint", scope.now);
        return decided.text;
    })
        .immediate());
}
function projectScope(scope) {
    const projectDir = scope.projectDir;
    if (projectDir === undefined) {
        throw new Error("a project action needs the project directory its request was guarded on");
    }
    return { ...scope, projectDir };
}
function inSession(scope, work) {
    const { config, profile, sessionId, now } = scope;
    return sessionId === undefined ? Promise.resolve("") : work({ config, profile, sessionId, now });
}
function actionReply(action, scope, locationNotice) {
    switch (action.kind) {
        case "session-start":
            return sessionStartReply(projectScope(scope), action.source, locationNotice);
        case "prompt":
            return contextOnly(promptText(projectScope(scope), action.prompt));
        case "tool-recall":
            return contextOnly(toolText(projectScope(scope), action.target));
        case "command-failed":
            return contextOnly(failedToolText(projectScope(scope), action));
        case "command-passed":
            return contextOnly(inSession(scope, (session) => commandPassedText(session, action.toolInput)));
        case "feedback-receipt":
            return contextOnly(inSession(scope, (session) => feedbackReceiptText(session, action.toolInput)));
        case "store-receipt":
            return contextOnly(inSession(scope, storeReceiptText));
        case "stop":
            return contextOnly(inSession(scope, (session) => stopText(session, action.stopHookActive)));
    }
}
function sessionProjectDir(profile, env) {
    return profile.projectDirEnv === undefined ? undefined : env[profile.projectDirEnv];
}
function passesScopeGuard(request, projectDir) {
    return request.scope === "session" ? request.sessionId !== undefined : projectDir !== undefined;
}
async function performRequest(request, profile, env) {
    const now = new Date().toISOString();
    const projectDir = projectDirectory(sessionProjectDir(profile, env), request.cwd);
    if (!passesScopeGuard(request, projectDir)) {
        return [];
    }
    const config = (0, cfg_1.loadConfig)(env);
    const state = (0, storelocation_1.storeState)(config.dataDir, (0, storelocation_1.legacyFacts)(profile, env, config.dataDir));
    const notice = (0, storelocation_1.storeNotice)(state, config.dataDir);
    if ((0, storelocation_1.storeMissing)(state)) {
        return startsSession(request) ? [{ context: "", notice }] : [];
    }
    if (state.kind === "shared" && request.actions.length > 0) {
        (0, storelocation_1.ensureDataDir)(config);
    }
    const scope = {
        config: (0, storelocation_1.storeConfig)(config, state, env),
        profile,
        env,
        projectDir,
        sessionId: request.sessionId,
        now,
    };
    const replies = [];
    for (const action of request.actions) {
        replies.push(await actionReply(action, scope, notice));
    }
    return replies;
}
async function readHookInput() {
    const raw = await readStdin();
    if (raw.trim() === "") {
        return undefined;
    }
    const input = JSON.parse(raw);
    return typeof input.hook_event_name === "string" ? input : undefined;
}
function startsSession(request) {
    return request.actions.some((action) => action.kind === "session-start");
}
function printOutput(output) {
    if (output !== undefined) {
        console.log(output);
    }
}
function reportHookFailure(host, request, error) {
    const event = request?.event ?? UNKNOWN_EVENT;
    if (host === undefined) {
        reportFailure(event, error);
        return;
    }
    const outage = (0, outage_1.storageOutage)(error, (0, host_1.hostProfile)(host).dependencyFix);
    if (outage === undefined) {
        reportFailure(event, error);
        return;
    }
    if (request !== undefined && startsSession(request)) {
        printOutput((0, output_1.hostOutput)(host, event, [{ context: "", notice: (0, outage_1.sessionNotice)(outage) }]));
    }
}
async function runHook() {
    let host;
    let request;
    try {
        const input = await readHookInput();
        if (input === undefined) {
            return;
        }
        host = (0, host_1.resolveHost)(process.env);
        request = (0, translate_1.hostRequest)(host, input);
        if (request === undefined) {
            return;
        }
        const replies = await performRequest(request, (0, host_1.hostProfile)(host), process.env);
        printOutput((0, output_1.hostOutput)(host, request.event, replies));
    }
    catch (error) {
        reportHookFailure(host, request, error);
    }
}
if (require.main === module) {
    void runHook();
}
