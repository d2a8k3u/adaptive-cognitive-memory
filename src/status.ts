import type { SignalKind } from "./capture";
import { RECALL_EVENT_NAMES, type RecallEventName } from "./db/events";
import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATES,
  type MemoryKind,
  type MemoryScope,
  type MemoryState,
} from "./policy";

export const RECALL_RATE_WINDOW = 500;
export const STATUS_LIST_LIMIT = 10;

const MS_PER_SECOND = 1000;

export interface MemoryCount {
  readonly scope: MemoryScope;
  readonly state: MemoryState;
  readonly kind: MemoryKind;
  readonly count: number;
}

export interface ReasonCount {
  readonly reason: string;
  readonly count: number;
}

export interface OpenSignalFact {
  readonly sessionId: string;
  readonly kind: SignalKind;
  readonly detail: string;
  readonly openedAt: string;
}

export interface InjectionFact {
  readonly id: string;
  readonly title: string;
  readonly event: string;
  readonly at: string;
}

export interface RecallEventCount {
  readonly event: RecallEventName;
  readonly events: number;
  readonly injecting: number;
}

interface EventTally {
  readonly events: number;
  readonly injecting: number;
}

export interface StatusFacts {
  readonly projectId: string;
  readonly recallEnabled: boolean;
  readonly memoryCounts: readonly MemoryCount[];
  readonly transitionCounts: readonly ReasonCount[];
  readonly recallEvents: readonly RecallEventCount[];
  readonly receiptInjections: { readonly memories: number; readonly neverUsed: number };
  readonly openSignals: readonly OpenSignalFact[];
  readonly recentInjections: readonly InjectionFact[];
}

type KindCounts = Record<MemoryKind, number>;
type StateCounts = Record<MemoryState, KindCounts>;

export interface StatusReport {
  readonly project: { readonly id: string; readonly recall: "on" | "off" };
  readonly memories: Record<MemoryScope, StateCounts>;
  readonly transitions: Record<string, number>;
  readonly recall_events: {
    readonly window: number;
    readonly events: number;
    readonly injecting: number;
    readonly rate: number | null;
    readonly by_event: Record<RecallEventName, EventTally>;
  };
  readonly receipt_sessions: {
    readonly memories_injected: number;
    readonly never_used: number;
    readonly share: number | null;
  };
  readonly open_signals: readonly {
    readonly session_id: string;
    readonly kind: SignalKind;
    readonly detail: string;
    readonly age_seconds: number;
  }[];
  readonly last_injections: readonly InjectionFact[];
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

function countOf(
  counts: readonly MemoryCount[],
  scope: MemoryScope,
  state: MemoryState,
  kind: MemoryKind,
): number {
  return counts
    .filter((row) => row.scope === scope && row.state === state && row.kind === kind)
    .reduce((sum, row) => sum + row.count, 0);
}

function stateCounts(counts: readonly MemoryCount[], scope: MemoryScope): StateCounts {
  const kindCounts = (state: MemoryState): KindCounts =>
    Object.fromEntries(
      MEMORY_KINDS.map((kind) => [kind, countOf(counts, scope, state, kind)]),
    ) as KindCounts;
  return Object.fromEntries(
    MEMORY_STATES.map((state) => [state, kindCounts(state)]),
  ) as StateCounts;
}

function ageSeconds(openedAt: string, now: string): number {
  return Math.floor((Date.parse(now) - Date.parse(openedAt)) / MS_PER_SECOND);
}

function tallyOf(counts: readonly RecallEventCount[]): EventTally {
  return counts.reduce(
    (sum, row) => ({ events: sum.events + row.events, injecting: sum.injecting + row.injecting }),
    { events: 0, injecting: 0 },
  );
}

function tallyByEvent(counts: readonly RecallEventCount[]): Record<RecallEventName, EventTally> {
  return Object.fromEntries(
    RECALL_EVENT_NAMES.map((event) => [
      event,
      tallyOf(counts.filter((row) => row.event === event)),
    ]),
  ) as Record<RecallEventName, EventTally>;
}

export function statusReport(facts: StatusFacts, now: string): StatusReport {
  const { receiptInjections } = facts;
  const recallEvents = tallyOf(facts.recallEvents);
  return {
    project: { id: facts.projectId, recall: facts.recallEnabled ? "on" : "off" },
    memories: Object.fromEntries(
      MEMORY_SCOPES.map((scope) => [scope, stateCounts(facts.memoryCounts, scope)]),
    ) as Record<MemoryScope, StateCounts>,
    transitions: Object.fromEntries(facts.transitionCounts.map((row) => [row.reason, row.count])),
    recall_events: {
      window: RECALL_RATE_WINDOW,
      events: recallEvents.events,
      injecting: recallEvents.injecting,
      rate: ratio(recallEvents.injecting, recallEvents.events),
      by_event: tallyByEvent(facts.recallEvents),
    },
    receipt_sessions: {
      memories_injected: receiptInjections.memories,
      never_used: receiptInjections.neverUsed,
      share: ratio(receiptInjections.neverUsed, receiptInjections.memories),
    },
    open_signals: facts.openSignals.map((signal) => ({
      session_id: signal.sessionId,
      kind: signal.kind,
      detail: signal.detail,
      age_seconds: ageSeconds(signal.openedAt, now),
    })),
    last_injections: facts.recentInjections,
  };
}
