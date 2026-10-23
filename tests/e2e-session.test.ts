import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { testModelEnv } from "../vitest.config";
import { runProcess, toolText } from "./fixtures/seed";

const SESSION_A_CWD = "/tmp/acm-e2e-project-alpha";
const SESSION_B_CWD = "/tmp/acm-e2e-project-beta";
const CZ_SESSION_PROMPT = "Jaký balíčkovací manažer mám použít pro nové projekty?";
const EN_SESSION_PROMPT = "which package manager should i use for the new typescript service";

const STORED_FACT = {
  title: "Preferred package manager",
  content:
    "Use pnpm for all new TypeScript projects because the user prefers fast installs and strict dependency graphs.",
  type: "pattern",
  kind: "preference",
  conflict_key: "tool.package_manager",
  cardinality: "single",
  value_text: "pnpm",
  scope: "user",
};

const COMMON_ENGLISH_WORDS = new Set([
  "the",
  "and",
  "use",
  "for",
  "all",
  "new",
  "because",
  "user",
  "prefers",
  "with",
  "that",
  "this",
  "from",
  "when",
  "should",
]);

function isEnglishText(text: string): boolean {
  if ([...text].some((char) => char.charCodeAt(0) > 0x7f)) {
    return false;
  }
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.filter((word) => COMMON_ENGLISH_WORDS.has(word)).length >= 3;
}

function distEntry(name: string): string {
  const entry = join(process.cwd(), "dist", name);
  if (!existsSync(entry)) {
    throw new Error(`dist/${name} missing — run npm run build before the e2e suite`);
  }
  return entry;
}

async function sessionBPrompt(
  pluginData: string,
  prompt: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runProcess({
    command: process.execPath,
    args: [distEntry("hooks.js")],
    env: { CLAUDE_PLUGIN_DATA: pluginData, ...testModelEnv },
    cwd: SESSION_B_CWD,
    stdinText: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      cwd: SESSION_B_CWD,
      prompt,
    }),
    timeoutMs: 30_000,
  });
}

describe("two-session e2e (AC-28, AC-8)", () => {
  it("a user fact stored by a czech session A is injected into session B in another project", {
    timeout: 180_000,
  }, async () => {
    const pluginData = mkdtempSync(join(tmpdir(), "acm-e2e-"));
    mkdirSync(SESSION_A_CWD, { recursive: true });
    mkdirSync(SESSION_B_CWD, { recursive: true });
    const childEnv = {
      CLAUDE_PLUGIN_DATA: pluginData,
      ...testModelEnv,
    };

    const client = new Client({ name: "acm-e2e-session", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distEntry("server.js")],
      env: childEnv,
      cwd: SESSION_A_CWD,
      stderr: "pipe",
    });
    await client.connect(transport);
    try {
      const stored = await client.callTool({ name: "memory_store", arguments: STORED_FACT });
      const storedValue = JSON.parse(toolText(stored)) as {
        id: string;
        action: string;
      };
      expect(storedValue.action).toBe("created");

      const fetched = await client.callTool({
        name: "memory_get",
        arguments: { id: storedValue.id },
      });
      const record = JSON.parse(toolText(fetched)) as {
        title: string;
        content: string;
        scope: string;
      };
      expect(record.scope).toBe("user");
      expect(isEnglishText(`${record.title} ${record.content}`)).toBe(true);
    } finally {
      await client.close();
    }

    const englishRecall = await sessionBPrompt(pluginData, EN_SESSION_PROMPT);
    expect(englishRecall.code).toBe(0);
    expect(englishRecall.stderr).toBe("");
    expect(englishRecall.stdout).toContain("pnpm");

    const sessionB = new Client({ name: "acm-e2e-session-b", version: "0.0.0" });
    await sessionB.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [distEntry("server.js")],
        env: childEnv,
        cwd: SESSION_B_CWD,
        stderr: "pipe",
      }),
    );
    try {
      const czechSearch = await sessionB.callTool({
        name: "memory_search",
        arguments: { query: CZ_SESSION_PROMPT },
      });
      const found = JSON.parse(toolText(czechSearch)) as { results: { abstract: string }[] };
      expect(found.results.some((row) => row.abstract.includes("pnpm"))).toBe(true);
    } finally {
      await sessionB.close();
    }
  });

  it("a project constraint stored by the server from a nested directory reaches the hook at the repository root", {
    timeout: 60_000,
  }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "acm-e2e-repo-")));
    const nested = join(root, "src", "app");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
    const childEnv = {
      CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "acm-e2e-")),
      ...testModelEnv,
      PATH: process.env.PATH ?? "",
    };

    const client = new Client({ name: "acm-e2e-identity", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [distEntry("server.js")],
        env: childEnv,
        cwd: nested,
        stderr: "pipe",
      }),
    );
    let storedId: string;
    try {
      const stored = await client.callTool({
        name: "memory_store",
        arguments: {
          title: "Release checklist owner",
          content: "Only the platform team edits the release checklist in docs/release.md.",
          type: "pattern",
          kind: "constraint",
          conflict_key: "team.release_checklist_owner",
          cardinality: "single",
          value_text: "platform team",
          scope: "project",
        },
      });
      storedId = (JSON.parse(toolText(stored)) as { id: string }).id;
    } finally {
      await client.close();
    }

    const sessionStart = await runProcess({
      command: process.execPath,
      args: [distEntry("hooks.js")],
      env: { ...childEnv, CLAUDE_PROJECT_DIR: root },
      cwd: root,
      stdinText: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: root }),
      timeoutMs: 30_000,
    });
    expect(sessionStart.code).toBe(0);
    expect(sessionStart.stderr).toBe("");
    expect(sessionStart.stdout).toContain(storedId);
  });

  it.each([
    { location: "the default auto memory index", customDirectory: false },
    { location: "the index in the project's autoMemoryDirectory", customDirectory: true },
  ])(
    "the server rejects restating CLAUDE.md or $location",
    async ({ customDirectory }) => {
      const project = realpathSync(mkdtempSync(join(tmpdir(), "acm-e2e-rules-")));
      const configDir = mkdtempSync(join(tmpdir(), "acm-e2e-claude-"));
      const memoryDir = customDirectory
        ? join(mkdtempSync(join(tmpdir(), "acm-e2e-custom-")), "memory")
        : join(configDir, "projects", project.replace(/[^A-Za-z0-9]/g, "-"), "memory");
      mkdirSync(memoryDir, { recursive: true });
      if (customDirectory) {
        mkdirSync(join(project, ".claude"));
        writeFileSync(
          join(project, ".claude", "settings.json"),
          JSON.stringify({ autoMemoryDirectory: memoryDir }),
        );
      }
      const claudeMd = join(project, "CLAUDE.md");
      const memoryIndex = join(memoryDir, "MEMORY.md");
      writeFileSync(claudeMd, "- Run database migrations with alembic only.\n");
      writeFileSync(memoryIndex, "- The staging database resets every Monday morning.\n");
      const client = new Client({ name: "acm-e2e-instructions", version: "0.0.0" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [distEntry("server.js")],
          env: {
            CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "acm-e2e-")),
            ...testModelEnv,
            CLAUDE_CONFIG_DIR: configDir,
            PATH: process.env.PATH ?? "",
          },
          cwd: project,
          stderr: "pipe",
        }),
      );
      try {
        for (const [content, source] of [
          ["Run database migrations with Alembic only", claudeMd],
          ["the staging database resets every Monday", memoryIndex],
        ] as const) {
          const outcome = await client.callTool({
            name: "memory_store",
            arguments: {
              title: "Database operations",
              content,
              type: "semantic",
              kind: "fact",
              conflict_key: "db.operations",
            },
          });
          expect(outcome.isError, source).toBe(true);
          expect(toolText(outcome)).toContain(source);
        }
      } finally {
        await client.close();
      }
    },
    60_000,
  );
});
