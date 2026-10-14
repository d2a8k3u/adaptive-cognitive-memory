import { describe, expect, it } from "vitest";
import { CALIBRATED_EMBEDDING, PROMPT_GATE } from "../src/calibration";
import { MODEL_DTYPE, MODEL_ID } from "../src/cfg";
import { passageText } from "../src/db/memories";
import { passageInput, queryInput } from "../src/embeddings";
import { NEIGHBOURHOOD_SIZE, type PromptCandidate, selectPromptMemories } from "../src/gate";
import { type PromptLanguage, promptLanguage } from "../src/prompt";

function filled(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);
}

describe("CALIBRATED_EMBEDDING", () => {
  it("names the live model and reproduces the live query and passage inputs", () => {
    const prompt = "how do we deploy billing";
    const row = {
      title: "Deploy target",
      abstract: "Deploys go to the ECS cluster.",
      conflictKey: "deploy.target",
      keywords: "ecs deploy",
    };

    expect({
      modelId: MODEL_ID,
      dtype: MODEL_DTYPE,
      query: queryInput(prompt),
      passage: passageInput(passageText(row)),
    }).toEqual({
      modelId: CALIBRATED_EMBEDDING.modelId,
      dtype: CALIBRATED_EMBEDDING.dtype,
      query: filled(CALIBRATED_EMBEDDING.queryTemplate, { prompt }),
      passage: filled(CALIBRATED_EMBEDDING.passageTemplate, {
        title: row.title,
        abstract: row.abstract,
        conflict_key: row.conflictKey,
        keywords: row.keywords,
      }),
    });
  });
});

const TYPICAL_CZECH_GOLD_COSINE = 0.8;

const FACT_AT_TYPICAL_CZECH_GOLD_COSINE: PromptCandidate = {
  id: "billing-deploy-fact",
  kind: "fact",
  epistemic: "verified",
  scope: "project",
  abstract: "billing deploys to ECS through the release pipeline",
  validFrom: "2026-10-14T00:00:00.000Z",
  cosine: TYPICAL_CZECH_GOLD_COSINE,
  ftsRank: undefined,
  keyHit: false,
};

const FROZEN_TAU = {
  en: { tau: 0.8507631421089172, tauOpen: 0.8507631421089172 },
  cs: { tau: 0.7875597178936005, tauOpen: 0.7852031290531158 },
} as const;
const JUST_BELOW = 1e-9;

function frozenBoundaryCandidates(language: PromptLanguage): PromptCandidate[] {
  const { tau, tauOpen } = FROZEN_TAU[language];
  const at = (id: string, kind: PromptCandidate["kind"], cosine: number): PromptCandidate => ({
    ...FACT_AT_TYPICAL_CZECH_GOLD_COSINE,
    id,
    kind,
    cosine,
  });
  return [
    at("fact-at-tau", "fact", tau),
    at("fact-below-tau", "fact", tau - JUST_BELOW),
    at("constraint-at-open", "constraint", tauOpen),
    at("constraint-below-open", "constraint", tauOpen - JUST_BELOW),
  ];
}

const COSINE_NEAR_EVERY_CANDIDATE = 0.99;
const NEIGHBOURHOOD_SIZES = {
  dense: NEIGHBOURHOOD_SIZE,
  sparse: NEIGHBOURHOOD_SIZE - 1,
} as const;

function neighbourhoodOf(size: number): number[] {
  return Array.from({ length: size }, () => COSINE_NEAR_EVERY_CANDIDATE);
}

const FROZEN_CENTRED = {
  en: { floor: 0.8569537550210953, margin: 0.01697020381689074, tauKey: 0.8526315242052078 },
  cs: { floor: 0.7918179929256439, margin: 0.012632755935192086, tauKey: 0.7806253433227539 },
} as const;
const CLEARANCE = 0.001;
const WELL_ABOVE_FLOOR = 0.01;

function centredCase(
  language: PromptLanguage,
  name: string,
  cosine: number,
  neighbourhoodMean: number,
  keyHit = false,
) {
  return {
    language,
    name,
    candidate: { ...FACT_AT_TYPICAL_CZECH_GOLD_COSINE, id: name, cosine, keyHit },
    neighbourhood: Array.from({ length: NEIGHBOURHOOD_SIZE }, () => neighbourhoodMean),
  };
}

function frozenCentredCases(language: PromptLanguage) {
  const { floor, margin, tauKey } = FROZEN_CENTRED[language];
  const distinctMean = floor - margin - CLEARANCE;
  const crowdedCosine = floor + WELL_ABOVE_FLOOR;
  return [
    { ...centredCase(language, "distinct-at-floor", floor, distinctMean), injected: true },
    {
      ...centredCase(language, "distinct-below-floor", floor - JUST_BELOW, distinctMean),
      injected: false,
    },
    {
      ...centredCase(
        language,
        "crowded-above-floor",
        crowdedCosine,
        crowdedCosine - margin + CLEARANCE,
      ),
      injected: false,
    },
    { ...centredCase(language, "keyed-at-tau-key", tauKey, tauKey, true), injected: true },
  ];
}

describe("PROMPT_GATE", () => {
  it.each(["en", "cs"] as const)(
    "injects a %s candidate only at the frozen floor and margin, or by key at the frozen key threshold",
    (language) => {
      const cases = frozenCentredCases(language);
      expect(
        cases.map(({ name, candidate, neighbourhood }) => ({
          name,
          injected:
            selectPromptMemories([candidate], PROMPT_GATE, { language, neighbourhood }, new Set())
              .length === 1,
        })),
      ).toEqual(cases.map(({ name, injected }) => ({ name, injected })));
    },
  );

  it.each([
    { language: "en", expected: ["constraint-at-open", "fact-at-tau"] },
    { language: "cs", expected: ["fact-at-tau", "constraint-at-open"] },
  ] as const)(
    "falls back to the frozen per-language tau for a $language prompt whose neighbourhood is too small",
    ({ language, expected }) => {
      expect(
        selectPromptMemories(
          frozenBoundaryCandidates(language),
          PROMPT_GATE,
          { language, neighbourhood: neighbourhoodOf(NEIGHBOURHOOD_SIZES.sparse) },
          new Set(),
        ).map((row) => row.id),
      ).toEqual(expected);
    },
  );

  it.each([
    { prompt: "Jak nasadím billing na produkci?", expected: ["billing-deploy-fact"] },
    { prompt: "How do I deploy billing to production?", expected: [] },
  ])(
    "judges a typical Czech gold cosine by the threshold of the language of $prompt",
    ({ prompt, expected }) => {
      expect(
        selectPromptMemories(
          [FACT_AT_TYPICAL_CZECH_GOLD_COSINE],
          PROMPT_GATE,
          { language: promptLanguage(prompt), neighbourhood: [] },
          new Set(),
        ).map((row) => row.id),
      ).toEqual(expected);
    },
  );
});
