# Looproom contributor instructions

Read README.md and docs/workflows/looproom-v1.md before work. The development coordinator maintains the original design workspace’s `../looproom-wiki/index.md` and linked pages. Restricted runtime workers use the contracts shipped within this repository plus project memory supplied by the coordinator; historical sibling docs are outside their workspace. That wiki uses immutable raw sources, evidence-linked synthesis and a chronological log; do not edit old snapshots.

Default profiles live in config/model-profiles.json: GPT-6.1 Sol / High orchestration; GPT-6 Sol / Medium workers. Do not silently substitute models. The host controls the active development chat model. Delegate only when the user or applicable instructions authorizes it; authorized children use gpt-6-sol / medium.

Product development runs in Git worktrees. Every product PR merge requires human approval for the exact revision. Keep credentials and external mutations in the coordinator broker; no broad sandbox fallback. Preserve the Looproom brand and simple goal-first flow. Use actual supplied UI components with their retained license notices.

Document work as proposed, researched, implemented or verified accurately. This is a working local v0; native independent review, real GitHub round-trips and measured self-improvement remain unverified or planned as described in README.md. Do not replace those gaps with fake data or motion.

Run meaningful tests for persistence, scheduling, execution boundaries and merge authority when changing them. Keep node_modules, dist, runtime data and account credentials out of commits.

The user excluded Impeccable and Anti UI Slop from this project work. Do not apply those skills. Product controls use the shared shadcn primitives; run npm run check:ui before handing off UI changes. New design references are curated in docs/ui-reference-selection.md.
