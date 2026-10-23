"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FAILURE_TERMS_MAX = exports.FAILURE_TEXT_MAX_CHARS = void 0;
exports.failureSignature = failureSignature;
exports.failureLookup = failureLookup;
const node_path_1 = require("node:path");
const prompt_1 = require("./prompt");
const redact_1 = require("./redact");
exports.FAILURE_TEXT_MAX_CHARS = 500;
exports.FAILURE_TERMS_MAX = 32;
const LINE_BREAK = "\n";
const ESCAPE = String.fromCharCode(0x1b);
const ANSI_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const EXIT_LINE = /^Exit code (\d+)\s*$/;
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|m|min)\b/g;
const HEX_RUN = /\b[0-9a-fA-F]{7,}\b/g;
const LINE_COLUMN = /:\d+(?::\d+)?/g;
const REDACTION_MARKER = /\[REDACTED\]/g;
const NOISE = [ISO_TIMESTAMP, DURATION, HEX_RUN, LINE_COLUMN, REDACTION_MARKER];
const CLASS_NAME = /\b[A-Z][A-Za-z0-9]*(?:Error|Exception|Warning)\b/g;
const CODE = /\b[A-Z][A-Z0-9_]{2,}\b/g;
const GENERIC_STATUS_WORDS = new Set([
    "ERROR",
    "ERR",
    "ERRORS",
    "FAILED",
    "FAILURES",
    "FAIL",
    "FATAL",
    "WARN",
    "WARNING",
    "INFO",
    "DEBUG",
    "TRACE",
    "PASSED",
    "PASS",
    "EXIT",
    "CODE",
    "STDERR",
    "STDOUT",
    "NULL",
    "TRUE",
    "FALSE",
]);
const QUOTED_MODULE = /(?:Cannot find module|No module named|could not resolve)\s+['"‘]?([\w@][\w@./-]*)/gi;
const PATH_RUN = /(?:^|[\s'"(=:])((?:\/|\.{1,2}\/)[^\s'"():]+)/g;
function splitExitLine(text) {
    const lineEnd = text.indexOf(LINE_BREAK);
    const firstLine = lineEnd === -1 ? text : text.slice(0, lineEnd);
    const exit = EXIT_LINE.exec(firstLine);
    if (exit === null) {
        return { exitCode: undefined, body: text };
    }
    return { exitCode: Number(exit[1]), body: lineEnd === -1 ? "" : text.slice(lineEnd + 1) };
}
function matches(text, pattern) {
    return [...text.matchAll(pattern)].map((match) => match[0]);
}
function captures(text, pattern) {
    return [...text.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}
function withoutNoise(body) {
    return NOISE.reduce((text, noise) => text.replace(noise, " "), body);
}
function candidateTerms(body) {
    return [
        ...matches(body, CLASS_NAME),
        ...matches(body, CODE).filter((code) => !GENERIC_STATUS_WORDS.has(code)),
        ...captures(body, QUOTED_MODULE),
        ...captures(body, PATH_RUN)
            .map((path) => (0, node_path_1.basename)(path))
            .filter((name) => name !== ""),
    ];
}
function failureSignature(error) {
    const visible = (0, redact_1.redactWithin)(error, exports.FAILURE_TEXT_MAX_CHARS).replace(ANSI_SEQUENCE, "");
    const { exitCode, body } = splitExitLine(visible);
    const terms = [...new Set(candidateTerms(withoutNoise(body)))].slice(0, exports.FAILURE_TERMS_MAX);
    return { exitCode, terms };
}
function failureLookup(signature) {
    if (signature.terms.length === 0) {
        return undefined;
    }
    return { anchors: signature.terms, tokens: (0, prompt_1.distinctWords)(signature.terms.join(" ")) };
}
