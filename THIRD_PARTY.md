# Third-party notices

Looproom's MIT license covers original application code. It does not replace the licenses on the incorporated source below or on npm dependencies.

| Source | Incorporated files | License / provenance |
|---|---|---|
| [ReactBits](https://reactbits.dev/llms.txt) | `src/components/ui/Stepper.tsx`, `StatusMark.tsx` | MIT + Commons Clause; `licenses/reactbits.txt`; free TypeScript/Tailwind registry. Stepper adapted for retained setup, final button wording and live content measurement |
| [DotMatrix](https://dotmatrix.zzzzshawn.cloud/) | `dotm-square-3.tsx`, `dotmatrix-core.tsx`, `dotmatrix-hooks.ts`, loader CSS | Custom Proprietary License; `licenses/dotmatrix.txt`; product incorporation permitted, standalone reusable component redistribution restricted |
| [Orbkit](https://orbkit.zzzzshawn.cloud/) | `shdr-11.tsx`, `shdr-12.tsx`, `shdr-13.tsx`, `shdr-16.tsx`, `shdr-23.tsx`, `orbkit-core.tsx` | MIT; `licenses/orbkit.txt`; Hydrogen, toy bricks, plasma globe (judge), caustic water and ASCII original variants. Local core adds WebGL-unavailable fallback notification. No noncommercial XorDev shader ports are incorporated |
| [Matt Pocock skills](https://github.com/mattpocock/skills) | `docs/workflows/upstream/` Wayfinder/research/to-spec/to-tickets/implement | MIT; `licenses/matt-pocock.txt`; commit `d81f3a183412e71a5b1e84ca21bc1a35eea03a60`; autonomous adaptation documented separately |
| [Ponytail](https://github.com/dietrichgebert/ponytail) | `docs/workflows/upstream/ponytail.md` | MIT; `licenses/ponytail.txt`; commit `e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156` |
| [shadcn/ui](https://ui.shadcn.com/docs) | Button/Input/Textarea/Dialog/Badge/Skeleton/Select/Checkbox/Switch/Tabs/Tooltip/Popover/Sonner source | MIT; generated with official CLI; `licenses/shadcn.txt` |
| [Arla design-system skills](https://github.com/arla6ka/skills) | `.agents/skills/component-docs`, `.agents/skills/migrate-design-system` | MIT; `licenses/arla-skills.txt`; project-local contributor tools, pinned by `skills-lock.json` |
| [IBM Plex](https://github.com/IBM/plex) | Local font assets served through Fontsource | SIL Open Font License 1.1; `licenses/ibm-plex-sans.txt` (historical Mono notice retained) |

UI registries were captured on 2026-09-30. Existing source captures and their hashes remain in the parent implementation wiki. Lockfile records exact npm versions. Application distribution must preserve these notices. Do not distribute the restricted files as an independent component collection.

## Arc migration (2026-09-30)

The shared shadcn primitive implementations and Sonner were replaced by 22 free [Arc UI](https://uiarc.dev/docs/ai) components installed through the shadcn registry CLI. Incorporated source and CSS modules: `src/components/arc/`; MIT, Copyright (c) 2026 Elia Kuratli, full notice in `src/components/arc/LICENSE`. See [upstream license](https://uiarc.dev/license), [source hashes](docs/arc-sources.json), and [coverage/setup](docs/arc-ui.md). No Arc Pro code is incorporated. The shadcn notice remains for the historical implementation and installation tooling.

ReactBits Stepper now provides retained animated wizard content around Arc's progress indicator and buttons. StatusMark remains incorporated.
