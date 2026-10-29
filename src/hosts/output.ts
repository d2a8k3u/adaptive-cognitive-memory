import type { HostId } from "../host";

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

export function hostOutput(
  host: HostId,
  event: string,
  replies: readonly HookReply[],
): string | undefined {
  switch (host) {
    case "claude":
      return claudeOutput(event, replies);
    case "codex":
    case "opencode":
      return undefined;
  }
}
