"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportSnapshot = exportSnapshot;
exports.stampExport = stampExport;
exports.lastExportAt = lastExportAt;
exports.importRecords = importRecords;
const policy_1 = require("../policy");
const transfer_1 = require("../transfer");
const database_1 = require("./database");
const LAST_EXPORT_AT_KEY = "last_export_at";
const MEMORY_COLUMNS = [
    "id",
    "type",
    "kind",
    "scope",
    "project_id",
    "title",
    "abstract",
    "content",
    "conflict_key",
    "cardinality",
    "value_text",
    "keywords",
    "anchors",
    "epistemic",
    "origin",
    "state",
    "importance",
    "support_count",
    "conflict_count",
    "injection_count",
    "used_count",
    "wrong_count",
    "valid_from",
    "invalid_at",
    "expired_at",
    "last_injected_at",
    "superseded_by",
    "created_at",
    "updated_at",
];
function exportSnapshot(db) {
    return db
        .transaction(() => ({
        memories: db
            .prepare(`SELECT ${MEMORY_COLUMNS.join(", ")} FROM memories ORDER BY id`)
            .all(),
        relations: db
            .prepare("SELECT source_id, target_id, relation_type FROM relations ORDER BY source_id, target_id, relation_type")
            .all(),
        transitions: db
            .prepare("SELECT memory_id, from_state, to_state, reason, evidence, related_id, at FROM transitions ORDER BY rowid")
            .all(),
    }))
        .deferred();
}
function stampExport(db, at) {
    (0, database_1.setMetaValue)(db, LAST_EXPORT_AT_KEY, at);
}
function lastExportAt(db) {
    return (0, database_1.metaValue)(db, LAST_EXPORT_AT_KEY);
}
function slotHolders(db) {
    const rows = db
        .prepare(`SELECT id, scope, project_id AS projectId, conflict_key AS conflictKey FROM memories
       WHERE cardinality = 'single' AND state = 'active' AND conflict_key <> ''`)
        .all();
    return rows.map((row) => ({
        id: row.id,
        slot: (0, transfer_1.slotOf)(row.scope, row.projectId, row.conflictKey),
    }));
}
function existingIds(db) {
    return new Set(db.prepare("SELECT id FROM memories").pluck().all());
}
function writeImport(db, writes) {
    db.pragma("defer_foreign_keys = ON");
    const insertMemory = db.prepare(`INSERT INTO memories (${MEMORY_COLUMNS.join(", ")}, content_hash)
     VALUES (${MEMORY_COLUMNS.map(() => "?").join(", ")}, ?)`);
    for (const memory of writes.memories) {
        insertMemory.run(...MEMORY_COLUMNS.map((column) => column === "anchors" ? JSON.stringify(memory.anchors) : memory[column]), (0, policy_1.contentHash)(memory.content));
    }
    const insertRelation = db.prepare("INSERT OR IGNORE INTO relations (source_id, target_id, relation_type) VALUES (?, ?, ?)");
    for (const relation of writes.relations) {
        insertRelation.run(relation.source_id, relation.target_id, relation.relation_type);
    }
    const insertTransition = db.prepare(`INSERT INTO transitions (memory_id, from_state, to_state, reason, evidence, related_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const transition of writes.transitions) {
        insertTransition.run(transition.memory_id, transition.from_state, transition.to_state, transition.reason, transition.evidence, transition.related_id, transition.at);
    }
}
function importRecords(db, records) {
    return db
        .transaction(() => {
        const plan = (0, transfer_1.planImport)(records, {
            existingIds: existingIds(db),
            slotHolders: slotHolders(db),
        });
        if (plan.ok) {
            writeImport(db, plan);
        }
        return plan;
    })
        .immediate();
}
