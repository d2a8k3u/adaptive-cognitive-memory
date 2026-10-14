import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROMPT_GATE, PROMPT_MIN_CONTENT_TOKENS } from "../../src/calibration";
import { loadConfig, MODEL_ID } from "../../src/cfg";
import { type Db, type OpenedDb, openDatabase } from "../../src/db/database";
import { embedQuery } from "../../src/embeddings";
import {
  KEY_MODES,
  type KeyMode,
  NEIGHBOURHOOD_SIZE,
  neighbourhoodReference,
  type PromptCandidate,
  type PromptGate,
  type SimilarityThresholds,
  selectPromptMemories,
  selectToolMemories,
  type ToolCandidate,
  type ToolGate,
} from "../../src/gate";
import { resolveProjectId } from "../../src/ids";
import { toolLookup } from "../../src/keys";
import { MEMORY_KINDS, type MemoryKind } from "../../src/policy";
import {
  admitPrompt,
  contentTokens,
  PROMPT_LANGUAGES,
  type PromptLanguage,
  promptLanguage,
} from "../../src/prompt";
import { promptCandidates, toolCandidates } from "../../src/search";
import { testModelCacheDir } from "../../vitest.config";
import { buildCorpusWorld, type StoredWorld } from "./corpus";
import {
  type Fixtures,
  LANGS,
  type Lang,
  loadFixtures,
  NEGATIVE_CATEGORIES,
  pretoolSplit,
} from "./fixtures";
import {
  type InjectionSummary,
  injectionSummary,
  type MetricEntry,
  mean,
  percentile,
  type Ratio,
  ratioMetric,
  ratioValue,
  recallAtK,
} from "./metrics";
import { FIXTURE_DIR, REPO_ROOT, RESULTS_DIR, type RunMeta, runMeta } from "./provenance";
import { loadPlugin, projectDirs, resolveToolInput } from "./world";

const CALIBRATION = "calibration";
const POSITIVE = "positive";
const NEGATIVE = "negative";
const ALPHAS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4] as const;
const EDGE_PROBE_ALPHA = 0.5;
const OPEN_ALPHA_OFFSETS = [-0.1, 0, 0.1] as const;
const KEY_ALPHA_OFFSETS = [-0.1, -0.2] as const;
const FLOOR_ALPHAS = [0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5] as const;
const MARGIN_ALPHAS = [null, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4] as const;
const CENTRED_KEY_MODES: readonly KeyMode[] = ["ignored", "conjunction"];
const ACTIVE_STATE = "active";
const MIN_CONTENT_TOKENS = [2, 3, 4] as const;
const MAX_ROWS = [3, 5, 8] as const;
const W3_SINGLE_TAU_POINT = {
  alpha: 0.3,
  openAlpha: 0.4,
  keyAlpha: null,
  keyMode: "ignored",
  minContentTokens: 3,
  maxRows: 3,
} as const;
const TOOL_KIND_SETS: readonly (readonly MemoryKind[])[] = [
  ["procedure", "constraint"],
  ["procedure", "constraint", "preference"],
  MEMORY_KINDS,
];
const KEYWORD_SIGNALS = [false, true] as const;
const RANK_CUTOFF = 5;
const RUNNER_UPS = 3;
const SUMMARY_ROWS = 15;
const PERSISTED_POINTS = 100;
const CZECH_RECALL_TARGET: Ratio = { numerator: 7, denominator: 10 };
const SELECTION_TIE_BREAKS = [
  "fewer injected rows",
  "higher min(EN gold hit, CS gold hit)",
  "higher pooled precision",
] as const;
const FRACTION_STEPS = 100;
const DISTRIBUTION_FRACTIONS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1] as const;
const NOTHING_INJECTED: ReadonlySet<string> = new Set();
const NO_MARGIN = -1;

type FixtureIdOf = (storedId: string) => string;
type PerLanguage<T> = Readonly<Record<PromptLanguage, T>>;

interface PromptCase {
  readonly id: string;
  readonly category: string;
  readonly lang: Lang;
  readonly language: PromptLanguage;
  readonly admittedAtMinTokens: ReadonlySet<number>;
  readonly prompt: string;
  readonly gold: readonly string[];
  readonly candidates: readonly PromptCandidate[];
  readonly neighbourhood: readonly number[];
  readonly corpusNeighbourhood: readonly number[];
}

interface ToolCase {
  readonly id: string;
  readonly gold: readonly string[];
  readonly candidates: readonly ToolCandidate[];
}

interface Scored {
  readonly id: string;
  readonly category: string;
  readonly lang?: Lang;
  readonly gold: readonly string[];
  readonly injected: readonly string[];
}

interface LanguageAlphas {
  readonly alpha: number;
  readonly openAlpha: number;
  readonly keyAlpha: number | null;
  readonly marginAlpha: number | null;
}

interface GoldDistributions {
  readonly cosines: PerLanguage<readonly number[]>;
  readonly margins: PerLanguage<readonly number[]>;
}

interface PointSpec {
  readonly alphas: PerLanguage<LanguageAlphas>;
  readonly keyMode: KeyMode;
  readonly minContentTokens: number;
  readonly maxRows: number;
}

interface PromptPoint {
  readonly alphas: PerLanguage<LanguageAlphas>;
  readonly minContentTokens: number;
  readonly gate: PromptGate;
}

interface RankedPoint {
  readonly point: PromptPoint;
  readonly summary: InjectionSummary;
  readonly byLanguage: Readonly<Record<Lang, InjectionSummary>>;
}

type PointRule = (ranked: RankedPoint) => boolean;

interface PromptResult {
  readonly point: PromptPoint;
  readonly summary: InjectionSummary;
  readonly scored: readonly Scored[];
}

interface ToolResult {
  readonly gate: ToolGate;
  readonly summary: InjectionSummary;
  readonly scored: readonly Scored[];
}

function perLanguage<T>(build: (language: PromptLanguage) => T): PerLanguage<T> {
  return { en: build("en"), cs: build("cs") };
}

function fixtureIdResolver(stored: StoredWorld): FixtureIdOf {
  const byStoredId = new Map(
    [...stored.owners].map(([fixtureId, storedId]) => [storedId, fixtureId]),
  );
  return (storedId) => {
    const fixtureId = byStoredId.get(storedId);
    if (fixtureId === undefined) {
      throw new Error(`stored memory ${storedId} belongs to no corpus fixture`);
    }
    return fixtureId;
  };
}

function projectIdResolver(stored: StoredWorld): (projectKey: string) => string {
  const cache = new Map<string, string>();
  return (projectKey) => {
    const known = cache.get(projectKey);
    if (known !== undefined) {
      return known;
    }
    const resolved = resolveProjectId(projectDirs(stored.world, projectKey).root);
    cache.set(projectKey, resolved);
    return resolved;
  };
}

function openWorldDatabase(stored: StoredWorld): OpenedDb {
  return openDatabase(
    loadConfig({
      CLAUDE_PLUGIN_DATA: stored.world.pluginData,
      ACM_MODEL_CACHE_DIR: stored.world.modelCacheDir,
    }),
  );
}

function admittedAtMinTokens(prompt: string): ReadonlySet<number> {
  return new Set(MIN_CONTENT_TOKENS.filter((min) => admitPrompt(prompt, min).admitted));
}

async function corpusNeighbourhood(
  db: Db,
  prompt: string,
  modelCacheDir: string,
): Promise<number[]> {
  const vector = await embedQuery(prompt, modelCacheDir);
  const hits = db
    .prepare("SELECT distance FROM memories_vec WHERE state = ? AND embedding MATCH ? AND k = ?")
    .all(ACTIVE_STATE, JSON.stringify(Array.from(vector)), NEIGHBOURHOOD_SIZE) as {
    distance: number;
  }[];
  return hits.map((hit) => 1 - hit.distance);
}

async function collectPromptCases(stored: StoredWorld, fixtures: Fixtures): Promise<PromptCase[]> {
  const items = [
    ...fixtures.positives.map((item) => ({ ...item, category: POSITIVE })),
    ...fixtures.negatives,
  ].filter((item) => item.split === CALIBRATION);
  const projectIdOf = projectIdResolver(stored);
  const now = new Date().toISOString();
  const opened = openWorldDatabase(stored);
  try {
    const cases: PromptCase[] = [];
    for (const item of items) {
      const prompt = item.prompt.trim();
      const found = await promptCandidates(opened, {
        projectId: projectIdOf(item.project),
        modelCacheDir: stored.world.modelCacheDir,
        prompt,
        tokens: contentTokens(prompt),
        now,
      });
      if (found.degraded !== undefined) {
        throw new Error(
          `the sweep needs the model and sqlite-vec: ${JSON.stringify(found.degraded)}`,
        );
      }
      cases.push({
        ...item,
        prompt,
        language: promptLanguage(prompt),
        admittedAtMinTokens: admittedAtMinTokens(prompt),
        candidates: found.candidates,
        neighbourhood: found.neighbourhood,
        corpusNeighbourhood: await corpusNeighbourhood(
          opened.db,
          prompt,
          stored.world.modelCacheDir,
        ),
      });
    }
    return cases;
  } finally {
    opened.db.close();
  }
}

function collectToolCases(stored: StoredWorld, fixtures: Fixtures): ToolCase[] {
  const projectIdOf = projectIdResolver(stored);
  const now = new Date().toISOString();
  const opened = openWorldDatabase(stored);
  try {
    return fixtures.pretool
      .filter((item) => pretoolSplit(item.id) === CALIBRATION)
      .map((item) => {
        const root = projectDirs(stored.world, item.project).root;
        const lookup = toolLookup(item.tool_name, resolveToolInput(root, item.tool_input), root);
        return {
          id: item.id,
          gold: item.gold,
          candidates:
            lookup === undefined
              ? []
              : toolCandidates(opened.db, {
                  projectId: projectIdOf(item.project),
                  lookup,
                  keywordSignal: true,
                  now,
                }),
        };
      });
  } finally {
    opened.db.close();
  }
}

function goldCosinesOf(item: PromptCase, fixtureIdOf: FixtureIdOf): (number | undefined)[] {
  return item.gold.map(
    (goldId) => item.candidates.find((entry) => fixtureIdOf(entry.id) === goldId)?.cosine,
  );
}

function goldCosines(cases: readonly PromptCase[], fixtureIdOf: FixtureIdOf) {
  const pairs = cases.flatMap((item) => goldCosinesOf(item, fixtureIdOf));
  const values = pairs.filter((cosine): cosine is number => cosine !== undefined);
  return { values, coverage: ratioMetric({ numerator: values.length, denominator: pairs.length }) };
}

function goldMargins(cases: readonly PromptCase[], fixtureIdOf: FixtureIdOf): number[] {
  return cases.flatMap((item) => {
    const reference = neighbourhoodReference(item.neighbourhood);
    if (reference === undefined) {
      return [];
    }
    return goldCosinesOf(item, fixtureIdOf).flatMap((cosine) =>
      cosine === undefined ? [] : [cosine - reference],
    );
  });
}

function sparseNeighbourhoods(cases: readonly PromptCase[]): Record<string, number> {
  return {
    partition: cases.filter((item) => neighbourhoodReference(item.neighbourhood) === undefined)
      .length,
    corpus: cases.filter((item) => neighbourhoodReference(item.corpusNeighbourhood) === undefined)
      .length,
  };
}

function topCosines(cases: readonly PromptCase[]): number[] {
  return cases.map((item) =>
    Math.max(-1, ...item.candidates.map((candidate) => candidate.cosine ?? -1)),
  );
}

function distribution(values: readonly number[]): Record<string, number> {
  return Object.fromEntries(
    DISTRIBUTION_FRACTIONS.map((fraction) => [`p${fraction * 100}`, percentile(values, fraction)]),
  );
}

function roundedFraction(value: number): number {
  return Math.round(value * FRACTION_STEPS) / FRACTION_STEPS;
}

function shiftedAlphas(alpha: number, offsets: readonly number[]): number[] {
  return offsets.map((offset) => roundedFraction(alpha + offset)).filter((shifted) => shifted > 0);
}

function keyAlphas(keyMode: KeyMode, alpha: number): (number | null)[] {
  return keyMode === "conjunction" ? shiftedAlphas(alpha, KEY_ALPHA_OFFSETS) : [null];
}

function languageAlphaOptions(keyMode: KeyMode): LanguageAlphas[] {
  return ALPHAS.flatMap((alpha) =>
    shiftedAlphas(alpha, OPEN_ALPHA_OFFSETS).flatMap((openAlpha) =>
      keyAlphas(keyMode, alpha).map((keyAlpha) => ({
        alpha,
        openAlpha,
        keyAlpha,
        marginAlpha: null,
      })),
    ),
  );
}

function centredAlphaOptions(keyMode: KeyMode): LanguageAlphas[] {
  return FLOOR_ALPHAS.flatMap((alpha) =>
    keyAlphas(keyMode, alpha).flatMap((keyAlpha) =>
      MARGIN_ALPHAS.map((marginAlpha) => ({ alpha, openAlpha: alpha, keyAlpha, marginAlpha })),
    ),
  );
}

function openFloorProbeSpecs(chosen: PromptPoint): PointSpec[] {
  const openOptions = perLanguage((language) => {
    const current = chosen.alphas[language];
    return shiftedAlphas(current.alpha, OPEN_ALPHA_OFFSETS).map((openAlpha) => ({
      ...current,
      openAlpha,
    }));
  });
  return openOptions.en.flatMap((en) =>
    openOptions.cs.map((cs) => ({
      alphas: { en, cs },
      keyMode: chosen.gate.keyMode,
      minContentTokens: chosen.minContentTokens,
      maxRows: chosen.gate.maxRows,
    })),
  );
}

function independentPerLanguage(options: readonly LanguageAlphas[]): PerLanguage<LanguageAlphas>[] {
  return options.flatMap((en) => options.map((cs) => ({ en, cs })));
}

function sharedAcrossLanguages(options: readonly LanguageAlphas[]): PerLanguage<LanguageAlphas>[] {
  return options.map((alphas) => perLanguage(() => alphas));
}

function gridSpecs(
  keyModes: readonly KeyMode[],
  optionsFor: (keyMode: KeyMode) => LanguageAlphas[],
  combine: (options: readonly LanguageAlphas[]) => PerLanguage<LanguageAlphas>[],
): PointSpec[] {
  return keyModes.flatMap((keyMode) =>
    combine(optionsFor(keyMode)).flatMap((alphas) =>
      MIN_CONTENT_TOKENS.flatMap((minContentTokens) =>
        MAX_ROWS.map((maxRows) => ({ alphas, keyMode, minContentTokens, maxRows })),
      ),
    ),
  );
}

function thresholdsAt(cosines: readonly number[], alphas: LanguageAlphas): SimilarityThresholds {
  const tauAt = (alpha: number) => percentile(cosines, alpha);
  const tau = tauAt(alphas.alpha);
  const tauOpen = tauAt(alphas.openAlpha);
  return {
    floor: tau,
    floorOpen: tauOpen,
    margin: NO_MARGIN,
    fallbackTau: tau,
    fallbackTauOpen: tauOpen,
    tauKey: tauAt(alphas.keyAlpha ?? alphas.alpha),
  };
}

function centredThresholdsAt(
  gold: GoldDistributions,
  language: PromptLanguage,
  alphas: LanguageAlphas,
): SimilarityThresholds {
  const floor = percentile(gold.cosines[language], alphas.alpha);
  const frozen = PROMPT_GATE.thresholds[language];
  return {
    floor,
    floorOpen: percentile(gold.cosines[language], alphas.openAlpha),
    margin:
      alphas.marginAlpha === null
        ? NO_MARGIN
        : percentile(gold.margins[language], alphas.marginAlpha),
    fallbackTau: frozen.fallbackTau,
    fallbackTauOpen: frozen.fallbackTauOpen,
    tauKey: alphas.keyAlpha === null ? floor : percentile(gold.cosines[language], alphas.keyAlpha),
  };
}

function pointWith(
  spec: PointSpec,
  thresholdsOf: (language: PromptLanguage) => SimilarityThresholds,
): PromptPoint {
  return {
    alphas: spec.alphas,
    minContentTokens: spec.minContentTokens,
    gate: { thresholds: perLanguage(thresholdsOf), keyMode: spec.keyMode, maxRows: spec.maxRows },
  };
}

function promptPoint(cosines: PerLanguage<readonly number[]>, spec: PointSpec): PromptPoint {
  return pointWith(spec, (language) => thresholdsAt(cosines[language], spec.alphas[language]));
}

function centredPoint(gold: GoldDistributions, spec: PointSpec): PromptPoint {
  return pointWith(spec, (language) => centredThresholdsAt(gold, language, spec.alphas[language]));
}

function edgeProbeSpecs(chosen: PromptPoint): PointSpec[] {
  return PROMPT_LANGUAGES.map((probed) => ({
    alphas: perLanguage((language) => {
      const current = chosen.alphas[language];
      if (language !== probed) {
        return current;
      }
      const shift = EDGE_PROBE_ALPHA - current.alpha;
      return {
        ...current,
        alpha: EDGE_PROBE_ALPHA,
        openAlpha: roundedFraction(current.openAlpha + shift),
        keyAlpha: current.keyAlpha === null ? null : roundedFraction(current.keyAlpha + shift),
      };
    }),
    keyMode: chosen.gate.keyMode,
    minContentTokens: chosen.minContentTokens,
    maxRows: chosen.gate.maxRows,
  }));
}

function languageTradeoffSpecs(chosen: PromptPoint, varied: PromptLanguage): PointSpec[] {
  return MIN_CONTENT_TOKENS.flatMap((minContentTokens) =>
    languageAlphaOptions(chosen.gate.keyMode).map((alphas) => ({
      alphas: perLanguage((language) => (language === varied ? alphas : chosen.alphas[language])),
      keyMode: chosen.gate.keyMode,
      minContentTokens,
      maxRows: chosen.gate.maxRows,
    })),
  );
}

function isW3SingleTauPoint({ point }: RankedPoint): boolean {
  const { alphas, minContentTokens, gate } = point;
  return (
    PROMPT_LANGUAGES.every(
      (language) =>
        alphas[language].alpha === W3_SINGLE_TAU_POINT.alpha &&
        alphas[language].openAlpha === W3_SINGLE_TAU_POINT.openAlpha &&
        alphas[language].keyAlpha === W3_SINGLE_TAU_POINT.keyAlpha,
    ) &&
    gate.keyMode === W3_SINGLE_TAU_POINT.keyMode &&
    minContentTokens === W3_SINGLE_TAU_POINT.minContentTokens &&
    gate.maxRows === W3_SINGLE_TAU_POINT.maxRows
  );
}

function scoreGate(
  cases: readonly PromptCase[],
  gate: PromptGate,
  minContentTokens: number,
  fixtureIdOf: FixtureIdOf,
): Scored[] {
  return cases.map((item) => ({
    id: item.id,
    category: item.category,
    lang: item.lang,
    gold: item.gold,
    injected: item.admittedAtMinTokens.has(minContentTokens)
      ? selectPromptMemories(
          item.candidates,
          gate,
          { language: item.language, neighbourhood: item.neighbourhood },
          NOTHING_INJECTED,
        ).map((row) => fixtureIdOf(row.id))
      : [],
  }));
}

function scorePromptPoint(
  cases: readonly PromptCase[],
  point: PromptPoint,
  fixtureIdOf: FixtureIdOf,
): PromptResult {
  const scored = scoreGate(cases, point.gate, point.minContentTokens, fixtureIdOf);
  return { point, summary: injectionSummary(scored), scored };
}

function shippingByLanguage(
  cases: readonly PromptCase[],
  fixtureIdOf: FixtureIdOf,
): Readonly<Record<Lang, InjectionSummary>> {
  const scored = scoreGate(cases, PROMPT_GATE, PROMPT_MIN_CONTENT_TOKENS, fixtureIdOf);
  return perLanguage((language) => languageSummary(scored, language));
}

function rankPromptPoints(
  cases: readonly PromptCase[],
  points: readonly PromptPoint[],
  fixtureIdOf: FixtureIdOf,
): RankedPoint[] {
  return points
    .map((point) => {
      const { summary, scored } = scorePromptPoint(cases, point, fixtureIdOf);
      return {
        point,
        summary,
        byLanguage: perLanguage((language) => languageSummary(scored, language)),
      };
    })
    .sort(byPromptSelectionOrder);
}

function rate(ratio: Ratio): number {
  return ratioValue(ratio) ?? 0;
}

function atLeast(ratio: Ratio, floor: Ratio): boolean {
  return ratio.numerator * floor.denominator >= floor.numerator * ratio.denominator;
}

function weakestLanguageGoldHit(ranked: RankedPoint): number {
  return Math.min(...LANGS.map((lang) => rate(ranked.byLanguage[lang].goldHit)));
}

function byPromptSelectionOrder(a: RankedPoint, b: RankedPoint): number {
  return (
    byPrecisionWeightedF(a.summary, b.summary) ||
    weakestLanguageGoldHit(b) - weakestLanguageGoldHit(a) ||
    rate(b.summary.precisionAll) - rate(a.summary.precisionAll)
  );
}

function languageParity(floor: Ratio): PointRule {
  return (ranked) => LANGS.every((lang) => atLeast(ranked.byLanguage[lang].goldHit, floor));
}

function noMoreFalseInjections(caps: Readonly<Record<Lang, InjectionSummary>>): PointRule {
  return (ranked) =>
    LANGS.every((lang) =>
      atLeast(caps[lang].falseInjection, ranked.byLanguage[lang].falseInjection),
    );
}

function selectionRule(floor: Ratio, caps: Readonly<Record<Lang, InjectionSummary>>): PointRule {
  const parity = languageParity(floor);
  const capped = noMoreFalseInjections(caps);
  return (ranked) => parity(ranked) && capped(ranked);
}

function comparisonRules(w3: RankedPoint): Readonly<Record<string, PointRule>> {
  return {
    a_unconstrained: () => true,
    c_pooled_gold_hit_at_least_w3_pooled: (ranked) =>
      atLeast(ranked.summary.goldHit, w3.summary.goldHit),
    d_czech_gold_hit_at_least_70_percent: (ranked) =>
      atLeast(ranked.byLanguage.cs.goldHit, CZECH_RECALL_TARGET),
    e_english_at_least_w3_english_and_czech_at_least_70_percent: (ranked) =>
      atLeast(ranked.byLanguage.en.goldHit, w3.byLanguage.en.goldHit) &&
      atLeast(ranked.byLanguage.cs.goldHit, CZECH_RECALL_TARGET),
  };
}

function firstAdmitted(ranked: readonly RankedPoint[], rule: PointRule): RankedPoint {
  const admitted = ranked.find(rule);
  if (admitted === undefined) {
    throw new Error("no grid point satisfies the selection rule");
  }
  return admitted;
}

function toolGates(): ToolGate[] {
  return TOOL_KIND_SETS.flatMap((kinds) =>
    KEYWORD_SIGNALS.map((keywordSignal) => ({ kinds, keywordSignal })),
  );
}

function scoreToolGate(
  cases: readonly ToolCase[],
  gate: ToolGate,
  fixtureIdOf: FixtureIdOf,
): ToolResult {
  const scored = cases.map((item) => ({
    id: item.id,
    category: item.gold.length === 0 ? NEGATIVE : POSITIVE,
    gold: item.gold,
    injected: selectToolMemories(item.candidates, gate, NOTHING_INJECTED).map((row) =>
      fixtureIdOf(row.id),
    ),
  }));
  return { gate, summary: injectionSummary(scored), scored };
}

function byPrecisionWeightedF(a: InjectionSummary, b: InjectionSummary): number {
  return b.f05 - a.f05 || a.injectedRows - b.injectedRows;
}

function meanRecall(scored: readonly Scored[], k: number): number | null {
  return (
    mean(
      scored
        .filter((item) => item.gold.length > 0)
        .map((item) => recallAtK(item.injected, item.gold, k)),
    ) ?? null
  );
}

function categoryRatio(scored: readonly Scored[], category: string): Ratio {
  const inCategory = scored.filter((item) => item.category === category);
  return {
    numerator: inCategory.filter((item) => item.injected.length > 0).length,
    denominator: inCategory.length,
  };
}

function languageSummary(scored: readonly Scored[], lang: Lang): InjectionSummary {
  return injectionSummary(scored.filter((item) => item.lang === lang));
}

function summaryRecord(summary: InjectionSummary): Record<string, MetricEntry | number | null> {
  return {
    f05: summary.f05,
    precision_all: ratioMetric(summary.precisionAll),
    precision_positive: ratioMetric(summary.precision),
    gold_hit: ratioMetric(summary.goldHit),
    false_injection: ratioMetric(summary.falseInjection),
    non_gold_rows_per_case: summary.nonGoldRowsPerCase ?? null,
    injected_rows: summary.injectedRows,
  };
}

function thresholdRecord(point: PromptPoint): Record<string, unknown> {
  return Object.fromEntries(
    PROMPT_LANGUAGES.map((language) => {
      const alphas = point.alphas[language];
      return [
        language,
        {
          alpha: alphas.alpha,
          open_alpha: alphas.openAlpha,
          key_alpha: alphas.keyAlpha,
          margin_alpha: alphas.marginAlpha,
          ...point.gate.thresholds[language],
        },
      ];
    }),
  );
}

function promptRecord(result: PromptResult): Record<string, unknown> {
  const { point, summary, scored } = result;
  return {
    key_mode: point.gate.keyMode,
    min_content_tokens: point.minContentTokens,
    max_rows: point.gate.maxRows,
    thresholds: thresholdRecord(point),
    ...summaryRecord(summary),
    recall_at_5: meanRecall(scored, RANK_CUTOFF),
    recall_at_k: meanRecall(scored, point.gate.maxRows),
    by_language: Object.fromEntries(
      LANGS.map((lang) => [lang, summaryRecord(languageSummary(scored, lang))]),
    ),
    ...Object.fromEntries(
      NEGATIVE_CATEGORIES.map((category) => [
        `false_injection_${category}`,
        ratioMetric(categoryRatio(scored, category)),
      ]),
    ),
  };
}

function countRecord(summary: InjectionSummary): Record<string, number> {
  return {
    gold_hits: summary.goldHit.numerator,
    false_injections: summary.falseInjection.numerator,
    gold_rows: summary.precisionAll.numerator,
    injected_rows: summary.injectedRows,
  };
}

function compactRecord(result: PromptResult): Record<string, unknown> {
  const { point, summary, scored } = result;
  return {
    key_mode: point.gate.keyMode,
    min_content_tokens: point.minContentTokens,
    max_rows: point.gate.maxRows,
    ...Object.fromEntries(
      PROMPT_LANGUAGES.map((language) => {
        const alphas = point.alphas[language];
        return [`alphas_${language}`, [alphas.alpha, alphas.openAlpha, alphas.keyAlpha]];
      }),
    ),
    f05: summary.f05,
    ...countRecord(summary),
    by_language: Object.fromEntries(
      LANGS.map((lang) => [lang, countRecord(languageSummary(scored, lang))]),
    ),
  };
}

function toolRecord(result: ToolResult): Record<string, unknown> {
  return {
    kinds: result.gate.kinds,
    keyword_signal: result.gate.keywordSignal,
    ...summaryRecord(result.summary),
  };
}

function diagnostics(scored: readonly Scored[]): Record<string, unknown> {
  return {
    gated_out_positives: scored
      .filter((item) => item.gold.length > 0 && !item.injected.some((id) => item.gold.includes(id)))
      .map((item) => ({ id: item.id, injected: item.injected })),
    falsely_injected_negatives: scored
      .filter((item) => item.gold.length === 0 && item.injected.length > 0)
      .map((item) => ({ id: item.id, category: item.category, injected: item.injected })),
    non_gold_on_positives: scored
      .filter((item) => item.gold.length > 0)
      .flatMap((item) => {
        const trash = item.injected.filter((id) => !item.gold.includes(id));
        return trash.length === 0 ? [] : [{ id: item.id, gold: item.gold, non_gold: trash }];
      }),
  };
}

function classificationAccuracy(cases: readonly PromptCase[]): Record<string, MetricEntry> {
  return Object.fromEntries(
    LANGS.map((lang) => {
      const labelled = cases.filter((item) => item.lang === lang);
      return [
        lang,
        ratioMetric({
          numerator: labelled.filter((item) => item.language === lang).length,
          denominator: labelled.length,
        }),
      ];
    }),
  );
}

function languageClassification(
  cases: readonly PromptCase[],
  minContentTokens: number,
): Record<string, unknown> {
  return {
    all: classificationAccuracy(cases),
    admitted_at_chosen_min_tokens: classificationAccuracy(
      cases.filter((item) => item.admittedAtMinTokens.has(minContentTokens)),
    ),
    misclassified: cases
      .filter((item) => item.language !== item.lang)
      .map((item) => ({
        id: item.id,
        category: item.category,
        lang: item.lang,
        classified: item.language,
        admitted_at_chosen_min_tokens: item.admittedAtMinTokens.has(minContentTokens),
      })),
  };
}

function percent(ratio: Ratio): string {
  return ratio.denominator === 0
    ? "n/a"
    : `${((100 * ratio.numerator) / ratio.denominator).toFixed(1)}%`;
}

function thresholdLabel(point: PromptPoint, language: PromptLanguage): string {
  const alphas = point.alphas[language];
  const thresholds = point.gate.thresholds[language];
  const keyAlpha = alphas.keyAlpha === null ? "" : ` key@${alphas.keyAlpha.toFixed(2)}`;
  const margin =
    alphas.marginAlpha === null
      ? ""
      : ` margin@${alphas.marginAlpha.toFixed(2)}=${thresholds.margin.toFixed(4)}`;
  return `${language} a=${alphas.alpha.toFixed(2)}/${alphas.openAlpha.toFixed(2)}${keyAlpha} floor=${thresholds.floor.toFixed(4)}/${thresholds.floorOpen.toFixed(4)}${margin}`;
}

function languageLabel(summary: InjectionSummary, lang: Lang): string {
  return `${lang}: F0.5=${summary.f05.toFixed(3)} P=${percent(summary.precisionAll)} hit=${percent(summary.goldHit)} FIR=${percent(summary.falseInjection)} trash=${(summary.nonGoldRowsPerCase ?? 0).toFixed(2)}`;
}

function promptLine(result: PromptResult): string {
  const { point, summary, scored } = result;
  return [
    `key=${point.gate.keyMode} min=${point.minContentTokens} k=${point.gate.maxRows}`,
    ...PROMPT_LANGUAGES.map((language) => thresholdLabel(point, language)),
    `all: F0.5=${summary.f05.toFixed(3)} P=${percent(summary.precisionAll)} hit=${percent(summary.goldHit)} FIR=${percent(summary.falseInjection)} trash=${(summary.nonGoldRowsPerCase ?? 0).toFixed(2)} rows=${summary.injectedRows}`,
    ...LANGS.map((lang) => languageLabel(languageSummary(scored, lang), lang)),
  ].join(" | ");
}

function toolLine(result: ToolResult): string {
  const { gate, summary } = result;
  return `kinds=${gate.kinds.join("+")} keyword=${gate.keywordSignal} | F0.5=${summary.f05.toFixed(3)} P=${percent(summary.precisionAll)} hit=${percent(summary.goldHit)} FIR=${percent(summary.falseInjection)} trash=${(summary.nonGoldRowsPerCase ?? 0).toFixed(2)} rows=${summary.injectedRows}`;
}

function writeSweep(meta: RunMeta, record: Record<string, unknown>): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `sweep-${meta.run_id.replaceAll(":", "-")}.json`);
  writeFileSync(path, `${JSON.stringify({ ...meta, ...record }, null, 2)}\n`);
  return path;
}

describe("calibration sweep of the recall gate", () => {
  it("scores every grid point on the calibration split and ranks them by F0.5", async () => {
    const startedAt = performance.now();
    const meta = runMeta(undefined);
    const fixtures = loadFixtures(FIXTURE_DIR);
    const plugin = loadPlugin(REPO_ROOT);
    const disposables: string[] = [];
    try {
      const corpus = await buildCorpusWorld(plugin, fixtures, testModelCacheDir, disposables);
      const fixtureIdOf = fixtureIdResolver(corpus);
      const promptCases = await collectPromptCases(corpus, fixtures);
      const toolCases = collectToolCases(corpus, fixtures);
      const featureMs = performance.now() - startedAt;

      const positives = promptCases.filter((item) => item.gold.length > 0);
      const negatives = promptCases.filter((item) => item.gold.length === 0);
      const gold = goldCosines(positives, fixtureIdOf);
      const classifiedGold = perLanguage((language) =>
        goldCosines(
          positives.filter((item) => item.language === language),
          fixtureIdOf,
        ),
      );
      const classifiedCosines = perLanguage((language) => classifiedGold[language].values);
      const pooledCosines = perLanguage(() => gold.values);
      const classifiedMargins = perLanguage((language) =>
        goldMargins(
          positives.filter((item) => item.language === language),
          fixtureIdOf,
        ),
      );
      const perLanguagePoints = gridSpecs(
        KEY_MODES,
        languageAlphaOptions,
        independentPerLanguage,
      ).map((spec) => promptPoint(classifiedCosines, spec));
      const singleTauPoints = gridSpecs(KEY_MODES, languageAlphaOptions, sharedAcrossLanguages).map(
        (spec) => promptPoint(pooledCosines, spec),
      );
      const centredGold = { cosines: classifiedCosines, margins: classifiedMargins };
      const centredPoints = gridSpecs(
        CENTRED_KEY_MODES,
        centredAlphaOptions,
        independentPerLanguage,
      ).map((spec) => centredPoint(centredGold, spec));
      const rescore = ({ point }: RankedPoint) => scorePromptPoint(promptCases, point, fixtureIdOf);
      const scoreSpec = (spec: PointSpec) =>
        scorePromptPoint(promptCases, promptPoint(classifiedCosines, spec), fixtureIdOf);
      const ranked = rankPromptPoints(promptCases, perLanguagePoints, fixtureIdOf);
      const rankedSingleTau = rankPromptPoints(promptCases, singleTauPoints, fixtureIdOf);
      const toolResults = toolGates()
        .map((gate) => scoreToolGate(toolCases, gate, fixtureIdOf))
        .sort((a, b) => byPrecisionWeightedF(a.summary, b.summary));
      const [bestSingleTauRank] = rankedSingleTau;
      const w3SingleTauRank = rankedSingleTau.find(isW3SingleTauPoint);
      const [chosenTool] = toolResults;
      if (
        bestSingleTauRank === undefined ||
        w3SingleTauRank === undefined ||
        chosenTool === undefined
      ) {
        throw new Error("the sweep produced no grid point");
      }
      const parityFloor = w3SingleTauRank.summary.goldHit;
      const shipping = shippingByLanguage(promptCases, fixtureIdOf);
      const admits = selectionRule(parityFloor, shipping);
      const selectable = ranked.filter(admits);
      const chosenPrompt = rescore(firstAdmitted(selectable, () => true));
      const runnerUps = selectable.slice(1, 1 + RUNNER_UPS).map(rescore);
      const w3SingleTau = rescore(w3SingleTauRank);
      const bestSingleTau = rescore(bestSingleTauRank);
      const comparisons = Object.entries(comparisonRules(w3SingleTauRank)).map(
        ([rule, admits]) => ({ rule, result: rescore(firstAdmitted(ranked, admits)) }),
      );
      const edgeProbe = edgeProbeSpecs(chosenPrompt.point).map(scoreSpec);
      const tradeoff = perLanguage((language) =>
        languageTradeoffSpecs(chosenPrompt.point, language).map(scoreSpec),
      );
      const classification = languageClassification(
        promptCases,
        chosenPrompt.point.minContentTokens,
      );
      const rankedCentred = rankPromptPoints(promptCases, centredPoints, fixtureIdOf);
      const selectableCentred = rankedCentred.filter(admits);
      const parityOnlyCentred = rankedCentred.filter(languageParity(parityFloor));
      const centredReference = rescore(
        firstAdmitted(
          selectableCentred.length > 0 ? selectableCentred : parityOnlyCentred,
          () => true,
        ),
      );
      const chosenCentred = selectableCentred.length > 0 ? centredReference : undefined;
      const centredRunnerUps = selectableCentred.slice(1, 1 + RUNNER_UPS).map(rescore);
      const openFloorProbe = rankPromptPoints(
        promptCases,
        openFloorProbeSpecs(centredReference.point).map((spec) => centredPoint(centredGold, spec)),
        fixtureIdOf,
      ).map(rescore);
      const corpusCases = promptCases.map((item) => ({
        ...item,
        neighbourhood: item.corpusNeighbourhood,
      }));
      const densityProbe = scorePromptPoint(corpusCases, centredReference.point, fixtureIdOf);
      const sparse = sparseNeighbourhoods(promptCases);

      const path = writeSweep(meta, {
        kind: "sweep",
        model_id: MODEL_ID,
        sweep_ms: performance.now() - startedAt,
        feature_ms: featureMs,
        calibration: {
          positives: positives.length,
          negatives: negatives.length,
          pretool_positives: toolCases.filter((item) => item.gold.length > 0).length,
          pretool_negatives: toolCases.filter((item) => item.gold.length === 0).length,
          language_classification: classification,
          gold_cosine_pairs_with_cosine: gold.coverage,
          gold_cosines: distribution(gold.values),
          ...Object.fromEntries(
            LANGS.map((lang) => [
              `gold_cosines_${lang}`,
              distribution(
                goldCosines(
                  positives.filter((item) => item.lang === lang),
                  fixtureIdOf,
                ).values,
              ),
            ]),
          ),
          ...Object.fromEntries(
            PROMPT_LANGUAGES.map((language) => [
              `gold_cosines_classified_${language}`,
              {
                coverage: classifiedGold[language].coverage,
                ...distribution(classifiedGold[language].values),
              },
            ]),
          ),
          positive_top_cosines: distribution(topCosines(positives)),
          negative_top_cosines: distribution(topCosines(negatives)),
          ...Object.fromEntries(
            LANGS.map((lang) => [
              `negative_top_cosines_${lang}`,
              distribution(topCosines(negatives.filter((item) => item.lang === lang))),
            ]),
          ),
        },
        prompt_grid_points: perLanguagePoints.length,
        single_tau_grid_points: singleTauPoints.length,
        selection_rule: {
          objective: "max pooled F0.5 of precision over all injected rows and gold hit",
          language_gold_hit_floor: ratioMetric(parityFloor),
          floor_source: "pooled calibration gold hit of the W3 frozen single-tau point",
          language_false_injection_caps: perLanguage((language) =>
            ratioMetric(shipping[language].falseInjection),
          ),
          caps_source: "per-language calibration false-injection rate of the shipping frozen point",
          tie_breaks: SELECTION_TIE_BREAKS,
        },
        selectable_points: selectable.length,
        prompt_points_top: selectable.slice(0, PERSISTED_POINTS).map(rescore).map(promptRecord),
        prompt_points_all: ranked.map(rescore).map(compactRecord),
        single_tau_points_top: rankedSingleTau
          .slice(0, PERSISTED_POINTS)
          .map(rescore)
          .map(promptRecord),
        tool_points: toolResults.map(toolRecord),
        chosen: {
          prompt: promptRecord(chosenPrompt),
          prompt_diagnostics: diagnostics(chosenPrompt.scored),
          tool: toolRecord(chosenTool),
          tool_diagnostics: diagnostics(chosenTool.scored),
        },
        runner_ups: runnerUps.map(promptRecord),
        comparison: {
          single_tau_w3_frozen: promptRecord(w3SingleTau),
          single_tau_best_same_grid: promptRecord(bestSingleTau),
          ...Object.fromEntries(
            comparisons.map(({ rule, result }) => [rule, promptRecord(result)]),
          ),
        },
        edge_probe_not_selectable: edgeProbe.map(promptRecord),
        language_tradeoff_not_selectable: perLanguage((language) =>
          tradeoff[language].map(promptRecord),
        ),
        neighbourhood_centred: {
          rule: "cosine >= floor and cosine - mean of the K nearest partition cosines >= margin; absolute fallback tau below K",
          neighbourhood_size: NEIGHBOURHOOD_SIZE,
          sparse_neighbourhood_prompts: sparse,
          ...Object.fromEntries(
            PROMPT_LANGUAGES.map((language) => [
              `gold_margins_classified_${language}`,
              {
                n: classifiedMargins[language].length,
                ...distribution(classifiedMargins[language]),
              },
            ]),
          ),
          grid_points: centredPoints.length,
          selectable_points: selectableCentred.length,
          points_top: selectableCentred.slice(0, PERSISTED_POINTS).map(rescore).map(promptRecord),
          chosen: chosenCentred === undefined ? null : promptRecord(chosenCentred),
          probe_reference: promptRecord(centredReference),
          probe_reference_source:
            chosenCentred === undefined
              ? "best centred point meeting the gold hit floor only; no centred point meets the full rule"
              : "chosen centred point",
          chosen_diagnostics: diagnostics(centredReference.scored),
          runner_ups: centredRunnerUps.map(promptRecord),
          open_floor_probe_not_selectable: openFloorProbe.map(promptRecord),
          density_probe_not_selectable: {
            partition_neighbourhood: promptRecord(centredReference),
            corpus_neighbourhood: promptRecord(densityProbe),
          },
        },
      });
      console.log(
        [
          `sweep ${meta.run_id} -> ${path}`,
          `calibration prompts: ${positives.length} positive, ${negatives.length} negative; gold cosines with a KNN cosine ${gold.coverage.numerator}/${gold.coverage.denominator}`,
          `language classification ${JSON.stringify(classification)}`,
          `gold cosine ${JSON.stringify(distribution(gold.values))}`,
          ...PROMPT_LANGUAGES.map(
            (language) =>
              `gold cosine classified ${language} ${JSON.stringify(distribution(classifiedGold[language].values))}`,
          ),
          `negative top cosine ${JSON.stringify(distribution(topCosines(negatives)))}`,
          `shipping frozen point on calibration: ${LANGS.map((lang) => languageLabel(shipping[lang], lang)).join(" | ")}`,
          `UserPromptSubmit per-language points with every language gold hit >= ${percent(parityFloor)} and no more false injections than shipping per language, by F0.5 (${selectable.length} of ${perLanguagePoints.length}):`,
          ...selectable.slice(0, SUMMARY_ROWS).map(rescore).map(promptLine),
          "single-tau comparison, W3 frozen point:",
          promptLine(w3SingleTau),
          `single-tau comparison, best of ${singleTauPoints.length} on the same grid:`,
          promptLine(bestSingleTau),
          ...comparisons.flatMap(({ rule, result }) => [`comparison ${rule}:`, promptLine(result)]),
          "edge probe beyond the alpha grid, not selectable:",
          ...edgeProbe.map(promptLine),
          ...PROMPT_LANGUAGES.flatMap((language) => [
            `${language} thresholds and min tokens varied around the chosen point, not selectable:`,
            ...tradeoff[language].map(promptLine),
          ]),
          `neighbourhood-centred family, K=${NEIGHBOURHOOD_SIZE}, sparse neighbourhoods ${JSON.stringify(sparse)}`,
          ...PROMPT_LANGUAGES.map(
            (language) =>
              `gold margin classified ${language} ${JSON.stringify(distribution(classifiedMargins[language]))}`,
          ),
          `centred points with every language gold hit >= ${percent(parityFloor)} and no more false injections than shipping per language, by F0.5 (${selectableCentred.length} of ${centredPoints.length}):`,
          ...selectableCentred.slice(0, SUMMARY_ROWS).map(rescore).map(promptLine),
          chosenCentred === undefined
            ? "no centred point meets the full rule; probes below use the best centred point that meets the gold hit floor only:"
            : "centred probes use the chosen centred point:",
          promptLine(centredReference),
          "centred open floor for constraints and preferences varied around the probe reference, not selectable:",
          ...openFloorProbe.map(promptLine),
          "per-language tau family chosen point, for comparison:",
          promptLine(chosenPrompt),
          "density probe, chosen centred point with the neighbourhood over the whole corpus, not selectable:",
          promptLine(densityProbe),
          "PreToolUse points by F0.5:",
          ...toolResults.map(toolLine),
          `sweep runtime ${Math.round(performance.now() - startedAt)} ms (features ${Math.round(featureMs)} ms)`,
        ].join("\n"),
      );

      expect(
        perLanguagePoints.every(({ gate }) =>
          PROMPT_LANGUAGES.every(
            (language) => gate.thresholds[language].tauKey <= gate.thresholds[language].floor,
          ),
        ),
      ).toBe(true);
      expect(toolResults).toHaveLength(TOOL_KIND_SETS.length * KEYWORD_SIGNALS.length);
    } finally {
      for (const dir of disposables) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
