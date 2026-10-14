"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUDGET_MAX_TOKENS = exports.BUDGET_MIN_TOKENS = exports.DEFAULT_PRETOOL_BUDGET_TOKENS = exports.DEFAULT_BUDGET_TOKENS = exports.DB_FILENAME = exports.SIGNAL_DETAIL_MAX_CHARS = exports.RELATION_TYPE_MAX_CHARS = exports.RELATION_CAP = exports.CONTENT_MAX_CHARS = exports.ABSTRACT_MAX_CHARS = exports.TITLE_MAX_CHARS = exports.EMBED_DEADLINE_MS = exports.EMBED_DIM = exports.MODEL_DTYPE = exports.MODEL_ID = void 0;
exports.loadConfig = loadConfig;
const node_path_1 = require("node:path");
exports.MODEL_ID = "Xenova/multilingual-e5-small";
exports.MODEL_DTYPE = "q8";
exports.EMBED_DIM = 384;
exports.EMBED_DEADLINE_MS = 1500;
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
const RECALL_BUDGET_OPTION = "CLAUDE_PLUGIN_OPTION_RECALL_BUDGET_TOKENS";
const PRETOOL_BUDGET_OPTION = "CLAUDE_PLUGIN_OPTION_PRETOOL_BUDGET_TOKENS";
function budgetFromEnv(env, name, fallback) {
    const value = env[name];
    if (value === undefined) {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < exports.BUDGET_MIN_TOKENS || parsed > exports.BUDGET_MAX_TOKENS) {
        throw new Error(`${name} must be an integer between ${exports.BUDGET_MIN_TOKENS} and ${exports.BUDGET_MAX_TOKENS}, got: ${value}`);
    }
    return parsed;
}
function loadConfig(env = process.env) {
    const pluginData = env.CLAUDE_PLUGIN_DATA;
    if (!pluginData) {
        throw new Error("CLAUDE_PLUGIN_DATA is required: set the Claude Code plugin data directory");
    }
    return {
        pluginData,
        dbPath: env.ACM_DB_PATH ?? (0, node_path_1.join)(pluginData, exports.DB_FILENAME),
        modelCacheDir: env.ACM_MODEL_CACHE_DIR ?? (0, node_path_1.join)(pluginData, "models"),
        budgetTokens: budgetFromEnv(env, RECALL_BUDGET_OPTION, exports.DEFAULT_BUDGET_TOKENS),
        pretoolBudgetTokens: budgetFromEnv(env, PRETOOL_BUDGET_OPTION, exports.DEFAULT_PRETOOL_BUDGET_TOKENS),
    };
}
