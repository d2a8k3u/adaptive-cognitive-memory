import Database from "better-sqlite3";
import { getLoadablePath } from "sqlite-vec";
import { type Config, EMBED_DIM, MODEL_ID } from "../cfg";
import { derivedImportance } from "../lifecycle";
import { contentHash } from "../policy";
import { PINNED_KINDS } from "../session";
import { PLUGIN_NAME, PLUGIN_VERSION } from "../version";
import {
  baselineDdl,
  questionsVecTableDdl,
  SCHEMA_VERSION,
  SchemaTooNewError,
  schemaV2Ddl,
  schemaV3Ddl,
  schemaV4Ddl,
  schemaV5Ddl,
  schemaV6Ddl,
  schemaV7Ddl,
  schemaV9Ddl,
  vecTableDdl,
} from "./schema";
import { recordTransition } from "./transitions";

export type Db = InstanceType<typeof Database>;

export type OpenedDb = { db: Db; vecLoaded: true } | { db: Db; vecLoaded: false; vecError: string };

type VecLoad = { readonly loaded: true } | { readonly loaded: false; readonly error: string };

const BUSY_TIMEOUT_MS = 5000;
const WRITER_VERSION_KEY = "writer_version";
const WAL_RETRY_INTERVAL_MS = 20;
const GUARDING_CONSTRAINT_CODES: ReadonlySet<string> = new Set([
  "SQLITE_CONSTRAINT_UNIQUE",
  "SQLITE_CONSTRAINT_TRIGGER",
]);

const LIVE_EMBEDDING: Readonly<Record<string, string>> = {
  embedding_model: MODEL_ID,
  embedding_dim: String(EMBED_DIM),
};

interface MigrationStep {
  version: number;
  apply: (db: Db) => void;
}

const migrationSteps: readonly MigrationStep[] = [
  { version: 1, apply: (db) => execAll(db, baselineDdl) },
  { version: 2, apply: migrateToV2 },
  { version: 3, apply: migrateToV3 },
  { version: 4, apply: (db) => execAll(db, schemaV4Ddl) },
  { version: 5, apply: (db) => execAll(db, schemaV5Ddl) },
  { version: 6, apply: (db) => execAll(db, schemaV6Ddl) },
  { version: 7, apply: (db) => execAll(db, schemaV7Ddl) },
  { version: 8, apply: (db) => reactivatePinnedDemotions(db, new Date().toISOString()) },
  { version: 9, apply: (db) => execAll(db, schemaV9Ddl) },
];

const PINNED_EXEMPTION_REASON = "pinned_exemption";
const PINNED_EXEMPTION_EVIDENCE = "schema v8 migration";

function execAll(db: Db, statements: readonly string[]): void {
  for (const statement of statements) {
    db.exec(statement);
  }
}

function migrateToV2(db: Db): void {
  execAll(db, schemaV2Ddl);
  const rows = db.prepare("SELECT id, content FROM memories").all() as {
    id: string;
    content: string;
  }[];
  const setHash = db.prepare("UPDATE memories SET content_hash = ? WHERE id = ?");
  for (const row of rows) {
    setHash.run(contentHash(row.content), row.id);
  }
}

function migrateToV3(db: Db): void {
  execAll(db, schemaV3Ddl);
  const rows = db
    .prepare("SELECT id, used_count AS usedCount, wrong_count AS wrongCount FROM memories")
    .all() as { id: string; usedCount: number; wrongCount: number }[];
  const setImportance = db.prepare("UPDATE memories SET importance = ? WHERE id = ?");
  for (const row of rows) {
    setImportance.run(derivedImportance({ ...row, receiptedInjections: 0 }), row.id);
  }
}

function reactivatePinnedDemotions(db: Db, at: string): void {
  const pinnedKinds = PINNED_KINDS.map(() => "?").join(", ");
  const demoted = db
    .prepare(
      `SELECT m.id FROM memories m
       WHERE m.state = 'hypothesis' AND m.kind IN (${pinnedKinds})
         AND (SELECT t.reason FROM transitions t WHERE t.memory_id = m.id
              ORDER BY t.at DESC, t.rowid DESC LIMIT 1) = 'unused_after_receipts'
       ORDER BY m.updated_at DESC, m.id`,
    )
    .pluck()
    .all(...PINNED_KINDS) as string[];
  const reactivateUnlessSlotHeld = db.prepare(
    `UPDATE memories SET state = 'active', updated_at = ?
     WHERE id = ? AND NOT (cardinality = 'single' AND conflict_key <> '' AND EXISTS (
       SELECT 1 FROM memories holder
       WHERE holder.state = 'active' AND holder.cardinality = 'single'
         AND holder.conflict_key = memories.conflict_key AND holder.scope = memories.scope
         AND (memories.scope = 'user' OR holder.project_id = memories.project_id)))`,
  );
  for (const id of demoted) {
    if (reactivateUnlessSlotHeld.run(at, id).changes === 1) {
      recordTransition(db, {
        memoryId: id,
        fromState: "hypothesis",
        toState: "active",
        reason: PINNED_EXEMPTION_REASON,
        evidence: PINNED_EXEMPTION_EVIDENCE,
        relatedId: null,
        at,
      });
    }
  }
}

export function probeNativeModule(): void {
  new Database(":memory:").close();
}

export function openDatabase(config: Config): OpenedDb {
  const db = new Database(config.dbPath);
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
  } catch (error) {
    db.close();
    throw error;
  }
}

function enableWalMode(db: Db): void {
  const deadline = performance.now() + BUSY_TIMEOUT_MS;
  while (performance.now() <= deadline) {
    try {
      const mode = db.pragma("journal_mode = WAL", { simple: true }) as string;
      if (mode === "wal") {
        return;
      }
    } catch (error) {
      if (!isBusyError(error)) {
        throw error;
      }
    }
    sleepSync(WAL_RETRY_INTERVAL_MS);
  }
  throw new Error(`database locked: wal mode not enabled within ${BUSY_TIMEOUT_MS} ms`);
}

function isBusyError(error: unknown): boolean {
  return error instanceof Database.SqliteError && error.code.startsWith("SQLITE_BUSY");
}

export function isStorageRejection(error: unknown): error is Error {
  return (
    isBusyError(error) ||
    (error instanceof Database.SqliteError && GUARDING_CONSTRAINT_CODES.has(error.code))
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function loadVecExtension(db: Db): VecLoad {
  try {
    db.loadExtension(getLoadablePath());
    return { loaded: true };
  } catch (error) {
    return { loaded: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function runMigrations(db: Db): void {
  const migrate = db.transaction(() => {
    const current = schemaVersionIn(db);
    if (current > SCHEMA_VERSION) {
      throw schemaTooNew(current, metaValue(db, WRITER_VERSION_KEY));
    }
    for (const step of migrationSteps) {
      if (step.version <= current) {
        continue;
      }
      step.apply(db);
      setMetaValue(db, "schema_version", String(step.version));
    }
    setMetaValue(db, WRITER_VERSION_KEY, PLUGIN_VERSION);
  });
  migrate.immediate();
}

function schemaTooNew(schemaVersion: number, writerVersion: string | undefined): SchemaTooNewError {
  const writtenBy =
    writerVersion === undefined ? "an unknown plugin version" : `${PLUGIN_NAME} ${writerVersion}`;
  return new SchemaTooNewError(
    `database schema ${schemaVersion} written by ${writtenBy} is newer than this build supports (schema ${SCHEMA_VERSION}, ${PLUGIN_NAME} ${PLUGIN_VERSION}): update the plugin`,
  );
}

export function metaValue(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMetaValue(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE value <> excluded.value`,
  ).run(key, value);
}

export function clearMetaValue(db: Db, key: string): void {
  if (metaValue(db, key) !== undefined) {
    db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }
}

function schemaVersionIn(db: Db): number {
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

type VecTableShape = "missing" | "stateless" | "current";

const VEC_STATE_COLUMN = "state";
const QUESTIONS_VEC_TABLE = "questions_vec";

function vecTableShape(db: Db): VecTableShape {
  const columns = db.prepare("PRAGMA table_info(memories_vec)").all() as { name: string }[];
  if (columns.length === 0) {
    return "missing";
  }
  return columns.some((column) => column.name === VEC_STATE_COLUMN) ? "current" : "stateless";
}

function hasTable(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name) !== undefined;
}

function ensureVecTable(db: Db, vecLoaded: boolean): void {
  if (!vecLoaded || (vecTableShape(db) === "current" && hasTable(db, QUESTIONS_VEC_TABLE))) {
    return;
  }
  const reshape = db.transaction(() => {
    const shape = vecTableShape(db);
    if (shape === "missing") {
      db.exec(vecTableDdl);
    } else if (shape === "stateless") {
      rebuildVecTableWithState(db);
    }
    if (!hasTable(db, QUESTIONS_VEC_TABLE)) {
      db.exec(questionsVecTableDdl);
    }
  });
  reshape.immediate();
}

function rebuildVecTableWithState(db: Db): void {
  const rows = db
    .prepare(
      `SELECT v.memory_id AS memoryId, v.embedding AS embedding, m.type AS type, m.scope AS scope,
              m.project_id AS projectId, m.state AS state
       FROM memories_vec v JOIN memories m ON m.id = v.memory_id`,
    )
    .all() as {
    memoryId: string;
    embedding: Buffer;
    type: string;
    scope: string;
    projectId: string;
    state: string;
  }[];
  db.exec("DROP TABLE memories_vec");
  db.exec(vecTableDdl);
  const insert = db.prepare(
    "INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id, state) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(row.memoryId, row.embedding, row.type, row.scope, row.projectId, row.state);
  }
}

function embeddedByAnotherModel(db: Db): boolean {
  return Object.entries(LIVE_EMBEDDING).some(([key, live]) => {
    const recorded = metaValue(db, key);
    if (recorded === undefined) {
      throw new Error(`${key} not set in meta: inconsistent database`);
    }
    return recorded !== live;
  });
}

function alignEmbeddingIndex(db: Db, vecLoaded: boolean): void {
  if (!vecLoaded || !embeddedByAnotherModel(db)) {
    return;
  }
  const reindex = db.transaction(() => {
    if (!embeddedByAnotherModel(db)) {
      return;
    }
    db.exec("DROP TABLE memories_vec");
    db.exec(vecTableDdl);
    db.exec(`DROP TABLE ${QUESTIONS_VEC_TABLE}`);
    db.exec(questionsVecTableDdl);
    for (const [key, live] of Object.entries(LIVE_EMBEDDING)) {
      setMetaValue(db, key, live);
    }
  });
  reindex.immediate();
}
