"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ULID_PATTERN = exports.LIST_PAGE_MAX_CHARS = exports.LIST_LIMIT_MAX = exports.LIST_LIMIT_DEFAULT = void 0;
exports.boundedPage = boundedPage;
exports.listMemories = listMemories;
const visibility_1 = require("./visibility");
exports.LIST_LIMIT_DEFAULT = 20;
exports.LIST_LIMIT_MAX = 50;
exports.LIST_PAGE_MAX_CHARS = 40_000;
exports.ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const LISTED_COLUMNS = `m.id, m.title, m.abstract, m.kind, m.type, m.scope, m.project_id, m.state,
  m.conflict_key, m.value_text, m.importance, m.support_count, m.injection_count, m.used_count,
  m.wrong_count, m.valid_from, m.updated_at`;
function partitionConditions(partition) {
    return partition.kind === "all"
        ? []
        : [{ sql: visibility_1.VISIBLE_TO_PROJECT, params: [partition.projectId] }];
}
function filterConditions(filters) {
    const columns = [
        ["m.state", filters.state],
        ["m.kind", filters.kind],
        ["m.type", filters.type],
        ["m.scope", filters.scope],
    ];
    return columns.flatMap(([column, value]) => value === undefined ? [] : [{ sql: `${column} = ?`, params: [value] }]);
}
function cursorConditions(before) {
    return before === undefined ? [] : [{ sql: "m.id < ?", params: [before] }];
}
function pageOf(rows, continues) {
    const last = rows.at(-1);
    return continues && last !== undefined ? { rows, next_cursor: last.id } : { rows };
}
function boundedPage(fetched, limit, maxChars) {
    const candidates = fetched.slice(0, limit);
    let kept = candidates.length;
    let page = pageOf(candidates, fetched.length > limit);
    while (kept > 1 && JSON.stringify(page).length > maxChars) {
        kept -= 1;
        page = pageOf(candidates.slice(0, kept), true);
    }
    return page;
}
function listMemories(db, request) {
    const conditions = [
        ...partitionConditions(request.partition),
        ...filterConditions(request.filters),
        ...cursorConditions(request.before),
    ];
    const where = conditions.length === 0
        ? ""
        : `WHERE ${conditions.map((condition) => condition.sql).join(" AND ")}`;
    const fetched = db
        .prepare(`SELECT ${LISTED_COLUMNS} FROM memories m ${where} ORDER BY m.id DESC LIMIT ?`)
        .all(...conditions.flatMap((condition) => condition.params), request.limit + 1);
    return boundedPage(fetched, request.limit, exports.LIST_PAGE_MAX_CHARS);
}
