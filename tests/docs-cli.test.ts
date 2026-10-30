import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DATA_DIR_SEGMENTS } from "../src/cfg";
import { testModelEnv } from "../vitest.config";
import { seedLegacyStore } from "./fixtures/seed";

const CLI_DOC = join(process.cwd(), "docs", "cli.md");
const HOST_HEADINGS = {
  claude: "## Claude Code",
  codex: "## Codex",
  opencode: "## OpenCode",
} as const;
type Host = keyof typeof HOST_HEADINGS;
const HOSTS = Object.keys(HOST_HEADINGS) as Host[];
const RUNNABLE_FENCE = /^```sh\n([\s\S]*?)^```$/gm;
const ROOT_PLACEHOLDER = /<root>/g;
const BLOCK_TIMEOUT_MS = 60_000;
const STATUSLINE_COMMAND = /\bstatusline\s+(?:on|off)\b/;
const STORE_PROJECT_ID = "0123456789abcdef";

function hostSection(text: string, host: Host): string {
  const start = text.indexOf(`\n${HOST_HEADINGS[host]}\n`);
  if (start === -1) {
    return "";
  }
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n## ", HOST_HEADINGS[host].length);
  return next === -1 ? rest : rest.slice(0, next);
}

function runnableBlocks(section: string): string[] {
  return [...section.matchAll(RUNNABLE_FENCE)].map((match) => (match[1] ?? "").trim());
}

describe("docs/cli.md per-host lines (FR-26)", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "acm-docs-cli-home-")));
  const project = realpathSync(mkdtempSync(join(tmpdir(), "acm-docs-cli-repo-")));
  beforeAll(() => {
    const dataDir = join(home, ...DEFAULT_DATA_DIR_SEGMENTS);
    mkdirSync(dataDir, { recursive: true });
    const store = seedLegacyStore(dataDir, {
      memories: 5,
      contentChars: 200,
      projectId: STORE_PROJECT_ID,
      pinnedAbstract: "docs cli seed",
    });
    store.anchor.close();
    spawnSync("git", ["init", "-q", project], { encoding: "utf8" });
  });

  function run(block: string): { status: number | null; output: string } {
    const result = spawnSync("sh", ["-c", block.replace(ROOT_PLACEHOLDER, process.cwd())], {
      cwd: project,
      encoding: "utf8",
      timeout: BLOCK_TIMEOUT_MS,
      env: { PATH: process.env.PATH, HOME: home, ...testModelEnv },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  const text = readFileSync(CLI_DOC, "utf8");

  it.each(HOSTS)("%s section lists doctor and recall on|off lines that run and exit 0", (host) => {
    const blocks = runnableBlocks(hostSection(text, host));

    expect(blocks.some((block) => /\bdoctor\b/.test(block))).toBe(true);
    expect(blocks.some((block) => /\brecall\s+on\b/.test(block))).toBe(true);
    expect(blocks.some((block) => /\brecall\s+off\b/.test(block))).toBe(true);
    for (const block of blocks) {
      expect(block).toContain("ACM_DATA_DIR=");
      expect(run(block)).toMatchObject({ status: 0 });
    }
  });

  it("lists the statusline lines under Claude Code only", () => {
    const withStatusline = (host: Host): boolean =>
      runnableBlocks(hostSection(text, host)).some((block) => STATUSLINE_COMMAND.test(block));

    expect(HOSTS.filter(withStatusline)).toEqual(["claude"]);
  });
});
