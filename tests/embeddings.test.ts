import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { describe, expect, it, vi } from "vitest";
import { EMBED_DIM } from "../src/cfg";
import {
  embedPassage,
  embedQuery,
  modelCached,
  modelCachePath,
  withDeadline,
} from "../src/embeddings";
import { testModelCacheDir } from "../vitest.config";

function l2norm(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

const originalFetch = env.fetch;

describe("embeddings", () => {
  it("refuses to embed when the model is not cached, naming the model path", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "acm-embed-"));
    expect(modelCached(emptyDir)).toBe(false);
    expect(modelCached(testModelCacheDir)).toBe(true);

    const modelPath = modelCachePath(emptyDir);
    const passageFailure = await embedPassage(["local inference only"], emptyDir).then(
      () => undefined,
      (error: Error) => error,
    );
    expect(passageFailure?.message).toContain("not cached");
    expect(passageFailure?.message).toContain(modelPath);

    await expect(embedQuery("local inference only", emptyDir)).rejects.toThrow(/not cached/);
  });

  it("embeds offline from the local cache with the e5 prefix contract", async () => {
    const fetchAttempt = vi.fn(() => Promise.reject(new Error("network fetch attempted")));
    env.fetch = fetchAttempt;
    try {
      const queryVector = await embedQuery("how to rotate logging credentials", testModelCacheDir);
      const [passageVector] = await embedPassage(
        ["how to rotate logging credentials"],
        testModelCacheDir,
      );
      expect(queryVector).toHaveLength(EMBED_DIM);
      expect(passageVector).toHaveLength(EMBED_DIM);
      expect(l2norm(queryVector)).toBeCloseTo(1, 5);
      expect(cosine(queryVector, passageVector!)).toBeLessThan(0.99);

      const repeatQuery = await embedQuery("how to rotate logging credentials", testModelCacheDir);
      expect(repeatQuery).toEqual(queryVector);
    } finally {
      env.fetch = originalFetch;
    }
    expect(fetchAttempt).not.toHaveBeenCalled();
    expect(env.allowRemoteModels).toBe(false);
  });

  it("embeds a passage batch with one normalized vector per text in input order", async () => {
    const [alpha, beta] = await embedPassage(
      ["alpha passage text", "beta passage text"],
      testModelCacheDir,
    );
    const [singleAlpha] = await embedPassage(["alpha passage text"], testModelCacheDir);
    const [singleBeta] = await embedPassage(["beta passage text"], testModelCacheDir);
    expect(alpha).toHaveLength(EMBED_DIM);
    expect(beta).toHaveLength(EMBED_DIM);
    expect(l2norm(alpha!)).toBeCloseTo(1, 5);
    expect(cosine(alpha!, singleAlpha!)).toBeGreaterThan(cosine(alpha!, singleBeta!));
    expect(cosine(beta!, singleBeta!)).toBeGreaterThan(cosine(beta!, singleAlpha!));
  });
});

describe("withDeadline", () => {
  it("returns the value when the operation finishes before its deadline", async () => {
    await expect(withDeadline(Promise.resolve(7), 100_000)).resolves.toBe(7);
  });

  it("rejects with the deadline when the operation exceeds it", async () => {
    vi.useFakeTimers();
    try {
      const pending = withDeadline(new Promise<number>(() => {}), 100);
      const expectation = expect(pending).rejects.toThrow(/deadline of 100 ms exceeded/);
      await vi.advanceTimersByTimeAsync(101);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces the deadline, not the late failure of the abandoned operation", async () => {
    vi.useFakeTimers();
    try {
      let abandon: (reason: Error) => void = () => {};
      const slow = new Promise<number>((_, reject) => {
        abandon = reject;
      });
      const pending = withDeadline(slow, 10);
      const expectation = expect(pending).rejects.toThrow(/deadline/);
      await vi.advanceTimersByTimeAsync(11);
      abandon(new Error("late failure"));
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
