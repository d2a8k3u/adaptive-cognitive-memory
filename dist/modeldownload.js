"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOTICE_REASON_MAX_CHARS = exports.STAGING_DIR_PREFIX = exports.DOWNLOAD_LOCK_STALE_MS = void 0;
exports.lockFresh = lockFresh;
exports.modelSetup = modelSetup;
exports.modelNotice = modelNotice;
exports.downloadLockPath = downloadLockPath;
exports.readDownloadLock = readDownloadLock;
exports.readDownloadFailure = readDownloadFailure;
exports.observedModelSetup = observedModelSetup;
exports.recordDownloadFailure = recordDownloadFailure;
exports.acquireDownloadLock = acquireDownloadLock;
exports.downloadModel = downloadModel;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const cfg_1 = require("./cfg");
const embeddings_1 = require("./embeddings");
const version_1 = require("./version");
exports.DOWNLOAD_LOCK_STALE_MS = 15 * 60_000;
exports.STAGING_DIR_PREFIX = ".staging-";
exports.NOTICE_REASON_MAX_CHARS = 120;
const LOCK_FILENAME = "model-download.lock";
const FAILURE_FILENAME = "model-download-failure.json";
const FILE_MISSING_CODE = "ENOENT";
const FILE_EXISTS_CODE = "EEXIST";
function lockFresh(lock, nowMs) {
    return lock !== undefined && nowMs - Date.parse(lock.startedAt) < exports.DOWNLOAD_LOCK_STALE_MS;
}
function modelSetup(facts) {
    if (facts.modelCached) {
        return "ready";
    }
    if (lockFresh(facts.lock, facts.nowMs)) {
        return "downloading";
    }
    return facts.autoDownload ? "start-download" : "download-off";
}
function shortReason(error) {
    const firstLine = error.split("\n", 1)[0] ?? "";
    return firstLine.length > exports.NOTICE_REASON_MAX_CHARS
        ? `${firstLine.slice(0, exports.NOTICE_REASON_MAX_CHARS - 1)}…`
        : firstLine;
}
function downloadingNotice(lastFailure) {
    const progress = `(one time, ${cfg_1.MODEL_DOWNLOAD_SIZE})`;
    return lastFailure === undefined
        ? `${version_1.PLUGIN_NAME} is downloading its embedding model ${progress}; prompt recall starts when it finishes.`
        : `${version_1.PLUGIN_NAME}'s last embedding model download failed (${shortReason(lastFailure.error)}); retrying in the background ${progress}, prompt recall starts when it finishes.`;
}
function downloadOffNotice(lastFailure) {
    const state = lastFailure === undefined
        ? "has no embedding model yet and its automatic download is off"
        : `has no embedding model: the last download failed (${shortReason(lastFailure.error)}) and automatic download is off`;
    return `${version_1.PLUGIN_NAME} ${state}, so prompt recall stays off: run /memory-doctor for the one-time model-init step.`;
}
function modelNotice(setup, lastFailure) {
    switch (setup) {
        case "ready":
            return undefined;
        case "start-download":
        case "downloading":
            return downloadingNotice(lastFailure);
        case "download-off":
            return downloadOffNotice(lastFailure);
    }
}
function isDownloadLock(value) {
    return (typeof value === "object" &&
        value !== null &&
        "pid" in value &&
        typeof value.pid === "number" &&
        "startedAt" in value &&
        typeof value.startedAt === "string");
}
function isDownloadFailure(value) {
    return (typeof value === "object" &&
        value !== null &&
        "failedAt" in value &&
        typeof value.failedAt === "string" &&
        "error" in value &&
        typeof value.error === "string");
}
function failureMessage(error) {
    if (!(error instanceof Error)) {
        return String(error);
    }
    return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}
function hasCode(error, code) {
    return error instanceof Error && "code" in error && error.code === code;
}
function readStateRecord(path, isRecord) {
    let text;
    try {
        text = (0, node_fs_1.readFileSync)(path, "utf8");
    }
    catch (error) {
        if (hasCode(error, FILE_MISSING_CODE)) {
            return undefined;
        }
        throw error;
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
    return isRecord(value) ? value : undefined;
}
function downloadLockPath(pluginData) {
    return (0, node_path_1.join)(pluginData, LOCK_FILENAME);
}
function downloadFailurePath(pluginData) {
    return (0, node_path_1.join)(pluginData, FAILURE_FILENAME);
}
function readDownloadLock(pluginData) {
    return readStateRecord(downloadLockPath(pluginData), isDownloadLock);
}
function readDownloadFailure(pluginData) {
    return readStateRecord(downloadFailurePath(pluginData), isDownloadFailure);
}
function observedModelSetup(config, nowMs) {
    return modelSetup({
        modelCached: (0, embeddings_1.modelCached)(config.modelCacheDir),
        autoDownload: config.autoDownloadModel,
        lock: readDownloadLock(config.pluginData),
        nowMs,
    });
}
function recordDownloadFailure(pluginData, failure) {
    (0, node_fs_1.writeFileSync)(downloadFailurePath(pluginData), JSON.stringify(failure));
}
function createLock(path, lock) {
    try {
        (0, node_fs_1.writeFileSync)(path, JSON.stringify(lock), { flag: "wx" });
        return true;
    }
    catch (error) {
        if (hasCode(error, FILE_EXISTS_CODE)) {
            return false;
        }
        throw error;
    }
}
function acquireDownloadLock(pluginData, now) {
    const path = downloadLockPath(pluginData);
    const lock = { pid: process.pid, startedAt: now.toISOString() };
    if (createLock(path, lock)) {
        return lock;
    }
    if (lockFresh(readDownloadLock(pluginData), now.getTime())) {
        return undefined;
    }
    (0, node_fs_1.rmSync)(path, { force: true });
    return createLock(path, lock) ? lock : undefined;
}
function releaseDownloadLock(pluginData, lock) {
    const current = readDownloadLock(pluginData);
    if (current?.pid === lock.pid && current.startedAt === lock.startedAt) {
        (0, node_fs_1.rmSync)(downloadLockPath(pluginData), { force: true });
    }
}
function removeStagingLeftovers(modelCacheDir) {
    for (const entry of (0, node_fs_1.readdirSync)(modelCacheDir)) {
        if (entry.startsWith(exports.STAGING_DIR_PREFIX)) {
            (0, node_fs_1.rmSync)((0, node_path_1.join)(modelCacheDir, entry), { recursive: true, force: true });
        }
    }
}
function installModel(fetchedPath, modelCacheDir) {
    if ((0, embeddings_1.modelCached)(modelCacheDir)) {
        return "already-cached";
    }
    const target = (0, embeddings_1.modelCachePath)(modelCacheDir);
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(target), { recursive: true });
    (0, node_fs_1.rmSync)(target, { recursive: true, force: true });
    (0, node_fs_1.renameSync)(fetchedPath, target);
    return "downloaded";
}
async function fetchAndInstall(dirs, fetchModel) {
    (0, node_fs_1.mkdirSync)(dirs.modelCacheDir, { recursive: true });
    removeStagingLeftovers(dirs.modelCacheDir);
    const staging = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)(dirs.modelCacheDir, exports.STAGING_DIR_PREFIX));
    try {
        await fetchModel(staging);
        if (!(0, embeddings_1.modelCached)(staging)) {
            throw new Error(`the download finished without the model files at ${(0, embeddings_1.modelCachePath)(staging)}`);
        }
        return installModel((0, embeddings_1.modelCachePath)(staging), dirs.modelCacheDir);
    }
    finally {
        (0, node_fs_1.rmSync)(staging, { recursive: true, force: true });
    }
}
async function downloadModel(dirs, fetchModel, clock) {
    if ((0, embeddings_1.modelCached)(dirs.modelCacheDir)) {
        return "already-cached";
    }
    const lock = acquireDownloadLock(dirs.pluginData, clock());
    if (lock === undefined) {
        return "busy";
    }
    try {
        const outcome = await fetchAndInstall(dirs, fetchModel);
        (0, node_fs_1.rmSync)(downloadFailurePath(dirs.pluginData), { force: true });
        return outcome;
    }
    catch (error) {
        recordDownloadFailure(dirs.pluginData, {
            failedAt: clock().toISOString(),
            error: failureMessage(error),
        });
        throw error;
    }
    finally {
        releaseDownloadLock(dirs.pluginData, lock);
    }
}
