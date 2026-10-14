import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MODEL_DTYPE, MODEL_ID } from "./cfg";
import { modelCachePath } from "./embeddings";

function directoryBytes(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? total + directoryBytes(path) : total + statSync(path).size;
  }, 0);
}

export async function modelInit(modelCacheDir: string): Promise<void> {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = modelCacheDir;
  env.allowRemoteModels = true;
  try {
    await pipeline("feature-extraction", MODEL_ID, { dtype: MODEL_DTYPE });
  } finally {
    env.allowRemoteModels = false;
  }
  const modelPath = modelCachePath(modelCacheDir);
  console.log(`${directoryBytes(modelPath)} bytes at ${modelPath}`);
}
