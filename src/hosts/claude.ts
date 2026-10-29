import type { ToolTarget } from "../keys";
import { hostToolName } from "../toolnames";
import {
  type EngineAction,
  fieldOf,
  type HookRequest,
  type HostInput,
  stringField,
} from "./request";

const BASH_TOOL = "Bash";
const FILE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "Read"]);
const FEEDBACK_TOOL = hostToolName("claude", "memory_feedback");
const STORE_RECEIPT_TOOLS: ReadonlySet<string> = new Set([
  hostToolName("claude", "memory_store"),
  hostToolName("claude", "memory_update"),
]);
const SESSION_EVENTS: ReadonlySet<string> = new Set(["PostToolUse", "Stop"]);

function toolTarget(toolName: string | undefined, toolInput: unknown): ToolTarget {
  if (toolName === BASH_TOOL) {
    return { kind: "command", toolInput };
  }
  const filePath =
    toolName !== undefined && FILE_TOOLS.has(toolName)
      ? stringField(fieldOf(toolInput, "file_path"))
      : undefined;
  return filePath === undefined ? { kind: "none" } : { kind: "files", paths: [filePath] };
}

function launchedInBackground(toolInput: unknown): boolean {
  return fieldOf(toolInput, "run_in_background") === true;
}

function postToolActions(toolName: string | undefined, toolInput: unknown): EngineAction[] {
  if (toolName === FEEDBACK_TOOL) {
    return [{ kind: "feedback-receipt", toolInput }];
  }
  if (toolName !== undefined && STORE_RECEIPT_TOOLS.has(toolName)) {
    return [{ kind: "store-receipt" }];
  }
  if (toolName === BASH_TOOL && !launchedInBackground(toolInput)) {
    return [{ kind: "command-passed", toolInput }];
  }
  return [];
}

function failedToolActions(input: HostInput, toolName: string | undefined): EngineAction[] {
  if (toolName !== BASH_TOOL) {
    return [];
  }
  return [
    {
      kind: "command-failed",
      toolInput: input.tool_input,
      error: stringField(input.error),
      interrupted: input.is_interrupt === true,
    },
  ];
}

function eventActions(event: string, input: HostInput): EngineAction[] | undefined {
  const toolName = stringField(input.tool_name);
  switch (event) {
    case "SessionStart":
      return [{ kind: "session-start", source: stringField(input.source) }];
    case "UserPromptSubmit":
      return [{ kind: "prompt", prompt: stringField(input.prompt)?.trim() ?? "" }];
    case "PreToolUse":
      return [{ kind: "tool-recall", target: toolTarget(toolName, input.tool_input) }];
    case "PostToolUse":
      return postToolActions(toolName, input.tool_input);
    case "PostToolUseFailure":
      return failedToolActions(input, toolName);
    case "Stop":
      return [{ kind: "stop", stopHookActive: input.stop_hook_active === true }];
    default:
      return undefined;
  }
}

export function claudeRequest(input: HostInput): HookRequest | undefined {
  const event = stringField(input.hook_event_name);
  const actions = event === undefined ? undefined : eventActions(event, input);
  if (event === undefined || actions === undefined) {
    return undefined;
  }
  return {
    event,
    scope: SESSION_EVENTS.has(event) ? "session" : "project",
    sessionId: stringField(input.session_id),
    cwd: stringField(input.cwd),
    actions,
  };
}
