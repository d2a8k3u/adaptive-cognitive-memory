import { SIGNAL_DETAIL_MAX_CHARS } from "./cfg";
import { redact } from "./redact";

export type SignalKind = "correction" | "remember" | "resolution";

export interface OpenSignal {
  readonly id: number;
  readonly kind: SignalKind;
  readonly detail: string;
}

export interface Checkpoint {
  readonly text: string;
  readonly closedIds: readonly number[];
}

const CHECKPOINT_OPENING = "Memory checkpoint: ";
const CHECKPOINT_LISTED_MOMENTS = 5;

function checkpointRequest(storeTool: string): string {
  return ` — store the durable lesson under the memory rules with ${storeTool}, or state that there is none, then finish.`;
}

function signalClause(signal: OpenSignal): string {
  switch (signal.kind) {
    case "correction":
      return `you were corrected about "${signal.detail}"`;
    case "remember":
      return `the user asked you to remember "${signal.detail}"`;
    case "resolution":
      return `you resolved a failing \`${signal.detail}\``;
  }
}

function unlistedMoments(count: number): string[] {
  if (count === 0) {
    return [];
  }
  return [`and ${count} more moment${count === 1 ? "" : "s"}`];
}

export function checkpoint(
  open: readonly OpenSignal[],
  stopHookActive: boolean,
  storeTool: string,
): Checkpoint | undefined {
  if (stopHookActive || open.length === 0) {
    return undefined;
  }
  const newestFirst = [...new Set(open.map(signalClause).reverse())];
  const listed = newestFirst.slice(0, CHECKPOINT_LISTED_MOMENTS).reverse();
  const clauses = [...listed, ...unlistedMoments(newestFirst.length - listed.length)];
  return {
    text: `${CHECKPOINT_OPENING}${clauses.join("; ")}${checkpointRequest(storeTool)}`,
    closedIds: open.map((signal) => signal.id),
  };
}

export function signalDetail(text: string): string {
  return [...redact(text).text].slice(0, SIGNAL_DETAIL_MAX_CHARS).join("");
}
