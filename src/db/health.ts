import { clearMetaValue, type Db, metaValue, setMetaValue } from "./database";

const BACKFILL_FAILURE_KEY = "last_backfill_failure";
const EMBEDDING_TIMEOUT_KEY = "last_embedding_timeout_at";

export function recordEmbeddingTimeout(db: Db, at: string): void {
  setMetaValue(db, EMBEDDING_TIMEOUT_KEY, at);
}

export function clearEmbeddingTimeout(db: Db): void {
  clearMetaValue(db, EMBEDDING_TIMEOUT_KEY);
}

export function lastEmbeddingTimeout(db: Db): string | undefined {
  return metaValue(db, EMBEDDING_TIMEOUT_KEY);
}

export function recordBackfillFailure(db: Db, at: string, message: string): void {
  setMetaValue(db, BACKFILL_FAILURE_KEY, `at ${at}: ${message}`);
}

export function clearBackfillFailure(db: Db): void {
  clearMetaValue(db, BACKFILL_FAILURE_KEY);
}

export function lastBackfillFailure(db: Db): string | undefined {
  return metaValue(db, BACKFILL_FAILURE_KEY);
}
