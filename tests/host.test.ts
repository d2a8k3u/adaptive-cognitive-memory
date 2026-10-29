import { describe, expect, it } from "vitest";
import { hostProfile, InvalidHostError, resolveHost } from "../src/host";

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
