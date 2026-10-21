"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ID_MAX_CHARS = void 0;
exports.newId = newId;
exports.isMemoryId = isMemoryId;
exports.projectIdentity = projectIdentity;
exports.collectLocationFacts = collectLocationFacts;
exports.resolveProjectId = resolveProjectId;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const ulid_1 = require("ulid");
const ulid = (0, ulid_1.monotonicFactory)();
exports.ID_MAX_CHARS = 26;
const PROJECT_ID_HEX_CHARS = 16;
const GIT_QUERY_TIMEOUT_MS = 2_000;
const GIT_NOT_INSTALLED_CODE = "ENOENT";
const DUBIOUS_OWNERSHIP = /detected dubious ownership in repository at '([^']+)'/;
const HEAD_FILE = "HEAD";
const BRANCH_REF_PREFIX = "ref: refs/heads/";
const UNREADABLE_HEAD_CODES = new Set([
    "ENOENT",
    "ENOTDIR",
    "EACCES",
    "EISDIR",
]);
function newId() {
    return ulid();
}
function isMemoryId(value) {
    return typeof value === "string" && value !== "" && value.length <= exports.ID_MAX_CHARS;
}
function projectIdentity(location) {
    return (0, node_crypto_1.createHash)("sha256")
        .update(location.gitCommonDir ?? location.realpath)
        .digest("hex")
        .slice(0, PROJECT_ID_HEX_CHARS);
}
function collectLocationFacts(dir) {
    const realpath = (0, node_fs_1.realpathSync)(dir);
    const answer = queryGitLocation(realpath);
    return {
        realpath,
        gitCommonDir: answer.kind === "repository" ? (0, node_fs_1.realpathSync)(answer.commonDir) : undefined,
        dubiousRepository: answer.kind === "dubious_ownership" ? answer.repository : undefined,
        branch: answer.kind === "repository" ? headBranch(answer.gitDir) : undefined,
    };
}
function resolveProjectId(dir) {
    return projectIdentity(collectLocationFacts(dir));
}
function headBranch(gitDir) {
    const head = readHead(gitDir);
    return head?.startsWith(BRANCH_REF_PREFIX) ? head.slice(BRANCH_REF_PREFIX.length) : undefined;
}
function readHead(gitDir) {
    try {
        return (0, node_fs_1.readFileSync)((0, node_path_1.join)(gitDir, HEAD_FILE), "utf8").trim();
    }
    catch (error) {
        if (headUnreadable(error)) {
            return undefined;
        }
        throw error;
    }
}
function headUnreadable(error) {
    return (error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        UNREADABLE_HEAD_CODES.has(error.code));
}
function repositoryAnswer(stdout) {
    const lines = stdout.trimEnd().split("\n");
    const [commonDir, gitDir] = lines;
    if (lines.length !== 2 || commonDir === undefined || gitDir === undefined) {
        throw new Error(`git rev-parse answered ${lines.length} lines instead of the common dir and the git dir`);
    }
    return { kind: "repository", commonDir, gitDir };
}
function queryGitLocation(dir) {
    try {
        return repositoryAnswer((0, node_child_process_1.execFileSync)("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_QUERY_TIMEOUT_MS }));
    }
    catch (error) {
        if (gitNotInstalled(error)) {
            return { kind: "outside" };
        }
        if (gitRejectedDirectory(error)) {
            return rejectionAnswer(error);
        }
        throw error;
    }
}
function rejectionAnswer(error) {
    const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    const repository = DUBIOUS_OWNERSHIP.exec(stderr)?.[1];
    return repository === undefined ? { kind: "outside" } : { kind: "dubious_ownership", repository };
}
function gitNotInstalled(error) {
    return error instanceof Error && "code" in error && error.code === GIT_NOT_INSTALLED_CODE;
}
function gitRejectedDirectory(error) {
    return (error instanceof Error &&
        "status" in error &&
        typeof error.status === "number" &&
        error.status !== 0);
}
