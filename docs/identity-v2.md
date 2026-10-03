# Looproom identity v2

Continuous plum surfaces with readable chalk text and soft citron actions. One IBM Plex Sans family serves all UI text, including labels, menus and code excerpts. Mini-titles use normal casing. Rectangular interactive surfaces share `--lr-radius: 10px`; physical orbs, status dots and switch thumbs stay circular.

`src/identity.css` owns shared tokens, shadcn aliases and presentation; `src/styles.css` owns base layout. Selection uses a soft tonal surface. Persistent accent frames and box shadows are removed; keyboard focus stays visible. Page names live in navigation/breadcrumbs with hidden semantic headings. Concise content titles and actual decision questions remain visible.

Blue, green, rose, plum and peach washes express role/stage selection with explicit labels. Distinct original MIT Orbkit shaders represent Orchestrator, Researcher, Builder, Reviewer and Judge. Their idle/thinking states reflect real runs. Looproom pending and status indicators consume shared tokens; shadcn owns interactive controls.

Human chat messages have one byline and readable 15 px text. Linked escalation requests show the original agent question before its human/judge reply. Goal fills the viewport and scrolls internally; new visits start at the latest message. The escalation Reply action selects a gate-specific composer without changing live state until submission.

Strict TypeScript/build, 20 meaningful engine/runtime tests, shadcn guard and whitespace checks pass. Native read-only judge inference is verified separately from fixture scheduler tests. Main JavaScript remains above Vite's 500 kB advisory. Actual UI inspection and contrast samples are recorded in the workspace wiki; no complete accessibility or runtime performance benchmark is claimed.
