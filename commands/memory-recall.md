---
description: Turn adaptive memory recall on or off for this project
argument-hint: on|off
---

The argument is `$ARGUMENTS`. If it is exactly `on` or `off`, run this Bash and relay its one-line answer; otherwise tell the user the usage is `/memory-recall on` or `/memory-recall off` and run nothing.

```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" recall $ARGUMENTS
```

`off` stops the hooks from injecting memories into this project's sessions (session start, prompts, before tool calls). Capture keeps working: the Stop memory checkpoint and `memory_store` are unchanged, and `memory_search` still answers. `on` restores recall. `memory_status` shows the current switch.
