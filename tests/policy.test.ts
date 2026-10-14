import { describe, expect, it } from "vitest";
import {
  addVerdict,
  noopVerdict,
  promotionContributors,
  reactivationVerdict,
  type Slot,
  type SlotRow,
  supersedeVerdict,
  updateVerdict,
} from "../src/policy";

const DATABASE_KEY = "project.primary_database";

function slot(overrides: Partial<Slot> = {}): Slot {
  return {
    scope: "project",
    projectId: "proj-a",
    conflictKey: DATABASE_KEY,
    cardinality: "single",
    valueText: "MySQL 8",
    ...overrides,
  };
}

function row(overrides: Partial<SlotRow> = {}): SlotRow {
  return {
    id: "01TARGET",
    state: "active",
    kind: "fact",
    ...slot({ valueText: "PostgreSQL 15" }),
    ...overrides,
  };
}

describe("resolution verdicts", () => {
  it.each([
    {
      name: "supersede a changed single-valued fact",
      verdict: supersedeVerdict(slot(), row()),
      reason: undefined,
    },
    {
      name: "supersede inside the user partition shared by all projects",
      verdict: supersedeVerdict(
        slot({ scope: "user", projectId: "proj-b" }),
        row({ scope: "user", projectId: "proj-a" }),
      ),
      reason: undefined,
    },
    {
      name: "supersede a multi-valued key",
      verdict: supersedeVerdict(
        slot({ conflictKey: "team.reviewers", cardinality: "multi", valueText: "Scout" }),
        row({ conflictKey: "team.reviewers", cardinality: "multi", valueText: "Buddy" }),
      ),
      reason: /multi-valued.*ADD.*UPDATE with target 01TARGET/,
    },
    {
      name: "supersede a row of another key",
      verdict: supersedeVerdict(slot(), row({ conflictKey: "project.cache" })),
      reason: /conflict_key project\.cache.*same conflict_key/,
    },
    {
      name: "supersede a row of another project",
      verdict: supersedeVerdict(slot(), row({ projectId: "proj-b" })),
      reason: /another partition.*ADD/,
    },
    {
      name: "supersede a revoked row",
      verdict: supersedeVerdict(slot(), row({ state: "revoked" })),
      reason: /01TARGET is revoked.*active/,
    },
    {
      name: "update the same slot",
      verdict: updateVerdict(slot(), row()),
      reason: undefined,
    },
    {
      name: "update a row of another key",
      verdict: updateVerdict(slot(), row({ conflictKey: "project.cache" })),
      reason: /same conflict_key/,
    },
    {
      name: "noop on an active row of another key in the partition",
      verdict: noopVerdict(slot(), row({ conflictKey: "project.cache" })),
      reason: undefined,
    },
    {
      name: "noop on a row of another project",
      verdict: noopVerdict(slot(), row({ projectId: "proj-b" })),
      reason: /another partition/,
    },
    {
      name: "noop on a hypothesis row",
      verdict: noopVerdict(slot(), row({ state: "hypothesis" })),
      reason: undefined,
    },
    {
      name: "update a hypothesis row",
      verdict: updateVerdict(slot(), row({ state: "hypothesis" })),
      reason: undefined,
    },
    {
      name: "noop on a revoked row",
      verdict: noopVerdict(slot(), row({ state: "revoked" })),
      reason: /01TARGET is revoked/,
    },
    {
      name: "supersede a hypothesis row",
      verdict: supersedeVerdict(slot(), row({ state: "hypothesis" })),
      reason: /01TARGET is hypothesis.*active/,
    },
  ])("$name", ({ verdict, reason }) => {
    if (reason === undefined) {
      expect(verdict).toEqual({ allowed: true });
      return;
    }
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed ? "" : verdict.reason).toMatch(reason);
  });

  it.each([
    {
      name: "a different value while a single-valued row holds the key",
      incoming: slot(),
      rows: [row()],
      reason: /holds "PostgreSQL 15" in memory 01TARGET.*SUPERSEDE with target 01TARGET.*UPDATE/,
    },
    {
      name: "the same normalised single value again",
      incoming: slot({ valueText: "  postgresql   15 " }),
      rows: [row()],
      reason: /already holds this value in memory 01TARGET.*NOOP or UPDATE/,
    },
    {
      name: "another value of a multi-valued key",
      incoming: slot({ conflictKey: "team.reviewers", cardinality: "multi", valueText: "Scout" }),
      rows: [row({ conflictKey: "team.reviewers", cardinality: "multi", valueText: "Buddy" })],
      reason: undefined,
    },
    {
      name: "a single value while only another project holds the key",
      incoming: slot(),
      rows: [row({ projectId: "proj-b" })],
      reason: undefined,
    },
    {
      name: "a single value while only a revoked row holds the key",
      incoming: slot(),
      rows: [row({ state: "revoked" })],
      reason: undefined,
    },
  ])("ADD of $name", ({ incoming, rows, reason }) => {
    const verdict = addVerdict(incoming, rows);
    if (reason === undefined) {
      expect(verdict).toEqual({ allowed: true });
      return;
    }
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed ? "" : verdict.reason).toMatch(reason);
  });
});

describe("reactivationVerdict", () => {
  const demoted = row({ id: "01DEMOTED", state: "hypothesis" });

  it.each([
    {
      name: "another active single-valued row of the same partition now holds the key",
      target: demoted,
      holders: [row({ id: "01HOLDER", valueText: "MySQL 8" })],
      reason: /01DEMOTED cannot return to active.*held by memory 01HOLDER.*SUPERSEDE.*01HOLDER/,
    },
    {
      name: "only another project holds the key",
      target: demoted,
      holders: [row({ id: "01HOLDER", projectId: "proj-b" })],
      reason: undefined,
    },
    {
      name: "the key is multi-valued",
      target: row({ id: "01DEMOTED", state: "hypothesis", cardinality: "multi" }),
      holders: [row({ id: "01HOLDER", cardinality: "multi" })],
      reason: undefined,
    },
  ])("reactivates a hypothesis row when $name", ({ target, holders, reason }) => {
    const verdict = reactivationVerdict(target, [...holders, target]);
    if (reason === undefined) {
      expect(verdict).toEqual({ allowed: true });
      return;
    }
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed ? "" : verdict.reason).toMatch(reason);
  });
});

describe("promotionContributors", () => {
  const testCommand = (id: string, projectId: string, overrides: Partial<SlotRow> = {}) =>
    row({
      id,
      projectId,
      kind: "procedure",
      conflictKey: "project.test_command",
      valueText: "pnpm test",
      ...overrides,
    });

  it.each([
    {
      name: "a procedure with the same key and value in two projects",
      written: testCommand("w", "proj-b"),
      others: [testCommand("a", "proj-a")],
      expected: ["a", "w"],
    },
    {
      name: "values equal only after normalisation",
      written: testCommand("w", "proj-b", { valueText: "  PNPM   test " }),
      others: [testCommand("a", "proj-a")],
      expected: ["a", "w"],
    },
    {
      name: "a fact",
      written: testCommand("w", "proj-b", { kind: "fact" }),
      others: [testCommand("a", "proj-a", { kind: "fact" })],
      expected: [],
    },
    {
      name: "a contributor of an unpromotable kind",
      written: testCommand("w", "proj-b"),
      others: [testCommand("a", "proj-a", { kind: "belief" })],
      expected: [],
    },
    {
      name: "different values",
      written: testCommand("w", "proj-b"),
      others: [testCommand("a", "proj-a", { valueText: "npm test" })],
      expected: [],
    },
    {
      name: "a revoked contributor",
      written: testCommand("w", "proj-b"),
      others: [testCommand("a", "proj-a", { state: "revoked" })],
      expected: [],
    },
    {
      name: "one project only",
      written: testCommand("w", "proj-b", { cardinality: "multi" }),
      others: [testCommand("a", "proj-b", { cardinality: "multi" })],
      expected: [],
    },
    {
      name: "an active user row already holding the key",
      written: testCommand("w", "proj-b"),
      others: [testCommand("a", "proj-a"), testCommand("u", "proj-c", { scope: "user" })],
      expected: [],
    },
    {
      name: "a written user-scope row",
      written: testCommand("w", "proj-b", { scope: "user" }),
      others: [testCommand("a", "proj-a"), testCommand("c", "proj-c")],
      expected: [],
    },
    {
      name: "empty values",
      written: testCommand("w", "proj-b", { cardinality: "multi", valueText: "" }),
      others: [testCommand("a", "proj-a", { cardinality: "multi", valueText: "" })],
      expected: [],
    },
  ])("promotes $name only when the rule holds", ({ written, others, expected }) => {
    const contributors = promotionContributors(written, [...others, written]);
    expect(contributors.map((contributor) => contributor.id).sort()).toEqual(expected);
  });
});
