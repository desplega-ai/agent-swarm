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
| [`24-steer-composer-fullwidth.png`](./2026-08-06-app-theming/24-steer-composer-fullwidth.png) | Task-detail steering dock now spans the full log column (`ComposerDock fullWidth` drops the chat-style `max-w-3xl mx-auto`; sessions chat unchanged). Verified on a seeded pending task with steering enabled (`STEERING_ENABLED=true` global config row in the QA DB). |

## Round 6 — approved theme ship + polish batch (same day)

| File | What it shows |
|---|---|
| [`25-pale-statuses-light.png`](./2026-08-06-app-theming/25-pale-statuses-light.png) | Swarm base with the PALE status set live (globals.css light+dark replaced; `-foreground` flipped to dark text on the pale fills). |
| [`26-appearance-classics.png`](./2026-08-06-app-theming/26-appearance-classics.png) | Settings → Appearance now lists the 7 classic presets (github/vscode/material/solarized/tokyo/monokai/gruvbox) from `theme-classics.ts`. |
| [`27-tokyo-light.png`](./2026-08-06-app-theming/27-tokyo-light.png) / [`28-tokyo-dark.png`](./2026-08-06-app-theming/28-tokyo-dark.png) | Tokyo Night applied on `<html>` — full field swap AND its own status palette on the chips (first presets to theme `--color-status-*`; hue semantics fixed). |

Also in this round (code-verified, gates green): global clickable=pointer rule in
globals.css; `AnimatedReveal` gained `axis="x"` (settings rail refactored onto it);
task-detail activity rail animates via `transition-[grid-template-columns]` +
content fade; session-log go-to-bottom pill glides (`scrollTo smooth`, auto-follow
paths stay instant, reduced-motion instant); `SteerComposer` `fullWidth` is now a
prop — task detail passes it, sessions chat keeps the centered `max-w-3xl` column
(regression from round 5 fixed); HiveMark + HiveLoadingScreen ported from
agent-swarm-internal (token-driven, reduced-motion-gated) and wired as the lazy-route
Suspense fallback.

Computed-style probes at capture time: `[data-slot="button"]` shows
`transition-property: color, background-color, border-color, transform`,
`transition-duration: 0.2s`, `transition-delay: 0.05s ×3, 0s` at rest (the
per-property linger/press split live), and the `sm` button class list carries
`active:scale-[0.97]` with the base 0.98 correctly deduped by twMerge.
Gates: `tsc -b`, `bun run lint`, `check:tokens` all green.

## Round 7 — chrome de-duplication + empty-state CTAs (2026-08-06, evening)

Taras's closing batch: (1) top bar bottom border removed; (2) in-page titles
removed everywhere — the breadcrumb owns page identity (plain-string
`PageHeader` titles no longer render; redundant name-h1s stripped from the
JSX-title detail pages whose breadcrumb resolves the entity name; unknown
segments auto-humanize kebab→Title Case); (3) the home greeting moved into the
breadcrumb slot; (4) first-run empty states vertically centered with an
"Ask the swarm" CTA that opens `/sessions?seed=Hey, help me set up my first
<entity>` (rides the existing NewSessionView seed contract); (5) sidebar rail
now shows `cursor: pointer` (menu buttons keep the default arrow).

| File | What it shows |
|---|---|
| [`30-home-greeting-breadcrumb.png`](./2026-08-06-app-theming/30-home-greeting-breadcrumb.png) | Home: "Welcome back, Taras QA" in the breadcrumb slot, borderless top bar, centered timeline empty state with primary "Ask the swarm" CTA. |
| [`31-workflows-empty-centered-cta.png`](./2026-08-06-app-theming/31-workflows-empty-centered-cta.png) | Workflows first-run empty converted from the hand-rolled block to `EmptyState fullPage entity="workflow"` — vertically centered, CTA present, no page title. |
| [`32-tasks-no-title.png`](./2026-08-06-app-theming/32-tasks-no-title.png) | Tasks: title gone, "Create Task" action right-aligned on its own row, grid unchanged. |
| [`33-memory-description-only.png`](./2026-08-06-app-theming/33-memory-description-only.png) | Memory: bespoke JSX title collapsed to a description-only header under the breadcrumb. |
| [`34-schedules-empty-cta.png`](./2026-08-06-app-theming/34-schedules-empty-cta.png) | Schedules empty: header action (Create Schedule) + centered EmptyState CTA coexist. |
| [`35-home-light-borderless.png`](./2026-08-06-app-theming/35-home-light-borderless.png) | Light mode: borderless top bar + greeting hold up. |

Live probes: `[data-slot="sidebar-rail"]` computes `cursor: pointer`,
`[data-sidebar="menu-button"]` stays `cursor: default`; clicking the CTA lands
on `/sessions` with the composer pre-seeded ("Hey, help me set up my first
workflow") and the `?seed` param stripped; `/usage/metrics` breadcrumb reads
Home › Usage › Metrics via the new auto-humanizer (no routeLabels entry).
Deliberately KEPT their JSX titles (breadcrumb can't resolve a name for them):
workflow-runs/[id] ("Run of <workflow>" link), templates/[id] (+ history),
connections/oauth-apps/[id]. Grid-overlay empties (`emptyMessage` on DataGrid
filter-misses) left as-is — they're filter feedback, not first-run states.
Gates: `bun run lint`, `bunx tsc -b` green.

## Round 8 — toolbar-resident actions + empty-state filter chrome (2026-08-06, late)

Follow-up: with titles gone, the lone header action row (Create Task / Sync
Remote / Add Server / per-tab Add) wasted a full row. Those actions moved into
the filter/toolbar row below as bare icon buttons with tooltips (`size="icon"
className="size-8"`, primary for create, outline for sync — spinner state
kept). First-run empty states no longer render filter chrome above them
(pages + approvals `ListFilterBar`, scripts tab filter row — all three
conditions are first-run-only, so active filters can always be cleared).

| File | What it shows |
|---|---|
| [`36-tasks-toolbar-plus.png`](./2026-08-06-app-theming/36-tasks-toolbar-plus.png) | Tasks: "+" rides the toolbar's right cluster next to Columns; header row gone. |
| [`37-mcp-toolbar-plus.png`](./2026-08-06-app-theming/37-mcp-toolbar-plus.png) | MCP Servers: search + filters + "+" on one row. |
| [`38-connections-toolbar-plus.png`](./2026-08-06-app-theming/38-connections-toolbar-plus.png) | Connections: tabs + search + kind/scope filters + per-tab "+" all on ONE row. |
| [`39-pages-empty-nofilters.png`](./2026-08-06-app-theming/39-pages-empty-nofilters.png) | Pages first-run empty: no filter bar — description, centered indicator, CTA only. |
| [`40-skills-toolbar-sync.png`](./2026-08-06-app-theming/40-skills-toolbar-sync.png) | Skills: sync icon (outline) at the toolbar's right end. |

Gates: `bun run lint`, `bunx tsc -b` green.

## Round 9 — schedules/people toolbars, subtitle prune, full-width breadcrumbs (2026-08-06, night)

Schedules joined the toolbar-action pattern ("+" in the search row; the
first-run empty keeps a labeled Create Schedule via `EmptyState action` next
to the Ask-the-swarm CTA). People's two actions (Merge users outline /
New user primary) became icon buttons to the RIGHT of the People|Unmapped
tabs. Top-level subtitles pruned: apps, people, pages, memory descriptions +
the skills system-skills note below the filter row. Breadcrumbs use ALL
available header width: the 40-char JS cap on contextual names is gone and
the trail owns the header's free space (`flex-1 min-w-0` wrapper replaces the
spacer) — CSS `truncate` clips only when space truly runs out; mobile keeps
the dropdown.

| File | What it shows |
|---|---|
| [`41-schedules-empty-create-action.png`](./2026-08-06-app-theming/41-schedules-empty-create-action.png) | Schedules first-run empty: Create Schedule + Ask the swarm side by side, single breadcrumb row above. |
| [`42-people-tabs-actions.png`](./2026-08-06-app-theming/42-people-tabs-actions.png) | People: search left, tabs right, merge/new-user icon buttons right of the tabs. |
| [`43-skills-no-note.png`](./2026-08-06-app-theming/43-skills-no-note.png) | Skills without the system-skills note — one more row reclaimed. |
| [`44-breadcrumb-fullwidth.png`](./2026-08-06-app-theming/44-breadcrumb-fullwidth.png) | Task detail: full 44-char task name uncut in the trail (previously clipped at 40 chars). |

Gates: `bun run lint`, `bunx tsc -b` green.

## Round 10 — workflows/scripts tabs join the toolbar row (2026-08-06, night)

Workflows and Scripts adopt the People pattern: the active tab's filters sit
on the left of ONE shared toolbar row with the tab switcher pinned right
(`TabsList ml-auto`); the standalone TabsList row is gone. The scripts Runs
tab's status filter was lifted out of `ScriptRunsGrid` into a new exported
`ScriptRunsStatusFilter` (same URL param, zero prop plumbing; the grid takes
`hideToolbar` on /scripts while /scripts/:id keeps the built-in row). The
workflows Runs tab's status/workflow selects moved into the shared toolbar
the same way. Scripts filters still hide over the first-run empty state.

| File | What it shows |
|---|---|
| [`45-scripts-tabs-toolbar.png`](./2026-08-06-app-theming/45-scripts-tabs-toolbar.png) | Scripts tab: search + scope + scratch switch left, Scripts\|Runs pinned right — one row. |
| [`46-scripts-runs-tab-toolbar.png`](./2026-08-06-app-theming/46-scripts-runs-tab-toolbar.png) | Runs tab: status filter left, tabs right — same single row. |

Workflows toolbar not visually verified with data (QA DB has no workflows so
the page early-returns its empty state) — the structure mirrors scripts
exactly; gates green.
