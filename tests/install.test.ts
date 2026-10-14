import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const INSTALL_BUDGET_MS = 60_000;

const EXPECTED_TOOLS = [
  "memory_delete",
  "memory_doctor",
  "memory_feedback",
  "memory_get",
  "memory_relate",
  "memory_search",
  "memory_status",
  "memory_store",
  "memory_update",
];

describe("install", () => {
  it("installs from the committed tree within 60 s and lists the nine tools over stdio", {
    timeout: 240_000,
  }, async () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "acm-install-"));
    const pluginData = mkdtempSync(join(tmpdir(), "acm-install-data-"));
    let client: Client | undefined;
    try {
      const archive = execFileSync("git", ["archive", "HEAD"], {
        cwd: process.cwd(),
        maxBuffer: 64 * 1024 * 1024,
      });
      const extract = spawnSync("tar", ["-x", "-C", cloneDir], { input: archive, timeout: 30_000 });
      expect(extract.status).toBe(0);

      const startedAt = performance.now();
      const install = spawnSync("npm", ["ci", "--ignore-scripts"], {
        cwd: cloneDir,
        timeout: 120_000,
        encoding: "utf8",
      });
      const elapsedMs = performance.now() - startedAt;
      console.log(`npm ci --ignore-scripts: ${Math.round(elapsedMs)} ms`);
      if (install.status !== 0) {
        throw new Error(`npm ci exited ${install.status}: ${String(install.stderr).slice(-500)}`);
      }
      expect(elapsedMs).toBeLessThanOrEqual(INSTALL_BUDGET_MS);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(cloneDir, "dist", "server.js")],
        env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
      });
      client = new Client({ name: "acm-install-check", version: "0.0.0" });
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
    } finally {
      await client?.close().catch(() => undefined);
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(pluginData, { recursive: true, force: true });
    }
  });
});
