"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ANCHOR_MAX_CHARS = exports.ANCHORS_MAX_ITEMS = exports.KEYWORDS_MAX_CHARS = exports.VALUE_TEXT_MAX_CHARS = exports.CONFLICT_KEY_NAMESPACES = exports.CONFLICT_KEY_PATTERN = exports.CONFLICT_KEY_MAX_CHARS = void 0;
exports.conflictKeyProblem = conflictKeyProblem;
exports.valueTextProblem = valueTextProblem;
exports.keywordsProblem = keywordsProblem;
exports.anchorsProblem = anchorsProblem;
const branch_1 = require("./branch");
const keys_1 = require("./keys");
exports.CONFLICT_KEY_MAX_CHARS = 120;
exports.CONFLICT_KEY_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_-]+)+$/;
exports.CONFLICT_KEY_NAMESPACES = [
    "project",
    "build",
    "test",
    "deploy",
    "db",
    "api",
    "code",
    "git",
    "tool",
    "team",
    "user",
    "error",
    "ticket",
];
exports.VALUE_TEXT_MAX_CHARS = 200;
exports.KEYWORDS_MAX_CHARS = 300;
exports.ANCHORS_MAX_ITEMS = 20;
exports.ANCHOR_MAX_CHARS = 200;
const NAMESPACE_SEPARATOR = ".";
const WORD_SEPARATOR = " ";
const ABSOLUTE_PATH_MARK = "/";
const DOT_RELATIVE_PATH = /^\.\.?\//;
const TAB_LINE_BREAK_OR_SPACE_RUN = /[\t\n\r]| {2}/;
const WHITESPACE = /\s/;
const BACKSLASH = "\\";
const GLOB_MARK = /[*?]/;
const CONFLICT_KEY_MESSAGE = `conflict_key must be namespace.topic naming the slot — lowercase, dotted, at most ${exports.CONFLICT_KEY_MAX_CHARS} characters, with namespace one of ${exports.CONFLICT_KEY_NAMESPACES.join(", ")} — such as project.primary_database or team.reviewers`;
const ANCHORS_SHAPE_MESSAGE = `anchors must be a list of at most ${exports.ANCHORS_MAX_ITEMS} non-empty strings of at most ${exports.ANCHOR_MAX_CHARS} characters`;
function isSingleToken(anchor) {
    return !WHITESPACE.test(anchor);
}
const ANCHOR_FORM_RULES = [
    {
        violatedBy: (anchor) => anchor.startsWith(ABSOLUTE_PATH_MARK),
        fault: "is an absolute path; anchors match the project-relative path, so write it relative to the project root (billing/tax.py)",
    },
    {
        violatedBy: (anchor) => DOT_RELATIVE_PATH.test(anchor),
        fault: "starts with ./ or ../; write the project-relative path without the prefix",
    },
    {
        violatedBy: (anchor) => anchor !== anchor.trim() || TAB_LINE_BREAK_OR_SPACE_RUN.test(anchor),
        fault: "has leading, trailing or repeated whitespace; use single spaces and no tabs or line breaks",
    },
    {
        violatedBy: (anchor) => isSingleToken(anchor) && anchor.includes(BACKSLASH),
        fault: "contains a backslash; paths use / as the separator",
    },
    {
        violatedBy: (anchor) => isSingleToken(anchor) && GLOB_MARK.test(anchor),
        fault: "contains * or ?; anchors match exactly — use the path, a directory prefix ending in /, the basename or the extension",
    },
    {
        violatedBy: (anchor) => anchor.split(WORD_SEPARATOR).length > keys_1.MAX_HEAD_WORDS,
        fault: `has more than ${keys_1.MAX_HEAD_WORDS} words; a Bash anchor is a command head of at most ${keys_1.MAX_HEAD_WORDS} words (uv run pytest)`,
    },
    {
        violatedBy: (anchor) => (0, branch_1.isTicketShaped)(anchor) && anchor !== anchor.toUpperCase(),
        fault: "has the shape of a ticket id; write it upper-case as it appears in the branch (TOUCH-4945), or it will never match",
    },
];
function namespaceOf(conflictKey) {
    return conflictKey.slice(0, conflictKey.indexOf(NAMESPACE_SEPARATOR));
}
function isConflictKey(value) {
    return (typeof value === "string" &&
        value.length <= exports.CONFLICT_KEY_MAX_CHARS &&
        exports.CONFLICT_KEY_PATTERN.test(value) &&
        exports.CONFLICT_KEY_NAMESPACES.includes(namespaceOf(value)));
}
function conflictKeyProblem(value) {
    return isConflictKey(value)
        ? undefined
        : { field: "conflict_key", message: CONFLICT_KEY_MESSAGE };
}
function textProblem(field, maxChars, value) {
    return typeof value === "string" && value.length <= maxChars
        ? undefined
        : { field, message: `${field} must be a string of at most ${maxChars} characters` };
}
function valueTextProblem(value) {
    return textProblem("value_text", exports.VALUE_TEXT_MAX_CHARS, value);
}
function keywordsProblem(value) {
    return textProblem("keywords", exports.KEYWORDS_MAX_CHARS, value);
}
function isAnchorList(value) {
    return (Array.isArray(value) &&
        value.length <= exports.ANCHORS_MAX_ITEMS &&
        value.every((anchor) => typeof anchor === "string" && anchor !== "" && anchor.length <= exports.ANCHOR_MAX_CHARS));
}
function anchorFault(anchors, index, anchor) {
    const formRule = ANCHOR_FORM_RULES.find((rule) => rule.violatedBy(anchor));
    if (formRule !== undefined) {
        return formRule.fault;
    }
    const firstIndex = anchors.indexOf(anchor);
    return firstIndex < index ? `repeats anchors[${firstIndex}]; list each anchor once` : undefined;
}
function anchorsProblem(value) {
    if (!isAnchorList(value)) {
        return { field: "anchors", message: ANCHORS_SHAPE_MESSAGE };
    }
    for (const [index, anchor] of value.entries()) {
        const fault = anchorFault(value, index, anchor);
        if (fault !== undefined) {
            return { field: "anchors", message: `anchors[${index}] ${JSON.stringify(anchor)} ${fault}` };
        }
    }
    return undefined;
}
