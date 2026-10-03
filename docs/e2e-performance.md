# End-to-end and stress verification · 2026-10-02

This report covers the application worktree based on published revision `8ca5f69`. The test coordinator used isolated fixture data and a fixture GitHub CLI for mutating PR paths. It did not approve or merge a live PR or copy account files into the repository. The later live YOLO correction, authorized by the user, updated project continuation instructions and requested a native judge reassessment; it is recorded separately from fixture verification. Two read-only, authenticated Codex turns tested the requested orchestrator and worker profiles separately from the fixture runtime.

## What was exercised

| Surface | Evidence and result |
| --- | --- |
| Coordinator | Repeated ticks reserved at most four of 20 independent tasks while a scoped gate held its task and dependent. Pause stopped new dispatch; restart preserved an interrupted task and YOLO judge gate. Tests also covered API session/origin checks, typed record IDs, concurrent writes, SSE reconnect, and complete state after coordinator restart. |
| PR authority | Generic PR gate resolution is rejected. **Request changes** checks the displayed SHA against the open GitHub head, records human feedback, and returns only that task to ready. Concurrent approve/request changes calls cannot both proceed. Approval still needs the exact head, successful checks and mergeability; a duplicate submission makes one merge request. A lost PR creation response can reuse only an open PR with the expected head and base. These GitHub paths used fixture responses. |
| YOLO | A fixture gate with three discarded candidates resumed through the judge with a distinct bounded round, preserved prior evidence and the frozen evaluator, and produced zero merge approvals. Unavailable capabilities remain blockers. This test checks policy and routing, not the quality of a future experiment. |
| Frozen baseline handoff | Candidate worktrees receive an immutable copy before a task run. The handoff checks project ownership, report identity, source hash, unchanged source and a successful measurement result; it refuses symlinks or conflicting bytes and leaves the candidate's `latest.json` untouched. A regression covers idempotent copying, conflicts, cross-project refusal and missing coordinator reports. A missing report raises an explicit blocker; measurements are never fabricated. |
| State and shutdown recovery | The browser reads state before opening one SSE stream. A terminal stream error closes it, rereads state for a fresh session, and retries with bounded backoff; cleanup cancels late reads and reconnects. SQLite runs `PRAGMA quick_check` before schema/default writes and leaves damaged test bytes untouched on failure. In a SIGTERM fixture, the coordinator closed an open SSE stream and SQLite, checkpointed its WAL, and reopened with durable state. The development supervisor sends termination to both server and Vite children, with a bounded force-stop fallback; that supervisor path was reviewed in source, not measured by the SIGTERM fixture. |
| Native and browser | Existing native macOS tests enforced worker and verification boundaries. Two simultaneous **read-only** Codex turns completed with GPT-6.1 Sol / High and GPT-6 Sol / Medium; neither wrote files. Browser checks exercised onboarding and native folder picker cancellation/selection, Goal, Work, Review, Agent room, 390/800/1280 px widths, an eight-gate burst producing one project toast, and recovery from a deliberately missing lazy chunk with one Alert and all five orbs restored. Synthetic records were used for screen coverage. |

The latest integrated run passed **68 tests, zero failures, zero skips**. The final integrated `npm run build` and `npm run check:ui` checks also passed after the recovery changes. The regression files and fixture harnesses are in `server/*.test.ts` and `scripts/state-stress.ts`; the browser and native observations were captured in separate test evidence. Test results do not establish that every model decision or live GitHub operation will succeed.

## State and SSE load

The fixed fixture had four paused projects, 1,000 tasks, 1,000 messages, 1,000 runs containing 1 KB hidden output each, and 2,000 stored events (the API returns the newest 80). Each process made 40 sequential `/api/state` reads with 32 authenticated SSE clients, posted a message, confirmed the next state contained it, and observed a notification on **all 32 clients**. Run output stayed absent from the state response. Original and modified processes were alternated. [Selected run summaries](benchmarks/2026-10-02/state-api.json) retain medians, p95, response sizes and notification counts without local paths or account metadata.

| Variant | State median across repeated process runs | State p95 | SSE median |
| --- | --- | --- | --- |
| Original | 7.79, 8.70, 7.96 ms | 8.59–9.62 ms | 162.24–165.08 ms |
| Modified | 1.05–2.94 ms across seven runs | 1.69–12.38 ms | 163.48–180.02 ms |

The lower state median repeated across the process runs. The same-path original and modified responses were both **402,449 bytes**. Two original runs from a longer temporary checkout were 402,465 bytes because a fixture error included that checkout path; record counts and data contract matched. The original server produced a Node listener warning with 32 SSE clients; the modified server used one shared engine listener and heartbeat and produced no such warning. **No p95 or SSE latency improvement is claimed.** This local fixture is not a representative user workload or a production latency service-level measurement.

## Built assets

Node gzip measurements of the Vite build are in [selected bundle sizes](benchmarks/2026-10-02/bundle-sizes.json). “Initial” means JS and CSS referenced directly by `dist/index.html`, excluding fonts and lazy chunks.

| Measure | Original | Modified | Difference |
| --- | ---: | ---: | ---: |
| Initial JS + CSS gzip | 240,143 B | 231,526 B | −8,617 B (−3.59%) |
| All JS gzip | 283,164 B | 286,709 B | +3,545 B |

The onboarding route now loads another 10.40 kB gzip JS and 2.30 kB gzip CSS when opened. The measured entry reduction applies to an existing-project opening; **no all-onboarding transfer or page-load gain is claimed**. The main minified entry chunk still triggers Vite’s **over 500 kB** advisory. No frame-rate, CPU/GPU or accessibility benchmark was made.

## Remaining boundaries

The native turns were read-only. PR creation, revision rejection and merge tests used fixture GitHub responses; this run did not exercise a live approval or merge. The browser checks used synthetic screen data and a deliberately broken chunk, not a full native agent-to-PR workflow. The state measurements use one large local dataset and sequential reads, so other data shapes and devices may behave differently. The autoresearch evaluator was not changed and these timings are not a self-improvement score.

A separate live recovery found a damaged SQLite main file and truncated WAL. Its cause was not established. The fixture integrity and clean-shutdown tests show fail-closed startup and orderly termination under their tested conditions; they do not prove that the live damage cannot recur.
