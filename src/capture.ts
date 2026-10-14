import { SIGNAL_DETAIL_MAX_CHARS } from "./cfg";
import { harnessMarker } from "./harness";
import { redact } from "./redact";
import { STORE_TOOL } from "./toolnames";

export type SignalKind = "correction" | "remember" | "resolution";
export type CueKind = Exclude<SignalKind, "resolution">;

export interface Cue {
  readonly kind: CueKind;
  readonly detail: string;
}

export interface OpenSignal {
  readonly id: number;
  readonly kind: SignalKind;
  readonly detail: string;
}

export interface Checkpoint {
  readonly text: string;
  readonly closedIds: readonly number[];
}

const CUE_LINES: Readonly<Record<CueKind, string>> = {
  correction: `If this message corrects how you work, store the rule and the reason with ${STORE_TOOL} before continuing.`,
  remember: `The user asked you to remember this: store it with ${STORE_TOOL} now.`,
};
const CHECKPOINT_OPENING = "Memory checkpoint: ";
const CHECKPOINT_REQUEST = ` — store the durable lesson under the memory rules with ${STORE_TOOL}, or state that there is none, then finish.`;
const CHECKPOINT_LISTED_MOMENTS = 5;

export function cueLine(kind: CueKind): string {
  return CUE_LINES[kind];
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
): Checkpoint | undefined {
  if (stopHookActive || open.length === 0) {
    return undefined;
  }
  const newestFirst = [...new Set(open.map(signalClause).reverse())];
  const listed = newestFirst.slice(0, CHECKPOINT_LISTED_MOMENTS).reverse();
  const clauses = [...listed, ...unlistedMoments(newestFirst.length - listed.length)];
  return {
    text: `${CHECKPOINT_OPENING}${clauses.join("; ")}${CHECKPOINT_REQUEST}`,
    closedIds: open.map((signal) => signal.id),
  };
}

export function signalDetail(text: string): string {
  return [...redact(text).text].slice(0, SIGNAL_DETAIL_MAX_CHARS).join("");
}

const WORD_START = "(?<![\\p{L}\\p{N}'])";
const WORD_END = "(?![\\p{L}\\p{N}])";
const COMBINING_MARKS = /\p{M}/gu;
const APOSTROPHE_VARIANTS = /[’‘ʼ`]/g;

const REMEMBER_CUES = [
  "(?<!(?:do|did) you )remember",
  "from now on",
  "next time",
  "note that",
  "keep in mind",
  "going forward",
  "in the future",
  "for future reference",
  "don'?t forget",
  "make a note",
  "memori[sz]e",
  "zapamatuj(?:te)?",
  "pamatuj(?:te)?",
  "priste",
  "odted",
  "od ted",
  "poznamenej(?:te)? si",
  "mej(?:te)? na pameti",
  "nezapomen(?:te)?",
  "do budoucna",
] as const;

const CORRECTION_CUES = [
  "^no(?:pe)?(?=[,.!])",
  "don'?t",
  "do not",
  "never",
  "wrong",
  "incorrect",
  "instead",
  "stop \\p{L}+ing",
  "i (?:already )?(?:told you|said)",
  "as i said",
  "not what i (?:asked|meant|wanted)",
  "should(?:n'?t| not) have",
  "why did you",
  "you forgot",
  "you keep",
  "(?:didn'?t|did not) ask",
  "^ne(?=[,.!])",
  "ne\\p{L}{2,}(?:ej|uj|aj|ij)(?:te)?",
  "ne(?:pis|maz|men)(?:te)?",
  "nikdy",
  "spatne",
  "chybne",
  "misto toho",
  "namisto",
  "(?:zase|znovu|znova|opet) (?:jsi|jste|si)",
  "prestan(?:te)?",
  "(?:ne)?rikal(?:a)? jsem",
  "proc (?:jsi|jste)",
  "zapomnel(?:a|i)? (?:jsi|jste)",
  "nesmi(?:s|te)",
  "nechci,? abys",
  "(?:neni|nebylo) (?:to )?spravne",
] as const;

function cuePatterns(sources: readonly string[]): readonly RegExp[] {
  return sources.map((source) => new RegExp(`${WORD_START}(?:${source})${WORD_END}`, "u"));
}

const PATTERNS_BY_KIND: readonly (readonly [CueKind, readonly RegExp[]])[] = [
  ["remember", cuePatterns(REMEMBER_CUES)],
  ["correction", cuePatterns(CORRECTION_CUES)],
];

function foldedText(text: string): string {
  return text
    .trim()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(APOSTROPHE_VARIANTS, "'");
}

function earliestMatch(text: string, patterns: readonly RegExp[]): string | undefined {
  const matches = patterns.flatMap((pattern) => {
    const match = pattern.exec(text);
    return match === null ? [] : [{ index: match.index, text: match[0] }];
  });
  const [earliest] = matches.sort((a, b) => a.index - b.index);
  return earliest?.text;
}

export function detectCue(prompt: string): Cue | undefined {
  if (harnessMarker(prompt) !== undefined) {
    return undefined;
  }
  const text = foldedText(prompt);
  for (const [kind, patterns] of PATTERNS_BY_KIND) {
    const detail = earliestMatch(text, patterns);
    if (detail !== undefined) {
      return { kind, detail };
    }
  }
  return undefined;
}
