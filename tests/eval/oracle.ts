export interface SlotClaim {
  readonly conflict_key: string;
  readonly value_text: string;
}

export interface ResolutionCandidate extends SlotClaim {
  readonly id: string;
  readonly cardinality: string;
}

export type OracleResolution =
  | { readonly action: "ADD" }
  | { readonly action: "SUPERSEDE" | "NOOP"; readonly target: string };

function normalised(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function oracleResolution(
  memory: SlotClaim,
  candidates: readonly ResolutionCandidate[],
): OracleResolution {
  const holder = candidates.find(
    (candidate) =>
      candidate.conflict_key === memory.conflict_key && candidate.cardinality === "single",
  );
  if (holder === undefined) {
    return { action: "ADD" };
  }
  return normalised(holder.value_text) === normalised(memory.value_text)
    ? { action: "NOOP", target: holder.id }
    : { action: "SUPERSEDE", target: holder.id };
}
