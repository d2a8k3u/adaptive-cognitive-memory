---
name: cross-project-no-leak
description: A project-scoped fact of another project never reaches this project
tags: [recall, single-arm]
runs: 2
model: haiku
max_turns: 8
allowed_tools: [Read, Glob, Grep, mcp__plugin_adaptive-cognitive-memory_memory__memory_search, mcp__plugin_adaptive-cognitive-memory_memory__memory_get]
---

Which Stripe API version does our billing code pin?
