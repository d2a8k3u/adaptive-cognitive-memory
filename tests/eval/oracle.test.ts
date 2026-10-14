import { describe, expect, it } from "vitest";
import { type OracleResolution, oracleResolution, type ResolutionCandidate } from "./oracle";

const MEMORY = { conflict_key: "project.primary_database", value_text: "MySQL 8" };

function candidate(overrides: Partial<ResolutionCandidate>): ResolutionCandidate {
  return {
    id: "01SAMEKEY",
    conflict_key: "project.primary_database",
    cardinality: "single",
    value_text: "PostgreSQL 15",
    ...overrides,
  };
}

describe("oracleResolution", () => {
  it.each<{ name: string; candidates: ResolutionCandidate[]; expected: OracleResolution }>([
    {
      name: "supersedes a single-valued candidate of the same key with another value",
      candidates: [candidate({ id: "01OTHER", conflict_key: "project.cache" }), candidate({})],
      expected: { action: "SUPERSEDE", target: "01SAMEKEY" },
    },
    {
      name: "keeps a single-valued candidate holding the same normalised value",
      candidates: [candidate({ value_text: "  mysql   8 " })],
      expected: { action: "NOOP", target: "01SAMEKEY" },
    },
    {
      name: "adds next to a multi-valued candidate of the same key",
      candidates: [candidate({ cardinality: "multi" })],
      expected: { action: "ADD" },
    },
    {
      name: "adds next to candidates of other keys",
      candidates: [candidate({ conflict_key: "project.cache" })],
      expected: { action: "ADD" },
    },
  ])("$name", ({ candidates, expected }) => {
    expect(oracleResolution(MEMORY, candidates)).toEqual(expected);
  });
});
