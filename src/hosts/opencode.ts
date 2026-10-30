import { resolve } from "node:path";
import type { ToolTarget } from "../keys";
import { hostToolName } from "../toolnames";
import {
  type EngineAction,
  fieldOf,
  type HookRequest,
  type HostInput,
  stringField,
} from "./request";

const BASH_TOOL = "bash";
const FILE_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write"]);
const FEEDBACK_TOOL = hostToolName("opencode", "memory_feedback");
const STORE_RECEIPT_TOOLS: ReadonlySet<string> = new Set([
  hostToolName("opencode", "memory_store"),
  hostToolName("opencode", "memory_update"),
]);
const SESSION_EVENTS: ReadonlySet<string> = new Set(["session.idle"]);
const STARTUP_SOURCE = "startup";
const COMPACT_SOURCE = "compact";
const PASSING_EXIT_CODE = 0;

export function bashOutcome(exit: unknown): "failed" | "passed" | "unfinished" {
  if (!Number.isInteger(exit)) {
    return "unfinished";
  }
  return exit === PASSING_EXIT_CODE ? "passed" : "failed";
}

function bashActions(input: HostInput): EngineAction[] {
  const toolInput = { command: stringField(fieldOf(input.args, "command")) };
  const recall: EngineAction = { kind: "tool-recall", target: { kind: "command", toolInput } };
  switch (bashOutcome(input.exit)) {
    case "failed":
      return [
        recall,
        { kind: "command-failed", toolInput, error: stringField(input.output), interrupted: false },
      ];
    case "passed":
      return [recall, { kind: "command-passed", toolInput }];
    case "unfinished":
      return [recall];
  }
}

function fileTarget(args: unknown, cwd: string | undefined): ToolTarget {
  const filePath = stringField(fieldOf(args, "filePath"));
  if (filePath === undefined) {
    return { kind: "none" };
  }
  return { kind: "files", paths: [cwd === undefined ? filePath : resolve(cwd, filePath)] };
}

function toolActions(input: HostInput, cwd: string | undefined): EngineAction[] | undefined {
  const tool = stringField(input.tool);
  if (tool === undefined) {
    return undefined;
  }
  if (tool === BASH_TOOL) {
    return bashActions(input);
  }
  if (FILE_TOOLS.has(tool)) {
    return [{ kind: "tool-recall", target: fileTarget(input.args, cwd) }];
  }
  if (tool === FEEDBACK_TOOL) {
    return [{ kind: "feedback-receipt", toolInput: input.args }];
  }
  return STORE_RECEIPT_TOOLS.has(tool) ? [{ kind: "store-receipt" }] : undefined;
}

function promptActions(input: HostInput): EngineAction[] {
  const prompt: EngineAction = { kind: "prompt", prompt: stringField(input.prompt)?.trim() ?? "" };
  return input.session_start === true
    ? [{ kind: "session-start", source: STARTUP_SOURCE }, prompt]
    : [prompt];
}

function eventActions(
  event: string,
  input: HostInput,
  cwd: string | undefined,
): EngineAction[] | undefined {
  switch (event) {
    case "chat.message":
      return promptActions(input);
    case "tool.execute.after":
      return toolActions(input, cwd);
    case "session.idle":
      return [{ kind: "stop", stopHookActive: input.stop_hook_active === true }];
    case "experimental.session.compacting":
      return [{ kind: "session-start", source: COMPACT_SOURCE }];
    default:
      return undefined;
  }
}

export function opencodeRequest(input: HostInput): HookRequest | undefined {
  const event = stringField(input.hook_event_name);
  const cwd = stringField(input.cwd);
  const actions = event === undefined ? undefined : eventActions(event, input, cwd);
  if (event === undefined || actions === undefined) {
    return undefined;
  }
  return {
    event,
    scope: SESSION_EVENTS.has(event) ? "session" : "project",
    sessionId: stringField(input.session_id),
    cwd,
    actions,
  };
}
