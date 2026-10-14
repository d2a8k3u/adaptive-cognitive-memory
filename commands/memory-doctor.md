---
description: Diagnose the adaptive memory plugin install (runtime, native module, database, model, indexes, auto memory, data retention)
---

Run this Bash and relay the report to the user. It checks the node version, the better-sqlite3 native module, the plugin data directory, database integrity (schema version, quick_check), the sqlite-vec extension, the cached embedding model, embedding coverage, vector state drift, the FTS index, the gate calibration, the project identity, native auto memory and data retention, then prints a JSON report. Every check has a `status`: `ok`, `warn` or `fail`. Exit code 1 means at least one check failed — the report names the exact broken piece and its fix; never summarize a degraded run as healthy. A `warn` keeps exit code 0 but is still worth the user's decision.

```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" doctor
```

Summarize every `fail` and every `warn` check by name with its fix.

- `model` failing is the most common break: run `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" model-init` (downloads once into the plugin data dir, then all lookups are local), then re-run the doctor and confirm no check fails.
- `native_module` failing means better-sqlite3 does not load under this node (for example after a node upgrade): run the `npm rebuild better-sqlite3` the fix names, or reinstall the plugin. Until then hooks stay silent and every memory tool except `memory_doctor` returns this error.
- `auto_memory` warning means Claude Code's native auto memory is also on for this project; that is fine, but a user who wants this plugin to be the only durable memory sets `"autoMemoryEnabled": false` in `.claude/settings.json`.
- `data_retention` warning means the database sits in the plugin data directory, which `claude plugin uninstall` deletes from the last scope: suggest an export and `--keep-data`.
