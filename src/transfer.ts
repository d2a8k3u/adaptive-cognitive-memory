import { type AuthoringProblem, conflictKeyProblem } from "./authoring";
import {
  ABSTRACT_MAX_CHARS,
  CONTENT_MAX_CHARS,
  RELATION_CAP,
  RELATION_TYPE_MAX_CHARS,
  TITLE_MAX_CHARS,
} from "./cfg";
import { storedKeyProblem, storedKeys } from "./db/memories";
import { ID_MAX_CHARS, isMemoryId } from "./ids";
import { parseStoredList } from "./keys";
import {
  CARDINALITIES,
  EPISTEMIC_STATES,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  MEMORY_SCOPES,
  MEMORY_STATES,
  MEMORY_TYPES,
  type MemoryScope,
} from "./policy";
import { redact, redactWithin } from "./redact";

export const EXPORT_HEADER = {
  record: "header",
  format: "adaptive-cognitive-memory",
  version: 1,
} as const;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const LEGACY_CONFLICT_KEY = "";

export interface MemoryLine {
  readonly record: "memory";
  readonly id: string;
  readonly type: string;
  readonly kind: string;
  readonly scope: MemoryScope;
  readonly project_id: string;
  readonly title: string;
  readonly abstract: string;
  readonly content: string;
  readonly conflict_key: string;
  readonly cardinality: string;
  readonly value_text: string;
  readonly keywords: string;
  readonly anchors: readonly string[];
  readonly questions: readonly string[];
  readonly epistemic: string;
  readonly origin: string;
  readonly state: string;
  readonly importance: number;
  readonly support_count: number;
  readonly conflict_count: number;
  readonly injection_count: number;
  readonly used_count: number;
  readonly wrong_count: number;
  readonly valid_from: string | null;
  readonly invalid_at: string | null;
  readonly expired_at: string | null;
  readonly last_injected_at: string | null;
  readonly superseded_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RelationLine {
  readonly record: "relation";
  readonly source_id: string;
  readonly target_id: string;
  readonly relation_type: string;
}

export interface TransitionLine {
  readonly record: "transition";
  readonly memory_id: string;
  readonly from_state: string;
  readonly to_state: string;
  readonly reason: string;
  readonly evidence: string;
  readonly related_id: string | null;
  readonly at: string;
}

export type ExportRecord = MemoryLine | RelationLine | TransitionLine;

export interface NumberedRecord {
  readonly line: number;
  readonly record: ExportRecord;
}

export interface StoredMemoryRow extends Omit<MemoryLine, "record" | "anchors" | "questions"> {
  readonly anchors: string;
  readonly questions: string;
}

export interface ExportSnapshot {
  readonly memories: readonly StoredMemoryRow[];
  readonly relations: readonly Omit<RelationLine, "record">[];
  readonly transitions: readonly Omit<TransitionLine, "record">[];
}

export interface SlotHolder {
  readonly id: string;
  readonly slot: string;
}

export interface ImportFacts {
  readonly existingIds: ReadonlySet<string>;
  readonly slotHolders: readonly SlotHolder[];
}

export type Rejected = { readonly ok: false; readonly errors: readonly string[] };

export type ParsedImport =
  | { readonly ok: true; readonly records: readonly NumberedRecord[] }
  | Rejected;

export interface ImportWrites {
  readonly memories: readonly MemoryLine[];
  readonly relations: readonly RelationLine[];
  readonly transitions: readonly TransitionLine[];
  readonly skipped: number;
}

export type ImportPlan = ({ readonly ok: true } & ImportWrites) | Rejected;

type Check = (field: string, value: unknown) => string | undefined;

function text(maxChars?: number): Check {
  return (field, value) => {
    if (typeof value === "string" && (maxChars === undefined || value.length <= maxChars)) {
      return undefined;
    }
    return maxChars === undefined
      ? `${field} must be a string`
      : `${field} must be a string of at most ${maxChars} characters`;
  };
}

const memoryId: Check = (field, value) =>
  isMemoryId(value)
    ? undefined
    : `${field} must be a non-empty string of at most ${ID_MAX_CHARS} characters`;

const optionalMemoryId: Check = (field, value) =>
  value === null ? undefined : memoryId(field, value);

function oneOf(values: readonly string[]): Check {
  return (field, value) =>
    typeof value === "string" && values.includes(value)
      ? undefined
      : `${field} must be one of ${values.join(", ")}`;
}

const counter: Check = (field, value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? undefined
    : `${field} must be a non-negative integer`;

const unitInterval: Check = (field, value) =>
  typeof value === "number" && value >= 0 && value <= 1
    ? undefined
    : `${field} must be a number between 0 and 1`;

const instant: Check = (field, value) =>
  typeof value === "string" && ISO_INSTANT.test(value)
    ? undefined
    : `${field} must be an ISO-8601 UTC timestamp`;

const optionalInstant: Check = (field, value) =>
  value === null ? undefined : instant(field, value);

function authoringCheck(problemOf: (value: unknown) => AuthoringProblem | undefined): Check {
  return (_field, value) => problemOf(value)?.message;
}

function legacyOr(check: Check): Check {
  return (field, value) => (value === LEGACY_CONFLICT_KEY ? undefined : check(field, value));
}

function absentOr(check: Check): Check {
  return (field, value) => (value === undefined ? undefined : check(field, value));
}

const MEMORY_FIELDS: Readonly<Record<Exclude<keyof MemoryLine, "record">, Check>> = {
  id: memoryId,
  type: oneOf(MEMORY_TYPES),
  kind: oneOf(MEMORY_KINDS),
  scope: oneOf(MEMORY_SCOPES),
  project_id: text(),
  title: text(TITLE_MAX_CHARS),
  abstract: text(ABSTRACT_MAX_CHARS),
  content: text(CONTENT_MAX_CHARS),
  conflict_key: legacyOr(authoringCheck(conflictKeyProblem)),
  cardinality: oneOf(CARDINALITIES),
  value_text: authoringCheck(storedKeyProblem.valueText),
  keywords: authoringCheck(storedKeyProblem.keywords),
  anchors: authoringCheck(storedKeyProblem.anchors),
  questions: absentOr(authoringCheck(storedKeyProblem.questions)),
  epistemic: oneOf(EPISTEMIC_STATES),
  origin: oneOf(MEMORY_ORIGINS),
  state: oneOf(MEMORY_STATES),
  importance: unitInterval,
  support_count: counter,
  conflict_count: counter,
  injection_count: counter,
  used_count: counter,
  wrong_count: counter,
  valid_from: optionalInstant,
  invalid_at: optionalInstant,
  expired_at: optionalInstant,
  last_injected_at: optionalInstant,
  superseded_by: optionalMemoryId,
  created_at: instant,
  updated_at: instant,
};

const RELATION_FIELDS: Readonly<Record<Exclude<keyof RelationLine, "record">, Check>> = {
  source_id: memoryId,
  target_id: memoryId,
  relation_type: text(RELATION_TYPE_MAX_CHARS),
};

const TRANSITION_FIELDS: Readonly<Record<Exclude<keyof TransitionLine, "record">, Check>> = {
  memory_id: memoryId,
  from_state: oneOf(MEMORY_STATES),
  to_state: oneOf(MEMORY_STATES),
  reason: text(),
  evidence: text(),
  related_id: optionalMemoryId,
  at: instant,
};

const FIELDS_BY_RECORD: Readonly<Record<ExportRecord["record"], Readonly<Record<string, Check>>>> =
  {
    memory: MEMORY_FIELDS,
    relation: RELATION_FIELDS,
    transition: TRANSITION_FIELDS,
  };

function isRecordKind(value: unknown): value is ExportRecord["record"] {
  return typeof value === "string" && Object.hasOwn(FIELDS_BY_RECORD, value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scrubbed(text: string): string {
  return redact(text).text;
}

function redactedMemoryLine(line: MemoryLine): MemoryLine {
  return {
    ...line,
    title: redactWithin(line.title, TITLE_MAX_CHARS),
    abstract: redactWithin(line.abstract, ABSTRACT_MAX_CHARS),
    content: redactWithin(line.content, CONTENT_MAX_CHARS),
    value_text: storedKeys.valueText(line.value_text),
    keywords: storedKeys.keywords(line.keywords),
    anchors: storedKeys.anchors(line.anchors),
    questions: storedKeys.questions(line.questions),
  };
}

function redactedTransitionLine(line: TransitionLine): TransitionLine {
  return { ...line, evidence: scrubbed(line.evidence) };
}

export function memoryLine(row: StoredMemoryRow): MemoryLine {
  return redactedMemoryLine({
    record: "memory",
    id: row.id,
    type: row.type,
    kind: row.kind,
    scope: row.scope,
    project_id: row.project_id,
    title: row.title,
    abstract: row.abstract,
    content: row.content,
    conflict_key: row.conflict_key,
    cardinality: row.cardinality,
    value_text: row.value_text,
    keywords: row.keywords,
    anchors: parseStoredList(row.id, "anchors", row.anchors),
    questions: parseStoredList(row.id, "questions", row.questions),
    epistemic: row.epistemic,
    origin: row.origin,
    state: row.state,
    importance: row.importance,
    support_count: row.support_count,
    conflict_count: row.conflict_count,
    injection_count: row.injection_count,
    used_count: row.used_count,
    wrong_count: row.wrong_count,
    valid_from: row.valid_from,
    invalid_at: row.invalid_at,
    expired_at: row.expired_at,
    last_injected_at: row.last_injected_at,
    superseded_by: row.superseded_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

export function exportText(snapshot: ExportSnapshot): string {
  const records: readonly unknown[] = [
    EXPORT_HEADER,
    ...snapshot.memories.map(memoryLine),
    ...snapshot.relations.map((row) => ({
      record: "relation",
      source_id: row.source_id,
      target_id: row.target_id,
      relation_type: row.relation_type,
    })),
    ...snapshot.transitions.map((row) =>
      redactedTransitionLine({
        record: "transition",
        memory_id: row.memory_id,
        from_state: row.from_state,
        to_state: row.to_state,
        reason: row.reason,
        evidence: row.evidence,
        related_id: row.related_id,
        at: row.at,
      }),
    ),
  ];
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function parsedJson(raw: string): { readonly value: unknown } | { readonly error: string } {
  try {
    return { value: JSON.parse(raw) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { error: `not JSON (${error.message})` };
    }
    throw error;
  }
}

function isExportHeader(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === Object.keys(EXPORT_HEADER).length &&
    Object.entries(EXPORT_HEADER).every(([key, expected]) => value[key] === expected)
  );
}

function recordErrors(value: unknown): string[] {
  if (!isPlainObject(value)) {
    return ["expected a JSON object"];
  }
  if (!isRecordKind(value.record)) {
    return [`unknown record '${String(value.record)}'`];
  }
  const fields = FIELDS_BY_RECORD[value.record];
  const unknownFields = Object.keys(value)
    .filter((key) => key !== "record" && !Object.hasOwn(fields, key))
    .map((key) => `unknown field '${key}'`);
  const invalidFields = Object.entries(fields).flatMap(([field, check]) => {
    const error = check(field, value[field]);
    return error === undefined ? [] : [error];
  });
  return [...unknownFields, ...invalidFields];
}

function withDefaults(record: ExportRecord): ExportRecord {
  if (record.record !== "memory" || record.questions !== undefined) {
    return record;
  }
  return { ...record, questions: [] };
}

export function parseImport(content: string): ParsedImport {
  const lines = content.split("\n");
  const errors: string[] = [];
  const records: NumberedRecord[] = [];
  if (!isExportHeader(parsedValue(lines[0] ?? ""))) {
    errors.push(`line 1: expected the export header ${JSON.stringify(EXPORT_HEADER)}`);
  }
  lines.slice(1).forEach((raw, index) => {
    const line = index + 2;
    if (raw === "") {
      return;
    }
    const parsed = parsedJson(raw);
    const problems = "error" in parsed ? [parsed.error] : recordErrors(parsed.value);
    if (problems.length > 0) {
      errors.push(...problems.map((problem) => `line ${line}: ${problem}`));
      return;
    }
    if ("value" in parsed) {
      records.push({ line, record: withDefaults(parsed.value as ExportRecord) });
    }
  });
  return errors.length === 0 ? { ok: true, records } : { ok: false, errors };
}

function parsedValue(raw: string): unknown {
  const parsed = parsedJson(raw);
  return "value" in parsed ? parsed.value : undefined;
}

export function slotOf(scope: MemoryScope, projectId: string, conflictKey: string): string {
  return JSON.stringify([scope, scope === "user" ? "" : projectId, conflictKey]);
}

function holdsSingleSlot(memory: MemoryLine): boolean {
  return memory.cardinality === "single" && memory.state === "active" && memory.conflict_key !== "";
}

interface NumberedMemory {
  readonly line: number;
  readonly memory: MemoryLine;
}

function memoriesOf(records: readonly NumberedRecord[]): NumberedMemory[] {
  return records.flatMap(({ line, record }) =>
    record.record === "memory" ? [{ line, memory: record }] : [],
  );
}

function duplicateIdErrors(memories: readonly NumberedMemory[]): string[] {
  const firstLine = new Map<string, number>();
  return memories.flatMap(({ line, memory }) => {
    const first = firstLine.get(memory.id);
    if (first !== undefined) {
      return [`line ${line}: duplicate memory id ${memory.id} (first on line ${first})`];
    }
    firstLine.set(memory.id, line);
    return [];
  });
}

function referencesOf(record: ExportRecord): readonly (readonly [string, string | null])[] {
  switch (record.record) {
    case "memory":
      return [["superseded_by", record.superseded_by]];
    case "relation":
      return [
        ["source_id", record.source_id],
        ["target_id", record.target_id],
      ];
    case "transition":
      return [
        ["memory_id", record.memory_id],
        ["related_id", record.related_id],
      ];
  }
}

function referenceErrors(
  records: readonly NumberedRecord[],
  knownIds: ReadonlySet<string>,
): string[] {
  return records.flatMap(({ line, record }) =>
    referencesOf(record).flatMap(([field, id]) =>
      id === null || knownIds.has(id)
        ? []
        : [`line ${line}: ${field} ${id} names no memory in the file or the database`],
    ),
  );
}

function slotErrors(added: readonly NumberedMemory[], existing: readonly SlotHolder[]): string[] {
  const holderBySlot = new Map(existing.map((holder) => [holder.slot, holder.id]));
  return added.flatMap(({ line, memory }) => {
    if (!holdsSingleSlot(memory)) {
      return [];
    }
    const slot = slotOf(memory.scope, memory.project_id, memory.conflict_key);
    const holder = holderBySlot.get(slot);
    if (holder !== undefined && holder !== memory.id) {
      return [
        `line ${line}: active single-valued ${memory.id} takes slot ${memory.conflict_key} held by ${holder}`,
      ];
    }
    holderBySlot.set(slot, memory.id);
    return [];
  });
}

interface NumberedRelation {
  readonly line: number;
  readonly relation: RelationLine;
}

function relationsOf(records: readonly NumberedRecord[]): NumberedRelation[] {
  return records.flatMap(({ line, record }) =>
    record.record === "relation" ? [{ line, relation: record }] : [],
  );
}

function distinctRelations(relations: readonly NumberedRelation[]): NumberedRelation[] {
  const seen = new Set<string>();
  return relations.filter(({ relation }) => {
    const key = JSON.stringify([relation.source_id, relation.target_id, relation.relation_type]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function relationCapErrors(relations: readonly NumberedRelation[]): string[] {
  const countBySource = new Map<string, number>();
  return relations.flatMap(({ line, relation }) => {
    const count = (countBySource.get(relation.source_id) ?? 0) + 1;
    countBySource.set(relation.source_id, count);
    return count > RELATION_CAP
      ? [
          `line ${line}: relation to ${relation.target_id} is relation ${count} of ${relation.source_id}; a memory holds at most ${RELATION_CAP} relations`,
        ]
      : [];
  });
}

export function planImport(records: readonly NumberedRecord[], facts: ImportFacts): ImportPlan {
  const memories = memoriesOf(records);
  const added = memories.filter(({ memory }) => !facts.existingIds.has(memory.id));
  const addedIds = new Set(added.map(({ memory }) => memory.id));
  const knownIds = new Set([...facts.existingIds, ...memories.map(({ memory }) => memory.id)]);
  const addedRelations = distinctRelations(
    relationsOf(records).filter(({ relation }) => addedIds.has(relation.source_id)),
  );
  const errors = [
    ...duplicateIdErrors(memories),
    ...referenceErrors(records, knownIds),
    ...slotErrors(added, facts.slotHolders),
    ...relationCapErrors(addedRelations),
  ];
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    memories: added.map(({ memory }) => redactedMemoryLine(memory)),
    relations: addedRelations.map(({ relation }) => relation),
    transitions: records.flatMap(({ record }) =>
      record.record === "transition" && addedIds.has(record.memory_id)
        ? [redactedTransitionLine(record)]
        : [],
    ),
    skipped: memories.length - added.length,
  };
}
