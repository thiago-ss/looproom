# Looproom

A local macOS workspace for continuous, goal-directed agent work. Give a project an outcome; the coordinator plans, assigns isolated worktrees, verifies changes and brings consequential decisions back to you.

**Working v0.** Real local UI, SQLite state and Codex transport are implemented. Native ChatGPT inference and the GitHub PR/merge flow still need an authenticated end-to-end run. The autoresearch evaluator and Jev integration remain planned; this release does not claim measured self-improvement.

## Run

Requires macOS, Node **22.13 or later**, Git, Codex CLI with named permission profiles (developed against **0.159.2**), and GitHub CLI for publishing PRs. Keep the requested models available on your ChatGPT account.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The coordinator binds only to **127.0.0.1:4319**. Port 4318 is avoided because it commonly hosts local OpenTelemetry receivers.

For the built application:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:4319**. After installing dependencies, double-click `Looproom.command` to build, launch and open the application. This is a local web application; a signed native macOS package is not shipped yet. Keep the coordinator running for continuous work. Sleep, shutdown or closing its terminal interrupts it; preserved work is reconciled on restart.

Configuration environment variables:

| Variable | Default |
|---|---|
| `LOOPROOM_DATA_DIR` | `~/Library/Application Support/Looproom` |
| `CODEX_BINARY` | `codex` on PATH |
| `PORT` | `4319` |

## First project

1. Open an existing Git repository or choose a new folder under an existing parent. Existing repositories need an initial commit. Uncommitted human changes stay in the original checkout; agents start from committed code.
2. Sign in with ChatGPT through Looproom. Codex app-server owns OAuth and refreshes its credentials in an isolated account directory. No unrelated app token is copied. You can finish setup first and connect in Settings.
3. Describe the goal and boundaries. Defaults are **GPT-6.1 Sol / High** for orchestration and **GPT-6 Sol / Medium** for workers, research and independent review. Settings controls future runs; unavailable models produce a gate.
4. Add check commands you authorize inside the task worktree. Start the loop for a read-only plan.
5. Review consequential gates in **Review**. A successful implementation gets checks, an independent review, and a PR. Approve & merge rereads GitHub and submits the displayed head SHA atomically. A changed revision, conflict or pending/failed check blocks merge.

Publishing requires a GitHub `origin` remote, an existing base branch on that remote, and your `gh auth login`. Dependency installation requiring network or other unavailable access becomes a human gate. Package installation has no automatic broad-access fallback.

## Screens

- **Goal:** persistent conversation, current work and contextual decisions.
- **Work:** tasks, acceptance evidence and the actual dependency graph.
- **Agent room:** role identities, real idle/thinking orb states and recorded handoffs.
- **Review:** decision queue, PR diff/checks/reviewer evidence and revision approval.
- **Memory:** project-scoped SQLite FTS5 search and source-linked outcome pages.
- **Settings:** connection, model profiles, project boundaries/checks and pause/stop.

## Execution and memory

One coordinator owns dispatch, SQLite writes and publication. Up to four projects can run concurrently, with one active task per project. Each bounded task has its own worktree. Native nested agents are disabled so every role uses an explicit model profile.

Named Codex permission profiles deny reads outside the assigned workspace and minimum toolchain paths, keep Git metadata read-only, carve out environment/key files and deny direct network access. The native macOS smoke test verifies these boundaries for broker check commands. Model/auth service traffic is separate from worker shell traffic. See [the permission documentation](https://learn.chatgpt.com/docs/permissions).

Completed runs create `wiki/<project-id>/raw/<run-id>.json` with hashes, cited Markdown pages, an index and an append-only content log. Agent reports remain labeled as reports; checks and PR results are separate evidence. SQLite owns live state. Restart pauses interrupted work and opens a recovery gate. The wiki does not store hidden reasoning.

Workflow adaptation and exact v0 boundaries: [Looproom v1](docs/workflows/looproom-v1.md). Original references: [resources](docs/resources.md). Defaults: [model profiles](config/model-profiles.json).

## Verify

```sh
npm test
npm run build
```

Tests cover persistence, scoped search, transaction rollback, crash recovery, worktree preservation/reuse, DAG validation, transport final-message handling, bounded repair, local API authority, revision/check preflight and native macOS sandbox enforcement. Coordinator integration uses a fixture runtime; it makes no model calls or GitHub mutations.

## Remaining work

Authenticated inference and PR round-trip; parallel task workers inside a project; contradiction review and versioned memory synthesis; protected experiment harness and evaluator promotion; Jev comparison against FTS5; accessibility and performance benchmarks with representative projects; signed macOS distribution. Runtime threads are recorded for audit; retries currently use a fresh thread with preserved worktree and project memory.

## License

Looproom's original code is MIT. Incorporated third-party UI has separate terms: **ReactBits MIT + Commons Clause**, **DotMatrix custom product-use license**, and **Orbkit Hydrogen MIT**. This repository incorporates those sources as application UI, not a standalone component library. See [third-party notices](THIRD_PARTY.md) and `licenses/` before redistribution.
