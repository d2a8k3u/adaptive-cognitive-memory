import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import Database from 'better-sqlite3';
import { DB_FILENAME, EMBED_DIM, type Config } from '../../src/cfg';
import { type OpenedDb, openDatabase } from '../../src/db/database';
import { type StoreDigest, storeDigest } from '../../src/db/digest';
import type { MemoryType } from '../../src/db/memories';
import { embedPassage } from '../../src/embeddings';
import { newId } from '../../src/ids';
import type { MemoryScope } from '../../src/policy';
import { enableStatusline } from '../../src/statusline';
import { testEmbedDeadlineMs } from '../../vitest.config';

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

export function seedConfig(dataDir: string, modelCacheDir: string): Config {
  return {
    dataDir,
    dbPath: join(dataDir, DB_FILENAME),
    modelCacheDir,
    modelRemoteHost: undefined,
    autoDownloadModel: false,
    budgetTokens: 1200,
    pretoolBudgetTokens: 300,
    embedDeadlineMs: testEmbedDeadlineMs,
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

export interface LegacyStoreOptions {
  readonly memories: number;
  readonly contentChars: number;
  readonly projectId: string;
  readonly pinnedAbstract: string;
}

export interface LegacyStore {
  readonly dir: string;
  readonly dbPath: string;
  readonly anchor: Database.Database;
  readonly pinnedId: string;
}

const SEEDED_AT = '2026-10-13T00:00:00.000Z';
const SEED_SESSION = 'session-seed';
const LATE_MEMORIES = 2;
const MODEL_FILE_BYTES = 64 * 1024;

function syntheticVector(ordinal: number): Buffer {
  const vector = new Float32Array(EMBED_DIM);
  for (let index = 0; index < EMBED_DIM; index += 1) {
    vector[index] = Math.sin(ordinal * EMBED_DIM + index);
  }
  return Buffer.from(vector.buffer);
}

function insertMemoryRows(
  db: Database.Database,
  options: LegacyStoreOptions,
  ids: readonly string[],
): void {
  const insertMemory = db.prepare(
    `INSERT INTO memories (id, type, kind, scope, project_id, title, abstract, content, importance, superseded_by, created_at, updated_at)
     VALUES (?, 'semantic', ?, 'project', ?, ?, ?, ?, 0.7, NULL, ?, ?)`,
  );
  const insertVector = db.prepare(
    'INSERT INTO memories_vec (memory_id, embedding, type, scope, project_id, state) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertRelation = db.prepare(
    "INSERT INTO relations (source_id, target_id, relation_type) VALUES (?, ?, 'follows')",
  );
  const insertTransition = db.prepare(
    "INSERT INTO transitions (memory_id, from_state, to_state, reason, evidence, related_id, at) VALUES (?, 'hypothesis', 'active', 'promoted', 'seed', NULL, ?)",
  );
  const insertVerdict = db.prepare(
    "INSERT INTO verdicts (session_id, memory_id, verdict, at) VALUES (?, ?, 'used', ?)",
  );
  const insertInjection = db.prepare(
    "INSERT INTO injections (session_id, memory_id, event, at) VALUES (?, ?, 'SessionStart', ?)",
  );
  ids.forEach((id, index) => {
    const kind = index === 0 ? 'constraint' : 'fact';
    const abstract = index === 0 ? options.pinnedAbstract : `abstract ${index}`;
    insertMemory.run(
      id,
      kind,
      options.projectId,
      `memory ${index}`,
      abstract,
      `content ${index} `.padEnd(options.contentChars, 'x'),
      SEEDED_AT,
      SEEDED_AT,
    );
    insertVector.run(id, syntheticVector(index), 'semantic', 'project', options.projectId, 'active');
    if (index > 0) {
      insertRelation.run(id, ids[index - 1]);
    }
    if (index % 3 === 0) {
      insertTransition.run(id, SEEDED_AT);
    }
    if (index % 2 === 0) {
      insertVerdict.run(SEED_SESSION, id, SEEDED_AT);
      insertInjection.run(SEED_SESSION, id, SEEDED_AT);
    }
  });
}

function insertSessionRows(db: Database.Database, projectId: string): void {
  db.prepare('INSERT INTO receipt_sessions (session_id, first_at) VALUES (?, ?)').run(
    SEED_SESSION,
    SEEDED_AT,
  );
  db.prepare(
    "INSERT INTO session_signals (session_id, kind, detail, opened_at) VALUES (?, 'remember', 'the release freeze', ?)",
  ).run(SEED_SESSION, SEEDED_AT);
  db.prepare(
    "INSERT INTO command_failures (session_id, head, failed_at) VALUES (?, 'npm test', ?)",
  ).run(SEED_SESSION, SEEDED_AT);
  db.prepare(
    "INSERT INTO failure_recalls (session_id, head, recalled_at) VALUES (?, 'npm test', ?)",
  ).run(SEED_SESSION, SEEDED_AT);
  db.prepare(
    "INSERT INTO recall_events (session_id, event, at, injected) VALUES (?, 'SessionStart', ?, 3)",
  ).run(SEED_SESSION, SEEDED_AT);
  db.prepare(
    'INSERT INTO project_settings (project_id, recall_enabled, updated_at) VALUES (?, 1, ?)',
  ).run(projectId, SEEDED_AT);
}

export function seedLegacyStore(dir: string, options: LegacyStoreOptions): LegacyStore {
  mkdirSync(join(dir, 'models', 'sub'), { recursive: true });
  writeFileSync(join(dir, 'models', 'sub', 'weights.bin'), Buffer.alloc(MODEL_FILE_BYTES, 1));
  enableStatusline(dir, Buffer.from('shim source'), SEEDED_AT);
  const dbPath = join(dir, DB_FILENAME);
  const opened = openDatabase(seedConfig(dir, join(dir, 'models')));
  const ids = Array.from({ length: options.memories }, () => newId());
  opened.db.transaction(() => {
    insertMemoryRows(opened.db, options, ids);
    insertSessionRows(opened.db, options.projectId);
  })();
  const anchor = new Database(dbPath, { readonly: true });
  anchor.prepare('SELECT count(*) FROM meta').get();
  const lateIds = Array.from({ length: LATE_MEMORIES }, () => newId());
  opened.db.transaction(() => insertMemoryRows(opened.db, options, lateIds))();
  opened.db.close();
  return { dir, dbPath, anchor, pinnedId: ids[0]! };
}

export function digestOfStore(dbPath: string): StoreDigest {
  const db = new Database(dbPath);
  try {
    return storeDigest(db);
  } finally {
    db.close();
  }
}

export function integrityOf(dbPath: string): string {
  const db = new Database(dbPath);
  try {
    return db.pragma('integrity_check', { simple: true }) as string;
  } finally {
    db.close();
  }
}

export type FileHashes = Readonly<Record<string, string>>;

export function fileHashes(root: string, dir: string = root): FileHashes {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return Object.entries(fileHashes(root, path));
      }
      if (!entry.isFile()) {
        return [];
      }
      const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      return [[relative(root, path), sha256]];
    }),
  );
}

const SHM_FILE = `${DB_FILENAME}-shm`;
const WAL_FILE = `${DB_FILENAME}-wal`;

export function sourceChanges(
  before: FileHashes,
  dir: string,
  allowedNewFiles: readonly string[],
): string[] {
  const after = fileHashes(dir);
  const changed = Object.entries(before)
    .filter(([file, sha]) => file !== SHM_FILE && after[file] !== sha)
    .map(([file]) => `${file}: ${after[file] === undefined ? 'missing' : 'changed'}`);
  const appeared = Object.keys(after)
    .filter((file) => before[file] === undefined)
    .filter((file) => file !== SHM_FILE && !allowedNewFiles.includes(file))
    .filter((file) => file !== WAL_FILE || statSync(join(dir, file)).size > 0)
    .map((file) => `${file}: appeared`);
  return [...changed, ...appeared];
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