import { PLUGIN_NAME } from "./version";

export const MEMORY_SERVER_NAME = "memory";

export function hostToolName(tool: string): string {
  return `mcp__plugin_${PLUGIN_NAME}_${MEMORY_SERVER_NAME}__${tool}`;
}

export const STORE_TOOL = hostToolName("memory_store");
