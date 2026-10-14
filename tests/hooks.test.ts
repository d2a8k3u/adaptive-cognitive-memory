import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/cfg";
import { type OpenedDb, openDatabase } from "../src/db/database";
import { embedPassage } from "../src/embeddings";
import { resolveProjectId } from "../src/ids";
import { estimateTokens } from "../src/inject";
import { testModelCacheDir } from "../vitest.config";

const CHILD_KILL_MS = 25_000;
const DAY_MS = 86_400_000;
const FEEDBACK_TOOL_NAME = "mcp__plugin_adaptive-cognitive-memory_memory__memory_feedback";
const RECEIPT_TOOL_NAMES = [
  "mcp__plugin_adaptive-cognitive-memory_memory__memory_store",
  "mcp__plugin_adaptive-cognitive-memory_memory__memory_update",
] as const;
const POST_TOOL_MATCHER =
  "Bash|mcp__plugin_adaptive-cognitive-memory_memory__memory_(feedback|store|update)";
const CORRECTION_LINE =
  "If this message corrects how you work, store the rule and the reason with mcp__plugin_adaptive-cognitive-memory_memory__memory_store before continuing.";
const ROUTING_LINE =
  "Native auto memory is also on: store durable lessons with mcp__plugin_adaptive-cognitive-memory_memory__memory_store, not in the auto-memory MEMORY.md.";

interface HookResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface SeededMemory {
  id: string;
  projectId: string;
  scope: "project" | "user";
  type: "semantic" | "episodic" | "procedural" | "pattern";
  title: string;
  abstract: string;
  content: string;
  importance: number;
  vector?: boolean;
  kind?: "constraint" | "preference" | "fact" | "procedure" | "belief";
  anchors?: readonly string[];
}

function hookEntryPath(): string {
  const entry = join(process.cwd(), "dist", "hooks.js");
  if (!existsSync(entry)) {
    throw new Error("dist/hooks.js missing — run npm run build before the hooks suite");
  }
  return entry;
}

function spawnHook(env: NodeJS.ProcessEnv, stdinText: string): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookEntryPath()], { env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdinText);
  });
}

function freshEnv(overrides: Record<string, string> = {}): {
  env: NodeJS.ProcessEnv;
  config: Config;
} {
  const env: NodeJS.ProcessEnv = {
    CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "acm-hooks-")),
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "acm-hooks-claude-")),
    ACM_MODEL_CACHE_DIR: testModelCacheDir,
    ...overrides,
  };
  return { env, config: loadConfig(env) };
}

function injectedContext(result: HookResult, event: string): string {
  const output: unknown = result.stdout === "" ? undefined : JSON.parse(result.stdout);
  expect(output).toEqual({
    hookSpecificOutput: { hookEventName: event, additionalContext: expect.any(String) },
  });
  return (output as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
    .additionalContext;
}

async function seedMemories(config: Config, rows: readonly SeededMemory[]): Promise<void> {
  const opened: OpenedDb = openDatabase(config);
  try {
    const insert = opened.db.prepare(
      `INSERT INTO memories (id, type, kind, anchors, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.type,
        row.kind ?? "fact",
        JSON.stringify(row.anchors ?? []),
        row.scope,
        row.projectId,
        row.title,
        row.abstract,
        row.content,
        row.importance,
      );
    }
    const embeddable = rows.filter((row) => row.vector);
    if (embeddable.length > 0) {
      const vectors = await embedPassage(
        embeddable.map((row) => `${row.title} ${row.abstract}`),
        testModelCacheDir,
      );
      const insertVector = opened.db.prepare(
        "INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id, state) VALUES (?, ?, ?, ?, ?, 'active')",
      );
      embeddable.forEach((row, index) => {
        insertVector.run(
          row.id,
          JSON.stringify(Array.from(vectors[index]!)),
          row.type,
          row.scope,
          row.projectId,
        );
      });
    }
  } finally {
    opened.db.close();
  }
}

interface SignalRow {
  kind: string;
  detail: string;
  closedBy: string | null;
}

function sessionSignals(config: Config, sessionId: string): SignalRow[] {
  const opened = openDatabase(config);
  try {
    return opened.db
      .prepare(
        "SELECT kind, detail, closed_by AS closedBy FROM session_signals WHERE session_id = ? ORDER BY id",
      )
      .all(sessionId) as SignalRow[];
  } finally {
    opened.db.close();
  }
}

interface RecallEventRow {
  sessionId: string | null;
  event: string;
  injected: number;
}

function recallEvents(config: Config): RecallEventRow[] {
  const opened = openDatabase(config);
  try {
    return opened.db
      .prepare("SELECT session_id AS sessionId, event, injected FROM recall_events ORDER BY id")
      .all() as RecallEventRow[];
  } finally {
    opened.db.close();
  }
}

const CWD = realpathSync(mkdtempSync(join(tmpdir(), "acm-hooks-project-")));
const PROJECT_ID = resolveProjectId(CWD);

function promptEvent(sessionId: string, prompt: string): string {
  return JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    cwd: CWD,
    session_id: sessionId,
    prompt,
  });
}

function stopEvent(sessionId: string, stopHookActive: boolean): string {
  return JSON.stringify({
    hook_event_name: "Stop",
    cwd: CWD,
    session_id: sessionId,
    stop_hook_active: stopHookActive,
    last_assistant_message: "Done.",
  });
}

function bashEvent(
  sessionId: string,
  command: string,
  outcome: "passed" | "failed" | "interrupted",
): string {
  const base = {
    cwd: CWD,
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "toolu_capture",
  };
  if (outcome === "passed") {
    return JSON.stringify({
      ...base,
      hook_event_name: "PostToolUse",
      tool_response: { stdout: "4 passed", stderr: "", interrupted: false },
    });
  }
  return JSON.stringify({
    ...base,
    hook_event_name: "PostToolUseFailure",
    error: "Exit code 1\n1 failed",
    is_interrupt: outcome === "interrupted",
  });
}

describe("hooks continuous capture", () => {
  it.each([
    { lang: "en", prompt: "Don't mock the database in the billing tests", detail: "don't" },
    { lang: "cs", prompt: "nedělej to", detail: "nedelej" },
  ])(
    "adds the store line to a human correction in $lang and opens a correction signal",
    async ({ prompt, detail }) => {
      const { env, config } = freshEnv();

      const result = await spawnHook(env, promptEvent("session-cue", prompt));

      expect(result.stderr).toBe("");
      expect(injectedContext(result, "UserPromptSubmit")).toBe(CORRECTION_LINE);
      expect(sessionSignals(config, "session-cue")).toEqual([
        { kind: "correction", detail, closedBy: null },
      ]);
    },
    30_000,
  );

  it.each([
    "[Subagent hand-back] Don't mock the database in the billing tests",
    'Another Claude session sent a message:\n<agent-message from="a1">\nnedělej to\n</agent-message>',
  ])(
    "adds nothing for an agent message carrying the same words: %s",
    async (prompt) => {
      const { env, config } = freshEnv();

      const result = await spawnHook(env, promptEvent("session-handback", prompt));

      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(sessionSignals(config, "session-handback")).toEqual([]);
    },
    30_000,
  );

  it("opens one resolution signal when a command that failed passes later in the session", async () => {
    const { env, config } = freshEnv();
    const command = "pytest -q tests/test_refunds.py";

    const runs = [
      await spawnHook(env, bashEvent("session-fix", command, "failed")),
      await spawnHook(env, bashEvent("session-fix", command, "passed")),
      await spawnHook(env, bashEvent("session-fix", command, "passed")),
      await spawnHook(env, bashEvent("session-other", command, "passed")),
    ];

    for (const run of runs) {
      expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    }
    expect(sessionSignals(config, "session-fix")).toEqual([
      { kind: "resolution", detail: "pytest", closedBy: null },
    ]);
    expect(sessionSignals(config, "session-other")).toEqual([]);
  });

  it("opens a command's resolution once per session, however often it fails and passes again", async () => {
    const { env, config } = freshEnv();
    const command = "npx vitest run tests/refunds.test.ts";

    for (const outcome of ["failed", "passed", "failed", "passed"] as const) {
      await spawnHook(env, bashEvent("session-cycles", command, outcome));
    }

    expect(sessionSignals(config, "session-cycles")).toEqual([
      { kind: "resolution", detail: "vitest run tests/refunds.test.ts", closedBy: null },
    ]);
  });

  it("does not count a background launch as a pass", async () => {
    const { env, config } = freshEnv();
    const command = "npm run build";
    const backgroundLaunch = JSON.stringify({
      hook_event_name: "PostToolUse",
      cwd: CWD,
      session_id: "session-background",
      tool_name: "Bash",
      tool_input: { command, run_in_background: true },
      tool_use_id: "toolu_background",
      tool_response: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "b1" },
    });

    await spawnHook(env, bashEvent("session-background", command, "failed"));
    await spawnHook(env, backgroundLaunch);
    const afterLaunch = sessionSignals(config, "session-background");
    await spawnHook(env, bashEvent("session-background", command, "passed"));

    expect(afterLaunch).toEqual([]);
    expect(sessionSignals(config, "session-background")).toEqual([
      { kind: "resolution", detail: "npm run build", closedBy: null },
    ]);
  });

  it("does not count a command the user interrupted as a failure", async () => {
    const { env, config } = freshEnv();

    await spawnHook(env, bashEvent("session-interrupt", "npm test", "interrupted"));
    await spawnHook(env, bashEvent("session-interrupt", "npm test", "passed"));

    expect(sessionSignals(config, "session-interrupt")).toEqual([]);
  });

  it("returns the checkpoint at the first ordinary stop only, never while a stop hook continues", async () => {
    const { env, config } = freshEnv();
    await spawnHook(env, promptEvent("session-stop", "nedělej to"));

    const continuing = await spawnHook(env, stopEvent("session-stop", true));
    const first = await spawnHook(env, stopEvent("session-stop", false));
    const second = await spawnHook(env, stopEvent("session-stop", false));

    expect(continuing).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(first.stderr).toBe("");
    expect(injectedContext(first, "Stop")).toBe(
      'Memory checkpoint: you were corrected about "nedelej" — store the durable lesson under the memory rules with mcp__plugin_adaptive-cognitive-memory_memory__memory_store, or state that there is none, then finish.',
    );
    expect(second).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(sessionSignals(config, "session-stop")).toEqual([
      { kind: "correction", detail: "nedelej", closedBy: "checkpoint" },
    ]);
  });

  it.each(RECEIPT_TOOL_NAMES)(
    "closes the open signals on a %s receipt so the stop stays silent",
    async (toolName) => {
      const { env, config } = freshEnv();
      await spawnHook(env, promptEvent("session-stored", "nedělej to"));

      const receipt = await spawnHook(
        env,
        JSON.stringify({
          hook_event_name: "PostToolUse",
          cwd: CWD,
          session_id: "session-stored",
          tool_name: toolName,
          tool_input: { id: "01J8GZSQHOOKRECEIPT000AAAA", content: "Never mock the database." },
          tool_response: [{ type: "text", text: '{"id":"01J8GZSQHOOKRECEIPT000AAAA"}' }],
        }),
      );
      const stop = await spawnHook(env, stopEvent("session-stored", false));

      expect(receipt).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(stop).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(sessionSignals(config, "session-stored")).toEqual([
        { kind: "correction", detail: "nedelej", closedBy: "receipt" },
      ]);
    },
  );
});

describe("hooks session-start", () => {
  it("injects top abstracts only, never memory bodies", async () => {
    const { env, config } = freshEnv();
    await seedMemories(config, [
      {
        id: "01J8GZSQHOOK0000000000AAAA",
        projectId: PROJECT_ID,
        scope: "project",
        type: "semantic",
        kind: "constraint",
        title: "deploys",
        abstract: "run deploys through the blue pipeline",
        content: "BODY-MARKER-7f3a the full deploy runbook with every step spelled out",
        importance: 0.9,
      },
      {
        id: "01J8GZSQHOOK0000000000BBBB",
        projectId: PROJECT_ID,
        scope: "user",
        type: "pattern",
        kind: "preference",
        title: "preference",
        abstract: "prefer trunk based development",
        content: "BODY-MARKER-9c21 the whole reasoning behind the preference",
        importance: 0.4,
      },
    ]);

    const result = await spawnHook(
      env,
      JSON.stringify({ hook_event_name: "SessionStart", cwd: CWD }),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const context = injectedContext(result, "SessionStart");
    expect(context).toContain("run deploys through the blue pipeline");
    expect(context).toContain("prefer trunk based development");
    expect(context).toContain("01J8GZSQ");
    expect(context).not.toContain("BODY-MARKER");
  });

  it("fills the budget from the session cap, not the default 10 rows", async () => {
    const { env, config } = freshEnv();
    const rows: SeededMemory[] = [];
    for (let i = 0; i < 40; i += 1) {
      rows.push({
        id: `01J8GZSQHOOKSESS${String(i).padStart(4, "0")}AAAAA`,
        projectId: PROJECT_ID,
        scope: "user",
        type: "semantic",
        kind: "preference",
        title: `fact ${i}`,
        abstract: `compact fact ${i}`,
        content: "BODY-MARKER-5d11 unused body",
        importance: 0.5,
      });
    }
    await seedMemories(config, rows);

    const result = await spawnHook(
      env,
      JSON.stringify({ hook_event_name: "SessionStart", cwd: CWD }),
    );

    expect(result.code).toBe(0);
    expect(injectedContext(result, "SessionStart")).toContain("compact fact 39");
  });

  it("injects only the constraints and preferences visible to the project on startup", async () => {
    const { env, config } = freshEnv();
    const seeded = (id: string, kind: SeededMemory["kind"], projectId = PROJECT_ID) => ({
      id,
      projectId,
      scope: "project" as const,
      type: "semantic" as const,
      kind,
      title: `${kind} ${id}`,
      abstract: `startup ${kind} abstract`,
      content: "BODY-MARKER-2e85 body",
      importance: 0.5,
    });
    await seedMemories(config, [
      seeded("01J8GZSQHOOKPIN0CONSTRAINT", "constraint"),
      { ...seeded("01J8GZSQHOOKPIN0PREFERENCE", "preference"), scope: "user" },
      seeded("01J8GZSQHOOKPIN000000FACT", "fact"),
      seeded("01J8GZSQHOOKPIN0PROCEDURE", "procedure"),
      seeded("01J8GZSQHOOKPIN00FOREIGN", "constraint", "proj-someone-else"),
    ]);

    const result = await spawnHook(
      env,
      JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: CWD }),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const injected = (injectedContext(result, "SessionStart").match(/01J8GZSQHOOKPIN\w+/g) ?? [])
      .slice()
      .sort();
    expect(injected).toEqual(["01J8GZSQHOOKPIN0CONSTRAINT", "01J8GZSQHOOKPIN0PREFERENCE"]);
  });

  it.each(["compact", "resume"])(
    "re-injects the rows injected earlier in the session when it restarts from %s",
    async (source) => {
      const { env, config } = freshEnv();
      const fact = (id: string, abstract: string): SeededMemory => ({
        id,
        projectId: PROJECT_ID,
        scope: "project",
        type: "semantic",
        title: `restart fact ${id}`,
        abstract,
        content: "BODY-MARKER-0a61 body",
        importance: 0.5,
      });
      await seedMemories(config, [
        fact("01J8GZSQHOOKSOURCE0EARLIER", "the deploy freeze holds until friday"),
        fact("01J8GZSQHOOKSOURCE00UNSEEN", "the cache warms up on boot"),
      ]);
      const opened = openDatabase(config);
      try {
        opened.db
          .prepare(
            "INSERT INTO injections (session_id, memory_id, event, at) VALUES (?, ?, 'UserPromptSubmit', ?)",
          )
          .run("session-restart", "01J8GZSQHOOKSOURCE0EARLIER", "2026-10-14T09:00:00.000Z");
      } finally {
        opened.db.close();
      }

      const result = await spawnHook(
        env,
        JSON.stringify({
          hook_event_name: "SessionStart",
          source,
          cwd: CWD,
          session_id: "session-restart",
        }),
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const context = injectedContext(result, "SessionStart");
      expect(context).toContain("01J8GZSQHOOKSOURCE0EARLIER");
      expect(context).not.toContain("01J8GZSQHOOKSOURCE00UNSEEN");
    },
  );
});

describe("hooks user-prompt-submit", () => {
  it("recalls matching abstracts within the 1200-token budget", async () => {
    const { env, config } = freshEnv();
    await seedMemories(config, [
      {
        id: "01J8GZSQHOOKPROMPT00000000AAAA",
        projectId: PROJECT_ID,
        scope: "project",
        type: "procedural",
        title: "deploy steps",
        abstract: "blue green deploy needs the maintenance flag",
        content: "BODY-MARKER-2b44 full runbook body",
        importance: 0.7,
        vector: true,
      },
    ]);

    const result = await spawnHook(
      env,
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        cwd: CWD,
        prompt: "how do we deploy blue green here",
      }),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const context = injectedContext(result, "UserPromptSubmit");
    expect(context).toContain("blue green deploy needs the maintenance flag");
    expect(context).not.toContain("BODY-MARKER");
    expect(estimateTokens(context)).toBeLessThanOrEqual(1200);
  }, 30_000);

  it.each(["ok", "díky"])(
    "injects nothing for the acknowledgement %s",
    async (prompt) => {
      const { env, config } = freshEnv();
      await seedMemories(config, [
        {
          id: "01J8GZSQHOOKPROMPTACK00AAAA",
          projectId: PROJECT_ID,
          scope: "project",
          type: "semantic",
          title: "deploy steps",
          abstract: "blue green deploy needs the maintenance flag",
          content: "BODY-MARKER-2c51 full runbook body",
          importance: 0.9,
          vector: true,
        },
      ]);

      const result = await spawnHook(
        env,
        JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: CWD, prompt }),
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");
    },
    30_000,
  );

  it("stays silent on an empty prompt", async () => {
    const { env, config } = freshEnv();
    await seedMemories(config, [
      {
        id: "01J8GZSQHOOKPROMPT00000000BBBB",
        projectId: PROJECT_ID,
        scope: "project",
        type: "semantic",
        title: "anything",
        abstract: "whatever abstract exists",
        content: "BODY-MARKER-6e07 body",
        importance: 0.9,
        vector: true,
      },
    ]);

    const result = await spawnHook(
      env,
      JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: CWD, prompt: "   " }),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("hooks pre-tool-use", () => {
  it("injects the procedure anchored on the command head within the 300-token budget", async () => {
    const { env, config } = freshEnv();
    await seedMemories(config, [
      {
        id: "01J8GZSQHOOKTOOL00000000AAAA",
        projectId: PROJECT_ID,
        scope: "project",
        type: "procedural",
        kind: "procedure",
        anchors: ["pytest", "tests/conftest.py"],
        title: "test runner",
        abstract: "Run the suite with uv run pytest -q from the repository root",
        content: "BODY-MARKER-8f02 body of the test runbook",
        importance: 0.6,
      },
    ]);

    const result = await spawnHook(
      env,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: CWD,
        session_id: "session-pretool",
        tool_name: "Bash",
        tool_input: { command: "pytest -q tests/test_invoices.py -k refund --maxfail=1" },
      }),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const context = injectedContext(result, "PreToolUse");
    expect(context).toContain("Run the suite with uv run pytest -q from the repository root");
    expect(context).not.toContain("BODY-MARKER");
    expect(estimateTokens(context)).toBeLessThanOrEqual(300);
  });
});

const RECALL_GATED_SEEDS: readonly SeededMemory[] = [
  {
    id: "01J8GZSQHOOKGATED0CONSTRNT",
    projectId: PROJECT_ID,
    scope: "project",
    type: "semantic",
    kind: "constraint",
    title: "release branch",
    abstract: "release only from the main branch",
    content: "BODY-MARKER-1c40 body",
    importance: 0.5,
  },
  {
    id: "01J8GZSQHOOKGATED0PROCEDUR",
    projectId: PROJECT_ID,
    scope: "project",
    type: "procedural",
    kind: "procedure",
    anchors: ["pytest"],
    title: "test runner",
    abstract: "run pytest with -q from the repository root",
    content: "BODY-MARKER-1c41 body",
    importance: 0.5,
  },
];

describe("hooks recall events", () => {
  it("records one event per recall hook run with the rows it injected, rejected prompts and session-less runs included", async () => {
    const { env, config } = freshEnv();
    await seedMemories(config, RECALL_GATED_SEEDS);

    for (const input of [
      {
        hook_event_name: "SessionStart",
        source: "startup",
        cwd: CWD,
        session_id: "session-events",
      },
      { hook_event_name: "UserPromptSubmit", cwd: CWD, session_id: "session-events", prompt: "ok" },
      {
        hook_event_name: "PreToolUse",
        cwd: CWD,
        session_id: "session-events",
        tool_name: "Bash",
        tool_input: { command: "pytest -q" },
      },
      { hook_event_name: "PreToolUse", cwd: CWD, tool_name: "Bash", tool_input: { command: "ls" } },
    ]) {
      expect((await spawnHook(env, JSON.stringify(input))).stderr).toBe("");
    }

    expect(recallEvents(config)).toEqual([
      { sessionId: "session-events", event: "SessionStart", injected: 1 },
      { sessionId: "session-events", event: "UserPromptSubmit", injected: 0 },
      { sessionId: "session-events", event: "PreToolUse", injected: 1 },
      { sessionId: null, event: "PreToolUse", injected: 0 },
    ]);
  });

  it("prunes recall events to the newest 10,000 and drops session history older than 30 days at session start", async () => {
    const { env, config } = freshEnv();
    const longAgo = new Date(Date.now() - 60 * DAY_MS).toISOString();
    const opened = openDatabase(config);
    try {
      const insertEvent = opened.db.prepare(
        "INSERT INTO recall_events (session_id, event, at, injected) VALUES ('session-old', 'UserPromptSubmit', ?, 0)",
      );
      opened.db.transaction(() => {
        for (let index = 0; index < 10_000; index += 1) {
          insertEvent.run(longAgo);
        }
      })();
      const insertSignal = opened.db.prepare(
        "INSERT INTO session_signals (session_id, kind, detail, opened_at, closed_at, closed_by) VALUES ('session-old', 'remember', ?, ?, ?, ?)",
      );
      insertSignal.run("closed long ago", longAgo, longAgo, "checkpoint");
      insertSignal.run("still open", longAgo, null, null);
      opened.db
        .prepare(
          "INSERT INTO command_failures (session_id, head, failed_at) VALUES ('session-old', 'pytest', ?)",
        )
        .run(longAgo);
    } finally {
      opened.db.close();
    }

    const result = await spawnHook(
      env,
      JSON.stringify({ hook_event_name: "SessionStart", cwd: CWD, session_id: "session-new" }),
    );

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    const reopened = openDatabase(config);
    try {
      expect(
        reopened.db.prepare("SELECT count(*) AS n, min(id) AS oldest FROM recall_events").get(),
      ).toEqual({ n: 10_000, oldest: 2 });
      expect(
        reopened.db.prepare("SELECT session_id FROM recall_events ORDER BY id DESC LIMIT 1").get(),
      ).toEqual({ session_id: "session-new" });
      expect(reopened.db.prepare("SELECT detail FROM session_signals").all()).toEqual([
        { detail: "still open" },
      ]);
      expect(reopened.db.prepare("SELECT head FROM command_failures").all()).toEqual([]);
    } finally {
      reopened.db.close();
    }
  });
});

describe("hooks auto memory routing", () => {
  it.each([
    { source: "startup", autoMemoryEnabled: undefined, routed: true },
    { source: "compact", autoMemoryEnabled: undefined, routed: true },
    { source: "resume", autoMemoryEnabled: undefined, routed: false },
    { source: "startup", autoMemoryEnabled: false, routed: false },
  ])(
    "routes durable lessons to memory_store on $source with autoMemoryEnabled $autoMemoryEnabled: $routed",
    async ({ source, autoMemoryEnabled, routed }) => {
      const project = realpathSync(mkdtempSync(join(tmpdir(), "acm-hooks-routing-")));
      if (autoMemoryEnabled !== undefined) {
        mkdirSync(join(project, ".claude"));
        writeFileSync(
          join(project, ".claude", "settings.json"),
          JSON.stringify({ autoMemoryEnabled }),
        );
      }
      const { env } = freshEnv();

      const result = await spawnHook(
        env,
        JSON.stringify({ hook_event_name: "SessionStart", source, cwd: project }),
      );

      expect(result.stderr).toBe("");
      expect(result.stdout === "" ? "" : injectedContext(result, "SessionStart")).toBe(
        routed ? ROUTING_LINE : "",
      );
    },
  );
});

describe("hooks recall switch", () => {
  it("injects no memories for a project whose recall is off, while the routing and capture lines stay", async () => {
    const { env, config } = freshEnv();
    await seedMemories(config, RECALL_GATED_SEEDS);
    const opened = openDatabase(config);
    try {
      opened.db
        .prepare(
          "INSERT INTO project_settings (project_id, recall_enabled, updated_at) VALUES (?, 0, '2026-10-14T00:00:00.000Z')",
        )
        .run(PROJECT_ID);
    } finally {
      opened.db.close();
    }

    const sessionStart = await spawnHook(
      env,
      JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: CWD }),
    );
    const preTool = await spawnHook(
      env,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: CWD,
        tool_name: "Bash",
        tool_input: { command: "pytest -q" },
      }),
    );
    const correction = await spawnHook(
      env,
      promptEvent("session-switch", "Don't release from a feature branch with pytest skipped"),
    );

    expect(sessionStart.stderr).toBe("");
    expect(injectedContext(sessionStart, "SessionStart")).toBe(ROUTING_LINE);
    expect(preTool).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(correction.stderr).toBe("");
    expect(injectedContext(correction, "UserPromptSubmit")).toBe(CORRECTION_LINE);
    expect(recallEvents(config)).toEqual([]);
  }, 30_000);
});

describe("hooks session dedup", () => {
  it("does not re-inject a memory into the session that already received it", async () => {
    const { env, config } = freshEnv();
    const memoryId = "01J8GZSQHOOKDEDUP0000000AAAA";
    await seedMemories(config, [
      {
        id: memoryId,
        projectId: PROJECT_ID,
        scope: "project",
        type: "procedural",
        kind: "procedure",
        title: "deploy steps",
        abstract: "blue green deploy needs the maintenance flag",
        content: "BODY-MARKER-7d10 full runbook body",
        importance: 0.7,
        vector: true,
      },
    ]);
    const promptIn = (sessionId: string) =>
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        cwd: CWD,
        session_id: sessionId,
        prompt: "blue green deploy needs the maintenance flag",
      });

    const first = await spawnHook(env, promptIn("session-one"));
    const second = await spawnHook(env, promptIn("session-one"));
    const otherSession = await spawnHook(env, promptIn("session-two"));

    expect(injectedContext(first, "UserPromptSubmit")).toContain(memoryId);
    expect(second.code).toBe(0);
    expect(second.stderr).toBe("");
    expect(second.stdout).toBe("");
    expect(injectedContext(otherSession, "UserPromptSubmit")).toContain(memoryId);
  }, 60_000);

  it("offers a memory again once a later session start left it out of the context", async () => {
    const { env, config } = freshEnv();
    const droppedId = "01J8GZSQHOOKDEDUP0000000CCCC";
    const carriedId = "01J8GZSQHOOKDEDUP0000000DDDD";
    const procedure = (id: string, abstract: string): SeededMemory => ({
      id,
      projectId: PROJECT_ID,
      scope: "project",
      type: "procedural",
      kind: "procedure",
      title: "deploy steps",
      abstract,
      content: "BODY-MARKER-7d12 full runbook body",
      importance: 0.7,
      vector: id === droppedId,
    });
    await seedMemories(config, [
      procedure(droppedId, "blue green deploy needs the maintenance flag"),
      procedure(carriedId, "rollbacks restore the previous image tag"),
    ]);
    const opened = openDatabase(config);
    try {
      const inject = opened.db.prepare(
        "INSERT INTO injections (session_id, memory_id, event, at) VALUES ('session-four', ?, ?, ?)",
      );
      inject.run(droppedId, "UserPromptSubmit", "2026-10-13T09:00:00.000Z");
      inject.run(carriedId, "SessionStart", "2026-10-13T09:30:00.000Z");
    } finally {
      opened.db.close();
    }

    const prompt = await spawnHook(
      env,
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        cwd: CWD,
        session_id: "session-four",
        prompt: "blue green deploy needs the maintenance flag",
      }),
    );

    expect(prompt.stderr).toBe("");
    expect(injectedContext(prompt, "UserPromptSubmit")).toContain(droppedId);
  }, 60_000);

  it.each([
    { kind: "constraint", atSessionStart: true, atPrompt: false },
    { kind: "procedure", atSessionStart: false, atPrompt: true },
  ] as const)(
    "delivers a $kind once per session: at session start $atSessionStart, at the matching prompt $atPrompt",
    async ({ kind, atSessionStart, atPrompt }) => {
      const { env, config } = freshEnv();
      const memoryId = "01J8GZSQHOOKDEDUP0000000BBBB";
      await seedMemories(config, [
        {
          id: memoryId,
          projectId: PROJECT_ID,
          scope: "project",
          type: "procedural",
          kind,
          title: "deploy steps",
          abstract: "blue green deploy needs the maintenance flag",
          content: "BODY-MARKER-7d11 full runbook body",
          importance: 0.7,
          vector: true,
        },
      ]);

      const sessionStart = await spawnHook(
        env,
        JSON.stringify({ hook_event_name: "SessionStart", cwd: CWD, session_id: "session-three" }),
      );
      const prompt = await spawnHook(
        env,
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          cwd: CWD,
          session_id: "session-three",
          prompt: "blue green deploy needs the maintenance flag",
        }),
      );

      expect(sessionStart.stdout.includes(memoryId)).toBe(atSessionStart);
      expect(prompt.stderr).toBe("");
      expect(prompt.stdout.includes(memoryId)).toBe(atPrompt);
    },
    60_000,
  );
});

describe("hooks feedback receipt", () => {
  it("records the session's first receipt silently and demotes what it left unused", async () => {
    const { env, config } = freshEnv();
    const memoryId = "01J8GZSQHOOKRECEIPT000AAAA";
    await seedMemories(config, [
      {
        id: memoryId,
        projectId: PROJECT_ID,
        scope: "project",
        type: "pattern",
        kind: "constraint",
        title: "release freeze",
        abstract: "no deploys on fridays",
        content: "BODY-MARKER-1c40 body",
        importance: 0.5,
      },
    ]);
    const opened = openDatabase(config);
    try {
      const injected = opened.db.prepare(
        "INSERT INTO injections (session_id, memory_id, event, at) VALUES (?, ?, 'SessionStart', ?)",
      );
      const receipted = opened.db.prepare(
        "INSERT INTO receipt_sessions (session_id, first_at) VALUES (?, ?)",
      );
      for (let session = 1; session <= 5; session += 1) {
        const at = `2026-10-14T10:0${session}:00.000Z`;
        injected.run(`session-receipt-${session}`, memoryId, at);
        if (session < 5) {
          receipted.run(`session-receipt-${session}`, at);
        }
      }
    } finally {
      opened.db.close();
    }

    const result = await spawnHook(
      env,
      JSON.stringify({
        hook_event_name: "PostToolUse",
        cwd: CWD,
        session_id: "session-receipt-5",
        tool_name: FEEDBACK_TOOL_NAME,
        tool_input: { ids: ["01J8GZSQHOOKOTHER00000AAAA"], verdict: "used" },
        tool_response: { memories: [] },
      }),
    );

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    const reopened = openDatabase(config);
    try {
      expect(reopened.db.prepare("SELECT state FROM memories WHERE id = ?").get(memoryId)).toEqual({
        state: "hypothesis",
      });
    } finally {
      reopened.db.close();
    }
  });
});

describe("hooks project identity", () => {
  const repo = { root: "", nested: "", outside: "" };

  beforeAll(() => {
    repo.root = realpathSync(mkdtempSync(join(tmpdir(), "acm-hooks-repo-")));
    repo.nested = join(repo.root, "src", "app");
    mkdirSync(repo.nested, { recursive: true });
    execFileSync("git", ["init", "-q", repo.root], { stdio: "ignore" });
    repo.outside = realpathSync(mkdtempSync(join(tmpdir(), "acm-hooks-outside-")));
  });

  it.each([
    { name: "a nested directory named as the project dir", cwd: "nested", projectDir: "nested" },
    { name: "a project dir that differs from the event cwd", cwd: "outside", projectDir: "root" },
    { name: "an empty project dir, falling back to the event cwd", cwd: "nested", projectDir: "" },
  ] as const)("injects repository root memories for $name", async ({ cwd, projectDir }) => {
    const projectDirPath = projectDir === "" ? "" : repo[projectDir];
    const { env, config } = freshEnv({
      PATH: process.env.PATH ?? "",
      CLAUDE_PROJECT_DIR: projectDirPath,
    });
    const memoryId = "01J8GZSQHOOKIDENTITY000AAAA";
    await seedMemories(config, [
      {
        id: memoryId,
        projectId: resolveProjectId(repo.root),
        scope: "project",
        type: "semantic",
        kind: "constraint",
        title: "repository fact",
        abstract: "the repository root owns this release checklist",
        content: "BODY-MARKER-5e19 body",
        importance: 0.9,
      },
    ]);

    const result = await spawnHook(
      env,
      JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: repo[cwd] }),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(injectedContext(result, "SessionStart")).toContain(memoryId);
  });
});

describe("hooks budgets", () => {
  it("trims a large session-start injection to the 1200-token budget", async () => {
    const { env, config } = freshEnv();
    const rows: SeededMemory[] = [];
    for (let i = 0; i < 40; i += 1) {
      rows.push({
        id: `01J8GZSQHOOKBUDG${String(i).padStart(4, "0")}AAAAA`,
        projectId: PROJECT_ID,
        scope: "user",
        type: "pattern",
        kind: "preference",
        title: `budget ${i}`,
        abstract: `${"long abstract ".repeat(14)}${i}`,
        content: "BODY-MARKER-4a90 unused body",
        importance: 0.5,
      });
    }
    await seedMemories(config, rows);

    const result = await spawnHook(
      env,
      JSON.stringify({ hook_event_name: "SessionStart", cwd: CWD }),
    );

    expect(result.code).toBe(0);
    const context = injectedContext(result, "SessionStart");
    expect(context.split("\n").length).toBeLessThan(rows.length);
    expect(estimateTokens(context)).toBeLessThanOrEqual(1200);
  });
});

describe("hooks empty database (AC-13)", () => {
  it("exits 0 with zero output on every recall event", async () => {
    const { env } = freshEnv();

    const sessionStart = await spawnHook(
      env,
      JSON.stringify({ hook_event_name: "SessionStart", cwd: CWD }),
    );
    const promptSubmit = await spawnHook(
      env,
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        cwd: CWD,
        prompt: "anything at all",
      }),
    );
    const preTool = await spawnHook(
      env,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: CWD,
        tool_name: "Bash",
        tool_input: { command: "git status" },
      }),
    );

    for (const result of [sessionStart, promptSubmit, preTool]) {
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
  }, 30_000);
});

describe("hooks internal error contract", () => {
  it("exits 0 with no stdout and one class-only stderr line when the db cannot open", async () => {
    const { env, config } = freshEnv();
    writeFileSync(join(config.pluginData, "blocker"), "not a directory");
    const blockedEnv: NodeJS.ProcessEnv = {
      ...env,
      ACM_DB_PATH: join(config.pluginData, "blocker", "memory.sqlite"),
    };

    const result = await spawnHook(
      blockedEnv,
      JSON.stringify({ hook_event_name: "SessionStart", cwd: CWD }),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    const stderrLines = result.stderr.split("\n").filter((line) => line !== "");
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toBe("memory hook SessionStart failed: SqliteError — no injection");
  });
});

describe("hooks storage outage", () => {
  const dlopenFailure = join(process.cwd(), "tests", "fixtures", "dlopen-fail.cjs");
  const missingDependency = join(process.cwd(), "tests", "fixtures", "missing-dependency.cjs");

  function newerSchemaEnv(): NodeJS.ProcessEnv {
    const { env, config } = freshEnv();
    openDatabase(config).db.close();
    const opened = openDatabase(config);
    try {
      opened.db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    } finally {
      opened.db.close();
    }
    return env;
  }

  it.each([
    {
      name: "a native module that fails to load at session start",
      env: () => ({ ...freshEnv().env, NODE_OPTIONS: `--require ${dlopenFailure}` }),
      event: "SessionStart",
      notice: [/better-sqlite3 failed to load/, /NODE_MODULE_VERSION 115/, /Fix: run npm rebuild/],
    },
    {
      name: "npm dependencies that were never installed at session start",
      env: () => ({ ...freshEnv().env, NODE_OPTIONS: `--require ${missingDependency}` }),
      event: "SessionStart",
      notice: [
        /npm dependencies are not installed \(missing better-sqlite3\)/,
        /claude plugin update adaptive-cognitive-memory@adaptive-cognitive-memory/,
        /npm ci --ignore-scripts/,
      ],
    },
    {
      name: "npm dependencies that were never installed on a prompt",
      env: () => ({ ...freshEnv().env, NODE_OPTIONS: `--require ${missingDependency}` }),
      event: "UserPromptSubmit",
      notice: [],
    },
    {
      name: "a native module that fails to load on a prompt",
      env: () => ({ ...freshEnv().env, NODE_OPTIONS: `--require ${dlopenFailure}` }),
      event: "UserPromptSubmit",
      notice: [],
    },
    {
      name: "a database written by a newer schema at session start",
      env: newerSchemaEnv,
      event: "SessionStart",
      notice: [/database schema 99/, /Fix: update the plugin/],
    },
  ])("exits 0 on $name, telling only session start", async ({ env, event, notice }) => {
    const result = await spawnHook(
      env(),
      JSON.stringify({
        hook_event_name: event,
        source: "startup",
        cwd: CWD,
        session_id: "session-outage",
        prompt: "how do we deploy the billing service",
      }),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    if (notice.length === 0) {
      expect(result.stdout).toBe("");
      return;
    }
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(output)).toEqual(["systemMessage"]);
    for (const pattern of notice) {
      expect(output.systemMessage).toMatch(pattern);
    }
  });
});

describe("hooks defensive stdin", () => {
  it.each([
    {
      name: "unparseable json reports one syntaxerror line",
      stdinText: "not json {",
      stdout: "",
      stderrPattern: /^memory hook unknown failed: SyntaxError — no injection$/,
    },
    {
      name: "empty stdin is a silent no-op",
      stdinText: "",
      stdout: "",
      stderrPattern: null,
    },
    {
      name: "unknown event is a silent no-op",
      stdinText: JSON.stringify({ hook_event_name: "Notification", cwd: CWD }),
      stdout: "",
      stderrPattern: null,
    },
    {
      name: "pre-compact has no context channel and stays silent",
      stdinText: JSON.stringify({ hook_event_name: "PreCompact", trigger: "auto", cwd: CWD }),
      stdout: "",
      stderrPattern: null,
    },
    {
      name: "missing cwd is a silent no-op",
      stdinText: JSON.stringify({ hook_event_name: "SessionStart" }),
      stdout: "",
      stderrPattern: null,
    },
  ])("$name", async ({ stdinText, stdout, stderrPattern }) => {
    const { env } = freshEnv();

    const result = await spawnHook(env, stdinText);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(stdout);
    if (stderrPattern === null) {
      expect(result.stderr).toBe("");
    } else {
      expect(result.stderr.trimEnd()).toMatch(stderrPattern);
    }
  });
});

describe("hooks offline run (0 LLM)", () => {
  it("serves every event without a single fetch attempt", async () => {
    const { env, config } = freshEnv();
    await seedMemories(config, [
      {
        id: "01J8GZSQHOOKOFFLINE0000000AAAA",
        projectId: PROJECT_ID,
        scope: "project",
        type: "procedural",
        kind: "constraint",
        anchors: ["zzqnet"],
        title: "offline fact",
        abstract: "bash offline zzqnet drill works without any network",
        content: "BODY-MARKER-3d77 body",
        importance: 0.8,
        vector: true,
      },
    ]);
    const scratch = mkdtempSync(join(tmpdir(), "acm-hooks-net-"));
    const markerPath = join(scratch, "net-marker");
    const noNetModule = join(scratch, "no-net.cjs");
    writeFileSync(
      noNetModule,
      [
        'const fs = require("node:fs");',
        "globalThis.fetch = function fetchStub() {",
        '  fs.writeFileSync(process.env.ACM_NET_MARKER, "fetch attempted");',
        '  throw new Error("network attempted");',
        "};",
      ].join("\n"),
    );
    const offlineEnv: NodeJS.ProcessEnv = {
      ...env,
      NODE_OPTIONS: `--require ${noNetModule}`,
      ACM_NET_MARKER: markerPath,
    };

    const sessionStart = await spawnHook(
      offlineEnv,
      JSON.stringify({ hook_event_name: "SessionStart", cwd: CWD }),
    );
    const promptSubmit = await spawnHook(
      offlineEnv,
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        cwd: CWD,
        prompt: "offline zzqnet drill",
      }),
    );
    const preTool = await spawnHook(
      offlineEnv,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: CWD,
        tool_name: "Bash",
        tool_input: { command: "zzqnet drill --offline" },
      }),
    );

    expect(sessionStart.code).toBe(0);
    expect(injectedContext(sessionStart, "SessionStart")).toContain(
      "offline zzqnet drill works without any network",
    );
    expect(promptSubmit.code).toBe(0);
    expect(promptSubmit.stdout).not.toBe("");
    expect(preTool.code).toBe(0);
    expect(preTool.stdout).not.toBe("");
    expect(existsSync(markerPath)).toBe(false);
  }, 60_000);
});

describe("hooks import graph", () => {
  it("keeps search and embeddings out of the hooks static require graph", () => {
    const content = readFileSync(hookEntryPath(), "utf8");

    expect(/require\(\s*['"]\.\/(?:search|embeddings)\.js['"]\)/.test(content)).toBe(false);
    expect(/import\(\s*['"]\.\/search\.js['"]\)/.test(content)).toBe(true);
    expect(content).not.toContain("transformers");
  });
});

describe("hooks.json contract", () => {
  it("registers the recall, receipt and capture events on the plugin hook entry with their matchers", () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<
        string,
        { matcher?: string; hooks: { type: string; command: string; timeout: number }[] }[]
      >;
    };

    expect(Object.keys(config.hooks).sort()).toEqual([
      "PostToolUse",
      "PostToolUseFailure",
      "PreToolUse",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    for (const group of config.hooks.PreToolUse ?? []) {
      expect(group.matcher).toBe("Bash|Edit|Write");
    }
    expect(config.hooks.PostToolUse?.map((group) => group.matcher)).toEqual([POST_TOOL_MATCHER]);
    expect(config.hooks.PostToolUseFailure?.map((group) => group.matcher)).toEqual(["Bash"]);
    for (const event of ["SessionStart", "Stop"]) {
      for (const group of config.hooks[event] ?? []) {
        expect(group.matcher, event).toBeUndefined();
      }
    }
    for (const groups of Object.values(config.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.type).toBe("command");
          expect(hook.command).toBe('node "$CLAUDE_PLUGIN_ROOT/dist/hooks.js"');
          expect(hook.timeout).toBeGreaterThanOrEqual(5);
        }
      }
    }
  });
});
