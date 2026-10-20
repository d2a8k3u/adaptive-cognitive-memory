---
name: memory-curate
description: >
  Review this project's memories with the user and clean them up: hypotheses,
  stale facts, wrong scope and recall keys. Use when the user asks to curate,
  review, audit or tidy the memory, or when memory_status shows many hypotheses.
---

# Memory curation

Propose every change and wait for the user's confirmation before you delete, supersede or update a memory; never run this unattended. Present the proposals as a short list with each memory's id and title.

1. **Status.** Call `memory_status` and keep its counts by state and kind for the end.
2. **Hypotheses.** `memory_list` with `state: "hypothesis"`; read each with `memory_get`. Propose to keep it (a `used` receipt through `memory_feedback` brings it back), correct it with `memory_update` or delete it with `memory_delete`.
3. **Stale facts.** `memory_list` with `kind: "fact"`, newest first; pass `next_cursor` as `before` for the next page. A changed value is a `memory_store` with resolution `SUPERSEDE`; a fact that no longer holds is a `memory_delete`.
4. **Wrong scope.** Scope and kind cannot change in place: store the memory again with the right scope or kind (`memory_store`), then delete the old one (`memory_delete`).
5. **Recall keys.** Fix keywords and anchors with `memory_update`, following [the authoring standard](../memory/references/authoring.md) (`memory/references/authoring.md`); each replaces the stored value whole.
6. **Before and after.** Call `memory_status` again and report both sets of counts.

A memory that `memory_list` finds only with `project: "all"` belongs to another project: it is read-only here and can be changed only from a session in its own project.
