"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.restatedInstruction = restatedInstruction;
exports.readInstructionLines = readInstructionLines;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const policy_1 = require("./policy");
const RESTATEMENT_MIN_CHARS = 20;
const MARKDOWN_EXTENSION = ".md";
const MISSING_FILE_CODES = new Set(["ENOENT", "ENOTDIR"]);
function restatedInstruction(content, lines) {
    const restated = (0, policy_1.normalizeText)(content);
    if (restated.length < RESTATEMENT_MIN_CHARS) {
        return undefined;
    }
    return lines.find((line) => (0, policy_1.normalizeText)(line.text).includes(restated));
}
function isMissingFile(error) {
    return (error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        MISSING_FILE_CODES.has(error.code));
}
function markdownFilesUnder(dir) {
    try {
        return (0, node_fs_1.readdirSync)(dir, { recursive: true, withFileTypes: true })
            .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(MARKDOWN_EXTENSION))
            .map((entry) => (0, node_path_1.join)(entry.parentPath, entry.name))
            .sort();
    }
    catch (error) {
        if (isMissingFile(error)) {
            return [];
        }
        throw error;
    }
}
function fileLines(path) {
    try {
        return (0, node_fs_1.readFileSync)(path, "utf8")
            .split("\n")
            .map((text) => ({ source: path, text }));
    }
    catch (error) {
        if (isMissingFile(error)) {
            return [];
        }
        throw error;
    }
}
function readInstructionLines(sources) {
    const { projectDir } = sources;
    return [
        (0, node_path_1.join)(projectDir, "CLAUDE.md"),
        (0, node_path_1.join)(projectDir, ".claude", "CLAUDE.md"),
        ...markdownFilesUnder((0, node_path_1.join)(projectDir, ".claude", "rules")),
        ...(sources.autoMemoryIndex === undefined ? [] : [sources.autoMemoryIndex]),
    ].flatMap(fileLines);
}
