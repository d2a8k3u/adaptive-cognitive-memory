# Statusline badge (Claude Code only)

Codex and OpenCode have no statusline badge. On Claude Code the badge files live in `statusline/` under the store's data directory: the shared directory after the [store move](storage.md#moving-the-claude-code-store), or `${CLAUDE_PLUGIN_DATA}` before it. `<plugin data dir>` below stands for that data directory; the line the command prints carries the real path.

The badge is opt-in: until you run `/memory-statusline on`, no hook or command writes a statusline file. `on` installs a small shim and an enabled marker in `<plugin data dir>/statusline/` and prints one line for your own statusline command; the badge never reads or writes any `settings.json`. While the badge is on, each recall hook (session start, prompt, pre-tool) writes its session's badge state there: one file per session, replaced atomically, so a reader never sees a torn file. Session start prunes state files older than 30 days and reinstalls the shim after a plugin update.

The badge is one line of at most 40 characters, `mem <n> · last <event> <hh:mm>` (the distinct memories injected in this session, the last recall event and its local time), or `mem off` while recall is off for the project. The shim reads only node built-ins and its own files, never the database. It prints nothing and exits 0 when there is nothing to show: badge off, unknown session, missing or unreadable state, malformed stdin.

Used alone as the `statusLine` command, the line works as printed:

```bash
{ test -f "<plugin data dir>/statusline/badge.cjs" && node "<plugin data dir>/statusline/badge.cjs"; } || :
```

In a script that reads the statusline's stdin once (`input="$(cat)"`) and hands it to several commands, replay it into the line:

```bash
printf '%s' "$input" | { test -f "<plugin data dir>/statusline/badge.cjs" && node "<plugin data dir>/statusline/badge.cjs"; } || :
```

`/memory-statusline off` stops the writes, removes `<plugin data dir>/statusline/` and prints the same line for you to remove. The store move prints the `statusLine` command for the new shim path when the badge is on; set it, since the shim path changes with the data directory. Before the move, uninstalling deletes the plugin data directory, so before you uninstall, run `/memory-statusline off` and remove the line from your statusline script.
