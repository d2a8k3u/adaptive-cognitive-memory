import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AuthoringProblem,
  anchorsProblem,
  conflictKeyProblem,
  keywordsProblem,
  valueTextProblem,
} from "../src/authoring";
import { hostToolName, MEMORY_SERVER_NAME } from "../src/toolnames";
import { PLUGIN_INSTALL_ID, PLUGIN_VERSION } from "../src/version";

const DIST_DIR = join(process.cwd(), "dist");
const HOOK_ENTRY = join(DIST_DIR, "hooks.js");

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

function resolveLocal(fromFile: string, specifier: string): string | undefined {
  const candidate = join(dirname(fromFile), specifier);
  if (existsSync(candidate)) {
    return candidate;
  }
  const withExtension = `${candidate}.js`;
  return existsSync(withExtension) ? withExtension : undefined;
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

    expect(Object.keys(mcp.mcpServers)).toEqual([MEMORY_SERVER_NAME]);
    expect(hostToolName("memory_store")).toBe(
      `mcp__plugin_${plugin.name}_${MEMORY_SERVER_NAME}__memory_store`,
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
    ]);
    for (const { name, text } of invoking) {
      const withPluginData = `CLAUDE_PLUGIN_DATA="\${CLAUDE_PLUGIN_DATA}" ${cliInvocation}`;
      expect(text.split(withPluginData), name).toHaveLength(text.split(cliInvocation).length);
    }
  });
});

describe("recall docs", () => {
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

  it("README states the observed subagent dedup scope", () => {
    expect(readme).toContain(
      "Dedup scope, observed 2026-10-20: subagent hooks carry the parent's `session_id`, so a row injected in the parent is skipped inside a subagent.",
    );
  });

  it("README hook table lists the PreToolUse tools hooks.json matches", () => {
    const matchers = readJson<{ hooks: { PreToolUse: { matcher: string }[] } }>(
      "hooks",
      "hooks.json",
    ).hooks.PreToolUse.map((group) => group.matcher);

    expect(matchers).toHaveLength(1);
    expect(readme).toContain(`| \`PreToolUse\` (\`${matchers[0]?.replaceAll("|", "\\|")}\`) |`);
  });

  it("skill says path anchors fire before Read, Edit and Write", () => {
    const skill = readFileSync(join(process.cwd(), "skills", "memory", "SKILL.md"), "utf8");

    expect(skill).toContain("before Read, Edit or Write, a project-relative path");
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

  it("loads no LLM or API client in the hook path (AC-21)", () => {
    const closure = hookClosure();
    expect(closure).toContain(join(DIST_DIR, "search.js"));
    expect(closure).toContain(join(DIST_DIR, "embeddings.js"));
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
});
