"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_HEAD_WORDS = void 0;
exports.keyHit = keyHit;
exports.parseStoredAnchors = parseStoredAnchors;
exports.anchorHit = anchorHit;
exports.commandHead = commandHead;
exports.toolLookup = toolLookup;
const node_path_1 = require("node:path");
const prompt_1 = require("./prompt");
const CONFLICT_KEY_NAMESPACE_SEPARATOR = ".";
exports.MAX_HEAD_WORDS = 3;
const MAX_COMMAND_SEGMENTS = 32;
const DIRECTORY_SEPARATOR = "/";
const EXTENSION_MARK = ".";
const PARENT_DIRECTORY = "..";
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMMAND_WRAPPERS = new Set([
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
const RUNNER_SUBCOMMANDS = {
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
const NAVIGATION_COMMANDS = new Set([
    "cd",
    "pushd",
    "popd",
    "source",
    ".",
    "export",
    "set",
]);
const PATH_TOOLS = new Set(["Edit", "Write", "Read"]);
const FLAG_MARK = "-";
const REDIRECTION = /[<>]/;
const OPEN_REDIRECTION = /[<>]$/;
const PIPE = "|";
const AMPERSAND = "&";
const OUTPUT_REDIRECTION = ">";
const LIST_SEPARATORS = new Set([";", "\n"]);
const QUOTES = new Set(["'", '"']);
const WHITESPACE = /\s/;
function topicSegments(conflictKey) {
    const segments = conflictKey.split(CONFLICT_KEY_NAMESPACE_SEPARATOR);
    const topic = segments.length > 1 ? segments.slice(1) : segments;
    return (0, prompt_1.wordsOf)(topic.join(" "));
}
function intersects(tokens, words) {
    return words.some((word) => tokens.has(word));
}
function anchorWordsPresent(tokens, anchor) {
    const words = (0, prompt_1.wordsOf)(anchor);
    return words.length > 0 && words.every((word) => tokens.has(word));
}
function keyHit(tokens, keys) {
    return (intersects(tokens, topicSegments(keys.conflictKey)) ||
        intersects(tokens, (0, prompt_1.wordsOf)(keys.keywords)) ||
        keys.anchors.some((anchor) => anchorWordsPresent(tokens, anchor)));
}
function parseStoredAnchors(memoryId, stored) {
    if (stored === "") {
        return [];
    }
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed) || !parsed.every((anchor) => typeof anchor === "string")) {
        throw new Error(`memory ${memoryId} has malformed anchors`);
    }
    return parsed;
}
function anchorHit(anchors, lookup) {
    return anchors.some((anchor) => lookup.has(anchor));
}
function shellOperator(chars, index, word) {
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
function shellPipelines(command) {
    const chars = [...command];
    const pipelines = [];
    let commands = [];
    let words = [];
    let word = "";
    let quote;
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
        const char = chars[index];
        if (quote !== undefined) {
            if (char === quote) {
                quote = undefined;
            }
            else {
                word += char;
            }
            continue;
        }
        const operator = shellOperator(chars, index, word);
        if (operator !== undefined) {
            if (operator.ends === "pipeline") {
                endPipeline();
            }
            else {
                endCommand();
            }
            index += operator.length - 1;
        }
        else if (QUOTES.has(char)) {
            quote = char;
        }
        else if (WHITESPACE.test(char)) {
            endWord();
        }
        else {
            word += char;
        }
    }
    endPipeline();
    return pipelines;
}
function withoutWrappers(words) {
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        const isPrefix = ENV_ASSIGNMENT.test(word) ||
            COMMAND_WRAPPERS.has(word) ||
            (index > 0 && word.startsWith("-") && COMMAND_WRAPPERS.has(words[index - 1]));
        if (!isPrefix) {
            break;
        }
        index += 1;
    }
    const [command, ...rest] = words.slice(index);
    if (command === undefined) {
        return [];
    }
    return [command.includes(DIRECTORY_SEPARATOR) ? (0, node_path_1.basename)(command) : command, ...rest];
}
function heads(words) {
    return Array.from({ length: Math.min(exports.MAX_HEAD_WORDS, words.length) }, (_, index) => words.slice(0, index + 1).join(" "));
}
function commandHeads(segment) {
    const words = withoutWrappers(segment);
    const [command, subcommand] = words;
    if (command === undefined) {
        return [];
    }
    const runsAnotherCommand = subcommand !== undefined && (RUNNER_SUBCOMMANDS[command] ?? []).includes(subcommand);
    return runsAnotherCommand ? [...heads(words), ...commandHeads(words.slice(2))] : heads(words);
}
function bashLookup(command) {
    const commands = shellPipelines(command).flat().slice(0, MAX_COMMAND_SEGMENTS);
    const anchors = [...new Set(commands.flatMap(commandHeads))];
    if (anchors.length === 0) {
        return undefined;
    }
    return { anchors, tokens: (0, prompt_1.contentTokens)(anchors.join(" ")) };
}
function projectRelativePath(filePath, projectDir) {
    const path = (0, node_path_1.relative)(projectDir, (0, node_path_1.resolve)(projectDir, filePath));
    if (path === "" || path.startsWith(PARENT_DIRECTORY) || (0, node_path_1.isAbsolute)(path)) {
        return undefined;
    }
    return path.split(node_path_1.sep).join(DIRECTORY_SEPARATOR);
}
function directoryPrefixes(path) {
    const directories = path.split(DIRECTORY_SEPARATOR).slice(0, -1);
    return directories.map((_, index) => `${directories.slice(0, index + 1).join(DIRECTORY_SEPARATOR)}/`);
}
function extensionSuffixes(name) {
    return [...name].flatMap((char, index) => (char === EXTENSION_MARK ? [name.slice(index)] : []));
}
function pathLookup(filePath, projectDir) {
    if (filePath.trim() === "") {
        return undefined;
    }
    const name = (0, node_path_1.basename)(filePath);
    const path = projectRelativePath(filePath, projectDir);
    const located = path === undefined ? [] : [path, ...directoryPrefixes(path)];
    return {
        anchors: [...new Set([...located, name, ...extensionSuffixes(name)])],
        tokens: (0, prompt_1.contentTokens)(path ?? name),
    };
}
function stringProperty(value, field) {
    if (value === null || typeof value !== "object" || !(field in value)) {
        return undefined;
    }
    const property = value[field];
    return typeof property === "string" ? property : undefined;
}
function endsHead(word) {
    return word.startsWith(FLAG_MARK) || REDIRECTION.test(word);
}
function leadingWords(words) {
    const [command, ...rest] = words.slice(0, exports.MAX_HEAD_WORDS);
    if (command === undefined) {
        return [];
    }
    const firstStop = rest.findIndex(endsHead);
    return [command, ...(firstStop === -1 ? rest : rest.slice(0, firstStop))];
}
function commandHead(toolInput) {
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
function toolLookup(toolName, toolInput, projectDir) {
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
