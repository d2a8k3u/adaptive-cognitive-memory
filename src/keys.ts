import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { contentTokens, wordsOf } from "./prompt";

export interface MemoryKeys {
  readonly conflictKey: string;
  readonly keywords: string;
  readonly anchors: readonly string[];
}

export interface ToolLookup {
  readonly anchors: readonly string[];
  readonly tokens: readonly string[];
}

const CONFLICT_KEY_NAMESPACE_SEPARATOR = ".";
export const MAX_HEAD_WORDS = 3;
const MAX_COMMAND_SEGMENTS = 32;
const DIRECTORY_SEPARATOR = "/";
const EXTENSION_MARK = ".";
const PARENT_DIRECTORY = "..";
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "env",
  "npx",
  "pnpx",
  "bunx",
  "uvx",
  "time",
  "nohup",
  "exec",
  "command",
]);
const RUNNER_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  uv: ["run"],
  poetry: ["run"],
  pipenv: ["run"],
  pdm: ["run"],
  hatch: ["run"],
  pipx: ["run"],
  pnpm: ["exec", "dlx"],
  npm: ["exec"],
  yarn: ["dlx", "exec"],
  bun: ["x"],
};
const NAVIGATION_COMMANDS: ReadonlySet<string> = new Set([
  "cd",
  "pushd",
  "popd",
  "source",
  ".",
  "export",
  "set",
]);
const PATH_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "Read"]);
const FLAG_MARK = "-";
const REDIRECTION = /[<>]/;
const OPEN_REDIRECTION = /[<>]$/;
const PIPE = "|";
const AMPERSAND = "&";
const OUTPUT_REDIRECTION = ">";
const LIST_SEPARATORS: ReadonlySet<string> = new Set([";", "\n"]);
const QUOTES: ReadonlySet<string> = new Set(["'", '"']);
const WHITESPACE = /\s/;

type ShellCommand = readonly string[];
type ShellPipeline = readonly ShellCommand[];

interface ShellOperator {
  readonly ends: "pipeline" | "command";
  readonly length: number;
}

function topicSegments(conflictKey: string): string[] {
  const segments = conflictKey.split(CONFLICT_KEY_NAMESPACE_SEPARATOR);
  const topic = segments.length > 1 ? segments.slice(1) : segments;
  return wordsOf(topic.join(" "));
}

function intersects(tokens: ReadonlySet<string>, words: readonly string[]): boolean {
  return words.some((word) => tokens.has(word));
}

function anchorWordsPresent(tokens: ReadonlySet<string>, anchor: string): boolean {
  const words = wordsOf(anchor);
  return words.length > 0 && words.every((word) => tokens.has(word));
}

export function keyHit(tokens: ReadonlySet<string>, keys: MemoryKeys): boolean {
  return (
    intersects(tokens, topicSegments(keys.conflictKey)) ||
    intersects(tokens, wordsOf(keys.keywords)) ||
    keys.anchors.some((anchor) => anchorWordsPresent(tokens, anchor))
  );
}

export function parseStoredAnchors(memoryId: string, stored: string): string[] {
  if (stored === "") {
    return [];
  }
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed) || !parsed.every((anchor) => typeof anchor === "string")) {
    throw new Error(`memory ${memoryId} has malformed anchors`);
  }
  return parsed;
}

export function anchorHit(anchors: readonly string[], lookup: ReadonlySet<string>): boolean {
  return anchors.some((anchor) => lookup.has(anchor));
}

function shellOperator(
  chars: readonly string[],
  index: number,
  word: string,
): ShellOperator | undefined {
  const char = chars[index];
  const next = chars[index + 1];
  if (char !== undefined && LIST_SEPARATORS.has(char)) {
    return { ends: "pipeline", length: 1 };
  }
  if (char === PIPE) {
    return next === PIPE
      ? { ends: "pipeline", length: 2 }
      : { ends: "command", length: next === AMPERSAND ? 2 : 1 };
  }
  if (char !== AMPERSAND || next === OUTPUT_REDIRECTION || OPEN_REDIRECTION.test(word)) {
    return undefined;
  }
  return { ends: "pipeline", length: next === AMPERSAND ? 2 : 1 };
}

function shellPipelines(command: string): ShellPipeline[] {
  const chars = [...command];
  const pipelines: ShellPipeline[] = [];
  let commands: ShellCommand[] = [];
  let words: string[] = [];
  let word = "";
  let quote: string | undefined;
  const endWord = () => {
    if (word !== "") {
      words.push(word);
      word = "";
    }
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) {
      commands.push(words);
      words = [];
    }
  };
  const endPipeline = () => {
    endCommand();
    if (commands.length > 0) {
      pipelines.push(commands);
      commands = [];
    }
  };
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] as string;
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        word += char;
      }
      continue;
    }
    const operator = shellOperator(chars, index, word);
    if (operator !== undefined) {
      if (operator.ends === "pipeline") {
        endPipeline();
      } else {
        endCommand();
      }
      index += operator.length - 1;
    } else if (QUOTES.has(char)) {
      quote = char;
    } else if (WHITESPACE.test(char)) {
      endWord();
    } else {
      word += char;
    }
  }
  endPipeline();
  return pipelines;
}

function withoutWrappers(words: readonly string[]): string[] {
  let index = 0;
  while (index < words.length) {
    const word = words[index] as string;
    const isPrefix =
      ENV_ASSIGNMENT.test(word) ||
      COMMAND_WRAPPERS.has(word) ||
      (index > 0 && word.startsWith("-") && COMMAND_WRAPPERS.has(words[index - 1] as string));
    if (!isPrefix) {
      break;
    }
    index += 1;
  }
  const [command, ...rest] = words.slice(index);
  if (command === undefined) {
    return [];
  }
  return [command.includes(DIRECTORY_SEPARATOR) ? basename(command) : command, ...rest];
}

function heads(words: readonly string[]): string[] {
  return Array.from({ length: Math.min(MAX_HEAD_WORDS, words.length) }, (_, index) =>
    words.slice(0, index + 1).join(" "),
  );
}

function commandHeads(segment: readonly string[]): string[] {
  const words = withoutWrappers(segment);
  const [command, subcommand] = words;
  if (command === undefined) {
    return [];
  }
  const runsAnotherCommand =
    subcommand !== undefined && (RUNNER_SUBCOMMANDS[command] ?? []).includes(subcommand);
  return runsAnotherCommand ? [...heads(words), ...commandHeads(words.slice(2))] : heads(words);
}

function bashLookup(command: string): ToolLookup | undefined {
  const commands = shellPipelines(command).flat().slice(0, MAX_COMMAND_SEGMENTS);
  const anchors = [...new Set(commands.flatMap(commandHeads))];
  if (anchors.length === 0) {
    return undefined;
  }
  return { anchors, tokens: contentTokens(anchors.join(" ")) };
}

function projectRelativePath(filePath: string, projectDir: string): string | undefined {
  const path = relative(projectDir, resolve(projectDir, filePath));
  if (path === "" || path.startsWith(PARENT_DIRECTORY) || isAbsolute(path)) {
    return undefined;
  }
  return path.split(sep).join(DIRECTORY_SEPARATOR);
}

function directoryPrefixes(path: string): string[] {
  const directories = path.split(DIRECTORY_SEPARATOR).slice(0, -1);
  return directories.map(
    (_, index) => `${directories.slice(0, index + 1).join(DIRECTORY_SEPARATOR)}/`,
  );
}

function extensionSuffixes(name: string): string[] {
  return [...name].flatMap((char, index) => (char === EXTENSION_MARK ? [name.slice(index)] : []));
}

function pathLookup(filePath: string, projectDir: string): ToolLookup | undefined {
  if (filePath.trim() === "") {
    return undefined;
  }
  const name = basename(filePath);
  const path = projectRelativePath(filePath, projectDir);
  const located = path === undefined ? [] : [path, ...directoryPrefixes(path)];
  return {
    anchors: [...new Set([...located, name, ...extensionSuffixes(name)])],
    tokens: contentTokens(path ?? name),
  };
}

function stringProperty(value: unknown, field: string): string | undefined {
  if (value === null || typeof value !== "object" || !(field in value)) {
    return undefined;
  }
  const property: unknown = (value as Record<string, unknown>)[field];
  return typeof property === "string" ? property : undefined;
}

function endsHead(word: string): boolean {
  return word.startsWith(FLAG_MARK) || REDIRECTION.test(word);
}

function leadingWords(words: readonly string[]): string[] {
  const [command, ...rest] = words.slice(0, MAX_HEAD_WORDS);
  if (command === undefined) {
    return [];
  }
  const firstStop = rest.findIndex(endsHead);
  return [command, ...(firstStop === -1 ? rest : rest.slice(0, firstStop))];
}

export function commandHead(toolInput: unknown): string | undefined {
  const command = stringProperty(toolInput, "command");
  if (command === undefined) {
    return undefined;
  }
  const producer = shellPipelines(command)
    .map(([first]) => withoutWrappers(first ?? []))
    .filter(([word]) => word !== undefined && !NAVIGATION_COMMANDS.has(word))
    .at(-1);
  return producer === undefined ? undefined : leadingWords(producer).join(" ");
}

export function toolLookup(
  toolName: string,
  toolInput: unknown,
  projectDir: string,
): ToolLookup | undefined {
  if (toolName === "Bash") {
    const command = stringProperty(toolInput, "command");
    return command === undefined ? undefined : bashLookup(command);
  }
  if (PATH_TOOLS.has(toolName)) {
    const filePath = stringProperty(toolInput, "file_path");
    return filePath === undefined ? undefined : pathLookup(filePath, projectDir);
  }
  return undefined;
}
