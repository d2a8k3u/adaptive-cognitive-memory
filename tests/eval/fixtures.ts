import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { conflictKeyProblem } from "../../src/authoring";
import { failureSignature } from "../../src/failure";
import { commandHead } from "../../src/keys";
import {
  type JsonRecord,
  optionalString,
  requireArray,
  requireEnum,
  requireRecord,
  requireString,
  requireStringArray,
} from "./narrow";

export const LANGS = ["en", "cs"] as const;
export const SPLITS = ["calibration", "confirmation"] as const;
export const PRETOOL_SPLITS = ["calibration", "heldout"] as const;
export const DISTRACTOR_ID_PREFIX = "dx-";
const SECRET_PLACEHOLDER = "{secret}";
export const SCOPES = ["project", "user"] as const;
export const MEMORY_TYPES = ["semantic", "procedural", "pattern", "episodic"] as const;
export const KINDS = ["constraint", "preference", "fact", "procedure", "belief"] as const;
export const CARDINALITIES = ["single", "multi"] as const;
export const NEGATIVE_CATEGORIES = [
  "content_free",
  "off_topic",
  "vague_followup",
  "other_project",
] as const;
export const TOOL_NAMES = ["Bash", "Edit", "Write", "Read"] as const;
export const ERROR_NEGATIVE_CATEGORIES = [
  "tdd_red",
  "lint",
  "generic_exit",
  "interrupt",
  "repeat_head",
  "head_only",
  "other_project",
  "secret",
] as const;
export const ERROR_POSITIVE_CATEGORIES = ["head_not_used_up"] as const;
const ERROR_CATEGORIES = [...ERROR_NEGATIVE_CATEGORIES, ...ERROR_POSITIVE_CATEGORIES] as const;
export const CUE_ORIGINS = ["human", "harness"] as const;
export const CUE_LABELS = ["correction", "remember", "neutral"] as const;
export const HARNESS_MARKERS = [
  "<agent-message",
  "<task-notification",
  "<system-reminder",
  "[Subagent hand-back]",
] as const;

export type Lang = (typeof LANGS)[number];
export type Split = (typeof SPLITS)[number];
export type PretoolSplit = (typeof PRETOOL_SPLITS)[number];
export type Scope = (typeof SCOPES)[number];
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type Kind = (typeof KINDS)[number];
export type Cardinality = (typeof CARDINALITIES)[number];
export type NegativeCategory = (typeof NEGATIVE_CATEGORIES)[number];
export type ToolName = (typeof TOOL_NAMES)[number];
export type ErrorNegativeCategory = (typeof ERROR_NEGATIVE_CATEGORIES)[number];
export type ErrorCaseCategory = (typeof ERROR_CATEGORIES)[number];
export type CueOrigin = (typeof CUE_ORIGINS)[number];
export type CueLabel = (typeof CUE_LABELS)[number];

export interface ProjectFixture {
  readonly key: string;
  readonly description: string;
}

export interface FixtureMemory {
  readonly id: string;
  readonly scope: Scope;
  readonly project: string | undefined;
  readonly type: MemoryType;
  readonly kind: Kind;
  readonly title: string;
  readonly content: string;
  readonly conflict_key: string;
  readonly cardinality: Cardinality;
  readonly value_text: string;
  readonly keywords: string;
  readonly anchors: readonly string[];
}

export interface Corpus {
  readonly projects: readonly ProjectFixture[];
  readonly memories: readonly FixtureMemory[];
}

export interface PositivePrompt {
  readonly id: string;
  readonly project: string;
  readonly lang: Lang;
  readonly prompt: string;
  readonly gold: readonly string[];
  readonly family: string;
  readonly split: Split;
}

export interface NegativePrompt {
  readonly id: string;
  readonly project: string;
  readonly lang: Lang;
  readonly category: NegativeCategory;
  readonly prompt: string;
  readonly gold: readonly string[];
  readonly family: string;
  readonly split: Split;
}

export interface PretoolCase {
  readonly id: string;
  readonly project: string;
  readonly tool_name: ToolName;
  readonly tool_input: Readonly<Record<string, string>>;
  readonly gold: readonly string[];
}

export interface ErrorCase {
  readonly id: string;
  readonly project: string;
  readonly session: string;
  readonly tool_input: Readonly<Record<string, string>>;
  readonly error: string;
  readonly is_interrupt: boolean;
  readonly category: ErrorCaseCategory | null;
  readonly gold: readonly string[];
}

export interface Probe {
  readonly lang: Lang;
  readonly prompt: string;
}

export interface SupersessionCase {
  readonly id: string;
  readonly project: string;
  readonly conflict_key: string;
  readonly old: FixtureMemory;
  readonly new: FixtureMemory;
  readonly probe: Probe;
  readonly current_value: string;
}

export interface ContradictionSide {
  readonly project: string;
  readonly memory: FixtureMemory;
}

export interface ContradictionProbe {
  readonly project: string;
  readonly lang: Lang;
  readonly prompt: string;
  readonly expect_memory_id: string;
}

export interface ContradictionCase {
  readonly id: string;
  readonly conflict_key: string;
  readonly a: ContradictionSide;
  readonly b: ContradictionSide;
  readonly probes: readonly ContradictionProbe[];
}

export interface CaptureCue {
  readonly id: string;
  readonly lang: Lang;
  readonly origin: CueOrigin;
  readonly label: CueLabel;
  readonly text: string;
}

export interface RedactionSample {
  readonly name: string;
  readonly text: string;
  readonly secret: string;
}

export interface Fixtures {
  readonly corpus: Corpus;
  readonly positives: readonly PositivePrompt[];
  readonly negatives: readonly NegativePrompt[];
  readonly pretool: readonly PretoolCase[];
  readonly supersession: readonly SupersessionCase[];
  readonly contradictions: readonly ContradictionCase[];
  readonly cues: readonly CaptureCue[];
  readonly redaction: readonly RedactionSample[];
}

export const FIXTURE_FILES = [
  "corpus.json",
  "prompts.json",
  "pretool.json",
  "supersession.json",
  "contradictions.json",
  "capture-cues.json",
  "redaction.json",
  "errors.json",
] as const;

type FixtureFile = (typeof FIXTURE_FILES)[number];

function records(value: unknown, path: string): JsonRecord[] {
  return requireArray(value, path).map((item, index) => requireRecord(item, `${path}[${index}]`));
}

function parseMemory(record: JsonRecord, path: string): FixtureMemory {
  return {
    id: requireString(record, "id", path),
    scope: requireEnum(record, "scope", SCOPES, path),
    project: optionalString(record, "project", path),
    type: requireEnum(record, "type", MEMORY_TYPES, path),
    kind: requireEnum(record, "kind", KINDS, path),
    title: requireString(record, "title", path),
    content: requireString(record, "content", path),
    conflict_key: requireString(record, "conflict_key", path),
    cardinality: requireEnum(record, "cardinality", CARDINALITIES, path),
    value_text: requireString(record, "value_text", path),
    keywords: requireString(record, "keywords", path),
    anchors: requireStringArray(record, "anchors", path),
  };
}

function parseCorpus(root: JsonRecord): Corpus {
  return {
    projects: records(root.projects, "corpus.projects").map((record, index) => ({
      key: requireString(record, "key", `corpus.projects[${index}]`),
      description: requireString(record, "description", `corpus.projects[${index}]`),
    })),
    memories: records(root.memories, "corpus.memories").map((record, index) =>
      parseMemory(record, `corpus.memories[${index}]`),
    ),
  };
}

function parsePositive(record: JsonRecord, path: string): PositivePrompt {
  return {
    id: requireString(record, "id", path),
    project: requireString(record, "project", path),
    lang: requireEnum(record, "lang", LANGS, path),
    prompt: requireString(record, "prompt", path),
    gold: requireStringArray(record, "gold", path),
    family: requireString(record, "family", path),
    split: requireEnum(record, "split", SPLITS, path),
  };
}

function parseNegative(record: JsonRecord, path: string): NegativePrompt {
  return {
    id: requireString(record, "id", path),
    project: requireString(record, "project", path),
    lang: requireEnum(record, "lang", LANGS, path),
    category: requireEnum(record, "category", NEGATIVE_CATEGORIES, path),
    prompt: requireString(record, "prompt", path),
    gold: requireStringArray(record, "gold", path),
    family: requireString(record, "family", path),
    split: requireEnum(record, "split", SPLITS, path),
  };
}

function parseToolInput(value: unknown, path: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(requireRecord(value, path)).map(([key, field]) => {
      if (typeof field !== "string") {
        throw new TypeError(`${path}.${key} must be a string`);
      }
      return [key, field];
    }),
  );
}

function parsePretool(record: JsonRecord, path: string): PretoolCase {
  return {
    id: requireString(record, "id", path),
    project: requireString(record, "project", path),
    tool_name: requireEnum(record, "tool_name", TOOL_NAMES, path),
    tool_input: parseToolInput(record.tool_input, `${path}.tool_input`),
    gold: requireStringArray(record, "gold", path),
  };
}

function requireBoolean(record: JsonRecord, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new TypeError(`${path}.${key} must be a boolean`);
  }
  return value;
}

function parseErrorCase(record: JsonRecord, path: string): ErrorCase {
  return {
    id: requireString(record, "id", path),
    project: requireString(record, "project", path),
    session: requireString(record, "session", path),
    tool_input: parseToolInput(record.tool_input, `${path}.tool_input`),
    error: requireString(record, "error", path),
    is_interrupt: requireBoolean(record, "is_interrupt", path),
    category:
      record.category === null ? null : requireEnum(record, "category", ERROR_CATEGORIES, path),
    gold: requireStringArray(record, "gold", path),
  };
}

function parseProbe(value: unknown, path: string): Probe {
  const record = requireRecord(value, path);
  return {
    lang: requireEnum(record, "lang", LANGS, path),
    prompt: requireString(record, "prompt", path),
  };
}

function parseSupersession(record: JsonRecord, path: string): SupersessionCase {
  return {
    id: requireString(record, "id", path),
    project: requireString(record, "project", path),
    conflict_key: requireString(record, "conflict_key", path),
    old: parseMemory(requireRecord(record.old, `${path}.old`), `${path}.old`),
    new: parseMemory(requireRecord(record.new, `${path}.new`), `${path}.new`),
    probe: parseProbe(record.probe, `${path}.probe`),
    current_value: requireString(record, "current_value", path),
  };
}

function parseSide(value: unknown, path: string): ContradictionSide {
  const record = requireRecord(value, path);
  return {
    project: requireString(record, "project", path),
    memory: parseMemory(requireRecord(record.memory, `${path}.memory`), `${path}.memory`),
  };
}

function parseContradiction(record: JsonRecord, path: string): ContradictionCase {
  return {
    id: requireString(record, "id", path),
    conflict_key: requireString(record, "conflict_key", path),
    a: parseSide(record.a, `${path}.a`),
    b: parseSide(record.b, `${path}.b`),
    probes: records(record.probes, `${path}.probes`).map((probe, index) => ({
      project: requireString(probe, "project", `${path}.probes[${index}]`),
      lang: requireEnum(probe, "lang", LANGS, `${path}.probes[${index}]`),
      prompt: requireString(probe, "prompt", `${path}.probes[${index}]`),
      expect_memory_id: requireString(probe, "expect_memory_id", `${path}.probes[${index}]`),
    })),
  };
}

function parseCue(record: JsonRecord, path: string): CaptureCue {
  return {
    id: requireString(record, "id", path),
    lang: requireEnum(record, "lang", LANGS, path),
    origin: requireEnum(record, "origin", CUE_ORIGINS, path),
    label: requireEnum(record, "label", CUE_LABELS, path),
    text: requireString(record, "text", path),
  };
}

export function parseRedaction(record: JsonRecord, path: string): RedactionSample {
  const secret = requireStringArray(record, "secret_parts", path).join("");
  const template = requireStringArray(record, "text_parts", path).join("");
  if (template.split(SECRET_PLACEHOLDER).length !== 2) {
    throw new TypeError(`${path}.text_parts must hold exactly one ${SECRET_PLACEHOLDER}`);
  }
  return {
    name: requireString(record, "name", path),
    text: template.replace(SECRET_PLACEHOLDER, secret),
    secret,
  };
}

function readFixture(dir: string, file: FixtureFile): unknown {
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

export function redactionSamples(dir: string): RedactionSample[] {
  return records(readFixture(dir, "redaction.json"), "redaction").map((record, index) =>
    parseRedaction(record, `redaction[${index}]`),
  );
}

export function errorCases(dir: string): ErrorCase[] {
  return records(readFixture(dir, "errors.json"), "errors").map((record, index) =>
    parseErrorCase(record, `errors[${index}]`),
  );
}

export function loadFixtures(dir: string): Fixtures {
  const prompts = requireRecord(readFixture(dir, "prompts.json"), "prompts");
  return {
    corpus: parseCorpus(requireRecord(readFixture(dir, "corpus.json"), "corpus")),
    positives: records(prompts.positives, "prompts.positives").map((record, index) =>
      parsePositive(record, `prompts.positives[${index}]`),
    ),
    negatives: records(prompts.negatives, "prompts.negatives").map((record, index) =>
      parseNegative(record, `prompts.negatives[${index}]`),
    ),
    pretool: records(readFixture(dir, "pretool.json"), "pretool").map((record, index) =>
      parsePretool(record, `pretool[${index}]`),
    ),
    supersession: records(readFixture(dir, "supersession.json"), "supersession").map(
      (record, index) => parseSupersession(record, `supersession[${index}]`),
    ),
    contradictions: records(readFixture(dir, "contradictions.json"), "contradictions").map(
      (record, index) => parseContradiction(record, `contradictions[${index}]`),
    ),
    cues: records(readFixture(dir, "capture-cues.json"), "capture-cues").map((record, index) =>
      parseCue(record, `capture-cues[${index}]`),
    ),
    redaction: redactionSamples(dir),
  };
}

export function fixtureDigest(dir: string): string {
  const hash = createHash("sha256");
  for (const file of [...FIXTURE_FILES].sort()) {
    hash.update(file);
    hash.update(readFileSync(join(dir, file)));
  }
  return hash.digest("hex");
}

export const MINIMUM_SIZES = {
  memories: 100,
  positives: 200,
  negatives: 200,
  czechShare: 0.3,
  pretool: 60,
  pretoolNegatives: 15,
  pretoolReadNegatives: 35,
  errorNegatives: 35,
  supersession: 100,
  contradictions: 20,
  cues: 150,
  redaction: 16,
} as const;

const REQUIRED_TOOL_FIELDS: Readonly<Record<ToolName, readonly string[]>> = {
  Bash: ["command"],
  Edit: ["file_path", "old_string", "new_string"],
  Write: ["file_path", "content"],
  Read: ["file_path"],
};

interface SplitAssigned {
  readonly id: string;
  readonly split: Split;
}

interface PromptText extends SplitAssigned {
  readonly prompt: string;
}

const CONFIRMATION_ID = /-conf-\d+$/;

export function promptSplit(promptId: string): Split {
  return CONFIRMATION_ID.test(promptId) ? "confirmation" : "calibration";
}

const CASE_NUMBER = /-(\d+)$/;

export function pretoolSplit(caseId: string): PretoolSplit {
  const caseNumber = CASE_NUMBER.exec(caseId)?.[1];
  if (caseNumber === undefined) {
    throw new Error(`pretool case ${caseId} has no case number to split on`);
  }
  return Number(caseNumber) % 2 === 1 ? "calibration" : "heldout";
}

function idsOf(items: readonly { readonly id: string }[]): string[] {
  return items.map((item) => item.id);
}

function duplicateProblems(section: string, ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      problems.push(`${section}: duplicate id ${id}`);
    }
    seen.add(id);
  }
  return problems;
}

function conflictKeyProblems(memory: FixtureMemory): string[] {
  const problem = conflictKeyProblem(memory.conflict_key);
  return problem === undefined ? [] : [`${memory.id}: ${problem.message}`];
}

function scopeProblems(memory: FixtureMemory, projectKeys: ReadonlySet<string>): string[] {
  if (memory.scope === "user") {
    return memory.project === undefined
      ? []
      : [`${memory.id}: user-scope memory must not name a project`];
  }
  if (memory.project === undefined || !projectKeys.has(memory.project)) {
    return [`${memory.id}: project-scope memory names unknown project ${memory.project}`];
  }
  return [];
}

function memoryProblems(memory: FixtureMemory, projectKeys: ReadonlySet<string>): string[] {
  return [...conflictKeyProblems(memory), ...scopeProblems(memory, projectKeys)];
}

function projectProblems(caseId: string, project: string, keys: ReadonlySet<string>): string[] {
  return keys.has(project) ? [] : [`${caseId}: unknown project ${project}`];
}

function goldProblems(
  caseId: string,
  project: string,
  gold: readonly string[],
  memoriesById: ReadonlyMap<string, FixtureMemory>,
): string[] {
  return gold.flatMap((goldId) => {
    const memory = memoriesById.get(goldId);
    if (memory === undefined) {
      return [`${caseId}: gold names unknown memory ${goldId}`];
    }
    if (memory.scope === "project" && memory.project !== project) {
      return [`${caseId}: gold ${goldId} belongs to project ${memory.project}, not ${project}`];
    }
    return [];
  });
}

function splitProblems(items: readonly SplitAssigned[]): string[] {
  return items.flatMap((item) => {
    const rule = promptSplit(item.id);
    return item.split === rule
      ? []
      : [`${item.id}: split ${item.split} breaks the rule, expected ${rule}`];
  });
}

function confirmationCoverageProblems(positives: readonly PositivePrompt[]): string[] {
  const families = [...new Set(positives.map((item) => item.family))];
  return families.flatMap((family) =>
    LANGS.filter(
      (lang) =>
        !positives.some(
          (item) => item.family === family && item.lang === lang && item.split === "confirmation",
        ),
    ).map((lang) => `${family}: no ${lang} confirmation positive`),
  );
}

function normalisedPrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase();
}

function confirmationLeakProblems(prompts: readonly PromptText[]): string[] {
  const calibrationPrompts = new Set(
    prompts
      .filter((item) => item.split === "calibration")
      .map((item) => normalisedPrompt(item.prompt)),
  );
  return prompts
    .filter(
      (item) =>
        item.split === "confirmation" && calibrationPrompts.has(normalisedPrompt(item.prompt)),
    )
    .map((item) => `${item.id}: confirmation prompt repeats a calibration prompt`);
}

function isDistractor(memoryId: string): boolean {
  return memoryId.startsWith(DISTRACTOR_ID_PREFIX);
}

function distractorProblems(fixtures: Fixtures): string[] {
  const memories = fixtures.corpus.memories;
  const memoriesByKey = new Map<string, number>();
  for (const memory of memories) {
    memoriesByKey.set(memory.conflict_key, (memoriesByKey.get(memory.conflict_key) ?? 0) + 1);
  }
  const goldCases = [...fixtures.positives, ...fixtures.pretool];
  return [
    ...memories
      .filter((memory) => isDistractor(memory.id))
      .flatMap((memory) => [
        ...(memory.anchors.length === 0 ? [] : [`${memory.id}: distractor must not carry anchors`]),
        ...((memoriesByKey.get(memory.conflict_key) ?? 0) > 1
          ? [`${memory.id}: distractor shares conflict key ${memory.conflict_key}`]
          : []),
      ]),
    ...goldCases.flatMap((item) =>
      item.gold.filter(isDistractor).map((goldId) => `${item.id}: gold names distractor ${goldId}`),
    ),
  ];
}

function positiveProblems(
  fixtures: Fixtures,
  keys: ReadonlySet<string>,
  memoriesById: ReadonlyMap<string, FixtureMemory>,
): string[] {
  const positives = fixtures.positives;
  return [
    ...duplicateProblems("positives", idsOf(positives)),
    ...positives.flatMap((item) => [
      ...projectProblems(item.id, item.project, keys),
      ...goldProblems(item.id, item.project, item.gold, memoriesById),
      ...(item.gold[0] === item.family
        ? []
        : [`${item.id}: family ${item.family} must equal the primary gold ${item.gold[0]}`]),
    ]),
    ...splitProblems(positives),
    ...confirmationCoverageProblems(positives),
  ];
}

function negativeProblems(fixtures: Fixtures, keys: ReadonlySet<string>): string[] {
  const negatives = fixtures.negatives;
  return [
    ...duplicateProblems("negatives", idsOf(negatives)),
    ...negatives.flatMap((item) => [
      ...projectProblems(item.id, item.project, keys),
      ...(item.gold.length === 0 ? [] : [`${item.id}: negative prompt must have empty gold`]),
    ]),
    ...splitProblems(negatives),
  ];
}

function pretoolProblems(
  fixtures: Fixtures,
  keys: ReadonlySet<string>,
  memoriesById: ReadonlyMap<string, FixtureMemory>,
): string[] {
  return [
    ...duplicateProblems("pretool", idsOf(fixtures.pretool)),
    ...fixtures.pretool.flatMap((item) => [
      ...projectProblems(item.id, item.project, keys),
      ...goldProblems(item.id, item.project, item.gold, memoriesById),
      ...REQUIRED_TOOL_FIELDS[item.tool_name]
        .filter((field) => item.tool_input[field] === undefined)
        .map((field) => `${item.id}: ${item.tool_name} input lacks ${field}`),
    ]),
  ];
}

function sideMemoryProblems(
  caseId: string,
  memory: FixtureMemory,
  expectedId: string,
  project: string,
  conflictKey: string,
): string[] {
  const problems: string[] = [];
  if (memory.id !== expectedId) {
    problems.push(`${caseId}: memory id ${memory.id} must be ${expectedId}`);
  }
  if (memory.scope !== "project" || memory.project !== project) {
    problems.push(`${caseId}: memory ${memory.id} must be project-scoped to ${project}`);
  }
  if (memory.conflict_key !== conflictKey) {
    problems.push(`${caseId}: memory ${memory.id} must carry conflict key ${conflictKey}`);
  }
  if (memory.cardinality !== "single") {
    problems.push(`${caseId}: memory ${memory.id} must be single-valued`);
  }
  return problems;
}

function keyCollisionProblems(section: string, projectKeys: readonly string[]): string[] {
  return duplicateProblems(section, projectKeys).map((problem) =>
    problem.replace("duplicate id", "duplicate project and conflict key"),
  );
}

function supersessionProblems(fixtures: Fixtures, keys: ReadonlySet<string>): string[] {
  const cases = fixtures.supersession;
  return [
    ...duplicateProblems("supersession", idsOf(cases)),
    ...keyCollisionProblems(
      "supersession",
      cases.map((item) => `${item.project}/${item.conflict_key}`),
    ),
    ...cases.flatMap((item) => [
      ...projectProblems(item.id, item.project, keys),
      ...sideMemoryProblems(item.id, item.old, `${item.id}-old`, item.project, item.conflict_key),
      ...sideMemoryProblems(item.id, item.new, `${item.id}-new`, item.project, item.conflict_key),
      ...(item.new.value_text === item.current_value
        ? []
        : [`${item.id}: new value must equal current_value`]),
      ...(item.old.value_text === item.new.value_text
        ? [`${item.id}: old and new values must differ`]
        : []),
    ]),
  ];
}

function contradictionCaseProblems(item: ContradictionCase, keys: ReadonlySet<string>): string[] {
  const sides = [
    { side: item.a, id: `${item.id}-a` },
    { side: item.b, id: `${item.id}-b` },
  ];
  const projectBySideId = new Map(sides.map(({ side, id }) => [id, side.project]));
  return [
    ...sides.flatMap(({ side, id }) => [
      ...projectProblems(item.id, side.project, keys),
      ...sideMemoryProblems(item.id, side.memory, id, side.project, item.conflict_key),
    ]),
    ...(item.a.project === item.b.project ? [`${item.id}: sides must use two projects`] : []),
    ...(item.a.memory.value_text === item.b.memory.value_text
      ? [`${item.id}: sides must assert different values`]
      : []),
    ...item.probes.flatMap((probe, index) =>
      projectBySideId.get(probe.expect_memory_id) === probe.project
        ? []
        : [`${item.id}: probe ${index} expects ${probe.expect_memory_id} outside ${probe.project}`],
    ),
    ...sides
      .filter(({ id }) => !item.probes.some((probe) => probe.expect_memory_id === id))
      .map(({ id }) => `${item.id}: no probe expects ${id}`),
  ];
}

function contradictionProblems(fixtures: Fixtures, keys: ReadonlySet<string>): string[] {
  const cases = fixtures.contradictions;
  return [
    ...duplicateProblems("contradictions", idsOf(cases)),
    ...keyCollisionProblems(
      "contradictions",
      cases.flatMap((item) => [
        `${item.a.project}/${item.conflict_key}`,
        `${item.b.project}/${item.conflict_key}`,
      ]),
    ),
    ...cases.flatMap((item) => contradictionCaseProblems(item, keys)),
  ];
}

function cueProblems(fixtures: Fixtures): string[] {
  return [
    ...duplicateProblems("capture-cues", idsOf(fixtures.cues)),
    ...fixtures.cues.flatMap((cue) => {
      const marked = HARNESS_MARKERS.some((marker) => cue.text.includes(marker));
      if (cue.origin === "harness" && !marked) {
        return [`${cue.id}: harness cue carries no harness marker`];
      }
      if (cue.origin === "human" && marked) {
        return [`${cue.id}: human cue carries a harness marker`];
      }
      return [];
    }),
  ];
}

function redactionProblems(fixtures: Fixtures): string[] {
  return [
    ...duplicateProblems(
      "redaction",
      fixtures.redaction.map((sample) => sample.name),
    ),
    ...fixtures.redaction
      .filter((sample) => !sample.text.includes(sample.secret))
      .map((sample) => `${sample.name}: text does not contain its secret`),
  ];
}

export function referenceProblems(fixtures: Fixtures): string[] {
  const keys = new Set(fixtures.corpus.projects.map((project) => project.key));
  const memories = fixtures.corpus.memories;
  const memoriesById = new Map(memories.map((memory) => [memory.id, memory]));
  const allMemoryIds = [
    ...memories.map((memory) => memory.id),
    ...fixtures.supersession.flatMap((item) => [item.old.id, item.new.id]),
    ...fixtures.contradictions.flatMap((item) => [item.a.memory.id, item.b.memory.id]),
  ];
  return [
    ...duplicateProblems(
      "projects",
      fixtures.corpus.projects.map((project) => project.key),
    ),
    ...duplicateProblems("memories", allMemoryIds),
    ...memories.flatMap((memory) => memoryProblems(memory, keys)),
    ...distractorProblems(fixtures),
    ...positiveProblems(fixtures, keys, memoriesById),
    ...negativeProblems(fixtures, keys),
    ...confirmationLeakProblems([...fixtures.positives, ...fixtures.negatives]),
    ...pretoolProblems(fixtures, keys, memoriesById),
    ...supersessionProblems(fixtures, keys),
    ...contradictionProblems(fixtures, keys),
    ...cueProblems(fixtures),
    ...redactionProblems(fixtures),
  ];
}

function czechShare(items: readonly { readonly lang: Lang }[]): number {
  return items.filter((item) => item.lang === "cs").length / Math.max(1, items.length);
}

function atLeast(name: string, actual: number, minimum: number): string[] {
  return actual >= minimum ? [] : [`${name}: ${actual} is below the minimum ${minimum}`];
}

export function sizeProblems(fixtures: Fixtures): string[] {
  const minimum = MINIMUM_SIZES;
  const missingCategories = NEGATIVE_CATEGORIES.filter(
    (category) => !fixtures.negatives.some((item) => item.category === category),
  );
  return [
    ...atLeast("memories", fixtures.corpus.memories.length, minimum.memories),
    ...atLeast("positives", fixtures.positives.length, minimum.positives),
    ...atLeast("positives czech share", czechShare(fixtures.positives), minimum.czechShare),
    ...atLeast("negatives", fixtures.negatives.length, minimum.negatives),
    ...atLeast("negatives czech share", czechShare(fixtures.negatives), minimum.czechShare),
    ...missingCategories.map((category) => `negatives: no ${category} prompts`),
    ...atLeast("pretool", fixtures.pretool.length, minimum.pretool),
    ...atLeast(
      "pretool negatives",
      fixtures.pretool.filter((item) => item.gold.length === 0).length,
      minimum.pretoolNegatives,
    ),
    ...atLeast(
      "pretool Read negatives",
      fixtures.pretool.filter((item) => item.tool_name === "Read" && item.gold.length === 0).length,
      minimum.pretoolReadNegatives,
    ),
    ...atLeast("supersession", fixtures.supersession.length, minimum.supersession),
    ...atLeast("contradictions", fixtures.contradictions.length, minimum.contradictions),
    ...atLeast("capture cues", fixtures.cues.length, minimum.cues),
    ...atLeast("redaction", fixtures.redaction.length, minimum.redaction),
  ];
}

function isNegativeCategory(category: ErrorCaseCategory | null): boolean {
  return ERROR_NEGATIVE_CATEGORIES.some((negative) => negative === category);
}

function errorLabelProblems(item: ErrorCase): string[] {
  const problems: string[] = [];
  if (isNegativeCategory(item.category) !== (item.gold.length === 0)) {
    problems.push(
      `${item.id}: a negative names a negative category and no gold, a positive gold and no negative category`,
    );
  }
  if ((item.category === "interrupt") !== item.is_interrupt) {
    problems.push(`${item.id}: only interrupt negatives set is_interrupt`);
  }
  if (item.tool_input.command === undefined) {
    problems.push(`${item.id}: Bash input lacks command`);
  }
  return problems;
}

function injectsThroughAnchor(
  item: ErrorCase,
  memoriesById: ReadonlyMap<string, FixtureMemory>,
): boolean {
  const terms = new Set(failureSignature(item.error).terms);
  return (
    !item.is_interrupt &&
    item.gold.some((goldId) =>
      (memoriesById.get(goldId)?.anchors ?? []).some((anchor) => terms.has(anchor)),
    )
  );
}

function repeatHeadProblems(
  cases: readonly ErrorCase[],
  memoriesById: ReadonlyMap<string, FixtureMemory>,
): string[] {
  return cases.flatMap((item, index) => {
    if (item.category !== "repeat_head") {
      return [];
    }
    const head = commandHead(item.tool_input);
    const headUsedUp = cases
      .slice(0, index)
      .some(
        (earlier) =>
          earlier.session === item.session &&
          commandHead(earlier.tool_input) === head &&
          injectsThroughAnchor(earlier, memoriesById),
      );
    return headUsedUp
      ? []
      : [
          `${item.id}: repeat_head follows no case of session ${item.session} and head ${head} that injects through an anchor equal to one of its terms`,
        ];
  });
}

export function errorCaseProblems(cases: readonly ErrorCase[], fixtures: Fixtures): string[] {
  const keys = new Set(fixtures.corpus.projects.map((project) => project.key));
  const memoriesById = new Map(fixtures.corpus.memories.map((memory) => [memory.id, memory]));
  return [
    ...duplicateProblems("errors", idsOf(cases)),
    ...cases.flatMap((item) => [
      ...projectProblems(item.id, item.project, keys),
      ...goldProblems(item.id, item.project, item.gold, memoriesById),
      ...errorLabelProblems(item),
    ]),
    ...repeatHeadProblems(cases, memoriesById),
    ...ERROR_NEGATIVE_CATEGORIES.filter(
      (category) => !cases.some((item) => item.category === category),
    ).map((category) => `errors: no ${category} negatives`),
    ...atLeast(
      "error negatives",
      cases.filter((item) => item.gold.length === 0).length,
      MINIMUM_SIZES.errorNegatives,
    ),
  ];
}
