import { FEEDBACK_VERDICTS, type FeedbackVerdicts } from "../lifecycle";
import { settleVerdictEvidence } from "./lifecycle";
import type { StateStore } from "./transitions";

export interface VerdictRecord {
  readonly sessionId: string;
  readonly verdicts: FeedbackVerdicts;
  readonly at: string;
}

export function recordVerdicts(store: StateStore, record: VerdictRecord): void {
  const { db } = store;
  const insert = db.prepare(
    `INSERT INTO verdicts (session_id, memory_id, verdict, at)
     SELECT ?, id, ?, ? FROM memories WHERE id = ? AND state <> 'revoked'`,
  );
  db.transaction(() => {
    const judged: string[] = [];
    for (const verdict of FEEDBACK_VERDICTS) {
      for (const id of record.verdicts[verdict]) {
        if (insert.run(record.sessionId, verdict, record.at, id).changes === 1) {
          judged.push(id);
        }
      }
    }
    settleVerdictEvidence(store, judged, record.at);
  }).immediate();
}
