"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMcpServer = createMcpServer;
exports.runServer = runServer;
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const automemory_1 = require("./automemory");
const cfg_1 = require("./cfg");
const database_1 = require("./db/database");
const health_1 = require("./db/health");
const memories_1 = require("./db/memories");
const transitions_1 = require("./db/transitions");
const doctor_1 = require("./doctor");
const embeddings_1 = require("./embeddings");
const host_1 = require("./host");
const ids_1 = require("./ids");
const outage_1 = require("./outage");
const tools_1 = require("./tools");
const version_1 = require("./version");
const START_BACKFILL_BATCH = 32;
const DOCTOR_TOOL = "memory_doctor";
function toolResult(outcome) {
    const isError = (0, tools_1.isToolError)(outcome);
    return {
        content: [{ type: "text", text: JSON.stringify(outcome) }],
        ...(isError ? { isError: true } : {}),
    };
}
async function callTool(backend, definition, args) {
    if (backend.available) {
        return definition.run(backend.deps, args);
    }
    if (definition.name === DOCTOR_TOOL) {
        return (0, doctor_1.runDoctor)(backend.processEnv, backend.projectDir);
    }
    return { error: { message: (0, outage_1.unavailableMessage)(backend.outage) } };
}
function createMcpServer(backend) {
    const server = new index_js_1.Server({ name: "memory", version: version_1.PLUGIN_VERSION }, { capabilities: { tools: { listChanged: false } } });
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, () => ({
        tools: tools_1.TOOL_DEFINITIONS.map((definition) => ({
            name: definition.name,
            description: definition.description,
            inputSchema: definition.inputSchema,
        })),
    }));
    server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
        const definition = tools_1.TOOL_DEFINITIONS.find((tool) => tool.name === request.params.name);
        if (definition === undefined) {
            throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
        }
        return toolResult(await callTool(backend, definition, request.params.arguments ?? {}));
    });
    return server;
}
function openStorage(config) {
    try {
        return { opened: (0, database_1.openDatabase)(config) };
    }
    catch (error) {
        const outage = (0, outage_1.storageOutage)(error, (0, host_1.hostProfile)("claude").dependencyFix);
        if (outage === undefined) {
            throw error;
        }
        return { outage };
    }
}
function toolBackend(config, env, projectDir) {
    const storage = openStorage(config);
    if ("outage" in storage) {
        return { available: false, outage: storage.outage, processEnv: env, projectDir };
    }
    const { opened } = storage;
    const location = (0, ids_1.collectLocationFacts)(projectDir);
    const autoMemory = (0, automemory_1.readAutoMemory)(env, projectDir, location);
    const memoryEnv = {
        db: opened.db,
        vecLoaded: opened.vecLoaded,
        modelCacheDir: config.modelCacheDir,
    };
    return {
        available: true,
        deps: {
            env: memoryEnv,
            projectId: (0, ids_1.projectIdentity)(location),
            embedDeadlineMs: config.embedDeadlineMs,
            processEnv: env,
            instructionSources: {
                projectDir,
                autoMemoryIndex: autoMemory.enabled ? autoMemory.indexPath : undefined,
            },
        },
    };
}
async function maintainVectors(env) {
    if (!env.vecLoaded) {
        return;
    }
    try {
        (0, transitions_1.reconcileVecStates)(env.db);
        if (!(0, embeddings_1.modelCached)(env.modelCacheDir)) {
            return;
        }
        await (0, memories_1.embedMissing)(env, START_BACKFILL_BATCH, "active");
        (0, health_1.clearBackfillFailure)(env.db);
    }
    catch (error) {
        (0, health_1.recordBackfillFailure)(env.db, new Date().toISOString(), (0, doctor_1.errorMessage)(error));
    }
}
async function runServer(env = process.env) {
    const backend = toolBackend((0, cfg_1.loadConfig)(env), env, process.cwd());
    await createMcpServer(backend).connect(new stdio_js_1.StdioServerTransport());
    if (backend.available) {
        void maintainVectors(backend.deps.env).catch((error) => {
            console.error(`memory start-up backfill failed and was not recorded: ${(0, doctor_1.errorMessage)(error)}`);
        });
    }
}
if (require.main === module) {
    void runServer().catch((error) => {
        console.error((0, doctor_1.errorMessage)(error));
        process.exitCode = 1;
    });
}
