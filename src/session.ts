import type { RecalledMemory } from "./gate";
import type { MemoryKind } from "./policy";
import { STORE_TOOL } from "./toolnames";

export const PINNED_KINDS: readonly MemoryKind[] = ["constraint", "preference"];
export const STALE_AFTER_INJECTION_EVENTS = 500;

const REINJECTING_SOURCES: ReadonlySet<string> = new Set(["resume", "compact"]);
const ROUTED_SOURCES: ReadonlySet<string> = new Set(["startup", "clear", "compact"]);
const ROUTING_LINE = `Native auto memory is also on: store durable lessons with ${STORE_TOOL}, not in the auto-memory MEMORY.md.`;

export function routesLessons(source: string | undefined): boolean {
  return ROUTED_SOURCES.has(source ?? "");
}

export function routingLine(autoMemoryEnabled: boolean): string {
  return autoMemoryEnabled ? ROUTING_LINE : "";
}

export interface PinnedCandidate extends RecalledMemory {
  readonly importance: number;
  readonly createdAt: string;
  readonly lastActivityAt: string;
}

export interface SessionStartInput {
  readonly source: string | undefined;
  readonly pinned: readonly PinnedCandidate[];
  readonly ticket?: readonly RecalledMemory[];
  readonly earlier: readonly RecalledMemory[];
  readonly recentEventTimes: readonly string[];
  readonly limit: number;
}

interface RankedCandidate {
  readonly candidate: PinnedCandidate;
  readonly stale: boolean;
}

export function isStale(lastActivityAt: string, recentEventTimes: readonly string[]): boolean {
  const eventsSince = recentEventTimes.filter((at) => at > lastActivityAt).length;
  return eventsSince > STALE_AFTER_INJECTION_EVENTS;
}

function descendingText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a > b ? -1 : 1;
}

function byRank(a: RankedCandidate, b: RankedCandidate): number {
  return (
    b.candidate.importance - a.candidate.importance ||
    Number(a.stale) - Number(b.stale) ||
    descendingText(a.candidate.createdAt, b.candidate.createdAt) ||
    -descendingText(a.candidate.id, b.candidate.id)
  );
}

function rankedPinned(
  pinned: readonly PinnedCandidate[],
  recentEventTimes: readonly string[],
): PinnedCandidate[] {
  return pinned
    .map((candidate) => ({ candidate, stale: isStale(candidate.lastActivityAt, recentEventTimes) }))
    .sort(byRank)
    .map((ranked) => ranked.candidate);
}

function firstOccurrences(rows: readonly RecalledMemory[]): RecalledMemory[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) {
      return false;
    }
    seen.add(row.id);
    return true;
  });
}

export function sessionStartMemories(input: SessionStartInput): RecalledMemory[] {
  const carried = REINJECTING_SOURCES.has(input.source ?? "") ? input.earlier : [];
  return firstOccurrences([
    ...rankedPinned(input.pinned, input.recentEventTimes),
    ...(input.ticket ?? []),
    ...carried,
  ]).slice(0, input.limit);
}
