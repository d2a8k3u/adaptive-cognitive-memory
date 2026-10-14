import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/cfg";
import { runCli } from "../src/cli";
import { type Db, openDatabase } from "../src/db/database";
import { EXPORT_HEADER, parseImport, planImport } from "../src/transfer";
import { FAKE_SECRETS } from "./fixtures/secrets";

const SECRET = FAKE_SECRETS.githubClassicLowercase;
const SUPERSEDED_ID = "01J8TRANSFER0000000000OLD1";
const REPLACEMENT_ID = "01J8TRANSFER0000000000REP1";

interface MemorySeed {
  id: string;
  scope?: "project" | "user";
  projectId?: string;
  kind?: string;
  conflictKey?: string;
  cardinality?: "single" | "multi";
  valueText?: string;
  state?: "active" | "hypothesis" | "revoked";
  content?: string;
  supersededBy?: string | null;
}

function insertMemory(db: Db, seed: MemorySeed): void {
  db.prepare(
    `INSERT INTO memories (id, type, kind, scope, project_id, title, abstract, content, conflict_key,
       cardinality, value_text, keywords, anchors, state, importance, support_count, injection_count,
       used_count, wrong_count, valid_from, last_injected_at, created_at, updated_at)
     VALUES (?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'deploy ecs', '["deploy/","make deploy"]', ?,
       0.6666666666666666, 2, 3, 1, 0, '2026-10-01T08:00:00.000Z', '2026-10-02T09:30:00.000Z',
       '2026-10-01T08:00:00.000Z', '2026-10-03T10:00:00.000Z')`,
  ).run(
    seed.id,
    seed.kind ?? "fact",
    seed.scope ?? "project",
    seed.projectId ?? "proj-transfer",
    `title of ${seed.id}`,
    `abstract of ${seed.id}`,
    seed.content ?? `content of ${seed.id}`,
    seed.conflictKey ?? "",
    seed.cardinality ?? "multi",
    seed.valueText ?? "",
    seed.state ?? "active",
  );
}

function pluginEnv(): NodeJS.ProcessEnv {
  return { CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "acm-transfer-")) };
}

function withDb<T>(env: NodeJS.ProcessEnv, work: (db: Db) => T): T {
  const opened = openDatabase(loadConfig(env));
  try {
    return work(opened.db);
  } finally {
    opened.db.close();
  }
}

function seedSource(db: Db): void {
  insertMemory(db, {
    id: REPLACEMENT_ID,
    conflictKey: "deploy.target",
    cardinality: "single",
    valueText: "ECS",
    content: `Deploy to ECS with token ${SECRET} from the vault.`,
  });
  insertMemory(db, {
    id: SUPERSEDED_ID,
    conflictKey: "deploy.target",
    cardinality: "single",
    valueText: "Heroku",
    state: "revoked",
  });
  db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(
    REPLACEMENT_ID,
    SUPERSEDED_ID,
  );
  insertMemory(db, { id: "01J8TRANSFER000000000USER1", scope: "user", kind: "preference" });
  insertMemory(db, { id: "01J8TRANSFER0000000000HYP1", state: "hypothesis" });
  db.prepare(
    "INSERT INTO relations (source_id, target_id, relation_type) VALUES (?, ?, 'explains')",
  ).run(REPLACEMENT_ID, "01J8TRANSFER000000000USER1");
  db.prepare(
    `INSERT INTO transitions (memory_id, from_state, to_state, reason, evidence, related_id, at)
     VALUES (?, 'active', 'revoked', 'superseded', 'ECS', ?, '2026-10-03T10:00:00.000Z')`,
  ).run(SUPERSEDED_ID, REPLACEMENT_ID);
  db.prepare(
    `INSERT INTO transitions (memory_id, from_state, to_state, reason, evidence, related_id, at)
     VALUES (?, 'active', 'hypothesis', 'feedback_wrong', 'wrong', NULL, '2026-10-04T10:00:00.000Z')`,
  ).run("01J8TRANSFER0000000000HYP1");
}

function exportTo(env: NodeJS.ProcessEnv, file: string): Promise<number> {
  return runCli(["node", "dist/cli.js", "export", file], env);
}

function importFrom(env: NodeJS.ProcessEnv, file: string): Promise<number> {
  return runCli(["node", "dist/cli.js", "import", file], env);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cli export and import", () => {
  it("round-trips byte for byte through an empty database, redacts secrets, stamps the export and re-imports as a no-op", async () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const source = pluginEnv();
    const target = pluginEnv();
    withDb(source, seedSource);
    const scratch = mkdtempSync(join(tmpdir(), "acm-transfer-files-"));
    const [first, second, third] = ["first.jsonl", "second.jsonl", "third.jsonl"].map((name) =>
      join(scratch, name),
    ) as [string, string, string];
    const startedAt = new Date().toISOString();

    const codes = [
      await exportTo(source, first),
      await importFrom(target, first),
      await exportTo(target, second),
      await importFrom(target, first),
      await exportTo(target, third),
    ];

    expect(codes).toEqual([0, 0, 0, 0, 0]);
    const exported = readFileSync(first, "utf8");
    expect(readFileSync(second, "utf8")).toBe(exported);
    expect(readFileSync(third, "utf8")).toBe(exported);
    expect(exported).not.toContain(SECRET);
    expect(exported).toContain("Deploy to ECS with token [REDACTED] from the vault.");
    expect(exported.split("\n").filter((line) => line !== "")).toHaveLength(8);
    expect(print.mock.calls.flat()).toEqual([
      `exported 4 memories, 1 relations, 2 transitions to ${first}`,
      "imported 4 memories (0 already present, skipped), 1 relations, 2 transitions; run node dist/cli.js reembed to embed them",
      `exported 4 memories, 1 relations, 2 transitions to ${second}`,
      "imported 0 memories (4 already present, skipped), 0 relations, 0 transitions; run node dist/cli.js reembed to embed them",
      `exported 4 memories, 1 relations, 2 transitions to ${third}`,
    ]);
    const lastExportAt = withDb(source, (db) =>
      db.prepare("SELECT value FROM meta WHERE key = 'last_export_at'").pluck().get(),
    );
    expect(typeof lastExportAt === "string" && lastExportAt >= startedAt).toBe(true);
    expect(
      withDb(target, (db) => db.prepare("SELECT count(*) FROM memories_vec").pluck().get()),
    ).toBe(0);
  });

  it("exports a capped title and abstract holding an unredacted secret as lines the import accepts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const source = pluginEnv();
    const target = pluginEnv();
    const cappedWithSecret = `${"t".repeat(182)} password=abcdefgh`;
    withDb(source, (db) => {
      insertMemory(db, { id: REPLACEMENT_ID });
      db.prepare("UPDATE memories SET title = ?, abstract = ? WHERE id = ?").run(
        cappedWithSecret,
        cappedWithSecret,
        REPLACEMENT_ID,
      );
    });
    const file = join(mkdtempSync(join(tmpdir(), "acm-transfer-files-")), "capped.jsonl");

    const codes = [await exportTo(source, file), await importFrom(target, file)];

    expect(codes).toEqual([0, 0]);
    expect(
      withDb(target, (db) => db.prepare("SELECT title, abstract FROM memories").get()),
    ).toEqual({
      title: `${"t".repeat(182)} password=[REDACTE`,
      abstract: `${"t".repeat(182)} password=[REDACTE`,
    });
  });

  it("redacts a secret in every imported text field before it is stored", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const target = pluginEnv();
    const secret = "password=hunter2secret";
    const masked = "password=[REDACTED]";
    const file = join(mkdtempSync(join(tmpdir(), "acm-transfer-files-")), "secret.jsonl");
    writeFileSync(
      file,
      fileOf(
        EXPORT_HEADER,
        {
          ...VALID_MEMORY,
          title: `title ${secret}`,
          abstract: `abstract ${secret}`,
          content: `content ${secret}`,
          value_text: `value ${secret}`,
          keywords: `keywords ${secret}`,
          anchors: [`anchor ${secret}`],
        },
        {
          record: "transition",
          memory_id: VALID_MEMORY.id,
          from_state: "active",
          to_state: "active",
          reason: "promoted",
          evidence: `evidence ${secret}`,
          related_id: null,
          at: "2026-10-01T00:00:00.000Z",
        },
      ),
    );

    const code = await importFrom(target, file);

    expect(code).toBe(0);
    expect(
      withDb(target, (db) => ({
        memory: db
          .prepare("SELECT title, abstract, content, value_text, keywords, anchors FROM memories")
          .get(),
        evidence: db.prepare("SELECT evidence FROM transitions").pluck().get(),
      })),
    ).toEqual({
      memory: {
        title: `title ${masked}`,
        abstract: `abstract ${masked}`,
        content: `content ${masked}`,
        value_text: `value ${masked}`,
        keywords: `keywords ${masked}`,
        anchors: JSON.stringify([`anchor ${masked}`]),
      },
      evidence: `evidence ${masked}`,
    });
  });

  it("rejects the whole import when an active single-valued row would take a slot another active row holds", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = pluginEnv();
    const target = pluginEnv();
    withDb(source, seedSource);
    withDb(target, (db) =>
      insertMemory(db, {
        id: "01J8TRANSFER000000HOLDER01",
        conflictKey: "deploy.target",
        cardinality: "single",
        valueText: "Fly.io",
      }),
    );
    const file = join(mkdtempSync(join(tmpdir(), "acm-transfer-files-")), "export.jsonl");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await exportTo(source, file);

    const code = await importFrom(target, file);

    expect(code).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toMatch(
      new RegExp(`${REPLACEMENT_ID}.*01J8TRANSFER000000HOLDER01`),
    );
    const kept = withDb(target, (db) => db.prepare("SELECT id FROM memories").pluck().all());
    expect(kept).toEqual(["01J8TRANSFER000000HOLDER01"]);
  });

  it("rejects a file with malformed lines, naming every line, and writes nothing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const target = pluginEnv();
    const file = join(mkdtempSync(join(tmpdir(), "acm-transfer-files-")), "broken.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify(EXPORT_HEADER),
        "{not json",
        JSON.stringify({ record: "embedding", memory_id: REPLACEMENT_ID }),
        "",
      ].join("\n"),
    );

    const code = await importFrom(target, file);

    expect(code).toBe(1);
    const reported = errors.mock.calls.flat().join("\n");
    expect(reported).toMatch(/line 2: /);
    expect(reported).toMatch(/line 3: unknown record 'embedding'/);
    const stored = withDb(target, (db) =>
      db.prepare("SELECT count(*) FROM memories").pluck().get(),
    );
    expect(stored).toBe(0);
  });

  it("refuses to overwrite an existing export file", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = pluginEnv();
    const file = join(mkdtempSync(join(tmpdir(), "acm-transfer-files-")), "kept.jsonl");
    writeFileSync(file, "keep me\n");

    const code = await exportTo(source, file);

    expect(code).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain(`refusing to overwrite ${file}`);
    expect(readFileSync(file, "utf8")).toBe("keep me\n");
    expect(
      withDb(source, (db) =>
        db.prepare("SELECT value FROM meta WHERE key = 'last_export_at'").pluck().get(),
      ),
    ).toBeUndefined();
  });
});

const VALID_MEMORY = {
  record: "memory",
  id: "01J8TRANSFER0000000000VAL1",
  type: "semantic",
  kind: "fact",
  scope: "project",
  project_id: "proj-transfer",
  title: "valid title",
  abstract: "valid abstract",
  content: "valid content",
  conflict_key: "",
  cardinality: "multi",
  value_text: "",
  keywords: "",
  anchors: [],
  epistemic: "verified",
  origin: "claude",
  state: "active",
  importance: 0.5,
  support_count: 0,
  conflict_count: 0,
  injection_count: 0,
  used_count: 0,
  wrong_count: 0,
  valid_from: "2026-10-01T00:00:00.000Z",
  invalid_at: null,
  expired_at: null,
  last_injected_at: null,
  superseded_by: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

function fileOf(...records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("parseImport", () => {
  it.each([
    {
      name: "a file without the export header",
      text: fileOf(VALID_MEMORY),
      error: /^line 1: expected the export header/,
    },
    {
      name: "an unknown field",
      text: fileOf(EXPORT_HEADER, { ...VALID_MEMORY, vector: [0.1] }),
      error: /^line 2: unknown field 'vector'/,
    },
    {
      name: "a missing field",
      text: fileOf(EXPORT_HEADER, { ...VALID_MEMORY, state: undefined }),
      error: /^line 2: state must be one of active, hypothesis, revoked/,
    },
    {
      name: "a title over the cap",
      text: fileOf(EXPORT_HEADER, { ...VALID_MEMORY, title: "t".repeat(201) }),
      error: /^line 2: title must be a string of at most 200 characters/,
    },
    {
      name: "a negative counter",
      text: fileOf(EXPORT_HEADER, { ...VALID_MEMORY, used_count: -1 }),
      error: /^line 2: used_count must be a non-negative integer/,
    },
    {
      name: "a timestamp that is not an ISO instant",
      text: fileOf(EXPORT_HEADER, { ...VALID_MEMORY, created_at: "yesterday" }),
      error: /^line 2: created_at must be an ISO-8601 UTC timestamp/,
    },
  ])("rejects $name", ({ text, error }) => {
    const parsed = parseImport(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.errors).toEqual([expect.stringMatching(error)]);
  });

  it("accepts a title of exactly 200 characters", () => {
    const parsed = parseImport(fileOf(EXPORT_HEADER, { ...VALID_MEMORY, title: "t".repeat(200) }));

    expect(parsed.ok).toBe(true);
  });
});

describe("planImport", () => {
  const single = {
    ...VALID_MEMORY,
    conflict_key: "deploy.target",
    cardinality: "single",
    value_text: "ECS",
  };

  it.each([
    {
      name: "a reference to a memory neither the file nor the database holds",
      records: [{ ...VALID_MEMORY, superseded_by: "01J8TRANSFER00000000GHOST1" }],
      error: /^line 2: superseded_by 01J8TRANSFER00000000GHOST1 names no memory/,
    },
    {
      name: "two active single-valued rows of the same slot",
      records: [single, { ...single, id: "01J8TRANSFER0000000000VAL2", value_text: "Fly.io" }],
      error:
        /^line 3: active single-valued 01J8TRANSFER0000000000VAL2 takes slot deploy\.target held by 01J8TRANSFER0000000000VAL1/,
    },
  ])("rejects $name", ({ records, error }) => {
    const parsed = parseImport(fileOf(EXPORT_HEADER, ...records));
    if (!parsed.ok) {
      throw new Error(parsed.errors.join("; "));
    }

    const plan = planImport(parsed.records, { existingIds: new Set(), slotHolders: [] });

    expect(plan.ok ? [] : plan.errors).toEqual([expect.stringMatching(error)]);
  });

  describe("relation cap", () => {
    const targets = Array.from(
      { length: 21 },
      (_, index) => `01J8TRANSFER00000TARGET${String(index).padStart(3, "0")}`,
    );
    const relation = (target: string) => ({
      record: "relation",
      source_id: VALID_MEMORY.id,
      target_id: target,
      relation_type: "explains",
    });

    function planned(relationTargets: readonly string[]) {
      const parsed = parseImport(
        fileOf(EXPORT_HEADER, VALID_MEMORY, ...relationTargets.map(relation)),
      );
      if (!parsed.ok) {
        throw new Error(parsed.errors.join("; "));
      }
      return planImport(parsed.records, { existingIds: new Set(targets), slotHolders: [] });
    }

    it("rejects the relation past the cap of its source, naming its line", () => {
      const plan = planned(targets);

      expect(plan.ok ? [] : plan.errors).toEqual([
        `line 23: relation to ${targets[20]} is relation 21 of ${VALID_MEMORY.id}; a memory holds at most 20 relations`,
      ]);
    });

    it("counts a repeated relation once and writes it once", () => {
      const firstTwenty = targets.slice(0, 20);
      const plan = planned([...firstTwenty, firstTwenty[0] as string]);

      expect(plan.ok ? plan.relations.map((row) => row.target_id) : plan.errors).toEqual(
        firstTwenty,
      );
    });
  });
});
