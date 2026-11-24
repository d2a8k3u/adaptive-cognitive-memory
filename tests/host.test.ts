import { describe, expect, it } from "vitest";
import { claudeDependencyFix, hostProfile, InvalidHostError, resolveHost } from "../src/host";
import { hostToolName } from "../src/toolnames";

const PLUGIN_DIR = "/plugins/adaptive-cognitive-memory";

describe("resolveHost", () => {
  it.each([
    {
      name: "ACM_HOST over a Codex plugin root",
      env: { ACM_HOST: "opencode", PLUGIN_ROOT: PLUGIN_DIR, CLAUDE_PLUGIN_ROOT: PLUGIN_DIR },
      host: "opencode",
    },
    {
      name: "PLUGIN_ROOT equal to CLAUDE_PLUGIN_ROOT",
      env: { PLUGIN_ROOT: PLUGIN_DIR, CLAUDE_PLUGIN_ROOT: PLUGIN_DIR },
      host: "codex",
    },
    {
      name: "a stray PLUGIN_ROOT other than CLAUDE_PLUGIN_ROOT",
      env: { PLUGIN_ROOT: "/elsewhere", CLAUDE_PLUGIN_ROOT: PLUGIN_DIR },
      host: "claude",
    },
    { name: "no PLUGIN_ROOT", env: { CLAUDE_PLUGIN_ROOT: PLUGIN_DIR }, host: "claude" },
    { name: "no plugin root at all", env: {}, host: "claude" },
    {
      name: "empty plugin roots",
      env: { PLUGIN_ROOT: "", CLAUDE_PLUGIN_ROOT: "" },
      host: "claude",
    },
  ])("resolves $host from $name", ({ env, host }) => {
    expect(resolveHost(env)).toBe(host);
  });

  it.each(["Codex", ""])("rejects ACM_HOST=%j", (value) => {
    const resolve = () => resolveHost({ ACM_HOST: value });

    expect(resolve).toThrow(InvalidHostError);
    expect(resolve).toThrow(/ACM_HOST/);
  });
});

describe("hostProfile", () => {
  const withoutClaudeFeatures = {
    projectDirEnv: undefined,
    legacyDataEnv: undefined,
    nativeAutoMemory: false,
    statuslineBadge: false,
  };

  it.each([
    {
      host: "claude",
      features: {
        projectDirEnv: "CLAUDE_PROJECT_DIR",
        legacyDataEnv: "CLAUDE_PLUGIN_DATA",
        nativeAutoMemory: true,
        statuslineBadge: true,
      },
    },
    { host: "codex", features: withoutClaudeFeatures },
    { host: "opencode", features: withoutClaudeFeatures },
  ] as const)(
    "reads Claude's variables and features only on Claude: $host",
    ({ host, features }) => {
      expect(hostProfile(host)).toMatchObject({ id: host, ...features });
    },
  );
});

describe("claudeDependencyFix", () => {
  it.each([
    {
      name: "names the marketplace the plugin was installed from",
      pluginRoot: "/Users/dev/.claude/plugins/cache/construct/adaptive-cognitive-memory/0.4.0",
      fix: "run claude plugin update adaptive-cognitive-memory@construct to retry Claude Code's dependency install, or npm ci --ignore-scripts in /Users/dev/.claude/plugins/cache/construct/adaptive-cognitive-memory/0.4.0",
    },
    {
      name: "offers only npm ci for a checkout loaded in place",
      pluginRoot: "/Users/dev/src/adaptive-cognitive-memory",
      fix: "npm ci --ignore-scripts in /Users/dev/src/adaptive-cognitive-memory",
    },
  ])("$name", ({ pluginRoot, fix }) => {
    expect(claudeDependencyFix(pluginRoot)).toBe(fix);
  });
});

describe("hostToolName", () => {
  it.each([
    { host: "claude", name: "mcp__plugin_adaptive-cognitive-memory_memory__memory_store" },
    { host: "codex", name: "mcp__memory__memory_store" },
    { host: "opencode", name: "memory_memory_store" },
  ] as const)("names memory_store the way $host reports it", ({ host, name }) => {
    expect(hostToolName(host, "memory_store")).toBe(name);
  });
});
