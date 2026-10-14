import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { HookEventName, HookProcessOutput } from "./host";
import {
  type JsonRecord,
  optionalString,
  parseJsonObject,
  requireArray,
  requireRecord,
  requireString,
} from "./narrow";
import { oracleResolution, type ResolutionCandidate } from "./oracle";

export const HOOK_POOL_SIZE = 4;

const NEEDS_RESOLUTION = "needs_resolution";
const KEY_DRIFT_PROBE = "eval.key_drift_probe";

const DEFAULT_HOOK_TIMEOUT_S = 60;
const MS_PER_SECOND = 1000;
const NESTED_PROJECT_SEGMENTS = ["src", "app"] as const;
const PLUGIN_ROOT_PLACEHOLDER = /\$\{CLAUDE_PLUGIN_ROOT\}/g;
const SHELL = "/bin/sh";
const MATCHER_FIELD_BY_EVENT: Readonly<Partial<Record<HookEventName, string>>> = {
  PreToolUse: "tool_name",
  PostToolUse: "tool_name",
  PostToolUseFailure: "tool_name",
  SessionStart: "source",
  PreCompact: "trigger",
};

const execFileAsync = promisify(execFile);

export interface HookCommand {
  readonly matcher: RegExp | undefined;
  readonly command: string;
  readonly timeoutMs: number;
}

export interface McpServerCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface PluginUnderTest {
  readonly root: string;
  readonly hooks: ReadonlyMap<string, readonly HookCommand[]>;
  readonly mcpServer: McpServerCommand;
}

export interface ProjectDirs {
  readonly root: string;
  readonly nested: string;
}

export interface World {
  readonly base: string;
  readonly pluginData: string;
  readonly claudeConfigDir: string;
  readonly modelCacheDir: string;
  readonly projects: ReadonlyMap<string, ProjectDirs>;
}

export interface StoreArguments {
  readonly title: string;
  readonly content: string;
  readonly type: string;
  readonly scope: string;
  readonly kind: string;
  readonly conflict_key: string;
  readonly cardinality: string;
  readonly value_text: string;
  readonly keywords: string;
  readonly anchors: readonly string[];
}

export type PhaseOneStatus = "written" | typeof NEEDS_RESOLUTION;

export interface StoreOutcome {
  readonly id: string;
  readonly action: string;
  readonly refId: string | undefined;
  readonly promotedId: string | undefined;
  readonly phaseOne: PhaseOneStatus;
  readonly candidateCount: number;
  readonly sameKeyCandidate: boolean;
  readonly sameKeyFoundWithoutKey: boolean | undefined;
  readonly resolution: string | undefined;
}

export interface StoredMemory {
  readonly id: string;
  readonly scope: string;
  readonly state: string;
  readonly title: string;
  readonly abstract: string;
  readonly content: string;
  readonly supersededBy: string | null;
}

interface WrittenMemory {
  readonly id: string;
  readonly action: string;
  readonly refId: string | undefined;
  readonly promotedId: string | undefined;
}

export interface HookInvocation {
  readonly event: HookEventName;
  readonly cwd: string;
  readonly projectDir: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
}

export interface HookRun extends HookProcessOutput {
  readonly registered: boolean;
  readonly timedOut: boolean;
  readonly latencyMs: number;
  readonly sessionId: string;
}

function readJsonObject(path: string): JsonRecord {
  return requireRecord(JSON.parse(readFileSync(path, "utf8")), path);
}

function toolMatcher(entry: JsonRecord, path: string): RegExp | undefined {
  const matcher = optionalString(entry, "matcher", path);
  if (matcher === undefined || matcher === "*") {
    return undefined;
  }
  return new RegExp(`^(?:${matcher})$`);
}

function hookCommands(entries: readonly unknown[], path: string): HookCommand[] {
  return entries.flatMap((entryValue, entryIndex) => {
    const entryPath = `${path}[${entryIndex}]`;
    const entry = requireRecord(entryValue, entryPath);
    const matcher = toolMatcher(entry, entryPath);
    return requireArray(entry.hooks, `${entryPath}.hooks`).map((hookValue, hookIndex) => {
      const hookPath = `${entryPath}.hooks[${hookIndex}]`;
      const hook = requireRecord(hookValue, hookPath);
      if (hook.type !== "command") {
        throw new TypeError(`${hookPath}.type must be command`);
      }
      const timeout = hook.timeout ?? DEFAULT_HOOK_TIMEOUT_S;
      if (typeof timeout !== "number" || timeout <= 0) {
        throw new TypeError(`${hookPath}.timeout must be a positive number of seconds`);
      }
      return {
        matcher,
        command: requireString(hook, "command", hookPath),
        timeoutMs: timeout * MS_PER_SECOND,
      };
    });
  });
}

function onlyMcpServer(root: string): McpServerCommand {
  const path = join(root, ".mcp.json");
  const servers = Object.values(
    requireRecord(readJsonObject(path).mcpServers, `${path}.mcpServers`),
  );
  const [server] = servers;
  if (servers.length !== 1 || server === undefined) {
    throw new Error(`${path} must declare exactly one MCP server, found ${servers.length}`);
  }
  const record = requireRecord(server, `${path}.mcpServers`);
  return {
    command: requireString(record, "command", path),
    args: requireArray(record.args, `${path}.args`).map((arg, index) => {
      if (typeof arg !== "string") {
        throw new TypeError(`${path}.args[${index}] must be a string`);
      }
      return arg.replace(PLUGIN_ROOT_PLACEHOLDER, root);
    }),
  };
}

export function loadPlugin(root: string): PluginUnderTest {
  for (const entry of ["dist/hooks.js", "dist/server.js"]) {
    if (!existsSync(join(root, entry))) {
      throw new Error(`${entry} missing; run npm run build before the evaluation`);
    }
  }
  const hooksPath = join(root, "hooks", "hooks.json");
  const registered = requireRecord(readJsonObject(hooksPath).hooks, `${hooksPath}.hooks`);
  const hooks = new Map(
    Object.entries(registered).map(([event, entries]) => [
      event,
      hookCommands(requireArray(entries, `${hooksPath}.${event}`), `${hooksPath}.${event}`),
    ]),
  );
  return { root, hooks, mcpServer: onlyMcpServer(root) };
}

function searchPath(): string {
  return [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter);
}

function definedEnv(entries: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export async function createWorld(
  projectKeys: readonly string[],
  modelCacheDir: string,
): Promise<World> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "acm-eval-")));
  const pluginData = join(base, "plugin-data");
  mkdirSync(pluginData);
  const claudeConfigDir = join(base, "claude-config");
  mkdirSync(claudeConfigDir);
  const projects = new Map<string, ProjectDirs>();
  for (const key of projectKeys) {
    const root = join(base, "projects", key);
    const nested = join(root, ...NESTED_PROJECT_SEGMENTS);
    mkdirSync(nested, { recursive: true });
    await execFileAsync("git", ["init", "-q", root]);
    projects.set(key, { root, nested });
  }
  return { base, pluginData, claudeConfigDir, modelCacheDir, projects };
}

export function projectDirs(world: World, key: string): ProjectDirs {
  const dirs = world.projects.get(key);
  if (dirs === undefined) {
    throw new Error(`world has no project ${key}`);
  }
  return dirs;
}

function toolPayload(result: unknown, tool: string): JsonRecord {
  const record = requireRecord(result, tool);
  const first = requireRecord(requireArray(record.content, `${tool}.content`)[0], tool);
  const text = requireString(first, "text", `${tool}.content[0]`);
  if (record.isError === true) {
    throw new Error(`${tool} returned an error: ${text}`);
  }
  const payload = parseJsonObject(text);
  if (payload === undefined) {
    throw new TypeError(`${tool} returned a non-object payload: ${text}`);
  }
  return payload;
}

function writtenMemory(payload: JsonRecord): WrittenMemory {
  return {
    id: requireString(payload, "id", "memory_store"),
    action: requireString(payload, "action", "memory_store"),
    refId: optionalString(payload, "refId", "memory_store"),
    promotedId: optionalString(payload, "promotedId", "memory_store"),
  };
}

function resolutionCandidates(payload: JsonRecord): ResolutionCandidate[] {
  return requireArray(payload.candidates, "memory_store.candidates").map((value, index) => {
    const path = `memory_store.candidates[${index}]`;
    const record = requireRecord(value, path);
    if (typeof record.value_text !== "string") {
      throw new TypeError(`${path}.value_text must be a string`);
    }
    return {
      id: requireString(record, "id", path),
      conflict_key: requireString(record, "conflict_key", path),
      cardinality: requireString(record, "cardinality", path),
      value_text: record.value_text,
    };
  });
}

export class WorldWriter {
  private readonly clients = new Map<string, Promise<Client>>();

  constructor(
    private readonly plugin: PluginUnderTest,
    private readonly world: World,
  ) {}

  async store(cwd: string, args: StoreArguments): Promise<StoreOutcome> {
    const first = await this.call(cwd, "memory_store", { ...args });
    if (first.status !== NEEDS_RESOLUTION) {
      return {
        ...writtenMemory(first),
        phaseOne: "written",
        candidateCount: 0,
        sameKeyCandidate: false,
        sameKeyFoundWithoutKey: undefined,
        resolution: undefined,
      };
    }
    const candidates = resolutionCandidates(first);
    const sameKey = candidates.find((candidate) => candidate.conflict_key === args.conflict_key);
    const sameKeyFoundWithoutKey =
      sameKey === undefined
        ? undefined
        : (await this.candidateIdsWithoutKey(cwd, args)).includes(sameKey.id);
    const resolution = oracleResolution(args, candidates);
    const second = await this.call(cwd, "memory_store", { ...args, resolution });
    return {
      ...writtenMemory(second),
      phaseOne: NEEDS_RESOLUTION,
      candidateCount: candidates.length,
      sameKeyCandidate: sameKey !== undefined,
      sameKeyFoundWithoutKey,
      resolution: resolution.action,
    };
  }

  async get(cwd: string, id: string): Promise<StoredMemory> {
    const payload = await this.call(cwd, "memory_get", { id });
    const supersededBy = payload.superseded_by;
    if (supersededBy !== null && typeof supersededBy !== "string") {
      throw new TypeError("memory_get.superseded_by must be a string or null");
    }
    return {
      id: requireString(payload, "id", "memory_get"),
      scope: requireString(payload, "scope", "memory_get"),
      state: requireString(payload, "state", "memory_get"),
      title: requireString(payload, "title", "memory_get"),
      abstract: typeof payload.abstract === "string" ? payload.abstract : "",
      content: requireString(payload, "content", "memory_get"),
      supersededBy,
    };
  }

  feedback(cwd: string, ids: readonly string[], verdict: string): Promise<JsonRecord> {
    return this.call(cwd, "memory_feedback", { ids: [...ids], verdict });
  }

  async close(): Promise<void> {
    const clients = await Promise.all(this.clients.values());
    await Promise.all(clients.map((client) => client.close()));
    this.clients.clear();
  }

  private async candidateIdsWithoutKey(cwd: string, args: StoreArguments): Promise<string[]> {
    const probe = await this.call(cwd, "memory_store", { ...args, conflict_key: KEY_DRIFT_PROBE });
    if (probe.status !== NEEDS_RESOLUTION) {
      throw new Error(`the key-drift probe wrote a memory: ${JSON.stringify(probe)}`);
    }
    return resolutionCandidates(probe).map((candidate) => candidate.id);
  }

  private async call(
    cwd: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<JsonRecord> {
    const client = await this.clientFor(cwd);
    return toolPayload(await client.callTool({ name, arguments: args }), name);
  }

  private clientFor(cwd: string): Promise<Client> {
    const existing = this.clients.get(cwd);
    if (existing !== undefined) {
      return existing;
    }
    const connecting = this.connect(cwd);
    this.clients.set(cwd, connecting);
    return connecting;
  }

  private async connect(cwd: string): Promise<Client> {
    const transport = new StdioClientTransport({
      command: this.plugin.mcpServer.command,
      args: [...this.plugin.mcpServer.args],
      cwd,
      env: definedEnv({
        PATH: searchPath(),
        HOME: process.env.HOME,
        CLAUDE_CONFIG_DIR: this.world.claudeConfigDir,
        CLAUDE_PLUGIN_ROOT: this.plugin.root,
        CLAUDE_PLUGIN_DATA: this.world.pluginData,
        ACM_MODEL_CACHE_DIR: this.world.modelCacheDir,
      }),
      stderr: "inherit",
    });
    const client = new Client({ name: "acm-eval", version: "0.0.0" });
    await client.connect(transport);
    return client;
  }
}

function matcherSubject(invocation: HookInvocation): string | undefined {
  const field = MATCHER_FIELD_BY_EVENT[invocation.event];
  const subject = field === undefined ? undefined : invocation.fields[field];
  return typeof subject === "string" ? subject : undefined;
}

function matchingHook(
  plugin: PluginUnderTest,
  invocation: HookInvocation,
): HookCommand | undefined {
  const subject = matcherSubject(invocation);
  const matching = (plugin.hooks.get(invocation.event) ?? []).filter(
    (hook) => hook.matcher === undefined || (subject !== undefined && hook.matcher.test(subject)),
  );
  if (matching.length > 1) {
    throw new Error(`${invocation.event} has ${matching.length} matching hooks; expected one`);
  }
  return matching[0];
}

function hookStdin(world: World, invocation: HookInvocation, sessionId: string): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: join(world.base, "transcripts", `${sessionId}.jsonl`),
    cwd: invocation.cwd,
    permission_mode: "default",
    hook_event_name: invocation.event,
    ...invocation.fields,
  });
}

export function runHook(
  plugin: PluginUnderTest,
  world: World,
  invocation: HookInvocation,
): Promise<HookRun> {
  const sessionId = invocation.sessionId ?? randomUUID();
  const hook = matchingHook(plugin, invocation);
  if (hook === undefined) {
    return Promise.resolve({
      registered: false,
      timedOut: false,
      latencyMs: 0,
      sessionId,
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  }
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(SHELL, ["-c", hook.command], {
      cwd: invocation.cwd,
      env: definedEnv({
        PATH: searchPath(),
        HOME: process.env.HOME,
        CLAUDE_CONFIG_DIR: world.claudeConfigDir,
        CLAUDE_PLUGIN_ROOT: plugin.root,
        CLAUDE_PLUGIN_DATA: world.pluginData,
        CLAUDE_PROJECT_DIR: invocation.projectDir,
        ACM_MODEL_CACHE_DIR: world.modelCacheDir,
      }),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, hook.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        registered: true,
        timedOut,
        latencyMs: performance.now() - startedAt,
        sessionId,
        exitCode: timedOut ? -1 : (code ?? -1),
        stdout,
        stderr,
      });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        reject(error);
      }
    });
    child.stdin.end(hookStdin(world, invocation, sessionId));
  });
}

export function resolveToolInput(
  root: string,
  input: Readonly<Record<string, string>>,
): Record<string, string> {
  const filePath = input.file_path;
  if (filePath === undefined || isAbsolute(filePath)) {
    return { ...input };
  }
  return { ...input, file_path: join(root, filePath) };
}

export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}
