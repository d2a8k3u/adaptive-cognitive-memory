"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.planMove = planMove;
exports.hasRoom = hasRoom;
exports.moveStore = moveStore;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const cfg_1 = require("./cfg");
const database_1 = require("./db/database");
const digest_1 = require("./db/digest");
const statusline_1 = require("./statusline");
const storelocation_1 = require("./storelocation");
const STAGING_DIR = ".moving";
const JOURNAL_FILE = "journal.json";
const JOURNAL_VERSION = 1;
const WAL_SUFFIX = "-wal";
const AUXILIARY_DIRS = ["models", "statusline"];
const BUSY_TIMEOUT_MS = 5000;
const FILE_EXISTS_CODE = "EEXIST";
const INTEGRITY_OK = "ok";
const INTEGRITY_DATABASE_HEADER = "***";
const CLONE_NEW_FILE = node_fs_1.constants.COPYFILE_FICLONE | node_fs_1.constants.COPYFILE_EXCL;
function refusal(reason) {
    return { kind: "refuse", reason };
}
function planMove(facts) {
    if (facts.sameDir) {
        return refusal("source and destination are the same directory");
    }
    if (!facts.sourceHasDb) {
        return refusal(`no ${cfg_1.DB_FILENAME} in ${facts.sourceRealPath}`);
    }
    if (facts.sourceMovedTo !== undefined) {
        return facts.destHasDb
            ? { kind: "already-moved", movedTo: facts.sourceMovedTo }
            : refusal(`source is marked as moved to ${facts.sourceMovedTo}, but ${facts.dataDir} has no store`);
    }
    if (facts.destHasDb) {
        return facts.journalSource === facts.sourceRealPath
            ? { kind: "resume-publish" }
            : refusal(`a store already exists in ${facts.dataDir}; move it aside and run the move again (docs/storage.md)`);
    }
    return { kind: "start" };
}
function hasRoom(freeBytes, neededBytes) {
    return freeBytes >= neededBytes;
}
function refused(reason) {
    return { kind: "refused", reason };
}
function digestTag(digest) {
    return `sha256:${digest.sha256}`;
}
function stagingDir(dataDir) {
    return (0, node_path_1.join)(dataDir, STAGING_DIR);
}
function sourceDbPath(fromDir) {
    return (0, node_path_1.join)(fromDir, cfg_1.DB_FILENAME);
}
function realOrResolved(path) {
    return (0, node_fs_1.existsSync)(path) ? (0, node_fs_1.realpathSync)(path) : (0, node_path_1.resolve)(path);
}
function parsedJson(text) {
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
function journalSourceIn(dataDir) {
    const path = (0, node_path_1.join)(stagingDir(dataDir), JOURNAL_FILE);
    if (!(0, node_fs_1.existsSync)(path)) {
        return undefined;
    }
    const journal = parsedJson((0, node_fs_1.readFileSync)(path, "utf8"));
    if (typeof journal !== "object" || journal === null || !("source" in journal)) {
        return undefined;
    }
    return typeof journal.source === "string" ? journal.source : undefined;
}
function gatherFacts(fromDir, dataDir) {
    const sourceRealPath = realOrResolved(fromDir);
    return {
        dataDir,
        sameDir: sourceRealPath === realOrResolved(dataDir),
        sourceHasDb: (0, node_fs_1.existsSync)(sourceDbPath(fromDir)),
        sourceMovedTo: (0, storelocation_1.movedMarkerTarget)(fromDir),
        destHasDb: (0, node_fs_1.existsSync)((0, node_path_1.join)(dataDir, cfg_1.DB_FILENAME)),
        journalSource: journalSourceIn(dataDir),
        sourceRealPath,
    };
}
function nearestExistingAncestor(path) {
    let current = (0, node_path_1.resolve)(path);
    while (!(0, node_fs_1.existsSync)(current)) {
        current = (0, node_path_1.dirname)(current);
    }
    return current;
}
function sizeOfTree(path) {
    const stats = (0, node_fs_1.statSync)(path);
    if (!stats.isDirectory()) {
        return stats.size;
    }
    return (0, node_fs_1.readdirSync)(path).reduce((sum, name) => sum + sizeOfTree((0, node_path_1.join)(path, name)), 0);
}
function sizeIfPresent(path) {
    return (0, node_fs_1.existsSync)(path) ? sizeOfTree(path) : 0;
}
function auxiliaryToStage(fromDir, dataDir) {
    return AUXILIARY_DIRS.filter((name) => (0, node_fs_1.existsSync)((0, node_path_1.join)(fromDir, name)) && !(0, node_fs_1.existsSync)((0, node_path_1.join)(dataDir, name)));
}
function neededBytes(fromDir, dataDir) {
    const sourceDb = sourceDbPath(fromDir);
    return (sizeOfTree(sourceDb) +
        sizeIfPresent(`${sourceDb}${WAL_SUFFIX}`) +
        auxiliaryToStage(fromDir, dataDir).reduce((sum, name) => sum + sizeOfTree((0, node_path_1.join)(fromDir, name)), 0));
}
function freeBytesBelow(dataDir) {
    const stats = (0, node_fs_1.statfsSync)(nearestExistingAncestor(dataDir));
    return stats.bsize * stats.bavail;
}
function stageAuxiliary(fromDir, config) {
    const needed = neededBytes(fromDir, config.dataDir);
    const free = freeBytesBelow(config.dataDir);
    if (!hasRoom(free, needed)) {
        return refused(`insufficient space in ${config.dataDir}: ${needed} bytes needed, ${free} bytes free`);
    }
    (0, storelocation_1.ensureDataDir)(config);
    const staging = stagingDir(config.dataDir);
    (0, node_fs_1.rmSync)(staging, { recursive: true, force: true });
    (0, node_fs_1.mkdirSync)(staging);
    for (const name of auxiliaryToStage(fromDir, config.dataDir)) {
        (0, node_fs_1.cpSync)((0, node_path_1.join)(fromDir, name), (0, node_path_1.join)(staging, name), {
            recursive: true,
            mode: node_fs_1.constants.COPYFILE_FICLONE,
        });
    }
    return undefined;
}
function lockSource(sourceDb) {
    const anchor = new better_sqlite3_1.default(sourceDb, { readonly: true });
    const writer = new better_sqlite3_1.default(sourceDb);
    try {
        anchor.prepare("SELECT count(*) FROM sqlite_schema").get();
        writer.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
        writer.exec("BEGIN IMMEDIATE");
        return { anchor, writer };
    }
    catch (error) {
        writer.close();
        anchor.close();
        if ((0, database_1.isStorageRejection)(error)) {
            return refused(`the source store is busy: another session held its write lock for more than ${BUSY_TIMEOUT_MS} ms`);
        }
        throw error;
    }
}
function releaseSource(lock) {
    if (lock.writer.inTransaction) {
        lock.writer.exec("ROLLBACK");
    }
    lock.writer.close();
    lock.anchor.close();
}
function copyDatabase(sourceDb, staging) {
    (0, node_fs_1.copyFileSync)(sourceDb, (0, node_path_1.join)(staging, cfg_1.DB_FILENAME), CLONE_NEW_FILE);
    const wal = `${sourceDb}${WAL_SUFFIX}`;
    if ((0, node_fs_1.existsSync)(wal)) {
        (0, node_fs_1.copyFileSync)(wal, (0, node_path_1.join)(staging, `${cfg_1.DB_FILENAME}${WAL_SUFFIX}`), CLONE_NEW_FILE);
    }
}
function differingTables(source, copy) {
    const names = new Set([...source.tables, ...copy.tables].map((table) => table.table));
    return [...names]
        .sort()
        .filter((name) => source.tables.find((table) => table.table === name)?.sha256 !==
        copy.tables.find((table) => table.table === name)?.sha256);
}
function firstIntegrityProblem(report) {
    const lines = report.split("\n");
    return lines.find((line) => !line.startsWith(INTEGRITY_DATABASE_HEADER)) ?? report;
}
function checkCopy(writer, copy, fromDir) {
    const integrity = String(copy.pragma("integrity_check", { simple: true }));
    if (integrity !== INTEGRITY_OK) {
        return {
            ok: false,
            reason: `integrity_check of the copy reported: ${firstIntegrityProblem(integrity)}`,
        };
    }
    const source = (0, digest_1.storeDigest)(writer);
    const copied = (0, digest_1.storeDigest)(copy);
    if (source.sha256 !== copied.sha256) {
        return {
            ok: false,
            reason: `the copy of ${fromDir} differs from the source in ${differingTables(source, copied).join(", ")}`,
        };
    }
    return { ok: true, digest: source };
}
function verifyStaging(writer, staging, fromDir) {
    const stagedDb = (0, node_path_1.join)(staging, cfg_1.DB_FILENAME);
    const staged = new better_sqlite3_1.default(stagedDb);
    let check;
    try {
        check = checkCopy(writer, staged, fromDir);
        if (check.ok) {
            staged.pragma("wal_checkpoint(TRUNCATE)");
        }
    }
    finally {
        staged.close();
    }
    if (check.ok && sizeIfPresent(`${stagedDb}${WAL_SUFFIX}`) > 0) {
        throw new Error(`the staged copy ${stagedDb} kept WAL frames after its checkpoint`);
    }
    return check;
}
function verifyPublished(writer, finalDb, fromDir) {
    const published = new better_sqlite3_1.default(finalDb);
    try {
        published.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
        return checkCopy(writer, published, fromDir);
    }
    finally {
        published.close();
    }
}
function writeJournal(staging, sourceRealPath, digest) {
    const journal = {
        version: JOURNAL_VERSION,
        source: sourceRealPath,
        digest: digestTag(digest),
    };
    const path = (0, node_path_1.join)(staging, JOURNAL_FILE);
    const temp = `${path}.${process.pid}.tmp`;
    (0, node_fs_1.writeFileSync)(temp, `${JSON.stringify(journal)}\n`);
    (0, node_fs_1.renameSync)(temp, path);
}
function fileExists(error) {
    return error instanceof Error && "code" in error && error.code === FILE_EXISTS_CODE;
}
function placeAuxiliary(staging, dataDir) {
    for (const name of AUXILIARY_DIRS) {
        const staged = (0, node_path_1.join)(staging, name);
        if ((0, node_fs_1.existsSync)(staged) && !(0, node_fs_1.existsSync)((0, node_path_1.join)(dataDir, name))) {
            (0, node_fs_1.renameSync)(staged, (0, node_path_1.join)(dataDir, name));
        }
    }
}
function publishStore(staging, dataDir) {
    const stagedDb = (0, node_path_1.join)(staging, cfg_1.DB_FILENAME);
    try {
        (0, node_fs_1.linkSync)(stagedDb, (0, node_path_1.join)(dataDir, cfg_1.DB_FILENAME));
    }
    catch (error) {
        if (fileExists(error)) {
            return refused(`a store appeared in ${dataDir} while the move ran; move it aside and run the move again (docs/storage.md)`);
        }
        throw error;
    }
    (0, node_fs_1.unlinkSync)(stagedDb);
    placeAuxiliary(staging, dataDir);
    return undefined;
}
function markSource(run, digest) {
    (0, storelocation_1.writeMovedMarker)(run.fromDir, (0, node_fs_1.realpathSync)(run.config.dataDir), digestTag(digest), run.now);
    run.afterStep("mark-source");
    return { kind: "moved", digest, statuslineSnippet: run.statuslineSnippet };
}
function startUnderLock(lock, run) {
    const { fromDir, config, afterStep } = run;
    const staging = stagingDir(config.dataDir);
    copyDatabase(sourceDbPath(fromDir), staging);
    afterStep("copy-database");
    const verified = verifyStaging(lock.writer, staging, fromDir);
    if (!verified.ok) {
        return { kind: "verification-failed", reason: verified.reason };
    }
    afterStep("verify-staging");
    writeJournal(staging, (0, node_fs_1.realpathSync)(fromDir), verified.digest);
    afterStep("write-journal");
    const occupied = publishStore(staging, config.dataDir);
    if (occupied !== undefined) {
        return occupied;
    }
    afterStep("publish-store");
    return markSource(run, verified.digest);
}
function resumeUnderLock(lock, run) {
    const { fromDir, config, afterStep } = run;
    const verified = verifyPublished(lock.writer, (0, node_path_1.join)(config.dataDir, cfg_1.DB_FILENAME), fromDir);
    if (!verified.ok) {
        return refused(`the store in ${config.dataDir} differs from ${fromDir}`);
    }
    afterStep("verify-staging");
    placeAuxiliary(stagingDir(config.dataDir), config.dataDir);
    afterStep("publish-store");
    return markSource(run, verified.digest);
}
function underLock(lock, run) {
    const plan = planMove(gatherFacts(run.fromDir, run.config.dataDir));
    switch (plan.kind) {
        case "refuse":
            return refused(plan.reason);
        case "already-moved":
            return { kind: "already-moved", movedTo: plan.movedTo };
        case "start":
            return startUnderLock(lock, run);
        case "resume-publish":
            return resumeUnderLock(lock, run);
    }
}
function removeStaging(dataDir) {
    (0, node_fs_1.rmSync)(stagingDir(dataDir), { recursive: true, force: true });
}
function statuslineSnippetFor(fromDir, dataDir) {
    return (0, statusline_1.statuslineEnabled)((0, statusline_1.statuslinePaths)(fromDir))
        ? (0, statusline_1.snippetLine)((0, statusline_1.statuslinePaths)(dataDir).shim)
        : undefined;
}
function moveStore(fromDir, config, now, afterStep = () => { }) {
    const run = {
        fromDir,
        config,
        now,
        statuslineSnippet: statuslineSnippetFor(fromDir, config.dataDir),
        afterStep,
    };
    const precheck = planMove(gatherFacts(fromDir, config.dataDir));
    if (precheck.kind === "refuse") {
        return refused(precheck.reason);
    }
    if (precheck.kind === "already-moved") {
        removeStaging(config.dataDir);
        return { kind: "already-moved", movedTo: precheck.movedTo };
    }
    if (precheck.kind === "start") {
        const noRoom = stageAuxiliary(fromDir, config);
        if (noRoom !== undefined) {
            return noRoom;
        }
        afterStep("stage-auxiliary");
    }
    const lock = lockSource(sourceDbPath(fromDir));
    if ("kind" in lock) {
        return lock;
    }
    let outcome;
    try {
        afterStep("lock-source");
        outcome = underLock(lock, run);
    }
    finally {
        releaseSource(lock);
    }
    afterStep("unlock-source");
    removeStaging(config.dataDir);
    afterStep("remove-staging");
    return outcome;
}
