import { EMBED_DEADLINE_MS } from "./cfg";
import type { Db } from "./db/database";
import { clearEmbeddingTimeout, recordEmbeddingTimeout } from "./db/health";
import { VISIBLE_TO_PROJECT } from "./db/visibility";
import { DeadlineExceededError, embedQuery, modelCached, withDeadline } from "./embeddings";
import type { PromptCandidate, RecalledMemory, ToolCandidate } from "./gate";
import { minLineTokens } from "./inject";
import { anchorHit, keyHit, type MemoryKeys, parseStoredList, type ToolLookup } from "./keys";
import type { Epistemic, MemoryKind, MemoryScope, MemoryType } from "./policy";
import { distinctWords } from "./prompt";
import { PINNED_KINDS, type PinnedCandidate } from "./session";

export interface RecallRow {
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  importance: number;
  abstract: string;
  score: number;
}

export interface DegradedFlags {
  model?: boolean;
  vec?: boolean;
  embedding_timeout?: boolean;
}

type QueryEmbedding =
  | { readonly vector: Float32Array; readonly degraded?: undefined }
  | { readonly vector?: undefined; readonly degraded: DegradedFlags };

export interface RecallOptions {
  projectId: string;
  modelCacheDir: string;
  query: string;
  limit?: number;
  type?: MemoryType;
  scope?: MemoryScope;
  ftsOnly?: boolean;
}

export interface RecallResult {
  rows: RecallRow[];
  degraded?: DegradedFlags;
}

export interface RecallSource {
  db: Db;
  vecLoaded: boolean;
}

export interface PinnedRequest {
  readonly projectId: string;
  readonly now: string;
}

export interface EarlierRequest {
  readonly sessionId: string;
  readonly projectId: string;
  readonly now: string;
}

export interface TicketRequest {
  readonly projectId: string;
  readonly ticket: string;
  readonly now: string;
  readonly limit: number;
}

export interface PromptRequest {
  readonly projectId: string;
  readonly modelCacheDir: string;
  readonly prompt: string;
  readonly tokens: readonly string[];
  readonly now: string;
}

export interface PromptCandidates {
  readonly candidates: readonly PromptCandidate[];
  readonly neighbourhood: readonly number[];
  readonly degraded: DegradedFlags | undefined;
}

export interface ToolRequest {
  readonly projectId: string;
  readonly lookup: ToolLookup;
  readonly keywordSignal: boolean;
  readonly now: string;
}

export const DEFAULT_RECALL_LIMIT = 10;
export const TICKET_ROWS_MAX = 3;

const RRF_K = 60;
const FTS_QUERY_MAX_TERMS = 32;
const KNN_LIMIT = 10;
const QUESTION_KNN_LIMIT = 40;
const FTS_HYBRID_LIMIT = 10;
const FTS_CANDIDATE_LIMIT = 20;
const ACTIVE_STATE = "active";
const RECALLABLE_ROW = "state = 'active' AND (invalid_at IS NULL OR invalid_at > ?)";
const RECALLABLE_MEMORY = "m.state = 'active' AND (m.invalid_at IS NULL OR m.invalid_at > ?)";
const KEY_COLUMNS_FILTER = "{conflict_key keywords}";
const TICKET_COLUMNS_FILTER = "{keywords}";
const MEMORY_FIELDS = `m.id, m.kind, m.epistemic, m.scope, m.abstract,
  COALESCE(m.valid_from, m.created_at) AS validFrom, m.conflict_key AS conflictKey, m.keywords,
  m.anchors`;

interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  importance: number;
  abstract: string;
}

interface StoredMemory {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly epistemic: Epistemic;
  readonly scope: MemoryScope;
  readonly abstract: string;
  readonly validFrom: string;
  readonly conflictKey: string;
  readonly keywords: string;
  readonly anchors: string;
}

interface KnnFilter {
  scope: MemoryScope;
  projectId?: string;
  type?: MemoryType;
}

interface KnnHit {
  readonly id: string;
  readonly distance: number;
}

interface FtsHit {
  readonly id: string;
  readonly rank: number;
}

interface FtsFilter {
  readonly projectId: string;
  readonly scope?: MemoryScope;
  readonly type?: MemoryType;
}

export function sessionStartLimit(budgetTokens: number): number {
  return Math.max(1, Math.ceil(budgetTokens / minLineTokens()));
}

function terms(text: string): string[] {
  return text.split(/\s+/).filter((term) => term.length > 0);
}

function ftsPhrase(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

export function anyTermMatchExpression(texts: readonly string[], maxTerms: number): string {
  const byFoldedTerm = new Map<string, string>();
  for (const term of texts.flatMap(terms)) {
    const folded = term.toLowerCase();
    if (!byFoldedTerm.has(folded)) {
      byFoldedTerm.set(folded, term);
    }
  }
  return [...byFoldedTerm.values()].slice(0, maxTerms).map(ftsPhrase).join(" OR ");
}

export function ftsMatchExpression(query: string): string {
  return anyTermMatchExpression(distinctWords(query), FTS_QUERY_MAX_TERMS);
}

export function rrfFuse(rankings: readonly (readonly string[])[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }
  return scores;
}

function environmentDegradation(
  source: RecallSource,
  modelCacheDir: string,
): DegradedFlags | undefined {
  const flags: DegradedFlags = {};
  if (!source.vecLoaded) {
    flags.vec = true;
  }
  if (!modelCached(modelCacheDir)) {
    flags.model = true;
  }
  return flags.vec || flags.model ? flags : undefined;
}

async function queryEmbedding(query: string, modelCacheDir: string): Promise<QueryEmbedding> {
  try {
    return { vector: await withDeadline(embedQuery(query, modelCacheDir), EMBED_DEADLINE_MS) };
  } catch (error) {
    return {
      degraded:
        error instanceof DeadlineExceededError ? { embedding_timeout: true } : { model: true },
    };
  }
}

function recordPromptEmbedding(db: Db, embedded: QueryEmbedding, at: string): void {
  if (embedded.vector !== undefined) {
    clearEmbeddingTimeout(db);
  } else if (embedded.degraded.embedding_timeout === true) {
    recordEmbeddingTimeout(db, at);
  }
}

export async function recall(opened: RecallSource, options: RecallOptions): Promise<RecallResult> {
  const now = new Date().toISOString();
  const degraded = environmentDegradation(opened, options.modelCacheDir);
  if (options.ftsOnly || degraded !== undefined) {
    return { rows: ftsRecall(opened.db, options, now), degraded };
  }
  const embedded = await queryEmbedding(options.query, options.modelCacheDir);
  if (embedded.vector === undefined) {
    return { rows: ftsRecall(opened.db, options, now), degraded: embedded.degraded };
  }
  return { rows: hybridRecall(opened.db, options, embedded.vector, now) };
}

export function pinnedCandidates(db: Db, request: PinnedRequest): PinnedCandidate[] {
  const kinds = PINNED_KINDS.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT ${MEMORY_FIELDS}, m.importance, m.created_at AS createdAt,
         COALESCE(m.last_injected_at, m.created_at) AS lastActivityAt
       FROM memories m
       WHERE ${RECALLABLE_MEMORY} AND ${VISIBLE_TO_PROJECT} AND m.kind IN (${kinds})`,
    )
    .all(request.now, request.projectId, ...PINNED_KINDS) as PinnedCandidate[];
}

export function sessionEarlierMemories(db: Db, request: EarlierRequest): RecalledMemory[] {
  return db
    .prepare(
      `SELECT ${MEMORY_FIELDS} FROM memories m
       JOIN (SELECT memory_id, max(at) AS lastAt FROM injections WHERE session_id = ?
             GROUP BY memory_id) s ON s.memory_id = m.id
       WHERE ${RECALLABLE_MEMORY} AND ${VISIBLE_TO_PROJECT}
       ORDER BY s.lastAt DESC, m.id`,
    )
    .all(request.sessionId, request.now, request.projectId) as StoredMemory[];
}

export function ticketCandidates(db: Db, request: TicketRequest): RecalledMemory[] {
  return db
    .prepare(
      `SELECT ${MEMORY_FIELDS} FROM memories m
       WHERE ${RECALLABLE_MEMORY} AND ${VISIBLE_TO_PROJECT}
         AND (${anchorMembership(1)}
              OR m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?))
       ORDER BY m.importance DESC, m.id
       LIMIT ?`,
    )
    .all(
      request.now,
      request.projectId,
      request.ticket,
      `${TICKET_COLUMNS_FILTER} : ${ftsPhrase(request.ticket)}`,
      request.limit,
    ) as StoredMemory[];
}

export async function promptCandidates(
  source: RecallSource,
  request: PromptRequest,
): Promise<PromptCandidates> {
  const filter: FtsFilter = { projectId: request.projectId };
  const match = anyTermMatchExpression(request.tokens, FTS_QUERY_MAX_TERMS);
  const ranks = new Map(
    match === ""
      ? []
      : ftsHits(source.db, match, filter, FTS_CANDIDATE_LIMIT, request.now).map((hit) => [
          hit.id,
          hit.rank,
        ]),
  );
  const environment = environmentDegradation(source, request.modelCacheDir);
  const embedded =
    environment === undefined
      ? await queryEmbedding(request.prompt, request.modelCacheDir)
      : undefined;
  if (embedded !== undefined) {
    recordPromptEmbedding(source.db, embedded, request.now);
  }
  const degraded = environment ?? embedded?.degraded;
  const vector = embedded?.vector;
  const cosines = closestCosines(
    vector === undefined
      ? []
      : [
          ...ownPartitionKnn(source.db, vector, request.projectId),
          ...ownPartitionQuestionKnn(source.db, vector, request.projectId),
        ],
  );
  const tokens = new Set(request.tokens);
  const candidates = memoriesByIds(
    source.db,
    [...cosines.keys(), ...ranks.keys()],
    request.now,
  ).map((memory) => ({
    ...recalledMemory(memory),
    cosine: cosines.get(memory.id),
    ftsRank: ranks.get(memory.id),
    keyHit: keyHit(tokens, memoryKeys(memory)),
  }));
  return { candidates, neighbourhood: [...cosines.values()], degraded };
}

export function toolCandidates(db: Db, request: ToolRequest): ToolCandidate[] {
  const lookup = new Set(request.lookup.anchors);
  const tokens = new Set(request.lookup.tokens);
  const anchored = anchoredIds(db, request);
  const keyed = request.keywordSignal ? keywordIds(db, request) : [];
  return memoriesByIds(db, [...anchored, ...keyed], request.now).map((memory) => {
    const keys = memoryKeys(memory);
    return {
      ...recalledMemory(memory),
      anchorHit: anchorHit(keys.anchors, lookup),
      keyHit: keyHit(tokens, keys),
    };
  });
}

function recalledMemory(memory: StoredMemory): RecalledMemory {
  return {
    id: memory.id,
    kind: memory.kind,
    epistemic: memory.epistemic,
    scope: memory.scope,
    abstract: memory.abstract,
    validFrom: memory.validFrom,
  };
}

function memoryKeys(memory: StoredMemory): MemoryKeys {
  return {
    conflictKey: memory.conflictKey,
    keywords: memory.keywords,
    anchors: parseStoredList(memory.id, "anchors", memory.anchors),
  };
}

function memoriesByIds(db: Db, ids: readonly string[], now: string): StoredMemory[] {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) {
    return [];
  }
  const placeholders = distinct.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT ${MEMORY_FIELDS} FROM memories m
       WHERE ${RECALLABLE_MEMORY} AND m.id IN (${placeholders}) ORDER BY m.id`,
    )
    .all(now, ...distinct) as StoredMemory[];
}

function anchorMembership(anchorCount: number): string {
  const placeholders = Array.from({ length: anchorCount }, () => "?").join(", ");
  return `EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(m.anchors) THEN m.anchors ELSE '[]' END)
    WHERE value IN (${placeholders})
  )`;
}

function anchoredIds(db: Db, request: ToolRequest): string[] {
  const keys = request.lookup.anchors;
  if (keys.length === 0) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT m.id FROM memories m
       WHERE ${RECALLABLE_MEMORY} AND ${VISIBLE_TO_PROJECT} AND ${anchorMembership(keys.length)}`,
    )
    .all(request.now, request.projectId, ...keys) as { id: string }[];
  return rows.map((row) => row.id);
}

function keywordIds(db: Db, request: ToolRequest): string[] {
  const match = anyTermMatchExpression(request.lookup.tokens, FTS_QUERY_MAX_TERMS);
  if (match === "") {
    return [];
  }
  return ftsHits(
    db,
    `${KEY_COLUMNS_FILTER} : (${match})`,
    { projectId: request.projectId },
    FTS_CANDIDATE_LIMIT,
    request.now,
  ).map((hit) => hit.id);
}

function ownPartitionKnn(db: Db, vector: Float32Array, projectId: string): KnnHit[] {
  return [
    ...knnHits(db, vector, { scope: "user" }),
    ...knnHits(db, vector, { scope: "project", projectId }),
  ];
}

function ownPartitionQuestionKnn(db: Db, vector: Float32Array, projectId: string): KnnHit[] {
  const nearest = (partition: string, params: readonly unknown[]) =>
    db
      .prepare(
        `SELECT memory_id AS id, distance FROM questions_vec
         WHERE state = ? AND ${partition} AND embedding MATCH ? AND k = ?`,
      )
      .all(
        ACTIVE_STATE,
        ...params,
        JSON.stringify(Array.from(vector)),
        QUESTION_KNN_LIMIT,
      ) as KnnHit[];
  return [
    ...nearest("scope = 'user'", []),
    ...nearest("scope = 'project' AND project_id = ?", [projectId]),
  ];
}

function closestCosines(hits: readonly KnnHit[]): Map<string, number> {
  const closest = new Map<string, number>();
  for (const hit of hits) {
    const cosine = 1 - hit.distance;
    if (cosine > (closest.get(hit.id) ?? Number.NEGATIVE_INFINITY)) {
      closest.set(hit.id, cosine);
    }
  }
  return closest;
}

function ftsRecall(db: Db, options: RecallOptions, now: string): RecallRow[] {
  const match = ftsMatchExpression(options.query);
  if (match === "") {
    return [];
  }
  const limit = options.limit ?? DEFAULT_RECALL_LIMIT;
  const ids = ftsHits(db, match, options, limit, now).map((hit) => hit.id);
  return fetchRanked(db, topRanked(rrfFuse([ids]), limit), now);
}

function hybridRecall(
  db: Db,
  options: RecallOptions,
  vector: Float32Array,
  now: string,
): RecallRow[] {
  const rankings: string[][] = [];
  if (options.scope !== "project") {
    rankings.push(knnHits(db, vector, { scope: "user", type: options.type }).map((hit) => hit.id));
  }
  if (options.scope !== "user") {
    rankings.push(
      knnHits(db, vector, {
        scope: "project",
        projectId: options.projectId,
        type: options.type,
      }).map((hit) => hit.id),
    );
  }
  const match = ftsMatchExpression(options.query);
  if (match !== "") {
    rankings.push(ftsHits(db, match, options, FTS_HYBRID_LIMIT, now).map((hit) => hit.id));
  }
  return fetchRanked(db, topRanked(rrfFuse(rankings), options.limit ?? DEFAULT_RECALL_LIMIT), now);
}

function knnHits(db: Db, vector: Float32Array, filter: KnnFilter): KnnHit[] {
  const clauses: string[] = ["state = ?"];
  const params: unknown[] = [ACTIVE_STATE];
  if (filter.type !== undefined) {
    clauses.push("type = ?");
    params.push(filter.type);
  }
  clauses.push("scope = ?");
  params.push(filter.scope);
  if (filter.projectId !== undefined) {
    clauses.push("project_id = ?");
    params.push(filter.projectId);
  }
  clauses.push("embedding MATCH ?", "k = ?");
  params.push(JSON.stringify(Array.from(vector)), KNN_LIMIT);
  return db
    .prepare(`SELECT memory_id AS id, distance FROM memories_vec WHERE ${clauses.join(" AND ")}`)
    .all(...params) as KnnHit[];
}

function ftsHits(db: Db, match: string, filter: FtsFilter, limit: number, now: string): FtsHit[] {
  const clauses = ["memories_fts MATCH ?", RECALLABLE_MEMORY];
  const params: unknown[] = [match, now];
  if (filter.scope === "user") {
    clauses.push("m.scope = ?");
    params.push("user");
  } else if (filter.scope === "project") {
    clauses.push("m.scope = ? AND m.project_id = ?");
    params.push("project", filter.projectId);
  } else {
    clauses.push(VISIBLE_TO_PROJECT);
    params.push(filter.projectId);
  }
  if (filter.type !== undefined) {
    clauses.push("m.type = ?");
    params.push(filter.type);
  }
  params.push(limit);
  return db
    .prepare(
      `SELECT m.id, memories_fts.rank AS rank FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE ${clauses.join(" AND ")} ORDER BY memories_fts.rank LIMIT ?`,
    )
    .all(...params) as FtsHit[];
}

function topRanked(scores: Map<string, number>, limit: number): (readonly [string, number])[] {
  return [...scores.entries()]
    .sort(([idA, scoreA], [idB, scoreB]) => scoreB - scoreA || (idA < idB ? -1 : 1))
    .slice(0, limit);
}

function fetchRanked(
  db: Db,
  ranked: readonly (readonly [string, number])[],
  now: string,
): RecallRow[] {
  if (ranked.length === 0) {
    return [];
  }
  const placeholders = ranked.map(() => "?").join(", ");
  const found = db
    .prepare(
      `SELECT id, scope, type, importance, abstract FROM memories
       WHERE ${RECALLABLE_ROW} AND id IN (${placeholders})`,
    )
    .all(now, ...ranked.map(([id]) => id)) as MemoryRecord[];
  const byId = new Map(found.map((row) => [row.id, row]));
  return ranked.flatMap(([id, score]) => {
    const record = byId.get(id);
    if (record === undefined) {
      return [];
    }
    return [{ ...record, score }];
  });
}
