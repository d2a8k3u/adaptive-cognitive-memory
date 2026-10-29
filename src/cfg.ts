import { join } from "node:path";

export const MODEL_ID = "onnx-community/granite-embedding-97m-multilingual-r2-ONNX";
export const MODEL_DTYPE = "q8";
export const MODEL_POOLING = "cls";
export const MODEL_PREFIXES = { query: "", passage: "" } as const;
export const MODEL_DOWNLOAD_SIZE = "about 120 MB";
export const EMBED_DIM = 384;
export const EMBED_DEADLINE_MS = 1500;
const EMBED_DEADLINE_MIN_MS = 1;
const TIMER_MAX_MS = 2_147_483_647;
export const TITLE_MAX_CHARS = 200;
export const ABSTRACT_MAX_CHARS = 200;
export const CONTENT_MAX_CHARS = 32000;
export const RELATION_CAP = 20;
export const RELATION_TYPE_MAX_CHARS = 40;
export const SIGNAL_DETAIL_MAX_CHARS = 200;
export const DB_FILENAME = "memory.sqlite";
export const DEFAULT_BUDGET_TOKENS = 1200;
export const DEFAULT_PRETOOL_BUDGET_TOKENS = 300;
export const BUDGET_MIN_TOKENS = 100;
export const BUDGET_MAX_TOKENS = 2375;
export const DEFAULT_DOWNLOAD_MODEL = true;

export interface Config {
  dataDir: string;
  dbPath: string;
  modelCacheDir: string;
  modelRemoteHost: string | undefined;
  autoDownloadModel: boolean;
  budgetTokens: number;
  pretoolBudgetTokens: number;
  embedDeadlineMs: number;
}

const RECALL_BUDGET_OPTION = "CLAUDE_PLUGIN_OPTION_RECALL_BUDGET_TOKENS";
const PRETOOL_BUDGET_OPTION = "CLAUDE_PLUGIN_OPTION_PRETOOL_BUDGET_TOKENS";
const DOWNLOAD_MODEL_OPTION = "CLAUDE_PLUGIN_OPTION_DOWNLOAD_MODEL";
const BOOLEAN_OPTION_VALUES: Readonly<Record<string, boolean>> = { true: true, false: false };

function switchFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = BOOLEAN_OPTION_VALUES[value.toLowerCase()];
  if (parsed === undefined) {
    throw new Error(`${name} must be true or false, got: ${value}`);
  }
  return parsed;
}

interface IntegerBounds {
  readonly min: number;
  readonly max: number;
}

const BUDGET_BOUNDS: IntegerBounds = { min: BUDGET_MIN_TOKENS, max: BUDGET_MAX_TOKENS };
const EMBED_DEADLINE_BOUNDS: IntegerBounds = { min: EMBED_DEADLINE_MIN_MS, max: TIMER_MAX_MS };

function integerFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  bounds: IntegerBounds,
): number {
  const value = env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new Error(
      `${name} must be an integer between ${bounds.min} and ${bounds.max}, got: ${value}`,
    );
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.CLAUDE_PLUGIN_DATA;
  if (!dataDir) {
    throw new Error("CLAUDE_PLUGIN_DATA is required: set the Claude Code plugin data directory");
  }
  return {
    dataDir,
    dbPath: env.ACM_DB_PATH ?? join(dataDir, DB_FILENAME),
    modelCacheDir: env.ACM_MODEL_CACHE_DIR ?? join(dataDir, "models"),
    modelRemoteHost: env.ACM_MODEL_REMOTE_HOST,
    autoDownloadModel: switchFromEnv(env, DOWNLOAD_MODEL_OPTION, DEFAULT_DOWNLOAD_MODEL),
    budgetTokens: integerFromEnv(env, RECALL_BUDGET_OPTION, DEFAULT_BUDGET_TOKENS, BUDGET_BOUNDS),
    pretoolBudgetTokens: integerFromEnv(
      env,
      PRETOOL_BUDGET_OPTION,
      DEFAULT_PRETOOL_BUDGET_TOKENS,
      BUDGET_BOUNDS,
    ),
    embedDeadlineMs: integerFromEnv(
      env,
      "ACM_EMBED_DEADLINE_MS",
      EMBED_DEADLINE_MS,
      EMBED_DEADLINE_BOUNDS,
    ),
  };
}
