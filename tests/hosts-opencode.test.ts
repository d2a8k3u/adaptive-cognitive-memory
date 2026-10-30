import { describe, expect, it } from "vitest";
import { bashOutcome, opencodeRequest } from "../src/hosts/opencode";
import { type HookReply, hostOutput } from "../src/hosts/output";
import type { EngineAction, HookRequest } from "../src/hosts/request";

const SESSION = "ses_5a1b2c3d4ffeAbCdEfGhIjKlMn";
const CWD = "/repo";

function projectRequest(event: string, actions: readonly EngineAction[]): HookRequest {
  return { event, scope: "project", sessionId: SESSION, cwd: CWD, actions };
}

function toolAfter(
  tool: string,
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { hook_event_name: "tool.execute.after", tool, ...fields };
}

describe("opencodeRequest", () => {
  it.each<{ name: string; input: Record<string, unknown>; expected: HookRequest | undefined }>([
    {
      name: "the first chat message of a session to a session start and the trimmed prompt",
      input: {
        hook_event_name: "chat.message",
        prompt: "  how do we deploy  ",
        session_start: true,
      },
      expected: projectRequest("chat.message", [
        { kind: "session-start", source: "startup" },
        { kind: "prompt", prompt: "how do we deploy" },
      ]),
    },
    {
      name: "a later chat message, with a non-boolean session_start, to the prompt alone",
      input: { hook_event_name: "chat.message", prompt: "how do we deploy", session_start: "true" },
      expected: projectRequest("chat.message", [{ kind: "prompt", prompt: "how do we deploy" }]),
    },
    {
      name: "a bash call that exited non-zero to its recall and a command failure",
      input: toolAfter("bash", {
        args: { command: "npm test", description: "Run tests" },
        exit: 1,
        output: "1 failed",
      }),
      expected: projectRequest("tool.execute.after", [
        { kind: "tool-recall", target: { kind: "command", toolInput: { command: "npm test" } } },
        {
          kind: "command-failed",
          toolInput: { command: "npm test" },
          error: "1 failed",
          interrupted: false,
        },
      ]),
    },
    {
      name: "a bash call that exited 0 to its recall and a command pass",
      input: toolAfter("bash", { args: { command: "npm test" }, exit: 0, output: "ok" }),
      expected: projectRequest("tool.execute.after", [
        { kind: "tool-recall", target: { kind: "command", toolInput: { command: "npm test" } } },
        { kind: "command-passed", toolInput: { command: "npm test" } },
      ]),
    },
    {
      name: "a bash call without an exit code to its recall alone",
      input: toolAfter("bash", { args: { command: "npm test" }, exit: null, output: "" }),
      expected: projectRequest("tool.execute.after", [
        { kind: "tool-recall", target: { kind: "command", toolInput: { command: "npm test" } } },
      ]),
    },
    {
      name: "a read of a relative path to the file resolved against the directory",
      input: toolAfter("read", { args: { filePath: "src/a.ts" } }),
      expected: projectRequest("tool.execute.after", [
        { kind: "tool-recall", target: { kind: "files", paths: ["/repo/src/a.ts"] } },
      ]),
    },
    {
      name: "an edit of an absolute path to that file",
      input: toolAfter("edit", { args: { filePath: "/repo/billing/tax.py", oldString: "a" } }),
      expected: projectRequest("tool.execute.after", [
        { kind: "tool-recall", target: { kind: "files", paths: ["/repo/billing/tax.py"] } },
      ]),
    },
    {
      name: "a write to the file it writes",
      input: toolAfter("write", { args: { filePath: "docs/notes.md", content: "# Notes" } }),
      expected: projectRequest("tool.execute.after", [
        { kind: "tool-recall", target: { kind: "files", paths: ["/repo/docs/notes.md"] } },
      ]),
    },
    {
      name: "a read without a string filePath to no target",
      input: toolAfter("read", { args: { filePath: 7 } }),
      expected: projectRequest("tool.execute.after", [
        { kind: "tool-recall", target: { kind: "none" } },
      ]),
    },
    {
      name: "the OpenCode memory_feedback call to a receipt",
      input: toolAfter("memory_memory_feedback", { args: { used: ["m"] } }),
      expected: projectRequest("tool.execute.after", [
        { kind: "feedback-receipt", toolInput: { used: ["m"] } },
      ]),
    },
    {
      name: "the OpenCode memory_store call to closing the session signals",
      input: toolAfter("memory_memory_store", { args: {} }),
      expected: projectRequest("tool.execute.after", [{ kind: "store-receipt" }]),
    },
    {
      name: "the OpenCode memory_update call to closing the session signals",
      input: toolAfter("memory_memory_update", { args: {} }),
      expected: projectRequest("tool.execute.after", [{ kind: "store-receipt" }]),
    },
    {
      name: "a built-in tool outside the handled set to no request",
      input: toolAfter("glob", { args: { pattern: "**/*.ts" } }),
      expected: undefined,
    },
    {
      name: "a tool of another MCP server to no request",
      input: toolAfter("github_create_issue", { args: { title: "x" } }),
      expected: undefined,
    },
    {
      name: "session.idle while a re-prompt is active to a session-scoped stop",
      input: { hook_event_name: "session.idle", stop_hook_active: true },
      expected: {
        event: "session.idle",
        scope: "session",
        sessionId: SESSION,
        cwd: CWD,
        actions: [{ kind: "stop", stopHookActive: true }],
      },
    },
    {
      name: "compaction to the post-compaction session recall",
      input: { hook_event_name: "experimental.session.compacting" },
      expected: projectRequest("experimental.session.compacting", [
        { kind: "session-start", source: "compact" },
      ]),
    },
    {
      name: "another bus event to no request",
      input: { hook_event_name: "session.created" },
      expected: undefined,
    },
  ])("maps $name", ({ input, expected }) => {
    expect(opencodeRequest({ session_id: SESSION, cwd: CWD, ...input })).toEqual(expected);
  });

  it("narrows a malformed session id and cwd to absent", () => {
    expect(
      opencodeRequest({ hook_event_name: "session.idle", session_id: 7, cwd: ["/repo"] }),
    ).toEqual({
      event: "session.idle",
      scope: "session",
      sessionId: undefined,
      cwd: undefined,
      actions: [{ kind: "stop", stopHookActive: false }],
    });
  });
});

describe("bashOutcome", () => {
  it.each<{ exit: unknown; outcome: ReturnType<typeof bashOutcome> }>([
    { exit: 2, outcome: "failed" },
    { exit: -1, outcome: "failed" },
    { exit: 0, outcome: "passed" },
    { exit: null, outcome: "unfinished" },
    { exit: "1", outcome: "unfinished" },
    { exit: 1.5, outcome: "unfinished" },
  ])("reads exit $exit as $outcome", ({ exit, outcome }) => {
    expect(bashOutcome(exit)).toBe(outcome);
  });
});

describe("hostOutput on OpenCode", () => {
  it.each<{ name: string; replies: HookReply[]; stdout: string | undefined }>([
    {
      name: "prints the notice first, then every non-empty context",
      replies: [{ context: "<start>", notice: "store moved" }, { context: "" }, { context: "<b>" }],
      stdout: '{"context":["store moved","<start>","<b>"]}',
    },
    {
      name: "prints an outage notice without recall alone",
      replies: [{ context: "", notice: "npm dependencies are not installed" }],
      stdout: '{"context":["npm dependencies are not installed"]}',
    },
    {
      name: "prints nothing without a notice or a context",
      replies: [{ context: "" }, { context: "" }],
      stdout: undefined,
    },
  ])("$name", ({ replies, stdout }) => {
    expect(hostOutput("opencode", "tool.execute.after", replies)).toBe(stdout);
  });
});
