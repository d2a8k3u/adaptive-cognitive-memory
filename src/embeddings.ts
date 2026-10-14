import { existsSync } from "node:fs";
import { join } from "node:path";
import { EMBED_DIM, MODEL_DTYPE, MODEL_ID } from "./cfg";

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array | number[] }>;

const PASSAGE_PREFIX = "passage: ";
const QUERY_PREFIX = "query: ";

const ONNX_FILE_BY_DTYPE: Record<typeof MODEL_DTYPE, string> = {
  q8: "onnx/model_quantized.onnx",
};

const MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  ONNX_FILE_BY_DTYPE[MODEL_DTYPE],
];

export function modelCachePath(modelCacheDir: string): string {
  return join(modelCacheDir, ...MODEL_ID.split("/"));
}

export function modelCached(modelCacheDir: string): boolean {
  const modelPath = modelCachePath(modelCacheDir);
  return MODEL_FILES.every((file) => existsSync(join(modelPath, file)));
}

const models = new Map<string, Promise<FeatureExtractionPipeline>>();

async function loadModel(modelCacheDir: string): Promise<FeatureExtractionPipeline> {
  const existing = models.get(modelCacheDir);
  if (existing) {
    return existing;
  }
  if (!modelCached(modelCacheDir)) {
    throw new Error(
      `embedding model not cached at ${modelCachePath(modelCacheDir)} — run model-init`,
    );
  }
  const loading = (async () => {
    const { env, pipeline } = await import("@huggingface/transformers");
    env.allowRemoteModels = false;
    env.cacheDir = modelCacheDir;
    return pipeline("feature-extraction", MODEL_ID, { dtype: MODEL_DTYPE });
  })();
  models.set(modelCacheDir, loading);
  void loading.catch(() => models.delete(modelCacheDir));
  return loading;
}

async function embed(texts: string[], modelCacheDir: string): Promise<Float32Array[]> {
  if (texts.length === 0) {
    throw new Error("embed requires at least one text");
  }
  const extractor = await loadModel(modelCacheDir);
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const batchSize = output.dims[0] ?? 0;
  const dim = output.dims[1];
  if (dim !== EMBED_DIM || batchSize !== texts.length) {
    throw new Error(`unexpected embedding output shape ${output.dims.join("x")}`);
  }
  const data = output.data as Float32Array;
  return texts.map((_, row) => data.slice(row * dim, (row + 1) * dim));
}

export function passageInput(text: string): string {
  return `${PASSAGE_PREFIX}${text}`;
}

export function queryInput(text: string): string {
  return `${QUERY_PREFIX}${text}`;
}

export function embedPassage(texts: string[], modelCacheDir: string): Promise<Float32Array[]> {
  return embed(texts.map(passageInput), modelCacheDir);
}

export async function embedQuery(text: string, modelCacheDir: string): Promise<Float32Array> {
  const vectors = await embed([queryInput(text)], modelCacheDir);
  const vector = vectors.at(0);
  if (vector === undefined) {
    throw new Error(`embedding query produced ${vectors.length} vectors, expected 1`);
  }
  return vector;
}

export class DeadlineExceededError extends Error {}

export async function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  void promise.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DeadlineExceededError(`deadline of ${deadlineMs} ms exceeded`)),
      deadlineMs,
    );
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}
