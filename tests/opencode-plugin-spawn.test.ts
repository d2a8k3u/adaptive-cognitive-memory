import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdaptiveCognitiveMemory } from "../opencode/adaptive-cognitive-memory";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

type ChatOutput = Parameters<NonNullable<Hooks["chat.message"]>>[1];
type MessagePart = ChatOutput["parts"][number];
type ToolOutput = Parameters<NonNullable<Hooks["tool.execute.after"]>>[1];
type BusEvent = Parameters<NonNullable<Hooks["event"]>>[0]["event"];
type PromptAsyncOptions = Parameters<PluginInput["client"]["session"]["promptAsync"]>[0];

interface EngineScript {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly stdinError?: boolean;
  readonly spawnError?: boolean;
  readonly hang?: boolean;
}

interface SpawnedEngine {
  readonly envelope: () => Readonly<Record<string, unknown>>;
  readonly kills: string[];
}

const DIRECTORY = "/workspace/billing";
const MESSAGE_ID = "msg_9a3f0c2b1001AbCdEfGhIjKlMn";
const SESSION = "ses_5a1b2c3d4ffeAbCdEfGhIjKlMn";
const ENGINE_TIMEOUT_MS = 5_000;
const ENGINE_OUTPUT_MAX_BYTES = 262_144;
const STDERR_LINE_MAX_CHARS = 300;
const SESSION_STATES_MAX = 1_024;
const REPLAY_EVENTS = 1_000;
const EMPTY_CONTEXT_REPLY_BYTES = '{"context":[""]}'.length;
const CHECKPOINT = "Before you stop, store the release freeze with memory_memory_store.";
const HANDLED_TOOL_IDS: ReadonlySet<string> = new Set([
  "bash",
  "read",
  "edit",
  "write",
  "memory_memory_feedback",
  "memory_memory_store",
  "memory_memory_update",
]);
const REPLAY_TOOL_IDS = [
  "bash",
  "read",
  "edit",
  "write",
  "glob",
  "grep",
  "list",
  "webfetch",
  "todowrite",
  "task",
  "apply_patch",
  "memory_memory_feedback",
  "memory_memory_store",
  "memory_memory_update",
  "memory_memory_search",
  "memory_memory_get",
  "github_create_issue",
] as const;
const REPLAY_BUS_EVENTS: readonly BusEvent[] = [
  { type: "session.idle", properties: { sessionID: SESSION } },
  { type: "session.compacted", properties: { sessionID: SESSION } },
  { type: "file.edited", properties: { file: "src/a.ts" } },
  { type: "file.watcher.updated", properties: { file: "src/a.ts", event: "change" } },
  { type: "server.connected", properties: {} },
];

const spawnMock = vi.mocked(spawn);
const spawned: SpawnedEngine[] = [];
const scripts: EngineScript[] = [];

afterEach(() => {
  spawnMock.mockReset();
  spawned.splice(0);
  scripts.splice(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeEngine(script: EngineScript): ChildProcess {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: Buffer[] = [];
  const kills: string[] = [];
  let closed = false;
  const close = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (closed) {
      return;
    }
    closed = true;
    stdout.resume().end();
    stderr.resume().end();
    void Promise.all([once(stdout, "end"), once(stderr, "end")]).then(() =>
      emitter.emit("close", code, signal),
    );
  };
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (script.stdinError === true) {
        callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        return;
      }
      written.push(chunk);
      callback();
    },
  });
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    kill: (signal: NodeJS.Signals) => {
      kills.push(signal);
      close(null, signal);
      return true;
    },
  });
  spawned.push({ envelope: () => JSON.parse(Buffer.concat(written).toString("utf8")), kills });
  process.nextTick(() => {
    if (script.spawnError === true) {
      emitter.emit("error", Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }));
      close(-2, null);
      return;
    }
    if (script.hang === true) {
      return;
    }
    stderr.write(script.stderr ?? "");
    stdout.write(script.stdout ?? "");
    close(script.code ?? 0, null);
  });
  return child as unknown as ChildProcess;
}

function scriptEngine(...queued: EngineScript[]): void {
  scripts.push(...queued);
  spawnMock.mockImplementation(() => fakeEngine(scripts.shift() ?? {}));
}

function contextReply(blocks: readonly string[]): string {
  return JSON.stringify({ context: blocks });
}

function promptAsyncStub(promptAsync: (options: PromptAsyncOptions) => Promise<unknown>): {
  readonly calls: PromptAsyncOptions[];
  readonly client: PluginInput["client"];
} {
  const calls: PromptAsyncOptions[] = [];
  const recorded = (options: PromptAsyncOptions) => {
    calls.push(options);
    return promptAsync(options);
  };
  return {
    calls,
    client: { session: { promptAsync: recorded } } as unknown as PluginInput["client"],
  };
}

function openPlugin(
  client: PluginInput["client"] = promptAsyncStub(async () => ({ data: undefined })).client,
): Promise<Hooks> {
  return AdaptiveCognitiveMemory({
    client,
    project: { id: "acm-opencode-test", worktree: DIRECTORY, vcs: "git", time: { created: 0 } },
    directory: DIRECTORY,
    worktree: DIRECTORY,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: undefined as unknown as PluginInput["$"],
  });
}

function userPart(id: string, text: string): MessagePart {
  return { id, sessionID: SESSION, messageID: MESSAGE_ID, type: "text", text };
}

function chatOutput(parts: MessagePart[]): ChatOutput {
  return {
    message: {
      id: MESSAGE_ID,
      sessionID: SESSION,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude" },
    },
    parts,
  };
}

function bashOutput(): ToolOutput {
  return { title: "bash", output: "1 failed", metadata: { output: "1 failed", exit: 1 } };
}

function stderrLines(): () => string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    const text = String(chunk);
    lines.push(...text.split("\n").filter((line) => line !== ""));
    return true;
  });
  return () => lines;
}

function chat(hooks: Hooks, sessionID: string, text: string): Promise<void> {
  return hooks["chat.message"]!(
    { sessionID },
    chatOutput([userPart("prt_18a922161000AbCdEfGhIjKlMn", text)]),
  );
}

describe("OpenCode plugin when the engine fails (FR-24)", () => {
  it.each([
    { name: "exits non-zero", script: { code: 1 }, failure: "EngineExitError" },
    { name: "prints invalid JSON", script: { stdout: "not json {" }, failure: "EngineOutputError" },
    {
      name: "prints a reply without a context list",
      script: { stdout: '{"context":"recall"}' },
      failure: "EngineOutputError",
    },
    {
      name: "closes its stdin before reading the envelope",
      script: { stdinError: true },
      failure: "EngineSpawnError",
    },
    { name: "cannot be started", script: { spawnError: true }, failure: "EngineSpawnError" },
  ])(
    "leaves the chat parts unchanged and reports one class-name line when the engine $name",
    async ({ script, failure }) => {
      scriptEngine(script);
      const hooks = await openPlugin();
      const output = chatOutput([userPart("prt_18a922161000AbCdEfGhIjKlMn", "deploy billing")]);
      const before = structuredClone(output);
      const stderr = stderrLines();

      await expect(hooks["chat.message"]!({ sessionID: SESSION }, output)).resolves.toBeUndefined();

      expect(output).toEqual(before);
      expect(stderr()).toEqual([`memory opencode chat.message failed: ${failure}`]);
    },
  );

  it.each<{ hook: string; run: (hooks: Hooks) => Promise<unknown>; unchanged: unknown }>([
    {
      hook: "tool.execute.after",
      run: async (hooks) => {
        const output = bashOutput();
        await hooks["tool.execute.after"]!(
          { tool: "bash", sessionID: SESSION, callID: "call_1", args: { command: "npm test" } },
          output,
        );
        return output;
      },
      unchanged: bashOutput(),
    },
    {
      hook: "experimental.session.compacting",
      run: async (hooks) => {
        const output = { context: ["existing context"] };
        await hooks["experimental.session.compacting"]!({ sessionID: SESSION }, output);
        return output;
      },
      unchanged: { context: ["existing context"] },
    },
  ])("leaves the $hook output unchanged on invalid engine output", async (row) => {
    scriptEngine({ stdout: "not json {" });
    const hooks = await openPlugin();
    const stderr = stderrLines();

    const output = await row.run(hooks);

    expect(output).toEqual(row.unchanged);
    expect(stderr()).toEqual([`memory opencode ${row.hook} failed: EngineOutputError`]);
  });

  it.each([
    {
      name: "invalid engine output",
      script: { stdout: "not json {" },
      promptAsync: async () => ({ data: undefined }),
      failure: "EngineOutputError",
      prompts: 0,
    },
    {
      name: "a rejected re-prompt",
      script: { stdout: contextReply([CHECKPOINT]) },
      promptAsync: async () => Promise.reject(new TypeError("fetch failed")),
      failure: "PromptAsyncError",
      prompts: 1,
    },
  ])("reports $name on session.idle as one class-name line", async (row) => {
    scriptEngine(row.script);
    const stub = promptAsyncStub(row.promptAsync);
    const hooks = await openPlugin(stub.client);
    const stderr = stderrLines();

    await expect(
      hooks.event!({ event: { type: "session.idle", properties: { sessionID: SESSION } } }),
    ).resolves.toBeUndefined();

    expect(stderr()).toEqual([`memory opencode session.idle failed: ${row.failure}`]);
    expect(stub.calls).toHaveLength(row.prompts);
  });

  it("kills the engine at 5 s and not before, leaving the parts unchanged", async () => {
    vi.useFakeTimers();
    scriptEngine({ hang: true });
    const hooks = await openPlugin();
    const output = chatOutput([userPart("prt_18a922161000AbCdEfGhIjKlMn", "deploy billing")]);
    const before = structuredClone(output);
    const stderr = stderrLines();

    const handled = hooks["chat.message"]!({ sessionID: SESSION }, output);
    await vi.advanceTimersByTimeAsync(ENGINE_TIMEOUT_MS - 1);
    const killsBeforeBudget = [...spawned[0]!.kills];
    await vi.advanceTimersByTimeAsync(1);
    await handled;

    expect(killsBeforeBudget).toEqual([]);
    expect(spawned[0]!.kills).toEqual(["SIGKILL"]);
    expect(output).toEqual(before);
    expect(stderr()).toEqual(["memory opencode chat.message failed: EngineTimeoutError"]);
  });

  it("accepts an engine reply of exactly 262,144 bytes and rejects one byte more", async () => {
    const atCap = "x".repeat(ENGINE_OUTPUT_MAX_BYTES - EMPTY_CONTEXT_REPLY_BYTES);
    scriptEngine({ stdout: contextReply([atCap]) }, { stdout: contextReply([`${atCap}x`]) });
    const hooks = await openPlugin();
    const accepted = chatOutput([userPart("prt_18a922161000AbCdEfGhIjKlMn", "deploy billing")]);
    const rejected = chatOutput([userPart("prt_18a922161000AbCdEfGhIjKlMn", "deploy billing")]);
    const stderr = stderrLines();

    await hooks["chat.message"]!({ sessionID: SESSION }, accepted);
    await hooks["chat.message"]!({ sessionID: SESSION }, rejected);

    expect(accepted.parts.map((part) => (part.type === "text" ? part.text : ""))).toEqual([
      "deploy billing",
      atCap,
    ]);
    expect(rejected.parts).toHaveLength(1);
    expect(stderr()).toEqual(["memory opencode chat.message failed: EngineOutputError"]);
  });

  it("forwards the engine's stderr as one line of at most 300 characters", async () => {
    const engineLine = `memory hook chat.message failed: ${"E".repeat(STDERR_LINE_MAX_CHARS)}`;
    scriptEngine({ stderr: `${engineLine}\nsecond line\n` });
    const hooks = await openPlugin();
    const stderr = stderrLines();

    await chat(hooks, SESSION, "deploy billing");

    expect(stderr()).toEqual([engineLine.slice(0, STDERR_LINE_MAX_CHARS)]);
  });
});

describe("OpenCode plugin spawn count (NFR-5)", () => {
  it("spawns the engine exactly once per handled event over a replay of 1,000 mixed events", async () => {
    scriptEngine();
    const hooks = await openPlugin();
    let handledEvents = 0;

    for (let index = 0; index < REPLAY_EVENTS; index += 1) {
      const tool = REPLAY_TOOL_IDS[index % REPLAY_TOOL_IDS.length]!;
      const busEvent = REPLAY_BUS_EVENTS[index % REPLAY_BUS_EVENTS.length]!;
      switch (index % 5) {
        case 0:
        case 1:
          await hooks["tool.execute.after"]!(
            { tool, sessionID: SESSION, callID: `call_${index}`, args: { command: "ls" } },
            { title: tool, output: "", metadata: {} },
          );
          handledEvents += HANDLED_TOOL_IDS.has(tool) ? 1 : 0;
          break;
        case 2:
        case 3:
          await hooks.event!({ event: busEvent });
          handledEvents += busEvent.type === "session.idle" ? 1 : 0;
          break;
        default:
          await chat(hooks, `ses_replay${index}`, "deploy billing");
          handledEvents += 1;
      }
    }

    expect(handledEvents).toBeGreaterThan(0);
    expect(handledEvents).toBeLessThan(REPLAY_EVENTS);
    expect(spawnMock).toHaveBeenCalledTimes(handledEvents);
  });
});

describe("OpenCode plugin session state", () => {
  it("keeps 1,024 sessions and forgets the oldest when a 1,025th starts", async () => {
    scriptEngine();
    const hooks = await openPlugin();
    const sessionIds = Array.from({ length: SESSION_STATES_MAX + 1 }, (_, index) => `ses_${index}`);
    for (const sessionID of sessionIds.slice(0, SESSION_STATES_MAX)) {
      await chat(hooks, sessionID, "deploy billing");
    }
    const startsBefore = spawned.length;

    await chat(hooks, sessionIds[0]!, "deploy billing");
    await chat(hooks, sessionIds[SESSION_STATES_MAX]!, "deploy billing");
    await chat(hooks, sessionIds[0]!, "deploy billing");
    await chat(hooks, sessionIds[SESSION_STATES_MAX]!, "deploy billing");

    expect(spawned.slice(startsBefore).map((engine) => engine.envelope().session_start)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  it("gives its own checkpoint re-prompt no recall, once", async () => {
    scriptEngine({ stdout: contextReply([CHECKPOINT]) });
    const stub = promptAsyncStub(async () => ({ data: undefined }));
    const hooks = await openPlugin(stub.client);

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: SESSION } } });
    await chat(hooks, SESSION, CHECKPOINT);
    const spawnsAfterReprompt = spawned.length;
    await chat(hooks, SESSION, CHECKPOINT);

    expect(stub.calls).toHaveLength(1);
    expect(spawnsAfterReprompt).toBe(1);
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.envelope()).toEqual({
      hook_event_name: "chat.message",
      session_id: SESSION,
      cwd: DIRECTORY,
      prompt: CHECKPOINT,
      session_start: true,
    });
  });
});

describe("OpenCode re-prompt and the promptAsync call", () => {
  it("skips recall for a re-prompt OpenCode delivers before promptAsync resolves", async () => {
    scriptEngine({ stdout: contextReply([CHECKPOINT]) });
    const plugin: { hooks?: Hooks } = {};
    const stub = promptAsyncStub(async () => {
      await chat(plugin.hooks!, SESSION, CHECKPOINT);
      return { data: undefined };
    });
    plugin.hooks = await openPlugin(stub.client);

    await plugin.hooks.event!({
      event: { type: "session.idle", properties: { sessionID: SESSION } },
    });

    expect(stub.calls).toHaveLength(1);
    expect(spawned).toHaveLength(1);
  });

  it("recalls for a user message equal to a checkpoint whose re-prompt failed", async () => {
    scriptEngine({ stdout: contextReply([CHECKPOINT]) });
    const stub = promptAsyncStub(async () => ({ error: { name: "BadRequest" } }));
    const hooks = await openPlugin(stub.client);
    stderrLines();

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: SESSION } } });
    await chat(hooks, SESSION, CHECKPOINT);

    expect(spawned).toHaveLength(2);
  });
});

describe("OpenCode part ids at the end of the 48-bit time field", () => {
  it("appends a part after an id one tick below the limit", async () => {
    scriptEngine({ stdout: contextReply(["<memory>recall</memory>"]) });
    const hooks = await openPlugin();
    const output = chatOutput([userPart("prt_fffffffffffeAbCdEfGhIjKlMn", "deploy billing")]);

    await hooks["chat.message"]!({ sessionID: SESSION }, output);

    expect(output.parts.map(({ id }) => id)).toEqual([
      "prt_fffffffffffeAbCdEfGhIjKlMn",
      expect.stringMatching(/^prt_ffffffffffff[0-9A-Za-z]{14}$/),
    ]);
  });

  it("appends nothing and reports PartIdExhaustedError after an id at the limit", async () => {
    scriptEngine({ stdout: contextReply(["<memory>recall</memory>"]) });
    const hooks = await openPlugin();
    const output = chatOutput([userPart("prt_ffffffffffffAbCdEfGhIjKlMn", "deploy billing")]);
    const stderr = stderrLines();

    await hooks["chat.message"]!({ sessionID: SESSION }, output);

    expect(output.parts).toHaveLength(1);
    expect(stderr()).toEqual(["memory opencode chat.message failed: PartIdExhaustedError"]);
  });
});
