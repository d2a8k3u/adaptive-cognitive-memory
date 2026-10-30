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
const PATCH_TOOL = "apply_patch";
const FORK_SOURCE = "fork";
const STARTUP_SOURCE = "startup";
const PATCH_FILE_MARKERS = [
  "*** Add File: ",
  "*** Update File: ",
  "*** Delete File: ",
  "*** Move to: ",
] as const;
const TRAILING_CARRIAGE_RETURN = /\r$/;
const FEEDBACK_TOOL = hostToolName("codex", "memory_feedback");
const STORE_RECEIPT_TOOLS: ReadonlySet<string> = new Set([
  hostToolName("codex", "memory_store"),
  hostToolName("codex", "memory_update"),
]);
const SESSION_EVENTS: ReadonlySet<string> = new Set(["PostToolUse", "Stop"]);

function patchedPath(line: string): string | undefined {
  const marker = PATCH_FILE_MARKERS.find((candidate) => line.startsWith(candidate));
  return marker === undefined ? undefined : line.slice(marker.length);
}

export function patchedFiles(patch: string): readonly string[] {
  const paths = patch
    .split("\n")
    .flatMap((line) => patchedPath(line.replace(TRAILING_CARRIAGE_RETURN, "")) ?? []);
  return [...new Set(paths)];
}

function sessionSource(source: string | undefined): string | undefined {
  return source === FORK_SOURCE ? STARTUP_SOURCE : source;
}

function toolTarget(toolName: string | undefined, toolInput: unknown): ToolTarget {
  if (toolName === BASH_TOOL) {
    return { kind: "command", toolInput };
  }
  const patch = toolName === PATCH_TOOL ? stringField(fieldOf(toolInput, "command")) : undefined;
  return patch === undefined ? { kind: "none" } : { kind: "files", paths: patchedFiles(patch) };
}

function postToolActions(toolName: string | undefined, toolInput: unknown): EngineAction[] {
  if (toolName === FEEDBACK_TOOL) {
    return [{ kind: "feedback-receipt", toolInput }];
  }
  if (toolName !== undefined && STORE_RECEIPT_TOOLS.has(toolName)) {
    return [{ kind: "store-receipt" }];
  }
  return [];
}

function eventActions(event: string, input: HostInput): EngineAction[] | undefined {
  const toolName = stringField(input.tool_name);
  switch (event) {
    case "SessionStart":
      return [{ kind: "session-start", source: sessionSource(stringField(input.source)) }];
    case "UserPromptSubmit":
      return [{ kind: "prompt", prompt: stringField(input.prompt)?.trim() ?? "" }];
    case "PreToolUse":
      return [{ kind: "tool-recall", target: toolTarget(toolName, input.tool_input) }];
    case "PostToolUse":
      return postToolActions(toolName, input.tool_input);
    case "Stop":
      return [{ kind: "stop", stopHookActive: input.stop_hook_active === true }];
    default:
      return undefined;
  }
}

export function codexRequest(input: HostInput): HookRequest | undefined {
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
