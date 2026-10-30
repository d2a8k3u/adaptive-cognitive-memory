# Commands and CLI

Every host runs the same CLI, `node <root>/dist/cli.js <command>`. `<root>` is the plugin root: the checkout, or on Codex the plugin cache directory of the installed version (see [Install](install.md#codex)). Claude Code also wraps three of the commands as slash commands; on Codex and OpenCode, run the lines below from a shell.

Every line sets `ACM_DATA_DIR`, the shared store: `$HOME/.local/share/adaptive-cognitive-memory` unless you chose another (see [Configuration](configuration.md#environment-variables)). `recall` works on the project of the working directory, so run it from inside that project.

| Command | Effect |
|---|---|
| `doctor` | JSON health report; exit 1 when a check fails |
| `recall on\|off` | recall switch for the project of the working directory |
| `statusline on\|off` | Claude Code only. Opt-in statusline badge: `on` installs the shim and prints the line for your statusline script, `off` removes the plugin's statusline files and prints the line to remove; neither touches any `settings.json` (see [Statusline badge](statusline.md)) |
| `store move --from <dir>` | moves the Claude Code store into the shared data directory (see [Store move](#store-move) and [Storage](storage.md#move-the-claude-code-store)) |
| `export <file>` | writes JSONL: a header, then one record per memory, relation and transition. A memory record holds every column needed to restore it, state, counters and timestamps included, but no vector. Secrets are redacted again, personal data is kept. Refuses an existing file; stamps the export time the doctor reads |
| `import <file>` | validates every line first and rejects the whole file naming each bad line; every memory must pass the same key rules as `memory_store` (conflict key, value, keywords, anchors), except that a legacy empty `conflict_key` (`""`) is kept; then writes in one transaction. A memory id already present is skipped (re-import is a no-op); an active single-valued memory whose slot another active memory holds, or a memory with more than 20 relations, rejects the import naming the line. Imported text is redacted like a stored memory's. Imported rows arrive without vectors: run `reembed` (each server start embeds up to 32 active ones) |
| `model-init` | one-time model download, the only command that touches the network (session start runs it in the background unless `download_model` is off). It downloads into a staging directory beside the model cache and moves the finished model into place, so an interrupted download never leaves a partial model; a lock in the data directory admits one download at a time (exit 1 while another runs; a lock older than 15 minutes is taken over), and a failure is recorded for the doctor. Prints the model's size and path; does nothing when the model is already cached |
| `reembed` | realigns vector states that drifted while sqlite-vec was not loaded, then embeds every memory still missing a vector (the MCP server does both for up to 32 active ones after it connects; a failure there leaves the rows unembedded and shows in the doctor's `unembedded` check) |

## Claude Code

In a session, `/memory-doctor`, `/memory-recall on|off` and `/memory-statusline on|off` run the CLI with the plugin data directory filled in. From a shell, once the store has been moved:

```sh
ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" doctor
```

```sh
ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" recall on
```

```sh
ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" recall off
```

The statusline commands exist on Claude Code only:

```sh
ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" statusline on
```

```sh
ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" statusline off
```

Before the move, Claude Code still uses its plugin data directory; point the CLI at it with `CLAUDE_PLUGIN_DATA`:

```bash
CLAUDE_PLUGIN_DATA="<plugin data dir>" node "<root>/dist/cli.js" doctor
```

## Codex

```sh
ACM_HOST=codex ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" doctor
```

```sh
ACM_HOST=codex ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" recall on
```

```sh
ACM_HOST=codex ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" recall off
```

There is no statusline badge on Codex.

## OpenCode

```sh
ACM_HOST=opencode ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" doctor
```

```sh
ACM_HOST=opencode ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" recall on
```

```sh
ACM_HOST=opencode ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" recall off
```

There is no statusline badge on OpenCode.

## Store move

Run it from a terminal with every Claude Code session quit and this plugin version installed. The full procedure and the remedies are in [Storage](storage.md#move-the-claude-code-store):

```bash
ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" store move --from "$HOME/.claude/plugins/data/adaptive-cognitive-memory-adaptive-cognitive-memory"
```

| Exit | Line |
|---|---|
| 0 | `moved the memory store from <from> to <dataDir>: <n> tables, <rows> rows verified`; when `<from>/statusline/enabled.json` exists, also `statusline: set the Claude Code statusLine command to: <snippet>` |
| 0 | `the memory store was already moved from <from> to <movedTo>` |
| 1 | `move refused: <reason>; the source store is unchanged`, on stderr |
| 1 | `move failed: <reason>; the source store is unchanged and <dataDir> was not used`, on stderr |
| 2 | the usage line, on stderr, for a missing or relative `--from` |

## Doctor checks

Every check has `status` `ok`, `warn` or `fail` (`ok: false` only for `fail`), a `detail` and, unless ok, a `fix`. Only `fail` makes the report `degraded` and the exit code 1.

| Check | What it reports |
|---|---|
| `node` | the Node.js version and path; fails below 22 |
| `native_module` | whether better-sqlite3 loads under this node; the fix is `npm rebuild better-sqlite3` in the plugin root |
| `plugin_data` | whether the data directory is writable; warns with the move command while the Claude Code store is not moved |
| `database` | schema version, `quick_check`, a newer schema written by a newer plugin |
| `vec` | whether the sqlite-vec extension loaded |
| `model` | fails while the model is missing, naming the last failed download; warns instead while a download is running, and when the last prompt's query embedding missed its 1.5 s deadline |
| `unembedded` | active memories without a vector, with the last failed start-up backfill |
| `vec_state` | vectors whose state drifted from their memory's |
| `fts` | whether an FTS5 query on the keyword index runs |
| `calibration` | the model and eval run the gate was fitted with |
| `project_identity` | warns with the `safe.directory` fix when git refuses the repository for dubious ownership and the project falls back to its directory |
| `auto_memory` | Claude Code: warns while native auto memory is on |
| `data_retention` | Claude Code: warns while the database sits in the plugin data directory without an export in the last 30 days; the fix is a backup with `export`, then the store move |
