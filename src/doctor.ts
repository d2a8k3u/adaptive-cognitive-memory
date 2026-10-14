import { rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { type AutoMemory, claudeConfigDir, readAutoMemory } from "./automemory";
import { CALIBRATED_EMBEDDING, CALIBRATION_RUN } from "./calibration";
import { type Config, EMBED_DEADLINE_MS, loadConfig } from "./cfg";
import { type Db, type OpenedDb, openDatabase, probeNativeModule } from "./db/database";
import { lastBackfillFailure, lastEmbeddingTimeout } from "./db/health";
import { unembeddedActiveCount } from "./db/memories";
import { SCHEMA_VERSION } from "./db/schema";
import { lastExportAt } from "./db/transfer";
import { driftedVecStateCount } from "./db/transitions";
import { modelCached, modelCachePath } from "./embeddings";
import { collectLocationFacts, type LocationFacts, projectIdentity } from "./ids";
import {
  DOWNLOAD_LOCK_STALE_MS,
  lockFresh,
  readDownloadFailure,
  readDownloadLock,
} from "./modeldownload";
import { NATIVE_MODULE_FIX } from "./outage";
import { daysBefore } from "./retention";
import { PLUGIN_NAME, PLUGIN_ROOT } from "./version";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  ok: boolean;
  detail: string;
  fix: string;
}

export interface DoctorReport {
  status: "ok" | "degraded";
  checks: DoctorCheck[];
}

export interface RetentionFacts {
  readonly dbPath: string;
  readonly pluginDataRoot: string;
  readonly lastExportAt: string | undefined;
  readonly now: string;
}

interface Verdict {
  readonly status: CheckStatus;
  readonly detail: string;
}

const NODE_MIN_MAJOR = 22;
const EXPORT_STALE_AFTER_DAYS = 30;
const PLUGIN_DATA_FIX = "set CLAUDE_PLUGIN_DATA to a writable directory";
const DB_FIX =
  "make the plugin data directory writable, or restore a backup / delete the database file to start fresh; a newer schema needs a plugin update";
const VEC_FIX =
  "reinstall plugin dependencies (npm ci) to restore the sqlite-vec build for this platform";
const MODEL_FIX = "run node dist/cli.js model-init to cache the embedding model";
const MODEL_DOWNLOADING_FIX = `wait for the download to finish, then run the doctor again; a download that has not finished within ${DOWNLOAD_LOCK_STALE_MS / 60_000} minutes is retried by the next session start or by node dist/cli.js model-init`;
const EMBEDDING_TIMEOUT_FIX =
  "the next prompt retries the embedding; if timeouts persist, free CPU for the hooks or run node dist/cli.js model-init to restore the model files";
const UNEMBEDDED_FIX =
  "restore the model (model-init) and sqlite-vec, then run node dist/cli.js reembed";
const VEC_STATE_FIX =
  "restore sqlite-vec, then run node dist/cli.js reembed or restart the session's memory server";
const FTS_FIX = "restore a backup or delete the database file to start fresh";
const PROJECT_IDENTITY_FIX =
  "make the project directory readable and git answer git rev-parse --git-common-dir within 2 s there";
const AUTO_MEMORY_FIX =
  'to make this plugin the only durable memory, set "autoMemoryEnabled": false in .claude/settings.json (this project) or ~/.claude/settings.json (every project)';
const RETENTION_FIX = `back up with node "${PLUGIN_ROOT}/dist/cli.js" export <file>, and uninstall with claude plugin uninstall ${PLUGIN_NAME} --keep-data so the database survives`;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rated(name: string, verdict: Verdict, fix: string): DoctorCheck {
  return {
    name,
    status: verdict.status,
    ok: verdict.status !== "fail",
    detail: verdict.detail,
    fix: verdict.status === "ok" ? "" : fix,
  };
}

function passOrFail(ok: boolean, detail: string): Verdict {
  return { status: ok ? "ok" : "fail", detail };
}

function failed(name: string, detail: string, fix: string): DoctorCheck {
  return rated(name, { status: "fail", detail }, fix);
}

function asCheck(name: string, fix: string, probe: () => Verdict): DoctorCheck {
  try {
    return rated(name, probe(), fix);
  } catch (error) {
    return failed(name, errorMessage(error), fix);
  }
}

function checkNode(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0] ?? "");
  return rated(
    "node",
    passOrFail(major >= NODE_MIN_MAJOR, `node ${process.versions.node} at ${process.execPath}`),
    `install node >= ${NODE_MIN_MAJOR}`,
  );
}

function checkNativeModule(): DoctorCheck {
  return asCheck("native_module", NATIVE_MODULE_FIX, () => {
    probeNativeModule();
    return {
      status: "ok",
      detail: `better-sqlite3 loaded under node ${process.versions.node} (ABI ${process.versions.modules})`,
    };
  });
}

function checkPluginData(config: Config): DoctorCheck {
  const probePath = join(config.pluginData, ".acm-doctor-probe");
  try {
    writeFileSync(probePath, "probe");
  } catch (error) {
    return failed("plugin_data", `${config.pluginData}: ${errorMessage(error)}`, PLUGIN_DATA_FIX);
  } finally {
    rmSync(probePath, { force: true });
  }
  return rated("plugin_data", passOrFail(true, `${config.pluginData} writable`), PLUGIN_DATA_FIX);
}

function checkDatabase(
  opened: OpenedDb | undefined,
  openDetail: string,
  dbPath: string,
): DoctorCheck {
  if (!opened) {
    return failed("database", openDetail, DB_FIX);
  }
  return asCheck("database", DB_FIX, () => {
    const version = opened.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    const quick = opened.db.pragma("quick_check") as { quick_check: string }[];
    const ok =
      version?.value === String(SCHEMA_VERSION) &&
      quick.length > 0 &&
      quick.every((row) => row.quick_check === "ok");
    return passOrFail(
      ok,
      `${dbPath} schema_version ${version?.value ?? "unset"}, quick_check ${quick.map((row) => row.quick_check).join(", ")}`,
    );
  });
}

function checkVec(opened: OpenedDb | undefined, openDetail: string): DoctorCheck {
  if (!opened) {
    return failed("vec", openDetail, VEC_FIX);
  }
  return opened.vecLoaded
    ? rated("vec", passOrFail(true, "sqlite-vec loaded"), VEC_FIX)
    : failed(
        "vec",
        `sqlite-vec not loaded — vector search unavailable: ${opened.vecError}`,
        VEC_FIX,
      );
}

function missingModelCheck(pluginData: string, path: string): DoctorCheck {
  const lock = readDownloadLock(pluginData);
  if (lockFresh(lock, Date.now())) {
    return rated(
      "model",
      {
        status: "warn",
        detail: `model missing at ${path}; downloading since ${lock.startedAt} (pid ${lock.pid})`,
      },
      MODEL_DOWNLOADING_FIX,
    );
  }
  const failure = readDownloadFailure(pluginData);
  const cause =
    failure === undefined
      ? ""
      : `; the last download failed at ${failure.failedAt}: ${failure.error}`;
  return failed("model", `model missing at ${path}${cause}`, MODEL_FIX);
}

function checkModel(config: Config | undefined, opened: OpenedDb | undefined): DoctorCheck {
  if (!config) {
    return failed("model", "skipped: CLAUDE_PLUGIN_DATA not resolved", MODEL_FIX);
  }
  const path = modelCachePath(config.modelCacheDir);
  if (!modelCached(config.modelCacheDir)) {
    try {
      return missingModelCheck(config.pluginData, path);
    } catch (error) {
      return failed("model", `model missing at ${path}; ${errorMessage(error)}`, MODEL_FIX);
    }
  }
  return asCheck("model", EMBEDDING_TIMEOUT_FIX, () => {
    const timedOutAt = opened === undefined ? undefined : lastEmbeddingTimeout(opened.db);
    return timedOutAt === undefined
      ? passOrFail(true, `model cached at ${path}`)
      : {
          status: "warn",
          detail: `model cached at ${path}, but the last prompt's query embedding at ${timedOutAt} exceeded the ${EMBED_DEADLINE_MS} ms deadline, so recall fell back to keyword search`,
        };
  });
}

function dbDependentCheck(
  name: string,
  fix: string,
  opened: OpenedDb | undefined,
  openDetail: string,
  probe: (db: Db, vecLoaded: boolean) => Verdict,
): DoctorCheck {
  if (!opened) {
    return failed(name, openDetail, fix);
  }
  return asCheck(name, fix, () => probe(opened.db, opened.vecLoaded));
}

function checkUnembedded(opened: OpenedDb | undefined, openDetail: string): DoctorCheck {
  return dbDependentCheck("unembedded", UNEMBEDDED_FIX, opened, openDetail, (db, vecLoaded) => {
    if (!vecLoaded) {
      return passOrFail(false, "cannot count: sqlite-vec not loaded");
    }
    const count = unembeddedActiveCount(db);
    if (count === 0) {
      return passOrFail(true, "all memories have embeddings");
    }
    const failure = lastBackfillFailure(db);
    const cause = failure === undefined ? "" : `; the start-up backfill failed ${failure}`;
    return passOrFail(false, `${count} active memories without embeddings${cause}`);
  });
}

function checkVecState(opened: OpenedDb | undefined, openDetail: string): DoctorCheck {
  return dbDependentCheck("vec_state", VEC_STATE_FIX, opened, openDetail, (db, vecLoaded) => {
    if (!vecLoaded) {
      return passOrFail(false, "cannot compare: sqlite-vec not loaded");
    }
    const count = driftedVecStateCount(db);
    return passOrFail(
      count === 0,
      count === 0
        ? "every vector carries its memory's state"
        : `${count} vectors carry a state other than their memory's, so vector recall misses or wrongly finds them`,
    );
  });
}

function checkFts(opened: OpenedDb | undefined, openDetail: string): DoctorCheck {
  return dbDependentCheck("fts", FTS_FIX, opened, openDetail, (db) => {
    const row = db
      .prepare(`SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'doctor'`)
      .get() as {
      n: number;
    };
    return passOrFail(true, `MATCH 'doctor' returned ${row.n} rows`);
  });
}

function checkCalibration(): DoctorCheck {
  return rated(
    "calibration",
    passOrFail(
      true,
      `gate calibrated for ${CALIBRATED_EMBEDDING.modelId} ${CALIBRATED_EMBEDDING.dtype} by sweep ${CALIBRATION_RUN.sweepRunId} (${CALIBRATION_RUN.date})`,
    ),
    "",
  );
}

export function autoMemoryCheck(autoMemory: AutoMemory): DoctorCheck {
  const decided = `as far as the readable settings show (decided by ${autoMemory.decidedBy})`;
  return autoMemory.enabled
    ? rated(
        "auto_memory",
        {
          status: "warn",
          detail: `native auto memory is on ${decided}; its index ${autoMemory.indexPath} loads into every session beside this plugin's recall`,
        },
        AUTO_MEMORY_FIX,
      )
    : rated("auto_memory", passOrFail(true, `native auto memory is off ${decided}`), "");
}

function projectIdentityCheck(facts: LocationFacts): DoctorCheck {
  const projectId = projectIdentity(facts);
  if (facts.dubiousRepository !== undefined) {
    return rated(
      "project_identity",
      {
        status: "warn",
        detail: `git refuses the repository at ${facts.dubiousRepository} (dubious ownership), so project ${projectId} is identified by the directory ${facts.realpath} and shares no memories with the repository's other directories`,
      },
      `git config --global --add safe.directory "${facts.dubiousRepository}"`,
    );
  }
  const source =
    facts.gitCommonDir === undefined
      ? `the directory ${facts.realpath}, outside git`
      : `the git repository at ${facts.gitCommonDir}`;
  return rated(
    "project_identity",
    passOrFail(true, `project ${projectId} is identified by ${source}`),
    "",
  );
}

function checkProjectIdentity(projectDir: string): DoctorCheck {
  try {
    return projectIdentityCheck(collectLocationFacts(projectDir));
  } catch (error) {
    return failed("project_identity", errorMessage(error), PROJECT_IDENTITY_FIX);
  }
}

function checkAutoMemory(env: NodeJS.ProcessEnv, projectDir: string): DoctorCheck {
  try {
    return autoMemoryCheck(readAutoMemory(env, projectDir, collectLocationFacts(projectDir)));
  } catch (error) {
    return failed("auto_memory", errorMessage(error), AUTO_MEMORY_FIX);
  }
}

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function retentionVerdict(facts: RetentionFacts): Verdict {
  if (!isInside(facts.pluginDataRoot, facts.dbPath)) {
    return passOrFail(
      true,
      `database ${facts.dbPath} lives outside ${facts.pluginDataRoot}; uninstalling the plugin leaves it in place`,
    );
  }
  const atRisk = `database ${facts.dbPath} lives in the plugin data directory, which uninstalling the plugin from its last scope deletes`;
  if (facts.lastExportAt === undefined) {
    return { status: "warn", detail: `${atRisk}; never exported` };
  }
  if (facts.lastExportAt < daysBefore(facts.now, EXPORT_STALE_AFTER_DAYS)) {
    return {
      status: "warn",
      detail: `${atRisk}; last export ${facts.lastExportAt} is older than ${EXPORT_STALE_AFTER_DAYS} days`,
    };
  }
  return passOrFail(true, `${atRisk}; last export ${facts.lastExportAt}`);
}

export function dataRetentionCheck(facts: RetentionFacts): DoctorCheck {
  return rated("data_retention", retentionVerdict(facts), RETENTION_FIX);
}

function checkDataRetention(
  env: NodeJS.ProcessEnv,
  config: Config | undefined,
  opened: OpenedDb | undefined,
  openDetail: string,
): DoctorCheck {
  return dbDependentCheck("data_retention", RETENTION_FIX, opened, openDetail, (db) =>
    retentionVerdict({
      dbPath: config?.dbPath ?? "",
      pluginDataRoot: join(claudeConfigDir(env), "plugins", "data"),
      lastExportAt: lastExportAt(db),
      now: new Date().toISOString(),
    }),
  );
}

export function runDoctor(env: NodeJS.ProcessEnv, projectDir: string): DoctorReport {
  const checks: DoctorCheck[] = [checkNode(), checkNativeModule()];
  let config: Config | undefined;
  try {
    config = loadConfig(env);
  } catch (error) {
    checks.push(failed("plugin_data", errorMessage(error), PLUGIN_DATA_FIX));
  }
  if (config) {
    checks.push(checkPluginData(config));
  }
  let opened: OpenedDb | undefined;
  let openDetail = "skipped: database not open";
  if (config) {
    try {
      opened = openDatabase(config);
    } catch (error) {
      openDetail = `${config.dbPath}: ${errorMessage(error)}`;
    }
  }
  try {
    checks.push(
      checkDatabase(opened, openDetail, config?.dbPath ?? "unset"),
      checkVec(opened, openDetail),
      checkModel(config, opened),
      checkUnembedded(opened, openDetail),
      checkVecState(opened, openDetail),
      checkFts(opened, openDetail),
      checkCalibration(),
      checkProjectIdentity(projectDir),
      checkAutoMemory(env, projectDir),
      checkDataRetention(env, config, opened, openDetail),
    );
  } finally {
    opened?.db.close();
  }
  const status = checks.some((check) => check.status === "fail") ? "degraded" : "ok";
  return { status, checks };
}
