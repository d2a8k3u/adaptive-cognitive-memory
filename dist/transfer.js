"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXPORT_HEADER = void 0;
exports.memoryLine = memoryLine;
exports.exportText = exportText;
exports.parseImport = parseImport;
exports.slotOf = slotOf;
exports.planImport = planImport;
const cfg_1 = require("./cfg");
const keys_1 = require("./keys");
const policy_1 = require("./policy");
const redact_1 = require("./redact");
exports.EXPORT_HEADER = {
    record: "header",
    format: "adaptive-cognitive-memory",
    version: 1,
};
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
function text(maxChars) {
    return (field, value) => {
        if (typeof value === "string" && (maxChars === undefined || value.length <= maxChars)) {
            return undefined;
        }
        return maxChars === undefined
            ? `${field} must be a string`
            : `${field} must be a string of at most ${maxChars} characters`;
    };
}
const memoryId = (field, value) => typeof value === "string" && value !== "" ? undefined : `${field} must be a non-empty string`;
const optionalMemoryId = (field, value) => value === null ? undefined : memoryId(field, value);
function oneOf(values) {
    return (field, value) => typeof value === "string" && values.includes(value)
        ? undefined
        : `${field} must be one of ${values.join(", ")}`;
}
const counter = (field, value) => typeof value === "number" && Number.isInteger(value) && value >= 0
    ? undefined
    : `${field} must be a non-negative integer`;
const unitInterval = (field, value) => typeof value === "number" && value >= 0 && value <= 1
    ? undefined
    : `${field} must be a number between 0 and 1`;
const instant = (field, value) => typeof value === "string" && ISO_INSTANT.test(value)
    ? undefined
    : `${field} must be an ISO-8601 UTC timestamp`;
const optionalInstant = (field, value) => value === null ? undefined : instant(field, value);
const stringList = (field, value) => Array.isArray(value) && value.every((item) => typeof item === "string")
    ? undefined
    : `${field} must be a list of strings`;
const MEMORY_FIELDS = {
    id: memoryId,
    type: oneOf(policy_1.MEMORY_TYPES),
    kind: oneOf(policy_1.MEMORY_KINDS),
    scope: oneOf(policy_1.MEMORY_SCOPES),
    project_id: text(),
    title: text(cfg_1.TITLE_MAX_CHARS),
    abstract: text(cfg_1.ABSTRACT_MAX_CHARS),
    content: text(cfg_1.CONTENT_MAX_CHARS),
    conflict_key: text(),
    cardinality: oneOf(policy_1.CARDINALITIES),
    value_text: text(),
    keywords: text(),
    anchors: stringList,
    epistemic: oneOf(policy_1.EPISTEMIC_STATES),
    origin: oneOf(policy_1.MEMORY_ORIGINS),
    state: oneOf(policy_1.MEMORY_STATES),
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
const RELATION_FIELDS = {
    source_id: memoryId,
    target_id: memoryId,
    relation_type: text(cfg_1.RELATION_TYPE_MAX_CHARS),
};
const TRANSITION_FIELDS = {
    memory_id: memoryId,
    from_state: oneOf(policy_1.MEMORY_STATES),
    to_state: oneOf(policy_1.MEMORY_STATES),
    reason: text(),
    evidence: text(),
    related_id: optionalMemoryId,
    at: instant,
};
const FIELDS_BY_RECORD = {
    memory: MEMORY_FIELDS,
    relation: RELATION_FIELDS,
    transition: TRANSITION_FIELDS,
};
function isRecordKind(value) {
    return typeof value === "string" && Object.hasOwn(FIELDS_BY_RECORD, value);
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function scrubbed(text) {
    return (0, redact_1.redact)(text).text;
}
function redactedMemoryLine(line) {
    return {
        ...line,
        title: (0, redact_1.redactWithin)(line.title, cfg_1.TITLE_MAX_CHARS),
        abstract: (0, redact_1.redactWithin)(line.abstract, cfg_1.ABSTRACT_MAX_CHARS),
        content: (0, redact_1.redactWithin)(line.content, cfg_1.CONTENT_MAX_CHARS),
        value_text: scrubbed(line.value_text),
        keywords: scrubbed(line.keywords),
        anchors: line.anchors.map(scrubbed),
    };
}
function redactedTransitionLine(line) {
    return { ...line, evidence: scrubbed(line.evidence) };
}
function memoryLine(row) {
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
        anchors: (0, keys_1.parseStoredAnchors)(row.id, row.anchors),
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
function exportText(snapshot) {
    const records = [
        exports.EXPORT_HEADER,
        ...snapshot.memories.map(memoryLine),
        ...snapshot.relations.map((row) => ({
            record: "relation",
            source_id: row.source_id,
            target_id: row.target_id,
            relation_type: row.relation_type,
        })),
        ...snapshot.transitions.map((row) => redactedTransitionLine({
            record: "transition",
            memory_id: row.memory_id,
            from_state: row.from_state,
            to_state: row.to_state,
            reason: row.reason,
            evidence: row.evidence,
            related_id: row.related_id,
            at: row.at,
        })),
    ];
    return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
function parsedJson(raw) {
    try {
        return { value: JSON.parse(raw) };
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            return { error: `not JSON (${error.message})` };
        }
        throw error;
    }
}
function isExportHeader(value) {
    return (isPlainObject(value) &&
        Object.keys(value).length === Object.keys(exports.EXPORT_HEADER).length &&
        Object.entries(exports.EXPORT_HEADER).every(([key, expected]) => value[key] === expected));
}
function recordErrors(value) {
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
function parseImport(content) {
    const lines = content.split("\n");
    const errors = [];
    const records = [];
    if (!isExportHeader(parsedValue(lines[0] ?? ""))) {
        errors.push(`line 1: expected the export header ${JSON.stringify(exports.EXPORT_HEADER)}`);
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
            records.push({ line, record: parsed.value });
        }
    });
    return errors.length === 0 ? { ok: true, records } : { ok: false, errors };
}
function parsedValue(raw) {
    const parsed = parsedJson(raw);
    return "value" in parsed ? parsed.value : undefined;
}
function slotOf(scope, projectId, conflictKey) {
    return JSON.stringify([scope, scope === "user" ? "" : projectId, conflictKey]);
}
function holdsSingleSlot(memory) {
    return memory.cardinality === "single" && memory.state === "active" && memory.conflict_key !== "";
}
function memoriesOf(records) {
    return records.flatMap(({ line, record }) => record.record === "memory" ? [{ line, memory: record }] : []);
}
function duplicateIdErrors(memories) {
    const firstLine = new Map();
    return memories.flatMap(({ line, memory }) => {
        const first = firstLine.get(memory.id);
        if (first !== undefined) {
            return [`line ${line}: duplicate memory id ${memory.id} (first on line ${first})`];
        }
        firstLine.set(memory.id, line);
        return [];
    });
}
function referencesOf(record) {
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
function referenceErrors(records, knownIds) {
    return records.flatMap(({ line, record }) => referencesOf(record).flatMap(([field, id]) => id === null || knownIds.has(id)
        ? []
        : [`line ${line}: ${field} ${id} names no memory in the file or the database`]));
}
function slotErrors(added, existing) {
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
function relationsOf(records) {
    return records.flatMap(({ line, record }) => record.record === "relation" ? [{ line, relation: record }] : []);
}
function distinctRelations(relations) {
    const seen = new Set();
    return relations.filter(({ relation }) => {
        const key = JSON.stringify([relation.source_id, relation.target_id, relation.relation_type]);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
function relationCapErrors(relations) {
    const countBySource = new Map();
    return relations.flatMap(({ line, relation }) => {
        const count = (countBySource.get(relation.source_id) ?? 0) + 1;
        countBySource.set(relation.source_id, count);
        return count > cfg_1.RELATION_CAP
            ? [
                `line ${line}: relation to ${relation.target_id} is relation ${count} of ${relation.source_id}; a memory holds at most ${cfg_1.RELATION_CAP} relations`,
            ]
            : [];
    });
}
function planImport(records, facts) {
    const memories = memoriesOf(records);
    const added = memories.filter(({ memory }) => !facts.existingIds.has(memory.id));
    const addedIds = new Set(added.map(({ memory }) => memory.id));
    const knownIds = new Set([...facts.existingIds, ...memories.map(({ memory }) => memory.id)]);
    const addedRelations = distinctRelations(relationsOf(records).filter(({ relation }) => addedIds.has(relation.source_id)));
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
        transitions: records.flatMap(({ record }) => record.record === "transition" && addedIds.has(record.memory_id)
            ? [redactedTransitionLine(record)]
            : []),
        skipped: memories.length - added.length,
    };
}
