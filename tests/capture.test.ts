import { describe, expect, it } from "vitest";
import { checkpoint, type OpenSignal, signalDetail } from "../src/capture";
import { hostToolName } from "../src/toolnames";

const CLAUDE_STORE_TOOL = hostToolName("claude", "memory_store");

const OPEN_SIGNALS: readonly OpenSignal[] = [
  { id: 11, kind: "correction", detail: "nedelej" },
  { id: 12, kind: "remember", detail: "from now on" },
  { id: 13, kind: "resolution", detail: "pytest" },
  { id: 14, kind: "resolution", detail: "pytest" },
];

describe("checkpoint", () => {
  it("names each distinct open signal once and closes every one of them", () => {
    expect(checkpoint(OPEN_SIGNALS, false, CLAUDE_STORE_TOOL)).toEqual({
      text: 'Memory checkpoint: you were corrected about "nedelej"; the user asked you to remember "from now on"; you resolved a failing `pytest` — store the durable lesson under the memory rules with mcp__plugin_adaptive-cognitive-memory_memory__memory_store, or state that there is none, then finish.',
      closedIds: [11, 12, 13, 14],
    });
  });

  it.each([
    {
      count: 5,
      listed: "`step1`; `step2`; `step3`; `step4`; `step5`",
    },
    {
      count: 6,
      listed: "`step2`; `step3`; `step4`; `step5`; `step6`; and 1 more moment",
    },
    {
      count: 8,
      listed: "`step4`; `step5`; `step6`; `step7`; `step8`; and 3 more moments",
    },
  ])(
    "lists the five newest of $count moments and closes every one of them",
    ({ count, listed }) => {
      const open: OpenSignal[] = Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        kind: "resolution",
        detail: `step${index + 1}`,
      }));

      const decided = checkpoint(open, false, CLAUDE_STORE_TOOL);

      expect(decided?.text.replaceAll("you resolved a failing ", "")).toBe(
        `Memory checkpoint: ${listed} — store the durable lesson under the memory rules with mcp__plugin_adaptive-cognitive-memory_memory__memory_store, or state that there is none, then finish.`,
      );
      expect(decided?.closedIds).toEqual(open.map((signal) => signal.id));
    },
  );

  it.each([
    { name: "a stop hook is already continuing the turn", open: OPEN_SIGNALS, active: true },
    { name: "no signal is open", open: [], active: false },
  ])("stays silent when $name", ({ open, active }) => {
    expect(checkpoint(open, active, CLAUDE_STORE_TOOL)).toBeUndefined();
  });
});

describe("signalDetail", () => {
  it.each([
    { name: "a 200-character head", raw: "a".repeat(200), detail: "a".repeat(200) },
    { name: "a 201-character head", raw: "a".repeat(201), detail: "a".repeat(200) },
    { name: "astral characters by code point", raw: "😀".repeat(201), detail: "😀".repeat(200) },
    {
      name: "url credentials",
      raw: "git clone https://deploy:hunter2secret@git.example/repo.git",
      detail: "git clone https://[REDACTED]@git.example/repo.git",
    },
  ])("keeps $name within the stored limit", ({ raw, detail }) => {
    expect(signalDetail(raw)).toBe(detail);
  });

  it("masks a secret before cutting, so a cut cannot expose part of it", () => {
    const detail = signalDetail(`${"a".repeat(180)} https://deploy:hunter2secret@git.example`);

    expect(detail).toHaveLength(200);
    expect(detail).not.toContain("hunter2");
  });
});
