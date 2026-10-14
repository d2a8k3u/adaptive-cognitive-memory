import { describe, expect, it } from "vitest";
import { anchorHit, commandHead, keyHit, type MemoryKeys, toolLookup } from "../src/keys";

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
  return toolLookup("Bash", { command }, "/repo")?.anchors ?? [];
}

describe("toolLookup for Bash", () => {
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

  it("offers the head words as tokens for the keyword signal", () => {
    expect(toolLookup("Bash", { command: "uv run alembic upgrade head" }, "/repo")?.tokens).toEqual(
      expect.arrayContaining(["uv", "run", "alembic", "upgrade"]),
    );
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

describe("toolLookup for Edit and Write", () => {
  it("emits the project-relative path, basename, directory prefixes and extensions", () => {
    expect(
      toolLookup("Edit", { file_path: "/repo/src/components/GuideCard.spec.ts" }, "/repo"),
    ).toEqual({
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
    const anchors = toolLookup("Write", { file_path: "/repo/.env.example" }, "/repo")?.anchors;
    expect(anchors).toEqual(expect.arrayContaining([".env.example", ".example"]));
    expect(anchors).not.toContain(".env");
  });

  it("keeps only the basename and extensions for a file outside the project", () => {
    const anchors = toolLookup(
      "Edit",
      { file_path: "/elsewhere/notes/todo.txt" },
      "/repo",
    )?.anchors;
    expect(anchors).toEqual(expect.arrayContaining(["todo.txt", ".txt"]));
    expect(anchors?.some((anchor) => anchor.includes("/"))).toBe(false);
  });

  it("has nothing to look up for other tools or inputs without a path or command", () => {
    expect(toolLookup("Read", { file_path: "/repo/a.ts" }, "/repo")).toBeUndefined();
    expect(toolLookup("Edit", { old_string: "a" }, "/repo")).toBeUndefined();
    expect(toolLookup("Bash", { command: "   " }, "/repo")).toBeUndefined();
  });
});

describe("anchorHit", () => {
  it("matches a stored anchor only by exact membership in the lookup", () => {
    const lookup = new Set(["src/components/", ".ts", "pytest"]);
    expect(anchorHit(["src/stores/", ".ts"], lookup)).toBe(true);
    expect(anchorHit(["src/components"], lookup)).toBe(false);
  });
});
