import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ProjectLocation } from "./ids";

export interface SettingsLayer {
  readonly source: string;
  readonly settings: unknown;
}

export interface AutoMemoryInputs {
  readonly disableEnv: string | undefined;
  readonly layers: readonly SettingsLayer[];
  readonly homeDir: string;
  readonly defaultDirectory: string;
}

export interface AutoMemory {
  readonly enabled: boolean;
  readonly decidedBy: string;
  readonly indexPath: string;
}

const DISABLE_ENV = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";
const ENABLED_KEY = "autoMemoryEnabled";
const DIRECTORY_KEY = "autoMemoryDirectory";
const HOME_PREFIX = "~/";
const INDEX_FILE = "MEMORY.md";
const GIT_DIR_NAME = ".git";
const CLAUDE_CONFIG_DIR_NAME = ".claude";
const PROJECT_KEY_UNSAFE_CHARS = /[^A-Za-z0-9]/g;
const PROJECT_KEY_REPLACEMENT = "-";
const UNREADABLE_FILE_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "EACCES",
]);

export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  return configured !== undefined && configured !== ""
    ? configured
    : join(homedir(), CLAUDE_CONFIG_DIR_NAME);
}

export function defaultAutoMemoryDirectory(configDir: string, facts: ProjectLocation): string {
  const commonDir = facts.gitCommonDir;
  const root =
    commonDir !== undefined && basename(commonDir) === GIT_DIR_NAME
      ? dirname(commonDir)
      : facts.realpath;
  const projectKey = root.replace(PROJECT_KEY_UNSAFE_CHARS, PROJECT_KEY_REPLACEMENT);
  return join(configDir, "projects", projectKey, "memory");
}

function settingOf(layer: SettingsLayer, key: string): unknown {
  const { settings } = layer;
  return typeof settings === "object" && settings !== null && key in settings
    ? (settings as Record<string, unknown>)[key]
    : undefined;
}

function enabledSetting(inputs: AutoMemoryInputs): Omit<AutoMemory, "indexPath"> {
  if (inputs.disableEnv === "1" || inputs.disableEnv === "0") {
    return { enabled: inputs.disableEnv === "0", decidedBy: `${DISABLE_ENV}=${inputs.disableEnv}` };
  }
  for (const layer of inputs.layers) {
    const value = settingOf(layer, ENABLED_KEY);
    if (typeof value === "boolean") {
      return { enabled: value, decidedBy: layer.source };
    }
  }
  return { enabled: true, decidedBy: "default" };
}

function configuredDirectory(value: unknown, homeDir: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value.startsWith(HOME_PREFIX)) {
    return join(homeDir, value.slice(HOME_PREFIX.length));
  }
  return isAbsolute(value) ? value : undefined;
}

function memoryDirectory(inputs: AutoMemoryInputs): string {
  for (const layer of inputs.layers) {
    const directory = configuredDirectory(settingOf(layer, DIRECTORY_KEY), inputs.homeDir);
    if (directory !== undefined) {
      return directory;
    }
  }
  return inputs.defaultDirectory;
}

export function resolveAutoMemory(inputs: AutoMemoryInputs): AutoMemory {
  return { ...enabledSetting(inputs), indexPath: join(memoryDirectory(inputs), INDEX_FILE) };
}

function unreadableFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    UNREADABLE_FILE_CODES.has(error.code)
  );
}

function readSettingsLayer(source: string): SettingsLayer[] {
  try {
    return [{ source, settings: JSON.parse(readFileSync(source, "utf8")) }];
  } catch (error) {
    if (unreadableFile(error) || error instanceof SyntaxError) {
      return [];
    }
    throw error;
  }
}

export function readAutoMemory(
  env: NodeJS.ProcessEnv,
  projectDir: string,
  facts: ProjectLocation,
): AutoMemory {
  const configDir = claudeConfigDir(env);
  const layers = [
    join(projectDir, ".claude", "settings.local.json"),
    join(projectDir, ".claude", "settings.json"),
    join(configDir, "settings.json"),
  ].flatMap(readSettingsLayer);
  return resolveAutoMemory({
    disableEnv: env[DISABLE_ENV],
    layers,
    homeDir: homedir(),
    defaultDirectory: defaultAutoMemoryDirectory(configDir, facts),
  });
}
