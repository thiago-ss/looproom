# Looproom

A local macOS workspace for continuous, goal-directed agent work. Give a project an outcome; the coordinator plans, assigns isolated worktrees, verifies changes and brings consequential decisions back to you.

**Working v0.** Real local UI, SQLite state and Codex transport are implemented. Authenticated GPT-6.1 Sol / High planning and GPT-6 Sol / Medium implementation turns have completed. The native independent-review and GitHub PR/merge flow still need an end-to-end run. The autoresearch evaluator and Jev integration remain planned; this release does not claim measured self-improvement.

## Run

Requires macOS, Node **22.13 or later**, Git, Codex CLI with named permission profiles (developed against **0.159.2**), Apple Command Line Tools for compiling the native folder picker, and GitHub CLI for publishing PRs. Keep the requested models available on your ChatGPT account.

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

Publishing requires a GitHub `origin` remote, an existing base branch on that remote, and your `gh auth login`. For npm projects, identical lockfiles let the broker copy the existing local node_modules into a fresh task worktree without network or lifecycle scripts. Different locks or missing dependencies requiring installation become a human gate. Package installation has no automatic broad-access fallback.

## Screens

- **Goal:** persistent conversation, current work and contextual decisions.
- **Work:** tasks, acceptance evidence and the actual dependency graph.
- **Agent room:** four distinct Orbkit identities in a selectable workflow map, live role inspector, task links and recorded handoffs.
- **Review:** decision queue, PR diff/checks/reviewer evidence and revision approval.
- **Memory:** project-scoped SQLite FTS5 search, compact outcome library, Markdown reading pane and cited-source connections.
- **Settings:** connection, shadcn model controls, project boundaries/checks, escalation sound and opt-in desktop alerts. A decision inbox remains available in the header.

## Folder selection and alerts

Choose folder opens a native macOS NSOpenPanel. Finder drops pass only folder names/URLs to the authenticated local broker; it resolves the drag pasteboard without uploading folder contents. Browsers that conceal the dropped path open the native picker as confirmation. New projects choose a parent folder and an editable new child path. Cancel preserves the draft. The small Swift helper is compiled locally on first use and cached by source hash in application data; it is not a signed distribution package.

New open gates produce a Sonner toast with a Review action and a two-note Web Audio chime after browser audio is unlocked by interaction. The persistent header inbox shows all open decisions. Desktop notifications are opt-in in Settings and need browser permission; unsupported/blocked browsers retain inbox and sound. Keep the app and coordinator open. Preferences and delivered-gate IDs are saved for this browser; history does not replay on startup, and Web Locks deduplicate alerts across supported same-origin tabs.

## Execution and memory

One coordinator owns dispatch, SQLite writes and publication. One to four concurrent workflows share capacity across planning, task pipelines and judges; independent ready tasks can run within the same project. Task gates block only affected work and its actual dependents. Runtime wiki writes are serialized per project. Each bounded task has its own worktree. Native nested agents are disabled so every role uses an explicit model profile.

Named Codex permission profiles deny reads outside the assigned workspace and minimum toolchain paths, keep Git metadata read-only, carve out environment/key files and deny direct network access. The native macOS smoke test verifies these worker boundaries. Model/auth service traffic is separate from worker shell traffic. See [the permission documentation](https://learn.chatgpt.com/docs/permissions).

Completed runs create `wiki/<project-id>/raw/<run-id>.json` with hashes, cited Markdown pages, an index and a chronological content log. Run completion and its durable ingestion intent commit together; restart repairs incomplete wiki writes without changing raw captures. Structured claim revisions retain conflicting source references and explicit unresolved status. Agent proposed supersession stays unresolved until independent evidence can establish it. Checks and PR outcomes are separate evidence attached to their originating run in Memory. SQLite owns live state. Restart pauses interrupted work and opens a recovery gate. The wiki does not store hidden reasoning. Reconciliation with the original parent wiki remains pending because runtime workers cannot access it.

Workflow adaptation and exact v0 boundaries: [Looproom v1](docs/workflows/looproom-v1.md). Original references: [resources](docs/resources.md). Defaults: [model profiles](config/model-profiles.json).

## Verify

```sh
npm test
npm run check:ui
npm run build
```

Forty-two tests cover scoped gates, concurrent reservation, attributed judge replies and preserved human merge authority, persistence, scoped search, transaction rollback, crash recovery, worktree preservation/reuse, DAG validation, transport final-message handling, bounded repair, local API authority, revision/check preflight and native macOS sandbox enforcement. Coordinator integration uses a fixture runtime; it makes no model calls or GitHub mutations.

## Remaining work

Native independent review and PR round-trip; simultaneous native task/PR pipelines; semantic contradiction review beyond structured claim keys and parent-wiki reconciliation; protected experiment harness and evaluator promotion; Jev comparison against FTS5; accessibility and performance benchmarks with representative projects; signed macOS distribution. Runtime threads are recorded for audit; retries currently use a fresh thread with preserved worktree and project memory.

## License

Looproom's original code is MIT. Incorporated third-party UI has separate terms: **ReactBits MIT + Commons Clause**, **DotMatrix custom product-use license**, and **Orbkit original shaders MIT**. This repository incorporates those sources as application UI, not a standalone component library. See [third-party notices](THIRD_PARTY.md) and `licenses/` before redistribution.

Goal fills the viewport and scrolls within the conversation. Work offers a grouped frontier/search and dependency graph; Review offers decision dossiers and revision-bound confirmation. All interactive form controls and disclosures use the shared shadcn layer.

## Product identity

The current interface uses continuous plum surfaces, soft citron actions and readable supporting text. Selected items use tonal fills; keyboard focus retains a visible outline. See [identity rules and verification](docs/identity-v2.md).

Goal preserves linked escalation requests and replies, including migrated history. Human messages use a single byline; the composer can answer a selected non-PR gate directly. Settings → Project boundaries offers Human review (judge draft), Judge bypass (routine automatic decisions), and YOLO (judge drafts and sends every non-PR reply). Its model is configured separately in Settings. Assessment is read-only; YOLO can attempt recovery in the existing task worktree under unchanged worker permissions. Submitted capability blockers remain blocked while independent work continues; every PR merge needs human approval. Native GPT-6 Sol / Medium judge inference was verified on an isolated routine-choice gate; no PR or live gate was approved by that test.

## Component development

Use Arc for shared interactive controls and feedback. [MCP setup, component coverage and identity rules](docs/arc-ui.md). `npm run check:ui` rejects native controls outside the Arc sources.

YOLO keeps PRs in your review inbox, while other escalations are handled by the judge. The response includes task-specific evidence and actionable next steps. Three task retries bound each recovery round. Unresolved YOLO blockers recheck after 5/10/20/30 minutes; three judge transport attempts use 15/30-second backoff followed by a 30-minute cooldown. Recovery may repair files and verify available alternatives in the task worktree; the coordinator never dispatches a worker while recovery still owns that worktree. Drafts are never worker instructions; submitted replies are recorded in SQLite and the goal chat. No mode grants unavailable capabilities or guarantees perfect judgments.

## Isolated verification

Configured checks run in disposable copies of task worktrees through a separate macOS verification sandbox. It permits child processes, fixture cleanup and loopback test servers; Internet access, coordinator ports, original checkout writes and known credential files remain denied. The environment is filtered and the home is empty. Dependencies must be local; external dependency links are normalized into the copy or rejected. Checks see synthetic, read-only Git metadata rather than the live repository's history.

Reports record actual commands, exit codes, timeout status, durations and the original source fingerprint in `verification/<id>.json` under the data directory. Workers can read `.looproom-verification/latest.json` and immutable `<report-id>.json` history; this runtime evidence is excluded from publication. YOLO judges can request configured checks or the pinned refresh baseline, then reassess the real results. Worker permissions and human approval of PR merges remain unchanged.

The v0 runner uses macOS `sandbox-exec`, which is deprecated. Native sandbox denial tests use a private socket to request the existing worker policy in a sibling sandbox, because macOS rejects nested policy application. Caller-supplied permission profiles are ignored. Normal timeouts terminate process groups and cancel native test children. A signed sandboxed runner and crash-proof process supervision remain packaging work.

YOLO may explicitly request `cleanup-test-fixtures` to remove only the reserved `.looproom-test-fixtures` scratch directory in the assigned worktree, then run configured checks. The coordinator rejects a symlinked root and does not follow nested links. This recorded housekeeping action is separate from test process permissions. Earlier reports remain readable by ID when later checks run.

Baseline setup repairs require independent source comparison and fresh coordinator measurements. Original evaluator bytes and hash revisions are retained; missing or modified snapshots fail closed. Once accepted, the baseline freezes for subsequent candidates. Refused verification recipes enter YOLO recovery with the actual error instead of the model transport cooldown. This does not grant worker capabilities, bypass review, or authorize a PR merge.
