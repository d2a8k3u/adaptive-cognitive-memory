import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMBED_DIM, loadConfig } from "../src/cfg";
import { type OpenedDb, openDatabase } from "../src/db/database";
import { type FeedbackOutcome, recordFeedback } from "../src/db/feedback";
import { recordInjections, recordReceipt } from "../src/db/injections";
import { recordVerdicts } from "../src/db/verdicts";
import { DEMOTION_MIN_VERDICT_SESSIONS, type FeedbackVerdict } from "../src/lifecycle";
import type { MemoryKind } from "../src/policy";

const PROJECT = "proj-receipts";
const CREATED_AT = "2026-10-01T00:00:00.000Z";

const openedDbs: OpenedDb[] = [];

function openStore(): OpenedDb {
  const dataDir = mkdtempSync(join(tmpdir(), "acm-receipts-"));
  const config = loadConfig({ CLAUDE_PLUGIN_DATA: dataDir, ACM_DATA_DIR: dataDir });
  const opened = openDatabase(config);
  openedDbs.push(opened);
  return opened;
}

function seedMemory(opened: OpenedDb, id: string, kind: MemoryKind = "fact"): void {
  opened.db
    .prepare(
      `INSERT INTO memories (id, type, kind, scope, project_id, title, abstract, content,
         created_at, updated_at)
       VALUES (?, 'semantic', ?, 'project', ?, ?, 'abstract', 'content', ?, ?)`,
    )
    .run(id, kind, PROJECT, `title ${id}`, CREATED_AT, CREATED_AT);
}

function counters(opened: OpenedDb, id: string): Record<string, unknown> {
  return opened.db
    .prepare(
      `SELECT state, importance, injection_count, last_injected_at, used_count, wrong_count
       FROM memories WHERE id = ?`,
    )
    .get(id) as Record<string, unknown>;
}

function seedVector(opened: OpenedDb, id: string): void {
  const embedding = new Float32Array(EMBED_DIM);
  embedding[0] = 1;
  opened.db
    .prepare(
      `INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id, state)
       VALUES (?, ?, 'semantic', 'project', ?, 'active')`,
    )
    .run(id, Buffer.from(embedding.buffer), PROJECT);
}

function vecState(opened: OpenedDb, id: string): string | undefined {
  const row = opened.db.prepare("SELECT state FROM memories_vec WHERE memory_id = ?").get(id) as
    | { state: string }
    | undefined;
  return row?.state;
}

function transitions(opened: OpenedDb, id: string): Record<string, unknown>[] {
  return opened.db
    .prepare(
      `SELECT from_state, to_state, reason, evidence FROM transitions
       WHERE memory_id = ? ORDER BY rowid`,
    )
    .all(id) as Record<string, unknown>[];
}

function at(minute: number): string {
  return `2026-10-14T10:${String(minute).padStart(2, "0")}:00.000Z`;
}

function feedback(
  opened: OpenedDb,
  ids: readonly string[],
  verdict: FeedbackVerdict,
  when: string,
): FeedbackOutcome {
  return recordFeedback(opened, {
    projectId: PROJECT,
    verdicts: { used: [], wrong: [], not_applicable: [], [verdict]: ids },
    at: when,
  });
}

afterEach(() => {
  for (const opened of openedDbs) {
    opened.db.close();
  }
  openedDbs.length = 0;
});

describe("recordInjections", () => {
  it("counts one injection per session and memory and stamps every delivery time", () => {
    const opened = openStore();
    seedMemory(opened, "mem-injected");

    recordInjections(opened, {
      sessionId: "session-a",
      event: "UserPromptSubmit",
      at: at(1),
      memoryIds: ["mem-injected"],
    });
    recordInjections(opened, {
      sessionId: "session-a",
      event: "SessionStart",
      at: at(2),
      memoryIds: ["mem-injected"],
    });
    const afterReinjection = counters(opened, "mem-injected");
    recordInjections(opened, {
      sessionId: "session-b",
      event: "SessionStart",
      at: at(3),
      memoryIds: ["mem-injected"],
    });

    expect(afterReinjection).toMatchObject({ injection_count: 1, last_injected_at: at(2) });
    expect(counters(opened, "mem-injected")).toMatchObject({
      injection_count: 2,
      last_injected_at: at(3),
    });
  });
});

function judge(
  opened: OpenedDb,
  session: number,
  verdict: FeedbackVerdict,
  memoryIds: readonly string[],
): void {
  recordVerdicts(opened, {
    sessionId: `session-${session}`,
    verdicts: { used: [], wrong: [], not_applicable: [], [verdict]: memoryIds },
    at: at(session),
  });
}

function judgeSessions(
  opened: OpenedDb,
  sessions: readonly number[],
  verdict: FeedbackVerdict,
  memoryIds: readonly string[],
): void {
  for (const session of sessions) {
    judge(opened, session, verdict, memoryIds);
  }
}

function sessionRange(first: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => first + index);
}

describe("verdict evidence", () => {
  it("demotes a memory used in fewer than half of five sessions that gave it a verdict", () => {
    const opened = openStore();
    seedMemory(opened, "mem-judged");
    seedVector(opened, "mem-judged");

    judgeSessions(opened, [1, 2], "used", ["mem-judged"]);
    judgeSessions(opened, [3, 4, 5], "not_applicable", ["mem-judged"]);

    expect(counters(opened, "mem-judged").state).toBe("hypothesis");
    expect(vecState(opened, "mem-judged")).toBe("hypothesis");
    expect(transitions(opened, "mem-judged")).toEqual([
      {
        from_state: "active",
        to_state: "hypothesis",
        reason: "unused_after_verdicts",
        evidence: "used in 2 of 5 sessions with a verdict",
      },
    ]);
  });

  it("counts a session once however many verdicts it gave the memory", () => {
    const opened = openStore();
    seedMemory(opened, "mem-rejudged");

    for (const session of sessionRange(1, DEMOTION_MIN_VERDICT_SESSIONS - 1)) {
      judge(opened, session, "not_applicable", ["mem-rejudged"]);
      judge(opened, session, "not_applicable", ["mem-rejudged"]);
    }

    expect(counters(opened, "mem-rejudged").state).toBe("active");
  });

  it("never demotes a memory left without a verdict, however many receipt-giving sessions injected it", () => {
    const opened = openStore();
    seedMemory(opened, "mem-unjudged");
    seedMemory(opened, "mem-other");

    for (const session of sessionRange(1, DEMOTION_MIN_VERDICT_SESSIONS + 1)) {
      recordInjections(opened, {
        sessionId: `session-${session}`,
        event: "SessionStart",
        at: at(session),
        memoryIds: ["mem-unjudged", "mem-other"],
      });
      judge(opened, session, "used", ["mem-other"]);
      recordReceipt(opened, `session-${session}`, at(session));
    }

    expect(counters(opened, "mem-unjudged").state).toBe("active");
    expect(transitions(opened, "mem-unjudged")).toEqual([]);
  });

  it("keeps a pinned constraint active however many sessions judge it not applicable", () => {
    const opened = openStore();
    seedMemory(opened, "mem-pinned", "constraint");

    judgeSessions(opened, sessionRange(1, DEMOTION_MIN_VERDICT_SESSIONS), "not_applicable", [
      "mem-pinned",
    ]);

    expect(counters(opened, "mem-pinned").state).toBe("active");
  });

  it("judges a memory back in active only on verdicts given after its return", () => {
    const opened = openStore();
    seedMemory(opened, "mem-revived");
    judgeSessions(opened, sessionRange(1, DEMOTION_MIN_VERDICT_SESSIONS), "not_applicable", [
      "mem-revived",
    ]);
    feedback(opened, ["mem-revived"], "used", at(20));

    judge(opened, 21, "not_applicable", ["mem-revived"]);
    const afterFirstTrialSession = counters(opened, "mem-revived").state;
    judgeSessions(opened, sessionRange(22, DEMOTION_MIN_VERDICT_SESSIONS - 1), "not_applicable", [
      "mem-revived",
    ]);

    expect(afterFirstTrialSession).toBe("active");
    expect(counters(opened, "mem-revived").state).toBe("hypothesis");
    expect(transitions(opened, "mem-revived").at(-1)).toMatchObject({
      evidence: "used in 0 of 5 sessions with a verdict",
    });
  });
});

describe("lifecycle without deletion", () => {
  it("keeps every row and its history across demotion and reactivation cycles", () => {
    const opened = openStore();
    seedMemory(opened, "mem-cycled");
    seedMemory(opened, "mem-receipted");
    const rowCount = () =>
      (opened.db.prepare("SELECT count(*) AS n FROM memories").get() as { n: number }).n;
    const observed: [number, unknown][] = [];
    const observe = () => observed.push([rowCount(), counters(opened, "mem-cycled").state]);

    for (const session of sessionRange(1, DEMOTION_MIN_VERDICT_SESSIONS)) {
      judge(opened, session, "not_applicable", ["mem-cycled"]);
      judge(opened, session, "used", ["mem-receipted"]);
    }
    observe();
    feedback(opened, ["mem-cycled"], "used", at(10));
    observe();
    feedback(opened, ["mem-cycled"], "wrong", at(11));
    observe();
    feedback(opened, ["mem-cycled"], "used", at(12));
    observe();

    expect(observed).toEqual([
      [2, "hypothesis"],
      [2, "active"],
      [2, "hypothesis"],
      [2, "active"],
    ]);
    expect(transitions(opened, "mem-cycled").map((row) => row.reason)).toEqual([
      "unused_after_verdicts",
      "feedback_used",
      "feedback_wrong",
      "feedback_used",
    ]);
    expect(counters(opened, "mem-receipted").state).toBe("active");
  });
});

describe("recordFeedback", () => {
  it.each([
    {
      verdict: "wrong",
      from: "active",
      expected: { state: "hypothesis", used_count: 0, wrong_count: 1, importance: 1 / 4 },
      transition: { reason: "feedback_wrong", evidence: "wrong" },
    },
    {
      verdict: "used",
      from: "hypothesis",
      expected: { state: "active", used_count: 1, wrong_count: 0, importance: 2 / 3 },
      transition: { reason: "feedback_used", evidence: "used" },
    },
    {
      verdict: "not_applicable",
      from: "active",
      expected: { state: "active", used_count: 0, wrong_count: 0, importance: 1 / 2 },
      transition: undefined,
    },
  ] as const)("applies $verdict to a $from memory", ({ verdict, from, expected, transition }) => {
    const opened = openStore();
    seedMemory(opened, "mem-feedback");
    seedVector(opened, "mem-feedback");
    opened.db.prepare("UPDATE memories SET state = ? WHERE id = ?").run(from, "mem-feedback");
    opened.db
      .prepare("UPDATE memories_vec SET state = ? WHERE memory_id = ?")
      .run(from, "mem-feedback");

    const outcome = feedback(opened, ["mem-feedback"], verdict, at(5));

    expect(outcome).toEqual({
      outcome: "recorded",
      memories: [{ id: "mem-feedback", state: expected.state }],
    });
    expect(counters(opened, "mem-feedback")).toMatchObject(expected);
    expect(vecState(opened, "mem-feedback")).toBe(expected.state);
    expect(transitions(opened, "mem-feedback")).toEqual(
      transition === undefined
        ? []
        : [{ from_state: from, to_state: expected.state, ...transition }],
    );
  });

  it("records nothing for any id of a call that names an unknown or revoked memory", () => {
    const opened = openStore();
    seedMemory(opened, "mem-valid");
    seedMemory(opened, "mem-revoked");
    opened.db.prepare("UPDATE memories SET state = 'revoked' WHERE id = ?").run("mem-revoked");

    const outcome = feedback(opened, ["mem-valid", "mem-unknown", "mem-revoked"], "wrong", at(5));

    expect(outcome).toEqual({
      outcome: "rejected",
      reason: expect.stringMatching(
        /unknown memory ids mem-unknown; revoked memory ids mem-revoked/,
      ),
    });
    expect(counters(opened, "mem-valid")).toMatchObject({ state: "active", wrong_count: 0 });
  });

  it("rejects a used receipt that would reactivate a single-valued memory whose key another memory now holds", () => {
    const opened = openStore();
    const holdSlot = opened.db.prepare(
      `UPDATE memories SET conflict_key = 'project.primary_database', cardinality = 'single',
         value_text = ?, state = ? WHERE id = ?`,
    );
    seedMemory(opened, "mem-demoted");
    holdSlot.run("PostgreSQL 15", "hypothesis", "mem-demoted");
    seedMemory(opened, "mem-holder");
    holdSlot.run("MySQL 8", "active", "mem-holder");

    const outcome = feedback(opened, ["mem-demoted"], "used", at(5));

    expect(outcome).toEqual({
      outcome: "rejected",
      reason: expect.stringMatching(/mem-demoted cannot return to active.*mem-holder/),
    });
    expect(counters(opened, "mem-demoted")).toMatchObject({ state: "hypothesis", used_count: 0 });
  });
});
