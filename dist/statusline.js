"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.statuslinePaths = statuslinePaths;
exports.statuslineEnabled = statuslineEnabled;
exports.distShim = distShim;
exports.snippetLine = snippetLine;
exports.writeBadgeState = writeBadgeState;
exports.refreshShim = refreshShim;
exports.pruneBadgeStates = pruneBadgeStates;
exports.enableStatusline = enableStatusline;
exports.disableStatusline = disableStatusline;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const badge_1 = require("./statusline/badge");
const STATUSLINE_DIR = "statusline";
const SHIM_FILE = "badge.cjs";
const DIST_SHIM_FILE = "badge.js";
const DOUBLE_QUOTE_SPECIALS = /["$`\\\n]/;
function statuslinePaths(dataDir) {
    const root = (0, node_path_1.join)((0, node_path_1.resolve)(dataDir), STATUSLINE_DIR);
    return {
        root,
        marker: (0, node_path_1.join)(root, badge_1.MARKER_FILE),
        shim: (0, node_path_1.join)(root, SHIM_FILE),
        sessions: (0, node_path_1.join)(root, badge_1.SESSIONS_DIR),
    };
}
function statuslineEnabled(paths) {
    return (0, node_fs_1.existsSync)(paths.marker);
}
function distShim() {
    return (0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, STATUSLINE_DIR, DIST_SHIM_FILE));
}
function snippetLine(shimPath) {
    if (DOUBLE_QUOTE_SPECIALS.test(shimPath)) {
        throw new Error(`${JSON.stringify(shimPath)} cannot be quoted in the statusline snippet: move CLAUDE_PLUGIN_DATA to a path without " $ \` \\ or a line break`);
    }
    return `{ test -f "${shimPath}" && node "${shimPath}"; } || :`;
}
function sha256(content) {
    return (0, node_crypto_1.createHash)("sha256").update(content).digest("hex");
}
function markerText(enabledAt, shimSha) {
    const marker = {
        version: badge_1.MARKER_VERSION,
        enabled_at: enabledAt,
        shim_sha256: shimSha,
    };
    return JSON.stringify(marker);
}
function replaceFile(path, content) {
    const staging = (0, node_path_1.join)((0, node_path_1.dirname)(path), `.${(0, node_path_1.basename)(path)}.${process.pid}.tmp`);
    (0, node_fs_1.writeFileSync)(staging, content);
    (0, node_fs_1.renameSync)(staging, path);
}
function writeBadgeState(paths, state) {
    replaceFile((0, node_path_1.join)(paths.sessions, (0, badge_1.stateFileName)(state.session_id)), JSON.stringify(state));
}
function refreshShim(paths, shimSource) {
    const shimSha = sha256(shimSource);
    const marker = (0, badge_1.markerFrom)((0, badge_1.fileJson)(paths.marker));
    if (marker === undefined || marker.shim_sha256 === shimSha) {
        return;
    }
    replaceFile(paths.shim, shimSource);
    replaceFile(paths.marker, markerText(marker.enabled_at, shimSha));
}
function pruneBadgeStates(paths, cutoff) {
    const cutoffMs = Date.parse(cutoff);
    for (const name of (0, node_fs_1.readdirSync)(paths.sessions)) {
        const file = (0, node_path_1.join)(paths.sessions, name);
        const stats = (0, node_fs_1.statSync)(file, { throwIfNoEntry: false });
        if (stats !== undefined && stats.mtimeMs < cutoffMs) {
            (0, node_fs_1.rmSync)(file, { force: true });
        }
    }
}
function enableStatusline(dataDir, shimSource, now) {
    const paths = statuslinePaths(dataDir);
    const snippet = snippetLine(paths.shim);
    (0, node_fs_1.mkdirSync)(paths.sessions, { recursive: true });
    replaceFile(paths.shim, shimSource);
    replaceFile(paths.marker, markerText(now, sha256(shimSource)));
    return snippet;
}
function disableStatusline(dataDir) {
    const paths = statuslinePaths(dataDir);
    const snippet = snippetLine(paths.shim);
    (0, node_fs_1.rmSync)(paths.root, { recursive: true, force: true });
    return snippet;
}
