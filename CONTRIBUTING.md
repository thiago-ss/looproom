# Contributing to Looproom

Thanks for helping make agent work understandable and reviewable. Code, docs, bug reports, accessibility feedback and careful testing on real projects are all useful.

## Before coding

Search existing [issues](https://github.com/thiago-ss/looproom/issues). For a large architectural change, open a proposal with the problem, expected behavior and acceptance criteria first. For a small bug or documentation correction, a focused PR is welcome.

Use the [getting started guide](docs/getting-started.md) on macOS. Create a branch or worktree from the repository's default branch (`feat/local-app` today). Keep changes scoped; do not include local databases, account files, generated run evidence or unrelated formatting.

## Code map

| Location | Responsibility |
|---|---|
| `src/` | React interface, shared Arc controls, role orbs |
| `server/engine.ts` | Coordinator, task lifecycle, gates and publication |
| `server/store.ts` | SQLite state and durable records |
| `server/runtime.ts` | Codex transport |
| `server/` tests | Lifecycle, verification, authority and recovery contracts |
| `scripts/` | Launcher, UI guards and measurement tools |
| `docs/` | Product contracts, provenance and recorded boundaries |

Use Arc primitives for shared interactive controls. Keep Looproom's existing palette, one font family, readable contrast and reduced-motion behavior. See [UI guidance](docs/arc-ui.md) and [identity](docs/identity-v2.md). New incorporated sources must have permissive licenses and preserved notices. Do not reintroduce the restricted ReactBits or DotMatrix implementations.

## Validate your change

```sh
npm run typecheck
npm run check:ui
npm test
npm run build
```

For UI work, inspect the real app in a browser and include a screenshot without private project data. Check keyboard operation and reduced motion for changed interactions. For engine changes, cover the changed lifecycle or authority boundary with meaningful tests. Record the exact checks run and failures; do not label fixture coverage as a live native run.

Tests do not intentionally mutate your live GitHub projects. Use a separate `LOOPROOM_DATA_DIR` for local fixtures or experimental coordinators. Never point two coordinators at the same data directory.

## Pull requests

Explain the problem, what changed, verification, and remaining limits. Link the issue when there is one. Update the affected contract or provenance docs when behavior changes. Keep the lockfile consistent with dependency changes.

Agents may help author a change, but reviewers need evidence and understandable code. Every product PR merge requires a human to approve the exact revision. Automation and YOLO do not waive that boundary.

## Good first contributions

- Reproduce a setup failure with sanitized steps.
- Improve a confusing message or keyboard interaction.
- Add a focused regression case for a documented boundary.
- Test native folder selection and onboarding on another Mac.
- Help design representative performance workloads without changing the evaluator to favor a candidate.

See the [roadmap](docs/roadmap.md). These are suggestions, not reserved assignments or a promise that every proposal will be accepted.

## Community conduct

Be respectful, specific and patient. Critique the work, not the person. Do not harass contributors, disclose private information, or post credentials. Maintainers may remove harmful content or restrict participation. Raise technical disagreements with reproducible evidence and a proposed alternative.

For security reports, follow [SECURITY.md](SECURITY.md).
