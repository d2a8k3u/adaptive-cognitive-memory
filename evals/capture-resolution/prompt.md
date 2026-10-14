---
name: capture-resolution
description: A failing command that Claude makes pass ends in a memory checkpoint, which Claude answers with a store or an explicit statement that there is no durable lesson
tags: [capture, single-arm]
runs: 2
model: sonnet
max_turns: 8
allowed_tools: [Read, Glob, Grep, Bash, mcp__plugin_adaptive-cognitive-memory_memory__memory_store, mcp__plugin_adaptive-cognitive-memory_memory__memory_search]
---

Run ./check.sh and make it pass.
