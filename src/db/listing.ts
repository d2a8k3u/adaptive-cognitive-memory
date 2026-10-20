import type { MemoryKind, MemoryScope, MemoryState, MemoryType } from "../policy";
import type { Db } from "./database";
import { VISIBLE_TO_PROJECT } from "./visibility";

export const LIST_LIMIT_DEFAULT = 20;
export const LIST_LIMIT_MAX = 50;
export const LIST_PAGE_MAX_CHARS = 40_000;

export type ListPartition =
  | { readonly kind: "visible"; readonly projectId: string }
  | { readonly kind: "all" };

export interface ListFilters {
  readonly state?: MemoryState;
  readonly kind?: MemoryKind;
  readonly type?: MemoryType;
  readonly scope?: MemoryScope;
}

export interface ListRequest {
  readonly partition: ListPartition;
  readonly filters: ListFilters;
  readonly before?: string;
  readonly limit: number;
}

export interface ListedMemory {
  readonly id: string;
  readonly title: string;
  readonly abstract: string;
  readonly kind: MemoryKind;
  readonly type: MemoryType;
  readonly scope: MemoryScope;
  readonly project_id: string;
  readonly state: MemoryState;
  readonly conflict_key: string;
  readonly value_text: string;
  readonly importance: number;
  readonly support_count: number;
  readonly injection_count: number;
  readonly used_count: number;
  readonly wrong_count: number;
  readonly valid_from: string | null;
  readonly updated_at: string;
}

export interface ListPage {
  readonly rows: readonly ListedMemory[];
  readonly next_cursor?: string;
}

interface Condition {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const LISTED_COLUMNS = `m.id, m.title, m.abstract, m.kind, m.type, m.scope, m.project_id, m.state,
  m.conflict_key, m.value_text, m.importance, m.support_count, m.injection_count, m.used_count,
  m.wrong_count, m.valid_from, m.updated_at`;

function partitionConditions(partition: ListPartition): Condition[] {
  return partition.kind === "all"
    ? []
    : [{ sql: VISIBLE_TO_PROJECT, params: [partition.projectId] }];
}

function filterConditions(filters: ListFilters): Condition[] {
  const columns = [
    ["m.state", filters.state],
    ["m.kind", filters.kind],
    ["m.type", filters.type],
    ["m.scope", filters.scope],
  ] as const;
  return columns.flatMap(([column, value]) =>
    value === undefined ? [] : [{ sql: `${column} = ?`, params: [value] }],
  );
}

function cursorConditions(before: string | undefined): Condition[] {
  return before === undefined ? [] : [{ sql: "m.id < ?", params: [before] }];
}

function pageOf(rows: readonly ListedMemory[], continues: boolean): ListPage {
  const last = rows.at(-1);
  return continues && last !== undefined ? { rows, next_cursor: last.id } : { rows };
}

export function boundedPage(
  fetched: readonly ListedMemory[],
  limit: number,
  maxChars: number,
): ListPage {
  const candidates = fetched.slice(0, limit);
  let kept = candidates.length;
  let page = pageOf(candidates, fetched.length > limit);
  while (kept > 1 && JSON.stringify(page).length > maxChars) {
    kept -= 1;
    page = pageOf(candidates.slice(0, kept), true);
  }
  return page;
}

export function listMemories(db: Db, request: ListRequest): ListPage {
  const conditions = [
    ...partitionConditions(request.partition),
    ...filterConditions(request.filters),
    ...cursorConditions(request.before),
  ];
  const where =
    conditions.length === 0
      ? ""
      : `WHERE ${conditions.map((condition) => condition.sql).join(" AND ")}`;
  const fetched = db
    .prepare(`SELECT ${LISTED_COLUMNS} FROM memories m ${where} ORDER BY m.id DESC LIMIT ?`)
    .all(
      ...conditions.flatMap((condition) => condition.params),
      request.limit + 1,
    ) as ListedMemory[];
  return boundedPage(fetched, request.limit, LIST_PAGE_MAX_CHARS);
}
