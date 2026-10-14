"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEIGHBOURHOOD_SIZE = exports.KEY_MODES = void 0;
exports.neighbourhoodReference = neighbourhoodReference;
exports.selectPromptMemories = selectPromptMemories;
exports.passesToolGate = passesToolGate;
exports.selectToolMemories = selectToolMemories;
exports.KEY_MODES = ["disjunction", "conjunction", "ignored"];
exports.NEIGHBOURHOOD_SIZE = 10;
const FAIL_OPEN_KINDS = new Set(["constraint", "preference"]);
function descending(a, b) {
    return b - a;
}
function neighbourhoodReference(partitionCosines) {
    if (partitionCosines.length < exports.NEIGHBOURHOOD_SIZE) {
        return undefined;
    }
    const nearest = [...partitionCosines].sort(descending).slice(0, exports.NEIGHBOURHOOD_SIZE);
    return nearest.reduce((sum, cosine) => sum + cosine, 0) / exports.NEIGHBOURHOOD_SIZE;
}
function floorFor(kind, thresholds) {
    return FAIL_OPEN_KINDS.has(kind) ? thresholds.floorOpen : thresholds.floor;
}
function fallbackTauFor(kind, thresholds) {
    return FAIL_OPEN_KINDS.has(kind) ? thresholds.fallbackTauOpen : thresholds.fallbackTau;
}
function reachesSimilarity(candidate, thresholds, reference) {
    const { cosine, kind } = candidate;
    if (cosine === undefined) {
        return false;
    }
    if (reference === undefined) {
        return cosine >= fallbackTauFor(kind, thresholds);
    }
    return cosine >= floorFor(kind, thresholds) && cosine - reference >= thresholds.margin;
}
function reaches(cosine, threshold) {
    return cosine !== undefined && cosine >= threshold;
}
function requiresKeyHit(memory) {
    return memory.kind === "belief" || memory.epistemic === "unverified";
}
function admittedByKey(candidate, keyMode, thresholds) {
    switch (keyMode) {
        case "disjunction":
            return candidate.keyHit;
        case "conjunction":
            return candidate.keyHit && reaches(candidate.cosine, thresholds.tauKey);
        case "ignored":
            return false;
    }
}
function passesPromptGate(candidate, keyMode, thresholds, reference) {
    if (requiresKeyHit(candidate) && !candidate.keyHit) {
        return false;
    }
    return (reachesSimilarity(candidate, thresholds, reference) ||
        admittedByKey(candidate, keyMode, thresholds));
}
function descendingDefinedFirst(a, b) {
    if (a === b) {
        return 0;
    }
    if (a === undefined) {
        return 1;
    }
    if (b === undefined) {
        return -1;
    }
    return b - a;
}
function byId(a, b) {
    if (a.id === b.id) {
        return 0;
    }
    return a.id < b.id ? -1 : 1;
}
function bm25Strength(candidate) {
    return candidate.ftsRank === undefined ? undefined : -candidate.ftsRank;
}
function byRelevance(a, b) {
    return (descendingDefinedFirst(a.cosine, b.cosine) ||
        Number(b.keyHit) - Number(a.keyHit) ||
        descendingDefinedFirst(bm25Strength(a), bm25Strength(b)) ||
        byId(a, b));
}
function selectPromptMemories(candidates, gate, context, alreadyInjected) {
    const thresholds = gate.thresholds[context.language];
    const reference = neighbourhoodReference(context.neighbourhood);
    return candidates
        .filter((candidate) => !alreadyInjected.has(candidate.id) &&
        passesPromptGate(candidate, gate.keyMode, thresholds, reference))
        .sort(byRelevance)
        .slice(0, gate.maxRows);
}
function passesToolGate(candidate, gate) {
    return (gate.kinds.includes(candidate.kind) &&
        (candidate.anchorHit || (gate.keywordSignal && candidate.keyHit)));
}
function byAnchorThenId(a, b) {
    return Number(b.anchorHit) - Number(a.anchorHit) || byId(a, b);
}
function selectToolMemories(candidates, gate, alreadyInjected) {
    return candidates
        .filter((candidate) => !alreadyInjected.has(candidate.id) && passesToolGate(candidate, gate))
        .sort(byAnchorThenId);
}
