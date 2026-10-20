import { isTicketShaped } from "./branch";
import { MAX_HEAD_WORDS } from "./keys";

export const CONFLICT_KEY_MAX_CHARS = 120;
export const CONFLICT_KEY_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_-]+)+$/;
export const CONFLICT_KEY_NAMESPACES: readonly string[] = [
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
export const VALUE_TEXT_MAX_CHARS = 200;
export const KEYWORDS_MAX_CHARS = 300;
export const ANCHORS_MAX_ITEMS = 20;
export const ANCHOR_MAX_CHARS = 200;

export type AuthoringField = "conflict_key" | "value_text" | "keywords" | "anchors";

export interface AuthoringProblem {
  readonly field: AuthoringField;
  readonly message: string;
}

interface AnchorFormRule {
  readonly violatedBy: (anchor: string) => boolean;
  readonly fault: string;
}

const NAMESPACE_SEPARATOR = ".";
const WORD_SEPARATOR = " ";
const ABSOLUTE_PATH_MARK = "/";
const DOT_RELATIVE_PATH = /^\.\.?\//;
const TAB_LINE_BREAK_OR_SPACE_RUN = /[\t\n\r]| {2}/;
const WHITESPACE = /\s/;
const BACKSLASH = "\\";
const GLOB_MARK = /[*?]/;

const CONFLICT_KEY_MESSAGE = `conflict_key must be namespace.topic naming the slot — lowercase, dotted, at most ${CONFLICT_KEY_MAX_CHARS} characters, with namespace one of ${CONFLICT_KEY_NAMESPACES.join(", ")} — such as project.primary_database or team.reviewers`;
const ANCHORS_SHAPE_MESSAGE = `anchors must be a list of at most ${ANCHORS_MAX_ITEMS} non-empty strings of at most ${ANCHOR_MAX_CHARS} characters`;
const REDACTED_ANCHOR_FAULT =
  "contains a secret; anchors match raw tool input, so a redacted anchor never fires";

function isSingleToken(anchor: string): boolean {
  return !WHITESPACE.test(anchor);
}

const ANCHOR_FORM_RULES: readonly AnchorFormRule[] = [
  {
    violatedBy: (anchor) => anchor.startsWith(ABSOLUTE_PATH_MARK),
    fault:
      "is an absolute path; anchors match the project-relative path, so write it relative to the project root (billing/tax.py)",
  },
  {
    violatedBy: (anchor) => DOT_RELATIVE_PATH.test(anchor),
    fault: "starts with ./ or ../; write the project-relative path without the prefix",
  },
  {
    violatedBy: (anchor) => anchor !== anchor.trim() || TAB_LINE_BREAK_OR_SPACE_RUN.test(anchor),
    fault:
      "has leading, trailing or repeated whitespace; use single spaces and no tabs or line breaks",
  },
  {
    violatedBy: (anchor) => isSingleToken(anchor) && anchor.includes(BACKSLASH),
    fault: "contains a backslash; paths use / as the separator",
  },
  {
    violatedBy: (anchor) => isSingleToken(anchor) && GLOB_MARK.test(anchor),
    fault:
      "contains * or ?; anchors match exactly — use the path, a directory prefix ending in /, the basename or the extension",
  },
  {
    violatedBy: (anchor) => anchor.split(WORD_SEPARATOR).length > MAX_HEAD_WORDS,
    fault: `has more than ${MAX_HEAD_WORDS} words; a Bash anchor is a command head of at most ${MAX_HEAD_WORDS} words (uv run pytest)`,
  },
  {
    violatedBy: (anchor) => isTicketShaped(anchor) && anchor !== anchor.toUpperCase(),
    fault:
      "has the shape of a ticket id; write it upper-case as it appears in the branch (TOUCH-4945), or it will never match",
  },
];

function namespaceOf(conflictKey: string): string {
  return conflictKey.slice(0, conflictKey.indexOf(NAMESPACE_SEPARATOR));
}

function isConflictKey(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= CONFLICT_KEY_MAX_CHARS &&
    CONFLICT_KEY_PATTERN.test(value) &&
    CONFLICT_KEY_NAMESPACES.includes(namespaceOf(value))
  );
}

export function conflictKeyProblem(value: unknown): AuthoringProblem | undefined {
  return isConflictKey(value)
    ? undefined
    : { field: "conflict_key", message: CONFLICT_KEY_MESSAGE };
}

function textProblem(
  field: AuthoringField,
  maxChars: number,
  value: unknown,
): AuthoringProblem | undefined {
  return typeof value === "string" && value.length <= maxChars
    ? undefined
    : { field, message: `${field} must be a string of at most ${maxChars} characters` };
}

export function valueTextProblem(value: unknown): AuthoringProblem | undefined {
  return textProblem("value_text", VALUE_TEXT_MAX_CHARS, value);
}

export function keywordsProblem(value: unknown): AuthoringProblem | undefined {
  return textProblem("keywords", KEYWORDS_MAX_CHARS, value);
}

function isAnchorList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= ANCHORS_MAX_ITEMS &&
    value.every(
      (anchor) => typeof anchor === "string" && anchor !== "" && anchor.length <= ANCHOR_MAX_CHARS,
    )
  );
}

function anchorFault(
  anchors: readonly string[],
  index: number,
  anchor: string,
): string | undefined {
  const formRule = ANCHOR_FORM_RULES.find((rule) => rule.violatedBy(anchor));
  if (formRule !== undefined) {
    return formRule.fault;
  }
  const firstIndex = anchors.indexOf(anchor);
  return firstIndex < index ? `repeats anchors[${firstIndex}]; list each anchor once` : undefined;
}

export function redactedAnchorProblem(
  written: readonly string[],
  stored: readonly string[],
): AuthoringProblem | undefined {
  const index = written.findIndex((anchor, position) => anchor !== stored[position]);
  return index === -1
    ? undefined
    : { field: "anchors", message: `anchors[${index}] ${REDACTED_ANCHOR_FAULT}` };
}

export function anchorsProblem(value: unknown): AuthoringProblem | undefined {
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
