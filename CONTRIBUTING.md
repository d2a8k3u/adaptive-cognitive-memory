# Contributing

Thanks for your interest in contributing to adaptive-cognitive-memory!

## Getting Started

```bash
git clone git@github.com:d2a8k3u/adaptive-cognitive-memory.git
cd adaptive-cognitive-memory
npm ci
```

[Development](docs/development.md) lists where everything lives, the checks, the performance gates and the evals.

## Making Changes

1. Create a branch from `main`
2. Make your changes
3. Ensure `npm run check` passes; if you touched `src/`, run `npm run build` and commit the updated `dist/`
4. If you changed the recall or hook path, check the [performance gates](docs/development.md#performance-gates) on your machine
5. Commit using [conventional commits](https://www.conventionalcommits.org/): `type(scope): description`
6. Open a pull request

## Code Style

- TypeScript strict mode, CommonJS output, Node ≥ 22
- Biome enforces formatting: 2-space indent, 100-column lines, double quotes, LF, organized imports
- No comments — names and structure carry the meaning; rationale belongs in the commit message
- No `any` — use `unknown` and narrow
- Never weaken a test to make a change pass; tests define the contract

## Reporting Issues

Open an issue with:

- What you expected vs. what happened
- Steps to reproduce, including the memory content shape (never real secrets)
- Node.js version and OS
- Output of `/memory-doctor`
