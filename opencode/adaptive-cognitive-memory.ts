import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";

type MessagePart = Parameters<NonNullable<Hooks["chat.message"]>>[1]["parts"][number];
type TextPart = Extract<MessagePart, { type: "text" }>;
type Envelope = Readonly<Record<string, unknown>>;
type SessionStates = Map<string, SessionState>;

interface SessionState {
  readonly started: boolean;
  readonly continued: boolean;
  readonly repromptText: string | undefined;
}

const HOST_ID = "opencode";
const ENGINE_COMMAND = "node";
const ENGINE_TIMEOUT_MS = 5_000;
const ENGINE_OUTPUT_MAX_BYTES = 262_144;
const ENGINE_STDERR_LINE_MAX_CHARS = 300;
const SESSION_STATES_MAX = 1_024;
const CHAT_MESSAGE_HOOK = "chat.message";
const TOOL_AFTER_HOOK = "tool.execute.after";
const SESSION_IDLE_EVENT = "session.idle";
const COMPACTING_HOOK = "experimental.session.compacting";
const BASH_TOOL = "bash";
const HANDLED_TOOLS: ReadonlySet<string> = new Set([
  BASH_TOOL,
  "read",
  "edit",
  "write",
  "memory_memory_feedback",
  "memory_memory_store",
  "memory_memory_update",
]);
const BLOCK_SEPARATOR = "\n\n";
const PROMPT_PART_SEPARATOR = "\n";
const PART_ID_PREFIX = "prt_";
const PART_ID_PATTERN = /^prt_([0-9a-f]{12})[0-9A-Za-z]{14}$/;
const PART_TIME_HEX_DIGITS = 12;
const PART_TIME_LIMIT = 1n << 48n;
const PART_TICKS_PER_MS = 0x1000n;
const PART_RANDOM_CHARS = 14;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const NEW_SESSION: SessionState = { started: false, continued: false, repromptText: undefined };

class PluginFailure extends Error {}
class EngineSpawnError extends PluginFailure {}
class EngineExitError extends PluginFailure {}
class EngineTimeoutError extends PluginFailure {}
class EngineOutputError extends PluginFailure {}
class PartIdExhaustedError extends PluginFailure {}
class PromptAsyncError extends PluginFailure {}

function partTime(id: string): bigint | undefined {
  const timeHex = PART_ID_PATTERN.exec(id)?.[1];
  return timeHex === undefined ? undefined : BigInt(`0x${timeHex}`);
}

function nextPartId(existingIds: readonly string[], nowMs: number, randomSuffix: string): string {
  const afterExisting = existingIds
    .flatMap((id) => partTime(id) ?? [])
    .reduce((latest, time) => (time + 1n > latest ? time + 1n : latest), 0n);
  const fromClock = (BigInt(nowMs) * PART_TICKS_PER_MS) % PART_TIME_LIMIT;
  const time = afterExisting > fromClock ? afterExisting : fromClock;
  if (time >= PART_TIME_LIMIT) {
    throw new PartIdExhaustedError("no part id sorts after the existing parts");
  }
  return `${PART_ID_PREFIX}${time.toString(16).padStart(PART_TIME_HEX_DIGITS, "0")}${randomSuffix}`;
}

function randomBase62(length: number): string {
  return [...randomBytes(length)]
    .map((byte) => BASE62_ALPHABET.charAt(byte % BASE62_ALPHABET.length))
    .join("");
}

function recallParts(
  parts: readonly MessagePart[],
  sessionID: string,
  messageID: string,
  blocks: readonly string[],
): TextPart[] {
  const ids = parts.map(({ id }) => id);
  return blocks.map((text) => {
    const id = nextPartId(ids, Date.now(), randomBase62(PART_RANDOM_CHARS));
    ids.push(id);
    return { id, sessionID, messageID, type: "text", text, synthetic: true };
  });
}

function isUserText(part: MessagePart): part is TextPart {
  return part.type === "text" && part.synthetic !== true && part.ignored !== true;
}

function promptText(parts: readonly MessagePart[]): string {
  return parts
    .filter(isUserText)
    .map(({ text }) => text)
    .join(PROMPT_PART_SEPARATOR);
}

function fieldOf(value: unknown, field: string): unknown {
  return typeof value === "object" && value !== null && field in value
    ? (value as Readonly<Record<string, unknown>>)[field]
    : undefined;
}

function bashResult(metadata: unknown): Envelope {
  return { exit: fieldOf(metadata, "exit"), output: fieldOf(metadata, "output") };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new EngineOutputError("engine stdout is not JSON", { cause: error });
  }
}

function engineBlocks(stdout: string): readonly string[] {
  if (stdout.trim() === "") {
    return [];
  }
  const context = fieldOf(parsedJson(stdout), "context");
  if (!isStringArray(context)) {
    throw new EngineOutputError("engine stdout is not a context list");
  }
  return context;
}

function forwardEngineStderr(stderr: string): void {
  const line = stderr.trim().split("\n", 1)[0] ?? "";
  if (line !== "") {
    process.stderr.write(`${line.slice(0, ENGINE_STDERR_LINE_MAX_CHARS)}\n`);
  }
}

function runEngine(
  engine: string,
  directory: string,
  envelope: Envelope,
): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE_COMMAND, [engine], {
      cwd: directory,
      env: { ...process.env, ACM_HOST: HOST_ID },
      stdio: "pipe",
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let failure: PluginFailure | undefined;
    const abort = (error: PluginFailure): void => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => abort(new EngineTimeoutError("engine exceeded its time budget")),
      ENGINE_TIMEOUT_MS,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > ENGINE_OUTPUT_MAX_BYTES) {
        abort(new EngineOutputError("engine stdout exceeded its size cap"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < ENGINE_STDERR_LINE_MAX_CHARS) {
        stderr += chunk.toString("utf8");
      }
    });
    child.stdin.on("error", (error) => {
      failure ??= new EngineSpawnError("engine closed its stdin early", { cause: error });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new EngineSpawnError("engine did not start", { cause: error }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      forwardEngineStderr(stderr);
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(new EngineExitError("engine exited non-zero"));
        return;
      }
      try {
        resolve(engineBlocks(Buffer.concat(stdout).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(envelope));
  });
}

function reportFailure(hook: string, error: unknown): void {
  if (!(error instanceof PluginFailure)) {
    throw error;
  }
  process.stderr.write(`memory opencode ${hook} failed: ${error.constructor.name}\n`);
}

async function guarded(hook: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    reportFailure(hook, error);
  }
}

function updateSession(
  states: SessionStates,
  sessionID: string,
  change: Partial<SessionState>,
): void {
  const current = states.get(sessionID);
  if (current === undefined && states.size >= SESSION_STATES_MAX) {
    const [oldest] = states.keys();
    if (oldest !== undefined) {
      states.delete(oldest);
    }
  }
  states.set(sessionID, { ...(current ?? NEW_SESSION), ...change });
}

async function reprompt(
  client: PluginInput["client"],
  sessionID: string,
  text: string,
): Promise<void> {
  let result: { readonly error?: unknown };
  try {
    result = await client.session.promptAsync({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text }] },
    });
  } catch (error) {
    throw new PromptAsyncError("the re-prompt was rejected", { cause: error });
  }
  if (result.error !== undefined) {
    throw new PromptAsyncError("the re-prompt resolved with an error");
  }
}

export const AdaptiveCognitiveMemory: Plugin = async ({ client, directory }) => {
  const engine = join(
    dirname(dirname(realpathSync(fileURLToPath(import.meta.url)))),
    "dist",
    "hooks.js",
  );
  const states: SessionStates = new Map();
  const sessionState = (sessionID: string): SessionState => states.get(sessionID) ?? NEW_SESSION;
  const callEngine = (envelope: Envelope) => runEngine(engine, directory, envelope);

  return {
    [CHAT_MESSAGE_HOOK]: (input, output) =>
      guarded(CHAT_MESSAGE_HOOK, async () => {
        const state = sessionState(input.sessionID);
        const prompt = promptText(output.parts);
        if (prompt === state.repromptText) {
          updateSession(states, input.sessionID, { repromptText: undefined });
          return;
        }
        const sessionStart = !state.started;
        updateSession(states, input.sessionID, { started: true });
        try {
          const blocks = await callEngine({
            hook_event_name: CHAT_MESSAGE_HOOK,
            session_id: input.sessionID,
            cwd: directory,
            prompt,
            session_start: sessionStart,
          });
          const recalled = recallParts(output.parts, input.sessionID, output.message.id, blocks);
          output.parts.push(...recalled);
        } catch (error) {
          if (sessionStart) {
            updateSession(states, input.sessionID, { started: false });
          }
          throw error;
        }
      }),
    [TOOL_AFTER_HOOK]: async (input, output) => {
      if (!HANDLED_TOOLS.has(input.tool)) {
        return;
      }
      await guarded(TOOL_AFTER_HOOK, async () => {
        const blocks = await callEngine({
          hook_event_name: TOOL_AFTER_HOOK,
          session_id: input.sessionID,
          cwd: directory,
          tool: input.tool,
          args: input.args,
          ...(input.tool === BASH_TOOL ? bashResult(output.metadata) : {}),
        });
        if (blocks.length > 0 && typeof output.output === "string") {
          output.output = [output.output, ...blocks].join(BLOCK_SEPARATOR);
        }
      });
    },
    event: async ({ event }) => {
      if (event.type !== SESSION_IDLE_EVENT) {
        return;
      }
      const sessionID = event.properties.sessionID;
      await guarded(SESSION_IDLE_EVENT, async () => {
        const blocks = await callEngine({
          hook_event_name: SESSION_IDLE_EVENT,
          session_id: sessionID,
          stop_hook_active: sessionState(sessionID).continued,
        });
        const checkpoint = blocks.join(BLOCK_SEPARATOR);
        if (checkpoint === "") {
          updateSession(states, sessionID, { continued: false });
          return;
        }
        updateSession(states, sessionID, { repromptText: checkpoint });
        try {
          await reprompt(client, sessionID, checkpoint);
        } catch (error) {
          updateSession(states, sessionID, { repromptText: undefined });
          throw error;
        }
        updateSession(states, sessionID, { continued: true });
      });
    },
    [COMPACTING_HOOK]: (input, output) =>
      guarded(COMPACTING_HOOK, async () => {
        const blocks = await callEngine({
          hook_event_name: COMPACTING_HOOK,
          session_id: input.sessionID,
          cwd: directory,
        });
        output.context.push(...blocks);
      }),
  };
};
