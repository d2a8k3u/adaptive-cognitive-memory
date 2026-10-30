import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import { codexRequest, patchedFiles } from "../src/hosts/codex";
import { type HookReply, hostOutput } from "../src/hosts/output";
import type { EngineAction, HookRequest } from "../src/hosts/request";

const SESSION = "019a2c3e-7a1b-7c3d-9e4f-5a6b7c8d9e0f";
const CWD = "/repo";
const CODEX_FIELDS = {
  session_id: SESSION,
  cwd: CWD,
  model: "gpt-5-codex",
  transcript_path: null,
  permission_mode: "default",
  turn_id: "019a2c3f-0b1c-7d2e-8f30-4a5b6c7d8e9f",
};
const BASH_INPUT = { command: "npm test" };
const UPDATE_PATCH = [
  "*** Begin Patch",
  "*** Update File: src/a.ts",
  "@@",
  "-a",
  "+b",
  "*** End Patch",
];

const SCHEMA_DIR = join(process.cwd(), "tests", "fixtures", "codex-hooks-schema");
const SCHEMA_FILE_STEMS: Readonly<Record<string, string>> = {
  SessionStart: "session-start",
  Stop: "stop",
};
const ajv = new Ajv();

function codexSchema(event: string): ValidateFunction {
  return ajv.compile(
    JSON.parse(
      readFileSync(
        join(SCHEMA_DIR, `${SCHEMA_FILE_STEMS[event]}.command.output.schema.json`),
        "utf8",
      ),
    ),
  );
}

function projectRequest(event: string, actions: readonly EngineAction[]): HookRequest {
  return { event, scope: "project", sessionId: SESSION, cwd: CWD, actions };
}

function sessionRequest(event: string, actions: readonly EngineAction[]): HookRequest {
  return { event, scope: "session", sessionId: SESSION, cwd: CWD, actions };
}

describe("codexRequest", () => {
  it.each<{ name: string; input: Record<string, unknown>; expected: HookRequest | undefined }>([
    {
      name: "SessionStart from a fork as a fresh start",
      input: { hook_event_name: "SessionStart", source: "fork" },
      expected: projectRequest("SessionStart", [{ kind: "session-start", source: "startup" }]),
    },
    {
      name: "SessionStart on resume with its source",
      input: { hook_event_name: "SessionStart", source: "resume" },
      expected: projectRequest("SessionStart", [{ kind: "session-start", source: "resume" }]),
    },
    {
      name: "UserPromptSubmit to a recall for the trimmed prompt",
      input: { hook_event_name: "UserPromptSubmit", prompt: "  how do we deploy  " },
      expected: projectRequest("UserPromptSubmit", [
        { kind: "prompt", prompt: "how do we deploy" },
      ]),
    },
    {
      name: "PreToolUse on Bash to the command lookup",
      input: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: BASH_INPUT },
      expected: projectRequest("PreToolUse", [
        { kind: "tool-recall", target: { kind: "command", toolInput: BASH_INPUT } },
      ]),
    },
    {
      name: "PreToolUse on apply_patch to the patched files",
      input: {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { command: UPDATE_PATCH.join("\n") },
      },
      expected: projectRequest("PreToolUse", [
        { kind: "tool-recall", target: { kind: "files", paths: ["src/a.ts"] } },
      ]),
    },
    {
      name: "PreToolUse on apply_patch without a patch text to no target",
      input: {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { command: 7 },
      },
      expected: projectRequest("PreToolUse", [{ kind: "tool-recall", target: { kind: "none" } }]),
    },
    {
      name: "PreToolUse on another tool to no target",
      input: { hook_event_name: "PreToolUse", tool_name: "view_image", tool_input: { path: "/a" } },
      expected: projectRequest("PreToolUse", [{ kind: "tool-recall", target: { kind: "none" } }]),
    },
    {
      name: "PostToolUse on the Codex memory_feedback to a receipt",
      input: {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__memory__memory_feedback",
        tool_input: { used: ["m"] },
      },
      expected: sessionRequest("PostToolUse", [
        { kind: "feedback-receipt", toolInput: { used: ["m"] } },
      ]),
    },
    {
      name: "PostToolUse on the Codex memory_store to closing the session signals",
      input: { hook_event_name: "PostToolUse", tool_name: "mcp__memory__memory_store" },
      expected: sessionRequest("PostToolUse", [{ kind: "store-receipt" }]),
    },
    {
      name: "PostToolUse on the Codex memory_update to closing the session signals",
      input: { hook_event_name: "PostToolUse", tool_name: "mcp__memory__memory_update" },
      expected: sessionRequest("PostToolUse", [{ kind: "store-receipt" }]),
    },
    {
      name: "PostToolUse on the Claude-form memory_feedback to nothing",
      input: {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__plugin_adaptive-cognitive-memory_memory__memory_feedback",
        tool_input: { used: ["m"] },
      },
      expected: sessionRequest("PostToolUse", []),
    },
    {
      name: "PostToolUse on Bash to nothing, since its outcome is unknown",
      input: {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: BASH_INPUT,
        tool_response: JSON.stringify("1 failed"),
      },
      expected: sessionRequest("PostToolUse", []),
    },
    {
      name: "PostToolUseFailure to no request, as Codex never sends it",
      input: { hook_event_name: "PostToolUseFailure", tool_name: "Bash", error: "Exit code 1" },
      expected: undefined,
    },
    {
      name: "Stop while a stop hook is active",
      input: { hook_event_name: "Stop", stop_hook_active: true },
      expected: sessionRequest("Stop", [{ kind: "stop", stopHookActive: true }]),
    },
  ])("maps $name", ({ input, expected }) => {
    expect(codexRequest({ ...CODEX_FIELDS, ...input })).toEqual(expected);
  });

  it("narrows a malformed session id and cwd to absent", () => {
    expect(codexRequest({ hook_event_name: "Stop", session_id: 7, cwd: ["/repo"] })).toEqual({
      event: "Stop",
      scope: "session",
      sessionId: undefined,
      cwd: undefined,
      actions: [{ kind: "stop", stopHookActive: false }],
    });
  });
});

describe("patchedFiles", () => {
  it.each([
    {
      name: "an added file",
      lines: ["*** Begin Patch", "*** Add File: docs/notes.md", "+# Notes", "*** End Patch"],
      paths: ["docs/notes.md"],
    },
    { name: "an updated file", lines: UPDATE_PATCH, paths: ["src/a.ts"] },
    {
      name: "a deleted file",
      lines: ["*** Begin Patch", "*** Delete File: src/legacy.ts", "*** End Patch"],
      paths: ["src/legacy.ts"],
    },
    {
      name: "a moved file, from and to",
      lines: [
        "*** Begin Patch",
        "*** Update File: src/old.ts",
        "*** Move to: src/new.ts",
        "@@",
        "-a",
        "+b",
        "*** End Patch",
      ],
      paths: ["src/old.ts", "src/new.ts"],
    },
  ])("takes the path of $name", ({ lines, paths }) => {
    expect(patchedFiles(lines.join("\n"))).toEqual(paths);
  });

  it("takes the path of a patch written with CRLF line ends without the carriage return", () => {
    expect(patchedFiles(UPDATE_PATCH.join("\r\n"))).toEqual(["src/a.ts"]);
  });

  it("takes every file of a multi-file patch once, in order, ignoring marker text inside hunks", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/b.ts",
      "+*** Delete File: src/not-a-marker.ts",
      "*** Update File: src/a.ts",
      "@@",
      " *** Update File: src/context-line.ts",
      "-a",
      "+b",
      "*** Delete File: src/c.ts",
      "*** Update File: src/b.ts",
      "@@",
      "-c",
      "+d",
      "*** End Patch",
    ].join("\n");

    expect(patchedFiles(patch)).toEqual(["src/b.ts", "src/a.ts", "src/c.ts"]);
  });
});

describe("hostOutput on Codex", () => {
  it.each<{ name: string; event: string; replies: HookReply[]; stdout: string | undefined }>([
    {
      name: "blocks a Stop with the checkpoint as the reason",
      event: "Stop",
      replies: [{ context: "store the release freeze" }],
      stdout: '{"decision":"block","reason":"store the release freeze"}',
    },
    {
      name: "prints nothing for a Stop without a checkpoint",
      event: "Stop",
      replies: [{ context: "" }],
      stdout: undefined,
    },
    {
      name: "prints session start recall and its notice in the Claude shape",
      event: "SessionStart",
      replies: [{ context: "<memory>", notice: "store moved" }],
      stdout:
        '{"systemMessage":"store moved","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<memory>"}}',
    },
    {
      name: "prints a session start notice without recall as a system message",
      event: "SessionStart",
      replies: [{ context: "", notice: "store moved" }],
      stdout: '{"systemMessage":"store moved"}',
    },
  ])("$name", ({ event, replies, stdout }) => {
    const printed = hostOutput("codex", event, replies);

    expect(printed).toBe(stdout);
    if (printed !== undefined) {
      const validate = codexSchema(event);
      expect(validate(JSON.parse(printed)), ajv.errorsText(validate.errors)).toBe(true);
    }
  });
});
