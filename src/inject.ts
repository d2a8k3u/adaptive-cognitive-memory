import type { RecalledMemory } from "./gate";
import type { MemoryKind } from "./policy";
import { redact } from "./redact";
import type { DegradedFlags } from "./search";

const ULID_CHARS = 26;
const ISO_DATE_CHARS = 10;
const BLOCK_OPEN = "<memory>";
const BLOCK_CLOSE = "</memory>";
const MAX_RENDERED_CHARS = 9_500;
const HEADER =
  "Recalled memory from earlier sessions; verify it against the current code. Apply or follow each line, or say why it does not apply, then send memory_feedback with the ids.";
const ACTION_PREFIX_OF_KIND: Readonly<Partial<Record<MemoryKind, string>>> = {
  constraint: "Apply — ",
  procedure: "Follow — ",
};
const SECTION_TITLES = ["Constraints:", "Preferences:", "Project facts:", "Procedures:"] as const;
type SectionTitle = (typeof SECTION_TITLES)[number];
const SECTION_OF_KIND: Readonly<Record<MemoryKind, SectionTitle>> = {
  constraint: "Constraints:",
  preference: "Preferences:",
  fact: "Project facts:",
  belief: "Project facts:",
  procedure: "Procedures:",
};

export interface Injection {
  readonly text: string;
  readonly injectedIds: readonly string[];
}

interface RenderedLine {
  readonly id: string;
  readonly section: SectionTitle;
  readonly line: string;
}

function tokensForChars(charCount: number): number {
  return Math.ceil(charCount / 4);
}

function fitsInjection(charCount: number, budgetTokens: number): boolean {
  return charCount <= MAX_RENDERED_CHARS && tokensForChars(charCount) <= budgetTokens;
}

export function estimateTokens(text: string): number {
  return tokensForChars(text.length);
}

function memoryLine(memory: RecalledMemory): string {
  const validFrom = memory.validFrom.slice(0, ISO_DATE_CHARS);
  const actionPrefix = ACTION_PREFIX_OF_KIND[memory.kind] ?? "";
  return `- ${actionPrefix}${redact(memory.abstract).text} (valid from ${validFrom} · ${memory.scope} · ${memory.id})`;
}

export function minLineTokens(): number {
  return estimateTokens(
    memoryLine({
      id: "0".repeat(ULID_CHARS),
      kind: "fact",
      epistemic: "verified",
      scope: "user",
      abstract: "",
      validFrom: "0".repeat(ISO_DATE_CHARS),
    }),
  );
}

function degradedHeading(degraded: DegradedFlags | undefined): string[] {
  const missing: string[] = [];
  if (degraded?.model) {
    missing.push("model");
  }
  if (degraded?.vec) {
    missing.push("vec");
  }
  const causes = [
    ...(missing.length === 0 ? [] : [`${missing.join(", ")} missing`]),
    ...(degraded?.embedding_timeout ? ["embedding timeout"] : []),
  ];
  return causes.length === 0 ? [] : [`memory degraded (${causes.join("; ")}) — run /memory-doctor`];
}

function joinedLength(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length, 0) + Math.max(0, lines.length - 1);
}

function sectionedBody(rendered: readonly RenderedLine[]): string[] {
  return SECTION_TITLES.flatMap((title) => {
    const lines = rendered.filter((entry) => entry.section === title).map((entry) => entry.line);
    return lines.length === 0 ? [] : [title, ...lines];
  });
}

export function renderInjection(
  rows: readonly RecalledMemory[],
  budgetTokens: number,
  degraded?: DegradedFlags,
): Injection {
  const heading = degradedHeading(degraded);
  let used = joinedLength([...heading, BLOCK_OPEN, HEADER, BLOCK_CLOSE]);
  const rendered: RenderedLine[] = [];
  for (const row of rows) {
    const section = SECTION_OF_KIND[row.kind];
    const line = memoryLine(row);
    const sectionOpened = rendered.some((entry) => entry.section === section);
    const titleCost = sectionOpened ? 0 : section.length + 1;
    const next = used + line.length + 1 + titleCost;
    if (!fitsInjection(next, budgetTokens)) {
      break;
    }
    used = next;
    rendered.push({ id: row.id, section, line });
  }
  if (rendered.length === 0) {
    return { text: heading.join("\n"), injectedIds: [] };
  }
  return {
    text: [...heading, BLOCK_OPEN, HEADER, ...sectionedBody(rendered), BLOCK_CLOSE].join("\n"),
    injectedIds: rendered.map((entry) => entry.id),
  };
}
