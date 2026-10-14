import { describe, expect, it } from "vitest";
import {
  type ContextEventName,
  type DeliveryChannel,
  deliveredContext,
  type HookProcessOutput,
  injectedIds,
  stopDelivery,
} from "./host";

const PLAIN_BLOCK = "<memory>\n- (project/semantic) Billing uses Postgres. (01K7AAAA)\n</memory>";

function exitedCleanly(stdout: string): HookProcessOutput {
  return { exitCode: 0, stdout, stderr: "" };
}

function contextJson(hookEventName: string, additionalContext: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } });
}

describe("deliveredContext", () => {
  const cases: readonly [string, ContextEventName, HookProcessOutput, DeliveryChannel, string][] = [
    [
      "session start plain stdout",
      "SessionStart",
      exitedCleanly(PLAIN_BLOCK),
      "plain_stdout",
      PLAIN_BLOCK,
    ],
    [
      "prompt plain stdout",
      "UserPromptSubmit",
      exitedCleanly(`${PLAIN_BLOCK}\n`),
      "plain_stdout",
      PLAIN_BLOCK,
    ],
    [
      "pre-tool plain stdout goes to the debug log",
      "PreToolUse",
      exitedCleanly(PLAIN_BLOCK),
      "none",
      "",
    ],
    [
      "pre-compact plain stdout goes to the debug log",
      "PreCompact",
      exitedCleanly(PLAIN_BLOCK),
      "none",
      "",
    ],
    [
      "prompt json delivers only the context",
      "UserPromptSubmit",
      exitedCleanly(contextJson("UserPromptSubmit", "ctx")),
      "additional_context",
      "ctx",
    ],
    [
      "pre-tool json context",
      "PreToolUse",
      exitedCleanly(contextJson("PreToolUse", "ctx")),
      "additional_context",
      "ctx",
    ],
    [
      "pre-compact has no context channel",
      "PreCompact",
      exitedCleanly(contextJson("PreCompact", "ctx")),
      "none",
      "",
    ],
    [
      "json naming another event",
      "PreToolUse",
      exitedCleanly(contextJson("UserPromptSubmit", "ctx")),
      "none",
      "",
    ],
    [
      "json with surrounding text is plain text",
      "SessionStart",
      exitedCleanly(`note ${contextJson("SessionStart", "ctx")}`),
      "plain_stdout",
      `note ${contextJson("SessionStart", "ctx")}`,
    ],
    [
      "blocked prompt reaches nobody",
      "UserPromptSubmit",
      exitedCleanly(
        JSON.stringify({
          decision: "block",
          reason: "no",
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ctx" },
        }),
      ),
      "none",
      "",
    ],
    [
      "non-blocking error",
      "UserPromptSubmit",
      { exitCode: 1, stdout: PLAIN_BLOCK, stderr: "boom" },
      "none",
      "",
    ],
    [
      "exit 2 on a prompt blocks it",
      "UserPromptSubmit",
      { exitCode: 2, stdout: "", stderr: "denied" },
      "none",
      "",
    ],
    [
      "exit 2 on a tool call shows stderr to Claude",
      "PreToolUse",
      { exitCode: 2, stdout: "", stderr: "denied\n" },
      "blocking_stderr",
      "denied",
    ],
    ["blank stdout", "UserPromptSubmit", exitedCleanly("  \n"), "none", ""],
  ];

  it.each(cases)("%s", (_name, event, output, channel, text) => {
    expect(deliveredContext(event, output)).toEqual({ channel, text, overflowed: false });
  });

  it("replaces text above 10,000 characters with a 2,000-character preview", () => {
    const atCap = "a".repeat(10_000);
    expect(deliveredContext("UserPromptSubmit", exitedCleanly(atCap))).toEqual({
      channel: "plain_stdout",
      text: atCap,
      overflowed: false,
    });
    const overCap = `${"b".repeat(2_000)}${"c".repeat(8_001)}`;
    expect(deliveredContext("UserPromptSubmit", exitedCleanly(overCap))).toEqual({
      channel: "plain_stdout",
      text: "b".repeat(2_000),
      overflowed: true,
    });
  });
});

describe("stopDelivery", () => {
  it("records decision, reason and additional context separately and ignores plain stdout", () => {
    const blocking = JSON.stringify({
      decision: "block",
      reason: "store the lesson first",
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: "memory checkpoint" },
    });
    expect(stopDelivery(exitedCleanly(blocking))).toEqual({
      decision: "block",
      reason: "store the lesson first",
      additionalContext: "memory checkpoint",
    });
    expect(stopDelivery(exitedCleanly("plain text"))).toEqual({
      decision: undefined,
      reason: undefined,
      additionalContext: undefined,
    });
    expect(stopDelivery({ exitCode: 2, stdout: "", stderr: "keep going\n" })).toEqual({
      decision: "block",
      reason: "keep going",
      additionalContext: undefined,
    });
  });
});

describe("injectedIds", () => {
  it("finds memories by their full stored id, in order of appearance, when ids share a timestamp prefix", () => {
    const stored = new Map([
      ["fact-a", "01K7AAAA0000000000000000AA"],
      ["fact-b", "01K7AAAA0000000000000000AB"],
      ["fact-c", "01K7AAAA0000000000000000AC"],
    ]);
    const delivered = "- second (01K7AAAA0000000000000000AB)\n- first (01K7AAAA0000000000000000AA)";
    expect(injectedIds(delivered, stored)).toEqual(["fact-b", "fact-a"]);
  });

  it("refuses two fixtures that resolved to one stored memory because attribution would be ambiguous", () => {
    const stored = new Map([
      ["fact-x", "01K7AAAA0000000000000000XX"],
      ["fact-y", "01K7AAAA0000000000000000XX"],
    ]);
    expect(() => injectedIds("(01K7AAAA0000000000000000XX)", stored)).toThrowError(
      /fact-x and fact-y both resolved to 01K7AAAA0000000000000000XX/,
    );
  });
});
