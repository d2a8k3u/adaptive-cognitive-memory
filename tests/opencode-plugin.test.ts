import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as pluginModule from "../opencode/adaptive-cognitive-memory";
import { AdaptiveCognitiveMemory } from "../opencode/adaptive-cognitive-memory";
import type { Config } from "../src/cfg";
import { openDatabase } from "../src/db/database";
import { newId, resolveProjectId } from "../src/ids";
import type { MemoryKind } from "../src/policy";
import { TOOL_DEFINITIONS } from "../src/tools";
import { PLUGIN_ROOT } from "../src/version";
import { testModelCacheDir, testModelEnv } from "../vitest.config";
import { runProcess, seedConfig, seedMemories } from "./fixtures/seed";

type ChatOutput = Parameters<NonNullable<Hooks["chat.message"]>>[1];
type ToolOutput = Parameters<NonNullable<Hooks["tool.execute.after"]>>[1];
type MessagePart = ChatOutput["parts"][number];
type PromptAsyncOptions = Parameters<PluginInput["client"]["session"]["promptAsync"]>[0];

interface PromptAsyncStub {
  readonly calls: PromptAsyncOptions[];
  readonly client: PluginInput["client"];
}

interface AnchoredMemory {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly anchors: readonly string[];
  readonly abstract: string;
}

const SPAWNED_TIMEOUT_MS = 60_000;
const CONTEXT_CHARS_MAX = 9_500;
const MEMORY_TOOL_COUNT = 10;
const PART_ID = /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const PART_TICKS_PER_MS = 0x1000n;
const PART_TIME_LIMIT = 1n << 48n;
const CLOCK_LEAD_MS = 60_000n;
const MESSAGE_ID = "msg_9a3f0c2b1001AbCdEfGhIjKlMn";
const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const NODE_FIRST_PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`;
const MIGRATION_PROMPT = "how should we handle database migrations under load";
const MISSING_DEPENDENCY = join(process.cwd(), "tests", "fixtures", "missing-dependency.cjs");
const HOOK_KILL_MS = 25_000;
const BLOCK_SEPARATOR = "\n\n";
const TOOL_RESULT = "tool finished";
const CLAUDE_FEEDBACK_TOOL = "mcp__plugin_adaptive-cognitive-memory_memory__memory_feedback";
const TEST_COMMAND = "pytest -q tests/test_db.py";
const TEST_COMMAND_HEAD = "pytest";
const LOCKED_DATABASE_OUTPUT = "E   sqlite3.OperationalError: SQLITE_BUSY: database is locked";
const TIMED_OUT_METADATA =
  "<shell_metadata>\nshell tool terminated command after exceeding timeout 120000 ms\n</shell_metadata>";
const clients: Client[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) {
    await client.close();
  }
});

function gitProject(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "acm-opencode-project-")));
  execFileSync("git", ["init", "-q", "-b", "main"], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", ...GIT_ISOLATION },
  });
  return dir;
}

const PROJECT = gitProject();
const PROJECT_ID = resolveProjectId(PROJECT);

function isolatedStore(): Config {
  const dataDir = mkdtempSync(join(tmpdir(), "acm-opencode-store-"));
  vi.stubEnv("ACM_DATA_DIR", dataDir);
  vi.stubEnv("ACM_DB_PATH", undefined);
  vi.stubEnv("ACM_MODEL_CACHE_DIR", testModelEnv.ACM_MODEL_CACHE_DIR);
  vi.stubEnv("ACM_EMBED_DEADLINE_MS", testModelEnv.ACM_EMBED_DEADLINE_MS);
  vi.stubEnv("CLAUDE_PLUGIN_OPTION_RECALL_BUDGET_TOKENS", undefined);
  vi.stubEnv("CLAUDE_PLUGIN_OPTION_PRETOOL_BUDGET_TOKENS", undefined);
  vi.stubEnv("CLAUDE_PLUGIN_OPTION_DOWNLOAD_MODEL", undefined);
  vi.stubEnv("NODE_OPTIONS", undefined);
  return seedConfig(dataDir, testModelCacheDir);
}

function promptAsyncStub(results: readonly { error?: unknown }[] = []): PromptAsyncStub {
  const calls: PromptAsyncOptions[] = [];
  const promptAsync = async (options: PromptAsyncOptions) => {
    calls.push(options);
    return results[calls.length - 1] ?? { data: undefined };
  };
  return { calls, client: { session: { promptAsync } } as unknown as PluginInput["client"] };
}

function pluginInput(client: PluginInput["client"]): PluginInput {
  return {
    client,
    project: { id: "acm-opencode-test", worktree: PROJECT, vcs: "git", time: { created: 0 } },
    directory: PROJECT,
    worktree: PROJECT,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: undefined as unknown as PluginInput["$"],
  };
}

function openPlugin(stub: PromptAsyncStub = promptAsyncStub()): Promise<Hooks> {
  return AdaptiveCognitiveMemory(pluginInput(stub.client));
}

function nowTicks(): bigint {
  return BigInt(Date.now()) * PART_TICKS_PER_MS;
}

function openCodeId(ticks: bigint, suffix: string): string {
  return `prt_${(ticks % PART_TIME_LIMIT).toString(16).padStart(12, "0")}${suffix}`;
}

function userPart(sessionID: string, id: string, text: string): MessagePart {
  return { id, sessionID, messageID: MESSAGE_ID, type: "text", text };
}

function chatOutput(sessionID: string, parts: MessagePart[]): ChatOutput {
  return {
    message: {
      id: MESSAGE_ID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude" },
    },
    parts,
  };
}

function appendedTexts(output: ChatOutput, existing: number): string[] {
  return output.parts.slice(existing).map((part) => (part.type === "text" ? part.text : ""));
}

function seedAnchoredMemory(config: Config, memory: AnchoredMemory): void {
  const opened = openDatabase(config);
  try {
    opened.db
      .prepare(
        `INSERT INTO memories (id, type, kind, anchors, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
         VALUES (?, 'procedural', ?, ?, 'project', ?, 'opencode memory', ?, 'body', 0.6, NULL, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
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

function storeRows(config: Config, sql: string): unknown[] {
  const opened = openDatabase(config);
  try {
    return opened.db.prepare(sql).all();
  } finally {
    opened.db.close();
  }
}

function toolOutput(output: string, metadata: unknown): ToolOutput {
  return { title: "tool", output, metadata };
}

function bashOutput(exit: number | null, metadataOutput: string): ToolOutput {
  return toolOutput(TOOL_RESULT, { output: metadataOutput, exit, truncated: false });
}

async function afterTool(
  hooks: Hooks,
  sessionID: string,
  call: { readonly tool: string; readonly args: unknown },
  output: ToolOutput,
): Promise<void> {
  await hooks["tool.execute.after"]!(
    { tool: call.tool, sessionID, callID: "call_opencode", args: call.args },
    output,
  );
}

function appendedTo(output: ToolOutput): string {
  expect(output.output.startsWith(TOOL_RESULT)).toBe(true);
  return output.output.slice(TOOL_RESULT.length);
}

function stderrLines(): () => string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    const text = String(chunk);
    lines.push(...text.split("\n").filter((line) => line !== ""));
    return true;
  });
  return () => lines;
}

describe("OpenCode plugin module", () => {
  it("exports exactly one value, the plugin function, for the legacy loader", () => {
    const values = Object.values(pluginModule);

    expect(values).toHaveLength(1);
    expect(values[0]).toBeTypeOf("function");
  });

  it("registers no tool.execute.before hook, so tool arguments stay untouched", async () => {
    isolatedStore();

    const hooks = await openPlugin();

    expect(Object.keys(hooks)).not.toContain("tool.execute.before");
  });

  it(
    "pairs with the MCP server, which lists the ten memory tools as OpenCode",
    async () => {
      const config = isolatedStore();
      const client = new Client({ name: "acm-opencode-check", version: "0.0.0" });
      clients.push(client);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [join(process.cwd(), "dist", "server.js")],
          env: {
            HOME: mkdtempSync(join(tmpdir(), "acm-opencode-mcp-home-")),
            PATH: NODE_FIRST_PATH,
            ACM_HOST: "opencode",
            ACM_DATA_DIR: config.dataDir,
            ...testModelEnv,
          },
          cwd: PROJECT,
          stderr: "pipe",
        }),
      );

      const listed = await client.listTools();

      expect(listed.tools).toHaveLength(MEMORY_TOOL_COUNT);
      expect(listed.tools.map(({ name }) => name).sort()).toEqual(
        TOOL_DEFINITIONS.map(({ name }) => name).sort(),
      );
    },
    SPAWNED_TIMEOUT_MS,
  );
});

describe("OpenCode chat.message", () => {
  it(
    "appends the session recall once and the prompt recall as synthetic parts that sort after every part",
    async () => {
      const config = isolatedStore();
      const sessionID = "ses_7c1d2e3f4a01AbCdEfGhIjKlMn";
      const pinnedId = newId();
      const relevantId = newId();
      seedAnchoredMemory(config, {
        id: pinnedId,
        kind: "constraint",
        anchors: [],
        abstract: "Never deploy the billing service during the release freeze",
      });
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
      const startTicks = nowTicks();
      const userIds = [
        openCodeId(startTicks - 1_000n * PART_TICKS_PER_MS, "AbCdEfGhIjKlMn"),
        openCodeId(startTicks + CLOCK_LEAD_MS * PART_TICKS_PER_MS, "ZyXwVuTsRqPoNm"),
      ];
      const hooks = await openPlugin();
      const first = chatOutput(sessionID, [
        userPart(sessionID, userIds[0]!, MIGRATION_PROMPT),
        userPart(sessionID, userIds[1]!, "and keep the lock short"),
      ]);
      const second = chatOutput(sessionID, [
        userPart(sessionID, openCodeId(startTicks, "QwErTyUiOpAsDf"), MIGRATION_PROMPT),
      ]);

      await hooks["chat.message"]!({ sessionID }, first);
      await hooks["chat.message"]!({ sessionID }, second);

      const appended = first.parts.slice(userIds.length);
      expect(appended).toEqual([
        {
          id: expect.stringMatching(PART_ID),
          sessionID,
          messageID: MESSAGE_ID,
          type: "text",
          text: expect.stringContaining(pinnedId),
          synthetic: true,
        },
        {
          id: expect.stringMatching(PART_ID),
          sessionID,
          messageID: MESSAGE_ID,
          type: "text",
          text: expect.stringContaining(relevantId),
          synthetic: true,
        },
      ]);
      const ids = first.parts.map(({ id }) => id);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(ids);
      for (const text of appendedTexts(first, userIds.length)) {
        expect(text.length).toBeLessThanOrEqual(CONTEXT_CHARS_MAX);
      }
      expect(second.parts).toHaveLength(1);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "appends the OpenCode dependency fix when the engine cannot load its storage",
    async () => {
      isolatedStore();
      vi.stubEnv("NODE_OPTIONS", `--require ${MISSING_DEPENDENCY}`);
      const sessionID = "ses_7c1d2e3f4a02AbCdEfGhIjKlMn";
      const hooks = await openPlugin();
      const output = chatOutput(sessionID, [
        userPart(sessionID, openCodeId(nowTicks(), "AbCdEfGhIjKlMn"), "hi"),
      ]);

      await hooks["chat.message"]!({ sessionID }, output);

      expect(appendedTexts(output, 1)).toEqual([
        expect.stringContaining("npm dependencies are not installed (missing better-sqlite3)"),
      ]);
      expect(appendedTexts(output, 1)[0]).toContain(
        `npm ci --ignore-scripts --omit=dev in ${PLUGIN_ROOT}`,
      );
    },
    SPAWNED_TIMEOUT_MS,
  );
});

describe("OpenCode tool.execute.after", () => {
  it.each([
    {
      tool: "bash",
      args: { command: "terraform apply -auto-approve", description: "Apply the plan" },
      metadata: { output: "Apply complete!", exit: 0, truncated: false },
      recalled: "command",
    },
    {
      tool: "read",
      args: { filePath: join(PROJECT, "billing", "tax.py") },
      metadata: { preview: "def tax():" },
      recalled: "file",
    },
    {
      tool: "edit",
      args: { filePath: "billing/tax.py", oldString: "round(", newString: "floor(" },
      metadata: { diagnostics: {} },
      recalled: "file",
    },
    {
      tool: "write",
      args: { filePath: join(PROJECT, "billing", "tax.py"), content: "def tax(): ..." },
      metadata: { exists: true },
      recalled: "file",
    },
  ] as const)(
    "appends the memory anchored on the $recalled a $tool call touched to its output",
    async ({ tool, args, metadata, recalled }) => {
      const config = isolatedStore();
      const commandMemoryId = newId();
      const fileMemoryId = newId();
      seedAnchoredMemory(config, {
        id: commandMemoryId,
        kind: "procedure",
        anchors: ["terraform apply"],
        abstract: "Run terraform plan and read it before every terraform apply",
      });
      seedAnchoredMemory(config, {
        id: fileMemoryId,
        kind: "procedure",
        anchors: ["billing/tax.py"],
        abstract: "Round tax per invoice line before summing",
      });
      const hooks = await openPlugin();
      const output = toolOutput(TOOL_RESULT, metadata);

      await afterTool(hooks, "ses_7c1d2e3f4b01AbCdEfGhIjKlMn", { tool, args }, output);

      expect(output).toEqual({
        title: "tool",
        output: expect.stringContaining(recalled === "command" ? commandMemoryId : fileMemoryId),
        metadata,
      });
      expect(appendedTo(output).startsWith(BLOCK_SEPARATOR)).toBe(true);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "records the memory_feedback receipt and verdicts as the Claude hook does, and closes signals on memory_store and memory_update",
    async () => {
      const config = isolatedStore();
      const claudeConfig = seedConfig(
        mkdtempSync(join(tmpdir(), "acm-opencode-claude-store-")),
        testModelCacheDir,
      );
      const feedbackSession = "ses_7c1d2e3f4b02AbCdEfGhIjKlMn";
      const updateSession = "ses_7c1d2e3f4b03AbCdEfGhIjKlMn";
      const usedId = newId();
      for (const store of [config, claudeConfig]) {
        seedAnchoredMemory(store, {
          id: usedId,
          kind: "fact",
          anchors: [],
          abstract: "The billing service deploys with make release",
        });
      }
      openRememberSignal(config, feedbackSession);
      openRememberSignal(config, updateSession);
      const hooks = await openPlugin();

      await afterTool(
        hooks,
        feedbackSession,
        { tool: "memory_memory_feedback", args: { used: [usedId] } },
        toolOutput("", {}),
      );
      await afterTool(
        hooks,
        feedbackSession,
        { tool: "memory_memory_store", args: { title: "Release freeze" } },
        toolOutput("", {}),
      );
      await afterTool(
        hooks,
        updateSession,
        { tool: "memory_memory_update", args: { id: usedId } },
        toolOutput("", {}),
      );
      const claude = await runProcess({
        command: process.execPath,
        args: [join(process.cwd(), "dist", "hooks.js")],
        env: { PATH: NODE_FIRST_PATH, ACM_DATA_DIR: claudeConfig.dataDir, ...testModelEnv },
        cwd: PROJECT,
        stdinText: JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: feedbackSession,
          cwd: PROJECT,
          tool_name: CLAUDE_FEEDBACK_TOOL,
          tool_input: { used: [usedId] },
        }),
        timeoutMs: HOOK_KILL_MS,
      });

      const receipts = "SELECT session_id AS sessionId FROM receipt_sessions";
      const verdicts =
        "SELECT session_id AS sessionId, memory_id AS memoryId, verdict FROM verdicts";
      expect(claude).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(storeRows(config, verdicts)).toEqual([
        { sessionId: feedbackSession, memoryId: usedId, verdict: "used" },
      ]);
      expect(storeRows(config, verdicts)).toEqual(storeRows(claudeConfig, verdicts));
      expect(storeRows(config, receipts)).toEqual(storeRows(claudeConfig, receipts));
      expect(
        storeRows(
          config,
          "SELECT session_id AS sessionId, closed_by AS closedBy FROM session_signals ORDER BY id",
        ),
      ).toEqual([
        { sessionId: feedbackSession, closedBy: "receipt" },
        { sessionId: updateSession, closedBy: "receipt" },
      ]);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "captures a bash failure only for a non-zero exit, and appends the same tool recall for every exit",
    async () => {
      const config = isolatedStore();
      const toolMemoryId = newId();
      const failureMemoryId = newId();
      seedAnchoredMemory(config, {
        id: toolMemoryId,
        kind: "procedure",
        anchors: [TEST_COMMAND_HEAD],
        abstract: "Run pytest with -x to stop at the first failure",
      });
      seedAnchoredMemory(config, {
        id: failureMemoryId,
        kind: "procedure",
        anchors: ["SQLITE_BUSY"],
        abstract: "Close the second sqlite connection before the test opens a writer",
      });
      const hooks = await openPlugin();
      const failed = bashOutput(1, LOCKED_DATABASE_OUTPUT);
      const passed = bashOutput(0, LOCKED_DATABASE_OUTPUT);
      const timedOut = bashOutput(null, `${LOCKED_DATABASE_OUTPUT}\n\n${TIMED_OUT_METADATA}`);
      const command = { tool: "bash", args: { command: TEST_COMMAND } };

      await afterTool(hooks, "ses_failed00000001AbCdEfGhIjKl", command, failed);
      await afterTool(hooks, "ses_passed00000001AbCdEfGhIjKl", command, passed);
      await afterTool(hooks, "ses_timedout000001AbCdEfGhIjKl", command, timedOut);

      const toolRecall = appendedTo(passed);
      expect(toolRecall).toContain(toolMemoryId);
      expect(toolRecall).not.toContain(failureMemoryId);
      expect(appendedTo(timedOut)).toBe(toolRecall);
      expect(appendedTo(failed).startsWith(`${toolRecall}${BLOCK_SEPARATOR}`)).toBe(true);
      expect(appendedTo(failed)).toContain(failureMemoryId);
      expect(
        storeRows(config, "SELECT session_id AS sessionId, head FROM command_failures"),
      ).toEqual([{ sessionId: "ses_failed00000001AbCdEfGhIjKl", head: TEST_COMMAND_HEAD }]);
      expect(storeRows(config, "SELECT session_id AS sessionId FROM failure_recalls")).toEqual([
        { sessionId: "ses_failed00000001AbCdEfGhIjKl" },
      ]);
      expect(storeRows(config, "SELECT id FROM session_signals")).toEqual([]);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "keeps a failed command unresolved through an unfinished run and resolves it on exit 0",
    async () => {
      const config = isolatedStore();
      const sessionID = "ses_resolve0000001AbCdEfGhIjKl";
      const hooks = await openPlugin();
      const command = { tool: "bash", args: { command: TEST_COMMAND } };
      const signals =
        "SELECT session_id AS sessionId, kind, detail, closed_at AS closedAt FROM session_signals";
      const failures = "SELECT session_id AS sessionId, head FROM command_failures";

      await afterTool(hooks, sessionID, command, bashOutput(1, LOCKED_DATABASE_OUTPUT));
      await afterTool(hooks, sessionID, command, bashOutput(null, TIMED_OUT_METADATA));
      const afterUnfinished = {
        signals: storeRows(config, signals),
        failures: storeRows(config, failures),
      };
      await afterTool(hooks, sessionID, command, bashOutput(0, "1 passed"));

      expect(afterUnfinished).toEqual({
        signals: [],
        failures: [{ sessionId: sessionID, head: TEST_COMMAND_HEAD }],
      });
      expect(storeRows(config, signals)).toEqual([
        { sessionId: sessionID, kind: "resolution", detail: TEST_COMMAND_HEAD, closedAt: null },
      ]);
      expect(storeRows(config, failures)).toEqual([]);
    },
    SPAWNED_TIMEOUT_MS,
  );
});

describe("OpenCode session.idle and compaction", () => {
  function idle(hooks: Hooks, sessionID: string): Promise<void> {
    return hooks.event!({ event: { type: "session.idle", properties: { sessionID } } });
  }

  it(
    "re-prompts once through the SDK client over three idle events with open signals",
    async () => {
      const config = isolatedStore();
      const sessionID = "ses_7c1d2e3f4c01AbCdEfGhIjKlMn";
      openRememberSignal(config, sessionID);
      const stub = promptAsyncStub();
      const hooks = await openPlugin(stub);

      await idle(hooks, sessionID);
      await idle(hooks, sessionID);
      await idle(hooks, sessionID);

      expect(stub.calls).toEqual([
        {
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: expect.stringContaining("memory_memory_store") }] },
        },
      ]);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "sends no re-prompt when the session has no open signals",
    async () => {
      isolatedStore();
      const stub = promptAsyncStub();
      const hooks = await openPlugin(stub);

      await idle(hooks, "ses_7c1d2e3f4c02AbCdEfGhIjKlMn");

      expect(stub.calls).toEqual([]);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "reports a re-prompt that resolves with an error once and checkpoints again on the next idle",
    async () => {
      const config = isolatedStore();
      const sessionID = "ses_7c1d2e3f4c03AbCdEfGhIjKlMn";
      openRememberSignal(config, sessionID);
      const stub = promptAsyncStub([{ error: { name: "BadRequest", data: { message: "busy" } } }]);
      const hooks = await openPlugin(stub);
      const stderr = stderrLines();

      await idle(hooks, sessionID);
      openRememberSignal(config, sessionID);
      await idle(hooks, sessionID);

      expect(stderr()).toEqual(["memory opencode session.idle failed: PromptAsyncError"]);
      expect(stub.calls).toHaveLength(2);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "pushes the post-compaction session recall to output.context and changes nothing else",
    async () => {
      const config = isolatedStore();
      const pinnedId = newId();
      seedAnchoredMemory(config, {
        id: pinnedId,
        kind: "constraint",
        anchors: [],
        abstract: "Never deploy the billing service during the release freeze",
      });
      const hooks = await openPlugin();
      const output = { context: ["existing context"] };

      await hooks["experimental.session.compacting"]!(
        { sessionID: "ses_7c1d2e3f4c04AbCdEfGhIjKlMn" },
        output,
      );

      expect(output).toEqual({
        context: ["existing context", expect.stringContaining(pinnedId)],
      });
    },
    SPAWNED_TIMEOUT_MS,
  );
});
