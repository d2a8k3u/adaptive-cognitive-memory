import {
  ANCHOR_MAX_CHARS,
  ANCHORS_MAX_ITEMS,
  type AuthoringProblem,
  CONFLICT_KEY_MAX_CHARS,
  CONFLICT_KEY_PATTERN,
  conflictKeyProblem,
  KEYWORDS_MAX_CHARS,
  QUESTION_MAX_CHARS,
  QUESTIONS_MAX_ITEMS,
  VALUE_TEXT_MAX_CHARS,
} from "./authoring";
import {
  ABSTRACT_MAX_CHARS,
  CONTENT_MAX_CHARS,
  RELATION_TYPE_MAX_CHARS,
  TITLE_MAX_CHARS,
} from "./cfg";
import { isStorageRejection } from "./db/database";
import { type FeedbackMemory, recordFeedback } from "./db/feedback";
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  type ListPage,
  type ListPartition,
  type ListRequest,
  listMemories,
} from "./db/listing";
import {
  type Candidate,
  deleteMemory,
  get,
  type MemoryEnv,
  type MemoryRecord,
  MemoryRejection,
  type Resolution,
  resolveVisibleMemoryId,
  type StoreInput,
  type StoreOutcome,
  type StoreResult,
  store,
  storedKeyProblem,
  updateMemory,
} from "./db/memories";
import { relate } from "./db/relations";
import { statusFacts } from "./db/status";
import { type DoctorReport, runDoctor } from "./doctor";
import { harnessMarker } from "./harness";
import { ID_MAX_CHARS, isMemoryId } from "./ids";
import { type InstructionSources, readInstructionLines, restatedInstruction } from "./instructions";
import { FEEDBACK_IDS_MAX_ITEMS, FEEDBACK_VERDICTS, parseFeedbackVerdicts } from "./lifecycle";
import {
  CARDINALITIES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATES,
  MEMORY_TYPES,
  RESOLUTION_ACTIONS,
  type ResolutionAction,
} from "./policy";
import { DEFAULT_RECALL_LIMIT, type DegradedFlags, type RecallRow, recall } from "./search";
import { type StatusReport, statusReport } from "./status";

export interface ToolDeps {
  env: MemoryEnv;
  projectId: string;
  embedDeadlineMs: number;
  processEnv: NodeJS.ProcessEnv;
  instructionSources: InstructionSources;
}

export interface ToolErrorValue {
  error: { field?: string; message: string };
}

export interface NeedsResolutionValue {
  status: "needs_resolution";
  candidates: readonly Candidate[];
  allowed: readonly ResolutionAction[];
}

const SEARCH_LIMIT_MAX = 100;
const ALL_PROJECTS = "all";
const IMMUTABLE_FIELDS = ["scope", "kind"] as const;

export function isToolError(value: unknown): value is ToolErrorValue {
  return typeof value === "object" && value !== null && "error" in value;
}

function fieldError(field: string, message: string): ToolErrorValue {
  return { error: { field, message } };
}

async function rejectionsAsToolErrors<T>(work: () => T | Promise<T>): Promise<T | ToolErrorValue> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof MemoryRejection || isStorageRejection(error)) {
      return { error: { message: error.message } };
    }
    throw error;
  }
}

function visibleId(deps: ToolDeps, idOrPrefix: string): string {
  return resolveVisibleMemoryId(deps.env.db, deps.projectId, idOrPrefix);
}

function requiredString(
  args: Record<string, unknown>,
  field: string,
  maxChars: number,
): string | ToolErrorValue {
  const value = args[field];
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    return fieldError(
      field,
      `${field} must be a non-empty string of at most ${maxChars} characters`,
    );
  }
  return value;
}

function memoryText(
  args: Record<string, unknown>,
  field: string,
  maxChars: number,
): string | ToolErrorValue {
  const value = requiredString(args, field, maxChars);
  if (isToolError(value)) {
    return value;
  }
  if (value.trim() === "") {
    return fieldError(field, `${field} must contain text, not only whitespace`);
  }
  const marker = harnessMarker(value);
  if (marker !== undefined) {
    return fieldError(
      field,
      `${field} contains the harness marker ${marker}; store the durable lesson in your own words, without agent, task or system wrapper text`,
    );
  }
  return value;
}

function optionalMemoryText(
  args: Record<string, unknown>,
  field: string,
  maxChars: number,
): string | undefined | ToolErrorValue {
  return args[field] === undefined ? undefined : memoryText(args, field, maxChars);
}

function requiredText(
  args: Record<string, unknown>,
  field: string,
  maxChars: number,
): string | ToolErrorValue {
  const value = args[field];
  if (typeof value !== "string" || value.length > maxChars) {
    return fieldError(field, `${field} must be a string of at most ${maxChars} characters`);
  }
  return value;
}

function requiredEnum<T extends string>(
  args: Record<string, unknown>,
  field: string,
  values: readonly T[],
): T | ToolErrorValue {
  const value = args[field];
  if (typeof value !== "string" || !values.includes(value as T)) {
    return fieldError(field, `${field} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  field: string,
  values: readonly T[],
): T | undefined | ToolErrorValue {
  const value = args[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !values.includes(value as T)) {
    return fieldError(field, `${field} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function optionalInt(
  args: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number | undefined | ToolErrorValue {
  const value = args[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return fieldError(field, `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function authoringError(problem: AuthoringProblem | undefined): ToolErrorValue | undefined {
  return problem === undefined ? undefined : fieldError(problem.field, problem.message);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function writtenKey<Key>(
  value: unknown,
  isKey: (value: unknown) => value is Key,
  problemOf: (value: unknown) => AuthoringProblem | undefined,
): Key | ToolErrorValue {
  const rejection = authoringError(problemOf(value));
  if (rejection !== undefined) {
    return rejection;
  }
  if (!isKey(value)) {
    throw new TypeError("an authoring check accepted a value of the wrong type");
  }
  return value;
}

function requiredConflictKey(args: Record<string, unknown>): string | ToolErrorValue {
  return writtenKey(args.conflict_key, isString, conflictKeyProblem);
}

function valueTextFor(
  args: Record<string, unknown>,
  cardinality: StoreInput["cardinality"],
): string | ToolErrorValue {
  const value = args.value_text;
  if (cardinality === "single" && (typeof value !== "string" || value.trim() === "")) {
    return fieldError(
      "value_text",
      "value_text is required for a single-valued conflict_key: give the slot's current value, such as PostgreSQL 15",
    );
  }
  if (value === undefined) {
    return "";
  }
  return writtenKey(value, isString, storedKeyProblem.valueText);
}

function keywordsArgument(args: Record<string, unknown>): string | undefined | ToolErrorValue {
  if (args.keywords === undefined) {
    return undefined;
  }
  return writtenKey(args.keywords, isString, storedKeyProblem.keywords);
}

function anchorsArgument(
  args: Record<string, unknown>,
): readonly string[] | undefined | ToolErrorValue {
  if (args.anchors === undefined) {
    return undefined;
  }
  return writtenKey(args.anchors, isStringList, storedKeyProblem.anchors);
}

function questionsArgument(
  args: Record<string, unknown>,
): readonly string[] | undefined | ToolErrorValue {
  if (args.questions === undefined) {
    return undefined;
  }
  return writtenKey(args.questions, isStringList, storedKeyProblem.questions);
}

function optionalResolution(
  args: Record<string, unknown>,
): Resolution | undefined | ToolErrorValue {
  const value: unknown = args.resolution;
  if (value === undefined) {
    return undefined;
  }
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const action = record.action;
  if (typeof action !== "string" || !RESOLUTION_ACTIONS.includes(action as ResolutionAction)) {
    return fieldError(
      "resolution",
      `resolution must be an object whose action is one of: ${RESOLUTION_ACTIONS.join(", ")}`,
    );
  }
  if (action === "ADD") {
    return { action };
  }
  const target = record.target;
  if (typeof target !== "string" || target === "" || target.length > ID_MAX_CHARS) {
    return fieldError(
      "resolution",
      `resolution.target must be the id of the candidate to ${action}, at most ${ID_MAX_CHARS} characters`,
    );
  }
  return { action: action as Exclude<ResolutionAction, "ADD">, target };
}

function parseStoreArgs(args: Record<string, unknown>): StoreInput | ToolErrorValue {
  const title = memoryText(args, "title", TITLE_MAX_CHARS);
  if (isToolError(title)) {
    return title;
  }
  const content = memoryText(args, "content", CONTENT_MAX_CHARS);
  if (isToolError(content)) {
    return content;
  }
  const type = requiredEnum(args, "type", MEMORY_TYPES);
  if (isToolError(type)) {
    return type;
  }
  const kind = requiredEnum(args, "kind", MEMORY_KINDS);
  if (isToolError(kind)) {
    return kind;
  }
  const conflictKey = requiredConflictKey(args);
  if (isToolError(conflictKey)) {
    return conflictKey;
  }
  const cardinality = optionalEnum(args, "cardinality", CARDINALITIES) ?? "multi";
  if (isToolError(cardinality)) {
    return cardinality;
  }
  const valueText = valueTextFor(args, cardinality);
  if (isToolError(valueText)) {
    return valueText;
  }
  const keywords = keywordsArgument(args) ?? "";
  if (isToolError(keywords)) {
    return keywords;
  }
  const anchors = anchorsArgument(args) ?? [];
  if (isToolError(anchors)) {
    return anchors;
  }
  const questions = questionsArgument(args) ?? [];
  if (isToolError(questions)) {
    return questions;
  }
  const scope = optionalEnum(args, "scope", MEMORY_SCOPES);
  if (isToolError(scope)) {
    return scope;
  }
  const abstract = optionalMemoryText(args, "abstract", ABSTRACT_MAX_CHARS);
  if (isToolError(abstract)) {
    return abstract;
  }
  const resolution = optionalResolution(args);
  if (isToolError(resolution)) {
    return resolution;
  }
  return {
    title,
    content,
    abstract,
    type,
    kind,
    conflictKey,
    cardinality,
    valueText,
    keywords,
    anchors,
    questions,
    scope: scope ?? "project",
    resolution,
  };
}

function storeToolResult(
  outcome: StoreOutcome,
): StoreResult | NeedsResolutionValue | ToolErrorValue {
  switch (outcome.outcome) {
    case "written":
      return outcome.result;
    case "needs_resolution":
      return {
        status: "needs_resolution",
        candidates: outcome.candidates,
        allowed: [...RESOLUTION_ACTIONS],
      };
    case "rejected":
      return fieldError("resolution", outcome.reason);
  }
}

export async function memoryStore(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<StoreResult | NeedsResolutionValue | ToolErrorValue> {
  const input = parseStoreArgs(args);
  if (isToolError(input)) {
    return input;
  }
  const restated = restatedInstruction(
    input.content,
    readInstructionLines(deps.instructionSources),
  );
  if (restated !== undefined) {
    return fieldError(
      "content",
      `content restates a line of ${restated.source}, which every session already loads; store only what a future session could not re-derive from the code, git history or CLAUDE.md`,
    );
  }
  return rejectionsAsToolErrors(async () =>
    storeToolResult(await store(deps.env, input, deps.projectId)),
  );
}

export async function memorySearch(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<SearchToolResult | ToolErrorValue> {
  const query = requiredText(args, "query", CONTENT_MAX_CHARS);
  if (isToolError(query)) {
    return query;
  }
  const limit = optionalInt(args, "limit", 1, SEARCH_LIMIT_MAX);
  if (isToolError(limit)) {
    return limit;
  }
  const type = optionalEnum(args, "type", MEMORY_TYPES);
  if (isToolError(type)) {
    return type;
  }
  const scope = optionalEnum(args, "scope", MEMORY_SCOPES);
  if (isToolError(scope)) {
    return scope;
  }
  return rejectionsAsToolErrors(async () => {
    const recalled = await recall(deps.env, {
      projectId: deps.projectId,
      modelCacheDir: deps.env.modelCacheDir,
      embedDeadlineMs: deps.embedDeadlineMs,
      query,
      limit: limit ?? DEFAULT_RECALL_LIMIT,
      type,
      scope,
      ftsOnly: query.trim() === "",
    });
    return {
      results: recalled.rows,
      ...(recalled.degraded === undefined ? {} : { degraded: recalled.degraded }),
    };
  });
}

export interface SearchToolResult {
  results: RecallRow[];
  degraded?: DegradedFlags;
}

function optionalCursor(args: Record<string, unknown>): string | undefined | ToolErrorValue {
  const value = args.before;
  if (value === undefined) {
    return undefined;
  }
  return isMemoryId(value)
    ? value
    : fieldError(
        "before",
        `before must be the next_cursor of the previous page, a non-empty id of at most ${ID_MAX_CHARS} characters`,
      );
}

function listPartition(
  args: Record<string, unknown>,
  projectId: string,
): ListPartition | ToolErrorValue {
  const value = args.project;
  if (value === undefined) {
    return { kind: "visible", projectId };
  }
  return value === ALL_PROJECTS
    ? { kind: "all" }
    : fieldError(
        "project",
        `project must be "${ALL_PROJECTS}" to list every project read-only, or left out`,
      );
}

function parseListArgs(
  args: Record<string, unknown>,
  projectId: string,
): ListRequest | ToolErrorValue {
  const state = optionalEnum(args, "state", MEMORY_STATES);
  if (isToolError(state)) {
    return state;
  }
  const kind = optionalEnum(args, "kind", MEMORY_KINDS);
  if (isToolError(kind)) {
    return kind;
  }
  const type = optionalEnum(args, "type", MEMORY_TYPES);
  if (isToolError(type)) {
    return type;
  }
  const scope = optionalEnum(args, "scope", MEMORY_SCOPES);
  if (isToolError(scope)) {
    return scope;
  }
  const before = optionalCursor(args);
  if (isToolError(before)) {
    return before;
  }
  const limit = optionalInt(args, "limit", 1, LIST_LIMIT_MAX);
  if (isToolError(limit)) {
    return limit;
  }
  const partition = listPartition(args, projectId);
  if (isToolError(partition)) {
    return partition;
  }
  return {
    partition,
    filters: { state, kind, type, scope },
    before,
    limit: limit ?? LIST_LIMIT_DEFAULT,
  };
}

export async function memoryList(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<ListPage | ToolErrorValue> {
  const request = parseListArgs(args, deps.projectId);
  if (isToolError(request)) {
    return request;
  }
  return rejectionsAsToolErrors(() => listMemories(deps.env.db, request));
}

export async function memoryGet(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<MemoryRecord | ToolErrorValue> {
  const id = requiredString(args, "id", ID_MAX_CHARS);
  if (isToolError(id)) {
    return id;
  }
  return rejectionsAsToolErrors(() => get(deps.env, visibleId(deps, id)));
}

export async function memoryUpdate(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<MemoryRecord | ToolErrorValue> {
  const id = requiredString(args, "id", ID_MAX_CHARS);
  if (isToolError(id)) {
    return id;
  }
  const title = optionalMemoryText(args, "title", TITLE_MAX_CHARS);
  if (isToolError(title)) {
    return title;
  }
  const abstract = optionalMemoryText(args, "abstract", ABSTRACT_MAX_CHARS);
  if (isToolError(abstract)) {
    return abstract;
  }
  const content = optionalMemoryText(args, "content", CONTENT_MAX_CHARS);
  if (isToolError(content)) {
    return content;
  }
  const keywords = keywordsArgument(args);
  if (isToolError(keywords)) {
    return keywords;
  }
  const anchors = anchorsArgument(args);
  if (isToolError(anchors)) {
    return anchors;
  }
  const questions = questionsArgument(args);
  if (isToolError(questions)) {
    return questions;
  }
  const immutable = IMMUTABLE_FIELDS.find((field) => args[field] !== undefined);
  if (immutable !== undefined) {
    return fieldError(
      immutable,
      `${immutable} cannot change in place; store the memory again with the new ${immutable}, then delete this one`,
    );
  }
  const edits = { title, abstract, content, keywords, anchors, questions };
  if (Object.values(edits).every((edit) => edit === undefined)) {
    return {
      error: {
        message:
          "update requires at least one of title, abstract, content, keywords, anchors, questions",
      },
    };
  }
  return rejectionsAsToolErrors(() => updateMemory(deps.env, visibleId(deps, id), edits));
}

export async function memoryDelete(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<{ deleted: true } | ToolErrorValue> {
  const id = requiredString(args, "id", ID_MAX_CHARS);
  if (isToolError(id)) {
    return id;
  }
  return rejectionsAsToolErrors(() => deleteMemory(deps.env, visibleId(deps, id)));
}

export async function memoryRelate(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<{ ok: true } | ToolErrorValue> {
  const sourceId = requiredString(args, "source_id", ID_MAX_CHARS);
  if (isToolError(sourceId)) {
    return sourceId;
  }
  const targetId = requiredString(args, "target_id", ID_MAX_CHARS);
  if (isToolError(targetId)) {
    return targetId;
  }
  const relationType = requiredString(args, "relation_type", RELATION_TYPE_MAX_CHARS);
  if (isToolError(relationType)) {
    return relationType;
  }
  return rejectionsAsToolErrors(() =>
    relate(deps.env.db, visibleId(deps, sourceId), visibleId(deps, targetId), relationType),
  );
}

export interface FeedbackToolResult {
  memories: readonly FeedbackMemory[];
}

export async function memoryFeedback(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<FeedbackToolResult | ToolErrorValue> {
  const parsed = parseFeedbackVerdicts(args);
  if (parsed.outcome === "invalid") {
    return parsed.field === undefined
      ? { error: { message: parsed.message } }
      : fieldError(parsed.field, parsed.message);
  }
  return rejectionsAsToolErrors(() => {
    const outcome = recordFeedback(deps.env, {
      projectId: deps.projectId,
      verdicts: parsed.verdicts,
      at: new Date().toISOString(),
    });
    return outcome.outcome === "recorded"
      ? { memories: outcome.memories }
      : { error: { message: outcome.reason } };
  });
}

export async function memoryDoctor(deps: ToolDeps): Promise<DoctorReport> {
  return runDoctor(deps.processEnv, deps.instructionSources.projectDir);
}

export async function memoryStatus(deps: ToolDeps): Promise<StatusReport> {
  return statusReport(statusFacts(deps.env.db, deps.projectId), new Date().toISOString());
}

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  run: (deps: ToolDeps, args: Record<string, unknown>) => Promise<unknown>;
}

const ID_PROPERTY = { type: "string", maxLength: ID_MAX_CHARS };
const TYPE_PROPERTY = { type: "string", enum: [...MEMORY_TYPES] };
const KIND_PROPERTY = { type: "string", enum: [...MEMORY_KINDS] };
const KEYWORDS_PROPERTY = { type: "string", maxLength: KEYWORDS_MAX_CHARS };
const ANCHORS_PROPERTY = {
  type: "array",
  items: { type: "string", maxLength: ANCHOR_MAX_CHARS },
  maxItems: ANCHORS_MAX_ITEMS,
};
const QUESTIONS_PROPERTY = {
  type: "array",
  items: { type: "string", maxLength: QUESTION_MAX_CHARS },
  maxItems: QUESTIONS_MAX_ITEMS,
};
const SCOPE_PROPERTY = { type: "string", enum: [...MEMORY_SCOPES] };
const TITLE_PROPERTY = { type: "string", maxLength: TITLE_MAX_CHARS };
const CONTENT_PROPERTY = { type: "string", maxLength: CONTENT_MAX_CHARS };
const ABSTRACT_PROPERTY = { type: "string", maxLength: ABSTRACT_MAX_CHARS };

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "memory_store",
    description:
      "Store one durable lesson the moment it appears, without asking first: after a user correction the rule and its reason, a non-obvious convention you inferred, or the reasoning behind a solved problem (not the fix; the diff holds it). Store only what a future session could not re-derive from the code, git history or CLAUDE.md; content restating a line of CLAUDE.md, .claude/rules or the auto-memory MEMORY.md is rejected. English, one topic, insight first, searchable terms; scope=user only for facts that hold across projects. Always give kind, a stable lowercase dotted conflict_key naming the slot (project.primary_database, team.reviewers), cardinality, and value_text for a single-valued key. Add questions users would type when it matters, in English and their language. If the answer is needs_resolution, repeat the same call with resolution {action, target}: SUPERSEDE a changed single-valued fact, UPDATE to refine the same fact, NOOP when it is already known, ADD for a genuinely different memory.",
    inputSchema: {
      type: "object",
      properties: {
        title: TITLE_PROPERTY,
        content: CONTENT_PROPERTY,
        type: TYPE_PROPERTY,
        kind: KIND_PROPERTY,
        conflict_key: {
          type: "string",
          maxLength: CONFLICT_KEY_MAX_CHARS,
          pattern: CONFLICT_KEY_PATTERN.source,
        },
        cardinality: { type: "string", enum: [...CARDINALITIES] },
        value_text: { type: "string", maxLength: VALUE_TEXT_MAX_CHARS },
        keywords: KEYWORDS_PROPERTY,
        anchors: ANCHORS_PROPERTY,
        questions: QUESTIONS_PROPERTY,
        scope: SCOPE_PROPERTY,
        abstract: ABSTRACT_PROPERTY,
        resolution: {
          type: "object",
          properties: {
            action: { type: "string", enum: [...RESOLUTION_ACTIONS] },
            target: ID_PROPERTY,
          },
          required: ["action"],
        },
      },
      required: ["title", "content", "type", "kind", "conflict_key"],
    },
    run: memoryStore,
  },
  {
    name: "memory_search",
    description:
      "Search memories by meaning. Returns one-line abstracts; fetch full content with memory_get using the id.",
    inputSchema: {
      type: "object",
      properties: {
        query: CONTENT_PROPERTY,
        limit: { type: "integer", minimum: 1, maximum: SEARCH_LIMIT_MAX },
        type: TYPE_PROPERTY,
        scope: SCOPE_PROPERTY,
      },
      required: ["query"],
    },
    run: memorySearch,
  },
  {
    name: "memory_list",
    description:
      'List memories newest first, without content. For the next page pass next_cursor as before; project "all" lists every project read-only.',
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: [...MEMORY_STATES] },
        kind: KIND_PROPERTY,
        type: TYPE_PROPERTY,
        scope: SCOPE_PROPERTY,
        before: ID_PROPERTY,
        limit: { type: "integer", minimum: 1, maximum: LIST_LIMIT_MAX },
        project: { type: "string", enum: [ALL_PROJECTS] },
      },
    },
    run: memoryList,
  },
  {
    name: "memory_get",
    description:
      "Fetch a memory by id or unique prefix, including content, state, conflict_key, value_text, superseded_by and relations. Superseded memories remain readable.",
    inputSchema: { type: "object", properties: { id: ID_PROPERTY }, required: ["id"] },
    run: memoryGet,
  },
  {
    name: "memory_update",
    description:
      "Update title, abstract, content, keywords, anchors or questions in place; each replaces the stored value whole. Revoked memories are immutable; scope and kind cannot change — re-store, then delete.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID_PROPERTY,
        title: TITLE_PROPERTY,
        abstract: ABSTRACT_PROPERTY,
        content: CONTENT_PROPERTY,
        keywords: KEYWORDS_PROPERTY,
        anchors: ANCHORS_PROPERTY,
        questions: QUESTIONS_PROPERTY,
      },
      required: ["id"],
    },
    run: memoryUpdate,
  },
  {
    name: "memory_delete",
    description: "Delete a memory by id or unique prefix, together with its relations.",
    inputSchema: { type: "object", properties: { id: ID_PROPERTY }, required: ["id"] },
    run: memoryDelete,
  },
  {
    name: "memory_relate",
    description: "Relate two memories explicitly. At most 20 relations per source memory.",
    inputSchema: {
      type: "object",
      properties: {
        source_id: ID_PROPERTY,
        target_id: ID_PROPERTY,
        relation_type: { type: "string", maxLength: RELATION_TYPE_MAX_CHARS },
      },
      required: ["source_id", "target_id", "relation_type"],
    },
    run: memoryRelate,
  },
  {
    name: "memory_feedback",
    description:
      "Once per turn, judge every memory recall injected, ids as printed: used (it informed the work), not_applicable (irrelevant here) or wrong (incorrect or outdated); an omitted id counts as no evidence. A wrong memory leaves recall until a used verdict or a store of it brings it back. A call naming an unknown or revoked id records nothing.",
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        FEEDBACK_VERDICTS.map((verdict) => [
          verdict,
          { type: "array", items: ID_PROPERTY, maxItems: FEEDBACK_IDS_MAX_ITEMS },
        ]),
      ),
    },
    run: memoryFeedback,
  },
  {
    name: "memory_doctor",
    description:
      "Health report covering node, plugin data, database, vec extension, model cache and FTS index.",
    inputSchema: { type: "object", properties: {} },
    run: (deps, _args) => memoryDoctor(deps),
  },
  {
    name: "memory_status",
    description:
      "What the memory holds and does for this project: its id and recall switch, memory counts by state and kind for user scope and this project, transitions by reason, the share of the newest 500 recall events that injected anything, the share of unpinned memories injected in receipt-giving sessions without a used receipt, verdict coverage, open capture signals and the last injections.",
    inputSchema: { type: "object", properties: {} },
    run: (deps, _args) => memoryStatus(deps),
  },
];
