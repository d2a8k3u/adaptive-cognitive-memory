"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TICKET_ROWS_MAX = exports.DEFAULT_RECALL_LIMIT = void 0;
exports.sessionStartLimit = sessionStartLimit;
exports.anyTermMatchExpression = anyTermMatchExpression;
exports.ftsMatchExpression = ftsMatchExpression;
exports.rrfFuse = rrfFuse;
exports.recall = recall;
exports.pinnedCandidates = pinnedCandidates;
exports.sessionEarlierMemories = sessionEarlierMemories;
exports.ticketCandidates = ticketCandidates;
exports.promptCandidates = promptCandidates;
exports.toolCandidates = toolCandidates;
const health_1 = require("./db/health");
const visibility_1 = require("./db/visibility");
const embeddings_1 = require("./embeddings");
const inject_1 = require("./inject");
const keys_1 = require("./keys");
const policy_1 = require("./policy");
const prompt_1 = require("./prompt");
const session_1 = require("./session");
exports.DEFAULT_RECALL_LIMIT = 10;
exports.TICKET_ROWS_MAX = 3;
const RRF_K = 60;
const FTS_QUERY_MAX_TERMS = 32;
const KNN_LIMIT = 10;
const QUESTION_KNN_LIMIT = 40;
const FTS_HYBRID_LIMIT = 10;
const FTS_CANDIDATE_LIMIT = 20;
const RECALL_STATES = ["active"];
const STILL_VALID_MEMORY = "(m.invalid_at IS NULL OR m.invalid_at > ?)";
const RECALLABLE_MEMORY = `m.state = 'active' AND ${STILL_VALID_MEMORY}`;
const KEY_COLUMNS_FILTER = "{conflict_key keywords}";
const TICKET_COLUMNS_FILTER = "{keywords}";
const MEMORY_FIELDS = `m.id, m.kind, m.epistemic, m.scope, m.abstract,
  COALESCE(m.valid_from, m.created_at) AS validFrom, m.conflict_key AS conflictKey, m.keywords,
  m.anchors`;
function sessionStartLimit(budgetTokens) {
    return Math.max(1, Math.ceil(budgetTokens / (0, inject_1.minLineTokens)()));
}
function terms(text) {
    return text.split(/\s+/).filter((term) => term.length > 0);
}
function ftsPhrase(term) {
    return `"${term.replaceAll('"', '""')}"`;
}
function anyTermMatchExpression(texts, maxTerms) {
    const byFoldedTerm = new Map();
    for (const term of texts.flatMap(terms)) {
        const folded = term.toLowerCase();
        if (!byFoldedTerm.has(folded)) {
            byFoldedTerm.set(folded, term);
        }
    }
    return [...byFoldedTerm.values()].slice(0, maxTerms).map(ftsPhrase).join(" OR ");
}
function ftsMatchExpression(query) {
    return anyTermMatchExpression((0, prompt_1.distinctWords)(query), FTS_QUERY_MAX_TERMS);
}
function rrfFuse(rankings) {
    const scores = new Map();
    for (const ranking of rankings) {
        ranking.forEach((id, index) => {
            scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1));
        });
    }
    return scores;
}
function environmentDegradation(source, modelCacheDir) {
    const flags = {};
    if (!source.vecLoaded) {
        flags.vec = true;
    }
    if (!(0, embeddings_1.modelCached)(modelCacheDir)) {
        flags.model = true;
    }
    return flags.vec || flags.model ? flags : undefined;
}
async function queryEmbedding(query, embedder) {
    try {
        return {
            vector: await (0, embeddings_1.withDeadline)((0, embeddings_1.embedQuery)(query, embedder.modelCacheDir), embedder.embedDeadlineMs),
        };
    }
    catch (error) {
        return {
            degraded: error instanceof embeddings_1.DeadlineExceededError ? { embedding_timeout: true } : { model: true },
        };
    }
}
function recordPromptEmbedding(db, embedded, at) {
    if (embedded.vector !== undefined) {
        (0, health_1.clearEmbeddingTimeout)(db);
    }
    else if (embedded.degraded.embedding_timeout === true) {
        (0, health_1.recordEmbeddingTimeout)(db, at);
    }
}
async function recall(opened, options) {
    const now = new Date().toISOString();
    const degraded = environmentDegradation(opened, options.modelCacheDir);
    if (options.ftsOnly || degraded !== undefined) {
        return { rows: ftsRecall(opened.db, options, now), degraded };
    }
    const embedded = await queryEmbedding(options.query, options);
    if (embedded.vector === undefined) {
        return { rows: ftsRecall(opened.db, options, now), degraded: embedded.degraded };
    }
    return { rows: hybridRecall(opened.db, options, embedded.vector, now) };
}
function pinnedCandidates(db, request) {
    const kinds = session_1.PINNED_KINDS.map(() => "?").join(", ");
    return db
        .prepare(`SELECT ${MEMORY_FIELDS}, m.importance, m.created_at AS createdAt,
         COALESCE(m.last_injected_at, m.created_at) AS lastActivityAt
       FROM memories m
       WHERE ${RECALLABLE_MEMORY} AND ${visibility_1.VISIBLE_TO_PROJECT} AND m.kind IN (${kinds})`)
        .all(request.now, request.projectId, ...session_1.PINNED_KINDS);
}
function sessionEarlierMemories(db, request) {
    return db
        .prepare(`SELECT ${MEMORY_FIELDS} FROM memories m
       JOIN (SELECT memory_id, max(at) AS lastAt FROM injections WHERE session_id = ?
             GROUP BY memory_id) s ON s.memory_id = m.id
       WHERE ${RECALLABLE_MEMORY} AND ${visibility_1.VISIBLE_TO_PROJECT}
       ORDER BY s.lastAt DESC, m.id`)
        .all(request.sessionId, request.now, request.projectId);
}
function ticketCandidates(db, request) {
    return db
        .prepare(`SELECT ${MEMORY_FIELDS} FROM memories m
       WHERE ${RECALLABLE_MEMORY} AND ${visibility_1.VISIBLE_TO_PROJECT}
         AND (${anchorMembership(1)}
              OR m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?))
       ORDER BY m.importance DESC, m.id
       LIMIT ?`)
        .all(request.now, request.projectId, request.ticket, `${TICKET_COLUMNS_FILTER} : ${ftsPhrase(request.ticket)}`, request.limit);
}
async function promptCandidates(source, request) {
    const filter = { states: RECALL_STATES, projectId: request.projectId };
    const match = anyTermMatchExpression(request.tokens, FTS_QUERY_MAX_TERMS);
    const ranks = new Map(match === ""
        ? []
        : ftsHits(source.db, match, filter, FTS_CANDIDATE_LIMIT, request.now).map((hit) => [
            hit.id,
            hit.rank,
        ]));
    const environment = environmentDegradation(source, request.modelCacheDir);
    const embedded = environment === undefined ? await queryEmbedding(request.prompt, request) : undefined;
    if (embedded !== undefined) {
        recordPromptEmbedding(source.db, embedded, request.now);
    }
    const degraded = environment ?? embedded?.degraded;
    const vector = embedded?.vector;
    const cosines = closestCosines(vector === undefined
        ? []
        : [
            ...ownPartitionKnn(source.db, vector, request.projectId),
            ...ownPartitionQuestionKnn(source.db, vector, request.projectId),
        ]);
    const tokens = new Set(request.tokens);
    const candidates = memoriesByIds(source.db, [...cosines.keys(), ...ranks.keys()], request.now).map((memory) => ({
        ...recalledMemory(memory),
        cosine: cosines.get(memory.id),
        ftsRank: ranks.get(memory.id),
        keyHit: (0, keys_1.keyHit)(tokens, memoryKeys(memory)),
    }));
    return { candidates, neighbourhood: [...cosines.values()], degraded };
}
function toolCandidates(db, request) {
    const lookup = new Set(request.lookup.anchors);
    const tokens = new Set(request.lookup.tokens);
    const anchored = anchoredIds(db, request);
    const keyed = request.keywordSignal ? keywordIds(db, request) : [];
    return memoriesByIds(db, [...anchored, ...keyed], request.now).map((memory) => {
        const keys = memoryKeys(memory);
        return {
            ...recalledMemory(memory),
            anchorHit: (0, keys_1.anchorHit)(keys.anchors, lookup),
            keyHit: (0, keys_1.keyHit)(tokens, keys),
        };
    });
}
function recalledMemory(memory) {
    return {
        id: memory.id,
        kind: memory.kind,
        epistemic: memory.epistemic,
        scope: memory.scope,
        abstract: memory.abstract,
        validFrom: memory.validFrom,
    };
}
function memoryKeys(memory) {
    return {
        conflictKey: memory.conflictKey,
        keywords: memory.keywords,
        anchors: (0, keys_1.parseStoredList)(memory.id, "anchors", memory.anchors),
    };
}
function memoriesByIds(db, ids, now) {
    const distinct = [...new Set(ids)];
    if (distinct.length === 0) {
        return [];
    }
    const placeholders = distinct.map(() => "?").join(", ");
    return db
        .prepare(`SELECT ${MEMORY_FIELDS} FROM memories m
       WHERE ${RECALLABLE_MEMORY} AND m.id IN (${placeholders}) ORDER BY m.id`)
        .all(now, ...distinct);
}
function anchorMembership(anchorCount) {
    const placeholders = Array.from({ length: anchorCount }, () => "?").join(", ");
    return `EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(m.anchors) THEN m.anchors ELSE '[]' END)
    WHERE value IN (${placeholders})
  )`;
}
function anchoredIds(db, request) {
    const keys = request.lookup.anchors;
    if (keys.length === 0) {
        return [];
    }
    const rows = db
        .prepare(`SELECT m.id FROM memories m
       WHERE ${RECALLABLE_MEMORY} AND ${visibility_1.VISIBLE_TO_PROJECT} AND ${anchorMembership(keys.length)}`)
        .all(request.now, request.projectId, ...keys);
    return rows.map((row) => row.id);
}
function keywordIds(db, request) {
    const match = anyTermMatchExpression(request.lookup.tokens, FTS_QUERY_MAX_TERMS);
    if (match === "") {
        return [];
    }
    return ftsHits(db, `${KEY_COLUMNS_FILTER} : (${match})`, { states: RECALL_STATES, projectId: request.projectId }, FTS_CANDIDATE_LIMIT, request.now).map((hit) => hit.id);
}
function ownPartitionKnn(db, vector, projectId) {
    return [
        ...knnHits(db, vector, { states: RECALL_STATES, scope: "user" }),
        ...knnHits(db, vector, { states: RECALL_STATES, scope: "project", projectId }),
    ];
}
function ownPartitionQuestionKnn(db, vector, projectId) {
    const nearest = (partition, params) => db
        .prepare(`SELECT memory_id AS id, distance FROM questions_vec
         WHERE ${inStates("state", RECALL_STATES)} AND ${partition}
           AND embedding MATCH ? AND k = ?`)
        .all(...RECALL_STATES, ...params, JSON.stringify(Array.from(vector)), QUESTION_KNN_LIMIT);
    return [
        ...nearest("scope = 'user'", []),
        ...nearest("scope = 'project' AND project_id = ?", [projectId]),
    ];
}
function closestCosines(hits) {
    const closest = new Map();
    for (const hit of hits) {
        const cosine = 1 - hit.distance;
        if (cosine > (closest.get(hit.id) ?? Number.NEGATIVE_INFINITY)) {
            closest.set(hit.id, cosine);
        }
    }
    return closest;
}
function ftsRecall(db, options, now) {
    const match = ftsMatchExpression(options.query);
    if (match === "") {
        return [];
    }
    const limit = options.limit ?? exports.DEFAULT_RECALL_LIMIT;
    const ids = ftsHits(db, match, searchFilter(options), limit, now).map((hit) => hit.id);
    return fetchRanked(db, topRanked(rrfFuse([ids]), limit), now);
}
function searchFilter(options) {
    return {
        states: policy_1.CONSULTABLE_STATES,
        projectId: options.projectId,
        scope: options.scope,
        type: options.type,
    };
}
function hybridRecall(db, options, vector, now) {
    const rankings = [];
    if (options.scope !== "project") {
        rankings.push(knnHits(db, vector, { states: policy_1.CONSULTABLE_STATES, scope: "user", type: options.type }).map((hit) => hit.id));
    }
    if (options.scope !== "user") {
        rankings.push(knnHits(db, vector, {
            states: policy_1.CONSULTABLE_STATES,
            scope: "project",
            projectId: options.projectId,
            type: options.type,
        }).map((hit) => hit.id));
    }
    const match = ftsMatchExpression(options.query);
    if (match !== "") {
        rankings.push(ftsHits(db, match, searchFilter(options), FTS_HYBRID_LIMIT, now).map((hit) => hit.id));
    }
    return fetchRanked(db, topRanked(rrfFuse(rankings), options.limit ?? exports.DEFAULT_RECALL_LIMIT), now);
}
function inStates(column, states) {
    return `${column} IN (${states.map(() => "?").join(", ")})`;
}
function knnHits(db, vector, filter) {
    const clauses = [inStates("state", filter.states)];
    const params = [...filter.states];
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
        .all(...params);
}
function ftsHits(db, match, filter, limit, now) {
    const clauses = ["memories_fts MATCH ?", inStates("m.state", filter.states), STILL_VALID_MEMORY];
    const params = [match, ...filter.states, now];
    if (filter.scope === "user") {
        clauses.push("m.scope = ?");
        params.push("user");
    }
    else if (filter.scope === "project") {
        clauses.push("m.scope = ? AND m.project_id = ?");
        params.push("project", filter.projectId);
    }
    else {
        clauses.push(visibility_1.VISIBLE_TO_PROJECT);
        params.push(filter.projectId);
    }
    if (filter.type !== undefined) {
        clauses.push("m.type = ?");
        params.push(filter.type);
    }
    params.push(limit);
    return db
        .prepare(`SELECT m.id, memories_fts.rank AS rank FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE ${clauses.join(" AND ")} ORDER BY memories_fts.rank LIMIT ?`)
        .all(...params);
}
function topRanked(scores, limit) {
    return [...scores.entries()]
        .sort(([idA, scoreA], [idB, scoreB]) => scoreB - scoreA || (idA < idB ? -1 : 1))
        .slice(0, limit);
}
function fetchRanked(db, ranked, now) {
    if (ranked.length === 0) {
        return [];
    }
    const placeholders = ranked.map(() => "?").join(", ");
    const found = db
        .prepare(`SELECT m.id, m.scope, m.type, m.importance, m.abstract, m.state FROM memories m
       WHERE ${inStates("m.state", policy_1.CONSULTABLE_STATES)} AND ${STILL_VALID_MEMORY}
         AND m.id IN (${placeholders})`)
        .all(...policy_1.CONSULTABLE_STATES, now, ...ranked.map(([id]) => id));
    const byId = new Map(found.map((row) => [row.id, row]));
    return ranked.flatMap(([id, score]) => {
        const record = byId.get(id);
        if (record === undefined) {
            return [];
        }
        return [{ ...record, score }];
    });
}
