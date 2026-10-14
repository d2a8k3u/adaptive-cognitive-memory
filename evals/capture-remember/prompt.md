---
name: capture-remember
description: An explicit request to remember leads Claude to store the fact
tags: [capture, single-arm]
runs: 2
model: sonnet
max_turns: 8
allowed_tools: [Read, Glob, Grep, mcp__plugin_adaptive-cognitive-memory_memory__memory_store, mcp__plugin_adaptive-cognitive-memory_memory__memory_search]
---

Remember that the integration tests of this project must run against the staging database host staging-db-2.internal, never against production.
