# Install and uninstall

## Requirements

Claude Code and Node.js ≥ 22.

## Install

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

### From a local checkout

A checkout loaded in place — `claude --plugin-dir /path/to/adaptive-cognitive-memory`, or a marketplace added from a local path — gets no automatic install. Run once in the checkout:

```bash
npm ci --ignore-scripts
```

## Embedding model

The first session downloads the embedding model by itself: `onnx-community/granite-embedding-97m-multilingual-r2-ONNX`, int8, about 120 MB, once, into the plugin data directory. It is the only network operation the plugin performs, and it never touches memory content. The download runs in the background, so the session starts at once with a notice; until it finishes, prompts recall nothing (session-start and pre-tool recall need no model), `memory_search` matches keywords only, and new memories are stored without a vector — the next memory server start embeds up to 32 of them, `reembed` the rest. A failed download is retried at every session start, whose notice then names the failure.

To keep the plugin off the network, turn the `download_model` option off (`/config`, or `claude plugin configure adaptive-cognitive-memory`) and cache the model yourself:

```bash
CLAUDE_PLUGIN_DATA="<plugin data dir>" node dist/cli.js model-init
```

Then run `/memory-doctor`. It prints a JSON health report; exit code 1 means a check failed. Its `model` check shows a running download, the last failed one, and the command above with the paths filled in.

## Uninstall

The database lives in `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`), outside the versioned plugin directory, so it survives plugin updates. **Uninstalling the plugin from the last scope it is installed at deletes that directory.** Export first and keep the data:

```bash
CLAUDE_PLUGIN_DATA="<plugin data dir>" node dist/cli.js export ~/memory-backup.jsonl
claude plugin uninstall adaptive-cognitive-memory --keep-data
```

The doctor's `data_retention` check warns while the database sits in the plugin data directory with no export in the last 30 days. With the statusline badge on, also run `/memory-statusline off` and remove its line from your statusline script first (see [Statusline badge](statusline.md)).
