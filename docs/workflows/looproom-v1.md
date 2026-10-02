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

A configurable shared capacity of one to four concurrent workflows includes planning, task pipelines and judges. Independent ready tasks within a project may run concurrently; each has a separate worktree. Role identities and handoffs are durable; a role runs in a fresh Codex thread with project memory/context. Native hidden child agents are disabled so every dispatched worker uses the explicitly selected profile. Simultaneous native worker/PR lifecycle verification, contradiction review, native macOS packaging and measured engine experiments remain next slices.

## Scoped gates and optional judge

A task gate blocks its task and true dependents; planning gates can leave already-scoped independent work runnable; a project gate stops ordinary project work. Dependencies represent required artifacts, not an arbitrary preferred sequence. Dispatch reserves capacity before starting asynchronous work and will not launch a duplicate task. Shared runtime wiki updates are serialized per project.

Every gate writes an attributed escalation message into the Goal conversation. Replies retain the gate/task link and identify the human or judge. The composer can reply directly to a non-PR gate. Restart backfills older history idempotently, using actual run evidence for attribution.

Project boundaries offers Human review, Judge bypass and YOLO; new projects start in Human review. A separately configurable judge defaults to GPT-6 Sol / Medium and runs read-only against repository/task evidence. It returns retry, skip or wait with a sourced answer. Answers and runtime identifiers are durable. A wait answer or failed judge stays on the original gate; explicit retry is available. Three judge retries bound a recovery round. YOLO rechecks unresolved conditions automatically and can perform scoped repairs and request coordinator verification; real new passing evidence can release an exhausted round. Human review retains drafts for the human. Selecting Human review or pausing prevents an in-flight answer from automatically resolving a gate. The judge cannot install tools, widen access, fabricate verification or approve a PR. PR merge approval remains human and exact-revision-bound.

In YOLO, planner-created experiment limits bound a round rather than creating an extra human approval requirement. Every role receives this mode policy. The judge may authorize a distinct, documented next round toward the same goal with a concrete hypothesis, the same measurement/runtime budget and unchanged acceptance thresholds. Failed candidates and their measurements remain discarded in history. Explicit user hard limits, exclusions, frozen evaluators and actual unavailable capabilities remain binding. This policy guides model decisions; it is not a general coordinator-enforced experiment ledger or a guarantee that every blocker can be repaired.

## Baseline setup and frozen comparisons

The refresh verification recipe records a project baseline owner and immutable evaluator source snapshots, verified against their SHA-256 on reuse. During initial setup, changing that owner's evaluator requires independent read-only review comparing the original and current source, confirming unchanged workloads, repetitions, metrics, runtime budget and acceptance rules, with no candidate results. Missing evidence or a source/phase race rejects the revision. An accepted repair invalidates old baseline verification and requires fresh measurements; scores across evaluator revisions cannot count as an improvement.

The baseline freezes after successful measurement and acceptance review, before publication. Candidate tasks cannot measure while setup is incomplete or alter the frozen evaluator. This is the supplied refresh recipe's guard; a general experiment platform and semantic equivalence proof remain outside v0. Verification recipe failures reach scoped YOLO recovery with actual errors. Model transport failures retain bounded backoff. Every PR merge still requires human approval of its exact revision.
