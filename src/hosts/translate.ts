import type { HostId } from "../host";
import { claudeRequest } from "./claude";
import { codexRequest } from "./codex";
import type { HookRequest, HostInput } from "./request";

export function hostRequest(host: HostId, input: HostInput): HookRequest | undefined {
  switch (host) {
    case "claude":
      return claudeRequest(input);
    case "codex":
      return codexRequest(input);
    case "opencode":
      return undefined;
  }
}
