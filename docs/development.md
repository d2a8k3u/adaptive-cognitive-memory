# Development

| What | Where |
|---|---|
| MCP server and its tools | `src/server.ts`, `src/tools.ts`, wired in `.mcp.json` (Claude Code), `[mcp_servers.memory]` (Codex) and an `mcp` entry (OpenCode) |
| Hooks | `src/hooks.ts`, wired in `hooks/hooks.json` (Claude Code and Codex) |
| Host adapters | `src/host.ts`, `src/hosts/`, and the OpenCode plugin module `opencode/adaptive-cognitive-memory.ts` |
| Store location and move | `src/storelocation.ts`, `src/storemove.ts` |
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
npm run build        # tsc → dist/ (commit the result: dist ships with the plugin)
npm run check        # tsc + biome + vitest run
npm run eval         # retrieval and capture evaluation at the host boundary
npm run eval:fit     # refit the prompt recall gate on the calibration split
```

`npm run check` runs what CI runs before the build: strict `tsc`, the `biome` lint and format gate (warnings are errors) and the full vitest suite. The first test run downloads the embedding model (about 120 MB) from Hugging Face and needs a network connection; later runs work offline.

The suite covers the store pipeline, scope isolation, budgeted injection, redaction, tool contracts, hook spawning against the committed `dist`, concurrency and kill -9 durability, export/import round trips, the doctor, native-module and newer-schema fail-open, install and static gates, and a two-session end-to-end recall run.

## Claude golden test

`tests/claude-golden.test.ts` runs the hooks of this checkout and of the baseline commit `e573fbf893b9196ff7ba0ee9937b5d6021b4a529` on the same seeded store and compares their Claude Code output. It extracts the baseline's `dist/` with `git archive` into `node_modules/.cache/adaptive-cognitive-memory/golden-baseline/`, so the clone needs that commit; a CI checkout needs the full history. Run it alone with:

```bash
git cat-file -e e573fbf893b9196ff7ba0ee9937b5d6021b4a529 && npm run build && npx vitest run tests/claude-golden.test.ts
```

## Codex hook schema fixtures

`tests/fixtures/codex-hooks-schema/` holds the hook output schemas of Codex 0.154.0, vendored from `https://github.com/openai/codex/tree/rust-v0.154.0/codex-rs/hooks/schema/generated`. They are licensed under Apache-2.0, the licence of the openai/codex repository. The Codex tests validate the hook output against them with `ajv`, a dev dependency.

## Live smoke procedure

The smoke run calls a model and writes `~/.codex` or `~/.local/share/opencode`, so it is not a test and never runs in CI. Run it by hand, once per host, with the plugin installed and registered as in [Install](install.md).

1. Make a scratch setup with an isolated store:

   ```bash
   S=$(mktemp -d)
   git init "$S/repo" && git -C "$S/repo" commit --allow-empty -m init
   export ACM_DATA_DIR="$S/store"
   ```

2. Seed the store from the one-memory fixture, anchored on the command head `false`:

   ```bash
   node "<root>/dist/cli.js" import tests/fixtures/smoke/seed.jsonl && node "<root>/dist/cli.js" reembed
   ```

3. Codex: write probe hooks into `$S/repo/.codex/hooks.json` that append their stdin to `$S/codex-hooks.log` for every event, then run:

   ```bash
   cd "$S/repo" && codex exec --dangerously-bypass-hook-trust "run the command false, then create notes.txt with one line"
   ```

4. OpenCode: copy `tests/fixtures/smoke/opencode-probe.js` to `$S/repo/.opencode/plugins/probe.js`; it logs the `chat.message` and `tool.execute.after` inputs to `$S/opencode-hooks.log`. Then run:

   ```bash
   cd "$S/repo" && opencode run "run the command false, then read README.md"
   ```

5. Check the evidence per host. The probe log holds the events. Opening `$ACM_DATA_DIR/memory.sqlite` read-only (with `better-sqlite3` from `<root>/node_modules`) shows `injections` rows for the host's session id and, on OpenCode only, a `command_failures` row for `false`.

## Performance gates

The hook latency caps in `tests/perf.test.ts` are measured on real hardware and skipped when `CI=true`, because a shared CPU makes the numbers meaningless. The warm `UserPromptSubmit` hook at 1000 memories has a 750 ms p95 budget (hooks.json timeout 5 s). If you change the recall or hook path, run `npm run check` on your machine and compare the printed p95 numbers against the budgets in `tests/perf.test.ts`.

## Real-session eval

`evals/` holds a `claude plugin eval` suite that runs a real model against the plugin. It checks that a correction, a remember request and a resolved failure lead to a store; that a conflicting fact goes through the two-phase store and supersedes the old value; that a content-free prompt, a neutral turn and another project's fact inject nothing; and that a superseded fact and a pre-tool procedure reach the answer. Each case's scaffold links the embedding model cached by `npm test` into the run's plugin data directory and seeds memories through the real MCP server. The cases need the real server and Bash:

```bash
claude plugin eval . --tag baseline --ablation with-without --mocks off --scaffold \
  --allow-tools "mcp__plugin_adaptive-cognitive-memory_memory__*" Bash --trust-plugin
claude plugin eval . --tag single-arm --ablation none --mocks off --scaffold \
  --allow-tools "mcp__plugin_adaptive-cognitive-memory_memory__*" Bash --trust-plugin
```

Transcripts carry only SessionStart hook output, so whether a memory was injected is checked in each run's database (`--keep-temp`, then the `injections` and `session_signals` tables), not with trace graders.
