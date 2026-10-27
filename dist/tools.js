"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_DEFINITIONS = void 0;
exports.isToolError = isToolError;
exports.memoryStore = memoryStore;
exports.memorySearch = memorySearch;
exports.memoryList = memoryList;
exports.memoryGet = memoryGet;
exports.memoryUpdate = memoryUpdate;
exports.memoryDelete = memoryDelete;
exports.memoryRelate = memoryRelate;
exports.memoryFeedback = memoryFeedback;
exports.memoryDoctor = memoryDoctor;
exports.memoryStatus = memoryStatus;
const authoring_1 = require("./authoring");
const cfg_1 = require("./cfg");
const database_1 = require("./db/database");
const feedback_1 = require("./db/feedback");
const listing_1 = require("./db/listing");
const memories_1 = require("./db/memories");
const relations_1 = require("./db/relations");
const status_1 = require("./db/status");
const doctor_1 = require("./doctor");
const harness_1 = require("./harness");
const ids_1 = require("./ids");
const instructions_1 = require("./instructions");
const lifecycle_1 = require("./lifecycle");
const policy_1 = require("./policy");
const search_1 = require("./search");
const status_2 = require("./status");
const SEARCH_LIMIT_MAX = 100;
const FEEDBACK_IDS_MAX_ITEMS = 20;
const ALL_PROJECTS = "all";
const IMMUTABLE_FIELDS = ["scope", "kind"];
function isToolError(value) {
    return typeof value === "object" && value !== null && "error" in value;
}
function fieldError(field, message) {
    return { error: { field, message } };
}
async function rejectionsAsToolErrors(work) {
    try {
        return await work();
    }
    catch (error) {
        if (error instanceof memories_1.MemoryRejection || (0, database_1.isStorageRejection)(error)) {
            return { error: { message: error.message } };
        }
        throw error;
    }
}
function visibleId(deps, idOrPrefix) {
    return (0, memories_1.resolveVisibleMemoryId)(deps.env.db, deps.projectId, idOrPrefix);
}
function requiredString(args, field, maxChars) {
    const value = args[field];
    if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
        return fieldError(field, `${field} must be a non-empty string of at most ${maxChars} characters`);
    }
    return value;
}
function memoryText(args, field, maxChars) {
    const value = requiredString(args, field, maxChars);
    if (isToolError(value)) {
        return value;
    }
    if (value.trim() === "") {
        return fieldError(field, `${field} must contain text, not only whitespace`);
    }
    const marker = (0, harness_1.harnessMarker)(value);
    if (marker !== undefined) {
        return fieldError(field, `${field} contains the harness marker ${marker}; store the durable lesson in your own words, without agent, task or system wrapper text`);
    }
    return value;
}
function optionalMemoryText(args, field, maxChars) {
    return args[field] === undefined ? undefined : memoryText(args, field, maxChars);
}
function requiredText(args, field, maxChars) {
    const value = args[field];
    if (typeof value !== "string" || value.length > maxChars) {
        return fieldError(field, `${field} must be a string of at most ${maxChars} characters`);
    }
    return value;
}
function requiredEnum(args, field, values) {
    const value = args[field];
    if (typeof value !== "string" || !values.includes(value)) {
        return fieldError(field, `${field} must be one of: ${values.join(", ")}`);
    }
    return value;
}
function optionalEnum(args, field, values) {
    const value = args[field];
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string" || !values.includes(value)) {
        return fieldError(field, `${field} must be one of: ${values.join(", ")}`);
    }
    return value;
}
function optionalInt(args, field, min, max) {
    const value = args[field];
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        return fieldError(field, `${field} must be an integer between ${min} and ${max}`);
    }
    return value;
}
function authoringError(problem) {
    return problem === undefined ? undefined : fieldError(problem.field, problem.message);
}
function isString(value) {
    return typeof value === "string";
}
function isStringList(value) {
    return Array.isArray(value) && value.every(isString);
}
function writtenKey(value, isKey, problemOf) {
    const rejection = authoringError(problemOf(value));
    if (rejection !== undefined) {
        return rejection;
    }
    if (!isKey(value)) {
        throw new TypeError("an authoring check accepted a value of the wrong type");
    }
    return value;
}
function requiredConflictKey(args) {
    return writtenKey(args.conflict_key, isString, authoring_1.conflictKeyProblem);
}
function valueTextFor(args, cardinality) {
    const value = args.value_text;
    if (cardinality === "single" && (typeof value !== "string" || value.trim() === "")) {
        return fieldError("value_text", "value_text is required for a single-valued conflict_key: give the slot's current value, such as PostgreSQL 15");
    }
    if (value === undefined) {
        return "";
    }
    return writtenKey(value, isString, memories_1.storedKeyProblem.valueText);
}
function keywordsArgument(args) {
    if (args.keywords === undefined) {
        return undefined;
    }
    return writtenKey(args.keywords, isString, memories_1.storedKeyProblem.keywords);
}
function anchorsArgument(args) {
    if (args.anchors === undefined) {
        return undefined;
    }
    return writtenKey(args.anchors, isStringList, memories_1.storedKeyProblem.anchors);
}
function questionsArgument(args) {
    if (args.questions === undefined) {
        return undefined;
    }
    return writtenKey(args.questions, isStringList, memories_1.storedKeyProblem.questions);
}
function optionalResolution(args) {
    const value = args.resolution;
    if (value === undefined) {
        return undefined;
    }
    const record = typeof value === "object" && value !== null ? value : {};
    const action = record.action;
    if (typeof action !== "string" || !policy_1.RESOLUTION_ACTIONS.includes(action)) {
        return fieldError("resolution", `resolution must be an object whose action is one of: ${policy_1.RESOLUTION_ACTIONS.join(", ")}`);
    }
    if (action === "ADD") {
        return { action };
    }
    const target = record.target;
    if (typeof target !== "string" || target === "" || target.length > ids_1.ID_MAX_CHARS) {
        return fieldError("resolution", `resolution.target must be the id of the candidate to ${action}, at most ${ids_1.ID_MAX_CHARS} characters`);
    }
    return { action: action, target };
}
function parseStoreArgs(args) {
    const title = memoryText(args, "title", cfg_1.TITLE_MAX_CHARS);
    if (isToolError(title)) {
        return title;
    }
    const content = memoryText(args, "content", cfg_1.CONTENT_MAX_CHARS);
    if (isToolError(content)) {
        return content;
    }
    const type = requiredEnum(args, "type", policy_1.MEMORY_TYPES);
    if (isToolError(type)) {
        return type;
    }
    const kind = requiredEnum(args, "kind", policy_1.MEMORY_KINDS);
    if (isToolError(kind)) {
        return kind;
    }
    const conflictKey = requiredConflictKey(args);
    if (isToolError(conflictKey)) {
        return conflictKey;
    }
    const cardinality = optionalEnum(args, "cardinality", policy_1.CARDINALITIES) ?? "multi";
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
    const scope = optionalEnum(args, "scope", policy_1.MEMORY_SCOPES);
    if (isToolError(scope)) {
        return scope;
    }
    const abstract = optionalMemoryText(args, "abstract", cfg_1.ABSTRACT_MAX_CHARS);
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
function storeToolResult(outcome) {
    switch (outcome.outcome) {
        case "written":
            return outcome.result;
        case "needs_resolution":
            return {
                status: "needs_resolution",
                candidates: outcome.candidates,
                allowed: [...policy_1.RESOLUTION_ACTIONS],
            };
        case "rejected":
            return fieldError("resolution", outcome.reason);
    }
}
async function memoryStore(deps, args) {
    const input = parseStoreArgs(args);
    if (isToolError(input)) {
        return input;
    }
    const restated = (0, instructions_1.restatedInstruction)(input.content, (0, instructions_1.readInstructionLines)(deps.instructionSources));
    if (restated !== undefined) {
        return fieldError("content", `content restates a line of ${restated.source}, which every session already loads; store only what a future session could not re-derive from the code, git history or CLAUDE.md`);
    }
    return rejectionsAsToolErrors(async () => storeToolResult(await (0, memories_1.store)(deps.env, input, deps.projectId)));
}
async function memorySearch(deps, args) {
    const query = requiredText(args, "query", cfg_1.CONTENT_MAX_CHARS);
    if (isToolError(query)) {
        return query;
    }
    const limit = optionalInt(args, "limit", 1, SEARCH_LIMIT_MAX);
    if (isToolError(limit)) {
        return limit;
    }
    const type = optionalEnum(args, "type", policy_1.MEMORY_TYPES);
    if (isToolError(type)) {
        return type;
    }
    const scope = optionalEnum(args, "scope", policy_1.MEMORY_SCOPES);
    if (isToolError(scope)) {
        return scope;
    }
    return rejectionsAsToolErrors(async () => {
        const recalled = await (0, search_1.recall)(deps.env, {
            projectId: deps.projectId,
            modelCacheDir: deps.env.modelCacheDir,
            embedDeadlineMs: deps.embedDeadlineMs,
            query,
            limit: limit ?? search_1.DEFAULT_RECALL_LIMIT,
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
function optionalCursor(args) {
    const value = args.before;
    if (value === undefined) {
        return undefined;
    }
    return (0, ids_1.isMemoryId)(value)
        ? value
        : fieldError("before", `before must be the next_cursor of the previous page, a non-empty id of at most ${ids_1.ID_MAX_CHARS} characters`);
}
function listPartition(args, projectId) {
    const value = args.project;
    if (value === undefined) {
        return { kind: "visible", projectId };
    }
    return value === ALL_PROJECTS
        ? { kind: "all" }
        : fieldError("project", `project must be "${ALL_PROJECTS}" to list every project read-only, or left out`);
}
function parseListArgs(args, projectId) {
    const state = optionalEnum(args, "state", policy_1.MEMORY_STATES);
    if (isToolError(state)) {
        return state;
    }
    const kind = optionalEnum(args, "kind", policy_1.MEMORY_KINDS);
    if (isToolError(kind)) {
        return kind;
    }
    const type = optionalEnum(args, "type", policy_1.MEMORY_TYPES);
    if (isToolError(type)) {
        return type;
    }
    const scope = optionalEnum(args, "scope", policy_1.MEMORY_SCOPES);
    if (isToolError(scope)) {
        return scope;
    }
    const before = optionalCursor(args);
    if (isToolError(before)) {
        return before;
    }
    const limit = optionalInt(args, "limit", 1, listing_1.LIST_LIMIT_MAX);
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
        limit: limit ?? listing_1.LIST_LIMIT_DEFAULT,
    };
}
async function memoryList(deps, args) {
    const request = parseListArgs(args, deps.projectId);
    if (isToolError(request)) {
        return request;
    }
    return rejectionsAsToolErrors(() => (0, listing_1.listMemories)(deps.env.db, request));
}
async function memoryGet(deps, args) {
    const id = requiredString(args, "id", ids_1.ID_MAX_CHARS);
    if (isToolError(id)) {
        return id;
    }
    return rejectionsAsToolErrors(() => (0, memories_1.get)(deps.env, visibleId(deps, id)));
}
async function memoryUpdate(deps, args) {
    const id = requiredString(args, "id", ids_1.ID_MAX_CHARS);
    if (isToolError(id)) {
        return id;
    }
    const title = optionalMemoryText(args, "title", cfg_1.TITLE_MAX_CHARS);
    if (isToolError(title)) {
        return title;
    }
    const abstract = optionalMemoryText(args, "abstract", cfg_1.ABSTRACT_MAX_CHARS);
    if (isToolError(abstract)) {
        return abstract;
    }
    const content = optionalMemoryText(args, "content", cfg_1.CONTENT_MAX_CHARS);
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
        return fieldError(immutable, `${immutable} cannot change in place; store the memory again with the new ${immutable}, then delete this one`);
    }
    const edits = { title, abstract, content, keywords, anchors, questions };
    if (Object.values(edits).every((edit) => edit === undefined)) {
        return {
            error: {
                message: "update requires at least one of title, abstract, content, keywords, anchors, questions",
            },
        };
    }
    return rejectionsAsToolErrors(() => (0, memories_1.updateMemory)(deps.env, visibleId(deps, id), edits));
}
async function memoryDelete(deps, args) {
    const id = requiredString(args, "id", ids_1.ID_MAX_CHARS);
    if (isToolError(id)) {
        return id;
    }
    return rejectionsAsToolErrors(() => (0, memories_1.deleteMemory)(deps.env, visibleId(deps, id)));
}
async function memoryRelate(deps, args) {
    const sourceId = requiredString(args, "source_id", ids_1.ID_MAX_CHARS);
    if (isToolError(sourceId)) {
        return sourceId;
    }
    const targetId = requiredString(args, "target_id", ids_1.ID_MAX_CHARS);
    if (isToolError(targetId)) {
        return targetId;
    }
    const relationType = requiredString(args, "relation_type", cfg_1.RELATION_TYPE_MAX_CHARS);
    if (isToolError(relationType)) {
        return relationType;
    }
    return rejectionsAsToolErrors(() => (0, relations_1.relate)(deps.env.db, visibleId(deps, sourceId), visibleId(deps, targetId), relationType));
}
function requiredIds(args) {
    const value = args.ids;
    const valid = Array.isArray(value) &&
        value.length >= 1 &&
        value.length <= FEEDBACK_IDS_MAX_ITEMS &&
        value.every((id) => typeof id === "string" && id !== "" && id.length <= ids_1.ID_MAX_CHARS);
    if (!valid) {
        return fieldError("ids", `ids must be a list of 1 to ${FEEDBACK_IDS_MAX_ITEMS} memory ids of at most ${ids_1.ID_MAX_CHARS} characters`);
    }
    return value;
}
async function memoryFeedback(deps, args) {
    const ids = requiredIds(args);
    if (isToolError(ids)) {
        return ids;
    }
    const verdict = requiredEnum(args, "verdict", lifecycle_1.FEEDBACK_VERDICTS);
    if (isToolError(verdict)) {
        return verdict;
    }
    return rejectionsAsToolErrors(() => {
        const outcome = (0, feedback_1.recordFeedback)(deps.env, {
            projectId: deps.projectId,
            ids,
            verdict,
            at: new Date().toISOString(),
        });
        return outcome.outcome === "recorded"
            ? { memories: outcome.memories }
            : fieldError("ids", outcome.reason);
    });
}
async function memoryDoctor(deps) {
    return (0, doctor_1.runDoctor)(deps.processEnv, deps.instructionSources.projectDir);
}
async function memoryStatus(deps) {
    return (0, status_2.statusReport)((0, status_1.statusFacts)(deps.env.db, deps.projectId), new Date().toISOString());
}
const ID_PROPERTY = { type: "string", maxLength: ids_1.ID_MAX_CHARS };
const TYPE_PROPERTY = { type: "string", enum: [...policy_1.MEMORY_TYPES] };
const KIND_PROPERTY = { type: "string", enum: [...policy_1.MEMORY_KINDS] };
const KEYWORDS_PROPERTY = { type: "string", maxLength: authoring_1.KEYWORDS_MAX_CHARS };
const ANCHORS_PROPERTY = {
    type: "array",
    items: { type: "string", maxLength: authoring_1.ANCHOR_MAX_CHARS },
    maxItems: authoring_1.ANCHORS_MAX_ITEMS,
};
const QUESTIONS_PROPERTY = {
    type: "array",
    items: { type: "string", maxLength: authoring_1.QUESTION_MAX_CHARS },
    maxItems: authoring_1.QUESTIONS_MAX_ITEMS,
};
const SCOPE_PROPERTY = { type: "string", enum: [...policy_1.MEMORY_SCOPES] };
const TITLE_PROPERTY = { type: "string", maxLength: cfg_1.TITLE_MAX_CHARS };
const CONTENT_PROPERTY = { type: "string", maxLength: cfg_1.CONTENT_MAX_CHARS };
const ABSTRACT_PROPERTY = { type: "string", maxLength: cfg_1.ABSTRACT_MAX_CHARS };
exports.TOOL_DEFINITIONS = [
    {
        name: "memory_store",
        description: "Store one durable lesson the moment it appears, without asking first: after a user correction the rule and its reason, a non-obvious convention you inferred, or the reasoning behind a solved problem (not the fix; the diff holds it). Store only what a future session could not re-derive from the code, git history or CLAUDE.md; content restating a line of CLAUDE.md, .claude/rules or the auto-memory MEMORY.md is rejected. English, one topic, insight first, searchable terms; scope=user only for facts that hold across projects. Always give kind, a stable lowercase dotted conflict_key naming the slot (project.primary_database, team.reviewers), cardinality, and value_text for a single-valued key. Add questions users would type when it matters, in English and their language. If the answer is needs_resolution, repeat the same call with resolution {action, target}: SUPERSEDE a changed single-valued fact, UPDATE to refine the same fact, NOOP when it is already known, ADD for a genuinely different memory.",
        inputSchema: {
            type: "object",
            properties: {
                title: TITLE_PROPERTY,
                content: CONTENT_PROPERTY,
                type: TYPE_PROPERTY,
                kind: KIND_PROPERTY,
                conflict_key: {
                    type: "string",
                    maxLength: authoring_1.CONFLICT_KEY_MAX_CHARS,
                    pattern: authoring_1.CONFLICT_KEY_PATTERN.source,
                },
                cardinality: { type: "string", enum: [...policy_1.CARDINALITIES] },
                value_text: { type: "string", maxLength: authoring_1.VALUE_TEXT_MAX_CHARS },
                keywords: KEYWORDS_PROPERTY,
                anchors: ANCHORS_PROPERTY,
                questions: QUESTIONS_PROPERTY,
                scope: SCOPE_PROPERTY,
                abstract: ABSTRACT_PROPERTY,
                resolution: {
                    type: "object",
                    properties: {
                        action: { type: "string", enum: [...policy_1.RESOLUTION_ACTIONS] },
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
        description: "Search memories by meaning. Returns one-line abstracts; fetch full content with memory_get using the id.",
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
        description: 'List memories newest first, without content. For the next page pass next_cursor as before; project "all" lists every project read-only.',
        inputSchema: {
            type: "object",
            properties: {
                state: { type: "string", enum: [...policy_1.MEMORY_STATES] },
                kind: KIND_PROPERTY,
                type: TYPE_PROPERTY,
                scope: SCOPE_PROPERTY,
                before: ID_PROPERTY,
                limit: { type: "integer", minimum: 1, maximum: listing_1.LIST_LIMIT_MAX },
                project: { type: "string", enum: [ALL_PROJECTS] },
            },
        },
        run: memoryList,
    },
    {
        name: "memory_get",
        description: "Fetch a memory by id or unique prefix, including content, state, conflict_key, value_text, superseded_by and relations. Superseded memories remain readable.",
        inputSchema: { type: "object", properties: { id: ID_PROPERTY }, required: ["id"] },
        run: memoryGet,
    },
    {
        name: "memory_update",
        description: "Update title, abstract, content, keywords, anchors or questions in place; each replaces the stored value whole. Revoked memories are immutable; scope and kind cannot change — re-store, then delete.",
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
                relation_type: { type: "string", maxLength: cfg_1.RELATION_TYPE_MAX_CHARS },
            },
            required: ["source_id", "target_id", "relation_type"],
        },
        run: memoryRelate,
    },
    {
        name: "memory_feedback",
        description: "After acting on injected memories, report what they were worth: used when a memory informed the work, wrong when it was incorrect or outdated, not_applicable when it was irrelevant. Pass the ids exactly as recall printed them; one call per turn is enough. A wrong memory leaves recall until a used receipt or a store of it brings it back; nothing is deleted. A call naming an unknown or revoked id records nothing.",
        inputSchema: {
            type: "object",
            properties: {
                ids: {
                    type: "array",
                    items: ID_PROPERTY,
                    minItems: 1,
                    maxItems: FEEDBACK_IDS_MAX_ITEMS,
                },
                verdict: { type: "string", enum: [...lifecycle_1.FEEDBACK_VERDICTS] },
            },
            required: ["ids", "verdict"],
        },
        run: memoryFeedback,
    },
    {
        name: "memory_doctor",
        description: "Health report covering node, plugin data, database, vec extension, model cache and FTS index.",
        inputSchema: { type: "object", properties: {} },
        run: (deps, _args) => memoryDoctor(deps),
    },
    {
        name: "memory_status",
        description: "What the memory holds and does for this project: its id and recall switch, memory counts by state and kind for user scope and this project, transitions by reason, the share of the newest 500 recall events that injected anything, the share of unpinned memories injected in receipt-giving sessions without a used receipt, open capture signals and the last injections.",
        inputSchema: { type: "object", properties: {} },
        run: (deps, _args) => memoryStatus(deps),
    },
];
