import { isRecord, type JsonRecord, parseJsonObject } from "./narrow";

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PreCompact"
  | "Stop";
export type ContextEventName = Exclude<HookEventName, "Stop">;
export type DeliveryChannel = "additional_context" | "plain_stdout" | "blocking_stderr" | "none";

export interface HookProcessOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ContextDelivery {
  readonly channel: DeliveryChannel;
  readonly text: string;
  readonly overflowed: boolean;
}

export interface StopDelivery {
  readonly decision: "block" | undefined;
  readonly reason: string | undefined;
  readonly additionalContext: string | undefined;
}

export const HOST_TEXT_CAP_CHARS = 10_000;
export const HOST_OVERFLOW_PREVIEW_CHARS = 2_000;

const EXIT_SUCCESS = 0;
const EXIT_BLOCKING = 2;
const PLAIN_STDOUT_EVENTS: ReadonlySet<ContextEventName> = new Set([
  "SessionStart",
  "UserPromptSubmit",
]);
const NOTHING_DELIVERED: ContextDelivery = { channel: "none", text: "", overflowed: false };

function delivered(channel: DeliveryChannel, text: string): ContextDelivery {
  const trimmed = text.trim();
  if (trimmed === "") {
    return NOTHING_DELIVERED;
  }
  if (trimmed.length > HOST_TEXT_CAP_CHARS) {
    return { channel, text: trimmed.slice(0, HOST_OVERFLOW_PREVIEW_CHARS), overflowed: true };
  }
  return { channel, text: trimmed, overflowed: false };
}

function additionalContextFor(json: JsonRecord, event: HookEventName): string | undefined {
  const specific = json.hookSpecificOutput;
  if (!isRecord(specific) || specific.hookEventName !== event) {
    return undefined;
  }
  return typeof specific.additionalContext === "string" ? specific.additionalContext : undefined;
}

function deliveredJson(event: ContextEventName, json: JsonRecord): ContextDelivery {
  if (event === "PreCompact") {
    return NOTHING_DELIVERED;
  }
  if (event === "UserPromptSubmit" && json.decision === "block") {
    return NOTHING_DELIVERED;
  }
  const context = additionalContextFor(json, event);
  return context === undefined ? NOTHING_DELIVERED : delivered("additional_context", context);
}

export function deliveredContext(
  event: ContextEventName,
  output: HookProcessOutput,
): ContextDelivery {
  if (output.exitCode === EXIT_BLOCKING && event === "PreToolUse") {
    return delivered("blocking_stderr", output.stderr);
  }
  if (output.exitCode !== EXIT_SUCCESS) {
    return NOTHING_DELIVERED;
  }
  const json = parseJsonObject(output.stdout);
  if (json !== undefined) {
    return deliveredJson(event, json);
  }
  return PLAIN_STDOUT_EVENTS.has(event)
    ? delivered("plain_stdout", output.stdout)
    : NOTHING_DELIVERED;
}

export function stopDelivery(output: HookProcessOutput): StopDelivery {
  if (output.exitCode === EXIT_BLOCKING) {
    return { decision: "block", reason: output.stderr.trim(), additionalContext: undefined };
  }
  const json = output.exitCode === EXIT_SUCCESS ? parseJsonObject(output.stdout) : undefined;
  if (json === undefined) {
    return { decision: undefined, reason: undefined, additionalContext: undefined };
  }
  return {
    decision: json.decision === "block" ? "block" : undefined,
    reason: typeof json.reason === "string" ? json.reason : undefined,
    additionalContext: additionalContextFor(json, "Stop"),
  };
}

export function injectedIds(
  deliveredText: string,
  storedIdByFixtureId: ReadonlyMap<string, string>,
): string[] {
  const fixtureIdByStoredId = new Map<string, string>();
  for (const [fixtureId, storedId] of storedIdByFixtureId) {
    const owner = fixtureIdByStoredId.get(storedId);
    if (owner !== undefined) {
      throw new Error(
        `${owner} and ${fixtureId} both resolved to ${storedId}; attribution would be ambiguous`,
      );
    }
    fixtureIdByStoredId.set(storedId, fixtureId);
  }
  return [...fixtureIdByStoredId]
    .map(([storedId, fixtureId]) => ({ position: deliveredText.indexOf(storedId), fixtureId }))
    .filter((match) => match.position >= 0)
    .sort((a, b) => a.position - b.position)
    .map((match) => match.fixtureId);
}
