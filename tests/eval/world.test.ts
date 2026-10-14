import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testModelCacheDir } from "../../vitest.config";
import { deliveredContext } from "./host";
import { createWorld, loadPlugin, projectDirs, runHook } from "./world";

const ROUTING_LINE =
  "Native auto memory is also on: store durable lessons with mcp__plugin_adaptive-cognitive-memory_memory__memory_store, not in the auto-memory MEMORY.md.";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runHook", () => {
  it("runs hooks against the world's own Claude config, never the user's settings", {
    timeout: 30_000,
  }, async () => {
    const home = mkdtempSync(join(tmpdir(), "acm-eval-home-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ autoMemoryEnabled: false }),
    );
    vi.stubEnv("HOME", home);
    const world = await createWorld(["alpha"], testModelCacheDir);
    const { root } = projectDirs(world, "alpha");

    const run = await runHook(loadPlugin(process.cwd()), world, {
      event: "SessionStart",
      cwd: root,
      projectDir: root,
      fields: { source: "startup" },
    });

    expect(deliveredContext("SessionStart", run).text).toBe(ROUTING_LINE);
  });
});
