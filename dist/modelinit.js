"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.modelInit = modelInit;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const cfg_1 = require("./cfg");
const embeddings_1 = require("./embeddings");
const modeldownload_1 = require("./modeldownload");
function directoryBytes(dir) {
    return (0, node_fs_1.readdirSync)(dir, { withFileTypes: true }).reduce((total, entry) => {
        const path = (0, node_path_1.join)(dir, entry.name);
        return entry.isDirectory() ? total + directoryBytes(path) : total + (0, node_fs_1.statSync)(path).size;
    }, 0);
}
function transformersFetcher(remoteHost) {
    return async (cacheDir) => {
        const { env, pipeline } = await import("@huggingface/transformers");
        env.cacheDir = cacheDir;
        if (remoteHost !== undefined) {
            env.remoteHost = remoteHost;
        }
        env.allowRemoteModels = true;
        try {
            await pipeline("feature-extraction", cfg_1.MODEL_ID, { dtype: cfg_1.MODEL_DTYPE });
        }
        finally {
            env.allowRemoteModels = false;
        }
    };
}
async function modelInit(config) {
    const outcome = await (0, modeldownload_1.downloadModel)(config, transformersFetcher(config.modelRemoteHost), () => new Date());
    if (outcome === "busy") {
        console.error(`another model-init is already downloading the embedding model (lock ${(0, modeldownload_1.downloadLockPath)(config.dataDir)}); wait for it to finish`);
        return 1;
    }
    const modelPath = (0, embeddings_1.modelCachePath)(config.modelCacheDir);
    console.log(`${directoryBytes(modelPath)} bytes at ${modelPath}`);
    return 0;
}
