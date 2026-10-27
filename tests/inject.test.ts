import { describe, expect, it } from "vitest";
import type { RecalledMemory } from "../src/gate";
import { estimateTokens, minLineTokens, renderInjection } from "../src/inject";
import { FAKE_SECRETS } from "./fixtures/secrets";

const HEADER =
  "Recalled memory from earlier sessions; verify it against the current code. Apply or follow each line, or say why it does not apply, then send memory_feedback for every id.";
const MODEL_WARNING = "memory degraded (model missing) — run /memory-doctor";
const MODEL_VEC_WARNING = "memory degraded (model, vec missing) — run /memory-doctor";
const SHORT_ID = "AAAAAAAAAAAAAAAA";

function memory(overrides: Partial<RecalledMemory> = {}): RecalledMemory {
  return {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    kind: "fact",
    epistemic: "verified",
    scope: "project",
    abstract: "default abstract",
    validFrom: "2026-10-13T09:30:00.000Z",
    ...overrides,
  };
}

describe("estimateTokens", () => {
  it("estimates tokens as ceil(chars / 4) at the rounding boundaries", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("minLineTokens", () => {
  it("equals the token cost of the shortest possible rendered line", () => {
    expect(minLineTokens()).toBe(16);
  });
});

describe("renderInjection", () => {
  it("renders the header, then non-empty sections in fixed order, one dated line per memory, constraints to apply and procedures to follow", () => {
    const rows = [
      memory({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        abstract: "Primary database is PostgreSQL 15",
        validFrom: "2026-10-01T08:00:00.000Z",
      }),
      memory({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
        kind: "constraint",
        scope: "user",
        abstract: "Never commit to main",
        validFrom: "2026-09-15T00:00:00.000Z",
      }),
      memory({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
        kind: "procedure",
        abstract: "Run tests with uv run pytest -q",
        validFrom: "2026-10-02T23:59:59.000Z",
      }),
      memory({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
        kind: "preference",
        scope: "user",
        abstract: "Prefer early returns",
        validFrom: "2026-09-20T12:00:00.000Z",
      }),
      memory({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAE",
        kind: "belief",
        abstract: "The flaky dunning test is caused by time zones",
        validFrom: "2026-10-03T00:00:00.000Z",
      }),
    ];

    expect(renderInjection(rows, 1200)).toEqual({
      text: [
        "<memory>",
        HEADER,
        "Constraints:",
        "- Apply — Never commit to main (valid from 2026-09-15 · user · 01ARZ3NDEKTSV4RRFFQ69G5FAB)",
        "Preferences:",
        "- Prefer early returns (valid from 2026-09-20 · user · 01ARZ3NDEKTSV4RRFFQ69G5FAD)",
        "Project facts:",
        "- Primary database is PostgreSQL 15 (valid from 2026-10-01 · project · 01ARZ3NDEKTSV4RRFFQ69G5FAA)",
        "- The flaky dunning test is caused by time zones (valid from 2026-10-03 · project · 01ARZ3NDEKTSV4RRFFQ69G5FAE)",
        "Procedures:",
        "- Follow — Run tests with uv run pytest -q (valid from 2026-10-02 · project · 01ARZ3NDEKTSV4RRFFQ69G5FAC)",
        "</memory>",
      ].join("\n"),
      injectedIds: [
        "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        "01ARZ3NDEKTSV4RRFFQ69G5FAB",
        "01ARZ3NDEKTSV4RRFFQ69G5FAC",
        "01ARZ3NDEKTSV4RRFFQ69G5FAD",
        "01ARZ3NDEKTSV4RRFFQ69G5FAE",
      ],
    });
    expect(renderInjection([memory({ kind: "procedure" })], 1200).text).not.toMatch(
      /Constraints:|Preferences:|Project facts:/,
    );
  });

  it("stops at the first memory whose line and new section title exceed the budget", () => {
    const rows = [
      memory({ id: SHORT_ID, abstract: "a".repeat(40) }),
      memory({ id: "BBBBBBBBBBBBBBBB", kind: "constraint", abstract: "b".repeat(40) }),
      memory({ id: "CCCCCCCCCCCCCCCC", abstract: "t" }),
    ];

    const below = renderInjection(rows, 104);
    expect(below.injectedIds).toEqual([SHORT_ID]);
    expect(estimateTokens(below.text)).toBeLessThanOrEqual(104);

    const atBoundary = renderInjection(rows, 105);
    expect(atBoundary.injectedIds).toEqual([SHORT_ID, "BBBBBBBBBBBBBBBB"]);
    expect(estimateTokens(atBoundary.text)).toBeLessThanOrEqual(105);
  });

  it("keeps a block of exactly 9,500 characters and drops the next line under any token budget", () => {
    const unboundedBudgetTokens = 100_000;
    const atCap = Array.from({ length: 36 }, (_, index) =>
      memory({ id: String(index).padStart(26, "0"), abstract: "f".repeat(index < 35 ? 194 : 129) }),
    );
    const overflow = memory({ id: "O".repeat(26), abstract: "o" });

    const kept = renderInjection(atCap, unboundedBudgetTokens);
    expect(kept.text.length).toBe(9_500);
    expect(kept.injectedIds).toHaveLength(36);

    expect(renderInjection([...atCap, overflow], unboundedBudgetTokens)).toEqual(kept);
  });

  it("masks a secret in a recalled abstract before it reaches the injection", () => {
    const secret = FAKE_SECRETS.slackBot;
    const { text } = renderInjection(
      [memory({ abstract: `deploy bot token ${secret} posts releases` })],
      1200,
    );
    expect(text).not.toContain(secret);
    expect(text).toContain("deploy bot token [REDACTED] posts releases");
  });

  it("renders nothing for no memories unless degraded, then only the warning", () => {
    expect(renderInjection([], 1200)).toEqual({ text: "", injectedIds: [] });
    expect(renderInjection([], 1200, {})).toEqual({ text: "", injectedIds: [] });
    expect(renderInjection([], 1200, { model: true })).toEqual({
      text: MODEL_WARNING,
      injectedIds: [],
    });
    expect(renderInjection([], 1200, { embedding_timeout: true })).toEqual({
      text: "memory degraded (embedding timeout) — run /memory-doctor",
      injectedIds: [],
    });
  });

  it("prepends the degraded warning and counts it against the budget", () => {
    const oneRow = [memory({ id: SHORT_ID, abstract: "a".repeat(40) })];

    const withWarning = renderInjection(oneRow, 90, { model: true, vec: true });
    expect(withWarning.text.startsWith(`${MODEL_VEC_WARNING}\n<memory>`)).toBe(true);
    expect(withWarning.injectedIds).toEqual([SHORT_ID]);

    expect(renderInjection(oneRow, 89, { model: true, vec: true })).toEqual({
      text: MODEL_VEC_WARNING,
      injectedIds: [],
    });
  });
});
