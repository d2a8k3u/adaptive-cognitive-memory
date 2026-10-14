---
name: supersession-current-fact
description: After a supersession, Claude answers with the current fact, never the revoked one
tags: [recall, baseline]
runs: 2
model: haiku
max_turns: 8
allowed_tools: [Read, Glob, Grep, mcp__plugin_adaptive-cognitive-memory_memory__memory_search, mcp__plugin_adaptive-cognitive-memory_memory__memory_get]
---

Which database engine and version does this project's primary database run? Answer in one short sentence.
