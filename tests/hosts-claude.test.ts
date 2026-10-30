import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database";
import { claudeRequest } from "../src/hosts/claude";
import type { EngineAction, HookRequest } from "../src/hosts/request";
import { newId } from "../src/ids";
import { testModelCacheDir, testModelEnv } from "../vitest.config";
import { type ProcessResult, runProcess, seedConfig } from "./fixtures/seed";

const FEEDBACK_TOOL = "mcp__plugin_adaptive-cognitive-memory_memory__memory_feedback";
const STORE_TOOL = "mcp__plugin_adaptive-cognitive-memory_memory__memory_store";
const UPDATE_TOOL = "mcp__plugin_adaptive-cognitive-memory_memory__memory_update";
const SESSION = "session-claude";
const CWD = "/repo";
const BASH_INPUT = { command: "npm test" };

function projectRequest(event: string, actions: readonly EngineAction[]): HookRequest {
  return { event, scope: "project", sessionId: SESSION, cwd: CWD, actions };
}

function sessionRequest(event: string, actions: readonly EngineAction[]): HookRequest {
  return { event, scope: "session", sessionId: SESSION, cwd: CWD, actions };
}

describe("claudeRequest", () => {
  it.each<{ name: string; input: Record<string, unknown>; expected: HookRequest | undefined }>([
    {
      name: "SessionStart starts a session with its source",
      input: { hook_event_name: "SessionStart", source: "resume" },
      expected: projectRequest("SessionStart", [{ kind: "session-start", source: "resume" }]),
    },
    {
      name: "UserPromptSubmit recalls for the trimmed prompt",
      input: { hook_event_name: "UserPromptSubmit", prompt: "  how do we deploy  " },
      expected: projectRequest("UserPromptSubmit", [
        { kind: "prompt", prompt: "how do we deploy" },
      ]),
    },
    {
      name: "UserPromptSubmit without a string prompt recalls for an empty prompt",
      input: { hook_event_name: "UserPromptSubmit", prompt: 42 },
      expected: projectRequest("UserPromptSubmit", [{ kind: "prompt", prompt: "" }]),
    },
    {
      name: "PreToolUse on Bash looks up the command",
      input: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: BASH_INPUT },
      expected: projectRequest("PreToolUse", [
        { kind: "tool-recall", target: { kind: "command", toolInput: BASH_INPUT } },
      ]),
    },
    {
      name: "PreToolUse on Edit looks up its file",
      input: {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/repo/a.ts", old_string: "a" },
      },
      expected: projectRequest("PreToolUse", [
        { kind: "tool-recall", target: { kind: "files", paths: ["/repo/a.ts"] } },
      ]),
    },
    {
      name: "PreToolUse on Read without a string path has no target",
      input: { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: 7 } },
      expected: projectRequest("PreToolUse", [{ kind: "tool-recall", target: { kind: "none" } }]),
    },
    {
      name: "PreToolUse on another tool has no target",
      input: { hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { file_path: "/a" } },
      expected: projectRequest("PreToolUse", [{ kind: "tool-recall", target: { kind: "none" } }]),
    },
    {
      name: "PostToolUse on memory_feedback records a receipt",
      input: {
        hook_event_name: "PostToolUse",
        tool_name: FEEDBACK_TOOL,
        tool_input: { used: ["m"] },
      },
      expected: sessionRequest("PostToolUse", [
        { kind: "feedback-receipt", toolInput: { used: ["m"] } },
      ]),
    },
    {
      name: "PostToolUse on memory_store closes the session signals",
      input: { hook_event_name: "PostToolUse", tool_name: STORE_TOOL, tool_input: {} },
      expected: sessionRequest("PostToolUse", [{ kind: "store-receipt" }]),
    },
    {
      name: "PostToolUse on memory_update closes the session signals",
      input: { hook_event_name: "PostToolUse", tool_name: UPDATE_TOOL, tool_input: {} },
      expected: sessionRequest("PostToolUse", [{ kind: "store-receipt" }]),
    },
    {
      name: "PostToolUse on Bash counts a pass",
      input: { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: BASH_INPUT },
      expected: sessionRequest("PostToolUse", [{ kind: "command-passed", toolInput: BASH_INPUT }]),
    },
    {
      name: "PostToolUse on a Bash launch in the background counts nothing",
      input: {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { ...BASH_INPUT, run_in_background: true },
      },
      expected: sessionRequest("PostToolUse", []),
    },
    {
      name: "PostToolUse on another tool does nothing",
      input: { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: {} },
      expected: sessionRequest("PostToolUse", []),
    },
    {
      name: "PostToolUseFailure on Bash records the failure",
      input: {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: BASH_INPUT,
        error: "Exit code 1",
        is_interrupt: false,
      },
      expected: projectRequest("PostToolUseFailure", [
        { kind: "command-failed", toolInput: BASH_INPUT, error: "Exit code 1", interrupted: false },
      ]),
    },
    {
      name: "PostToolUseFailure on an interrupted Bash call keeps the interrupt",
      input: {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: BASH_INPUT,
        error: { message: "x" },
        is_interrupt: true,
      },
      expected: projectRequest("PostToolUseFailure", [
        { kind: "command-failed", toolInput: BASH_INPUT, error: undefined, interrupted: true },
      ]),
    },
    {
      name: "PostToolUseFailure on another tool does nothing",
      input: { hook_event_name: "PostToolUseFailure", tool_name: "Edit", error: "Exit code 1" },
      expected: projectRequest("PostToolUseFailure", []),
    },
    {
      name: "Stop while a stop hook is active",
      input: { hook_event_name: "Stop", stop_hook_active: true },
      expected: sessionRequest("Stop", [{ kind: "stop", stopHookActive: true }]),
    },
    {
      name: "Stop with a non-boolean stop_hook_active",
      input: { hook_event_name: "Stop", stop_hook_active: "true" },
      expected: sessionRequest("Stop", [{ kind: "stop", stopHookActive: false }]),
    },
    {
      name: "an unknown event",
      input: { hook_event_name: "Notification" },
      expected: undefined,
    },
  ])("maps $name", ({ input, expected }) => {
    expect(claudeRequest({ session_id: SESSION, cwd: CWD, ...input })).toEqual(expected);
  });

  it("narrows a malformed session id and cwd to absent", () => {
    expect(claudeRequest({ hook_event_name: "Stop", session_id: 7, cwd: ["/repo"] })).toEqual({
      event: "Stop",
      scope: "session",
      sessionId: undefined,
      cwd: undefined,
      actions: [{ kind: "stop", stopHookActive: false }],
    });
  });
});

const HOOK_KILL_MS = 25_000;
const SPAWNED_TIMEOUT_MS = 60_000;
const CODEX_TOOL_NAMES = [
  "mcp__memory__memory_feedback",
  "mcp__memory__memory_store",
  "mcp__memory__memory_update",
] as const;

interface StoreCounts {
  readonly receipts: number;
  readonly verdicts: number;
  readonly openSignals: number;
}

describe("Claude PostToolUse naming the Codex memory tools (D-16)", () => {
  it(
    "prints nothing and writes no receipt, verdict or signal change",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "acm-hosts-claude-"));
      const config = seedConfig(dataDir, testModelCacheDir);
      const memoryId = newId();
      const seeded = openDatabase(config);
      try {
        seeded.db
          .prepare(
            `INSERT INTO memories (id, type, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
             VALUES (?, 'semantic', 'user', 'p', 'title', 'abstract', 'body', 0.5, NULL, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
          )
          .run(memoryId);
        seeded.db
          .prepare(
            "INSERT INTO session_signals (session_id, kind, detail, opened_at) VALUES (?, 'remember', 'the release freeze', '2026-10-30T00:00:00.000Z')",
          )
          .run(SESSION);
      } finally {
        seeded.db.close();
      }
      const env = {
        CLAUDE_PLUGIN_DATA: dataDir,
        ACM_DATA_DIR: dataDir,
        CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "acm-hosts-claude-config-")),
        ...testModelEnv,
      };

      const results: ProcessResult[] = [];
      for (const toolName of CODEX_TOOL_NAMES) {
        results.push(
          await runProcess({
            command: process.execPath,
            args: [join(process.cwd(), "dist", "hooks.js")],
            env,
            stdinText: JSON.stringify({
              hook_event_name: "PostToolUse",
              cwd: CWD,
              session_id: SESSION,
              tool_name: toolName,
              tool_input: { not_applicable: [memoryId] },
            }),
            timeoutMs: HOOK_KILL_MS,
          }),
        );
      }

      expect(results).toEqual(CODEX_TOOL_NAMES.map(() => ({ code: 0, stdout: "", stderr: "" })));
      const opened = openDatabase(config);
      try {
        expect(
          opened.db
            .prepare(
              `SELECT (SELECT count(*) FROM receipt_sessions) AS receipts,
                      (SELECT count(*) FROM verdicts) AS verdicts,
                      (SELECT count(*) FROM session_signals WHERE closed_at IS NULL) AS openSignals`,
            )
            .get() as StoreCounts,
        ).toEqual({ receipts: 0, verdicts: 0, openSignals: 1 });
      } finally {
        opened.db.close();
      }
    },
    SPAWNED_TIMEOUT_MS,
  );
});
