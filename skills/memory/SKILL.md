---
name: memory
description: >
  Store and recall durable knowledge in the adaptive memory. Use whenever the
  user corrects how you work, asks you to remember something, when you infer a
  non-obvious convention or solve a problem whose reasoning is not in the diff,
  when a stored memory turns out to be stale, and to expand a memory id from recall.
---

# Memory capture

One local database serves every project. Hook recall and `memory_search` surface memories automatically; you are the only author, and storing is always your decision.

## When to store, and what

| Moment | Store |
|---|---|
| The user corrects how you work | A `pattern` right away, before continuing: the rule and the reason. |
| The user asks you to remember something | That fact or rule, now. |
| You inferred a non-obvious project convention | The convention and the evidence for it. |
| You solved a problem | The reasoning a future session cannot read from the diff: why this approach, what was rejected, which constraint forced it. Not the fix itself. |

Rules for every memory:

- Store only what a future session could not re-derive from the code, git history or CLAUDE.md. The server rejects content that restates a line of the project's `CLAUDE.md`, `.claude/rules/*.md` or the auto-memory `MEMORY.md`.
- English, one topic per memory, insight first, then the reason.
- Searchable terms: file paths, module names, commands, error signatures.
- Do not ask the user before saving. Do not store agent, task or system text: write the lesson in your own words.
- When Claude Code's native auto memory is also on, durable lessons still go to `memory_store`, not to the auto-memory `MEMORY.md`.

The hooks only point at moments; they never store anything. A correction or a remember request adds one line to the prompt context asking you to store it. When you finish a turn with such a moment still unstored (or after a failing command later passed), the Stop hook returns a memory checkpoint: store the durable lesson, or say there is none, then finish.

## Acting on recall

Recalled constraints start with `Apply —`, procedures with `Follow —`. Apply or follow each one, or say why it does not apply. Then call `memory_feedback` once per turn with the ids: `used` when one informed the work, `wrong` when it was incorrect or outdated, `not_applicable` when it was irrelevant. A `wrong` memory leaves recall until a `used` receipt or a store of the same content brings it back; nothing is deleted.

## The slot every store names

- `type`: `semantic` facts, `procedural` how-tos, `episodic` events, `pattern` corrections and preferences.
- `scope=user` only for what holds across projects (the user, their tools); `scope=project` otherwise.
- `kind`: `constraint`, `preference`, `fact`, `procedure` or `belief`.
- `conflict_key`: a stable lowercase dotted key, the same every time the same question is answered — `project.primary_database`, `test.command.backend`, `team.reviewers`.
- `cardinality`: `single` when the slot holds one current value, `multi` when several coexist.
- `value_text`: the slot's value in a few words (`PostgreSQL 15`); required for `single`.
- `keywords` and `anchors` help recall find it. Before a tool call a memory is recalled only when an anchor matches exactly: before Bash, a command head (`pytest`, `git commit`); before Read, Edit or Write, a project-relative path or basename (`billing/tax.py`), a directory prefix ending in `/` (`migrations/versions/`) or an extension starting with `.` (`.vue`) of the file.

## When the answer is needs_resolution

The server wrote nothing and lists the candidates it found. Repeat the same call with `resolution`:

- `SUPERSEDE` + `target` — a single-valued fact changed; the old memory is revoked.
- `UPDATE` + `target` — refine the same fact in place.
- `NOOP` + `target` — it is already known; only its support count changes.
- `ADD` — a genuinely different memory.

A rejection message names the resolution to use instead. An exact duplicate of an active or hypothesis memory is recorded as `noop` automatically, and a hypothesis comes back to active.

## Reading and curating

- Recall shows abstracts with the full id; read the body with `memory_get`.
- `memory_update` edits title, abstract or content in place; revoked memories are immutable. Importance is derived from feedback, never typed.
- `memory_relate` is for load-bearing connections only, at most 20 per memory.
- `memory_status` shows what the memory holds and does for this project: counts, the recall switch, how often recall injects, open capture moments and the last injections.
- `/memory-recall off` stops recall in this project while storing keeps working; `/memory-recall on` restores it.
- If recall reports a degraded mode or a session-start notice says memory is off, run `/memory-doctor` and follow the fix it names.
