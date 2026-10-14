import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelCachePath } from "../src/embeddings";
import { modelInit } from "../src/modelinit";
import { testModelCacheDir } from "../vitest.config";

const originalFetch = env.fetch;

afterEach(() => {
  env.fetch = originalFetch;
  env.allowRemoteModels = false;
  vi.restoreAllMocks();
});

describe("modelInit", () => {
  it("attempts a remote fetch when the model is missing and restores local-only mode", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "acm-init-"));
    const fetchAttempt = vi.fn(() => Promise.reject(new Error("network unavailable")));
    env.fetch = fetchAttempt;

    await expect(modelInit(emptyDir)).rejects.toThrow(/network unavailable/);
    expect(fetchAttempt.mock.calls.length).toBeGreaterThan(0);
    expect(env.allowRemoteModels).toBe(false);
  });

  it("initializes from the local cache without network access and prints bytes and the path", async () => {
    const fetchAttempt = vi.fn(() => Promise.reject(new Error("network fetch attempted")));
    env.fetch = fetchAttempt;
    const print = vi.spyOn(console, "log").mockImplementation(() => {});

    await modelInit(testModelCacheDir);

    expect(fetchAttempt).not.toHaveBeenCalled();
    expect(env.allowRemoteModels).toBe(false);
    const lines = print.mock.calls.map((args) => args.join(" "));
    const expectedPath = modelCachePath(testModelCacheDir);
    expect(lines.some((line) => line.includes(expectedPath) && /\d+ bytes/.test(line))).toBe(true);
  });
});
