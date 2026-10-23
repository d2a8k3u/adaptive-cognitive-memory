import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMBED_DIM, loadConfig, RELATION_CAP } from "../src/cfg";
import { type Db, type OpenedDb, openDatabase } from "../src/db/database";
import {
  deleteMemory,
  get,
  type MemoryEnv,
  type StoreInput,
  type StoreOutcome,
  store,
  updateMemory,
} from "../src/db/memories";
import { relate } from "../src/db/relations";

const PROJECT_ALPHA = "proj-alpha";

const embedState = vi.hoisted(() => ({
  cached: true,
  inputs: [] as string[],
  queue: [] as Float32Array[],
  default: (() => {
    const vector = new Float32Array(384);
    vector[0] = 1;
    return vector;
  })(),
}));

vi.mock("../src/embeddings", () => ({
  modelCached: () => embedState.cached,
  embedPassage: (texts: string[]) => {
    embedState.inputs.push(texts[0] ?? "");
    return Promise.resolve([embedState.queue.shift() ?? embedState.default]);
  },
}));

const openedDbs: OpenedDb[] = [];

function openEnv(): MemoryEnv {
  const pluginData = mkdtempSync(join(tmpdir(), "acm-relations-"));
  const config = loadConfig({ CLAUDE_PLUGIN_DATA: pluginData });
  const opened = openDatabase(config);
  openedDbs.push(opened);
  return { db: opened.db, vecLoaded: opened.vecLoaded, modelCacheDir: config.modelCacheDir };
}

function seedMemory(env: MemoryEnv, id: string, projectIdValue = "proj-seed"): void {
  const timestamp = "2026-01-01T00:00:00.000Z";
  env.db
    .prepare(
      `INSERT INTO memories (id, type, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
       VALUES (?, 'semantic', 'project', ?, ?, ?, ?, 0.5, NULL, ?, ?)`,
    )
    .run(
      id,
      projectIdValue,
      `title ${id}`,
      `abstract ${id}`,
      `content ${id}`,
      timestamp,
      timestamp,
    );
}

function vectorAtCosine(cosine: number): Float32Array {
  const vector = new Float32Array(EMBED_DIM);
  vector[0] = cosine;
  vector[1] = Math.sqrt(1 - cosine * cosine);
  return vector;
}

function relationCount(db: Db, ...params: unknown[]): number {
  const row = db.prepare("SELECT count(*) AS n FROM relations").get(...params) as { n: number };
  return row.n;
}

afterEach(() => {
  for (const opened of openedDbs) {
    opened.db.close();
  }
  openedDbs.length = 0;
  embedState.cached = true;
  embedState.inputs = [];
  embedState.queue = [];
});

describe("relate", () => {
  it("persists a relation, lists it on the source and stays idempotent on duplicates", () => {
    const env = openEnv();
    seedMemory(env, "rel-src-1");
    seedMemory(env, "rel-tgt-1");
    expect(relate(env.db, "rel-src", "rel-tgt-1", "relates_to")).toEqual({ ok: true });
    expect(get(env, "rel-src-1").relations).toEqual([
      { target_id: "rel-tgt-1", relation_type: "relates_to" },
    ]);
    expect(relate(env.db, "rel-src-1", "rel-tgt-1", "relates_to")).toEqual({ ok: true });
    expect(relationCount(env.db)).toBe(1);
  });

  it("rejects self-relations without persisting anything", () => {
    const env = openEnv();
    seedMemory(env, "rel-self-1");
    expect(() => relate(env.db, "rel-self-1", "rel-self", "relates_to")).toThrow(
      /cannot relate memory rel-self-1 to itself/,
    );
    expect(relationCount(env.db)).toBe(0);
  });

  it("rejects unknown source or target ids without persisting anything", () => {
    const env = openEnv();
    seedMemory(env, "rel-known-1");
    expect(() => relate(env.db, "nosuchid0000", "rel-known-1", "relates_to")).toThrow(
      /memory not found/,
    );
    expect(() => relate(env.db, "rel-known-1", "nosuchid0000", "relates_to")).toThrow(
      /memory not found/,
    );
    expect(relationCount(env.db)).toBe(0);
  });

  it("rejects the relation past the cap while other sources stay unaffected", () => {
    const env = openEnv();
    seedMemory(env, "rel-src-cap");
    for (let index = 0; index <= RELATION_CAP; index += 1) {
      seedMemory(env, `rel-tgt-cap-${index}`);
    }
    for (let index = 0; index < RELATION_CAP; index += 1) {
      expect(relate(env.db, "rel-src-cap", `rel-tgt-cap-${index}`, "relates_to")).toEqual({
        ok: true,
      });
    }
    expect(() =>
      relate(env.db, "rel-src-cap", `rel-tgt-cap-${RELATION_CAP}`, "relates_to"),
    ).toThrow(new RegExp(`relation cap ${RELATION_CAP} reached for source rel-src-cap`));
    expect(relationCount(env.db)).toBe(RELATION_CAP);
    seedMemory(env, "rel-src-other");
    expect(relate(env.db, "rel-src-other", `rel-tgt-cap-${RELATION_CAP}`, "relates_to")).toEqual({
      ok: true,
    });
  });

  it("re-relates an existing pair at the cap as an idempotent success and still rejects a new one", () => {
    const env = openEnv();
    seedMemory(env, "rel-src-full");
    for (let index = 0; index <= RELATION_CAP; index += 1) {
      seedMemory(env, `rel-tgt-full-${index}`);
    }
    for (let index = 0; index < RELATION_CAP; index += 1) {
      relate(env.db, "rel-src-full", `rel-tgt-full-${index}`, "relates_to");
    }

    const repeated = relate(env.db, "rel-src-full", "rel-tgt-full-0", "relates_to");

    expect(repeated).toEqual({ ok: true });
    expect(() => relate(env.db, "rel-src-full", "rel-tgt-full-0", "blocks")).toThrow(
      new RegExp(`relation cap ${RELATION_CAP} reached for source rel-src-full`),
    );
    expect(relationCount(env.db)).toBe(RELATION_CAP);
  });

  it("writes zero relations on the capture path across every store action, update and delete", async () => {
    const env = openEnv();
    const capture = (title: string, value: string): StoreInput => ({
      title,
      content: `${title} body.`,
      type: "semantic",
      kind: "fact",
      conflictKey: "test.capture_subject",
      cardinality: "single",
      valueText: value,
      keywords: "",
      anchors: [],
      questions: [],
      scope: "project",
    });
    const idOf = (outcome: StoreOutcome): string => {
      if (outcome.outcome !== "written") {
        throw new Error(`expected a write, got ${JSON.stringify(outcome)}`);
      }
      return outcome.result.id;
    };
    const firstId = idOf(await store(env, capture("capture one", "one"), PROJECT_ALPHA));
    embedState.queue.push(vectorAtCosine(1));
    const phaseOne = await store(env, capture("capture two", "two"), PROJECT_ALPHA);
    expect(phaseOne.outcome).toBe("needs_resolution");
    const secondId = idOf(
      await store(
        env,
        { ...capture("capture two", "two"), resolution: { action: "SUPERSEDE", target: firstId } },
        PROJECT_ALPHA,
      ),
    );
    await store(
      env,
      { ...capture("capture two again", "two"), resolution: { action: "NOOP", target: secondId } },
      PROJECT_ALPHA,
    );
    await store(
      env,
      {
        ...capture("capture two refined", "two"),
        resolution: { action: "UPDATE", target: secondId },
      },
      PROJECT_ALPHA,
    );
    await updateMemory(env, secondId, { title: "capture two retitled" });
    deleteMemory(env, firstId);
    expect(relationCount(env.db)).toBe(0);
  });

  it("cascades relation deletion in both directions when a memory is deleted", async () => {
    const env = openEnv();
    seedMemory(env, "rel-cascade-a");
    seedMemory(env, "rel-cascade-b");
    relate(env.db, "rel-cascade-a", "rel-cascade-b", "relates_to");
    relate(env.db, "rel-cascade-b", "rel-cascade-a", "blocks");
    deleteMemory(env, "rel-cascade-a");
    expect(relationCount(env.db)).toBe(0);
  });
});
