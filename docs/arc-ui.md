# Arc UI in Looproom

Arc owns every shared interactive control. Use its documented API and installed sources under `src/components/arc`. Thin modules in `src/components/ui` retain the application's existing import names; they render Arc, rather than duplicating control implementations. `npm run check:ui` rejects native button/select/input/textarea/details/summary tags outside the Arc source directory.

## Codex MCP

Official endpoint: https://uiarc.dev/api/mcp. Configure each contributor's Codex installation:

```sh
codex mcp add arc --url https://uiarc.dev/api/mcp
codex mcp get arc --json
```

The current host has an enabled streamable HTTP `arc` server without authentication. Initialization, tool discovery, free component listing, intent search, component docs, installation guidance and review guidance were verified through real MCP calls. The active chat's tool inventory was already loaded, so this migration queried MCP through JSON-RPC; dynamic attachment to an already-running chat was not verified. Use the registered MCP in subsequent Codex sessions.

For a change: search the intent, inspect the chosen component, get its install command, use documented props and review it. Do not send account data, project contents or private source to this public component catalog. Public UI queries are sufficient.

## Installed and used

| Arc component | Application use |
|---|---|
| Button | Navigation, task cards, stations, actions and layer triggers |
| ActionButton | Model and project saves; pending/success reflect the real API promise; failed saves reject |
| CopyButton | Copy selected memory with native clipboard feedback |
| Input / Textarea | Onboarding, repository path, goal composer, review response, constraints and checks |
| SearchField | Work filtering and Memory search; clear retains field focus |
| NumberField | Bounded workflow concurrency, 1–4 |
| Select | Project, work stage, role model and reasoning effort |
| Checkbox / Switch | Setup choices and notification preferences |
| Tabs | Work views, Memory views, review evidence and room feed |
| Dialog | Task contract and explicit approval of an exact PR revision |
| Popover | Notification inbox and compact Goal context |
| Tooltip | Agent station/help and outcome provenance |
| Badge | Actual agent states and configured reasoning |
| Skeleton | Lazy Memory content loading |
| ToastStack | Escalation delivery, review action and dismissal; one provider |
| Accordion | Expand actual recorded check output |
| Stepper | Four-step setup progress; original Looproom wizard content |
| ScrollArea | Native Goal viewport, forwarded ref, bottom-follow and user scroll tracking |
| EmptyState | Empty project/review/work/Memory surfaces |
| Alert | Setup, network, operation, folder, memory, agent and PR errors |
| Progress | Actual completed-task fraction in Work |
| SegmentedControl | Five Work state filters with keyboard navigation |
| Timeline | Latest twelve actual task turns with attributed response details |

These are 25 applicable free components. Do not install unrelated controls just to inflate coverage. Arc has no free standalone Kbd or Collapsible entry in the retrieved catalog: the shortcut stays semantic text; check disclosures use Accordion. No Pro source or Pro token is incorporated.

## Identity and source boundary

`src/arc-theme.css` maps Arc's semantic tokens to the established plum palette, IBM Plex Sans and 10px rectangular corners. Physical orb/track geometry remains circular. Explicit keyboard focus, shadow-free surfaces and the existing palette take precedence over Arc's default styling recommendations. This app exposes one dark branded theme. Arc wrapper layout is adapted for domain cards; vendor component sources stay unchanged after CLI installation.

Source hashes: `docs/arc-sources.json`. License: `src/components/arc/LICENSE`, MIT, Copyright (c) 2026 Elia Kuratli. The upstream license page was marked draft on capture. Preserve the notice in distributions. Registry JSON and MCP evidence are archived in the parent LLM wiki. Captured registry source matches installed code after removal of CSS comments; installed byte hashes are authoritative for this revision.

Orbkit owns agent visual identities, original Looproom components own operation indicators and task state marks. Those domain visuals complement Arc controls. Native macOS folder selection/drop stays behind the existing local bridge. Human approval of every PR merge and model defaults are retained.

## Work expansion (2026-09-30)

Work uses Progress, SegmentedControl and Timeline retrieved through the official MCP and installed with shadcn. Timeline registry metadata contained an invalid dependency named ` animate=`; the first CLI attempt failed. Installation metadata was normalized to existing `motion`/`lucide-react` dependencies and omitted the already installed matching foundation. Component TS/CSS source was preserved, with the CLI's CSS comment/format normalization verified. Exact upstream registries, derived installer files and MCP API captures are immutable in the parent wiki's work-redesign batch. The original 48 installed source hashes are unchanged; six new files bring coverage to 54 source files. No new npm dependency or Pro code was added.

Record buttons adapt Arc's animated label wrappers to intrinsic height and full-width wrapping at the application boundary. Work and its CSS load as a separate route chunk. The activity timeline uses supplied timestamps, profile metadata and attributed run messages already in state; it does not enlarge coordinator state with full run outputs or fabricate progress.
