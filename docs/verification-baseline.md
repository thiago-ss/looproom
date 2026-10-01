# Local verification and refresh baseline

## Frozen evaluator (2026-09-30, before any refresh candidate)

Evaluator: `scripts/measure-refresh.ts`. The original measured revision had
SHA-256 `9a750960adcea0556fc5552e25642e238dab34670599c059fedf1ef79ce4eeae`.
The setup-cleanup repair has SHA-256
`ec72c39beda16d1906aa92fdea71e89c56125477c2ca986406e3d6bf68ca0858`.
Its workload identities, repetitions, metrics, runtime budget and keep/discard
rule are unchanged. The coordinator baseline for this revision is recorded below.
The fixed evaluator and baseline-first rule are adapted from
[autoresearch's primary program](https://github.com/karpathy/autoresearch/blob/master/program.md).
Changing the evaluator requires a new baseline and recorded hash; scores from
different evaluator versions are not comparable.

- Workload identities: `benchmark-project-0` through `benchmark-project-3`;
  12 completed tasks and 20 events per project; five numbered message updates
  to `benchmark-project-0`. Projects are paused during measurement.
- Repetitions: five. Runtime budget: 30 seconds for the measurement run.
- Metrics: median uncompressed `/api/state` response bytes; median time from
  local HTTP request start through body read (a coordinator round trip proxy,
  not server CPU time); median time from message POST start until the matching
  SSE `changed` event. The first session request is excluded.
- Keep/discard rule: require the existing test suite and native sandbox check
  to pass; keep a candidate only if at least one median improves by 10% or
  more and none of the other medians regresses by more than 5%. Otherwise
  discard it. Use the same toolchain and host for baseline and candidate.
  Do not change the evaluator to improve a candidate score.

## Coordinator baseline and verification (2026-10-01 UTC)

The coordinator ran the frozen evaluator in a disposable isolated copy of
this worktree. The matching record is
`.looproom-verification/6cdbec25-30fd-440c-8f47-54aaf68a494d.json`,
run `6cdbec25-30fd-440c-8f47-54aaf68a494d`, with source hash
`2d6f0cb1dc5d482085a6f4b2c529f2f30c7d097a95a6f7cde1f7b4fb4ba9c0d5`,
`sourceUnchanged: true`, and evaluator exit status 0. That same report records
exit status 0 for `npm run build` and `npm test`: 11 passed, 0 failed,
including the native macOS sandbox denial test. These are coordinator results,
not successful direct worker-shell runs.

A later, separate report,
`.looproom-verification/3971e0eb-8291-462e-b0c3-0166be66db92.json`,
run `3971e0eb-8291-462e-b0c3-0166be66db92`, records build and test exit
status 0 with 12 passed, 0 failed, including native macOS denial. Its source
hash is `906c31a0d341034aed69bac752fb2114749468cec078381248d4bac48a36f403`.
It also records `fixtureCleanup.removed: true` for the assigned worktree's
`.looproom-test-fixtures/` directory. That directory is now absent. This later
report is not a benchmark of its own source revision.

| Metric | Five raw observations, in run order | Median |
|---|---|---:|
| Refresh response bytes | 19046, 19195, 19345, 19495, 19645 | 19345 bytes |
| Coordinator round trip | 1.724750, 1.289583, 4.009000, 3.606792, 5.084042 ms | 3.606792 ms |
| Update latency | 158.459083, 154.289125, 157.143875, 155.002708, 156.699375 ms | 156.699375 ms |

The table above belongs to the original evaluator revision. The later report
separately documents cleanup of the assigned worktree's pre-existing fixtures.
Another coordinator report,
`.looproom-verification/ceaaa5dc-dba0-4da6-b699-1776ae7ef078.json`, records
build and all 12 tests passing plus an original-evaluator baseline of 19345
refresh bytes, 1.540000 ms coordinator round trip and 152.701916 ms update
latency. It predates the setup-cleanup repair and is not verification of its
new hash. No optimization candidate was measured or kept.

For the cleanup revision, a historical direct worker attempt to run
`node_modules/.bin/tsc --noEmit` failed with `MODULE_NOT_FOUND`. This checkout
now contains `node_modules/.bin/tsc` as a symlink. A prior read-only worker
session could not resolve its target; this worker session has not verified that
the executable is usable.
`git diff --check` passed, and the ignored fixture directory is absent. The
coordinator's recorded `npm run build`, `npm test` and repaired evaluator results
are documented below, separately from those direct worker attempts.

## Repaired evaluator baseline (2026-10-01 UTC)

The repaired evaluator has SHA-256
`ec72c39beda16d1906aa92fdea71e89c56125477c2ca986406e3d6bf68ca0858`,
confirmed against `scripts/measure-refresh.ts` with Node's SHA-256 implementation.
The coordinator's `refresh-baseline` run
`.looproom-verification/9e8af822-2198-42e6-8985-21153f06298d.json`
exited 0, reports `sourceUnchanged: true`, and records source hash
`b49ce41276b05b14dadd1fb5009d02a32198254b8162eb25c23cfd99404d8047`.
The five observations below are in run order.

| Metric | Five raw observations, in run order | Median |
|---|---|---:|
| Refresh response bytes | 19046, 19195, 19345, 19495, 19645 | 19345 bytes |
| Coordinator round trip | 3.668333, 1.760375, 1.571458, 1.834792, 1.512666 ms | 1.760375 ms |
| Update latency | 167.543041, 154.574542, 153.301084, 153.743417, 153.623083 ms | 153.743417 ms |

The earlier broker report
`.looproom-verification/1501023a-6294-48bb-a55e-7c40d707aa19.json`
has the same source hash and `sourceUnchanged: true`; it records exit status 0
for `npm run build` and `npm test`, with 12 passed and 0 failed, including the
native macOS sandbox denial test. The assigned worktree's ignored fixture
directory is absent. These results establish the baseline for this evaluator
revision; no optimization candidate was measured or kept.

## Assigned worker limits (2026-09-30)

Direct worker-shell attempts are distinct from the coordinator results above.
`npm run build` and `npm test` exited 255 without results. A direct test run
reported 2 passes and 9 failures: eight worktree-local fixture cleanups failed
at `rmdir EPERM`, and the native denial test failed at `spawn EPERM` before its
assertions. The direct evaluator could not bind loopback (`listen EPERM`) and
produced no measurements. Direct TypeScript checking and `git diff --check`
exited 0. Node 25.8.0, Apple Git 2.50.1 and Codex CLI 0.159.2 were callable;
`gh` was absent from PATH, so the GitHub round trip prerequisite remains
missing. No tools were installed.

The fixtures use ignored `.looproom-test-fixtures/` under this worktree.
Historically, 140 disposable directories remained under that root, and direct
removal of the empty `probe-empty` directory returned `EPERM` in the worker
sandbox. The coordinator subsequently removed the fixture root under its
existing authority, as recorded in run
`3971e0eb-8291-462e-b0c3-0166be66db92`; it is absent in this worktree.
`server/permissions.ts` continues to deny `:tmpdir`, `:slash_tmp`, direct
network access and workspace secret paths, with Git metadata read-only.
The recorded native test verified those worker denials in its isolated copy.
The coordinator's isolated-copy check did not widen the worker
profile. The npm permission path expands to the package root only for the
recognized `npm/bin/npm-cli.js` layout; other layouts receive an exact file
read grant.


## Integrated application baseline (2026-10-01 UTC)

The PR branch now incorporates the current application base and the YOLO recovery
fixes. The evaluator remains `ec72c39beda16d1906aa92fdea71e89c56125477c2ca986406e3d6bf68ca0858`.
Report `902097c9-9862-4933-85b5-f80bb0c71759` records source hash `fda70635feba4371c666f955a15a643815d1474e125954846a2a54fcae1e675d`,
unchanged source, and exit 0 for build, tests and measurement. The measurements
above are historical observations of the earlier application revision. These new
figures are the baseline for the integrated application; no optimization
improvement or cross-revision score comparison is claimed.

| Metric | Five raw observations | Median |
|---|---|---:|
| Refresh bytes | 19094, 19243, 19393, 19543, 19693 | 19393 |
| Coordinator round trip (ms) | 5.417042, 2.365084, 2.300458, 1.997375, 1.682042 | 2.300458 |
| Update latency (ms) | 171.240459, 153.582625, 153.231958, 152.147625, 153.283458 | 153.283458 |

The host suite passes all 42 tests with zero skips, including native verifier
isolation. The isolated coordinator suite passes 41 tests with zero failures;
its pre-existing guard skips the verifier-within-verifier isolation case to
avoid nested Seatbelt application. The native worker denial test still runs
and passes there. The coordinator handoff test uses a fixture verifier that
checks the actual fixture output; native boundaries are tested separately.
After base integration, an outdated dependency copy was replaced with the
existing local dependency tree only after exact lockfile matching, with no
network installation or lifecycle scripts. No worker capability was granted.

This report fingerprint precedes the documentation of its own results. Final
configured checks separately verify the documented publication source. Runtime
evidence stays in ignored, ID-addressed report history and is not published as
source code. Any merge requires human approval of the updated PR head.
