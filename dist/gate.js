"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RELEVANCE_FEATURES = exports.NEIGHBOURHOOD_SIZE = void 0;
exports.nearestMean = nearestMean;
exports.relevanceFeatures = relevanceFeatures;
exports.relevanceScore = relevanceScore;
exports.selectPromptMemories = selectPromptMemories;
exports.passesToolGate = passesToolGate;
exports.selectToolMemories = selectToolMemories;
exports.NEIGHBOURHOOD_SIZE = 10;
exports.RELEVANCE_FEATURES = [
    "cosine",
    "gapToTop",
    "gapToNeighbourhood",
    "lexical",
    "top",
    "keyHit",
];
function descending(a, b) {
    return b - a;
}
function nearestMean(cosines, neighbourhoodPrior) {
    const nearest = [...cosines].sort(descending).slice(0, exports.NEIGHBOURHOOD_SIZE);
    const missing = exports.NEIGHBOURHOOD_SIZE - nearest.length;
    return ((nearest.reduce((sum, cosine) => sum + cosine, 0) + missing * neighbourhoodPrior) /
        exports.NEIGHBOURHOOD_SIZE);
}
function bm25Strength(ftsRank) {
    return ftsRank === undefined ? 0 : Math.max(0, -ftsRank);
}
function relevanceFeatures(candidate, context, neighbourhoodPrior) {
    const { cosine } = candidate;
    if (cosine === undefined) {
        return undefined;
    }
    const top = Math.max(cosine, ...context.neighbourhood);
    return {
        cosine,
        gapToTop: cosine - top,
        gapToNeighbourhood: cosine - nearestMean(context.neighbourhood, neighbourhoodPrior),
        lexical: Math.log1p(bm25Strength(candidate.ftsRank)),
        top: cosine === top ? 1 : 0,
        keyHit: candidate.keyHit ? 1 : 0,
    };
}
function relevanceScore(features, gate) {
    return exports.RELEVANCE_FEATURES.reduce((score, feature) => score + gate.weights[feature] * features[feature], gate.bias);
}
function requiresKeyHit(memory) {
    return memory.kind === "belief" || memory.epistemic === "unverified";
}
function byId(a, b) {
    if (a.id === b.id) {
        return 0;
    }
    return a.id < b.id ? -1 : 1;
}
function scored(candidate, gate, context) {
    if (requiresKeyHit(candidate) && !candidate.keyHit) {
        return [];
    }
    const features = relevanceFeatures(candidate, context, gate.neighbourhoodPrior);
    if (features === undefined) {
        return [];
    }
    const score = relevanceScore(features, gate);
    return score >= gate.threshold ? [{ candidate, score }] : [];
}
function selectPromptMemories(candidates, gate, context, alreadyInjected) {
    return candidates
        .filter((candidate) => !alreadyInjected.has(candidate.id))
        .flatMap((candidate) => scored(candidate, gate, context))
        .sort((a, b) => b.score - a.score || byId(a.candidate, b.candidate))
        .slice(0, gate.maxRows)
        .map(({ candidate }) => candidate);
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
