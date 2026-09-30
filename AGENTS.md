# Looproom contributor instructions

Read README.md and docs/workflows/looproom-v1.md before work. In the original design workspace, also read the maintained `../looproom-wiki/index.md` and its relevant linked pages. That wiki uses immutable raw sources, evidence-linked synthesis and a chronological log; do not edit old snapshots.

Default profiles live in config/model-profiles.json: GPT-6.1 Sol / High orchestration; GPT-6 Sol / Medium workers. Do not silently substitute models. The host controls the active development chat model. Delegate only when the user or applicable instructions authorizes it; authorized children use gpt-6-sol / medium.

Product development runs in Git worktrees. Every product PR merge requires human approval for the exact revision. Keep credentials and external mutations in the coordinator broker; no broad sandbox fallback. Preserve the Looproom brand and simple goal-first flow. Use actual supplied UI components with their retained license notices.

Document work as proposed, researched, implemented or verified accurately. This is a working local v0; authenticated model execution, real GitHub round-trips and measured self-improvement remain unverified or planned as described in README.md. Do not replace those gaps with fake data or motion.

Run meaningful tests for persistence, scheduling, execution boundaries and merge authority when changing them. Keep node_modules, dist, runtime data and account credentials out of commits.
