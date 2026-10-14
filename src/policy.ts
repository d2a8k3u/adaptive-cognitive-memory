import { createHash } from "node:crypto";

export const MEMORY_KINDS = ["constraint", "preference", "fact", "procedure", "belief"] as const;
export const CARDINALITIES = ["single", "multi"] as const;
export const RESOLUTION_ACTIONS = ["ADD", "UPDATE", "SUPERSEDE", "NOOP"] as const;
export const EPISTEMIC_STATES = ["verified", "unverified"] as const;
export const MEMORY_SCOPES = ["project", "user"] as const;
export const MEMORY_STATES = ["active", "hypothesis", "revoked"] as const;
export const MEMORY_TYPES = ["semantic", "episodic", "procedural", "pattern"] as const;
export const MEMORY_ORIGINS = ["user", "claude", "tool"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type Epistemic = (typeof EPISTEMIC_STATES)[number];
export type Cardinality = (typeof CARDINALITIES)[number];
export type ResolutionAction = (typeof RESOLUTION_ACTIONS)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemoryState = (typeof MEMORY_STATES)[number];
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface Slot {
  readonly scope: MemoryScope;
  readonly projectId: string;
  readonly conflictKey: string;
  readonly cardinality: Cardinality;
  readonly valueText: string;
}

export interface SlotRow extends Slot {
  readonly id: string;
  readonly state: MemoryState;
  readonly kind: MemoryKind;
}

export type Verdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function contentHash(content: string): string {
  return createHash("sha256").update(normalizeText(content)).digest("hex");
}

const ALLOWED: Verdict = { allowed: true };
const PROMOTABLE_KINDS: ReadonlySet<MemoryKind> = new Set([
  "procedure",
  "constraint",
  "preference",
]);
const PROMOTION_MIN_PROJECTS = 2;
const SUPERSEDABLE_STATES: ReadonlySet<MemoryState> = new Set(["active"]);
const REASSERTABLE_STATES: ReadonlySet<MemoryState> = new Set(["active", "hypothesis"]);

function rejected(reason: string): Verdict {
  return { allowed: false, reason };
}

function samePartition(a: Slot, b: Slot): boolean {
  return a.scope === b.scope && (a.scope === "user" || a.projectId === b.projectId);
}

function sameValue(a: Slot, b: Slot): boolean {
  return normalizeText(a.valueText) === normalizeText(b.valueText);
}

function holdsSlot(incoming: Slot, row: SlotRow): boolean {
  return (
    row.state === "active" &&
    samePartition(incoming, row) &&
    row.conflictKey === incoming.conflictKey
  );
}

function targetVerdict(
  incoming: Slot,
  target: SlotRow,
  acceptedStates: ReadonlySet<MemoryState>,
): Verdict {
  if (!acceptedStates.has(target.state)) {
    return rejected(
      `memory ${target.id} is ${target.state}; resolve against an active candidate or use ADD`,
    );
  }
  if (!samePartition(incoming, target)) {
    return rejected(
      `memory ${target.id} belongs to another partition (${target.scope} scope${target.scope === "project" ? ` of project ${target.projectId}` : ""}); resolve against a candidate of this partition or use ADD`,
    );
  }
  return ALLOWED;
}

function sameKeyVerdict(
  incoming: Slot,
  target: SlotRow,
  action: ResolutionAction,
  acceptedStates: ReadonlySet<MemoryState>,
): Verdict {
  const reachable = targetVerdict(incoming, target, acceptedStates);
  if (!reachable.allowed || target.conflictKey === incoming.conflictKey) {
    return reachable;
  }
  return rejected(
    `memory ${target.id} has conflict_key ${target.conflictKey}, not ${incoming.conflictKey}; ${action} needs the same conflict_key — use ADD for a different slot`,
  );
}

export function supersedeVerdict(incoming: Slot, target: SlotRow): Verdict {
  const sameKey = sameKeyVerdict(incoming, target, "SUPERSEDE", SUPERSEDABLE_STATES);
  if (!sameKey.allowed) {
    return sameKey;
  }
  if (incoming.cardinality !== "single" || target.cardinality !== "single") {
    return rejected(
      `conflict_key ${incoming.conflictKey} is multi-valued; SUPERSEDE needs single-valued rows on both sides — use ADD for another value or UPDATE with target ${target.id} to refine it`,
    );
  }
  return ALLOWED;
}

export function updateVerdict(incoming: Slot, target: SlotRow): Verdict {
  return sameKeyVerdict(incoming, target, "UPDATE", REASSERTABLE_STATES);
}

export function noopVerdict(incoming: Slot, target: SlotRow): Verdict {
  return targetVerdict(incoming, target, REASSERTABLE_STATES);
}

export function addVerdict(incoming: Slot, rows: readonly SlotRow[]): Verdict {
  const singleHolders = rows.filter(
    (row) => holdsSlot(incoming, row) && row.cardinality === "single",
  );
  const conflicting = singleHolders.find((row) => !sameValue(row, incoming));
  if (conflicting !== undefined) {
    return rejected(
      `conflict_key ${incoming.conflictKey} already holds "${conflicting.valueText}" in memory ${conflicting.id}; use SUPERSEDE with target ${conflicting.id} when the value changed, or UPDATE with target ${conflicting.id} to refine it`,
    );
  }
  const duplicate = singleHolders[0];
  if (incoming.cardinality === "single" && duplicate !== undefined) {
    return rejected(
      `conflict_key ${incoming.conflictKey} already holds this value in memory ${duplicate.id}; use NOOP or UPDATE with target ${duplicate.id}`,
    );
  }
  return ALLOWED;
}

export function reactivationVerdict(target: SlotRow, holders: readonly SlotRow[]): Verdict {
  if (target.state !== "hypothesis" || target.cardinality !== "single") {
    return ALLOWED;
  }
  const holder = holders.find(
    (row) => row.id !== target.id && row.cardinality === "single" && holdsSlot(target, row),
  );
  if (holder === undefined) {
    return ALLOWED;
  }
  return rejected(
    `memory ${target.id} cannot return to active: conflict_key ${target.conflictKey} is now held by memory ${holder.id} ("${holder.valueText}"); use memory_store with resolution SUPERSEDE and target ${holder.id} to restore the earlier value`,
  );
}

export function promotionContributors(
  written: SlotRow,
  sameKeyRows: readonly SlotRow[],
): readonly SlotRow[] {
  if (
    written.scope !== "project" ||
    !PROMOTABLE_KINDS.has(written.kind) ||
    normalizeText(written.valueText) === ""
  ) {
    return [];
  }
  const sharesKey = (row: SlotRow) =>
    row.state === "active" && row.conflictKey === written.conflictKey;
  if (sameKeyRows.some((row) => sharesKey(row) && row.scope === "user")) {
    return [];
  }
  const contributors = sameKeyRows.filter(
    (row) =>
      sharesKey(row) &&
      row.scope === "project" &&
      PROMOTABLE_KINDS.has(row.kind) &&
      sameValue(row, written),
  );
  const projects = new Set(contributors.map((row) => row.projectId));
  return projects.size >= PROMOTION_MIN_PROJECTS ? contributors : [];
}
