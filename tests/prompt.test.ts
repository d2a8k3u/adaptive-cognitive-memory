import { describe, expect, it } from "vitest";
import { admitPrompt, contentTokens, promptLanguage } from "../src/prompt";

describe("promptLanguage", () => {
  it.each([
    { prompt: "spustím testy", expected: "cs" },
    { prompt: "ŘEKNI BILLING DEPLOY", expected: "cs" },
    { prompt: "zkrať log", expected: "cs" },
    { prompt: "jak spustim testy", expected: "cs" },
    { prompt: "co to dela", expected: "cs" },
    { prompt: "jak the deploy works", expected: "en" },
    { prompt: "How do I run the tests here?", expected: "en" },
    { prompt: "deploy billing staging", expected: "en" },
  ])("classifies $prompt as $expected", ({ prompt, expected }) => {
    expect(promptLanguage(prompt)).toBe(expected);
  });
});

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
