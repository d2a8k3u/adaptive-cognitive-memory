import { describe, expect, it } from "vitest";
import {
  derivedImportance,
  FRESH_COUNTERS,
  feedbackRejection,
  feedbackTransition,
  type LifecycleSnapshot,
  type ReceiptCounters,
  receiptEvidenceTransition,
} from "../src/lifecycle";

function counters(overrides: Partial<ReceiptCounters>): ReceiptCounters {
  return { ...FRESH_COUNTERS, ...overrides };
}

function snapshot(overrides: Partial<LifecycleSnapshot>): LifecycleSnapshot {
  return { ...FRESH_COUNTERS, state: "active", ...overrides };
}

describe("feedbackTransition", () => {
  it.each([
    {
      state: "active",
      verdict: "wrong",
      expected: { toState: "hypothesis", reason: "feedback_wrong", evidence: "wrong" },
    },
    {
      state: "hypothesis",
      verdict: "used",
      expected: { toState: "active", reason: "feedback_used", evidence: "used" },
    },
    { state: "active", verdict: "used", expected: undefined },
    { state: "hypothesis", verdict: "wrong", expected: undefined },
    { state: "hypothesis", verdict: "not_applicable", expected: undefined },
  ] as const)(
    "moves a $state row on $verdict to $expected.toState",
    ({ state, verdict, expected }) => {
      expect(feedbackTransition(state, verdict)).toEqual(expected);
    },
  );
});

describe("feedbackRejection", () => {
  it("names every unknown and revoked id so the whole call can be retried", () => {
    expect(
      feedbackRejection(
        ["01ACTIVE", "01GONE", "01REVOKED", "01HYPOTHESIS"],
        [
          { id: "01ACTIVE", state: "active" },
          { id: "01REVOKED", state: "revoked" },
          { id: "01HYPOTHESIS", state: "hypothesis" },
        ],
      ),
    ).toBe(
      "no feedback recorded: unknown memory ids 01GONE; revoked memory ids 01REVOKED. Give feedback only on ids of active or hypothesis memories, exactly as recall printed them",
    );
  });

  it("accepts a call whose ids are all active or hypothesis memories", () => {
    expect(
      feedbackRejection(
        ["01ACTIVE", "01HYPOTHESIS"],
        [
          { id: "01ACTIVE", state: "active" },
          { id: "01HYPOTHESIS", state: "hypothesis" },
        ],
      ),
    ).toBeUndefined();
  });
});

describe("receiptEvidenceTransition", () => {
  it.each([
    { name: "four receipted injections without use", row: { receiptedInjections: 4 } },
    {
      name: "a used share of exactly one half",
      row: { receiptedInjections: 6, usedCount: 3 },
    },
    {
      name: "a hypothesis row already out of recall",
      row: { state: "hypothesis", receiptedInjections: 9 } as const,
    },
  ])("keeps the row for $name", ({ row }) => {
    expect(receiptEvidenceTransition(snapshot(row))).toBeUndefined();
  });

  it("demotes an active row used in fewer than half of at least five receipted injections", () => {
    expect(receiptEvidenceTransition(snapshot({ receiptedInjections: 5, usedCount: 2 }))).toEqual({
      toState: "hypothesis",
      reason: "unused_after_receipts",
      evidence: "used 2 of 5 receipted injections",
    });
  });
});

describe("derivedImportance", () => {
  it.each([
    { name: "a fresh row", counts: {}, expected: 1 / 2 },
    {
      name: "two used receipts",
      counts: { usedCount: 2, receiptedInjections: 2 },
      expected: 3 / 4,
    },
    { name: "one wrong receipt weighs double", counts: { wrongCount: 1 }, expected: 1 / 4 },
    {
      name: "receipted injections without use",
      counts: { usedCount: 1, receiptedInjections: 5 },
      expected: 2 / 7,
    },
    {
      name: "more used receipts than receipted injections",
      counts: { usedCount: 3, receiptedInjections: 1 },
      expected: 4 / 5,
    },
    {
      name: "mixed evidence",
      counts: { usedCount: 1, wrongCount: 1, receiptedInjections: 3 },
      expected: 2 / 7,
    },
  ])("derives $expected for $name", ({ counts, expected }) => {
    expect(derivedImportance(counters(counts))).toBeCloseTo(expected, 12);
  });
});
