import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdaptiveCognitiveMemory } from "../opencode/adaptive-cognitive-memory";
import { type Config, DB_FILENAME } from "../src/cfg";
import { openDatabase } from "../src/db/database";
import type { HostId } from "../src/host";
import { newId, resolveProjectId } from "../src/ids";
import { estimateTokens } from "../src/inject";
import { testModelCacheDir, testModelEnv } from "../vitest.config";
import { runProcess, seedConfig, seedMemories, toolText } from "./fixtures/seed";

type ChatOutput = Parameters<NonNullable<Hooks["chat.message"]>>[1];

interface HostMemory {
  readonly title: string;
  readonly content: string;
  readonly conflictKey: string;
  readonly query: string;
}

const HOST_MEMORIES: Readonly<Record<HostId, HostMemory>> = {
  claude: {
    title: "Billing deploys pause during the release freeze",
    content: "Never deploy the billing service during the release freeze.",
    conflictKey: "deploy.release_freeze",
    query: "billing release freeze",
  },
  codex: {
    title: "Staging database snapshots run nightly at 02:00",
    content: "The staging database snapshot job runs nightly at 02:00 UTC.",
    conflictKey: "db.staging_snapshot_schedule",
    query: "staging database snapshot",
  },
  opencode: {
    title: "Payment webhooks retry five times with backoff",
    content: "Payment webhooks retry five times with exponential backoff.",
    conflictKey: "api.payment_webhook_retries",
    query: "payment webhook retry",
  },
};

const HOSTS: readonly HostId[] = ["claude", "codex", "opencode"];
const HOST_ENV: Readonly<Record<HostId, Readonly<Record<string, string>>>> = {
  claude: {},
  codex: { ACM_HOST: "codex" },
  opencode: { ACM_HOST: "opencode" },
};
const CODEX_FIELDS = { model: "gpt-5-codex", transcript_path: null, permission_mode: "default" };
const NEUTRAL_DATA_DIR_SEGMENTS = [".local", "share", "adaptive-cognitive-memory"] as const;
const SPAWNED_TIMEOUT_MS = 120_000;
const HOOK_KILL_MS = 25_000;
const MEMORY_TOOL_COUNT = 10;
const ALTERNATING_RUNS = 10;
const DEFAULT_BUDGET_TOKENS = 1_200;
const RAISED_BUDGET_TOKENS = 1_500;
const OUT_OF_RANGE_BUDGET_TOKENS = 2_376;
const BUDGET_OPTION = "CLAUDE_PLUGIN_OPTION_RECALL_BUDGET_TOKENS";
const PINNED_ROWS = 40;
const MESSAGE_ID = "msg_9a3f0c2b1001AbCdEfGhIjKlMn";
const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const NODE_FIRST_PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`;
const HOOKS_ENTRY = join(process.cwd(), "dist", "hooks.js");
const SERVER_ENTRY = join(process.cwd(), "dist", "server.js");
const clients: Client[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const client of clients.splice(0)) {
    await client.close();
  }
});

function gitProject(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "acm-shared-project-")));
  execFileSync("git", ["init", "-q", "-b", "main"], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", ...GIT_ISOLATION },
  });
  return dir;
}

const PROJECT = gitProject();
const PROJECT_ID = resolveProjectId(PROJECT);

function tempHome(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "acm-shared-home-")));
}

function neutralConfig(home: string): Config {
  const dataDir = join(home, ...NEUTRAL_DATA_DIR_SEGMENTS);
  mkdirSync(dataDir, { recursive: true });
  return seedConfig(dataDir, testModelCacheDir);
}

function neutralEnv(home: string, host: HostId, options: Record<string, string> = {}) {
  return {
    PATH: NODE_FIRST_PATH,
    HOME: home,
    ...GIT_ISOLATION,
    ...testModelEnv,
    ...HOST_ENV[host],
    ...options,
  };
}

function sqliteFiles(home: string): string[] {
  return readdirSync(home, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(DB_FILENAME))
    .map((path) => join(home, path));
}

async function startServer(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "acm-shared-check", version: "0.0.0" });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env,
      cwd: PROJECT,
      stderr: "pipe",
    }),
  );
  return client;
}

async function storeVia(client: Client, memory: HostMemory): Promise<string> {
  const stored = JSON.parse(
    toolText(
      await client.callTool({
        name: "memory_store",
        arguments: {
          title: memory.title,
          content: memory.content,
          type: "semantic",
          kind: "constraint",
          conflict_key: memory.conflictKey,
          cardinality: "single",
          value_text: memory.title,
          scope: "project",
          resolution: { action: "ADD" },
        },
      }),
    ),
  ) as { id?: string; action?: string };
  expect(stored).toEqual({ id: expect.any(String), action: "created" });
  return stored.id!;
}

async function searchIds(client: Client, query: string): Promise<string[]> {
  const found = JSON.parse(
    toolText(await client.callTool({ name: "memory_search", arguments: { query } })),
  ) as { results: { id: string }[] };
  return found.results.map(({ id }) => id);
}

function hookInput(host: HostId, sessionId: string, prompt: string | undefined) {
  if (host === "opencode") {
    return {
      hook_event_name: "chat.message",
      session_id: sessionId,
      cwd: PROJECT,
      prompt: prompt ?? "",
      session_start: prompt === undefined,
    };
  }
  const event =
    prompt === undefined
      ? { hook_event_name: "SessionStart", source: "startup" }
      : { hook_event_name: "UserPromptSubmit", prompt };
  const hostFields = host === "codex" ? CODEX_FIELDS : {};
  return { ...event, ...hostFields, session_id: sessionId, cwd: PROJECT };
}

async function hookContexts(
  env: Record<string, string>,
  host: HostId,
  sessionId: string,
  prompt?: string,
): Promise<string[]> {
  const result = await runProcess({
    command: process.execPath,
    args: [HOOKS_ENTRY],
    env,
    cwd: PROJECT,
    stdinText: JSON.stringify(hookInput(host, sessionId, prompt)),
    timeoutMs: HOOK_KILL_MS,
  });
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  if (result.stdout === "") {
    return [];
  }
  const output = JSON.parse(result.stdout) as {
    context?: string[];
    hookSpecificOutput?: { additionalContext: string };
  };
  return output.context ?? [output.hookSpecificOutput?.additionalContext ?? ""];
}

function seedPinnedMemories(config: Config, count: number): void {
  const opened = openDatabase(config);
  try {
    const insert = opened.db.prepare(
      `INSERT INTO memories (id, type, kind, anchors, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
       VALUES (?, 'pattern', 'preference', '[]', 'user', ?, ?, ?, 'body', 0.5, NULL, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
    );
    for (let index = 0; index < count; index += 1) {
      insert.run(newId(), PROJECT_ID, `budget ${index}`, `${"long abstract ".repeat(14)}${index}`);
    }
  } finally {
    opened.db.close();
  }
}

function vectorIndex(config: Config): { readonly tableRowid: number; readonly vectors: number } {
  const opened = openDatabase(config);
  try {
    const table = opened.db
      .prepare("SELECT rowid FROM sqlite_master WHERE name = 'memories_vec'")
      .get() as { rowid: number };
    const vectors = opened.db.prepare("SELECT count(*) AS n FROM memories_vec").get() as {
      n: number;
    };
    return { tableRowid: table.rowid, vectors: vectors.n };
  } finally {
    opened.db.close();
  }
}

function isolatePluginEnv(home: string, options: Record<string, string> = {}): void {
  for (const name of Object.keys(process.env).filter((key) => key.startsWith("CLAUDE_"))) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("ACM_DATA_DIR", undefined);
  vi.stubEnv("ACM_DB_PATH", undefined);
  vi.stubEnv("NODE_OPTIONS", undefined);
  vi.stubEnv("ACM_MODEL_CACHE_DIR", testModelEnv.ACM_MODEL_CACHE_DIR);
  vi.stubEnv("ACM_EMBED_DEADLINE_MS", testModelEnv.ACM_EMBED_DEADLINE_MS);
  for (const [name, value] of Object.entries(options)) {
    vi.stubEnv(name, value);
  }
}

async function openCodeSessionStart(sessionID: string): Promise<string[]> {
  const hooks = await AdaptiveCognitiveMemory({
    client: { session: { promptAsync: async () => ({}) } } as unknown as PluginInput["client"],
    project: { id: "acm-shared-test", worktree: PROJECT, vcs: "git", time: { created: 0 } },
    directory: PROJECT,
    worktree: PROJECT,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: undefined as unknown as PluginInput["$"],
  });
  const output: ChatOutput = {
    message: {
      id: MESSAGE_ID,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude" },
    },
    parts: [],
  };
  await hooks["chat.message"]!({ sessionID }, output);
  return output.parts.map((part) => (part.type === "text" ? part.text : ""));
}

describe("one store shared by Claude, Codex and OpenCode (FR-1)", () => {
  it(
    "finds what any host stored from every host's server and hooks, all in the one neutral memory.sqlite",
    async () => {
      const home = tempHome();
      const servers = new Map<HostId, Client>();
      for (const host of HOSTS) {
        servers.set(host, await startServer(neutralEnv(home, host)));
      }
      const storedIds = new Map<HostId, string>();
      const inodes = new Set<number>();
      const neutralDb = join(home, ...NEUTRAL_DATA_DIR_SEGMENTS, DB_FILENAME);
      for (const host of HOSTS) {
        storedIds.set(host, await storeVia(servers.get(host)!, HOST_MEMORIES[host]));
        inodes.add(statSync(neutralDb).ino);
      }

      const misses: string[] = [];
      for (const searcher of HOSTS) {
        for (const storer of HOSTS) {
          const found = await searchIds(servers.get(searcher)!, HOST_MEMORIES[storer].query);
          if (!found.includes(storedIds.get(storer)!)) {
            misses.push(`${searcher} search misses the ${storer} store`);
          }
        }
        const recalled = (await hookContexts(neutralEnv(home, searcher), searcher, "fr1")).join();
        for (const storer of HOSTS) {
          if (!recalled.includes(storedIds.get(storer)!)) {
            misses.push(`${searcher} hook misses the ${storer} store`);
          }
        }
        inodes.add(statSync(neutralDb).ino);
      }

      expect(misses).toEqual([]);
      expect(inodes.size).toBe(1);
      expect(sqliteFiles(home)).toEqual([neutralDb]);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "rebuilds no embedding index over ten alternating host runs (NFR-7)",
    async () => {
      const home = tempHome();
      const config = neutralConfig(home);
      await seedMemories(config, [
        {
          id: newId(),
          projectId: PROJECT_ID,
          scope: "project",
          type: "procedural",
          title: "Database migrations under load run in small batches",
          abstract: "Handle database migrations under load in batches of 500 rows",
          content: "Database migrations under load copy data in batches of 500 rows.",
          importance: 0.5,
        },
      ]);
      const before = vectorIndex(config);

      for (let run = 0; run < ALTERNATING_RUNS; run += 1) {
        const host = HOSTS[run % HOSTS.length]!;
        await hookContexts(
          neutralEnv(home, host),
          host,
          `nfr7-${run}`,
          "how should we handle database migrations under load",
        );
      }

      expect(before.vectors).toBe(1);
      expect(vectorIndex(config)).toEqual(before);
    },
    SPAWNED_TIMEOUT_MS,
  );
});

describe("recall budget option on Codex and OpenCode (FR-28)", () => {
  it(
    "fills a 1500-token session recall in the Codex hook and the OpenCode-spawned hook",
    async () => {
      const home = tempHome();
      seedPinnedMemories(neutralConfig(home), PINNED_ROWS);
      const option = { [BUDGET_OPTION]: String(RAISED_BUDGET_TOKENS) };
      isolatePluginEnv(home, option);

      const codexRecall = await hookContexts(neutralEnv(home, "codex", option), "codex", "fr28");
      const openCodeRecall = await openCodeSessionStart("ses_fr28000000001AbCdEfGhIjKl");

      for (const recall of [codexRecall, openCodeRecall]) {
        expect(recall).toHaveLength(1);
        expect(estimateTokens(recall[0]!)).toBeGreaterThan(DEFAULT_BUDGET_TOKENS);
        expect(estimateTokens(recall[0]!)).toBeLessThanOrEqual(RAISED_BUDGET_TOKENS);
      }
    },
    SPAWNED_TIMEOUT_MS,
  );

  it.each(["codex", "opencode"] as const)(
    "starts the %s server with a 1500-token budget and refuses one past the maximum",
    async (host) => {
      const home = tempHome();

      const accepted = await startServer(
        neutralEnv(home, host, { [BUDGET_OPTION]: String(RAISED_BUDGET_TOKENS) }),
      );
      const refused = await runProcess({
        command: process.execPath,
        args: [SERVER_ENTRY],
        env: neutralEnv(home, host, { [BUDGET_OPTION]: String(OUT_OF_RANGE_BUDGET_TOKENS) }),
        cwd: PROJECT,
        stdinText: "",
        timeoutMs: HOOK_KILL_MS,
      });

      expect((await accepted.listTools()).tools).toHaveLength(MEMORY_TOOL_COUNT);
      expect(refused).toEqual({
        code: 1,
        stdout: "",
        stderr: `${BUDGET_OPTION} must be an integer between 100 and 2375, got: ${OUT_OF_RANGE_BUDGET_TOKENS}\n`,
      });
    },
    SPAWNED_TIMEOUT_MS,
  );
});
