import type { HostId } from "../host";

const STOP_EVENT = "Stop";

export interface HookReply {
  readonly context: string;
  readonly notice?: string;
}

function claudeOutput(event: string, replies: readonly HookReply[]): string | undefined {
  if (replies.length > 1) {
    throw new Error(`a Claude ${event} hook prints one reply, got ${replies.length}`);
  }
  const [reply] = replies;
  if (reply === undefined) {
    return undefined;
  }
  const output = {
    ...(reply.notice === undefined ? {} : { systemMessage: reply.notice }),
    ...(reply.context === ""
      ? {}
      : { hookSpecificOutput: { hookEventName: event, additionalContext: reply.context } }),
  };
  return Object.keys(output).length === 0 ? undefined : JSON.stringify(output);
}

function codexStopOutput(replies: readonly HookReply[]): string | undefined {
  const reason = replies
    .map(({ context }) => context)
    .filter((context) => context !== "")
    .join("\n");
  return reason === "" ? undefined : JSON.stringify({ decision: "block", reason });
}

function codexOutput(event: string, replies: readonly HookReply[]): string | undefined {
  return event === STOP_EVENT ? codexStopOutput(replies) : claudeOutput(event, replies);
}

export function hostOutput(
  host: HostId,
  event: string,
  replies: readonly HookReply[],
): string | undefined {
  switch (host) {
    case "claude":
      return claudeOutput(event, replies);
    case "codex":
      return codexOutput(event, replies);
    case "opencode":
      return undefined;
  }
}
