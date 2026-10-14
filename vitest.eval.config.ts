import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

const EVAL_TIMEOUT_MS = 3_600_000;

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["tests/eval/**/*.eval.ts"],
      testTimeout: EVAL_TIMEOUT_MS,
      hookTimeout: EVAL_TIMEOUT_MS,
    },
  }),
);
