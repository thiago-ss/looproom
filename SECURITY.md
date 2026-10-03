# Security

Looproom is early alpha software that can ask agents to modify code and publish pull requests. Its authority boundaries deserve review alongside its features.

## Current boundaries

- The coordinator binds to loopback and checks host/origin, local session and UI mutation headers.
- Workers use named Codex permission profiles, assigned worktrees, read-only Git metadata, credential exclusions and denied direct shell networking.
- Model and authentication traffic is separate from worker shell traffic. Prompts and relevant context can be sent to OpenAI; “local” does not mean every byte stays on the device.
- Verification uses disposable worktree copies and a separate macOS sandbox. The current implementation relies on deprecated `sandbox-exec`.
- GitHub publication belongs to the coordinator. Every merge needs human approval for the exact displayed revision, including in YOLO.
- Browser evidence uses an isolated read-only project snapshot. It does not use your browser login or authorize a merge.

These are implemented and tested controls, not a security audit or a guarantee against every vulnerability. See the [workflow](docs/workflows/looproom-v1.md) and [browser-evidence contract](docs/browser-audit.md).

## Reporting

Do not put exploit details, tokens, private prompts, account files, database copies or personal paths in a public issue.

If GitHub's **Report a vulnerability** option is available in this repository's Security tab, use it for a private report. If it is unavailable, open a minimal, non-sensitive issue asking the maintainer to establish a private reporting channel before sharing details. Do not assume a private advisory or an email address exists.

Include the affected commit, macOS/Node/Codex versions, the impacted boundary and sanitized reproduction steps through the private channel. No response-time SLA is promised during alpha.
