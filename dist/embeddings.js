"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeadlineExceededError = exports.MODEL_FILES = void 0;
exports.modelCachePath = modelCachePath;
exports.modelCached = modelCached;
exports.passageInput = passageInput;
exports.queryInput = queryInput;
exports.embedPassage = embedPassage;
exports.embedQuery = embedQuery;
exports.withDeadline = withDeadline;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const cfg_1 = require("./cfg");
const PASSAGE_PREFIX = "passage: ";
const QUERY_PREFIX = "query: ";
const ONNX_FILE_BY_DTYPE = {
    q8: "onnx/model_quantized.onnx",
};
exports.MODEL_FILES = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    ONNX_FILE_BY_DTYPE[cfg_1.MODEL_DTYPE],
];
function modelCachePath(modelCacheDir) {
    return (0, node_path_1.join)(modelCacheDir, ...cfg_1.MODEL_ID.split("/"));
}
function modelCached(modelCacheDir) {
    const modelPath = modelCachePath(modelCacheDir);
    return exports.MODEL_FILES.every((file) => (0, node_fs_1.existsSync)((0, node_path_1.join)(modelPath, file)));
}
const models = new Map();
async function loadModel(modelCacheDir) {
    const existing = models.get(modelCacheDir);
    if (existing) {
        return existing;
    }
    if (!modelCached(modelCacheDir)) {
        throw new Error(`embedding model not cached at ${modelCachePath(modelCacheDir)} — run model-init`);
    }
    const loading = (async () => {
        const { env, pipeline } = await import("@huggingface/transformers");
        env.allowRemoteModels = false;
        env.cacheDir = modelCacheDir;
        return pipeline("feature-extraction", cfg_1.MODEL_ID, { dtype: cfg_1.MODEL_DTYPE });
    })();
    models.set(modelCacheDir, loading);
    void loading.catch(() => models.delete(modelCacheDir));
    return loading;
}
async function embed(texts, modelCacheDir) {
    if (texts.length === 0) {
        throw new Error("embed requires at least one text");
    }
    const extractor = await loadModel(modelCacheDir);
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    const batchSize = output.dims[0] ?? 0;
    const dim = output.dims[1];
    if (dim !== cfg_1.EMBED_DIM || batchSize !== texts.length) {
        throw new Error(`unexpected embedding output shape ${output.dims.join("x")}`);
    }
    const data = output.data;
    return texts.map((_, row) => data.slice(row * dim, (row + 1) * dim));
}
function passageInput(text) {
    return `${PASSAGE_PREFIX}${text}`;
}
function queryInput(text) {
    return `${QUERY_PREFIX}${text}`;
}
function embedPassage(texts, modelCacheDir) {
    return embed(texts.map(passageInput), modelCacheDir);
}
async function embedQuery(text, modelCacheDir) {
    const vectors = await embed([queryInput(text)], modelCacheDir);
    const vector = vectors.at(0);
    if (vector === undefined) {
        throw new Error(`embedding query produced ${vectors.length} vectors, expected 1`);
    }
    return vector;
}
class DeadlineExceededError extends Error {
}
exports.DeadlineExceededError = DeadlineExceededError;
async function withDeadline(promise, deadlineMs) {
    void promise.catch(() => { });
    let timer;
    const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceededError(`deadline of ${deadlineMs} ms exceeded`)), deadlineMs);
    });
    try {
        return await Promise.race([promise, expired]);
    }
    finally {
        clearTimeout(timer);
    }
}
