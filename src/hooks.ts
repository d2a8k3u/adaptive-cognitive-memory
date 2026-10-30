import { spawn } from "node:child_process";
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
import { CLI_ENTRY, type HostId, type HostProfile, hostProfile, resolveHost } from "./host";
import { type HookReply, hostOutput } from "./hosts/output";
import type { EngineAction, HookRequest, HostInput } from "./hosts/request";
import { hostRequest } from "./hosts/translate";
import { collectLocationFacts, type LocationFacts, projectIdentity, resolveProjectId } from "./ids";
import { type Injection, renderInjection } from "./inject";
import { commandHead, type ToolLookup, type ToolTarget, targetLookup } from "./keys";
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
import {
  ensureDataDir,
  legacyFacts,
  storeConfig,
  storeMissing,
  storeNotice,
  storeState,
} from "./storelocation";
import { hostToolName } from "./toolnames";

const UNKNOWN_EVENT = "unknown";

type CommandFailedAction = Extract<EngineAction, { readonly kind: "command-failed" }>;

interface SessionScope {
  readonly config: Config;
  readonly profile: HostProfile;
  readonly sessionId: string;
  readonly now: string;
}

interface RequestScope {
  readonly config: Config;
  readonly profile: HostProfile;
  readonly env: NodeJS.ProcessEnv;
  readonly projectDir: string | undefined;
  readonly sessionId: string | undefined;
  readonly now: string;
}

interface HookScope extends RequestScope {
  readonly projectDir: string;
}

interface Selection {
  readonly event: RecallEventName;
  readonly rows: readonly RecalledMemory[];
  readonly budgetTokens: number;
  readonly degraded?: DegradedFlags;
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

function projectDirectory(
  sessionProjectDir: string | undefined,
  eventCwd: string | undefined,
): string | undefined {
  return sessionProjectDir !== undefined && sessionProjectDir !== "" ? sessionProjectDir : eventCwd;
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
  const injection = renderInjection(
    selection.rows,
    selection.budgetTokens,
    scope.profile.doctorInstruction,
    selection.degraded,
  );
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
  if (!scope.profile.statuslineBadge) {
    return;
  }
  const paths = statuslinePaths(scope.config.dataDir);
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
  return scope.profile.nativeAutoMemory && routesLessons(source)
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
  return modelNotice(
    setup,
    readDownloadFailure(scope.config.dataDir),
    scope.profile.doctorInstruction,
  );
}

function joinedNotices(notices: readonly (string | undefined)[]): string | undefined {
  const present = notices.filter((notice) => notice !== undefined);
  return present.length === 0 ? undefined : present.join("\n");
}

async function sessionStartReply(
  scope: HookScope,
  source: string | undefined,
  locationNotice: string | undefined,
): Promise<HookReply> {
  const notice = joinedNotices([locationNotice, await setUpModel(scope)]);
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

function toolText(scope: HookScope, target: ToolTarget): Promise<string> {
  const lookup = targetLookup(target, scope.projectDir);
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

function signalHead(toolInput: unknown): string | undefined {
  const head = commandHead(toolInput);
  return head === undefined ? undefined : signalDetail(head);
}

function feedbackReceiptText(scope: SessionScope, toolInput: unknown): Promise<string> {
  return silently(scope.config, (opened) => recordFeedbackCall(opened, scope, toolInput));
}

function storeReceiptText(scope: SessionScope): Promise<string> {
  const { sessionId, now } = scope;
  return silently(scope.config, ({ db }) => closeSessionSignals(db, sessionId, "receipt", now));
}

function commandPassedText(scope: SessionScope, toolInput: unknown): Promise<string> {
  const { sessionId, now } = scope;
  const head = signalHead(toolInput);
  if (head === undefined) {
    return Promise.resolve("");
  }
  return silently(scope.config, ({ db }) => resolveCommand(db, { sessionId, head, at: now }));
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
  const injection = renderInjection(
    rows,
    scope.config.pretoolBudgetTokens,
    scope.profile.doctorInstruction,
  );
  if (injection.injectedIds.length === 0) {
    return recordAbstention(opened, scope, "PostToolUseFailure");
  }
  return claimAndRecord(opened, scope, failure, injection);
}

function failedToolText(scope: HookScope, action: CommandFailedAction): Promise<string> {
  const head = action.interrupted ? undefined : signalHead(action.toolInput);
  const sessionId = scope.sessionId;
  if (head === undefined || sessionId === undefined) {
    return Promise.resolve("");
  }
  const failure: CommandFailure = {
    sessionId,
    head,
    projectId: resolveProjectId(scope.projectDir),
    error: action.error,
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
        const decided = checkpoint(
          openSignals(db, scope.sessionId),
          stopHookActive,
          hostToolName(scope.profile.id, "memory_store"),
        );
        if (decided === undefined) {
          return "";
        }
        closeSignals(db, decided.closedIds, "checkpoint", scope.now);
        return decided.text;
      })
      .immediate(),
  );
}

function projectScope(scope: RequestScope): HookScope {
  const projectDir = scope.projectDir;
  if (projectDir === undefined) {
    throw new Error("a project action needs the project directory its request was guarded on");
  }
  return { ...scope, projectDir };
}

function inSession(
  scope: RequestScope,
  work: (session: SessionScope) => Promise<string>,
): Promise<string> {
  const { config, profile, sessionId, now } = scope;
  return sessionId === undefined ? Promise.resolve("") : work({ config, profile, sessionId, now });
}

function actionReply(
  action: EngineAction,
  scope: RequestScope,
  locationNotice: string | undefined,
): Promise<HookReply> {
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
      return contextOnly(
        inSession(scope, (session) => commandPassedText(session, action.toolInput)),
      );
    case "feedback-receipt":
      return contextOnly(
        inSession(scope, (session) => feedbackReceiptText(session, action.toolInput)),
      );
    case "store-receipt":
      return contextOnly(inSession(scope, storeReceiptText));
    case "stop":
      return contextOnly(inSession(scope, (session) => stopText(session, action.stopHookActive)));
  }
}

function sessionProjectDir(profile: HostProfile, env: NodeJS.ProcessEnv): string | undefined {
  return profile.projectDirEnv === undefined ? undefined : env[profile.projectDirEnv];
}

function passesScopeGuard(request: HookRequest, projectDir: string | undefined): boolean {
  return request.scope === "session" ? request.sessionId !== undefined : projectDir !== undefined;
}

async function performRequest(
  request: HookRequest,
  profile: HostProfile,
  env: NodeJS.ProcessEnv,
): Promise<readonly HookReply[]> {
  const now = new Date().toISOString();
  const projectDir = projectDirectory(sessionProjectDir(profile, env), request.cwd);
  if (!passesScopeGuard(request, projectDir)) {
    return [];
  }
  const config = loadConfig(env);
  const state = storeState(config.dataDir, legacyFacts(profile, env, config.dataDir));
  const notice = storeNotice(state, config.dataDir);
  if (storeMissing(state)) {
    return startsSession(request) ? [{ context: "", notice }] : [];
  }
  if (state.kind === "shared" && request.actions.length > 0) {
    ensureDataDir(config);
  }
  const scope: RequestScope = {
    config: storeConfig(config, state, env),
    profile,
    env,
    projectDir,
    sessionId: request.sessionId,
    now,
  };
  const replies: HookReply[] = [];
  for (const action of request.actions) {
    replies.push(await actionReply(action, scope, notice));
  }
  return replies;
}

async function readHookInput(): Promise<HostInput | undefined> {
  const raw = await readStdin();
  if (raw.trim() === "") {
    return undefined;
  }
  const input = JSON.parse(raw) as HostInput;
  return typeof input.hook_event_name === "string" ? input : undefined;
}

function startsSession(request: HookRequest): boolean {
  return request.actions.some((action) => action.kind === "session-start");
}

function printOutput(output: string | undefined): void {
  if (output !== undefined) {
    console.log(output);
  }
}

function reportHookFailure(
  host: HostId | undefined,
  request: HookRequest | undefined,
  error: unknown,
): void {
  const event = request?.event ?? UNKNOWN_EVENT;
  if (host === undefined) {
    reportFailure(event, error);
    return;
  }
  const outage = storageOutage(error, hostProfile(host).dependencyFix);
  if (outage === undefined) {
    reportFailure(event, error);
    return;
  }
  if (request !== undefined && startsSession(request)) {
    printOutput(hostOutput(host, event, [{ context: "", notice: sessionNotice(outage) }]));
  }
}

async function runHook(): Promise<void> {
  let host: HostId | undefined;
  let request: HookRequest | undefined;
  try {
    const input = await readHookInput();
    if (input === undefined) {
      return;
    }
    host = resolveHost(process.env);
    request = hostRequest(host, input);
    if (request === undefined) {
      return;
    }
    const replies = await performRequest(request, hostProfile(host), process.env);
    printOutput(hostOutput(host, request.event, replies));
  } catch (error) {
    reportHookFailure(host, request, error);
  }
}

if (require.main === module) {
  void runHook();
}
