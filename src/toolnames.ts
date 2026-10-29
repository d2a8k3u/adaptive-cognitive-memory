import type { HostId } from "./host";
import { PLUGIN_NAME } from "./version";

export const MEMORY_SERVER_KEY = "memory";

export type MemoryToolName =
  | "memory_delete"
  | "memory_doctor"
  | "memory_feedback"
  | "memory_get"
  | "memory_list"
  | "memory_relate"
  | "memory_search"
  | "memory_status"
  | "memory_store"
  | "memory_update";

const QUALIFIED_TOOL_PREFIX: Readonly<Record<HostId, string>> = {
  claude: `mcp__plugin_${PLUGIN_NAME}_${MEMORY_SERVER_KEY}__`,
  codex: `mcp__${MEMORY_SERVER_KEY}__`,
  opencode: `${MEMORY_SERVER_KEY}_`,
};

export function hostToolName(host: HostId, tool: MemoryToolName): string {
  return `${QUALIFIED_TOOL_PREFIX[host]}${tool}`;
}
