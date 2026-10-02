# Remote PR synchronization

The coordinator observes registered task PRs on startup and every 15 seconds. Reads are single flight per project; errors back off up to two minutes. Paused projects still reconcile facts but do not start agent work. A closed coordinator ignores late remote replies.

- A merged PR completes its task, removes its stale Review gate and immediately reevaluates the dependency frontier. The durable gate stores the observed URL, number, base, final head, merge commit and time. It creates no human approval and attributes the merge actor as unverified.
- A different externally merged head remains explicitly different from the previously reviewed revision. Its earlier independent review is never reused as authorization.
- Conflicts or a changed open head supersede the old review and queue integration in the same task worktree. Active task/judge runs and human decisions retain ownership. The coordinator validates the worktree/repository, fetches the remote branch and base, adopts only a fast-forward branch update, persists its integration intent, and prepares a merge. The worker resolves source conflicts; Git metadata remains coordinator-owned.
- Coordinator staging rejects leftover conflict markers. Full configured checks and an independent read-only review of `git diff HEAD` run before a normal push. The existing PR receives a fresh exact-head review gate. Every merge still requires a human.
- Uncertain merge attempts use the established reconciliation path; polling never repeats a merge request or silently releases an unresolved attempt. Closed unmerged PRs remain explicit open review state rather than being marked completed.
- New task branches already start from the fetched remote project base, preserving unsaved files in the primary checkout. Synchronization fetches refs; it does not reset that checkout or hot-swap a running application.

Tests use synthetic GitHub responses and real disposable Git repositories, including a conflicted merge, preserved dirty primary checkout, staged resolutions, verification/review ordering and a normal push to a local bare origin. Native runtime verification and review evidence live in the project LLM wiki.
