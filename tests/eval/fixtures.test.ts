import { describe, expect, it } from "vitest";
import {
  type FixtureMemory,
  type Fixtures,
  type Lang,
  type NegativePrompt,
  type PositivePrompt,
  parseRedaction,
  pretoolSplit,
  promptSplit,
  referenceProblems,
  type Split,
} from "./fixtures";

function positive(
  id: string,
  project: string,
  lang: Lang,
  gold: string[],
  split: Split,
): PositivePrompt {
  return { id, project, lang, prompt: `prompt ${id}`, gold, family: gold[0] ?? id, split };
}

function negative(id: string, prompt: string, split: Split): NegativePrompt {
  return {
    id,
    project: "p1",
    lang: "en",
    category: "content_free",
    prompt,
    gold: [],
    family: "content_free/p1",
    split,
  };
}

function memory(id: string, project: string | undefined): FixtureMemory {
  return {
    id,
    scope: project === undefined ? "user" : "project",
    project,
    type: "semantic",
    kind: "fact",
    title: `title ${id}`,
    content: `content ${id}`,
    conflict_key: `test.${id}`,
    cardinality: "single",
    value_text: id,
    keywords: id,
    anchors: [],
    questions: [],
  };
}

function coveredFamily(family: string, project: string): PositivePrompt[] {
  return [
    positive(`pos-${family}-1`, project, "en", [family], "calibration"),
    positive(`pos-${family}-conf-1`, project, "en", [family], "confirmation"),
    positive(`pos-${family}-conf-2`, project, "cs", [family], "confirmation"),
  ];
}

function validFixtures(): Fixtures {
  return {
    corpus: {
      projects: [
        { key: "p1", description: "first" },
        { key: "p2", description: "second" },
      ],
      memories: [memory("m1", "p1"), memory("m2", "p2"), memory("u1", undefined)],
    },
    positives: [
      ...coveredFamily("m1", "p1"),
      ...coveredFamily("m2", "p2"),
      ...coveredFamily("u1", "p1"),
    ],
    negatives: [],
    pretool: [],
    supersession: [],
    contradictions: [],
    cues: [],
    redaction: [],
    multilingualPrompts: [],
    multilingualCues: [],
  };
}

describe("promptSplit", () => {
  it("puts ids ending in the confirmation marker in confirmation and every other id in calibration", () => {
    expect(promptSplit("pos-billing-db-primary-conf-2")).toBe("confirmation");
    expect(promptSplit("neg-billing-api-off_topic-conf-07")).toBe("confirmation");
    expect(promptSplit("pos-billing-db-primary-2")).toBe("calibration");
    expect(promptSplit("pos-guide-conf-banner-1")).toBe("calibration");
  });
});

describe("pretoolSplit", () => {
  it("calibrates on odd case numbers and holds out even ones", () => {
    expect(pretoolSplit("pt-billing-api-07")).toBe("calibration");
    expect(pretoolSplit("pt-billing-api-10")).toBe("heldout");
    expect(() => pretoolSplit("pt-billing-api")).toThrowError(/no case number/);
  });
});

describe("referenceProblems", () => {
  it("accepts calibration prompts beside an English and a Czech confirmation prompt per family", () => {
    expect(referenceProblems(validFixtures())).toEqual([]);
  });

  it("reports unknown gold, gold from another project and splits that break the rule", () => {
    const base = validFixtures();
    const fixtures: Fixtures = {
      ...base,
      positives: [
        ...base.positives,
        positive("pos-m1-2", "p1", "en", ["m1", "ghost"], "calibration"),
        positive("pos-m1-3", "p1", "cs", ["m1", "m2"], "calibration"),
        positive("pos-m2-conf-3", "p2", "en", ["m2"], "calibration"),
        positive("pos-m2-2", "p2", "cs", ["m2"], "confirmation"),
      ],
    };
    expect(referenceProblems(fixtures)).toEqual([
      expect.stringMatching(/pos-m1-2.*unknown memory ghost/),
      expect.stringMatching(/pos-m1-3.*m2.*project p2/),
      expect.stringMatching(/pos-m2-conf-3.*split calibration.*expected confirmation/),
      expect.stringMatching(/pos-m2-2.*split confirmation.*expected calibration/),
    ]);
  });

  it("reports a family that lacks a confirmation prompt in one language", () => {
    const base = validFixtures();
    const fixtures: Fixtures = {
      ...base,
      positives: base.positives.filter((item) => item.id !== "pos-m2-conf-2"),
    };
    expect(referenceProblems(fixtures)).toEqual([
      expect.stringMatching(/m2.*no cs confirmation positive/),
    ]);
  });

  it("reports confirmation prompts that repeat a calibration prompt", () => {
    const base = validFixtures();
    const fixtures: Fixtures = {
      ...base,
      positives: base.positives.map((item) =>
        item.id === "pos-m1-conf-1" ? { ...item, prompt: " Prompt  pos-m1-1" } : item,
      ),
      negatives: [
        negative("neg-p1-content_free-01", "ok", "calibration"),
        negative("neg-p1-content_free-conf-01", "OK", "confirmation"),
        negative("neg-p1-content_free-conf-02", "okay then", "confirmation"),
      ],
    };
    expect(referenceProblems(fixtures)).toEqual([
      expect.stringMatching(/pos-m1-conf-1.*repeats a calibration prompt/),
      expect.stringMatching(/neg-p1-content_free-conf-01.*repeats a calibration prompt/),
    ]);
  });

  it("reports distractors with anchors, a shared conflict key or a place in gold", () => {
    const base = validFixtures();
    const fixtures: Fixtures = {
      ...base,
      corpus: {
        ...base.corpus,
        memories: [
          ...base.corpus.memories,
          { ...memory("dx-anchored", "p1"), anchors: ["src/app.ts"] },
          { ...memory("dx-sharing", "p2"), conflict_key: "test.m2" },
          memory("dx-gold", "p1"),
        ],
      },
      positives: [
        ...base.positives,
        positive("pos-m1-2", "p1", "en", ["m1", "dx-gold"], "calibration"),
      ],
    };
    expect(referenceProblems(fixtures)).toEqual([
      expect.stringMatching(/dx-anchored.*must not carry anchors/),
      expect.stringMatching(/dx-sharing.*shares conflict key test\.m2/),
      expect.stringMatching(/pos-m1-2.*gold names distractor dx-gold/),
    ]);
  });

  it("reports translations whose source is not a labelled prompt or a human cue", () => {
    const base = validFixtures();
    const fixtures: Fixtures = {
      ...base,
      cues: [
        { id: "cue-1", lang: "en", origin: "human", label: "correction", text: "No, use pnpm." },
        { id: "cue-2", lang: "en", origin: "harness", label: "neutral", text: "<agent-message>" },
      ],
      multilingualPrompts: [
        { id: "pos-m1-1#de", source: "pos-m1-1", lang: "de", prompt: "Frage" },
        { id: "pos-gone-1#ja", source: "pos-gone-1", lang: "ja", prompt: "質問" },
      ],
      multilingualCues: [
        { id: "cue-1#es", source: "cue-1", lang: "es", text: "No, usa pnpm." },
        { id: "cue-2#pl", source: "cue-2", lang: "pl", text: "<agent-message>" },
      ],
    };
    expect(referenceProblems(fixtures)).toEqual([
      expect.stringMatching(/pos-gone-1#ja.*no labelled prompt pos-gone-1/),
      expect.stringMatching(/cue-2#pl.*no human cue cue-2/),
    ]);
  });

  it("reports a memory whose conflict key the store would reject, before any store", () => {
    const base = validFixtures();
    const fixtures: Fixtures = {
      ...base,
      corpus: {
        ...base.corpus,
        memories: base.corpus.memories.map((item) =>
          item.id === "m1" ? { ...item, conflict_key: "billing.x" } : item,
        ),
      },
    };
    expect(referenceProblems(fixtures)).toEqual([
      expect.stringMatching(/^m1: conflict_key must be namespace\.topic/),
    ]);
  });
});

describe("parseRedaction", () => {
  it("assembles the sample text and its secret from their fragments", () => {
    expect(
      parseRedaction(
        {
          name: "split_token",
          text_parts: ["Use -----BEGIN ", "MARKER----- with {secret} today."],
          secret_parts: ["tok", "en_123"],
        },
        "redaction[0]",
      ),
    ).toEqual({
      name: "split_token",
      text: "Use -----BEGIN MARKER----- with token_123 today.",
      secret: "token_123",
    });
  });

  it.each([
    { name: "no placeholder", text_parts: ["no slot here"] },
    { name: "two placeholders", text_parts: ["{secret} and ", "{secret}"] },
  ])("rejects a text with $name", ({ text_parts }) => {
    expect(() =>
      parseRedaction({ name: "bad", text_parts, secret_parts: ["x"] }, "redaction[1]"),
    ).toThrow(new TypeError("redaction[1].text_parts must hold exactly one {secret}"));
  });
});
