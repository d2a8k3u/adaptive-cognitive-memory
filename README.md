# Adaptive cognitive memory

A Claude Code plugin that gives Claude a persistent cognitive memory: one central, local SQLite database shared by every project, with local semantic search, budgeted hook recall and explicit, curated capture.

Every project Claude works in reads and writes the same `${CLAUDE_PLUGIN_DATA}/memory.sqlite`. Memories carry a scope — `project` (visible only in that project) or `user` (visible everywhere) — and a type: `semantic` (facts), `procedural` (how-tos), `episodic` (session events) or `pattern` (lessons and preferences). All memories are stored in English as the canonical retrieval language; a multilingual local embedding model makes Czech or other non-English queries find them anyway.

## How it works

- **Recall is automatic.** Hooks inject one-line abstracts under a token budget at session start, on every user prompt and before tool calls; Claude expands a memory's full body with `memory_get` using the full id on the recalled line.
- **Capture is explicit.** Nothing is auto-saved. Claude stores durable knowledge with the `memory_*` MCP tools, guided by the bundled `memory` skill. Hooks only point at the moments worth a store: a correction, a remember request, a failing command that later passed.
- **Claude curates, the server guards.** Every memory names its slot (`kind`, `conflict_key`, `cardinality`, `value_text`). A store that finds related memories in its project (same key, nearest vectors, keyword hits) writes nothing and returns them as `needs_resolution`; Claude repeats the call with `SUPERSEDE`, `UPDATE`, `NOOP` or `ADD`, and the server rejects resolutions that would break a single-valued key or cross a project. Superseded memories are revoked: they stay readable but never reach recall. A procedure, constraint or preference with the same key and value in two projects is copied to `user` scope; facts never are.
- **Nothing ever leaves the machine.** No outbound request carries memory content, the MCP server talks stdio only, and hooks make zero LLM calls. Secrets are redacted at the persist boundary and again on export.
- **Degraded is never silent.** A missing embedding model or sqlite-vec extension falls back to FTS5 keyword search with a visible warning; a native module that does not load or a database from a newer plugin turns memory off with one session-start notice; `/memory-doctor` names the broken piece and its fix.

## Install

Requirements: Claude Code and Node.js ≥ 22.

The repository is its own marketplace. In Claude Code:

```
/plugin install adaptive-cognitive-memory --marketplace d2a8k3u/adaptive-cognitive-memory
```

or from a shell:

```bash
claude plugin marketplace add d2a8k3u/adaptive-cognitive-memory
claude plugin install adaptive-cognitive-memory@adaptive-cognitive-memory
```

The plugin ships `dist/` committed, and Claude Code installs its npm dependencies from `package-lock.json` into the plugin's cached copy during the marketplace install (registry packages only, `--ignore-scripts`, within 60 s), so there is no build or install step of your own. If that install does not finish, `claude plugin list` notes the missing packages and the first session says so; `claude plugin update adaptive-cognitive-memory@adaptive-cognitive-memory` retries it.

A checkout loaded in place — `claude --plugin-dir /path/to/adaptive-cognitive-memory`, or a marketplace added from a local path — gets no automatic install. Run once in the checkout:

```bash
npm ci --ignore-scripts
```

The first session downloads the embedding model by itself: `Xenova/multilingual-e5-small`, int8, about 135 MB, once, into the plugin data directory. It is the only network operation the plugin performs, and it never touches memory content. The download runs in the background, so the session starts at once with a notice; until it finishes, prompts recall nothing (session-start and pre-tool recall need no model), `memory_search` matches keywords only, and new memories are stored without a vector — the next memory server start embeds up to 32 of them, `reembed` the rest. A failed download is retried at every session start, whose notice then names the failure.

To keep the plugin off the network, turn the `download_model` option off (`/config`, or `claude plugin configure adaptive-cognitive-memory`) and cache the model yourself:

```bash
CLAUDE_PLUGIN_DATA="<plugin data dir>" node dist/cli.js model-init
```

Then run `/memory-doctor`. It prints a JSON health report; exit code 1 means a check failed. Its `model` check shows a running download, the last failed one, and the command above with the paths filled in.

### Keep your memories when you uninstall

The database lives in `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`), outside the versioned plugin directory, so it survives plugin updates. **Uninstalling the plugin from the last scope it is installed at deletes that directory.** Export first and keep the data:

```bash
CLAUDE_PLUGIN_DATA="<plugin data dir>" node dist/cli.js export ~/memory-backup.jsonl
claude plugin uninstall adaptive-cognitive-memory --keep-data
```

The doctor's `data_retention` check warns while the database sits in the plugin data directory with no export in the last 30 days. With the statusline badge on, also run `/memory-statusline off` and remove its line from your statusline script first (see [Statusline badge](#statusline-badge)).

## Native auto memory

Claude Code's own auto memory (`~/.claude/projects/<project>/memory/MEMORY.md`, or the `autoMemoryDirectory` setting) is on by default and can run beside this plugin. The plugin reads the same settings Claude Code does — `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (`1` off, `0` on) first, then `autoMemoryEnabled` in `.claude/settings.local.json`, `.claude/settings.json` and `~/.claude/settings.json`, highest first. Managed settings and `--settings` are invisible to it, so its verdict holds "as far as the readable settings show". While auto memory is on:

- SessionStart (`startup`, `clear`, `compact`) adds one line asking Claude to store durable lessons with `memory_store`, not in `MEMORY.md`.
- `memory_store` rejects content that restates a line of that `MEMORY.md` (as it does for `CLAUDE.md` and `.claude/rules/*.md`).
- `/memory-doctor` warns (`auto_memory`). To make this plugin the only durable memory, set `"autoMemoryEnabled": false` in `.claude/settings.json` (one project) or `~/.claude/settings.json` (every project).

## Recall

Injection shape (abstracts only, never content; token estimate = chars/4; never more than 9,500 characters whatever the budget, since the host truncates additional context above 10,000):

```
Native auto memory is also on: store durable lessons with memory_store, not in the auto-memory MEMORY.md.
memory degraded (model missing) — run /memory-doctor
<memory>
Recalled memory from earlier sessions; verify it against the current code. Apply or follow each line, or say why it does not apply, then send memory_feedback with the ids.
Constraints:
- Apply — release only from the main branch (valid from 2026-10-13 · project · 01K7Q3M5X8R2C9V4N6B1T0ZJHD)
Preferences:
- prefer pnpm for new TypeScript projects (valid from 2026-10-02 · user · 01K6ZP2Y7W3N8D5Q1F4H9GX0RB)
Project facts:
- deploys go to the ECS cluster (valid from 2026-10-10 · project · 01K7JD9C4T6M1Q8W2Z5R3N7BXA)
Procedures:
- Follow — run uv run pytest -q from the repository root (valid from 2026-10-11 · project · 01K7MA0F3H8B6Y2K9V1D4S7CWE)
</memory>
```

The first line appears only at session start while native auto memory is on, the second only when a prompt's recall ran degraded; sections appear only when non-empty. Constraints start with `Apply —`, procedures with `Follow —`.

| Event | Behaviour | Budget |
|---|---|---|
| `SessionStart` | the active constraints and preferences of the user and the project, ranked by derived importance, then rows injected fewer than 500 injection events ago, then recency; on a branch carrying a ticket id then up to 3 rows keyed with it (see below); on `resume` and `compact` also every row injected earlier in the session | `recall_budget_tokens` (1200) |
| `UserPromptSubmit` | admission first (slash commands, acknowledgements and prompts with fewer than 3 content words inject nothing and never load the model), then vector KNN + FTS5 candidates through a calibrated gate per prompt language: a row must reach an absolute cosine floor (English 0.857, Czech 0.792) and stand out from the mean cosine of the prompt's 10 nearest memories by a margin (English 0.017, Czech 0.013), or reach a lower threshold when its key or keywords match the prompt (English 0.853, Czech 0.781); with fewer than 10 memories in the partition the margin is not computed and a plain cosine threshold applies (English 0.851, Czech 0.788); beliefs and unverified rows also need a key hit; at most 3 rows | `recall_budget_tokens` (1200) |
| `PreToolUse` (`Bash\|Edit\|Write\|Read`) | no embedding: the Bash command head (`pytest`, `git commit`, `uv run pytest` → also `pytest`) or the read or edited path (relative path, basename, directory prefixes, extensions) matched exactly against each memory's anchors | `pretool_budget_tokens` (300) |

Rows already injected in the session since its latest SessionStart are skipped. Dedup scope, observed 2026-10-20: subagent hooks carry the parent's `session_id`, so a row injected in the parent is skipped inside a subagent. The gate's operating point is measured, not chosen: `npm run eval:sweep` scores the grid on the calibration split (240 positive and 207 negative prompts over partitions of 115 memories) and picks the highest F0.5 among points whose gold hit holds a per-language floor and whose false-injection rate is no worse than the previous gate's in either language; the frozen point lives in `src/calibration.ts`, and a test pins it to the live embedding model and query/passage inputs. It was confirmed once on a fresh, separately written set of 240 positive and 120 negative prompts: precision 44.2% (previous gate 32.2%), gold hit 53.8% (57.9%), false injections 3/120 (8/120), non-gold rows per prompt 0.46 (0.82). The margin makes the gate more conservative as a store grows denser. An embedding run has a 1.5 s deadline per event; without a query vector `UserPromptSubmit` injects only the degraded warning, which names `embedding timeout` when the deadline passed and `model missing` when the model failed.

`/memory-recall off` turns recall off for the current project (its git repository, or its directory outside git): the hooks inject no memories there while capture, the Stop checkpoint, `memory_store` and `memory_search` keep working. `/memory-recall on` restores it.

### Branch-aware session start

Session start reads the current branch inside the `git rev-parse` call that already resolves the project (`--git-common-dir --git-dir`, then the `HEAD` file of the git dir), so no git process is added. The ticket id is the first token of 2–10 letters or digits, a hyphen and 1–6 digits in the branch name, upper-cased: `fix/TOUCH-4945/guide-list-search` and `fix/touch-4945-x` both give `TOUCH-4945`. Words of the branch name are never used. When there is a ticket, up to 3 memories of the project and the user are added after the pinned constraints and preferences and before the rows carried over on `resume` and `compact`, the most important first, within the same budget and the same SessionStart recall event. A memory matches only when one of its anchors equals the ticket id or its keywords hold it as a phrase (`TOUCH-4945` or `touch 4945`); `touch` alone or `TOUCH-49450` never match, and another project's memories never do. A version-like name such as `release-2026` reads as the ticket `RELEASE-2026` and matches only memories keyed with exactly that id. On `main`, a detached HEAD, outside git or when git fails, session start is unchanged. A repository on the reftable ref format keeps no branch in its `HEAD` file, so it gets no ticket rows. In a repository whose path holds a newline the two-line answer is ambiguous, so the project is resolved by one more `git rev-parse --git-common-dir`, with the same id as before, and it gets no ticket rows. To make a lesson come back on its ticket's branch, put the ticket id, upper-case as it appears in the branch, into both `keywords` and `anchors`.

## Capture moments and the Stop checkpoint

- A human prompt that corrects how Claude works (`don't`, `never`, `wrong`, `instead`, `nedělej`, `špatně`, …) gets one context line: store the rule and the reason with `memory_store` before continuing. A remember request (`remember`, `from now on`, `zapamatuj si`, …) gets: store it now. Agent and system messages never trigger a line.
- A Bash command that failed and later passed in the same session opens a resolution moment.
- When a turn ends with such a moment still open (no `memory_store` or `memory_update` since), the Stop hook returns one memory checkpoint: store the durable lesson, or say there is none, then finish. It never fires while a stop hook is already continuing the turn.
- `memory_feedback` receipts drive the lifecycle: only in sessions that give receipts does an injection without a `used` receipt count against a memory; at 5 or more receipted injections with a used share below 0.5 it becomes a `hypothesis` and leaves recall. Nothing is deleted.

All hooks run `dist/hooks.js`, always exit 0 and never block. They print at most one JSON object: `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"…"}}`, or, at session start when the database cannot be used, `{"systemMessage":"…"}` naming the cause and `/memory-doctor`. While the embedding model is missing, session start adds a `systemMessage` beside the context: the model is downloading, or, with `download_model` off, run `/memory-doctor`; after a failed download it names the failure's first line (at most 120 characters) and that the download is retrying. When no download is running, that session start also launches `model-init` as a detached background process and does not wait for it; no other event starts one. Any other internal failure prints one class-only line to stderr and nothing to stdout.

## MCP tools

Server name `memory`, so tool ids look like `mcp__plugin_adaptive-cognitive-memory_memory__memory_store`.

| Tool | Arguments | Result |
|---|---|---|
| `memory_store` | `title` (≤200), `content` (≤32000), `type`, `kind`, `conflict_key` (lowercase dotted, ≤120) — required; `cardinality` (`single`\|`multi`, default `multi`), `value_text` (≤200, required for `single`), `keywords` (≤300), `anchors` (≤20 × ≤200), `scope` (`project`\|`user`, default `project`), `abstract`, `resolution` (`{action: ADD\|UPDATE\|SUPERSEDE\|NOOP, target?}`). A `conflict_key` is `namespace.topic` with namespace one of `project`, `build`, `test`, `deploy`, `db`, `api`, `code`, `git`, `tool`, `team`, `user`, `error`, `ticket`, and an anchor is a command head of at most 3 words, a project-relative path, a directory prefix ending in `/`, a basename, an extension, an upper-case ticket id or an error code | `{id, action: created\|superseded\|updated\|noop, refId?, promotedId?}` or `{status: needs_resolution, candidates, allowed}` |
| `memory_search` | `query` (required, may be blank), `limit` (1–100, default 10), `type`, `scope` | `{results: [{id, scope, type, importance, abstract, score}], degraded?}` |
| `memory_list` | optional filters `state`, `kind`, `type`, `scope`; `before` (the `next_cursor` of the previous page); `limit` (1–50, default 20); `project: "all"` lists every project's memories read-only (never the default; without it only the memories visible to this project) | `{rows: [{id, title, abstract, kind, type, scope, project_id, state, conflict_key, value_text, importance, support_count, injection_count, used_count, wrong_count, valid_from, updated_at}], next_cursor?}`, newest first, never `content`, changing nothing; a page stays within 40,000 characters of JSON, so it can hold fewer rows than `limit`; `next_cursor` is absent on the last page |
| `memory_get` | `id` (full id or unique prefix) | full record incl. `content`, `state`, `conflict_key`, `value_text`, `superseded_by`, `relations` |
| `memory_update` | `id`, plus at least one of `title`, `abstract`, `content`, `keywords`, `anchors`; `keywords` and `anchors` replace the stored value whole and pass the same checks as `memory_store`; `scope` or `kind` is rejected (store the memory again, then delete the old one) | updated record; revoked memories are immutable |
| `memory_feedback` | `ids` (1–20, as recall printed them), `verdict` (`used`\|`wrong`\|`not_applicable`) | `{memories: [{id, state}]}`; `wrong` moves a memory to `hypothesis`, `used` brings it back; a call naming an unknown or revoked id records nothing |
| `memory_delete` | `id` | `{deleted: true}`; deletes the row, its vector and its relations |
| `memory_relate` | `source_id`, `target_id`, `relation_type` (≤40) | `{ok: true}`; rejects self-relations, unknown ids and a 21st relation |
| `memory_status` | — | this project's id and recall switch; memory counts by state × kind for `user` scope and the project; transitions by reason; the share of the newest 500 recall events that injected anything (admission rejections and gate abstentions included); the share of memories injected in receipt-giving sessions that never got `used`; the newest 10 open capture signals with session and age; the last 10 injections |
| `memory_doctor` | — | the doctor report |

Invalid input returns `{error: {field, message}}` and persists nothing. An anchor no recall path can match or a `conflict_key` outside `namespace.topic` with a listed namespace is rejected the same way, the message naming the fix; the standard behind these rules is `skills/memory/references/authoring.md`. Keys are checked as they will be stored: an anchor holding a secret is rejected, because redaction would change it and it could never match, and `keywords` or a `value_text` that redaction would lengthen past its limit are rejected too. When the native module or the database cannot be used, every tool except `memory_doctor` returns an error naming the cause and the fix.

The bundled `memory-curate` skill reviews the memory with the user: status, hypotheses, stale facts, wrong scope, recall keys, then the counts before and after. It proposes each change and deletes, supersedes or updates nothing until the user confirms.

## Commands and CLI

From a session, `/memory-doctor`, `/memory-recall on|off` and `/memory-statusline on|off` run the CLI with the plugin data directory filled in. From a shell, set `CLAUDE_PLUGIN_DATA` and run `node dist/cli.js <command>` in the plugin root:

| Command | Effect |
|---|---|
| `doctor` | JSON health report; exit 1 when a check fails |
| `recall on\|off` | recall switch for the project of the working directory |
| `statusline on\|off` | opt-in statusline badge: `on` installs the shim and prints the line for your statusline script, `off` removes the plugin's statusline files and prints the line to remove; neither touches any `settings.json` (see [Statusline badge](#statusline-badge)) |
| `export <file>` | writes JSONL: a header, then one record per memory (every column needed to restore it — state, counters, timestamps — but no vector), relation and transition; secrets redacted again, personal data kept; refuses an existing file; stamps the export time the doctor reads |
| `import <file>` | validates every line first and rejects the whole file naming each bad line; every memory must pass the same key rules as `memory_store` (conflict key, value, keywords, anchors), except that a legacy empty `conflict_key` (`""`) is kept; then writes in one transaction. A memory id already present is skipped (re-import is a no-op); an active single-valued memory whose slot another active memory holds, or a memory with more than 20 relations, rejects the import naming the line. Imported text is redacted like a stored memory's. Imported rows arrive without vectors: run `reembed` (each server start embeds up to 32 active ones) |
| `model-init` | one-time model download, the only command that touches the network (session start runs it in the background unless `download_model` is off). It downloads into a staging directory beside the model cache and moves the finished model into place, so an interrupted download never leaves a partial model; a lock in the plugin data directory admits one download at a time (exit 1 while another runs; a lock older than 15 minutes is taken over), and a failure is recorded for the doctor. Prints the model's size and path; does nothing when the model is already cached |
| `reembed` | realigns vector states that drifted while sqlite-vec was not loaded, then embeds every memory still missing a vector (the MCP server does both for up to 32 active ones after it connects; a failure there leaves the rows unembedded and shows in the doctor's `unembedded` check) |

### Doctor checks

Every check has `status` `ok`, `warn` or `fail` (`ok: false` only for `fail`), a `detail` and, unless ok, a `fix`. Only `fail` makes the report `degraded` and the exit code 1.

`node`, `native_module` (better-sqlite3 loads under this node; the fix is `npm rebuild better-sqlite3` in the plugin root), `plugin_data`, `database` (schema version, `quick_check`, a newer schema written by a newer plugin), `vec`, `model` (fails while the model is missing, naming the last failed download; warns instead while a download is running, and when the last prompt's query embedding missed its 1.5 s deadline), `unembedded` (active memories without a vector, with the last failed start-up backfill), `vec_state` (vectors whose state drifted from their memory's), `fts`, `calibration` (the model and sweep the gate was calibrated with), `project_identity` (warns with the `safe.directory` fix when git refuses the repository for dubious ownership and the project falls back to its directory), `auto_memory` (warns while native auto memory is on), `data_retention` (warns while the database sits in the plugin data directory without an export in the last 30 days).

## Statusline badge

The badge is opt-in: until you run `/memory-statusline on`, no hook or command writes a statusline file. `on` installs a small shim and an enabled marker in `${CLAUDE_PLUGIN_DATA}/statusline/` and prints one line for your own statusline command; the badge never reads or writes any `settings.json`. While the badge is on, each recall hook (session start, prompt, pre-tool) writes its session's badge state there: one file per session, replaced atomically, so a reader never sees a torn file. Session start prunes state files older than 30 days and reinstalls the shim after a plugin update.

The badge is one line of at most 40 characters, `mem <n> · last <event> <hh:mm>` (the distinct memories injected in this session, the last recall event and its local time), or `mem off` while recall is off for the project. The shim reads only node built-ins and its own files, never the database. It prints nothing and exits 0 when there is nothing to show: badge off, unknown session, missing or unreadable state, malformed stdin.

Used alone as the `statusLine` command, the line works as printed:

```bash
{ test -f "<plugin data dir>/statusline/badge.cjs" && node "<plugin data dir>/statusline/badge.cjs"; } || :
```

In a script that reads the statusline's stdin once (`input="$(cat)"`) and hands it to several commands, replay it into the line:

```bash
printf '%s' "$input" | { test -f "<plugin data dir>/statusline/badge.cjs" && node "<plugin data dir>/statusline/badge.cjs"; } || :
```

`/memory-statusline off` stops the writes, removes `${CLAUDE_PLUGIN_DATA}/statusline/` and prints the same line for you to remove. Uninstalling deletes the plugin data directory, so before you uninstall, run `/memory-statusline off` and remove the line from your statusline script.

## Configuration

Plugin options (`/config`, or `claude plugin configure adaptive-cognitive-memory`):

| Option | Meaning | Default | Range |
|---|---|---|---|
| `recall_budget_tokens` | injection budget, SessionStart + UserPromptSubmit | `1200` | 100–2375 |
| `pretool_budget_tokens` | injection budget, PreToolUse | `300` | 100–2375 |
| `download_model` | download the embedding model in the background at the first session start | `true` | `true`, `false` |

Hooks receive them as `CLAUDE_PLUGIN_OPTION_RECALL_BUDGET_TOKENS`, `CLAUDE_PLUGIN_OPTION_PRETOOL_BUDGET_TOKENS` and `CLAUDE_PLUGIN_OPTION_DOWNLOAD_MODEL`; an unset option takes its default, and a value outside the range is an explicit error. Environment:

| Variable | Meaning | Default |
|---|---|---|
| `CLAUDE_PLUGIN_DATA` | plugin data directory; required | set by Claude Code |
| `ACM_DB_PATH` | database path override | `${CLAUDE_PLUGIN_DATA}/memory.sqlite` |
| `ACM_MODEL_CACHE_DIR` | model cache override | `${CLAUDE_PLUGIN_DATA}/models` |
| `ACM_MODEL_REMOTE_HOST` | model download source override (the tests point it at an unreachable local address) | `https://huggingface.co/` |

## Storage

One SQLite database (WAL, `busy_timeout` 5000 ms, short immediate transactions) holds:

- `memories` — ulid id, type, kind, scope, `project_id`, title, abstract, content, slot, state, counters, derived importance ((1 + used) / (2 + used + failures) with failures = 2 × wrong + receipted injections without use), validity timestamps. `project_id` is the first 16 hex chars of the sha256 of the project's git common dir, so every subdirectory and worktree of one repository shares it; outside git it hashes the directory's real path.
- `relations` (explicit, capped at 20 per source), `memories_vec` (sqlite-vec, float[384] cosine, with a `state` column so KNN filters to active rows), `memories_fts` (FTS5 over title, abstract, conflict key, keywords and value).
- `transitions` — every supersession, promotion, demotion and reactivation with its evidence.
- `injections`, `receipt_sessions`, `recall_events` — what each session was shown, which sessions gave receipts, and one row per recall hook run with the number of rows it injected (kept to the newest 10,000 at each session start).
- `session_signals`, `command_failures` — capture moments; closed signals and command failures older than 30 days are dropped at session start.
- `project_settings` — the per-project recall switch.

Concurrent sessions are safe: an externally locked database surfaces an explicit `database locked` error, never a partial write. The embedding model identity and dimension are guarded at open. Every open stamps the plugin version that wrote the database; a database whose schema is newer than the running plugin supports is refused with both versions named and "update the plugin".

## Development

```bash
npm ci               # install dependencies (exact pins, lockfile committed)
npm run build        # tsc → dist/ (commit the result — dist ships with the plugin)
npm run check        # tsc + biome + vitest run
npm run eval         # retrieval and capture evaluation at the host boundary
```

The suite covers the store pipeline, scope isolation, budgeted injection, redaction, tool contracts, hook spawning against the committed `dist`, concurrency and kill -9 durability, export/import round trips, the doctor, native-module and newer-schema fail-open, install and static gates, and a two-session end-to-end recall run. The perf gate measures the warm `UserPromptSubmit` hook at 1000 memories against a 750 ms p95 budget (hooks.json timeout 5 s).

### Real-session eval

`evals/` holds a small `claude plugin eval` suite that runs a real model against the plugin: a correction, a remember request and a resolved failure lead to a store; a conflicting fact goes through the two-phase store and supersedes the old value; a content-free prompt, a neutral turn and another project's fact inject nothing; a superseded fact and a pre-tool procedure reach the answer. Each case's scaffold links the embedding model cached by `npm test` into the run's plugin data directory and seeds memories through the real MCP server. The cases need the real server and Bash:

```bash
claude plugin eval . --tag baseline --ablation with-without --mocks off --scaffold \
  --allow-tools "mcp__plugin_adaptive-cognitive-memory_memory__*" Bash --trust-plugin
claude plugin eval . --tag single-arm --ablation none --mocks off --scaffold \
  --allow-tools "mcp__plugin_adaptive-cognitive-memory_memory__*" Bash --trust-plugin
```

Transcripts carry only SessionStart hook output, so whether a memory was injected is checked in each run's database (`--keep-temp`, then the `injections` and `session_signals` tables), not with trace graders.

Source layout: `src/` core (`cfg`, `ids`, `redact`, `embeddings`, `search`, `gate`, `inject`, `capture`, `lifecycle`, `policy`, `automemory`, `status`, `transfer`, `doctor`, `tools`) and `src/db/` (`database`, `schema`, `memories`, `listing`, `relations`, `injections`, `signals`, `events`, `projects`, `status`, `transfer`), entries `src/server.ts`, `src/hooks.ts`, `src/cli.ts`.
