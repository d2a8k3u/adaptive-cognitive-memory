import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_ID } from "../src/cfg";
import { MODEL_FILES, modelCached, modelCachePath } from "../src/embeddings";
import { hostProfile } from "../src/host";
import {
  acquireDownloadLock,
  DOWNLOAD_LOCK_STALE_MS,
  type DownloadLock,
  downloadLockPath,
  downloadModel,
  type ModelFetcher,
  modelNotice,
  modelSetup,
  NOTICE_REASON_MAX_CHARS,
  readDownloadFailure,
  readDownloadLock,
  recordDownloadFailure,
  STAGING_DIR_PREFIX,
} from "../src/modeldownload";

const NOW_MS = Date.parse("2026-10-14T12:00:00.000Z");
const NOW = new Date(NOW_MS);
const CONFIG_FILE = MODEL_FILES[0]!;
const MODEL_ORG_DIR = MODEL_ID.split("/")[0]!;
const CLAUDE_DOCTOR = hostProfile("claude").doctorInstruction;

function lockAged(ageMs: number): DownloadLock {
  return { pid: 4242, startedAt: new Date(NOW_MS - ageMs).toISOString() };
}

function freshDirs(): { dataDir: string; modelCacheDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "acm-download-"));
  return { dataDir, modelCacheDir: join(dataDir, "models") };
}

function writeModel(
  cacheDir: string,
  content: string,
  files: readonly string[] = MODEL_FILES,
): void {
  for (const file of files) {
    const path = join(modelCachePath(cacheDir), file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function fetching(content: string): ModelFetcher {
  return async (cacheDir) => writeModel(cacheDir, content);
}

function installedContent(modelCacheDir: string): string {
  return readFileSync(join(modelCachePath(modelCacheDir), CONFIG_FILE), "utf8");
}

describe("modelSetup", () => {
  it.each([
    { name: "a cached model", cached: true, auto: true, lock: undefined, setup: "ready" },
    {
      name: "a cached model whose download has not released its lock yet",
      cached: true,
      auto: true,
      lock: lockAged(0),
      setup: "ready",
    },
    {
      name: "a missing model",
      cached: false,
      auto: true,
      lock: undefined,
      setup: "start-download",
    },
    {
      name: "a missing model with a lock just inside the stale limit",
      cached: false,
      auto: true,
      lock: lockAged(DOWNLOAD_LOCK_STALE_MS - 1),
      setup: "downloading",
    },
    {
      name: "a missing model with a lock at the stale limit",
      cached: false,
      auto: true,
      lock: lockAged(DOWNLOAD_LOCK_STALE_MS),
      setup: "start-download",
    },
    {
      name: "a missing model with automatic download off",
      cached: false,
      auto: false,
      lock: undefined,
      setup: "download-off",
    },
    {
      name: "a missing model that a manual model-init is downloading",
      cached: false,
      auto: false,
      lock: lockAged(0),
      setup: "downloading",
    },
  ])("decides $setup for $name", ({ cached, auto, lock, setup }) => {
    const facts = { modelCached: cached, autoDownload: auto, lock, nowMs: NOW_MS };

    expect(modelSetup(facts)).toBe(setup);
  });
});

describe("modelNotice", () => {
  const refused = {
    failedAt: "2026-10-14T09:15:00.000Z",
    error: "fetch failed (getaddrinfo ENOTFOUND huggingface.co)",
  };
  const downloading =
    "adaptive-cognitive-memory is downloading its embedding model (one time, about 120 MB); prompt recall starts when it finishes.";
  const retrying =
    "adaptive-cognitive-memory's last embedding model download failed (fetch failed (getaddrinfo ENOTFOUND huggingface.co)); retrying in the background (one time, about 120 MB), prompt recall starts when it finishes.";
  const off =
    "adaptive-cognitive-memory has no embedding model yet and its automatic download is off, so prompt recall stays off: run /memory-doctor for the one-time model-init step.";
  const offAfterFailure =
    "adaptive-cognitive-memory has no embedding model: the last download failed (fetch failed (getaddrinfo ENOTFOUND huggingface.co)) and automatic download is off, so prompt recall stays off: run /memory-doctor for the one-time model-init step.";

  it.each([
    {
      name: "a cached model after a failed download",
      setup: "ready",
      failure: refused,
      notice: undefined,
    },
    { name: "a first download", setup: "start-download", failure: undefined, notice: downloading },
    { name: "a retry it starts", setup: "start-download", failure: refused, notice: retrying },
    { name: "a retry in progress", setup: "downloading", failure: refused, notice: retrying },
    { name: "automatic download off", setup: "download-off", failure: undefined, notice: off },
    {
      name: "automatic download off after a failed download",
      setup: "download-off",
      failure: refused,
      notice: offAfterFailure,
    },
  ] as const)("tells the session about $name", ({ setup, failure, notice }) => {
    expect(modelNotice(setup, failure, CLAUDE_DOCTOR)).toBe(notice);
  });

  it.each([
    {
      name: "a reason at the length limit",
      error: "x".repeat(NOTICE_REASON_MAX_CHARS),
      reason: "x".repeat(NOTICE_REASON_MAX_CHARS),
    },
    {
      name: "a reason one past the length limit",
      error: "x".repeat(NOTICE_REASON_MAX_CHARS + 1),
      reason: `${"x".repeat(NOTICE_REASON_MAX_CHARS - 1)}…`,
    },
    { name: "a multi-line reason", error: "first line\n    at stack frame", reason: "first line" },
  ])("names $name in short", ({ error, reason }) => {
    const notice = modelNotice(
      "start-download",
      { failedAt: refused.failedAt, error },
      CLAUDE_DOCTOR,
    );

    expect(notice).toContain(`download failed (${reason}); retrying`);
  });
});

describe("downloadModel", () => {
  it("installs the fetched model at the final path and leaves no staging directory or lock", async () => {
    const dirs = freshDirs();

    const outcome = await downloadModel(dirs, fetching("fetched"), () => NOW);

    expect(outcome).toBe("downloaded");
    expect(modelCached(dirs.modelCacheDir)).toBe(true);
    expect(installedContent(dirs.modelCacheDir)).toBe("fetched");
    expect(readdirSync(dirs.modelCacheDir)).toEqual([MODEL_ORG_DIR]);
    expect(readDownloadLock(dirs.dataDir)).toBeUndefined();
  });

  it("fails with no model at the final path, no staging directory and the failure recorded", async () => {
    const dirs = freshDirs();
    const refused = new Error("fetch failed", {
      cause: new Error("connect ECONNREFUSED 127.0.0.1:9"),
    });
    const interrupted: ModelFetcher = async (cacheDir) => {
      writeModel(cacheDir, "partial", [CONFIG_FILE]);
      throw refused;
    };

    await expect(downloadModel(dirs, interrupted, () => NOW)).rejects.toBe(refused);

    expect(existsSync(modelCachePath(dirs.modelCacheDir))).toBe(false);
    expect(readdirSync(dirs.modelCacheDir)).toEqual([]);
    expect(readDownloadFailure(dirs.dataDir)).toEqual({
      failedAt: NOW.toISOString(),
      error: "fetch failed (connect ECONNREFUSED 127.0.0.1:9)",
    });
    expect(readDownloadLock(dirs.dataDir)).toBeUndefined();
  });

  it("replaces what an interrupted earlier run left behind and clears its recorded failure", async () => {
    const dirs = freshDirs();
    writeModel(dirs.modelCacheDir, "partial", [CONFIG_FILE]);
    writeModel(join(dirs.modelCacheDir, `${STAGING_DIR_PREFIX}crashed`), "partial", [CONFIG_FILE]);
    recordDownloadFailure(dirs.dataDir, {
      failedAt: "2026-10-13T08:00:00.000Z",
      error: "fetch failed",
    });

    const outcome = await downloadModel(dirs, fetching("fetched"), () => NOW);

    expect(outcome).toBe("downloaded");
    expect(installedContent(dirs.modelCacheDir)).toBe("fetched");
    expect(readdirSync(dirs.modelCacheDir)).toEqual([MODEL_ORG_DIR]);
    expect(readDownloadFailure(dirs.dataDir)).toBeUndefined();
  });

  it("returns busy without fetching while another run holds a fresh lock", async () => {
    const dirs = freshDirs();
    const held = acquireDownloadLock(dirs.dataDir, NOW);

    const outcome = await downloadModel(dirs, fetching("fetched"), () => NOW);

    expect(held).toBeDefined();
    expect(outcome).toBe("busy");
    expect(modelCached(dirs.modelCacheDir)).toBe(false);
    expect(readDownloadLock(dirs.dataDir)).toEqual(held);
  });

  it.each([
    {
      name: "a lock at the stale limit",
      leave: (pluginData: string) =>
        acquireDownloadLock(pluginData, new Date(NOW_MS - DOWNLOAD_LOCK_STALE_MS)),
    },
    {
      name: "a lock file a crash left empty",
      leave: (pluginData: string) => writeFileSync(downloadLockPath(pluginData), ""),
    },
  ])("takes over $name", async ({ leave }) => {
    const dirs = freshDirs();
    leave(dirs.dataDir);

    const outcome = await downloadModel(dirs, fetching("fetched"), () => NOW);

    expect(outcome).toBe("downloaded");
    expect(modelCached(dirs.modelCacheDir)).toBe(true);
  });

  it("leaves in place the lock of a run that took over while it was still fetching", async () => {
    const dirs = freshDirs();
    let takenOver: DownloadLock | undefined;
    const outlasted: ModelFetcher = async (cacheDir) => {
      takenOver = acquireDownloadLock(dirs.dataDir, new Date(NOW_MS + DOWNLOAD_LOCK_STALE_MS));
      writeModel(cacheDir, "fetched");
    };

    await downloadModel(dirs, outlasted, () => NOW);

    expect(takenOver).toBeDefined();
    expect(readDownloadLock(dirs.dataDir)).toEqual(takenOver);
  });

  it("keeps a model another process completed during the fetch and discards its own copy", async () => {
    const dirs = freshDirs();
    const overtaken: ModelFetcher = async (cacheDir) => {
      writeModel(cacheDir, "fetched");
      writeModel(dirs.modelCacheDir, "completed elsewhere");
    };

    const outcome = await downloadModel(dirs, overtaken, () => NOW);

    expect(outcome).toBe("already-cached");
    expect(installedContent(dirs.modelCacheDir)).toBe("completed elsewhere");
    expect(readdirSync(dirs.modelCacheDir)).toEqual([MODEL_ORG_DIR]);
  });
});
