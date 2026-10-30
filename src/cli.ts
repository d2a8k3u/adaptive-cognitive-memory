import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type Config, loadConfig } from "./cfg";
import { openDatabase } from "./db/database";
import { embedMissing } from "./db/memories";
import { setRecallEnabled } from "./db/projects";
import { exportSnapshot, importRecords, stampExport } from "./db/transfer";
import { reconcileVecStates } from "./db/transitions";
import { errorMessage, runDoctor } from "./doctor";
import { modelCached, modelCachePath } from "./embeddings";
import { hostProfile, resolveHost } from "./host";
import { resolveProjectId } from "./ids";
import { modelInit } from "./modelinit";
import { disableStatusline, distShim, enableStatusline } from "./statusline";
import {
  ensureDataDir,
  legacyFacts,
  storeConfig,
  storeMissing,
  storeNotice,
  storeState,
} from "./storelocation";
import { type MoveOutcome, moveStore } from "./storemove";
import { exportText, parseImport } from "./transfer";

const USAGE =
  "usage: cli <doctor|model-init|reembed|recall on|recall off|statusline on|statusline off|export <file>|import <file>|store move --from <dir>>";
const REEMBED_BATCH = 32;
const FILE_EXISTS_CODE = "EEXIST";

type Command = (config: Config) => Promise<number> | number;

async function reembed(config: Config): Promise<number> {
  if (!modelCached(config.modelCacheDir)) {
    console.error(
      `embedding model missing at ${modelCachePath(config.modelCacheDir)} — run node dist/cli.js model-init first`,
    );
    return 1;
  }
  const opened = openDatabase(config);
  try {
    if (!opened.vecLoaded) {
      console.error(`sqlite-vec not loaded: ${opened.vecError}`);
      return 1;
    }
    const env = { db: opened.db, vecLoaded: true, modelCacheDir: config.modelCacheDir };
    const reconciled = reconcileVecStates(opened.db);
    let total = 0;
    for (;;) {
      const embedded = await embedMissing(env, REEMBED_BATCH, "all");
      if (embedded === 0) {
        break;
      }
      total += embedded;
    }
    console.log(`${total} memories embedded, ${reconciled} vector states reconciled`);
    return 0;
  } finally {
    opened.db.close();
  }
}

function switchRecall(config: Config, cwd: string, enabled: boolean): number {
  const projectId = resolveProjectId(cwd);
  const opened = openDatabase(config);
  try {
    setRecallEnabled(opened.db, projectId, enabled, new Date().toISOString());
  } finally {
    opened.db.close();
  }
  console.log(`recall ${enabled ? "on" : "off"} for project ${projectId} (${cwd})`);
  return 0;
}

function switchStatusline(config: Config, enabled: boolean): number {
  console.log(
    enabled
      ? enableStatusline(config.dataDir, distShim(), new Date().toISOString())
      : disableStatusline(config.dataDir),
  );
  return 0;
}

function fileExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === FILE_EXISTS_CODE;
}

function exportTo(config: Config, file: string): number {
  const opened = openDatabase(config);
  try {
    const snapshot = exportSnapshot(opened.db);
    try {
      writeFileSync(file, exportText(snapshot), { flag: "wx" });
    } catch (error) {
      if (fileExists(error)) {
        console.error(`refusing to overwrite ${file}: export to a new file`);
        return 1;
      }
      throw error;
    }
    stampExport(opened.db, new Date().toISOString());
    console.log(
      `exported ${snapshot.memories.length} memories, ${snapshot.relations.length} relations, ${snapshot.transitions.length} transitions to ${file}`,
    );
    return 0;
  } finally {
    opened.db.close();
  }
}

function importFrom(config: Config, file: string): number {
  const parsed = parseImport(readFileSync(file, "utf8"));
  if (!parsed.ok) {
    console.error(`nothing imported: ${file} has ${parsed.errors.length} invalid lines`);
    for (const error of parsed.errors) {
      console.error(error);
    }
    return 1;
  }
  const opened = openDatabase(config);
  try {
    const outcome = importRecords(opened.db, parsed.records);
    if (!outcome.ok) {
      console.error(`nothing imported: ${file} conflicts with the database`);
      for (const error of outcome.errors) {
        console.error(error);
      }
      return 1;
    }
    console.log(
      `imported ${outcome.memories.length} memories (${outcome.skipped} already present, skipped), ${outcome.relations.length} relations, ${outcome.transitions.length} transitions; run node dist/cli.js reembed to embed them`,
    );
    return 0;
  } finally {
    opened.db.close();
  }
}

function commandFor(argv: readonly string[], cwd: string): Command | undefined {
  const [command, argument] = argv.slice(2);
  switch (command) {
    case "model-init":
      return modelInit;
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

function doctor(env: NodeJS.ProcessEnv, cwd: string): number {
  const report = runDoctor(env, cwd);
  console.log(JSON.stringify(report, null, 2));
  return report.status === "ok" ? 0 : 1;
}

function moveSource(argv: readonly string[]): string | undefined {
  const [subcommand, flag, from] = argv.slice(3);
  return subcommand === "move" && flag === "--from" && from !== undefined && isAbsolute(from)
    ? from
    : undefined;
}

function reportMove(outcome: MoveOutcome, from: string, dataDir: string): number {
  switch (outcome.kind) {
    case "moved": {
      const rows = outcome.digest.tables.reduce((sum, table) => sum + table.rows, 0);
      console.log(
        `moved the memory store from ${from} to ${dataDir}: ${outcome.digest.tables.length} tables, ${rows} rows verified`,
      );
      if (outcome.statuslineSnippet !== undefined) {
        console.log(
          `statusline: set the Claude Code statusLine command to: ${outcome.statuslineSnippet}`,
        );
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
      console.error(
        `move failed: ${outcome.reason}; the source store is unchanged and ${dataDir} was not used`,
      );
      return 1;
  }
}

function moveCommand(from: string, env: NodeJS.ProcessEnv): number {
  const config = loadConfig(env);
  return reportMove(moveStore(from, config, new Date().toISOString()), from, config.dataDir);
}

async function onResolvedStore(command: Command, env: NodeJS.ProcessEnv): Promise<number> {
  const profile = hostProfile(resolveHost(env));
  const config = loadConfig(env);
  const state = storeState(config.dataDir, legacyFacts(profile, env, config.dataDir));
  if (storeMissing(state)) {
    console.error(storeNotice(state, config.dataDir));
    return 1;
  }
  if (state.kind === "shared") {
    ensureDataDir(config);
  }
  return command(storeConfig(config, state, env));
}

async function reportingFailure(run: () => Promise<number> | number): Promise<number> {
  try {
    return await run();
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }
}

export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<number> {
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
