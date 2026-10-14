import { describe, expect, it } from "vitest";
import {
  type AutoMemoryInputs,
  defaultAutoMemoryDirectory,
  resolveAutoMemory,
  type SettingsLayer,
} from "../src/automemory";

const LOCAL = "/work/app/.claude/settings.local.json";
const PROJECT = "/work/app/.claude/settings.json";
const USER = "/home/u/.claude/settings.json";
const DEFAULT_DIRECTORY = "/home/u/.claude/projects/-work-app/memory";

function inputs(
  layers: readonly SettingsLayer[],
  disableEnv: string | undefined = undefined,
): AutoMemoryInputs {
  return { disableEnv, layers, homeDir: "/home/u", defaultDirectory: DEFAULT_DIRECTORY };
}

describe("resolveAutoMemory", () => {
  it.each([
    { name: "no setting leaves it on", env: undefined, layers: [], enabled: true, by: "default" },
    {
      name: "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 outranks a true setting",
      env: "1",
      layers: [{ source: LOCAL, settings: { autoMemoryEnabled: true } }],
      enabled: false,
      by: "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1",
    },
    {
      name: "CLAUDE_CODE_DISABLE_AUTO_MEMORY=0 outranks a false setting",
      env: "0",
      layers: [{ source: LOCAL, settings: { autoMemoryEnabled: false } }],
      enabled: true,
      by: "CLAUDE_CODE_DISABLE_AUTO_MEMORY=0",
    },
    {
      name: "another environment value defers to the settings",
      env: "yes",
      layers: [{ source: PROJECT, settings: { autoMemoryEnabled: false } }],
      enabled: false,
      by: PROJECT,
    },
    {
      name: "the highest layer that sets it wins",
      env: undefined,
      layers: [
        { source: LOCAL, settings: {} },
        { source: PROJECT, settings: { autoMemoryEnabled: false } },
        { source: USER, settings: { autoMemoryEnabled: true } },
      ],
      enabled: false,
      by: PROJECT,
    },
    {
      name: "a value that is not a boolean is ignored",
      env: undefined,
      layers: [
        { source: PROJECT, settings: { autoMemoryEnabled: "false" } },
        { source: USER, settings: { autoMemoryEnabled: false } },
      ],
      enabled: false,
      by: USER,
    },
  ])("$name", ({ env, layers, enabled, by }) => {
    const resolved = resolveAutoMemory(inputs(layers, env));

    expect({ enabled: resolved.enabled, decidedBy: resolved.decidedBy }).toEqual({
      enabled,
      decidedBy: by,
    });
  });

  it.each([
    { name: "the default directory", layers: [], index: `${DEFAULT_DIRECTORY}/MEMORY.md` },
    {
      name: "a ~/ directory under the home directory",
      layers: [{ source: USER, settings: { autoMemoryDirectory: "~/notes/memory" } }],
      index: "/home/u/notes/memory/MEMORY.md",
    },
    {
      name: "the highest layer's absolute directory",
      layers: [
        { source: PROJECT, settings: { autoMemoryDirectory: "/data/memory" } },
        { source: USER, settings: { autoMemoryDirectory: "~/notes/memory" } },
      ],
      index: "/data/memory/MEMORY.md",
    },
    {
      name: "the default directory instead of a relative one",
      layers: [{ source: PROJECT, settings: { autoMemoryDirectory: "memory" } }],
      index: `${DEFAULT_DIRECTORY}/MEMORY.md`,
    },
  ])("indexes $name", ({ layers, index }) => {
    expect(resolveAutoMemory(inputs(layers)).indexPath).toBe(index);
  });
});

describe("defaultAutoMemoryDirectory", () => {
  it.each([
    {
      name: "a subdirectory of a repository uses the repository root",
      facts: { realpath: "/work/billing-api/src", gitCommonDir: "/work/billing-api/.git" },
      directory: "/home/u/.claude/projects/-work-billing-api/memory",
    },
    {
      name: "a linked worktree shares the main checkout's directory",
      facts: { realpath: "/work/wt/feature_x", gitCommonDir: "/work/billing-api/.git" },
      directory: "/home/u/.claude/projects/-work-billing-api/memory",
    },
    {
      name: "a directory outside git uses its own path, every other character a dash",
      facts: { realpath: "/tmp/notes_v2.d", gitCommonDir: undefined },
      directory: "/home/u/.claude/projects/-tmp-notes-v2-d/memory",
    },
  ])("$name", ({ facts, directory }) => {
    expect(defaultAutoMemoryDirectory("/home/u/.claude", facts)).toBe(directory);
  });
});
