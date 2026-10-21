# Development

| What | Where |
|---|---|
| MCP server and its tools | `src/server.ts`, `src/tools.ts`, wired in `.mcp.json` |
| Hooks | `src/hooks.ts`, wired in `hooks/hooks.json` |
| CLI and slash commands | `src/cli.ts`, `commands/` |
| Recall search, prompt gate and its frozen calibration | `src/search.ts`, `src/gate.ts`, `src/calibration.ts` |
| Key, anchor and limit rules | `src/authoring.ts`, `src/keys.ts`, `src/cfg.ts` |
| Database schema and queries | `src/db/` |
| Bundled skills | `skills/memory/`, `skills/memory-curate/` |
| Plugin manifest and options | `.claude-plugin/plugin.json` |
| Tests and the host-boundary eval | `tests/`, `tests/eval/`, fixtures in `tests/fixtures/` |
| Real-session eval | `evals/` |
| Build output, committed and shipped | `dist/` |

## Checks

```bash
npm ci               # install dependencies (exact pins, lockfile committed)
npm run build        # tsc → dist/ (commit the result — dist ships with the plugin)
npm run check        # tsc + biome + vitest run
npm run eval         # retrieval and capture evaluation at the host boundary
```

The suite covers the store pipeline, scope isolation, budgeted injection, redaction, tool contracts, hook spawning against the committed `dist`, concurrency and kill -9 durability, export/import round trips, the doctor, native-module and newer-schema fail-open, install and static gates, and a two-session end-to-end recall run. The perf gate measures the warm `UserPromptSubmit` hook at 1000 memories against a 750 ms p95 budget (hooks.json timeout 5 s).

## Real-session eval

`evals/` holds a small `claude plugin eval` suite that runs a real model against the plugin: a correction, a remember request and a resolved failure lead to a store; a conflicting fact goes through the two-phase store and supersedes the old value; a content-free prompt, a neutral turn and another project's fact inject nothing; a superseded fact and a pre-tool procedure reach the answer. Each case's scaffold links the embedding model cached by `npm test` into the run's plugin data directory and seeds memories through the real MCP server. The cases need the real server and Bash:

```bash
claude plugin eval . --tag baseline --ablation with-without --mocks off --scaffold \
  --allow-tools "mcp__plugin_adaptive-cognitive-memory_memory__*" Bash --trust-plugin
claude plugin eval . --tag single-arm --ablation none --mocks off --scaffold \
  --allow-tools "mcp__plugin_adaptive-cognitive-memory_memory__*" Bash --trust-plugin
```

Transcripts carry only SessionStart hook output, so whether a memory was injected is checked in each run's database (`--keep-temp`, then the `injections` and `session_signals` tables), not with trace graders.
