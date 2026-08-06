---
date: 2026-08-06
topic: "QA evidence — app theming + hive refinements + json-render quality slice 1"
tags: [qa, ui, theming, swarm-apps, json-render]
---

# QA evidence — app theming + hive refinements + json-render quality slice 1

Manual QA session (agent-browser against the local stack; qa-use YAML deliberately
skipped per repo convention — Taras manual-QAs the SPA). Screenshots in
[`2026-08-06-app-theming/`](./2026-08-06-app-theming/).

Environment: worktree API on :3213 (fresh `/tmp/app-theming-qa.sqlite`), vite on
:5433, seeded demo app **Launch Tracker** (`definition.theme: "ember"`, viewer
`$theme` override: `iris`).

| File | What it shows |
|---|---|
| [`01-tasks-light.png`](./2026-08-06-app-theming/01-tasks-light.png) | Dashboard chrome, hive light — sidebar/header, focus-ring + radius tokens live. |
| [`03-app-form-light.png`](./2026-08-06-app-theming/03-app-form-light.png) | Launch Tracker, light, full page — dot-convention badge pills (StatusBadge parity), h1/metric typography aligned to PageHeader/StatPanel, subtle AG Grid row rules, full-width enum Selects in the form, viewer `$theme` (iris) voicing the submit button, `destructive-outline` row deletes. |
| [`04-app-dark.png`](./2026-08-06-app-theming/04-app-dark.png) | Same page, dark — no light-token leaks under the scoped theme, white-alpha hairlines (border 10% / subtle 8%), `-strong` badge text collapsing to the 400 stops. |
| [`06-config-light.png`](./2026-08-06-app-theming/06-config-light.png) | Settings → Configuration, light — two-tier lines: `divide-y divide-border-subtle` row rules visibly softer than card outlines/inputs. |
| [`05-config-dark.png`](./2026-08-06-app-theming/05-config-dark.png) | Same page, dark — subtle rules at white/8, inputs kept at /15 for affordance. |

Checks at capture time: `apps/ui` `tsc -b`, `biome check`, `check:tokens` all
green; root `tsc:check`, skill drift checks, apps test files (179 tests) green;
full root suite run before PR.

## Round 2 — linger hover + animated sidebar icons (same day)

| File | What it shows |
|---|---|
| [`07-sidebar-icons.png`](./2026-08-06-app-theming/07-sidebar-icons.png) | Full animated icon set in the expanded sidebar — glyphs pixel-identical to the previous static lucide set. |
| [`08-sidebar-hover.png`](./2026-08-06-app-theming/08-sidebar-hover.png) | Workflows row hovered — instant hover bg (linger timing verified via computed styles: 0s enter / 200ms + 50ms-delay exit on the snappy curve), icon caught mid draw-in animation. |
| [`10-collapsed.png`](./2026-08-06-app-theming/10-collapsed.png) | Icon-collapsed rail — animated-icon div wrappers keep centering/sizing intact. |

Functional checks: icon returns to normal state after unhover (pixel-probed the
row before/after); `[data-sidebar="menu-button"]` computed styles show
`transition-property: width, height, padding, color, background-color`,
`transition-duration: 0.2s`, `transition-delay: 0.05s` at rest.

## Round 3 — grid header restyle + sidebar chrome softening + responsive slice

Direction reference: Taras's Cloudflare OS "cleanliness" screenshot — near
line-free chrome, spacing + uppercase micro-labels doing the separation.

| File | What it shows |
|---|---|
| [`11-grid-header-light.png`](./2026-08-06-app-theming/11-grid-header-light.png) | AG Grid header with no filled band — 11px uppercase tracked labels + subtle bottom rule; sidebar header/footer/panel rules on the subtle tier. |
| [`12-grid-header-dark.png`](./2026-08-06-app-theming/12-grid-header-dark.png) | Same in dark — white/8 hairlines throughout the chrome. |

Slice-2 responsive changes (Grid bare-count reflow, Stack collapseBelow,
Grid/Split padding, Table pinned/pagination/density) verified by type gates +
the 173 apps tests against the regenerated catalog; Drawer mobile width turned
out already solved (runtime passes `w-full`, twMerge overrides the sheet's
`w-3/4` base) — no change needed.

## Round 4 — DES-766 polish + motion pass (same day, PR #1123)

| File | What it shows |
|---|---|
| [`13-app-light-round4.png`](./2026-08-06-app-theming/13-app-light-round4.png) | Launch Tracker, light — baseline for the round; standalone stage Select now carries `aria-label="All stages"` (placeholder fallback, verified via `get attr`). |
| [`14-form-toast-light.png`](./2026-08-06-app-theming/14-form-toast-light.png) | Form create success — sonner "Saved" toast bottom-right, form cleared, new row in the grid. |
| [`15-rowaction-keyboard-confirm.png`](./2026-08-06-app-theming/15-rowaction-keyboard-confirm.png) | Row-action reached by KEYBOARD: cell click → ArrowRight×5 → Enter (focus hands into the actions cell) → Enter → the Delete confirm AlertDialog. Repeated twice more in dark to actually delete the QA rows. |
| [`16-select-open-light.png`](./2026-08-06-app-theming/16-select-open-light.png) | Select popover open — computed `animation-duration: 0.15s`, `animation-timing-function: cubic-bezier(0.2, 0, 0, 1)` (ease-snappy), exit drops to 100ms via `data-[state=closed]:duration-100`. |
| [`17-icon-midhover-light.png`](./2026-08-06-app-theming/17-icon-midhover-light.png) | Workflows row mid-hover — icon glyph fully drawn while animating (transform-based retune; the old pathLength draw-in blanked it ~150ms). |
| [`18-sidebar-group-reopening.png`](./2026-08-06-app-theming/18-sidebar-group-reopening.png) | WORK sidebar group re-opening through the new `CollapsibleSection` height+fade (200/150 snappy); links intact after settle. |
| [`19-app-dark-round4.png`](./2026-08-06-app-theming/19-app-dark-round4.png) | Same app, dark — hairlines stay at the confirmed 8%/10% (Taras: keep), no light-token leaks. |
| [`20-form-toast-dark.png`](./2026-08-06-app-theming/20-form-toast-dark.png) | Dark form create — "Saved" toast + row landed. |
| [`21-alertdialog-dark.png`](./2026-08-06-app-theming/21-alertdialog-dark.png) | Dark AlertDialog on the retimed 200/150 snappy curve. |
| [`22-hover-visible-light.png`](./2026-08-06-app-theming/22-hover-visible-light.png) | Light hover fix (Taras: "too lowkey"): `--color-accent` split off muted, zinc-100 → ~zinc-150 (0.943), sidebar-accent + cobalt/ember light accents bumped the same step — hovered Workflows row now clearly filled. Dark untouched. |

Computed-style probes at capture time: `[data-slot="button"]` shows
`transition-property: color, background-color, border-color, transform`,
`transition-duration: 0.2s`, `transition-delay: 0.05s ×3, 0s` at rest (the
per-property linger/press split live), and the `sm` button class list carries
`active:scale-[0.97]` with the base 0.98 correctly deduped by twMerge.
Gates: `tsc -b`, `bun run lint`, `check:tokens` all green.
