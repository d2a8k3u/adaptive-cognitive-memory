import fs, {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DB_FILENAME } from "../src/cfg";
import { runCli } from "../src/cli";
import { openDatabase } from "../src/db/database";
import { type StoreDigest, storeDigest } from "../src/db/digest";
import { unembeddedActiveCount } from "../src/db/memories";
import { resolveProjectId } from "../src/ids";
import { snippetLine, statuslinePaths } from "../src/statusline";
import { MOVED_MARKER_FILE } from "../src/storelocation";
import {
  hasRoom,
  type MoveFacts,
  type MovePlan,
  type MoveStep,
  moveStore,
  planMove,
} from "../src/storemove";
import { testModelCacheDir, testModelEnv } from "../vitest.config";
import {
  digestOfStore,
  fileHashes,
  integrityOf,
  type LegacyStore,
  type ProcessResult,
  runProcess,
  seedConfig,
  seedLegacyStore,
  sourceChanges,
  type ToolCallResult,
  toolText,
} from "./fixtures/seed";

const PROJECT_ID = "0123456789abcdef";
const PINNED_ABSTRACT = "never push to the main branch directly, open a pull request";
const DATA_DIR = "/data/shared";
const SOURCE_REAL = "/real/claude/plugin-data";
const ELSEWHERE = "/data/elsewhere";
const NOW = "2026-10-30T12:00:00.000Z";
const LATER = "2026-10-30T13:00:00.000Z";
const STAGING_DIR = ".moving";
const LOCK_HOLD_BUDGET_MS = 2_500;
const MOVE_BUDGET_MS = 10_000;
const TWELVE_MB = 12 * 1024 * 1024;
const SPAWNED_TIMEOUT_MS = 90_000;
const HOOK_KILL_MS = 25_000;

function moveFacts(overrides: Partial<MoveFacts>): MoveFacts {
  return {
    dataDir: DATA_DIR,
    sameDir: false,
    sourceHasDb: true,
    sourceMovedTo: undefined,
    destHasDb: false,
    journalSource: undefined,
    sourceRealPath: SOURCE_REAL,
    ...overrides,
  };
}

describe("planMove", () => {
  it.each<{ readonly facts: Partial<MoveFacts>; readonly plan: MovePlan }>([
    {
      facts: { sameDir: true, sourceHasDb: false, sourceMovedTo: DATA_DIR, destHasDb: true },
      plan: { kind: "refuse", reason: "source and destination are the same directory" },
    },
    {
      facts: { sourceHasDb: false, sourceMovedTo: DATA_DIR, destHasDb: true },
      plan: { kind: "refuse", reason: `no memory.sqlite in ${SOURCE_REAL}` },
    },
    {
      facts: { sourceMovedTo: ELSEWHERE, destHasDb: true },
      plan: { kind: "already-moved", movedTo: ELSEWHERE },
    },
    {
      facts: { sourceMovedTo: ELSEWHERE, destHasDb: false, journalSource: SOURCE_REAL },
      plan: {
        kind: "refuse",
        reason: `source is marked as moved to ${ELSEWHERE}, but ${DATA_DIR} has no store`,
      },
    },
    {
      facts: { destHasDb: true, journalSource: SOURCE_REAL },
      plan: { kind: "resume-publish" },
    },
    {
      facts: { destHasDb: true, journalSource: ELSEWHERE },
      plan: {
        kind: "refuse",
        reason: `a store already exists in ${DATA_DIR}; move it aside and run the move again (docs/storage.md)`,
      },
    },
    { facts: { journalSource: SOURCE_REAL }, plan: { kind: "start" } },
  ])("plans $plan.kind for $facts", ({ facts, plan }) => {
    expect(planMove(moveFacts(facts))).toEqual(plan);
  });
});

describe("hasRoom", () => {
  it("needs the free bytes to reach the needed bytes exactly", () => {
    expect([hasRoom(100, 100), hasRoom(99, 100)]).toEqual([true, false]);
  });
});

const stores: LegacyStore[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const store of stores.splice(0)) {
    store.anchor.close();
  }
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

function tempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function legacyStore(
  root: string,
  memories: number,
  contentChars: number,
  projectId: string = PROJECT_ID,
): LegacyStore {
  const store = seedLegacyStore(join(root, "legacy"), {
    memories,
    contentChars,
    projectId,
    pinnedAbstract: PINNED_ABSTRACT,
  });
  stores.push(store);
  return store;
}

function moveConfig(dataDir: string) {
  return seedConfig(dataDir, testModelCacheDir);
}

function movedMarker(legacyDir: string): unknown {
  return JSON.parse(readFileSync(join(legacyDir, MOVED_MARKER_FILE), "utf8"));
}

function rowsOf(digest: StoreDigest, table: string): number {
  return digest.tables.find((entry) => entry.table === table)?.rows ?? Number.NaN;
}

function totalRows(digest: StoreDigest): number {
  return digest.tables.reduce((sum, table) => sum + table.rows, 0);
}

function metaRows(db: Database.Database): unknown[] {
  return db.prepare("SELECT key, value FROM meta ORDER BY key").all();
}

function sizeOfTree(path: string): number {
  const stats = statSync(path);
  return stats.isDirectory()
    ? readdirSync(path).reduce((sum, name) => sum + sizeOfTree(join(path, name)), 0)
    : stats.size;
}

function corruptTableRoot(dbPath: string, table: string): void {
  const db = new Database(dbPath, { readonly: true });
  const rootPage = db
    .prepare("SELECT rootpage FROM sqlite_schema WHERE name = ?")
    .pluck()
    .get(table) as number;
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  db.close();
  const fd = openSync(dbPath, "r+");
  try {
    writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, (rootPage - 1) * pageSize + 8);
  } finally {
    closeSync(fd);
  }
}

function checkpointedStore(root: string): LegacyStore {
  const store = seedLegacyStore(join(root, "legacy"), {
    memories: 40,
    contentChars: 200,
    projectId: PROJECT_ID,
    pinnedAbstract: PINNED_ABSTRACT,
  });
  store.anchor.close();
  const checkpointer = new Database(store.dbPath);
  checkpointer.pragma("wal_checkpoint(TRUNCATE)");
  checkpointer.close();
  expect(existsSync(`${store.dbPath}-wal`)).toBe(false);
  return store;
}

function byteCopyWithWal(store: LegacyStore, dir: string): string {
  mkdirSync(dir);
  const copy = join(dir, DB_FILENAME);
  copyFileSync(store.dbPath, copy, constants.COPYFILE_FICLONE);
  copyFileSync(`${store.dbPath}-wal`, `${copy}-wal`, constants.COPYFILE_FICLONE);
  return copy;
}

describe("storeDigest", () => {
  it("is equal for a byte copy with its WAL replayed and differs once one row changes", () => {
    const root = tempRoot("acm-digest-");
    const store = legacyStore(root, 30, 100);
    const copyPath = byteCopyWithWal(store, join(root, "copy"));
    const copy = new Database(copyPath);
    try {
      const source = storeDigest(store.anchor);
      const replayed = storeDigest(copy);
      copy.prepare("DELETE FROM verdicts WHERE rowid = (SELECT min(rowid) FROM verdicts)").run();
      const edited = storeDigest(copy);

      expect(replayed).toEqual(source);
      expect(edited.sha256).not.toBe(source.sha256);
      expect(
        edited.tables.filter(
          (table) => table.sha256 !== source.tables.find((t) => t.table === table.table)?.sha256,
        ),
      ).toEqual([
        {
          table: "verdicts",
          rows: (source.tables.find((t) => t.table === "verdicts")?.rows ?? 0) - 1,
          sha256: expect.any(String),
        },
      ]);
    } finally {
      copy.close();
    }
  });

  it("covers every ordinary table including the FTS and vec shadow tables, in name order, and skips virtual and sqlite_ tables", () => {
    const root = tempRoot("acm-digest-tables-");
    const store = legacyStore(root, 3, 100);

    const digest = storeDigest(store.anchor);
    const names = digest.tables.map((table) => table.table);

    expect(names).toEqual([...names].sort());
    expect(names).toEqual(expect.arrayContaining(["memories_fts_idx", "memories_vec_chunks"]));
    expect(names.filter((name) => name.startsWith("sqlite_"))).toEqual([]);
    expect(names).not.toContain("memories_vec");
    expect(names).not.toContain("memories_fts");
    expect(digest.tables.find((table) => table.table === "memories")?.rows).toBe(5);
  });
});

describe("moveStore", () => {
  it("moves at least 1,000 memories with their relations, verdicts, transitions and session rows losslessly, leaving the source byte-identical plus moved.json", () => {
    const root = tempRoot("acm-move-lossless-");
    const store = legacyStore(root, 1000, 300);
    const dataDir = join(root, "shared");
    const sourceDigest = storeDigest(store.anchor);
    const sourceMeta = metaRows(store.anchor);
    store.anchor.close();
    const before = fileHashes(store.dir);
    expect(statSync(`${store.dbPath}-wal`).size).toBeGreaterThan(0);

    const outcome = moveStore(store.dir, moveConfig(dataDir), NOW);

    expect(outcome).toEqual({
      kind: "moved",
      digest: sourceDigest,
      statuslineSnippet: snippetLine(statuslinePaths(dataDir).shim),
    });
    expect(rowsOf(sourceDigest, "memories")).toBeGreaterThanOrEqual(1000);
    expect(readdirSync(dataDir).sort()).toEqual([DB_FILENAME, "models", "statusline"]);
    expect(readFileSync(join(dataDir, "models", "sub", "weights.bin"))).toEqual(
      readFileSync(join(store.dir, "models", "sub", "weights.bin")),
    );
    expect(integrityOf(join(dataDir, DB_FILENAME))).toBe("ok");
    const opened = openDatabase(moveConfig(dataDir));
    try {
      expect(storeDigest(opened.db)).toEqual(sourceDigest);
      expect(metaRows(opened.db)).toEqual(sourceMeta);
      expect(unembeddedActiveCount(opened.db)).toBe(0);
    } finally {
      opened.db.close();
    }
    expect(movedMarker(store.dir)).toEqual({
      version: 1,
      movedTo: dataDir,
      movedAt: NOW,
      digest: `sha256:${sourceDigest.sha256}`,
    });
    expect(sourceChanges(before, store.dir, [MOVED_MARKER_FILE])).toEqual([]);
  });

  it("reports already moved on a second run and leaves the destination and the marker unchanged", () => {
    const root = tempRoot("acm-move-again-");
    const store = legacyStore(root, 20, 100);
    const dataDir = join(root, "shared");
    expect(moveStore(store.dir, moveConfig(dataDir), NOW).kind).toBe("moved");
    const published = digestOfStore(join(dataDir, DB_FILENAME));
    const marker = movedMarker(store.dir);

    const second = moveStore(store.dir, moveConfig(dataDir), LATER);

    expect(second).toEqual({ kind: "already-moved", movedTo: dataDir });
    expect(digestOfStore(join(dataDir, DB_FILENAME))).toEqual(published);
    expect(movedMarker(store.dir)).toEqual(marker);
    expect(existsSync(join(dataDir, STAGING_DIR))).toBe(false);
  });

  it("fails verification when the staged copy differs from the source, leaving the source byte-identical, no marker and the data dir without a store", () => {
    const root = tempRoot("acm-move-verify-");
    const store = legacyStore(root, 20, 100);
    const dataDir = join(root, "shared");
    const before = fileHashes(store.dir);
    const dropOneVerdict = (step: MoveStep) => {
      if (step !== "copy-database") {
        return;
      }
      const staged = new Database(join(dataDir, STAGING_DIR, DB_FILENAME));
      staged.prepare("DELETE FROM verdicts WHERE rowid = (SELECT min(rowid) FROM verdicts)").run();
      staged.close();
    };

    const outcome = moveStore(store.dir, moveConfig(dataDir), NOW, dropOneVerdict);

    expect(outcome).toEqual({
      kind: "verification-failed",
      reason: `the copy of ${store.dir} differs from the source in verdicts`,
    });
    expect(sourceChanges(before, store.dir, [])).toEqual([]);
    expect(existsSync(join(store.dir, MOVED_MARKER_FILE))).toBe(false);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("refuses when the data dir already holds a store, touching neither side", () => {
    const root = tempRoot("acm-move-occupied-");
    const store = legacyStore(root, 20, 100);
    const dataDir = join(root, "shared");
    mkdirSync(dataDir);
    openDatabase(moveConfig(dataDir)).db.close();
    const occupied = digestOfStore(join(dataDir, DB_FILENAME));
    const before = fileHashes(store.dir);

    const outcome = moveStore(store.dir, moveConfig(dataDir), NOW);

    expect(outcome).toEqual({
      kind: "refused",
      reason: `a store already exists in ${dataDir}; move it aside and run the move again (docs/storage.md)`,
    });
    expect(digestOfStore(join(dataDir, DB_FILENAME))).toEqual(occupied);
    expect(sourceChanges(before, store.dir, [])).toEqual([]);
    expect(existsSync(join(store.dir, MOVED_MARKER_FILE))).toBe(false);
    expect(existsSync(join(dataDir, STAGING_DIR))).toBe(false);
  });

  it("refuses when a store appears in the data dir while the move runs, keeping that store and the source untouched", () => {
    const root = tempRoot("acm-move-appeared-");
    const store = legacyStore(root, 20, 100);
    const dataDir = join(root, "shared");
    const before = fileHashes(store.dir);
    let appeared: StoreDigest | undefined;
    const createStoreMeanwhile = (step: MoveStep) => {
      if (step !== "write-journal") {
        return;
      }
      openDatabase(moveConfig(dataDir)).db.close();
      appeared = digestOfStore(join(dataDir, DB_FILENAME));
    };

    const outcome = moveStore(store.dir, moveConfig(dataDir), NOW, createStoreMeanwhile);

    expect(outcome).toEqual({
      kind: "refused",
      reason: `a store appeared in ${dataDir} while the move ran; move it aside and run the move again (docs/storage.md)`,
    });
    expect(digestOfStore(join(dataDir, DB_FILENAME))).toEqual(appeared);
    expect(readdirSync(dataDir)).toEqual([DB_FILENAME]);
    expect(sourceChanges(before, store.dir, [])).toEqual([]);
    expect(existsSync(join(store.dir, MOVED_MARKER_FILE))).toBe(false);
  });

  it("checks free space on the nearest existing ancestor of a missing data dir and refuses before creating anything", () => {
    const root = tempRoot("acm-move-space-");
    const store = legacyStore(root, 20, 100);
    const dataDir = join(root, "share", "adaptive-cognitive-memory");
    const needed =
      statSync(store.dbPath).size +
      statSync(`${store.dbPath}-wal`).size +
      sizeOfTree(join(store.dir, "models")) +
      sizeOfTree(join(store.dir, "statusline"));
    const statfs = vi.spyOn(fs, "statfsSync").mockReturnValue({
      type: 0,
      bsize: 4096,
      blocks: 1,
      bfree: 1,
      bavail: 1,
      files: 0,
      ffree: 0,
    });
    syncBuiltinESMExports();

    const outcome = moveStore(store.dir, moveConfig(dataDir), NOW);

    expect(outcome).toEqual({
      kind: "refused",
      reason: `insufficient space in ${dataDir}: ${needed} bytes needed, 4096 bytes free`,
    });
    expect(statfs.mock.calls.map(([path]) => path)).toEqual([root]);
    expect(existsSync(join(root, "share"))).toBe(false);
    expect(existsSync(join(store.dir, MOVED_MARKER_FILE))).toBe(false);
  });

  it("moves a 12 MB store within 10 s and holds the source write lock for at most LOCK_HOLD_BUDGET_MS", () => {
    const root = tempRoot("acm-move-large-");
    const store = legacyStore(root, 1200, 10_000);
    const dataDir = join(root, "shared");
    expect(statSync(store.dbPath).size).toBeGreaterThanOrEqual(TWELVE_MB);
    const sourceDigest = storeDigest(store.anchor);
    const stepAt = new Map<MoveStep, number>();
    const started = performance.now();

    const outcome = moveStore(store.dir, moveConfig(dataDir), NOW, (step) =>
      stepAt.set(step, performance.now()),
    );
    const elapsedMs = performance.now() - started;

    expect(outcome).toMatchObject({ kind: "moved", digest: sourceDigest });
    expect(elapsedMs).toBeLessThanOrEqual(MOVE_BUDGET_MS);
    expect(
      (stepAt.get("unlock-source") ?? Number.NaN) - (stepAt.get("lock-source") ?? Number.NaN),
    ).toBeLessThanOrEqual(LOCK_HOLD_BUDGET_MS);
  });
});

const SERVER_ENTRY = join(process.cwd(), "dist", "server.js");
const HOOK_ENTRY = join(process.cwd(), "dist", "hooks.js");
const PROJECT_DIR = realpathSync(mkdtempSync(join(tmpdir(), "acm-move-project-")));

async function spawnedServer(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "acm-move-check", version: "0.0.0" });
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

async function toolValue(client: Client, name: string, args: Record<string, unknown>) {
  return JSON.parse(toolText((await client.callTool({ name, arguments: args })) as ToolCallResult));
}

function sessionStart(env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return runProcess({
    command: process.execPath,
    args: [HOOK_ENTRY],
    env,
    stdinText: JSON.stringify({
      cwd: PROJECT_DIR,
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: "session-after-move",
    }),
    timeoutMs: HOOK_KILL_MS,
  });
}

function titlesIn(dataDir: string): string[] {
  const db = new Database(join(dataDir, DB_FILENAME), { readonly: true });
  try {
    return db
      .prepare("SELECT title FROM memories WHERE title LIKE '% note' ORDER BY title")
      .pluck()
      .all() as string[];
  } finally {
    db.close();
  }
}

describe("moveStore survives a Claude plugin uninstall (FR-6)", () => {
  it(
    "keeps the moved store intact and in use by Claude hooks and Codex- and OpenCode-shaped servers after the legacy dir is deleted",
    async () => {
      const root = tempRoot("acm-move-uninstall-");
      const store = legacyStore(root, 20, 100, resolveProjectId(PROJECT_DIR));
      const dataDir = join(root, "shared");
      expect(moveStore(store.dir, moveConfig(dataDir), NOW).kind).toBe("moved");
      const published = digestOfStore(join(dataDir, DB_FILENAME));
      store.anchor.close();
      rmSync(store.dir, { recursive: true, force: true });
      const env = {
        CLAUDE_PLUGIN_DATA: store.dir,
        ACM_DATA_DIR: dataDir,
        CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "acm-move-claude-")),
        ...testModelEnv,
      };

      expect(digestOfStore(join(dataDir, DB_FILENAME))).toEqual(published);
      const started = await sessionStart(env);
      expect({ code: started.code, stderr: started.stderr }).toEqual({ code: 0, stderr: "" });
      const startOutput = JSON.parse(started.stdout) as {
        systemMessage?: string;
        hookSpecificOutput: { additionalContext: string };
      };
      expect(startOutput.systemMessage).toBeUndefined();
      expect(startOutput.hookSpecificOutput.additionalContext).toContain(PINNED_ABSTRACT);
      for (const host of ["codex", "opencode"]) {
        const client = await spawnedServer({ ...env, ACM_HOST: host });
        const got = await toolValue(client, "memory_get", { id: store.pinnedId });
        expect(got).toMatchObject({ abstract: PINNED_ABSTRACT });
        const stored = await toolValue(client, "memory_store", {
          title: `${host} note`,
          content: `Stored from a ${host}-shaped server after the move.`,
          type: "semantic",
          kind: "fact",
          conflict_key: `project.${host}_note`,
          resolution: { action: "ADD" },
        });
        expect(stored).toMatchObject({ action: "created" });
      }
      expect(titlesIn(dataDir)).toEqual(["codex note", "opencode note"]);
    },
    SPAWNED_TIMEOUT_MS,
  );
});

describe("store move CLI", () => {
  function cliEnv(dataDir: string): NodeJS.ProcessEnv {
    return { ACM_DATA_DIR: dataDir, ...testModelEnv };
  }

  it("prints the moved line with the statusline snippet and exits 0, then the already-moved line on a rerun", async () => {
    const root = tempRoot("acm-cli-move-");
    const store = legacyStore(root, 20, 100);
    const dataDir = join(root, "shared");
    const digest = storeDigest(store.anchor);
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const argv = ["node", "cli.js", "store", "move", "--from", store.dir];

    const code = await runCli(argv, cliEnv(dataDir), PROJECT_DIR);
    const firstRun = logs.mock.calls.splice(0);
    const rerunCode = await runCli(argv, cliEnv(dataDir), PROJECT_DIR);

    expect(code).toBe(0);
    expect(firstRun).toEqual([
      [
        `moved the memory store from ${store.dir} to ${dataDir}: ${digest.tables.length} tables, ${totalRows(digest)} rows verified`,
      ],
      [
        `statusline: set the Claude Code statusLine command to: ${snippetLine(statuslinePaths(dataDir).shim)}`,
      ],
    ]);
    expect(rerunCode).toBe(0);
    expect(logs.mock.calls).toEqual([
      [`the memory store was already moved from ${store.dir} to ${dataDir}`],
    ]);
  });

  it("prints the refusal line and exits 1 when the data dir already holds a store", async () => {
    const root = tempRoot("acm-cli-refused-");
    const store = legacyStore(root, 20, 100);
    const dataDir = join(root, "shared");
    mkdirSync(dataDir);
    openDatabase(moveConfig(dataDir)).db.close();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(
      ["node", "cli.js", "store", "move", "--from", store.dir],
      cliEnv(dataDir),
      PROJECT_DIR,
    );

    expect(code).toBe(1);
    expect(errors.mock.calls).toEqual([
      [
        `move refused: a store already exists in ${dataDir}; move it aside and run the move again (docs/storage.md); the source store is unchanged`,
      ],
    ]);
  });

  it("prints the failure line and exits 1 when the copy fails integrity_check, leaving the source byte-identical and the data dir without a store", async () => {
    const root = tempRoot("acm-cli-failed-");
    const store = checkpointedStore(root);
    corruptTableRoot(store.dbPath, "memories");
    const dataDir = join(root, "shared");
    const before = fileHashes(store.dir);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(
      ["node", "cli.js", "store", "move", "--from", store.dir],
      cliEnv(dataDir),
      PROJECT_DIR,
    );

    expect(code).toBe(1);
    expect(errors.mock.calls).toEqual([
      [
        expect.stringMatching(
          new RegExp(
            `^move failed: integrity_check of the copy reported: [^\\n]+; the source store is unchanged and ${dataDir} was not used$`,
          ),
        ),
      ],
    ]);
    expect(sourceChanges(before, store.dir, [])).toEqual([]);
    expect(existsSync(join(store.dir, MOVED_MARKER_FILE))).toBe(false);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it.each([
    ["store"],
    ["store", "move"],
    ["store", "move", "--from"],
    ["store", "move", "--from", "relative/dir"],
    ["store", "move", "--to", "/absolute/dir"],
  ])("exits 2 with the usage line for %j", async (...args) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["node", "cli.js", ...args], cliEnv(tempRoot("acm-cli-usage-")));

    expect(code).toBe(2);
    expect(errors.mock.calls).toEqual([
      [expect.stringMatching(/^usage: cli <.*store move --from <dir>/)],
    ]);
  });
});
