"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MOVED_MARKER_FILE = void 0;
exports.storeState = storeState;
exports.legacyFacts = legacyFacts;
exports.storeConfig = storeConfig;
exports.storeNotice = storeNotice;
exports.ensureDataDir = ensureDataDir;
exports.sourceMoved = sourceMoved;
exports.writeMovedMarker = writeMovedMarker;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const cfg_1 = require("./cfg");
const host_1 = require("./host");
const version_1 = require("./version");
exports.MOVED_MARKER_FILE = "moved.json";
const MARKER_VERSION = 1;
const SHARED = { kind: "shared" };
function storeState(dataDir, legacy) {
    if (legacy === undefined) {
        return SHARED;
    }
    if (legacy.markerPresent &&
        legacy.movedTo !== undefined &&
        legacy.movedTo !== legacy.dataDirRealPath) {
        return { kind: "moved-elsewhere", movedTo: legacy.movedTo, targetExists: legacy.movedToExists };
    }
    if (legacy.markerPresent) {
        return SHARED;
    }
    if ((0, node_path_1.resolve)(legacy.dir) !== (0, node_path_1.resolve)(dataDir) && legacy.hasDb) {
        return { kind: "legacy", legacyDir: legacy.dir };
    }
    return SHARED;
}
function markerPath(legacyDir) {
    return (0, node_path_1.join)(legacyDir, exports.MOVED_MARKER_FILE);
}
function parsedMarker(text) {
    try {
        return JSON.parse(text);
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
}
function markerTarget(text) {
    const marker = parsedMarker(text);
    if (typeof marker !== "object" || marker === null || !("movedTo" in marker)) {
        return undefined;
    }
    const movedTo = marker.movedTo;
    return typeof movedTo === "string" && (0, node_path_1.isAbsolute)(movedTo) ? movedTo : undefined;
}
function existingRealPath(dir) {
    return (0, node_fs_1.existsSync)(dir) ? (0, node_fs_1.realpathSync)(dir) : undefined;
}
function legacyFacts(profile, env, dataDir) {
    const dir = profile.legacyDataEnv === undefined ? undefined : env[profile.legacyDataEnv];
    if (dir === undefined || dir === "") {
        return undefined;
    }
    const hasDb = (0, node_fs_1.existsSync)((0, node_path_1.join)(dir, cfg_1.DB_FILENAME));
    if (!(0, node_fs_1.existsSync)(markerPath(dir))) {
        return {
            dir,
            hasDb,
            markerPresent: false,
            movedTo: undefined,
            movedToExists: false,
            dataDirRealPath: undefined,
        };
    }
    const movedTo = markerTarget((0, node_fs_1.readFileSync)(markerPath(dir), "utf8"));
    return {
        dir,
        hasDb,
        markerPresent: true,
        movedTo,
        movedToExists: movedTo !== undefined && (0, node_fs_1.existsSync)(movedTo),
        dataDirRealPath: existingRealPath(dataDir),
    };
}
function storeDir(state) {
    switch (state.kind) {
        case "shared":
            return undefined;
        case "legacy":
            return state.legacyDir;
        case "moved-elsewhere":
            return state.targetExists ? state.movedTo : undefined;
    }
}
function storeConfig(config, state, env) {
    const dir = storeDir(state);
    return dir === undefined ? config : { ...config, ...(0, cfg_1.storePaths)(dir, env) };
}
function storeNotice(state, dataDir) {
    switch (state.kind) {
        case "shared":
            return undefined;
        case "legacy":
            return `${version_1.PLUGIN_NAME} uses the Claude Code store in ${state.legacyDir}; Codex and OpenCode use ${dataDir}. To share one store: with this plugin version installed, quit every Claude Code session, then run from a terminal: ${cfg_1.DATA_DIR_ENV}="${dataDir}" node "${host_1.CLI_ENTRY}" store move --from "${state.legacyDir}"`;
        case "moved-elsewhere":
            return state.targetExists
                ? `${version_1.PLUGIN_NAME}: the Claude Code store was moved to ${state.movedTo}, but ${cfg_1.DATA_DIR_ENV} resolves to ${dataDir}; this session uses ${state.movedTo}. Set ${cfg_1.DATA_DIR_ENV}="${state.movedTo}" for Claude Code, Codex and OpenCode.`
                : `${version_1.PLUGIN_NAME}: the Claude Code store was moved to ${state.movedTo}, which does not exist; memory is off for this session. Set ${cfg_1.DATA_DIR_ENV} to the directory that holds the moved store.`;
    }
}
const OWNER_ONLY_DIR_MODE = 0o700;
function ensureDataDir(config) {
    (0, node_fs_1.mkdirSync)(config.dataDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
}
function sourceMoved(legacyDir) {
    return (0, node_fs_1.existsSync)(markerPath(legacyDir));
}
function writeMovedMarker(legacyDir, dataDirRealPath, digest, now) {
    const marker = {
        version: MARKER_VERSION,
        movedTo: dataDirRealPath,
        movedAt: now,
        digest,
    };
    const staged = `${markerPath(legacyDir)}.${process.pid}.tmp`;
    (0, node_fs_1.writeFileSync)(staged, `${JSON.stringify(marker)}\n`);
    (0, node_fs_1.renameSync)(staged, markerPath(legacyDir));
}
