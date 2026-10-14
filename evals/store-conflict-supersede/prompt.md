---
name: store-conflict-supersede
description: A changed single-valued fact goes through the two-phase store and supersedes the stored value
tags: [capture, single-arm]
runs: 2
model: sonnet
max_turns: 8
allowed_tools: [Read, Glob, Grep, mcp__plugin_adaptive-cognitive-memory_memory__memory_store, mcp__plugin_adaptive-cognitive-memory_memory__memory_search, mcp__plugin_adaptive-cognitive-memory_memory__memory_get]
---

Remember this: we finished the migration, and the project's primary database is now PostgreSQL 16.
