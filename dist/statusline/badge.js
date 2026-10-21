"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSIONS_DIR = exports.MARKER_FILE = exports.MARKER_VERSION = exports.BADGE_STATE_VERSION = void 0;
exports.isBadgeSessionId = isBadgeSessionId;
exports.stateFileName = stateFileName;
exports.badgeLine = badgeLine;
exports.markerFrom = markerFrom;
exports.fileJson = fileJson;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
exports.BADGE_STATE_VERSION = 1;
exports.MARKER_VERSION = 1;
exports.MARKER_FILE = "enabled.json";
exports.SESSIONS_DIR = "sessions";
const BADGE_MAX_CHARS = 40;
const STDIN_MAX_BYTES = 65_536;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_NAME_PATTERN = /^[A-Za-z]{1,40}$/;
const UNREADABLE_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES"]);
function isBadgeSessionId(value) {
    return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}
function stateFileName(sessionId) {
    return `${sessionId}.json`;
}
function twoDigits(value) {
    return String(value).padStart(2, "0");
}
function badgeLine(state) {
    if (state.recall === "off") {
        return "mem off";
    }
    const at = new Date(state.last_at);
    const time = `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;
    return `mem ${state.injected} · last ${state.last_event} ${time}`.slice(0, BADGE_MAX_CHARS);
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function isCount(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isEventName(value) {
    return typeof value === "string" && EVENT_NAME_PATTERN.test(value);
}
function isTimestamp(value) {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
function badgeStateFrom(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { version, session_id, injected, last_event, last_at, recall } = value;
    return version === exports.BADGE_STATE_VERSION &&
        isBadgeSessionId(session_id) &&
        isCount(injected) &&
        isEventName(last_event) &&
        isTimestamp(last_at) &&
        (recall === "on" || recall === "off")
        ? { version, session_id, injected, last_event, last_at, recall }
        : undefined;
}
function markerFrom(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { version, enabled_at, shim_sha256 } = value;
    return version === exports.MARKER_VERSION && isTimestamp(enabled_at) && typeof shim_sha256 === "string"
        ? { version, enabled_at, shim_sha256 }
        : undefined;
}
function parsedJson(text) {
    try {
        return JSON.parse(text);
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
}
function isUnreadable(error) {
    return (error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        UNREADABLE_CODES.has(error.code));
}
function fileJson(path) {
    try {
        return parsedJson((0, node_fs_1.readFileSync)(path, "utf8"));
    }
    catch (error) {
        if (isUnreadable(error)) {
            return undefined;
        }
        throw error;
    }
}
function sessionIdFrom(stdin) {
    const input = parsedJson(stdin);
    const sessionId = isRecord(input) ? input.session_id : undefined;
    return isBadgeSessionId(sessionId) ? sessionId : undefined;
}
function badgeFor(dir, sessionId) {
    if (markerFrom(fileJson((0, node_path_1.join)(dir, exports.MARKER_FILE))) === undefined) {
        return undefined;
    }
    const state = badgeStateFrom(fileJson((0, node_path_1.join)(dir, exports.SESSIONS_DIR, stateFileName(sessionId))));
    return state === undefined ? undefined : badgeLine(state);
}
function boundedStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        process.stdin.on("data", (chunk) => {
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
async function main() {
    const sessionId = sessionIdFrom(await boundedStdin());
    const line = sessionId === undefined ? undefined : badgeFor(__dirname, sessionId);
    if (line !== undefined) {
        process.stdout.write(`${line}\n`);
    }
}
if (require.main === module) {
    void main();
}
