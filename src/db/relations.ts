import { RELATION_CAP } from "../cfg";
import type { Db } from "./database";
import { MemoryRejection, resolveMemoryId } from "./memories";

export function relate(
  db: Db,
  sourceRef: string,
  targetRef: string,
  relationType: string,
): { ok: true } {
  const txn = db.transaction((): { ok: true } => {
    const sourceId = resolveMemoryId(db, sourceRef);
    const targetId = resolveMemoryId(db, targetRef);
    if (sourceId === targetId) {
      throw new MemoryRejection(`cannot relate memory ${sourceId} to itself`);
    }
    const existing = db
      .prepare(
        "SELECT 1 FROM relations WHERE source_id = ? AND target_id = ? AND relation_type = ?",
      )
      .get(sourceId, targetId, relationType);
    if (existing !== undefined) {
      return { ok: true };
    }
    const row = db
      .prepare("SELECT count(*) AS n FROM relations WHERE source_id = ?")
      .get(sourceId) as { n: number };
    if (row.n >= RELATION_CAP) {
      throw new MemoryRejection(`relation cap ${RELATION_CAP} reached for source ${sourceId}`);
    }
    db.prepare("INSERT INTO relations (source_id, target_id, relation_type) VALUES (?, ?, ?)").run(
      sourceId,
      targetId,
      relationType,
    );
    return { ok: true };
  });
  return txn.immediate();
}
