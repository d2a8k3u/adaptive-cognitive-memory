import { contentHash, type MemoryScope } from "../policy";
import {
  type ExportSnapshot,
  type ImportWrites,
  type NumberedRecord,
  planImport,
  type Rejected,
  type SlotHolder,
  type StoredMemoryRow,
  slotOf,
} from "../transfer";
import { type Db, metaValue, setMetaValue } from "./database";

export type ImportOutcome = ({ readonly ok: true } & ImportWrites) | Rejected;

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
  "questions",
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
] as const;

export function exportSnapshot(db: Db): ExportSnapshot {
  return db
    .transaction(
      (): ExportSnapshot => ({
        memories: db
          .prepare(`SELECT ${MEMORY_COLUMNS.join(", ")} FROM memories ORDER BY id`)
          .all() as StoredMemoryRow[],
        relations: db
          .prepare(
            "SELECT source_id, target_id, relation_type FROM relations ORDER BY source_id, target_id, relation_type",
          )
          .all() as ExportSnapshot["relations"][number][],
        transitions: db
          .prepare(
            "SELECT memory_id, from_state, to_state, reason, evidence, related_id, at FROM transitions ORDER BY rowid",
          )
          .all() as ExportSnapshot["transitions"][number][],
      }),
    )
    .deferred();
}

export function stampExport(db: Db, at: string): void {
  setMetaValue(db, LAST_EXPORT_AT_KEY, at);
}

export function lastExportAt(db: Db): string | undefined {
  return metaValue(db, LAST_EXPORT_AT_KEY);
}

function slotHolders(db: Db): SlotHolder[] {
  const rows = db
    .prepare(
      `SELECT id, scope, project_id AS projectId, conflict_key AS conflictKey FROM memories
       WHERE cardinality = 'single' AND state = 'active' AND conflict_key <> ''`,
    )
    .all() as { id: string; scope: MemoryScope; projectId: string; conflictKey: string }[];
  return rows.map((row) => ({
    id: row.id,
    slot: slotOf(row.scope, row.projectId, row.conflictKey),
  }));
}

function existingIds(db: Db): Set<string> {
  return new Set(db.prepare("SELECT id FROM memories").pluck().all() as string[]);
}

function writeImport(db: Db, writes: ImportWrites): void {
  db.pragma("defer_foreign_keys = ON");
  const insertMemory = db.prepare(
    `INSERT INTO memories (${MEMORY_COLUMNS.join(", ")}, content_hash)
     VALUES (${MEMORY_COLUMNS.map(() => "?").join(", ")}, ?)`,
  );
  for (const memory of writes.memories) {
    insertMemory.run(
      ...MEMORY_COLUMNS.map((column) =>
        column === "anchors" || column === "questions"
          ? JSON.stringify(memory[column])
          : memory[column],
      ),
      contentHash(memory.content),
    );
  }
  const insertRelation = db.prepare(
    "INSERT OR IGNORE INTO relations (source_id, target_id, relation_type) VALUES (?, ?, ?)",
  );
  for (const relation of writes.relations) {
    insertRelation.run(relation.source_id, relation.target_id, relation.relation_type);
  }
  const insertTransition = db.prepare(
    `INSERT INTO transitions (memory_id, from_state, to_state, reason, evidence, related_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const transition of writes.transitions) {
    insertTransition.run(
      transition.memory_id,
      transition.from_state,
      transition.to_state,
      transition.reason,
      transition.evidence,
      transition.related_id,
      transition.at,
    );
  }
}

export function importRecords(db: Db, records: readonly NumberedRecord[]): ImportOutcome {
  return db
    .transaction((): ImportOutcome => {
      const plan = planImport(records, {
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
