import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type OpenedDb, openDatabase } from "../src/db/database";
import { type MemoryEnv, type StoreInput, type StoreOutcome, store } from "../src/db/memories";
import { recall } from "../src/search";
import { testModelCacheDir } from "../vitest.config";
import { seedConfig } from "./fixtures/seed";

const RECALL_PROJECT_ID = "proj-quality";

function userNote(title: string, content: string, conflictKey: string): StoreInput {
  return {
    title,
    content,
    type: "semantic",
    kind: "procedure",
    conflictKey,
    cardinality: "multi",
    valueText: "",
    keywords: "",
    anchors: [],
    scope: "user",
    resolution: { action: "ADD" },
  };
}

function createdId(outcome: StoreOutcome): string {
  if (outcome.outcome !== "written" || outcome.result.action !== "created") {
    throw new Error(`expected a created memory, got ${JSON.stringify(outcome)}`);
  }
  return outcome.result.id;
}

const TARGET = userNote(
  "rollback procedure for a failed launch",
  "Re-point the load balancer at the previous release slot and watch error rates until they settle.",
  "release.rollback",
);

const DISTRACTORS: readonly { title: string; content: string }[] = [
  {
    title: "sourdough starter feeding",
    content:
      "Feed the starter with equal weights of flour and water every twelve hours at room temperature.",
  },
  {
    title: "japanese rail pass advice",
    content:
      "Activate the rail pass only after arriving so the validity window matches the actual trip dates.",
  },
  {
    title: "greenhouse tomato pruning",
    content:
      "Remove the suckers that grow between the main stem and branches so the plant focuses energy on fruit.",
  },
  {
    title: "vinyl record storage",
    content:
      "Store records vertically on a cool dry shelf away from direct sunlight to prevent warping.",
  },
  {
    title: "index fund rebalancing",
    content:
      "Once a year sell the overweighted asset classes and buy the underweighted ones to restore target ratios.",
  },
  {
    title: "bicycle brake bleeding",
    content:
      "Bleed the hydraulic brakes from the caliper upward so air pockets escape at the reservoir.",
  },
  {
    title: "espresso grind dialing",
    content:
      "Adjust the grinder one notch coarser when the shot drips too slowly and tastes bitter.",
  },
  {
    title: "sourdough bake schedule",
    content:
      "Shape the dough after the four hour bulk rise and let it rest overnight in the fridge.",
  },
  {
    title: "camera exposure triangle",
    content:
      "Balance aperture shutter speed and iso so the histogram stays centered without clipping highlights.",
  },
];

const PARAPHRASE_QUERY = "how do i undo a bad rollout and bring back the earlier build";
const CZECH_QUERY = "jak vrátit zpět špatné nasazení verze";

const FUNCTION_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "to",
  "of",
  "at",
  "in",
  "on",
  "do",
  "does",
  "i",
  "we",
  "you",
  "it",
  "is",
  "are",
  "how",
  "what",
  "with",
  "until",
  "they",
  "this",
  "that",
  "back",
]);

function wordsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
}

describe("retrieval quality", () => {
  let opened: OpenedDb;
  let env: MemoryEnv;
  let targetId: string;

  beforeAll(async () => {
    const pluginData = mkdtempSync(join(tmpdir(), "acm-quality-"));
    const config = seedConfig(pluginData, testModelCacheDir);
    opened = openDatabase(config);
    env = { db: opened.db, vecLoaded: opened.vecLoaded, modelCacheDir: config.modelCacheDir };
    targetId = createdId(await store(env, TARGET, RECALL_PROJECT_ID));
    for (const [index, distractor] of DISTRACTORS.entries()) {
      createdId(
        await store(
          env,
          userNote(distractor.title, distractor.content, `distractor.topic_${index}`),
          RECALL_PROJECT_ID,
        ),
      );
    }
  }, 120_000);

  afterAll(() => {
    opened.db.close();
  });

  it("recalls a zero-keyword-overlap paraphrase in the top-3 (AC-9)", {
    timeout: 60_000,
  }, async () => {
    const storedText = `${TARGET.title} ${TARGET.content}`;
    const overlap = [...wordsOf(PARAPHRASE_QUERY)].filter((word) => wordsOf(storedText).has(word));
    expect(overlap.filter((word) => !FUNCTION_WORDS.has(word))).toEqual([]);

    const ftsOnly = await recall(opened, {
      projectId: RECALL_PROJECT_ID,
      modelCacheDir: env.modelCacheDir,
      query: PARAPHRASE_QUERY,
      limit: 10,
      ftsOnly: true,
    });
    expect(ftsOnly.rows).toHaveLength(0);

    const result = await recall(opened, {
      projectId: RECALL_PROJECT_ID,
      modelCacheDir: env.modelCacheDir,
      query: PARAPHRASE_QUERY,
      limit: 3,
    });
    const rank = result.rows.findIndex((row) => row.id === targetId);
    console.log(`AC-9 paraphrase rank: ${rank + 1} of ${result.rows.length}`);
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(3);
  });

  it("finds the english memory from a czech query (DEC-2)", { timeout: 60_000 }, async () => {
    const result = await recall(opened, {
      projectId: RECALL_PROJECT_ID,
      modelCacheDir: env.modelCacheDir,
      query: CZECH_QUERY,
      limit: 3,
    });
    const rank = result.rows.findIndex((row) => row.id === targetId);
    console.log(`DEC-2 czech query rank: ${rank + 1} of ${result.rows.length}`);
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(3);
  });
});
