import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostToolName, MEMORY_SERVER_NAME } from "../src/toolnames";
import { PLUGIN_VERSION } from "../src/version";

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
