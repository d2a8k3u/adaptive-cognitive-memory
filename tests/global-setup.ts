import { MODEL_DTYPE, MODEL_ID } from "../src/cfg";
import { testModelCacheDir } from "../vitest.config";

export async function setup(): Promise<void> {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = testModelCacheDir;
  env.allowRemoteModels = true;
  await pipeline("feature-extraction", MODEL_ID, { dtype: MODEL_DTYPE });
}
