"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cueLine = cueLine;
exports.checkpoint = checkpoint;
exports.signalDetail = signalDetail;
exports.detectCue = detectCue;
const cfg_1 = require("./cfg");
const harness_1 = require("./harness");
const redact_1 = require("./redact");
const toolnames_1 = require("./toolnames");
const CUE_LINES = {
    correction: `If this message corrects how you work, store the rule and the reason with ${toolnames_1.STORE_TOOL} before continuing.`,
    remember: `The user asked you to remember this: store it with ${toolnames_1.STORE_TOOL} now.`,
};
const CHECKPOINT_OPENING = "Memory checkpoint: ";
const CHECKPOINT_REQUEST = ` — store the durable lesson under the memory rules with ${toolnames_1.STORE_TOOL}, or state that there is none, then finish.`;
const CHECKPOINT_LISTED_MOMENTS = 5;
function cueLine(kind) {
    return CUE_LINES[kind];
}
function signalClause(signal) {
    switch (signal.kind) {
        case "correction":
            return `you were corrected about "${signal.detail}"`;
        case "remember":
            return `the user asked you to remember "${signal.detail}"`;
        case "resolution":
            return `you resolved a failing \`${signal.detail}\``;
    }
}
function unlistedMoments(count) {
    if (count === 0) {
        return [];
    }
    return [`and ${count} more moment${count === 1 ? "" : "s"}`];
}
function checkpoint(open, stopHookActive) {
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
function signalDetail(text) {
    return [...(0, redact_1.redact)(text).text].slice(0, cfg_1.SIGNAL_DETAIL_MAX_CHARS).join("");
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
];
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
];
function cuePatterns(sources) {
    return sources.map((source) => new RegExp(`${WORD_START}(?:${source})${WORD_END}`, "u"));
}
const PATTERNS_BY_KIND = [
    ["remember", cuePatterns(REMEMBER_CUES)],
    ["correction", cuePatterns(CORRECTION_CUES)],
];
function foldedText(text) {
    return text
        .trim()
        .normalize("NFD")
        .replace(COMBINING_MARKS, "")
        .toLowerCase()
        .replace(APOSTROPHE_VARIANTS, "'");
}
function earliestMatch(text, patterns) {
    const matches = patterns.flatMap((pattern) => {
        const match = pattern.exec(text);
        return match === null ? [] : [{ index: match.index, text: match[0] }];
    });
    const [earliest] = matches.sort((a, b) => a.index - b.index);
    return earliest?.text;
}
function detectCue(prompt) {
    if ((0, harness_1.harnessMarker)(prompt) !== undefined) {
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
