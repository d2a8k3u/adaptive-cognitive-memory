"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storeDigest = storeDigest;
const node_crypto_1 = require("node:crypto");
const ORDINARY_TABLES_SQL = `SELECT name, sql FROM sqlite_schema
  WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'
  ORDER BY name`;
const WITHOUT_ROWID = /WITHOUT\s+ROWID/i;
const ROW_SEPARATOR = "\n";
const VALUE_SEPARATOR = "\u0000";
function quoted(identifier) {
    return `"${identifier.replaceAll('"', '""')}"`;
}
function rowOrder(db, table) {
    if (!WITHOUT_ROWID.test(table.sql)) {
        return "rowid";
    }
    const columns = db.pragma(`table_info(${quoted(table.name)})`);
    return columns.map((_, index) => String(index + 1)).join(", ");
}
function canonicalValue(value) {
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
function feedRow(hash, row) {
    hash.update(row.map(canonicalValue).join(VALUE_SEPARATOR));
    hash.update(ROW_SEPARATOR);
}
function tableDigest(db, table) {
    const statement = db
        .prepare(`SELECT * FROM ${quoted(table.name)} ORDER BY ${rowOrder(db, table)}`)
        .raw(true)
        .safeIntegers(true);
    const hash = (0, node_crypto_1.createHash)("sha256");
    let rows = 0;
    for (const row of statement.iterate()) {
        feedRow(hash, row);
        rows += 1;
    }
    return { table: table.name, rows, sha256: hash.digest("hex") };
}
function storeDigest(db) {
    const tables = db.prepare(ORDINARY_TABLES_SQL).all().map((table) => tableDigest(db, table));
    const total = (0, node_crypto_1.createHash)("sha256");
    for (const table of tables) {
        total.update(`${table.table}${VALUE_SEPARATOR}${table.rows}${VALUE_SEPARATOR}${table.sha256}`);
        total.update(ROW_SEPARATOR);
    }
    return { tables, sha256: total.digest("hex") };
}
