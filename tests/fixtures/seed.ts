import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DB_FILENAME, type Config } from '../../src/cfg';
import { type OpenedDb, openDatabase } from '../../src/db/database';
import type { MemoryType } from '../../src/db/memories';
import { embedPassage } from '../../src/embeddings';
import type { MemoryScope } from '../../src/policy';

export interface SeedMemory {
  id: string;
  projectId: string;
  scope: MemoryScope;
  type: MemoryType;
  title: string;
  abstract: string;
  content: string;
  importance: number;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ToolCallResult = Awaited<ReturnType<Client['callTool']>>;

export function toolText(result: ToolCallResult): string {
  const content: unknown = result.content;
  const block: unknown = Array.isArray(content) ? content[0] : undefined;
  if (
    typeof block !== 'object' ||
    block === null ||
    !('text' in block) ||
    typeof block.text !== 'string'
  ) {
    throw new TypeError('tool result has no leading text block');
  }
  return block.text;
}

export function seedConfig(pluginData: string, modelCacheDir: string): Config {
  return {
    pluginData,
    dbPath: join(pluginData, DB_FILENAME),
    modelCacheDir,
    budgetTokens: 1200,
    pretoolBudgetTokens: 300,
  };
}

const EMBED_CHUNK = 128;

export async function seedMemories(config: Config, rows: readonly SeedMemory[]): Promise<void> {
  const opened: OpenedDb = openDatabase(config);
  try {
    const insert = opened.db.prepare(
      `INSERT INTO memories (id, type, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
    );
    const insertVector = opened.db.prepare(
      'INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id, state) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.type,
        row.scope,
        row.projectId,
        row.title,
        row.abstract,
        row.content,
        row.importance,
      );
    }
    for (let offset = 0; offset < rows.length; offset += EMBED_CHUNK) {
      const chunk = rows.slice(offset, offset + EMBED_CHUNK);
      const vectors = await embedPassage(
        chunk.map((row) => `${row.title} ${row.abstract}`),
        config.modelCacheDir,
      );
      chunk.forEach((row, index) => {
        insertVector.run(
          row.id,
          JSON.stringify(Array.from(vectors[index]!)),
          row.type,
          row.scope,
          row.projectId,
          'active',
        );
      });
    }
    opened.db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    opened.db.close();
  }
}

export function runProcess(options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  stdinText: string;
  timeoutMs: number;
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, { env: options.env, cwd: options.cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdinText);
  });
}