# Capture

Nothing is auto-saved. Claude stores durable knowledge with the `memory_*` MCP tools, guided by the bundled `memory` skill. Claude notices a correction or a remember request itself, in any language; the hooks only point at a failing command that later passed.

## Two-phase store

Every memory names its slot (`kind`, `conflict_key`, `cardinality`, `value_text`). A store that finds related memories in its project (same key, nearest vectors, keyword hits) writes nothing and returns them as `needs_resolution`; Claude repeats the call with `SUPERSEDE`, `UPDATE`, `NOOP` or `ADD`, and the server rejects resolutions that would break a single-valued key or cross a project. Superseded memories are revoked: they stay readable but never reach recall. A procedure, constraint or preference with the same key and value in two projects is copied to `user` scope; facts never are.

## Capture moments and the Stop checkpoint

- A Bash command that failed and later passed in the same session opens a resolution moment.
- When a turn ends with such a moment still open (no `memory_store` or `memory_update` since), the Stop hook returns one memory checkpoint: store the durable lesson, or say there is none, then finish. It never fires while a stop hook is already continuing the turn.
- `memory_feedback` receipts drive the lifecycle: only in sessions that give receipts does an injection without a `used` receipt count against a memory; at 5 or more receipted injections with a used share below 0.5 it becomes a `hypothesis` and leaves recall. Constraints and preferences are pinned into every session start whatever the task, so their used share says nothing about their worth: they leave recall only on a `wrong` receipt. A memory that comes back to active starts a fresh trial: only the receipted injections and `used` receipts after its return count toward the next demotion. Nothing is deleted.

## Hook output

All hooks run `dist/hooks.js`, always exit 0 and never block. They print at most one JSON object: `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"…"}}`, or, at session start when the database cannot be used, `{"systemMessage":"…"}` naming the cause and `/memory-doctor`. While the embedding model is missing, session start adds a `systemMessage` beside the context: the model is downloading, or, with `download_model` off, run `/memory-doctor`; after a failed download it names the failure's first line (at most 120 characters) and that the download is retrying. When no download is running, that session start also launches `model-init` as a detached background process and does not wait for it; no other event starts one. Any other internal failure prints one class-only line to stderr and nothing to stdout.
