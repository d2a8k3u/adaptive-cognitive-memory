import { describe, expect, it } from "vitest";
import {
  anchorsProblem,
  CONFLICT_KEY_NAMESPACES,
  conflictKeyProblem,
  keywordsProblem,
  valueTextProblem,
} from "../src/authoring";

const ANCHORS_SHAPE_MESSAGE =
  "anchors must be a list of at most 20 non-empty strings of at most 200 characters";
const CONFLICT_KEY_MESSAGE =
  "conflict_key must be namespace.topic naming the slot — lowercase, dotted, at most 120 characters, with namespace one of project, build, test, deploy, db, api, code, git, tool, team, user, error, ticket — such as project.primary_database or team.reviewers";
const PATH_PREFIX_FIX = "write the project-relative path without the prefix";
const WHITESPACE_FIX = "use single spaces and no tabs or line breaks";
const GLOB_FIX =
  "anchors match exactly — use the path, a directory prefix ending in /, the basename or the extension";
const ANCHOR_CHECK_RUNS = 1000;
const ANCHOR_CHECK_P95_CAP_MS = 1;

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(Math.ceil(fraction * sorted.length), sorted.length) - 1] ?? Infinity;
}

describe("anchorsProblem", () => {
  it.each([
    {
      rule: "(a) an absolute path",
      anchors: ["/Users/me/app/billing/tax.py"],
      reported: 'anchors[0] "/Users/me/app/billing/tax.py" is an absolute path',
      fix: "write it relative to the project root (billing/tax.py)",
    },
    {
      rule: "(b) a ./ prefix",
      anchors: ["pytest", "./scripts/release.sh"],
      reported: 'anchors[1] "./scripts/release.sh" starts with ./ or ../',
      fix: PATH_PREFIX_FIX,
    },
    {
      rule: "(b) a ../ prefix",
      anchors: ["../shared/settings.py"],
      reported: 'anchors[0] "../shared/settings.py" starts with ./ or ../',
      fix: PATH_PREFIX_FIX,
    },
    {
      rule: "(c) leading whitespace",
      anchors: [" pytest"],
      reported: 'anchors[0] " pytest" has leading, trailing or repeated whitespace',
      fix: WHITESPACE_FIX,
    },
    {
      rule: "(c) two consecutive spaces",
      anchors: ["git  commit"],
      reported: 'anchors[0] "git  commit" has leading, trailing or repeated whitespace',
      fix: WHITESPACE_FIX,
    },
    {
      rule: "(c) a tab",
      anchors: ["git\tcommit"],
      reported: 'anchors[0] "git\\tcommit" has leading, trailing or repeated whitespace',
      fix: WHITESPACE_FIX,
    },
    {
      rule: "(c) a line break",
      anchors: ["git\ncommit"],
      reported: 'anchors[0] "git\\ncommit" has leading, trailing or repeated whitespace',
      fix: WHITESPACE_FIX,
    },
    {
      rule: "(d) a backslash in a single token",
      anchors: ["billing\\tax.py"],
      reported: 'anchors[0] "billing\\\\tax.py" contains a backslash',
      fix: "paths use / as the separator",
    },
    {
      rule: "(d) a * in a single token",
      anchors: ["src/*.ts"],
      reported: 'anchors[0] "src/*.ts" contains * or ?',
      fix: GLOB_FIX,
    },
    {
      rule: "(d) a ? in a single token",
      anchors: ["tests/test_?.py"],
      reported: 'anchors[0] "tests/test_?.py" contains * or ?',
      fix: GLOB_FIX,
    },
    {
      rule: "(e) more than three words",
      anchors: ["uv run pytest tests"],
      reported: 'anchors[0] "uv run pytest tests" has more than 3 words',
      fix: "a Bash anchor is a command head of at most 3 words (uv run pytest)",
    },
    {
      rule: "(f) a ticket id that is not upper-case",
      anchors: ["touch-4945"],
      reported: 'anchors[0] "touch-4945" has the shape of a ticket id',
      fix: "write it upper-case as it appears in the branch (TOUCH-4945)",
    },
    {
      rule: "(g) a repeated anchor",
      anchors: ["pytest", "billing/tax.py", "pytest"],
      reported: 'anchors[2] "pytest" repeats anchors[0]',
      fix: "list each anchor once",
    },
  ])("rejects $rule, naming the index, the anchor and the fix", ({ anchors, reported, fix }) => {
    const problem = anchorsProblem(anchors);

    expect(problem?.field).toBe("anchors");
    expect(problem?.message.startsWith(reported)).toBe(true);
    expect(problem?.message).toContain(fix);
  });

  it("accepts every form a matcher produces", () => {
    expect(
      anchorsProblem([
        "pytest",
        "git commit",
        "uv run pytest",
        "go test ./...",
        "rm -rf *",
        "billing/tax.py",
        "migrations/versions/",
        "pyproject.toml",
        "Dockerfile",
        "src/components/GuideImage.vue",
        ".vue",
        ".env.example",
        "pages/[id].vue",
        "scripts/deploy-2.sh",
        "TOUCH-4945",
        "ENOENT",
        "ModuleNotFoundError",
        "[REDACTED]",
      ]),
    ).toBeUndefined();
  });

  it("reports the list shape before the form of any anchor", () => {
    expect(anchorsProblem(["/billing/tax.py", 42])).toEqual({
      field: "anchors",
      message: ANCHORS_SHAPE_MESSAGE,
    });
  });

  it.skipIf(process.env.CI === "true")(
    "checks 20 anchors of 200 characters within 1 ms at p95",
    () => {
      const anchors = Array.from({ length: 20 }, (_, index) => `${index}`.padEnd(200, "p"));
      const durations = Array.from({ length: ANCHOR_CHECK_RUNS }, () => {
        const started = performance.now();
        anchorsProblem(anchors);
        return performance.now() - started;
      });
      const p95 = percentile(durations, 0.95);
      console.log(
        `NFR-20 anchorsProblem p95 over ${ANCHOR_CHECK_RUNS} calls: ${p95.toFixed(4)} ms (cap ${ANCHOR_CHECK_P95_CAP_MS})`,
      );

      expect(anchorsProblem(anchors)).toBeUndefined();
      expect(p95).toBeLessThanOrEqual(ANCHOR_CHECK_P95_CAP_MS);
    },
  );
});

describe("conflictKeyProblem", () => {
  it.each([
    "project.primary_database",
    "build.lint_command",
    "test.command.backend",
    "deploy.target",
    "db.migration_tool",
    "api.request_timeout",
    "code.http_client",
    "git.branch_policy",
    "tool.package_manager",
    "team.reviewers",
    "user.typescript_any",
    "error.sqlite_busy.wal_lock",
    "ticket.touch_4945",
  ])("accepts %s", (key) => {
    expect(conflictKeyProblem(key)).toBeUndefined();
  });

  it.each([
    { reason: "a single segment", key: "database" },
    { reason: "a namespace outside the list", key: "billing.tax_rounding" },
    { reason: "an upper-case namespace", key: "Project.x" },
    { reason: "an upper-case topic", key: "project.Primary" },
  ])("rejects $reason with the shape and every namespace", ({ key }) => {
    expect(conflictKeyProblem(key)).toEqual({
      field: "conflict_key",
      message: CONFLICT_KEY_MESSAGE,
    });
  });

  it("lists every namespace of the owner in its message", () => {
    const message = conflictKeyProblem("database")?.message ?? "";

    expect(CONFLICT_KEY_NAMESPACES.filter((namespace) => !message.includes(namespace))).toEqual([]);
  });
});

describe("text limits", () => {
  it.each([
    { field: "value_text", check: valueTextProblem, maxChars: 200 },
    { field: "keywords", check: keywordsProblem, maxChars: 300 },
  ])(
    "$field accepts $maxChars characters and rejects one more or a non-string",
    ({ field, check, maxChars }) => {
      const problem = {
        field,
        message: `${field} must be a string of at most ${maxChars} characters`,
      };

      expect(check("w".repeat(maxChars))).toBeUndefined();
      expect(check("w".repeat(maxChars + 1))).toEqual(problem);
      expect(check(42)).toEqual(problem);
    },
  );
});
