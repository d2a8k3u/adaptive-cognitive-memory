"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorMessage = errorMessage;
exports.autoMemoryCheck = autoMemoryCheck;
exports.dataRetentionCheck = dataRetentionCheck;
exports.runDoctor = runDoctor;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const automemory_1 = require("./automemory");
const calibration_1 = require("./calibration");
const cfg_1 = require("./cfg");
const database_1 = require("./db/database");
const health_1 = require("./db/health");
const memories_1 = require("./db/memories");
const schema_1 = require("./db/schema");
const transfer_1 = require("./db/transfer");
const transitions_1 = require("./db/transitions");
const embeddings_1 = require("./embeddings");
const ids_1 = require("./ids");
const modeldownload_1 = require("./modeldownload");
const outage_1 = require("./outage");
const retention_1 = require("./retention");
const version_1 = require("./version");
const NODE_MIN_MAJOR = 22;
const EXPORT_STALE_AFTER_DAYS = 30;
const PLUGIN_DATA_FIX = "set CLAUDE_PLUGIN_DATA to a writable directory";
const DB_FIX = "make the plugin data directory writable, or restore a backup / delete the database file to start fresh; a newer schema needs a plugin update";
const VEC_FIX = "reinstall plugin dependencies (npm ci) to restore the sqlite-vec build for this platform";
const MODEL_FIX = "run node dist/cli.js model-init to cache the embedding model";
const MODEL_DOWNLOADING_FIX = `wait for the download to finish, then run the doctor again; a download that has not finished within ${modeldownload_1.DOWNLOAD_LOCK_STALE_MS / 60_000} minutes is retried by the next session start or by node dist/cli.js model-init`;
const EMBEDDING_TIMEOUT_FIX = "the next prompt retries the embedding; if timeouts persist, free CPU for the hooks or run node dist/cli.js model-init to restore the model files";
const UNEMBEDDED_FIX = "restore the model (model-init) and sqlite-vec, then run node dist/cli.js reembed";
const VEC_STATE_FIX = "restore sqlite-vec, then run node dist/cli.js reembed or restart the session's memory server";
const FTS_FIX = "restore a backup or delete the database file to start fresh";
const PROJECT_IDENTITY_FIX = "make the project directory readable and git answer git rev-parse --git-common-dir within 2 s there";
const AUTO_MEMORY_FIX = 'to make this plugin the only durable memory, set "autoMemoryEnabled": false in .claude/settings.json (this project) or ~/.claude/settings.json (every project)';
const RETENTION_FIX = `back up with node "${version_1.PLUGIN_ROOT}/dist/cli.js" export <file>, and uninstall with claude plugin uninstall ${version_1.PLUGIN_NAME} --keep-data so the database survives`;
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function rated(name, verdict, fix) {
    return {
        name,
        status: verdict.status,
        ok: verdict.status !== "fail",
        detail: verdict.detail,
        fix: verdict.status === "ok" ? "" : fix,
    };
}
function passOrFail(ok, detail) {
    return { status: ok ? "ok" : "fail", detail };
}
function failed(name, detail, fix) {
    return rated(name, { status: "fail", detail }, fix);
}
function asCheck(name, fix, probe) {
    try {
        return rated(name, probe(), fix);
    }
    catch (error) {
        return failed(name, errorMessage(error), fix);
    }
}
function checkNode() {
    const major = Number(process.versions.node.split(".")[0] ?? "");
    return rated("node", passOrFail(major >= NODE_MIN_MAJOR, `node ${process.versions.node} at ${process.execPath}`), `install node >= ${NODE_MIN_MAJOR}`);
}
function checkNativeModule() {
    return asCheck("native_module", outage_1.NATIVE_MODULE_FIX, () => {
        (0, database_1.probeNativeModule)();
        return {
            status: "ok",
            detail: `better-sqlite3 loaded under node ${process.versions.node} (ABI ${process.versions.modules})`,
        };
    });
}
function checkPluginData(config) {
    const probePath = (0, node_path_1.join)(config.pluginData, ".acm-doctor-probe");
    try {
        (0, node_fs_1.writeFileSync)(probePath, "probe");
    }
    catch (error) {
        return failed("plugin_data", `${config.pluginData}: ${errorMessage(error)}`, PLUGIN_DATA_FIX);
    }
    finally {
        (0, node_fs_1.rmSync)(probePath, { force: true });
    }
    return rated("plugin_data", passOrFail(true, `${config.pluginData} writable`), PLUGIN_DATA_FIX);
}
function checkDatabase(opened, openDetail, dbPath) {
    if (!opened) {
        return failed("database", openDetail, DB_FIX);
    }
    return asCheck("database", DB_FIX, () => {
        const version = opened.db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get();
        const quick = opened.db.pragma("quick_check");
        const ok = version?.value === String(schema_1.SCHEMA_VERSION) &&
            quick.length > 0 &&
            quick.every((row) => row.quick_check === "ok");
        return passOrFail(ok, `${dbPath} schema_version ${version?.value ?? "unset"}, quick_check ${quick.map((row) => row.quick_check).join(", ")}`);
    });
}
function checkVec(opened, openDetail) {
    if (!opened) {
        return failed("vec", openDetail, VEC_FIX);
    }
    return opened.vecLoaded
        ? rated("vec", passOrFail(true, "sqlite-vec loaded"), VEC_FIX)
        : failed("vec", `sqlite-vec not loaded — vector search unavailable: ${opened.vecError}`, VEC_FIX);
}
function missingModelCheck(pluginData, path) {
    const lock = (0, modeldownload_1.readDownloadLock)(pluginData);
    if ((0, modeldownload_1.lockFresh)(lock, Date.now())) {
        return rated("model", {
            status: "warn",
            detail: `model missing at ${path}; downloading since ${lock.startedAt} (pid ${lock.pid})`,
        }, MODEL_DOWNLOADING_FIX);
    }
    const failure = (0, modeldownload_1.readDownloadFailure)(pluginData);
    const cause = failure === undefined
        ? ""
        : `; the last download failed at ${failure.failedAt}: ${failure.error}`;
    return failed("model", `model missing at ${path}${cause}`, MODEL_FIX);
}
function checkModel(config, opened) {
    if (!config) {
        return failed("model", "skipped: CLAUDE_PLUGIN_DATA not resolved", MODEL_FIX);
    }
    const path = (0, embeddings_1.modelCachePath)(config.modelCacheDir);
    if (!(0, embeddings_1.modelCached)(config.modelCacheDir)) {
        try {
            return missingModelCheck(config.pluginData, path);
        }
        catch (error) {
            return failed("model", `model missing at ${path}; ${errorMessage(error)}`, MODEL_FIX);
        }
    }
    return asCheck("model", EMBEDDING_TIMEOUT_FIX, () => {
        const timedOutAt = opened === undefined ? undefined : (0, health_1.lastEmbeddingTimeout)(opened.db);
        return timedOutAt === undefined
            ? passOrFail(true, `model cached at ${path}`)
            : {
                status: "warn",
                detail: `model cached at ${path}, but the last prompt's query embedding at ${timedOutAt} exceeded the ${config.embedDeadlineMs} ms deadline, so recall fell back to keyword search`,
            };
    });
}
function dbDependentCheck(name, fix, opened, openDetail, probe) {
    if (!opened) {
        return failed(name, openDetail, fix);
    }
    return asCheck(name, fix, () => probe(opened.db, opened.vecLoaded));
}
function checkUnembedded(opened, openDetail) {
    return dbDependentCheck("unembedded", UNEMBEDDED_FIX, opened, openDetail, (db, vecLoaded) => {
        if (!vecLoaded) {
            return passOrFail(false, "cannot count: sqlite-vec not loaded");
        }
        const count = (0, memories_1.unembeddedActiveCount)(db);
        if (count === 0) {
            return passOrFail(true, "all memories have embeddings");
        }
        const failure = (0, health_1.lastBackfillFailure)(db);
        const cause = failure === undefined ? "" : `; the start-up backfill failed ${failure}`;
        return passOrFail(false, `${count} active memories without embeddings${cause}`);
    });
}
function checkVecState(opened, openDetail) {
    return dbDependentCheck("vec_state", VEC_STATE_FIX, opened, openDetail, (db, vecLoaded) => {
        if (!vecLoaded) {
            return passOrFail(false, "cannot compare: sqlite-vec not loaded");
        }
        const count = (0, transitions_1.driftedVecStateCount)(db);
        return passOrFail(count === 0, count === 0
            ? "every vector carries its memory's state"
            : `${count} vectors carry a state other than their memory's, so vector recall misses or wrongly finds them`);
    });
}
function checkFts(opened, openDetail) {
    return dbDependentCheck("fts", FTS_FIX, opened, openDetail, (db) => {
        const row = db
            .prepare(`SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'doctor'`)
            .get();
        return passOrFail(true, `MATCH 'doctor' returned ${row.n} rows`);
    });
}
function checkCalibration() {
    return rated("calibration", passOrFail(true, `gate calibrated for ${calibration_1.CALIBRATED_EMBEDDING.modelId} ${calibration_1.CALIBRATED_EMBEDDING.dtype} by eval run ${calibration_1.CALIBRATION_RUN.runId} (${calibration_1.CALIBRATION_RUN.date})`), "");
}
function autoMemoryCheck(autoMemory) {
    const decided = `as far as the readable settings show (decided by ${autoMemory.decidedBy})`;
    return autoMemory.enabled
        ? rated("auto_memory", {
            status: "warn",
            detail: `native auto memory is on ${decided}; its index ${autoMemory.indexPath} loads into every session beside this plugin's recall`,
        }, AUTO_MEMORY_FIX)
        : rated("auto_memory", passOrFail(true, `native auto memory is off ${decided}`), "");
}
function projectIdentityCheck(facts) {
    const projectId = (0, ids_1.projectIdentity)(facts);
    if (facts.dubiousRepository !== undefined) {
        return rated("project_identity", {
            status: "warn",
            detail: `git refuses the repository at ${facts.dubiousRepository} (dubious ownership), so project ${projectId} is identified by the directory ${facts.realpath} and shares no memories with the repository's other directories`,
        }, `git config --global --add safe.directory "${facts.dubiousRepository}"`);
    }
    const source = facts.gitCommonDir === undefined
        ? `the directory ${facts.realpath}, outside git`
        : `the git repository at ${facts.gitCommonDir}`;
    return rated("project_identity", passOrFail(true, `project ${projectId} is identified by ${source}`), "");
}
function checkProjectIdentity(projectDir) {
    try {
        return projectIdentityCheck((0, ids_1.collectLocationFacts)(projectDir));
    }
    catch (error) {
        return failed("project_identity", errorMessage(error), PROJECT_IDENTITY_FIX);
    }
}
function checkAutoMemory(env, projectDir) {
    try {
        return autoMemoryCheck((0, automemory_1.readAutoMemory)(env, projectDir, (0, ids_1.collectLocationFacts)(projectDir)));
    }
    catch (error) {
        return failed("auto_memory", errorMessage(error), AUTO_MEMORY_FIX);
    }
}
function isInside(root, path) {
    const fromRoot = (0, node_path_1.relative)(root, path);
    return (fromRoot !== "" &&
        fromRoot !== ".." &&
        !fromRoot.startsWith(`..${node_path_1.sep}`) &&
        !(0, node_path_1.isAbsolute)(fromRoot));
}
function retentionVerdict(facts) {
    if (!isInside(facts.pluginDataRoot, facts.dbPath)) {
        return passOrFail(true, `database ${facts.dbPath} lives outside ${facts.pluginDataRoot}; uninstalling the plugin leaves it in place`);
    }
    const atRisk = `database ${facts.dbPath} lives in the plugin data directory, which uninstalling the plugin from its last scope deletes`;
    if (facts.lastExportAt === undefined) {
        return { status: "warn", detail: `${atRisk}; never exported` };
    }
    if (facts.lastExportAt < (0, retention_1.daysBefore)(facts.now, EXPORT_STALE_AFTER_DAYS)) {
        return {
            status: "warn",
            detail: `${atRisk}; last export ${facts.lastExportAt} is older than ${EXPORT_STALE_AFTER_DAYS} days`,
        };
    }
    return passOrFail(true, `${atRisk}; last export ${facts.lastExportAt}`);
}
function dataRetentionCheck(facts) {
    return rated("data_retention", retentionVerdict(facts), RETENTION_FIX);
}
function checkDataRetention(env, config, opened, openDetail) {
    return dbDependentCheck("data_retention", RETENTION_FIX, opened, openDetail, (db) => retentionVerdict({
        dbPath: config?.dbPath ?? "",
        pluginDataRoot: (0, node_path_1.join)((0, automemory_1.claudeConfigDir)(env), "plugins", "data"),
        lastExportAt: (0, transfer_1.lastExportAt)(db),
        now: new Date().toISOString(),
    }));
}
function runDoctor(env, projectDir) {
    const checks = [checkNode(), checkNativeModule()];
    let config;
    try {
        config = (0, cfg_1.loadConfig)(env);
    }
    catch (error) {
        checks.push(failed("plugin_data", errorMessage(error), PLUGIN_DATA_FIX));
    }
    if (config) {
        checks.push(checkPluginData(config));
    }
    let opened;
    let openDetail = "skipped: database not open";
    if (config) {
        try {
            opened = (0, database_1.openDatabase)(config);
        }
        catch (error) {
            openDetail = `${config.dbPath}: ${errorMessage(error)}`;
        }
    }
    try {
        checks.push(checkDatabase(opened, openDetail, config?.dbPath ?? "unset"), checkVec(opened, openDetail), checkModel(config, opened), checkUnembedded(opened, openDetail), checkVecState(opened, openDetail), checkFts(opened, openDetail), checkCalibration(), checkProjectIdentity(projectDir), checkAutoMemory(env, projectDir), checkDataRetention(env, config, opened, openDetail));
    }
    finally {
        opened?.db.close();
    }
    const status = checks.some((check) => check.status === "fail") ? "degraded" : "ok";
    return { status, checks };
}
