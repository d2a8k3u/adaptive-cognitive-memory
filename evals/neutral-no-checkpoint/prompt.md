---
name: neutral-no-checkpoint
description: A neutral turn triggers no memory checkpoint and no store
tags: [capture, single-arm]
runs: 2
model: sonnet
max_turns: 8
allowed_tools: [Read, Glob, Grep, Bash, mcp__plugin_adaptive-cognitive-memory_memory__memory_store, mcp__plugin_adaptive-cognitive-memory_memory__memory_search]
---

How many files are in this workspace? List their names.
