# Install and uninstall

## Requirements

Node.js ≥ 22 and one or more of Claude Code, Codex and OpenCode. The three hosts share one memory store (see [Storage](storage.md#layout)).

The native dependencies `better-sqlite3`, `sqlite-vec` and `@huggingface/transformers` must be installed in the plugin root. Claude Code does that itself during a marketplace install; on Codex and OpenCode you run the install step below. `dist/` is committed, so there is no build step.

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Recall at session start and on every prompt | yes | yes | yes |
| Recall before a tool call | yes | yes | appended after the call |
| Recall after a failed Bash command | yes | no | yes |
| Failure capture (a failing command that later passed) | yes | no: Codex reports no exit status to its hooks, so `resolution` signals stay inert | yes |
| Slash commands | `/memory-doctor`, `/memory-recall`, `/memory-statusline` | CLI lines ([Commands and CLI](cli.md#codex)) | CLI lines ([Commands and CLI](cli.md#opencode)) |
| Statusline badge | yes | no | no |
| Native auto memory | yes | not applicable | not applicable |
| Plugin options | plugin configuration | environment only | environment only |
| MCP server registration | automatic | a `[mcp_servers.memory]` entry you add | an `mcp` entry you add |

Per-event detail is in [Recall](recall.md).

## Install

### Claude Code

The repository is its own marketplace. In Claude Code:

```
/plugin install adaptive-cognitive-memory --marketplace d2a8k3u/adaptive-cognitive-memory
```

or from a shell:

```bash
claude plugin marketplace add d2a8k3u/adaptive-cognitive-memory
claude plugin install adaptive-cognitive-memory@adaptive-cognitive-memory
```

Claude Code installs the plugin's npm dependencies from `package-lock.json` into the plugin's cached copy during the marketplace install (registry packages only, `--ignore-scripts`, within 60 s), so there is no install step of your own. If that install does not finish, `claude plugin list` notes the missing packages and the first session says so; `claude plugin update adaptive-cognitive-memory@adaptive-cognitive-memory` retries it.

A checkout loaded in place — `claude --plugin-dir /path/to/adaptive-cognitive-memory`, or a marketplace added from a local path — gets no automatic install. Run once in the checkout:

```bash
npm ci --ignore-scripts
```

An existing Claude Code store stays where it is, and Claude Code keeps using it, until you move it into the shared directory. Every session shows a notice with the move command. To share memories with Codex or OpenCode, run the move with its precondition (this plugin version installed, every Claude Code session quit, a terminal): see [Moving the Claude Code store](storage.md#moving-the-claude-code-store).

### Codex

Move an existing Claude Code store before you install on Codex. Otherwise Codex creates a fresh store in the shared directory and the move refuses until that store is moved aside.

1. Add this repository (`d2a8k3u/adaptive-cognitive-memory`) as a Codex plugin marketplace and install the plugin `adaptive-cognitive-memory` from it.
2. Codex installs no dependencies for plugins. Find the plugin cache directory of the installed version and install the dependencies there:

   ```bash
   ls -d ~/.codex/plugins/cache/*/adaptive-cognitive-memory/*/
   ```

   ```bash
   cd "<root>" && npm ci --ignore-scripts --omit=dev
   ```

   `<root>` is the directory `ls -d` printed.
3. Register the MCP server in `~/.codex/config.toml`. This step is mandatory. The plugin carries its own server entry, but Codex does not expand `${CLAUDE_PLUGIN_ROOT}` in it, so without the entry below that one wins and fails to start; the `config.toml` entry takes precedence and the plugin's is never started.

   ```toml
   [mcp_servers.memory]
   command = "node"
   args = ["<root>/dist/server.js"]
   env = { ACM_HOST = "codex" }
   env_vars = ["ACM_DATA_DIR", "CLAUDE_PLUGIN_OPTION_RECALL_BUDGET_TOKENS", "CLAUDE_PLUGIN_OPTION_PRETOOL_BUDGET_TOKENS", "CLAUDE_PLUGIN_OPTION_DOWNLOAD_MODEL"]
   ```

   `env_vars` names the variables Codex passes from its own environment to the server; set `ACM_DATA_DIR` and the options there when you want values other than the defaults (see [Configuration](configuration.md)).
4. Review and trust the plugin's hooks. Codex keeps a trust state for plugin hooks (`hooks.state` in `~/.codex/config.toml`) and runs a hook according to it; `codex exec` uses the same state. The global flag `--dangerously-bypass-hook-trust` skips the review and belongs to the smoke procedure in [Development](development.md#live-smoke-procedure), not to everyday use.
5. Check the install with the doctor line in [Commands and CLI](cli.md#codex).

The plugin cache directory changes with every plugin version. After each plugin update, repeat step 2 for the new `<root>` and edit `args` in step 3 to the new path.

### OpenCode

OpenCode targets the v1 plugin API of OpenCode 1.18.31.

1. Clone this repository to `<root>` and install the dependencies there:

   ```bash
   cd "<root>" && npm ci --ignore-scripts --omit=dev
   ```

2. Symlink the plugin module into OpenCode's plugin directory:

   ```bash
   mkdir -p ~/.config/opencode/plugins
   ln -s "<root>/opencode/adaptive-cognitive-memory.ts" ~/.config/opencode/plugins/adaptive-cognitive-memory.ts
   ```

3. Register the MCP server with an `mcp` entry in `~/.config/opencode/opencode.json`. Add the data directory and any options to `environment` (see [Configuration](configuration.md)):

   ```json
   {"mcp":{"memory":{"type":"local","command":["node","<root>/dist/server.js"],"environment":{"ACM_HOST":"opencode"},"enabled":true}}}
   ```

4. Symlink the skills; OpenCode reads `~/.agents/skills`:

   ```bash
   mkdir -p ~/.agents/skills
   ln -s "<root>/skills/memory" ~/.agents/skills/memory
   ln -s "<root>/skills/memory-curate" ~/.agents/skills/memory-curate
   ```

5. Check the install with the doctor line in [Commands and CLI](cli.md#opencode).

To update, pull the clone and rerun the dependency step.

## Embedding model

The first session downloads the embedding model by itself: `onnx-community/granite-embedding-97m-multilingual-r2-ONNX`, int8, about 120 MB, once, into the store's data directory. It is the only network operation the plugin performs, and it never touches memory content. The download runs in the background, so the session starts at once with a notice; until it finishes, prompts recall nothing (session-start and pre-tool recall need no model), `memory_search` matches keywords only, and new memories are stored without a vector — the next memory server start embeds up to 32 of them, `reembed` the rest. A failed download is retried at every session start, whose notice then names the failure.

To keep the plugin off the network, turn the download off and cache the model yourself. On Claude Code, turn the `download_model` option off (`/config`, or `claude plugin configure adaptive-cognitive-memory`); on Codex and OpenCode, set `CLAUDE_PLUGIN_OPTION_DOWNLOAD_MODEL=false` in the environment (see [Configuration](configuration.md)). Then cache the model:

```bash
ACM_DATA_DIR="$HOME/.local/share/adaptive-cognitive-memory" node "<root>/dist/cli.js" model-init
```

Then run the doctor ([Commands and CLI](cli.md)). It prints a JSON health report; exit code 1 means a check failed. Its `model` check shows a running download, the last failed one, and the command above with the paths filled in.

## Uninstall

### Uninstalling on Claude Code

Before the store is moved, the database lives in the plugin data directory `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`), outside the versioned plugin directory, so it survives plugin updates. **Uninstalling the plugin from the last scope it is installed at deletes that directory.** Export first, then uninstall keeping the data, or move the store (below):

```bash
CLAUDE_PLUGIN_DATA="<plugin data dir>" node "<root>/dist/cli.js" export ~/memory-backup.jsonl
claude plugin uninstall adaptive-cognitive-memory --keep-data
```

The doctor's `data_retention` check warns while the database sits in the plugin data directory with no export in the last 30 days. Its fix is the export above and then the [store move](storage.md#moving-the-claude-code-store), which takes the store out of the directory an uninstall deletes: after the move, uninstalling the plugin no longer touches the store, and the legacy directory is yours to delete. With the statusline badge on, also run `/memory-statusline off` and remove its line from your statusline script first (see [Statusline badge](statusline.md)).

### Codex and OpenCode

The store lives in the shared directory, outside anything the host removes with the plugin. Delete the plugin, the `config.toml` or `opencode.json` entry and the symlinks; the memories stay until you delete the shared directory.
