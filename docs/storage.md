# Storage

One SQLite database (WAL, `busy_timeout` 5000 ms, short immediate transactions) holds:

- `memories`: ulid id, type, kind, scope, `project_id`, title, abstract, content, slot, state, counters, derived importance ((1 + used) / (2 + used + failures) with failures = 2 × wrong + receipted injections without use), the start of its current trial (when it last became active), validity timestamps. `project_id` is the first 16 hex chars of the sha256 of the project's git common dir, so every subdirectory and worktree of one repository shares it; outside git it hashes the directory's real path.
- `relations` (explicit, capped at 20 per source), `memories_vec` (sqlite-vec, float[384] cosine over title, content and keywords, with a `state` column so KNN filters to active rows), `questions_vec` (one vector per recall question, with the memory's scope, project and state so KNN filters inside the query), `memories_fts` (FTS5 over title, abstract, conflict key, keywords and value).
- `transitions`: every supersession, promotion, demotion and reactivation with its evidence.
- `verdicts`: every explicit `used`, `not_applicable` or `wrong` verdict with its session and time, the evidence the lifecycle decides on.
- `injections`, `receipt_sessions`, `recall_events`: what each session was shown, which sessions gave receipts, and one row per recall hook run with the number of rows it injected (kept to the newest 10,000 at each session start).
- `session_signals`, `command_failures`: capture moments. `failure_recalls`: the session and command heads whose failure already injected. Session start drops closed signals, command failures and failure recalls older than 30 days.
- `project_settings`: the per-project recall switch.

Concurrent sessions are safe: an externally locked database surfaces an explicit `database locked` error, never a partial write. The database records the embedding model's identity and dimension. Opening a database embedded by another model or dimension drops its vectors, keeps every memory and records the live model; the next memory server start (or `reembed`) embeds them again. Every open stamps the plugin version that wrote the database. A database whose schema is newer than the running plugin supports is refused with both versions named and "update the plugin".

## Layout

All three hosts read and write one store in the shared data directory: `ACM_DATA_DIR`, by default `$HOME/.local/share/adaptive-cognitive-memory` (see [Configuration](configuration.md#environment-variables)). It holds:

- `memory.sqlite` with its `-wal` and `-shm` files, the database described above;
- `models/`, the cached embedding model;
- `statusline/`, the Claude Code badge files, only while the badge is on (see [Statusline badge](statusline.md));
- `.moving/`, staging for a [store move](#move-the-claude-code-store), on the same filesystem as the final path.

The directory is created with owner-only permissions. Nothing in it is host-specific, so a memory stored from one host is recalled on the others.

## Move the Claude Code store

A Claude Code install made before the shared directory existed keeps its store in its plugin data directory. Claude Code reads and writes that legacy store until you move it: nothing is created in the shared directory beforehand, and each session start, the MCP server's instructions, `memory_status` and the doctor's `plugin_data` check show a notice with the move command. Codex and OpenCode use the shared directory from the start, so they do not see the legacy memories before the move.

The move never runs by itself. Before you run it, install this plugin version and quit every Claude Code session, then run it from a terminal. If you also want Codex, move before you install on Codex; otherwise Codex creates a fresh store and the move refuses (see [An existing store in the shared directory](#an-existing-store-in-the-shared-directory)).

```bash
ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" store move --from "$HOME/.claude/plugins/data/adaptive-cognitive-memory-adaptive-cognitive-memory"
```

The command copies the database into a staging directory under `.moving/`, verifies the copy, publishes it into the shared directory and only then marks the legacy directory. It never writes the legacy store: the only file it adds there is `moved.json` (`{"version":1,"movedTo":…,"movedAt":…,"digest":…}`). The exit lines are listed in [Commands and CLI](cli.md#store-move). If the Claude Code statusline badge is on, the success output also prints the `statusLine` command to set for the new path. Restart Claude Code afterwards; Claude Code, Codex and OpenCode then share the store.

The move holds the legacy database's write lock from the copy to the marker, then releases it without writing. It does not fence tool calls that are in flight or start during that hold, a vector backfill, or sessions of an older plugin version; that is why every Claude Code session must be quit first. Operations that start after `moved.json` exists use the shared store.

After the move the legacy directory stays exactly as it was, plus `moved.json`; you may delete it. Uninstalling the plugin does not touch the moved store, because the shared directory is outside the plugin data directory.

### An existing store in the shared directory

When the shared directory already holds a store, the move refuses and leaves the source unchanged. Move the shared directory aside, run the move again, then rename the aside directory back or delete it:

```bash
mv "$HOME/.local/share/adaptive-cognitive-memory" "$HOME/.local/share/adaptive-cognitive-memory.aside"
```

To bring the memories of the aside store into the moved one, export them from the aside store and import them after the move:

```bash
ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory.aside" node "<root>/dist/cli.js" export "$HOME/acm-aside.jsonl"
```

```bash
ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" import "$HOME/acm-aside.jsonl"
```

`export` carries only memories, relations and transitions; the aside store's verdicts, injections, session tables and recall switches stay behind. Run `reembed` afterwards, because imported rows arrive without vectors.

To resume an interrupted move, run the same command again. When `moved.json` points to a directory other than the one `ACM_DATA_DIR` resolves to, Claude Code uses the moved store and its notice names the directory to set `ACM_DATA_DIR` to.

### Roll back the move

The move leaves the legacy store untouched, so a rollback loses nothing. Quit every Claude Code session first, then do one of:

- Keep the pre-move state: delete `moved.json` from the legacy directory. Claude Code then uses the legacy store as it was at the move.
- Keep what was written after the move: with every session on every host quit (so the shared database is checkpointed), remove the legacy `memory.sqlite-wal` and `memory.sqlite-shm`, copy the shared `memory.sqlite` over the legacy `memory.sqlite`, and delete `moved.json`. Or point the older plugin at the shared database with `ACM_DB_PATH=<shared dir>/memory.sqlite`; plugin 0.3.0 honours it and the schema version is unchanged.

Export and import is not a lossless rollback, because export leaves verdicts, injections, session tables and recall switches behind.
