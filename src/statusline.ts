import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  type BadgeState,
  fileJson,
  MARKER_FILE,
  MARKER_VERSION,
  markerFrom,
  SESSIONS_DIR,
  type StatuslineMarker,
  stateFileName,
} from "./statusline/badge";

const STATUSLINE_DIR = "statusline";
const SHIM_FILE = "badge.cjs";
const DIST_SHIM_FILE = "badge.js";
const DOUBLE_QUOTE_SPECIALS = /["$`\\\n]/;

export interface StatuslinePaths {
  readonly root: string;
  readonly marker: string;
  readonly shim: string;
  readonly sessions: string;
}

export function statuslinePaths(dataDir: string): StatuslinePaths {
  const root = join(resolve(dataDir), STATUSLINE_DIR);
  return {
    root,
    marker: join(root, MARKER_FILE),
    shim: join(root, SHIM_FILE),
    sessions: join(root, SESSIONS_DIR),
  };
}

export function statuslineEnabled(paths: StatuslinePaths): boolean {
  return existsSync(paths.marker);
}

export function distShim(): Buffer {
  return readFileSync(join(__dirname, STATUSLINE_DIR, DIST_SHIM_FILE));
}

export function snippetLine(shimPath: string): string {
  if (DOUBLE_QUOTE_SPECIALS.test(shimPath)) {
    throw new Error(
      `${JSON.stringify(shimPath)} cannot be quoted in the statusline snippet: move CLAUDE_PLUGIN_DATA to a path without " $ \` \\ or a line break`,
    );
  }
  return `{ test -f "${shimPath}" && node "${shimPath}"; } || :`;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function markerText(enabledAt: string, shimSha: string): string {
  const marker: StatuslineMarker = {
    version: MARKER_VERSION,
    enabled_at: enabledAt,
    shim_sha256: shimSha,
  };
  return JSON.stringify(marker);
}

function replaceFile(path: string, content: string | Buffer): void {
  const staging = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(staging, content);
  renameSync(staging, path);
}

export function writeBadgeState(paths: StatuslinePaths, state: BadgeState): void {
  replaceFile(join(paths.sessions, stateFileName(state.session_id)), JSON.stringify(state));
}

export function refreshShim(paths: StatuslinePaths, shimSource: Buffer): void {
  const shimSha = sha256(shimSource);
  const marker = markerFrom(fileJson(paths.marker));
  if (marker === undefined || marker.shim_sha256 === shimSha) {
    return;
  }
  replaceFile(paths.shim, shimSource);
  replaceFile(paths.marker, markerText(marker.enabled_at, shimSha));
}

export function pruneBadgeStates(paths: StatuslinePaths, cutoff: string): void {
  const cutoffMs = Date.parse(cutoff);
  for (const name of readdirSync(paths.sessions)) {
    const file = join(paths.sessions, name);
    const stats = statSync(file, { throwIfNoEntry: false });
    if (stats !== undefined && stats.mtimeMs < cutoffMs) {
      rmSync(file, { force: true });
    }
  }
}

export function enableStatusline(dataDir: string, shimSource: Buffer, now: string): string {
  const paths = statuslinePaths(dataDir);
  const snippet = snippetLine(paths.shim);
  mkdirSync(paths.sessions, { recursive: true });
  replaceFile(paths.shim, shimSource);
  replaceFile(paths.marker, markerText(now, sha256(shimSource)));
  return snippet;
}

export function disableStatusline(dataDir: string): string {
  const paths = statuslinePaths(dataDir);
  const snippet = snippetLine(paths.shim);
  rmSync(paths.root, { recursive: true, force: true });
  return snippet;
}
