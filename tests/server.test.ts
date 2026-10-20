import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/cfg";
import { type OpenedDb, openDatabase } from "../src/db/database";
import type { MemoryEnv } from "../src/db/memories";
import { modelCachePath } from "../src/embeddings";
import { createMcpServer } from "../src/server";
import { testModelCacheDir } from "../vitest.config";
import { type ToolCallResult, toolText } from "./fixtures/seed";

const START_BACKFILL_BATCH = 32;

const embedState = vi.hoisted(() => ({
  cached: true,
  defaultVector: (() => {
    const vector = new Float32Array(384);
    vector[0] = 1;
    return vector;
  })(),
}));

vi.mock("../src/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embeddings")>();
  return {
    ...actual,
    modelCached: () => embedState.cached,
    embedPassage: () => Promise.resolve([embedState.defaultVector]),
    embedQuery: () => Promise.resolve(embedState.defaultVector),
  };
});

const openedDbs: OpenedDb[] = [];
const clients: Client[] = [];
const servers: ReturnType<typeof createMcpServer>[] = [];

async function connect(
  pluginData = mkdtempSync(join(tmpdir(), "acm-server-")),
): Promise<{ client: Client; config: ReturnType<typeof loadConfig>; env: MemoryEnv }> {
  const config = loadConfig({ CLAUDE_PLUGIN_DATA: pluginData });
  const opened = openDatabase(config);
  openedDbs.push(opened);
  const env: MemoryEnv = {
    db: opened.db,
    vecLoaded: opened.vecLoaded,
    modelCacheDir: config.modelCacheDir,
  };
  const projectDir = mkdtempSync(join(tmpdir(), "acm-server-project-"));
  const server = createMcpServer({
    available: true,
    deps: {
      env,
      projectId: "proj-server",
      processEnv: {
        CLAUDE_PLUGIN_DATA: pluginData,
        CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "acm-server-claude-")),
      },
      instructionSources: { projectDir, autoMemoryIndex: join(projectDir, "MEMORY.md") },
    },
  });
  servers.push(server);
  const client = new Client({ name: "acm-test-client", version: "0.0.0" });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, config, env };
}

function textOf(result: ToolCallResult): unknown {
  return JSON.parse(toolText(result));
}

afterEach(async () => {
  for (const client of clients) {
    await client.close();
  }
  clients.length = 0;
  for (const server of servers) {
    await server.close();
  }
  servers.length = 0;
  for (const opened of openedDbs) {
    opened.db.close();
  }
  openedDbs.length = 0;
  embedState.cached = true;
});

const serverEntry = join(process.cwd(), "dist", "server.js");
const POLL_DEADLINE_MS = 30_000;
const POLL_INTERVAL_MS = 50;
const MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx",
];

async function spawnedServer(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "acm-spawned-check", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: {
        CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "acm-spawned-claude-")),
        PATH: process.env.PATH ?? "",
        ...env,
      },
      cwd: mkdtempSync(join(tmpdir(), "acm-spawned-project-")),
      stderr: "pipe",
    }),
  );
  clients.push(client);
  return client;
}

async function waitFor(what: string, condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`gave up waiting for ${what} after ${POLL_DEADLINE_MS} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function corruptModelCacheDir(): string {
  const cacheDir = mkdtempSync(join(tmpdir(), "acm-corrupt-model-"));
  for (const file of MODEL_FILES) {
    const path = join(modelCachePath(cacheDir), file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not a model");
  }
  return cacheDir;
}

beforeAll(() => {
  if (!existsSync(serverEntry)) {
    execFileSync("npm", ["run", "build"], { timeout: 120_000, stdio: "pipe" });
  }
}, 200_000);

describe("server", () => {
  it("lists the ten memory tools", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "memory_delete",
      "memory_doctor",
      "memory_feedback",
      "memory_get",
      "memory_list",
      "memory_relate",
      "memory_search",
      "memory_status",
      "memory_store",
      "memory_update",
    ]);
  });

  it("round-trips store and get through the wire", async () => {
    const { client } = await connect();
    const stored = await client.callTool({
      name: "memory_store",
      arguments: {
        title: "wire roundtrip",
        content: "Facts travel over stdio. Second sentence.",
        type: "semantic",
        kind: "fact",
        conflict_key: "project.server_transport",
      },
    });
    const storedValue = textOf(stored) as { id: string; action: string };
    expect(storedValue.action).toBe("created");

    const got = await client.callTool({ name: "memory_get", arguments: { id: storedValue.id } });
    const record = textOf(got) as { title: string; abstract: string; content: string };
    expect(record.title).toBe("wire roundtrip");
    expect(record.abstract).toBe("Facts travel over stdio.");
    expect(record.content).toBe("Facts travel over stdio. Second sentence.");
  });

  it("returns field-named result errors for invalid input instead of protocol errors", async () => {
    const { client } = await connect();
    const badTitle = await client.callTool({
      name: "memory_store",
      arguments: { title: 42, content: "Facts travel over stdio.", type: "semantic" },
    });
    expect(badTitle.isError).toBe(true);
    const badTitleValue = textOf(badTitle) as { error: { field?: string; message: string } };
    expect(badTitleValue.error.field).toBe("title");

    const badType = await client.callTool({
      name: "memory_store",
      arguments: { title: "wire roundtrip", content: "Facts travel over stdio.", type: "thought" },
    });
    expect(badType.isError).toBe(true);
    const badTypeValue = textOf(badType) as { error: { field?: string } };
    expect(badTypeValue.error.field).toBe("type");
  });

  it("advertises the memory_store argument schema", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    const store = listed.tools.find((tool) => tool.name === "memory_store");
    const schema = store?.inputSchema as {
      required?: string[];
      properties: Record<
        string,
        {
          type?: string;
          enum?: string[];
          maxLength?: number;
          pattern?: string;
          maxItems?: number;
          required?: string[];
        }
      >;
    };
    expect(schema.required).toEqual(["title", "content", "type", "kind", "conflict_key"]);
    expect(Object.keys(schema.properties).sort()).toEqual([
      "abstract",
      "anchors",
      "cardinality",
      "conflict_key",
      "content",
      "keywords",
      "kind",
      "resolution",
      "scope",
      "title",
      "type",
      "value_text",
    ]);
    expect(schema.properties.title).toEqual({ type: "string", maxLength: 200 });
    expect(schema.properties.type?.enum).toEqual(["semantic", "episodic", "procedural", "pattern"]);
    expect(schema.properties.kind?.enum).toEqual([
      "constraint",
      "preference",
      "fact",
      "procedure",
      "belief",
    ]);
    expect(schema.properties.conflict_key).toEqual({
      type: "string",
      maxLength: 120,
      pattern: "^[a-z0-9_]+(\\.[a-z0-9_-]+)+$",
    });
    expect(schema.properties.anchors?.maxItems).toBe(20);
    expect(schema.properties.resolution?.required).toEqual(["action"]);
    expect(store?.description).toMatch(/needs_resolution/);
  });

  it("reports a server defect behind a tool as a protocol error, not as a tool result", async () => {
    const { client, env } = await connect();
    const stored = textOf(
      await client.callTool({
        name: "memory_store",
        arguments: {
          title: "corrupted anchors",
          content: "This row gets malformed anchors.",
          type: "semantic",
          kind: "fact",
          conflict_key: "project.server_defect",
        },
      }),
    ) as { id: string };
    env.db.prepare("UPDATE memories SET anchors = '{broken' WHERE id = ?").run(stored.id);

    const rejection = await client
      .callTool({ name: "memory_get", arguments: { id: stored.id } })
      .then(
        () => undefined,
        (error: unknown) => error as { code?: number; message?: string },
      );

    expect(rejection?.code).toBe(ErrorCode.InternalError);
    expect(rejection?.message).toMatch(/JSON/);
  });

  it("rejects unknown tool names with a protocol error", async () => {
    const { client } = await connect();
    const rejection = await client.callTool({ name: "memory_teleport", arguments: {} }).then(
      () => undefined,
      (error: unknown) => error as { code?: number; message?: string },
    );
    expect(rejection?.code).toBe(ErrorCode.InvalidParams);
    expect(rejection?.message).toContain("Unknown tool: memory_teleport");
  });

  it("answers a zero-argument tool call over the wire", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "memory_doctor", arguments: {} });
    expect(result.isError).toBeUndefined();
    const report = textOf(result) as { status: string; checks: { name: string }[] };
    expect(report.status).toBe("ok");
    expect(report.checks.length).toBe(13);
  });

  it("after it connects, reconciles drifted vector states and embeds one bounded batch of unembedded active memories", {
    timeout: 60_000,
  }, async () => {
    const pluginData = mkdtempSync(join(tmpdir(), "acm-backfill-"));
    const config = loadConfig({ CLAUDE_PLUGIN_DATA: pluginData });
    const observer = openDatabase(config);
    openedDbs.push(observer);
    const insert = observer.db.prepare(
      `INSERT INTO memories (id, type, scope, project_id, title, abstract, content, created_at, updated_at, state)
       VALUES (?, 'semantic', 'project', 'proj-backfill', ?, 'abstract', 'content',
         '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z', ?)`,
    );
    for (let index = 0; index <= START_BACKFILL_BATCH; index += 1) {
      insert.run(`mem-backfill-${String(index).padStart(2, "0")}`, `fact ${index}`, "active");
    }
    insert.run("mem-backfill-revoked", "revoked fact", "revoked");
    insert.run("mem-drifted", "reactivated fact", "active");
    observer.db
      .prepare(
        `INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id, state)
         VALUES ('mem-drifted', ?, 'semantic', 'project', 'proj-backfill', 'hypothesis')`,
      )
      .run(Buffer.from(embedState.defaultVector.buffer));
    const vectors = observer.db.prepare(
      "SELECT memory_id, state FROM memories_vec ORDER BY memory_id",
    );
    const client = await spawnedServer({
      CLAUDE_PLUGIN_DATA: pluginData,
      ACM_MODEL_CACHE_DIR: testModelCacheDir,
    });

    await waitFor("the start-up backfill", () => vectors.all().length > 1);
    await client.callTool({ name: "memory_status", arguments: {} });

    const embedded = vectors.all() as { memory_id: string; state: string }[];
    expect(embedded).toHaveLength(START_BACKFILL_BATCH + 1);
    expect(embedded.map((row) => row.memory_id)).not.toContain("mem-backfill-revoked");
    expect(embedded.find((row) => row.memory_id === "mem-drifted")?.state).toBe("active");
  });

  it("keeps serving when the start-up backfill fails, leaving rows unembedded and naming the failure in memory_doctor", {
    timeout: 60_000,
  }, async () => {
    const pluginData = mkdtempSync(join(tmpdir(), "acm-backfill-fail-"));
    const seeded = openDatabase(loadConfig({ CLAUDE_PLUGIN_DATA: pluginData }));
    try {
      seeded.db
        .prepare(
          `INSERT INTO memories (id, type, scope, project_id, title, abstract, content, created_at, updated_at)
           VALUES ('mem-unembedded', 'semantic', 'project', 'proj-backfill', 'fact', 'abstract',
             'content', '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
        )
        .run();
    } finally {
      seeded.db.close();
    }
    const client = await spawnedServer({
      CLAUDE_PLUGIN_DATA: pluginData,
      ACM_MODEL_CACHE_DIR: corruptModelCacheDir(),
    });
    const unembeddedCheck = async () => {
      const report = textOf(
        (await client.callTool({ name: "memory_doctor", arguments: {} })) as ToolCallResult,
      ) as { checks: { name: string; status: string; detail: string }[] };
      return report.checks.find((check) => check.name === "unembedded");
    };

    await waitFor(
      "the recorded backfill failure",
      async () => (await unembeddedCheck())?.detail.includes("backfill") ?? false,
    );
    const unembedded = await unembeddedCheck();
    const status = await client.callTool({ name: "memory_status", arguments: {} });

    expect(unembedded).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(
        /^1 active memories without embeddings; the start-up backfill failed at \S+: Unexpected token/,
      ),
    });
    expect(status.isError).toBeUndefined();
  });

  it("spawns a stdio server that listens on no socket", { timeout: 60_000 }, async () => {
    const pluginData = mkdtempSync(join(tmpdir(), "acm-listen-"));
    const dbPath = join(pluginData, "memory.sqlite");
    const child = spawn(process.execPath, [join(process.cwd(), "dist", "server.js")], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(dbPath) && Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`server exited early with ${child.exitCode}: ${stderr.join("")}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(existsSync(dbPath)).toBe(true);
      expect(child.exitCode).toBeNull();

      const sockets = spawnSync("lsof", ["-a", "-p", String(child.pid), "-i"], {
        encoding: "utf8",
      });
      if (sockets.error) {
        throw new Error(`lsof unavailable: ${String(sockets.error)}`);
      }
      expect(sockets.stdout).not.toMatch(/LISTEN/);
    } finally {
      child.kill();
      await new Promise((resolve) => {
        child.once("exit", resolve);
        setTimeout(resolve, 5_000);
      });
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  it("starts without its native module, serving memory_doctor and naming the cause and fix on every other tool", {
    timeout: 60_000,
  }, async () => {
    const client = new Client({ name: "acm-native-outage", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [serverEntry],
        env: {
          CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "acm-outage-")),
          CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "acm-outage-claude-")),
          PATH: process.env.PATH ?? "",
          NODE_OPTIONS: `--require ${join(process.cwd(), "tests", "fixtures", "dlopen-fail.cjs")}`,
        },
        cwd: mkdtempSync(join(tmpdir(), "acm-outage-project-")),
        stderr: "pipe",
      }),
    );
    try {
      const search = await client.callTool({ name: "memory_search", arguments: { query: "x" } });
      const doctor = await client.callTool({ name: "memory_doctor", arguments: {} });

      expect(search.isError).toBe(true);
      expect(toolText(search)).toMatch(
        /better-sqlite3 failed to load .*NODE_MODULE_VERSION 115.*Fix: run npm rebuild better-sqlite3/,
      );
      expect(doctor.isError).toBeUndefined();
      const report = textOf(doctor) as { checks: { name: string; status: string }[] };
      expect(report.checks.find((check) => check.name === "native_module")?.status).toBe("fail");
    } finally {
      await client.close();
    }
  });
});
