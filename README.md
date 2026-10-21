# Adaptive cognitive memory

A Claude Code plugin that gives Claude a persistent cognitive memory: one central, local SQLite database shared by every project, with local semantic search, budgeted hook recall and explicit, curated capture.

Every project Claude works in reads and writes the same `${CLAUDE_PLUGIN_DATA}/memory.sqlite`. Memories carry a scope — `project` (visible only in that project) or `user` (visible everywhere) — and a type: `semantic` (facts), `procedural` (how-tos), `episodic` (session events) or `pattern` (lessons and preferences). All memories are stored in English as the canonical retrieval language; a multilingual local embedding model makes Czech or other non-English queries find them anyway.

## How it works

- **Recall is automatic.** Hooks inject one-line abstracts under a token budget at session start, on every user prompt, before tool calls and after a failed Bash command; Claude expands a memory's full body with `memory_get`.
- **Capture is explicit.** Nothing is auto-saved. Claude stores durable knowledge with the `memory_*` MCP tools, guided by the bundled `memory` skill. Hooks only point at the moments worth a store: a correction, a remember request, a failing command that later passed.
- **Claude curates, the server guards.** A store that finds related memories writes nothing and returns them; Claude decides to supersede, update, skip or add. Superseded memories stay readable but never reach recall.
- **Nothing ever leaves the machine.** No outbound request carries memory content, the MCP server talks stdio only, and hooks make zero LLM calls. The one network operation is the one-time embedding model download. Secrets are redacted at the persist boundary and again on export.
- **Degraded is never silent.** A missing embedding model or sqlite-vec extension falls back to FTS5 keyword search with a visible warning; a native module that does not load or a database from a newer plugin turns memory off with one session-start notice; `/memory-doctor` names the broken piece and its fix.

Requirements: Claude Code and Node.js ≥ 22. To start, follow [Install](docs/install.md#install).

**Uninstalling the plugin from the last scope it is installed at deletes every memory.** Export them first: [Uninstall](docs/install.md#uninstall).

## Documentation

### Using the plugin

- [Install and uninstall](docs/install.md): install from the marketplace or a local checkout, the embedding model download, keeping your memories when you uninstall
- [Recall](docs/recall.md): what Claude sees, when each hook recalls, turning recall off, branch-aware session start, recall after a failed Bash command
- [Capture](docs/capture.md): the two-phase store, capture moments, the Stop checkpoint and what the hooks print
- [MCP tools and skills](docs/tools.md): every `memory_*` tool with its arguments and result, and the `memory-curate` skill
- [Commands and CLI](docs/cli.md): `/memory-doctor`, `/memory-recall`, `/memory-statusline`, export, import, re-embedding and the doctor checks
- [Statusline badge](docs/statusline.md): the opt-in badge and the line for your statusline script
- [Configuration](docs/configuration.md): plugin options, environment variables and native auto memory

### Developing the plugin

- [Development](docs/development.md): where everything lives, checks, the test suite and the real-session eval
- [Storage](docs/storage.md): the database tables, project ids, concurrency and schema versions
- [Contributing](CONTRIBUTING.md)
