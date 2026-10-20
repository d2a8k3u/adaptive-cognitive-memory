import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type OpenedDb, openDatabase } from "../src/db/database";
import { LIST_LIMIT_MAX, type ListRequest, listMemories } from "../src/db/listing";
import type { MemoryType } from "../src/db/memories";
import { resolveProjectId } from "../src/ids";
import { recall } from "../src/search";
import { testModelCacheDir } from "../vitest.config";
import { runProcess, type SeedMemory, seedConfig, seedMemories } from "./fixtures/seed";

const SEED_ROWS = 1000;
const WARM_RUNS = 50;
const SEARCH_RUNS = 50;
const COLD_CAP_MS = 2000;
const WARM_P95_CAP_MS = 750;
const SEARCH_P95_CAP_MS = 100;
const READ_RUNS = 50;
const READ_P95_CAP_MS = 300;
const READ_ANCHOR = "billing/tax.py";
const READ_ANCHORED_ID = `01J8PERF${"2".padStart(18, "0")}`;
const LIST_WALKS = 3;
const LIST_P95_CAP_MS = 20;
const SIZE_CAP_BYTES = 25 * 1024 * 1024;
const HOOK_TIMEOUT_FLOOR_S = 5;
const RECALL_PROMPT = "how should we handle database migrations under load";

const MEMORY_TYPES: readonly MemoryType[] = ["semantic", "episodic", "procedural", "pattern"];

const TOPICS = [
  "deploy pipeline",
  "database migrations",
  "code review discipline",
  "test coverage",
  "api design",
  "error handling",
  "caching strategy",
  "logging standards",
  "release cadence",
  "incident response",
  "on-call rotation",
  "service boundaries",
  "queue backpressure",
  "idempotency",
  "retry policy",
  "schema evolution",
  "index tuning",
  "query budgets",
  "hook latency",
  "model loading",
];

const QUALIFIERS = [
  "baseline",
  "under load",
  "after failover",
  "with replicas",
  "in staging",
  "at the edge",
  "overnight",
  "on weekends",
  "during migration",
  "postmortem",
];

function recallTarget(projectId: string): SeedMemory {
  return {
    id: `01J8PERF${"TARGET".padStart(18, "0")}`,
    projectId,
    scope: "project",
    type: "procedural",
    title: "Database migrations under load run in small batches",
    abstract:
      "Handle database migrations under load in batches of 500 rows with a 2 s lock timeout, pausing while replica lag exceeds 5 s",
    content:
      "Database migrations that run while the service is under load copy data in batches of 500 rows, set lock_timeout to 2 s and pause whenever replica lag exceeds 5 s.",
    importance: 0.5,
  };
}

function seedRows(projectId: string): SeedMemory[] {
  const rows: SeedMemory[] = [recallTarget(projectId)];
  for (let index = 1; index < SEED_ROWS; index += 1) {
    const topic = TOPICS[index % TOPICS.length]!;
    const qualifier = QUALIFIERS[Math.floor(index / TOPICS.length) % QUALIFIERS.length]!;
    rows.push({
      id: `01J8PERF${String(index).padStart(18, "0")}`,
      projectId,
      scope: index % 5 === 0 ? "user" : "project",
      type: MEMORY_TYPES[index % MEMORY_TYPES.length]!,
      title: `${topic} ${qualifier} ${index}`,
      abstract: `guideline for ${topic} ${qualifier} number ${index}`,
      content: `The team treats ${topic} ${qualifier} as a durable practice and revisits it whenever ${topic} comes up during planning for release ${index}.`,
      importance: (index % 10) / 10,
    });
  }
  return rows;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

function distEntry(name: string): string {
  const entry = join(process.cwd(), "dist", name);
  if (!existsSync(entry)) {
    throw new Error(`dist/${name} missing — run npm run build before the perf suite`);
  }
  return entry;
}

describe("perf gates @ 1000 memories (AC-24)", () => {
  let pluginData: string;
  let hookEnv: NodeJS.ProcessEnv;
  let seedFinishedMs: number;
  let projectDir: string;
  let projectId: string;

  beforeAll(async () => {
    pluginData = mkdtempSync(join(tmpdir(), "acm-perf-"));
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), "acm-perf-project-")));
    projectId = resolveProjectId(projectDir);
    const config = seedConfig(pluginData, testModelCacheDir);
    hookEnv = { CLAUDE_PLUGIN_DATA: pluginData, ACM_MODEL_CACHE_DIR: testModelCacheDir };
    const startedAt = performance.now();
    await seedMemories(config, seedRows(projectId));
    seedFinishedMs = Math.round(performance.now() - startedAt);
  }, 120_000);

  it.skipIf(process.env.CI === "true")(
    "cold and warm hook runs hold the latency caps and justify the hooks.json timeouts",
    {
      timeout: 300_000,
    },
    async () => {
      const spawnHook = (sessionId: string) =>
        runProcess({
          command: process.execPath,
          args: [distEntry("hooks.js")],
          env: hookEnv,
          stdinText: JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            cwd: projectDir,
            session_id: sessionId,
            prompt: RECALL_PROMPT,
          }),
          timeoutMs: 30_000,
        });

      const coldStartedAt = performance.now();
      const cold = await spawnHook("perf-cold");
      const coldMs = performance.now() - coldStartedAt;
      expect(cold.code).toBe(0);
      expect(cold.stderr).toBe("");
      expect(cold.stdout).toContain("<memory>");
      expect(cold.stdout).toContain("01J8PERF");
      console.log(`AC-24 cold hook run: ${Math.round(coldMs)} ms (cap ${COLD_CAP_MS})`);
      expect(coldMs).toBeLessThanOrEqual(COLD_CAP_MS);

      const warmMs: number[] = [];
      for (let index = 0; index < WARM_RUNS; index += 1) {
        const runStartedAt = performance.now();
        const run = await spawnHook(`perf-warm-${index}`);
        warmMs.push(performance.now() - runStartedAt);
        expect(run.code).toBe(0);
        expect(run.stderr).toBe("");
        expect(run.stdout).toContain("<memory>");
      }
      const warmP95 = percentile(warmMs, 0.95);
      const warmMax = Math.max(...warmMs);
      console.log(
        `AC-24 warm hook p95: ${Math.round(warmP95)} ms (cap ${WARM_P95_CAP_MS}), max ${Math.round(warmMax)} ms over ${WARM_RUNS} runs`,
      );
      console.log(`seed ${SEED_ROWS} memories: ${seedFinishedMs} ms`);
      expect(warmP95).toBeLessThanOrEqual(WARM_P95_CAP_MS);

      const hooksJson = JSON.parse(
        readFileSync(join(process.cwd(), "hooks", "hooks.json"), "utf8"),
      ) as {
        hooks: Record<string, { hooks: { timeout: number }[] }[]>;
      };
      const requiredTimeoutS = Math.max(HOOK_TIMEOUT_FLOOR_S, Math.ceil((2 * coldMs) / 1000));
      for (const groups of Object.values(hooksJson.hooks)) {
        for (const group of groups) {
          for (const hook of group.hooks) {
            expect(hook.timeout).toBeGreaterThanOrEqual(requiredTimeoutS);
          }
        }
      }
      console.log(
        `hooks.json final timeout: ${requiredTimeoutS} s = max(2 × ${Math.round(coldMs)} ms cold, ${HOOK_TIMEOUT_FLOOR_S} s)`,
      );
    },
  );

  it.skipIf(process.env.CI === "true")(
    "spawned PreToolUse Read p95 stays under 300 ms",
    { timeout: 120_000 },
    async () => {
      const opened: OpenedDb = openDatabase(seedConfig(pluginData, testModelCacheDir));
      try {
        opened.db
          .prepare("UPDATE memories SET anchors = ? WHERE id = ?")
          .run(JSON.stringify([READ_ANCHOR]), READ_ANCHORED_ID);
      } finally {
        opened.db.close();
      }
      const readMs: number[] = [];
      for (let index = 0; index < READ_RUNS; index += 1) {
        const runStartedAt = performance.now();
        const run = await runProcess({
          command: process.execPath,
          args: [distEntry("hooks.js")],
          env: hookEnv,
          stdinText: JSON.stringify({
            hook_event_name: "PreToolUse",
            cwd: projectDir,
            session_id: `perf-read-${index}`,
            tool_name: "Read",
            tool_input: { file_path: join(projectDir, READ_ANCHOR) },
          }),
          timeoutMs: 30_000,
        });
        readMs.push(performance.now() - runStartedAt);
        expect(run.code).toBe(0);
        expect(run.stderr).toBe("");
        expect(run.stdout).toContain(READ_ANCHORED_ID);
      }
      const readP95 = percentile(readMs, 0.95);
      console.log(
        `NFR-13 PreToolUse Read p95 @${SEED_ROWS}: ${Math.round(readP95)} ms (cap ${READ_P95_CAP_MS}), max ${Math.round(Math.max(...readMs))} ms over ${READ_RUNS} runs`,
      );
      expect(readP95).toBeLessThanOrEqual(READ_P95_CAP_MS);
    },
  );

  it("search p95 stays under 100 ms", { timeout: 120_000 }, async () => {
    const config = seedConfig(pluginData, testModelCacheDir);
    const opened: OpenedDb = openDatabase(config);
    try {
      await recall(opened, {
        projectId,
        modelCacheDir: config.modelCacheDir,
        query: RECALL_PROMPT,
        limit: 10,
      });
      const runMs: number[] = [];
      for (let index = 0; index < SEARCH_RUNS; index += 1) {
        const startedAt = performance.now();
        const result = await recall(opened, {
          projectId,
          modelCacheDir: config.modelCacheDir,
          query: RECALL_PROMPT,
          limit: 10,
        });
        runMs.push(performance.now() - startedAt);
        expect(result.rows.length).toBeGreaterThan(0);
      }
      const searchP95 = percentile(runMs, 0.95);
      console.log(
        `search p95 @${SEED_ROWS}: ${Math.round(searchP95)} ms (cap ${SEARCH_P95_CAP_MS})`,
      );
      expect(searchP95).toBeLessThanOrEqual(SEARCH_P95_CAP_MS);
    } finally {
      opened.db.close();
    }
  });

  it("memory_list pages hold p95 under 20 ms with one statement per page", {
    timeout: 60_000,
  }, () => {
    const opened: OpenedDb = openDatabase(seedConfig(pluginData, testModelCacheDir));
    try {
      const prepare = vi.spyOn(opened.db, "prepare");
      const walks: readonly Omit<ListRequest, "before">[] = [
        {
          partition: { kind: "visible", projectId },
          filters: { state: "active" },
          limit: LIST_LIMIT_MAX,
        },
        { partition: { kind: "all" }, filters: {}, limit: LIST_LIMIT_MAX },
      ];
      const pageMs: number[] = [];
      const listedPerWalk: number[] = [];
      for (let walk = 0; walk < LIST_WALKS; walk += 1) {
        for (const request of walks) {
          let before: string | undefined;
          let listed = 0;
          do {
            const startedAt = performance.now();
            const page = listMemories(opened.db, { ...request, before });
            pageMs.push(performance.now() - startedAt);
            listed += page.rows.length;
            before = page.next_cursor;
          } while (before !== undefined);
          listedPerWalk.push(listed);
        }
      }
      const listP95 = percentile(pageMs, 0.95);
      console.log(
        `NFR-10 memory_list page p95 @${SEED_ROWS}: ${listP95.toFixed(2)} ms (cap ${LIST_P95_CAP_MS}) over ${pageMs.length} pages, ${prepare.mock.calls.length} statements`,
      );

      expect({
        listed: listedPerWalk,
        statements: prepare.mock.calls.length,
      }).toEqual({
        listed: Array.from({ length: LIST_WALKS * walks.length }, () => SEED_ROWS),
        statements: pageMs.length,
      });
      expect(listP95).toBeLessThanOrEqual(LIST_P95_CAP_MS);
    } finally {
      opened.db.close();
    }
  });

  it("1000 memories with vectors and FTS stay under 25 MB", { timeout: 60_000 }, () => {
    const config = seedConfig(pluginData, testModelCacheDir);
    const opened: OpenedDb = openDatabase(config);
    opened.db.pragma("wal_checkpoint(TRUNCATE)");
    opened.db.close();
    const dbBytes = statSync(config.dbPath).size;
    const walBytes = existsSync(`${config.dbPath}-wal`) ? statSync(`${config.dbPath}-wal`).size : 0;
    const totalBytes = dbBytes + walBytes;
    console.log(
      `db size @${SEED_ROWS}: ${(totalBytes / 1024 / 1024).toFixed(2)} MB (cap ${SIZE_CAP_BYTES / 1024 / 1024} MB)`,
    );
    expect(totalBytes).toBeLessThanOrEqual(SIZE_CAP_BYTES);
  });
});
