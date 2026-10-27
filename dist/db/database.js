"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.probeNativeModule = probeNativeModule;
exports.openDatabase = openDatabase;
exports.isStorageRejection = isStorageRejection;
exports.metaValue = metaValue;
exports.setMetaValue = setMetaValue;
exports.clearMetaValue = clearMetaValue;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const sqlite_vec_1 = require("sqlite-vec");
const cfg_1 = require("../cfg");
const lifecycle_1 = require("../lifecycle");
const policy_1 = require("../policy");
const session_1 = require("../session");
const version_1 = require("../version");
const schema_1 = require("./schema");
const transitions_1 = require("./transitions");
const BUSY_TIMEOUT_MS = 5000;
const WRITER_VERSION_KEY = "writer_version";
const WAL_RETRY_INTERVAL_MS = 20;
const GUARDING_CONSTRAINT_CODES = new Set([
    "SQLITE_CONSTRAINT_UNIQUE",
    "SQLITE_CONSTRAINT_TRIGGER",
]);
const LIVE_EMBEDDING = {
    embedding_model: cfg_1.MODEL_ID,
    embedding_dim: String(cfg_1.EMBED_DIM),
};
const migrationSteps = [
    { version: 1, apply: (db) => execAll(db, schema_1.baselineDdl) },
    { version: 2, apply: migrateToV2 },
    { version: 3, apply: migrateToV3 },
    { version: 4, apply: (db) => execAll(db, schema_1.schemaV4Ddl) },
    { version: 5, apply: (db) => execAll(db, schema_1.schemaV5Ddl) },
    { version: 6, apply: (db) => execAll(db, schema_1.schemaV6Ddl) },
    { version: 7, apply: (db) => execAll(db, schema_1.schemaV7Ddl) },
    { version: 8, apply: (db) => reactivateUnusedDemotions(db, PINNED_EXEMPTION, nowIso()) },
    { version: 9, apply: migrateToV9 },
];
const PINNED_EXEMPTION = {
    kinds: session_1.PINNED_KINDS,
    reason: "pinned_exemption",
    evidence: "schema v8 migration",
};
const SILENCE_NOT_EVIDENCE = {
    kinds: policy_1.MEMORY_KINDS,
    reason: "silence_not_evidence",
    evidence: "schema v9 migration",
};
function nowIso() {
    return new Date().toISOString();
}
function execAll(db, statements) {
    for (const statement of statements) {
        db.exec(statement);
    }
}
function migrateToV2(db) {
    execAll(db, schema_1.schemaV2Ddl);
    const rows = db.prepare("SELECT id, content FROM memories").all();
    const setHash = db.prepare("UPDATE memories SET content_hash = ? WHERE id = ?");
    for (const row of rows) {
        setHash.run((0, policy_1.contentHash)(row.content), row.id);
    }
}
function migrateToV3(db) {
    execAll(db, schema_1.schemaV3Ddl);
    const rows = db
        .prepare("SELECT id, used_count AS usedCount, wrong_count AS wrongCount FROM memories")
        .all();
    const setImportance = db.prepare("UPDATE memories SET importance = ? WHERE id = ?");
    for (const row of rows) {
        setImportance.run((0, lifecycle_1.derivedImportance)({ ...row, receiptedInjections: 0 }), row.id);
    }
}
function migrateToV9(db) {
    execAll(db, schema_1.schemaV9Ddl);
    const at = nowIso();
    const startTrial = db.prepare("UPDATE memories SET trial_started_at = ? WHERE id = ?");
    for (const id of reactivateUnusedDemotions(db, SILENCE_NOT_EVIDENCE, at)) {
        startTrial.run(at, id);
    }
}
function reactivateUnusedDemotions(db, repair, at) {
    const kinds = repair.kinds.map(() => "?").join(", ");
    const demoted = db
        .prepare(`SELECT m.id FROM memories m
       WHERE m.state = 'hypothesis' AND m.kind IN (${kinds})
         AND (SELECT t.reason FROM transitions t WHERE t.memory_id = m.id
              ORDER BY t.at DESC, t.rowid DESC LIMIT 1) = 'unused_after_receipts'
       ORDER BY m.updated_at DESC, m.id`)
        .pluck()
        .all(...repair.kinds);
    const reactivateUnlessSlotHeld = db.prepare(`UPDATE memories SET state = 'active', updated_at = ?
     WHERE id = ? AND NOT (cardinality = 'single' AND conflict_key <> '' AND EXISTS (
       SELECT 1 FROM memories holder
       WHERE holder.state = 'active' AND holder.cardinality = 'single'
         AND holder.conflict_key = memories.conflict_key AND holder.scope = memories.scope
         AND (memories.scope = 'user' OR holder.project_id = memories.project_id)))`);
    const reactivated = [];
    for (const id of demoted) {
        if (reactivateUnlessSlotHeld.run(at, id).changes === 1) {
            (0, transitions_1.recordTransition)(db, {
                memoryId: id,
                fromState: "hypothesis",
                toState: "active",
                reason: repair.reason,
                evidence: repair.evidence,
                relatedId: null,
                at,
            });
            reactivated.push(id);
        }
    }
    return reactivated;
}
function probeNativeModule() {
    new better_sqlite3_1.default(":memory:").close();
}
function openDatabase(config) {
    const db = new better_sqlite3_1.default(config.dbPath);
    try {
        db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
        enableWalMode(db);
        db.pragma("synchronous = NORMAL");
        db.pragma("foreign_keys = ON");
        const vec = loadVecExtension(db);
        runMigrations(db);
        ensureVecTable(db, vec.loaded);
        alignEmbeddingIndex(db, vec.loaded);
        return vec.loaded ? { db, vecLoaded: true } : { db, vecLoaded: false, vecError: vec.error };
    }
    catch (error) {
        db.close();
        throw error;
    }
}
function enableWalMode(db) {
    const deadline = performance.now() + BUSY_TIMEOUT_MS;
    while (performance.now() <= deadline) {
        try {
            const mode = db.pragma("journal_mode = WAL", { simple: true });
            if (mode === "wal") {
                return;
            }
        }
        catch (error) {
            if (!isBusyError(error)) {
                throw error;
            }
        }
        sleepSync(WAL_RETRY_INTERVAL_MS);
    }
    throw new Error(`database locked: wal mode not enabled within ${BUSY_TIMEOUT_MS} ms`);
}
function isBusyError(error) {
    return error instanceof better_sqlite3_1.default.SqliteError && error.code.startsWith("SQLITE_BUSY");
}
function isStorageRejection(error) {
    return (isBusyError(error) ||
        (error instanceof better_sqlite3_1.default.SqliteError && GUARDING_CONSTRAINT_CODES.has(error.code)));
}
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function loadVecExtension(db) {
    try {
        db.loadExtension((0, sqlite_vec_1.getLoadablePath)());
        return { loaded: true };
    }
    catch (error) {
        return { loaded: false, error: error instanceof Error ? error.message : String(error) };
    }
}
function runMigrations(db) {
    const migrate = db.transaction(() => {
        const current = schemaVersionIn(db);
        if (current > schema_1.SCHEMA_VERSION) {
            throw schemaTooNew(current, metaValue(db, WRITER_VERSION_KEY));
        }
        for (const step of migrationSteps) {
            if (step.version <= current) {
                continue;
            }
            step.apply(db);
            setMetaValue(db, "schema_version", String(step.version));
        }
        setMetaValue(db, WRITER_VERSION_KEY, version_1.PLUGIN_VERSION);
    });
    migrate.immediate();
}
function schemaTooNew(schemaVersion, writerVersion) {
    const writtenBy = writerVersion === undefined ? "an unknown plugin version" : `${version_1.PLUGIN_NAME} ${writerVersion}`;
    return new schema_1.SchemaTooNewError(`database schema ${schemaVersion} written by ${writtenBy} is newer than this build supports (schema ${schema_1.SCHEMA_VERSION}, ${version_1.PLUGIN_NAME} ${version_1.PLUGIN_VERSION}): update the plugin`);
}
function metaValue(db, key) {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row?.value;
}
function setMetaValue(db, key, value) {
    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE value <> excluded.value`).run(key, value);
}
function clearMetaValue(db, key) {
    if (metaValue(db, key) !== undefined) {
        db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    }
}
function schemaVersionIn(db) {
    const metaTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
        .get();
    if (metaTable === undefined) {
        return 0;
    }
    const value = metaValue(db, "schema_version");
    if (value === undefined) {
        throw new Error("schema_version not set but meta table exists: inconsistent database");
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`schema_version mismatch: expected integer, actual '${value}'`);
    }
    return parsed;
}
const VEC_STATE_COLUMN = "state";
const QUESTIONS_VEC_TABLE = "questions_vec";
function vecTableShape(db) {
    const columns = db.prepare("PRAGMA table_info(memories_vec)").all();
    if (columns.length === 0) {
        return "missing";
    }
    return columns.some((column) => column.name === VEC_STATE_COLUMN) ? "current" : "stateless";
}
function hasTable(db, name) {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name) !== undefined;
}
function ensureVecTable(db, vecLoaded) {
    if (!vecLoaded || (vecTableShape(db) === "current" && hasTable(db, QUESTIONS_VEC_TABLE))) {
        return;
    }
    const reshape = db.transaction(() => {
        const shape = vecTableShape(db);
        if (shape === "missing") {
            db.exec(schema_1.vecTableDdl);
        }
        else if (shape === "stateless") {
            rebuildVecTableWithState(db);
        }
        if (!hasTable(db, QUESTIONS_VEC_TABLE)) {
            db.exec(schema_1.questionsVecTableDdl);
        }
    });
    reshape.immediate();
}
function rebuildVecTableWithState(db) {
    const rows = db
        .prepare(`SELECT v.memory_id AS memoryId, v.embedding AS embedding, m.type AS type, m.scope AS scope,
              m.project_id AS projectId, m.state AS state
       FROM memories_vec v JOIN memories m ON m.id = v.memory_id`)
        .all();
    db.exec("DROP TABLE memories_vec");
    db.exec(schema_1.vecTableDdl);
    const insert = db.prepare("INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id, state) VALUES (?, ?, ?, ?, ?, ?)");
    for (const row of rows) {
        insert.run(row.memoryId, row.embedding, row.type, row.scope, row.projectId, row.state);
    }
}
function embeddedByAnotherModel(db) {
    return Object.entries(LIVE_EMBEDDING).some(([key, live]) => {
        const recorded = metaValue(db, key);
        if (recorded === undefined) {
            throw new Error(`${key} not set in meta: inconsistent database`);
        }
        return recorded !== live;
    });
}
function alignEmbeddingIndex(db, vecLoaded) {
    if (!vecLoaded || !embeddedByAnotherModel(db)) {
        return;
    }
    const reindex = db.transaction(() => {
        if (!embeddedByAnotherModel(db)) {
            return;
        }
        db.exec("DROP TABLE memories_vec");
        db.exec(schema_1.vecTableDdl);
        db.exec(`DROP TABLE ${QUESTIONS_VEC_TABLE}`);
        db.exec(schema_1.questionsVecTableDdl);
        for (const [key, live] of Object.entries(LIVE_EMBEDDING)) {
            setMetaValue(db, key, live);
        }
    });
    reindex.immediate();
}
