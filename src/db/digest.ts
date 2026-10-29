import { createHash, type Hash } from "node:crypto";
import type Database from "better-sqlite3";

export interface TableDigest {
  readonly table: string;
  readonly rows: number;
  readonly sha256: string;
}

export interface StoreDigest {
  readonly tables: readonly TableDigest[];
  readonly sha256: string;
}

interface SchemaTable {
  readonly name: string;
  readonly sql: string;
}

const ORDINARY_TABLES_SQL = `SELECT name, sql FROM sqlite_schema
  WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'
  ORDER BY name`;
const WITHOUT_ROWID = /WITHOUT\s+ROWID/i;
const ROW_SEPARATOR = "\n";
const VALUE_SEPARATOR = "\u0000";

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function rowOrder(db: Database.Database, table: SchemaTable): string {
  if (!WITHOUT_ROWID.test(table.sql)) {
    return "rowid";
  }
  const columns = db.pragma(`table_info(${quoted(table.name)})`) as { name: string }[];
  return columns.map((_, index) => String(index + 1)).join(", ");
}

function canonicalValue(value: unknown): string {
  if (value === null) {
    return "N";
  }
  if (typeof value === "bigint") {
    return `I${value}`;
  }
  if (typeof value === "number") {
    return `R${value}`;
  }
  if (typeof value === "string") {
    return `T${value.length}:${value}`;
  }
  if (Buffer.isBuffer(value)) {
    return `B${value.toString("hex")}`;
  }
  throw new TypeError(`unexpected SQLite value type ${typeof value}`);
}

function feedRow(hash: Hash, row: unknown[]): void {
  hash.update(row.map(canonicalValue).join(VALUE_SEPARATOR));
  hash.update(ROW_SEPARATOR);
}

function tableDigest(db: Database.Database, table: SchemaTable): TableDigest {
  const statement = db
    .prepare(`SELECT * FROM ${quoted(table.name)} ORDER BY ${rowOrder(db, table)}`)
    .raw(true)
    .safeIntegers(true);
  const hash = createHash("sha256");
  let rows = 0;
  for (const row of statement.iterate()) {
    feedRow(hash, row as unknown[]);
    rows += 1;
  }
  return { table: table.name, rows, sha256: hash.digest("hex") };
}

export function storeDigest(db: Database.Database): StoreDigest {
  const tables = (db.prepare(ORDINARY_TABLES_SQL).all() as SchemaTable[]).map((table) =>
    tableDigest(db, table),
  );
  const total = createHash("sha256");
  for (const table of tables) {
    total.update(`${table.table}${VALUE_SEPARATOR}${table.rows}${VALUE_SEPARATOR}${table.sha256}`);
    total.update(ROW_SEPARATOR);
  }
  return { tables, sha256: total.digest("hex") };
}
