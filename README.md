# Adaptive cognitive memory

A plugin for Claude Code, Codex and OpenCode that gives the agent a persistent cognitive memory: one central, local SQLite database shared by every project and every host, with local semantic search, budgeted hook recall and explicit, curated capture.

Every project the agent works in, on any of the three hosts, reads and writes the same `memory.sqlite` in one shared data directory, `$HOME/.local/share/adaptive-cognitive-memory` by default (see [Storage](docs/storage.md#layout)). An existing Claude Code store is moved there once, by a command you run ([Moving the Claude Code store](docs/storage.md#moving-the-claude-code-store)). Memories carry a scope — `project` (visible only in that project) or `user` (visible everywhere) — and a type: `semantic` (facts), `procedural` (how-tos), `episodic` (session events) or `pattern` (lessons and preferences). All memories are stored in English as the canonical retrieval language; a multilingual local embedding model and the recall questions each memory carries, written in English and in the user's language, let prompts in other languages find them.

## Hosts

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Integration | hooks, MCP server and slash commands from the marketplace install | hooks from the plugin, MCP server registered in `~/.codex/config.toml` | a plugin module and an `mcp` entry in `opencode.json` |
| Commands | `/memory-doctor`, `/memory-recall`, `/memory-statusline` | CLI lines | CLI lines |
| Missing | | failure capture and failure recall; statusline badge | recall before a tool call (appended after it); statusline badge |

The per-host steps are in [Install](docs/install.md#install) and the full capability matrix is at the top of [Install and uninstall](docs/install.md).

## How it works

- **Recall is automatic.** Hooks inject one-line abstracts under a token budget at session start, on every user prompt, before tool calls and after a failed Bash command (Codex: no failed-command recall); the agent expands a memory's full body with `memory_get`.
- **Capture is explicit.** Nothing is auto-saved. Claude stores durable knowledge with the `memory_*` MCP tools, guided by the bundled `memory` skill. Claude notices a correction or a remember request itself, in any language; the hooks only point at a failing command that later passed.
- **Claude curates, the server guards.** A store that finds related memories writes nothing and returns them; Claude decides to supersede, update, skip or add. Superseded memories stay readable but never reach recall.
- **Nothing ever leaves the machine.** No outbound request carries memory content, the MCP server talks stdio only, and hooks make zero LLM calls. The one network operation is the one-time embedding model download. Secrets are redacted at the persist boundary and again on export.
- **Degraded is never silent.** A missing embedding model or sqlite-vec extension falls back to FTS5 keyword search with a visible warning; a native module that does not load or a database from a newer plugin turns memory off with one session-start notice; the doctor names the broken piece and its fix.

Requirements: Node.js ≥ 22 and Claude Code, Codex or OpenCode. To start, follow [Install](docs/install.md#install).

**On Claude Code, uninstalling the plugin from the last scope it is installed at deletes the store until you move it.** Export or move the store first: [Uninstall](docs/install.md#uninstall).

## Documentation

### Using the plugin

- [Install and uninstall](docs/install.md): per-host install for Claude Code, Codex and OpenCode, the capability matrix, the embedding model download, keeping your memories when you uninstall
- [Recall](docs/recall.md): what the agent sees, when each hook recalls and which event each host uses, turning recall off, branch-aware session start, recall after a failed Bash command
- [Capture](docs/capture.md): the two-phase store, capture moments, the Stop checkpoint and what the hooks print
- [MCP tools and skills](docs/tools.md): every `memory_*` tool with its arguments and result, and the `memory-curate` skill
- [Commands and CLI](docs/cli.md): the per-host `doctor`, `recall on|off` and `statusline` lines, `store move`, export, import, re-embedding and the doctor checks
- [Statusline badge](docs/statusline.md): the opt-in Claude Code badge and the line for your statusline script
- [Configuration](docs/configuration.md): plugin options, `ACM_DATA_DIR`, `ACM_HOST`, environment variables and Claude Code's native auto memory

### Developing the plugin

- [Development](docs/development.md): where everything lives, checks, the test suite, performance gates, the Codex hook schema fixtures, the live smoke procedure and the real-session eval
- [Storage](docs/storage.md): the database tables, project ids, concurrency, schema versions, the shared directory layout and the store move
- [Contributing](CONTRIBUTING.md)
