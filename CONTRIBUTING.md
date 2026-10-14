# Contributing

Thanks for your interest in contributing to adaptive-cognitive-memory!

## Getting Started

```bash
git clone git@github.com:d2a8k3u/adaptive-cognitive-memory.git
cd adaptive-cognitive-memory
npm ci
```

The first test run downloads the local embedding model (~118 MB) from Hugging Face, so it needs a network connection. Later runs work fully offline.

## The One Gate

```bash
npm run check
```

This runs everything the CI runs: strict `tsc`, the `biome` lint and format gate (warnings are errors), and the full vitest suite. Fix what it reports before opening a PR.

```bash
npm run build
```

## Project Structure

- `src/` — TypeScript source: core (`cfg`, `ids`, `redact`, `search`, `inject`, `embeddings`, `modelinit`, `doctor`), db (`database`, `schema`, `memories`, `relations`), entries (`server`, `tools`, `hooks`, `cli`)
- `dist/` — **committed** build output; the plugin ships it, so rebuild and include it in your commit when you change `src/`
- `tests/` — vitest suite (store, recall, redaction, tools, hooks, concurrency, install, e2e)
- `hooks/` — Claude Code hook wiring (`hooks.json`)
- `skills/`, `commands/` — bundled skill and `/memory-doctor` command
- `.claude-plugin/`, `.mcp.json` — plugin manifest and MCP server wiring

## Making Changes

1. Create a branch from `main`
2. Make your changes
3. Ensure `npm run check` passes; if you touched `src/`, run `npm run build` and commit the updated `dist/`
4. Commit using [conventional commits](https://www.conventionalcommits.org/): `type(scope): description`
5. Open a pull request

## Code Style

- TypeScript strict mode, CommonJS output, Node ≥ 22
- Biome enforces formatting: 2-space indent, 100-column lines, double quotes, LF, organized imports
- No comments — names and structure carry the meaning; rationale belongs in the commit message
- No `any` — use `unknown` and narrow
- Never weaken a test to make a change pass; tests define the contract

## Performance Gates

The hook latency caps are measured on real hardware and run locally and on non-CI branches; CI runners skip them because shared CPU makes the numbers meaningless. If you change the recall or hook path, run `npm run check` on your machine and compare the printed p95 numbers against the budgets in `tests/perf.test.ts`.

## Reporting Issues

Open an issue with:

- What you expected vs. what happened
- Steps to reproduce, including the memory content shape (never real secrets)
- Node.js version and OS
- Output of `/memory-doctor`