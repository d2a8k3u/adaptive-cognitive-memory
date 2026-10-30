# Contributing

## Set up

```bash
git clone git@github.com:d2a8k3u/adaptive-cognitive-memory.git
cd adaptive-cognitive-memory
npm ci
```

[Development](docs/development.md) lists where everything lives, the checks, the performance gates and the evals.

## Make a change

1. Create a branch from `main`.
2. Run `npm run check` until it passes. If you touched `src/`, run `npm run build` and commit the updated `dist/`.
3. If you changed the recall or hook path, check the [performance gates](docs/development.md#performance-gates) on your machine.
4. Commit with [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`.
5. Open a pull request.

## Code style

- TypeScript strict mode, CommonJS output, Node ≥ 22.
- Biome enforces formatting: 2-space indent, 100-column lines, double quotes, LF, organized imports.
- No comments. Names and structure carry the meaning; rationale belongs in the commit message.
- No `any`. Use `unknown` and narrow it.
- Never weaken a test to make a change pass; the tests define the contract.

## Report an issue

Open an issue with:

- what you expected and what happened
- steps to reproduce, including the shape of the memory content (never real secrets)
- Node.js version and OS
- the doctor output: `/memory-doctor` on Claude Code, the doctor line from [Commands and CLI](docs/cli.md) on Codex and OpenCode
