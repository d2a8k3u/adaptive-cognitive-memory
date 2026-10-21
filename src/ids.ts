import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();
export const ID_MAX_CHARS = 26;
const PROJECT_ID_HEX_CHARS = 16;
const GIT_QUERY_TIMEOUT_MS = 2_000;
const LOCATION_LINE_COUNT = 2;
const GIT_NOT_INSTALLED_CODE = "ENOENT";
const DUBIOUS_OWNERSHIP = /detected dubious ownership in repository at '([^']+)'/;
const HEAD_FILE = "HEAD";
const BRANCH_REF_PREFIX = "ref: refs/heads/";
const UNREADABLE_HEAD_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EISDIR",
]);

export interface ProjectLocation {
  readonly realpath: string;
  readonly gitCommonDir: string | undefined;
}

export interface LocationFacts extends ProjectLocation {
  readonly dubiousRepository: string | undefined;
  readonly branch: string | undefined;
}

type GitAnswer =
  | {
      readonly kind: "repository";
      readonly commonDir: string;
      readonly gitDir: string | undefined;
    }
  | { readonly kind: "outside" }
  | { readonly kind: "dubious_ownership"; readonly repository: string };

export function newId(): string {
  return ulid();
}

export function isMemoryId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= ID_MAX_CHARS;
}

export function projectIdentity(location: ProjectLocation): string {
  return createHash("sha256")
    .update(location.gitCommonDir ?? location.realpath)
    .digest("hex")
    .slice(0, PROJECT_ID_HEX_CHARS);
}

export function collectLocationFacts(dir: string): LocationFacts {
  const realpath = realpathSync(dir);
  const answer = queryGitLocation(realpath);
  return {
    realpath,
    gitCommonDir: answer.kind === "repository" ? realpathSync(answer.commonDir) : undefined,
    dubiousRepository: answer.kind === "dubious_ownership" ? answer.repository : undefined,
    branch:
      answer.kind === "repository" && answer.gitDir !== undefined
        ? headBranch(answer.gitDir)
        : undefined,
  };
}

export function resolveProjectId(dir: string): string {
  return projectIdentity(collectLocationFacts(dir));
}

function headBranch(gitDir: string): string | undefined {
  const head = readHead(gitDir);
  return head?.startsWith(BRANCH_REF_PREFIX) ? head.slice(BRANCH_REF_PREFIX.length) : undefined;
}

function readHead(gitDir: string): string | undefined {
  try {
    return readFileSync(join(gitDir, HEAD_FILE), "utf8").trim();
  } catch (error) {
    if (headUnreadable(error)) {
      return undefined;
    }
    throw error;
  }
}

function headUnreadable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    UNREADABLE_HEAD_CODES.has(error.code)
  );
}

function unambiguousLocation(stdout: string): GitAnswer | undefined {
  const lines = stdout.trimEnd().split("\n");
  const [commonDir, gitDir] = lines;
  return lines.length === LOCATION_LINE_COUNT && commonDir !== undefined && gitDir !== undefined
    ? { kind: "repository", commonDir, gitDir }
    : undefined;
}

function revParse(dir: string, ...queries: readonly string[]): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", ...queries], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_QUERY_TIMEOUT_MS,
  });
}

function queryGitLocation(dir: string): GitAnswer {
  try {
    return (
      unambiguousLocation(revParse(dir, "--git-common-dir", "--git-dir")) ?? {
        kind: "repository",
        commonDir: revParse(dir, "--git-common-dir").trim(),
        gitDir: undefined,
      }
    );
  } catch (error) {
    if (gitNotInstalled(error)) {
      return { kind: "outside" };
    }
    if (gitRejectedDirectory(error)) {
      return rejectionAnswer(error);
    }
    throw error;
  }
}

function rejectionAnswer(error: Error): GitAnswer {
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  const repository = DUBIOUS_OWNERSHIP.exec(stderr)?.[1];
  return repository === undefined ? { kind: "outside" } : { kind: "dubious_ownership", repository };
}

function gitNotInstalled(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === GIT_NOT_INSTALLED_CODE;
}

function gitRejectedDirectory(error: unknown): error is Error {
  return (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status !== 0
  );
}
