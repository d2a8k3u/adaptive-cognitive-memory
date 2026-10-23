import { describe, expect, it } from "vitest";
import {
  type PromptCandidate,
  type PromptGate,
  relevanceFeatures,
  selectPromptMemories,
  selectToolMemories,
  type ToolCandidate,
  type ToolGate,
} from "../src/gate";

const COSINE_ONLY: PromptGate = {
  bias: -5,
  weights: { cosine: 10, gapToTop: 0, gapToNeighbourhood: 0, lexical: 0, top: 0, keyHit: 0 },
  threshold: 0,
  maxRows: 2,
  neighbourhoodPrior: 0,
};
const ADMITTED_COSINE = 0.5;
const JUST_BELOW = 1e-9;
const NOTHING_INJECTED: ReadonlySet<string> = new Set();

function candidate(overrides: Partial<PromptCandidate> & { id: string }): PromptCandidate {
  return {
    kind: "fact",
    epistemic: "verified",
    scope: "project",
    abstract: `abstract of ${overrides.id}`,
    validFrom: "2026-10-13T00:00:00.000Z",
    cosine: undefined,
    ftsRank: undefined,
    keyHit: false,
    ...overrides,
  };
}

function selectedIds(
  candidates: readonly PromptCandidate[],
  gate: PromptGate = COSINE_ONLY,
  alreadyInjected: ReadonlySet<string> = NOTHING_INJECTED,
): string[] {
  const neighbourhood = candidates.flatMap((item) =>
    item.cosine === undefined ? [] : [item.cosine],
  );
  return selectPromptMemories(candidates, gate, { neighbourhood }, alreadyInjected).map(
    (row) => row.id,
  );
}

describe("relevanceFeatures", () => {
  it("derives the gap to the top cosine and to the mean of the ten nearest, the bm25 strength and the hits", () => {
    const neighbourhood = [0.5, 0.8, 0.5, 0.5, 0.6, 0.5, 0.5, 0.5, 0.1, 0.5, 0.5];

    expect(
      relevanceFeatures(
        candidate({ id: "c", cosine: 0.6, ftsRank: -2, keyHit: true }),
        { neighbourhood },
        0,
      ),
    ).toEqual({
      cosine: 0.6,
      gapToTop: expect.closeTo(-0.2, 12),
      gapToNeighbourhood: expect.closeTo(0.06, 12),
      lexical: expect.closeTo(Math.log(3), 12),
      top: 0,
      keyHit: 1,
    });
  });
});

describe("relevanceFeatures in a sparse neighbourhood", () => {
  it("fills the missing nearest cosines with the prior so a small database is judged like a full one", () => {
    expect(
      relevanceFeatures(candidate({ id: "only", cosine: 0.8 }), { neighbourhood: [0.8] }, 0.5)
        ?.gapToNeighbourhood,
    ).toBeCloseTo(0.27, 12);
  });
});

describe("selectPromptMemories", () => {
  it("admits a candidate whose score reaches the threshold and rejects one just below it", () => {
    expect(
      selectedIds([
        candidate({ id: "at-threshold", cosine: ADMITTED_COSINE }),
        candidate({ id: "below-threshold", cosine: ADMITTED_COSINE - JUST_BELOW }),
      ]),
    ).toEqual(["at-threshold"]);
  });

  it("keeps the best-scoring rows up to maxRows, skipping rows already injected in the session", () => {
    expect(
      selectedIds(
        [
          candidate({ id: "third", cosine: 0.7 }),
          candidate({ id: "best", cosine: 0.9 }),
          candidate({ id: "injected", cosine: 0.95 }),
          candidate({ id: "second", cosine: 0.8 }),
        ],
        COSINE_ONLY,
        new Set(["injected"]),
      ),
    ).toEqual(["best", "second"]);
  });

  it("never admits a keyword-only candidate that has no cosine", () => {
    const lexicalOnly: PromptGate = {
      ...COSINE_ONLY,
      weights: { ...COSINE_ONLY.weights, lexical: 100 },
    };

    expect(
      selectedIds([candidate({ id: "fts-only", ftsRank: -20, keyHit: true })], lexicalOnly),
    ).toEqual([]);
  });

  it("admits beliefs and unverified rows only with a key hit", () => {
    expect(
      selectedIds([
        candidate({ id: "belief", kind: "belief", cosine: 0.9 }),
        candidate({ id: "unverified", epistemic: "unverified", cosine: 0.9 }),
        candidate({ id: "keyed-belief", kind: "belief", cosine: 0.8, keyHit: true }),
      ]),
    ).toEqual(["keyed-belief"]);
  });
});

function toolCandidate(overrides: Partial<ToolCandidate> & { id: string }): ToolCandidate {
  return {
    kind: "procedure",
    epistemic: "verified",
    scope: "project",
    abstract: `abstract of ${overrides.id}`,
    validFrom: "2026-10-13T00:00:00.000Z",
    anchorHit: false,
    keyHit: false,
    ...overrides,
  };
}

describe("selectToolMemories", () => {
  const candidates = [
    toolCandidate({ id: "procedure-key", keyHit: true }),
    toolCandidate({ id: "fact-anchor", kind: "fact", anchorHit: true }),
    toolCandidate({ id: "constraint-anchor", kind: "constraint", anchorHit: true }),
    toolCandidate({ id: "procedure-none" }),
    toolCandidate({ id: "procedure-anchor", anchorHit: true }),
  ];

  it.each([
    {
      gate: { kinds: ["procedure", "constraint"], keywordSignal: false },
      expected: ["constraint-anchor", "procedure-anchor"],
    },
    {
      gate: { kinds: ["procedure", "constraint", "fact"], keywordSignal: true },
      expected: ["constraint-anchor", "fact-anchor", "procedure-anchor", "procedure-key"],
    },
  ] satisfies { gate: ToolGate; expected: string[] }[])(
    "admits the configured kinds on an anchor hit, and on a key hit only with the keyword signal",
    ({ gate, expected }) => {
      expect(selectToolMemories(candidates, gate, NOTHING_INJECTED).map((row) => row.id)).toEqual(
        expected,
      );
    },
  );

  it("skips rows already injected in the session", () => {
    expect(
      selectToolMemories(
        candidates,
        { kinds: ["procedure", "constraint"], keywordSignal: false },
        new Set(["procedure-anchor"]),
      ).map((row) => row.id),
    ).toEqual(["constraint-anchor"]);
  });
});
