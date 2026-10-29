import { describe, expect, it } from "vitest";
import { anchorHit, commandHead, keyHit, type MemoryKeys, targetLookup } from "../src/keys";

const KEYS: MemoryKeys = {
  conflictKey: "project.primary_database",
  keywords: "postgres advisory-locks rds",
  anchors: ["git commit", "billing/db/session.py"],
};

describe("keyHit", () => {
  it.each([
    { tokens: ["database"], expected: true, reason: "a conflict key topic segment" },
    { tokens: ["project"], expected: false, reason: "only the conflict key namespace" },
    { tokens: ["locks"], expected: true, reason: "a keyword token" },
    { tokens: ["git", "commit"], expected: true, reason: "every word of an anchor" },
    { tokens: ["commit"], expected: false, reason: "part of a multi-word anchor" },
    { tokens: ["mysql", "schema"], expected: false, reason: "no shared token" },
  ])("is $expected for $reason", ({ tokens, expected }) => {
    expect(keyHit(new Set(tokens), KEYS)).toBe(expected);
  });

  it("treats a single-segment conflict key as the topic", () => {
    expect(keyHit(new Set(["tdd"]), { conflictKey: "tdd", keywords: "", anchors: [] })).toBe(true);
  });
});

function bashAnchors(command: string): readonly string[] {
  return targetLookup({ kind: "command", toolInput: { command } }, "/repo")?.anchors ?? [];
}

function fileLookup(...paths: readonly string[]) {
  return targetLookup({ kind: "files", paths }, "/repo");
}

describe("targetLookup for a command", () => {
  it("emits the one, two and three word heads and the head behind a runner", () => {
    expect(bashAnchors("uv run pytest -q tests/test_invoices.py")).toEqual(
      expect.arrayContaining([
        "uv",
        "uv run",
        "uv run pytest",
        "pytest",
        "pytest -q",
        "pytest -q tests/test_invoices.py",
      ]),
    );
  });

  it("strips env assignments, sudo, npx and path prefixes from the command word", () => {
    const anchors = bashAnchors("CI=1 sudo npx vitest run && ./node_modules/.bin/eslint .");
    expect(anchors).toEqual(expect.arrayContaining(["vitest", "vitest run", "eslint", "eslint ."]));
    expect(anchors.filter((anchor) => /CI=1|sudo|npx|node_modules/.test(anchor))).toEqual([]);
  });

  it("splits on separators outside quotes only", () => {
    const anchors = bashAnchors("git commit -m 'fix: a; b' | cat; pnpm lint");
    expect(anchors).toEqual(
      expect.arrayContaining(["git commit", "git commit -m", "cat", "pnpm lint"]),
    );
    expect(anchors.filter((anchor) => anchor.startsWith("b"))).toEqual([]);
  });

  it("reads 2>&1 and &> as redirections, not as command separators", () => {
    const anchors = bashAnchors("pytest -x 2>&1 | tail -20; npm test &> test.log");
    expect(anchors).toEqual(expect.arrayContaining(["pytest", "tail -20", "npm test"]));
    expect(anchors.filter((anchor) => /^(1|>)/.test(anchor))).toEqual([]);
  });

  it("looks at the first 32 command segments only, bounding the anchor query", () => {
    const anchors = bashAnchors(Array.from({ length: 40 }, (_, index) => `t${index}`).join("\n"));
    expect(anchors).toContain("t31");
    expect(anchors).not.toContain("t32");
  });

  it("turns a path argument into the project-relative path, as a file and as a directory, without its parents", () => {
    const paths = (command: string) =>
      bashAnchors(command).filter((anchor) => anchor.includes("/") && !anchor.includes(" "));

    expect(paths("go test -tags integration ./internal/it/...")).toEqual([
      "internal/it",
      "internal/it/",
    ]);
    expect(paths("go run ./cmd/backfill --from 2025-01-01")).toEqual([
      "cmd/backfill",
      "cmd/backfill/",
    ]);
    expect(paths("wc -l /repo/billing/tax.py")).toEqual(["billing/tax.py", "billing/tax.py/"]);
  });

  it("adds no path anchor for a command that only lists a directory, as Glob recalls nothing", () => {
    expect(
      bashAnchors("ls src/components && tree docs/").filter(
        (anchor) => anchor.includes("/") && !anchor.includes(" "),
      ),
    ).toEqual([]);
  });

  it("adds no basename, extension, url or outside path as an anchor", () => {
    const anchors = bashAnchors(
      "curl -o out/report.json https://example.com/api/v1 && cat /etc/hosts",
    );
    expect(anchors).toEqual(expect.arrayContaining(["out/report.json"]));
    expect(
      anchors.filter((anchor) =>
        /^(report\.json|\.json|https:.*|example\.com.*|etc\/.*|\/etc.*|hosts)$/.test(anchor),
      ),
    ).toEqual([]);
  });

  it("offers the head words as tokens for the keyword signal", () => {
    expect(
      targetLookup(
        { kind: "command", toolInput: { command: "uv run alembic upgrade head" } },
        "/repo",
      )?.tokens,
    ).toEqual(expect.arrayContaining(["uv", "run", "alembic", "upgrade"]));
  });
});

describe("commandHead", () => {
  it.each([
    { command: "pytest -q tests/test_invoices.py", head: "pytest" },
    { command: "pytest tests/test_invoices.py", head: "pytest tests/test_invoices.py" },
    { command: "npm run build -- --watch", head: "npm run build" },
    { command: "git push origin main", head: "git push origin" },
    { command: "cd billing && uv run pytest -x", head: "uv run pytest" },
    { command: "pytest 2>&1 | tail -20", head: "pytest" },
    { command: "npm test 2>&1 | tail -20", head: "npm test" },
    { command: "npm test &> test.log", head: "npm test" },
    { command: "cat check.sh && ./check.sh", head: "check.sh" },
    { command: "./regen.sh --with-ids && ./check.sh", head: "check.sh" },
    { command: "cat ./check.sh; ./check.sh", head: "check.sh" },
    { command: "./check.sh && cd ..", head: "check.sh" },
    { command: "CI=1 npx vitest run", head: "vitest run" },
    { command: "cd billing", head: undefined },
  ])("names $command by $head", ({ command, head }) => {
    expect(commandHead({ command })).toBe(head);
  });

  it("names nothing without a command string", () => {
    expect(commandHead({ file_path: "src/app.ts" })).toBeUndefined();
  });
});

describe("targetLookup for files", () => {
  it("emits the project-relative path, basename, directory prefixes and extensions", () => {
    expect(fileLookup("/repo/src/components/GuideCard.spec.ts")).toEqual({
      anchors: expect.arrayContaining([
        "src/components/GuideCard.spec.ts",
        "GuideCard.spec.ts",
        "src/",
        "src/components/",
        ".spec.ts",
        ".ts",
      ]),
      tokens: expect.arrayContaining(["src", "components", "guidecard", "spec", "ts"]),
    });
  });

  it("does not turn a longer dotfile into its shorter prefix", () => {
    const anchors = fileLookup("/repo/.env.example")?.anchors;
    expect(anchors).toEqual(expect.arrayContaining([".env.example", ".example"]));
    expect(anchors).not.toContain(".env");
  });

  it("keeps only the basename and extensions for a file outside the project", () => {
    const anchors = fileLookup("/elsewhere/notes/todo.txt")?.anchors;
    expect(anchors).toEqual(expect.arrayContaining(["todo.txt", ".txt"]));
    expect(anchors?.some((anchor) => anchor.includes("/"))).toBe(false);
  });

  it("unites the anchors of the first 32 paths and gives later paths no recall", () => {
    const anchors = fileLookup(
      ...Array.from({ length: 33 }, (_, index) => `/repo/dir${index}/file${index}.ts`),
    )?.anchors;
    expect(anchors).toEqual(expect.arrayContaining(["dir0/file0.ts", "dir31/file31.ts"]));
    expect(anchors).not.toContain("dir32/file32.ts");
  });

  it("has nothing to look up without a target, a command or a path", () => {
    expect(targetLookup({ kind: "none" }, "/repo")).toBeUndefined();
    expect(fileLookup()).toBeUndefined();
    expect(
      targetLookup({ kind: "command", toolInput: { command: "   " } }, "/repo"),
    ).toBeUndefined();
  });
});

describe("anchorHit", () => {
  it("matches a stored anchor only by exact membership in the lookup", () => {
    const lookup = new Set(["src/components/", ".ts", "pytest"]);
    expect(anchorHit(["src/stores/", ".ts"], lookup)).toBe(true);
    expect(anchorHit(["src/components"], lookup)).toBe(false);
  });
});
