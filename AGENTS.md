# Looproom working instructions

Read `outputs/looproom-wiki/index.md`, then relevant linked pages before work. Maintain the LLM wiki using `outputs/looproom-wiki/SCHEMA.md`: source snapshots are immutable, pages cite evidence, and meaningful changes append to the log.

The user requested GPT-6.1 Sol with High reasoning for orchestration and GPT-6 Sol with Medium reasoning for implementation/subagents. The product's canonical default profiles are in `outputs/looproom-wiki/config/model-profiles.json`. When the user authorizes delegated work, use `gpt-6-sol` and `medium` for children. Do not silently substitute models. The active chat model is controlled by the host, not this file.

Use the original resource inventory in the wiki. The user has finished mockup exploration; next UI work belongs in the actual application. Preserve Looproom branding and the simple, goal-first onboarding requirement. Product implementation runs in Git worktrees. Every product PR merge needs human approval for the revision being merged.

Document work as proposed, researched, implemented, or verified accurately. Current assets and HTML previews are mockups; no application runtime has been implemented yet.
