import type { Db } from "./database";

export interface FailureRecallClaim {
  readonly sessionId: string;
  readonly head: string;
  readonly at: string;
}

export function claimFailureRecall(db: Db, claim: FailureRecallClaim): boolean {
  return (
    db
      .prepare(
        "INSERT OR IGNORE INTO failure_recalls (session_id, head, recalled_at) VALUES (?, ?, ?)",
      )
      .run(claim.sessionId, claim.head, claim.at).changes === 1
  );
}

export function pruneFailureRecalls(db: Db, cutoff: string): void {
  db.prepare("DELETE FROM failure_recalls WHERE recalled_at < ?").run(cutoff);
}
