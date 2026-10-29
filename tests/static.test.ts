import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANCHOR_MAX_CHARS,
  ANCHORS_MAX_ITEMS,
  type AuthoringProblem,
  anchorsProblem,
  CONFLICT_KEY_MAX_CHARS,
  CONFLICT_KEY_NAMESPACES,
  conflictKeyProblem,
  KEYWORDS_MAX_CHARS,
  keywordsProblem,
  VALUE_TEXT_MAX_CHARS,
  valueTextProblem,
} from "../src/authoring";
import { ticketId } from "../src/branch";
import { ABSTRACT_MAX_CHARS, CONTENT_MAX_CHARS, TITLE_MAX_CHARS } from "../src/cfg";
import { LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, LIST_PAGE_MAX_CHARS } from "../src/db/listing";
import { MAX_HEAD_WORDS } from "../src/keys";
import { TICKET_ROWS_MAX } from "../src/search";
import { snippetLine } from "../src/statusline";
import { hostToolName, MEMORY_SERVER_KEY } from "../src/toolnames";
import { TOOL_DEFINITIONS, type ToolDefinition } from "../src/tools";
import { PLUGIN_INSTALL_ID, PLUGIN_VERSION } from "../src/version";

const DIST_DIR = join(process.cwd(), "dist");
const HOOK_ENTRY = join(DIST_DIR, "hooks.js");
const DOCS_DIR = join(process.cwd(), "docs");

const NET_MODULES = new Set([
  "net",
  "node:net",
  "http",
  "node:http",
  "https",
  "node:https",
  "tls",
  "node:tls",
  "dgram",
  "node:dgram",
  "dns",
  "node:dns",
]);
const NET_MODULE_OWNERS = new Set(["modelinit.js", "embeddings.js"]);

const LLM_CLIENT_ROOTS = [
  "@anthropic-ai",
  "@azure/openai",
  "@google/generativeai",
  "@google/genai",
  "@mistralai",
  "@openai",
  "anthropic",
  "cohere",
  "openai",
];

function distJsFiles(dir: string = DIST_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return distJsFiles(path);
    }
    return entry.name.endsWith(".js") ? [path] : [];
  });
}

function specifiersOf(content: string): string[] {
  return [...content.matchAll(/(?:require\(|import\()(['"])([^'"]+)\1/g)]
    .map((match) => match[2] ?? "")
    .filter((specifier) => specifier !== "");
}

function localSpecifiersOf(file: string): string[] {
  return specifiersOf(readFileSync(file, "utf8")).filter(
    (specifier) => specifier.startsWith("./") || specifier.startsWith("../"),
  );
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

function resolveLocal(fromFile: string, specifier: string): string | undefined {
  const candidate = join(dirname(fromFile), specifier);
  if (isFile(candidate)) {
    return candidate;
  }
  const withExtension = `${candidate}.js`;
  return isFile(withExtension) ? withExtension : undefined;
}

function hookClosure(entry: string = HOOK_ENTRY): string[] {
  const closure: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    closure.push(file);
    for (const specifier of localSpecifiersOf(file)) {
      const resolved = resolveLocal(file, specifier);
      if (resolved !== undefined) {
        queue.push(resolved);
      }
    }
  }
  return closure;
}

describe("plugin version owner", () => {
  it("matches the version package.json and plugin.json declare", () => {
    const manifests = ["package.json", join(".claude-plugin", "plugin.json")].map(
      (path) => JSON.parse(readFileSync(join(process.cwd(), path), "utf8")) as { version: string },
    );

    expect(manifests.map((manifest) => manifest.version)).toEqual([PLUGIN_VERSION, PLUGIN_VERSION]);
  });

  it("names the memory tools from the plugin name and the MCP server key the manifests declare", () => {
    const plugin = JSON.parse(
      readFileSync(join(process.cwd(), ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string };
    const mcp = JSON.parse(readFileSync(join(process.cwd(), ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };

    expect(Object.keys(mcp.mcpServers)).toEqual([MEMORY_SERVER_KEY]);
    expect(hostToolName("claude", "memory_store")).toBe(
      `mcp__plugin_${plugin.name}_${MEMORY_SERVER_KEY}__memory_store`,
    );
  });
});

const SCANNABLE_SECRET_SHAPES = [
  /ghp_[A-Za-z0-9]{16,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk_(?:live|test)_[A-Za-z0-9]{10,}/,
  /(?<![A-Za-z0-9])sk-(?:ant-|proj-)[A-Za-z0-9-]{10,}/,
  /xox[abposr]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /hf_[A-Za-z0-9]{20,}/,
  /npm_[A-Za-z0-9]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
] as const;

function trackedTextFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: process.cwd(), encoding: "utf8" })
    .split("\0")
    .filter((path) => path !== "" && existsSync(join(process.cwd(), path)));
}

describe("repository secret hygiene", () => {
  it("keeps every synthetic credential assembled from fragments, so no tracked file holds a scannable secret", () => {
    const offenders = trackedTextFiles().flatMap((path) => {
      const text = readFileSync(join(process.cwd(), path), "utf8");
      return SCANNABLE_SECRET_SHAPES.filter((shape) => shape.test(text)).map(
        (shape) => `${path} ${shape.source}`,
      );
    });

    expect(offenders).toEqual([]);
  });
});

interface LockedPackage {
  readonly dev?: boolean;
  readonly link?: boolean;
  readonly resolved?: string;
  readonly integrity?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

const AUTO_INSTALL_LOCKFILE_VERSIONS = [2, 3];
const NPM_REGISTRY = "https://registry.npmjs.org/";

function readJson<T>(...path: string[]): T {
  return JSON.parse(readFileSync(join(process.cwd(), ...path), "utf8")) as T;
}

describe("marketplace install", () => {
  it("lists the plugin under the install id that the dependency fix names", () => {
    const marketplace = readJson<{ name: string; plugins: { name: string }[] }>(
      ".claude-plugin",
      "marketplace.json",
    );

    expect(marketplace.plugins.map((entry) => `${entry.name}@${marketplace.name}`)).toEqual([
      PLUGIN_INSTALL_ID,
    ]);
  });

  it("keeps the runtime dependencies installable by Claude Code's frozen, script-free npm install", () => {
    const manifest = readJson<{ dependencies: Record<string, string>; overrides?: unknown }>(
      "package.json",
    );
    const lock = readJson<{ lockfileVersion: number; packages: Record<string, LockedPackage> }>(
      "package-lock.json",
    );
    const runtimePackages = Object.entries(lock.packages).filter(
      ([path, entry]) => path !== "" && entry.dev !== true,
    );

    expect({
      lockfileVersion: AUTO_INSTALL_LOCKFILE_VERSIONS.includes(lock.lockfileVersion),
      overrides: manifest.overrides,
      lockedDependencies: lock.packages[""]?.dependencies,
      unpinned: runtimePackages
        .filter(
          ([, entry]) =>
            entry.link === true ||
            entry.integrity === undefined ||
            !entry.resolved?.startsWith(NPM_REGISTRY),
        )
        .map(([path]) => path),
    }).toEqual({
      lockfileVersion: true,
      overrides: undefined,
      lockedDependencies: manifest.dependencies,
      unpinned: [],
    });
  });
});

describe("plugin commands", () => {
  const commandsDir = join(process.cwd(), "commands");
  const cliInvocation = `node "\${CLAUDE_PLUGIN_ROOT}/dist/cli.js"`;
  const commands = readdirSync(commandsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name, text: readFileSync(join(commandsDir, name), "utf8") }));

  it("hands the CLI the plugin data directory the Bash tool environment lacks", () => {
    const invoking = commands.filter(({ text }) => text.includes(cliInvocation));

    expect(invoking.map(({ name }) => name).sort()).toEqual([
      "memory-doctor.md",
      "memory-recall.md",
      "memory-statusline.md",
    ]);
    for (const { name, text } of invoking) {
      const withPluginData = `CLAUDE_PLUGIN_DATA="\${CLAUDE_PLUGIN_DATA}" ${cliInvocation}`;
      expect(text.split(withPluginData), name).toHaveLength(text.split(cliInvocation).length);
    }
  });
});

describe("recall docs", () => {
  const recall = docText("recall.md");

  it("recall doc states the observed subagent dedup scope", () => {
    expect(recall).toContain(
      "Dedup scope, observed 2026-10-20: subagent hooks carry the parent's `session_id`, so a row injected in the parent is skipped inside a subagent.",
    );
  });

  it("recall doc hook table lists the PreToolUse tools hooks.json matches", () => {
    const matchers = readJson<{ hooks: { PreToolUse: { matcher: string }[] } }>(
      "hooks",
      "hooks.json",
    ).hooks.PreToolUse.map((group) => group.matcher);

    expect(matchers).toHaveLength(1);
    expect(recall).toContain(`| \`PreToolUse\` (\`${matchers[0]?.replaceAll("|", "\\|")}\`) |`);
  });

  it("skill says path anchors fire before Read, Edit and Write", () => {
    const skill = readFileSync(join(process.cwd(), "skills", "memory", "SKILL.md"), "utf8");

    expect(skill).toContain("before Read, Edit or Write, a project-relative path");
  });

  it("skill says to put a lesson's ticket id, upper-case as in the branch, into keywords and anchors", () => {
    const skill = readFileSync(join(process.cwd(), "skills", "memory", "SKILL.md"), "utf8");

    expect(skill).toContain(
      `put the ticket id, upper-case as it appears in the branch (\`${ticketId("fix/TOUCH-4945/guide-list")}\`), into both \`keywords\` and \`anchors\``,
    );
  });

  it("recall doc error recall section names the trigger, the anchor-only match, the once-per-head rule, the budget, redaction and an error code", () => {
    const section = markdownSection(recall, "## Recall on a failed Bash command").join("\n");

    expect(section).toContain("`PostToolUseFailure`");
    expect(section).toContain("only when one of its anchors equals a term");
    expect(section).toContain("its conflict key and keywords are not matched");
    expect(section).toContain("once per session and command head");
    expect(section).toContain("`pretool_budget_tokens`");
    expect(section).toContain("redacted");
    expect(section).toContain("`SQLITE_BUSY`");
    expect(section).toContain("command head alone never");
  });

  it("skill says to anchor an error lesson on its stable tokens, that only anchors match on an error and that a command head alone never recalls it", () => {
    const skill = readFileSync(join(process.cwd(), "skills", "memory", "SKILL.md"), "utf8");

    expect(skill).toContain(
      "A lesson about an error: put its stable tokens — the code, class name or module name (`SQLITE_BUSY`, `ModuleNotFoundError`, `express`) — into `anchors`",
    );
    expect(skill).toContain("only through an anchor equal to a token of its error");
    expect(skill).toContain("a command head alone never recalls it");
  });

  it("recall doc branch-aware section names the ticket row cap from its owner, the exact match and the unchanged no-ticket start", () => {
    const section = markdownSection(recall, "## Branch-aware session start").join("\n");

    expect(section).toContain(`up to ${TICKET_ROWS_MAX} memories`);
    expect(section).toContain("`touch` alone or `TOUCH-49450` never match");
    expect(section).toContain("session start is unchanged");
    expect(section).toContain(
      "put the ticket id, upper-case as it appears in the branch, into both `keywords` and `anchors`",
    );
  });
});

const KEY_LIMIT_DECLARATION = /(?:conflict_key|value_text|keywords?|anchors?)\w*\s*=\s*\d/i;
const KEY_PATTERN_DECLARATION = /CONFLICT_KEY_PATTERN\s*=/;
const HEAD_WORDS_DECLARATION = /MAX_HEAD_WORDS\s*=/;

function sourceFiles(dir: string = join(process.cwd(), "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

type FixtureMemoryFields = Readonly<Record<string, unknown>>;

interface FixtureMemorySource {
  readonly file: string;
  readonly memories: readonly FixtureMemoryFields[];
}

function fixtureMemorySources(): FixtureMemorySource[] {
  const evalFixture = (name: string) => join("tests", "fixtures", "eval", name);
  const corpus = readJson<{ memories: FixtureMemoryFields[] }>(evalFixture("corpus.json"));
  const supersession = readJson<{ old: FixtureMemoryFields; new: FixtureMemoryFields }[]>(
    evalFixture("supersession.json"),
  );
  const contradictions = readJson<
    { a: { memory: FixtureMemoryFields }; b: { memory: FixtureMemoryFields } }[]
  >(evalFixture("contradictions.json"));
  const seedFiles = readdirSync(join(process.cwd(), "evals"))
    .map((name) => join("evals", name, "seeds.json"))
    .filter((path) => existsSync(join(process.cwd(), path)));
  return [
    { file: evalFixture("corpus.json"), memories: corpus.memories },
    {
      file: evalFixture("supersession.json"),
      memories: supersession.flatMap((item) => [item.old, item.new]),
    },
    {
      file: evalFixture("contradictions.json"),
      memories: contradictions.flatMap((item) => [item.a.memory, item.b.memory]),
    },
    ...seedFiles.map((file) => ({
      file,
      memories: readJson<{ memory: FixtureMemoryFields }[]>(file).map((seed) => seed.memory),
    })),
  ];
}

function storedAuthoringProblems(memory: FixtureMemoryFields): AuthoringProblem[] {
  return [
    conflictKeyProblem(memory.conflict_key),
    valueTextProblem(memory.value_text ?? ""),
    keywordsProblem(memory.keywords ?? ""),
    anchorsProblem(memory.anchors ?? []),
  ].filter((problem) => problem !== undefined);
}

describe("authoring standard", () => {
  it("every fixture memory the eval and the real-session suite store passes the authoring checks", () => {
    const offenders = fixtureMemorySources().flatMap(({ file, memories }) =>
      memories.flatMap((memory, index) =>
        storedAuthoringProblems(memory).map(
          (problem) => `${file} ${String(memory.id ?? index)}: ${problem.message}`,
        ),
      ),
    );

    expect(offenders).toEqual([]);
  });

  it("declares the key limits only in src/authoring.ts and the head-word cap only in src/keys.ts", () => {
    const declaringFiles = (declaration: RegExp) =>
      sourceFiles()
        .filter((file) => declaration.test(readFileSync(file, "utf8")))
        .map((file) => relative(process.cwd(), file));

    expect({
      keyLimits: declaringFiles(KEY_LIMIT_DECLARATION),
      keyPattern: declaringFiles(KEY_PATTERN_DECLARATION),
      headWords: declaringFiles(HEAD_WORDS_DECLARATION),
    }).toEqual({
      keyLimits: [join("src", "authoring.ts")],
      keyPattern: [join("src", "authoring.ts")],
      headWords: [join("src", "keys.ts")],
    });
  });

  it("dist/authoring.js requires ./keys and ./branch and nothing else (NFR-19)", () => {
    expect(specifiersOf(readFileSync(join(DIST_DIR, "authoring.js"), "utf8")).sort()).toEqual([
      "./branch",
      "./keys",
    ]);
  });
});

const AUTHORING_REFERENCE_PATH = "memory/references/authoring.md";
const AUTHORING_REFERENCE_MAX_WORDS = 600;
const AUTHORING_SUMMARY_MAX_LINES = 8;
const EXAMPLE_LIST_MIN_TOKENS = 5;

function authoringReference(): string {
  return readFileSync(join(process.cwd(), "skills", AUTHORING_REFERENCE_PATH), "utf8");
}

function exampleTokens(text: string, label: string): string[] {
  const line = text.split("\n").find((candidate) => candidate.startsWith(`${label}:`)) ?? "";
  return [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

function markdownSection(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) {
    return [];
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line.trim() !== "");
}

function docText(name: string): string {
  return readFileSync(join(DOCS_DIR, name), "utf8");
}

function docLine(name: string, prefix: string): string {
  return (
    docText(name)
      .split("\n")
      .find((line) => line.startsWith(prefix)) ?? ""
  );
}

const RENDERED_LIMITS = [
  `${ANCHORS_MAX_ITEMS} anchors`,
  `${ANCHOR_MAX_CHARS} characters`,
  `${VALUE_TEXT_MAX_CHARS} characters`,
  `${KEYWORDS_MAX_CHARS} characters`,
  `${CONFLICT_KEY_MAX_CHARS} characters`,
  `${TITLE_MAX_CHARS} characters`,
  `${ABSTRACT_MAX_CHARS} characters`,
  `${CONTENT_MAX_CHARS} characters`,
  `${MAX_HEAD_WORDS} words`,
];

const FIELD_ROW_LIMITS: readonly { readonly field: string; readonly limit: string }[] = [
  { field: "title", limit: `${TITLE_MAX_CHARS} characters` },
  { field: "abstract", limit: `${ABSTRACT_MAX_CHARS} characters` },
  { field: "content", limit: `${CONTENT_MAX_CHARS} characters` },
  { field: "conflict_key", limit: `${CONFLICT_KEY_MAX_CHARS} characters` },
  { field: "cardinality + value_text", limit: `${VALUE_TEXT_MAX_CHARS} characters` },
  { field: "keywords", limit: `${KEYWORDS_MAX_CHARS} characters` },
  { field: "anchors", limit: `${ANCHORS_MAX_ITEMS} anchors` },
  { field: "anchors", limit: `${ANCHOR_MAX_CHARS} characters` },
];

function fieldRow(reference: string, field: string): string {
  return reference.split("\n").find((line) => line.startsWith(`| ${field} |`)) ?? "";
}

describe("authoring standard docs", () => {
  it("the reference names every limit from its owner in its field's row and every conflict key namespace", () => {
    const reference = authoringReference();

    expect({
      limitsMissingFromTheirRow: FIELD_ROW_LIMITS.filter(
        ({ field, limit }) => !fieldRow(reference, field).includes(limit),
      ).map(({ field, limit }) => `${field}: ${limit}`),
      headWordCapMissing: !reference.includes(`${MAX_HEAD_WORDS} words`),
      missingNamespaces: CONFLICT_KEY_NAMESPACES.filter(
        (namespace) => !reference.includes(`| \`${namespace}\` |`),
      ),
    }).toEqual({ limitsMissingFromTheirRow: [], headWordCapMissing: false, missingNamespaces: [] });
  });

  it("every good example passes the server checks and every bad example fails them", () => {
    const reference = authoringReference();
    const lists = {
      goodAnchors: exampleTokens(reference, "Good anchors"),
      badAnchors: exampleTokens(reference, "Bad anchors"),
      goodKeys: exampleTokens(reference, "Good keys"),
      badKeys: exampleTokens(reference, "Bad keys"),
    };

    expect(
      Object.entries(lists)
        .filter(([, tokens]) => tokens.length < EXAMPLE_LIST_MIN_TOKENS)
        .map(([list]) => list),
    ).toEqual([]);
    expect({
      rejectedGoodAnchors: lists.goodAnchors.filter((token) => anchorsProblem([token])),
      acceptedBadAnchors: lists.badAnchors.filter((token) => !anchorsProblem([token])),
      rejectedGoodKeys: lists.goodKeys.filter((token) => conflictKeyProblem(token)),
      acceptedBadKeys: lists.badKeys.filter((token) => !conflictKeyProblem(token)),
    }).toEqual({
      rejectedGoodAnchors: [],
      acceptedBadAnchors: [],
      rejectedGoodKeys: [],
      acceptedBadKeys: [],
    });
  });

  it("the reference stays short and the memory skill summarises it in a few lines that link it and repeat no limit", () => {
    const summary = markdownSection(
      readFileSync(join(process.cwd(), "skills", "memory", "SKILL.md"), "utf8"),
      "## Authoring standard",
    );

    const referenceWords = authoringReference()
      .split(/\s+/)
      .filter((word) => word !== "");

    expect(referenceWords.length).toBeLessThanOrEqual(AUTHORING_REFERENCE_MAX_WORDS);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(AUTHORING_SUMMARY_MAX_LINES);
    expect(summary.join("\n")).toContain(AUTHORING_REFERENCE_PATH);
    expect(RENDERED_LIMITS.filter((limit) => summary.join("\n").includes(limit))).toEqual([]);
  });

  it("the tools doc memory_store row names the key limits from their owner, the namespace rule and the anchor forms", () => {
    const row = docLine("tools.md", "| `memory_store` |");

    expect(row).toContain(`\`conflict_key\` (lowercase dotted, ≤${CONFLICT_KEY_MAX_CHARS})`);
    expect(row).toContain(`\`value_text\` (≤${VALUE_TEXT_MAX_CHARS},`);
    expect(row).toContain(`\`keywords\` (≤${KEYWORDS_MAX_CHARS})`);
    expect(row).toContain(`\`anchors\` (≤${ANCHORS_MAX_ITEMS} × ≤${ANCHOR_MAX_CHARS})`);
    expect(row).toContain(
      `\`namespace.topic\` with namespace one of ${CONFLICT_KEY_NAMESPACES.map((namespace) => `\`${namespace}\``).join(", ")}`,
    );
    expect(row).toContain(`a command head of at most ${MAX_HEAD_WORDS} words`);
  });

  it("the docs state the authoring rejections and that import applies the same key rules", () => {
    expect(docLine("tools.md", "Invalid input returns")).toContain(
      "An anchor no recall path can match or a `conflict_key` outside `namespace.topic` with a listed namespace is rejected the same way, the message naming the fix",
    );
    expect(docLine("cli.md", "| `import <file>` |")).toContain(
      'every memory must pass the same key rules as `memory_store` (conflict key, value, keywords, anchors), except that a legacy empty `conflict_key` (`""`) is kept',
    );
  });
});

const CURATE_SKILL_DIR = join(process.cwd(), "skills", "memory-curate");
const CURATE_CONFIRMATION =
  "Propose every change and wait for the user's confirmation before you delete, supersede or update a memory; never run this unattended.";
const CURATE_CROSS_PROJECT =
  'A memory that `memory_list` finds only with `project: "all"` belongs to another project: it is read-only here and can be changed only from a session in its own project.';

function curateSkill(): string {
  return readFileSync(join(CURATE_SKILL_DIR, "SKILL.md"), "utf8");
}

function frontmatter(text: string): string {
  return text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
}

describe("memory-curate skill", () => {
  it("declares the name memory-curate, distinct from the predecessor plugin's memory-maintain, and a description", () => {
    const header = frontmatter(curateSkill());

    expect({
      name: header.match(/^name: (.+)$/m)?.[1],
      description: (header.match(/^description: >?([\s\S]*)$/m)?.[1] ?? "").trim() !== "",
    }).toEqual({ name: "memory-curate", description: true });
  });

  it("names only registered memory tools", () => {
    const registered = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
    const named = [...curateSkill().matchAll(/memory_[a-z_]+/g)].map((match) => match[0]);

    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !registered.has(name))).toEqual([]);
  });

  it("waits for the user's confirmation and keeps other projects' memories read-only", () => {
    const text = curateSkill();

    expect({
      confirmation: text.includes(CURATE_CONFIRMATION),
      crossProject: text.includes(CURATE_CROSS_PROJECT),
    }).toEqual({ confirmation: true, crossProject: true });
  });

  it("links the authoring reference by a path that resolves and restates no limit", () => {
    const text = curateSkill();
    const linked = text.match(/\]\(([^)]*memory\/references\/authoring\.md)\)/)?.[1];

    expect(text).toContain(AUTHORING_REFERENCE_PATH);
    expect(linked !== undefined && existsSync(join(CURATE_SKILL_DIR, linked))).toBe(true);
    expect(RENDERED_LIMITS.filter((limit) => text.includes(limit))).toEqual([]);
  });
});

const REPLAY_PREFIX = `printf '%s' "$input" | `;

describe("statusline docs (FR-30)", () => {
  const placeholderSnippet = snippetLine("<plugin data dir>/statusline/badge.cjs");

  it("statusline doc shows the opt-in command, the snippet in its replay form, and off plus removing the line before uninstall", () => {
    const section = docText("statusline.md");

    expect(section).toContain("`/memory-statusline on`");
    expect(section).toContain(`${REPLAY_PREFIX}${placeholderSnippet}`);
    expect(section).toContain("never reads or writes any `settings.json`");
    expect(section).toContain(
      "run `/memory-statusline off` and remove the line from your statusline script",
    );
  });

  it("the memory-statusline command shows the replay form of the line it prints", () => {
    const command = readFileSync(join(process.cwd(), "commands", "memory-statusline.md"), "utf8");

    expect(command).toContain(`${REPLAY_PREFIX}<the line>`);
  });
});

describe("browse and curate docs", () => {
  it("the tools doc memory_list row names the filters, the cursor, the limits from their owner and the read-only project all", () => {
    const row = docLine("tools.md", "| `memory_list` |");

    expect(row).toContain("`state`, `kind`, `type`, `scope`");
    expect(row).toContain("`before` (the `next_cursor` of the previous page)");
    expect(row).toContain(`\`limit\` (1–${LIST_LIMIT_MAX}, default ${LIST_LIMIT_DEFAULT})`);
    expect(row).toContain('`project: "all"` lists every project\'s memories read-only');
    expect(row).toContain(`${LIST_PAGE_MAX_CHARS.toLocaleString("en-US")} characters`);
  });

  it("the tools doc memory_update row names the key edits and the fixed scope and kind, and the tools doc names the curate skill", () => {
    const row = docLine("tools.md", "| `memory_update` |");

    expect(row).toContain("`keywords`, `anchors`");
    expect(row).toContain("replace the stored value whole");
    expect(row).toContain("`scope` or `kind`");
    expect(docText("tools.md")).toContain("`memory-curate`");
  });

  it("the memory skill's curating section names memory_list, the key edits and the curate skill", () => {
    const section = markdownSection(
      readFileSync(join(process.cwd(), "skills", "memory", "SKILL.md"), "utf8"),
      "## Reading and curating",
    ).join("\n");

    expect(section).toContain("`memory_list`");
    expect(section).toContain("keywords or anchors");
    expect(section).toContain("`memory-curate`");
  });
});

const MARKDOWN_LINK_TARGET = /\]\(([^)\s]+)\)/g;
const URL_SCHEME = /^[a-z]+:/;

function headingSlugs(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) =>
        line
          .replace(/^#+ /, "")
          .toLowerCase()
          .replace(/[^\p{L}\p{N} _-]/gu, "")
          .replaceAll(" ", "-"),
      ),
  );
}

function linkResolves(file: string, target: string): boolean {
  const [path = "", anchor] = target.split("#");
  const linked = path === "" ? file : join(dirname(file), path);
  if (!existsSync(linked)) {
    return false;
  }
  return anchor === undefined || headingSlugs(readFileSync(linked, "utf8")).has(anchor);
}

describe("docs links", () => {
  it("every relative link in the README, CONTRIBUTING and docs points at an existing file and heading", () => {
    const markdownFiles = [
      join(process.cwd(), "README.md"),
      join(process.cwd(), "CONTRIBUTING.md"),
      ...readdirSync(DOCS_DIR)
        .filter((name) => name.endsWith(".md"))
        .map((name) => join(DOCS_DIR, name)),
    ];
    const broken = markdownFiles.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(MARKDOWN_LINK_TARGET)]
        .map((match) => match[1] ?? "")
        .filter((target) => !URL_SCHEME.test(target) && !linkResolves(file, target))
        .map((target) => `${relative(process.cwd(), file)} → ${target}`),
    );

    expect(broken).toEqual([]);
  });
});

const LIST_TOOL_MAX_CHARS = 600;
const DESCRIPTION_MAX_CHARS = 4096;
const ALL_TOOLS_MAX_CHARS = 5500;

function definitionChars(tool: ToolDefinition): number {
  return tool.description.length + JSON.stringify(tool.inputSchema).length;
}

describe("tool definition size (NFR-12)", () => {
  it("keeps memory_list within 600 characters, every description under 4 096 and all tools within 5 500", () => {
    const listTool = TOOL_DEFINITIONS.find((tool) => tool.name === "memory_list");

    expect(listTool === undefined ? Infinity : definitionChars(listTool)).toBeLessThanOrEqual(
      LIST_TOOL_MAX_CHARS,
    );
    expect(
      TOOL_DEFINITIONS.filter((tool) => tool.description.length >= DESCRIPTION_MAX_CHARS).map(
        (tool) => tool.name,
      ),
    ).toEqual([]);
    expect(
      TOOL_DEFINITIONS.reduce((chars, tool) => chars + definitionChars(tool), 0),
    ).toBeLessThanOrEqual(ALL_TOOLS_MAX_CHARS);
  });
});

describe("static dist gates", () => {
  it("ships no import path from the predecessor memory plugins (AC-17)", () => {
    const offenders = distJsFiles().filter((file) =>
      /claude-memory|adaptive-memory/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("contains no listening-socket code (AC-19)", () => {
    const offenders = distJsFiles().filter((file) =>
      readFileSync(file, "utf8").includes("listen("),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps network imports inside modelinit and embeddings (AC-20)", () => {
    const offenders: string[] = [];
    for (const file of distJsFiles()) {
      if (NET_MODULE_OWNERS.has(basename(file))) {
        continue;
      }
      for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
        if (NET_MODULES.has(specifier)) {
          offenders.push(`${file} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("loads no LLM or API client in the hook path or the memory listing (AC-21)", () => {
    const listing = join(DIST_DIR, "db", "listing.js");
    const closure = [HOOK_ENTRY, listing].flatMap((entry) => hookClosure(entry));
    expect(closure).toContain(join(DIST_DIR, "search.js"));
    expect(closure).toContain(join(DIST_DIR, "embeddings.js"));
    expect(closure).toContain(join(DIST_DIR, "branch.js"));
    expect(closure).toContain(join(DIST_DIR, "failure.js"));
    expect(closure).toContain(join(DIST_DIR, "db", "failures.js"));
    expect(closure).toContain(join(DIST_DIR, "statusline.js"));
    expect(closure).toContain(join(DIST_DIR, "statusline", "badge.js"));
    expect(closure).toContain(listing);
    const offenders: string[] = [];
    for (const file of closure) {
      for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
        const isLlmClient = LLM_CLIENT_ROOTS.some(
          (root) => specifier === root || specifier.startsWith(`${root}/`),
        );
        if (isLlmClient) {
          offenders.push(`${file} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the statusline shim on node:fs and node:path alone, so its byte copy opens no database (NFR-15)", () => {
    const shim = readFileSync(join(DIST_DIR, "statusline", "badge.js"), "utf8");

    expect([...new Set(specifiersOf(shim))].sort()).toEqual(["node:fs", "node:path"]);
  });
});
