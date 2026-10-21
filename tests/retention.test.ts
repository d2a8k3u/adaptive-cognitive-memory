import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/cfg";
import { type OpenedDb, openDatabase } from "../src/db/database";
import { pruneRecallEvents } from "../src/db/events";
import { pruneFailureRecalls } from "../src/db/failures";
import { pruneSessionHistory } from "../src/db/signals";

const CUTOFF = "2026-09-14T00:00:00.000Z";
const JUST_BEFORE_CUTOFF = "2026-09-13T23:59:59.999Z";

const openedDbs: OpenedDb[] = [];

function freshDb(): OpenedDb {
  const opened = openDatabase(
    loadConfig({ CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "acm-retention-")) }),
  );
  openedDbs.push(opened);
  return opened;
}

afterEach(() => {
  for (const opened of openedDbs) {
    opened.db.close();
  }
  openedDbs.length = 0;
});

describe("pruneRecallEvents", () => {
  it.each([
    { stored: 3, kept: [1, 2, 3] },
    { stored: 4, kept: [2, 3, 4] },
  ])("keeps the newest 3 of $stored events", ({ stored, kept }) => {
    const { db } = freshDb();
    const insert = db.prepare(
      "INSERT INTO recall_events (session_id, event, at, injected) VALUES ('s', 'PreToolUse', ?, 0)",
    );
    for (let index = 0; index < stored; index += 1) {
      insert.run(CUTOFF);
    }

    pruneRecallEvents(db, 3);

    expect(db.prepare("SELECT id FROM recall_events ORDER BY id").pluck().all()).toEqual(kept);
  });
});

describe("pruneSessionHistory", () => {
  it("drops closed signals and command failures from before the cutoff and keeps open signals of any age", () => {
    const { db } = freshDb();
    const signal = db.prepare(
      "INSERT INTO session_signals (session_id, kind, detail, opened_at, closed_at, closed_by) VALUES ('s', 'remember', ?, ?, ?, ?)",
    );
    signal.run("closed at the cutoff", JUST_BEFORE_CUTOFF, CUTOFF, "receipt");
    signal.run("closed just before", JUST_BEFORE_CUTOFF, JUST_BEFORE_CUTOFF, "checkpoint");
    signal.run("open since long ago", "2026-01-01T00:00:00.000Z", null, null);
    const failure = db.prepare(
      "INSERT INTO command_failures (session_id, head, failed_at) VALUES ('s', ?, ?)",
    );
    failure.run("pytest", CUTOFF);
    failure.run("npm test", JUST_BEFORE_CUTOFF);

    pruneSessionHistory(db, CUTOFF);

    expect(db.prepare("SELECT detail FROM session_signals ORDER BY id").pluck().all()).toEqual([
      "closed at the cutoff",
      "open since long ago",
    ]);
    expect(db.prepare("SELECT head FROM command_failures").pluck().all()).toEqual(["pytest"]);
  });
});

describe("pruneFailureRecalls", () => {
  it("drops failure claims from before the cutoff and keeps the one claimed at it", () => {
    const { db } = freshDb();
    const claim = db.prepare(
      "INSERT INTO failure_recalls (session_id, head, recalled_at) VALUES ('s', ?, ?)",
    );
    claim.run("pytest", CUTOFF);
    claim.run("npm test", JUST_BEFORE_CUTOFF);

    pruneFailureRecalls(db, CUTOFF);

    expect(db.prepare("SELECT head FROM failure_recalls").pluck().all()).toEqual(["pytest"]);
  });
});
