import { join } from "node:path";
import { defineConfig } from "vitest/config";

const testCacheRoot = join(process.cwd(), "node_modules", ".cache", "adaptive-cognitive-memory");

export const testModelCacheDir = join(testCacheRoot, "models");

const testDataDir = join(testCacheRoot, "test-data");

export const testEmbedDeadlineMs = 20_000;

export const testModelEnv = {
  ACM_MODEL_CACHE_DIR: testModelCacheDir,
  ACM_EMBED_DEADLINE_MS: String(testEmbedDeadlineMs),
};

export default defineConfig({
  test: {
    env: {
      ACM_MODEL_CACHE_DIR: testModelCacheDir,
      ACM_DATA_DIR: testDataDir,
    },
    globalSetup: ["./tests/global-setup.ts"],
  },
});
