import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeText } from "./policy";

export interface InstructionLine {
  readonly source: string;
  readonly text: string;
}

export interface InstructionSources {
  readonly projectDir: string;
  readonly autoMemoryIndex: string | undefined;
}

const RESTATEMENT_MIN_CHARS = 20;
const MARKDOWN_EXTENSION = ".md";
const MISSING_FILE_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

export function restatedInstruction(
  content: string,
  lines: readonly InstructionLine[],
): InstructionLine | undefined {
  const restated = normalizeText(content);
  if (restated.length < RESTATEMENT_MIN_CHARS) {
    return undefined;
  }
  return lines.find((line) => normalizeText(line.text).includes(restated));
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    MISSING_FILE_CODES.has(error.code)
  );
}

function markdownFilesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(MARKDOWN_EXTENSION),
      )
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

function fileLines(path: string): InstructionLine[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .map((text) => ({ source: path, text }));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

export function readInstructionLines(sources: InstructionSources): InstructionLine[] {
  const { projectDir } = sources;
  return [
    join(projectDir, "CLAUDE.md"),
    join(projectDir, ".claude", "CLAUDE.md"),
    ...markdownFilesUnder(join(projectDir, ".claude", "rules")),
    ...(sources.autoMemoryIndex === undefined ? [] : [sources.autoMemoryIndex]),
  ].flatMap(fileLines);
}
