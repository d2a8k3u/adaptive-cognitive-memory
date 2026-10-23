# Commands and CLI

From a session, `/memory-doctor`, `/memory-recall on|off` and `/memory-statusline on|off` run the CLI with the plugin data directory filled in. From a shell, set `CLAUDE_PLUGIN_DATA` and run `node dist/cli.js <command>` in the plugin root:

| Command | Effect |
|---|---|
| `doctor` | JSON health report; exit 1 when a check fails |
| `recall on\|off` | recall switch for the project of the working directory |
| `statusline on\|off` | opt-in statusline badge: `on` installs the shim and prints the line for your statusline script, `off` removes the plugin's statusline files and prints the line to remove; neither touches any `settings.json` (see [Statusline badge](statusline.md)) |
| `export <file>` | writes JSONL: a header, then one record per memory (every column needed to restore it — state, counters, timestamps — but no vector), relation and transition; secrets redacted again, personal data kept; refuses an existing file; stamps the export time the doctor reads |
| `import <file>` | validates every line first and rejects the whole file naming each bad line; every memory must pass the same key rules as `memory_store` (conflict key, value, keywords, anchors), except that a legacy empty `conflict_key` (`""`) is kept; then writes in one transaction. A memory id already present is skipped (re-import is a no-op); an active single-valued memory whose slot another active memory holds, or a memory with more than 20 relations, rejects the import naming the line. Imported text is redacted like a stored memory's. Imported rows arrive without vectors: run `reembed` (each server start embeds up to 32 active ones) |
| `model-init` | one-time model download, the only command that touches the network (session start runs it in the background unless `download_model` is off). It downloads into a staging directory beside the model cache and moves the finished model into place, so an interrupted download never leaves a partial model; a lock in the plugin data directory admits one download at a time (exit 1 while another runs; a lock older than 15 minutes is taken over), and a failure is recorded for the doctor. Prints the model's size and path; does nothing when the model is already cached |
| `reembed` | realigns vector states that drifted while sqlite-vec was not loaded, then embeds every memory still missing a vector (the MCP server does both for up to 32 active ones after it connects; a failure there leaves the rows unembedded and shows in the doctor's `unembedded` check) |

## Doctor checks

Every check has `status` `ok`, `warn` or `fail` (`ok: false` only for `fail`), a `detail` and, unless ok, a `fix`. Only `fail` makes the report `degraded` and the exit code 1.

`node`, `native_module` (better-sqlite3 loads under this node; the fix is `npm rebuild better-sqlite3` in the plugin root), `plugin_data`, `database` (schema version, `quick_check`, a newer schema written by a newer plugin), `vec`, `model` (fails while the model is missing, naming the last failed download; warns instead while a download is running, and when the last prompt's query embedding missed its 1.5 s deadline), `unembedded` (active memories without a vector, with the last failed start-up backfill), `vec_state` (vectors whose state drifted from their memory's), `fts`, `calibration` (the model and eval run the gate was fitted with), `project_identity` (warns with the `safe.directory` fix when git refuses the repository for dubious ownership and the project falls back to its directory), `auto_memory` (warns while native auto memory is on), `data_retention` (warns while the database sits in the plugin data directory without an export in the last 30 days).
