---
name: pretool-procedure
description: A stored test procedure anchored on pytest is followed when Claude runs the tests
tags: [recall, baseline]
runs: 2
model: haiku
max_turns: 8
allowed_tools: [Read, Glob, Grep, Bash]
---

Run the Python test suite of this project.
