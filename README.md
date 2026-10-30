# Adaptive cognitive memory

Gives Claude Code, Codex and OpenCode one local memory shared by every project: what the agent stores in one session comes back in later sessions, on any of the three hosts. Memory content never leaves your machine.

## Install

You need Node.js ≥ 22. On Claude Code, run:

```bash
claude plugin marketplace add d2a8k3u/adaptive-cognitive-memory
claude plugin install adaptive-cognitive-memory@adaptive-cognitive-memory
```

Codex and OpenCode need a few more steps (dependencies, the MCP server entry, and on Codex the hook review): follow [Install](docs/install.md#install).

The first session downloads the embedding model (about 120 MB) in the background. Then check the install with `/memory-doctor` on Claude Code, or with the doctor line from [Commands and CLI](docs/cli.md) on Codex and OpenCode. It rates every check `ok`, `warn` or `fail` and gives the fix for each one that is not ok.

On Claude Code, uninstalling the plugin from the last scope it is installed at deletes the store until you move it. Export or move the store first: [Uninstall](docs/install.md#uninstall).

## How it works

Every project, on every host, reads and writes one `memory.sqlite` in the shared data directory, `$HOME/.local/share/adaptive-cognitive-memory` by default ([Storage](docs/storage.md#layout)). An existing Claude Code store stays where it is until you move it with one command ([Move the Claude Code store](docs/storage.md#move-the-claude-code-store)).

A memory has a scope, `project` (visible only in that project) or `user` (visible everywhere), and a type: `semantic` (facts), `procedural` (how-tos), `episodic` (session events) or `pattern` (lessons and preferences). Memories are stored in English. Each one carries recall questions in English and in the user's language, and the local embedding model is multilingual, so prompts in other languages find them.

Recall is automatic. Hooks inject one-line abstracts under a token budget at session start, on every prompt, before tool calls and after a failed Bash command. The agent reads a memory's full body with `memory_get`.

Capture is explicit: nothing is saved automatically. The agent stores durable knowledge with the `memory_*` MCP tools, guided by the bundled `memory` skill. It notices a correction or a remember request itself, in any language; the hooks only point at a failing command that later passed. A store that finds related memories writes nothing and returns them, and the agent decides to supersede, update, skip or add. Superseded memories stay readable but never reach recall.

No outbound request carries memory content: the MCP server talks stdio only and the hooks make no LLM calls. The one network operation is the one-time model download. Secrets are redacted when a memory is stored and again on export.

A broken part is never silent. Without the embedding model or the sqlite-vec extension, recall falls back to FTS5 keyword search with a visible warning. A native module that does not load, or a database written by a newer plugin version, turns memory off with one notice at session start. The doctor names the broken piece and its fix.

## Host differences

Codex has no failure capture, no recall after a failed command and no statusline badge. OpenCode appends pre-tool recall after the tool call and has no statusline badge. Both run the commands as CLI lines instead of slash commands. The full matrix is in [Install](docs/install.md).

## Documentation

### Using the plugin

- [Install and uninstall](docs/install.md): per-host install, the capability matrix, the embedding model download, keeping your memories when you uninstall
- [Recall](docs/recall.md): what the agent sees, when each hook recalls and on which host event, turning recall off, branch-aware session start, recall after a failed Bash command
- [Capture](docs/capture.md): the two-phase store, capture moments, the Stop checkpoint and what the hooks print
- [MCP tools and skills](docs/tools.md): every `memory_*` tool with its arguments and result, and the `memory-curate` skill
- [Commands and CLI](docs/cli.md): the per-host `doctor`, `recall on|off` and `statusline` lines, `store move`, export, import, re-embedding and the doctor checks
- [Statusline badge](docs/statusline.md): the opt-in Claude Code badge and the line for your statusline script
- [Configuration](docs/configuration.md): plugin options, `ACM_DATA_DIR`, `ACM_HOST`, environment variables and Claude Code's native auto memory

### Developing the plugin

- [Development](docs/development.md): where everything lives, checks, the test suite, performance gates, the Codex hook schema fixtures, the live smoke procedure and the real-session eval
- [Storage](docs/storage.md): the database tables, project ids, concurrency, schema versions, the shared directory layout and the store move
- [Contributing](CONTRIBUTING.md)
