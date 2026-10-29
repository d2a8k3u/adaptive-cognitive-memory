"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCli = runCli;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const cfg_1 = require("./cfg");
const database_1 = require("./db/database");
const memories_1 = require("./db/memories");
const projects_1 = require("./db/projects");
const transfer_1 = require("./db/transfer");
const transitions_1 = require("./db/transitions");
const doctor_1 = require("./doctor");
const embeddings_1 = require("./embeddings");
const host_1 = require("./host");
const ids_1 = require("./ids");
const modelinit_1 = require("./modelinit");
const statusline_1 = require("./statusline");
const storelocation_1 = require("./storelocation");
const storemove_1 = require("./storemove");
const transfer_2 = require("./transfer");
const USAGE = "usage: cli <doctor|model-init|reembed|recall on|recall off|statusline on|statusline off|export <file>|import <file>|store move --from <dir>>";
const REEMBED_BATCH = 32;
const FILE_EXISTS_CODE = "EEXIST";
async function reembed(config) {
    if (!(0, embeddings_1.modelCached)(config.modelCacheDir)) {
        console.error(`embedding model missing at ${(0, embeddings_1.modelCachePath)(config.modelCacheDir)} — run node dist/cli.js model-init first`);
        return 1;
    }
    const opened = (0, database_1.openDatabase)(config);
    try {
        if (!opened.vecLoaded) {
            console.error(`sqlite-vec not loaded: ${opened.vecError}`);
            return 1;
        }
        const env = { db: opened.db, vecLoaded: true, modelCacheDir: config.modelCacheDir };
        const reconciled = (0, transitions_1.reconcileVecStates)(opened.db);
        let total = 0;
        for (;;) {
            const embedded = await (0, memories_1.embedMissing)(env, REEMBED_BATCH, "all");
            if (embedded === 0) {
                break;
            }
            total += embedded;
        }
        console.log(`${total} memories embedded, ${reconciled} vector states reconciled`);
        return 0;
    }
    finally {
        opened.db.close();
    }
}
function switchRecall(config, cwd, enabled) {
    const projectId = (0, ids_1.resolveProjectId)(cwd);
    const opened = (0, database_1.openDatabase)(config);
    try {
        (0, projects_1.setRecallEnabled)(opened.db, projectId, enabled, new Date().toISOString());
    }
    finally {
        opened.db.close();
    }
    console.log(`recall ${enabled ? "on" : "off"} for project ${projectId} (${cwd})`);
    return 0;
}
function switchStatusline(config, enabled) {
    console.log(enabled
        ? (0, statusline_1.enableStatusline)(config.dataDir, (0, statusline_1.distShim)(), new Date().toISOString())
        : (0, statusline_1.disableStatusline)(config.dataDir));
    return 0;
}
function fileExists(error) {
    return error instanceof Error && "code" in error && error.code === FILE_EXISTS_CODE;
}
function exportTo(config, file) {
    const opened = (0, database_1.openDatabase)(config);
    try {
        const snapshot = (0, transfer_1.exportSnapshot)(opened.db);
        try {
            (0, node_fs_1.writeFileSync)(file, (0, transfer_2.exportText)(snapshot), { flag: "wx" });
        }
        catch (error) {
            if (fileExists(error)) {
                console.error(`refusing to overwrite ${file}: export to a new file`);
                return 1;
            }
            throw error;
        }
        (0, transfer_1.stampExport)(opened.db, new Date().toISOString());
        console.log(`exported ${snapshot.memories.length} memories, ${snapshot.relations.length} relations, ${snapshot.transitions.length} transitions to ${file}`);
        return 0;
    }
    finally {
        opened.db.close();
    }
}
function importFrom(config, file) {
    const parsed = (0, transfer_2.parseImport)((0, node_fs_1.readFileSync)(file, "utf8"));
    if (!parsed.ok) {
        console.error(`nothing imported: ${file} has ${parsed.errors.length} invalid lines`);
        for (const error of parsed.errors) {
            console.error(error);
        }
        return 1;
    }
    const opened = (0, database_1.openDatabase)(config);
    try {
        const outcome = (0, transfer_1.importRecords)(opened.db, parsed.records);
        if (!outcome.ok) {
            console.error(`nothing imported: ${file} conflicts with the database`);
            for (const error of outcome.errors) {
                console.error(error);
            }
            return 1;
        }
        console.log(`imported ${outcome.memories.length} memories (${outcome.skipped} already present, skipped), ${outcome.relations.length} relations, ${outcome.transitions.length} transitions; run node dist/cli.js reembed to embed them`);
        return 0;
    }
    finally {
        opened.db.close();
    }
}
function commandFor(argv, cwd) {
    const [command, argument] = argv.slice(2);
    switch (command) {
        case "model-init":
            return modelinit_1.modelInit;
        case "reembed":
            return reembed;
        case "recall":
            return argument === "on" || argument === "off"
                ? (config) => switchRecall(config, cwd, argument === "on")
                : undefined;
        case "statusline":
            return argument === "on" || argument === "off"
                ? (config) => switchStatusline(config, argument === "on")
                : undefined;
        case "export":
            return argument === undefined ? undefined : (config) => exportTo(config, argument);
        case "import":
            return argument === undefined ? undefined : (config) => importFrom(config, argument);
        default:
            return undefined;
    }
}
function doctor(env, cwd) {
    const report = (0, doctor_1.runDoctor)(env, cwd);
    console.log(JSON.stringify(report, null, 2));
    return report.status === "ok" ? 0 : 1;
}
function moveSource(argv) {
    const [subcommand, flag, from] = argv.slice(3);
    return subcommand === "move" && flag === "--from" && from !== undefined && (0, node_path_1.isAbsolute)(from)
        ? from
        : undefined;
}
function reportMove(outcome, from, dataDir) {
    switch (outcome.kind) {
        case "moved": {
            const rows = outcome.digest.tables.reduce((sum, table) => sum + table.rows, 0);
            console.log(`moved the memory store from ${from} to ${dataDir}: ${outcome.digest.tables.length} tables, ${rows} rows verified`);
            if (outcome.statuslineSnippet !== undefined) {
                console.log(`statusline: set the Claude Code statusLine command to: ${outcome.statuslineSnippet}`);
            }
            return 0;
        }
        case "already-moved":
            console.log(`the memory store was already moved from ${from} to ${outcome.movedTo}`);
            return 0;
        case "refused":
            console.error(`move refused: ${outcome.reason}; the source store is unchanged`);
            return 1;
        case "verification-failed":
            console.error(`move failed: ${outcome.reason}; the source store is unchanged and ${dataDir} was not used`);
            return 1;
    }
}
function moveCommand(from, env) {
    const config = (0, cfg_1.loadConfig)(env);
    return reportMove((0, storemove_1.moveStore)(from, config, new Date().toISOString()), from, config.dataDir);
}
async function onResolvedStore(command, env) {
    const profile = (0, host_1.hostProfile)((0, host_1.resolveHost)(env));
    const config = (0, cfg_1.loadConfig)(env);
    const state = (0, storelocation_1.storeState)(config.dataDir, (0, storelocation_1.legacyFacts)(profile, env, config.dataDir));
    if ((0, storelocation_1.storeMissing)(state)) {
        console.error((0, storelocation_1.storeNotice)(state, config.dataDir));
        return 1;
    }
    if (state.kind === "shared") {
        (0, storelocation_1.ensureDataDir)(config);
    }
    return command((0, storelocation_1.storeConfig)(config, state, env));
}
async function reportingFailure(run) {
    try {
        return await run();
    }
    catch (error) {
        console.error((0, doctor_1.errorMessage)(error));
        return 1;
    }
}
async function runCli(argv, env = process.env, cwd = process.cwd()) {
    if (argv[2] === "doctor") {
        return reportingFailure(() => doctor(env, cwd));
    }
    if (argv[2] === "store") {
        const from = moveSource(argv);
        if (from === undefined) {
            console.error(USAGE);
            return 2;
        }
        return reportingFailure(() => moveCommand(from, env));
    }
    const command = commandFor(argv, cwd);
    if (command === undefined) {
        console.error(USAGE);
        return 2;
    }
    return reportingFailure(() => onResolvedStore(command, env));
}
if (require.main === module) {
    void runCli(process.argv, process.env).then((code) => {
        process.exitCode = code;
    });
}
