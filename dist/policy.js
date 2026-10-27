"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONSULTABLE_STATES = exports.MEMORY_ORIGINS = exports.MEMORY_TYPES = exports.MEMORY_STATES = exports.MEMORY_SCOPES = exports.EPISTEMIC_STATES = exports.RESOLUTION_ACTIONS = exports.CARDINALITIES = exports.MEMORY_KINDS = void 0;
exports.normalizeText = normalizeText;
exports.contentHash = contentHash;
exports.supersedeVerdict = supersedeVerdict;
exports.updateVerdict = updateVerdict;
exports.noopVerdict = noopVerdict;
exports.addVerdict = addVerdict;
exports.reactivationVerdict = reactivationVerdict;
exports.promotionContributors = promotionContributors;
const node_crypto_1 = require("node:crypto");
exports.MEMORY_KINDS = ["constraint", "preference", "fact", "procedure", "belief"];
exports.CARDINALITIES = ["single", "multi"];
exports.RESOLUTION_ACTIONS = ["ADD", "UPDATE", "SUPERSEDE", "NOOP"];
exports.EPISTEMIC_STATES = ["verified", "unverified"];
exports.MEMORY_SCOPES = ["project", "user"];
exports.MEMORY_STATES = ["active", "hypothesis", "revoked"];
exports.MEMORY_TYPES = ["semantic", "episodic", "procedural", "pattern"];
exports.MEMORY_ORIGINS = ["user", "claude", "tool"];
exports.CONSULTABLE_STATES = ["active", "hypothesis"];
function normalizeText(text) {
    return text.trim().replace(/\s+/g, " ").toLowerCase();
}
function contentHash(content) {
    return (0, node_crypto_1.createHash)("sha256").update(normalizeText(content)).digest("hex");
}
const ALLOWED = { allowed: true };
const PROMOTABLE_KINDS = new Set([
    "procedure",
    "constraint",
    "preference",
]);
const PROMOTION_MIN_PROJECTS = 2;
const SUPERSEDABLE_STATES = new Set(["active"]);
const REASSERTABLE_STATES = new Set(["active", "hypothesis"]);
function rejected(reason) {
    return { allowed: false, reason };
}
function samePartition(a, b) {
    return a.scope === b.scope && (a.scope === "user" || a.projectId === b.projectId);
}
function sameValue(a, b) {
    return normalizeText(a.valueText) === normalizeText(b.valueText);
}
function holdsSlot(incoming, row) {
    return (row.state === "active" &&
        samePartition(incoming, row) &&
        row.conflictKey === incoming.conflictKey);
}
function targetVerdict(incoming, target, acceptedStates) {
    if (!acceptedStates.has(target.state)) {
        return rejected(`memory ${target.id} is ${target.state}; resolve against an active candidate or use ADD`);
    }
    if (!samePartition(incoming, target)) {
        return rejected(`memory ${target.id} belongs to another partition (${target.scope} scope${target.scope === "project" ? ` of project ${target.projectId}` : ""}); resolve against a candidate of this partition or use ADD`);
    }
    return ALLOWED;
}
function sameKeyVerdict(incoming, target, action, acceptedStates) {
    const reachable = targetVerdict(incoming, target, acceptedStates);
    if (!reachable.allowed || target.conflictKey === incoming.conflictKey) {
        return reachable;
    }
    return rejected(`memory ${target.id} has conflict_key ${target.conflictKey}, not ${incoming.conflictKey}; ${action} needs the same conflict_key — use ADD for a different slot`);
}
function supersedeVerdict(incoming, target) {
    const sameKey = sameKeyVerdict(incoming, target, "SUPERSEDE", SUPERSEDABLE_STATES);
    if (!sameKey.allowed) {
        return sameKey;
    }
    if (incoming.cardinality !== "single" || target.cardinality !== "single") {
        return rejected(`conflict_key ${incoming.conflictKey} is multi-valued; SUPERSEDE needs single-valued rows on both sides — use ADD for another value or UPDATE with target ${target.id} to refine it`);
    }
    return ALLOWED;
}
function updateVerdict(incoming, target) {
    return sameKeyVerdict(incoming, target, "UPDATE", REASSERTABLE_STATES);
}
function noopVerdict(incoming, target) {
    return targetVerdict(incoming, target, REASSERTABLE_STATES);
}
function addVerdict(incoming, rows) {
    const singleHolders = rows.filter((row) => holdsSlot(incoming, row) && row.cardinality === "single");
    const conflicting = singleHolders.find((row) => !sameValue(row, incoming));
    if (conflicting !== undefined) {
        return rejected(`conflict_key ${incoming.conflictKey} already holds "${conflicting.valueText}" in memory ${conflicting.id}; use SUPERSEDE with target ${conflicting.id} when the value changed, or UPDATE with target ${conflicting.id} to refine it`);
    }
    const duplicate = singleHolders[0];
    if (incoming.cardinality === "single" && duplicate !== undefined) {
        return rejected(`conflict_key ${incoming.conflictKey} already holds this value in memory ${duplicate.id}; use NOOP or UPDATE with target ${duplicate.id}`);
    }
    return ALLOWED;
}
function reactivationVerdict(target, holders) {
    if (target.state !== "hypothesis" || target.cardinality !== "single") {
        return ALLOWED;
    }
    const holder = holders.find((row) => row.id !== target.id && row.cardinality === "single" && holdsSlot(target, row));
    if (holder === undefined) {
        return ALLOWED;
    }
    return rejected(`memory ${target.id} cannot return to active: conflict_key ${target.conflictKey} is now held by memory ${holder.id} ("${holder.valueText}"); use memory_store with resolution SUPERSEDE and target ${holder.id} to restore the earlier value`);
}
function promotionContributors(written, sameKeyRows) {
    if (written.scope !== "project" ||
        !PROMOTABLE_KINDS.has(written.kind) ||
        normalizeText(written.valueText) === "") {
        return [];
    }
    const sharesKey = (row) => row.state === "active" && row.conflictKey === written.conflictKey;
    if (sameKeyRows.some((row) => sharesKey(row) && row.scope === "user")) {
        return [];
    }
    const contributors = sameKeyRows.filter((row) => sharesKey(row) &&
        row.scope === "project" &&
        PROMOTABLE_KINDS.has(row.kind) &&
        sameValue(row, written));
    const projects = new Set(contributors.map((row) => row.projectId));
    return projects.size >= PROMOTION_MIN_PROJECTS ? contributors : [];
}
