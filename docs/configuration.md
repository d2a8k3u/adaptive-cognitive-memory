# Configuration

## Plugin options

The three options have the same names, defaults and bounds on every host:

| Option | Meaning | Default | Range |
|---|---|---|---|
| `recall_budget_tokens` | injection budget, SessionStart + UserPromptSubmit | `1200` | 100–2375 |
| `pretool_budget_tokens` | injection budget, PreToolUse and PostToolUseFailure | `300` | 100–2375 |
| `download_model` | download the embedding model in the background at the first session start | `true` | `true`, `false` |

Each option is read from an environment variable: `CLAUDE_PLUGIN_OPTION_RECALL_BUDGET_TOKENS`, `CLAUDE_PLUGIN_OPTION_PRETOOL_BUDGET_TOKENS` and `CLAUDE_PLUGIN_OPTION_DOWNLOAD_MODEL`. An unset option takes its default, and a value outside the range is an explicit error.

- Claude Code sets the variables from the plugin's configuration: `/config`, or `claude plugin configure adaptive-cognitive-memory`.
- Codex has no plugin options. Set the variables in the environment Codex runs with: its hooks inherit them, and the MCP server gets them through `env_vars` in `[mcp_servers.memory]` (see [Install](install.md#codex)).
- OpenCode has no plugin options. Set the variables in the environment OpenCode runs with: the plugin passes its environment to the hook it spawns, and the MCP server gets them through `environment` in its `mcp` entry (see [Install](install.md#opencode)).

## Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `ACM_DATA_DIR` | absolute directory of the shared store, used by all three hosts; a relative path is an error | `$HOME/.local/share/adaptive-cognitive-memory` |
| `ACM_HOST` | the host: `claude`, `codex` or `opencode`; any other value is an error. The Codex and OpenCode registrations in [Install](install.md) set it | `claude`, or `codex` when a Codex plugin hook runs |
| `HOME` | required when `ACM_DATA_DIR` is unset | set by the system |
| `ACM_DB_PATH` | database path override | `<data dir>/memory.sqlite` |
| `ACM_MODEL_CACHE_DIR` | model cache override | `<data dir>/models` |
| `ACM_EMBED_DEADLINE_MS` | deadline for a query embedding, model load included, before recall falls back to keyword search (the tests raise it so slow CI runners do not fail recall tests) | `1500` |
| `ACM_MODEL_REMOTE_HOST` | model download source override (the tests point it at an unreachable local address) | `https://huggingface.co/` |

`<data dir>` is the shared store directory. On Claude Code, before the store is moved, it is the plugin data directory instead (see below).

### Claude Code variables

| Variable | Meaning |
|---|---|
| `CLAUDE_PLUGIN_DATA` | the legacy store: the plugin data directory Claude Code sets. Claude Code uses it until `moved.json` exists in it, then uses the shared directory (see [Storage](storage.md#move-the-claude-code-store)) |
| `CLAUDE_PROJECT_DIR` | the project directory the hooks read |

## Native auto memory (Claude Code)

Claude Code's own auto memory (`~/.claude/projects/<project>/memory/MEMORY.md`, or the `autoMemoryDirectory` setting) is on by default and can run beside this plugin. The plugin reads the same settings Claude Code does: `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (`1` off, `0` on) first, then `autoMemoryEnabled` in `.claude/settings.local.json`, `.claude/settings.json` and `~/.claude/settings.json`, highest first. It cannot see managed settings or `--settings`, so the doctor qualifies its verdict with "as far as the readable settings show". While auto memory is on:

- SessionStart (`startup`, `clear`, `compact`) adds one line asking Claude to store durable lessons with `memory_store`, not in `MEMORY.md`.
- `memory_store` rejects content that restates a line of that `MEMORY.md` (as it does for `CLAUDE.md` and `.claude/rules/*.md`).
- The doctor warns (`auto_memory`). To make this plugin the only durable memory, set `"autoMemoryEnabled": false` in `.claude/settings.json` (one project) or `~/.claude/settings.json` (every project).

On Codex and OpenCode the plugin ignores native auto memory.
