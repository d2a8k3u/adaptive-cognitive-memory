import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Config, MODEL_DTYPE, MODEL_ID } from "./cfg";
import { modelCachePath } from "./embeddings";
import { downloadLockPath, downloadModel, type ModelFetcher } from "./modeldownload";

type ModelInitConfig = Pick<Config, "dataDir" | "modelCacheDir" | "modelRemoteHost">;

function directoryBytes(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? total + directoryBytes(path) : total + statSync(path).size;
  }, 0);
}

function transformersFetcher(remoteHost: string | undefined): ModelFetcher {
  return async (cacheDir) => {
    const { env, pipeline } = await import("@huggingface/transformers");
    env.cacheDir = cacheDir;
    if (remoteHost !== undefined) {
      env.remoteHost = remoteHost;
    }
    env.allowRemoteModels = true;
    try {
      await pipeline("feature-extraction", MODEL_ID, { dtype: MODEL_DTYPE });
    } finally {
      env.allowRemoteModels = false;
    }
  };
}

export async function modelInit(config: ModelInitConfig): Promise<number> {
  const outcome = await downloadModel(
    config,
    transformersFetcher(config.modelRemoteHost),
    () => new Date(),
  );
  if (outcome === "busy") {
    console.error(
      `another model-init is already downloading the embedding model (lock ${downloadLockPath(config.dataDir)}); wait for it to finish`,
    );
    return 1;
  }
  const modelPath = modelCachePath(config.modelCacheDir);
  console.log(`${directoryBytes(modelPath)} bytes at ${modelPath}`);
  return 0;
}
