"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.claudeConfigDir = claudeConfigDir;
exports.defaultAutoMemoryDirectory = defaultAutoMemoryDirectory;
exports.resolveAutoMemory = resolveAutoMemory;
exports.readAutoMemory = readAutoMemory;
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const DISABLE_ENV = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";
const ENABLED_KEY = "autoMemoryEnabled";
const DIRECTORY_KEY = "autoMemoryDirectory";
const HOME_PREFIX = "~/";
const INDEX_FILE = "MEMORY.md";
const GIT_DIR_NAME = ".git";
const CLAUDE_CONFIG_DIR_NAME = ".claude";
const PROJECT_KEY_UNSAFE_CHARS = /[^A-Za-z0-9]/g;
const PROJECT_KEY_REPLACEMENT = "-";
const UNREADABLE_FILE_CODES = new Set([
    "ENOENT",
    "ENOTDIR",
    "EISDIR",
    "EACCES",
]);
function claudeConfigDir(env) {
    const configured = env.CLAUDE_CONFIG_DIR;
    return configured !== undefined && configured !== ""
        ? configured
        : (0, node_path_1.join)((0, node_os_1.homedir)(), CLAUDE_CONFIG_DIR_NAME);
}
function defaultAutoMemoryDirectory(configDir, facts) {
    const commonDir = facts.gitCommonDir;
    const root = commonDir !== undefined && (0, node_path_1.basename)(commonDir) === GIT_DIR_NAME
        ? (0, node_path_1.dirname)(commonDir)
        : facts.realpath;
    const projectKey = root.replace(PROJECT_KEY_UNSAFE_CHARS, PROJECT_KEY_REPLACEMENT);
    return (0, node_path_1.join)(configDir, "projects", projectKey, "memory");
}
function settingOf(layer, key) {
    const { settings } = layer;
    return typeof settings === "object" && settings !== null && key in settings
        ? settings[key]
        : undefined;
}
function enabledSetting(inputs) {
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
function configuredDirectory(value, homeDir) {
    if (typeof value !== "string") {
        return undefined;
    }
    if (value.startsWith(HOME_PREFIX)) {
        return (0, node_path_1.join)(homeDir, value.slice(HOME_PREFIX.length));
    }
    return (0, node_path_1.isAbsolute)(value) ? value : undefined;
}
function memoryDirectory(inputs) {
    for (const layer of inputs.layers) {
        const directory = configuredDirectory(settingOf(layer, DIRECTORY_KEY), inputs.homeDir);
        if (directory !== undefined) {
            return directory;
        }
    }
    return inputs.defaultDirectory;
}
function resolveAutoMemory(inputs) {
    return { ...enabledSetting(inputs), indexPath: (0, node_path_1.join)(memoryDirectory(inputs), INDEX_FILE) };
}
function unreadableFile(error) {
    return (error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        UNREADABLE_FILE_CODES.has(error.code));
}
function readSettingsLayer(source) {
    try {
        return [{ source, settings: JSON.parse((0, node_fs_1.readFileSync)(source, "utf8")) }];
    }
    catch (error) {
        if (unreadableFile(error) || error instanceof SyntaxError) {
            return [];
        }
        throw error;
    }
}
function readAutoMemory(env, projectDir, facts) {
    const configDir = claudeConfigDir(env);
    const layers = [
        (0, node_path_1.join)(projectDir, ".claude", "settings.local.json"),
        (0, node_path_1.join)(projectDir, ".claude", "settings.json"),
        (0, node_path_1.join)(configDir, "settings.json"),
    ].flatMap(readSettingsLayer);
    return resolveAutoMemory({
        disableEnv: env[DISABLE_ENV],
        layers,
        homeDir: (0, node_os_1.homedir)(),
        defaultDirectory: defaultAutoMemoryDirectory(configDir, facts),
    });
}
