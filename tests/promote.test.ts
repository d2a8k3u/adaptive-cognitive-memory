import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/cfg";
import { type OpenedDb, openDatabase } from "../src/db/database";
import { deleteMemory, get, type MemoryEnv, type StoreInput, store } from "../src/db/memories";

const PROJECT_AAA = "proj-aaa";
const PROJECT_BBB = "proj-bbb";
const PROJECT_CCC = "proj-ccc";

const embedState = vi.hoisted(() => ({
  default: (() => {
    const vector = new Float32Array(384);
    vector[0] = 1;
    return vector;
  })(),
}));

vi.mock("../src/embeddings", () => ({
  modelCached: () => true,
  embedPassage: (texts: string[]) => Promise.resolve(texts.map(() => embedState.default)),
}));

const openedDbs: OpenedDb[] = [];

function openEnv(): MemoryEnv {
  const pluginData = mkdtempSync(join(tmpdir(), "acm-promote-"));
  const config = loadConfig({ CLAUDE_PLUGIN_DATA: pluginData, ACM_DATA_DIR: pluginData });
  const opened = openDatabase(config);
  openedDbs.push(opened);
  return { db: opened.db, vecLoaded: opened.vecLoaded, modelCacheDir: config.modelCacheDir };
}

function testCommand(overrides: Partial<StoreInput> = {}): StoreInput {
  return {
    title: "Run unit tests with pnpm test",
    content: "Run the unit tests with pnpm test from the repository root.",
    type: "procedural",
    kind: "procedure",
    conflictKey: "project.test_command",
    cardinality: "single",
    valueText: "pnpm test",
    keywords: "pnpm test unit",
    anchors: [],
    questions: [],
    scope: "project",
    resolution: { action: "ADD" },
    ...overrides,
  };
}

function rows(env: MemoryEnv, sql: string, ...params: unknown[]): unknown[] {
  return env.db.prepare(sql).all(...params);
}

function idIn(env: MemoryEnv, scope: string, projectId: string): string {
  const row = env.db
    .prepare("SELECT id FROM memories WHERE scope = ? AND project_id = ?")
    .get(scope, projectId) as { id: string } | undefined;
  if (row === undefined) {
    throw new Error(`no ${scope} memory for ${projectId}`);
  }
  return row.id;
}

function userRowCount(env: MemoryEnv): number {
  return (
    env.db.prepare("SELECT count(*) AS n FROM memories WHERE scope = 'user'").get() as { n: number }
  ).n;
}

afterEach(() => {
  for (const opened of openedDbs) {
    opened.db.close();
  }
  openedDbs.length = 0;
});

describe("restricted promotion", () => {
  it("promotes a procedure shared by two projects to one user row and leaves the contributors untouched", async () => {
    const env = openEnv();
    await store(env, testCommand(), PROJECT_AAA);
    const second = await store(env, testCommand(), PROJECT_BBB);
    const aaaId = idIn(env, "project", PROJECT_AAA);
    const bbbId = idIn(env, "project", PROJECT_BBB);

    expect(get(env, aaaId)).toMatchObject({ state: "active", superseded_by: null });
    expect(get(env, bbbId)).toMatchObject({ state: "active", superseded_by: null });
    expect(userRowCount(env)).toBe(1);
    const userId = idIn(env, "user", PROJECT_BBB);
    expect(second).toEqual({
      outcome: "written",
      result: { id: bbbId, action: "created", promotedId: userId },
    });
    expect(get(env, userId)).toMatchObject({
      kind: "procedure",
      conflict_key: "project.test_command",
      value_text: "pnpm test",
      content: "Run the unit tests with pnpm test from the repository root.",
      state: "active",
    });
    expect(rows(env, "SELECT origin FROM memories WHERE id = ?", userId)).toEqual([
      { origin: "claude" },
    ]);
    expect(rows(env, "SELECT scope, state FROM memories_vec WHERE memory_id = ?", userId)).toEqual([
      { scope: "user", state: "active" },
    ]);
    expect(
      rows(
        env,
        "SELECT memory_id, from_state, to_state, reason, related_id FROM transitions ORDER BY memory_id",
      ),
    ).toEqual(
      [aaaId, bbbId].sort().map((memoryId) => ({
        memory_id: memoryId,
        from_state: "active",
        to_state: "active",
        reason: "promoted",
        related_id: userId,
      })),
    );

    const third = await store(env, testCommand(), PROJECT_CCC);
    expect(third.outcome === "written" ? third.result.promotedId : "not written").toBeUndefined();
    expect(userRowCount(env)).toBe(1);

    deleteMemory(env, userId);
    expect(rows(env, "SELECT related_id FROM transitions")).toEqual([
      { related_id: null },
      { related_id: null },
    ]);
  });

  it("never promotes a fact shared by two projects", async () => {
    const env = openEnv();
    const fact = testCommand({
      title: "Primary database is PostgreSQL 15",
      content: "The service stores everything in PostgreSQL 15.",
      type: "semantic",
      kind: "fact",
      conflictKey: "project.primary_database",
      valueText: "PostgreSQL 15",
    });
    await store(env, fact, PROJECT_AAA);
    await store(env, fact, PROJECT_BBB);
    expect(userRowCount(env)).toBe(0);
    expect(get(env, idIn(env, "project", PROJECT_AAA)).superseded_by).toBeNull();
  });

  it("promotes when an UPDATE makes two projects agree", async () => {
    const env = openEnv();
    await store(env, testCommand(), PROJECT_AAA);
    await store(
      env,
      testCommand({ content: "Run the unit tests with npm test.", valueText: "npm test" }),
      PROJECT_BBB,
    );
    expect(userRowCount(env)).toBe(0);
    const bbbId = idIn(env, "project", PROJECT_BBB);

    const updated = await store(
      env,
      testCommand({
        content: "Run the unit tests with pnpm test after the migration to pnpm.",
        resolution: { action: "UPDATE", target: bbbId },
      }),
      PROJECT_BBB,
    );

    expect(userRowCount(env)).toBe(1);
    expect(updated).toEqual({
      outcome: "written",
      result: { id: bbbId, action: "updated", promotedId: idIn(env, "user", PROJECT_BBB) },
    });
  });
});
