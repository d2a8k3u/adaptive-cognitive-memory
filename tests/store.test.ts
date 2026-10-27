import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Config, EMBED_DIM, loadConfig } from "../src/cfg";
import { type OpenedDb, openDatabase } from "../src/db/database";
import { recordFeedback } from "../src/db/feedback";
import {
  deleteMemory,
  deriveAbstract,
  embedMissing,
  get,
  type MemoryEnv,
  MemoryRejection,
  type StoreInput,
  type StoreOutcome,
  type StoreResult,
  store,
  updateMemory,
} from "../src/db/memories";
import { FAKE_SECRETS } from "./fixtures/secrets";

const PROJECT_ALPHA = "proj-alpha";
const PROJECT_BETA = "proj-beta";

const embedState = vi.hoisted(() => ({
  cached: true,
  inputs: [] as string[],
  queue: [] as Float32Array[],
  duringEmbed: undefined as (() => void) | undefined,
  default: (() => {
    const vector = new Float32Array(384);
    vector[0] = 1;
    return vector;
  })(),
}));

vi.mock("../src/embeddings", () => ({
  modelCached: () => embedState.cached,
  embedPassage: (texts: string[]) => {
    embedState.inputs.push(...texts);
    embedState.duringEmbed?.();
    return Promise.resolve(texts.map(() => embedState.queue.shift() ?? embedState.default));
  },
  embedQuestions: (texts: string[]) => Promise.resolve(texts.map(() => embedState.default)),
}));

const vecState = vi.hoisted(() => ({ failLoad: false }));

vi.mock("sqlite-vec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sqlite-vec")>();
  return {
    ...actual,
    getLoadablePath: () => {
      if (vecState.failLoad) {
        throw new Error("Unsupported platform for sqlite-vec");
      }
      return actual.getLoadablePath();
    },
  };
});

const openedDbs: OpenedDb[] = [];

function openEnv(pluginData = mkdtempSync(join(tmpdir(), "acm-store-"))): {
  env: MemoryEnv;
  config: Config;
} {
  const config = loadConfig({ CLAUDE_PLUGIN_DATA: pluginData });
  const opened = openDatabase(config);
  openedDbs.push(opened);
  return {
    env: { db: opened.db, vecLoaded: opened.vecLoaded, modelCacheDir: config.modelCacheDir },
    config,
  };
}

function vectorAtCosine(cosine: number): Float32Array {
  const vector = new Float32Array(EMBED_DIM);
  vector[0] = cosine;
  vector[1] = Math.sqrt(1 - cosine * cosine);
  return vector;
}

function input(overrides: Partial<StoreInput> = {}): StoreInput {
  return {
    title: "postgres migration recipe",
    content: "Always run VACUUM after bulk load. More detail here.",
    type: "semantic",
    kind: "procedure",
    conflictKey: "project.migration_recipe",
    cardinality: "multi",
    valueText: "",
    keywords: "",
    anchors: [],
    questions: [],
    scope: "project",
    ...overrides,
  };
}

const POSTGRES = input({
  title: "Primary database is PostgreSQL 15",
  content: "The service stores everything in PostgreSQL 15.",
  kind: "fact",
  conflictKey: "project.primary_database",
  cardinality: "single",
  valueText: "PostgreSQL 15",
});

const MYSQL = input({
  title: "Primary database is MySQL 8",
  content: "The service stores everything in MySQL 8.",
  kind: "fact",
  conflictKey: "project.primary_database",
  cardinality: "single",
  valueText: "MySQL 8",
});

const ADD = { resolution: { action: "ADD" } } as const;

function written(outcome: StoreOutcome): StoreResult {
  if (outcome.outcome !== "written") {
    throw new Error(`expected a write, got ${JSON.stringify(outcome)}`);
  }
  return outcome.result;
}

function scalar(env: MemoryEnv, sql: string, ...params: unknown[]): number {
  const row = env.db.prepare(sql).get(...params) as { n: number };
  return row.n;
}

function rowCount(env: MemoryEnv): number {
  return scalar(env, "SELECT count(*) AS n FROM memories");
}

function idByTitle(env: MemoryEnv, title: string): string {
  const row = env.db.prepare("SELECT id FROM memories WHERE title = ?").get(title) as
    | { id: string }
    | undefined;
  if (row === undefined) {
    throw new Error(`no memory titled ${title}`);
  }
  return row.id;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

afterEach(() => {
  for (const opened of openedDbs) {
    opened.db.close();
  }
  openedDbs.length = 0;
  embedState.cached = true;
  embedState.inputs = [];
  embedState.queue = [];
  embedState.duringEmbed = undefined;
  vecState.failLoad = false;
});

describe("store", () => {
  it("creates a memory with derived abstract, content hash, active vec row, fts row and the expanded-key passage", async () => {
    const { env } = openEnv();
    const result = written(
      await store(
        env,
        input({ keywords: "vacuum bulk load", anchors: ["db/maintenance.sql"] }),
        PROJECT_ALPHA,
      ),
    );
    expect(result).toEqual({
      id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      action: "created",
    });
    const record = get(env, result.id);
    expect(record).toMatchObject({
      type: "semantic",
      kind: "procedure",
      scope: "project",
      project_id: PROJECT_ALPHA,
      title: "postgres migration recipe",
      abstract: "Always run VACUUM after bulk load.",
      content: "Always run VACUUM after bulk load. More detail here.",
      conflict_key: "project.migration_recipe",
      cardinality: "multi",
      value_text: "",
      keywords: "vacuum bulk load",
      anchors: ["db/maintenance.sql"],
      state: "active",
      importance: 0.5,
      support_count: 0,
      superseded_by: null,
      invalid_at: null,
      relations: [],
    });
    expect(record.valid_from).toBe(record.created_at);
    expect(
      scalar(
        env,
        "SELECT count(*) AS n FROM memories WHERE content_hash = ?",
        sha256Hex("always run vacuum after bulk load. more detail here."),
      ),
    ).toBe(1);
    expect(embedState.inputs).toEqual([
      "postgres migration recipe. Always run VACUUM after bulk load. More detail here. vacuum bulk load",
    ]);
    expect(
      env.db.prepare("SELECT memory_id, type, scope, project_id, state FROM memories_vec").all(),
    ).toEqual([
      {
        memory_id: result.id,
        type: "semantic",
        scope: "project",
        project_id: PROJECT_ALPHA,
        state: "active",
      },
    ]);
    expect(
      scalar(env, "SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'bulk'"),
    ).toBe(1);
  });

  it("derives the abstract from the first sentence and caps overlong sentences", () => {
    expect(deriveAbstract("First sentence here. Second sentence.")).toBe("First sentence here.");
    expect(deriveAbstract("no punctuation at all")).toBe("no punctuation at all");
    expect(deriveAbstract("  trimmed space  ")).toBe("trimmed space");
    expect(deriveAbstract(`${"a".repeat(250)}. tail`)).toBe("a".repeat(200));
  });

  it("uses and redacts an explicit abstract override", async () => {
    const { env } = openEnv();
    const result = written(
      await store(
        env,
        input({ abstract: "hand abstract api_key=sk-abcdefgh123456789" }),
        PROJECT_ALPHA,
      ),
    );
    expect(get(env, result.id).abstract).toBe("hand abstract api_key=[REDACTED]");
  });

  it("redacts secrets in every stored text field at the persist boundary", async () => {
    const { env } = openEnv();
    const result = written(
      await store(
        env,
        input({
          title: `deploy notes ${FAKE_SECRETS.awsAccessKeyId}`,
          content: `rotate ${FAKE_SECRETS.anthropicKey} soon`,
          cardinality: "single",
          valueText: FAKE_SECRETS.huggingFace,
          keywords: FAKE_SECRETS.npm,
          anchors: [FAKE_SECRETS.githubClassicExample],
        }),
        PROJECT_ALPHA,
      ),
    );
    const record = get(env, result.id);
    expect(record).toMatchObject({
      title: "deploy notes [REDACTED]",
      content: "rotate [REDACTED] soon",
      value_text: "[REDACTED]",
      keywords: "[REDACTED]",
      anchors: ["[REDACTED]"],
    });
    expect(
      scalar(
        env,
        `SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH '${FAKE_SECRETS.awsAccessKeyId}'`,
      ),
    ).toBe(0);
  });

  it("stores an explicit user-scope memory with user vec row and creating-project provenance", async () => {
    const { env } = openEnv();
    const result = written(await store(env, input({ scope: "user" }), PROJECT_ALPHA));
    const record = get(env, result.id);
    expect(record.scope).toBe("user");
    expect(record.project_id).toBe(PROJECT_ALPHA);
    const vecRow = env.db
      .prepare("SELECT scope FROM memories_vec WHERE memory_id = ?")
      .get(result.id) as { scope: string };
    expect(vecRow.scope).toBe("user");
  });
});

describe("two-phase write protocol", () => {
  it("phase 1 lists same-key rows first, then semantic neighbours, and writes nothing", async () => {
    const { env } = openEnv();
    embedState.queue.push(vectorAtCosine(0.5));
    await store(env, { ...POSTGRES, ...ADD }, PROJECT_ALPHA);
    await store(
      env,
      input({
        title: "Cache layer is Redis 7",
        content: "Sessions are cached in Redis 7.",
        kind: "fact",
        conflictKey: "project.cache",
        cardinality: "single",
        valueText: "Redis 7",
        ...ADD,
      }),
      PROJECT_ALPHA,
    );
    const postgresId = idByTitle(env, POSTGRES.title);
    const redisId = idByTitle(env, "Cache layer is Redis 7");

    const outcome = await store(env, MYSQL, PROJECT_ALPHA);

    expect(rowCount(env)).toBe(2);
    expect(outcome.outcome).toBe("needs_resolution");
    const candidates = outcome.outcome === "needs_resolution" ? outcome.candidates : [];
    expect(candidates.map((candidate) => candidate.id)).toEqual([postgresId, redisId]);
    expect(candidates[0]).toEqual({
      id: postgresId,
      title: POSTGRES.title,
      kind: "fact",
      conflict_key: "project.primary_database",
      cardinality: "single",
      value_text: "PostgreSQL 15",
      valid_from: get(env, postgresId).valid_from,
      support_count: 0,
      scope: "project",
      state: "active",
    });
  });

  it("stores a value in project B without touching project A's row or creating a user row", async () => {
    const { env } = openEnv();
    await store(env, POSTGRES, PROJECT_ALPHA);
    const postgresId = idByTitle(env, POSTGRES.title);

    const outcome = await store(env, MYSQL, PROJECT_BETA);

    expect(scalar(env, "SELECT count(*) AS n FROM memories WHERE scope = 'user'")).toBe(0);
    expect(get(env, postgresId)).toMatchObject({ state: "active", superseded_by: null });
    const mysqlId = idByTitle(env, MYSQL.title);
    expect(get(env, mysqlId)).toMatchObject({ scope: "project", project_id: PROJECT_BETA });
    expect(outcome).toEqual({ outcome: "written", result: { id: mysqlId, action: "created" } });
  });

  it("rejects SUPERSEDE on a multi-valued key and ADD over another single value, writing nothing", async () => {
    const { env } = openEnv();
    const reviewer = (name: string) =>
      input({
        title: `${name} reviews pull requests`,
        content: `${name} reviews every pull request.`,
        conflictKey: "team.reviewers",
        cardinality: "multi",
        valueText: name,
      });
    await store(env, { ...reviewer("Buddy"), ...ADD }, PROJECT_ALPHA);
    embedState.queue.push(vectorAtCosine(0.5));
    await store(env, { ...POSTGRES, ...ADD }, PROJECT_ALPHA);
    const buddyId = idByTitle(env, "Buddy reviews pull requests");
    const postgresId = idByTitle(env, POSTGRES.title);

    const supersede = await store(
      env,
      { ...reviewer("Scout"), resolution: { action: "SUPERSEDE", target: buddyId } },
      PROJECT_ALPHA,
    );
    const add = await store(env, { ...MYSQL, ...ADD }, PROJECT_ALPHA);

    expect(supersede).toEqual({
      outcome: "rejected",
      reason: expect.stringMatching(/multi-valued/),
    });
    expect(add).toEqual({
      outcome: "rejected",
      reason: expect.stringContaining(`SUPERSEDE with target ${postgresId}`),
    });
    expect(rowCount(env)).toBe(2);
    expect(get(env, postgresId).state).toBe("active");
    expect(written(await store(env, { ...reviewer("Scout"), ...ADD }, PROJECT_ALPHA)).action).toBe(
      "created",
    );
  });

  it("SUPERSEDE revokes the target with validity bounds, a transition and a revoked vector", async () => {
    const { env } = openEnv();
    const question = ["Which database do we run on?"];
    await store(env, { ...POSTGRES, questions: question, ...ADD }, PROJECT_ALPHA);
    const postgresId = idByTitle(env, POSTGRES.title);

    const result = written(
      await store(
        env,
        {
          ...MYSQL,
          questions: question,
          resolution: { action: "SUPERSEDE", target: postgresId.slice(0, 10) },
        },
        PROJECT_ALPHA,
      ),
    );

    expect(result).toEqual({
      id: idByTitle(env, MYSQL.title),
      action: "superseded",
      refId: postgresId,
    });
    const current = get(env, result.id);
    const old = get(env, postgresId);
    expect(old).toMatchObject({
      state: "revoked",
      superseded_by: result.id,
      invalid_at: current.valid_from,
      expired_at: current.valid_from,
      content: POSTGRES.content,
    });
    expect(
      env.db
        .prepare(
          "SELECT memory_id, from_state, to_state, reason, evidence, related_id FROM transitions",
        )
        .all(),
    ).toEqual([
      {
        memory_id: postgresId,
        from_state: "active",
        to_state: "revoked",
        reason: "superseded",
        evidence: "MySQL 8",
        related_id: result.id,
      },
    ]);
    const vectorStates = [
      { memory_id: postgresId, state: "revoked" },
      { memory_id: result.id, state: "active" },
    ].sort((a, b) => (a.memory_id < b.memory_id ? -1 : 1));
    expect(
      env.db.prepare("SELECT memory_id, state FROM memories_vec ORDER BY memory_id").all(),
    ).toEqual(vectorStates);
    expect(
      env.db.prepare("SELECT memory_id, state FROM questions_vec ORDER BY memory_id").all(),
    ).toEqual(vectorStates);

    const next = await store(
      env,
      input({ ...POSTGRES, title: "Primary database is SQLite", valueText: "SQLite" }),
      PROJECT_ALPHA,
    );
    expect(next.outcome === "needs_resolution" ? next.candidates.map((c) => c.id) : []).toEqual([
      result.id,
    ]);
  });

  it("UPDATE rewrites the target in place, re-embeds it and rehashes its content", async () => {
    const { env } = openEnv();
    await store(env, { ...POSTGRES, ...ADD }, PROJECT_ALPHA);
    const postgresId = idByTitle(env, POSTGRES.title);
    embedState.inputs = [];

    const result = written(
      await store(
        env,
        {
          ...POSTGRES,
          title: "Primary database is PostgreSQL 15.4",
          content: "The service stores everything in PostgreSQL 15.4 on RDS.",
          valueText: "PostgreSQL 15.4",
          keywords: "postgres rds",
          resolution: { action: "UPDATE", target: postgresId },
        },
        PROJECT_ALPHA,
      ),
    );

    expect(result).toEqual({ id: postgresId, action: "updated" });
    expect(rowCount(env)).toBe(1);
    expect(get(env, postgresId)).toMatchObject({
      title: "Primary database is PostgreSQL 15.4",
      content: "The service stores everything in PostgreSQL 15.4 on RDS.",
      value_text: "PostgreSQL 15.4",
      keywords: "postgres rds",
      state: "active",
    });
    expect(
      scalar(
        env,
        "SELECT count(*) AS n FROM memories WHERE content_hash = ?",
        sha256Hex("the service stores everything in postgresql 15.4 on rds."),
      ),
    ).toBe(1);
    expect(embedState.inputs).toEqual([
      "Primary database is PostgreSQL 15.4. The service stores everything in PostgreSQL 15.4 on RDS. postgres rds",
    ]);
    expect(env.db.prepare("SELECT memory_id, state FROM memories_vec").all()).toEqual([
      { memory_id: postgresId, state: "active" },
    ]);
  });

  it("NOOP counts support on the target and changes nothing else, importance included", async () => {
    const { env } = openEnv();
    await store(env, { ...POSTGRES, ...ADD }, PROJECT_ALPHA);
    const postgresId = idByTitle(env, POSTGRES.title);
    const before = get(env, postgresId);

    const result = written(
      await store(
        env,
        {
          ...POSTGRES,
          title: "Postgres 15 again",
          resolution: { action: "NOOP", target: postgresId },
        },
        PROJECT_ALPHA,
      ),
    );

    expect(result).toEqual({ id: postgresId, action: "noop" });
    expect(get(env, postgresId)).toEqual({ ...before, support_count: 1 });
  });

  it("treats an exact normalised content duplicate in the partition as a NOOP that counts support", async () => {
    const { env } = openEnv();
    await store(env, { ...POSTGRES, ...ADD }, PROJECT_ALPHA);
    const postgresId = idByTitle(env, POSTGRES.title);
    const duplicate = {
      ...MYSQL,
      title: "Database again",
      content: "  the SERVICE stores   everything in postgresql 15. ",
    };

    const phaseOne = written(await store(env, duplicate, PROJECT_ALPHA));
    const added = written(await store(env, { ...duplicate, ...ADD }, PROJECT_ALPHA));
    const otherProject = written(await store(env, duplicate, PROJECT_BETA));

    expect(phaseOne).toEqual({ id: postgresId, action: "noop" });
    expect(added).toEqual({ id: postgresId, action: "noop" });
    expect(get(env, postgresId).support_count).toBe(2);
    expect(otherProject.action).toBe("created");
    expect(rowCount(env)).toBe(2);
  });
});

describe("reasserting a hypothesis memory", () => {
  async function demotedPostgres(env: MemoryEnv): Promise<string> {
    await store(env, { ...POSTGRES, ...ADD }, PROJECT_ALPHA);
    const postgresId = idByTitle(env, POSTGRES.title);
    recordFeedback(env, {
      projectId: PROJECT_ALPHA,
      ids: [postgresId],
      verdict: "wrong",
      at: "2026-10-14T10:00:00.000Z",
    });
    return postgresId;
  }

  function reactivations(env: MemoryEnv, id: string): unknown[] {
    return env.db
      .prepare(
        "SELECT reason FROM transitions WHERE memory_id = ? AND to_state = 'active' ORDER BY rowid",
      )
      .all(id);
  }

  it.each([
    { name: "an exact duplicate", resolution: undefined, action: "noop" },
    { name: "a NOOP resolution", resolution: "NOOP", action: "noop" },
    { name: "an UPDATE resolution", resolution: "UPDATE", action: "updated" },
  ] as const)("brings it back to active through $name", async ({ resolution, action }) => {
    const { env } = openEnv();
    const postgresId = await demotedPostgres(env);
    const restated =
      resolution === undefined
        ? POSTGRES
        : {
            ...POSTGRES,
            content: "The service keeps every record in PostgreSQL 15.",
            resolution: { action: resolution, target: postgresId },
          };

    const result = written(await store(env, restated, PROJECT_ALPHA));

    expect(result).toEqual({ id: postgresId, action });
    expect(get(env, postgresId).state).toBe("active");
    expect(env.db.prepare("SELECT state FROM memories_vec").all()).toEqual([{ state: "active" }]);
    expect(reactivations(env, postgresId)).toEqual([
      { reason: resolution === "UPDATE" ? "store_update" : "store_noop" },
    ]);
    expect(rowCount(env)).toBe(1);
  });

  it.each([
    { name: "under the same key", conflictKey: POSTGRES.conflictKey },
    { name: "under another key", conflictKey: "project.database_engine" },
  ])(
    "offers it as a candidate with its state when the lesson is stored again $name",
    async ({ conflictKey }) => {
      const { env } = openEnv();
      const postgresId = await demotedPostgres(env);

      const outcome = await store(
        env,
        { ...POSTGRES, conflictKey, content: "Every record lives in PostgreSQL 15." },
        PROJECT_ALPHA,
      );

      expect(outcome.outcome === "needs_resolution" ? outcome.candidates : []).toEqual([
        expect.objectContaining({ id: postgresId, state: "hypothesis" }),
      ]);
      expect(rowCount(env)).toBe(1);
    },
  );

  it("rejects bringing it back while another memory holds its single-valued key", async () => {
    const { env } = openEnv();
    const postgresId = await demotedPostgres(env);
    await store(env, { ...MYSQL, ...ADD }, PROJECT_ALPHA);

    const outcome = await store(env, POSTGRES, PROJECT_ALPHA);

    expect(outcome).toEqual({
      outcome: "rejected",
      reason: expect.stringMatching(new RegExp(`${postgresId} cannot return to active`)),
    });
    expect(get(env, postgresId)).toMatchObject({ state: "hypothesis", support_count: 0 });
  });
});

describe("id and prefix resolution", () => {
  it("resolves a unique id prefix and rejects ambiguous or unknown references", async () => {
    const { env } = openEnv();
    const stored = written(await store(env, input(), PROJECT_ALPHA));
    expect(get(env, stored.id.slice(0, 8)).id).toBe(stored.id);
    expect(() => get(env, "ZZZZZZZZZZZZ")).toThrow(/memory not found/);
    const insertAmbiguous = env.db.prepare(
      `INSERT INTO memories (id, type, scope, project_id, title, abstract, content, created_at, updated_at)
       VALUES (?, 'semantic', 'project', 'proj-seed', 'title', 'abstract', 'content', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    insertAmbiguous.run("PFXAMBIG1alpha");
    insertAmbiguous.run("PFXAMBIG2beta");
    expect(() => get(env, "PFXAMBIG")).toThrow(
      /ambiguous memory id or prefix 'PFXAMBIG' matches 2 memories/,
    );
  });
});

describe("update", () => {
  it("updates fields, re-derives the abstract, re-redacts, rehashes, re-embeds and bumps updated_at", async () => {
    const { env } = openEnv();
    const stored = written(
      await store(
        env,
        input({ title: "deploy guide", content: "Use port 3000 for dev.", keywords: "port" }),
        PROJECT_ALPHA,
      ),
    );
    embedState.inputs = [];
    const updated = await updateMemory(env, stored.id.slice(0, 8), {
      title: "deploy guide v2",
      content: `Use port 4000 for dev with key ${FAKE_SECRETS.awsAccessKeyId}.`,
    });
    expect(updated.title).toBe("deploy guide v2");
    expect(updated.abstract).toBe("Use port 4000 for dev with key [REDACTED].");
    expect(updated.content).toBe("Use port 4000 for dev with key [REDACTED].");
    expect(updated.updated_at).not.toBe(updated.created_at);
    expect(
      scalar(
        env,
        "SELECT count(*) AS n FROM memories WHERE content_hash = ?",
        sha256Hex("use port 4000 for dev with key [redacted]."),
      ),
    ).toBe(1);
    expect(embedState.inputs).toEqual([
      "deploy guide v2. Use port 4000 for dev with key [REDACTED]. port",
    ]);
    expect(
      scalar(env, "SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH '3000'"),
    ).toBe(0);
    expect(
      scalar(env, "SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH '4000'"),
    ).toBe(1);
    expect(env.db.prepare("SELECT state FROM memories_vec").all()).toEqual([{ state: "active" }]);
  });

  it("keeps a concurrent edit and embeds the committed text when the row changed during the embedding", async () => {
    const { env } = openEnv();
    const stored = written(
      await store(
        env,
        input({ title: "deploy guide", content: "Use port 3000 for dev." }),
        PROJECT_ALPHA,
      ),
    );
    embedState.inputs = [];
    embedState.queue.push(vectorAtCosine(0.2), vectorAtCosine(0.9));
    embedState.duringEmbed = () => {
      embedState.duringEmbed = undefined;
      env.db
        .prepare("UPDATE memories SET abstract = ?, content = ? WHERE id = ?")
        .run("Use port 4000 for dev.", "Use port 4000 for dev.", stored.id);
    };

    const updated = await updateMemory(env, stored.id, { title: "deploy guide v2" });

    expect(updated).toMatchObject({
      title: "deploy guide v2",
      abstract: "Use port 4000 for dev.",
      content: "Use port 4000 for dev.",
    });
    expect(embedState.inputs.at(-1)).toBe("deploy guide v2. Use port 4000 for dev.");
    const embedding = env.db
      .prepare("SELECT embedding FROM memories_vec WHERE memory_id = ?")
      .pluck()
      .get(stored.id) as Buffer;
    expect(new Float32Array(embedding.buffer, embedding.byteOffset, EMBED_DIM)[0]).toBeCloseTo(0.9);
  });

  it("rejects an update whose row keeps changing during every embedding, writing nothing", async () => {
    const { env } = openEnv();
    const stored = written(
      await store(env, input({ content: "Original content." }), PROJECT_ALPHA),
    );
    let edits = 0;
    embedState.duringEmbed = () => {
      edits += 1;
      env.db
        .prepare("UPDATE memories SET content = ? WHERE id = ?")
        .run(`Concurrent edit ${edits}.`, stored.id);
    };

    await expect(updateMemory(env, stored.id, { title: "never lands" })).rejects.toThrow(
      new MemoryRejection(
        `memory ${stored.id} changed during each of 3 update attempts; nothing was written, retry the update`,
      ),
    );
    expect(get(env, stored.id).title).toBe("postgres migration recipe");
  });

  it("drops the stale vec row when text changes without a cached model", async () => {
    const { env } = openEnv();
    const stored = written(
      await store(env, input({ content: "Original content." }), PROJECT_ALPHA),
    );
    embedState.cached = false;
    const updated = await updateMemory(env, stored.id, { content: "Rewritten content." });
    expect(updated.abstract).toBe("Rewritten content.");
    expect(scalar(env, "SELECT count(*) AS n FROM memories_vec")).toBe(0);
    expect(
      scalar(env, "SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'Rewritten'"),
    ).toBe(1);
  });

  it("rejects updates to revoked rows as immutable history", async () => {
    const { env } = openEnv();
    await store(env, { ...POSTGRES, ...ADD }, PROJECT_ALPHA);
    const postgresId = idByTitle(env, POSTGRES.title);
    await store(
      env,
      { ...MYSQL, resolution: { action: "SUPERSEDE", target: postgresId } },
      PROJECT_ALPHA,
    );
    await expect(updateMemory(env, postgresId, { title: "Postgres retitled" })).rejects.toThrow(
      `memory ${postgresId} is revoked and immutable`,
    );
  });
});

describe("delete", () => {
  it("deletes the row, its vec row and its outgoing relations, and refuses unknown ids", async () => {
    const { env } = openEnv();
    const alpha = written(
      await store(
        env,
        input({ title: "alpha row", content: "Alpha body.", ...ADD }),
        PROJECT_ALPHA,
      ),
    );
    embedState.queue.push(vectorAtCosine(0.5));
    const beta = written(
      await store(env, input({ title: "beta row", content: "Beta body.", ...ADD }), PROJECT_ALPHA),
    );
    const insertRelation = env.db.prepare(
      "INSERT INTO relations (source_id, target_id, relation_type) VALUES (?, ?, ?)",
    );
    insertRelation.run(alpha.id, beta.id, "relates_to");
    insertRelation.run(beta.id, alpha.id, "blocks");
    expect(deleteMemory(env, alpha.id)).toEqual({ deleted: true });
    expect(scalar(env, "SELECT count(*) AS n FROM relations")).toBe(0);
    expect(rowCount(env)).toBe(1);
    expect(scalar(env, "SELECT count(*) AS n FROM memories_vec")).toBe(1);
    expect(
      scalar(env, "SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'alpha'"),
    ).toBe(0);
    expect(() => deleteMemory(env, alpha.id)).toThrow(/memory not found/);
  });

  it("deletes a superseded row with its transition but refuses the row that supersedes it", async () => {
    const { env } = openEnv();
    await store(env, { ...POSTGRES, ...ADD }, PROJECT_ALPHA);
    const postgresId = idByTitle(env, POSTGRES.title);
    const mysql = written(
      await store(
        env,
        { ...MYSQL, resolution: { action: "SUPERSEDE", target: postgresId } },
        PROJECT_ALPHA,
      ),
    );
    expect(() => deleteMemory(env, mysql.id)).toThrow(MemoryRejection);
    expect(() => deleteMemory(env, mysql.id)).toThrow(
      `memory ${mysql.id} cannot be deleted: it is the superseded_by of ${postgresId}; delete ${postgresId} first to drop that history, or keep ${mysql.id} and replace its value with memory_store resolution SUPERSEDE`,
    );
    expect(deleteMemory(env, postgresId)).toEqual({ deleted: true });
    expect(scalar(env, "SELECT count(*) AS n FROM transitions")).toBe(0);
    expect(rowCount(env)).toBe(1);
  });
});

describe("degraded store", () => {
  it("without the model a short title gets keyword candidates instead of merging into an unrelated memory", async () => {
    const { env } = openEnv();
    embedState.cached = false;
    const commitHygiene = input({
      title: "Commit hygiene",
      content:
        "Run the unit tests and the linter before every commit, and never commit generated files.",
      type: "pattern",
      kind: "constraint",
      conflictKey: "project.commit_hygiene",
    });
    const integrationTests = input({
      title: "tests",
      content:
        "Integration tests need the Postgres container from docker compose up db before they run.",
      kind: "fact",
      conflictKey: "project.integration_test_dependencies",
    });
    await store(env, commitHygiene, PROJECT_ALPHA);
    const commitId = idByTitle(env, "Commit hygiene");

    const phaseOne = await store(env, integrationTests, PROJECT_ALPHA);

    expect(scalar(env, "SELECT count(*) AS n FROM memories_vec")).toBe(0);
    expect(rowCount(env)).toBe(1);
    expect(get(env, commitId).content).toBe(commitHygiene.content);
    expect(
      phaseOne.outcome === "needs_resolution" ? phaseOne.candidates.map((c) => c.id) : [],
    ).toEqual([commitId]);
    const added = written(await store(env, { ...integrationTests, ...ADD }, PROJECT_ALPHA));
    expect(added.action).toBe("created");
    expect(get(env, added.id).content).toBe(integrationTests.content);
  });

  it("backfills a vector only for a row whose text did not change while it was embedded", async () => {
    const { env } = openEnv();
    embedState.cached = false;
    const steady = written(await store(env, input({ title: "steady row" }), PROJECT_ALPHA));
    const edited = written(
      await store(
        env,
        input({ title: "edited row", content: "Other body.", ...ADD }),
        PROJECT_ALPHA,
      ),
    );
    embedState.cached = true;
    embedState.duringEmbed = () => {
      env.db.prepare("UPDATE memories SET title = 'edited row v2' WHERE id = ?").run(edited.id);
    };

    const embedded = await embedMissing(env, 10, "active");

    expect(embedded).toBe(1);
    expect(env.db.prepare("SELECT memory_id FROM memories_vec").all()).toEqual([
      { memory_id: steady.id },
    ]);
  });

  it("stores while the vec extension fails to load", async () => {
    vecState.failLoad = true;
    const { env } = openEnv();
    expect(env.vecLoaded).toBe(false);
    const result = written(await store(env, input({ title: "no vec row" }), PROJECT_ALPHA));
    expect(result.action).toBe("created");
    expect(get(env, result.id).title).toBe("no vec row");
  });
});

describe("reopen", () => {
  it("keeps memories retrievable from a freshly opened database (AC-4 store level)", async () => {
    const pluginData = mkdtempSync(join(tmpdir(), "acm-plugin-swap-"));
    const first = openEnv(pluginData);
    const stored = written(
      await store(
        first.env,
        input({ title: "survives update", content: "Durable fact." }),
        PROJECT_ALPHA,
      ),
    );
    const second = openEnv(pluginData);
    const record = get(second.env, stored.id.slice(0, 8));
    expect(record.title).toBe("survives update");
    expect(record.content).toBe("Durable fact.");
  });
});
