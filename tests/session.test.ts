import { describe, expect, it } from "vitest";
import type { RecalledMemory } from "../src/gate";
import {
  isStale,
  type PinnedCandidate,
  STALE_AFTER_INJECTION_EVENTS,
  sessionStartMemories,
} from "../src/session";

const ACTIVITY = "2026-10-01T00:00:00.000Z";
const AFTER_ACTIVITY = "2026-10-02T00:00:00.000Z";
const BEFORE_ACTIVITY = "2026-09-30T00:00:00.000Z";

function eventTimes(after: number, before: number): string[] {
  return [
    ...Array.from({ length: after }, () => AFTER_ACTIVITY),
    ...Array.from({ length: before }, () => BEFORE_ACTIVITY),
  ];
}

function recalled(id: string, kind: RecalledMemory["kind"] = "fact"): RecalledMemory {
  return {
    id,
    kind,
    epistemic: "verified",
    scope: "project",
    abstract: `abstract ${id}`,
    validFrom: "2026-01-01T00:00:00.000Z",
  };
}

function pinned(
  id: string,
  importance: number,
  createdAt: string,
  lastActivityAt: string,
): PinnedCandidate {
  return { ...recalled(id, "constraint"), importance, createdAt, lastActivityAt };
}

describe("isStale", () => {
  it.each([
    { after: STALE_AFTER_INJECTION_EVENTS, stale: false },
    { after: STALE_AFTER_INJECTION_EVENTS + 1, stale: true },
  ])("is $stale with $after injection events after the last activity", ({ after, stale }) => {
    expect(isStale(ACTIVITY, eventTimes(after, 3))).toBe(stale);
  });
});

describe("sessionStartMemories", () => {
  const staleTimes = eventTimes(STALE_AFTER_INJECTION_EVENTS + 1, 0);
  const candidates = [
    pinned("p-stale-newest", 0.5, "2026-09-01T00:00:00.000Z", BEFORE_ACTIVITY),
    pinned("p-fresh-old", 0.5, "2026-01-01T00:00:00.000Z", "2026-10-03T00:00:00.000Z"),
    pinned("p-important-stale", 0.75, "2026-01-01T00:00:00.000Z", BEFORE_ACTIVITY),
    pinned("p-fresh-newer", 0.5, "2026-05-01T00:00:00.000Z", "2026-10-03T00:00:00.000Z"),
  ];
  const ranked = ["p-important-stale", "p-fresh-newer", "p-fresh-old", "p-stale-newest"];

  it("ranks pinned rows by importance, then fresh before stale, then recency, on startup without earlier rows", () => {
    const rows = sessionStartMemories({
      source: "startup",
      pinned: candidates,
      ticket: [],
      earlier: [recalled("e-fact")],
      recentEventTimes: staleTimes,
      limit: 10,
    });

    expect(rows.map((row) => row.id)).toEqual(ranked);
  });

  it.each(["compact", "resume"])(
    "re-injects the session's earlier rows after the pinned ones on %s, once each, within the limit",
    (source) => {
      const rows = sessionStartMemories({
        source,
        pinned: candidates,
        ticket: [],
        earlier: [
          recalled("e-procedure", "procedure"),
          recalled("p-fresh-old"),
          recalled("e-fact"),
        ],
        recentEventTimes: staleTimes,
        limit: 6,
      });

      expect(rows.map((row) => row.id)).toEqual([...ranked, "e-procedure", "e-fact"]);
    },
  );

  it("stops at the limit", () => {
    const rows = sessionStartMemories({
      source: "compact",
      pinned: candidates,
      ticket: [],
      earlier: [recalled("e-fact")],
      recentEventTimes: staleTimes,
      limit: 2,
    });

    expect(rows.map((row) => row.id)).toEqual(ranked.slice(0, 2));
  });
});
