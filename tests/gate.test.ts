import { describe, expect, it } from "vitest";
import {
  NEIGHBOURHOOD_SIZE,
  neighbourhoodReference,
  type PromptCandidate,
  type PromptContext,
  type PromptGate,
  type SimilarityThresholds,
  selectPromptMemories,
  selectToolMemories,
  type ToolCandidate,
  type ToolGate,
} from "../src/gate";

const NO_MARGIN = -1;
const GATE: PromptGate = {
  thresholds: {
    en: {
      floor: 0.85,
      floorOpen: 0.8,
      margin: NO_MARGIN,
      fallbackTau: 0.85,
      fallbackTauOpen: 0.8,
      tauKey: 0.75,
    },
    cs: {
      floor: 0.78,
      floorOpen: 0.76,
      margin: NO_MARGIN,
      fallbackTau: 0.78,
      fallbackTauOpen: 0.76,
      tauKey: 0.7,
    },
  },
  keyMode: "disjunction",
  maxRows: 3,
};
const NOTHING_INJECTED: ReadonlySet<string> = new Set();

function neighbourhoodAt(cosine: number, size: number = NEIGHBOURHOOD_SIZE): number[] {
  return Array.from({ length: size }, () => cosine);
}

const ENGLISH_DENSE: PromptContext = { language: "en", neighbourhood: neighbourhoodAt(0.5) };

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
  gate: PromptGate = GATE,
  alreadyInjected: ReadonlySet<string> = NOTHING_INJECTED,
  context: PromptContext = ENGLISH_DENSE,
): string[] {
  return selectPromptMemories(candidates, gate, context, alreadyInjected).map((row) => row.id);
}

describe("selectPromptMemories", () => {
  it.each([
    { language: "en", expected: [] },
    { language: "cs", expected: ["fact", "constraint"] },
  ] as const)(
    "applies the $language thresholds to a $language prompt",
    ({ language, expected }) => {
      expect(
        selectedIds(
          [
            candidate({ id: "fact", cosine: 0.79 }),
            candidate({ id: "constraint", kind: "constraint", cosine: 0.77 }),
          ],
          { ...GATE, keyMode: "ignored" },
          NOTHING_INJECTED,
          { ...ENGLISH_DENSE, language },
        ),
      ).toEqual(expected);
    },
  );

  it("abstains when no candidate reaches its threshold and none has a key hit", () => {
    expect(
      selectedIds([
        candidate({ id: "fact", cosine: 0.849 }),
        candidate({ id: "constraint", kind: "constraint", cosine: 0.799 }),
        candidate({ id: "fts-only", ftsRank: -3.2 }),
      ]),
    ).toEqual([]);
  });

  it("admits constraints and preferences at tau_open while facts and procedures need tau", () => {
    expect(
      selectedIds([
        candidate({ id: "constraint", kind: "constraint", cosine: 0.8 }),
        candidate({ id: "preference", kind: "preference", cosine: 0.8 }),
        candidate({ id: "fact", kind: "fact", cosine: 0.84 }),
        candidate({ id: "procedure", kind: "procedure", cosine: 0.85 }),
      ]),
    ).toEqual(["procedure", "constraint", "preference"]);
  });

  it("admits beliefs and unverified rows only with a key hit", () => {
    expect(
      selectedIds([
        candidate({ id: "belief-no-key", kind: "belief", cosine: 0.95 }),
        candidate({ id: "unverified-no-key", epistemic: "unverified", cosine: 0.95 }),
        candidate({ id: "belief-key", kind: "belief", cosine: 0.9, keyHit: true }),
        candidate({ id: "unverified-key", epistemic: "unverified", cosine: 0.86, keyHit: true }),
      ]),
    ).toEqual(["belief-key", "unverified-key"]);
  });

  it.each([
    { keyMode: "disjunction", expected: ["key-high", "key-low", "key-none"] },
    { keyMode: "conjunction", expected: ["key-high"] },
    { keyMode: "ignored", expected: [] },
  ] as const)("lets a key hit admit a row below tau in $keyMode mode", ({ keyMode, expected }) => {
    expect(
      selectedIds(
        [
          candidate({ id: "key-high", cosine: 0.75, keyHit: true }),
          candidate({ id: "key-low", cosine: 0.74, keyHit: true }),
          candidate({ id: "key-none", keyHit: true }),
          candidate({ id: "no-key", cosine: 0.84 }),
        ],
        { ...GATE, keyMode },
      ),
    ).toEqual(expected);
  });

  it("keeps the k most similar admitted rows, skipping rows already injected in the session", () => {
    const admitted = [
      candidate({ id: "c86", cosine: 0.86 }),
      candidate({ id: "c90", cosine: 0.9 }),
      candidate({ id: "c88", cosine: 0.88 }),
      candidate({ id: "c95", cosine: 0.95 }),
      candidate({ id: "c87", cosine: 0.87 }),
    ];
    expect(selectedIds(admitted)).toEqual(["c95", "c90", "c88"]);
    expect(selectedIds(admitted, GATE, new Set(["c95", "c88"]))).toEqual(["c90", "c87", "c86"]);
  });

  it("orders key-hit rows without a cosine by the better, more negative bm25 rank", () => {
    expect(
      selectedIds(
        [
          candidate({ id: "weak", keyHit: true, ftsRank: -1.5 }),
          candidate({ id: "strong", keyHit: true, ftsRank: -6.25 }),
        ],
        { ...GATE, maxRows: 1 },
      ),
    ).toEqual(["strong"]);
  });
});

describe("selectPromptMemories against the prompt's neighbourhood", () => {
  const JUST_BELOW = 1e-9;
  const centred = (thresholds: Partial<SimilarityThresholds>): PromptGate => ({
    thresholds: { ...GATE.thresholds, en: { ...GATE.thresholds.en, ...thresholds } },
    keyMode: "ignored",
    maxRows: 8,
  });
  const english = (neighbourhood: readonly number[]): PromptContext => ({
    language: "en",
    neighbourhood,
  });

  it("admits a candidate exactly the margin above the neighbourhood mean and rejects one just below", () => {
    expect(
      selectedIds(
        [
          candidate({ id: "at-margin", cosine: 0.875 }),
          candidate({ id: "below-margin", cosine: 0.875 - JUST_BELOW }),
        ],
        centred({ floor: 0.5, margin: 0.125, fallbackTau: 0.5 }),
        NOTHING_INJECTED,
        english(neighbourhoodAt(0.75)),
      ),
    ).toEqual(["at-margin"]);
  });

  it("rejects a candidate just below the floor however far above its neighbourhood it stands", () => {
    expect(
      selectedIds(
        [
          candidate({ id: "at-floor", cosine: 0.875 }),
          candidate({ id: "below-floor", cosine: 0.875 - JUST_BELOW }),
        ],
        centred({ floor: 0.875, margin: 0.125, fallbackTau: 0.5 }),
        NOTHING_INJECTED,
        english(neighbourhoodAt(0.25)),
      ),
    ).toEqual(["at-floor"]);
  });

  it.each([
    { size: NEIGHBOURHOOD_SIZE - 1, expected: ["clear", "near", "constraint-near"] },
    { size: NEIGHBOURHOOD_SIZE, expected: ["clear"] },
  ])(
    "falls back to the absolute tau only while the neighbourhood holds fewer than K memories ($size)",
    ({ size, expected }) => {
      expect(
        selectedIds(
          [
            candidate({ id: "clear", cosine: 0.96875 }),
            candidate({ id: "near", cosine: 0.9 }),
            candidate({ id: "constraint-near", kind: "constraint", cosine: 0.72 }),
            candidate({ id: "fact-near", cosine: 0.72 }),
          ],
          centred({
            floor: 0.5,
            floorOpen: 0.5,
            margin: 0.0625,
            fallbackTau: 0.75,
            fallbackTauOpen: 0.7,
          }),
          NOTHING_INJECTED,
          english(neighbourhoodAt(0.875, size)),
        ),
      ).toEqual(expected);
    },
  );
});

describe("neighbourhoodReference", () => {
  it("averages the K nearest cosines whatever order the partition's nearest arrive in", () => {
    expect(neighbourhoodReference([0, 0, ...neighbourhoodAt(0.75)])).toBe(0.75);
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
