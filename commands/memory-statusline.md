---
description: Turn the adaptive memory statusline badge on or off and print the line for your own statusline script
argument-hint: on|off
---

The argument is `$ARGUMENTS`. If it is exactly `on` or `off`, run this Bash and relay its one-line answer exactly; otherwise tell the user the usage is `/memory-statusline on` or `/memory-statusline off` and run nothing.

```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" statusline $ARGUMENTS
```

The answer is one shell line. This command never reads or writes any `settings.json`; the user wires the line into their own statusline command.

- `on`: the hooks start writing the badge `mem <n> · last <event> <hh:mm>` (or `mem off` while recall is off for the project). Tell the user to add the line to their statusline command so it receives the statusline's stdin JSON. Used alone as the `statusLine` command, the line works as printed. In a script that reads stdin once (`input="$(cat)"`), add it as `printf '%s' "$input" | <the line>`. The line prints nothing when the badge has nothing to show and always exits 0.
- `off`: the hooks stop writing and the plugin's statusline files are removed. Tell the user to remove the line from their statusline script. Run `off` and remove the line before uninstalling the plugin.
