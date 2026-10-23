"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkpoint = checkpoint;
exports.signalDetail = signalDetail;
const cfg_1 = require("./cfg");
const redact_1 = require("./redact");
const toolnames_1 = require("./toolnames");
const CHECKPOINT_OPENING = "Memory checkpoint: ";
const CHECKPOINT_REQUEST = ` — store the durable lesson under the memory rules with ${toolnames_1.STORE_TOOL}, or state that there is none, then finish.`;
const CHECKPOINT_LISTED_MOMENTS = 5;
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
