import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { readAutoMemory } from "./automemory";
import { type Config, loadConfig } from "./cfg";
import { type OpenedDb, openDatabase } from "./db/database";
import { clearBackfillFailure, recordBackfillFailure } from "./db/health";
import { embedMissing, type MemoryEnv } from "./db/memories";
import { reconcileVecStates } from "./db/transitions";
import { errorMessage, runDoctor } from "./doctor";
import { modelCached } from "./embeddings";
import { type HostProfile, hostProfile, resolveHost } from "./host";
import { collectLocationFacts, projectIdentity } from "./ids";
import { type StorageOutage, storageOutage, unavailableMessage } from "./outage";
import {
  ensureDataDir,
  legacyFacts,
  MOVED_STORE_FIX,
  type StoreState,
  sourceMoved,
  storeConfig,
  storeMissing,
  storeNotice,
  storeState,
} from "./storelocation";
import {
  isToolError,
  type StoreMove,
  TOOL_DEFINITIONS,
  type ToolDefinition,
  type ToolDeps,
} from "./tools";
import { PLUGIN_VERSION } from "./version";

export type ToolBackend =
  | { readonly available: true; readonly deps: ToolDeps }
  | {
      readonly available: false;
      readonly outage: StorageOutage;
      readonly processEnv: NodeJS.ProcessEnv;
      readonly projectDir: string;
    };

export interface AfterMove {
  readonly legacyDir: string;
  readonly open: () => ToolBackend;
}

export interface ServerOptions {
  readonly instructions?: string;
  readonly afterMove?: AfterMove;
}

interface ServerShell {
  readonly profile: HostProfile;
  readonly config: Config;
  readonly env: NodeJS.ProcessEnv;
  readonly projectDir: string;
}

const START_BACKFILL_BATCH = 32;
const DOCTOR_TOOL = "memory_doctor";
const SWITCH_FAILURE = "memory could not switch to the moved store";

function toolResult(outcome: unknown): CallToolResult {
  const isError = isToolError(outcome);
  return {
    content: [{ type: "text", text: JSON.stringify(outcome) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function callTool(
  backend: ToolBackend,
  definition: ToolDefinition,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (backend.available) {
    return definition.run(backend.deps, args);
  }
  if (definition.name === DOCTOR_TOOL) {
    return runDoctor(backend.processEnv, backend.projectDir);
  }
  return { error: { message: unavailableMessage(backend.outage) } };
}

export function createMcpServer(initial: ToolBackend, options: ServerOptions = {}): Server {
  let current = initial;
  let afterMove = options.afterMove;
  const server = new Server(
    { name: "memory", version: PLUGIN_VERSION },
    { capabilities: { tools: { listChanged: false } }, instructions: options.instructions },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === request.params.name);
    if (definition === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    }
    if (afterMove !== undefined && sourceMoved(afterMove.legacyDir)) {
      try {
        current = afterMove.open();
      } catch (error) {
        return toolResult({ error: { message: `${SWITCH_FAILURE}: ${errorMessage(error)}` } });
      }
      afterMove = undefined;
    }
    return toolResult(await callTool(current, definition, request.params.arguments ?? {}));
  });
  return server;
}

function openStorage(
  config: Config,
  dependencyFix: string,
): { opened: OpenedDb } | { outage: StorageOutage } {
  try {
    return { opened: openDatabase(config) };
  } catch (error) {
    const outage = storageOutage(error, dependencyFix);
    if (outage === undefined) {
      throw error;
    }
    return { outage };
  }
}

function toolBackend(
  shell: ServerShell,
  config: Config,
  storeMove: StoreMove | undefined,
): ToolBackend {
  const { env, projectDir } = shell;
  const storage = openStorage(config, shell.profile.dependencyFix);
  if ("outage" in storage) {
    return { available: false, outage: storage.outage, processEnv: env, projectDir };
  }
  const { opened } = storage;
  const location = collectLocationFacts(projectDir);
  const autoMemory = readAutoMemory(env, projectDir, location);
  const memoryEnv: MemoryEnv = {
    db: opened.db,
    vecLoaded: opened.vecLoaded,
    modelCacheDir: config.modelCacheDir,
  };
  return {
    available: true,
    deps: {
      env: memoryEnv,
      projectId: projectIdentity(location),
      embedDeadlineMs: config.embedDeadlineMs,
      processEnv: env,
      instructionSources: {
        projectDir,
        autoMemoryIndex: autoMemory.enabled ? autoMemory.indexPath : undefined,
      },
      storeMove,
    },
  };
}

function currentStoreState(shell: ServerShell): StoreState {
  const { profile, env, config } = shell;
  return storeState(config.dataDir, legacyFacts(profile, env, config.dataDir));
}

function storeMoveOf(state: StoreState, dataDir: string): StoreMove | undefined {
  const notice = storeNotice(state, dataDir);
  return state.kind === "shared" || notice === undefined
    ? undefined
    : { state: state.kind, notice };
}

function stateBackend(shell: ServerShell, state: StoreState): ToolBackend {
  const { config, env, projectDir } = shell;
  if (storeMissing(state)) {
    return {
      available: false,
      outage: { cause: `the moved store ${state.movedTo} does not exist`, fix: MOVED_STORE_FIX },
      processEnv: env,
      projectDir,
    };
  }
  if (state.kind === "shared") {
    ensureDataDir(config);
  }
  return toolBackend(shell, storeConfig(config, state, env), storeMoveOf(state, config.dataDir));
}

function afterMoveOf(shell: ServerShell, state: StoreState): AfterMove | undefined {
  return state.kind === "legacy"
    ? { legacyDir: state.legacyDir, open: () => stateBackend(shell, currentStoreState(shell)) }
    : undefined;
}

async function maintainVectors(env: MemoryEnv): Promise<void> {
  if (!env.vecLoaded) {
    return;
  }
  try {
    reconcileVecStates(env.db);
    if (!modelCached(env.modelCacheDir)) {
      return;
    }
    await embedMissing(env, START_BACKFILL_BATCH, "active");
    clearBackfillFailure(env.db);
  } catch (error) {
    recordBackfillFailure(env.db, new Date().toISOString(), errorMessage(error));
  }
}

export async function runServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const shell: ServerShell = {
    profile: hostProfile(resolveHost(env)),
    config: loadConfig(env),
    env,
    projectDir: process.cwd(),
  };
  const state = currentStoreState(shell);
  const backend = stateBackend(shell, state);
  const options: ServerOptions = {
    instructions: storeNotice(state, shell.config.dataDir),
    afterMove: afterMoveOf(shell, state),
  };
  await createMcpServer(backend, options).connect(new StdioServerTransport());
  if (backend.available) {
    void maintainVectors(backend.deps.env).catch((error: unknown) => {
      console.error(`memory start-up backfill failed and was not recorded: ${errorMessage(error)}`);
    });
  }
}

if (require.main === module) {
  void runServer().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
