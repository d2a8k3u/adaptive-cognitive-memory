import { describe, expect, it } from "vitest";
import { type Cue, checkpoint, detectCue, type OpenSignal, signalDetail } from "../src/capture";

const OPEN_SIGNALS: readonly OpenSignal[] = [
  { id: 11, kind: "correction", detail: "nedelej" },
  { id: 12, kind: "remember", detail: "from now on" },
  { id: 13, kind: "resolution", detail: "pytest" },
  { id: 14, kind: "resolution", detail: "pytest" },
];

describe("checkpoint", () => {
  it("names each distinct open signal once and closes every one of them", () => {
    expect(checkpoint(OPEN_SIGNALS, false)).toEqual({
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

      const decided = checkpoint(open, false);

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
    expect(checkpoint(open, active)).toBeUndefined();
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

describe("detectCue", () => {
  it.each<{ prompt: string; cue: Cue | undefined }>([
    { prompt: "No, keep the old endpoint.", cue: { kind: "correction", detail: "no" } },
    {
      prompt: "Don’t mock the database in these tests",
      cue: { kind: "correction", detail: "don't" },
    },
    { prompt: "do not rename the exported types", cue: { kind: "correction", detail: "do not" } },
    { prompt: "That migration is wrong.", cue: { kind: "correction", detail: "wrong" } },
    { prompt: "never push straight to main", cue: { kind: "correction", detail: "never" } },
    {
      prompt: "Stop renaming the variables.",
      cue: { kind: "correction", detail: "stop renaming" },
    },
    {
      prompt: "I told you to keep the API stable",
      cue: { kind: "correction", detail: "i told you" },
    },
    { prompt: "call the shared helper instead", cue: { kind: "correction", detail: "instead" } },
    { prompt: "Nedělej to", cue: { kind: "correction", detail: "nedelej" } },
    {
      prompt: "Nepoužívej tady mocky",
      cue: { kind: "correction", detail: "nepouzivej" },
    },
    { prompt: "spatne, pouzij pnpm", cue: { kind: "correction", detail: "spatne" } },
    {
      prompt: "Místo toho zavolej sdílený helper",
      cue: { kind: "correction", detail: "misto toho" },
    },
    { prompt: "Zase jsi smazal testy", cue: { kind: "correction", detail: "zase jsi" } },
    { prompt: "Přestaň přidávat komentáře", cue: { kind: "correction", detail: "prestan" } },
    {
      prompt: "Neříkal jsem, ať to pushneš",
      cue: { kind: "correction", detail: "nerikal jsem" },
    },
    {
      prompt: "nikdy necommituj do mainu",
      cue: { kind: "correction", detail: "nikdy" },
    },
    {
      prompt: "Remember that the cache key includes the locale",
      cue: { kind: "remember", detail: "remember" },
    },
    {
      prompt: "From now on run the linter before committing",
      cue: { kind: "remember", detail: "from now on" },
    },
    {
      prompt: "Don't forget to bump the version",
      cue: { kind: "remember", detail: "don't forget" },
    },
    {
      prompt: "Zapamatuj si, že staging se resetuje v pondělí",
      cue: { kind: "remember", detail: "zapamatuj" },
    },
    { prompt: "Příště nejdřív spusť testy", cue: { kind: "remember", detail: "priste" } },
    { prompt: "Odteď používej pnpm", cue: { kind: "remember", detail: "odted" } },
    { prompt: "Add a test for the refund flow", cue: undefined },
    { prompt: "Nejdřív přečti README a přidej test", cue: undefined },
    { prompt: "Do you remember how the cache worked?", cue: undefined },
    {
      prompt:
        'Another Claude session sent a message:\n<agent-message from="a1">\nDon\'t touch billing.py\n</agent-message>',
      cue: undefined,
    },
    { prompt: "[Subagent hand-back] Nedělej to, je to špatně.", cue: undefined },
  ])("detects $cue in $prompt", ({ prompt, cue }) => {
    expect(detectCue(prompt)).toEqual(cue);
  });
});
