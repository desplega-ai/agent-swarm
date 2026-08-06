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
