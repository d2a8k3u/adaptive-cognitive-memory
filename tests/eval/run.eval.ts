import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_FILENAME } from "../../src/cfg";
import { DEMOTION_MIN_RECEIPTED_INJECTIONS } from "../../src/lifecycle";
import { testModelCacheDir } from "../../vitest.config";
import { buildCorpusWorld, ownersOf, projectKeys, type StoredWorld, storeAll } from "./corpus";
import {
  type CaptureCue,
  type ContradictionCase,
  type Fixtures,
  LANGS,
  type Lang,
  loadFixtures,
  NEGATIVE_CATEGORIES,
  PRETOOL_SPLITS,
  type PretoolCase,
  type PretoolSplit,
  pretoolSplit,
  type RedactionSample,
  referenceProblems,
  SPLITS,
  type Split,
  type SupersessionCase,
  sizeProblems,
} from "./fixtures";
import {
  type ContextDelivery,
  type ContextEventName,
  deliveredContext,
  injectedIds,
  stopDelivery,
} from "./host";
import {
  contradictionLeak,
  falseInjectionRate,
  injectionSummary,
  type MetricEntry,
  mean,
  ndcgAtK,
  percentile,
  precisionOf,
  type Ratio,
  ratioMetric,
  recallAtK,
  staleExposure,
  toolRecallHit,
} from "./metrics";
import { FIXTURE_DIR, REPO_ROOT, RESULTS_DIR, type RunMeta, runMeta } from "./provenance";
import {
  createWorld,
  HOOK_POOL_SIZE,
  type HookInvocation,
  type HookRun,
  loadPlugin,
  mapPool,
  type PluginUnderTest,
  projectDirs,
  resolveToolInput,
  runHook,
  type StoreArguments,
  type StoredMemory,
  type StoreOutcome,
  type World,
  WorldWriter,
} from "./world";

const RESULTS_FILE = join(RESULTS_DIR, "results.jsonl");
const RANK_CUTOFF = 5;
const CONFIRMATION_SPLIT = "confirmation";
const SUITE_COLUMN_CHARS = 20;
const SUPERSESSION_SHARD_SIZE = 50;
const SESSION_SOURCE = "startup";
const COMPACT_SOURCE = "compact";
const SESSION_EARLIER_PROMPTS = 3;
const SESSION_PINNED_KINDS: ReadonlySet<string> = new Set(["constraint", "preference"]);
const REDACTION_PROJECT = "vault";
const DEGRADED_PROJECT = "degraded";
const NOOP_ACTION = "noop";
const SUPERSEDED_ACTION = "superseded";
const NEEDS_RESOLUTION = "needs_resolution";
const ACTIVE_STATE = "active";
const USER_SCOPE = "user";
const MEDIAN = 0.5;
const P95 = 0.95;
const MAX = 1;
const DEGRADED_FIRST: StoreArguments = {
  title: "Commit hygiene",
  content:
    "Run the unit tests and the linter before every commit, and never commit generated files.",
  type: "pattern",
  scope: "project",
  kind: "constraint",
  conflict_key: "project.commit_hygiene",
  cardinality: "single",
  value_text: "tests and linter before every commit",
  keywords: "commit lint unit tests generated files",
  anchors: [],
};
const DEGRADED_SECOND: StoreArguments = {
  title: "tests",
  content:
    "Integration tests need the Postgres container from docker compose up db before they run.",
  type: "semantic",
  scope: "project",
  kind: "fact",
  conflict_key: "project.integration_test_dependencies",
  cardinality: "single",
  value_text: "docker compose up db",
  keywords: "integration tests postgres docker compose",
  anchors: [],
};

const LIFECYCLE_RECEIPT_PROJECT = "receipting";
const LIFECYCLE_SILENT_PROJECT = "silent";
const FEEDBACK_TOOL_NAME = "mcp__plugin_adaptive-cognitive-memory_memory__memory_feedback";
const LIFECYCLE_UNUSED: StoreArguments = {
  title: "Release tagging",
  content: "Tag every release from the main branch with an annotated tag before announcing it.",
  type: "pattern",
  scope: "project",
  kind: "constraint",
  conflict_key: "git.release_tagging",
  cardinality: "single",
  value_text: "annotated tag on main",
  keywords: "release tag annotated main",
  anchors: [],
};
const LIFECYCLE_RECEIPTED: StoreArguments = {
  title: "Changelog entries",
  content: "Every pull request adds a changelog entry under the Unreleased heading.",
  type: "pattern",
  scope: "project",
  kind: "constraint",
  conflict_key: "git.release_changelog",
  cardinality: "single",
  value_text: "entry under Unreleased",
  keywords: "changelog pull request unreleased",
  anchors: [],
};
const LIFECYCLE_SILENT: StoreArguments = {
  title: "Migration tool only",
  content: "Database migrations run through the migration tool only, never by hand in production.",
  type: "pattern",
  scope: "project",
  kind: "constraint",
  conflict_key: "db.migrations",
  cardinality: "single",
  value_text: "migration tool only",
  keywords: "database migrations tool production",
  anchors: [],
};

const CAPTURE_PROJECT = "capture";
const CHECKPOINT_PROJECT = "checkpoint";
const STORE_TOOL_NAME = "mcp__plugin_adaptive-cognitive-memory_memory__memory_store";
const CORRECTION_CUE_LINE = `If this message corrects how you work, store the rule and the reason with ${STORE_TOOL_NAME} before continuing.`;
const REMEMBER_CUE_LINE = `The user asked you to remember this: store it with ${STORE_TOOL_NAME} now.`;
const DETECTED_CUES = ["correction", "remember"] as const;
const CHECKPOINT_CORRECTION =
  "Don't run the migrations against the shared database, use the local container.";
const CHECKPOINT_NEUTRAL = "Add a test for the refund webhook and run it.";
const CHECKPOINT_FAILING_COMMAND = "pytest -q tests/test_refunds.py";
const CHECKPOINT_STEADY_COMMAND = "git status --short";
const CHECKPOINT_STEADY_RUNS = 30;
const CHECKPOINT_LESSON: StoreArguments = {
  title: "Migrations run against the local container",
  content:
    "Run database migrations against the local docker container only; the shared database belongs to the staging team.",
  type: "pattern",
  scope: "project",
  kind: "constraint",
  conflict_key: "db.migration_target",
  cardinality: "single",
  value_text: "local container",
  keywords: "migrations shared database local container",
  anchors: [],
};

type DetectedCue = (typeof DETECTED_CUES)[number];
type ContextInvocation = HookInvocation & { readonly event: ContextEventName };
type ResultRecord = Readonly<Record<string, unknown>>;

interface SupersessionShard {
  readonly cases: readonly SupersessionCase[];
  readonly stored: StoredWorld;
}

interface ContradictionWorld {
  readonly cases: readonly ContradictionCase[];
  readonly stored: StoredWorld;
  readonly readBack: ReadonlyMap<string, StoredMemory>;
}

interface RedactionOutcome {
  readonly sample: RedactionSample;
  readonly outcome: StoreOutcome;
  readonly readBack: StoredMemory;
}

interface DegradedOutcome {
  readonly first: StoreOutcome;
  readonly second: StoreOutcome;
  readonly secondReadBack: StoredMemory;
}

interface Worlds {
  readonly corpus: StoredWorld;
  readonly supersession: readonly SupersessionShard[];
  readonly contradictions: ContradictionWorld;
  readonly redaction: readonly RedactionOutcome[];
  readonly degraded: DegradedOutcome;
}

interface Observation {
  readonly event: ContextEventName;
  readonly delivery: ContextDelivery;
  readonly injected: readonly string[];
  readonly printed: readonly string[];
  readonly run: HookRun;
}

interface CaseLabels {
  readonly split: Split | PretoolSplit | null;
  readonly lang: Lang | null;
  readonly category: string | null;
  readonly gold: readonly string[];
}

interface SummaryRow {
  readonly suite: string;
  readonly metric: string;
  readonly entry: MetricEntry;
}

interface RunState {
  readonly meta: RunMeta;
  readonly fixtures: Fixtures;
  readonly plugin: PluginUnderTest;
  readonly sample: number | undefined;
  readonly problems: readonly string[];
  readonly summary: SummaryRow[];
  readonly latencies: { readonly event: string; readonly ms: number }[];
  readonly disposables: string[];
  readonly rootInjectedByPositive: Map<string, readonly string[]>;
  worlds: Worlds | undefined;
}

interface RecallCase extends CaseLabels {
  readonly id: string;
  readonly project: string;
  readonly prompt: string;
  readonly positive: boolean;
}

function sampleLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RangeError(`EVAL_SAMPLE must be a positive integer, got ${raw}`);
  }
  return parsed;
}

function sampleEvenly<T>(items: readonly T[], limit: number | undefined): T[] {
  if (limit === undefined || items.length <= limit) {
    return [...items];
  }
  return Array.from(
    { length: limit },
    (_, index) => items[Math.floor((index * items.length) / limit)] as T,
  );
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

function storeFields(outcome: StoreOutcome | undefined): ResultRecord {
  return {
    action: outcome?.action ?? null,
    ref_id: outcome?.refId ?? null,
    promoted_id: outcome?.promotedId ?? null,
    phase_one: outcome?.phaseOne ?? null,
    candidates: outcome?.candidateCount ?? null,
    same_key_candidate: outcome?.sameKeyCandidate ?? null,
    same_key_found_without_key: outcome?.sameKeyFoundWithoutKey ?? null,
    resolution: outcome?.resolution ?? null,
  };
}

function prefixed(prefix: string, record: ResultRecord): ResultRecord {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [`${prefix}_${key}`, value]),
  );
}

function sharedStoredIds(owners: ReadonlyMap<string, string>): string[] {
  const fixtureIdsByStoredId = new Map<string, string[]>();
  for (const [fixtureId, storedId] of owners) {
    fixtureIdsByStoredId.set(storedId, [...(fixtureIdsByStoredId.get(storedId) ?? []), fixtureId]);
  }
  return [...fixtureIdsByStoredId]
    .filter(([, fixtureIds]) => fixtureIds.length > 1)
    .map(([storedId, fixtureIds]) => `${storedId}: ${fixtureIds.join(", ")}`);
}

async function newWorld(state: RunState, keys: readonly string[], models: string): Promise<World> {
  const world = await createWorld(keys, models);
  state.disposables.push(world.base);
  return world;
}

async function buildSupersessionShard(
  state: RunState,
  cases: readonly SupersessionCase[],
): Promise<SupersessionShard> {
  const world = await newWorld(state, projectKeys(state.fixtures), testModelCacheDir);
  const writer = new WorldWriter(state.plugin, world);
  const startedAt = performance.now();
  try {
    const olds = await storeAll(
      writer,
      world,
      cases.map((item) => ({ memory: item.old, projectKey: item.project })),
    );
    const news = await storeAll(
      writer,
      world,
      cases.map((item) => ({ memory: item.new, projectKey: item.project })),
    );
    const loaded = [...olds, ...news];
    return {
      cases,
      stored: { world, loaded, owners: ownersOf(loaded), loadMs: performance.now() - startedAt },
    };
  } finally {
    await writer.close();
  }
}

async function buildContradictionWorld(
  state: RunState,
  cases: readonly ContradictionCase[],
): Promise<ContradictionWorld> {
  const world = await newWorld(state, projectKeys(state.fixtures), testModelCacheDir);
  const writer = new WorldWriter(state.plugin, world);
  const startedAt = performance.now();
  try {
    const sides = [
      ...cases.map((item) => ({ memory: item.a.memory, projectKey: item.a.project })),
      ...cases.map((item) => ({ memory: item.b.memory, projectKey: item.b.project })),
    ];
    const loaded = await storeAll(writer, world, sides);
    const readBack = new Map<string, StoredMemory>();
    for (const entry of loaded) {
      const cwd = projectDirs(world, entry.projectKey).root;
      readBack.set(entry.fixtureId, await writer.get(cwd, entry.outcome.id));
    }
    return {
      cases,
      stored: { world, loaded, owners: ownersOf(loaded), loadMs: performance.now() - startedAt },
      readBack,
    };
  } finally {
    await writer.close();
  }
}

async function storeRedactionSample(
  state: RunState,
  sample: RedactionSample,
): Promise<RedactionOutcome> {
  const world = await newWorld(state, [REDACTION_PROJECT], testModelCacheDir);
  const writer = new WorldWriter(state.plugin, world);
  const cwd = projectDirs(world, REDACTION_PROJECT).root;
  try {
    const outcome = await writer.store(cwd, {
      title: `Credential handling note ${sample.name}`,
      content: sample.text,
      type: "semantic",
      scope: "project",
      kind: "fact",
      conflict_key: `test.credential_note.${sample.name}`,
      cardinality: "multi",
      value_text: "",
      keywords: "",
      anchors: [],
    });
    return { sample, outcome, readBack: await writer.get(cwd, outcome.id) };
  } finally {
    await writer.close();
  }
}

async function runDegradedControl(state: RunState): Promise<DegradedOutcome> {
  const emptyModels = realpathSync(mkdtempSync(join(tmpdir(), "acm-eval-no-model-")));
  state.disposables.push(emptyModels);
  const world = await newWorld(state, [DEGRADED_PROJECT], emptyModels);
  const writer = new WorldWriter(state.plugin, world);
  const cwd = projectDirs(world, DEGRADED_PROJECT).root;
  try {
    const first = await writer.store(cwd, DEGRADED_FIRST);
    const second = await writer.store(cwd, DEGRADED_SECOND);
    return { first, second, secondReadBack: await writer.get(cwd, second.id) };
  } finally {
    await writer.close();
  }
}

async function buildWorlds(state: RunState): Promise<Worlds> {
  const supersessionCases = sampleEvenly(state.fixtures.supersession, state.sample);
  const contradictionCases = sampleEvenly(state.fixtures.contradictions, state.sample);
  const redactionSamples = sampleEvenly(state.fixtures.redaction, state.sample);
  const [corpus, supersession, contradictions, redaction, degraded] = await Promise.all([
    buildCorpusWorld(state.plugin, state.fixtures, testModelCacheDir, state.disposables),
    Promise.all(
      chunks(supersessionCases, SUPERSESSION_SHARD_SIZE).map((shard) =>
        buildSupersessionShard(state, shard),
      ),
    ),
    buildContradictionWorld(state, contradictionCases),
    mapPool(redactionSamples, HOOK_POOL_SIZE, (sample) => storeRedactionSample(state, sample)),
    runDegradedControl(state),
  ]);
  return { corpus, supersession, contradictions, redaction, degraded };
}

function memoryRowCount(world: World): number {
  const db = new Database(join(world.pluginData, DB_FILENAME), { readonly: true });
  try {
    return (db.prepare("SELECT count(*) AS n FROM memories").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function requireWorlds(state: RunState): Worlds {
  if (state.worlds === undefined) {
    throw new Error("evaluation worlds were not built because the fixtures failed integrity");
  }
  return state.worlds;
}

async function observe(
  state: RunState,
  world: World,
  owners: ReadonlyMap<string, string>,
  invocation: ContextInvocation,
): Promise<Observation> {
  const run = await runHook(state.plugin, world, invocation);
  if (run.registered) {
    state.latencies.push({ event: invocation.event, ms: run.latencyMs });
  }
  const delivery = deliveredContext(invocation.event, run);
  return {
    event: invocation.event,
    delivery,
    injected: injectedIds(delivery.text, owners),
    printed: injectedIds(run.stdout, owners),
    run,
  };
}

function promptInvocation(cwd: string, prompt: string, sessionId?: string): ContextInvocation {
  return { event: "UserPromptSubmit", cwd, projectDir: cwd, fields: { prompt }, sessionId };
}

function recordBase(state: RunState): ResultRecord {
  return {
    run_id: state.meta.run_id,
    ts: new Date().toISOString(),
    git_sha: state.meta.git_sha,
    source_dirty: state.meta.source_dirty,
    fixture_digest: state.meta.fixture_digest,
  };
}

function hookCaseRecord(
  state: RunState,
  suite: string,
  caseId: string,
  labels: CaseLabels,
  observation: Observation,
  extra: ResultRecord,
): ResultRecord {
  return {
    ...recordBase(state),
    kind: "case",
    suite,
    case_id: caseId,
    event: observation.event,
    registered: observation.run.registered,
    split: labels.split,
    lang: labels.lang,
    category: labels.category,
    gold: labels.gold,
    injected: observation.injected,
    printed: observation.printed,
    delivered_chars: observation.delivery.text.length,
    channel: observation.delivery.channel,
    overflowed: observation.delivery.overflowed,
    exit_code: observation.run.exitCode,
    timed_out: observation.run.timedOut,
    latency_ms: observation.run.latencyMs,
    session_id: observation.run.sessionId,
    ...extra,
  };
}

function storeCaseRecord(
  state: RunState,
  suite: string,
  caseId: string,
  extra: ResultRecord,
): ResultRecord {
  return {
    ...recordBase(state),
    kind: "case",
    suite,
    case_id: caseId,
    event: "memory_store",
    split: null,
    lang: null,
    category: null,
    gold: [],
    injected: [],
    delivered_chars: null,
    latency_ms: null,
    ...extra,
  };
}

function appendRecords(records: readonly ResultRecord[]): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(RESULTS_FILE, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
}

function writeAggregate(
  state: RunState,
  suite: string,
  metrics: Readonly<Record<string, MetricEntry>>,
): void {
  appendRecords([{ ...recordBase(state), kind: "aggregate", suite, metrics }]);
  for (const [metric, entry] of Object.entries(metrics)) {
    state.summary.push({ suite, metric, entry });
  }
}

function countRatio<T>(items: readonly T[], predicate: (item: T) => boolean): Ratio {
  return { numerator: items.filter(predicate).length, denominator: items.length };
}

function meanMetric(values: readonly number[]): MetricEntry {
  return { value: mean(values) ?? null, n: values.length };
}

function protocolMetrics(outcomes: readonly StoreOutcome[]): Record<string, MetricEntry> {
  const resolved = outcomes.filter((outcome) => outcome.phaseOne === NEEDS_RESOLUTION);
  return {
    needs_resolution_share: ratioMetric(
      countRatio(outcomes, (outcome) => outcome.phaseOne === NEEDS_RESOLUTION),
    ),
    candidates_mean: meanMetric(resolved.map((outcome) => outcome.candidateCount)),
    same_key_row_in_semantic_candidates: ratioMetric(
      countRatio(
        outcomes.filter((outcome) => outcome.sameKeyCandidate),
        (outcome) => outcome.sameKeyFoundWithoutKey === true,
      ),
    ),
  };
}

function valueMetric(value: number): MetricEntry {
  return { value, n: 1 };
}

function distributionMetrics(name: string, values: readonly number[]): Record<string, MetricEntry> {
  if (values.length === 0) {
    return {};
  }
  return {
    [`${name}_p50`]: { value: percentile(values, MEDIAN), n: values.length },
    [`${name}_p95`]: { value: percentile(values, P95), n: values.length },
    [`${name}_max`]: { value: percentile(values, MAX), n: values.length },
  };
}

function observationDistributions(
  observations: readonly Observation[],
): Record<string, MetricEntry> {
  const registered = observations.filter((observation) => observation.run.registered);
  return {
    ...distributionMetrics(
      "latency_ms",
      registered.map((observation) => observation.run.latencyMs),
    ),
    ...distributionMetrics(
      "delivered_chars",
      observations.map((observation) => observation.delivery.text.length),
    ),
  };
}

function goldHit(injected: readonly string[], gold: readonly string[]): boolean {
  return recallAtK(injected, gold, Number.POSITIVE_INFINITY) > 0;
}

interface RecallObservation {
  readonly item: RecallCase;
  readonly observation: Observation;
}

function recallMetrics(observed: readonly RecallObservation[]): Record<string, MetricEntry> {
  const positives = observed.filter(({ item }) => item.positive);
  const negatives = observed.filter(({ item }) => !item.positive);
  const summaryOf = (subset: readonly RecallObservation[]) =>
    injectionSummary(
      subset.map(({ item, observation }) => ({ injected: observation.injected, gold: item.gold })),
    );
  const summary = summaryOf(observed);
  const hits = (subset: readonly RecallObservation[]) =>
    ratioMetric(
      countRatio(subset, ({ item, observation }) => goldHit(observation.injected, item.gold)),
    );
  const negativeRate = (subset: readonly RecallObservation[]) =>
    ratioMetric(falseInjectionRate(subset.map(({ observation }) => observation.injected)));
  return {
    positive_gold_hit_rate: hits(positives),
    ...Object.fromEntries(
      LANGS.map((lang) => [
        `positive_gold_hit_rate_${lang}`,
        hits(positives.filter(({ item }) => item.lang === lang)),
      ]),
    ),
    positive_recall_at_5: meanMetric(
      positives.map(({ item, observation }) =>
        recallAtK(observation.injected, item.gold, RANK_CUTOFF),
      ),
    ),
    positive_ndcg_at_5: meanMetric(
      positives.map(({ item, observation }) =>
        ndcgAtK(observation.injected, item.gold, RANK_CUTOFF),
      ),
    ),
    positive_precision: ratioMetric(summary.precision),
    precision_all_injected: ratioMetric(summary.precisionAll),
    f05_precision_all_vs_gold_hit: valueMetric(summary.f05),
    non_gold_rows_per_prompt: { value: summary.nonGoldRowsPerCase ?? null, n: observed.length },
    positive_rows_mean: meanMetric(positives.map(({ observation }) => observation.injected.length)),
    negative_false_injection_rate: negativeRate(negatives),
    ...Object.fromEntries(
      NEGATIVE_CATEGORIES.map((category) => [
        `negative_false_injection_rate_${category}`,
        negativeRate(negatives.filter(({ item }) => item.category === category)),
      ]),
    ),
    ...Object.fromEntries(
      LANGS.flatMap((lang) => {
        const inLanguage = observed.filter(({ item }) => item.lang === lang);
        return [
          [`precision_all_injected_${lang}`, ratioMetric(summaryOf(inLanguage).precisionAll)],
          [
            `negative_false_injection_rate_${lang}`,
            negativeRate(inLanguage.filter(({ item }) => !item.positive)),
          ],
        ];
      }),
    ),
    negative_rows_mean: meanMetric(negatives.map(({ observation }) => observation.injected.length)),
  };
}

function deliveredCue(text: string): DetectedCue | undefined {
  const lines = text.split("\n");
  if (lines.includes(REMEMBER_CUE_LINE)) {
    return "remember";
  }
  return lines.includes(CORRECTION_CUE_LINE) ? "correction" : undefined;
}

interface CueObservation {
  readonly cue: CaptureCue;
  readonly detected: DetectedCue | undefined;
  readonly observation: Observation;
}

function cueLabelMetrics(
  observed: readonly CueObservation[],
  suffix: string,
): Record<string, MetricEntry> {
  return Object.fromEntries(
    DETECTED_CUES.flatMap((label) => [
      [
        `${label}_precision${suffix}`,
        ratioMetric(
          countRatio(
            observed.filter(({ detected }) => detected === label),
            ({ cue }) => cue.label === label,
          ),
        ),
      ],
      [
        `${label}_recall${suffix}`,
        ratioMetric(
          countRatio(
            observed.filter(({ cue }) => cue.label === label),
            ({ detected }) => detected === label,
          ),
        ),
      ],
    ]),
  );
}

function cueMetrics(observed: readonly CueObservation[]): Record<string, MetricEntry> {
  const human = observed.filter(({ cue }) => cue.origin === "human");
  const harness = observed.filter(({ cue }) => cue.origin === "harness");
  const anyCue = ({ detected }: CueObservation) => detected !== undefined;
  const neutralRate = (subset: readonly CueObservation[]) =>
    ratioMetric(
      countRatio(
        subset.filter(({ cue }) => cue.label === "neutral"),
        anyCue,
      ),
    );
  return {
    ...cueLabelMetrics(human, ""),
    ...Object.fromEntries(
      LANGS.flatMap((lang) =>
        Object.entries(
          cueLabelMetrics(
            human.filter(({ cue }) => cue.lang === lang),
            `_${lang}`,
          ),
        ),
      ),
    ),
    any_cue_precision: ratioMetric(
      countRatio(human.filter(anyCue), ({ cue }) => cue.label !== "neutral"),
    ),
    any_cue_recall: ratioMetric(
      countRatio(
        human.filter(({ cue }) => cue.label !== "neutral"),
        anyCue,
      ),
    ),
    neutral_false_cue_rate: neutralRate(human),
    ...Object.fromEntries(
      LANGS.map((lang) => [
        `neutral_false_cue_rate_${lang}`,
        neutralRate(human.filter(({ cue }) => cue.lang === lang)),
      ]),
    ),
    harness_cue_rate: ratioMetric(countRatio(harness, anyCue)),
    ...observationDistributions(observed.map(({ observation }) => observation)),
  };
}

function formatEntry(metric: string, entry: MetricEntry): string {
  if (entry.value === null) {
    return "n/a";
  }
  if (entry.denominator !== undefined) {
    return `${(entry.value * 100).toFixed(1)}%`;
  }
  if (metric.includes("_ms") || metric.includes("_chars")) {
    return entry.value.toFixed(0);
  }
  return entry.value.toFixed(3);
}

function formatInterval(entry: MetricEntry): string {
  const interval = entry.ci95;
  if (interval === undefined || interval === null) {
    return "";
  }
  const bounds = `[${(interval[0] * 100).toFixed(1)}, ${(interval[1] * 100).toFixed(1)}]`;
  return entry.zero_event_upper95 === undefined
    ? bounds
    : `${bounds} zero-event<=${(entry.zero_event_upper95 * 100).toFixed(2)}%`;
}

function summaryTable(rows: readonly SummaryRow[]): string {
  const lines = rows.map((row) =>
    [
      row.suite.padEnd(SUITE_COLUMN_CHARS),
      row.metric.padEnd(42),
      formatEntry(row.metric, row.entry).padStart(9),
      `n=${row.entry.n}`.padEnd(8),
      formatInterval(row.entry),
    ].join(" "),
  );
  return [`${"suite".padEnd(SUITE_COLUMN_CHARS)} metric`, ...lines].join("\n");
}

describe("memory evaluation at the host boundary", () => {
  let state: RunState;

  beforeAll(async () => {
    const sample = sampleLimit(process.env.EVAL_SAMPLE);
    const fixtures = loadFixtures(FIXTURE_DIR);
    state = {
      meta: runMeta(sample),
      fixtures,
      plugin: loadPlugin(REPO_ROOT),
      sample,
      problems: [...referenceProblems(fixtures), ...sizeProblems(fixtures)],
      summary: [],
      latencies: [],
      disposables: [],
      rootInjectedByPositive: new Map(),
      worlds: undefined,
    };
    if (state.problems.length === 0) {
      state.worlds = await buildWorlds(state);
    }
  });

  afterAll(() => {
    if (state === undefined) {
      return;
    }
    const byEvent = new Map<string, number[]>();
    for (const { event, ms } of state.latencies) {
      byEvent.set(event, [...(byEvent.get(event) ?? []), ms]);
    }
    writeAggregate(
      state,
      "latency",
      Object.fromEntries(
        [...byEvent].flatMap(([event, values]) =>
          Object.entries(distributionMetrics(`${event}_ms`, values)),
        ),
      ),
    );
    for (const path of state.disposables) {
      rmSync(path, { recursive: true, force: true });
    }
    console.log(
      `\nrun ${state.meta.run_id} (${state.meta.git_sha.slice(0, 7)}${state.meta.source_dirty ? ", dirty" : ""}, sample ${state.meta.sample ?? "full"}) -> ${RESULTS_FILE}\n${summaryTable(state.summary)}\n`,
    );
  });

  it("fixtures are intact and every corpus memory was stored with an unambiguous id", () => {
    expect(state.problems).toEqual([]);
    const { corpus } = requireWorlds(state);
    expect(corpus.loaded.map((entry) => entry.fixtureId)).toEqual(
      state.fixtures.corpus.memories.map((memory) => memory.id),
    );
    expect(sharedStoredIds(corpus.owners)).toEqual([]);
    appendRecords(
      corpus.loaded.map((entry) =>
        storeCaseRecord(state, "corpus_load", entry.fixtureId, {
          project: entry.projectKey,
          ...storeFields(entry.outcome),
          stored_id: entry.outcome.id,
        }),
      ),
    );
    const outcomes = corpus.loaded.map((entry) => entry.outcome);
    writeAggregate(state, "corpus_load", {
      created_share: ratioMetric(countRatio(outcomes, ({ action }) => action === "created")),
      noop_share: ratioMetric(countRatio(outcomes, ({ action }) => action === NOOP_ACTION)),
      promoted_share: ratioMetric(
        countRatio(outcomes, ({ promotedId }) => promotedId !== undefined),
      ),
      ...protocolMetrics(outcomes),
      load_ms: valueMetric(corpus.loadMs),
    });
  });

  it("recall: UserPromptSubmit on labelled positive and negative prompts", async () => {
    const { corpus } = requireWorlds(state);
    const cases: RecallCase[] = sampleEvenly(
      [
        ...state.fixtures.positives.map((item) => ({
          ...item,
          category: "positive",
          positive: true,
        })),
        ...state.fixtures.negatives.map((item) => ({ ...item, positive: false })),
      ],
      state.sample,
    );
    const observed = await mapPool(cases, HOOK_POOL_SIZE, async (item) => ({
      item,
      observation: await observe(
        state,
        corpus.world,
        corpus.owners,
        promptInvocation(projectDirs(corpus.world, item.project).root, item.prompt),
      ),
    }));
    const records = observed.map(({ item, observation }) => {
      const injected = observation.injected;
      const scored = item.positive
        ? {
            recall_at_5: recallAtK(injected, item.gold, RANK_CUTOFF),
            ndcg_at_5: ndcgAtK(injected, item.gold, RANK_CUTOFF),
            gold_hit: goldHit(injected, item.gold),
            precision: precisionOf(injected, item.gold),
          }
        : {};
      return hookCaseRecord(state, "recall", item.id, item, observation, {
        project: item.project,
        rows: injected.length,
        ...scored,
      });
    });
    appendRecords(records);
    for (const { item, observation } of observed.filter(({ item }) => item.positive)) {
      state.rootInjectedByPositive.set(item.id, observation.injected);
    }
    writeAggregate(state, "recall", {
      ...recallMetrics(observed),
      ...observationDistributions(observed.map(({ observation }) => observation)),
    });
    for (const split of SPLITS) {
      writeAggregate(
        state,
        `recall_${split}`,
        recallMetrics(observed.filter(({ item }) => item.split === split)),
      );
    }
    expect(records).toHaveLength(cases.length);
  });

  it("session_dedup: the same confirmation positive prompt twice in one session", async () => {
    const { corpus } = requireWorlds(state);
    const cases = sampleEvenly(
      state.fixtures.positives.filter((item) => item.split === CONFIRMATION_SPLIT),
      state.sample,
    );
    const observed = await mapPool(cases, HOOK_POOL_SIZE, async (item) => {
      const sessionId = randomUUID();
      const root = projectDirs(corpus.world, item.project).root;
      const first = await observe(
        state,
        corpus.world,
        corpus.owners,
        promptInvocation(root, item.prompt, sessionId),
      );
      const second = await observe(
        state,
        corpus.world,
        corpus.owners,
        promptInvocation(root, item.prompt, sessionId),
      );
      return { item, first, second };
    });
    const reinjected = ({ first, second }: (typeof observed)[number]) =>
      second.injected.filter((id) => first.injected.includes(id));
    appendRecords(
      observed.map((entry) =>
        hookCaseRecord(
          state,
          "session_dedup",
          entry.item.id,
          { ...entry.item, category: "positive" },
          entry.second,
          {
            project: entry.item.project,
            first_injected: entry.first.injected,
            reinjected: reinjected(entry),
          },
        ),
      ),
    );
    const injectedFirst = observed.filter(({ first }) => first.injected.length > 0);
    writeAggregate(state, "session_dedup", {
      first_injected_share: ratioMetric(
        countRatio(observed, ({ first }) => first.injected.length > 0),
      ),
      second_reinjects_none: ratioMetric(
        countRatio(injectedFirst, (entry) => reinjected(entry).length === 0),
      ),
      reinjected_rows: valueMetric(
        observed.reduce((sum, entry) => sum + reinjected(entry).length, 0),
      ),
      second_rows_mean: meanMetric(observed.map(({ second }) => second.injected.length)),
    });
    expect(observed).toHaveLength(cases.length);
  });

  it("session_start: startup, prompts, then compact in one session per project", async () => {
    const { corpus } = requireWorlds(state);
    const memoriesById = new Map(
      state.fixtures.corpus.memories.map((memory) => [memory.id, memory]),
    );
    const keys = sampleEvenly(projectKeys(state.fixtures), state.sample);
    const sessionStartIn = (root: string, source: string, sessionId: string) =>
      observe(state, corpus.world, corpus.owners, {
        event: "SessionStart",
        cwd: root,
        projectDir: root,
        fields: { source },
        sessionId,
      });
    const sessions = await mapPool(keys, HOOK_POOL_SIZE, async (key) => {
      const root = projectDirs(corpus.world, key).root;
      const sessionId = randomUUID();
      const startup = await sessionStartIn(root, SESSION_SOURCE, sessionId);
      const prompts = sampleEvenly(
        state.fixtures.positives.filter((item) => item.project === key),
        SESSION_EARLIER_PROMPTS,
      );
      const promptInjected: string[] = [];
      for (const item of prompts) {
        const prompt = await observe(
          state,
          corpus.world,
          corpus.owners,
          promptInvocation(root, item.prompt, sessionId),
        );
        promptInjected.push(...prompt.injected);
      }
      const compact = await sessionStartIn(root, COMPACT_SOURCE, sessionId);
      return {
        key,
        startup,
        compact,
        earlier: [...new Set([...startup.injected, ...promptInjected])],
      };
    });
    const visibleTo = (key: string, fixtureId: string) => {
      const memory = memoriesById.get(fixtureId);
      return memory !== undefined && (memory.scope === USER_SCOPE || memory.project === key);
    };
    const pinnedKind = (fixtureId: string) =>
      SESSION_PINNED_KINDS.has(memoriesById.get(fixtureId)?.kind ?? "");
    const eligiblePinned = (key: string) =>
      [...corpus.owners.keys()].filter((id) => visibleTo(key, id) && pinnedKind(id));
    const bySource = [
      {
        source: SESSION_SOURCE,
        entries: sessions.map(({ key, startup }) => ({ key, observed: startup })),
      },
      {
        source: COMPACT_SOURCE,
        entries: sessions.map(({ key, compact }) => ({ key, observed: compact })),
      },
    ];
    const records = bySource.flatMap(({ source, entries }) =>
      entries.map(({ key, observed }) =>
        hookCaseRecord(
          state,
          "session_start",
          `${key}#${source}`,
          { split: null, lang: null, category: source, gold: [] },
          observed,
          {
            project: key,
            source,
            rows: observed.injected.length,
            pinned_kind_rows: observed.injected.filter(pinnedKind).length,
            foreign_rows: observed.injected.filter((id) => !visibleTo(key, id)).length,
            eligible_pinned_rows: eligiblePinned(key).length,
            earlier_rows:
              source === COMPACT_SOURCE
                ? (sessions.find((session) => session.key === key)?.earlier ?? [])
                : [],
          },
        ),
      ),
    );
    appendRecords(records);
    for (const { source, entries } of bySource) {
      const rows = entries.flatMap(({ key, observed }) =>
        observed.injected.map((id) => ({ key, id })),
      );
      writeAggregate(state, `session_start_${source}`, {
        rows_mean: meanMetric(entries.map(({ observed }) => observed.injected.length)),
        pinned_kind_share: ratioMetric(countRatio(rows, ({ id }) => pinnedKind(id))),
        eligible_pinned_share_injected: ratioMetric({
          numerator: rows.filter(({ key, id }) => eligiblePinned(key).includes(id)).length,
          denominator: entries.reduce((sum, { key }) => sum + eligiblePinned(key).length, 0),
        }),
        foreign_row_share: ratioMetric(countRatio(rows, ({ key, id }) => !visibleTo(key, id))),
        ...(source === COMPACT_SOURCE
          ? {
              earlier_rows_reinjected: ratioMetric({
                numerator: sessions.reduce(
                  (sum, { earlier, compact }) =>
                    sum + earlier.filter((id) => compact.injected.includes(id)).length,
                  0,
                ),
                denominator: sessions.reduce((sum, { earlier }) => sum + earlier.length, 0),
              }),
              earlier_non_pinned_rows_reinjected: ratioMetric({
                numerator: sessions.reduce(
                  (sum, { earlier, compact }) =>
                    sum +
                    earlier.filter((id) => !pinnedKind(id) && compact.injected.includes(id)).length,
                  0,
                ),
                denominator: sessions.reduce(
                  (sum, { earlier }) => sum + earlier.filter((id) => !pinnedKind(id)).length,
                  0,
                ),
              }),
            }
          : {}),
        ...observationDistributions(entries.map(({ observed }) => observed)),
      });
    }
    expect(records).toHaveLength(keys.length * bySource.length);
  });

  it("pretool: PreToolUse on realistic Bash, Edit, Write and Read inputs", async () => {
    const { corpus } = requireWorlds(state);
    const cases: PretoolCase[] = sampleEvenly(state.fixtures.pretool, state.sample);
    const observed = await mapPool(cases, HOOK_POOL_SIZE, async (item) => {
      const root = projectDirs(corpus.world, item.project).root;
      return {
        item,
        observation: await observe(state, corpus.world, corpus.owners, {
          event: "PreToolUse",
          cwd: root,
          projectDir: root,
          fields: {
            tool_name: item.tool_name,
            tool_input: resolveToolInput(root, item.tool_input),
            tool_use_id: `toolu_eval_${randomUUID().replaceAll("-", "")}`,
          },
        }),
      };
    });
    const records = observed.map(({ item, observation }) =>
      hookCaseRecord(
        state,
        "pretool",
        item.id,
        {
          split: pretoolSplit(item.id),
          lang: null,
          category: item.gold.length === 0 ? "negative" : "positive",
          gold: item.gold,
        },
        observation,
        {
          project: item.project,
          tool_name: item.tool_name,
          gold_hit: item.gold.length > 0 && goldHit(observation.injected, item.gold),
          printed_gold_hit: item.gold.length > 0 && goldHit(observation.printed, item.gold),
        },
      ),
    );
    appendRecords(records);
    const negatives = observed.filter(({ item }) => item.gold.length === 0);
    const deliveredSummary = (subset: typeof observed) =>
      injectionSummary(
        subset.map(({ item, observation }) => ({
          injected: observation.injected,
          gold: item.gold,
        })),
      );
    const deliveredMetrics = (subset: typeof observed) => {
      const summary = deliveredSummary(subset);
      return {
        tool_recall_hit_delivered: ratioMetric(summary.goldHit),
        negative_false_injection_rate_delivered: ratioMetric(summary.falseInjection),
        precision_all_injected: ratioMetric(summary.precisionAll),
        f05_precision_all_vs_tool_recall: valueMetric(summary.f05),
        non_gold_rows_per_case: { value: summary.nonGoldRowsPerCase ?? null, n: subset.length },
      };
    };
    for (const split of PRETOOL_SPLITS) {
      writeAggregate(
        state,
        `pretool_${split}`,
        deliveredMetrics(observed.filter(({ item }) => pretoolSplit(item.id) === split)),
      );
    }
    writeAggregate(
      state,
      "pretool_read",
      deliveredMetrics(observed.filter(({ item }) => item.tool_name === "Read")),
    );
    writeAggregate(state, "pretool", {
      ...deliveredMetrics(observed),
      tool_recall_hit_stdout_only: ratioMetric(
        toolRecallHit(
          observed.map(({ item, observation }) => ({
            injected: observation.printed,
            gold: item.gold,
          })),
        ),
      ),
      negative_false_injection_rate_stdout_only: ratioMetric(
        falseInjectionRate(negatives.map(({ observation }) => observation.printed)),
      ),
      ...observationDistributions(observed.map(({ observation }) => observation)),
    });
    expect(records).toHaveLength(cases.length);
  });

  it("identity: the same positive prompts from a nested subdirectory", async () => {
    const { corpus } = requireWorlds(state);
    const memoriesById = new Map(
      state.fixtures.corpus.memories.map((memory) => [memory.id, memory]),
    );
    const cases = sampleEvenly(
      state.fixtures.positives
        .filter((item) => state.rootInjectedByPositive.has(item.id))
        .map((item) => ({
          item,
          projectGold: item.gold.filter((id) => memoriesById.get(id)?.scope === "project"),
        }))
        .filter(({ projectGold }) => projectGold.length > 0),
      state.sample,
    );
    const observed = await mapPool(cases, HOOK_POOL_SIZE, async ({ item, projectGold }) => ({
      item,
      projectGold,
      rootInjected: state.rootInjectedByPositive.get(item.id) ?? [],
      observation: await observe(
        state,
        corpus.world,
        corpus.owners,
        promptInvocation(projectDirs(corpus.world, item.project).nested, item.prompt),
      ),
    }));
    const records = observed.map(({ item, projectGold, rootInjected, observation }) =>
      hookCaseRecord(state, "identity", item.id, { ...item, category: "positive" }, observation, {
        project: item.project,
        project_gold: projectGold,
        root_injected: rootInjected,
        root_hit: goldHit(rootInjected, projectGold),
        subdir_hit: goldHit(observation.injected, projectGold),
      }),
    );
    appendRecords(records);
    const rootHits = observed.filter(({ projectGold, rootInjected }) =>
      goldHit(rootInjected, projectGold),
    );
    writeAggregate(state, "identity", {
      root_project_gold_hit_rate: ratioMetric({
        numerator: rootHits.length,
        denominator: observed.length,
      }),
      subdir_project_gold_hit_rate: ratioMetric(
        countRatio(observed, ({ projectGold, observation }) =>
          goldHit(observation.injected, projectGold),
        ),
      ),
      subdir_retains_root_hits: ratioMetric(
        countRatio(rootHits, ({ projectGold, observation }) =>
          goldHit(observation.injected, projectGold),
        ),
      ),
      ...observationDistributions(observed.map(({ observation }) => observation)),
    });
    expect(records).toHaveLength(cases.length);
    expect(records.length).toBeGreaterThan(0);
  });

  it("supersession: old then new value stored through the resolution oracle, then probed", async () => {
    const { supersession } = requireWorlds(state);
    for (const shard of supersession) {
      expect(sharedStoredIds(shard.stored.owners)).toEqual([]);
      expect(shard.stored.loaded).toHaveLength(shard.cases.length * 2);
    }
    const probes = supersession.flatMap((shard) => shard.cases.map((item) => ({ shard, item })));
    const observed = await mapPool(probes, HOOK_POOL_SIZE, async ({ shard, item }) => ({
      shard,
      item,
      observation: await observe(
        state,
        shard.stored.world,
        shard.stored.owners,
        promptInvocation(projectDirs(shard.stored.world, item.project).root, item.probe.prompt),
      ),
    }));
    const outcomeOf = (shard: SupersessionShard, fixtureId: string) =>
      shard.stored.loaded.find((entry) => entry.fixtureId === fixtureId)?.outcome;
    const oldIds = probes.map(({ item }) => item.old.id);
    const records = observed.map(({ shard, item, observation }) =>
      hookCaseRecord(
        state,
        "supersession",
        item.id,
        { split: null, lang: item.probe.lang, category: null, gold: [item.new.id] },
        observation,
        {
          project: item.project,
          conflict_key: item.conflict_key,
          current_value: item.current_value,
          ...prefixed("old", storeFields(outcomeOf(shard, item.old.id))),
          ...prefixed("new", storeFields(outcomeOf(shard, item.new.id))),
          old_injected: observation.injected.includes(item.old.id),
          new_injected: observation.injected.includes(item.new.id),
          stale_rows: observation.injected.filter((id) => oldIds.includes(id)).length,
        },
      ),
    );
    appendRecords(records);
    const newOutcomes = observed.flatMap(({ shard, item }) => {
      const outcome = outcomeOf(shard, item.new.id);
      return outcome === undefined ? [] : [outcome];
    });
    const newAction = (shard: SupersessionShard, item: SupersessionCase) =>
      outcomeOf(shard, item.new.id)?.action;
    writeAggregate(state, "supersession", {
      stale_exposure_rows: ratioMetric(
        staleExposure(
          observed.map(({ observation }) => observation.injected),
          oldIds,
        ),
      ),
      stale_case_rate: ratioMetric(
        countRatio(observed, ({ item, observation }) => observation.injected.includes(item.old.id)),
      ),
      current_value_delivered: ratioMetric(
        countRatio(observed, ({ item, observation }) => observation.injected.includes(item.new.id)),
      ),
      current_value_only: ratioMetric(
        countRatio(
          observed,
          ({ item, observation }) =>
            observation.injected.includes(item.new.id) &&
            !observation.injected.includes(item.old.id),
        ),
      ),
      new_value_lost: ratioMetric(
        countRatio(observed, ({ shard, item }) => newAction(shard, item) === NOOP_ACTION),
      ),
      new_value_superseded_old: ratioMetric(
        countRatio(
          observed,
          ({ shard, item }) =>
            newAction(shard, item) === SUPERSEDED_ACTION &&
            outcomeOf(shard, item.new.id)?.refId === outcomeOf(shard, item.old.id)?.id,
        ),
      ),
      new_value_promoted_to_user: ratioMetric(
        countRatio(newOutcomes, ({ promotedId }) => promotedId !== undefined),
      ),
      same_key_row_in_candidates: ratioMetric(
        countRatio(newOutcomes, ({ sameKeyCandidate }) => sameKeyCandidate),
      ),
      ...protocolMetrics(newOutcomes),
      ...observationDistributions(observed.map(({ observation }) => observation)),
    });
    expect(records).toHaveLength(probes.length);
  });

  it("contradictions: same key, different values in two projects", async () => {
    const { contradictions } = requireWorlds(state);
    const { cases, stored, readBack } = contradictions;
    expect(sharedStoredIds(stored.owners)).toEqual([]);
    expect(stored.loaded).toHaveLength(cases.length * 2);
    const outcomeOf = (fixtureId: string) =>
      stored.loaded.find((entry) => entry.fixtureId === fixtureId)?.outcome;
    const promotedEither = (item: ContradictionCase) =>
      outcomeOf(item.a.memory.id)?.promotedId !== undefined ||
      outcomeOf(item.b.memory.id)?.promotedId !== undefined ||
      readBack.get(item.b.memory.id)?.scope === USER_SCOPE;
    const ownValueReplaced = (item: ContradictionCase) => {
      const own = readBack.get(item.a.memory.id);
      return own === undefined || own.supersededBy !== null || own.state !== ACTIVE_STATE;
    };
    const caseRecords = cases.map((item) =>
      storeCaseRecord(state, "contradictions", item.id, {
        conflict_key: item.conflict_key,
        a_project: item.a.project,
        b_project: item.b.project,
        ...prefixed("a", storeFields(outcomeOf(item.a.memory.id))),
        ...prefixed("b", storeFields(outcomeOf(item.b.memory.id))),
        b_scope: readBack.get(item.b.memory.id)?.scope ?? null,
        a_state: readBack.get(item.a.memory.id)?.state ?? null,
        a_superseded: ownValueReplaced(item),
        promoted: promotedEither(item),
      }),
    );
    const probes = cases.flatMap((item) =>
      item.probes.map((probe, index) => ({
        item,
        probe,
        caseId: `${item.id}#${index}`,
        conflicting: [item.a.memory.id, item.b.memory.id].filter(
          (id) => id !== probe.expect_memory_id,
        ),
      })),
    );
    const observed = await mapPool(probes, HOOK_POOL_SIZE, async (entry) => ({
      ...entry,
      observation: await observe(
        state,
        stored.world,
        stored.owners,
        promptInvocation(projectDirs(stored.world, entry.probe.project).root, entry.probe.prompt),
      ),
    }));
    const probeRecords = observed.map(({ item, probe, caseId, conflicting, observation }) =>
      hookCaseRecord(
        state,
        "contradictions",
        caseId,
        { split: null, lang: probe.lang, category: null, gold: [probe.expect_memory_id] },
        observation,
        {
          project: probe.project,
          conflict_key: item.conflict_key,
          conflicting,
          own_delivered: observation.injected.includes(probe.expect_memory_id),
          leaked: conflicting.some((id) => observation.injected.includes(id)),
        },
      ),
    );
    appendRecords([...caseRecords, ...probeRecords]);
    writeAggregate(state, "contradictions", {
      contradiction_leak: ratioMetric(
        contradictionLeak(
          observed.map(({ conflicting, observation }) => ({
            injected: observation.injected,
            conflicting,
          })),
        ),
      ),
      co_injection: ratioMetric(
        countRatio(
          observed,
          ({ probe, conflicting, observation }) =>
            observation.injected.includes(probe.expect_memory_id) &&
            conflicting.some((id) => observation.injected.includes(id)),
        ),
      ),
      own_value_delivered: ratioMetric(
        countRatio(observed, ({ probe, observation }) =>
          observation.injected.includes(probe.expect_memory_id),
        ),
      ),
      cross_project_promotion: ratioMetric(countRatio(cases, promotedEither)),
      own_value_superseded_by_other_project: ratioMetric(countRatio(cases, ownValueReplaced)),
      ...protocolMetrics(stored.loaded.map((entry) => entry.outcome)),
      ...observationDistributions(observed.map(({ observation }) => observation)),
    });
    expect(probeRecords).toHaveLength(probes.length);
  });

  it("redaction: each synthetic secret stored through memory_store and read back", () => {
    const { redaction } = requireWorlds(state);
    const leakedFields = ({ sample, readBack }: RedactionOutcome) =>
      (["title", "abstract", "content"] as const).filter((field) =>
        readBack[field].includes(sample.secret),
      );
    appendRecords(
      redaction.map((entry) =>
        storeCaseRecord(state, "redaction", entry.sample.name, {
          ...storeFields(entry.outcome),
          leaked: leakedFields(entry).length > 0,
          leaked_fields: leakedFields(entry),
        }),
      ),
    );
    writeAggregate(state, "redaction", {
      secret_leak_rate: ratioMetric(
        countRatio(redaction, (entry) => leakedFields(entry).length > 0),
      ),
    });
    expect(redaction).toHaveLength(sampleEvenly(state.fixtures.redaction, state.sample).length);
  });

  it("degraded_control: two unrelated stores without the embedding model", () => {
    const { degraded } = requireWorlds(state);
    const distinctRows = new Set([degraded.first.id, degraded.second.id]).size;
    const preserved = degraded.secondReadBack.content === DEGRADED_SECOND.content;
    appendRecords([
      storeCaseRecord(state, "degraded_control", "commit-hygiene-then-tests", {
        ...prefixed("first", storeFields(degraded.first)),
        ...prefixed("second", storeFields(degraded.second)),
        distinct_rows: distinctRows,
        expected_rows: 2,
        second_content_preserved: preserved,
      }),
    ]);
    writeAggregate(state, "degraded_control", {
      distinct_rows: valueMetric(distinctRows),
      second_content_preserved: ratioMetric({ numerator: preserved ? 1 : 0, denominator: 1 }),
    });
    expect(degraded.secondReadBack.id).toBe(degraded.second.id);
  });

  it("lifecycle: receipts demote unused memories, verdicts move them, nothing is deleted", async () => {
    const world = await newWorld(
      state,
      [LIFECYCLE_RECEIPT_PROJECT, LIFECYCLE_SILENT_PROJECT],
      testModelCacheDir,
    );
    const writer = new WorldWriter(state.plugin, world);
    const receiptRoot = projectDirs(world, LIFECYCLE_RECEIPT_PROJECT).root;
    const silentRoot = projectDirs(world, LIFECYCLE_SILENT_PROJECT).root;
    try {
      const unused = (await writer.store(receiptRoot, LIFECYCLE_UNUSED)).id;
      const receipted = (await writer.store(receiptRoot, LIFECYCLE_RECEIPTED)).id;
      const silent = (await writer.store(silentRoot, LIFECYCLE_SILENT)).id;
      const owners = new Map([
        ["unused", unused],
        ["receipted", receipted],
        ["silent", silent],
      ]);
      const sessionStart = (root: string, sessionId = randomUUID()) =>
        observe(state, world, owners, {
          event: "SessionStart",
          cwd: root,
          projectDir: root,
          fields: { source: SESSION_SOURCE },
          sessionId,
        });
      const feedback = async (
        root: string,
        sessionId: string,
        ids: readonly string[],
        verdict: string,
      ) => {
        await writer.feedback(root, ids, verdict);
        return observe(state, world, owners, {
          event: "PostToolUse",
          cwd: root,
          projectDir: root,
          fields: {
            tool_name: FEEDBACK_TOOL_NAME,
            tool_input: { ids: [...ids], verdict },
            tool_response: {},
          },
          sessionId,
        });
      };
      const stateOf = async (root: string, id: string) => (await writer.get(root, id)).state;
      const rowCounts = [memoryRowCount(world)];

      const receiptSessions: Observation[] = [];
      const silentSessions: Observation[] = [];
      for (let session = 1; session <= DEMOTION_MIN_RECEIPTED_INJECTIONS; session += 1) {
        const sessionId = randomUUID();
        receiptSessions.push(await sessionStart(receiptRoot, sessionId));
        receiptSessions.push(await feedback(receiptRoot, sessionId, [receipted], "used"));
        silentSessions.push(await sessionStart(silentRoot));
      }
      const afterReceipts = {
        unused: await stateOf(receiptRoot, unused),
        receipted: await stateOf(receiptRoot, receipted),
        silent: await stateOf(silentRoot, silent),
      };
      const probeAfterDemotion = await sessionStart(receiptRoot);
      rowCounts.push(memoryRowCount(world));

      await feedback(silentRoot, randomUUID(), [silent], "wrong");
      const silentAfterWrong = await stateOf(silentRoot, silent);
      const probeAfterWrong = await sessionStart(silentRoot);
      rowCounts.push(memoryRowCount(world));

      await feedback(receiptRoot, randomUUID(), [unused], "used");
      const unusedAfterUsed = await stateOf(receiptRoot, unused);
      const probeAfterReactivation = await sessionStart(receiptRoot);
      rowCounts.push(memoryRowCount(world));

      const unusedInjections = receiptSessions.filter((observed) =>
        observed.injected.includes("unused"),
      ).length;
      const receiptsPrintedNothing = receiptSessions
        .filter((observed) => observed.event === "PostToolUse")
        .every((observed) => observed.run.registered && observed.run.stdout === "");
      const outcomes = {
        unused_injected_in_receipt_sessions: unusedInjections === DEMOTION_MIN_RECEIPTED_INJECTIONS,
        receipt_hook_registered_and_silent: receiptsPrintedNothing,
        unused_demoted_after_receipts: afterReceipts.unused === "hypothesis",
        unused_left_recall: !probeAfterDemotion.injected.includes("unused"),
        receipt_backed_stays_active: afterReceipts.receipted === "active",
        unreceipted_stays_active:
          afterReceipts.silent === "active" &&
          silentSessions.every((observed) => observed.injected.includes("silent")),
        wrong_demotes_immediately: silentAfterWrong === "hypothesis",
        wrong_left_recall: !probeAfterWrong.injected.includes("silent"),
        used_reactivates: unusedAfterUsed === "active",
        reactivated_recalled_again: probeAfterReactivation.injected.includes("unused"),
        rows_constant: rowCounts.every((count) => count === owners.size),
      };
      appendRecords([
        {
          ...recordBase(state),
          kind: "case",
          suite: "lifecycle",
          case_id: "receipts-wrong-used",
          event: null,
          after_receipts: afterReceipts,
          silent_after_wrong: silentAfterWrong,
          unused_after_used: unusedAfterUsed,
          probe_after_demotion: probeAfterDemotion.injected,
          probe_after_wrong: probeAfterWrong.injected,
          probe_after_reactivation: probeAfterReactivation.injected,
          row_counts: rowCounts,
          ...outcomes,
        },
      ]);
      writeAggregate(
        state,
        "lifecycle",
        Object.fromEntries(
          Object.entries(outcomes).map(([name, holds]) => [
            name,
            ratioMetric({ numerator: holds ? 1 : 0, denominator: 1 }),
          ]),
        ),
      );
      expect(outcomes).toEqual(
        Object.fromEntries(Object.keys(outcomes).map((name) => [name, true])),
      );
    } finally {
      await writer.close();
    }
  });

  it("capture_cues: every labelled cue as a UserPromptSubmit, typed by the user or by the harness", async () => {
    const world = await newWorld(state, [CAPTURE_PROJECT], testModelCacheDir);
    const root = projectDirs(world, CAPTURE_PROJECT).root;
    const cues = sampleEvenly(state.fixtures.cues, state.sample);
    const observed: CueObservation[] = await mapPool(cues, HOOK_POOL_SIZE, async (cue) => {
      const observation = await observe(state, world, new Map(), promptInvocation(root, cue.text));
      return { cue, detected: deliveredCue(observation.delivery.text), observation };
    });
    appendRecords(
      observed.map(({ cue, detected, observation }) =>
        hookCaseRecord(
          state,
          "capture_cues",
          cue.id,
          { split: null, lang: cue.lang, category: `${cue.origin}:${cue.label}`, gold: [] },
          observation,
          { origin: cue.origin, label: cue.label, detected: detected ?? null },
        ),
      ),
    );
    writeAggregate(state, "capture_cues", cueMetrics(observed));
    expect(
      observed
        .filter(({ cue, detected }) => cue.origin === "harness" && detected !== undefined)
        .map(({ cue }) => cue.id),
    ).toEqual([]);
  });

  it("checkpoint: corrections, receipts, resolutions and stop_hook_active at the host boundary", async () => {
    const world = await newWorld(state, [CHECKPOINT_PROJECT], testModelCacheDir);
    const writer = new WorldWriter(state.plugin, world);
    const root = projectDirs(world, CHECKPOINT_PROJECT).root;
    const runs: HookRun[] = [];
    const latencyByHook = new Map<string, number[]>();
    const invoke = async (hook: string, invocation: HookInvocation) => {
      const run = await runHook(state.plugin, world, invocation);
      runs.push(run);
      if (run.registered) {
        state.latencies.push({ event: invocation.event, ms: run.latencyMs });
        latencyByHook.set(hook, [...(latencyByHook.get(hook) ?? []), run.latencyMs]);
      }
      return run;
    };
    const at = (sessionId: string, event: HookInvocation["event"], fields: ResultRecord) => ({
      event,
      cwd: root,
      projectDir: root,
      fields,
      sessionId,
    });
    const prompt = (sessionId: string, text: string) =>
      invoke("prompt", at(sessionId, "UserPromptSubmit", { prompt: text }));
    const stop = async (sessionId: string, active: boolean) => {
      const fields = { stop_hook_active: active, last_assistant_message: "Done." };
      return stopDelivery(await invoke("stop", at(sessionId, "Stop", fields)));
    };
    const bash = (sessionId: string, command: string, passed: boolean) =>
      passed
        ? invoke(
            "post_tool_bash",
            at(sessionId, "PostToolUse", {
              tool_name: "Bash",
              tool_input: { command },
              tool_response: { stdout: "", stderr: "", interrupted: false },
            }),
          )
        : invoke(
            "post_tool_failure_bash",
            at(sessionId, "PostToolUseFailure", {
              tool_name: "Bash",
              tool_input: { command },
              error: "Exit code 1\n1 failed",
            }),
          );
    try {
      const corrected = randomUUID();
      const correctionPrompt = await prompt(corrected, CHECKPOINT_CORRECTION);
      const correctedFirst = await stop(corrected, false);
      const correctedSecond = await stop(corrected, false);

      const stored = randomUUID();
      await prompt(stored, CHECKPOINT_CORRECTION);
      const lesson = await writer.store(root, CHECKPOINT_LESSON);
      await invoke(
        "post_tool_store",
        at(stored, "PostToolUse", {
          tool_name: STORE_TOOL_NAME,
          tool_input: { ...CHECKPOINT_LESSON },
          tool_response: [{ type: "text", text: JSON.stringify({ id: lesson.id }) }],
        }),
      );
      const storedStop = await stop(stored, false);

      const neutral = randomUUID();
      await prompt(neutral, CHECKPOINT_NEUTRAL);
      const neutralStop = await stop(neutral, false);

      const resolved = randomUUID();
      await bash(resolved, CHECKPOINT_FAILING_COMMAND, false);
      await bash(resolved, CHECKPOINT_FAILING_COMMAND, true);
      const resolvedStop = await stop(resolved, false);

      const continuing = randomUUID();
      await prompt(continuing, CHECKPOINT_CORRECTION);
      const continuingStop = await stop(continuing, true);

      const steady = randomUUID();
      for (let index = 0; index < CHECKPOINT_STEADY_RUNS; index += 1) {
        await bash(steady, CHECKPOINT_STEADY_COMMAND, true);
        await stop(steady, false);
      }

      const correctionContext = deliveredContext("UserPromptSubmit", correctionPrompt).text;
      const outcomes = {
        all_hooks_registered: runs.every((run) => run.registered && run.exitCode === 0),
        correction_line_delivered: correctionContext.split("\n").includes(CORRECTION_CUE_LINE),
        correction_checkpoint_once:
          correctedFirst.additionalContext?.startsWith(
            "Memory checkpoint: you were corrected about",
          ) === true && correctedSecond.additionalContext === undefined,
        never_blocks: [
          correctedFirst,
          correctedSecond,
          storedStop,
          neutralStop,
          resolvedStop,
          continuingStop,
        ].every((delivery) => delivery.decision === undefined),
        store_receipt_silences_checkpoint: storedStop.additionalContext === undefined,
        neutral_turn_no_checkpoint: neutralStop.additionalContext === undefined,
        failed_then_passed_resolution_checkpoint:
          resolvedStop.additionalContext?.includes("you resolved a failing `pytest`") === true,
        stop_hook_active_silent: continuingStop.additionalContext === undefined,
      };
      appendRecords([
        {
          ...recordBase(state),
          kind: "case",
          suite: "checkpoint",
          case_id: "capture-moments",
          event: null,
          corrected_first: correctedFirst.additionalContext ?? null,
          corrected_second: correctedSecond.additionalContext ?? null,
          stored_stop: storedStop.additionalContext ?? null,
          neutral_stop: neutralStop.additionalContext ?? null,
          resolved_stop: resolvedStop.additionalContext ?? null,
          continuing_stop: continuingStop.additionalContext ?? null,
          ...outcomes,
        },
      ]);
      writeAggregate(state, "checkpoint", {
        ...Object.fromEntries(
          Object.entries(outcomes).map(([name, holds]) => [
            name,
            ratioMetric({ numerator: holds ? 1 : 0, denominator: 1 }),
          ]),
        ),
        ...Object.fromEntries(
          [...latencyByHook].flatMap(([hook, values]) =>
            Object.entries(distributionMetrics(`${hook}_ms`, values)),
          ),
        ),
      });
      expect(outcomes).toEqual(
        Object.fromEntries(Object.keys(outcomes).map((name) => [name, true])),
      );
    } finally {
      await writer.close();
    }
  });
});
