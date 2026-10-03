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

## Refresh experiment candidate 1 (2026-10-01)

**Status: discarded as a standalone candidate.** `src/lib/refresh.ts` and
`src/App.tsx` serialize `/api/state` reads, coalesce triggers that arrive during
an active read into one follow-up, and ignore an earlier response when a newer
trigger is pending. The initial read, SSE notifications, 15-second fallback
poll and action refreshes all use the same path. This is a bounded change to
the existing UI path; the server response and FTS5 retrieval are unchanged.

The direct `server/refresh.test.ts` run passed all three focused cases:
overlapping responses, retry after a failed read, and disposal during a read.
Direct `node scripts/check-ui.mjs`, `node node_modules/typescript/bin/tsc
--noEmit`, and `git diff --check` passed. The worker
could not collect candidate benchmark numbers: the frozen evaluator's loopback
server failed to bind with `EPERM`, and fixture cleanup also failed with
`EPERM`. `npm run typecheck` and `npm run check:ui` exited 255 in this worker;
the direct UI checker and direct TypeScript compiler passed, while the
`tsc` launcher symlink target was unreadable.
The judge discarded this candidate under the frozen keep rule because the
evaluator cannot measure browser-side request coalescing. Its code was included
in candidates 2 and 3, which were judged as integrated changes against the
same baseline. The client refresh path remains for the task's stale-response,
reconnect and fallback-polling correctness requirements; it is not a kept
measured optimization.

The frozen evaluator measures direct `/api/state` response bytes, coordinator
round trip and POST-to-SSE latency. It does not run the browser's refresh path
or count its state requests. Therefore those measurements cannot establish
that this UI-only candidate clears the 10% improvement rule. No score or
keep decision is claimed from the focused tests. The repository has no
project wiki directory in this assigned worktree; the development coordinator
maintains the original design wiki outside the worker workspace. This entry
is the source-backed experiment record available for coordinator synthesis.

## Refresh experiment candidate 2 (2026-10-01)

**Status: discarded.**
`server/state.ts` caches the exact serialized `/api/state` snapshot between
Store writes and runtime-status changes. Store write methods advance an
in-process revision; a rolled-back transaction can cause an extra rebuild but
cannot preserve a rolled-back state in the cache. The response fields and
FTS5 retrieval path are unchanged. Candidate 2 includes the client
coalescing and stale-response protection from discarded candidate 1, so the
keep rule applies to the integrated application as a whole.

The direct focused run passed four tests covering coalescing, failed-read
retry, disposal, cache invalidation after writes and rollback, and runtime
status changes. Direct TypeScript compilation, the UI checker and
`git diff --check` exited 0. The evaluator source was not edited. The
coordinator's immutable report
`.looproom-verification/f17c8b66-d70a-4349-81b9-a590d022d0d5.json`
records build, UI check and evaluator exit 0; 45 tests passed, none failed,
and the verifier-within-verifier isolation test was skipped. Its candidate
medians were 19,393 refresh bytes, 2.711375 ms round trip, and 154.657542 ms
update latency. Relative to the **documented** integrated baseline above,
bytes were unchanged, round trip regressed 17.9%, and update latency
regressed 0.9%. No metric improved by 10%, and round trip exceeded the 5%
regression limit. The cited integrated baseline JSON is absent from this
worktree, so its figures are not independently inspected here. The snapshot
cache and Store revision changes were removed for candidate 3. This is
candidate 2 of at most three.

## Refresh experiment candidate 3 (2026-10-01)

**Status: discarded.** Candidate 3 made the existing `/api/state` query
include the 80 most recent event records only for `?events=1`; the Agent room
requested that option. Other state refreshes returned `events: []`. The
client coalescing and stale-response guard from candidate 1 were part of this
integrated candidate. [SQLite FTS5](https://www.sqlite.org/fts5.html) and the
supplied UI components and license notices were unchanged.

The frozen evaluator remains at SHA-256
`ec72c39beda16d1906aa92fdea71e89c56125477c2ca986406e3d6bf68ca0858`.
The coordinator's immutable measurement report
`.looproom-verification/c91bae1c-a7bc-4d50-9d46-b2fee0f4eb1e.json`
records `sourceUnchanged: true`, source hash
`bb41f0fad317de3d885ab646cc0fc4b108b4a1fd50ddc8a00d668e2fa8237d2e`
and evaluator exit 0. Its five raw observations and medians are:

| Metric | Five raw observations, in run order | Median | Change from documented integrated baseline |
|---|---|---:|---:|
| Refresh bytes | 8504, 8665, 8827, 8989, 9151 | 8827 | 54.5% lower |
| Coordinator round trip (ms) | 2.771375, 1.578250, 3.176875, 2.795167, 3.508083 | 2.795167 | 21.5% higher |
| Update latency (ms) | 164.522125, 154.910125, 155.254459, 155.084833, 154.677792 | 155.084833 | 1.2% higher |

The integrated baseline figures above are documented, but its cited JSON is
absent from this worktree and was not independently inspected here. The
coordinator's matching configured-checks report
`.looproom-verification/e3a5d5c8-7b0e-4fb4-a722-457543e47941.json`
records build and UI check exit 0, and 44 test passes, zero failures and one
skipped verifier-within-verifier isolation test. The byte reduction clears the
10% improvement threshold, but the 21.5% round-trip regression exceeds the
frozen 5% limit, so the whole candidate fails the keep rule. The event query
change and its API test were removed after this measurement. The client
refresh path remains only for the required stale-response, reconnect and
fallback-polling behavior. The candidate 3 reports do not verify the source
revision after removal.

For the final source after removal, the three focused refresh tests, direct
TypeScript compilation, direct UI checker and `git diff --check` exited 0 in
the worker. `npm run check:ui` exited 255 under the worker sandbox, while its
direct `node scripts/check-ui.mjs` command passed. The direct API test reached
fixture cleanup and failed at `rmdir EPERM`; it provides no test result for
this final source. The coordinator's later isolated report
`.looproom-verification/071ee51a-16bd-4f0c-a10c-17e10720e77f.json`
records `sourceUnchanged: true` for the post-removal source hash
`0183b29e13b80696cd6ed4e08eaf0bb8dff8190da5fa4919dc5c4687f9086782`.
Build, tests and UI check all exited 0; 44 tests passed and the existing
verifier-within-verifier case was skipped. This verifies the post-removal
source, not an optimization result. This documentation update came after that
report, so the report does not fingerprint this updated record.

All three candidate slots in the first round are used, and none met the frozen
keep rule. No measured refresh-overhead improvement is claimed for that round.
The earlier escalation asked for a human decision on another round. The current
goal delegates routine in-goal decisions to the judge and explicitly allows a
separately documented round of at most three candidates. The subsequent judge
decision and measurements are recorded below. They do not revise the first
round's results or approve a PR merge.

## Refresh experiment round 2, candidate 1 (2026-10-02)

**Status: discarded after contradictory repeat measurement.** This was the
first candidate in the separately documented round, with at most three
candidates allowed. The earlier keep decision below is superseded by the frozen rule;
it is retained to show how the contradiction was resolved.
The judge's recovered native outcome is raw run
`81611e6e-1907-447e-8878-bef08991ee1e`; the coordinator reports below are
the independently inspected measurement and check evidence for that decision.
The new hypothesis is that the earlier candidate's byte reduction was real while its
round-trip median reflected local timing variation: omitting the event-history
query except while Agent room is open will reduce `/api/state` bytes by at
least 10% without a greater-than-5% regression in either latency median when
compared with the current post-removal baseline in the same isolated runner.
The candidate reinstates the previously tested `/api/state?events=1` option;
entering Agent room triggers a refresh. The existing serialized refresh path still handles
SSE, reconnect, fallback polling and actions. No new dependency or retrieval
engine is introduced.

The evaluator remains `scripts/measure-refresh.ts` at SHA-256
`ec72c39beda16d1906aa92fdea71e89c56125477c2ca986406e3d6bf68ca0858`.
Workload: four paused projects, 48 completed tasks, 80 events and five message
updates. Five repetitions; 30-second evaluator runtime budget. Metrics remain
median response bytes, coordinator round trip and POST-to-SSE update latency.
The original keep rule still applies: one median improves by at least 10%,
neither other median regresses by more than 5%, and build, tests, UI check and
native sandbox verification pass. Candidate slots and thresholds were not
changed in response to its score.

The current post-removal source was measured by coordinator report
`.looproom-verification/5b652260-032f-40a7-b06a-ee0c150bcc54.json` on
2026-10-02: 19,393 bytes, 2.947208 ms round trip and 154.003709 ms update
latency. The report has `sourceUnchanged: true` and evaluator exit 0. Its raw
round-trip observations were 4.444375, 3.049000, 2.481833, 2.947208 and
2.095459 ms, confirming substantial local timing spread. The report source
fingerprint precedes this documentation and candidate code. The earlier
integrated baseline report cited above remains unavailable in this worktree;
this round uses the new current baseline and makes no cross-revision claim.
The candidate source was measured by coordinator report
`.looproom-verification/862d1fc8-37dc-43d7-8cd6-783db60697d4.json`.
It records source hash
`82b2240daf82dd5ae28f7cdd827f60b3df52836bd8da9d14c7a26b3e1e7d0735`,
`sourceUnchanged: true`, evaluator exit 0, and the same five-repetition
workload. The matching-source checks report
`.looproom-verification/8571a0ff-0340-4a7e-8284-6b7d76244298.json`
records exit 0 for build, tests and UI check: 44 tests passed, zero failed,
and one pre-existing verifier-within-verifier case was skipped by the isolated
runner. The native macOS worker-denial test passed. The added API test confirmed
that ordinary state responses omit event history and `?events=1` includes it.

| Metric | Post-removal baseline median | Candidate observations, in run order | Candidate median | Change |
|---|---:|---|---:|---:|
| Refresh bytes | 19,393 | 8,504, 8,665, 8,827, 8,989, 9,151 | 8,827 | 54.5% lower |
| Coordinator round trip (ms) | 2.947208 | 4.873416, 1.956417, 1.864000, 3.051500, 1.553291 | 1.956417 | 33.6% lower |
| Update latency (ms) | 154.003709 | 171.394750, 154.654709, 155.027875, 152.937000, 154.945167 | 154.945167 | 0.6% higher |

The first candidate run's response-byte reduction exceeds both the frozen 10%
keep threshold and the baseline's observed byte range of 19,094–19,693. Its
other medians were within the 5% regression limit, and the matching checks
passed. The judge initially recorded a keep decision on that evidence. The
same source was then measured twice more, producing the contradictory result
below. The judge subsequently directed a discard under the unchanged frozen
rule. The original pass and decision remain recorded rather than being
relabelled as a failure.

| Coordinator report | Source hash | Refresh bytes median | Round-trip median (ms) | Update latency median (ms) | Frozen-rule outcome |
|---|---|---:|---:|---:|---|
| `862d1fc8-37dc-43d7-8cd6-783db60697d4` | `82b2240daf82dd5ae28f7cdd827f60b3df52836bd8da9d14c7a26b3e1e7d0735` | 8,827 | 1.956417 | 154.945167 | Initial pass; later superseded |
| `47722b66-3a57-420c-a3b2-ac4616da0335` | `3ce6e6f3b1258e07c4b967b1d85f05a1ec93f58d880ccae7da775be26b09c5a4` | 8,827 | 2.880583 | 154.389125 | Pass against the documented baseline |
| `bd6d8589-aad6-4a1f-b352-4aaa1e6c3ad6` | `3ce6e6f3b1258e07c4b967b1d85f05a1ec93f58d880ccae7da775be26b09c5a4` | 8,827 | 3.209042 | 155.510458 | Fail: round trip 8.9% above baseline |

The two repeat reports have the same source hash and each records
`sourceUnchanged: true`, evaluator exit 0, and build, test and UI check exit 0.
The earlier report has a different source hash because this experiment record
was updated after its measurement; its application change was the same event
history option. In the failing repeat, raw round-trip observations were
4.637708, 1.675166, 3.016959, 3.209042 and 3.246916 ms. Relative to the
post-removal baseline of 2.947208 ms, the 3.209042 ms median breaches the
5% ceiling of 3.094568 ms. Bytes remained 54.5% lower and update latency
rose 1.0%, but a byte improvement cannot offset the latency regression under
the frozen rule. The candidate is discarded; no stable latency improvement is
claimed. The worktree's event-history code is retained only as part of the
integrated next candidate pending its own measurement and decision.
The evaluator directly requests `/api/state`; it does not measure browser
request coalescing, reconnect behavior or the number of client requests. The
focused tests support stale-response and retry behavior separately. The
documentation edit recording this outcome follows those coordinator reports;
the coordinator must verify the publication source after this edit.
The first-round failures remain discarded and intact above. FTS5 remains the
retrieval baseline; no Jev savings claim is made. Any PR merge still requires
human approval of its exact revision.

## Refresh experiment round 2, candidate 2 (2026-10-02)

**Status: kept under the frozen rule.** This uses the second of at most
three candidate slots in round 2. Its concrete latency hypothesis is that
repeated `DatabaseSync.prepare` calls in `Store.all` contribute enough local
HTTP round-trip overhead to explain the candidate 1 regression. The Store now
prepares its existing all-records query once and reuses that statement for
successive state reads. This candidate includes the event-history option from
candidate 1 and the previously retained serialized client refresh behavior.
It adds no dependency and changes neither SQL results nor response shape.

The comparison baseline remains coordinator report
`5b652260-032f-40a7-b06a-ee0c150bcc54` (19,393 bytes, 2.947208 ms
round trip, 154.003709 ms update latency). Evaluator SHA-256 remains
`ec72c39beda16d1906aa92fdea71e89c56125477c2ca986406e3d6bf68ca0858`.
The same four paused projects, 48 completed tasks, 80 events, five updates,
five repetitions, 30-second measurement budget and frozen 10% improvement /
5% maximum regression rule apply. Coordinator measurement report
`.looproom-verification/ba5a414a-98d1-4ff2-ae9d-b38f3fbbc44b.json`
records source hash `13fefb2d672c5f634295674b9f656d19be5470f5f27869ab6395647d81d76510`,
`sourceUnchanged: true`, evaluator exit 0 and the unchanged workload.
Matching-source report
`.looproom-verification/446a863d-7fc2-4fba-af54-7db2b2187a52.json`
records build, tests and UI check exit 0. Its 44 passing tests include the
native macOS worker-denial test; one verifier-within-verifier case was skipped
in the isolated runner.

| Metric | Post-removal baseline median | Candidate observations, in run order | Candidate median | Change |
|---|---:|---|---:|---:|
| Refresh bytes | 19,393 | 8,504, 8,665, 8,827, 8,989, 9,151 | 8,827 | 54.5% lower |
| Coordinator round trip (ms) | 2.947208 | 2.807958, 1.929333, 3.542833, 3.923625, 2.974541 | 2.974541 | 0.9% higher |
| Update latency (ms) | 154.003709 | 166.518083, 154.334708, 157.822417, 155.081416, 157.035000 | 157.035000 | 2.0% higher |

The byte reduction exceeds the 10% threshold and both latency changes remain
below the frozen 5% regression limit. The judge directed a candidate-2 keep
decision on these results. The earlier candidate-1 contradiction and discard
remain intact above. This measurement covers direct `/api/state` reads; it
does not measure browser request coalescing or EventSource reconnect behavior.
Direct worker checks on this candidate passed: TypeScript `--noEmit`, the UI
checker, the three focused refresh tests and `git diff --check`. The worker did
run `npm run check:ui`; its npm wrapper exited 255 under the worker sandbox,
while the direct `node scripts/check-ui.mjs` command exited 0. The worker did
not run the frozen evaluator or claim a measured gain; the coordinator's
isolated reports above supply that evidence. The original design
wiki is outside this restricted worktree, so this repository record is the
available evidence for coordinator synthesis into that wiki.

A subsequent focused test, `server/eventsource.test.ts`, opens a live native
EventSource, lets the first SSE response close, and checks that the same
subscription receives a later `changed` message after reconnect. This test
was added after the candidate measurement and matching-source checks, so
those reports do not verify this new test. A direct worker probe could not
bind `127.0.0.1` (`listen EPERM`); the coordinator's isolated check runner
must execute the new test before handoff. The application endpoint sends a
`connected` frame on each connection, which the existing `onmessage` handler
routes through the serialized refresh path.

## PR #7 base integration (2026-10-02)

The current worktree combines the kept event-history query and prepared
`Store.all` statement with the newer base branch's state snapshot cache,
integrity check, and EventSource reconnect lifecycle. The cache now keeps
separate entries for plain `/api/state` and `/api/state?events=1`, keyed by
Store and runtime revisions. Agent room still requests event history on entry;
other views request the smaller response. The API test checks both variants
in sequence, including a return to the plain variant. No evaluator source,
workload, acceptance threshold, dependency, or FTS5 retrieval path changed.

**Integrated revision outcome: kept under the unchanged frozen rule.**
Coordinator report
`.looproom-verification/b269f9e8-90be-4799-8cd2-e5a11b1f6f7a.json`
records source hash
`99e70aa1805fcdb82300e0d57bc6b165b4626e75ef06218818a45f4ce5b65426`,
`sourceUnchanged: true`, evaluator exit 0, and the same five-repetition
workload. The local evaluator source still hashes to
`ec72c39beda16d1906aa92fdea71e89c56125477c2ca986406e3d6bf68ca0858`.
The matching-source report
`.looproom-verification/11cc40aa-c6f5-47ac-ad58-9298978c7ebb.json`
records build, tests and UI check exit 0: 137 tests passed, zero failed and
one verifier-within-verifier case was skipped in the isolated runner. The
native worker-denial and live EventSource reconnect tests passed.

| Metric | Post-removal baseline median | Integrated observations, in run order | Integrated median | Change |
|---|---:|---|---:|---:|
| Refresh bytes | 19,393 | 8,504, 8,665, 8,827, 8,989, 9,151 | 8,827 | 54.5% lower |
| Coordinator round trip (ms) | 2.947208 | 1.411916, 1.022875, 0.953167, 4.033458, 2.886667 | 1.411916 | 52.1% lower |
| Update latency (ms) | 154.003709 | 159.589167, 152.474125, 153.364542, 154.444208, 153.809291 | 153.809291 | 0.1% lower |

The byte reduction exceeds the frozen 10% threshold and the baseline's
observed byte variation of 19,094–19,693. Neither latency median regressed.
The judge directed a keep decision for this integrated revision. This
supersedes the preceding provisional statement that the integrated source had
no measurement; it does not change the earlier pre-integration candidate-2
decision or the candidate-1 discard and contradictory repeats. The evaluator
measures direct `/api/state` reads, not browser request count or reconnect
latency. These reports fingerprint the application source before this record
was updated; the coordinator's publication checks must cover this documentation
change. No PR merge was approved.
