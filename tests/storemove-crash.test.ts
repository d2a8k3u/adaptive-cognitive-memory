import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DB_FILENAME } from "../src/cfg";
import { type StoreDigest, storeDigest } from "../src/db/digest";
import { MOVED_MARKER_FILE } from "../src/storelocation";
import { type MoveStep, moveStore } from "../src/storemove";
import { testModelCacheDir, testModelEnv } from "../vitest.config";
import {
  digestOfStore,
  fileHashes,
  integrityOf,
  type LegacyStore,
  runProcess,
  seedConfig,
  seedLegacyStore,
  sourceChanges,
} from "./fixtures/seed";

const KILL_POINTS: readonly MoveStep[] = [
  "stage-auxiliary",
  "copy-database",
  "write-journal",
  "publish-store",
  "mark-source",
];
const FIXTURES = join(process.cwd(), "tests", "fixtures");
const MOVE_UNTIL = join(FIXTURES, "move-until.cjs");
const MOVE_WRITER = join(FIXTURES, "move-writer.cjs");
const PROJECT_ID = "0123456789abcdef";
const PINNED_ABSTRACT = "never push to the main branch directly, open a pull request";
const NOW = "2026-10-30T12:00:00.000Z";
const SIGNALLED_EXIT = -1;
const KILLED_RUN_TIMEOUT_MS = 30_000;
const SPAWNED_TIMEOUT_MS = 60_000;
const WRITER_WARMUP_COMMITS = 20;
const POLL_INTERVAL_MS = 10;
const POLL_TIMEOUT_MS = 10_000;

const stores: LegacyStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.anchor.close();
  }
});

function tempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function legacyStore(root: string): LegacyStore {
  const store = seedLegacyStore(join(root, "legacy"), {
    memories: 200,
    contentChars: 500,
    projectId: PROJECT_ID,
    pinnedAbstract: PINNED_ABSTRACT,
  });
  stores.push(store);
  return store;
}

function moveConfig(dataDir: string) {
  return seedConfig(dataDir, testModelCacheDir);
}

function fixtureEnv(extra: Record<string, string>): Record<string, string> {
  return {
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    ...testModelEnv,
    ...extra,
  };
}

function probeCount(db: Database.Database): number {
  const present = db
    .prepare("SELECT count(*) FROM sqlite_schema WHERE name = 'move_probe'")
    .pluck()
    .get() as number;
  return present === 0
    ? 0
    : (db.prepare("SELECT count(*) FROM move_probe").pluck().get() as number);
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met before the poll timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

describe("store move interrupted by kill -9 (FR-3, FR-4)", () => {
  it.each(KILL_POINTS)(
    "after %s the source holds the byte rule and a rerun reaches the same verified store",
    async (step) => {
      const root = tempRoot("acm-crash-");
      const store = legacyStore(root);
      const dataDir = join(root, "shared");
      const sourceDigest = storeDigest(store.anchor);
      const before = fileHashes(store.dir);

      const killed = await runProcess({
        command: process.execPath,
        args: [MOVE_UNTIL, store.dir],
        env: fixtureEnv({ ACM_DATA_DIR: dataDir, ACM_MOVE_KILL_AFTER: step }),
        stdinText: "",
        timeoutMs: KILLED_RUN_TIMEOUT_MS,
      });
      const markerAfterKill = step === "mark-source";
      const sourceAfterKill = sourceChanges(
        before,
        store.dir,
        markerAfterKill ? [MOVED_MARKER_FILE] : [],
      );
      const markerPresent = existsSync(join(store.dir, MOVED_MARKER_FILE));
      const rerun = moveStore(store.dir, moveConfig(dataDir), NOW);

      expect(killed).toEqual({ code: SIGNALLED_EXIT, stdout: "", stderr: "" });
      expect(sourceAfterKill).toEqual([]);
      expect(markerPresent).toBe(markerAfterKill);
      expect(rerun.kind).toBe(markerAfterKill ? "already-moved" : "moved");
      expect(readdirSync(dataDir).sort()).toEqual([DB_FILENAME, "models", "statusline"]);
      expect(digestOfStore(join(dataDir, DB_FILENAME))).toEqual(sourceDigest);
      expect(integrityOf(join(dataDir, DB_FILENAME))).toBe("ok");
      expect(sourceChanges(before, store.dir, [MOVED_MARKER_FILE])).toEqual([]);
    },
    SPAWNED_TIMEOUT_MS,
  );
});

describe("store move beside a continuously committing writer (FR-3)", () => {
  it(
    "keeps every commit made before the lock as a gap-free prefix of the moved store",
    async () => {
      const root = tempRoot("acm-writer-");
      const store = legacyStore(root);
      const dataDir = join(root, "shared");
      const writer = spawn(process.execPath, [MOVE_WRITER, store.dbPath], {
        env: fixtureEnv({}),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let writerOut = "";
      let writerErr = "";
      writer.stdout.on("data", (chunk) => {
        writerOut += chunk;
      });
      writer.stderr.on("data", (chunk) => {
        writerErr += chunk;
      });
      const writerExit = new Promise<number | null>((resolve) => writer.on("close", resolve));
      await until(() => probeCount(store.anchor) >= WRITER_WARMUP_COMMITS);
      let committedBeforeLock = Number.NaN;
      let digestAtLock: StoreDigest | undefined;

      const outcome = moveStore(store.dir, moveConfig(dataDir), NOW, (step) => {
        if (step === "lock-source") {
          committedBeforeLock = probeCount(store.anchor);
          digestAtLock = storeDigest(store.anchor);
        }
      });
      writer.stdin.end();
      const writerCode = await writerExit;

      expect({ code: writerCode, stderr: writerErr }).toEqual({ code: 0, stderr: "" });
      expect(outcome).toEqual({
        kind: "moved",
        digest: digestAtLock,
        statuslineSnippet: expect.any(String),
      });
      expect(committedBeforeLock).toBeGreaterThanOrEqual(WRITER_WARMUP_COMMITS);
      const moved = new Database(join(dataDir, DB_FILENAME), { readonly: true });
      try {
        expect(moved.prepare("SELECT seq FROM move_probe ORDER BY seq").pluck().all()).toEqual(
          Array.from({ length: committedBeforeLock }, (_, index) => index + 1),
        );
      } finally {
        moved.close();
      }
      expect(integrityOf(join(dataDir, DB_FILENAME))).toBe("ok");
      expect(Number(writerOut.trim().split(" ")[1])).toBeGreaterThan(committedBeforeLock);
    },
    SPAWNED_TIMEOUT_MS,
  );
});
