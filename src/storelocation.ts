import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type Config, DATA_DIR_ENV, DB_FILENAME, storePaths } from "./cfg";
import { CLI_ENTRY, type HostProfile } from "./host";
import { PLUGIN_NAME } from "./version";

export const MOVED_MARKER_FILE = "moved.json";

export interface LegacyFacts {
  readonly dir: string;
  readonly hasDb: boolean;
  readonly markerPresent: boolean;
  readonly movedTo: string | undefined;
  readonly movedToExists: boolean;
  readonly dataDirRealPath: string | undefined;
}

export type StoreState =
  | { readonly kind: "shared" }
  | { readonly kind: "legacy"; readonly legacyDir: string }
  | { readonly kind: "moved-elsewhere"; readonly movedTo: string; readonly targetExists: boolean };

const MARKER_VERSION = 1;

interface MovedMarker {
  readonly version: typeof MARKER_VERSION;
  readonly movedTo: string;
  readonly movedAt: string;
  readonly digest: string;
}

const SHARED: StoreState = { kind: "shared" };

export function storeState(dataDir: string, legacy: LegacyFacts | undefined): StoreState {
  if (legacy === undefined) {
    return SHARED;
  }
  if (
    legacy.markerPresent &&
    legacy.movedTo !== undefined &&
    legacy.movedTo !== legacy.dataDirRealPath
  ) {
    return { kind: "moved-elsewhere", movedTo: legacy.movedTo, targetExists: legacy.movedToExists };
  }
  if (legacy.markerPresent) {
    return SHARED;
  }
  if (resolve(legacy.dir) !== resolve(dataDir) && legacy.hasDb) {
    return { kind: "legacy", legacyDir: legacy.dir };
  }
  return SHARED;
}

function markerPath(legacyDir: string): string {
  return join(legacyDir, MOVED_MARKER_FILE);
}

function parsedMarker(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function markerTarget(text: string): string | undefined {
  const marker = parsedMarker(text);
  if (typeof marker !== "object" || marker === null || !("movedTo" in marker)) {
    return undefined;
  }
  const movedTo = marker.movedTo;
  return typeof movedTo === "string" && isAbsolute(movedTo) ? movedTo : undefined;
}

function existingRealPath(dir: string): string | undefined {
  return existsSync(dir) ? realpathSync(dir) : undefined;
}

export function legacyFacts(
  profile: HostProfile,
  env: NodeJS.ProcessEnv,
  dataDir: string,
): LegacyFacts | undefined {
  const dir = profile.legacyDataEnv === undefined ? undefined : env[profile.legacyDataEnv];
  if (dir === undefined || dir === "") {
    return undefined;
  }
  const hasDb = existsSync(join(dir, DB_FILENAME));
  if (!existsSync(markerPath(dir))) {
    return {
      dir,
      hasDb,
      markerPresent: false,
      movedTo: undefined,
      movedToExists: false,
      dataDirRealPath: undefined,
    };
  }
  const movedTo = markerTarget(readFileSync(markerPath(dir), "utf8"));
  return {
    dir,
    hasDb,
    markerPresent: true,
    movedTo,
    movedToExists: movedTo !== undefined && existsSync(movedTo),
    dataDirRealPath: existingRealPath(dataDir),
  };
}

function storeDir(state: StoreState): string | undefined {
  switch (state.kind) {
    case "shared":
      return undefined;
    case "legacy":
      return state.legacyDir;
    case "moved-elsewhere":
      return state.targetExists ? state.movedTo : undefined;
  }
}

export function storeConfig(config: Config, state: StoreState, env: NodeJS.ProcessEnv): Config {
  const dir = storeDir(state);
  return dir === undefined ? config : { ...config, ...storePaths(dir, env) };
}

export function storeNotice(state: StoreState, dataDir: string): string | undefined {
  switch (state.kind) {
    case "shared":
      return undefined;
    case "legacy":
      return `${PLUGIN_NAME} uses the Claude Code store in ${state.legacyDir}; Codex and OpenCode use ${dataDir}. To share one store: with this plugin version installed, quit every Claude Code session, then run from a terminal: ${DATA_DIR_ENV}="${dataDir}" node "${CLI_ENTRY}" store move --from "${state.legacyDir}"`;
    case "moved-elsewhere":
      return state.targetExists
        ? `${PLUGIN_NAME}: the Claude Code store was moved to ${state.movedTo}, but ${DATA_DIR_ENV} resolves to ${dataDir}; this session uses ${state.movedTo}. Set ${DATA_DIR_ENV}="${state.movedTo}" for Claude Code, Codex and OpenCode.`
        : `${PLUGIN_NAME}: the Claude Code store was moved to ${state.movedTo}, which does not exist; memory is off for this session. Set ${DATA_DIR_ENV} to the directory that holds the moved store.`;
  }
}

const OWNER_ONLY_DIR_MODE = 0o700;

export function ensureDataDir(config: Config): void {
  mkdirSync(config.dataDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
}

export function sourceMoved(legacyDir: string): boolean {
  return existsSync(markerPath(legacyDir));
}

export function writeMovedMarker(
  legacyDir: string,
  dataDirRealPath: string,
  digest: string,
  now: string,
): void {
  const marker: MovedMarker = {
    version: MARKER_VERSION,
    movedTo: dataDirRealPath,
    movedAt: now,
    digest,
  };
  const staged = `${markerPath(legacyDir)}.${process.pid}.tmp`;
  writeFileSync(staged, `${JSON.stringify(marker)}\n`);
  renameSync(staged, markerPath(legacyDir));
}
