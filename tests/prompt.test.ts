import { describe, expect, it } from "vitest";
import { admitPrompt, contentTokens } from "../src/prompt";

describe("admitPrompt", () => {
  it.each([
    { prompt: "/compact keep the billing notes", min: 1, expected: "slash_command" },
    { prompt: "great, thanks", min: 2, expected: "acknowledgement" },
    { prompt: "v pohodě, pokračuj", min: 1, expected: "acknowledgement" },
    { prompt: "Jak spustím testy?", min: 3, expected: "too_few_content_tokens" },
    { prompt: "How do I run the tests here?", min: 3, expected: "too_few_content_tokens" },
  ])("rejects $prompt as $expected", ({ prompt, min, expected }) => {
    expect(admitPrompt(prompt, min)).toEqual({ admitted: false, reason: expected });
  });

  it("segments scripts written without spaces into words before counting them", () => {
    expect(admitPrompt("顧客に返金するにはどうすればいい?", 3)).toEqual({
      admitted: true,
      tokens: ["顧客", "返金", "する", "どう", "いい"],
    });
    expect(admitPrompt("なんで?", 3)).toEqual({
      admitted: false,
      reason: "too_few_content_tokens",
    });
  });

  it("admits a prompt with exactly the minimum number of content tokens, stopwords removed", () => {
    expect(admitPrompt("Jak spustím testy v billingu?", 3)).toEqual({
      admitted: true,
      tokens: ["spustím", "testy", "billingu"],
    });
    expect(admitPrompt("How do I run the tests here?", 2)).toEqual({
      admitted: true,
      tokens: ["run", "tests"],
    });
  });
});

describe("contentTokens", () => {
  it("lowercases, splits on punctuation, drops one-letter words and repeats", () => {
    expect(contentTokens("Use fmt.Errorf, then FMT again; a b")).toEqual(["use", "fmt", "errorf"]);
  });
});
