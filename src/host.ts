import { join } from "node:path";
import { PLUGIN_INSTALL_ID, PLUGIN_ROOT } from "./version";

export type HostId = "claude" | "codex" | "opencode";
export const HOST_ENV = "ACM_HOST";
export const CODEX_PLUGIN_ROOT_ENV = "PLUGIN_ROOT";
const CLAUDE_PLUGIN_ROOT_ENV = "CLAUDE_PLUGIN_ROOT";
const HOST_IDS: ReadonlySet<string> = new Set<HostId>(["claude", "codex", "opencode"]);

export class InvalidHostError extends Error {}

export interface HostProfile {
  readonly id: HostId;
  readonly projectDirEnv: string | undefined;
  readonly legacyDataEnv: string | undefined;
  readonly nativeAutoMemory: boolean;
  readonly statuslineBadge: boolean;
  readonly doctorInstruction: string;
  readonly dependencyFix: string;
}

function isHostId(value: string): value is HostId {
  return HOST_IDS.has(value);
}

function isCodexPluginHook(env: NodeJS.ProcessEnv): boolean {
  const pluginRoot = env[CODEX_PLUGIN_ROOT_ENV];
  return (
    pluginRoot !== undefined && pluginRoot !== "" && pluginRoot === env[CLAUDE_PLUGIN_ROOT_ENV]
  );
}

export function resolveHost(env: NodeJS.ProcessEnv): HostId {
  const declared = env[HOST_ENV];
  if (declared === undefined) {
    return isCodexPluginHook(env) ? "codex" : "claude";
  }
  if (!isHostId(declared)) {
    throw new InvalidHostError(
      `${HOST_ENV} must be one of ${[...HOST_IDS].join(", ")}, got: ${JSON.stringify(declared)}`,
    );
  }
  return declared;
}

export const CLI_ENTRY = join(PLUGIN_ROOT, "dist", "cli.js");

const CLAUDE_PROFILE: HostProfile = {
  id: "claude",
  projectDirEnv: "CLAUDE_PROJECT_DIR",
  legacyDataEnv: "CLAUDE_PLUGIN_DATA",
  nativeAutoMemory: true,
  statuslineBadge: true,
  doctorInstruction: "/memory-doctor",
  dependencyFix: `run claude plugin update ${PLUGIN_INSTALL_ID} to retry Claude Code's dependency install, or npm ci --ignore-scripts in ${PLUGIN_ROOT}`,
};

function profileWithoutClaudeFeatures(id: Exclude<HostId, "claude">): HostProfile {
  return {
    id,
    projectDirEnv: undefined,
    legacyDataEnv: undefined,
    nativeAutoMemory: false,
    statuslineBadge: false,
    doctorInstruction: `${HOST_ENV}=${id} node "${CLI_ENTRY}" doctor`,
    dependencyFix: `npm ci --ignore-scripts --omit=dev in ${PLUGIN_ROOT}`,
  };
}

const PROFILES: Readonly<Record<HostId, HostProfile>> = {
  claude: CLAUDE_PROFILE,
  codex: profileWithoutClaudeFeatures("codex"),
  opencode: profileWithoutClaudeFeatures("opencode"),
};

export function hostProfile(host: HostId): HostProfile {
  return PROFILES[host];
}
