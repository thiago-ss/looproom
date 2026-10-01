# UI reference selection

The actual app keeps Looproom's Plex typography, graphite shell, warm paper, mineral teal and vermilion decision signal. This is a working UI revision, not a mockup.

| Source | Selected use | Import status |
|---|---|---|
| [Bencho](https://bencho.dev/) and [sounds](https://bencho.dev/sounds) | Direct folder-drop feedback, selectable action stations, gentle attention sound | Pattern inspiration; original CSS/React and synthesized Web Audio |
| [Refero Styles](https://styles.refero.design/) | Consistent type, spacing and product vocabulary; Linear/Perplexity references | Research reference; Looproom brand retained |
| [BoardUI](https://www.boardui.com/llms.txt) | Header notification inbox and action-oriented agent information | Pattern inspiration; no Pro source imported |
| [devl](https://www.devl.dev/) | Memory catalogue/reader and room/inspector splits; preferences | Pattern inspiration; no second control framework |
| [Pixel Perfect](https://www.pixel-perfect.space/) | Reviewed pixel fields, border and expressive button examples | Deferred; original quiet field/empty archive artwork |
| [Justin Levine](https://ui.justinlevine.me/llms.txt) | Reviewed activity graph, file tree, logs and diff candidates | Deferred until real activity/diff tooling warrants it |
| [Efferd](https://efferd.com/) | Shadcn-based app-shell/auth composition | Reference; no paid block imported |
| [Arla skills](https://github.com/arla6ka/skills) | component-docs and migrate-design-system installed for contributors | MIT project-local skills, hashes in skills-lock.json; not runtime permission policy |
| [shadcn](https://ui.shadcn.com/docs) | Every button/form control; Select, Checkbox, Switch, Tabs, Tooltip, Popover, Sonner | Actual local primitive source, MIT |
| [ReactBits](https://reactbits.dev/llms.txt) | Onboarding Stepper, task StatusMark | Actual source; buttons adapted to shadcn |
| [DotMatrix](https://dotmatrix.zzzzshawn.cloud/) | Labeled pending operations | Actual source with product-use license |
| [Orbkit](https://orbkit.zzzzshawn.cloud/) | Hydrogen / toy bricks / water caustics / terminal, one per role | Actual MIT original shader source; idle/thinking driven by runs |

Semantic layout and document HTML do not need a component wrapper. Interactive controls belong in the shared shadcn layer; `npm run check:ui` enforces the boundary. Detailed provenance and evidence are maintained in the development workspace's LLM wiki; redistribution terms live in THIRD_PARTY.md and licenses/.

## Work, Review and Goal follow-through

Work uses a grouped frontier with shadcn Tabs/Select/Input and the actual dependency graph. A queued task whose prerequisites are incomplete is labelled “Waiting on work”; the displayed label never changes scheduler state. Review uses intrinsic-height decision cards, a bounded context reader, response controls before supplemental task evidence, and explicit diff tabs. Approval confirmation captures the gate ID and head SHA when opened; the broker still rechecks and submits that exact SHA.

Goal owns 100dvh, including navigation and header. Its conversation scrolls independently and opens at the latest message. Reading older history suspends automatic following until the user returns to the bottom; a Latest messages control is available. The context rail scrolls independently on desktop and becomes a shadcn popover on narrower screens. Escalations are normal content cards with a separate action, rather than multiline compact buttons. Task check outputs use shadcn Collapsible.

The supplied brand, Plex fonts, ReactBits StatusMark, DotMatrix pending feedback and role-specific Orbkit wrappers remain in the application. Sources above inform the interaction patterns; paid blocks were not copied. Verified with actual local data at 1280×850 and 390×844; screenshots and the source-backed verification record live in the development wiki.
