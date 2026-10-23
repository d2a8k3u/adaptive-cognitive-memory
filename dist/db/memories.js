"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storedKeyProblem = exports.storedKeys = exports.MemoryRejection = void 0;
exports.deriveAbstract = deriveAbstract;
exports.passageText = passageText;
exports.resolveMemoryId = resolveMemoryId;
exports.resolveVisibleMemoryId = resolveVisibleMemoryId;
exports.store = store;
exports.get = get;
exports.updateMemory = updateMemory;
exports.embedMissing = embedMissing;
exports.deleteMemory = deleteMemory;
exports.singleKeyHolders = singleKeyHolders;
exports.unembeddedActiveCount = unembeddedActiveCount;
exports.slotRow = slotRow;
const authoring_1 = require("../authoring");
const cfg_1 = require("../cfg");
const embeddings_1 = require("../embeddings");
const ids_1 = require("../ids");
const keys_1 = require("../keys");
const lifecycle_1 = require("../lifecycle");
const policy_1 = require("../policy");
const redact_1 = require("../redact");
const search_1 = require("../search");
const lifecycle_2 = require("./lifecycle");
const transitions_1 = require("./transitions");
const visibility_1 = require("./visibility");
const CANDIDATE_SOURCE_LIMIT = 10;
const CANDIDATE_FTS_MAX_TERMS = 32;
const UPDATE_ATTEMPTS = 3;
class MemoryRejection extends Error {
}
exports.MemoryRejection = MemoryRejection;
const UPDATE_BASIS_COLUMNS = [
    "title",
    "abstract",
    "content",
    "conflict_key",
    "keywords",
    "anchors",
    "questions",
];
const MEMORY_ROW_COLUMNS = `id, type, kind, scope, project_id, title, abstract, content, conflict_key,
  cardinality, value_text, keywords, anchors, questions, state, importance, support_count, valid_from,
  invalid_at, expired_at, superseded_by, created_at, updated_at`;
const SLOT_ROW_COLUMNS = `id, scope, project_id AS projectId, conflict_key AS conflictKey, cardinality,
  value_text AS valueText, state, kind`;
const EVERY_MEMORY = { sql: "TRUE", params: [] };
function storedKeyText(text) {
    return (0, redact_1.redact)(text).text;
}
exports.storedKeys = {
    valueText: storedKeyText,
    keywords: storedKeyText,
    anchors: (anchors) => anchors.map(storedKeyText),
    questions: (questions) => questions.map(storedKeyText),
};
function isText(value) {
    return typeof value === "string";
}
function isTextList(value) {
    return Array.isArray(value) && value.every(isText);
}
function asStored(writtenProblem, isKey, storedProblem) {
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
exports.storedKeyProblem = {
    valueText: asStored(authoring_1.valueTextProblem, isText, (text) => (0, authoring_1.valueTextProblem)(exports.storedKeys.valueText(text))),
    keywords: asStored(authoring_1.keywordsProblem, isText, (text) => (0, authoring_1.keywordsProblem)(exports.storedKeys.keywords(text))),
    anchors: asStored(authoring_1.anchorsProblem, isTextList, (anchors) => (0, authoring_1.redactedAnchorProblem)(anchors, exports.storedKeys.anchors(anchors))),
    questions: asStored(authoring_1.questionsProblem, isTextList, (questions) => (0, authoring_1.questionsProblem)(exports.storedKeys.questions(questions))),
};
function deriveAbstract(content) {
    const text = content.trim();
    const sentence = text.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? text;
    return sentence.length > cfg_1.ABSTRACT_MAX_CHARS ? sentence.slice(0, cfg_1.ABSTRACT_MAX_CHARS) : sentence;
}
function passageText(fields) {
    const tail = [fields.content, fields.keywords].filter((part) => part !== "");
    return `${fields.title}. ${tail.join(" ")}`;
}
function resolveMemoryId(db, idOrPrefix) {
    return resolveIdAmong(db, idOrPrefix, EVERY_MEMORY);
}
function resolveVisibleMemoryId(db, projectId, idOrPrefix) {
    return resolveIdAmong(db, idOrPrefix, { sql: visibility_1.VISIBLE_TO_PROJECT, params: [projectId] });
}
function resolveIdAmong(db, idOrPrefix, among) {
    if (idOrPrefix.length === 0) {
        throw new Error("memory id or prefix must not be empty");
    }
    const exact = db
        .prepare(`SELECT m.id FROM memories m WHERE m.id = ? AND ${among.sql}`)
        .get(idOrPrefix, ...among.params);
    if (exact !== undefined) {
        return exact.id;
    }
    const pattern = `${globLiteral(idOrPrefix)}*`;
    const rows = db
        .prepare(`SELECT m.id FROM memories m WHERE m.id GLOB ? AND ${among.sql} ORDER BY m.id`)
        .all(pattern, ...among.params);
    const [exactMatch] = rows;
    if (rows.length === 1 && exactMatch) {
        return exactMatch.id;
    }
    if (rows.length === 0) {
        throw new MemoryRejection(`memory not found: ${idOrPrefix}`);
    }
    throw new MemoryRejection(`ambiguous memory id or prefix '${idOrPrefix}' matches ${rows.length} memories`);
}
async function store(env, input, projectId) {
    const row = prepareRow(input, projectId);
    const vectors = await embedForStore(env, {
        passage: passageText(row),
        questions: row.questions,
    });
    const write = env.db.transaction(() => resolveWrite(env, row, vectors, input.resolution, nowIso()));
    return write.immediate();
}
function get(env, idOrPrefix) {
    const id = resolveMemoryId(env.db, idOrPrefix);
    const { anchors, questions, ...row } = fetchMemoryRow(env.db, id);
    const relations = env.db
        .prepare("SELECT target_id, relation_type FROM relations WHERE source_id = ? ORDER BY target_id, relation_type")
        .all(id);
    return {
        ...row,
        anchors: (0, keys_1.parseStoredList)(id, "anchors", anchors),
        questions: (0, keys_1.parseStoredList)(id, "questions", questions),
        relations,
    };
}
async function updateMemory(env, idOrPrefix, input) {
    const id = resolveMemoryId(env.db, idOrPrefix);
    for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
        if (await updateFromSnapshot(env, fetchMemoryRow(env.db, id), input)) {
            return get(env, id);
        }
    }
    throw new MemoryRejection(`memory ${id} changed during each of ${UPDATE_ATTEMPTS} update attempts; nothing was written, retry the update`);
}
function updatedText(row, input) {
    const content = input.content === undefined ? row.content : (0, redact_1.redactWithin)(input.content, cfg_1.CONTENT_MAX_CHARS);
    const abstract = input.abstract !== undefined
        ? (0, redact_1.redactWithin)(input.abstract, cfg_1.ABSTRACT_MAX_CHARS)
        : input.content === undefined
            ? row.abstract
            : deriveAbstract(content);
    return {
        title: input.title === undefined ? row.title : (0, redact_1.redactWithin)(input.title, cfg_1.TITLE_MAX_CHARS),
        abstract,
        content,
    };
}
function updatedKeys(row, input) {
    return {
        keywords: input.keywords === undefined ? row.keywords : exports.storedKeys.keywords(input.keywords),
        anchors: input.anchors === undefined ? row.anchors : JSON.stringify(exports.storedKeys.anchors(input.anchors)),
        questions: input.questions === undefined
            ? row.questions
            : JSON.stringify(exports.storedKeys.questions(input.questions)),
    };
}
function vectorsEdited(input) {
    return (input.title !== undefined ||
        input.content !== undefined ||
        input.keywords !== undefined ||
        input.questions !== undefined);
}
function sameUpdateBasis(current, snapshot) {
    return UPDATE_BASIS_COLUMNS.every((column) => current[column] === snapshot[column]);
}
async function updateFromSnapshot(env, snapshot, input) {
    const text = updatedText(snapshot, input);
    const keys = updatedKeys(snapshot, input);
    const reembed = vectorsEdited(input);
    const vectors = reembed
        ? await embedForStore(env, {
            passage: passageText({ ...text, keywords: keys.keywords }),
            questions: (0, keys_1.parseStoredList)(snapshot.id, "questions", keys.questions),
        })
        : undefined;
    const txn = env.db.transaction(() => {
        const current = fetchMemoryRow(env.db, snapshot.id);
        if (current.state === "revoked") {
            throw new MemoryRejection(`memory ${snapshot.id} is revoked and immutable`);
        }
        if (!sameUpdateBasis(current, snapshot)) {
            return false;
        }
        env.db
            .prepare(`UPDATE memories SET title = ?, abstract = ?, content = ?, keywords = ?, anchors = ?,
           questions = ?, content_hash = ?, updated_at = ?
         WHERE id = ?`)
            .run(text.title, text.abstract, text.content, keys.keywords, keys.anchors, keys.questions, (0, policy_1.contentHash)(text.content), nowIso(), current.id);
        if (reembed) {
            replaceVectors(env, current, vectors);
        }
        return true;
    });
    return txn.immediate();
}
async function embedMissing(env, limit, coverage) {
    const rows = unembeddedRows(env.db, limit, coverage);
    if (rows.length === 0) {
        return 0;
    }
    const vectors = await embedBatch(env.modelCacheDir, rows.map((row) => ({
        passage: passageText(row),
        questions: (0, keys_1.parseStoredList)(row.id, "questions", row.questions),
    })));
    const write = env.db.transaction(() => {
        let embedded = 0;
        rows.forEach((row, index) => {
            const current = unembeddedRow(env.db, row.id, coverage);
            const rowVectors = vectors[index];
            if (current === undefined ||
                rowVectors === undefined ||
                passageText(current) !== passageText(row) ||
                current.questions !== row.questions) {
                return;
            }
            insertVectors(env.db, current, rowVectors);
            embedded += 1;
        });
        return embedded;
    });
    return write.immediate();
}
function deleteMemory(env, idOrPrefix) {
    const id = resolveMemoryId(env.db, idOrPrefix);
    const txn = env.db.transaction(() => {
        const superseded = env.db
            .prepare("SELECT id FROM memories WHERE superseded_by = ? ORDER BY id")
            .pluck()
            .all(id);
        if (superseded.length > 0) {
            const history = superseded.join(", ");
            throw new MemoryRejection(`memory ${id} cannot be deleted: it is the superseded_by of ${history}; delete ${history} first to drop that history, or keep ${id} and replace its value with memory_store resolution SUPERSEDE`);
        }
        if (env.vecLoaded) {
            deleteVectors(env.db, id);
        }
        env.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    });
    txn.immediate();
    return { deleted: true };
}
function prepareRow(input, projectId) {
    const content = (0, redact_1.redactWithin)(input.content, cfg_1.CONTENT_MAX_CHARS);
    return {
        type: input.type,
        kind: input.kind,
        scope: input.scope,
        projectId,
        conflictKey: input.conflictKey,
        cardinality: input.cardinality,
        valueText: exports.storedKeys.valueText(input.valueText),
        title: (0, redact_1.redactWithin)(input.title, cfg_1.TITLE_MAX_CHARS),
        abstract: input.abstract === undefined
            ? deriveAbstract(content)
            : (0, redact_1.redactWithin)(input.abstract, cfg_1.ABSTRACT_MAX_CHARS),
        content,
        keywords: exports.storedKeys.keywords(input.keywords),
        anchors: JSON.stringify(exports.storedKeys.anchors(input.anchors)),
        questions: exports.storedKeys.questions(input.questions),
        contentHash: (0, policy_1.contentHash)(content),
    };
}
function resolveWrite(env, row, vectors, resolution, now) {
    if (resolution === undefined || resolution.action === "ADD") {
        const duplicate = exactDuplicate(env.db, row);
        if (duplicate !== undefined) {
            return guarded(reactivationGuard(env.db, duplicate), () => reasserted(env, duplicate, "store_noop", row.title, now, () => countSupport(env.db, duplicate.id)));
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
        return guarded((0, policy_1.addVerdict)(row, singleKeyHolders(env.db, row)), () => addMemory(env, row, vectors, now));
    }
    const target = slotRow(env.db, resolveMemoryId(env.db, resolution.target));
    switch (resolution.action) {
        case "SUPERSEDE":
            return guarded((0, policy_1.supersedeVerdict)(row, target), () => supersede(env, row, vectors, target, now));
        case "UPDATE":
            return guarded(reassertionVerdict(env.db, (0, policy_1.updateVerdict)(row, target), target), () => reasserted(env, target, "store_update", row.title, now, () => rewrite(env, row, vectors, target.id, now)));
        case "NOOP":
            return guarded(reassertionVerdict(env.db, (0, policy_1.noopVerdict)(row, target), target), () => reasserted(env, target, "store_noop", row.title, now, () => countSupport(env.db, target.id)));
    }
}
function reactivationGuard(db, target) {
    return (0, policy_1.reactivationVerdict)(target, singleKeyHolders(db, target));
}
function reassertionVerdict(db, resolutionVerdict, target) {
    return resolutionVerdict.allowed ? reactivationGuard(db, target) : resolutionVerdict;
}
function reasserted(env, target, reason, evidence, now, write) {
    const transition = (0, lifecycle_1.reactivation)(target.state, reason, evidence);
    if (transition !== undefined) {
        (0, lifecycle_2.applyTransition)(env, target.id, target.state, transition, now);
    }
    return write();
}
function written(result) {
    return { outcome: "written", result };
}
function guarded(verdict, write) {
    return verdict.allowed ? written(write()) : { outcome: "rejected", reason: verdict.reason };
}
function addMemory(env, row, vectors, now) {
    const id = insertMemory(env, row, vectors, now);
    return withPromotion({ id, action: "created" }, promote(env, id, row, vectors, now));
}
function supersede(env, row, vectors, target, now) {
    env.db
        .prepare("UPDATE memories SET state = 'revoked', invalid_at = ?, expired_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, now, target.id);
    const id = insertMemory(env, row, vectors, now);
    env.db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(id, target.id);
    (0, transitions_1.recordTransition)(env.db, {
        memoryId: target.id,
        fromState: "active",
        toState: "revoked",
        reason: "superseded",
        evidence: row.valueText,
        relatedId: id,
        at: now,
    });
    (0, transitions_1.setVecState)(env, target.id, "revoked");
    return withPromotion({ id, action: "superseded", refId: target.id }, promote(env, id, row, vectors, now));
}
function rewrite(env, row, vectors, targetId, now) {
    env.db
        .prepare(`UPDATE memories SET title = ?, abstract = ?, content = ?, value_text = ?, keywords = ?,
         anchors = ?, questions = ?, kind = ?, content_hash = ?, updated_at = ? WHERE id = ?`)
        .run(row.title, row.abstract, row.content, row.valueText, row.keywords, row.anchors, JSON.stringify(row.questions), row.kind, row.contentHash, now, targetId);
    replaceVectors(env, fetchMemoryRow(env.db, targetId), vectors);
    return withPromotion({ id: targetId, action: "updated" }, promote(env, targetId, row, vectors, now));
}
function countSupport(db, id) {
    db.prepare("UPDATE memories SET support_count = support_count + 1 WHERE id = ?").run(id);
    return { id, action: "noop" };
}
function promote(env, writtenId, row, vectors, now) {
    const writtenSlot = { ...row, id: writtenId, state: "active" };
    const contributors = (0, policy_1.promotionContributors)(writtenSlot, keyHolders(env.db, row.conflictKey));
    if (contributors.length === 0) {
        return undefined;
    }
    const userId = insertMemory(env, { ...row, scope: "user" }, vectors, now);
    for (const contributor of contributors) {
        (0, transitions_1.recordTransition)(env.db, {
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
function withPromotion(result, promotedId) {
    return promotedId === undefined ? result : { ...result, promotedId };
}
function insertMemory(env, row, vectors, now) {
    const id = (0, ids_1.newId)();
    env.db
        .prepare(`INSERT INTO memories (id, type, kind, scope, project_id, title, abstract, content, conflict_key,
         cardinality, value_text, keywords, anchors, questions, content_hash, importance, valid_from,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, row.type, row.kind, row.scope, row.projectId, row.title, row.abstract, row.content, row.conflictKey, row.cardinality, row.valueText, row.keywords, row.anchors, JSON.stringify(row.questions), row.contentHash, (0, lifecycle_1.derivedImportance)(lifecycle_1.FRESH_COUNTERS), now, now, now);
    if (vectors !== undefined) {
        insertVectors(env.db, { id, type: row.type, scope: row.scope, project_id: row.projectId, state: "active" }, vectors);
    }
    return id;
}
function insertVectors(db, fields, vectors) {
    db.prepare("INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id, state) VALUES (?, ?, ?, ?, ?, ?)").run(fields.id, vecBlob(vectors.passage), fields.type, fields.scope, fields.project_id, fields.state);
    const insertQuestion = db.prepare(`INSERT INTO questions_vec (question_id, embedding, memory_id, scope, project_id, state)
     VALUES (?, ?, ?, ?, ?, ?)`);
    vectors.questions.forEach((vector, index) => {
        insertQuestion.run(`${fields.id}:${index}`, vecBlob(vector), fields.id, fields.scope, fields.project_id, fields.state);
    });
}
function deleteVectors(db, memoryId) {
    db.prepare("DELETE FROM memories_vec WHERE memory_id = ?").run(memoryId);
    db.prepare("DELETE FROM questions_vec WHERE memory_id = ?").run(memoryId);
}
function replaceVectors(env, fields, vectors) {
    if (!env.vecLoaded) {
        return;
    }
    deleteVectors(env.db, fields.id);
    if (vectors !== undefined) {
        insertVectors(env.db, fields, vectors);
    }
}
function partitionFilter(slot, alias = "") {
    return slot.scope === "user"
        ? { sql: `${alias}scope = 'user'`, params: [] }
        : { sql: `${alias}scope = 'project' AND ${alias}project_id = ?`, params: [slot.projectId] };
}
function exactDuplicate(db, row) {
    const partition = partitionFilter(row);
    return db
        .prepare(`SELECT ${SLOT_ROW_COLUMNS} FROM memories
       WHERE content_hash = ? AND state IN ('active', 'hypothesis') AND ${partition.sql}
       ORDER BY state = 'active' DESC LIMIT 1`)
        .get(row.contentHash, ...partition.params);
}
function writeCandidates(env, row, vectors) {
    const ids = new Set([
        ...sameKeyIds(env.db, row),
        ...(vectors === undefined ? [] : neighbourIds(env.db, row, vectors.passage)),
        ...keywordHitIds(env.db, row),
    ]);
    return candidatesByIds(env.db, [...ids]);
}
function sameKeyIds(db, row) {
    const partition = partitionFilter(row);
    const rows = db
        .prepare(`SELECT id FROM memories
       WHERE conflict_key = ? AND state = 'active' AND ${partition.sql}
       ORDER BY created_at LIMIT ?`)
        .all(row.conflictKey, ...partition.params, CANDIDATE_SOURCE_LIMIT);
    return rows.map((hit) => hit.id);
}
function neighbourIds(db, row, embedding) {
    const partition = partitionFilter(row);
    const rows = db
        .prepare(`SELECT memory_id FROM memories_vec
       WHERE state = 'active' AND ${partition.sql} AND embedding MATCH ? AND k = ?`)
        .all(...partition.params, vecBlob(embedding), CANDIDATE_SOURCE_LIMIT);
    return rows.map((hit) => hit.memory_id);
}
function keywordHitIds(db, row) {
    const match = (0, search_1.anyTermMatchExpression)([row.title, row.abstract, row.keywords, row.valueText], CANDIDATE_FTS_MAX_TERMS);
    if (match === "") {
        return [];
    }
    const partition = partitionFilter(row, "m.");
    const rows = db
        .prepare(`SELECT m.id AS id FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.state = 'active' AND ${partition.sql}
       ORDER BY rank LIMIT ?`)
        .all(match, ...partition.params, CANDIDATE_SOURCE_LIMIT);
    return rows.map((hit) => hit.id);
}
function candidatesByIds(db, ids) {
    if (ids.length === 0) {
        return [];
    }
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
        .prepare(`SELECT id, title, kind, conflict_key, cardinality, value_text, valid_from, support_count, scope
       FROM memories WHERE id IN (${placeholders})`)
        .all(...ids);
    const byId = new Map(rows.map((candidate) => [candidate.id, candidate]));
    return ids.flatMap((id) => {
        const candidate = byId.get(id);
        return candidate === undefined ? [] : [candidate];
    });
}
function singleKeyHolders(db, row) {
    const partition = partitionFilter(row);
    return db
        .prepare(`SELECT ${SLOT_ROW_COLUMNS} FROM memories
       WHERE conflict_key = ? AND cardinality = 'single' AND state = 'active' AND ${partition.sql}`)
        .all(row.conflictKey, ...partition.params);
}
function keyHolders(db, conflictKey) {
    return db
        .prepare(`SELECT ${SLOT_ROW_COLUMNS} FROM memories WHERE conflict_key = ? AND state = 'active'`)
        .all(conflictKey);
}
const UNEMBEDDED_ROW_SELECT = `SELECT m.id, m.type, m.scope, m.project_id, m.state, m.title, m.content,
    m.keywords, m.questions
  FROM memories m
  WHERE NOT EXISTS (SELECT 1 FROM memories_vec v WHERE v.memory_id = m.id)
    AND (? = 'all' OR m.state = 'active')`;
function unembeddedActiveCount(db) {
    return db
        .prepare(`SELECT count(*) FROM (${UNEMBEDDED_ROW_SELECT})`)
        .pluck()
        .get("active");
}
function unembeddedRows(db, limit, coverage) {
    return db
        .prepare(`${UNEMBEDDED_ROW_SELECT} ORDER BY m.rowid LIMIT ?`)
        .all(coverage, limit);
}
function unembeddedRow(db, id, coverage) {
    return db.prepare(`${UNEMBEDDED_ROW_SELECT} AND m.id = ?`).get(coverage, id);
}
function slotRow(db, id) {
    const row = db.prepare(`SELECT ${SLOT_ROW_COLUMNS} FROM memories WHERE id = ?`).get(id);
    if (row === undefined) {
        throw new Error(`memory not found: ${id}`);
    }
    return row;
}
function vectorCountGuard(kind, expected, actual) {
    if (actual !== expected) {
        throw new Error(`embedding ${expected} ${kind} produced ${actual} vectors`);
    }
}
async function embedBatch(modelCacheDir, sources) {
    const passages = await (0, embeddings_1.embedPassage)(sources.map((source) => source.passage), modelCacheDir);
    vectorCountGuard("passages", sources.length, passages.length);
    const questionTexts = sources.flatMap((source) => source.questions);
    const questions = questionTexts.length === 0 ? [] : await (0, embeddings_1.embedQuestions)(questionTexts, modelCacheDir);
    vectorCountGuard("questions", questionTexts.length, questions.length);
    let next = 0;
    return sources.map((source, index) => {
        const own = questions.slice(next, next + source.questions.length);
        next += source.questions.length;
        return { passage: passages[index], questions: own };
    });
}
async function embedForStore(env, source) {
    if (!env.vecLoaded || !(0, embeddings_1.modelCached)(env.modelCacheDir)) {
        return undefined;
    }
    const [vectors] = await embedBatch(env.modelCacheDir, [source]);
    return vectors;
}
function fetchMemoryRow(db, id) {
    const row = db.prepare(`SELECT ${MEMORY_ROW_COLUMNS} FROM memories WHERE id = ?`).get(id);
    if (row === undefined) {
        throw new MemoryRejection(`memory not found: ${id}`);
    }
    return row;
}
function globLiteral(value) {
    return value.replace(/[*?[]/g, (character) => `[${character}]`);
}
function vecBlob(embedding) {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}
function nowIso() {
    return new Date().toISOString();
}
