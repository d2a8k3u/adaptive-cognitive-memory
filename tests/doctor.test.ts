import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALIBRATED_EMBEDDING, CALIBRATION_RUN } from "../src/calibration";
import { DB_FILENAME, EMBED_DIM, loadConfig } from "../src/cfg";
import { runCli } from "../src/cli";
import { type OpenedDb, openDatabase } from "../src/db/database";
import { recordEmbeddingTimeout } from "../src/db/health";
import { SCHEMA_VERSION } from "../src/db/schema";
import {
  type CheckStatus,
  type DoctorCheck,
  type DoctorReport,
  dataRetentionCheck,
  runDoctor,
} from "../src/doctor";
import { modelCachePath } from "../src/embeddings";
import { resolveProjectId } from "../src/ids";
import { acquireDownloadLock, recordDownloadFailure } from "../src/modeldownload";
import { MOVED_MARKER_FILE, storeNotice, writeMovedMarker } from "../src/storelocation";
import { PLUGIN_VERSION } from "../src/version";
import { testModelCacheDir } from "../vitest.config";

const vecState = vi.hoisted(() => ({ failGetLoadablePath: false }));

vi.mock("sqlite-vec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sqlite-vec")>();
  return {
    ...actual,
    getLoadablePath: () => {
      if (vecState.failGetLoadablePath) {
        throw new Error("Unsupported platform for sqlite-vec");
      }
      return actual.getLoadablePath();
    },
  };
});

const CHECK_NAMES = [
  "node",
  "native_module",
  "plugin_data",
  "database",
  "vec",
  "model",
  "unembedded",
  "vec_state",
  "fts",
  "calibration",
  "project_identity",
  "auto_memory",
  "data_retention",
];
const PROJECT_DIR = realpathSync(mkdtempSync(join(tmpdir(), "acm-doctor-project-")));
const CHILD_KILL_MS = 30_000;

function healthyEnv(): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), "acm-doctor-"));
  return {
    CLAUDE_PLUGIN_DATA: dataDir,
    ACM_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "acm-doctor-claude-")),
    ACM_MODEL_CACHE_DIR: testModelCacheDir,
  };
}

function reembedEnv(): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), "acm-cli-reembed-"));
  return {
    CLAUDE_PLUGIN_DATA: dataDir,
    ACM_DATA_DIR: dataDir,
    ACM_MODEL_CACHE_DIR: mkdtempSync(join(tmpdir(), "acm-cli-reembed-model-")),
  };
}

function cliDoctor(env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), "dist", "cli.js"), "doctor"], {
      env,
      cwd: PROJECT_DIR,
    });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
  });
}

function checkByName(report: DoctorReport, name: string): DoctorCheck {
  const check = report.checks.find((entry) => entry.name === name);
  expect(check, `check ${name} present`).toBeDefined();
  return check as DoctorCheck;
}

function insertMemory(opened: OpenedDb, id: string): void {
  opened.db
    .prepare(
      `INSERT INTO memories (id, type, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
       VALUES (?, 'semantic', 'project', 'proj-0000000000000001', 'title', 'abstract', 'content', 0.5, NULL, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
    )
    .run(id);
}

function insertVector(opened: OpenedDb, id: string, state: string): void {
  opened.db
    .prepare(
      `INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id, state)
       VALUES (?, ?, 'semantic', 'project', 'proj-0000000000000001', ?)`,
    )
    .run(id, Buffer.from(new Float32Array(EMBED_DIM).fill(0.5).buffer), state);
}

function seedVecStateDrift(env: NodeJS.ProcessEnv): void {
  const opened = openDatabase(loadConfig(env));
  try {
    insertMemory(opened, "mem-steady");
    insertVector(opened, "mem-steady", "active");
    insertMemory(opened, "mem-reactivated");
    insertVector(opened, "mem-reactivated", "hypothesis");
  } finally {
    opened.db.close();
  }
}

function vecStates(env: NodeJS.ProcessEnv): unknown[] {
  const opened = openDatabase(loadConfig(env));
  try {
    return opened.db.prepare("SELECT memory_id, state FROM memories_vec ORDER BY memory_id").all();
  } finally {
    opened.db.close();
  }
}

afterEach(() => {
  vecState.failGetLoadablePath = false;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runDoctor", () => {
  it("rates every check on a healthy install and warns about native auto memory without degrading", () => {
    const report = runDoctor(healthyEnv(), PROJECT_DIR);

    expect(report.status).toBe("ok");
    expect(report.checks.map((check) => [check.name, check.status])).toEqual(
      CHECK_NAMES.map((name) => [name, name === "auto_memory" ? "warn" : "ok"]),
    );
    expect(report.checks.every((check) => check.ok)).toBe(true);
    expect(checkByName(report, "unembedded").detail).toBe("all memories have embeddings");
    expect(checkByName(report, "auto_memory").fix).toContain(
      '"autoMemoryEnabled": false in .claude/settings.json',
    );
    expect(checkByName(report, "calibration").detail).toContain(CALIBRATION_RUN.runId);
    expect(checkByName(report, "calibration").detail).toContain(CALIBRATED_EMBEDDING.modelId);
  });

  it("warns with the safe.directory fix when git refuses the project's repository for dubious ownership", () => {
    const repository = realpathSync(mkdtempSync(join(tmpdir(), "acm-doctor-dubious-")));
    execFileSync("git", ["init", "-q", repository], { stdio: "ignore" });
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1");

    const report = runDoctor(healthyEnv(), repository);

    expect(report.status).toBe("ok");
    expect(checkByName(report, "project_identity")).toMatchObject({
      status: "warn",
      detail: `git refuses the repository at ${repository} (dubious ownership), so project ${resolveProjectId(repository)} is identified by the directory ${repository} and shares no memories with the repository's other directories`,
      fix: `git config --global --add safe.directory "${repository}"`,
    });
  });

  it("passes auto_memory when native auto memory is off", () => {
    const env = { ...healthyEnv(), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };

    expect(checkByName(runDoctor(env, PROJECT_DIR), "auto_memory")).toMatchObject({
      status: "ok",
      ok: true,
      fix: "",
    });
  });

  it("warns about data retention for a database in the plugin data directory until it is exported", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const configDir = mkdtempSync(join(tmpdir(), "acm-doctor-claude-"));
    const pluginData = join(configDir, "plugins", "data", "adaptive-cognitive-memory-inline");
    mkdirSync(pluginData, { recursive: true });
    const env = {
      ...healthyEnv(),
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_PLUGIN_DATA: pluginData,
      ACM_DATA_DIR: pluginData,
    };

    const before = checkByName(runDoctor(env, PROJECT_DIR), "data_retention");
    await runCli(["node", "dist/cli.js", "export", join(configDir, "backup.jsonl")], env);
    const after = checkByName(runDoctor(env, PROJECT_DIR), "data_retention");

    expect(before.status).toBe("warn");
    expect(before.fix).toBe(
      `back up with node "${join(process.cwd(), "dist", "cli.js")}" export <file>, and move the database out of the plugin data directory: run the store move that plugin_data names, or set ACM_DATA_DIR to a directory outside it`,
    );
    expect(after).toMatchObject({ status: "ok", fix: "" });
  });

  it("names the better-sqlite3 load failure and the rebuild fix when the native module does not load", async () => {
    const env: NodeJS.ProcessEnv = {
      ...healthyEnv(),
      PATH: process.env.PATH ?? "",
      NODE_OPTIONS: `--require ${join(process.cwd(), "tests", "fixtures", "dlopen-fail.cjs")}`,
    };

    const { code, stdout } = await cliDoctor(env);

    expect(code).toBe(1);
    const report = JSON.parse(stdout) as DoctorReport;
    expect(report.status).toBe("degraded");
    expect(checkByName(report, "native_module")).toMatchObject({
      status: "fail",
      ok: false,
      detail: expect.stringContaining("NODE_MODULE_VERSION 115"),
      fix: expect.stringContaining("npm rebuild better-sqlite3"),
    });
  }, 30_000);

  it("names the exact missing model path and the model-init fix when the model is absent", () => {
    const emptyCacheDir = mkdtempSync(join(tmpdir(), "acm-doctor-model-"));
    const env = healthyEnv();
    env.ACM_MODEL_CACHE_DIR = emptyCacheDir;

    const report = runDoctor(env, PROJECT_DIR);

    expect(report.status).toBe("degraded");
    const model = checkByName(report, "model");
    expect(model.ok).toBe(false);
    expect(model.detail).toContain(modelCachePath(emptyCacheDir));
    expect(model.fix).toMatch(/model-init/);
  });

  it("warns that the missing model is downloading while a fresh download lock exists", () => {
    const env = healthyEnv();
    env.ACM_MODEL_CACHE_DIR = mkdtempSync(join(tmpdir(), "acm-doctor-model-"));
    const lock = acquireDownloadLock(env.CLAUDE_PLUGIN_DATA as string, new Date())!;

    const report = runDoctor(env, PROJECT_DIR);

    expect(report.status).toBe("ok");
    expect(checkByName(report, "model")).toMatchObject({
      status: "warn",
      detail: `model missing at ${modelCachePath(env.ACM_MODEL_CACHE_DIR)}; downloading since ${lock.startedAt} (pid ${lock.pid})`,
      fix: expect.stringContaining("wait for the download to finish"),
    });
  });

  it("names the last download failure while the model is missing", () => {
    const env = healthyEnv();
    env.ACM_MODEL_CACHE_DIR = mkdtempSync(join(tmpdir(), "acm-doctor-model-"));
    recordDownloadFailure(env.CLAUDE_PLUGIN_DATA as string, {
      failedAt: "2026-10-14T09:15:00.000Z",
      error: "fetch failed (getaddrinfo ENOTFOUND huggingface.co)",
    });

    const report = runDoctor(env, PROJECT_DIR);

    expect(report.status).toBe("degraded");
    expect(checkByName(report, "model")).toMatchObject({
      status: "fail",
      detail: `model missing at ${modelCachePath(env.ACM_MODEL_CACHE_DIR)}; the last download failed at 2026-10-14T09:15:00.000Z: fetch failed (getaddrinfo ENOTFOUND huggingface.co)`,
      fix: expect.stringMatching(/model-init/),
    });
  });

  it("warns with the time and the configured deadline when the last prompt's query embedding timed out", () => {
    const env = { ...healthyEnv(), ACM_EMBED_DEADLINE_MS: "2500" };
    const opened = openDatabase(loadConfig(env));
    try {
      recordEmbeddingTimeout(opened.db, "2026-10-14T09:15:00.000Z");
    } finally {
      opened.db.close();
    }

    const report = runDoctor(env, PROJECT_DIR);

    expect(report.status).toBe("ok");
    expect(checkByName(report, "model")).toMatchObject({
      status: "warn",
      detail: `model cached at ${modelCachePath(testModelCacheDir)}, but the last prompt's query embedding at 2026-10-14T09:15:00.000Z exceeded the 2500 ms deadline, so recall fell back to keyword search`,
      fix: expect.stringContaining("model-init"),
    });
  });

  it.each([
    {
      title: "read-only plugin data directory",
      breakage: (env: NodeJS.ProcessEnv) => {
        chmodSync(env.CLAUDE_PLUGIN_DATA as string, 0o500);
        return () => chmodSync(env.CLAUDE_PLUGIN_DATA as string, 0o700);
      },
      expectedDetail: /memory\.sqlite/,
    },
    {
      title: "schema_version guard mismatch",
      breakage: (env: NodeJS.ProcessEnv) => {
        const config = loadConfig(env);
        openDatabase(config).db.close();
        const raw = new Database(config.dbPath);
        raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
        raw.close();
        return () => {};
      },
      expectedDetail: new RegExp(
        `database schema 99 written by adaptive-cognitive-memory ${PLUGIN_VERSION} is newer than this build supports \\(schema ${SCHEMA_VERSION}, .*\\): update the plugin`,
      ),
    },
  ])("names the broken piece on $title", ({ breakage, expectedDetail }) => {
    const env = healthyEnv();
    const restore = breakage(env);

    try {
      const report = runDoctor(env, PROJECT_DIR);
      expect(report.status).toBe("degraded");
      const database = checkByName(report, "database");
      expect(database.ok).toBe(false);
      expect(database.detail).toMatch(expectedDetail);
      expect(database.fix.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("counts only active memories without embeddings, the ones recall can return, and flags them as degraded", () => {
    const env = healthyEnv();
    const opened = openDatabase(loadConfig(env));
    try {
      insertMemory(opened, "mem-embedded");
      insertMemory(opened, "mem-embedded-2");
      insertMemory(opened, "mem-bare");
      insertMemory(opened, "mem-bare-revoked");
      insertMemory(opened, "mem-bare-hypothesis");
      opened.db
        .prepare("UPDATE memories SET state = ? WHERE id = ?")
        .run("revoked", "mem-bare-revoked");
      opened.db
        .prepare("UPDATE memories SET state = ? WHERE id = ?")
        .run("hypothesis", "mem-bare-hypothesis");
      const embedding = Buffer.from(new Float32Array(EMBED_DIM).fill(0.5).buffer);
      const insertVector = opened.db.prepare(
        `INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id, state)
         VALUES (?, ?, 'semantic', 'project', 'proj-0000000000000001', 'active')`,
      );
      insertVector.run("mem-embedded", embedding);
      insertVector.run("mem-embedded-2", embedding);
    } finally {
      opened.db.close();
    }

    const report = runDoctor(env, PROJECT_DIR);

    expect(report.status).toBe("degraded");
    const unembedded = checkByName(report, "unembedded");
    expect(unembedded.ok).toBe(false);
    expect(unembedded.detail).toBe("1 active memories without embeddings");
    expect(unembedded.fix.length).toBeGreaterThan(0);
  });

  it("counts vectors whose state drifted from their memory's and flags them as degraded", () => {
    const env = healthyEnv();
    seedVecStateDrift(env);

    const report = runDoctor(env, PROJECT_DIR);

    expect(report.status).toBe("degraded");
    expect(checkByName(report, "vec_state")).toMatchObject({
      status: "fail",
      detail:
        "1 vectors carry a state other than their memory's, so vector recall misses or wrongly finds them",
      fix: expect.stringContaining("reembed"),
    });
  });

  it("stays degraded and never silently ok when sqlite-vec fails to load", () => {
    vecState.failGetLoadablePath = true;
    const report = runDoctor(healthyEnv(), PROJECT_DIR);

    expect(report.status).toBe("degraded");
    expect(checkByName(report, "vec")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("Unsupported platform for sqlite-vec"),
    });
    expect(checkByName(report, "unembedded").ok).toBe(false);
    expect(checkByName(report, "fts").ok).toBe(true);
    expect(checkByName(report, "database").ok).toBe(true);
  });
});

const DIGEST = "digest-of-the-moved-store";
const MOVED_AT = "2026-10-30T00:00:00.000Z";

interface ClaudeStores {
  readonly legacyDir: string;
  readonly dataDir: string;
  readonly movedTo: string;
  readonly env: NodeJS.ProcessEnv;
}

function claudeStores(): ClaudeStores {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-doctor-location-")));
  const configDir = join(root, "claude");
  const legacyDir = join(configDir, "plugins", "data", "adaptive-cognitive-memory-inline");
  const dataDir = join(root, "shared");
  mkdirSync(legacyDir, { recursive: true });
  mkdirSync(dataDir);
  openDatabase(loadConfig({ ACM_DATA_DIR: legacyDir })).db.close();
  return {
    legacyDir,
    dataDir,
    movedTo: join(root, "moved"),
    env: {
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_PLUGIN_DATA: legacyDir,
      ACM_DATA_DIR: dataDir,
      ACM_MODEL_CACHE_DIR: testModelCacheDir,
    },
  };
}

describe("runDoctor by host and store location", () => {
  it("passes plugin_data, auto_memory and data_retention for a fresh store outside any Claude install", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-doctor-codex-")));
    const dataDir = join(root, "share", "adaptive-cognitive-memory");
    const env = {
      ACM_HOST: "codex",
      ACM_DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      ACM_MODEL_CACHE_DIR: testModelCacheDir,
    };

    const report = runDoctor(env, PROJECT_DIR);

    expect(checkByName(report, "plugin_data")).toMatchObject({
      status: "ok",
      detail: `${dataDir} writable`,
    });
    expect(checkByName(report, "auto_memory")).toMatchObject({
      status: "ok",
      detail: "native auto memory is not applicable on codex",
    });
    expect(checkByName(report, "data_retention").status).toBe("ok");
  });

  it("fails plugin_data with a fix naming ACM_DATA_DIR, and names CLAUDE_PLUGIN_DATA nowhere, when the data dir does not resolve", () => {
    const env = {
      ACM_DATA_DIR: "relative/memory",
      CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "acm-doctor-claude-")),
    };

    const report = runDoctor(env, PROJECT_DIR);

    expect(checkByName(report, "plugin_data")).toEqual({
      name: "plugin_data",
      status: "fail",
      ok: false,
      detail: "ACM_DATA_DIR must be an absolute path, got: relative/memory",
      fix: "set ACM_DATA_DIR to an absolute path of a writable directory",
    });
    expect(JSON.stringify(report)).not.toContain("CLAUDE_PLUGIN_DATA");
  });

  it.each<{
    name: string;
    prepare: (stores: ClaudeStores) => void;
    pluginData: (stores: ClaudeStores) => { detail: string; fix: string | undefined };
    retention: CheckStatus;
    dataDirDb: boolean;
  }>([
    {
      name: "an unmoved legacy store",
      prepare: () => {},
      pluginData: ({ legacyDir, dataDir }) => ({
        detail: `${legacyDir} writable`,
        fix: storeNotice({ kind: "legacy", legacyDir }, dataDir),
      }),
      retention: "warn",
      dataDirDb: false,
    },
    {
      name: "a store moved elsewhere",
      prepare: ({ legacyDir, movedTo }) => {
        mkdirSync(movedTo);
        writeMovedMarker(legacyDir, movedTo, DIGEST, MOVED_AT);
      },
      pluginData: ({ movedTo, dataDir }) => ({
        detail: `${movedTo} writable`,
        fix: storeNotice({ kind: "moved-elsewhere", movedTo, targetExists: true }, dataDir),
      }),
      retention: "ok",
      dataDirDb: false,
    },
    {
      name: "a store moved to a missing dir",
      prepare: ({ legacyDir, movedTo }) => writeMovedMarker(legacyDir, movedTo, DIGEST, MOVED_AT),
      pluginData: ({ movedTo, dataDir }) => ({
        detail: `${movedTo} does not exist`,
        fix: storeNotice({ kind: "moved-elsewhere", movedTo, targetExists: false }, dataDir),
      }),
      retention: "fail",
      dataDirDb: false,
    },
    {
      name: "an unreadable marker",
      prepare: ({ legacyDir }) => writeFileSync(join(legacyDir, MOVED_MARKER_FILE), "{not json"),
      pluginData: ({ legacyDir, dataDir }) => ({
        detail: `${dataDir} writable; ${join(legacyDir, MOVED_MARKER_FILE)} is unreadable`,
        fix: "set ACM_DATA_DIR to the directory that holds the moved store",
      }),
      retention: "ok",
      dataDirDb: true,
    },
  ])(
    "warns in plugin_data about $name and examines the store in use",
    ({ prepare, pluginData, retention, dataDirDb }) => {
      const stores = claudeStores();
      prepare(stores);

      const report = runDoctor(stores.env, PROJECT_DIR);

      expect(checkByName(report, "plugin_data")).toEqual({
        name: "plugin_data",
        status: "warn",
        ok: true,
        ...pluginData(stores),
      });
      expect(checkByName(report, "data_retention").status).toBe(retention);
      expect(existsSync(join(stores.dataDir, DB_FILENAME))).toBe(dataDirDb);
    },
  );
});

describe("dataRetentionCheck", () => {
  const pluginDataRoot = "/home/u/.claude/plugins/data";
  const inPluginData = `${pluginDataRoot}/adaptive-cognitive-memory/memory.sqlite`;

  it.each([
    { name: "a database outside the plugin data directory", dbPath: "/srv/memory.sqlite" },
    {
      name: "a database in a sibling directory sharing the prefix",
      dbPath: "/home/u/.claude/plugins/data-archive/memory.sqlite",
    },
    {
      name: "an export exactly 30 days old",
      dbPath: inPluginData,
      lastExportAt: "2026-09-14T12:00:00.000Z",
    },
    {
      name: "a database never exported",
      dbPath: inPluginData,
      status: "warn",
    },
    {
      name: "an export 30 days and 1 ms old",
      dbPath: inPluginData,
      lastExportAt: "2026-09-14T11:59:59.999Z",
      status: "warn",
    },
  ])("rates $name as $status", ({ dbPath, lastExportAt, status = "ok" }) => {
    const check = dataRetentionCheck({
      dbPath,
      pluginDataRoot,
      lastExportAt,
      now: "2026-10-14T12:00:00.000Z",
    });

    expect(check.status).toBe(status);
  });
});

describe("runCli", () => {
  it("doctor prints the JSON report, exits 0 despite a warning, and touches no network", async () => {
    const fetchAttempt = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network attempted");
    });
    const print = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["node", "dist/cli.js", "doctor"], healthyEnv(), PROJECT_DIR);

    expect(code).toBe(0);
    expect(fetchAttempt).not.toHaveBeenCalled();
    expect(print).toHaveBeenCalledTimes(1);
    const report = JSON.parse(print.mock.calls[0]?.[0] as string) as DoctorReport;
    expect(report.status).toBe("ok");
    expect(report.checks.map((check) => check.name)).toEqual(CHECK_NAMES);
    expect(checkByName(report, "auto_memory").status).toBe("warn");
  });

  it("doctor exits 1 with a degraded report when the model is missing", async () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = healthyEnv();
    env.ACM_MODEL_CACHE_DIR = mkdtempSync(join(tmpdir(), "acm-cli-model-"));

    const code = await runCli(["node", "dist/cli.js", "doctor"], env, PROJECT_DIR);

    expect(code).toBe(1);
    const report = JSON.parse(print.mock.calls[0]?.[0] as string) as DoctorReport;
    expect(report.status).toBe("degraded");
  });

  it("reembed embeds every memory without a vector, revoked ones included, and prints the count", {
    timeout: 60_000,
  }, async () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = healthyEnv();
    const opened = openDatabase(loadConfig(env));
    try {
      insertMemory(opened, "mem-active");
      insertMemory(opened, "mem-revoked");
      opened.db.prepare("UPDATE memories SET state = 'revoked' WHERE id = ?").run("mem-revoked");
    } finally {
      opened.db.close();
    }

    const code = await runCli(["node", "dist/cli.js", "reembed"], env);

    expect(code).toBe(0);
    expect(print.mock.calls.flat()).toEqual(["2 memories embedded, 0 vector states reconciled"]);
    const reopened = openDatabase(loadConfig(env));
    try {
      expect(
        reopened.db.prepare("SELECT memory_id, state FROM memories_vec ORDER BY memory_id").all(),
      ).toEqual([
        { memory_id: "mem-active", state: "active" },
        { memory_id: "mem-revoked", state: "revoked" },
      ]);
    } finally {
      reopened.db.close();
    }
  });

  it("reembed reconciles vector states that drifted while sqlite-vec was not loaded", async () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = healthyEnv();
    seedVecStateDrift(env);

    const code = await runCli(["node", "dist/cli.js", "reembed"], env);

    expect(code).toBe(0);
    expect(print.mock.calls.flat()).toEqual(["0 memories embedded, 1 vector states reconciled"]);
    expect(vecStates(env)).toEqual([
      { memory_id: "mem-reactivated", state: "active" },
      { memory_id: "mem-steady", state: "active" },
    ]);
  });

  it("recall off and on switch recall for the project of the working directory", async () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = healthyEnv();
    const project = realpathSync(mkdtempSync(join(tmpdir(), "acm-cli-recall-")));
    const projectId = resolveProjectId(project);
    const recallSwitch = () => {
      const opened = openDatabase(loadConfig(env));
      try {
        return opened.db.prepare("SELECT project_id, recall_enabled FROM project_settings").all();
      } finally {
        opened.db.close();
      }
    };

    const offCode = await runCli(["node", "dist/cli.js", "recall", "off"], env, project);
    const afterOff = recallSwitch();
    const onCode = await runCli(["node", "dist/cli.js", "recall", "on"], env, project);

    expect([offCode, onCode]).toEqual([0, 0]);
    expect(afterOff).toEqual([{ project_id: projectId, recall_enabled: 0 }]);
    expect(recallSwitch()).toEqual([{ project_id: projectId, recall_enabled: 1 }]);
    expect(print.mock.calls.flat()).toEqual([
      `recall off for project ${projectId} (${project})`,
      `recall on for project ${projectId} (${project})`,
    ]);
  });

  it.each([
    { argv: ["node", "dist/cli.js"], env: undefined, code: 2, stderr: /usage: cli/ },
    { argv: ["node", "dist/cli.js", "bogus"], env: undefined, code: 2, stderr: /usage: cli/ },
    {
      argv: ["node", "dist/cli.js", "recall", "maybe"],
      env: undefined,
      code: 2,
      stderr: /usage: cli/,
    },
    {
      argv: ["node", "dist/cli.js", "model-init"],
      env: {},
      code: 1,
      stderr: /ACM_DATA_DIR/,
    },
    {
      argv: ["node", "dist/cli.js", "doctor"],
      env: { ...healthyEnv(), ACM_HOST: "vim" },
      code: 1,
      stderr: /^ACM_HOST must be one of claude, codex, opencode, got: "vim"$/,
    },
    {
      argv: ["node", "dist/cli.js", "reembed"],
      env: reembedEnv(),
      code: 1,
      stderr: /model-init/,
    },
  ])("rejects $argv[2] with exit $code", async ({ argv, env, code, stderr }) => {
    const errorPrint = vi.spyOn(console, "error").mockImplementation(() => {});

    const actual = await runCli(argv, env ?? healthyEnv());

    expect(actual).toBe(code);
    expect(errorPrint.mock.calls.flat().join(" ")).toMatch(stderr);
  });
});
