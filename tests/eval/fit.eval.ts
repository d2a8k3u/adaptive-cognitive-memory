import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CALIBRATION_RUN, PROMPT_GATE, PROMPT_MIN_WORDS } from "../../src/calibration";
import { loadConfig } from "../../src/cfg";
import { type OpenedDb, openDatabase } from "../../src/db/database";
import {
  NEIGHBOURHOOD_SIZE,
  nearestMean,
  type PromptCandidate,
  type PromptGate,
  relevanceFeatures,
  relevanceScore,
  selectPromptMemories,
} from "../../src/gate";
import { resolveProjectId } from "../../src/ids";
import { admitPrompt } from "../../src/prompt";
import { promptCandidates } from "../../src/search";
import { testModelCacheDir } from "../../vitest.config";
import { buildCorpusWorld, type StoredWorld } from "./corpus";
import { bestThreshold, fitLogistic, type GateOutcome, type LabelledFeatures } from "./fit";
import { loadFixtures, type Split } from "./fixtures";
import { FIXTURE_DIR, REPO_ROOT, RESULTS_DIR, runMeta } from "./provenance";
import { loadPlugin, projectDirs } from "./world";

const FIT_OPTIONS = { iterations: 3000, learningRate: 0.5, l2: 0.001 } as const;
const NOTHING_INJECTED: ReadonlySet<string> = new Set();

interface PromptCase {
  readonly id: string;
  readonly split: Split;
  readonly positive: boolean;
  readonly gold: ReadonlySet<string>;
  readonly candidates: readonly PromptCandidate[];
  readonly neighbourhood: readonly number[];
}

function openWorldDatabase(stored: StoredWorld): OpenedDb {
  return openDatabase(
    loadConfig({
      CLAUDE_PLUGIN_DATA: stored.world.pluginData,
      ACM_MODEL_CACHE_DIR: stored.world.modelCacheDir,
    }),
  );
}

function storedGold(stored: StoredWorld, fixtureGold: readonly string[]): Set<string> {
  return new Set(
    fixtureGold.map((fixtureId) => {
      const storedId = stored.owners.get(fixtureId);
      if (storedId === undefined) {
        throw new Error(`gold ${fixtureId} was not stored`);
      }
      return storedId;
    }),
  );
}

async function collectCases(stored: StoredWorld): Promise<PromptCase[]> {
  const fixtures = loadFixtures(FIXTURE_DIR);
  const items = [
    ...fixtures.positives.map((item) => ({ ...item, positive: true })),
    ...fixtures.negatives.map((item) => ({ ...item, positive: false })),
  ];
  const projectIds = new Map(
    fixtures.corpus.projects.map((project) => [
      project.key,
      resolveProjectId(projectDirs(stored.world, project.key).root),
    ]),
  );
  const now = new Date().toISOString();
  const opened = openWorldDatabase(stored);
  try {
    const cases: PromptCase[] = [];
    for (const item of items) {
      const admission = admitPrompt(item.prompt, PROMPT_MIN_WORDS);
      const found = admission.admitted
        ? await promptCandidates(opened, {
            projectId: projectIds.get(item.project) ?? item.project,
            modelCacheDir: stored.world.modelCacheDir,
            prompt: item.prompt,
            tokens: admission.tokens,
            now,
          })
        : { candidates: [], neighbourhood: [], degraded: undefined };
      if (found.degraded !== undefined) {
        throw new Error(
          `the fit needs the model and sqlite-vec: ${JSON.stringify(found.degraded)}`,
        );
      }
      cases.push({
        id: item.id,
        split: item.split,
        positive: item.positive,
        gold: storedGold(stored, item.gold),
        candidates: found.candidates,
        neighbourhood: found.neighbourhood,
      });
    }
    return cases;
  } finally {
    opened.db.close();
  }
}

function typicalNeighbourhoodMean(cases: readonly PromptCase[]): number {
  const full = cases.filter((item) => item.neighbourhood.length >= NEIGHBOURHOOD_SIZE);
  if (full.length === 0) {
    throw new Error("no calibration prompt has a full neighbourhood to derive the prior from");
  }
  return full.reduce((sum, item) => sum + nearestMean(item.neighbourhood, 0), 0) / full.length;
}

function trainingRows(cases: readonly PromptCase[], prior: number): LabelledFeatures[] {
  return cases.flatMap((item) =>
    item.candidates.flatMap((candidate) => {
      const features = relevanceFeatures(candidate, { neighbourhood: item.neighbourhood }, prior);
      return features === undefined ? [] : [{ features, gold: item.gold.has(candidate.id) }];
    }),
  );
}

function outcomeOf(cases: readonly PromptCase[], gate: PromptGate): GateOutcome {
  let goldHits = 0;
  let falseInjections = 0;
  let goldRows = 0;
  let injectedRows = 0;
  for (const item of cases) {
    const injected = selectPromptMemories(
      item.candidates,
      gate,
      { neighbourhood: item.neighbourhood },
      NOTHING_INJECTED,
    );
    const gold = injected.filter((row) => item.gold.has(row.id)).length;
    goldRows += gold;
    injectedRows += injected.length;
    if (item.positive && gold > 0) {
      goldHits += 1;
    }
    if (!item.positive && injected.length > 0) {
      falseInjections += 1;
    }
  }
  return {
    goldHits,
    positives: cases.filter((item) => item.positive).length,
    falseInjections,
    negatives: cases.filter((item) => !item.positive).length,
    goldRows,
    injectedRows,
  };
}

function summary(outcome: GateOutcome): Record<string, number> {
  return {
    goldHit: outcome.goldHits / Math.max(outcome.positives, 1),
    falseInjection: outcome.falseInjections / Math.max(outcome.negatives, 1),
    precision: outcome.goldRows / Math.max(outcome.injectedRows, 1),
    ...outcome,
  };
}

describe("recall gate fit", () => {
  it("fits the relevance model on the calibration split and reports the held-out confirmation split", async () => {
    const meta = runMeta(undefined);
    const disposables: string[] = [];
    try {
      const corpus = await buildCorpusWorld(
        loadPlugin(REPO_ROOT),
        loadFixtures(FIXTURE_DIR),
        testModelCacheDir,
        disposables,
      );
      const cases = await collectCases(corpus);
      const calibration = cases.filter((item) => item.split === "calibration");
      const confirmation = cases.filter((item) => item.split === "confirmation");
      const neighbourhoodPrior = typicalNeighbourhoodMean(calibration);
      const model = fitLogistic(trainingRows(calibration, neighbourhoodPrior), FIT_OPTIONS);
      const gateAt = (threshold: number): PromptGate => ({
        ...model,
        threshold,
        maxRows: PROMPT_GATE.maxRows,
        neighbourhoodPrior,
      });
      const thresholds = [
        ...new Set(
          calibration.flatMap((item) =>
            item.candidates.flatMap((candidate) => {
              const features = relevanceFeatures(
                candidate,
                { neighbourhood: item.neighbourhood },
                neighbourhoodPrior,
              );
              return features === undefined ? [] : [relevanceScore(features, gateAt(0))];
            }),
          ),
        ),
      ].sort((a, b) => a - b);
      const threshold = bestThreshold(
        thresholds,
        (candidate) => outcomeOf(calibration, gateAt(candidate)),
        CALIBRATION_RUN.falseInjectionCap,
      );
      const gate = gateAt(threshold);
      const record = {
        ...meta,
        kind: "fit",
        options: FIT_OPTIONS,
        gate,
        calibration: summary(outcomeOf(calibration, gate)),
        confirmation: summary(outcomeOf(confirmation, gate)),
        live_gate_confirmation: summary(outcomeOf(confirmation, PROMPT_GATE)),
      };
      mkdirSync(RESULTS_DIR, { recursive: true });
      const path = join(RESULTS_DIR, `fit-${meta.run_id.replaceAll(":", "-")}.json`);
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
      console.log(`fit ${meta.run_id} -> ${path}\n${JSON.stringify(record, null, 2)}`);

      expect(record.calibration.falseInjection).toBeLessThanOrEqual(
        CALIBRATION_RUN.falseInjectionCap,
      );
    } finally {
      for (const path of disposables) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });
});
