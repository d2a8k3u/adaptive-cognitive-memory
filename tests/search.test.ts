import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMBED_DEADLINE_MS, EMBED_DIM, loadConfig } from "../src/cfg";
import { type Db, type OpenedDb, openDatabase } from "../src/db/database";
import { lastEmbeddingTimeout } from "../src/db/health";
import { embedPassage, embedQuestions } from "../src/embeddings";
import type { MemoryKind, MemoryScope, MemoryType } from "../src/policy";
import {
  anyTermMatchExpression,
  ftsMatchExpression,
  pinnedCandidates,
  promptCandidates,
  type RecallOptions,
  type RecallResult,
  recall,
  rrfFuse,
  sessionStartLimit,
} from "../src/search";
import { testModelCacheDir } from "../vitest.config";

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

const embedState = vi.hoisted(() => ({
  failEmbedQuery: false,
  hangEmbedQuery: false,
  stubQueryVector: undefined as Float32Array | undefined,
  embedQueryCalls: 0,
}));

vi.mock("../src/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embeddings")>();
  return {
    ...actual,
    embedQuery: (text: string, modelCacheDir: string) => {
      embedState.embedQueryCalls += 1;
      if (embedState.failEmbedQuery) {
        return Promise.reject(new Error("onnxruntime session failed"));
      }
      if (embedState.hangEmbedQuery) {
        return new Promise<Float32Array>(() => {});
      }
      if (embedState.stubQueryVector !== undefined) {
        return Promise.resolve(embedState.stubQueryVector);
      }
      return actual.embedQuery(text, modelCacheDir);
    },
  };
});

const PROJECT_A = "proj-search-a";
const PROJECT_B = "proj-search-b";
const BASE_TIME = "2026-10-13T00:00:00.000Z";
const NOW = "2026-10-14T00:00:00.000Z";

interface SeedMemory {
  id: string;
  projectId: string;
  scope: MemoryScope;
  type: MemoryType;
  kind?: MemoryKind;
  title: string;
  abstract: string;
  importance: number;
  createdAt?: string;
  supersededBy?: string;
  state?: "hypothesis" | "active" | "revoked";
  invalidAt?: string;
  vector?: boolean;
  questions?: readonly string[];
}

function tempConfig() {
  const pluginData = mkdtempSync(join(tmpdir(), "acm-search-"));
  return loadConfig({ CLAUDE_PLUGIN_DATA: pluginData });
}

async function openSeeded(rows: readonly SeedMemory[]): Promise<OpenedDb> {
  const opened = openDatabase(tempConfig());
  const insert = opened.db.prepare(
    `INSERT INTO memories (id, type, kind, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at, state, invalid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertVec = opened.db.prepare.bind(opened.db);
  const embeddable: SeedMemory[] = [];
  for (const row of rows) {
    insert.run(
      row.id,
      row.type,
      row.kind ?? "fact",
      row.scope,
      row.projectId,
      row.title,
      row.abstract,
      `content of ${row.id}`,
      row.importance,
      row.supersededBy ?? null,
      row.createdAt ?? BASE_TIME,
      row.createdAt ?? BASE_TIME,
      row.state ?? "active",
      row.invalidAt ?? null,
    );
    if (row.vector) {
      embeddable.push(row);
    }
  }
  if (embeddable.length > 0) {
    const vectors = await embedPassage(
      embeddable.map((row) => `${row.title} ${row.abstract}`),
      testModelCacheDir,
    );
    const insertVector = insertVec(
      "INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id, state) VALUES (?, ?, ?, ?, ?, ?)",
    );
    embeddable.forEach((row, index) => {
      insertVector.run(
        row.id,
        JSON.stringify(Array.from(vectors[index]!)),
        row.type,
        row.scope,
        row.projectId,
        row.state ?? "active",
      );
    });
  }
  const questioned = rows.flatMap((row) =>
    (row.questions ?? []).map((question, index) => ({ row, question, index })),
  );
  if (questioned.length > 0) {
    const vectors = await embedQuestions(
      questioned.map(({ question }) => question),
      testModelCacheDir,
    );
    const insertQuestion = opened.db.prepare(
      `INSERT INTO questions_vec (question_id, embedding, memory_id, scope, project_id, state)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    questioned.forEach(({ row, index }, position) => {
      insertQuestion.run(
        `${row.id}:${index}`,
        JSON.stringify(Array.from(vectors[position]!)),
        row.id,
        row.scope,
        row.projectId,
        row.state ?? "active",
      );
    });
  }
  return opened;
}

function trackStatements(db: Db): string[] {
  const executed: string[] = [];
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    const bound = {
      all: statement.all.bind(statement),
      get: statement.get.bind(statement),
      run: statement.run.bind(statement),
    };
    Object.defineProperties(statement, {
      all: {
        value: (...args: unknown[]) => {
          executed.push(sql);
          return bound.all(...args);
        },
      },
      get: {
        value: (...args: unknown[]) => {
          executed.push(sql);
          return bound.get(...args);
        },
      },
      run: {
        value: (...args: unknown[]) => {
          executed.push(sql);
          return bound.run(...args);
        },
      },
    });
    return statement;
  }) as typeof db.prepare;
  return executed;
}

function hybridOptions(overrides: Partial<RecallOptions> = {}): RecallOptions {
  return {
    projectId: PROJECT_B,
    modelCacheDir: testModelCacheDir,
    query: "database deployment",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vecState.failGetLoadablePath = false;
  embedState.failEmbedQuery = false;
  embedState.hangEmbedQuery = false;
  embedState.stubQueryVector = undefined;
  embedState.embedQueryCalls = 0;
});

async function pastEmbeddingDeadline<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  embedState.hangEmbedQuery = true;
  const pending = work();
  await vi.advanceTimersByTimeAsync(EMBED_DEADLINE_MS);
  const settled = await pending;
  embedState.hangEmbedQuery = false;
  vi.useRealTimers();
  return settled;
}

describe("rrfFuse", () => {
  it("sums 1/(60+rank) per ranking list, fusing on the id", () => {
    const scores = rrfFuse([
      ["a", "b", "c"],
      ["b", "d"],
    ]);
    expect(scores.get("a")).toBeCloseTo(1 / 61, 12);
    expect(scores.get("b")).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(scores.get("c")).toBeCloseTo(1 / 63, 12);
    expect(scores.get("d")).toBeCloseTo(1 / 62, 12);
    expect(scores.size).toBe(4);
  });
});

describe("ftsMatchExpression", () => {
  it("ORs every quoted distinct word so one matching term is enough and operators stay literal", () => {
    expect(ftsMatchExpression("How do I deploy the database?")).toBe(
      '"how" OR "do" OR "deploy" OR "the" OR "database"',
    );
    expect(ftsMatchExpression('NEAR( "x" OR AND * the')).toBe('"near" OR "or" OR "and" OR "the"');
    expect(ftsMatchExpression("   ")).toBe("");
  });
});

describe("anyTermMatchExpression", () => {
  it("ORs each term once case-insensitively, quoted literally, up to the term cap", () => {
    expect(anyTermMatchExpression(["Run the tests", "the TESTS run"], 32)).toBe(
      '"Run" OR "the" OR "tests"',
    );
    expect(anyTermMatchExpression(['say "hi" NEAR('], 32)).toBe('"say" OR """hi""" OR "NEAR("');
    const fortyTerms = Array.from({ length: 40 }, (_, index) => `term${index}`).join(" ");
    expect(anyTermMatchExpression([fortyTerms], 32).split(" OR ")).toHaveLength(32);
    expect(anyTermMatchExpression(["   ", ""], 32)).toBe("");
  });
});

describe("sessionStartLimit", () => {
  it("sizes the cap to fill the budget with minimal lines", () => {
    expect(sessionStartLimit(1200)).toBe(75);
    expect(sessionStartLimit(300)).toBe(19);
    expect(sessionStartLimit(16)).toBe(1);
    expect(sessionStartLimit(17)).toBe(2);
    expect(sessionStartLimit(1)).toBe(1);
  });
});

describe("pinnedCandidates", () => {
  it("offers the visible constraints and preferences with their importance and last activity", async () => {
    const pinnedRow = (id: string, overrides: Partial<SeedMemory>): SeedMemory => ({
      id,
      projectId: PROJECT_B,
      scope: "project",
      type: "pattern",
      kind: "constraint",
      title: `pinned ${id}`,
      abstract: `pinned abstract ${id}`,
      importance: 0.5,
      ...overrides,
    });
    const opened = await openSeeded([
      pinnedRow("pin-own", { importance: 0.75 }),
      pinnedRow("pin-user", { scope: "user", projectId: PROJECT_A, kind: "preference" }),
      pinnedRow("pin-fact", { kind: "fact" }),
      pinnedRow("pin-procedure", { kind: "procedure" }),
      pinnedRow("pin-foreign", { projectId: PROJECT_A }),
      pinnedRow("pin-doubt", { state: "hypothesis" }),
    ]);
    try {
      opened.db
        .prepare("UPDATE memories SET last_injected_at = ? WHERE id = ?")
        .run(NOW, "pin-user");

      const pinned = pinnedCandidates(opened.db, { projectId: PROJECT_B, now: NOW });

      expect(
        pinned
          .map(({ id, importance, createdAt, lastActivityAt }) => ({
            id,
            importance,
            createdAt,
            lastActivityAt,
          }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
      ).toEqual([
        { id: "pin-own", importance: 0.75, createdAt: BASE_TIME, lastActivityAt: BASE_TIME },
        { id: "pin-user", importance: 0.5, createdAt: BASE_TIME, lastActivityAt: NOW },
      ]);
    } finally {
      opened.db.close();
    }
  });
});

describe("recall hybrid mode", () => {
  it("fuses vec and fts rankings on the memory id with exact rrf scores", async () => {
    const opened = await openSeeded([
      {
        id: "fuse-x",
        projectId: PROJECT_B,
        scope: "user",
        type: "semantic",
        title: "database deployment zero downtime",
        abstract: "database deployment zero downtime",
        importance: 0.5,
        vector: true,
      },
      {
        id: "fuse-y",
        projectId: PROJECT_B,
        scope: "user",
        type: "semantic",
        title: "cooking pasta recipes",
        abstract: "cooking pasta recipes",
        importance: 0.5,
        vector: true,
      },
    ]);
    try {
      const { rows, degraded } = await recall(opened, hybridOptions());
      expect(degraded).toBeUndefined();
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get("fuse-x")?.score).toBeCloseTo(1 / 61 + 1 / 61, 12);
      expect(byId.get("fuse-y")?.score).toBeCloseTo(1 / 62, 12);
      expect(rows[0]?.id).toBe("fuse-x");
    } finally {
      opened.db.close();
    }
  });

  it("never recalls other projects rows from the querying project", async () => {
    const opened = await openSeeded([
      {
        id: "iso-a",
        projectId: PROJECT_A,
        scope: "project",
        type: "semantic",
        title: "database deployment runbook",
        abstract: "database deployment runbook",
        importance: 0.5,
        vector: true,
      },
      {
        id: "iso-user",
        projectId: PROJECT_A,
        scope: "user",
        type: "semantic",
        title: "database deployment checklist",
        abstract: "database deployment checklist",
        importance: 0.5,
        vector: true,
      },
      {
        id: "iso-b",
        projectId: PROJECT_B,
        scope: "project",
        type: "semantic",
        title: "database deployment guide",
        abstract: "database deployment guide",
        importance: 0.5,
        vector: true,
      },
    ]);
    try {
      const { rows } = await recall(opened, hybridOptions());
      const ids = rows.map((row) => row.id);
      expect(ids).not.toContain("iso-a");
      expect(ids).toContain("iso-user");
      expect(ids).toContain("iso-b");

      const userOnly = await recall(opened, hybridOptions({ scope: "user" }));
      expect(userOnly.rows.map((row) => row.id)).toEqual(["iso-user"]);
    } finally {
      opened.db.close();
    }
  });

  it("recalls only active, still-valid rows on the knn, fts and session paths, filtering knn inside the query", async () => {
    const closeMatch = (id: string, state: SeedMemory["state"], invalidAt?: string) => ({
      id,
      projectId: PROJECT_B,
      scope: "project" as const,
      type: "semantic" as const,
      kind: "constraint" as const,
      title: `database deployment zero downtime ${id}`,
      abstract: `database deployment zero downtime ${id}`,
      importance: 0.9,
      state,
      invalidAt,
      supersededBy: state === "revoked" ? "live" : undefined,
      vector: true,
    });
    const opened = await openSeeded([
      {
        id: "live",
        projectId: PROJECT_B,
        scope: "project",
        type: "semantic",
        kind: "constraint",
        title: "database deployment guide",
        abstract: "database deployment guide",
        importance: 0.5,
        vector: true,
      },
      ...Array.from({ length: 12 }, (_, index) => closeMatch(`stale${index}`, "revoked")),
      closeMatch("doubt", "hypothesis"),
      closeMatch("expired", "active", "2026-01-01T00:00:00.000Z"),
    ]);
    try {
      const query = "database deployment zero downtime";
      const hybrid = await recall(opened, hybridOptions({ query }));
      expect(hybrid.rows.map((row) => row.id)).toEqual(["live"]);

      const ftsOnly = await recall(opened, hybridOptions({ query, ftsOnly: true }));
      expect(ftsOnly.rows.map((row) => row.id)).toEqual(["live"]);

      const session = pinnedCandidates(opened.db, { projectId: PROJECT_B, now: NOW });
      expect(session.map((row) => row.id)).toEqual(["live"]);
    } finally {
      opened.db.close();
    }
  });

  it("applies the type filter across the vec and fts sources", async () => {
    const opened = await openSeeded([
      {
        id: "tf-sem",
        projectId: PROJECT_B,
        scope: "user",
        type: "semantic",
        title: "database deployment runbook",
        abstract: "database deployment runbook",
        importance: 0.5,
        vector: true,
      },
      {
        id: "tf-epi",
        projectId: PROJECT_B,
        scope: "user",
        type: "episodic",
        title: "database deployment incident",
        abstract: "database deployment incident",
        importance: 0.5,
        vector: true,
      },
    ]);
    try {
      const unfiltered = await recall(opened, hybridOptions());
      expect(unfiltered.rows.map((row) => row.id)).toEqual(
        expect.arrayContaining(["tf-sem", "tf-epi"]),
      );

      const filtered = await recall(opened, hybridOptions({ type: "semantic" }));
      const ids = filtered.rows.map((row) => row.id);
      expect(ids).toContain("tf-sem");
      expect(ids).not.toContain("tf-epi");
    } finally {
      opened.db.close();
    }
  });

  it("bounds the hybrid recall to four sql statements", async () => {
    const opened = await openSeeded([
      {
        id: "sql-x",
        projectId: PROJECT_B,
        scope: "user",
        type: "semantic",
        title: "database deployment zero downtime",
        abstract: "database deployment zero downtime",
        importance: 0.5,
        vector: true,
      },
      {
        id: "sql-y",
        projectId: PROJECT_B,
        scope: "project",
        type: "semantic",
        title: "database deployment guide",
        abstract: "database deployment guide",
        importance: 0.5,
        vector: true,
      },
    ]);
    try {
      const executed = trackStatements(opened.db);
      await recall(opened, hybridOptions());
      expect(executed.length).toBeLessThanOrEqual(4);
    } finally {
      opened.db.close();
    }
  });
});

describe("promptCandidates", () => {
  it("returns the prompt's neighbourhood from its own project and the user scope only", async () => {
    const prompt = "database deployment zero downtime";
    const partitionRow = (id: string, projectId: string, scope: MemoryScope): SeedMemory => ({
      id,
      projectId,
      scope,
      type: "semantic",
      title: `database deployment ${id}`,
      abstract: `database deployment notes ${id}`,
      importance: 0.5,
      vector: true,
    });
    const opened = await openSeeded([
      partitionRow("nb-own-1", PROJECT_B, "project"),
      partitionRow("nb-own-2", PROJECT_B, "project"),
      partitionRow("nb-user", PROJECT_A, "user"),
      { ...partitionRow("nb-foreign", PROJECT_A, "project"), title: prompt, abstract: prompt },
    ]);
    try {
      const found = await promptCandidates(opened, {
        projectId: PROJECT_B,
        modelCacheDir: testModelCacheDir,
        prompt,
        tokens: [],
        now: NOW,
      });

      const ascending = (a: number, b: number) => a - b;
      const visibleCosines = found.candidates.map((candidate) => candidate.cosine!);
      expect(found.candidates.map((candidate) => candidate.id).sort()).toEqual([
        "nb-own-1",
        "nb-own-2",
        "nb-user",
      ]);
      expect(found.neighbourhood).toHaveLength(3);
      expect([...found.neighbourhood].sort(ascending)).toEqual(visibleCosines.sort(ascending));
    } finally {
      opened.db.close();
    }
  });

  it("scores a memory by its closest recall question, filtering questions to the visible, active partition", async () => {
    const prompt = "how do I undo a release";
    const questionedRow = (id: string, projectId: string, state?: "revoked"): SeedMemory => ({
      id,
      projectId,
      scope: "project",
      type: "procedural",
      title: "release script flags",
      abstract: "the release script takes an environment flag",
      importance: 0.5,
      vector: true,
      questions: [prompt],
      ...(state === undefined ? {} : { state }),
    });
    const opened = await openSeeded([
      questionedRow("q-own", PROJECT_B),
      questionedRow("q-foreign", PROJECT_A),
      questionedRow("q-revoked", PROJECT_B, "revoked"),
    ]);
    try {
      const found = await promptCandidates(opened, {
        projectId: PROJECT_B,
        modelCacheDir: testModelCacheDir,
        prompt,
        tokens: [],
        now: NOW,
      });

      expect(
        found.candidates.map((candidate) => ({
          id: candidate.id,
          cosine: Number(candidate.cosine?.toFixed(3)),
        })),
      ).toEqual([{ id: "q-own", cosine: 1 }]);
      expect(found.neighbourhood.map((cosine) => Number(cosine.toFixed(3)))).toEqual([1]);
    } finally {
      opened.db.close();
    }
  });
});

describe("recall degraded mode", () => {
  it("falls back to fts-only with a model flag when the embedding model is missing", async () => {
    const opened = await openSeeded([
      {
        id: "deg-fts",
        projectId: PROJECT_B,
        scope: "user",
        type: "semantic",
        title: "database deployment runbook",
        abstract: "database deployment runbook",
        importance: 0.5,
      },
    ]);
    try {
      const emptyModelCache = mkdtempSync(join(tmpdir(), "acm-empty-model-"));
      const executed = trackStatements(opened.db);
      const { rows, degraded } = await recall(
        opened,
        hybridOptions({ modelCacheDir: emptyModelCache }),
      );
      expect(degraded?.model).toBe(true);
      expect(degraded?.vec).toBeUndefined();
      expect(rows.map((row) => row.id)).toEqual(["deg-fts"]);
      expect(executed.length).toBeLessThanOrEqual(2);

      const blankQuery = await recall(
        opened,
        hybridOptions({ modelCacheDir: emptyModelCache, query: "   " }),
      );
      expect(blankQuery.rows).toEqual([]);
    } finally {
      opened.db.close();
    }
  });

  it("falls back to fts-only with a vec flag when the extension fails to load", async () => {
    vecState.failGetLoadablePath = true;
    const opened = await openSeeded([
      {
        id: "vec-fts",
        projectId: PROJECT_B,
        scope: "user",
        type: "semantic",
        title: "database deployment runbook",
        abstract: "database deployment runbook",
        importance: 0.5,
      },
    ]);
    try {
      const { rows, degraded } = await recall(opened, hybridOptions());
      expect(degraded?.vec).toBe(true);
      expect(degraded?.model).toBeUndefined();
      expect(rows.map((row) => row.id)).toEqual(["vec-fts"]);
    } finally {
      opened.db.close();
    }
  });

  it.each([
    {
      cause: "fails",
      embed: (work: () => Promise<RecallResult>) => {
        embedState.failEmbedQuery = true;
        return work();
      },
      flags: { model: true },
    },
    {
      cause: "misses its deadline",
      embed: pastEmbeddingDeadline<RecallResult>,
      flags: { embedding_timeout: true },
    },
  ])("falls back to fts with $flags when the query embedding $cause", async ({ embed, flags }) => {
    const opened = await openSeeded([
      {
        id: "dl-fts",
        projectId: PROJECT_B,
        scope: "user",
        type: "semantic",
        title: "database deployment runbook",
        abstract: "database deployment runbook",
        importance: 0.5,
      },
    ]);
    try {
      const { rows, degraded } = await embed(() => recall(opened, hybridOptions()));
      expect(degraded).toEqual(flags);
      expect(rows.map((row) => row.id)).toEqual(["dl-fts"]);
    } finally {
      opened.db.close();
    }
  });

  it("records a prompt's embedding timeout for the doctor and clears it after the next embedded prompt", async () => {
    const opened = await openSeeded([]);
    const request = {
      projectId: PROJECT_B,
      modelCacheDir: testModelCacheDir,
      prompt: "database deployment runbook",
      tokens: ["database", "deployment", "runbook"],
      now: NOW,
    };
    try {
      const timedOut = await pastEmbeddingDeadline(() => promptCandidates(opened, request));
      const recorded = lastEmbeddingTimeout(opened.db);
      embedState.stubQueryVector = new Float32Array(EMBED_DIM).fill(0.05);
      const embedded = await promptCandidates(opened, request);

      expect(timedOut.degraded).toEqual({ embedding_timeout: true });
      expect(recorded).toBe(NOW);
      expect(embedded.degraded).toBeUndefined();
      expect(lastEmbeddingTimeout(opened.db)).toBeUndefined();
    } finally {
      opened.db.close();
    }
  });

  it("finds a row through fts when only some query terms occur in it", async () => {
    const opened = await openSeeded([
      {
        id: "or-row",
        projectId: PROJECT_B,
        scope: "user",
        type: "semantic",
        title: "database deployment runbook",
        abstract: "database deployment runbook",
        importance: 0.5,
      },
    ]);
    try {
      const { rows } = await recall(
        opened,
        hybridOptions({ query: "database outage postmortem", ftsOnly: true }),
      );
      expect(rows.map((row) => row.id)).toEqual(["or-row"]);
    } finally {
      opened.db.close();
    }
  });

  it("skips embedding in fts-only mode while still reporting environment degradation", async () => {
    const opened = await openSeeded([
      {
        id: "ftsonly-row",
        projectId: PROJECT_B,
        scope: "user",
        type: "semantic",
        title: "database deployment runbook",
        abstract: "database deployment runbook",
        importance: 0.5,
      },
    ]);
    try {
      const { rows, degraded } = await recall(opened, hybridOptions({ ftsOnly: true }));
      expect(embedState.embedQueryCalls).toBe(0);
      expect(degraded).toBeUndefined();
      expect(rows.map((row) => row.id)).toEqual(["ftsonly-row"]);

      const emptyModelCache = mkdtempSync(join(tmpdir(), "acm-empty-model-"));
      const degradedFtsOnly = await recall(
        opened,
        hybridOptions({ ftsOnly: true, modelCacheDir: emptyModelCache }),
      );
      expect(embedState.embedQueryCalls).toBe(0);
      expect(degradedFtsOnly.degraded?.model).toBe(true);
      expect(degradedFtsOnly.rows.map((row) => row.id)).toEqual(["ftsonly-row"]);
    } finally {
      opened.db.close();
    }
  });
});
