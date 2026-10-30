import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Ajv from "ajv";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/cfg";
import { openDatabase } from "../src/db/database";
import { recordCommandFailure } from "../src/db/signals";
import { newId, resolveProjectId } from "../src/ids";
import type { MemoryKind } from "../src/policy";
import { routingLine } from "../src/session";
import { enableStatusline, statuslinePaths } from "../src/statusline";
import { TOOL_DEFINITIONS } from "../src/tools";
import { testModelCacheDir, testModelEnv } from "../vitest.config";
import {
  type ProcessResult,
  runProcess,
  seedConfig,
  seedMemories,
  toolText,
} from "./fixtures/seed";

type CodexEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

interface CodexSession {
  readonly env: NodeJS.ProcessEnv;
  readonly config: Config;
}

interface AnchoredMemory {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly anchors: readonly string[];
  readonly abstract: string;
}

interface HooksConfig {
  readonly hooks: Readonly<Record<string, readonly { readonly hooks: { command: string }[] }[]>>;
}

const PLUGIN_DIR = process.cwd();
const HOOK_KILL_MS = 25_000;
const SPAWNED_TIMEOUT_MS = 60_000;
const CODEX_CONTEXT_CHARS_MAX = 9_500;
const MEMORY_TOOL_COUNT = 10;
const SESSION = "019a2c3e-7a1b-7c3d-9e4f-5a6b7c8d9e0f";
const OTHER_SESSION = "019a2c3e-7a1b-7c3d-9e4f-5a6b7c8d9e10";
const TURN = "019a2c3f-0b1c-7d2e-8f30-4a5b6c7d8e9f";
const CODEX_FEEDBACK_TOOL = "mcp__memory__memory_feedback";
const CODEX_STORE_TOOL = "mcp__memory__memory_store";
const CODEX_UPDATE_TOOL = "mcp__memory__memory_update";
const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const NODE_FIRST_PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`;
const SCHEMA_DIR = join(PLUGIN_DIR, "tests", "fixtures", "codex-hooks-schema");
const SCHEMA_FILE_STEMS: Readonly<Record<CodexEvent, string>> = {
  SessionStart: "session-start",
  UserPromptSubmit: "user-prompt-submit",
  PreToolUse: "pre-tool-use",
  PostToolUse: "post-tool-use",
  Stop: "stop",
};
const HOOKS_JSON = JSON.parse(
  readFileSync(join(PLUGIN_DIR, "hooks", "hooks.json"), "utf8"),
) as HooksConfig;
const ajv = new Ajv();
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
});

function gitProject(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "acm-codex-project-")));
  execFileSync("git", ["init", "-q", "-b", "main"], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", ...GIT_ISOLATION },
  });
  return dir;
}

const PROJECT = gitProject();
const PROJECT_ID = resolveProjectId(PROJECT);

function codexSession(): CodexSession {
  const dataDir = mkdtempSync(join(tmpdir(), "acm-codex-store-"));
  const codexHome = mkdtempSync(join(tmpdir(), "acm-codex-home-"));
  const codexPluginData = join(codexHome, ".codex", "plugins", "data", "adaptive-cognitive-memory");
  return {
    env: {
      PATH: NODE_FIRST_PATH,
      HOME: codexHome,
      PLUGIN_ROOT: PLUGIN_DIR,
      CLAUDE_PLUGIN_ROOT: PLUGIN_DIR,
      PLUGIN_DATA: codexPluginData,
      CLAUDE_PLUGIN_DATA: codexPluginData,
      ACM_DATA_DIR: dataDir,
      ...GIT_ISOLATION,
      ...testModelEnv,
    },
    config: seedConfig(dataDir, testModelCacheDir),
  };
}

function hookCommand(event: CodexEvent): string {
  const command = HOOKS_JSON.hooks[event]?.[0]?.hooks[0]?.command;
  if (command === undefined) {
    throw new Error(`hooks/hooks.json registers no ${event} command`);
  }
  return command;
}

function codexHook(
  env: NodeJS.ProcessEnv,
  event: CodexEvent,
  fields: Readonly<Record<string, unknown>>,
): Promise<ProcessResult> {
  return runProcess({
    command: "sh",
    args: ["-c", hookCommand(event)],
    env,
    cwd: PROJECT,
    stdinText: JSON.stringify({
      session_id: SESSION,
      transcript_path: null,
      cwd: PROJECT,
      hook_event_name: event,
      model: "gpt-5-codex",
      permission_mode: "default",
      ...(event === "SessionStart" ? {} : { turn_id: TURN }),
      ...fields,
    }),
    timeoutMs: HOOK_KILL_MS,
  });
}

function codexStdout(result: ProcessResult, event: CodexEvent): unknown {
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  if (result.stdout === "") {
    return undefined;
  }
  const output: unknown = JSON.parse(result.stdout);
  const validate = ajv.compile(
    JSON.parse(
      readFileSync(
        join(SCHEMA_DIR, `${SCHEMA_FILE_STEMS[event]}.command.output.schema.json`),
        "utf8",
      ),
    ),
  );
  expect(validate(output), ajv.errorsText(validate.errors)).toBe(true);
  return output;
}

function injectedContext(output: unknown, event: CodexEvent): string {
  expect(output).toEqual({
    hookSpecificOutput: { hookEventName: event, additionalContext: expect.any(String) },
  });
  const context = (output as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext;
  expect(context.length).toBeLessThanOrEqual(CODEX_CONTEXT_CHARS_MAX);
  return context;
}

function seedAnchoredMemory(config: Config, memory: AnchoredMemory): void {
  const opened = openDatabase(config);
  try {
    opened.db
      .prepare(
        `INSERT INTO memories (id, type, kind, anchors, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
         VALUES (?, 'procedural', ?, ?, 'project', ?, 'codex memory', ?, 'body', 0.6, NULL, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
      )
      .run(memory.id, memory.kind, JSON.stringify(memory.anchors), PROJECT_ID, memory.abstract);
  } finally {
    opened.db.close();
  }
}

function openRememberSignal(config: Config, sessionId: string): void {
  const opened = openDatabase(config);
  try {
    opened.db
      .prepare(
        "INSERT INTO session_signals (session_id, kind, detail, opened_at) VALUES (?, 'remember', 'the release freeze', '2026-10-30T00:00:00.000Z')",
      )
      .run(sessionId);
  } finally {
    opened.db.close();
  }
}

function storeRows<T>(config: Config, sql: string, ...params: readonly string[]): T[] {
  const opened = openDatabase(config);
  try {
    return opened.db.prepare(sql).all(...params) as T[];
  } finally {
    opened.db.close();
  }
}

describe("Codex hooks from hooks/hooks.json", () => {
  it(
    "recall the pinned project memory at session start with no Claude routing line and no statusline badge",
    async () => {
      const { env, config } = codexSession();
      const pinnedId = newId();
      seedAnchoredMemory(config, {
        id: pinnedId,
        kind: "constraint",
        anchors: [],
        abstract: "Never deploy the billing service during the release freeze",
      });
      enableStatusline(config.dataDir, Buffer.from("shim"), "2026-10-30T00:00:00.000Z");

      const started = await codexHook(env, "SessionStart", { source: "startup" });

      const context = injectedContext(codexStdout(started, "SessionStart"), "SessionStart");
      expect(context).toContain(pinnedId);
      expect(context).not.toContain(routingLine(true));
      expect(readdirSync(statuslinePaths(config.dataDir).sessions)).toEqual([]);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "recall a relevant memory for a prompt",
    async () => {
      const { env, config } = codexSession();
      const relevantId = newId();
      await seedMemories(config, [
        {
          id: relevantId,
          projectId: PROJECT_ID,
          scope: "project",
          type: "procedural",
          title: "Database migrations under load run in small batches",
          abstract:
            "Handle database migrations under load in batches of 500 rows with a 2 s lock timeout",
          content: "Database migrations under load copy data in batches of 500 rows.",
          importance: 0.5,
        },
      ]);

      const prompted = await codexHook(env, "UserPromptSubmit", {
        prompt: "how should we handle database migrations under load",
      });

      expect(
        injectedContext(codexStdout(prompted, "UserPromptSubmit"), "UserPromptSubmit"),
      ).toContain(relevantId);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "recall the memory anchored on a file an apply_patch call updates",
    async () => {
      const { env, config } = codexSession();
      const anchoredId = newId();
      seedAnchoredMemory(config, {
        id: anchoredId,
        kind: "procedure",
        anchors: ["billing/tax.py"],
        abstract: "Round tax per invoice line before summing",
      });

      const patched = await codexHook(env, "PreToolUse", {
        tool_name: "apply_patch",
        tool_use_id: "call_patch",
        tool_input: {
          command: [
            "*** Begin Patch",
            "*** Update File: billing/tax.py",
            "@@",
            "-total = round(sum(lines))",
            "+total = sum(round(line) for line in lines)",
            "*** End Patch",
          ].join("\n"),
        },
      });

      expect(injectedContext(codexStdout(patched, "PreToolUse"), "PreToolUse")).toContain(
        "Round tax per invoice line before summing",
      );
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "record the memory_feedback receipt with its verdicts and close the signals on memory_store and memory_update",
    async () => {
      const { env, config } = codexSession();
      const usedId = newId();
      seedAnchoredMemory(config, {
        id: usedId,
        kind: "fact",
        anchors: [],
        abstract: "The billing service deploys with make release",
      });
      openRememberSignal(config, SESSION);
      openRememberSignal(config, OTHER_SESSION);
      const toolResponse = { content: [{ type: "text", text: "{}" }] };

      const feedback = await codexHook(env, "PostToolUse", {
        tool_name: CODEX_FEEDBACK_TOOL,
        tool_use_id: "call_feedback",
        tool_input: { used: [usedId] },
        tool_response: toolResponse,
      });
      const stored = await codexHook(env, "PostToolUse", {
        tool_name: CODEX_STORE_TOOL,
        tool_use_id: "call_store",
        tool_input: {},
        tool_response: toolResponse,
      });
      const updated = await codexHook(env, "PostToolUse", {
        session_id: OTHER_SESSION,
        tool_name: CODEX_UPDATE_TOOL,
        tool_use_id: "call_update",
        tool_input: {},
        tool_response: toolResponse,
      });

      expect(
        [feedback, stored, updated].map((result) => codexStdout(result, "PostToolUse")),
      ).toEqual([undefined, undefined, undefined]);
      expect(storeRows(config, "SELECT session_id AS sessionId FROM receipt_sessions")).toEqual([
        { sessionId: SESSION },
      ]);
      expect(
        storeRows(
          config,
          "SELECT session_id AS sessionId, memory_id AS memoryId, verdict FROM verdicts",
        ),
      ).toEqual([{ sessionId: SESSION, memoryId: usedId, verdict: "used" }]);
      expect(
        storeRows(
          config,
          "SELECT session_id AS sessionId, closed_by AS closedBy FROM session_signals ORDER BY id",
        ),
      ).toEqual([
        { sessionId: SESSION, closedBy: "receipt" },
        { sessionId: OTHER_SESSION, closedBy: "receipt" },
      ]);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "block the stop once with a checkpoint naming the Codex store tool, and not again while the stop hook is active",
    async () => {
      const { env, config } = codexSession();
      openRememberSignal(config, SESSION);

      const whileActive = await codexHook(env, "Stop", {
        stop_hook_active: true,
        last_assistant_message: "Done.",
      });
      const blocked = await codexHook(env, "Stop", {
        stop_hook_active: false,
        last_assistant_message: "Done.",
      });
      const afterCheckpoint = await codexHook(env, "Stop", {
        stop_hook_active: false,
        last_assistant_message: "Done.",
      });

      expect(codexStdout(whileActive, "Stop")).toBeUndefined();
      expect(codexStdout(blocked, "Stop")).toEqual({
        decision: "block",
        reason: expect.stringContaining(CODEX_STORE_TOOL),
      });
      expect(codexStdout(afterCheckpoint, "Stop")).toBeUndefined();
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "capture no failure and open no resolution from a Bash result without an exit code",
    async () => {
      const { env, config } = codexSession();
      const failedAt = "2026-10-30T00:00:00.000Z";
      const opened = openDatabase(config);
      try {
        recordCommandFailure(opened.db, { sessionId: SESSION, head: "npm test", at: failedAt });
      } finally {
        opened.db.close();
      }

      const result = await codexHook(env, "PostToolUse", {
        tool_name: "Bash",
        tool_use_id: "call_bash",
        tool_input: { command: "npm test" },
        tool_response: JSON.stringify("Error: 1 test failed\n"),
      });

      expect(codexStdout(result, "PostToolUse")).toBeUndefined();
      expect(
        storeRows(
          config,
          "SELECT session_id AS sessionId, head, failed_at AS failedAt FROM command_failures",
        ),
      ).toEqual([{ sessionId: SESSION, head: "npm test", failedAt }]);
      expect(storeRows(config, "SELECT session_id FROM failure_recalls")).toEqual([]);
      expect(storeRows(config, "SELECT id FROM session_signals")).toEqual([]);
    },
    SPAWNED_TIMEOUT_MS,
  );
});

describe("Codex MCP server registered in config.toml", () => {
  it(
    "lists the ten memory tools under a cleared env and stores under the project id the Codex hooks recall",
    async () => {
      const { env: hookEnv, config } = codexSession();
      const client = new Client({ name: "acm-codex-check", version: "0.0.0" });
      clients.push(client);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [join(PLUGIN_DIR, "dist", "server.js")],
          env: {
            HOME: mkdtempSync(join(tmpdir(), "acm-codex-mcp-home-")),
            PATH: NODE_FIRST_PATH,
            ACM_HOST: "codex",
            ACM_DATA_DIR: config.dataDir,
            ...testModelEnv,
          },
          cwd: PROJECT,
          stderr: "pipe",
        }),
      );

      const listed = await client.listTools();
      const stored = JSON.parse(
        toolText(
          await client.callTool({
            name: "memory_store",
            arguments: {
              title: "Release freeze",
              content: "Never deploy the billing service during the release freeze.",
              type: "semantic",
              kind: "constraint",
              conflict_key: "deploy.release_freeze",
              cardinality: "single",
              value_text: "no deploys during the freeze",
              scope: "project",
            },
          }),
        ),
      ) as { id: string; action: string };
      const started = await codexHook(hookEnv, "SessionStart", { source: "startup" });

      expect(listed.tools.map(({ name }) => name).sort()).toEqual(
        TOOL_DEFINITIONS.map(({ name }) => name).sort(),
      );
      expect(listed.tools).toHaveLength(MEMORY_TOOL_COUNT);
      expect(stored.action).toBe("created");
      expect(storeRows(config, "SELECT scope FROM memories WHERE id = ?", stored.id)).toEqual([
        { scope: "project" },
      ]);
      expect(injectedContext(codexStdout(started, "SessionStart"), "SessionStart")).toContain(
        stored.id,
      );
    },
    SPAWNED_TIMEOUT_MS,
  );
});
