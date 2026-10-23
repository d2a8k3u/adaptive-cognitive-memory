# Configuration

## Plugin options

Set them with `/config`, or `claude plugin configure adaptive-cognitive-memory`:

| Option | Meaning | Default | Range |
|---|---|---|---|
| `recall_budget_tokens` | injection budget, SessionStart + UserPromptSubmit | `1200` | 100–2375 |
| `pretool_budget_tokens` | injection budget, PreToolUse and PostToolUseFailure | `300` | 100–2375 |
| `download_model` | download the embedding model in the background at the first session start | `true` | `true`, `false` |

Hooks receive them as `CLAUDE_PLUGIN_OPTION_RECALL_BUDGET_TOKENS`, `CLAUDE_PLUGIN_OPTION_PRETOOL_BUDGET_TOKENS` and `CLAUDE_PLUGIN_OPTION_DOWNLOAD_MODEL`; an unset option takes its default, and a value outside the range is an explicit error.

## Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `CLAUDE_PLUGIN_DATA` | plugin data directory; required | set by Claude Code |
| `ACM_DB_PATH` | database path override | `${CLAUDE_PLUGIN_DATA}/memory.sqlite` |
| `ACM_MODEL_CACHE_DIR` | model cache override | `${CLAUDE_PLUGIN_DATA}/models` |
| `ACM_EMBED_DEADLINE_MS` | deadline for a query embedding, model load included, before recall falls back to keyword search (the tests raise it so slow CI runners do not fail recall tests) | `1500` |
| `ACM_MODEL_REMOTE_HOST` | model download source override (the tests point it at an unreachable local address) | `https://huggingface.co/` |

## Native auto memory

Claude Code's own auto memory (`~/.claude/projects/<project>/memory/MEMORY.md`, or the `autoMemoryDirectory` setting) is on by default and can run beside this plugin. The plugin reads the same settings Claude Code does — `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (`1` off, `0` on) first, then `autoMemoryEnabled` in `.claude/settings.local.json`, `.claude/settings.json` and `~/.claude/settings.json`, highest first. Managed settings and `--settings` are invisible to it, so its verdict holds "as far as the readable settings show". While auto memory is on:

- SessionStart (`startup`, `clear`, `compact`) adds one line asking Claude to store durable lessons with `memory_store`, not in `MEMORY.md`.
- `memory_store` rejects content that restates a line of that `MEMORY.md` (as it does for `CLAUDE.md` and `.claude/rules/*.md`).
- `/memory-doctor` warns (`auto_memory`). To make this plugin the only durable memory, set `"autoMemoryEnabled": false` in `.claude/settings.json` (one project) or `~/.claude/settings.json` (every project).
