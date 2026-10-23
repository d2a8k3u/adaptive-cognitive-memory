import { describe, expect, it } from "vitest";
import { admitPrompt, distinctWords } from "../src/prompt";

describe("admitPrompt", () => {
  it("rejects a slash command", () => {
    expect(admitPrompt("/compact keep the billing notes", 1)).toEqual({
      admitted: false,
      reason: "slash_command",
    });
  });

  it.each([
    { prompt: "great, thanks" },
    { prompt: "v pohodě" },
    { prompt: "danke, passt" },
    { prompt: "なんで?" },
  ])(
    "rejects $prompt for having fewer distinct words than the minimum, whatever its language",
    ({ prompt }) => {
      expect(admitPrompt(prompt, 3)).toEqual({ admitted: false, reason: "too_few_words" });
    },
  );

  it("counts every distinct word of two or more letters, with no word list deciding what counts", () => {
    expect(admitPrompt("Jak spustím testy v billingu?", 4)).toEqual({
      admitted: true,
      tokens: ["jak", "spustím", "testy", "billingu"],
    });
    expect(admitPrompt("Jak spustím testy v billingu?", 5)).toEqual({
      admitted: false,
      reason: "too_few_words",
    });
  });

  it("segments scripts written without spaces into words before counting them", () => {
    expect(admitPrompt("顧客に返金するにはどうすればいい?", 3)).toEqual({
      admitted: true,
      tokens: ["顧客", "返金", "する", "どう", "いい"],
    });
  });
});

describe("distinctWords", () => {
  it("lowercases, splits on punctuation, drops one-letter words and repeats", () => {
    expect(distinctWords("Use fmt.Errorf, then FMT again; a b")).toEqual([
      "use",
      "fmt",
      "errorf",
      "then",
      "again",
    ]);
  });
});
