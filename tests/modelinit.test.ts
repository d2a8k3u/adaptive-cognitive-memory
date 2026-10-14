import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelCachePath } from "../src/embeddings";
import { acquireDownloadLock, downloadLockPath } from "../src/modeldownload";
import { modelInit } from "../src/modelinit";
import { testModelCacheDir } from "../vitest.config";

const UNREACHABLE_HOST = "http://127.0.0.1:9/";
const originalFetch = env.fetch;
const originalRemoteHost = env.remoteHost;

afterEach(() => {
  env.fetch = originalFetch;
  env.remoteHost = originalRemoteHost;
  env.allowRemoteModels = false;
  vi.restoreAllMocks();
});

function initConfig(modelCacheDir?: string) {
  const pluginData = mkdtempSync(join(tmpdir(), "acm-init-"));
  return {
    pluginData,
    modelCacheDir: modelCacheDir ?? join(pluginData, "models"),
    modelRemoteHost: undefined,
  };
}

function rejectedFetch(message: string) {
  return vi.fn((_url: unknown) => Promise.reject(new Error(message)));
}

describe("modelInit", () => {
  it("fetches a missing model from the configured host and restores local-only mode", async () => {
    const fetchAttempt = rejectedFetch("network unavailable");
    env.fetch = fetchAttempt;

    await expect(modelInit({ ...initConfig(), modelRemoteHost: UNREACHABLE_HOST })).rejects.toThrow(
      /network unavailable/,
    );
    expect(String(fetchAttempt.mock.calls[0]?.[0])).toMatch(new RegExp(`^${UNREACHABLE_HOST}`));
    expect(env.allowRemoteModels).toBe(false);
  });

  it("reports the cached model without network access and exits 0", async () => {
    const fetchAttempt = rejectedFetch("network fetch attempted");
    env.fetch = fetchAttempt;
    const print = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await modelInit(initConfig(testModelCacheDir));

    expect(code).toBe(0);
    expect(fetchAttempt).not.toHaveBeenCalled();
    const lines = print.mock.calls.map((args) => args.join(" "));
    const expectedPath = modelCachePath(testModelCacheDir);
    expect(lines.some((line) => line.includes(expectedPath) && /\d+ bytes/.test(line))).toBe(true);
  });

  it("exits 1 naming the lock while another run downloads the model", async () => {
    const fetchAttempt = rejectedFetch("network fetch attempted");
    env.fetch = fetchAttempt;
    const errorPrint = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = initConfig();
    acquireDownloadLock(config.pluginData, new Date());

    const code = await modelInit(config);

    expect(code).toBe(1);
    expect(fetchAttempt).not.toHaveBeenCalled();
    expect(errorPrint.mock.calls.flat().join(" ")).toContain(downloadLockPath(config.pluginData));
  });
});
