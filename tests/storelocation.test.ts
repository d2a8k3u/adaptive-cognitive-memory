import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Config, DB_FILENAME, loadConfig } from "../src/cfg";
import { runCli } from "../src/cli";
import { type OpenedDb, openDatabase } from "../src/db/database";
import { type HostId, hostProfile } from "../src/host";
import { newId, resolveProjectId } from "../src/ids";
import { createMcpServer, type ServerOptions, type ToolBackend } from "../src/server";
import {
  ensureDataDir,
  type LegacyFacts,
  legacyFacts,
  MOVED_MARKER_FILE,
  type StoreState,
  sourceMoved,
  storeConfig,
  storeNotice,
  storeState,
  writeMovedMarker,
} from "../src/storelocation";
import { testEmbedDeadlineMs, testModelCacheDir, testModelEnv } from "../vitest.config";
import {
  type ProcessResult,
  runProcess,
  seedConfig,
  type ToolCallResult,
  toolText,
} from "./fixtures/seed";

const MOVED_AT = "2026-10-30T00:00:00.000Z";
const DIGEST = "digest-of-the-moved-store";

const DATA_DIR = "/data/shared";
const DATA_DIR_REAL = "/real/data/shared";
const LEGACY_DIR = "/claude/plugin-data";
const ELSEWHERE = "/data/elsewhere";

function facts(overrides: Partial<LegacyFacts>): LegacyFacts {
  return {
    dir: LEGACY_DIR,
    hasDb: true,
    markerPresent: false,
    movedTo: undefined,
    movedToExists: false,
    dataDirRealPath: DATA_DIR_REAL,
    ...overrides,
  };
}

describe("storeState", () => {
  it.each<{ name: string; legacy: LegacyFacts | undefined; expected: StoreState }>([
    { name: "no legacy env", legacy: undefined, expected: { kind: "shared" } },
    {
      name: "a legacy dir that is the data dir",
      legacy: facts({ dir: `${DATA_DIR}/` }),
      expected: { kind: "shared" },
    },
    {
      name: "a legacy dir without a DB",
      legacy: facts({ hasDb: false }),
      expected: { kind: "shared" },
    },
    {
      name: "a legacy DB without a marker",
      legacy: facts({}),
      expected: { kind: "legacy", legacyDir: LEGACY_DIR },
    },
    {
      name: "a marker naming the data dir",
      legacy: facts({ markerPresent: true, movedTo: DATA_DIR_REAL, movedToExists: true }),
      expected: { kind: "shared" },
    },
    {
      name: "a marker naming another dir",
      legacy: facts({ markerPresent: true, movedTo: ELSEWHERE, movedToExists: true }),
      expected: { kind: "moved-elsewhere", movedTo: ELSEWHERE, targetExists: true },
    },
    {
      name: "a marker whose target is missing",
      legacy: facts({ markerPresent: true, movedTo: ELSEWHERE, movedToExists: false }),
      expected: { kind: "moved-elsewhere", movedTo: ELSEWHERE, targetExists: false },
    },
    {
      name: "a marker while the data dir does not exist",
      legacy: facts({
        markerPresent: true,
        movedTo: DATA_DIR_REAL,
        movedToExists: true,
        dataDirRealPath: undefined,
      }),
      expected: { kind: "moved-elsewhere", movedTo: DATA_DIR_REAL, targetExists: true },
    },
    {
      name: "an unreadable marker",
      legacy: facts({ markerPresent: true, movedTo: undefined }),
      expected: { kind: "shared" },
    },
  ])("is $expected.kind for $name", ({ legacy, expected }) => {
    expect(storeState(DATA_DIR, legacy)).toEqual(expected);
  });
});

const LEGACY: StoreState = { kind: "legacy", legacyDir: LEGACY_DIR };
const MOVED: StoreState = { kind: "moved-elsewhere", movedTo: ELSEWHERE, targetExists: true };
const MOVED_MISSING: StoreState = {
  kind: "moved-elsewhere",
  movedTo: ELSEWHERE,
  targetExists: false,
};

describe("storeConfig", () => {
  const sharedEnv = { ACM_DATA_DIR: DATA_DIR };
  const overrideEnv = {
    ...sharedEnv,
    ACM_DB_PATH: "/override/memory.sqlite",
    ACM_MODEL_CACHE_DIR: "/override/models",
  };

  it.each<{ name: string; state: StoreState; env: NodeJS.ProcessEnv; paths: Partial<Config> }>([
    {
      name: "the shared store",
      state: { kind: "shared" },
      env: sharedEnv,
      paths: {
        dataDir: "/data/shared",
        dbPath: "/data/shared/memory.sqlite",
        modelCacheDir: "/data/shared/models",
      },
    },
    {
      name: "the legacy store",
      state: LEGACY,
      env: sharedEnv,
      paths: {
        dataDir: "/claude/plugin-data",
        dbPath: "/claude/plugin-data/memory.sqlite",
        modelCacheDir: "/claude/plugin-data/models",
      },
    },
    {
      name: "the legacy store under path overrides",
      state: LEGACY,
      env: overrideEnv,
      paths: {
        dataDir: "/claude/plugin-data",
        dbPath: "/override/memory.sqlite",
        modelCacheDir: "/override/models",
      },
    },
    {
      name: "the store named by the marker",
      state: MOVED,
      env: sharedEnv,
      paths: {
        dataDir: "/data/elsewhere",
        dbPath: "/data/elsewhere/memory.sqlite",
        modelCacheDir: "/data/elsewhere/models",
      },
    },
    {
      name: "a marker whose store is missing",
      state: MOVED_MISSING,
      env: sharedEnv,
      paths: {
        dataDir: "/data/shared",
        dbPath: "/data/shared/memory.sqlite",
        modelCacheDir: "/data/shared/models",
      },
    },
  ])("points $name at its paths", ({ state, env, paths }) => {
    const config = loadConfig(env);

    expect(storeConfig(config, state, env)).toEqual({ ...config, ...paths });
  });
});

describe("storeNotice", () => {
  const cliEntry = join(process.cwd(), "dist", "cli.js");

  it.each<{ name: string; state: StoreState; notice: string | undefined }>([
    { name: "the shared store", state: { kind: "shared" }, notice: undefined },
    {
      name: "an unmoved legacy store",
      state: LEGACY,
      notice: `adaptive-cognitive-memory uses the Claude Code store in /claude/plugin-data; Codex and OpenCode use /data/shared. To share one store: with this plugin version installed, quit every Claude Code session, then run from a terminal: ACM_DATA_DIR="/data/shared" node "${cliEntry}" store move --from "/claude/plugin-data"`,
    },
    {
      name: "a store moved elsewhere",
      state: MOVED,
      notice:
        'adaptive-cognitive-memory: the Claude Code store was moved to /data/elsewhere, but ACM_DATA_DIR resolves to /data/shared; this session uses /data/elsewhere. Set ACM_DATA_DIR="/data/elsewhere" for Claude Code, Codex and OpenCode.',
    },
    {
      name: "a store moved to a missing dir",
      state: MOVED_MISSING,
      notice:
        "adaptive-cognitive-memory: the Claude Code store was moved to /data/elsewhere, which does not exist; memory is off for this session. Set ACM_DATA_DIR to the directory that holds the moved store.",
    },
  ])("tells $name", ({ state, notice }) => {
    expect(storeNotice(state, DATA_DIR)).toBe(notice);
  });
});

describe("ensureDataDir", () => {
  it("creates the data dir with its missing parents, open to the owner only", () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "acm-ensure-")), "share", "memory");

    ensureDataDir(loadConfig({ ACM_DATA_DIR: dataDir }));

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });
});

interface Layout {
  readonly root: string;
  readonly legacyDir: string;
  readonly dataDir: string;
  readonly elsewhere: string;
}

function layout(): Layout {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-location-")));
  const paths = {
    root,
    legacyDir: join(root, "legacy"),
    dataDir: join(root, "data"),
    elsewhere: join(root, "elsewhere"),
  };
  for (const dir of [paths.legacyDir, paths.dataDir, paths.elsewhere]) {
    mkdirSync(dir);
  }
  writeFileSync(join(paths.legacyDir, DB_FILENAME), "");
  return paths;
}

describe("legacyFacts read from disk", () => {
  it.each<{
    name: string;
    host: HostId;
    legacyEnv: (paths: Layout) => string;
    marker: ((paths: Layout) => string) | undefined;
    expected: (paths: Layout) => StoreState;
  }>([
    {
      name: "a host without a legacy store",
      host: "codex",
      legacyEnv: (paths) => paths.legacyDir,
      marker: undefined,
      expected: () => ({ kind: "shared" }),
    },
    {
      name: "a legacy DB without a marker",
      host: "claude",
      legacyEnv: (paths) => paths.legacyDir,
      marker: undefined,
      expected: (paths) => ({ kind: "legacy", legacyDir: paths.legacyDir }),
    },
    {
      name: "a marker that is not JSON",
      host: "claude",
      legacyEnv: (paths) => paths.legacyDir,
      marker: () => "{not json",
      expected: () => ({ kind: "shared" }),
    },
    {
      name: "a marker without a string movedTo",
      host: "claude",
      legacyEnv: (paths) => paths.legacyDir,
      marker: () => JSON.stringify({ movedTo: 42 }),
      expected: () => ({ kind: "shared" }),
    },
    {
      name: "a marker with a relative movedTo",
      host: "claude",
      legacyEnv: (paths) => paths.legacyDir,
      marker: () => JSON.stringify({ movedTo: "relative/data" }),
      expected: () => ({ kind: "shared" }),
    },
    {
      name: "a marker naming another dir",
      host: "claude",
      legacyEnv: (paths) => paths.legacyDir,
      marker: (paths) => JSON.stringify({ movedTo: paths.elsewhere }),
      expected: (paths) => ({
        kind: "moved-elsewhere",
        movedTo: paths.elsewhere,
        targetExists: true,
      }),
    },
    {
      name: "a marker naming a missing dir",
      host: "claude",
      legacyEnv: (paths) => paths.legacyDir,
      marker: (paths) => JSON.stringify({ movedTo: join(paths.elsewhere, "gone") }),
      expected: (paths) => ({
        kind: "moved-elsewhere",
        movedTo: join(paths.elsewhere, "gone"),
        targetExists: false,
      }),
    },
  ])("gives $name its store state", ({ host, legacyEnv, marker, expected }) => {
    const paths = layout();
    if (marker !== undefined) {
      writeFileSync(join(paths.legacyDir, MOVED_MARKER_FILE), marker(paths));
    }
    const env = { CLAUDE_PLUGIN_DATA: legacyEnv(paths) };

    const facts = legacyFacts(hostProfile(host), env, paths.dataDir);

    expect(storeState(paths.dataDir, facts)).toEqual(expected(paths));
  });

  it("gives an empty CLAUDE_PLUGIN_DATA no legacy store, so the working directory never becomes one", () => {
    const paths = layout();

    expect(
      legacyFacts(hostProfile("claude"), { CLAUDE_PLUGIN_DATA: "" }, paths.dataDir),
    ).toBeUndefined();
  });

  it("reads the marker writeMovedMarker wrote for a data dir reached through a symlink as shared", () => {
    const paths = layout();
    const linkedDataDir = join(paths.root, "data-link");
    symlinkSync(paths.dataDir, linkedDataDir);
    writeMovedMarker(paths.legacyDir, realpathSync(linkedDataDir), DIGEST, MOVED_AT);

    const facts = legacyFacts(
      hostProfile("claude"),
      { CLAUDE_PLUGIN_DATA: paths.legacyDir },
      linkedDataDir,
    );

    expect(storeState(linkedDataDir, facts)).toEqual({ kind: "shared" });
  });

  it("sees the source as moved once writeMovedMarker published the marker, with no temp file left", () => {
    const paths = layout();
    expect(sourceMoved(paths.legacyDir)).toBe(false);

    writeMovedMarker(paths.legacyDir, paths.dataDir, DIGEST, MOVED_AT);

    expect(sourceMoved(paths.legacyDir)).toBe(true);
    expect(readdirSync(paths.legacyDir).sort()).toEqual([DB_FILENAME, MOVED_MARKER_FILE]);
    expect(readFileSync(join(paths.legacyDir, MOVED_MARKER_FILE), "utf8")).toBe(
      `${JSON.stringify({ version: 1, movedTo: paths.dataDir, movedAt: MOVED_AT, digest: DIGEST })}\n`,
    );
  });
});

const HOOK_KILL_MS = 25_000;
const SPAWNED_TIMEOUT_MS = 60_000;
const PROJECT_DIR = realpathSync(mkdtempSync(join(tmpdir(), "acm-location-project-")));
const PROJECT_ID = resolveProjectId(PROJECT_DIR);
const STORE_TOOL = "mcp__plugin_adaptive-cognitive-memory_memory__memory_store";
const PINNED_ABSTRACT = "never push to the main branch directly, open a pull request";
const LEGACY_ONLY_ABSTRACT = "this line lives only in the store left behind by the move";

function seededStore(dir: string, abstract: string): string {
  mkdirSync(dir, { recursive: true });
  const id = newId();
  const opened = openDatabase(seedConfig(dir, testModelCacheDir));
  try {
    opened.db
      .prepare(
        `INSERT INTO memories (id, type, kind, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
         VALUES (?, 'semantic', 'constraint', 'project', ?, 'main branch', ?, 'body', 0.7, NULL, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
      )
      .run(id, PROJECT_ID, abstract);
  } finally {
    opened.db.close();
  }
  return id;
}

function openRememberSignal(dir: string, sessionId: string): void {
  const opened = openDatabase(seedConfig(dir, testModelCacheDir));
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

function storeRows<T>(dir: string, sql: string): T[] {
  const opened = openDatabase(seedConfig(dir, testModelCacheDir));
  try {
    return opened.db.prepare(sql).all() as T[];
  } finally {
    opened.db.close();
  }
}

function claudeEnv(legacyDir: string, dataDir: string): Record<string, string> {
  return {
    CLAUDE_PLUGIN_DATA: legacyDir,
    ACM_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "acm-location-claude-")),
    ...testModelEnv,
  };
}

function hook(env: NodeJS.ProcessEnv, input: Record<string, unknown>): Promise<ProcessResult> {
  return runProcess({
    command: process.execPath,
    args: [join(process.cwd(), "dist", "hooks.js")],
    env,
    stdinText: JSON.stringify({ cwd: PROJECT_DIR, ...input }),
    timeoutMs: HOOK_KILL_MS,
  });
}

interface StartOutput {
  readonly systemMessage: string;
  readonly hookSpecificOutput: { readonly additionalContext: string };
}

function sessionStartOutput(result: ProcessResult): StartOutput {
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  return JSON.parse(result.stdout) as StartOutput;
}

describe("Claude hooks by store location", () => {
  it(
    "keep an unmoved legacy store in use, with the move notice, and create nothing in the data dir",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-location-legacy-")));
      const legacyDir = join(root, "legacy");
      const dataDir = join(root, "shared");
      seededStore(legacyDir, PINNED_ABSTRACT);
      openRememberSignal(legacyDir, "session-receipt");
      openRememberSignal(legacyDir, "session-stop");
      const env = claudeEnv(legacyDir, dataDir);

      const start = await hook(env, {
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: "session-start",
      });
      const prompt = await hook(env, {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-start",
        prompt: "how do we push changes to the main branch",
      });
      const receipt = await hook(env, {
        hook_event_name: "PostToolUse",
        session_id: "session-receipt",
        tool_name: STORE_TOOL,
        tool_input: {},
      });
      const stop = await hook(env, {
        hook_event_name: "Stop",
        session_id: "session-stop",
        stop_hook_active: false,
      });

      const started = sessionStartOutput(start);
      expect(started.systemMessage).toBe(storeNotice({ kind: "legacy", legacyDir }, dataDir));
      expect(started.hookSpecificOutput.additionalContext).toContain(PINNED_ABSTRACT);
      expect([prompt, receipt].map(({ code, stderr }) => ({ code, stderr }))).toEqual([
        { code: 0, stderr: "" },
        { code: 0, stderr: "" },
      ]);
      expect(stop.stdout).toContain('the user asked you to remember \\"the release freeze\\"');
      expect(
        storeRows(legacyDir, "SELECT event FROM recall_events ORDER BY id").map(
          (row) => (row as { event: string }).event,
        ),
      ).toEqual(["SessionStart", "UserPromptSubmit"]);
      expect(
        storeRows(
          legacyDir,
          "SELECT session_id AS sessionId, closed_by AS closedBy FROM session_signals ORDER BY id",
        ),
      ).toEqual([
        { sessionId: "session-receipt", closedBy: "receipt" },
        { sessionId: "session-stop", closedBy: "checkpoint" },
      ]);
      expect(existsSync(dataDir)).toBe(false);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "serve the store the marker names, with its notice, when ACM_DATA_DIR resolves elsewhere",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-location-moved-")));
      const legacyDir = join(root, "legacy");
      const movedTo = join(root, "moved");
      const dataDir = join(root, "shared");
      seededStore(legacyDir, LEGACY_ONLY_ABSTRACT);
      seededStore(movedTo, PINNED_ABSTRACT);
      writeMovedMarker(legacyDir, movedTo, DIGEST, MOVED_AT);

      const start = await hook(claudeEnv(legacyDir, dataDir), {
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: "session-moved",
      });

      const started = sessionStartOutput(start);
      expect(started.systemMessage).toBe(
        storeNotice({ kind: "moved-elsewhere", movedTo, targetExists: true }, dataDir),
      );
      expect(started.hookSpecificOutput.additionalContext).toContain(PINNED_ABSTRACT);
      expect(started.hookSpecificOutput.additionalContext).not.toContain(LEGACY_ONLY_ABSTRACT);
      expect(existsSync(dataDir)).toBe(false);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "turn memory off with only the notice when the marker names a missing store",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-location-gone-")));
      const legacyDir = join(root, "legacy");
      const movedTo = join(root, "gone");
      const dataDir = join(root, "shared");
      seededStore(legacyDir, LEGACY_ONLY_ABSTRACT);
      writeMovedMarker(legacyDir, movedTo, DIGEST, MOVED_AT);
      const env = claudeEnv(legacyDir, dataDir);

      const start = await hook(env, {
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: "session-gone",
      });
      const prompt = await hook(env, {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-gone",
        prompt: "how do we push changes to the main branch",
      });

      const notice = storeNotice(
        { kind: "moved-elsewhere", movedTo, targetExists: false },
        dataDir,
      );
      expect(start).toEqual({
        code: 0,
        stdout: `${JSON.stringify({ systemMessage: notice })}\n`,
        stderr: "",
      });
      expect(prompt).toEqual({ code: 0, stdout: "", stderr: "" });
      expect([existsSync(dataDir), existsSync(movedTo)]).toEqual([false, false]);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "create the shared data dir, open to the owner only, before the first store opens there",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-location-fresh-")));
      const pluginDataWithoutStore = join(root, "plugin-data");
      mkdirSync(pluginDataWithoutStore);
      const dataDir = join(root, "share", "adaptive-cognitive-memory");

      const start = await hook(claudeEnv(pluginDataWithoutStore, dataDir), {
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: "session-fresh",
      });

      expect({ code: start.code, stderr: start.stderr }).toEqual({ code: 0, stderr: "" });
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(existsSync(join(dataDir, DB_FILENAME))).toBe(true);
    },
    SPAWNED_TIMEOUT_MS,
  );
});

const SERVER_ENTRY = join(process.cwd(), "dist", "server.js");
const OWNER_ONLY = 0o700;
const clients: Client[] = [];
const openedStores: OpenedDb[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const opened of openedStores.splice(0)) {
    opened.db.close();
  }
  vi.restoreAllMocks();
});

async function spawnedServer(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "acm-location-check", version: "0.0.0" });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: { PATH: process.env.PATH ?? "", ...env },
      cwd: PROJECT_DIR,
      stderr: "pipe",
    }),
  );
  return client;
}

async function inProcessServer(initial: ToolBackend, options: ServerOptions): Promise<Client> {
  const server = createMcpServer(initial, options);
  const client = new Client({ name: "acm-location-switch", version: "0.0.0" });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function storeBackend(dir: string): ToolBackend {
  const config = seedConfig(dir, testModelCacheDir);
  const opened = openDatabase(config);
  openedStores.push(opened);
  return {
    available: true,
    deps: {
      env: { db: opened.db, vecLoaded: opened.vecLoaded, modelCacheDir: config.modelCacheDir },
      projectId: PROJECT_ID,
      embedDeadlineMs: testEmbedDeadlineMs,
      processEnv: {},
      instructionSources: { projectDir: PROJECT_DIR, autoMemoryIndex: undefined },
    },
  };
}

function toolValue(result: ToolCallResult): unknown {
  return JSON.parse(toolText(result));
}

async function memoryGet(client: Client, id: string): Promise<unknown> {
  return toolValue(
    (await client.callTool({ name: "memory_get", arguments: { id } })) as ToolCallResult,
  );
}

interface MovedStores {
  readonly legacyDir: string;
  readonly dataDir: string;
  readonly legacyId: string;
  readonly sharedId: string;
}

function movedStores(): MovedStores {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-location-switch-")));
  const legacyDir = join(root, "legacy");
  const dataDir = join(root, "shared");
  return {
    legacyDir,
    dataDir,
    legacyId: seededStore(legacyDir, LEGACY_ONLY_ABSTRACT),
    sharedId: seededStore(dataDir, PINNED_ABSTRACT),
  };
}

const FROM_LEGACY = expect.objectContaining({ abstract: LEGACY_ONLY_ABSTRACT });
const FROM_SHARED = expect.objectContaining({ abstract: PINNED_ABSTRACT });

describe("MCP server by store location", () => {
  it(
    "serves an unmoved legacy store, with the move notice in its instructions and memory_status, and creates nothing in the data dir",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-location-server-legacy-")));
      const legacyDir = join(root, "legacy");
      const dataDir = join(root, "shared");
      mkdirSync(legacyDir);
      openDatabase(seedConfig(legacyDir, testModelCacheDir)).db.close();
      const client = await spawnedServer(claudeEnv(legacyDir, dataDir));

      const status = toolValue(
        (await client.callTool({ name: "memory_status", arguments: {} })) as ToolCallResult,
      );
      const stored = toolValue(
        (await client.callTool({
          name: "memory_store",
          arguments: {
            title: "release freeze",
            content: "Releases freeze on Fridays. Nothing deploys after noon.",
            type: "semantic",
            kind: "fact",
            conflict_key: "project.release_freeze",
          },
        })) as ToolCallResult,
      );

      const notice = storeNotice({ kind: "legacy", legacyDir }, dataDir);
      expect(client.getInstructions()).toBe(notice);
      expect(status).toMatchObject({ store_move: { state: "legacy", notice } });
      expect(stored).toMatchObject({ action: "created" });
      expect(storeRows(legacyDir, "SELECT title FROM memories")).toEqual([
        { title: "release freeze" },
      ]);
      expect(existsSync(dataDir)).toBe(false);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "creates the shared data dir, open to the owner only, and carries no store notice in the shared state",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-location-server-fresh-")));
      const dataDir = join(root, "share", "adaptive-cognitive-memory");
      const client = await spawnedServer({
        ACM_DATA_DIR: dataDir,
        CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "acm-location-claude-")),
        ...testModelEnv,
      });

      const status = toolValue(
        (await client.callTool({ name: "memory_status", arguments: {} })) as ToolCallResult,
      );

      expect(client.getInstructions()).toBeUndefined();
      expect(status).not.toHaveProperty("store_move");
      expect(statSync(dataDir).mode & 0o777).toBe(OWNER_ONLY);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it(
    "turns memory off with the move notice when the marker names a missing store, and creates nothing",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-location-server-gone-")));
      const legacyDir = join(root, "legacy");
      const movedTo = join(root, "gone");
      const dataDir = join(root, "shared");
      seededStore(legacyDir, LEGACY_ONLY_ABSTRACT);
      writeMovedMarker(legacyDir, movedTo, DIGEST, MOVED_AT);
      const client = await spawnedServer(claudeEnv(legacyDir, dataDir));

      const search = (await client.callTool({
        name: "memory_search",
        arguments: { query: "main branch" },
      })) as ToolCallResult;

      expect(client.getInstructions()).toBe(
        storeNotice({ kind: "moved-elsewhere", movedTo, targetExists: false }, dataDir),
      );
      expect({ isError: search.isError, value: toolValue(search) }).toEqual({
        isError: true,
        value: {
          error: {
            message: `memory unavailable: the moved store ${movedTo} does not exist. Fix: set ACM_DATA_DIR to the directory that holds the moved store.`,
          },
        },
      });
      expect([existsSync(dataDir), existsSync(movedTo)]).toEqual([false, false]);
    },
    SPAWNED_TIMEOUT_MS,
  );

  it("opens the moved store once for two concurrent calls after the marker appears", async () => {
    const stores = movedStores();
    const open = vi.fn(() => storeBackend(stores.dataDir));
    const client = await inProcessServer(storeBackend(stores.legacyDir), {
      afterMove: { legacyDir: stores.legacyDir, open },
    });
    writeMovedMarker(stores.legacyDir, stores.dataDir, DIGEST, MOVED_AT);

    const served = await Promise.all([
      memoryGet(client, stores.sharedId),
      memoryGet(client, stores.sharedId),
    ]);

    expect(served).toEqual([FROM_SHARED, FROM_SHARED]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("answers the call that finds the marker with the switch error when the moved store fails to open, and retries on the next call", async () => {
    const stores = movedStores();
    const open = vi
      .fn<() => ToolBackend>()
      .mockImplementationOnce(() => {
        throw new Error("EACCES: permission denied");
      })
      .mockImplementation(() => storeBackend(stores.dataDir));
    const client = await inProcessServer(storeBackend(stores.legacyDir), {
      afterMove: { legacyDir: stores.legacyDir, open },
    });
    writeMovedMarker(stores.legacyDir, stores.dataDir, DIGEST, MOVED_AT);

    const failed = (await client.callTool({
      name: "memory_get",
      arguments: { id: stores.legacyId },
    })) as ToolCallResult;
    const retried = await memoryGet(client, stores.sharedId);

    expect({ isError: failed.isError, value: toolValue(failed) }).toEqual({
      isError: true,
      value: {
        error: { message: "memory could not switch to the moved store: EACCES: permission denied" },
      },
    });
    expect(retried).toEqual(FROM_SHARED);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("checks for the marker with one existsSync per call until the switch, and never after it", async () => {
    const stores = movedStores();
    const marker = join(stores.legacyDir, MOVED_MARKER_FILE);
    const client = await inProcessServer(storeBackend(stores.legacyDir), {
      afterMove: { legacyDir: stores.legacyDir, open: () => storeBackend(stores.dataDir) },
    });
    const exists = vi.spyOn(fs, "existsSync");
    syncBuiltinESMExports();
    try {
      const beforeMove = [
        await memoryGet(client, stores.legacyId),
        await memoryGet(client, stores.legacyId),
      ];
      writeMovedMarker(stores.legacyDir, stores.dataDir, DIGEST, MOVED_AT);
      const afterMove = [
        await memoryGet(client, stores.sharedId),
        await memoryGet(client, stores.sharedId),
        await memoryGet(client, stores.sharedId),
      ];

      expect(beforeMove).toEqual([FROM_LEGACY, FROM_LEGACY]);
      expect(afterMove).toEqual([FROM_SHARED, FROM_SHARED, FROM_SHARED]);
      expect(exists.mock.calls.filter(([path]) => path === marker)).toHaveLength(3);
    } finally {
      exists.mockRestore();
      syncBuiltinESMExports();
    }
  });
});

describe("CLI by store location", () => {
  it("switches recall in the unmoved legacy store and creates nothing in the data dir", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-location-cli-legacy-")));
    const legacyDir = join(root, "legacy");
    const dataDir = join(root, "shared");
    seededStore(legacyDir, PINNED_ABSTRACT);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(
      ["node", "cli.js", "recall", "on"],
      claudeEnv(legacyDir, dataDir),
      PROJECT_DIR,
    );

    expect(code).toBe(0);
    expect(
      storeRows(
        legacyDir,
        "SELECT project_id AS projectId, recall_enabled AS recallEnabled FROM project_settings",
      ),
    ).toEqual([{ projectId: PROJECT_ID, recallEnabled: 1 }]);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("refuses a store command with the notice when the marker names a missing store, and creates nothing", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-location-cli-gone-")));
    const legacyDir = join(root, "legacy");
    const movedTo = join(root, "gone");
    const dataDir = join(root, "shared");
    const exportFile = join(root, "backup.jsonl");
    seededStore(legacyDir, LEGACY_ONLY_ABSTRACT);
    writeMovedMarker(legacyDir, movedTo, DIGEST, MOVED_AT);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(
      ["node", "cli.js", "export", exportFile],
      claudeEnv(legacyDir, dataDir),
      PROJECT_DIR,
    );

    expect(code).toBe(1);
    expect(errors.mock.calls).toEqual([
      [storeNotice({ kind: "moved-elsewhere", movedTo, targetExists: false }, dataDir)],
    ]);
    expect([existsSync(dataDir), existsSync(movedTo), existsSync(exportFile)]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("creates the shared data dir, open to the owner only, before a store command opens the store there", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-location-cli-fresh-")));
    const dataDir = join(root, "share", "adaptive-cognitive-memory");
    vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(
      ["node", "cli.js", "recall", "on"],
      { ACM_DATA_DIR: dataDir, ...testModelEnv },
      PROJECT_DIR,
    );

    expect(code).toBe(0);
    expect(statSync(dataDir).mode & 0o777).toBe(OWNER_ONLY);
  });
});
