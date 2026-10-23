import {
  ABSTRACT_MAX_CHARS,
  CONTENT_MAX_CHARS,
  EMBED_DIM,
  MODEL_ID,
  RELATION_CAP,
  RELATION_TYPE_MAX_CHARS,
  SIGNAL_DETAIL_MAX_CHARS,
  TITLE_MAX_CHARS,
} from "../cfg";
import { RECALL_EVENT_NAMES } from "./events";

export const SCHEMA_VERSION = 7;

export class SchemaTooNewError extends Error {}

export const baselineDdl: readonly string[] = [
  `CREATE TABLE meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE memories (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('semantic', 'episodic', 'procedural', 'pattern')),
    scope TEXT NOT NULL CHECK (scope IN ('project', 'user')),
    project_id TEXT NOT NULL,
    title TEXT NOT NULL CHECK (length(title) <= ${TITLE_MAX_CHARS}),
    abstract TEXT NOT NULL CHECK (length(abstract) <= ${ABSTRACT_MAX_CHARS}),
    content TEXT NOT NULL CHECK (length(content) <= ${CONTENT_MAX_CHARS}),
    importance REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
    superseded_by TEXT REFERENCES memories(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX memories_scope_project ON memories (scope, project_id)",
  "CREATE INDEX memories_superseded_by ON memories (superseded_by) WHERE superseded_by IS NOT NULL",
  `CREATE TABLE relations (
    source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL CHECK (length(relation_type) <= ${RELATION_TYPE_MAX_CHARS}),
    PRIMARY KEY (source_id, target_id, relation_type)
  )`,
  "CREATE INDEX relations_target ON relations (target_id)",
  `CREATE TRIGGER relations_cap BEFORE INSERT ON relations
  WHEN (SELECT count(*) FROM relations WHERE source_id = new.source_id) >= ${RELATION_CAP}
  BEGIN
    SELECT RAISE(ABORT, 'relation cap ${RELATION_CAP} reached for source');
  END`,
  `CREATE VIRTUAL TABLE memories_fts USING fts5(
    title, abstract, content,
    content = 'memories',
    content_rowid = 'rowid',
    detail = full
  )`,
  `CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, title, abstract, content)
    VALUES (new.rowid, new.title, new.abstract, new.content);
  END`,
  `CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, title, abstract, content)
    VALUES ('delete', old.rowid, old.title, old.abstract, old.content);
  END`,
  `CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, title, abstract, content)
    VALUES ('delete', old.rowid, old.title, old.abstract, old.content);
    INSERT INTO memories_fts (rowid, title, abstract, content)
    VALUES (new.rowid, new.title, new.abstract, new.content);
  END`,
  `INSERT INTO meta (key, value) VALUES ('embedding_model', '${MODEL_ID}'), ('embedding_dim', '${EMBED_DIM}')`,
];

const FTS_V2_COLUMNS = "title, abstract, conflict_key, keywords, value_text";
const FTS_V2_NEW_VALUES =
  "new.rowid, new.title, new.abstract, new.conflict_key, new.keywords, new.value_text";
const FTS_V2_OLD_VALUES =
  "old.rowid, old.title, old.abstract, old.conflict_key, old.keywords, old.value_text";

export const schemaV2Ddl: readonly string[] = [
  "ALTER TABLE memories ADD COLUMN conflict_key TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE memories ADD COLUMN cardinality TEXT NOT NULL DEFAULT 'multi' CHECK (cardinality IN ('single', 'multi'))",
  "ALTER TABLE memories ADD COLUMN value_text TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('constraint', 'preference', 'fact', 'procedure', 'belief'))",
  "ALTER TABLE memories ADD COLUMN epistemic TEXT NOT NULL DEFAULT 'verified' CHECK (epistemic IN ('verified', 'unverified'))",
  "ALTER TABLE memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'claude' CHECK (origin IN ('user', 'claude', 'tool'))",
  "ALTER TABLE memories ADD COLUMN state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('hypothesis', 'active', 'revoked'))",
  "ALTER TABLE memories ADD COLUMN keywords TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE memories ADD COLUMN anchors TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE memories ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE memories ADD COLUMN valid_from TEXT",
  "ALTER TABLE memories ADD COLUMN invalid_at TEXT",
  "ALTER TABLE memories ADD COLUMN expired_at TEXT",
  "ALTER TABLE memories ADD COLUMN support_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE memories ADD COLUMN conflict_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE memories ADD COLUMN injection_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE memories ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE memories ADD COLUMN wrong_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE memories ADD COLUMN last_injected_at TEXT",
  `UPDATE memories SET
     valid_from = created_at,
     state = CASE WHEN superseded_by IS NULL THEN 'active' ELSE 'revoked' END`,
  `CREATE UNIQUE INDEX memories_single_active_key
     ON memories (scope, CASE scope WHEN 'user' THEN '' ELSE project_id END, conflict_key)
     WHERE cardinality = 'single' AND state = 'active' AND conflict_key <> ''`,
  "CREATE INDEX memories_conflict_key ON memories (conflict_key) WHERE conflict_key <> ''",
  "CREATE INDEX memories_content_hash ON memories (content_hash)",
  `CREATE TABLE transitions (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL,
    related_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
    at TEXT NOT NULL
  )`,
  "CREATE INDEX transitions_memory ON transitions (memory_id)",
  "CREATE INDEX transitions_related ON transitions (related_id) WHERE related_id IS NOT NULL",
  `CREATE TABLE injections (
    session_id TEXT NOT NULL,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (session_id, memory_id, at)
  )`,
  "DROP TRIGGER memories_fts_insert",
  "DROP TRIGGER memories_fts_delete",
  "DROP TRIGGER memories_fts_update",
  "DROP TABLE memories_fts",
  `CREATE VIRTUAL TABLE memories_fts USING fts5(
    ${FTS_V2_COLUMNS},
    content = 'memories',
    content_rowid = 'rowid',
    detail = full
  )`,
  `CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, ${FTS_V2_COLUMNS}) VALUES (${FTS_V2_NEW_VALUES});
  END`,
  `CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, ${FTS_V2_COLUMNS})
    VALUES ('delete', ${FTS_V2_OLD_VALUES});
  END`,
  `CREATE TRIGGER memories_fts_update
   AFTER UPDATE OF title, abstract, conflict_key, keywords, value_text ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, ${FTS_V2_COLUMNS})
    VALUES ('delete', ${FTS_V2_OLD_VALUES});
    INSERT INTO memories_fts (rowid, ${FTS_V2_COLUMNS}) VALUES (${FTS_V2_NEW_VALUES});
  END`,
  "INSERT INTO memories_fts (memories_fts) VALUES ('rebuild')",
];

export const schemaV3Ddl: readonly string[] = [
  `CREATE TABLE receipt_sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    first_at TEXT NOT NULL
  )`,
  "CREATE INDEX injections_memory ON injections (memory_id)",
  "CREATE INDEX injections_at ON injections (at)",
];

export const schemaV4Ddl: readonly string[] = [
  `CREATE TABLE session_signals (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('correction', 'remember', 'resolution')),
    detail TEXT NOT NULL CHECK (length(detail) <= ${SIGNAL_DETAIL_MAX_CHARS}),
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    closed_by TEXT CHECK (closed_by IN ('checkpoint', 'receipt')),
    CHECK ((closed_at IS NULL) = (closed_by IS NULL))
  )`,
  "CREATE INDEX session_signals_open ON session_signals (session_id) WHERE closed_at IS NULL",
  `CREATE TABLE command_failures (
    session_id TEXT NOT NULL,
    head TEXT NOT NULL CHECK (length(head) <= ${SIGNAL_DETAIL_MAX_CHARS}),
    failed_at TEXT NOT NULL,
    PRIMARY KEY (session_id, head)
  )`,
];

export const schemaV5Ddl: readonly string[] = [
  `CREATE TABLE recall_events (
    id INTEGER PRIMARY KEY,
    session_id TEXT,
    event TEXT NOT NULL CHECK (event IN ('SessionStart', 'UserPromptSubmit', 'PreToolUse')),
    at TEXT NOT NULL,
    injected INTEGER NOT NULL CHECK (injected >= 0)
  )`,
  `CREATE TABLE project_settings (
    project_id TEXT PRIMARY KEY NOT NULL,
    recall_enabled INTEGER NOT NULL CHECK (recall_enabled IN (0, 1)),
    updated_at TEXT NOT NULL
  )`,
];

const RECALL_EVENT_CHECK_LIST = RECALL_EVENT_NAMES.map((event) => `'${event}'`).join(", ");

export const schemaV6Ddl: readonly string[] = [
  `CREATE TABLE recall_events_v6 (
    id INTEGER PRIMARY KEY,
    session_id TEXT,
    event TEXT NOT NULL CHECK (event IN (${RECALL_EVENT_CHECK_LIST})),
    at TEXT NOT NULL,
    injected INTEGER NOT NULL CHECK (injected >= 0)
  )`,
  `INSERT INTO recall_events_v6 (id, session_id, event, at, injected)
    SELECT id, session_id, event, at, injected FROM recall_events`,
  "DROP TABLE recall_events",
  "ALTER TABLE recall_events_v6 RENAME TO recall_events",
  `CREATE TABLE failure_recalls (
    session_id TEXT NOT NULL,
    head TEXT NOT NULL CHECK (length(head) <= ${SIGNAL_DETAIL_MAX_CHARS}),
    recalled_at TEXT NOT NULL,
    PRIMARY KEY (session_id, head)
  )`,
];

export const schemaV7Ddl: readonly string[] = [
  "ALTER TABLE memories ADD COLUMN questions TEXT NOT NULL DEFAULT '[]'",
];

export const questionsVecTableDdl = `CREATE VIRTUAL TABLE questions_vec USING vec0(
  question_id TEXT PRIMARY KEY,
  embedding float[${EMBED_DIM}] distance_metric=cosine,
  memory_id TEXT,
  scope TEXT,
  project_id TEXT,
  state TEXT
)`;

export const vecTableDdl = `CREATE VIRTUAL TABLE memories_vec USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding float[${EMBED_DIM}] distance_metric=cosine,
  type TEXT partition key,
  scope TEXT,
  project_id TEXT,
  state TEXT
)`;
