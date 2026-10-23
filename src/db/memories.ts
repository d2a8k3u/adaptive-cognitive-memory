import {
  type AuthoringProblem,
  anchorsProblem,
  keywordsProblem,
  questionsProblem,
  redactedAnchorProblem,
  valueTextProblem,
} from "../authoring";
import { ABSTRACT_MAX_CHARS, CONTENT_MAX_CHARS, TITLE_MAX_CHARS } from "../cfg";
import { embedPassage, embedQuestions, modelCached } from "../embeddings";
import { newId } from "../ids";
import { parseStoredList } from "../keys";
import {
  derivedImportance,
  FRESH_COUNTERS,
  type ReactivationReason,
  reactivation,
} from "../lifecycle";
import {
  addVerdict,
  type Cardinality,
  contentHash,
  type MemoryKind,
  type MemoryScope,
  type MemoryState,
  type MemoryType,
  noopVerdict,
  promotionContributors,
  reactivationVerdict,
  type Slot,
  type SlotRow,
  supersedeVerdict,
  updateVerdict,
  type Verdict,
} from "../policy";
import { redact, redactWithin } from "../redact";
import { anyTermMatchExpression } from "../search";
import type { Db } from "./database";
import { applyTransition } from "./lifecycle";
import { recordTransition, setVecState } from "./transitions";
import { VISIBLE_TO_PROJECT } from "./visibility";

export type { MemoryType };
export type StoreAction = "created" | "superseded" | "updated" | "noop";
export type EmbeddingCoverage = "active" | "all";

export type Resolution =
  | { readonly action: "ADD" }
  | { readonly action: "UPDATE" | "SUPERSEDE" | "NOOP"; readonly target: string };

const CANDIDATE_SOURCE_LIMIT = 10;
const CANDIDATE_FTS_MAX_TERMS = 32;
const UPDATE_ATTEMPTS = 3;

export class MemoryRejection extends Error {}

export interface MemoryEnv {
  db: Db;
  vecLoaded: boolean;
  modelCacheDir: string;
}

export interface StoreInput {
  readonly title: string;
  readonly content: string;
  readonly abstract?: string;
  readonly type: MemoryType;
  readonly kind: MemoryKind;
  readonly conflictKey: string;
  readonly cardinality: Cardinality;
  readonly valueText: string;
  readonly keywords: string;
  readonly anchors: readonly string[];
  readonly questions: readonly string[];
  readonly scope: MemoryScope;
  readonly resolution?: Resolution;
}

export interface StoreResult {
  id: string;
  action: StoreAction;
  refId?: string;
  promotedId?: string;
}

export interface Candidate {
  id: string;
  title: string;
  kind: MemoryKind;
  conflict_key: string;
  cardinality: Cardinality;
  value_text: string;
  valid_from: string | null;
  support_count: number;
  scope: MemoryScope;
}

export type StoreOutcome =
  | { readonly outcome: "written"; readonly result: StoreResult }
  | { readonly outcome: "needs_resolution"; readonly candidates: readonly Candidate[] }
  | { readonly outcome: "rejected"; readonly reason: string };

export interface UpdateInput {
  title?: string;
  abstract?: string;
  content?: string;
  keywords?: string;
  anchors?: readonly string[];
  questions?: readonly string[];
}

export interface MemoryRelation {
  target_id: string;
  relation_type: string;
}

interface MemoryRow {
  id: string;
  type: MemoryType;
  kind: MemoryKind;
  scope: MemoryScope;
  project_id: string;
  title: string;
  abstract: string;
  content: string;
  conflict_key: string;
  cardinality: Cardinality;
  value_text: string;
  keywords: string;
  anchors: string;
  questions: string;
  state: MemoryState;
  importance: number;
  support_count: number;
  valid_from: string | null;
  invalid_at: string | null;
  expired_at: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryRecord extends Omit<MemoryRow, "anchors" | "questions"> {
  anchors: string[];
  questions: string[];
  relations: MemoryRelation[];
}

interface MemoryVectors {
  readonly passage: Float32Array;
  readonly questions: readonly Float32Array[];
}

type UpdatedText = Pick<MemoryRow, "title" | "abstract" | "content">;
type UpdatedKeys = Pick<MemoryRow, "keywords" | "anchors" | "questions">;

const UPDATE_BASIS_COLUMNS = [
  "title",
  "abstract",
  "content",
  "conflict_key",
  "keywords",
  "anchors",
  "questions",
] as const satisfies readonly (keyof MemoryRow)[];

interface PreparedRow extends Slot {
  readonly type: MemoryType;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly abstract: string;
  readonly content: string;
  readonly keywords: string;
  readonly anchors: string;
  readonly questions: readonly string[];
  readonly contentHash: string;
}

export interface PassageFields {
  readonly title: string;
  readonly content: string;
  readonly keywords: string;
}

interface PartitionFilter {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const MEMORY_ROW_COLUMNS = `id, type, kind, scope, project_id, title, abstract, content, conflict_key,
  cardinality, value_text, keywords, anchors, questions, state, importance, support_count, valid_from,
  invalid_at, expired_at, superseded_by, created_at, updated_at`;

const SLOT_ROW_COLUMNS = `id, scope, project_id AS projectId, conflict_key AS conflictKey, cardinality,
  value_text AS valueText, state, kind`;

const EVERY_MEMORY: PartitionFilter = { sql: "TRUE", params: [] };

function storedKeyText(text: string): string {
  return redact(text).text;
}

export const storedKeys = {
  valueText: storedKeyText,
  keywords: storedKeyText,
  anchors: (anchors: readonly string[]): string[] => anchors.map(storedKeyText),
  questions: (questions: readonly string[]): string[] => questions.map(storedKeyText),
} as const;

type KeyProblem = (value: unknown) => AuthoringProblem | undefined;

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isTextList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isText);
}

function asStored<Key>(
  writtenProblem: KeyProblem,
  isKey: (value: unknown) => value is Key,
  storedProblem: (key: Key) => AuthoringProblem | undefined,
): KeyProblem {
  return (value) => {
    const problem = writtenProblem(value);
    if (problem !== undefined) {
      return problem;
    }
    if (!isKey(value)) {
      throw new TypeError("an authoring check accepted a value of the wrong type");
    }
    return storedProblem(value);
  };
}

export const storedKeyProblem = {
  valueText: asStored(valueTextProblem, isText, (text) =>
    valueTextProblem(storedKeys.valueText(text)),
  ),
  keywords: asStored(keywordsProblem, isText, (text) => keywordsProblem(storedKeys.keywords(text))),
  anchors: asStored(anchorsProblem, isTextList, (anchors) =>
    redactedAnchorProblem(anchors, storedKeys.anchors(anchors)),
  ),
  questions: asStored(questionsProblem, isTextList, (questions) =>
    questionsProblem(storedKeys.questions(questions)),
  ),
} as const;

export function deriveAbstract(content: string): string {
  const text = content.trim();
  const sentence = text.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? text;
  return sentence.length > ABSTRACT_MAX_CHARS ? sentence.slice(0, ABSTRACT_MAX_CHARS) : sentence;
}

export function passageText(fields: PassageFields): string {
  const tail = [fields.content, fields.keywords].filter((part) => part !== "");
  return `${fields.title}. ${tail.join(" ")}`;
}

export function resolveMemoryId(db: Db, idOrPrefix: string): string {
  return resolveIdAmong(db, idOrPrefix, EVERY_MEMORY);
}

export function resolveVisibleMemoryId(db: Db, projectId: string, idOrPrefix: string): string {
  return resolveIdAmong(db, idOrPrefix, { sql: VISIBLE_TO_PROJECT, params: [projectId] });
}

function resolveIdAmong(db: Db, idOrPrefix: string, among: PartitionFilter): string {
  if (idOrPrefix.length === 0) {
    throw new Error("memory id or prefix must not be empty");
  }
  const exact = db
    .prepare(`SELECT m.id FROM memories m WHERE m.id = ? AND ${among.sql}`)
    .get(idOrPrefix, ...among.params) as { id: string } | undefined;
  if (exact !== undefined) {
    return exact.id;
  }
  const pattern = `${globLiteral(idOrPrefix)}*`;
  const rows = db
    .prepare(`SELECT m.id FROM memories m WHERE m.id GLOB ? AND ${among.sql} ORDER BY m.id`)
    .all(pattern, ...among.params) as { id: string }[];
  const [exactMatch] = rows;
  if (rows.length === 1 && exactMatch) {
    return exactMatch.id;
  }
  if (rows.length === 0) {
    throw new MemoryRejection(`memory not found: ${idOrPrefix}`);
  }
  throw new MemoryRejection(
    `ambiguous memory id or prefix '${idOrPrefix}' matches ${rows.length} memories`,
  );
}

export async function store(
  env: MemoryEnv,
  input: StoreInput,
  projectId: string,
): Promise<StoreOutcome> {
  const row = prepareRow(input, projectId);
  const vectors = await embedForStore(env, {
    passage: passageText(row),
    questions: row.questions,
  });
  const write = env.db.transaction(
    (): StoreOutcome => resolveWrite(env, row, vectors, input.resolution, nowIso()),
  );
  return write.immediate();
}

export function get(env: MemoryEnv, idOrPrefix: string): MemoryRecord {
  const id = resolveMemoryId(env.db, idOrPrefix);
  const { anchors, questions, ...row } = fetchMemoryRow(env.db, id);
  const relations = env.db
    .prepare(
      "SELECT target_id, relation_type FROM relations WHERE source_id = ? ORDER BY target_id, relation_type",
    )
    .all(id) as MemoryRelation[];
  return {
    ...row,
    anchors: parseStoredList(id, "anchors", anchors),
    questions: parseStoredList(id, "questions", questions),
    relations,
  };
}

export async function updateMemory(
  env: MemoryEnv,
  idOrPrefix: string,
  input: UpdateInput,
): Promise<MemoryRecord> {
  const id = resolveMemoryId(env.db, idOrPrefix);
  for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
    if (await updateFromSnapshot(env, fetchMemoryRow(env.db, id), input)) {
      return get(env, id);
    }
  }
  throw new MemoryRejection(
    `memory ${id} changed during each of ${UPDATE_ATTEMPTS} update attempts; nothing was written, retry the update`,
  );
}

function updatedText(row: MemoryRow, input: UpdateInput): UpdatedText {
  const content =
    input.content === undefined ? row.content : redactWithin(input.content, CONTENT_MAX_CHARS);
  const abstract =
    input.abstract !== undefined
      ? redactWithin(input.abstract, ABSTRACT_MAX_CHARS)
      : input.content === undefined
        ? row.abstract
        : deriveAbstract(content);
  return {
    title: input.title === undefined ? row.title : redactWithin(input.title, TITLE_MAX_CHARS),
    abstract,
    content,
  };
}

function updatedKeys(row: MemoryRow, input: UpdateInput): UpdatedKeys {
  return {
    keywords: input.keywords === undefined ? row.keywords : storedKeys.keywords(input.keywords),
    anchors:
      input.anchors === undefined ? row.anchors : JSON.stringify(storedKeys.anchors(input.anchors)),
    questions:
      input.questions === undefined
        ? row.questions
        : JSON.stringify(storedKeys.questions(input.questions)),
  };
}

function vectorsEdited(input: UpdateInput): boolean {
  return (
    input.title !== undefined ||
    input.content !== undefined ||
    input.keywords !== undefined ||
    input.questions !== undefined
  );
}

function sameUpdateBasis(current: MemoryRow, snapshot: MemoryRow): boolean {
  return UPDATE_BASIS_COLUMNS.every((column) => current[column] === snapshot[column]);
}

async function updateFromSnapshot(
  env: MemoryEnv,
  snapshot: MemoryRow,
  input: UpdateInput,
): Promise<boolean> {
  const text = updatedText(snapshot, input);
  const keys = updatedKeys(snapshot, input);
  const reembed = vectorsEdited(input);
  const vectors = reembed
    ? await embedForStore(env, {
        passage: passageText({ ...text, keywords: keys.keywords }),
        questions: parseStoredList(snapshot.id, "questions", keys.questions),
      })
    : undefined;
  const txn = env.db.transaction((): boolean => {
    const current = fetchMemoryRow(env.db, snapshot.id);
    if (current.state === "revoked") {
      throw new MemoryRejection(`memory ${snapshot.id} is revoked and immutable`);
    }
    if (!sameUpdateBasis(current, snapshot)) {
      return false;
    }
    env.db
      .prepare(
        `UPDATE memories SET title = ?, abstract = ?, content = ?, keywords = ?, anchors = ?,
           questions = ?, content_hash = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        text.title,
        text.abstract,
        text.content,
        keys.keywords,
        keys.anchors,
        keys.questions,
        contentHash(text.content),
        nowIso(),
        current.id,
      );
    if (reembed) {
      replaceVectors(env, current, vectors);
    }
    return true;
  });
  return txn.immediate();
}

export async function embedMissing(
  env: MemoryEnv,
  limit: number,
  coverage: EmbeddingCoverage,
): Promise<number> {
  const rows = unembeddedRows(env.db, limit, coverage);
  if (rows.length === 0) {
    return 0;
  }
  const vectors = await embedBatch(
    env.modelCacheDir,
    rows.map((row) => ({
      passage: passageText(row),
      questions: parseStoredList(row.id, "questions", row.questions),
    })),
  );
  const write = env.db.transaction((): number => {
    let embedded = 0;
    rows.forEach((row, index) => {
      const current = unembeddedRow(env.db, row.id, coverage);
      const rowVectors = vectors[index];
      if (
        current === undefined ||
        rowVectors === undefined ||
        passageText(current) !== passageText(row) ||
        current.questions !== row.questions
      ) {
        return;
      }
      insertVectors(env.db, current, rowVectors);
      embedded += 1;
    });
    return embedded;
  });
  return write.immediate();
}

export function deleteMemory(env: MemoryEnv, idOrPrefix: string): { deleted: true } {
  const id = resolveMemoryId(env.db, idOrPrefix);
  const txn = env.db.transaction(() => {
    const superseded = env.db
      .prepare("SELECT id FROM memories WHERE superseded_by = ? ORDER BY id")
      .pluck()
      .all(id) as string[];
    if (superseded.length > 0) {
      const history = superseded.join(", ");
      throw new MemoryRejection(
        `memory ${id} cannot be deleted: it is the superseded_by of ${history}; delete ${history} first to drop that history, or keep ${id} and replace its value with memory_store resolution SUPERSEDE`,
      );
    }
    if (env.vecLoaded) {
      deleteVectors(env.db, id);
    }
    env.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  });
  txn.immediate();
  return { deleted: true };
}

function prepareRow(input: StoreInput, projectId: string): PreparedRow {
  const content = redactWithin(input.content, CONTENT_MAX_CHARS);
  return {
    type: input.type,
    kind: input.kind,
    scope: input.scope,
    projectId,
    conflictKey: input.conflictKey,
    cardinality: input.cardinality,
    valueText: storedKeys.valueText(input.valueText),
    title: redactWithin(input.title, TITLE_MAX_CHARS),
    abstract:
      input.abstract === undefined
        ? deriveAbstract(content)
        : redactWithin(input.abstract, ABSTRACT_MAX_CHARS),
    content,
    keywords: storedKeys.keywords(input.keywords),
    anchors: JSON.stringify(storedKeys.anchors(input.anchors)),
    questions: storedKeys.questions(input.questions),
    contentHash: contentHash(content),
  };
}

function resolveWrite(
  env: MemoryEnv,
  row: PreparedRow,
  vectors: MemoryVectors | undefined,
  resolution: Resolution | undefined,
  now: string,
): StoreOutcome {
  if (resolution === undefined || resolution.action === "ADD") {
    const duplicate = exactDuplicate(env.db, row);
    if (duplicate !== undefined) {
      return guarded(reactivationGuard(env.db, duplicate), () =>
        reasserted(env, duplicate, "store_noop", row.title, now, () =>
          countSupport(env.db, duplicate.id),
        ),
      );
    }
  }
  if (resolution === undefined) {
    const candidates = writeCandidates(env, row, vectors);
    if (candidates.length > 0) {
      return { outcome: "needs_resolution", candidates };
    }
    return written(addMemory(env, row, vectors, now));
  }
  if (resolution.action === "ADD") {
    return guarded(addVerdict(row, singleKeyHolders(env.db, row)), () =>
      addMemory(env, row, vectors, now),
    );
  }
  const target = slotRow(env.db, resolveMemoryId(env.db, resolution.target));
  switch (resolution.action) {
    case "SUPERSEDE":
      return guarded(supersedeVerdict(row, target), () =>
        supersede(env, row, vectors, target, now),
      );
    case "UPDATE":
      return guarded(reassertionVerdict(env.db, updateVerdict(row, target), target), () =>
        reasserted(env, target, "store_update", row.title, now, () =>
          rewrite(env, row, vectors, target.id, now),
        ),
      );
    case "NOOP":
      return guarded(reassertionVerdict(env.db, noopVerdict(row, target), target), () =>
        reasserted(env, target, "store_noop", row.title, now, () =>
          countSupport(env.db, target.id),
        ),
      );
  }
}

function reactivationGuard(db: Db, target: SlotRow): Verdict {
  return reactivationVerdict(target, singleKeyHolders(db, target));
}

function reassertionVerdict(db: Db, resolutionVerdict: Verdict, target: SlotRow): Verdict {
  return resolutionVerdict.allowed ? reactivationGuard(db, target) : resolutionVerdict;
}

function reasserted(
  env: MemoryEnv,
  target: SlotRow,
  reason: ReactivationReason,
  evidence: string,
  now: string,
  write: () => StoreResult,
): StoreResult {
  const transition = reactivation(target.state, reason, evidence);
  if (transition !== undefined) {
    applyTransition(env, target.id, target.state, transition, now);
  }
  return write();
}

function written(result: StoreResult): StoreOutcome {
  return { outcome: "written", result };
}

function guarded(verdict: Verdict, write: () => StoreResult): StoreOutcome {
  return verdict.allowed ? written(write()) : { outcome: "rejected", reason: verdict.reason };
}

function addMemory(
  env: MemoryEnv,
  row: PreparedRow,
  vectors: MemoryVectors | undefined,
  now: string,
): StoreResult {
  const id = insertMemory(env, row, vectors, now);
  return withPromotion({ id, action: "created" }, promote(env, id, row, vectors, now));
}

function supersede(
  env: MemoryEnv,
  row: PreparedRow,
  vectors: MemoryVectors | undefined,
  target: SlotRow,
  now: string,
): StoreResult {
  env.db
    .prepare(
      "UPDATE memories SET state = 'revoked', invalid_at = ?, expired_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(now, now, now, target.id);
  const id = insertMemory(env, row, vectors, now);
  env.db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(id, target.id);
  recordTransition(env.db, {
    memoryId: target.id,
    fromState: "active",
    toState: "revoked",
    reason: "superseded",
    evidence: row.valueText,
    relatedId: id,
    at: now,
  });
  setVecState(env, target.id, "revoked");
  return withPromotion(
    { id, action: "superseded", refId: target.id },
    promote(env, id, row, vectors, now),
  );
}

function rewrite(
  env: MemoryEnv,
  row: PreparedRow,
  vectors: MemoryVectors | undefined,
  targetId: string,
  now: string,
): StoreResult {
  env.db
    .prepare(
      `UPDATE memories SET title = ?, abstract = ?, content = ?, value_text = ?, keywords = ?,
         anchors = ?, questions = ?, kind = ?, content_hash = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      row.title,
      row.abstract,
      row.content,
      row.valueText,
      row.keywords,
      row.anchors,
      JSON.stringify(row.questions),
      row.kind,
      row.contentHash,
      now,
      targetId,
    );
  replaceVectors(env, fetchMemoryRow(env.db, targetId), vectors);
  return withPromotion(
    { id: targetId, action: "updated" },
    promote(env, targetId, row, vectors, now),
  );
}

function countSupport(db: Db, id: string): StoreResult {
  db.prepare("UPDATE memories SET support_count = support_count + 1 WHERE id = ?").run(id);
  return { id, action: "noop" };
}

function promote(
  env: MemoryEnv,
  writtenId: string,
  row: PreparedRow,
  vectors: MemoryVectors | undefined,
  now: string,
): string | undefined {
  const writtenSlot: SlotRow = { ...row, id: writtenId, state: "active" };
  const contributors = promotionContributors(writtenSlot, keyHolders(env.db, row.conflictKey));
  if (contributors.length === 0) {
    return undefined;
  }
  const userId = insertMemory(env, { ...row, scope: "user" }, vectors, now);
  for (const contributor of contributors) {
    recordTransition(env.db, {
      memoryId: contributor.id,
      fromState: "active",
      toState: "active",
      reason: "promoted",
      evidence: row.valueText,
      relatedId: userId,
      at: now,
    });
  }
  return userId;
}

function withPromotion(result: StoreResult, promotedId: string | undefined): StoreResult {
  return promotedId === undefined ? result : { ...result, promotedId };
}

function insertMemory(
  env: MemoryEnv,
  row: PreparedRow,
  vectors: MemoryVectors | undefined,
  now: string,
): string {
  const id = newId();
  env.db
    .prepare(
      `INSERT INTO memories (id, type, kind, scope, project_id, title, abstract, content, conflict_key,
         cardinality, value_text, keywords, anchors, questions, content_hash, importance, valid_from,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      row.type,
      row.kind,
      row.scope,
      row.projectId,
      row.title,
      row.abstract,
      row.content,
      row.conflictKey,
      row.cardinality,
      row.valueText,
      row.keywords,
      row.anchors,
      JSON.stringify(row.questions),
      row.contentHash,
      derivedImportance(FRESH_COUNTERS),
      now,
      now,
      now,
    );
  if (vectors !== undefined) {
    insertVectors(
      env.db,
      { id, type: row.type, scope: row.scope, project_id: row.projectId, state: "active" },
      vectors,
    );
  }
  return id;
}

interface VecRowFields {
  readonly id: string;
  readonly type: MemoryType;
  readonly scope: MemoryScope;
  readonly project_id: string;
  readonly state: MemoryState;
}

function insertVectors(db: Db, fields: VecRowFields, vectors: MemoryVectors): void {
  db.prepare(
    "INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id, state) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    fields.id,
    vecBlob(vectors.passage),
    fields.type,
    fields.scope,
    fields.project_id,
    fields.state,
  );
  const insertQuestion = db.prepare(
    `INSERT INTO questions_vec (question_id, embedding, memory_id, scope, project_id, state)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  vectors.questions.forEach((vector, index) => {
    insertQuestion.run(
      `${fields.id}:${index}`,
      vecBlob(vector),
      fields.id,
      fields.scope,
      fields.project_id,
      fields.state,
    );
  });
}

function deleteVectors(db: Db, memoryId: string): void {
  db.prepare("DELETE FROM memories_vec WHERE memory_id = ?").run(memoryId);
  db.prepare("DELETE FROM questions_vec WHERE memory_id = ?").run(memoryId);
}

function replaceVectors(
  env: MemoryEnv,
  fields: VecRowFields,
  vectors: MemoryVectors | undefined,
): void {
  if (!env.vecLoaded) {
    return;
  }
  deleteVectors(env.db, fields.id);
  if (vectors !== undefined) {
    insertVectors(env.db, fields, vectors);
  }
}

function partitionFilter(slot: Slot, alias = ""): PartitionFilter {
  return slot.scope === "user"
    ? { sql: `${alias}scope = 'user'`, params: [] }
    : { sql: `${alias}scope = 'project' AND ${alias}project_id = ?`, params: [slot.projectId] };
}

function exactDuplicate(db: Db, row: PreparedRow): SlotRow | undefined {
  const partition = partitionFilter(row);
  return db
    .prepare(
      `SELECT ${SLOT_ROW_COLUMNS} FROM memories
       WHERE content_hash = ? AND state IN ('active', 'hypothesis') AND ${partition.sql}
       ORDER BY state = 'active' DESC LIMIT 1`,
    )
    .get(row.contentHash, ...partition.params) as SlotRow | undefined;
}

function writeCandidates(
  env: MemoryEnv,
  row: PreparedRow,
  vectors: MemoryVectors | undefined,
): Candidate[] {
  const ids = new Set([
    ...sameKeyIds(env.db, row),
    ...(vectors === undefined ? [] : neighbourIds(env.db, row, vectors.passage)),
    ...keywordHitIds(env.db, row),
  ]);
  return candidatesByIds(env.db, [...ids]);
}

function sameKeyIds(db: Db, row: PreparedRow): string[] {
  const partition = partitionFilter(row);
  const rows = db
    .prepare(
      `SELECT id FROM memories
       WHERE conflict_key = ? AND state = 'active' AND ${partition.sql}
       ORDER BY created_at LIMIT ?`,
    )
    .all(row.conflictKey, ...partition.params, CANDIDATE_SOURCE_LIMIT) as { id: string }[];
  return rows.map((hit) => hit.id);
}

function neighbourIds(db: Db, row: PreparedRow, embedding: Float32Array): string[] {
  const partition = partitionFilter(row);
  const rows = db
    .prepare(
      `SELECT memory_id FROM memories_vec
       WHERE state = 'active' AND ${partition.sql} AND embedding MATCH ? AND k = ?`,
    )
    .all(...partition.params, vecBlob(embedding), CANDIDATE_SOURCE_LIMIT) as {
    memory_id: string;
  }[];
  return rows.map((hit) => hit.memory_id);
}

function keywordHitIds(db: Db, row: PreparedRow): string[] {
  const match = anyTermMatchExpression(
    [row.title, row.abstract, row.keywords, row.valueText],
    CANDIDATE_FTS_MAX_TERMS,
  );
  if (match === "") {
    return [];
  }
  const partition = partitionFilter(row, "m.");
  const rows = db
    .prepare(
      `SELECT m.id AS id FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.state = 'active' AND ${partition.sql}
       ORDER BY rank LIMIT ?`,
    )
    .all(match, ...partition.params, CANDIDATE_SOURCE_LIMIT) as { id: string }[];
  return rows.map((hit) => hit.id);
}

function candidatesByIds(db: Db, ids: readonly string[]): Candidate[] {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, title, kind, conflict_key, cardinality, value_text, valid_from, support_count, scope
       FROM memories WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Candidate[];
  const byId = new Map(rows.map((candidate) => [candidate.id, candidate]));
  return ids.flatMap((id) => {
    const candidate = byId.get(id);
    return candidate === undefined ? [] : [candidate];
  });
}

export function singleKeyHolders(db: Db, row: Slot): SlotRow[] {
  const partition = partitionFilter(row);
  return db
    .prepare(
      `SELECT ${SLOT_ROW_COLUMNS} FROM memories
       WHERE conflict_key = ? AND cardinality = 'single' AND state = 'active' AND ${partition.sql}`,
    )
    .all(row.conflictKey, ...partition.params) as SlotRow[];
}

function keyHolders(db: Db, conflictKey: string): SlotRow[] {
  return db
    .prepare(`SELECT ${SLOT_ROW_COLUMNS} FROM memories WHERE conflict_key = ? AND state = 'active'`)
    .all(conflictKey) as SlotRow[];
}

interface UnembeddedRow extends VecRowFields {
  readonly title: string;
  readonly content: string;
  readonly keywords: string;
  readonly questions: string;
}

const UNEMBEDDED_ROW_SELECT = `SELECT m.id, m.type, m.scope, m.project_id, m.state, m.title, m.content,
    m.keywords, m.questions
  FROM memories m
  WHERE NOT EXISTS (SELECT 1 FROM memories_vec v WHERE v.memory_id = m.id)
    AND (? = 'all' OR m.state = 'active')`;

export function unembeddedActiveCount(db: Db): number {
  return db
    .prepare(`SELECT count(*) FROM (${UNEMBEDDED_ROW_SELECT})`)
    .pluck()
    .get("active") as number;
}

function unembeddedRows(db: Db, limit: number, coverage: EmbeddingCoverage): UnembeddedRow[] {
  return db
    .prepare(`${UNEMBEDDED_ROW_SELECT} ORDER BY m.rowid LIMIT ?`)
    .all(coverage, limit) as UnembeddedRow[];
}

function unembeddedRow(db: Db, id: string, coverage: EmbeddingCoverage): UnembeddedRow | undefined {
  return db.prepare(`${UNEMBEDDED_ROW_SELECT} AND m.id = ?`).get(coverage, id) as
    | UnembeddedRow
    | undefined;
}

export function slotRow(db: Db, id: string): SlotRow {
  const row = db.prepare(`SELECT ${SLOT_ROW_COLUMNS} FROM memories WHERE id = ?`).get(id) as
    | SlotRow
    | undefined;
  if (row === undefined) {
    throw new Error(`memory not found: ${id}`);
  }
  return row;
}

interface EmbeddingSource {
  readonly passage: string;
  readonly questions: readonly string[];
}

function vectorCountGuard(kind: string, expected: number, actual: number): void {
  if (actual !== expected) {
    throw new Error(`embedding ${expected} ${kind} produced ${actual} vectors`);
  }
}

async function embedBatch(
  modelCacheDir: string,
  sources: readonly EmbeddingSource[],
): Promise<MemoryVectors[]> {
  const passages = await embedPassage(
    sources.map((source) => source.passage),
    modelCacheDir,
  );
  vectorCountGuard("passages", sources.length, passages.length);
  const questionTexts = sources.flatMap((source) => source.questions);
  const questions =
    questionTexts.length === 0 ? [] : await embedQuestions(questionTexts, modelCacheDir);
  vectorCountGuard("questions", questionTexts.length, questions.length);
  let next = 0;
  return sources.map((source, index) => {
    const own = questions.slice(next, next + source.questions.length);
    next += source.questions.length;
    return { passage: passages[index] as Float32Array, questions: own };
  });
}

async function embedForStore(
  env: MemoryEnv,
  source: EmbeddingSource,
): Promise<MemoryVectors | undefined> {
  if (!env.vecLoaded || !modelCached(env.modelCacheDir)) {
    return undefined;
  }
  const [vectors] = await embedBatch(env.modelCacheDir, [source]);
  return vectors;
}

function fetchMemoryRow(db: Db, id: string): MemoryRow {
  const row = db.prepare(`SELECT ${MEMORY_ROW_COLUMNS} FROM memories WHERE id = ?`).get(id) as
    | MemoryRow
    | undefined;
  if (row === undefined) {
    throw new MemoryRejection(`memory not found: ${id}`);
  }
  return row;
}

function globLiteral(value: string): string {
  return value.replace(/[*?[]/g, (character) => `[${character}]`);
}

function vecBlob(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function nowIso(): string {
  return new Date().toISOString();
}
