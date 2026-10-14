import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [pluginRoot, seedFile, workspaceDir, otherProjectDir] = process.argv.slice(2);
const sdkClientDir = join(pluginRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm/client");
const { Client } = await import(pathToFileURL(join(sdkClientDir, "index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(join(sdkClientDir, "stdio.js")).href);

const projectDirs = { workspace: workspaceDir, other: otherProjectDir };
const seeds = JSON.parse(readFileSync(seedFile, "utf8"));

async function connect(cwd) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(pluginRoot, "dist/server.js")],
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
    },
    stderr: "inherit",
  });
  const client = new Client({ name: "acm-eval-seed", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const clients = new Map();
const storedIds = [];
for (const seed of seeds) {
  const project = seed.project ?? "workspace";
  if (!clients.has(project)) {
    clients.set(project, await connect(projectDirs[project]));
  }
  const resolution =
    seed.supersedes === undefined
      ? { action: "ADD" }
      : { action: "SUPERSEDE", target: storedIds[seed.supersedes] };
  const result = await clients
    .get(project)
    .callTool({ name: "memory_store", arguments: { ...seed.memory, resolution } });
  const text = result.content[0]?.text ?? "";
  const stored = result.isError ? undefined : JSON.parse(text);
  if (stored?.id === undefined) {
    throw new Error(`seed ${storedIds.length} was not stored: ${text}`);
  }
  storedIds.push(stored.id);
}
for (const client of clients.values()) {
  await client.close();
}
process.stdout.write(`${JSON.stringify(storedIds)}\n`);
