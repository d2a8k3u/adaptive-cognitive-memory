import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();
const PROJECT_ID_HEX_CHARS = 16;
const GIT_QUERY_TIMEOUT_MS = 2_000;
const GIT_NOT_INSTALLED_CODE = "ENOENT";
const DUBIOUS_OWNERSHIP = /detected dubious ownership in repository at '([^']+)'/;

export interface ProjectLocation {
  readonly realpath: string;
  readonly gitCommonDir: string | undefined;
}

export interface LocationFacts extends ProjectLocation {
  readonly dubiousRepository: string | undefined;
}

type GitAnswer =
  | { readonly kind: "repository"; readonly commonDir: string }
  | { readonly kind: "outside" }
  | { readonly kind: "dubious_ownership"; readonly repository: string };

export function newId(): string {
  return ulid();
}

export function projectIdentity(location: ProjectLocation): string {
  return createHash("sha256")
    .update(location.gitCommonDir ?? location.realpath)
    .digest("hex")
    .slice(0, PROJECT_ID_HEX_CHARS);
}

export function collectLocationFacts(dir: string): LocationFacts {
  const realpath = realpathSync(dir);
  const answer = queryGitCommonDir(realpath);
  return {
    realpath,
    gitCommonDir: answer.kind === "repository" ? realpathSync(answer.commonDir) : undefined,
    dubiousRepository: answer.kind === "dubious_ownership" ? answer.repository : undefined,
  };
}

export function resolveProjectId(dir: string): string {
  return projectIdentity(collectLocationFacts(dir));
}

function queryGitCommonDir(dir: string): GitAnswer {
  try {
    const commonDir = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_QUERY_TIMEOUT_MS },
    ).trim();
    return { kind: "repository", commonDir };
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
