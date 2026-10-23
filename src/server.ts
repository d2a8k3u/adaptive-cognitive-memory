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
import { collectLocationFacts, projectIdentity } from "./ids";
import { type StorageOutage, storageOutage, unavailableMessage } from "./outage";
import { isToolError, TOOL_DEFINITIONS, type ToolDefinition, type ToolDeps } from "./tools";
import { PLUGIN_VERSION } from "./version";

export type ToolBackend =
  | { readonly available: true; readonly deps: ToolDeps }
  | {
      readonly available: false;
      readonly outage: StorageOutage;
      readonly processEnv: NodeJS.ProcessEnv;
      readonly projectDir: string;
    };

const START_BACKFILL_BATCH = 32;
const DOCTOR_TOOL = "memory_doctor";

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

export function createMcpServer(backend: ToolBackend): Server {
  const server = new Server(
    { name: "memory", version: PLUGIN_VERSION },
    { capabilities: { tools: { listChanged: false } } },
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
    return toolResult(await callTool(backend, definition, request.params.arguments ?? {}));
  });
  return server;
}

function openStorage(config: Config): { opened: OpenedDb } | { outage: StorageOutage } {
  try {
    return { opened: openDatabase(config) };
  } catch (error) {
    const outage = storageOutage(error);
    if (outage === undefined) {
      throw error;
    }
    return { outage };
  }
}

function toolBackend(config: Config, env: NodeJS.ProcessEnv, projectDir: string): ToolBackend {
  const storage = openStorage(config);
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
    },
  };
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
  const backend = toolBackend(loadConfig(env), env, process.cwd());
  await createMcpServer(backend).connect(new StdioServerTransport());
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
