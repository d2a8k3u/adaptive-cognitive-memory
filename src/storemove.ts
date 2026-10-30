import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { type Config, DB_FILENAME } from "./cfg";
import { isStorageRejection } from "./db/database";
import { type StoreDigest, storeDigest } from "./db/digest";
import { snippetLine, statuslineEnabled, statuslinePaths } from "./statusline";
import { ensureDataDir, movedMarkerTarget, writeMovedMarker } from "./storelocation";

export interface MoveFacts {
  readonly dataDir: string;
  readonly sameDir: boolean;
  readonly sourceHasDb: boolean;
  readonly sourceMovedTo: string | undefined;
  readonly destHasDb: boolean;
  readonly journalSource: string | undefined;
  readonly sourceRealPath: string;
}

export type MovePlan =
  | { readonly kind: "start" }
  | { readonly kind: "resume-publish" }
  | { readonly kind: "already-moved"; readonly movedTo: string }
  | { readonly kind: "refuse"; readonly reason: string };

export type MoveStep =
  | "stage-auxiliary"
  | "lock-source"
  | "copy-database"
  | "verify-staging"
  | "write-journal"
  | "publish-store"
  | "mark-source"
  | "unlock-source"
  | "remove-staging";

export type MoveOutcome =
  | {
      readonly kind: "moved";
      readonly digest: StoreDigest;
      readonly statuslineSnippet: string | undefined;
    }
  | { readonly kind: "already-moved"; readonly movedTo: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "verification-failed"; readonly reason: string };

type Refused = Extract<MoveOutcome, { kind: "refused" }>;

type CopyCheck =
  | { readonly ok: true; readonly digest: StoreDigest }
  | { readonly ok: false; readonly reason: string };

interface SourceLock {
  readonly anchor: Database.Database;
  readonly writer: Database.Database;
}

interface MoveJournal {
  readonly version: typeof JOURNAL_VERSION;
  readonly source: string;
  readonly digest: string;
}

interface MoveRun {
  readonly fromDir: string;
  readonly config: Config;
  readonly now: string;
  readonly statuslineSnippet: string | undefined;
  readonly afterStep: (step: MoveStep) => void;
}

const STAGING_DIR = ".moving";
const JOURNAL_FILE = "journal.json";
const JOURNAL_VERSION = 1;
const WAL_SUFFIX = "-wal";
const AUXILIARY_DIRS = ["models", "statusline"] as const;
const BUSY_TIMEOUT_MS = 5000;
const FILE_EXISTS_CODE = "EEXIST";
const INTEGRITY_OK = "ok";
const INTEGRITY_DATABASE_HEADER = "***";
const CLONE_NEW_FILE = constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL;

function refusal(reason: string): MovePlan {
  return { kind: "refuse", reason };
}

export function planMove(facts: MoveFacts): MovePlan {
  if (facts.sameDir) {
    return refusal("source and destination are the same directory");
  }
  if (!facts.sourceHasDb) {
    return refusal(`no ${DB_FILENAME} in ${facts.sourceRealPath}`);
  }
  if (facts.sourceMovedTo !== undefined) {
    return facts.destHasDb
      ? { kind: "already-moved", movedTo: facts.sourceMovedTo }
      : refusal(
          `source is marked as moved to ${facts.sourceMovedTo}, but ${facts.dataDir} has no store`,
        );
  }
  if (facts.destHasDb) {
    return facts.journalSource === facts.sourceRealPath
      ? { kind: "resume-publish" }
      : refusal(
          `a store already exists in ${facts.dataDir}; move it aside and run the move again (docs/storage.md)`,
        );
  }
  return { kind: "start" };
}

export function hasRoom(freeBytes: number, neededBytes: number): boolean {
  return freeBytes >= neededBytes;
}

function refused(reason: string): Refused {
  return { kind: "refused", reason };
}

function digestTag(digest: StoreDigest): string {
  return `sha256:${digest.sha256}`;
}

function stagingDir(dataDir: string): string {
  return join(dataDir, STAGING_DIR);
}

function sourceDbPath(fromDir: string): string {
  return join(fromDir, DB_FILENAME);
}

function realOrResolved(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function journalSourceIn(dataDir: string): string | undefined {
  const path = join(stagingDir(dataDir), JOURNAL_FILE);
  if (!existsSync(path)) {
    return undefined;
  }
  const journal = parsedJson(readFileSync(path, "utf8"));
  if (typeof journal !== "object" || journal === null || !("source" in journal)) {
    return undefined;
  }
  return typeof journal.source === "string" ? journal.source : undefined;
}

function gatherFacts(fromDir: string, dataDir: string): MoveFacts {
  const sourceRealPath = realOrResolved(fromDir);
  return {
    dataDir,
    sameDir: sourceRealPath === realOrResolved(dataDir),
    sourceHasDb: existsSync(sourceDbPath(fromDir)),
    sourceMovedTo: movedMarkerTarget(fromDir),
    destHasDb: existsSync(join(dataDir, DB_FILENAME)),
    journalSource: journalSourceIn(dataDir),
    sourceRealPath,
  };
}

function nearestExistingAncestor(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    current = dirname(current);
  }
  return current;
}

function sizeOfTree(path: string): number {
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    return stats.size;
  }
  return readdirSync(path).reduce((sum, name) => sum + sizeOfTree(join(path, name)), 0);
}

function sizeIfPresent(path: string): number {
  return existsSync(path) ? sizeOfTree(path) : 0;
}

function auxiliaryToStage(fromDir: string, dataDir: string): string[] {
  return AUXILIARY_DIRS.filter(
    (name) => existsSync(join(fromDir, name)) && !existsSync(join(dataDir, name)),
  );
}

function neededBytes(fromDir: string, dataDir: string): number {
  const sourceDb = sourceDbPath(fromDir);
  return (
    sizeOfTree(sourceDb) +
    sizeIfPresent(`${sourceDb}${WAL_SUFFIX}`) +
    auxiliaryToStage(fromDir, dataDir).reduce(
      (sum, name) => sum + sizeOfTree(join(fromDir, name)),
      0,
    )
  );
}

function freeBytesBelow(dataDir: string): number {
  const stats = statfsSync(nearestExistingAncestor(dataDir));
  return stats.bsize * stats.bavail;
}

function stageAuxiliary(fromDir: string, config: Config): Refused | undefined {
  const needed = neededBytes(fromDir, config.dataDir);
  const free = freeBytesBelow(config.dataDir);
  if (!hasRoom(free, needed)) {
    return refused(
      `insufficient space in ${config.dataDir}: ${needed} bytes needed, ${free} bytes free`,
    );
  }
  ensureDataDir(config);
  const staging = stagingDir(config.dataDir);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  for (const name of auxiliaryToStage(fromDir, config.dataDir)) {
    cpSync(join(fromDir, name), join(staging, name), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
  }
  return undefined;
}

function lockSource(sourceDb: string): SourceLock | Refused {
  const anchor = new Database(sourceDb, { readonly: true });
  const writer = new Database(sourceDb);
  try {
    anchor.prepare("SELECT count(*) FROM sqlite_schema").get();
    writer.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    writer.exec("BEGIN IMMEDIATE");
    return { anchor, writer };
  } catch (error) {
    writer.close();
    anchor.close();
    if (isStorageRejection(error)) {
      return refused(
        `the source store is busy: another session held its write lock for more than ${BUSY_TIMEOUT_MS} ms`,
      );
    }
    throw error;
  }
}

function releaseSource(lock: SourceLock): void {
  if (lock.writer.inTransaction) {
    lock.writer.exec("ROLLBACK");
  }
  lock.writer.close();
  lock.anchor.close();
}

function copyDatabase(sourceDb: string, staging: string): void {
  copyFileSync(sourceDb, join(staging, DB_FILENAME), CLONE_NEW_FILE);
  const wal = `${sourceDb}${WAL_SUFFIX}`;
  if (existsSync(wal)) {
    copyFileSync(wal, join(staging, `${DB_FILENAME}${WAL_SUFFIX}`), CLONE_NEW_FILE);
  }
}

function differingTables(source: StoreDigest, copy: StoreDigest): string[] {
  const names = new Set([...source.tables, ...copy.tables].map((table) => table.table));
  return [...names]
    .sort()
    .filter(
      (name) =>
        source.tables.find((table) => table.table === name)?.sha256 !==
        copy.tables.find((table) => table.table === name)?.sha256,
    );
}

function firstIntegrityProblem(report: string): string {
  const lines = report.split("\n");
  return lines.find((line) => !line.startsWith(INTEGRITY_DATABASE_HEADER)) ?? report;
}

function checkCopy(writer: Database.Database, copy: Database.Database, fromDir: string): CopyCheck {
  const integrity = String(copy.pragma("integrity_check", { simple: true }));
  if (integrity !== INTEGRITY_OK) {
    return {
      ok: false,
      reason: `integrity_check of the copy reported: ${firstIntegrityProblem(integrity)}`,
    };
  }
  const source = storeDigest(writer);
  const copied = storeDigest(copy);
  if (source.sha256 !== copied.sha256) {
    return {
      ok: false,
      reason: `the copy of ${fromDir} differs from the source in ${differingTables(source, copied).join(", ")}`,
    };
  }
  return { ok: true, digest: source };
}

function verifyStaging(writer: Database.Database, staging: string, fromDir: string): CopyCheck {
  const stagedDb = join(staging, DB_FILENAME);
  const staged = new Database(stagedDb);
  let check: CopyCheck;
  try {
    check = checkCopy(writer, staged, fromDir);
    if (check.ok) {
      staged.pragma("wal_checkpoint(TRUNCATE)");
    }
  } finally {
    staged.close();
  }
  if (check.ok && sizeIfPresent(`${stagedDb}${WAL_SUFFIX}`) > 0) {
    throw new Error(`the staged copy ${stagedDb} kept WAL frames after its checkpoint`);
  }
  return check;
}

function verifyPublished(writer: Database.Database, finalDb: string, fromDir: string): CopyCheck {
  const published = new Database(finalDb);
  try {
    published.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return checkCopy(writer, published, fromDir);
  } finally {
    published.close();
  }
}

function writeJournal(staging: string, sourceRealPath: string, digest: StoreDigest): void {
  const journal: MoveJournal = {
    version: JOURNAL_VERSION,
    source: sourceRealPath,
    digest: digestTag(digest),
  };
  const path = join(staging, JOURNAL_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(journal)}\n`);
  renameSync(temp, path);
}

function fileExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === FILE_EXISTS_CODE;
}

function placeAuxiliary(staging: string, dataDir: string): void {
  for (const name of AUXILIARY_DIRS) {
    const staged = join(staging, name);
    if (existsSync(staged) && !existsSync(join(dataDir, name))) {
      renameSync(staged, join(dataDir, name));
    }
  }
}

function publishStore(staging: string, dataDir: string): Refused | undefined {
  const stagedDb = join(staging, DB_FILENAME);
  try {
    linkSync(stagedDb, join(dataDir, DB_FILENAME));
  } catch (error) {
    if (fileExists(error)) {
      return refused(
        `a store appeared in ${dataDir} while the move ran; move it aside and run the move again (docs/storage.md)`,
      );
    }
    throw error;
  }
  unlinkSync(stagedDb);
  placeAuxiliary(staging, dataDir);
  return undefined;
}

function markSource(run: MoveRun, digest: StoreDigest): MoveOutcome {
  writeMovedMarker(run.fromDir, realpathSync(run.config.dataDir), digestTag(digest), run.now);
  run.afterStep("mark-source");
  return { kind: "moved", digest, statuslineSnippet: run.statuslineSnippet };
}

function startUnderLock(lock: SourceLock, run: MoveRun): MoveOutcome {
  const { fromDir, config, afterStep } = run;
  const staging = stagingDir(config.dataDir);
  copyDatabase(sourceDbPath(fromDir), staging);
  afterStep("copy-database");
  const verified = verifyStaging(lock.writer, staging, fromDir);
  if (!verified.ok) {
    return { kind: "verification-failed", reason: verified.reason };
  }
  afterStep("verify-staging");
  writeJournal(staging, realpathSync(fromDir), verified.digest);
  afterStep("write-journal");
  const occupied = publishStore(staging, config.dataDir);
  if (occupied !== undefined) {
    return occupied;
  }
  afterStep("publish-store");
  return markSource(run, verified.digest);
}

function resumeUnderLock(lock: SourceLock, run: MoveRun): MoveOutcome {
  const { fromDir, config, afterStep } = run;
  const verified = verifyPublished(lock.writer, join(config.dataDir, DB_FILENAME), fromDir);
  if (!verified.ok) {
    return refused(`the store in ${config.dataDir} differs from ${fromDir}`);
  }
  afterStep("verify-staging");
  placeAuxiliary(stagingDir(config.dataDir), config.dataDir);
  afterStep("publish-store");
  return markSource(run, verified.digest);
}

function underLock(lock: SourceLock, run: MoveRun): MoveOutcome {
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

function removeStaging(dataDir: string): void {
  rmSync(stagingDir(dataDir), { recursive: true, force: true });
}

function statuslineSnippetFor(fromDir: string, dataDir: string): string | undefined {
  return statuslineEnabled(statuslinePaths(fromDir))
    ? snippetLine(statuslinePaths(dataDir).shim)
    : undefined;
}

export function moveStore(
  fromDir: string,
  config: Config,
  now: string,
  afterStep: (step: MoveStep) => void = () => {},
): MoveOutcome {
  const run: MoveRun = {
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
  let outcome: MoveOutcome;
  try {
    afterStep("lock-source");
    outcome = underLock(lock, run);
  } finally {
    releaseSource(lock);
  }
  afterStep("unlock-source");
  removeStaging(config.dataDir);
  afterStep("remove-staging");
  return outcome;
}
