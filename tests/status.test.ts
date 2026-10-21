import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/cfg";
import { openDatabase } from "../src/db/database";
import { statusFacts } from "../src/db/status";
import { RECALL_RATE_WINDOW, type StatusFacts, statusReport } from "../src/status";

const NOW = "2026-10-14T12:00:00.000Z";

const NO_KINDS = { constraint: 0, preference: 0, fact: 0, procedure: 0, belief: 0 };

const EMPTY_FACTS: StatusFacts = {
  projectId: "proj-a1b2c3",
  recallEnabled: true,
  memoryCounts: [],
  transitionCounts: [],
  recallEvents: [],
  receiptInjections: { memories: 0, neverUsed: 0 },
  openSignals: [],
  recentInjections: [],
};

describe("statusReport", () => {
  it("fills every state and kind per scope, derives the realized rates and ages open signals", () => {
    const facts: StatusFacts = {
      ...EMPTY_FACTS,
      recallEnabled: false,
      memoryCounts: [
        { scope: "user", state: "active", kind: "preference", count: 2 },
        { scope: "project", state: "hypothesis", kind: "fact", count: 1 },
        { scope: "project", state: "active", kind: "fact", count: 4 },
      ],
      transitionCounts: [
        { reason: "superseded", count: 3 },
        { reason: "feedback_wrong", count: 1 },
      ],
      recallEvents: [
        { event: "PostToolUseFailure", events: 3, injecting: 1 },
        { event: "UserPromptSubmit", events: 5, injecting: 1 },
      ],
      receiptInjections: { memories: 5, neverUsed: 2 },
      openSignals: [
        {
          sessionId: "session-a",
          kind: "correction",
          detail: "don't",
          openedAt: "2026-10-14T11:58:30.000Z",
        },
      ],
      recentInjections: [
        {
          id: "01J8GZSQSTATUS000000000AAA",
          title: "deploy freeze",
          event: "UserPromptSubmit",
          at: "2026-10-14T11:00:00.000Z",
        },
      ],
    };

    expect(statusReport(facts, NOW)).toEqual({
      project: { id: "proj-a1b2c3", recall: "off" },
      memories: {
        user: {
          active: { ...NO_KINDS, preference: 2 },
          hypothesis: NO_KINDS,
          revoked: NO_KINDS,
        },
        project: {
          active: { ...NO_KINDS, fact: 4 },
          hypothesis: { ...NO_KINDS, fact: 1 },
          revoked: NO_KINDS,
        },
      },
      transitions: { superseded: 3, feedback_wrong: 1 },
      recall_events: {
        window: 500,
        events: 8,
        injecting: 2,
        rate: 0.25,
        by_event: {
          SessionStart: { events: 0, injecting: 0 },
          UserPromptSubmit: { events: 5, injecting: 1 },
          PreToolUse: { events: 0, injecting: 0 },
          PostToolUseFailure: { events: 3, injecting: 1 },
        },
      },
      receipt_sessions: { memories_injected: 5, never_used: 2, share: 0.4 },
      open_signals: [
        { session_id: "session-a", kind: "correction", detail: "don't", age_seconds: 90 },
      ],
      last_injections: [
        {
          id: "01J8GZSQSTATUS000000000AAA",
          title: "deploy freeze",
          event: "UserPromptSubmit",
          at: "2026-10-14T11:00:00.000Z",
        },
      ],
    });
  });

  it("reports no rate rather than dividing by zero before any recall event or receipt", () => {
    const report = statusReport(EMPTY_FACTS, NOW);

    expect(report.recall_events.rate).toBeNull();
    expect(report.receipt_sessions.share).toBeNull();
    expect(report.project).toEqual({ id: "proj-a1b2c3", recall: "on" });
  });
});

describe("statusFacts", () => {
  it("counts the newest recall events per event name, leaving older ones out of the window", () => {
    const opened = openDatabase(
      loadConfig({ CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "acm-status-")) }),
    );
    try {
      const insert = opened.db.prepare(
        "INSERT INTO recall_events (session_id, event, at, injected) VALUES ('s', ?, ?, ?)",
      );
      insert.run("SessionStart", NOW, 4);
      const failures = 200;
      for (let index = 0; index < RECALL_RATE_WINDOW; index += 1) {
        const event = index < failures ? "PostToolUseFailure" : "PreToolUse";
        insert.run(event, NOW, index % 4 === 0 ? 1 : 0);
      }

      expect(statusFacts(opened.db, "proj-status").recallEvents).toEqual([
        { event: "PostToolUseFailure", events: failures, injecting: failures / 4 },
        {
          event: "PreToolUse",
          events: RECALL_RATE_WINDOW - failures,
          injecting: (RECALL_RATE_WINDOW - failures) / 4,
        },
      ]);
    } finally {
      opened.db.close();
    }
  });
});
