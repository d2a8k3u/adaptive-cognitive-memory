"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLI_ENTRY = exports.InvalidHostError = exports.CODEX_PLUGIN_ROOT_ENV = exports.HOST_ENV = void 0;
exports.resolveHost = resolveHost;
exports.hostProfile = hostProfile;
const node_path_1 = require("node:path");
const version_1 = require("./version");
exports.HOST_ENV = "ACM_HOST";
exports.CODEX_PLUGIN_ROOT_ENV = "PLUGIN_ROOT";
const CLAUDE_PLUGIN_ROOT_ENV = "CLAUDE_PLUGIN_ROOT";
const HOST_IDS = new Set(["claude", "codex", "opencode"]);
class InvalidHostError extends Error {
}
exports.InvalidHostError = InvalidHostError;
function isHostId(value) {
    return HOST_IDS.has(value);
}
function isCodexPluginHook(env) {
    const pluginRoot = env[exports.CODEX_PLUGIN_ROOT_ENV];
    return (pluginRoot !== undefined && pluginRoot !== "" && pluginRoot === env[CLAUDE_PLUGIN_ROOT_ENV]);
}
function resolveHost(env) {
    const declared = env[exports.HOST_ENV];
    if (declared === undefined) {
        return isCodexPluginHook(env) ? "codex" : "claude";
    }
    if (!isHostId(declared)) {
        throw new InvalidHostError(`${exports.HOST_ENV} must be one of ${[...HOST_IDS].join(", ")}, got: ${JSON.stringify(declared)}`);
    }
    return declared;
}
exports.CLI_ENTRY = (0, node_path_1.join)(version_1.PLUGIN_ROOT, "dist", "cli.js");
const CLAUDE_PROFILE = {
    id: "claude",
    projectDirEnv: "CLAUDE_PROJECT_DIR",
    legacyDataEnv: "CLAUDE_PLUGIN_DATA",
    nativeAutoMemory: true,
    statuslineBadge: true,
    doctorInstruction: "/memory-doctor",
    dependencyFix: `run claude plugin update ${version_1.PLUGIN_INSTALL_ID} to retry Claude Code's dependency install, or npm ci --ignore-scripts in ${version_1.PLUGIN_ROOT}`,
};
function profileWithoutClaudeFeatures(id) {
    return {
        id,
        projectDirEnv: undefined,
        legacyDataEnv: undefined,
        nativeAutoMemory: false,
        statuslineBadge: false,
        doctorInstruction: `${exports.HOST_ENV}=${id} node "${exports.CLI_ENTRY}" doctor`,
        dependencyFix: `npm ci --ignore-scripts --omit=dev in ${version_1.PLUGIN_ROOT}`,
    };
}
const PROFILES = {
    claude: CLAUDE_PROFILE,
    codex: profileWithoutClaudeFeatures("codex"),
    opencode: profileWithoutClaudeFeatures("opencode"),
};
function hostProfile(host) {
    return PROFILES[host];
}
