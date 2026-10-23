import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/cfg";
import { openDatabase } from "../src/db/database";
import { resolveProjectId } from "../src/ids";
import { testModelEnv } from "../vitest.config";
import { type ProcessResult, runProcess } from "./fixtures/seed";

const HOOK_KILL_MS = 25_000;
const PROJECT_DIR = realpathSync(mkdtempSync(join(tmpdir(), "acm-read-project-")));
const PROJECT_ID = resolveProjectId(PROJECT_DIR);
const ABSTAINED: ProcessResult = { code: 0, stdout: "", stderr: "" };

const ANCHORED = [
  {
    anchorClass: "project-relative path",
    id: "01J8GZSQREAD0000000000PATH",
    anchor: "billing/tax.py",
    filePath: "billing/tax.py",
  },
  {
    anchorClass: "directory prefix",
    id: "01J8GZSQREAD00000000PREFIX",
    anchor: "migrations/versions/",
    filePath: "migrations/versions/0042_add_refunds.py",
  },
  {
    anchorClass: "basename",
    id: "01J8GZSQREAD000000BASENAME",
    anchor: "Dockerfile",
    filePath: "deploy/Dockerfile",
  },
  {
    anchorClass: "extension",
    id: "01J8GZSQREAD00000EXTENSION",
    anchor: ".vue",
    filePath: "src/components/GuideCard.vue",
  },
] as const;

const [PATH_ANCHORED] = ANCHORED;

function hookEntryPath(): string {
  const entry = join(process.cwd(), "dist", "hooks.js");
  if (!existsSync(entry)) {
    throw new Error("dist/hooks.js missing — run npm run build before the Read recall suite");
  }
  return entry;
}

function freshEnv(): NodeJS.ProcessEnv {
  return {
    CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "acm-read-")),
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "acm-read-claude-")),
    ...testModelEnv,
  };
}

function seedAnchoredMemories(env: NodeJS.ProcessEnv): void {
  const opened = openDatabase(loadConfig(env));
  try {
    const insert = opened.db.prepare(
      `INSERT INTO memories (id, type, kind, anchors, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
       VALUES (?, 'procedural', 'procedure', ?, 'project', ?, ?, ?, ?, 0.5, NULL, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
    );
    for (const row of ANCHORED) {
      insert.run(
        row.id,
        JSON.stringify([row.anchor]),
        PROJECT_ID,
        `${row.anchorClass} rule`,
        `follow the rule anchored on ${row.anchor}`,
        `body of the rule anchored on ${row.anchor}`,
      );
    }
  } finally {
    opened.db.close();
  }
}

function preToolUse(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  toolName: string,
  toolInput: unknown,
): Promise<ProcessResult> {
  return runProcess({
    command: process.execPath,
    args: [hookEntryPath()],
    env,
    stdinText: JSON.stringify({
      hook_event_name: "PreToolUse",
      cwd: PROJECT_DIR,
      session_id: sessionId,
      tool_name: toolName,
      tool_input: toolInput,
    }),
    timeoutMs: HOOK_KILL_MS,
  });
}

function editInput(filePath: string): Record<string, string> {
  return { file_path: join(PROJECT_DIR, filePath), old_string: "rate", new_string: "vat_rate" };
}

describe("PreToolUse Read recall", () => {
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    env = freshEnv();
    seedAnchoredMemories(env);
  });

  it.each(ANCHORED)(
    "Read output equals Edit output for an anchor by $anchorClass, fresh session each",
    async ({ anchorClass, id, filePath }) => {
      const edit = await preToolUse(env, `edit ${anchorClass}`, "Edit", editInput(filePath));
      const read = await preToolUse(env, `read ${anchorClass}`, "Read", {
        file_path: join(PROJECT_DIR, filePath),
        offset: 120,
        limit: 40,
      });

      expect(edit.stdout).toContain(id);
      expect(read).toEqual(edit);
    },
  );

  it("does not inject a row at Edit that the Read of the same file injected earlier in the session", async () => {
    const read = await preToolUse(env, "read then edit", "Read", {
      file_path: join(PROJECT_DIR, PATH_ANCHORED.filePath),
    });
    const edit = await preToolUse(env, "read then edit", "Edit", editInput(PATH_ANCHORED.filePath));

    expect(read.stdout).toContain(PATH_ANCHORED.id);
    expect(edit).toEqual(ABSTAINED);
  });

  it.each([
    {
      input: "Grep on an anchored file",
      toolName: "Grep",
      toolInput: { pattern: "round_half_up", path: join(PROJECT_DIR, PATH_ANCHORED.filePath) },
    },
    {
      input: "Glob for an anchored extension",
      toolName: "Glob",
      toolInput: { pattern: "src/components/*.vue", path: PROJECT_DIR },
    },
    {
      input: "Read with a non-string file_path",
      toolName: "Read",
      toolInput: { file_path: [join(PROJECT_DIR, PATH_ANCHORED.filePath)] },
    },
  ])("abstains, exit 0, for $input", async ({ input, toolName, toolInput }) => {
    expect(await preToolUse(env, `abstain ${input}`, toolName, toolInput)).toEqual(ABSTAINED);
  });
});
