import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BADGE_STATE_VERSION = 1;
export const MARKER_VERSION = 1;
export const MARKER_FILE = "enabled.json";
export const SESSIONS_DIR = "sessions";

const BADGE_MAX_CHARS = 40;
const STDIN_MAX_BYTES = 65_536;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_NAME_PATTERN = /^[A-Za-z]{1,40}$/;
const UNREADABLE_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EACCES"]);

export type BadgeSessionId = string & { readonly brand: "BadgeSessionId" };

export interface BadgeState {
  readonly version: typeof BADGE_STATE_VERSION;
  readonly session_id: BadgeSessionId;
  readonly injected: number;
  readonly last_event: string;
  readonly last_at: string;
  readonly recall: "on" | "off";
}

export interface StatuslineMarker {
  readonly version: typeof MARKER_VERSION;
  readonly enabled_at: string;
  readonly shim_sha256: string;
}

export function isBadgeSessionId(value: unknown): value is BadgeSessionId {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function stateFileName(sessionId: BadgeSessionId): string {
  return `${sessionId}.json`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export function badgeLine(state: BadgeState): string {
  if (state.recall === "off") {
    return "mem off";
  }
  const at = new Date(state.last_at);
  const time = `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;
  return `mem ${state.injected} · last ${state.last_event} ${time}`.slice(0, BADGE_MAX_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isEventName(value: unknown): value is string {
  return typeof value === "string" && EVENT_NAME_PATTERN.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function badgeStateFrom(value: unknown): BadgeState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { version, session_id, injected, last_event, last_at, recall } = value;
  return version === BADGE_STATE_VERSION &&
    isBadgeSessionId(session_id) &&
    isCount(injected) &&
    isEventName(last_event) &&
    isTimestamp(last_at) &&
    (recall === "on" || recall === "off")
    ? { version, session_id, injected, last_event, last_at, recall }
    : undefined;
}

export function markerFrom(value: unknown): StatuslineMarker | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { version, enabled_at, shim_sha256 } = value;
  return version === MARKER_VERSION && isTimestamp(enabled_at) && typeof shim_sha256 === "string"
    ? { version, enabled_at, shim_sha256 }
    : undefined;
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

function isUnreadable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    UNREADABLE_CODES.has(error.code)
  );
}

export function fileJson(path: string): unknown {
  try {
    return parsedJson(readFileSync(path, "utf8"));
  } catch (error) {
    if (isUnreadable(error)) {
      return undefined;
    }
    throw error;
  }
}

function sessionIdFrom(stdin: string): BadgeSessionId | undefined {
  const input = parsedJson(stdin);
  const sessionId = isRecord(input) ? input.session_id : undefined;
  return isBadgeSessionId(sessionId) ? sessionId : undefined;
}

function badgeFor(dir: string, sessionId: BadgeSessionId): string | undefined {
  if (markerFrom(fileJson(join(dir, MARKER_FILE))) === undefined) {
    return undefined;
  }
  const state = badgeStateFrom(fileJson(join(dir, SESSIONS_DIR, stateFileName(sessionId))));
  return state === undefined ? undefined : badgeLine(state);
}

function boundedStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    process.stdin.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > STDIN_MAX_BYTES) {
        process.stdin.destroy();
        resolve("");
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function main(): Promise<void> {
  const sessionId = sessionIdFrom(await boundedStdin());
  const line = sessionId === undefined ? undefined : badgeFor(__dirname, sessionId);
  if (line !== undefined) {
    process.stdout.write(`${line}\n`);
  }
}

if (require.main === module) {
  void main();
}
