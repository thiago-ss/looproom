# Looproom workflow adapter v1

**Implemented coordinator contract.** The files under `upstream/` are pinned Matt Pocock and Ponytail skill references with their license notices. Their original tracker and human interview instructions are context for this versioned adaptation.

1. **Wayfinder:** name the destination and boundaries. Read the repository and durable human context. Answer reversible routine choices using evidence; record uncertainty. Consequential authority, access, scope or irreversible choices create a human gate. Never pretend to be the human who answers the original interview.
2. **Research:** read primary sources and actual repository files. A past agent report is a lead to verify, not corroborating evidence. Cached web search is available; direct shell networking is disabled. Missing access becomes an explicit gate.
3. **Spec/tickets:** structured planning output creates at most six tasks with acceptance criteria and validated acyclic dependencies. The goal conversation is the current planning brief. Task contracts persist in SQLite.
4. **Ponytail:** prefer existing project features, standard libraries and minimal changes. Preserve behavior, accessibility and validation. No arbitrary new dependency budget or line count objective.
5. **Implement:** one assigned contract, isolated worktree, requested worker profile. Workers cannot approve their own external actions. The coordinator runs user-authorized checks and a separate read-only review. Check/review failures get at most three attempts with recorded feedback before escalation.
6. **Publish:** coordinator alone stages, commits, pushes and opens a PR. Human review covers the displayed head revision. Preflight rereads head/checks/mergeability; GitHub receives that same SHA atomically. The worker never receives merge credentials through its environment.
7. **Memory:** each completed structured outcome creates an immutable raw run capture, a cited Markdown page, an index/log entry and a project-scoped FTS5 row. Outcomes are explicitly agent-reported; actual checks and PR state remain independent records.
8. **Next cycle:** continue ready independent work while another task waits at a gate. Replan after the frontier completes. If no evidenced improvement remains, wait for new human context; do not create busywork.

## Research methods awaiting dedicated implementation

Karpathy autoresearch informs fixed acceptance criteria and bounded candidates. The independent experiment harness, evaluator write protection and keep/discard promotion are **not yet shipped**. Jev retrieval remains a candidate to benchmark against the implemented local FTS5 baseline. No savings or quality improvement is claimed.

## Scope of v0

One active task per project; up to four concurrent projects. Role identities and handoffs are durable; a role runs in a fresh Codex thread with project memory/context. Native hidden child agents are disabled so every dispatched worker uses the explicitly selected profile. Parallel workers within one project, contradiction review, native macOS packaging and measured engine experiments remain next slices.
