import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUDGET_MIN_TOKENS, loadConfig } from "../src/cfg";
import { openDatabase } from "../src/db/database";
import type { RecalledMemory } from "../src/gate";
import { projectIdentity, resolveProjectId } from "../src/ids";
import type { MemoryKind } from "../src/policy";
import { sessionStartLimit } from "../src/search";
import { type PinnedCandidate, sessionStartMemories } from "../src/session";
import { testModelEnv } from "../vitest.config";
import { type ProcessResult, runProcess } from "./fixtures/seed";

const HOOK_KILL_MS = 25_000;
const SESSION_ID = "branch-recall";
const TICKET = "TOUCH-4945";
const TICKET_BRANCH = `fix/${TICKET}/x`;
const FOREIGN_PROJECT_ID = "proj-someone-else";
const GIT_ISOLATION: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const COMMIT = ["commit", "-q", "--allow-empty", "--no-verify", "-m", "init"] as const;
const ON_TICKET_BRANCH = ["checkout", "-q", "-b", TICKET_BRANCH] as const;

interface SeededRow {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly anchors: readonly string[];
  readonly keywords: string;
  readonly abstract: string;
  readonly importance: number;
  readonly projectId?: string;
}

interface RecallEventRow {
  readonly sessionId: string | null;
  readonly event: string;
  readonly injected: number;
}

interface Checkout {
  readonly dir: string;
  readonly projectId: string;
  readonly path?: string;
}

function seededId(name: string): string {
  return `01J8GZSQBRANCH${name.padStart(12, "0")}`;
}

const PINNED: SeededRow = {
  id: seededId("PINNED"),
  kind: "constraint",
  anchors: [],
  keywords: "release branch policy",
  abstract: "release only from the main branch",
  importance: 0.5,
};

const TICKET_ANCHORED: SeededRow = {
  id: seededId("ANCHORED"),
  kind: "fact",
  anchors: [TICKET],
  keywords: "guide list search",
  abstract: "the guide list search pages by cursor",
  importance: 0.5,
};

const TICKET_KEYWORDED: SeededRow = {
  id: seededId("KEYWORDED"),
  kind: "fact",
  anchors: [],
  keywords: `${TICKET} guide list`,
  abstract: "the guide list keeps the old sort",
  importance: 0.5,
};

const TICKET_ROWS: readonly SeededRow[] = [
  TICKET_ANCHORED,
  TICKET_KEYWORDED,
  {
    id: seededId("SINGLETERM"),
    kind: "fact",
    anchors: [],
    keywords: "touch screen calibration",
    abstract: "touch screens calibrate on boot",
    importance: 0.5,
  },
  {
    id: seededId("LONGERNUMBER"),
    kind: "fact",
    anchors: [],
    keywords: `${TICKET}0 guide list`,
    abstract: "the guide list exports to csv",
    importance: 0.5,
  },
  {
    id: seededId("FOREIGN"),
    kind: "fact",
    anchors: [TICKET],
    keywords: "guide list search",
    abstract: "another project's guide list search",
    importance: 0.5,
    projectId: FOREIGN_PROJECT_ID,
  },
  {
    id: seededId("INPROSE"),
    kind: "fact",
    anchors: [],
    keywords: "guide list release notes",
    abstract: `the ${TICKET} fix shipped in the release notes`,
    importance: 0.5,
  },
];

const BASELINE_CONTEXT = [
  "Native auto memory is also on: store durable lessons with mcp__plugin_adaptive-cognitive-memory_memory__memory_store, not in the auto-memory MEMORY.md.",
  "<memory>",
  "Recalled memory from earlier sessions; verify it against the current code. Apply or follow each line, or say why it does not apply, then send memory_feedback with the ids.",
  "Constraints:",
  `- Apply — release only from the main branch (valid from 2026-10-13 · project · ${PINNED.id})`,
  "</memory>",
].join("\n");

const BASELINE: ProcessResult = {
  code: 0,
  stdout: `${JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: BASELINE_CONTEXT },
  })}\n`,
  stderr: "",
};

function hookEntryPath(): string {
  const entry = join(process.cwd(), "dist", "hooks.js");
  if (!existsSync(entry)) {
    throw new Error("dist/hooks.js missing — run npm run build before the branch recall suite");
  }
  return entry;
}

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function git(dir: string, args: readonly string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=acm", "-c", "user.email=acm@example.invalid", "-C", dir, ...args],
    { env: { ...process.env, ...GIT_ISOLATION }, stdio: "ignore" },
  );
}

function repository(...steps: readonly (readonly string[])[]): string {
  const dir = tempDir("acm-branch-repo-");
  git(dir, ["init", "-q", "-b", "main"]);
  for (const step of steps) {
    git(dir, step);
  }
  return dir;
}

function gitShimPath(script: string): string {
  const dir = tempDir("acm-branch-git-shim-");
  const path = join(dir, "git");
  writeFileSync(path, `#!/bin/sh\n${script}`);
  chmodSync(path, 0o755);
  return dir;
}

function failingGitPath(): string {
  return gitShimPath("echo 'fatal: unable to read the repository' >&2\nexit 1\n");
}

function countingGitPath(calls: string): string {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  return gitShimPath(`echo call >> '${calls}'\nexec '${realGit}' "$@"\n`);
}

function recalledRow(id: string, kind: MemoryKind): RecalledMemory {
  return {
    id,
    kind,
    epistemic: "verified",
    scope: "project",
    abstract: `abstract ${id}`,
    validFrom: "2026-10-13T00:00:00.000Z",
  };
}

function checkedOut(dir: string): Checkout {
  return { dir, projectId: resolveProjectId(dir) };
}

function hookEnv(path: string | undefined): NodeJS.ProcessEnv {
  return {
    CLAUDE_PLUGIN_DATA: tempDir("acm-branch-data-"),
    CLAUDE_CONFIG_DIR: tempDir("acm-branch-claude-"),
    ...testModelEnv,
    PATH: path,
    ...GIT_ISOLATION,
  };
}

function seed(env: NodeJS.ProcessEnv, projectId: string, rows: readonly SeededRow[]): void {
  const opened = openDatabase(loadConfig(env));
  try {
    const insert = opened.db.prepare(
      `INSERT INTO memories (id, type, kind, anchors, keywords, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
       VALUES (?, 'semantic', ?, ?, ?, 'project', ?, ?, ?, ?, ?, NULL, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.kind,
        JSON.stringify(row.anchors),
        row.keywords,
        row.projectId ?? projectId,
        `title of ${row.abstract}`,
        row.abstract,
        `body of ${row.abstract}`,
        row.importance,
      );
    }
  } finally {
    opened.db.close();
  }
}

function recallEvents(env: NodeJS.ProcessEnv): RecallEventRow[] {
  const opened = openDatabase(loadConfig(env));
  try {
    return opened.db
      .prepare("SELECT session_id AS sessionId, event, injected FROM recall_events ORDER BY id")
      .all() as RecallEventRow[];
  } finally {
    opened.db.close();
  }
}

function sessionStart(env: NodeJS.ProcessEnv, cwd: string): Promise<ProcessResult> {
  return runProcess({
    command: process.execPath,
    args: [hookEntryPath()],
    env,
    stdinText: JSON.stringify({
      hook_event_name: "SessionStart",
      source: "startup",
      cwd,
      session_id: SESSION_ID,
    }),
    timeoutMs: HOOK_KILL_MS,
  });
}

function seededEnv(checkout: Checkout, rows: readonly SeededRow[]): NodeJS.ProcessEnv {
  const env = hookEnv(checkout.path ?? process.env.PATH);
  seed(env, checkout.projectId, rows);
  return env;
}

function sessionStartIn(checkout: Checkout, rows: readonly SeededRow[]): Promise<ProcessResult> {
  return sessionStart(seededEnv(checkout, rows), checkout.dir);
}

const NO_TICKET_CHECKOUTS: readonly { state: string; checkout: () => Checkout }[] = [
  { state: "main", checkout: () => checkedOut(repository(COMMIT)) },
  {
    state: "detached HEAD at a ticket branch's commit",
    checkout: () =>
      checkedOut(repository(COMMIT, ON_TICKET_BRANCH, ["checkout", "-q", "--detach"])),
  },
  { state: "unborn HEAD", checkout: () => checkedOut(repository()) },
  { state: "non-git directory", checkout: () => checkedOut(tempDir("acm-branch-plain-")) },
  {
    state: "git failing inside a repository on a ticket branch",
    checkout: () => {
      const dir = repository(COMMIT, ON_TICKET_BRANCH);
      return {
        dir,
        projectId: projectIdentity({ realpath: dir, gitCommonDir: undefined }),
        path: failingGitPath(),
      };
    },
  },
];

function injectedSeededIds(result: ProcessResult): string[] {
  return [...result.stdout.matchAll(/01J8GZSQBRANCH\w+/g)].map((match) => match[0]).sort();
}

describe("SessionStart on a ticket branch", () => {
  it("adds exactly the rows anchored or keyed with the branch's ticket to the pinned rows", async () => {
    const result = await sessionStartIn(checkedOut(repository(COMMIT, ON_TICKET_BRANCH)), [
      PINNED,
      ...TICKET_ROWS,
    ]);

    expect({
      code: result.code,
      stderr: result.stderr,
      injected: injectedSeededIds(result),
    }).toEqual({
      code: 0,
      stderr: "",
      injected: [PINNED.id, TICKET_ANCHORED.id, TICKET_KEYWORDED.id].sort(),
    });
  });

  it("adds at most three ticket rows, the most important first, within the one SessionStart recall event", async () => {
    const matching: SeededRow[] = [0.5, 0.6, 0.7, 0.8, 0.9].map((importance, index) => ({
      ...TICKET_ANCHORED,
      id: seededId(`CAPPED${index}`),
      abstract: `ticket fact number ${index}`,
      importance,
    }));
    const checkout = checkedOut(repository(COMMIT, ON_TICKET_BRANCH));
    const env = seededEnv(checkout, matching);

    const result = await sessionStart(env, checkout.dir);

    expect({ injected: injectedSeededIds(result), events: recallEvents(env) }).toEqual({
      injected: [seededId("CAPPED2"), seededId("CAPPED3"), seededId("CAPPED4")],
      events: [{ sessionId: SESSION_ID, event: "SessionStart", injected: 3 }],
    });
  });

  it("adds no ticket row and leaves the output unchanged when the pinned rows fill the limit", async () => {
    const pinned: SeededRow[] = Array.from(
      { length: sessionStartLimit(BUDGET_MIN_TOKENS) },
      (_, index) => ({
        ...PINNED,
        id: seededId(`PINNED${index}`),
        abstract: `pinned rule number ${index}`,
      }),
    );
    const dir = repository(COMMIT);
    const env = {
      ...seededEnv(checkedOut(dir), [...pinned, { ...TICKET_ANCHORED, importance: 1 }]),
      CLAUDE_PLUGIN_OPTION_RECALL_BUDGET_TOKENS: String(BUDGET_MIN_TOKENS),
    };
    const onMain = await sessionStart(env, dir);
    git(dir, ON_TICKET_BRANCH);

    const onTicketBranch = await sessionStart(env, dir);

    expect(onMain.stdout).toContain(seededId("PINNED0"));
    expect(onTicketBranch).toEqual(onMain);
  });

  it("spends one git process per session start on the project and its branch", async () => {
    const calls = join(tempDir("acm-branch-git-calls-"), "calls");
    const checkout = {
      ...checkedOut(repository(COMMIT, ON_TICKET_BRANCH)),
      path: countingGitPath(calls),
    };

    const result = await sessionStartIn(checkout, [TICKET_ANCHORED]);

    expect({
      injected: injectedSeededIds(result),
      gitProcesses: readFileSync(calls, "utf8").split("\n").length - 1,
    }).toEqual({ injected: [TICKET_ANCHORED.id], gitProcesses: 1 });
  });
});

describe("session start order with ticket rows", () => {
  it("puts the ticket rows after the pinned rows and before the carried rows, each once, and cuts the tail at the limit", () => {
    const pinnedRule: PinnedCandidate = {
      ...recalledRow("p-rule", "constraint"),
      importance: 0.5,
      createdAt: "2026-10-13T00:00:00.000Z",
      lastActivityAt: "2026-10-13T00:00:00.000Z",
    };

    const rows = sessionStartMemories({
      source: "resume",
      pinned: [pinnedRule],
      ticket: [recalledRow("t-first", "fact"), pinnedRule, recalledRow("t-second", "fact")],
      earlier: [
        recalledRow("t-first", "fact"),
        recalledRow("c-carried", "fact"),
        recalledRow("c-cut", "fact"),
      ],
      recentEventTimes: [],
      limit: 4,
    });

    expect(rows.map((row) => row.id)).toEqual(["p-rule", "t-first", "t-second", "c-carried"]);
  });
});

describe("SessionStart on a branch without a ticket", () => {
  it.each(NO_TICKET_CHECKOUTS)(
    "prints the pre-ticket output byte for byte: $state",
    async ({ checkout }) => {
      expect(await sessionStartIn(checkout(), [PINNED, ...TICKET_ROWS])).toEqual(BASELINE);
    },
  );
});
