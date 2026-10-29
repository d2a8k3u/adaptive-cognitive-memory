"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_DOWNLOAD_MODEL = exports.BUDGET_MAX_TOKENS = exports.BUDGET_MIN_TOKENS = exports.DEFAULT_PRETOOL_BUDGET_TOKENS = exports.DEFAULT_BUDGET_TOKENS = exports.DB_FILENAME = exports.SIGNAL_DETAIL_MAX_CHARS = exports.RELATION_TYPE_MAX_CHARS = exports.RELATION_CAP = exports.CONTENT_MAX_CHARS = exports.ABSTRACT_MAX_CHARS = exports.TITLE_MAX_CHARS = exports.EMBED_DEADLINE_MS = exports.EMBED_DIM = exports.MODEL_DOWNLOAD_SIZE = exports.MODEL_PREFIXES = exports.MODEL_POOLING = exports.MODEL_DTYPE = exports.MODEL_ID = void 0;
exports.loadConfig = loadConfig;
const node_path_1 = require("node:path");
exports.MODEL_ID = "onnx-community/granite-embedding-97m-multilingual-r2-ONNX";
exports.MODEL_DTYPE = "q8";
exports.MODEL_POOLING = "cls";
exports.MODEL_PREFIXES = { query: "", passage: "" };
exports.MODEL_DOWNLOAD_SIZE = "about 120 MB";
exports.EMBED_DIM = 384;
exports.EMBED_DEADLINE_MS = 1500;
const EMBED_DEADLINE_MIN_MS = 1;
const TIMER_MAX_MS = 2_147_483_647;
exports.TITLE_MAX_CHARS = 200;
exports.ABSTRACT_MAX_CHARS = 200;
exports.CONTENT_MAX_CHARS = 32000;
exports.RELATION_CAP = 20;
exports.RELATION_TYPE_MAX_CHARS = 40;
exports.SIGNAL_DETAIL_MAX_CHARS = 200;
exports.DB_FILENAME = "memory.sqlite";
exports.DEFAULT_BUDGET_TOKENS = 1200;
exports.DEFAULT_PRETOOL_BUDGET_TOKENS = 300;
exports.BUDGET_MIN_TOKENS = 100;
exports.BUDGET_MAX_TOKENS = 2375;
exports.DEFAULT_DOWNLOAD_MODEL = true;
const RECALL_BUDGET_OPTION = "CLAUDE_PLUGIN_OPTION_RECALL_BUDGET_TOKENS";
const PRETOOL_BUDGET_OPTION = "CLAUDE_PLUGIN_OPTION_PRETOOL_BUDGET_TOKENS";
const DOWNLOAD_MODEL_OPTION = "CLAUDE_PLUGIN_OPTION_DOWNLOAD_MODEL";
const BOOLEAN_OPTION_VALUES = { true: true, false: false };
function switchFromEnv(env, name, fallback) {
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
const BUDGET_BOUNDS = { min: exports.BUDGET_MIN_TOKENS, max: exports.BUDGET_MAX_TOKENS };
const EMBED_DEADLINE_BOUNDS = { min: EMBED_DEADLINE_MIN_MS, max: TIMER_MAX_MS };
function integerFromEnv(env, name, fallback, bounds) {
    const value = env[name];
    if (value === undefined) {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
        throw new Error(`${name} must be an integer between ${bounds.min} and ${bounds.max}, got: ${value}`);
    }
    return parsed;
}
function loadConfig(env = process.env) {
    const dataDir = env.CLAUDE_PLUGIN_DATA;
    if (!dataDir) {
        throw new Error("CLAUDE_PLUGIN_DATA is required: set the Claude Code plugin data directory");
    }
    return {
        dataDir,
        dbPath: env.ACM_DB_PATH ?? (0, node_path_1.join)(dataDir, exports.DB_FILENAME),
        modelCacheDir: env.ACM_MODEL_CACHE_DIR ?? (0, node_path_1.join)(dataDir, "models"),
        modelRemoteHost: env.ACM_MODEL_REMOTE_HOST,
        autoDownloadModel: switchFromEnv(env, DOWNLOAD_MODEL_OPTION, exports.DEFAULT_DOWNLOAD_MODEL),
        budgetTokens: integerFromEnv(env, RECALL_BUDGET_OPTION, exports.DEFAULT_BUDGET_TOKENS, BUDGET_BOUNDS),
        pretoolBudgetTokens: integerFromEnv(env, PRETOOL_BUDGET_OPTION, exports.DEFAULT_PRETOOL_BUDGET_TOKENS, BUDGET_BOUNDS),
        embedDeadlineMs: integerFromEnv(env, "ACM_EMBED_DEADLINE_MS", exports.EMBED_DEADLINE_MS, EMBED_DEADLINE_BOUNDS),
    };
}
