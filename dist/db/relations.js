"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.relate = relate;
const cfg_1 = require("../cfg");
const memories_1 = require("./memories");
function relate(db, sourceRef, targetRef, relationType) {
    const txn = db.transaction(() => {
        const sourceId = (0, memories_1.resolveMemoryId)(db, sourceRef);
        const targetId = (0, memories_1.resolveMemoryId)(db, targetRef);
        if (sourceId === targetId) {
            throw new memories_1.MemoryRejection(`cannot relate memory ${sourceId} to itself`);
        }
        const existing = db
            .prepare("SELECT 1 FROM relations WHERE source_id = ? AND target_id = ? AND relation_type = ?")
            .get(sourceId, targetId, relationType);
        if (existing !== undefined) {
            return { ok: true };
        }
        const row = db
            .prepare("SELECT count(*) AS n FROM relations WHERE source_id = ?")
            .get(sourceId);
        if (row.n >= cfg_1.RELATION_CAP) {
            throw new memories_1.MemoryRejection(`relation cap ${cfg_1.RELATION_CAP} reached for source ${sourceId}`);
        }
        db.prepare("INSERT INTO relations (source_id, target_id, relation_type) VALUES (?, ?, ?)").run(sourceId, targetId, relationType);
        return { ok: true };
    });
    return txn.immediate();
}
