import {
  type InjectionFact,
  type MemoryCount,
  type OpenSignalFact,
  RECALL_RATE_WINDOW,
  type ReasonCount,
  STATUS_LIST_LIMIT,
  type StatusFacts,
} from "../status";
import type { Db } from "./database";
import { recallEnabled } from "./projects";
import { VISIBLE_TO_PROJECT } from "./visibility";

function memoryCounts(db: Db, projectId: string): MemoryCount[] {
  return db
    .prepare(
      `SELECT m.scope, m.state, m.kind, count(*) AS count FROM memories m
       WHERE ${VISIBLE_TO_PROJECT} GROUP BY m.scope, m.state, m.kind`,
    )
    .all(projectId) as MemoryCount[];
}

function transitionCounts(db: Db, projectId: string): ReasonCount[] {
  return db
    .prepare(
      `SELECT t.reason, count(*) AS count FROM transitions t JOIN memories m ON m.id = t.memory_id
       WHERE ${VISIBLE_TO_PROJECT} GROUP BY t.reason ORDER BY t.reason`,
    )
    .all(projectId) as ReasonCount[];
}

function recallEventCounts(db: Db): StatusFacts["recallEvents"] {
  return db
    .prepare(
      `SELECT count(*) AS events, coalesce(sum(injected > 0), 0) AS injecting
       FROM (SELECT injected FROM recall_events ORDER BY id DESC LIMIT ?)`,
    )
    .get(RECALL_RATE_WINDOW) as StatusFacts["recallEvents"];
}

function receiptInjections(db: Db): StatusFacts["receiptInjections"] {
  return db
    .prepare(
      `SELECT count(*) AS memories, coalesce(sum(m.used_count = 0), 0) AS neverUsed
       FROM memories m WHERE m.id IN (
         SELECT i.memory_id FROM injections i
         JOIN receipt_sessions r ON r.session_id = i.session_id)`,
    )
    .get() as StatusFacts["receiptInjections"];
}

function openSignalFacts(db: Db): OpenSignalFact[] {
  return db
    .prepare(
      `SELECT session_id AS sessionId, kind, detail, opened_at AS openedAt FROM session_signals
       WHERE closed_at IS NULL ORDER BY opened_at DESC, id DESC LIMIT ?`,
    )
    .all(STATUS_LIST_LIMIT) as OpenSignalFact[];
}

function recentInjections(db: Db): InjectionFact[] {
  return db
    .prepare(
      `SELECT i.memory_id AS id, m.title, i.event, i.at FROM injections i
       JOIN memories m ON m.id = i.memory_id ORDER BY i.at DESC LIMIT ?`,
    )
    .all(STATUS_LIST_LIMIT) as InjectionFact[];
}

export function statusFacts(db: Db, projectId: string): StatusFacts {
  return {
    projectId,
    recallEnabled: recallEnabled(db, projectId),
    memoryCounts: memoryCounts(db, projectId),
    transitionCounts: transitionCounts(db, projectId),
    recallEvents: recallEventCounts(db),
    receiptInjections: receiptInjections(db),
    openSignals: openSignalFacts(db),
    recentInjections: recentInjections(db),
  };
}
