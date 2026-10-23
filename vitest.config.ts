import { join } from "node:path";
import { defineConfig } from "vitest/config";

export const testModelCacheDir = join(
  process.cwd(),
  "node_modules",
  ".cache",
  "adaptive-cognitive-memory",
  "models",
);

export const testEmbedDeadlineMs = 20_000;

export const testModelEnv = {
  ACM_MODEL_CACHE_DIR: testModelCacheDir,
  ACM_EMBED_DEADLINE_MS: String(testEmbedDeadlineMs),
};

export default defineConfig({
  test: {
    env: {
      ACM_MODEL_CACHE_DIR: testModelCacheDir,
    },
    globalSetup: ["./tests/global-setup.ts"],
  },
});
