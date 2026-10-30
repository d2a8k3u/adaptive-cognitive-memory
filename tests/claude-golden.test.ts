import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_FILENAME, DEFAULT_DATA_DIR_SEGMENTS } from "../src/cfg";
import { openDatabase } from "../src/db/database";
import { embedPassage } from "../src/embeddings";
import { resolveProjectId } from "../src/ids";
import { storeNotice, writeMovedMarker } from "../src/storelocation";
import { testModelCacheDir, testModelEnv } from "../vitest.config";
import { type ProcessResult, runProcess, seedConfig } from "./fixtures/seed";

const BASELINE_COMMIT = "e573fbf893b9196ff7ba0ee9937b5d6021b4a529";
const GOLDEN_CACHE = join(
  process.cwd(),
  "node_modules",
  ".cache",
  "adaptive-cognitive-memory",
  "golden-baseline",
);
const BASELINE_ROOT = join(GOLDEN_CACHE, BASELINE_COMMIT);
const BASELINE_HOOKS = join(BASELINE_ROOT, "dist", "hooks.js");
const CURRENT_HOOKS = join(process.cwd(), "dist", "hooks.js");
const HOOK_KILL_MS = 25_000;
const SCENARIO_TIMEOUT_MS = 90_000;
const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
const MARKER_DIGEST = "golden-digest";

const FEEDBACK_TOOL = "mcp__plugin_adaptive-cognitive-memory_memory__memory_feedback";
const STORE_TOOL = "mcp__plugin_adaptive-cognitive-memory_memory__memory_store";
const NEW_SESSION = "golden-new";
const EARLIER_SESSION = "golden-earlier";
const CAPTURE_SESSION = "golden-capture";
const FAILURE_SESSION = "golden-failure";
const REPEAT_SESSION = "golden-repeat";
const STOP_SESSION = "golden-stop";
const QUIET_SESSION = "golden-quiet";
const HIT_PROMPT = "how do we deploy blue green here";
const CAPTURED_COMMAND = "zzgolden build --all";
const CAPTURED_ERROR = "Exit code 2\nbuild failed";
const SERVER_COMMAND = "node server.js";
const MISSING_MODULE_ERROR = "Exit code 1\nError: Cannot find module 'express'";

const PROJECT_DIR = realpathSync(mkdtempSync(join(tmpdir(), "acm-golden-project-")));
execFileSync("git", ["init", "-q", PROJECT_DIR]);
const PROJECT_ID = resolveProjectId(PROJECT_DIR);

interface GoldenMemory {
  readonly id: string;
  readonly type: "semantic" | "procedural";
  readonly kind: "constraint" | "fact" | "procedure";
  readonly anchors: readonly string[];
  readonly title: string;
  readonly abstract: string;
  readonly vector: boolean;
}

const MEMORIES: readonly GoldenMemory[] = [
  {
    id: "01J8GZSQGOLDENPINNED00000A",
    type: "semantic",
    kind: "constraint",
    anchors: [],
    title: "main branch",
    abstract: "never push to the main branch directly, open a pull request",
    vector: false,
  },
  {
    id: "01J8GZSQGOLDENPROMPT00000A",
    type: "procedural",
    kind: "procedure",
    anchors: [],
    title: "deploy steps",
    abstract: "blue green deploy needs the maintenance flag",
    vector: true,
  },
  {
    id: "01J8GZSQGOLDENBASHTOOL000A",
    type: "procedural",
    kind: "procedure",
    anchors: ["zzgolden deploy"],
    title: "zzgolden deploy",
    abstract: "zzgolden deploy needs the staging token exported first",
    vector: false,
  },
  {
    id: "01J8GZSQGOLDENEDITTOOL000A",
    type: "semantic",
    kind: "fact",
    anchors: ["billing/invoice.py"],
    title: "invoice rounding",
    abstract: "invoice totals are rounded half-even in billing/invoice.py",
    vector: false,
  },
  {
    id: "01J8GZSQGOLDENFAILURE0000A",
    type: "procedural",
    kind: "procedure",
    anchors: ["express"],
    title: "express missing",
    abstract: "install express with npm ci before starting the server",
    vector: false,
  },
];

interface Scenario {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly injects: boolean;
}

function sessionStart(sessionId: string, source: string): Record<string, unknown> {
  return { hook_event_name: "SessionStart", cwd: PROJECT_DIR, session_id: sessionId, source };
}

function prompt(text: string): Record<string, unknown> {
  return {
    hook_event_name: "UserPromptSubmit",
    cwd: PROJECT_DIR,
    session_id: NEW_SESSION,
    prompt: text,
  };
}

function preTool(toolName: string, toolInput: Record<string, unknown>): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    cwd: PROJECT_DIR,
    session_id: NEW_SESSION,
    tool_name: toolName,
    tool_input: toolInput,
  };
}

function postTool(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    cwd: PROJECT_DIR,
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: { stdout: "ok", stderr: "", interrupted: false },
  };
}

function failure(
  sessionId: string,
  command: string,
  error: string,
  isInterrupt: boolean,
): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUseFailure",
    cwd: PROJECT_DIR,
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command },
    error,
    is_interrupt: isInterrupt,
  };
}

function stop(sessionId: string, stopHookActive: boolean): Record<string, unknown> {
  return {
    hook_event_name: "Stop",
    cwd: PROJECT_DIR,
    session_id: sessionId,
    stop_hook_active: stopHookActive,
    last_assistant_message: "Done.",
  };
}

const EMPTY_MODEL_DIR = mkdtempSync(join(tmpdir(), "acm-golden-no-model-"));
const MODEL_OFF_ENV = {
  ACM_MODEL_CACHE_DIR: EMPTY_MODEL_DIR,
  CLAUDE_PLUGIN_OPTION_DOWNLOAD_MODEL: "false",
};

const SCENARIOS: readonly Scenario[] = [
  { name: "SessionStart startup", input: sessionStart(NEW_SESSION, "startup"), injects: true },
  { name: "SessionStart resume", input: sessionStart(EARLIER_SESSION, "resume"), injects: true },
  { name: "SessionStart compact", input: sessionStart(EARLIER_SESSION, "compact"), injects: true },
  {
    name: "SessionStart with the model off",
    input: sessionStart(NEW_SESSION, "startup"),
    env: MODEL_OFF_ENV,
    injects: true,
  },
  { name: "UserPromptSubmit hit", input: prompt(HIT_PROMPT), injects: true },
  { name: "UserPromptSubmit short", input: prompt("deploy it"), injects: false },
  {
    name: "UserPromptSubmit slash",
    input: prompt("/memory-doctor check the store please"),
    injects: false,
  },
  {
    name: "UserPromptSubmit degraded",
    input: prompt(HIT_PROMPT),
    env: MODEL_OFF_ENV,
    injects: true,
  },
  {
    name: "PreToolUse Bash",
    input: preTool("Bash", { command: "zzgolden deploy --env staging" }),
    injects: true,
  },
  {
    name: "PreToolUse Edit",
    input: preTool("Edit", {
      file_path: join(PROJECT_DIR, "billing", "invoice.py"),
      old_string: "a",
      new_string: "b",
    }),
    injects: true,
  },
  {
    name: "PreToolUse Read miss",
    input: preTool("Read", { file_path: join(PROJECT_DIR, "docs", "unrelated.md") }),
    injects: false,
  },
  {
    name: "PostToolUse feedback",
    input: postTool(NEW_SESSION, FEEDBACK_TOOL, { not_applicable: [MEMORIES[1]!.id] }),
    injects: false,
  },
  {
    name: "PostToolUse store",
    input: postTool(STOP_SESSION, STORE_TOOL, { title: "lesson" }),
    injects: false,
  },
  {
    name: "PostToolUse Bash pass after a failure",
    input: postTool(CAPTURE_SESSION, "Bash", { command: CAPTURED_COMMAND }),
    injects: false,
  },
  {
    name: "PostToolUseFailure failure",
    input: failure(FAILURE_SESSION, SERVER_COMMAND, MISSING_MODULE_ERROR, false),
    injects: true,
  },
  {
    name: "PostToolUseFailure interrupt",
    input: failure(FAILURE_SESSION, SERVER_COMMAND, MISSING_MODULE_ERROR, true),
    injects: false,
  },
  {
    name: "PostToolUseFailure repeat head",
    input: failure(REPEAT_SESSION, SERVER_COMMAND, MISSING_MODULE_ERROR, false),
    injects: false,
  },
  { name: "Stop open signals", input: stop(STOP_SESSION, false), injects: true },
  { name: "Stop active", input: stop(STOP_SESSION, true), injects: false },
  { name: "Stop none", input: stop(QUIET_SESSION, false), injects: false },
];

const SEED_HISTORY: readonly Record<string, unknown>[] = [
  { ...prompt(HIT_PROMPT), session_id: EARLIER_SESSION },
  failure(CAPTURE_SESSION, CAPTURED_COMMAND, CAPTURED_ERROR, false),
  failure(STOP_SESSION, CAPTURED_COMMAND, CAPTURED_ERROR, false),
  postTool(STOP_SESSION, "Bash", { command: CAPTURED_COMMAND }),
  failure(REPEAT_SESSION, SERVER_COMMAND, MISSING_MODULE_ERROR, false),
];

const SEED_DIR = mkdtempSync(join(tmpdir(), "acm-golden-seed-"));
const EMPTY_STORE_DIR = mkdtempSync(join(tmpdir(), "acm-golden-empty-"));

function extractBaseline(): void {
  const probe = spawnSync("git", ["cat-file", "-e", BASELINE_COMMIT], { cwd: process.cwd() });
  if (probe.error !== undefined) {
    throw probe.error;
  }
  if (probe.status !== 0) {
    throw new Error(
      `baseline commit ${BASELINE_COMMIT} is missing from this clone: check out the full history (actions/checkout with fetch-depth: 0)`,
    );
  }
  rmSync(BASELINE_ROOT, { recursive: true, force: true });
  mkdirSync(BASELINE_ROOT, { recursive: true });
  const archive = execFileSync(
    "git",
    ["archive", BASELINE_COMMIT, "dist", ".claude-plugin", "package.json"],
    { cwd: process.cwd(), maxBuffer: ARCHIVE_MAX_BYTES },
  );
  execFileSync("tar", ["-x", "-C", BASELINE_ROOT], { input: archive });
}

async function seedStore(): Promise<void> {
  const opened = openDatabase(seedConfig(SEED_DIR, testModelCacheDir));
  try {
    const insert = opened.db.prepare(
      `INSERT INTO memories (id, type, kind, anchors, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'project', ?, ?, ?, ?, 0.7, NULL, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
    );
    for (const memory of MEMORIES) {
      insert.run(
        memory.id,
        memory.type,
        memory.kind,
        JSON.stringify(memory.anchors),
        PROJECT_ID,
        memory.title,
        memory.abstract,
        `body of ${memory.title}`,
      );
    }
    const embedded = MEMORIES.filter((memory) => memory.vector);
    const vectors = await embedPassage(
      embedded.map((memory) => `${memory.title} ${memory.abstract}`),
      testModelCacheDir,
    );
    const insertVector = opened.db.prepare(
      "INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id, state) VALUES (?, ?, ?, 'project', ?, 'active')",
    );
    embedded.forEach((memory, index) => {
      insertVector.run(
        memory.id,
        JSON.stringify(Array.from(vectors[index]!)),
        memory.type,
        PROJECT_ID,
      );
    });
  } finally {
    opened.db.close();
  }
}

function settleStore(dir: string): void {
  const opened = openDatabase(seedConfig(dir, testModelCacheDir));
  try {
    opened.db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    opened.db.close();
  }
}

function copyStore(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const file of readdirSync(from).filter((name) => name.startsWith(DB_FILENAME))) {
    copyFileSync(join(from, file), join(to, file));
  }
}

interface EngineHome {
  readonly home: string;
  readonly sharedDataDir: string;
  readonly env: NodeJS.ProcessEnv;
}

function engineHome(scenario: Scenario): EngineHome {
  const home = mkdtempSync(join(tmpdir(), "acm-golden-home-"));
  return {
    home,
    sharedDataDir: join(home, ...DEFAULT_DATA_DIR_SEGMENTS),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "acm-golden-claude-")),
      CLAUDE_PLUGIN_ROOT: process.cwd(),
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
      ...testModelEnv,
      ...scenario.env,
    },
  };
}

function runHook(entry: string, env: NodeJS.ProcessEnv, input: unknown): Promise<ProcessResult> {
  return runProcess({
    command: process.execPath,
    args: [entry],
    env,
    stdinText: JSON.stringify(input),
    timeoutMs: HOOK_KILL_MS,
  });
}

function seededCopy(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  copyStore(SEED_DIR, dir);
  return dir;
}

function baselineRun(home: EngineHome, scenario: Scenario): Promise<ProcessResult> {
  return runHook(
    BASELINE_HOOKS,
    { ...home.env, CLAUDE_PLUGIN_DATA: seededCopy("acm-golden-a-") },
    scenario.input,
  );
}

function expectBaselineShape(baseline: ProcessResult, scenario: Scenario): void {
  const shape = { code: baseline.code, stderr: baseline.stderr, injects: baseline.stdout !== "" };
  expect(shape).toEqual({ code: 0, stderr: "", injects: scenario.injects });
}

beforeAll(async () => {
  extractBaseline();
  await seedStore();
  const seedEnv = {
    ...engineHome({ name: "seed", input: {}, injects: false }).env,
    CLAUDE_PLUGIN_DATA: SEED_DIR,
  };
  for (const input of SEED_HISTORY) {
    const result = await runHook(BASELINE_HOOKS, seedEnv, input);
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  }
  settleStore(SEED_DIR);
  settleStore(EMPTY_STORE_DIR);
}, SCENARIO_TIMEOUT_MS);

afterAll(() => {
  rmSync(GOLDEN_CACHE, { recursive: true, force: true });
});

describe("Claude output after the store move matches the baseline engine (TD-8)", () => {
  it.each(SCENARIOS)(
    "$name",
    async (scenario) => {
      const home = engineHome(scenario);
      const legacyDir = mkdtempSync(join(tmpdir(), "acm-golden-legacy-"));
      copyStore(EMPTY_STORE_DIR, legacyDir);
      copyStore(SEED_DIR, home.sharedDataDir);
      writeMovedMarker(
        legacyDir,
        realpathSync(home.sharedDataDir),
        MARKER_DIGEST,
        new Date().toISOString(),
      );

      const [baseline, current] = await Promise.all([
        baselineRun(home, scenario),
        runHook(CURRENT_HOOKS, { ...home.env, CLAUDE_PLUGIN_DATA: legacyDir }, scenario.input),
      ]);

      expectBaselineShape(baseline, scenario);
      expect(current.stdout).toBe(baseline.stdout);
      expect(current.stderr).toBe(baseline.stderr);
      expect(current.code).toBe(baseline.code);
    },
    SCENARIO_TIMEOUT_MS,
  );
});

interface SessionStartOutput {
  readonly systemMessage?: string;
  readonly hookSpecificOutput: unknown;
}

function withStoreNotice(baselineStdout: string, notice: string | undefined): string {
  const baseline = JSON.parse(baselineStdout) as SessionStartOutput;
  const systemMessage = [notice, baseline.systemMessage]
    .filter((part) => part !== undefined)
    .join("\n");
  return `${JSON.stringify({ systemMessage, hookSpecificOutput: baseline.hookSpecificOutput })}\n`;
}

describe("Claude output before the store move matches the baseline engine, plus the move notice (D-19)", () => {
  it.each(SCENARIOS)(
    "$name",
    async (scenario) => {
      const home = engineHome(scenario);
      const legacyDir = seededCopy("acm-golden-b-");

      const [baseline, current] = await Promise.all([
        baselineRun(home, scenario),
        runHook(CURRENT_HOOKS, { ...home.env, CLAUDE_PLUGIN_DATA: legacyDir }, scenario.input),
      ]);

      expectBaselineShape(baseline, scenario);
      const expectedStdout =
        scenario.input.hook_event_name === "SessionStart"
          ? withStoreNotice(
              baseline.stdout,
              storeNotice({ kind: "legacy", legacyDir }, home.sharedDataDir),
            )
          : baseline.stdout;
      expect(current.stdout).toBe(expectedStdout);
      expect(current.stderr).toBe(baseline.stderr);
      expect(current.code).toBe(baseline.code);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
