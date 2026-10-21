import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { collectLocationFacts, isMemoryId, newId, projectIdentity } from "../src/ids";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISOLATED_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(dir: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=acm", "-c", "user.email=acm@example.invalid", "-C", dir, ...args],
    { env: ISOLATED_GIT_ENV, stdio: "ignore" },
  );
}

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function fakeGitDir(script: string): string {
  const dir = tempDir("acm-fake-git-");
  const path = join(dir, "git");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("newId", () => {
  it("emits lexicographically sortable ulids", () => {
    const first = newId();
    const second = newId();
    expect(first).toMatch(ULID_PATTERN);
    expect(first < second).toBe(true);
  });
});

describe("isMemoryId", () => {
  it.each([
    { name: "a 26-character legacy id", value: "zz-legacy-0000000000000001", accepted: true },
    { name: "a 27-character id", value: "zz-legacy-00000000000000001", accepted: false },
    { name: "an empty id", value: "", accepted: false },
  ])("treats $name as a memory id: $accepted", ({ value, accepted }) => {
    expect(isMemoryId(value)).toBe(accepted);
  });
});

describe("projectIdentity", () => {
  it.each([
    {
      name: "a subdirectory of a repository shares the repository identity",
      facts: { realpath: "/work/alpha/src/app", gitCommonDir: "/work/alpha/.git" },
      expected: "0c5bcc2e9ee18edd",
    },
    {
      name: "a worktree shares the identity of its common git dir",
      facts: { realpath: "/elsewhere/alpha-feature", gitCommonDir: "/work/alpha/.git" },
      expected: "0c5bcc2e9ee18edd",
    },
    {
      name: "a directory outside git is identified by its real path",
      facts: { realpath: "/work/alpha", gitCommonDir: undefined },
      expected: "017094432d2c0fa9",
    },
    {
      name: "another repository has its own identity",
      facts: { realpath: "/work/alpha", gitCommonDir: "/work/beta/.git" },
      expected: "f4c917f55aca7e78",
    },
  ])("$name", ({ facts, expected }) => {
    expect(projectIdentity(facts)).toBe(expected);
  });
});

describe("collectLocationFacts", () => {
  it("reports one common git dir for the repository root, a nested directory and a worktree", () => {
    const root = tempDir("acm-ids-repo-");
    const nested = join(root, "src", "app");
    mkdirSync(nested, { recursive: true });
    git(root, "init", "-q");
    git(root, "commit", "-q", "--allow-empty", "--no-verify", "-m", "init");
    const worktree = join(tempDir("acm-ids-worktree-"), "feature");
    git(root, "worktree", "add", "-q", "--detach", worktree);
    const expectedCommonDir = join(root, ".git");

    expect([root, nested, worktree].map((dir) => collectLocationFacts(dir).gitCommonDir)).toEqual([
      expectedCommonDir,
      expectedCommonDir,
      expectedCommonDir,
    ]);
    expect(collectLocationFacts(nested).realpath).toBe(nested);
  });

  it("keeps the common git dir identity and reports no branch when the repository path contains a newline", () => {
    const root = tempDir("acm-ids-line\nbreak-");
    git(root, "init", "-q", "-b", "main");

    expect(collectLocationFacts(root)).toEqual({
      realpath: root,
      gitCommonDir: join(root, ".git"),
      dubiousRepository: undefined,
      branch: undefined,
    });
  });

  it("names a repository git refuses on the fallback common dir query as it does on the first query", () => {
    const plain = tempDir("acm-ids-fallback-dubious-");
    vi.stubEnv(
      "PATH",
      fakeGitDir(
        `#!/bin/sh\ncase "$*" in\n*--git-dir*) printf '%s\\n' /repo/new line/.git /repo/new line/.git ;;\n*) echo "fatal: detected dubious ownership in repository at '${plain}'" >&2; exit 128 ;;\nesac\n`,
      ),
    );

    expect(collectLocationFacts(plain)).toEqual({
      realpath: plain,
      gitCommonDir: undefined,
      dubiousRepository: plain,
    });
  });

  it("reports the real path and no git dir outside a repository", () => {
    const linkedPath = mkdtempSync(join(tmpdir(), "acm-ids-plain-"));

    expect(collectLocationFacts(linkedPath)).toEqual({
      realpath: realpathSync(linkedPath),
      gitCommonDir: undefined,
    });
  });

  it("names a repository git refuses for dubious ownership and falls back to the directory identity", () => {
    const root = tempDir("acm-ids-dubious-");
    const nested = join(root, "src");
    mkdirSync(nested);
    git(root, "init", "-q");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1");

    expect(collectLocationFacts(nested)).toEqual({
      realpath: nested,
      gitCommonDir: undefined,
      dubiousRepository: root,
    });
  });

  it("treats a missing git executable as a directory outside git", () => {
    const plain = tempDir("acm-ids-nogit-");
    vi.stubEnv("PATH", tempDir("acm-empty-path-"));

    expect(collectLocationFacts(plain)).toEqual({ realpath: plain, gitCommonDir: undefined });
  });

  it("throws when git is killed before answering, so identity never silently changes", () => {
    const plain = tempDir("acm-ids-killed-");
    vi.stubEnv("PATH", fakeGitDir("#!/bin/sh\nkill -KILL $$\n"));

    expect(() => collectLocationFacts(plain)).toThrowError(
      expect.objectContaining({ signal: "SIGKILL" }),
    );
  });
});

describe("collectLocationFacts branch", () => {
  const ticketBranch = "fix/TOUCH-4945/guide-list-search";
  let root: string;
  let unborn: string;
  let worktrees: string;

  beforeAll(() => {
    root = tempDir("acm-ids-branch-");
    git(root, "init", "-q", "-b", "main");
    git(root, "commit", "-q", "--allow-empty", "--no-verify", "-m", "init");
    git(root, "checkout", "-q", "-b", ticketBranch);
    worktrees = tempDir("acm-ids-branch-worktrees-");
    git(root, "worktree", "add", "-q", "-b", "feat/WT-1", join(worktrees, "linked"));
    git(root, "worktree", "add", "-q", "--detach", join(worktrees, "detached"));
    unborn = tempDir("acm-ids-unborn-");
    git(unborn, "init", "-q", "-b", "main");
  });

  it.each([
    { state: "a normal repository", dir: () => root, repository: () => root, branch: ticketBranch },
    {
      state: "a linked worktree",
      dir: () => join(worktrees, "linked"),
      repository: () => root,
      branch: "feat/WT-1",
    },
    {
      state: "a detached HEAD",
      dir: () => join(worktrees, "detached"),
      repository: () => root,
      branch: undefined,
    },
    { state: "an unborn HEAD", dir: () => unborn, repository: () => unborn, branch: "main" },
  ])("keeps the identity and reports the branch of $state", ({ dir, repository, branch }) => {
    expect(collectLocationFacts(dir())).toEqual({
      realpath: dir(),
      gitCommonDir: join(repository(), ".git"),
      branch,
    });
  });

  it("reads the branch with the one git process it already spends on the common dir", () => {
    const calls = join(tempDir("acm-ids-git-calls-"), "calls");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const counting = fakeGitDir(`#!/bin/sh\necho call >> '${calls}'\nexec '${realGit}' "$@"\n`);
    vi.stubEnv("PATH", `${counting}:${process.env.PATH}`);

    const facts = collectLocationFacts(root);

    expect({ gitProcesses: readFileSync(calls, "utf8").split("\n").length - 1, facts }).toEqual({
      gitProcesses: 1,
      facts: { realpath: root, gitCommonDir: join(root, ".git"), branch: ticketBranch },
    });
  });

  it("keeps the identity and reports no branch when the git dir git names has no HEAD", () => {
    const plain = tempDir("acm-ids-headless-");
    const commonDir = tempDir("acm-ids-headless-common-");
    const gitDir = tempDir("acm-ids-headless-gitdir-");
    vi.stubEnv("PATH", fakeGitDir(`#!/bin/sh\necho '${commonDir}'\necho '${gitDir}'\n`));

    expect(collectLocationFacts(plain)).toEqual({
      realpath: plain,
      gitCommonDir: commonDir,
      branch: undefined,
    });
  });

  it("lets a HEAD read failure other than a missing or unreadable file propagate", () => {
    const plain = tempDir("acm-ids-looping-");
    const gitDir = tempDir("acm-ids-looping-gitdir-");
    symlinkSync(join(gitDir, "HEAD"), join(gitDir, "HEAD"));
    vi.stubEnv("PATH", fakeGitDir(`#!/bin/sh\necho '${gitDir}'\necho '${gitDir}'\n`));

    expect(() => collectLocationFacts(plain)).toThrow(/ELOOP/);
  });
});
