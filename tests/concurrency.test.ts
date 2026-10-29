import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/cfg";
import { type OpenedDb, openDatabase } from "../src/db/database";
import { testModelCacheDir } from "../vitest.config";
import { seedConfig } from "./fixtures/seed";

const SESSION_A_PROJECT_ID = "proj-conc-alpha";
const SESSION_B_PROJECT_ID = "proj-conc-beta";
const STORES_PER_SESSION = 10;

const SESSION_A_FACTS = [
  "api gateway timeouts",
  "redis eviction policy",
  "nginx buffer tuning",
  "oauth token rotation",
  "webhook retry storms",
  "kafka consumer lag",
  "grpc deadline budgets",
  "s3 multipart uploads",
  "dns failover order",
  "container image slimming",
];

const SESSION_B_FACTS = [
  "celery queue sizing",
  "postgres vacuum schedule",
  "github branch protection",
  "terraform drift checks",
  "vault seal practice",
  "prometheus scrape limits",
  "log sampling strategy",
  "feature flag hygiene",
  "migration rollback windows",
  "incident severity ladder",
];

interface StoreOutcome {
  id: string;
  action: string;
}

function runnerSource(): string {
  return [
    'const { openDatabase } = require(process.env.ACM_DIST + "/db/database.js");',
    'const { store } = require(process.env.ACM_DIST + "/db/memories.js");',
    "const config = {",
    "  pluginData: process.env.CLAUDE_PLUGIN_DATA,",
    "  dbPath: process.env.ACM_DB_PATH,",
    "  modelCacheDir: process.env.ACM_MODEL_CACHE_DIR,",
    "  budgetTokens: 1200,",
    "  pretoolBudgetTokens: 300,",
    "};",
    "const opened = openDatabase(config);",
    "const env = { db: opened.db, vecLoaded: opened.vecLoaded, modelCacheDir: config.modelCacheDir };",
    "const facts = JSON.parse(process.env.ACM_RUNNER_FACTS);",
    "(async () => {",
    "  const outcomes = [];",
    "  for (const fact of facts) {",
    "    const outcome = await store(env, {",
    "      title: fact,",
    "      content: 'Durable note about ' + fact.toLowerCase() + ' recorded during the concurrency verification run.',",
    "      type: 'semantic',",
    "      kind: 'fact',",
    "      conflictKey: 'test.concurrency_' + fact.replaceAll(' ', '_'),",
    "      cardinality: 'multi',",
    "      valueText: '',",
    "      keywords: '',",
    "      anchors: [],",
    "      questions: [],",
    "      scope: 'project',",
    "      resolution: { action: 'ADD' },",
    "    }, process.env.ACM_RUNNER_PROJECT_ID);",
    "    outcomes.push(outcome.outcome === 'written' ? outcome.result : outcome);",
    "  }",
    "  process.stdout.write(JSON.stringify(outcomes));",
    "  opened.db.close();",
    "  process.exit(0);",
    "})().catch((error) => {",
    "  process.stderr.write(String(error && error.stack ? error.stack : error));",
    "  process.exit(1);",
    "});",
  ].join("\n");
}

function runnerEnv(config: Config, facts: readonly string[], projectId: string): NodeJS.ProcessEnv {
  return {
    CLAUDE_PLUGIN_DATA: config.pluginData,
    ACM_DATA_DIR: config.pluginData,
    ACM_DB_PATH: config.dbPath,
    ACM_MODEL_CACHE_DIR: config.modelCacheDir,
    ACM_DIST: distDir(),
    ACM_RUNNER_FACTS: JSON.stringify(facts),
    ACM_RUNNER_PROJECT_ID: projectId,
  };
}

function spawnRunner(path: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path], { env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
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
  });
}

async function openPoller(dbPath: string): Promise<Database.Database> {
  for (;;) {
    try {
      const candidate = new Database(dbPath, { fileMustExist: true });
      candidate.prepare("SELECT count(*) AS n FROM memories").get();
      return candidate;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}

function peerSource(): string {
  return [
    'const { existsSync, writeFileSync } = require("node:fs");',
    'const Database = require(process.env.ACM_NODE_MODULES + "/better-sqlite3");',
    "const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);",
    "const db = new Database(process.env.ACM_PEER_DB_PATH);",
    'db.pragma("busy_timeout = 1000");',
    'db.exec("BEGIN IMMEDIATE");',
    'db.exec("CREATE TABLE peer_hold (x)");',
    'writeFileSync(process.env.ACM_PEER_HOLD, "held");',
    "const deadline = Date.now() + 30000;",
    "while (!existsSync(process.env.ACM_PEER_RELEASE) && Date.now() < deadline) { sleep(10); }",
    'db.exec("COMMIT");',
    "db.close();",
    'writeFileSync(process.env.ACM_PEER_DONE, "done");',
  ].join("\n");
}

async function awaitMarker(path: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`peer marker missing before deadline: ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function distDir(): string {
  const dir = join(process.cwd(), "dist");
  if (!existsSync(join(dir, "hooks.js"))) {
    throw new Error("dist missing — run npm run build before the concurrency suite");
  }
  return dir;
}

describe("multi-process database access", () => {
  it("two concurrent storing sessions land every row with integrity ok (AC-22)", {
    timeout: 90_000,
  }, async () => {
    const pluginData = mkdtempSync(join(tmpdir(), "acm-conc-"));
    const config = seedConfig(pluginData, testModelCacheDir);
    const runnerPath = join(mkdtempSync(join(tmpdir(), "acm-conc-runner-")), "store-runner.cjs");
    writeFileSync(runnerPath, runnerSource());

    const startedAt = performance.now();
    const [sessionA, sessionB] = await Promise.all([
      spawnRunner(runnerPath, runnerEnv(config, SESSION_A_FACTS, SESSION_A_PROJECT_ID)),
      spawnRunner(runnerPath, runnerEnv(config, SESSION_B_FACTS, SESSION_B_PROJECT_ID)),
    ]);
    console.log(`AC-22 two sessions finished in ${Math.round(performance.now() - startedAt)} ms`);

    expect(sessionA.code, sessionA.stderr).toBe(0);
    expect(sessionA.stderr).toBe("");
    expect(sessionB.code, sessionB.stderr).toBe(0);
    expect(sessionB.stderr).toBe("");
    const outcomesA = JSON.parse(sessionA.stdout) as StoreOutcome[];
    const outcomesB = JSON.parse(sessionB.stdout) as StoreOutcome[];
    expect(outcomesA.map((outcome) => outcome.action)).toEqual(
      Array(STORES_PER_SESSION).fill("created"),
    );
    expect(outcomesB.map((outcome) => outcome.action)).toEqual(
      Array(STORES_PER_SESSION).fill("created"),
    );

    const opened: OpenedDb = openDatabase(config);
    try {
      const count = opened.db.prepare("SELECT count(*) AS n FROM memories").get();
      const perProject = opened.db
        .prepare(
          "SELECT project_id AS pid, count(*) AS n FROM memories GROUP BY project_id ORDER BY pid",
        )
        .all() as { pid: string; n: number }[];
      const expectedPerProject = [
        { pid: SESSION_A_PROJECT_ID, n: STORES_PER_SESSION },
        { pid: SESSION_B_PROJECT_ID, n: STORES_PER_SESSION },
      ].sort((a, b) => (a.pid < b.pid ? -1 : 1));
      expect(count).toEqual({ n: 2 * STORES_PER_SESSION });
      expect(perProject).toEqual(expectedPerProject);
      expect(opened.db.prepare("SELECT count(*) AS n FROM memories_vec").get()).toEqual({
        n: 2 * STORES_PER_SESSION,
      });
      expect(opened.db.prepare("SELECT count(*) AS n FROM memories_fts").get()).toEqual({
        n: 2 * STORES_PER_SESSION,
      });
      expect(opened.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      opened.db.close();
    }
  });

  it("first open waits out a peer write transaction on a fresh delete-mode database (AC-22)", {
    timeout: 30_000,
  }, async () => {
    const pluginData = mkdtempSync(join(tmpdir(), "acm-openrace-"));
    const config = seedConfig(pluginData, testModelCacheDir);
    const markerDir = mkdtempSync(join(tmpdir(), "acm-openrace-peer-"));
    const markers = {
      hold: join(markerDir, "hold"),
      release: join(markerDir, "release"),
      done: join(markerDir, "done"),
    };
    const peerPath = join(mkdtempSync(join(tmpdir(), "acm-openrace-runner-")), "hold-runner.cjs");
    writeFileSync(peerPath, peerSource());
    const exited = spawnRunner(peerPath, {
      ACM_NODE_MODULES: join(process.cwd(), "node_modules"),
      ACM_PEER_DB_PATH: config.dbPath,
      ACM_PEER_HOLD: markers.hold,
      ACM_PEER_RELEASE: markers.release,
      ACM_PEER_DONE: markers.done,
    });

    await awaitMarker(markers.hold);
    writeFileSync(markers.release, "");
    const openedAt = performance.now();
    const opened: OpenedDb = openDatabase(config);
    const openMs = Math.round(performance.now() - openedAt);
    console.log(`AC-22 first open under peer write txn took ${openMs} ms`);
    try {
      expect(opened.db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(
        opened.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
          .get(),
      ).toBeDefined();
    } finally {
      opened.db.close();
    }

    const exit = await exited;
    expect(exit.code, exit.stderr).toBe(0);
    expect(exit.stderr).toBe("");
    expect(existsSync(markers.done)).toBe(true);
  });

  it("kill -9 mid-write leaves the database intact with no torn rows", {
    timeout: 90_000,
  }, async () => {
    const pluginData = mkdtempSync(join(tmpdir(), "acm-kill-"));
    const config = seedConfig(pluginData, testModelCacheDir);
    const runnerPath = join(mkdtempSync(join(tmpdir(), "acm-kill-runner-")), "store-runner.cjs");
    writeFileSync(runnerPath, runnerSource());
    const child = spawn(process.execPath, [runnerPath], {
      env: runnerEnv(config, SESSION_A_FACTS.concat(SESSION_B_FACTS), SESSION_A_PROJECT_ID),
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    const poller = await openPoller(config.dbPath);
    let killedAtCount = -1;
    for (;;) {
      const count = (poller.prepare("SELECT count(*) AS n FROM memories").get() as { n: number }).n;
      if (count >= 3) {
        killedAtCount = count;
        child.kill("SIGKILL");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    poller.close();
    const exit = await exited;
    expect(exit.code).toBeNull();
    expect(exit.signal).toBe("SIGKILL");

    const opened: OpenedDb = openDatabase(config);
    try {
      const count = (opened.db.prepare("SELECT count(*) AS n FROM memories").get() as { n: number })
        .n;
      console.log(`durability: killed at ${killedAtCount} rows, ${count} rows survived`);
      expect(count).toBeGreaterThanOrEqual(3);
      expect(count).toBeLessThan(20);
      expect(opened.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(opened.db.prepare("SELECT count(*) AS n FROM memories_vec").get()).toEqual({
        n: count,
      });
      expect(opened.db.prepare("SELECT count(*) AS n FROM memories_fts").get()).toEqual({
        n: count,
      });
      const torn = opened.db
        .prepare(
          "SELECT count(*) AS n FROM memories WHERE title = '' OR abstract = '' OR content = ''",
        )
        .get();
      expect(torn).toEqual({ n: 0 });
    } finally {
      opened.db.close();
    }
  });
});
