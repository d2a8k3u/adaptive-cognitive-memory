"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.claimFailureRecall = claimFailureRecall;
exports.pruneFailureRecalls = pruneFailureRecalls;
function claimFailureRecall(db, claim) {
    return (db
        .prepare("INSERT OR IGNORE INTO failure_recalls (session_id, head, recalled_at) VALUES (?, ?, ?)")
        .run(claim.sessionId, claim.head, claim.at).changes === 1);
}
function pruneFailureRecalls(db, cutoff) {
    db.prepare("DELETE FROM failure_recalls WHERE recalled_at < ?").run(cutoff);
}
