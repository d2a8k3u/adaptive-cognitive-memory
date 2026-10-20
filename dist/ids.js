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
const ulid_1 = require("ulid");
const ulid = (0, ulid_1.monotonicFactory)();
exports.ID_MAX_CHARS = 26;
const PROJECT_ID_HEX_CHARS = 16;
const GIT_QUERY_TIMEOUT_MS = 2_000;
const GIT_NOT_INSTALLED_CODE = "ENOENT";
const DUBIOUS_OWNERSHIP = /detected dubious ownership in repository at '([^']+)'/;
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
    const answer = queryGitCommonDir(realpath);
    return {
        realpath,
        gitCommonDir: answer.kind === "repository" ? (0, node_fs_1.realpathSync)(answer.commonDir) : undefined,
        dubiousRepository: answer.kind === "dubious_ownership" ? answer.repository : undefined,
    };
}
function resolveProjectId(dir) {
    return projectIdentity(collectLocationFacts(dir));
}
function queryGitCommonDir(dir) {
    try {
        const commonDir = (0, node_child_process_1.execFileSync)("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_QUERY_TIMEOUT_MS }).trim();
        return { kind: "repository", commonDir };
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
