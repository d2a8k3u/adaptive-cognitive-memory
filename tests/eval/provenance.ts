import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fixtureDigest } from "./fixtures";

export const REPO_ROOT = process.cwd();
export const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "eval");
export const RESULTS_DIR = join(REPO_ROOT, "eval-results");

const SOURCE_PATHS = ["src", "dist", "hooks", ".claude-plugin", ".mcp.json"];

export interface RunMeta {
  readonly run_id: string;
  readonly git_sha: string;
  readonly source_dirty: boolean;
  readonly fixture_digest: string;
  readonly sample: number | null;
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

export function runMeta(sample: number | undefined): RunMeta {
  return {
    run_id: `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`,
    git_sha: git(["rev-parse", "HEAD"]),
    source_dirty: git(["status", "--porcelain", "--", ...SOURCE_PATHS]) !== "",
    fixture_digest: fixtureDigest(FIXTURE_DIR),
    sample: sample ?? null,
  };
}
