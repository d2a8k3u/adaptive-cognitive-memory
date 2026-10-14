"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordEmbeddingTimeout = recordEmbeddingTimeout;
exports.clearEmbeddingTimeout = clearEmbeddingTimeout;
exports.lastEmbeddingTimeout = lastEmbeddingTimeout;
exports.recordBackfillFailure = recordBackfillFailure;
exports.clearBackfillFailure = clearBackfillFailure;
exports.lastBackfillFailure = lastBackfillFailure;
const database_1 = require("./database");
const BACKFILL_FAILURE_KEY = "last_backfill_failure";
const EMBEDDING_TIMEOUT_KEY = "last_embedding_timeout_at";
function recordEmbeddingTimeout(db, at) {
    (0, database_1.setMetaValue)(db, EMBEDDING_TIMEOUT_KEY, at);
}
function clearEmbeddingTimeout(db) {
    (0, database_1.clearMetaValue)(db, EMBEDDING_TIMEOUT_KEY);
}
function lastEmbeddingTimeout(db) {
    return (0, database_1.metaValue)(db, EMBEDDING_TIMEOUT_KEY);
}
function recordBackfillFailure(db, at, message) {
    (0, database_1.setMetaValue)(db, BACKFILL_FAILURE_KEY, `at ${at}: ${message}`);
}
function clearBackfillFailure(db) {
    (0, database_1.clearMetaValue)(db, BACKFILL_FAILURE_KEY);
}
function lastBackfillFailure(db) {
    return (0, database_1.metaValue)(db, BACKFILL_FAILURE_KEY);
}
