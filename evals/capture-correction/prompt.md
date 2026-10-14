---
name: capture-correction
description: A user correction about how to work leads Claude to store the rule and its reason
tags: [capture, single-arm]
runs: 2
model: sonnet
max_turns: 8
allowed_tools: [Read, Glob, Grep, mcp__plugin_adaptive-cognitive-memory_memory__memory_store, mcp__plugin_adaptive-cognitive-memory_memory__memory_search]
---

Stop editing CHANGELOG.md by hand in this project: the release script generates it from the commit subjects, so a manual entry ends up duplicated in the next release.
