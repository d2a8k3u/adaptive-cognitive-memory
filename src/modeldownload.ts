import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type Config, MODEL_DOWNLOAD_SIZE } from "./cfg";
import { modelCached, modelCachePath } from "./embeddings";
import { PLUGIN_NAME } from "./version";

export const DOWNLOAD_LOCK_STALE_MS = 15 * 60_000;
export const STAGING_DIR_PREFIX = ".staging-";
export const NOTICE_REASON_MAX_CHARS = 120;
const LOCK_FILENAME = "model-download.lock";
const FAILURE_FILENAME = "model-download-failure.json";
const FILE_MISSING_CODE = "ENOENT";
const FILE_EXISTS_CODE = "EEXIST";

export interface DownloadLock {
  readonly pid: number;
  readonly startedAt: string;
}

export interface DownloadFailure {
  readonly failedAt: string;
  readonly error: string;
}

export type ModelSetup = "ready" | "start-download" | "downloading" | "download-off";

export interface ModelSetupFacts {
  readonly modelCached: boolean;
  readonly autoDownload: boolean;
  readonly lock: DownloadLock | undefined;
  readonly nowMs: number;
}

export type ModelFetcher = (cacheDir: string) => Promise<void>;

export type DownloadOutcome = "downloaded" | "already-cached" | "busy";

export type DownloadDirs = Pick<Config, "dataDir" | "modelCacheDir">;

export function lockFresh(lock: DownloadLock | undefined, nowMs: number): lock is DownloadLock {
  return lock !== undefined && nowMs - Date.parse(lock.startedAt) < DOWNLOAD_LOCK_STALE_MS;
}

export function modelSetup(facts: ModelSetupFacts): ModelSetup {
  if (facts.modelCached) {
    return "ready";
  }
  if (lockFresh(facts.lock, facts.nowMs)) {
    return "downloading";
  }
  return facts.autoDownload ? "start-download" : "download-off";
}

function shortReason(error: string): string {
  const firstLine = error.split("\n", 1)[0] ?? "";
  return firstLine.length > NOTICE_REASON_MAX_CHARS
    ? `${firstLine.slice(0, NOTICE_REASON_MAX_CHARS - 1)}…`
    : firstLine;
}

function downloadingNotice(lastFailure: DownloadFailure | undefined): string {
  const progress = `(one time, ${MODEL_DOWNLOAD_SIZE})`;
  return lastFailure === undefined
    ? `${PLUGIN_NAME} is downloading its embedding model ${progress}; prompt recall starts when it finishes.`
    : `${PLUGIN_NAME}'s last embedding model download failed (${shortReason(lastFailure.error)}); retrying in the background ${progress}, prompt recall starts when it finishes.`;
}

function downloadOffNotice(lastFailure: DownloadFailure | undefined): string {
  const state =
    lastFailure === undefined
      ? "has no embedding model yet and its automatic download is off"
      : `has no embedding model: the last download failed (${shortReason(lastFailure.error)}) and automatic download is off`;
  return `${PLUGIN_NAME} ${state}, so prompt recall stays off: run /memory-doctor for the one-time model-init step.`;
}

export function modelNotice(
  setup: ModelSetup,
  lastFailure: DownloadFailure | undefined,
): string | undefined {
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

function isDownloadLock(value: unknown): value is DownloadLock {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "startedAt" in value &&
    typeof value.startedAt === "string"
  );
}

function isDownloadFailure(value: unknown): value is DownloadFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "failedAt" in value &&
    typeof value.failedAt === "string" &&
    "error" in value &&
    typeof value.error === "string"
  );
}

function failureMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function readStateRecord<T>(path: string, isRecord: (value: unknown) => value is T): T | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (hasCode(error, FILE_MISSING_CODE)) {
      return undefined;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
  return isRecord(value) ? value : undefined;
}

export function downloadLockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILENAME);
}

function downloadFailurePath(dataDir: string): string {
  return join(dataDir, FAILURE_FILENAME);
}

export function readDownloadLock(dataDir: string): DownloadLock | undefined {
  return readStateRecord(downloadLockPath(dataDir), isDownloadLock);
}

export function readDownloadFailure(dataDir: string): DownloadFailure | undefined {
  return readStateRecord(downloadFailurePath(dataDir), isDownloadFailure);
}

export function observedModelSetup(
  config: Pick<Config, "dataDir" | "modelCacheDir" | "autoDownloadModel">,
  nowMs: number,
): ModelSetup {
  return modelSetup({
    modelCached: modelCached(config.modelCacheDir),
    autoDownload: config.autoDownloadModel,
    lock: readDownloadLock(config.dataDir),
    nowMs,
  });
}

export function recordDownloadFailure(dataDir: string, failure: DownloadFailure): void {
  writeFileSync(downloadFailurePath(dataDir), JSON.stringify(failure));
}

function createLock(path: string, lock: DownloadLock): boolean {
  try {
    writeFileSync(path, JSON.stringify(lock), { flag: "wx" });
    return true;
  } catch (error) {
    if (hasCode(error, FILE_EXISTS_CODE)) {
      return false;
    }
    throw error;
  }
}

export function acquireDownloadLock(dataDir: string, now: Date): DownloadLock | undefined {
  const path = downloadLockPath(dataDir);
  const lock = { pid: process.pid, startedAt: now.toISOString() };
  if (createLock(path, lock)) {
    return lock;
  }
  if (lockFresh(readDownloadLock(dataDir), now.getTime())) {
    return undefined;
  }
  rmSync(path, { force: true });
  return createLock(path, lock) ? lock : undefined;
}

function releaseDownloadLock(dataDir: string, lock: DownloadLock): void {
  const current = readDownloadLock(dataDir);
  if (current?.pid === lock.pid && current.startedAt === lock.startedAt) {
    rmSync(downloadLockPath(dataDir), { force: true });
  }
}

function removeStagingLeftovers(modelCacheDir: string): void {
  for (const entry of readdirSync(modelCacheDir)) {
    if (entry.startsWith(STAGING_DIR_PREFIX)) {
      rmSync(join(modelCacheDir, entry), { recursive: true, force: true });
    }
  }
}

function installModel(fetchedPath: string, modelCacheDir: string): DownloadOutcome {
  if (modelCached(modelCacheDir)) {
    return "already-cached";
  }
  const target = modelCachePath(modelCacheDir);
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  renameSync(fetchedPath, target);
  return "downloaded";
}

async function fetchAndInstall(
  dirs: DownloadDirs,
  fetchModel: ModelFetcher,
): Promise<DownloadOutcome> {
  mkdirSync(dirs.modelCacheDir, { recursive: true });
  removeStagingLeftovers(dirs.modelCacheDir);
  const staging = mkdtempSync(join(dirs.modelCacheDir, STAGING_DIR_PREFIX));
  try {
    await fetchModel(staging);
    if (!modelCached(staging)) {
      throw new Error(
        `the download finished without the model files at ${modelCachePath(staging)}`,
      );
    }
    return installModel(modelCachePath(staging), dirs.modelCacheDir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function downloadModel(
  dirs: DownloadDirs,
  fetchModel: ModelFetcher,
  clock: () => Date,
): Promise<DownloadOutcome> {
  if (modelCached(dirs.modelCacheDir)) {
    return "already-cached";
  }
  const lock = acquireDownloadLock(dirs.dataDir, clock());
  if (lock === undefined) {
    return "busy";
  }
  try {
    const outcome = await fetchAndInstall(dirs, fetchModel);
    rmSync(downloadFailurePath(dirs.dataDir), { force: true });
    return outcome;
  } catch (error) {
    recordDownloadFailure(dirs.dataDir, {
      failedAt: clock().toISOString(),
      error: failureMessage(error),
    });
    throw error;
  } finally {
    releaseDownloadLock(dirs.dataDir, lock);
  }
}
