import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DB_FILENAME, loadConfig } from "../src/cfg";
import { type Db, openDatabase } from "../src/db/database";
import { resolveProjectId } from "../src/ids";
import { estimateTokens } from "../src/inject";
import { testModelCacheDir } from "../vitest.config";
import { FAKE_SECRETS } from "./fixtures/secrets";
import { type ProcessResult, runProcess } from "./fixtures/seed";

const HOOK_KILL_MS = 25_000;
const DAY_MS = 86_400_000;
const PROJECT_DIR = realpathSync(mkdtempSync(join(tmpdir(), "acm-failure-project-")));
const OTHER_PROJECT_DIR = realpathSync(mkdtempSync(join(tmpdir(), "acm-failure-other-")));
const PROJECT_ID = resolveProjectId(PROJECT_DIR);
const OTHER_PROJECT_ID = resolveProjectId(OTHER_PROJECT_DIR);
const ABSTAINED: ProcessResult = { code: 0, stdout: "", stderr: "" };
const SMALLEST_BUDGET_TOKENS = 100;
const CONCURRENT_FAILURES = 8;
const MISSING_MODULE_ERROR = "Exit code 1\nError: Cannot find module 'express'";
const MISSING_MODULE_ROW = "01J8GZSQFAIL0000000EXPRESS";
const CONCURRENT_CODES = [
  "ENOENT",
  "EACCES",
  "EPERM",
  "EEXIST",
  "EISDIR",
  "ENOTDIR",
  "EMFILE",
  "ECONNRESET",
] as const;

interface FailureRow {
  readonly id: string;
  readonly anchors?: readonly string[];
  readonly conflictKey?: string;
  readonly keywords?: string;
  readonly projectId?: string;
  readonly abstract?: string;
}

interface FailureEvent {
  readonly sessionId: string;
  readonly command: string;
  readonly error?: unknown;
  readonly isInterrupt?: boolean;
  readonly cwd?: string;
}

interface RecallEventRow {
  readonly event: string;
  readonly injected: number;
}

function hookEntryPath(): string {
  const entry = join(process.cwd(), "dist", "hooks.js");
  if (!existsSync(entry)) {
    throw new Error("dist/hooks.js missing — run npm run build before the failure recall suite");
  }
  return entry;
}

function freshEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "acm-failure-")),
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "acm-failure-claude-")),
    ACM_MODEL_CACHE_DIR: testModelCacheDir,
    ...overrides,
  };
}

function withDb<T>(env: NodeJS.ProcessEnv, read: (db: Db) => T): T {
  const opened = openDatabase(loadConfig(env));
  try {
    return read(opened.db);
  } finally {
    opened.db.close();
  }
}

function seedRows(env: NodeJS.ProcessEnv, rows: readonly FailureRow[]): void {
  withDb(env, (db) => {
    const insert = db.prepare(
      `INSERT INTO memories (id, type, kind, anchors, conflict_key, keywords, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
       VALUES (?, 'procedural', 'procedure', ?, ?, ?, 'project', ?, ?, ?, ?, 0.5, NULL, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
    );
    for (const row of rows) {
      insert.run(
        row.id,
        JSON.stringify(row.anchors ?? []),
        row.conflictKey ?? "",
        row.keywords ?? "",
        row.projectId ?? PROJECT_ID,
        `fix for ${row.id}`,
        row.abstract ?? `apply the fix recorded as ${row.id}`,
        `body of ${row.id}`,
      );
    }
  });
}

function hook(env: NodeJS.ProcessEnv, input: Record<string, unknown>): Promise<ProcessResult> {
  return runProcess({
    command: process.execPath,
    args: [hookEntryPath()],
    env,
    stdinText: JSON.stringify({ cwd: PROJECT_DIR, ...input }),
    timeoutMs: HOOK_KILL_MS,
  });
}

function failure(env: NodeJS.ProcessEnv, event: FailureEvent): Promise<ProcessResult> {
  return hook(env, {
    hook_event_name: "PostToolUseFailure",
    cwd: event.cwd ?? PROJECT_DIR,
    session_id: event.sessionId,
    tool_name: "Bash",
    tool_input: { command: event.command },
    tool_use_id: "toolu_failure",
    error: event.error,
    is_interrupt: event.isInterrupt ?? false,
  });
}

function success(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  command: string,
): Promise<ProcessResult> {
  return hook(env, {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "toolu_success",
    tool_response: { stdout: "ok", stderr: "", interrupted: false },
  });
}

function additionalContext(result: ProcessResult): string {
  const output: unknown = JSON.parse(result.stdout);
  expect(output).toEqual({
    hookSpecificOutput: {
      hookEventName: "PostToolUseFailure",
      additionalContext: expect.any(String),
    },
  });
  return (output as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
    .additionalContext;
}

function injectedRowIds(result: ProcessResult, ids: readonly string[]): string[] {
  return ids.filter((id) => result.stdout.includes(id));
}

function failureEvents(env: NodeJS.ProcessEnv): RecallEventRow[] {
  return withDb(
    env,
    (db) =>
      db
        .prepare(
          "SELECT event, injected FROM recall_events WHERE event = 'PostToolUseFailure' ORDER BY id",
        )
        .all() as RecallEventRow[],
  );
}

function tableRowCounts(env: NodeJS.ProcessEnv): Record<string, number> {
  return withDb(env, (db) => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all() as string[];
    return Object.fromEntries(
      tables.map((table) => [
        table,
        db.prepare(`SELECT count(*) FROM "${table}"`).pluck().get() as number,
      ]),
    );
  });
}

describe("PostToolUseFailure recall", () => {
  it("injects a visible row anchored on a signature term, exit 0", async () => {
    const env = freshEnv();
    seedRows(env, [{ id: MISSING_MODULE_ROW, anchors: ["express"] }]);

    const result = await failure(env, {
      sessionId: "fr1-session",
      command: "node server.js",
      error: MISSING_MODULE_ERROR,
    });

    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(additionalContext(result)).toContain(MISSING_MODULE_ROW);
  });

  it("never admits a row whose conflict key and keywords alone hold a signature term", async () => {
    const env = freshEnv();
    seedRows(env, [
      {
        id: MISSING_MODULE_ROW,
        conflictKey: "error.express_missing",
        keywords: "express server dependency",
      },
    ]);

    expect(
      await failure(env, {
        sessionId: "keys-session",
        command: "node server.js",
        error: MISSING_MODULE_ERROR,
      }),
    ).toEqual(ABSTAINED);
  });

  it("records the injection and one PostToolUseFailure recall event with injected 1", async () => {
    const env = freshEnv();
    seedRows(env, [{ id: MISSING_MODULE_ROW, anchors: ["express"] }]);

    await failure(env, {
      sessionId: "fr8-session",
      command: "node server.js",
      error: MISSING_MODULE_ERROR,
    });

    expect(failureEvents(env)).toEqual([{ event: "PostToolUseFailure", injected: 1 }]);
    expect(
      withDb(env, (db) =>
        db
          .prepare("SELECT session_id AS sessionId, memory_id AS memoryId, event FROM injections")
          .all(),
      ),
    ).toEqual([
      { sessionId: "fr8-session", memoryId: MISSING_MODULE_ROW, event: "PostToolUseFailure" },
    ]);
  });

  it.each([
    { failureText: "a bare assertion", error: "Exit code 1\nassert 1 == 2" },
    {
      failureText: "an assertion class no row names",
      error: "Exit code 1\nE   AssertionError: assert 1 == 2",
    },
  ])(
    "never admits a row anchored only on the command head, after $failureText",
    async ({ error }) => {
      const env = freshEnv();
      seedRows(env, [{ id: "01J8GZSQFAIL00000HEADONLY1", anchors: ["pytest"] }]);

      expect(await failure(env, { sessionId: "fr3-session", command: "pytest -q", error })).toEqual(
        ABSTAINED,
      );
    },
  );

  it("injects once per session and command head: a later failure of the head stays silent, even after a pass, while another head still injects", async () => {
    const env = freshEnv();
    const moduleRow = "01J8GZSQFAIL00000000MODULE";
    const enoentRow = "01J8GZSQFAIL00000000ENOENT";
    seedRows(env, [
      { id: moduleRow, anchors: ["ModuleNotFoundError"] },
      { id: enoentRow, anchors: ["ENOENT"] },
    ]);
    const sessionId = "fr4-sequence";
    const enoent = "Exit code 1\nFileNotFoundError: ENOENT: no such file or directory";

    const runs = [
      await failure(env, {
        sessionId,
        command: "pytest -q",
        error: "Exit code 1\nModuleNotFoundError: No module named 'requests'",
      }),
      await failure(env, { sessionId, command: "pytest -q", error: enoent }),
      await success(env, sessionId, "pytest -q"),
      await failure(env, { sessionId, command: "pytest -q", error: enoent }),
      await failure(env, { sessionId, command: "npm test", error: enoent }),
    ];

    expect(runs.map((run) => injectedRowIds(run, [moduleRow, enoentRow]))).toEqual([
      [moduleRow],
      [],
      [],
      [],
      [enoentRow],
    ]);
  });

  it("leaves the head unused when a failure injects nothing", async () => {
    const env = freshEnv();
    seedRows(env, [{ id: MISSING_MODULE_ROW, anchors: ["express"] }]);
    const sessionId = "a2-session";

    const silent = await failure(env, {
      sessionId,
      command: "node server.js",
      error: "Exit code 1\nError: listen EADDRINUSE: address already in use",
    });
    const matched = await failure(env, {
      sessionId,
      command: "node server.js",
      error: MISSING_MODULE_ERROR,
    });

    expect(silent).toEqual(ABSTAINED);
    expect(injectedRowIds(matched, [MISSING_MODULE_ROW])).toEqual([MISSING_MODULE_ROW]);
  });

  it("8 concurrent failures of one head in a fresh session inject exactly once", {
    timeout: 60_000,
  }, async () => {
    const env = freshEnv();
    const rowIds = CONCURRENT_CODES.map((_, index) => `01J8GZSQFAIL0000CONCURRNT${index}`);
    seedRows(
      env,
      CONCURRENT_CODES.map((code, index) => ({ id: rowIds[index] as string, anchors: [code] })),
    );

    const runs = await Promise.all(
      CONCURRENT_CODES.map((code) =>
        failure(env, {
          sessionId: "fr4-concurrent",
          command: "npm test",
          error: `Exit code 1\nError: ${code}: operation failed`,
        }),
      ),
    );

    expect(runs.map(({ code, stderr }) => ({ code, stderr }))).toEqual(
      runs.map(() => ({ code: 0, stderr: "" })),
    );
    const events = failureEvents(env);
    expect({
      outputs: runs.filter((run) => run.stdout !== "").length,
      events: events.length,
      injecting: events.filter((event) => event.injected > 0).length,
      claims: withDb(env, (db) => db.prepare("SELECT count(*) FROM failure_recalls").pluck().get()),
    }).toEqual({ outputs: 1, events: CONCURRENT_FAILURES, injecting: 1, claims: 1 });
  });

  it("an interrupt with a matching signature injects nothing and writes nothing", async () => {
    const env = freshEnv();
    seedRows(env, [{ id: MISSING_MODULE_ROW, anchors: ["express"] }]);
    const before = tableRowCounts(env);

    const result = await failure(env, {
      sessionId: "fr5-session",
      command: "node server.js",
      error: MISSING_MODULE_ERROR,
      isInterrupt: true,
    });

    expect(result).toEqual(ABSTAINED);
    expect(tableRowCounts(env)).toEqual(before);
  });

  it("persists and prints neither the error text nor a secret inside it", async () => {
    const env = freshEnv();
    seedRows(env, [{ id: "01J8GZSQFAIL0000000REFUSED", anchors: ["ECONNREFUSED"] }]);
    const marker = "ZQMARK7731";
    const secret = FAKE_SECRETS.awsAccessKeyId;

    const result = await failure(env, {
      sessionId: "fr6-session",
      command: "psql -h db",
      error: `Exit code 2\nError: ${marker} login with ${secret} failed: connect ECONNREFUSED`,
    });
    const dataDir = env.CLAUDE_PLUGIN_DATA as string;
    const outputs = [
      { name: "stdout", text: result.stdout },
      ...[DB_FILENAME, `${DB_FILENAME}-wal`]
        .filter((name) => existsSync(join(dataDir, name)))
        .map((name) => ({ name, text: readFileSync(join(dataDir, name)).toString("latin1") })),
    ];

    expect(result.stdout).toContain("01J8GZSQFAIL0000000REFUSED");
    expect(
      outputs.map(({ name, text }) => ({
        name,
        marker: text.includes(marker),
        secret: text.includes(secret),
      })),
    ).toEqual(outputs.map(({ name }) => ({ name, marker: false, secret: false })));
  });

  it.each([
    {
      condition: "the row belongs to another project",
      arrange: (env: NodeJS.ProcessEnv) =>
        seedRows(env, [
          { id: MISSING_MODULE_ROW, anchors: ["express"], projectId: OTHER_PROJECT_ID },
        ]),
    },
    {
      condition: "UserPromptSubmit already injected the row in this session",
      arrange: (env: NodeJS.ProcessEnv) => {
        seedRows(env, [{ id: MISSING_MODULE_ROW, anchors: ["express"] }]);
        withDb(env, (db) =>
          db
            .prepare(
              "INSERT INTO injections (session_id, memory_id, event, at) VALUES ('fr7-session', ?, 'UserPromptSubmit', ?)",
            )
            .run(MISSING_MODULE_ROW, new Date().toISOString()),
        );
      },
    },
    {
      condition: "recall is off for the project",
      arrange: (env: NodeJS.ProcessEnv) => {
        seedRows(env, [{ id: MISSING_MODULE_ROW, anchors: ["express"] }]);
        withDb(env, (db) =>
          db
            .prepare(
              "INSERT INTO project_settings (project_id, recall_enabled, updated_at) VALUES (?, 0, ?)",
            )
            .run(PROJECT_ID, new Date().toISOString()),
        );
      },
    },
  ])("injects nothing when $condition", async ({ arrange }) => {
    const env = freshEnv();
    arrange(env);

    expect(
      await failure(env, {
        sessionId: "fr7-session",
        command: "node server.js",
        error: MISSING_MODULE_ERROR,
      }),
    ).toEqual(ABSTAINED);
  });

  it("renders within the pre-tool budget, not the session budget", async () => {
    const env = freshEnv({
      CLAUDE_PLUGIN_OPTION_PRETOOL_BUDGET_TOKENS: String(SMALLEST_BUDGET_TOKENS),
    });
    const rowIds = Array.from({ length: 5 }, (_, index) => `01J8GZSQFAIL00000BUDGET0${index}`);
    seedRows(
      env,
      rowIds.map((id) => ({
        id,
        anchors: ["express"],
        abstract: `install express before starting the server and pin its version in the lockfile, row ${id}`,
      })),
    );

    const context = additionalContext(
      await failure(env, {
        sessionId: "budget-session",
        command: "node server.js",
        error: MISSING_MODULE_ERROR,
      }),
    );

    expect(rowIds.filter((id) => context.includes(id)).length).toBeGreaterThan(0);
    expect(estimateTokens(context)).toBeLessThanOrEqual(SMALLEST_BUDGET_TOKENS);
  });

  it.each([
    { field: "missing", error: undefined },
    { field: "not a string", error: { message: "Cannot find module 'express'" } },
  ])("keeps the capture signal and abstains when error is $field", async ({ error }) => {
    const env = freshEnv();
    seedRows(env, [{ id: MISSING_MODULE_ROW, anchors: ["express"] }]);

    const result = await failure(env, {
      sessionId: "nfr2-session",
      command: "node server.js",
      error,
    });

    expect(result).toEqual(ABSTAINED);
    expect(failureEvents(env)).toEqual([{ event: "PostToolUseFailure", injected: 0 }]);
    expect(
      withDb(env, (db) => db.prepare("SELECT head FROM command_failures").pluck().all()),
    ).toEqual(["node server.js"]);
  });

  it("session start drops failure claims older than 30 days", async () => {
    const env = freshEnv();
    const recent = new Date().toISOString();
    withDb(env, (db) => {
      const claim = db.prepare(
        "INSERT INTO failure_recalls (session_id, head, recalled_at) VALUES ('old-session', ?, ?)",
      );
      claim.run("pytest", new Date(Date.now() - 31 * DAY_MS).toISOString());
      claim.run("npm test", recent);
    });

    await hook(env, {
      hook_event_name: "SessionStart",
      session_id: "new-session",
      source: "startup",
    });

    expect(
      withDb(env, (db) => db.prepare("SELECT head FROM failure_recalls").pluck().all()),
    ).toEqual(["npm test"]);
  });

  it("writes the statusline badge state after an injecting failure while the badge is on", async () => {
    const env = freshEnv();
    seedRows(env, [{ id: MISSING_MODULE_ROW, anchors: ["express"] }]);
    const enabled = await runProcess({
      command: process.execPath,
      args: [join(process.cwd(), "dist", "cli.js"), "statusline", "on"],
      env,
      stdinText: "",
      timeoutMs: HOOK_KILL_MS,
    });
    const sessionId = "6f1d2c3b-badge-failure";

    await failure(env, { sessionId, command: "node server.js", error: MISSING_MODULE_ERROR });
    const state: unknown = JSON.parse(
      readFileSync(
        join(env.CLAUDE_PLUGIN_DATA as string, "statusline", "sessions", `${sessionId}.json`),
        "utf8",
      ),
    );

    expect(enabled.code).toBe(0);
    expect(state).toEqual({
      version: 1,
      session_id: sessionId,
      injected: 1,
      last_event: "PostToolUseFailure",
      last_at: expect.any(String),
      recall: "on",
    });
  });
});
