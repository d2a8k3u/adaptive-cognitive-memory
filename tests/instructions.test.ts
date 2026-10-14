import { describe, expect, it } from "vitest";
import { restatedInstruction } from "../src/instructions";

describe("restatedInstruction", () => {
  const twentyChars = "never commit to main";
  const lines = [
    { source: "/repo/.claude/rules/git.md", text: `- **${twentyChars.toUpperCase()}**` },
    { source: "/repo/CLAUDE.md", text: "Run   the suite with uv run pytest -q before pushing" },
  ];

  it.each([
    { content: "  Never   COMMIT to main ", restated: lines[0] },
    { content: "the suite with UV RUN pytest -q", restated: lines[1] },
    { content: "never commit to main, open a pull request", restated: undefined },
    { content: "uv run pytest", restated: undefined },
  ])("finds $restated.source for $content", ({ content, restated }) => {
    expect(restatedInstruction(content, lines)).toEqual(restated);
  });

  it("counts content of exactly 20 normalised characters and ignores content of 19", () => {
    expect(twentyChars).toHaveLength(20);

    expect(restatedInstruction(` ${twentyChars} `, lines)).toEqual(lines[0]);
    expect(restatedInstruction(twentyChars.slice(1), lines)).toBeUndefined();
  });
});
