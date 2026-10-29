import type { HostId } from "../host";
import { claudeRequest } from "./claude";
import type { HookRequest, HostInput } from "./request";

export function hostRequest(host: HostId, input: HostInput): HookRequest | undefined {
  switch (host) {
    case "claude":
      return claudeRequest(input);
    case "codex":
    case "opencode":
      return undefined;
  }
}
