# Changelog

## 0.4.1 (2026-11-25)

- Claude Code installs from the [construct](https://github.com/d2a8k3u/construct) marketplace: `claude plugin marketplace add d2a8k3u/construct`, then `claude plugin install adaptive-cognitive-memory@construct`. Installs from the repository marketplace keep working.
- When the npm dependencies are missing, the session notice names the install id of your copy in its `claude plugin update` command. A checkout loaded in place gets only the `npm ci --ignore-scripts` step.
- [Evaluation](docs/evaluation.md) describes how recall is measured, the current results and the commands to rerun them.

## 0.4.0 (2026-10-30)

- The plugin runs in OpenAI Codex CLI and OpenCode next to Claude Code. All three share one store in `~/.local/share/adaptive-cognitive-memory` (or `ACM_DATA_DIR`), so what one host stores the others recall. [Install](docs/install.md#install) has the steps per host.
- An existing Claude Code store stays where it is until you run `store move` ([Move the Claude Code store](docs/storage.md#move-the-claude-code-store)). The doctor warns until then.
- Codex records no command failures, because it does not report a failing command's exit status to its hooks. OpenCode recalls for a tool call after the call, not before it.

## 0.3.0 (2026-10-27)

### Changed

- The embedding model is `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` instead of `Xenova/multilingual-e5-small`. The first session after the update downloads it. The store keeps every memory and embeds them again on the next memory server start or with `reembed`.
- Prompt recall admits memories through one fitted gate for every language instead of English and Czech word lists. Memories carry recall questions in English and in the user's language.
- The agent notices corrections and remember requests itself, in any language. The English and Czech cue lists are gone.
- `memory_feedback` takes a verdict per id (`used`, `not_applicable`, `wrong`) in one call. A memory is demoted only on explicit verdicts, and demotions made earlier on silence are lifted.

### Added

- Recall after a failed Bash command brings back lessons anchored to that command, once per command head ([Recall on a failed Bash command](docs/recall.md#recall-on-a-failed-bash-command)).
- Before a Bash command, recall also matches memories anchored to the project paths the command names.
- `memory_search` finds hypothesis memories and shows their state.
- `memory_status` reports the verdict coverage of unpinned injections.
- `ACM_EMBED_DEADLINE_MS` sets how long a query embedding may take before recall falls back to keyword search.
- The `memory-curate` skill finds and merges duplicate memories, hypotheses included.

### Fixed

- Pinned constraints and preferences are no longer demoted for unused receipts, and the ones already demoted are reactivated.
- A relearned lesson revives its hypothesis memory instead of being stored again.

## 0.2.0 (2026-10-21)

- Pre-tool recall runs before `Read` too, for memories anchored to the file's path.
- `memory_list` browses memories by filter, read-only across projects. `memory_update` edits keywords and anchors with the store's checks.
- The `memory-curate` skill guides cleaning up the store.
- On a ticket branch, session start adds the memories keyed by the ticket id ([Branch-aware session start](docs/recall.md#branch-aware-session-start)).
- An opt-in [statusline badge](docs/statusline.md) on Claude Code.
- The store rejects recall keys the matchers can never hit, and import applies the same authoring rules.

## 0.1.1 (2026-10-15)

- The first session downloads the embedding model in the background. The `download_model` option turns it off, and the doctor shows a running download and its last failure.
- The session says when the plugin's npm dependencies are missing and how to install them.

## 0.1.0 (2026-10-14)

- First release, for Claude Code.
