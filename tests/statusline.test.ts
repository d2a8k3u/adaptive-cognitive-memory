import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/cfg";
import { openDatabase } from "../src/db/database";
import { resolveProjectId } from "../src/ids";
import { enableStatusline, refreshShim, statuslinePaths, writeBadgeState } from "../src/statusline";
import {
  type BadgeSessionId,
  type BadgeState,
  badgeLine,
  isBadgeSessionId,
} from "../src/statusline/badge";
import { testModelCacheDir } from "../vitest.config";
import { type ProcessResult, runProcess } from "./fixtures/seed";

const PROCESS_KILL_MS = 25_000;
const UNREACHABLE_MODEL_HOST = "http://127.0.0.1:9/";
const STDIN_MAX_BYTES = 65_536;
const DAY_MS = 86_400_000;
const SHIM_RUNS = 20;
const SHIM_P95_CAP_MS = 50;
const SILENT: ProcessResult = { code: 0, stdout: "", stderr: "" };
const USER_STATUS_LINE = `${JSON.stringify(
  { statusLine: { type: "command", command: "bash ~/.claude/statusline-combined.sh" } },
  null,
  2,
)}\n`;
const STATE_SESSION_ID = "5f0c2c1e-4b8e-4d7a-9a51-2f1e8c3d7b60";
const STATE_AT = "2026-10-20T09:05:00.000Z";
const STATE_LINE = "mem 2 · last UserPromptSubmit 09:05\n";
const PROJECT_DIR = realpathSync(mkdtempSync(join(tmpdir(), "acm-statusline-project-")));
const ANCHORED_PATH = "billing/tax.py";
const ANCHORED_IDS = [
  "01J8GZSQBADGE000000000ROW1",
  "01J8GZSQBADGE000000000ROW2",
  "01J8GZSQBADGE000000000ROW3",
];

interface EnabledWorld {
  readonly pluginData: string;
  readonly env: NodeJS.ProcessEnv;
  readonly snippet: string;
}

function localIso(hours: number, minutes: number): string {
  return new Date(2026, 9, 20, hours, minutes).toISOString();
}

function badgeSessionId(raw: string): BadgeSessionId {
  if (!isBadgeSessionId(raw)) {
    throw new Error(`not a badge session id: ${raw}`);
  }
  return raw;
}

function badgeState(fields: Partial<BadgeState>): BadgeState {
  return {
    version: 1,
    session_id: badgeSessionId("badge-unit"),
    injected: 3,
    last_event: "PreToolUse",
    last_at: localIso(9, 5),
    recall: "on",
    ...fields,
  };
}

function distEntry(...segments: string[]): string {
  const entry = join(process.cwd(), "dist", ...segments);
  if (!existsSync(entry)) {
    throw new Error(
      `dist/${segments.join("/")} missing — run npm run build before the statusline suite`,
    );
  }
  return entry;
}

function snippetFor(pluginData: string): string {
  const shim = `${pluginData}/statusline/badge.cjs`;
  return `{ test -f "${shim}" && node "${shim}"; } || :`;
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `acm-statusline-${prefix}-`));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

function pluginEnv(pluginData: string, home: string): NodeJS.ProcessEnv {
  return {
    CLAUDE_PLUGIN_DATA: pluginData,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    ACM_MODEL_CACHE_DIR: testModelCacheDir,
    ACM_MODEL_REMOTE_HOST: UNREACHABLE_MODEL_HOST,
    CLAUDE_PLUGIN_OPTION_DOWNLOAD_MODEL: "false",
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    TZ: "UTC",
  };
}

function userSettings(home: string): string {
  const settings = join(home, ".claude", "settings.json");
  mkdirSync(dirname(settings));
  writeFileSync(settings, USER_STATUS_LINE);
  return settings;
}

function cli(env: NodeJS.ProcessEnv, args: string[], cwd?: string): Promise<ProcessResult> {
  return runProcess({
    command: process.execPath,
    args: [distEntry("cli.js"), ...args],
    env,
    cwd,
    stdinText: "",
    timeoutMs: PROCESS_KILL_MS,
  });
}

function hook(env: NodeJS.ProcessEnv, event: Record<string, unknown>): Promise<ProcessResult> {
  return runProcess({
    command: process.execPath,
    args: [distEntry("hooks.js")],
    env,
    stdinText: JSON.stringify({ cwd: PROJECT_DIR, ...event }),
    timeoutMs: PROCESS_KILL_MS,
  });
}

function shell(env: NodeJS.ProcessEnv, script: string, stdinText: string): Promise<ProcessResult> {
  return runProcess({
    command: "/bin/sh",
    args: ["-c", script],
    env,
    stdinText,
    timeoutMs: PROCESS_KILL_MS,
  });
}

function sessionStartEvent(sessionId: string): Record<string, unknown> {
  return { hook_event_name: "SessionStart", session_id: sessionId, source: "startup" };
}

function promptEvent(sessionId: string): Record<string, unknown> {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt: "how do we round the vat line in the billing module",
  };
}

function readEvent(sessionId: string): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    tool_name: "Read",
    tool_input: { file_path: join(PROJECT_DIR, ANCHORED_PATH) },
  };
}

function bashEvent(sessionId: string, hookEventName: string): Record<string, unknown> {
  return {
    hook_event_name: hookEventName,
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command: "uv run pytest -q" },
    ...(hookEventName === "PostToolUseFailure" ? { error: "Exit code 1" } : {}),
  };
}

function statuslineInput(sessionId: string): string {
  return JSON.stringify({
    hook_event_name: "Status",
    session_id: sessionId,
    transcript_path: `/tmp/transcripts/${sessionId}.jsonl`,
    cwd: "/tmp/project",
    model: { id: "claude-opus-5-5", display_name: "Opus" },
    workspace: { current_dir: "/tmp/project", project_dir: "/tmp/project" },
    version: "2.1.0",
    cost: { total_cost_usd: 0.01 },
  });
}

function seedAnchoredMemories(env: NodeJS.ProcessEnv): void {
  const projectId = resolveProjectId(PROJECT_DIR);
  const opened = openDatabase(loadConfig(env));
  try {
    const insert = opened.db.prepare(
      `INSERT INTO memories (id, type, kind, anchors, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
       VALUES (?, 'procedural', 'procedure', ?, 'project', ?, ?, ?, ?, 0.5, NULL, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
    );
    for (const [index, id] of ANCHORED_IDS.entries()) {
      insert.run(
        id,
        JSON.stringify([ANCHORED_PATH]),
        projectId,
        `tax rule ${index}`,
        `round the vat line ${index} half up`,
        `body of tax rule ${index}`,
      );
    }
  } finally {
    opened.db.close();
  }
}

function writeState(pluginData: string, fields: Record<string, unknown> = {}): void {
  const state = {
    version: 1,
    session_id: STATE_SESSION_ID,
    injected: 2,
    last_event: "UserPromptSubmit",
    last_at: STATE_AT,
    recall: "on",
    ...fields,
  };
  writeFileSync(
    join(pluginData, "statusline", "sessions", `${STATE_SESSION_ID}.json`),
    JSON.stringify(state),
  );
}

function stateAgedDays(sessionsDir: string, sessionId: string, days: number): string {
  const name = `${sessionId}.json`;
  const file = join(sessionsDir, name);
  writeFileSync(file, "{}");
  const at = new Date(Date.now() - days * DAY_MS);
  utimesSync(file, at, at);
  return name;
}

function rewriteMarker(pluginData: string, fields: Record<string, unknown>): void {
  const marker = join(pluginData, "statusline", "enabled.json");
  writeFileSync(marker, JSON.stringify({ ...JSON.parse(readFileSync(marker, "utf8")), ...fields }));
}

async function enabledWorld(): Promise<EnabledWorld> {
  const pluginData = tempDir("data");
  const env = pluginEnv(pluginData, tempDir("home"));
  const enabled = await cli(env, ["statusline", "on"]);
  expect(enabled.code).toBe(0);
  return { pluginData, env, snippet: enabled.stdout.trimEnd() };
}

async function statuslineAfter(
  arrange: (world: EnabledWorld) => string | Promise<string>,
): Promise<ProcessResult> {
  const world = await enabledWorld();
  const stdinText = await arrange(world);
  return shell(world.env, world.snippet, stdinText);
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(Math.ceil(fraction * sorted.length), sorted.length) - 1]!;
}

describe("badge line (A-5)", () => {
  it.each([
    { input: "recall on", state: badgeState({}), line: "mem 3 · last PreToolUse 09:05" },
    { input: "recall off", state: badgeState({ recall: "off" }), line: "mem off" },
    {
      input: "a 4-digit count after PostToolUseFailure, exactly 40 chars",
      state: badgeState({
        injected: 1234,
        last_event: "PostToolUseFailure",
        last_at: localIso(23, 59),
      }),
      line: "mem 1234 · last PostToolUseFailure 23:59",
    },
    {
      input: "a 5-digit count after PostToolUseFailure, cut to 40 chars",
      state: badgeState({
        injected: 12345,
        last_event: "PostToolUseFailure",
        last_at: localIso(23, 59),
      }),
      line: "mem 12345 · last PostToolUseFailure 23:5",
    },
  ])("$input → $line", ({ state, line }) => {
    expect(badgeLine(state)).toBe(line);
  });
});

describe("statusline on (FR-24)", () => {
  it("prints one snippet line with the absolute plugin data path and leaves the user's settings.json byte-identical with the same mtime", async () => {
    const pluginData = tempDir("data");
    const home = tempDir("home");
    const settings = userSettings(home);
    const mtimeBefore = statSync(settings).mtimeMs;

    const result = await cli(pluginEnv(pluginData, home), ["statusline", "on"]);

    expect(result).toEqual({ code: 0, stdout: `${snippetFor(pluginData)}\n`, stderr: "" });
    expect(result.stdout).not.toContain(process.cwd());
    expect(readFileSync(settings, "utf8")).toBe(USER_STATUS_LINE);
    expect(statSync(settings).mtimeMs).toBe(mtimeBefore);
  });

  it("creates no settings.json when HOME holds none", async () => {
    const home = tempDir("home");

    const result = await cli(pluginEnv(tempDir("data"), home), ["statusline", "on"]);

    expect(result.code).toBe(0);
    expect(filesUnder(home)).toEqual([]);
  });

  it.each([
    { input: "a double quote", character: '"' },
    { input: "a dollar sign", character: "$" },
    { input: "a backtick", character: "`" },
    { input: "a backslash", character: "\\" },
    { input: "a line break", character: "\n" },
  ])("refuses a plugin data path holding $input before writing anything", ({ character }) => {
    const pluginData = mkdtempSync(join(tmpdir(), `acm-statusline-${character}-`));

    expect(() => enableStatusline(pluginData, Buffer.from("shim"), STATE_AT)).toThrow(
      /cannot be quoted in the statusline snippet/,
    );
    expect(existsSync(join(pluginData, "statusline"))).toBe(false);
  });

  it("feeds the badge through a script that captures stdin once and replays it into the snippet", async () => {
    const { pluginData, env, snippet } = await enabledWorld();
    writeState(pluginData);
    const replayScript = `input="$(cat)"\nprintf '%s' "$input" | ${snippet}`;

    expect(await shell(env, replayScript, statuslineInput(STATE_SESSION_ID))).toEqual({
      code: 0,
      stdout: STATE_LINE,
      stderr: "",
    });
  });
});

describe("badge shim (FR-26, FR-27)", () => {
  it("as the whole statusLine command, prints the badge of the session named on stdin", async () => {
    const { pluginData, env, snippet } = await enabledWorld();
    writeState(pluginData);

    expect(await shell(env, snippet, statuslineInput(STATE_SESSION_ID))).toEqual({
      code: 0,
      stdout: STATE_LINE,
      stderr: "",
    });
  });

  it.each([
    {
      input: "never enabled (no statusline directory)",
      arrange: ({ pluginData }: EnabledWorld) => {
        rmSync(join(pluginData, "statusline"), { recursive: true });
        return statuslineInput(STATE_SESSION_ID);
      },
    },
    {
      input: "disabled",
      arrange: async ({ pluginData, env }: EnabledWorld) => {
        writeState(pluginData);
        expect((await cli(env, ["statusline", "off"])).code).toBe(0);
        return statuslineInput(STATE_SESSION_ID);
      },
    },
    {
      input: "plugin data directory gone",
      arrange: ({ pluginData }: EnabledWorld) => {
        writeState(pluginData);
        rmSync(pluginData, { recursive: true });
        return statuslineInput(STATE_SESSION_ID);
      },
    },
    {
      input: "shim file absent",
      arrange: ({ pluginData }: EnabledWorld) => {
        writeState(pluginData);
        rmSync(join(pluginData, "statusline", "badge.cjs"));
        return statuslineInput(STATE_SESSION_ID);
      },
    },
    {
      input: "unknown session",
      arrange: ({ pluginData }: EnabledWorld) => {
        writeState(pluginData);
        return statuslineInput("9d1e7a40-0000-4c3b-8f2e-unknownsess");
      },
    },
    {
      input: "malformed stdin",
      arrange: ({ pluginData }: EnabledWorld) => {
        writeState(pluginData);
        return '{"session_id": ';
      },
    },
    {
      input: "a session_id that climbs out of sessions/",
      arrange: ({ pluginData }: EnabledWorld) => {
        writeState(pluginData);
        return statuslineInput("../enabled");
      },
    },
    {
      input: "stdin over 64 KB",
      arrange: ({ pluginData }: EnabledWorld) => {
        writeState(pluginData);
        return JSON.stringify({
          session_id: STATE_SESSION_ID,
          padding: "x".repeat(STDIN_MAX_BYTES),
        });
      },
    },
    {
      input: "unknown state version",
      arrange: ({ pluginData }: EnabledWorld) => {
        writeState(pluginData, { version: 2 });
        return statuslineInput(STATE_SESSION_ID);
      },
    },
    {
      input: "unknown marker version",
      arrange: ({ pluginData }: EnabledWorld) => {
        writeState(pluginData);
        rewriteMarker(pluginData, { version: 2 });
        return statuslineInput(STATE_SESSION_ID);
      },
    },
    {
      input: "state missing last_at",
      arrange: ({ pluginData }: EnabledWorld) => {
        writeState(pluginData, { last_at: undefined });
        return statuslineInput(STATE_SESSION_ID);
      },
    },
  ])("prints nothing and exits 0 when $input", async ({ arrange }) => {
    expect(await statuslineAfter(arrange)).toEqual(SILENT);
  });
});

describe("badge state written by the recall hooks (FR-26, FR-28)", () => {
  it("counts 3 after a Read injects 3 distinct rows, then reads mem off once recall is off for the project", async () => {
    const { env, snippet } = await enabledWorld();
    seedAnchoredMemories(env);
    const sessionId = "3c9f2d4e-7a1b-4c8d-9e0f-1a2b3c4d5e6f";

    const read = await hook(env, readEvent(sessionId));
    const counted = await shell(env, snippet, statuslineInput(sessionId));
    expect((await cli(env, ["recall", "off"], PROJECT_DIR)).code).toBe(0);
    await hook(env, promptEvent(sessionId));
    const off = await shell(env, snippet, statuslineInput(sessionId));

    expect(ANCHORED_IDS.filter((id) => read.stdout.includes(id))).toEqual(ANCHORED_IDS);
    expect(counted.stdout).toMatch(/^mem 3 · last PreToolUse \d{2}:\d{2}\n$/);
    expect(off).toEqual({ code: 0, stdout: "mem off\n", stderr: "" });
  });

  it("keeps the injection and names the fs error in one stderr line when the badge cannot be written", async () => {
    const { pluginData, env } = await enabledWorld();
    seedAnchoredMemories(env);
    rmSync(join(pluginData, "statusline", "sessions"), { recursive: true });

    const read = await hook(env, readEvent("a1b2c3d4-0000-4e5f-8a9b-badgewritefail"));

    expect(ANCHORED_IDS.filter((id) => read.stdout.includes(id))).toEqual(ANCHORED_IDS);
    expect(read.stderr).toBe("statusline badge not written: ENOENT\n");
    expect(read.code).toBe(0);
  });

  it("replaces the state file whole: a reader holding the previous file still reads it complete", () => {
    const pluginData = tempDir("data");
    enableStatusline(pluginData, readFileSync(distEntry("statusline", "badge.js")), STATE_AT);
    const paths = statuslinePaths(pluginData);
    const earlier = badgeState({ injected: 1, last_event: "SessionStart" });
    const later = badgeState({ injected: 2, last_event: "PreToolUse" });
    const stateFile = join(paths.sessions, `${earlier.session_id}.json`);
    writeBadgeState(paths, earlier);
    const reader = openSync(stateFile, "r");
    try {
      writeBadgeState(paths, later);

      expect(JSON.parse(readFileSync(reader, "utf8"))).toEqual(earlier);
      expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual(later);
    } finally {
      closeSync(reader);
    }
  });

  it("8 concurrent hook writers and 20 shim runs: after the first write every run prints a valid badge and one state file remains", {
    timeout: 60_000,
  }, async () => {
    const { pluginData, env, snippet } = await enabledWorld();
    const sessionId = "c0ffee00-8a7b-4c6d-9e5f-concurrent01";
    expect((await hook(env, bashEvent(sessionId, "PreToolUse"))).code).toBe(0);
    const shimLane = async (runs: number) => {
      const outputs: string[] = [];
      for (let run = 0; run < runs; run += 1) {
        outputs.push((await shell(env, snippet, statuslineInput(sessionId))).stdout);
      }
      return outputs;
    };

    const [writers, ...lanes] = await Promise.all([
      Promise.all(Array.from({ length: 8 }, () => hook(env, bashEvent(sessionId, "PreToolUse")))),
      shimLane(SHIM_RUNS / 2),
      shimLane(SHIM_RUNS / 2),
    ]);

    expect(writers.map(({ code, stderr }) => ({ code, stderr }))).toEqual(
      writers.map(() => ({ code: 0, stderr: "" })),
    );
    expect(
      lanes.flat().filter((line) => !/^mem 0 · last PreToolUse \d{2}:\d{2}\n$/.test(line)),
    ).toEqual([]);
    expect(readdirSync(join(pluginData, "statusline", "sessions"))).toEqual([`${sessionId}.json`]);
  });
});

describe("default off (FR-25)", () => {
  it("every hook event and every existing command leave no statusline file in a fresh data dir", {
    timeout: 120_000,
  }, async () => {
    const pluginData = tempDir("data");
    const env = pluginEnv(pluginData, tempDir("home"));
    const exportFile = join(tempDir("export"), "memories.jsonl");
    const sessionId = "7e2a9c41-5b3d-4f6e-8a1c-2d4b6f8e0a13";
    const events = [
      sessionStartEvent(sessionId),
      promptEvent(sessionId),
      readEvent(sessionId),
      bashEvent(sessionId, "PreToolUse"),
      bashEvent(sessionId, "PostToolUseFailure"),
      bashEvent(sessionId, "PostToolUse"),
      { hook_event_name: "Stop", session_id: sessionId, stop_hook_active: false },
    ];
    const commands = [
      ["recall", "off"],
      ["recall", "on"],
      ["export", exportFile],
      ["import", exportFile],
      ["model-init"],
      ["reembed"],
      ["statusline", "off"],
    ];

    const hookRuns = [];
    for (const event of events) {
      hookRuns.push(await hook(env, event));
    }
    const commandRuns = [];
    for (const args of commands) {
      commandRuns.push(await cli(env, args, PROJECT_DIR));
    }
    await cli(env, ["doctor"], PROJECT_DIR);

    expect([...hookRuns, ...commandRuns].map((run) => run.code)).toEqual(
      [...events, ...commands].map(() => 0),
    );
    expect(existsSync(join(pluginData, "statusline"))).toBe(false);
  });
});

describe("session start maintenance (NFR-16, D-9)", () => {
  const sessionId = "e5f6a7b8-2222-4c3d-8e9f-sessionstart";
  let world: EnabledWorld;
  let sessions: string;
  let kept: string;
  let start: ProcessResult;

  beforeAll(async () => {
    world = await enabledWorld();
    sessions = join(world.pluginData, "statusline", "sessions");
    stateAgedDays(sessions, "0a0a0a0a-old-31-days", 31);
    kept = stateAgedDays(sessions, "0b0b0b0b-recent-29-days", 29);
    writeFileSync(
      join(world.pluginData, "statusline", "badge.cjs"),
      "stale shim of an older plugin",
    );
    rewriteMarker(world.pluginData, { shim_sha256: "0".repeat(64) });
    start = await hook(world.env, sessionStartEvent(sessionId));
  }, 60_000);

  it("prunes a 31-day-old state file, keeps a 29-day-old one and leaves one file per session", () => {
    expect(start.code).toBe(0);
    expect(readdirSync(sessions).sort()).toEqual([kept, `${sessionId}.json`].sort());
  });

  it("reinstalls the shim and its sha when the dist shim differs from the marker", () => {
    const distShim = readFileSync(distEntry("statusline", "badge.js"));
    const marker = JSON.parse(
      readFileSync(join(world.pluginData, "statusline", "enabled.json"), "utf8"),
    );

    expect(readFileSync(join(world.pluginData, "statusline", "badge.cjs")).equals(distShim)).toBe(
      true,
    );
    expect(marker.shim_sha256).toBe(createHash("sha256").update(distShim).digest("hex"));
  });

  it("writes the SessionStart badge", async () => {
    expect((await shell(world.env, world.snippet, statuslineInput(sessionId))).stdout).toMatch(
      /^mem 0 · last SessionStart \d{2}:\d{2}\n$/,
    );
  });

  it("never recreates a marker that off removed while the session started", () => {
    const pluginData = tempDir("data");
    enableStatusline(pluginData, Buffer.from("older shim"), STATE_AT);
    const paths = statuslinePaths(pluginData);
    rmSync(paths.marker);

    refreshShim(paths, readFileSync(distEntry("statusline", "badge.js")));

    expect(existsSync(paths.marker)).toBe(false);
  });
});

describe("statusline off (FR-29)", () => {
  it("prints the snippet to remove, removes every statusline file, stops hook writes and leaves settings.json untouched", async () => {
    const pluginData = tempDir("data");
    const home = tempDir("home");
    const settings = userSettings(home);
    const mtimeBefore = statSync(settings).mtimeMs;
    const env = pluginEnv(pluginData, home);
    const sessionId = "d4c3b2a1-1111-4a2b-9c3d-statuslineoff";
    expect((await cli(env, ["statusline", "on"])).code).toBe(0);
    expect((await hook(env, bashEvent(sessionId, "PreToolUse"))).code).toBe(0);
    expect(existsSync(join(pluginData, "statusline", "sessions", `${sessionId}.json`))).toBe(true);

    const off = await cli(env, ["statusline", "off"]);
    const afterOff = await hook(env, bashEvent(sessionId, "PreToolUse"));

    expect(off).toEqual({ code: 0, stdout: `${snippetFor(pluginData)}\n`, stderr: "" });
    expect(afterOff.code).toBe(0);
    expect(existsSync(join(pluginData, "statusline"))).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe(USER_STATUS_LINE);
    expect(statSync(settings).mtimeMs).toBe(mtimeBefore);
  });
});

describe("shim latency (NFR-15)", () => {
  it.skipIf(process.env.CI === "true")(
    "20 spawned shim runs hold p95 under 50 ms",
    { timeout: 60_000 },
    async () => {
      const { pluginData, env } = await enabledWorld();
      writeState(pluginData);
      const stdinText = statuslineInput(STATE_SESSION_ID);
      const shim = join(pluginData, "statusline", "badge.cjs");
      const runMs: number[] = [];
      for (let run = 0; run < SHIM_RUNS; run += 1) {
        const startedAt = performance.now();
        const result = await runProcess({
          command: process.execPath,
          args: [shim],
          env,
          stdinText,
          timeoutMs: PROCESS_KILL_MS,
        });
        runMs.push(performance.now() - startedAt);
        expect(result.stdout).toBe(STATE_LINE);
      }
      const shimP95 = percentile(runMs, 0.95);
      console.log(
        `NFR-15 shim p95: ${shimP95.toFixed(1)} ms (cap ${SHIM_P95_CAP_MS}), max ${Math.max(...runMs).toFixed(1)} ms over ${SHIM_RUNS} runs`,
      );
      expect(shimP95).toBeLessThanOrEqual(SHIM_P95_CAP_MS);
    },
  );
});
