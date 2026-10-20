import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/cfg";
import { type Db, type OpenedDb, openDatabase } from "../src/db/database";
import type { ListPage } from "../src/db/listing";
import type { MemoryKind, MemoryScope, MemoryState, MemoryType } from "../src/policy";
import { isToolError, memoryList, type ToolDeps } from "../src/tools";

const PROJECT = "proj-listing";
const OTHER_PROJECT = "proj-other";

interface ListSeed {
  readonly id: string;
  readonly projectId?: string;
  readonly scope?: MemoryScope;
  readonly state?: MemoryState;
  readonly kind?: MemoryKind;
  readonly type?: MemoryType;
  readonly title?: string;
}

const openedDbs: OpenedDb[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const opened of openedDbs) {
    opened.db.close();
  }
  openedDbs.length = 0;
});

function listId(index: number): string {
  return `01K7${String(index).padStart(22, "0")}`;
}

function openDeps(): ToolDeps {
  const pluginData = mkdtempSync(join(tmpdir(), "acm-listing-"));
  const config = loadConfig({ CLAUDE_PLUGIN_DATA: pluginData });
  const opened = openDatabase(config);
  openedDbs.push(opened);
  const projectDir = mkdtempSync(join(tmpdir(), "acm-listing-project-"));
  return {
    env: { db: opened.db, vecLoaded: opened.vecLoaded, modelCacheDir: config.modelCacheDir },
    projectId: PROJECT,
    processEnv: { CLAUDE_PLUGIN_DATA: pluginData },
    instructionSources: { projectDir, autoMemoryIndex: undefined },
  };
}

function insertRows(db: Db, seeds: readonly ListSeed[]): void {
  const insert = db.prepare(
    `INSERT INTO memories (id, type, kind, scope, project_id, title, abstract, content, state,
       importance, valid_from, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0.5, '2026-10-01T00:00:00.000Z',
       '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
  );
  for (const seed of seeds) {
    insert.run(
      seed.id,
      seed.type ?? "semantic",
      seed.kind ?? "fact",
      seed.scope ?? "project",
      seed.projectId ?? PROJECT,
      seed.title ?? `title of ${seed.id}`,
      `abstract of ${seed.id}`,
      `content of ${seed.id}`,
      seed.state ?? "active",
    );
  }
}

async function listed(deps: ToolDeps, args: Record<string, unknown>): Promise<ListPage> {
  const page = await memoryList(deps, args);
  if (isToolError(page)) {
    throw new Error(`list failed: ${JSON.stringify(page)}`);
  }
  return page;
}

function idsOf(page: ListPage): string[] {
  return page.rows.map((row) => row.id);
}

describe("memory_list", () => {
  it.each([
    { filters: { state: "hypothesis" }, ids: [listId(2)] },
    { filters: { kind: "procedure" }, ids: [listId(4), listId(3)] },
    { filters: { type: "pattern" }, ids: [listId(5)] },
    { filters: { scope: "user" }, ids: [listId(5), listId(4)] },
    {
      filters: { state: "active", kind: "fact", type: "semantic", scope: "project" },
      ids: [listId(1)],
    },
  ])("returns exactly the rows matching $filters, newest first", async ({ filters, ids }) => {
    const deps = openDeps();
    insertRows(deps.env.db, [
      { id: listId(1), state: "active", kind: "fact", type: "semantic", scope: "project" },
      { id: listId(2), state: "hypothesis", kind: "fact", type: "semantic", scope: "project" },
      { id: listId(3), state: "revoked", kind: "procedure", type: "procedural", scope: "project" },
      { id: listId(4), state: "active", kind: "procedure", type: "procedural", scope: "user" },
      { id: listId(5), state: "active", kind: "preference", type: "pattern", scope: "user" },
      { id: listId(6), state: "active", kind: "fact", type: "episodic", scope: "project" },
    ]);

    expect(idsOf(await listed(deps, filters))).toEqual(ids);
  });

  it("pages 45 rows 20/20/5 by default with strictly descending ids, no gap and no duplicate", async () => {
    const deps = openDeps();
    insertRows(
      deps.env.db,
      Array.from({ length: 45 }, (_, index) => ({ id: listId(index + 1) })),
    );

    const first = await listed(deps, {});
    const second = await listed(deps, { before: first.next_cursor });
    const third = await listed(deps, { before: second.next_cursor });
    const pastTheOldest = await listed(deps, { before: listId(1) });
    const whole = await listed(deps, { limit: 45 });

    expect({
      sizes: [first, second, third].map((page) => page.rows.length),
      ids: [first, second, third].flatMap(idsOf),
      lastCursor: third.next_cursor,
      pastTheOldest,
      whole: { rows: whole.rows.length, cursor: whole.next_cursor },
    }).toEqual({
      sizes: [20, 20, 5],
      ids: Array.from({ length: 45 }, (_, index) => listId(45 - index)),
      lastCursor: undefined,
      pastTheOldest: { rows: [] },
      whole: { rows: 45, cursor: undefined },
    });
  });

  it.each([
    { args: { limit: 0 }, field: "limit" },
    { args: { limit: 51 }, field: "limit" },
    { args: { limit: 1.5 }, field: "limit" },
    { args: { before: "01K7" }, field: "before" },
    { args: { before: "01J8TRANSFER0000000000VAL1" }, field: "before" },
    { args: { state: "deleted" }, field: "state" },
    { args: { kind: "rumour" }, field: "kind" },
    { args: { type: "thought" }, field: "type" },
    { args: { scope: "galaxy" }, field: "scope" },
    { args: { project: "x" }, field: "project" },
  ])("rejects $args naming $field before any statement", async ({ args, field }) => {
    const deps = openDeps();
    const prepare = vi.spyOn(deps.env.db, "prepare");

    const outcome = await memoryList(deps, args);

    expect({ outcome, prepared: prepare.mock.calls.length }).toEqual({
      outcome: { error: { field, message: expect.any(String) } },
      prepared: 0,
    });
  });

  it("carries exactly the listed fields of a row with their stored values and never its content", async () => {
    const deps = openDeps();
    deps.env.db
      .prepare(
        `INSERT INTO memories (id, type, kind, scope, project_id, title, abstract, content,
           conflict_key, cardinality, value_text, keywords, anchors, state, importance, support_count,
           injection_count, used_count, wrong_count, valid_from, created_at, updated_at)
         VALUES (?, 'procedural', 'procedure', 'project', ?, 'release title', 'release abstract',
           'release content body', 'deploy.release', 'single', 'tag first', 'release tag',
           '["make release"]', 'hypothesis', 0.25, 3, 7, 1, 2, '2026-10-02T00:00:00.000Z',
           '2026-10-01T00:00:00.000Z', '2026-10-05T00:00:00.000Z')`,
      )
      .run(listId(1), PROJECT);

    const page = await listed(deps, {});

    expect(page).toEqual({
      rows: [
        {
          id: listId(1),
          title: "release title",
          abstract: "release abstract",
          kind: "procedure",
          type: "procedural",
          scope: "project",
          project_id: PROJECT,
          state: "hypothesis",
          conflict_key: "deploy.release",
          value_text: "tag first",
          importance: 0.25,
          support_count: 3,
          injection_count: 7,
          used_count: 1,
          wrong_count: 2,
          valid_from: "2026-10-02T00:00:00.000Z",
          updated_at: "2026-10-05T00:00:00.000Z",
        },
      ],
    });
  });

  it('lists only rows visible to the project by default, and every project\'s rows with project "all"', async () => {
    const deps = openDeps();
    insertRows(deps.env.db, [
      { id: listId(1) },
      { id: listId(2), projectId: OTHER_PROJECT },
      { id: listId(3), projectId: OTHER_PROJECT, scope: "user" },
    ]);

    const visible = await listed(deps, {});
    const every = await listed(deps, { project: "all" });

    expect({ visible: idsOf(visible), every: idsOf(every) }).toEqual({
      visible: [listId(3), listId(1)],
      every: [listId(3), listId(2), listId(1)],
    });
  });

  it("keeps each page of 50 rows at every field's stored maximum within 40 000 characters of JSON and continues over every row", async () => {
    const deps = openDeps();
    const insert = deps.env.db.prepare(
      `INSERT INTO memories (id, type, kind, scope, project_id, title, abstract, content, conflict_key,
         cardinality, value_text, state, importance, support_count, injection_count, used_count,
         wrong_count, valid_from, created_at, updated_at)
       VALUES (?, 'procedural', 'preference', 'project', ?, ?, ?, 'content', ?, 'single', ?,
         'hypothesis', 0.6666666666666666, 999999, 999999, 999999, 999999,
         '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    );
    for (let index = 1; index <= 50; index += 1) {
      insert.run(
        listId(index),
        "f".repeat(16),
        '"'.repeat(200),
        "a".repeat(200),
        `project.${"k".repeat(112)}`,
        "v".repeat(200),
      );
    }
    const args = { project: "all", limit: 50 };

    const pages = [await listed(deps, args)];
    while (pages.length <= 50 && pages.at(-1)?.next_cursor !== undefined) {
      pages.push(await listed(deps, { ...args, before: pages.at(-1)?.next_cursor }));
    }

    expect({
      oversized: pages.map((page) => JSON.stringify(page).length).filter((chars) => chars > 40_000),
      ids: pages.flatMap(idsOf),
    }).toEqual({
      oversized: [],
      ids: Array.from({ length: 50 }, (_, index) => listId(50 - index)),
    });
  });

  it("leaves every table's row count and every memory row unchanged", async () => {
    const deps = openDeps();
    const { db } = deps.env;
    insertRows(
      db,
      Array.from({ length: 3 }, (_, index) => ({ id: listId(index + 1) })),
    );
    db.prepare(
      "INSERT INTO injections (session_id, memory_id, event, at) VALUES ('s', ?, 'UserPromptSubmit', '2026-10-01T00:00:00.000Z')",
    ).run(listId(1));
    const snapshot = () => ({
      counts: db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .pluck()
        .all()
        .map(String)
        .map((table) => [table, db.prepare(`SELECT count(*) FROM "${table}"`).pluck().get()]),
      memories: db.prepare("SELECT * FROM memories ORDER BY id").all(),
    });
    const before = snapshot();

    await listed(deps, {});
    await listed(deps, { project: "all", limit: 1 });
    await listed(deps, { state: "active", before: listId(3) });

    expect(snapshot()).toEqual(before);
  });
});
