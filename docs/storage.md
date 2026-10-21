# Storage

One SQLite database (WAL, `busy_timeout` 5000 ms, short immediate transactions) holds:

- `memories` — ulid id, type, kind, scope, `project_id`, title, abstract, content, slot, state, counters, derived importance ((1 + used) / (2 + used + failures) with failures = 2 × wrong + receipted injections without use), validity timestamps. `project_id` is the first 16 hex chars of the sha256 of the project's git common dir, so every subdirectory and worktree of one repository shares it; outside git it hashes the directory's real path.
- `relations` (explicit, capped at 20 per source), `memories_vec` (sqlite-vec, float[384] cosine, with a `state` column so KNN filters to active rows), `memories_fts` (FTS5 over title, abstract, conflict key, keywords and value).
- `transitions` — every supersession, promotion, demotion and reactivation with its evidence.
- `injections`, `receipt_sessions`, `recall_events` — what each session was shown, which sessions gave receipts, and one row per recall hook run with the number of rows it injected (kept to the newest 10,000 at each session start).
- `session_signals`, `command_failures` — capture moments; `failure_recalls` — the session and command heads whose failure already injected; closed signals, command failures and failure recalls older than 30 days are dropped at session start.
- `project_settings` — the per-project recall switch.

Concurrent sessions are safe: an externally locked database surfaces an explicit `database locked` error, never a partial write. The embedding model identity and dimension are guarded at open. Every open stamps the plugin version that wrote the database; a database whose schema is newer than the running plugin supports is refused with both versions named and "update the plugin".
