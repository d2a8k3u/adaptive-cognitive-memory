"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.estimateTokens = estimateTokens;
exports.minLineTokens = minLineTokens;
exports.renderInjection = renderInjection;
const redact_1 = require("./redact");
const ULID_CHARS = 26;
const ISO_DATE_CHARS = 10;
const BLOCK_OPEN = "<memory>";
const BLOCK_CLOSE = "</memory>";
const MAX_RENDERED_CHARS = 9_500;
const HEADER = "Recalled memory from earlier sessions; verify it against the current code. Apply or follow each line, or say why it does not apply, then send memory_feedback for every id.";
const ACTION_PREFIX_OF_KIND = {
    constraint: "Apply — ",
    procedure: "Follow — ",
};
const SECTION_TITLES = ["Constraints:", "Preferences:", "Project facts:", "Procedures:"];
const SECTION_OF_KIND = {
    constraint: "Constraints:",
    preference: "Preferences:",
    fact: "Project facts:",
    belief: "Project facts:",
    procedure: "Procedures:",
};
function tokensForChars(charCount) {
    return Math.ceil(charCount / 4);
}
function fitsInjection(charCount, budgetTokens) {
    return charCount <= MAX_RENDERED_CHARS && tokensForChars(charCount) <= budgetTokens;
}
function estimateTokens(text) {
    return tokensForChars(text.length);
}
function memoryLine(memory) {
    const validFrom = memory.validFrom.slice(0, ISO_DATE_CHARS);
    const actionPrefix = ACTION_PREFIX_OF_KIND[memory.kind] ?? "";
    return `- ${actionPrefix}${(0, redact_1.redact)(memory.abstract).text} (valid from ${validFrom} · ${memory.scope} · ${memory.id})`;
}
function minLineTokens() {
    return estimateTokens(memoryLine({
        id: "0".repeat(ULID_CHARS),
        kind: "fact",
        epistemic: "verified",
        scope: "user",
        abstract: "",
        validFrom: "0".repeat(ISO_DATE_CHARS),
    }));
}
function degradedHeading(degraded) {
    const missing = [];
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
function joinedLength(lines) {
    return lines.reduce((sum, line) => sum + line.length, 0) + Math.max(0, lines.length - 1);
}
function sectionedBody(rendered) {
    return SECTION_TITLES.flatMap((title) => {
        const lines = rendered.filter((entry) => entry.section === title).map((entry) => entry.line);
        return lines.length === 0 ? [] : [title, ...lines];
    });
}
function renderInjection(rows, budgetTokens, degraded) {
    const heading = degradedHeading(degraded);
    let used = joinedLength([...heading, BLOCK_OPEN, HEADER, BLOCK_CLOSE]);
    const rendered = [];
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
