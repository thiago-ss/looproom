# Resource map

| User resource | Concrete use | Current status |
|---|---|---|
| [Jev RAG article](https://medium.com/@GaoDalie_AI/jev-rag-a-more-efficient-solution-for-rag-systems-9be77037c17b) | Retrieval candidate against local FTS5; relevance/token/latency comparisons | Research reference; provider integration and benchmark pending |
| [Karpathy autoresearch](https://github.com/karpathy/autoresearch) | Bounded candidates with unchanged acceptance criteria, independent review and keep/discard promotion | Method in contracts; protected experiment harness pending |
| [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | Immutable raw outcomes with hashes; source-linked pages, index/log and FTS5 | Implemented initial runtime memory; contradiction workflow pending |
| [Matt Pocock skills](https://github.com/mattpocock/skills) | Wayfinder → research → task contracts → implementation | Upstream references shipped; [versioned adaptation](workflows/looproom-v1.md) implemented through coordinator contracts |
| [Ponytail](https://github.com/dietrichgebert/ponytail) | Reuse and minimum-code pass in task contracts | Instructions implemented; no measured code-reduction claim |
| [shadcn](https://ui.shadcn.com/docs) | Registry installation foundation | CLI installs Arc and existing visual assets |
| [Arc UI](https://uiarc.dev/docs/ai) | All shared control primitives, overlays, search, number field, progress, feedback | 25 free components installed; Codex MCP configured; [coverage](arc-ui.md) |
| [ReactBits](https://reactbits.dev/llms.txt) | Retained wizard animation/content; task StatusMark (progress now Arc) | Actual components imported and adapted |
| [DotMatrix](https://dotmatrix.zzzzshawn.cloud/) | Inline operation loading | Actual loader/core/hooks/CSS imported |
| [Orbkit](https://orbkit.zzzzshawn.cloud/) | Role orbs with real idle/thinking states | Actual MIT Hydrogen shader/core imported |
| Attio / Linear / Notion / Perplexity | Compact navigation, linked work, readable evidence, goal conversation | Existing brand applied to application |
| [Grok Bot](https://docs.x.ai/grok-bot/get-started) | Simple onboarding and focused goal interaction | Adapted to a local coding product |
| Superdesign / imagegen | Looproom brand marks and onboarding sculpture | Existing approved direction incorporated; no new mockups |

For source constraints see [third-party notices](../THIRD_PARTY.md). Research claims remain hypotheses until measured in Looproom.

Pending escalation judgment uses the ReactBits Shiny Text CSS sweep mapped to the Looproom palette, with reduced-motion static text. Source snapshots and verification are in the parent wiki’s follow-through batch; existing MIT + Commons Clause notice applies.

## Work redesign selection

Revisited all supplied UI catalogs. [devl two-pane](https://www.devl.dev/c/layouts/two-pane) and [issues](https://www.devl.dev/c/tables/issues) inform the persistent inspector and compact task rows; [Bencho](https://bencho.dev/) informs connected-task navigation; [BoardUI](https://www.boardui.com/llms.txt) informs task/progress organization. These are interaction references, not copied source. BoardUI Pro entries are not incorporated. [Jalco](https://ui.justinlevine.me/llms.txt) and [devl PR ops](https://www.devl.dev/c/timelines/pr-ops-console) inform an evidence-based activity feed. [Refero](https://styles.refero.design/), [Pixel Perfect](https://www.pixel-perfect.space/) and [Efferd](https://efferd.com/) were inspected; their marketing-oriented treatments were not selected for this working task surface. Arc supplies the actual primitives; existing ReactBits states, DotMatrix pending indicators and distinct Orbkit role shaders remain imported. Full source evidence and selection rationale live in the parent wiki's UI revision.
