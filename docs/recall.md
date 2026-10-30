# Recall

Hooks inject one-line abstracts under a token budget at session start, on every user prompt, before tool calls and after a failed Bash command; Claude expands a memory's full body with `memory_get` using the full id on the recalled line.

## What Claude sees

Injection shape (abstracts only, never content; token estimate = chars/4; never more than 9,500 characters whatever the budget, since the host truncates additional context above 10,000):

```
Native auto memory is also on: store durable lessons with memory_store, not in the auto-memory MEMORY.md.
memory degraded (model missing) — run /memory-doctor
<memory>
Recalled memory from earlier sessions; verify it against the current code. Apply or follow each line, or say why it does not apply, then send memory_feedback for every id.
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

The first line appears only on Claude Code, at session start while native auto memory is on, the second only when a prompt's recall ran degraded; sections appear only when non-empty. Constraints start with `Apply —`, procedures with `Follow —`.

## When recall runs

| Event | Behaviour | Budget |
|---|---|---|
| `SessionStart` | the active constraints and preferences of the user and the project, ranked by derived importance, then rows injected fewer than 500 injection events ago, then recency; on a branch carrying a ticket id then up to 3 rows keyed with it (see below); on `resume` and `compact` also every row injected earlier in the session | `recall_budget_tokens` (1200) |
| `UserPromptSubmit` | admission first (slash commands and prompts with fewer than 3 distinct words of two or more letters inject nothing and never load the model; no word list decides what counts, and text in scripts written without spaces, such as Japanese or Chinese, is split into words first), then KNN over each memory's vector and its recall questions plus FTS5 candidates; a memory's cosine is the best of the two. One gate serves every language: a calibrated linear score over the cosine, its gap to the best candidate, its gap to the mean of the prompt's 10 nearest memories (a sparse store fills the missing ones with a calibrated background cosine), the BM25 strength, whether it is the best candidate and whether its key or keywords match the prompt must reach the frozen threshold; beliefs and unverified rows also need a key hit; at most 3 rows, best score first | `recall_budget_tokens` (1200) |
| `PreToolUse` (`Bash\|Edit\|Write\|Read`) | no embedding: the Bash command head (`pytest`, `git commit`, `uv run pytest` → also `pytest`) and the project paths its arguments name with their directory prefixes (`go test ./internal/it/...` → `internal/it/`), or the read or edited path (relative path, basename, directory prefixes, extensions) matched exactly against each memory's anchors | `pretool_budget_tokens` (300) |
| `PostToolUseFailure` (`Bash`) | no embedding: terms of the redacted error text matched exactly against each memory's anchors, once per session and command head (see below) | `pretool_budget_tokens` (300) |

Rows already injected in the session since its latest SessionStart are skipped. Dedup scope, observed 2026-10-20: subagent hooks carry the parent's `session_id`, so a row injected in the parent is skipped inside a subagent.

The gate is fitted, not hand-tuned: `npm run eval:fit` stores the eval corpus through the real memory server, collects every calibration prompt's candidates the way the hook does (240 positive and 207 negative prompts in English and Czech), fits a logistic model on them and picks the threshold with the most gold hits whose false-injection rate stays within 3%; the weights, threshold and background cosine live in `src/calibration.ts`, and a test pins the record to the live embedding model and its query, passage and question inputs. On the held-out confirmation split (240 positive, 120 negative prompts) the fitted gate reaches a gold hit of 57.5%, precision 82.1% and false injections 2/120; prompts in German, Spanish, Polish and Japanese are measured by the `recall_multilingual` eval suite and never used for fitting.

An embedding run has a 1.5 s deadline per event (`ACM_EMBED_DEADLINE_MS`); without a query vector `UserPromptSubmit` injects only the degraded warning, which names `embedding timeout` when the deadline passed and `model missing` when the model failed.

## Events per host

The table above names Claude Code's events. Codex and OpenCode run the same recall engine from their own events:

| Recall | Claude Code | Codex | OpenCode |
|---|---|---|---|
| session start | `SessionStart` | `SessionStart` | the first `chat.message` of a session; `experimental.session.compacting` recalls again after a compaction |
| every prompt | `UserPromptSubmit` | `UserPromptSubmit` | `chat.message` |
| before a tool call | `PreToolUse` | `PreToolUse` | none: recall for the tool is appended after the call, from `tool.execute.after` |
| after a failed Bash command | `PostToolUseFailure` | none | `tool.execute.after` of `bash`, failure read from `metadata.exit` |
| Stop checkpoint | `Stop` | `Stop`, answered as `{"decision":"block","reason":…}` whose reason becomes the continuation prompt | `session.idle`, answered by a re-prompt through the plugin's client |

Codex gives its hooks no exit status for a Bash command, so on Codex there is no failure capture, no failure recall, and `resolution` signals stay inert. On OpenCode the injected text is added as a text part of the message. The memory tools are named `mcp__plugin_adaptive-cognitive-memory_memory__memory_*` on Claude Code, `mcp__memory__memory_*` on Codex and `memory_memory_*` on OpenCode; the recall header's bare `memory_feedback` is the server's own tool name on every host.

Texts that tell you to run the doctor name the host's form: `/memory-doctor` on Claude Code, and on Codex and OpenCode the `node <root>/dist/cli.js doctor` line from [Commands and CLI](cli.md).

## Turning recall off

`recall off` turns recall off for the current project (its git repository, or its directory outside git): the hooks inject no memories there while capture, the Stop checkpoint, `memory_store` and `memory_search` keep working. `recall on` restores it. On Claude Code these are `/memory-recall off` and `/memory-recall on`; on Codex and OpenCode run the `recall on|off` line from [Commands and CLI](cli.md) inside the project.

## Branch-aware session start

Session start reads the current branch inside the `git rev-parse` call that already resolves the project (`--git-common-dir --git-dir`, then the `HEAD` file of the git dir), so no git process is added. The ticket id is the first token of 2–10 letters or digits, a hyphen and 1–6 digits in the branch name, upper-cased: `fix/TOUCH-4945/guide-list-search` and `fix/touch-4945-x` both give `TOUCH-4945`. Words of the branch name are never used. When there is a ticket, up to 3 memories of the project and the user are added after the pinned constraints and preferences and before the rows carried over on `resume` and `compact`, the most important first, within the same budget and the same SessionStart recall event. A memory matches only when one of its anchors equals the ticket id or its keywords hold it as a phrase (`TOUCH-4945` or `touch 4945`); `touch` alone or `TOUCH-49450` never match, and another project's memories never do. A version-like name such as `release-2026` reads as the ticket `RELEASE-2026` and matches only memories keyed with exactly that id. On `main`, a detached HEAD, outside git or when git fails, session start is unchanged. A repository on the reftable ref format keeps no branch in its `HEAD` file, so it gets no ticket rows. In a repository whose path holds a newline the two-line answer is ambiguous, so the project is resolved by one more `git rev-parse --git-common-dir`, with the same id as before, and it gets no ticket rows. To make a lesson come back on its ticket's branch, put the ticket id, upper-case as it appears in the branch, into both `keywords` and `anchors`.

## Recall on a failed Bash command

When a Bash command fails (`PostToolUseFailure`, not an interrupt), the hook takes signature terms from the error text Claude Code passes, redacted first and cut to its first 500 characters, at most 32 of them: error class names (`TypeError`, `ModuleNotFoundError`), upper-case codes (`ENOENT`, `SQLITE_BUSY`, `ECONNREFUSED`, `E401`), the module name after `Cannot find module`, `No module named` or `could not resolve`, and path basenames (`tax.py`). The `Exit code N` line, `:line:col` suffixes, hex runs of 7 or more, durations, timestamps, absolute path prefixes, colour codes, the redaction marker and status words such as `ERROR`, `ERR`, `FAIL` or `PASS` never become terms. A visible memory is injected only when one of its anchors equals a term; its conflict key and keywords are not matched on this path, and the command head alone never admits a row, so a memory anchored only on `pytest` comes back after a failing `pytest` only when the error text itself names `pytest`. Recall runs once per session and command head: the first failure of `pytest` that injects something uses up `pytest` for the rest of the session, even after it passes, while a failure that injects nothing leaves it unused. It shares the PreToolUse budget (`pretool_budget_tokens`), skips rows already injected since the session's latest start, does nothing while recall is off and loads no model. The error text is never stored; only the command head is, as before, for the resolution moment. To make a lesson come back on its error, put the code, class name or module name into `anchors`.
