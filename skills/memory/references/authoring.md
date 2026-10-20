# Memory authoring standard

The server rejects what no recall path can match; its message names the fix. Forms marked (guidance) are not checked.

| Field | Limit | Form | Good | Bad |
|---|---|---|---|---|
| title | 200 characters | the lesson in a few words (guidance) | `Run backend tests with uv run pytest -q` | `Note` |
| abstract | 200 characters | the one line recall prints, not the title again (guidance) | `Run uv run pytest -q from the repository root` | the title repeated |
| content | 32000 characters | English, one topic, insight first, then the reason (guidance) | `Tests need Postgres: the ledger uses advisory locks.` | a pasted log |
| conflict_key | 120 characters | `namespace.topic`, lowercase, dotted, namespace from the table below; name the area, not the project (guidance) | `test.command.backend` | `billing.test_command` |
| cardinality + value_text | 200 characters | `single` with the current value in a few words; `multi` when values coexist | `single`, `PostgreSQL 15` | `single` without a value |
| keywords | 300 characters | lower-case terms, each once, identifiers as written (guidance) | `pytest fixtures xdist docker` | `Tests, tests, TESTS` |
| anchors | 20 anchors | each one of the forms below, at most 200 characters, listed once | `pytest`, `billing/tax.py` | `/Users/me/app/billing/tax.py` |
| scope | — | `user` only for what holds in every project; keys are not tied to scope (guidance) | `user` for an editor preference | `user` for one project's database |

## Anchors

An anchor matches exactly what a hook derives before the tool call:

- before Bash, a command head of at most 3 words (`pytest`, `git commit`, `uv run pytest`);
- before Read, Edit or Write, the project-relative path (`billing/tax.py`), a directory prefix ending in `/` (`migrations/versions/`), the basename with or without its extension (`pyproject.toml`, `Dockerfile`) or an extension (`.vue`); an extension fires on every file of that type, so keep it for rules that hold for all of them (guidance);
- an upper-case ticket id as it appears in the branch (`TOUCH-4945`);
- an error code or class name (`ENOENT`, `ModuleNotFoundError`).

A path of more than 3 space-separated words can only be anchored by a directory prefix or its extension.

Good anchors: `pytest` `git commit` `uv run pytest` `go test ./...` `billing/tax.py` `migrations/versions/` `pyproject.toml` `Dockerfile` `.vue` `pages/[id].vue` `TOUCH-4945` `ENOENT` `ModuleNotFoundError`
Bad anchors: `/Users/me/app/billing/tax.py` `./scripts/release.sh` `billing\tax.py` `src/*.ts` `uv run pytest tests/test_tax.py` `touch-4945`

## Conflict key namespaces

| Namespace | Area | Example |
|---|---|---|
| `project` | what the project is and its business rules; the catch-all | `project.primary_database` |
| `build` | compiling, bundling, linting, type checks, CI, code generation | `build.lint_command` |
| `test` | test commands, data, style, mocks, benchmarks | `test.command.backend` |
| `deploy` | targets, releases, infrastructure, operations, monitoring | `deploy.target` |
| `db` | schema, migrations, queries, storage, caches, retention | `db.migration_tool` |
| `api` | HTTP and message contracts, external integrations | `api.request_timeout` |
| `code` | conventions, architecture, libraries, error-handling style | `code.http_client` |
| `git` | branches, commits, pull requests, tags, changelog | `git.branch_policy` |
| `tool` | local tooling: package manager, dev servers, editor | `tool.package_manager` |
| `team` | ownership, reviewers, approvals | `team.reviewers` |
| `user` | the user's own preferences | `user.typescript_any` |
| `error` | incidents, failure causes, error signatures | `error.sqlite_busy.wal_lock` |
| `ticket` | facts tied to one ticket | `ticket.touch_4945` |

Good keys: `project.primary_database` `test.command.backend` `team.reviewers` `deploy.target` `error.sqlite_busy.wal_lock` `user.typescript_any`
Bad keys: `database` `billing.tax_rounding` `Project.Primary` `project..database` `test.Command`
