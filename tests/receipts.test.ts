import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMBED_DIM, loadConfig } from "../src/cfg";
import { type OpenedDb, openDatabase } from "../src/db/database";
import { type FeedbackOutcome, recordFeedback } from "../src/db/feedback";
import { recordInjections, recordReceipt } from "../src/db/injections";
import { DEMOTION_MIN_RECEIPTED_INJECTIONS, type FeedbackVerdict } from "../src/lifecycle";

const PROJECT = "proj-receipts";
const CREATED_AT = "2026-10-01T00:00:00.000Z";

const openedDbs: OpenedDb[] = [];

function openStore(): OpenedDb {
  const config = loadConfig({ CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "acm-receipts-")) });
  const opened = openDatabase(config);
  openedDbs.push(opened);
  return opened;
}

function seedMemory(opened: OpenedDb, id: string): void {
  opened.db
    .prepare(
      `INSERT INTO memories (id, type, kind, scope, project_id, title, abstract, content,
         created_at, updated_at)
       VALUES (?, 'semantic', 'constraint', 'project', ?, ?, 'abstract', 'content', ?, ?)`,
    )
    .run(id, PROJECT, `title ${id}`, CREATED_AT, CREATED_AT);
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
  return recordFeedback(opened, { projectId: PROJECT, ids, verdict, at: when });
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

describe("receipt evidence", () => {
  function injectInSession(opened: OpenedDb, session: number, memoryIds: readonly string[]): void {
    recordInjections(opened, {
      sessionId: `session-${session}`,
      event: "SessionStart",
      at: at(session),
      memoryIds,
    });
  }

  it.each([
    { order: "after the injection", receiptFirst: false },
    { order: "before the injection", receiptFirst: true },
  ])(
    "demotes a memory injected in five receipt-giving sessions without a used receipt when the receipt comes $order",
    ({ receiptFirst }) => {
      const opened = openStore();
      seedMemory(opened, "mem-unused");
      seedVector(opened, "mem-unused");
      for (let session = 1; session <= DEMOTION_MIN_RECEIPTED_INJECTIONS; session += 1) {
        if (receiptFirst) {
          recordReceipt(opened, `session-${session}`, at(session));
        }
        injectInSession(opened, session, ["mem-unused"]);
        if (!receiptFirst) {
          recordReceipt(opened, `session-${session}`, at(session));
        }
      }

      expect(counters(opened, "mem-unused")).toMatchObject({
        state: "hypothesis",
        importance: 1 / 7,
      });
      expect(vecState(opened, "mem-unused")).toBe("hypothesis");
      expect(transitions(opened, "mem-unused")).toEqual([
        {
          from_state: "active",
          to_state: "hypothesis",
          reason: "unused_after_receipts",
          evidence: "used 0 of 5 receipted injections",
        },
      ]);
    },
  );

  it("never demotes a memory injected only in sessions that gave no receipt", () => {
    const opened = openStore();
    seedMemory(opened, "mem-silent");
    for (let session = 1; session <= DEMOTION_MIN_RECEIPTED_INJECTIONS + 1; session += 1) {
      injectInSession(opened, session, ["mem-silent"]);
    }
    recordReceipt(opened, "session-without-the-memory", at(30));

    expect(counters(opened, "mem-silent")).toMatchObject({ state: "active", importance: 1 / 2 });
    expect(transitions(opened, "mem-silent")).toEqual([]);
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

    for (let session = 1; session <= DEMOTION_MIN_RECEIPTED_INJECTIONS; session += 1) {
      recordInjections(opened, {
        sessionId: `session-${session}`,
        event: "SessionStart",
        at: at(session),
        memoryIds: ["mem-cycled", "mem-receipted"],
      });
      feedback(opened, ["mem-receipted"], "used", at(session));
      recordReceipt(opened, `session-${session}`, at(session));
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
      "unused_after_receipts",
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

    const outcome = feedback(opened, ["mem-feedback", "mem-feedback"], verdict, at(5));

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
