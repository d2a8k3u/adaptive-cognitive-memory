import { spawn } from "node:child_process";
import { join } from "node:path";
import { readAutoMemory } from "./automemory";
import { ticketId } from "./branch";
import { FAILURE_GATE, PROMPT_GATE, PROMPT_MIN_WORDS, TOOL_GATE } from "./calibration";
import { checkpoint, signalDetail } from "./capture";
import { type Config, loadConfig } from "./cfg";
import type { Db, OpenedDb } from "./db/database";
import { pruneRecallEvents, type RecallEventName, recordRecallEvent } from "./db/events";
import { claimFailureRecall, pruneFailureRecalls } from "./db/failures";
import {
  contextInjectedIds,
  recentInjectionEventTimes,
  recordInjections,
  recordReceipt,
  sessionInjectedIds,
} from "./db/injections";
import { recallEnabled } from "./db/projects";
import {
  closeSessionSignals,
  closeSignals,
  openSignals,
  pruneSessionHistory,
  recordCommandFailure,
  resolveCommand,
} from "./db/signals";
import { recordVerdicts } from "./db/verdicts";
import { failureLookup, failureSignature } from "./failure";
import {
  type RecalledMemory,
  selectPromptMemories,
  selectToolMemories,
  type ToolCandidate,
  type ToolGate,
} from "./gate";
import { collectLocationFacts, type LocationFacts, projectIdentity, resolveProjectId } from "./ids";
import { type Injection, renderInjection } from "./inject";
import { commandHead, type ToolLookup, toolLookup } from "./keys";
import { parseFeedbackVerdicts } from "./lifecycle";
import { sessionNotice, storageOutage } from "./outage";
import { admitPrompt } from "./prompt";
import { daysBefore, RECALL_EVENTS_KEPT, SESSION_HISTORY_RETENTION_DAYS } from "./retention";
import type { DegradedFlags } from "./search";
import {
  routesLessons,
  routingLine,
  STALE_AFTER_INJECTION_EVENTS,
  sessionStartMemories,
} from "./session";
import {
  distShim,
  pruneBadgeStates,
  refreshShim,
  type StatuslinePaths,
  statuslineEnabled,
  statuslinePaths,
  writeBadgeState,
} from "./statusline";
import { BADGE_STATE_VERSION, type BadgeState, isBadgeSessionId } from "./statusline/badge";
import { hostToolName, STORE_TOOL } from "./toolnames";
import { PLUGIN_ROOT } from "./version";

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];
const SESSION_EVENTS = ["PostToolUse", "Stop"] as const;
type SessionEvent = (typeof SESSION_EVENTS)[number];

const CLI_ENTRY = join(PLUGIN_ROOT, "dist", "cli.js");

const BASH_TOOL = "Bash";
const FEEDBACK_TOOL = hostToolName("memory_feedback");
const STORE_RECEIPT_TOOLS: ReadonlySet<string> = new Set([
  STORE_TOOL,
  hostToolName("memory_update"),
]);

interface HookInput {
  hook_event_name?: unknown;
  cwd?: unknown;
  session_id?: unknown;
  source?: unknown;
  prompt?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  error?: unknown;
  is_interrupt?: unknown;
  stop_hook_active?: unknown;
}

interface SessionScope {
  readonly config: Config;
  readonly sessionId: string;
  readonly now: string;
}

interface HookScope {
  readonly config: Config;
  readonly env: NodeJS.ProcessEnv;
  readonly projectDir: string;
  readonly sessionId: string | undefined;
  readonly now: string;
}

interface Selection {
  readonly event: RecallEventName;
  readonly rows: readonly RecalledMemory[];
  readonly budgetTokens: number;
  readonly degraded?: DegradedFlags;
}

interface HookReply {
  readonly context: string;
  readonly notice?: string;
}

interface StartLocation {
  readonly projectId: string;
  readonly ticket: string | undefined;
}

interface CommandFailure {
  readonly sessionId: string;
  readonly head: string;
  readonly projectId: string;
  readonly error: string | undefined;
}

function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === "string" && (HOOK_EVENTS as readonly string[]).includes(value);
}

function isSessionEvent(event: HookEvent): event is SessionEvent {
  return (SESSION_EVENTS as readonly HookEvent[]).includes(event);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function projectDirectory(
  sessionProjectDir: string | undefined,
  eventCwd: string | undefined,
): string | undefined {
  return sessionProjectDir !== undefined && sessionProjectDir !== "" ? sessionProjectDir : eventCwd;
}

function hookOutput(event: HookEvent, reply: HookReply): string | undefined {
  const output = {
    ...(reply.notice === undefined ? {} : { systemMessage: reply.notice }),
    ...(reply.context === ""
      ? {}
      : { hookSpecificOutput: { hookEventName: event, additionalContext: reply.context } }),
  };
  return Object.keys(output).length === 0 ? undefined : JSON.stringify(output);
}

function contextOnly(text: Promise<string>): Promise<HookReply> {
  return text.then((context) => ({ context }));
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function errorClassName(error: unknown): string {
  if (error instanceof Error) {
    return error.constructor.name;
  }
  return typeof error;
}

function reportFailure(event: string, error: unknown): void {
  console.error(`memory hook ${event} failed: ${errorClassName(error)} — no injection`);
}

async function withDatabase(
  config: Config,
  work: (opened: OpenedDb) => Promise<string>,
): Promise<string> {
  const { openDatabase } = await import("./db/database.js");
  const opened = openDatabase(config);
  try {
    return await work(opened);
  } finally {
    opened.db.close();
  }
}

function alreadyInjected(opened: OpenedDb, scope: HookScope): ReadonlySet<string> {
  return scope.sessionId === undefined ? new Set() : contextInjectedIds(opened.db, scope.sessionId);
}

function recordRecall(
  opened: OpenedDb,
  scope: HookScope,
  event: RecallEventName,
  injectedIds: readonly string[],
): void {
  if (scope.sessionId !== undefined) {
    recordInjections(opened, {
      sessionId: scope.sessionId,
      event,
      at: scope.now,
      memoryIds: injectedIds,
    });
  }
  recordRecallEvent(opened.db, {
    sessionId: scope.sessionId,
    event,
    at: scope.now,
    injected: injectedIds.length,
  });
}

function injectAndRecord(opened: OpenedDb, scope: HookScope, selection: Selection): string {
  const injection = renderInjection(selection.rows, selection.budgetTokens, selection.degraded);
  recordRecall(opened, scope, selection.event, injection.injectedIds);
  return injection.text;
}

function recordAbstention(opened: OpenedDb, scope: HookScope, event: RecallEventName): string {
  recordRecall(opened, scope, event, []);
  return "";
}

function fsErrorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "syscall" in error &&
    typeof error.syscall === "string" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function whileStatuslineEnabled(scope: HookScope, work: (paths: StatuslinePaths) => void): void {
  const paths = statuslinePaths(scope.config.pluginData);
  if (!statuslineEnabled(paths)) {
    return;
  }
  try {
    work(paths);
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === undefined) {
      throw error;
    }
    console.error(`statusline badge not written: ${code}`);
  }
}

function writeSessionBadge(
  paths: StatuslinePaths,
  opened: OpenedDb,
  scope: HookScope,
  event: RecallEventName,
  recallOn: boolean,
): void {
  const sessionId = scope.sessionId;
  if (!isBadgeSessionId(sessionId)) {
    return;
  }
  const state: BadgeState = {
    version: BADGE_STATE_VERSION,
    session_id: sessionId,
    injected: sessionInjectedIds(opened.db, sessionId).size,
    last_event: event,
    last_at: scope.now,
    recall: recallOn ? "on" : "off",
  };
  writeBadgeState(paths, state);
}

function updateBadge(
  opened: OpenedDb,
  scope: HookScope,
  event: RecallEventName,
  recallOn: boolean,
): void {
  whileStatuslineEnabled(scope, (paths) =>
    writeSessionBadge(paths, opened, scope, event, recallOn),
  );
}

function statuslineAtSessionStart(opened: OpenedDb, scope: HookScope, recallOn: boolean): void {
  whileStatuslineEnabled(scope, (paths) => {
    refreshShim(paths, distShim());
    pruneBadgeStates(paths, daysBefore(scope.now, SESSION_HISTORY_RETENTION_DAYS));
    writeSessionBadge(paths, opened, scope, "SessionStart", recallOn);
  });
}

function keepHistoryBounded(db: Db, now: string): void {
  const cutoff = daysBefore(now, SESSION_HISTORY_RETENTION_DAYS);
  db.transaction(() => {
    pruneRecallEvents(db, RECALL_EVENTS_KEPT);
    pruneSessionHistory(db, cutoff);
    pruneFailureRecalls(db, cutoff);
  }).immediate();
}

async function sessionStartRecall(
  opened: OpenedDb,
  scope: HookScope,
  location: StartLocation,
  source: string | undefined,
): Promise<string> {
  const {
    pinnedCandidates,
    sessionEarlierMemories,
    sessionStartLimit,
    TICKET_ROWS_MAX,
    ticketCandidates,
  } = await import("./search.js");
  const budgetTokens = scope.config.budgetTokens;
  const request = { projectId: location.projectId, now: scope.now };
  const rows = sessionStartMemories({
    source,
    pinned: pinnedCandidates(opened.db, request),
    ticket:
      location.ticket === undefined
        ? []
        : ticketCandidates(opened.db, {
            ...request,
            ticket: location.ticket,
            limit: TICKET_ROWS_MAX,
          }),
    earlier:
      scope.sessionId === undefined
        ? []
        : sessionEarlierMemories(opened.db, { ...request, sessionId: scope.sessionId }),
    recentEventTimes: recentInjectionEventTimes(opened.db, STALE_AFTER_INJECTION_EVENTS + 1),
    limit: sessionStartLimit(budgetTokens),
  });
  return injectAndRecord(opened, scope, { event: "SessionStart", rows, budgetTokens });
}

function lessonRouting(scope: HookScope, facts: LocationFacts, source: string | undefined): string {
  return routesLessons(source)
    ? routingLine(readAutoMemory(scope.env, scope.projectDir, facts).enabled)
    : "";
}

function startModelDownload(env: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, [CLI_ENTRY, "model-init"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.on("error", (error) => {
    console.error(
      `memory hook SessionStart could not start the model download: ${errorClassName(error)}`,
    );
  });
  child.unref();
}

async function setUpModel(scope: HookScope): Promise<string | undefined> {
  const { modelNotice, observedModelSetup, readDownloadFailure } = await import(
    "./modeldownload.js"
  );
  const setup = observedModelSetup(scope.config, Date.parse(scope.now));
  if (setup === "ready") {
    return undefined;
  }
  if (setup === "start-download") {
    startModelDownload(scope.env);
  }
  return modelNotice(setup, readDownloadFailure(scope.config.pluginData));
}

async function sessionStartReply(scope: HookScope, source: string | undefined): Promise<HookReply> {
  const notice = await setUpModel(scope);
  return { context: await sessionStartText(scope, source), notice };
}

function sessionStartText(scope: HookScope, source: string | undefined): Promise<string> {
  const facts = collectLocationFacts(scope.projectDir);
  const location = { projectId: projectIdentity(facts), ticket: ticketId(facts.branch) };
  const routing = lessonRouting(scope, facts, source);
  return withDatabase(scope.config, async (opened) => {
    const recallOn = recallEnabled(opened.db, location.projectId);
    const recall = recallOn ? await sessionStartRecall(opened, scope, location, source) : "";
    keepHistoryBounded(opened.db, scope.now);
    statuslineAtSessionStart(opened, scope, recallOn);
    return contextLines([routing, recall]);
  });
}

async function promptRecall(
  opened: OpenedDb,
  scope: HookScope,
  projectId: string,
  prompt: string,
): Promise<string> {
  const admission = admitPrompt(prompt, PROMPT_MIN_WORDS);
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
  const rows = selectPromptMemories(
    found.candidates,
    PROMPT_GATE,
    { neighbourhood: found.neighbourhood },
    alreadyInjected(opened, scope),
  );
  return injectAndRecord(opened, scope, {
    event: "UserPromptSubmit",
    rows,
    budgetTokens: scope.config.budgetTokens,
    degraded: found.degraded,
  });
}

function contextLines(parts: readonly string[]): string {
  return parts.filter((part) => part !== "").join("\n");
}

function promptText(scope: HookScope, prompt: string): Promise<string> {
  const projectId = resolveProjectId(scope.projectDir);
  return withDatabase(scope.config, async (opened) => {
    const recallOn = recallEnabled(opened.db, projectId);
    const recall = recallOn ? await promptRecall(opened, scope, projectId, prompt) : "";
    updateBadge(opened, scope, "UserPromptSubmit", recallOn);
    return recall;
  });
}

async function gatedToolRows(
  opened: OpenedDb,
  scope: HookScope,
  projectId: string,
  lookup: ToolLookup,
  gate: ToolGate,
): Promise<ToolCandidate[]> {
  const { toolCandidates } = await import("./search.js");
  const candidates = toolCandidates(opened.db, {
    projectId,
    lookup,
    keywordSignal: gate.keywordSignal,
    now: scope.now,
  });
  return selectToolMemories(candidates, gate, alreadyInjected(opened, scope));
}

async function toolRecall(
  opened: OpenedDb,
  scope: HookScope,
  projectId: string,
  lookup: ToolLookup | undefined,
): Promise<string> {
  if (lookup === undefined) {
    return recordAbstention(opened, scope, "PreToolUse");
  }
  return injectAndRecord(opened, scope, {
    event: "PreToolUse",
    rows: await gatedToolRows(opened, scope, projectId, lookup, TOOL_GATE),
    budgetTokens: scope.config.pretoolBudgetTokens,
  });
}

function toolText(scope: HookScope, lookup: ToolLookup | undefined): Promise<string> {
  const projectId = resolveProjectId(scope.projectDir);
  return withDatabase(scope.config, async (opened) => {
    const recallOn = recallEnabled(opened.db, projectId);
    const recall = recallOn ? await toolRecall(opened, scope, projectId, lookup) : "";
    updateBadge(opened, scope, "PreToolUse", recallOn);
    return recall;
  });
}

function recordFeedbackCall(opened: OpenedDb, scope: SessionScope, toolInput: unknown): void {
  const { sessionId, now } = scope;
  recordReceipt(opened, sessionId, now);
  const parsed = parseFeedbackVerdicts(toolInput);
  if (parsed.outcome === "parsed") {
    recordVerdicts(opened, { sessionId, verdicts: parsed.verdicts, at: now });
  }
}

function silently(config: Config, work: (opened: OpenedDb) => void): Promise<string> {
  return withDatabase(config, async (opened) => {
    work(opened);
    return "";
  });
}

function bashHead(input: HookInput): string | undefined {
  const head =
    stringField(input.tool_name) === BASH_TOOL ? commandHead(input.tool_input) : undefined;
  return head === undefined ? undefined : signalDetail(head);
}

function launchedInBackground(toolInput: unknown): boolean {
  return (
    typeof toolInput === "object" &&
    toolInput !== null &&
    "run_in_background" in toolInput &&
    toolInput.run_in_background === true
  );
}

function postToolText(scope: SessionScope, input: HookInput): Promise<string> {
  const { config, sessionId, now } = scope;
  const toolName = stringField(input.tool_name) ?? "";
  if (toolName === FEEDBACK_TOOL) {
    return silently(config, (opened) => recordFeedbackCall(opened, scope, input.tool_input));
  }
  if (STORE_RECEIPT_TOOLS.has(toolName)) {
    return silently(config, ({ db }) => closeSessionSignals(db, sessionId, "receipt", now));
  }
  const head = launchedInBackground(input.tool_input) ? undefined : bashHead(input);
  if (head === undefined) {
    return Promise.resolve("");
  }
  return silently(config, ({ db }) => resolveCommand(db, { sessionId, head, at: now }));
}

function claimAndRecord(
  opened: OpenedDb,
  scope: HookScope,
  failure: CommandFailure,
  injection: Injection,
): string {
  return opened.db
    .transaction(() => {
      const claimed = claimFailureRecall(opened.db, {
        sessionId: failure.sessionId,
        head: failure.head,
        at: scope.now,
      });
      recordRecall(opened, scope, "PostToolUseFailure", claimed ? injection.injectedIds : []);
      return claimed ? injection.text : "";
    })
    .immediate();
}

async function failureRecall(
  opened: OpenedDb,
  scope: HookScope,
  failure: CommandFailure,
): Promise<string> {
  const lookup =
    failure.error === undefined ? undefined : failureLookup(failureSignature(failure.error));
  if (lookup === undefined) {
    return recordAbstention(opened, scope, "PostToolUseFailure");
  }
  const rows = await gatedToolRows(opened, scope, failure.projectId, lookup, FAILURE_GATE);
  const injection = renderInjection(rows, scope.config.pretoolBudgetTokens);
  if (injection.injectedIds.length === 0) {
    return recordAbstention(opened, scope, "PostToolUseFailure");
  }
  return claimAndRecord(opened, scope, failure, injection);
}

function failedToolText(scope: HookScope, input: HookInput): Promise<string> {
  const head = input.is_interrupt === true ? undefined : bashHead(input);
  const sessionId = scope.sessionId;
  if (head === undefined || sessionId === undefined) {
    return Promise.resolve("");
  }
  const failure: CommandFailure = {
    sessionId,
    head,
    projectId: resolveProjectId(scope.projectDir),
    error: stringField(input.error),
  };
  return withDatabase(scope.config, async (opened) => {
    recordCommandFailure(opened.db, { sessionId, head, at: scope.now });
    const recallOn = recallEnabled(opened.db, failure.projectId);
    const recall = recallOn ? await failureRecall(opened, scope, failure) : "";
    updateBadge(opened, scope, "PostToolUseFailure", recallOn);
    return recall;
  });
}

function stopText(scope: SessionScope, stopHookActive: boolean): Promise<string> {
  return withDatabase(scope.config, async ({ db }) =>
    db
      .transaction(() => {
        const decided = checkpoint(openSignals(db, scope.sessionId), stopHookActive);
        if (decided === undefined) {
          return "";
        }
        closeSignals(db, decided.closedIds, "checkpoint", scope.now);
        return decided.text;
      })
      .immediate(),
  );
}

function sessionEventText(
  event: SessionEvent,
  input: HookInput,
  scope: SessionScope,
): Promise<string> {
  switch (event) {
    case "PostToolUse":
      return postToolText(scope, input);
    case "Stop":
      return stopText(scope, input.stop_hook_active === true);
  }
}

async function dispatch(
  event: HookEvent,
  input: HookInput,
  env: NodeJS.ProcessEnv,
): Promise<HookReply> {
  const sessionId = stringField(input.session_id);
  const now = new Date().toISOString();
  if (isSessionEvent(event)) {
    return sessionId === undefined
      ? { context: "" }
      : contextOnly(sessionEventText(event, input, { config: loadConfig(env), sessionId, now }));
  }
  const projectDir = projectDirectory(env.CLAUDE_PROJECT_DIR, stringField(input.cwd));
  if (projectDir === undefined) {
    return { context: "" };
  }
  const scope: HookScope = { config: loadConfig(env), env, projectDir, sessionId, now };
  if (event === "UserPromptSubmit") {
    return contextOnly(promptText(scope, stringField(input.prompt)?.trim() ?? ""));
  }
  if (event === "PreToolUse") {
    return contextOnly(
      toolText(scope, toolLookup(stringField(input.tool_name) ?? "", input.tool_input, projectDir)),
    );
  }
  if (event === "PostToolUseFailure") {
    return contextOnly(failedToolText(scope, input));
  }
  return sessionStartReply(scope, stringField(input.source));
}

async function runHook(): Promise<void> {
  let event = "unknown";
  try {
    const raw = await readStdin();
    if (raw.trim() === "") {
      return;
    }
    const input = JSON.parse(raw) as HookInput;
    const hookEvent = input.hook_event_name;
    if (!isHookEvent(hookEvent)) {
      return;
    }
    event = hookEvent;
    const output = hookOutput(hookEvent, await dispatch(hookEvent, input, process.env));
    if (output !== undefined) {
      console.log(output);
    }
  } catch (error) {
    const outage = storageOutage(error);
    if (outage === undefined) {
      reportFailure(event, error);
    } else if (event === "SessionStart") {
      console.log(JSON.stringify({ systemMessage: sessionNotice(outage) }));
    }
  }
}

if (require.main === module) {
  void runHook();
}
