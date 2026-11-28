# Security policy

## Supported versions

Security fixes go into the latest release only. Before you report, update the plugin (`claude plugin update adaptive-cognitive-memory@construct` on Claude Code) and check that the problem is still there.

## Report a vulnerability

Report it privately through the [vulnerability reporting form](https://github.com/d2a8k3u/adaptive-cognitive-memory/security/advisories/new) on GitHub. Only you and the maintainers see the report. Do not open a public issue, pull request or discussion about it.

Report anything that breaks what the plugin promises about your data:

- Memory content leaves your machine. The only network request the plugin makes is the [embedding model download](docs/install.md#embedding-model).
- A secret survives redaction when a memory is stored or exported.
- A `project` memory is recalled in another project.

Include the plugin version, the host and its version (Claude Code, Codex or OpenCode), the Node.js version, the OS and the smallest steps that show the problem. Use made-up memory content and secrets, never real ones.
