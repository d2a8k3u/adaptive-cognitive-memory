"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.modelInit = modelInit;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const cfg_1 = require("./cfg");
const embeddings_1 = require("./embeddings");
function directoryBytes(dir) {
    return (0, node_fs_1.readdirSync)(dir, { withFileTypes: true }).reduce((total, entry) => {
        const path = (0, node_path_1.join)(dir, entry.name);
        return entry.isDirectory() ? total + directoryBytes(path) : total + (0, node_fs_1.statSync)(path).size;
    }, 0);
}
async function modelInit(modelCacheDir) {
    const { env, pipeline } = await import("@huggingface/transformers");
    env.cacheDir = modelCacheDir;
    env.allowRemoteModels = true;
    try {
        await pipeline("feature-extraction", cfg_1.MODEL_ID, { dtype: cfg_1.MODEL_DTYPE });
    }
    finally {
        env.allowRemoteModels = false;
    }
    const modelPath = (0, embeddings_1.modelCachePath)(modelCacheDir);
    console.log(`${directoryBytes(modelPath)} bytes at ${modelPath}`);
}
