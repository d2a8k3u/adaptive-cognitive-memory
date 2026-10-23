import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getLoadablePath } from "sqlite-vec";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ABSTRACT_MAX_CHARS,
  CONTENT_MAX_CHARS,
  EMBED_DIM,
  loadConfig,
  MODEL_ID,
  RELATION_CAP,
  RELATION_TYPE_MAX_CHARS,
  TITLE_MAX_CHARS,
} from "../src/cfg";
import { type Db, isStorageRejection, type OpenedDb, openDatabase } from "../src/db/database";
import {
  baselineDdl,
  SCHEMA_VERSION,
  SchemaTooNewError,
  schemaV2Ddl,
  schemaV3Ddl,
  schemaV4Ddl,
  schemaV5Ddl,
  vecTableDdl,
} from "../src/db/schema";
import { PLUGIN_VERSION } from "../src/version";

const V1_VEC_DDL = `CREATE VIRTUAL TABLE memories_vec USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding float[${EMBED_DIM}] distance_metric=cosine,
  type TEXT partition key,
  scope TEXT,
  project_id TEXT
)`;

const vecState = vi.hoisted(() => ({ failGetLoadablePath: false }));

vi.mock("sqlite-vec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sqlite-vec")>();
  return {
    ...actual,
    getLoadablePath: () => {
      if (vecState.failGetLoadablePath) {
        throw new Error("Unsupported platform for sqlite-vec");
      }
      return actual.getLoadablePath();
    },
  };
});

type MemoryInsert = {
  id: string | null;
  type: string;
  scope: string;
  project_id: string;
  title: string;
  abstract: string;
  content: string;
  importance: number | null;
  superseded_by: string | null;
  created_at: string | null;
  updated_at: string | null;
};

function memoryRow(overrides: Partial<MemoryInsert> = {}): MemoryInsert {
  return {
    id: "mem-1",
    type: "semantic",
    scope: "project",
    project_id: "proj-0000000000000001",
    title: "default title",
    abstract: "default abstract",
    content: "default content",
    importance: 0.5,
    superseded_by: null,
    created_at: "2026-10-13T00:00:00.000Z",
    updated_at: "2026-10-13T00:00:00.000Z",
    ...overrides,
  };
}

function insertMemory(db: Db, row: MemoryInsert): void {
  db.prepare(
    `INSERT INTO memories (id, type, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.type,
    row.scope,
    row.project_id,
    row.title,
    row.abstract,
    row.content,
    row.importance,
    row.superseded_by,
    row.created_at,
    row.updated_at,
  );
}

function tempConfig() {
  const pluginData = mkdtempSync(join(tmpdir(), "acm-db-"));
  return loadConfig({ CLAUDE_PLUGIN_DATA: pluginData });
}

function metaValue(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function objectNames(db: Db, type: string): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type) as {
    name: string;
  }[];
  return rows.map((row) => row.name);
}

function ftsHitCount(db: Db, term: string): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?")
    .get(term) as {
    n: number;
  };
  return row.n;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function createV1Database(dbPath: string): void {
  const raw = new Database(dbPath);
  try {
    raw.loadExtension(getLoadablePath());
    for (const statement of baselineDdl) {
      raw.exec(statement);
    }
    raw.exec(V1_VEC_DDL);
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    insertMemory(
      raw,
      memoryRow({
        id: "mem-v1-new",
        title: "deploy runbook",
        content: "  Run   DEPLOY via CI  ",
        created_at: "2026-09-01T00:00:00.000Z",
      }),
    );
    insertMemory(
      raw,
      memoryRow({
        id: "mem-v1-old",
        title: "deploy runbook legacy",
        content: "Run deploy by hand",
        superseded_by: "mem-v1-new",
        created_at: "2026-08-01T00:00:00.000Z",
      }),
    );
    const insertVector = raw.prepare(
      `INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id)
       VALUES (?, ?, 'semantic', 'project', 'proj-0000000000000001')`,
    );
    for (const id of ["mem-v1-new", "mem-v1-old"]) {
      insertVector.run(id, Buffer.from(new Float32Array(EMBED_DIM).fill(0.5).buffer));
    }
  } finally {
    raw.close();
  }
}

function createV2Database(dbPath: string): void {
  const raw = new Database(dbPath);
  try {
    raw.loadExtension(getLoadablePath());
    for (const statement of [...baselineDdl, ...schemaV2Ddl, vecTableDdl]) {
      raw.exec(statement);
    }
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '2')").run();
    insertMemory(raw, memoryRow({ id: "mem-v2-typed", importance: 0.9 }));
    raw
      .prepare(
        "UPDATE memories SET support_count = 2, used_count = 1, wrong_count = 1 WHERE id = ?",
      )
      .run("mem-v2-typed");
    insertMemory(raw, memoryRow({ id: "mem-v2-fresh", importance: 0.2 }));
  } finally {
    raw.close();
  }
}

function createV3Database(dbPath: string): void {
  const raw = new Database(dbPath);
  try {
    raw.loadExtension(getLoadablePath());
    for (const statement of [...baselineDdl, ...schemaV2Ddl, ...schemaV3Ddl, vecTableDdl]) {
      raw.exec(statement);
    }
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3')").run();
    insertMemory(raw, memoryRow({ id: "mem-v3" }));
  } finally {
    raw.close();
  }
}

function createV4Database(dbPath: string): void {
  const raw = new Database(dbPath);
  try {
    raw.loadExtension(getLoadablePath());
    for (const statement of [
      ...baselineDdl,
      ...schemaV2Ddl,
      ...schemaV3Ddl,
      ...schemaV4Ddl,
      vecTableDdl,
    ]) {
      raw.exec(statement);
    }
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4')").run();
    insertMemory(raw, memoryRow({ id: "mem-v4" }));
  } finally {
    raw.close();
  }
}

const V5_RECALL_EVENTS = [
  { id: 7, session_id: "s1", event: "SessionStart", at: "2026-10-14T00:00:00.000Z", injected: 2 },
  {
    id: 9,
    session_id: null,
    event: "UserPromptSubmit",
    at: "2026-10-14T00:01:00.000Z",
    injected: 0,
  },
  { id: 12, session_id: "s1", event: "PreToolUse", at: "2026-10-14T00:02:00.000Z", injected: 1 },
] as const;

function createV5Database(dbPath: string): void {
  const raw = new Database(dbPath);
  try {
    raw.loadExtension(getLoadablePath());
    for (const statement of [
      ...baselineDdl,
      ...schemaV2Ddl,
      ...schemaV3Ddl,
      ...schemaV4Ddl,
      ...schemaV5Ddl,
      vecTableDdl,
    ]) {
      raw.exec(statement);
    }
    raw
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', '5'), ('writer_version', '0.1.1')",
      )
      .run();
    insertMemory(raw, memoryRow({ id: "mem-v5" }));
    const recallEvent = raw.prepare(
      "INSERT INTO recall_events (id, session_id, event, at, injected) VALUES (@id, @session_id, @event, @at, @injected)",
    );
    for (const row of V5_RECALL_EVENTS) {
      recallEvent.run(row);
    }
    raw
      .prepare(
        "INSERT INTO command_failures (session_id, head, failed_at) VALUES ('s1', 'pytest', '2026-10-14T00:03:00.000Z')",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO project_settings (project_id, recall_enabled, updated_at) VALUES ('proj-a', 0, '2026-10-14T00:04:00.000Z')",
      )
      .run();
  } finally {
    raw.close();
  }
}

function tableRowCounts(db: Db): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .pluck()
    .all() as string[];
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db.prepare(`SELECT count(*) FROM "${table}"`).pluck().get() as number,
    ]),
  );
}

function v5TableRowCounts(dbPath: string): Record<string, number> {
  const raw = new Database(dbPath);
  try {
    raw.loadExtension(getLoadablePath());
    return tableRowCounts(raw);
  } finally {
    raw.close();
  }
}

afterEach(() => {
  vecState.failGetLoadablePath = false;
});

describe("openDatabase", () => {
  it("sets WAL, busy timeout, synchronous NORMAL and foreign keys at open", () => {
    const opened = openDatabase(tempConfig());
    try {
      expect(opened.db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(opened.db.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(opened.db.pragma("synchronous", { simple: true })).toBe(1);
      expect(opened.db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      opened.db.close();
    }
  });

  it("migrates a fresh database through every step to the current schema and is idempotent on reopen", () => {
    const config = tempConfig();
    const opened = openDatabase(config);
    try {
      expect(opened.vecLoaded).toBe(true);
      expect(metaValue(opened.db, "schema_version")).toBe(String(SCHEMA_VERSION));
      expect(metaValue(opened.db, "embedding_model")).toBe(MODEL_ID);
      expect(metaValue(opened.db, "embedding_dim")).toBe(String(EMBED_DIM));
      expect(objectNames(opened.db, "table")).toEqual(
        expect.arrayContaining([
          "meta",
          "memories",
          "relations",
          "memories_fts",
          "memories_vec",
          "transitions",
          "injections",
        ]),
      );
      expect(objectNames(opened.db, "index")).toEqual(
        expect.arrayContaining([
          "memories_scope_project",
          "memories_superseded_by",
          "memories_single_active_key",
          "relations_target",
        ]),
      );
      expect(objectNames(opened.db, "trigger")).toEqual(
        expect.arrayContaining([
          "relations_cap",
          "memories_fts_insert",
          "memories_fts_update",
          "memories_fts_delete",
        ]),
      );
    } finally {
      opened.db.close();
    }
    const reopened = openDatabase(config);
    try {
      expect(metaValue(reopened.db, "schema_version")).toBe(String(SCHEMA_VERSION));
    } finally {
      reopened.db.close();
    }
  });

  it("drops the vectors of another embedding model or dimension, keeps the memories and records the live model", () => {
    for (const [key, tampered] of [
      ["embedding_model", "Xenova/other-model"],
      ["embedding_dim", "768"],
    ] as const) {
      const config = tempConfig();
      openDatabase(config).db.close();
      const raw = new Database(config.dbPath);
      raw.loadExtension(getLoadablePath());
      insertMemory(raw, memoryRow({ id: "mem-kept" }));
      raw
        .prepare(
          `INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id, state)
           VALUES (?, ?, 'semantic', 'project', 'proj-0000000000000001', 'active')`,
        )
        .run("mem-kept", Buffer.from(new Float32Array(EMBED_DIM).fill(0.5).buffer));
      raw
        .prepare(
          `INSERT INTO questions_vec (question_id, embedding, memory_id, scope, project_id, state)
           VALUES ('mem-kept:0', ?, 'mem-kept', 'project', 'proj-0000000000000001', 'active')`,
        )
        .run(Buffer.from(new Float32Array(EMBED_DIM).fill(0.5).buffer));
      raw.prepare("UPDATE meta SET value = ? WHERE key = ?").run(tampered, key);
      raw.close();
      const reopened = openDatabase(config);
      try {
        expect({
          model: metaValue(reopened.db, "embedding_model"),
          dim: metaValue(reopened.db, "embedding_dim"),
          vectors: reopened.db.prepare("SELECT count(*) FROM memories_vec").pluck().get(),
          questionVectors: reopened.db.prepare("SELECT count(*) FROM questions_vec").pluck().get(),
          memories: reopened.db.prepare("SELECT id FROM memories").pluck().all(),
        }).toEqual({
          model: MODEL_ID,
          dim: String(EMBED_DIM),
          vectors: 0,
          questionVectors: 0,
          memories: ["mem-kept"],
        });
      } finally {
        reopened.db.close();
      }
    }
  });

  it("throws when the database records no embedding model", () => {
    const config = tempConfig();
    openDatabase(config).db.close();
    const raw = new Database(config.dbPath);
    raw.prepare("DELETE FROM meta WHERE key = ?").run("embedding_model");
    raw.close();
    expect(() => openDatabase(config)).toThrow(/embedding_model not set/);
  });

  it("stamps this build's writer version on open, replacing an older writer's", () => {
    const config = tempConfig();
    openDatabase(config).db.close();
    const raw = new Database(config.dbPath);
    const stamped = metaValue(raw, "writer_version");
    raw.prepare("UPDATE meta SET value = '0.0.9' WHERE key = 'writer_version'").run();
    raw.close();

    const reopened = openDatabase(config);
    try {
      expect(stamped).toBe(PLUGIN_VERSION);
      expect(metaValue(reopened.db, "writer_version")).toBe(PLUGIN_VERSION);
    } finally {
      reopened.db.close();
    }
  });

  it.each([
    { writerVersion: "9.9.9", writtenBy: "adaptive-cognitive-memory 9.9.9" },
    { writerVersion: undefined, writtenBy: "an unknown plugin version" },
  ])(
    "refuses a newer schema written by $writtenBy, naming both versions and the update",
    ({ writerVersion, writtenBy }) => {
      const config = tempConfig();
      openDatabase(config).db.close();
      const raw = new Database(config.dbPath);
      raw
        .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
        .run(String(SCHEMA_VERSION + 1));
      raw.prepare("DELETE FROM meta WHERE key = 'writer_version'").run();
      if (writerVersion !== undefined) {
        raw
          .prepare("INSERT INTO meta (key, value) VALUES ('writer_version', ?)")
          .run(writerVersion);
      }
      raw.close();

      expect(() => openDatabase(config)).toThrow(SchemaTooNewError);
      expect(() => openDatabase(config)).toThrow(
        `database schema ${SCHEMA_VERSION + 1} written by ${writtenBy} is newer than this build supports (schema ${SCHEMA_VERSION}, adaptive-cognitive-memory ${PLUGIN_VERSION}): update the plugin`,
      );
    },
  );

  it("degrades to vecLoaded=false without throwing and repairs memories_vec on the next loadable open", () => {
    const config = tempConfig();
    vecState.failGetLoadablePath = true;
    const degraded = openDatabase(config);
    try {
      expect(degraded.vecLoaded).toBe(false);
      expect(objectNames(degraded.db, "table")).not.toContain("memories_vec");
      expect(objectNames(degraded.db, "table")).toContain("memories");
    } finally {
      degraded.db.close();
    }
    vecState.failGetLoadablePath = false;
    const repaired = openDatabase(config);
    try {
      expect(repaired.vecLoaded).toBe(true);
      expect(objectNames(repaired.db, "table")).toContain("memories_vec");
    } finally {
      repaired.db.close();
    }
  });

  it("resolves the same database file from two working directories", () => {
    const pluginData = mkdtempSync(join(tmpdir(), "acm-plugin-"));
    const originalCwd = process.cwd();
    const cwdA = mkdtempSync(join(tmpdir(), "acm-cwd-"));
    const cwdB = mkdtempSync(join(tmpdir(), "acm-cwd-"));
    let first: OpenedDb | undefined;
    let second: OpenedDb | undefined;
    try {
      process.chdir(cwdA);
      const configA = loadConfig({ CLAUDE_PLUGIN_DATA: pluginData });
      first = openDatabase(configA);
      process.chdir(cwdB);
      const configB = loadConfig({ CLAUDE_PLUGIN_DATA: pluginData });
      second = openDatabase(configB);
      expect(configB.dbPath).toBe(configA.dbPath);
      expect(existsSync(configA.dbPath)).toBe(true);
      insertMemory(first.db, memoryRow({ id: "mem-ac3" }));
      expect(second.db.prepare("SELECT id FROM memories WHERE id = ?").get("mem-ac3")).toEqual({
        id: "mem-ac3",
      });
    } finally {
      process.chdir(originalCwd);
      first?.db.close();
      second?.db.close();
    }
  });
});

describe("isStorageRejection", () => {
  it.each([
    { error: new Database.SqliteError("database is locked", "SQLITE_BUSY"), expected: true },
    {
      error: new Database.SqliteError(
        "FOREIGN KEY constraint failed",
        "SQLITE_CONSTRAINT_FOREIGNKEY",
      ),
      expected: false,
    },
    {
      error: new Database.SqliteError("UNIQUE constraint failed", "SQLITE_CONSTRAINT_UNIQUE"),
      expected: true,
    },
    {
      error: new Database.SqliteError("relation cap 20 reached", "SQLITE_CONSTRAINT_TRIGGER"),
      expected: true,
    },
    {
      error: new Database.SqliteError("CHECK constraint failed", "SQLITE_CONSTRAINT_CHECK"),
      expected: false,
    },
    { error: new Database.SqliteError("malformed", "SQLITE_CORRUPT"), expected: false },
    { error: new TypeError("not a function"), expected: false },
  ])("is $expected for $error.message", ({ error, expected }) => {
    expect(isStorageRejection(error)).toBe(expected);
  });
});

describe("schema v2 migration", () => {
  it("migrates a v1 database: state from superseded_by, valid_from, content hash, rebuilt fts and a stateful vec table", () => {
    const config = tempConfig();
    createV1Database(config.dbPath);
    const opened = openDatabase(config);
    try {
      expect(metaValue(opened.db, "schema_version")).toBe(String(SCHEMA_VERSION));
      expect(
        opened.db
          .prepare("SELECT id, state, valid_from, content_hash FROM memories ORDER BY id")
          .all(),
      ).toEqual([
        {
          id: "mem-v1-new",
          state: "active",
          valid_from: "2026-09-01T00:00:00.000Z",
          content_hash: sha256Hex("run deploy via ci"),
        },
        {
          id: "mem-v1-old",
          state: "revoked",
          valid_from: "2026-08-01T00:00:00.000Z",
          content_hash: sha256Hex("run deploy by hand"),
        },
      ]);
      expect(ftsHitCount(opened.db, "runbook")).toBe(2);
      expect(ftsHitCount(opened.db, "hand")).toBe(0);
      expect(
        opened.db.prepare("SELECT memory_id, state FROM memories_vec ORDER BY memory_id").all(),
      ).toEqual([
        { memory_id: "mem-v1-new", state: "active" },
        { memory_id: "mem-v1-old", state: "revoked" },
      ]);
    } finally {
      opened.db.close();
    }
  });
});

describe("schema v3 migration", () => {
  it("migrates a v2 database: receipt sessions, injection lookups and importance derived from the counters", () => {
    const config = tempConfig();
    createV2Database(config.dbPath);
    const opened = openDatabase(config);
    try {
      expect(metaValue(opened.db, "schema_version")).toBe(String(SCHEMA_VERSION));
      expect(objectNames(opened.db, "table")).toContain("receipt_sessions");
      expect(objectNames(opened.db, "index")).toEqual(
        expect.arrayContaining(["injections_memory", "injections_at"]),
      );
      expect(
        opened.db.prepare("SELECT id, importance, support_count FROM memories ORDER BY id").all(),
      ).toEqual([
        { id: "mem-v2-fresh", importance: 1 / 2, support_count: 0 },
        { id: "mem-v2-typed", importance: 2 / 5, support_count: 2 },
      ]);
    } finally {
      opened.db.close();
    }
  });
});

describe("schema v4 migration", () => {
  it("migrates a v3 database: session signals and command failures with their caps, rows kept", () => {
    const config = tempConfig();
    createV3Database(config.dbPath);

    const opened = openDatabase(config);
    try {
      expect(metaValue(opened.db, "schema_version")).toBe(String(SCHEMA_VERSION));
      expect(opened.db.prepare("SELECT id FROM memories").all()).toEqual([{ id: "mem-v3" }]);
      const signal = opened.db.prepare(
        "INSERT INTO session_signals (session_id, kind, detail, opened_at, closed_at, closed_by) VALUES ('s1', ?, ?, '2026-10-14T00:00:00.000Z', ?, ?)",
      );
      signal.run("correction", "x".repeat(200), null, null);
      signal.run("resolution", "pytest", "2026-10-14T00:01:00.000Z", "checkpoint");
      for (const [kind, detail, closedAt, closedBy] of [
        ["mood", "x", null, null],
        ["remember", "x".repeat(201), null, null],
        ["remember", "x", "2026-10-14T00:01:00.000Z", null],
        ["remember", "x", "2026-10-14T00:01:00.000Z", "manual"],
      ] as const) {
        expect(() => signal.run(kind, detail, closedAt, closedBy), kind).toThrow(
          /CHECK constraint failed/,
        );
      }
      const failure = opened.db.prepare(
        "INSERT INTO command_failures (session_id, head, failed_at) VALUES ('s1', 'pytest', ?)",
      );
      failure.run("2026-10-14T00:00:00.000Z");
      expect(() => failure.run("2026-10-14T00:02:00.000Z")).toThrow(/UNIQUE constraint failed/);
    } finally {
      opened.db.close();
    }
  });
});

describe("schema v5 migration", () => {
  it("migrates a v4 database: recall events and per-project recall switches with their checks, rows kept", () => {
    const config = tempConfig();
    createV4Database(config.dbPath);

    const opened = openDatabase(config);
    try {
      expect(metaValue(opened.db, "schema_version")).toBe(String(SCHEMA_VERSION));
      expect(opened.db.prepare("SELECT id FROM memories").all()).toEqual([{ id: "mem-v4" }]);
      const recallEvent = opened.db.prepare(
        "INSERT INTO recall_events (session_id, event, at, injected) VALUES (?, ?, '2026-10-14T00:00:00.000Z', ?)",
      );
      recallEvent.run("s1", "SessionStart", 0);
      recallEvent.run(null, "UserPromptSubmit", 3);
      recallEvent.run("s1", "PreToolUse", 1);
      for (const [event, injected, failure] of [
        ["Stop", 0, /CHECK constraint failed/],
        ["PreToolUse", -1, /CHECK constraint failed/],
        ["PreToolUse", null, /NOT NULL constraint failed/],
      ] as const) {
        expect(() => recallEvent.run("s1", event, injected), event).toThrow(failure);
      }
      const recallSwitch = opened.db.prepare(
        "INSERT INTO project_settings (project_id, recall_enabled, updated_at) VALUES (?, ?, '2026-10-14T00:00:00.000Z')",
      );
      recallSwitch.run("proj-a", 0);
      recallSwitch.run("proj-b", 1);
      expect(() => recallSwitch.run("proj-c", 2)).toThrow(/CHECK constraint failed/);
      expect(() => recallSwitch.run("proj-a", 1)).toThrow(/UNIQUE constraint failed/);
    } finally {
      opened.db.close();
    }
  });
});

describe("schema v7 migration", () => {
  it("gives every kept memory an empty question list and creates the question vector table", () => {
    const config = tempConfig();
    createV5Database(config.dbPath);

    const opened = openDatabase(config);
    try {
      expect({
        questions: opened.db.prepare("SELECT id, questions FROM memories").all(),
        questionVectors: opened.db.prepare("SELECT count(*) FROM questions_vec").pluck().get(),
      }).toEqual({ questions: [{ id: "mem-v5", questions: "[]" }], questionVectors: 0 });
    } finally {
      opened.db.close();
    }
  });
});

describe("schema v6 migration", () => {
  it("migrates a v5 database: recall events rebuilt with the failure event and their ids, failure claims added, every row kept", () => {
    const config = tempConfig();
    createV5Database(config.dbPath);
    const before = v5TableRowCounts(config.dbPath);

    const opened = openDatabase(config);
    try {
      expect(metaValue(opened.db, "schema_version")).toBe(String(SCHEMA_VERSION));
      const after = tableRowCounts(opened.db);
      expect(
        Object.fromEntries(
          [...Object.keys(before), "failure_recalls"].map((table) => [table, after[table]]),
        ),
      ).toEqual({ ...before, failure_recalls: 0 });
      expect(
        opened.db
          .prepare("SELECT id, session_id, event, at, injected FROM recall_events ORDER BY id")
          .all(),
      ).toEqual(V5_RECALL_EVENTS);
      const recallEvent = opened.db.prepare(
        "INSERT INTO recall_events (session_id, event, at, injected) VALUES ('s2', ?, '2026-10-21T00:00:00.000Z', ?)",
      );
      expect(Number(recallEvent.run("PostToolUseFailure", 1).lastInsertRowid)).toBe(13);
      for (const [event, injected, failure] of [
        ["Stop", 0, /CHECK constraint failed/],
        ["PostToolUseFailure", -1, /CHECK constraint failed/],
      ] as const) {
        expect(() => recallEvent.run(event, injected), event).toThrow(failure);
      }
      const claim = opened.db.prepare(
        "INSERT INTO failure_recalls (session_id, head, recalled_at) VALUES ('s1', ?, '2026-10-21T00:00:00.000Z')",
      );
      claim.run("x".repeat(200));
      expect(() => claim.run("x".repeat(201))).toThrow(/CHECK constraint failed/);
      expect(() => claim.run("x".repeat(200))).toThrow(/UNIQUE constraint failed/);
    } finally {
      opened.db.close();
    }
  });
});

describe("schema v2", () => {
  it("keeps the external-content FTS index in sync across insert, update and delete", () => {
    const opened = openDatabase(tempConfig());
    const db = opened.db;
    try {
      insertMemory(
        db,
        memoryRow({
          id: "mem-fts-1",
          title: "postgres migration recipe",
          content: "run VACUUM after load",
        }),
      );
      db.prepare("UPDATE memories SET keywords = ? WHERE id = ?").run("vacuum", "mem-fts-1");
      expect(ftsHitCount(db, "postgres")).toBe(1);
      expect(ftsHitCount(db, "VACUUM")).toBe(1);
      db.prepare("UPDATE memories SET title = ? WHERE id = ?").run("mysql recipe", "mem-fts-1");
      expect(ftsHitCount(db, "postgres")).toBe(0);
      expect(ftsHitCount(db, "mysql")).toBe(1);
      db.prepare("DELETE FROM memories WHERE id = ?").run("mem-fts-1");
      expect(ftsHitCount(db, "mysql")).toBe(0);
      expect(ftsHitCount(db, "recipe")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("allows one active single-valued row per conflict key and partition, with one user partition across projects", () => {
    const opened = openDatabase(tempConfig());
    const db = opened.db;
    try {
      const insertKeyed = db.prepare(
        `INSERT INTO memories (id, type, scope, project_id, title, abstract, content, created_at, updated_at,
           conflict_key, cardinality, value_text, state)
         VALUES (?, 'semantic', ?, ?, 'title', 'abstract', 'content', '2026-10-13T00:00:00.000Z',
           '2026-10-13T00:00:00.000Z', 'project.primary_database', ?, ?, ?)`,
      );
      insertKeyed.run("key-a", "project", "proj-a", "single", "PostgreSQL 15", "active");
      insertKeyed.run("key-b", "project", "proj-b", "single", "MySQL 8", "active");
      insertKeyed.run("key-a-old", "project", "proj-a", "single", "PostgreSQL 14", "revoked");
      insertKeyed.run("key-a-multi", "project", "proj-a", "multi", "SQLite", "active");
      expect(() =>
        insertKeyed.run("key-a-dup", "project", "proj-a", "single", "SQLite", "active"),
      ).toThrow(/UNIQUE constraint failed/);
      insertKeyed.run("key-user-a", "user", "proj-a", "single", "PostgreSQL 15", "active");
      expect(() =>
        insertKeyed.run("key-user-b", "user", "proj-b", "single", "MySQL 8", "active"),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      db.close();
    }
  });

  it("rejects rows violating the CHECK caps, enums and NOT NULL constraints", () => {
    const opened = openDatabase(tempConfig());
    const db = opened.db;
    try {
      insertMemory(db, memoryRow({ title: "a".repeat(TITLE_MAX_CHARS) }));
      insertMemory(
        db,
        memoryRow({ id: "mem-abstract-cap", abstract: "a".repeat(ABSTRACT_MAX_CHARS) }),
      );
      insertMemory(
        db,
        memoryRow({ id: "mem-content-cap", content: "a".repeat(CONTENT_MAX_CHARS) }),
      );
      insertMemory(db, memoryRow({ id: "mem-importance-cap", importance: 1 }));
      const rejected: [string, MemoryInsert][] = [
        ["type", memoryRow({ id: "mem-bad-type", type: "emotional" })],
        ["scope", memoryRow({ id: "mem-bad-scope", scope: "global" })],
        ["title", memoryRow({ id: "mem-long-title", title: "a".repeat(TITLE_MAX_CHARS + 1) })],
        [
          "abstract",
          memoryRow({ id: "mem-long-abstract", abstract: "a".repeat(ABSTRACT_MAX_CHARS + 1) }),
        ],
        [
          "content",
          memoryRow({ id: "mem-long-content", content: "a".repeat(CONTENT_MAX_CHARS + 1) }),
        ],
        ["importance", memoryRow({ id: "mem-high-importance", importance: 1.5 })],
        ["importance", memoryRow({ id: "mem-null-importance", importance: null })],
        ["created_at", memoryRow({ id: "mem-null-created", created_at: null })],
        ["updated_at", memoryRow({ id: "mem-null-updated", updated_at: null })],
        ["id", memoryRow({ id: null })],
      ];
      for (const [column, row] of rejected) {
        expect(() => insertMemory(db, row), column).toThrow(/NOT NULL|CHECK constraint failed/);
      }
    } finally {
      db.close();
    }
  });

  it("enforces the per-source relation cap in the database and dedups by composite key", () => {
    const opened = openDatabase(tempConfig());
    const db = opened.db;
    try {
      insertMemory(db, memoryRow({ id: "mem-src-1" }));
      insertMemory(db, memoryRow({ id: "mem-src-2" }));
      for (let i = 0; i < RELATION_CAP; i++) {
        insertMemory(db, memoryRow({ id: `mem-tgt-${i}` }));
      }
      const insertRelation = db.prepare(
        "INSERT INTO relations (source_id, target_id, relation_type) VALUES (?, ?, ?)",
      );
      for (let i = 0; i < RELATION_CAP; i++) {
        insertRelation.run("mem-src-1", `mem-tgt-${i}`, "relates_to");
      }
      const capPattern = new RegExp(`relation cap ${RELATION_CAP}`);
      expect(() => insertRelation.run("mem-src-1", "mem-tgt-0", "blocks")).toThrow(capPattern);
      expect(() => insertRelation.run("mem-src-2", "mem-tgt-0", "relates_to")).not.toThrow();
      expect(() => insertRelation.run("mem-src-2", "mem-tgt-0", "relates_to")).toThrow(
        /UNIQUE constraint failed/,
      );
      insertMemory(db, memoryRow({ id: "mem-src-3" }));
      expect(() =>
        insertRelation.run("mem-src-3", "mem-tgt-0", "a".repeat(RELATION_TYPE_MAX_CHARS + 1)),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });
});
