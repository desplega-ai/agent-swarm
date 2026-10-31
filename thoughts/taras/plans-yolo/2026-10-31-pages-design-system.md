---
date: 2026-10-31T00:00:00Z
topic: "Pages design system v2: token contract, themes, importer hook"
status: in-progress
---

# Pages design system v2: token contract, themes, importer hook

## Goal

HTML pages served at `/p/:id` get one opinionated default look (Hive, the dashboard identity) that is built from the dashboard token contract. Any theme source (a preset id today, a raw token map, a Figma/DTCG import later) normalizes into that contract, so one switch restyles the whole page. Inside the dashboard, a page with no own theme follows the viewer's preset and light/dark mode. Old pages keep their current v1 head (Tailwind v3) through a design version on the page row.

## Decisions

- Build the full change now, in one worktree, with Workflow orchestration. This exceeds the one-shot scope gate (about 6 phases, 3 areas). (asked: Taras granted the exception)
- Default page look = Hive. The skill's warm paper style ships as a `paper` preset. (asked)
- Direct links (outside the dashboard) render light. Inside the dashboard, the page follows the dashboard mode. (asked)
- Token names = the dashboard contract (`--color-*`, `--radius-*`, `--font-*`). `--swarm-*` stay as aliases. (asked earlier: Taras accepted the proposal and its risks)
- Theme sources go through an importer registry, so a Figma/DTCG importer is one new entry. (asked: Taras wants Figma import to be easy later)
- Migration ordinal 269. Main ends at 266. Open PRs #2219 and #2458 use 267 and 268.
- QA fixtures: the demo leads page copied as the baseline (as-is on v1, as-is on v2, and a v2 rewrite of the same content), a few existing prod pages copied read-only from the prod DB, and 4 pages a local Opus agent authors from the new skill. No prod swarm authoring. (asked)
- Prod-page screenshots stay local. Only demo and locally authored pages go into the PR. (assumed: prod pages can hold internal data)
- Parallel agents never run `bun test` at the same time (shared `./test-*.sqlite` fixtures). Only the sequential chain runs tests. (assumed: bun test gotcha)

- Frozen spec: `thoughts/taras/plans-yolo/2026-10-31-pages-design-system-spec.md`. Maps: `thoughts/taras/research/2026-10-31-pages-ds-maps/`. (assumed)
- Tailwind v4 browser 4.3.3 pinned with SRI, `@theme inline reference` mapping, Preflight off (theme + utilities imports), layer order statement first, `.dark` class variant. Research tested these in Chromium. (assumed)
- Viewer params are namespaced `__swarm-theme` / `__swarm-mode`: the SPA forwards its own query to the frame and already reserves `mode`. (assumed)
- Theme importers today: `tokens` (JSON map, shadcn short names accepted) and `css` (shadcn / tweakcn / Tailwind v4 `@theme` block). Figma / DTCG = one new importer later. (assumed: Taras asked for an easy Figma path, `css` covers his original "Tailwind schema" ask)
- Unknown preset ids are rejected on page writes (the server now has the registry). Apps keep their lenient shape check. (assumed)
- JSON pages stay on the dashboard theme. v2 theming covers HTML pages. (assumed: scope)
- Executors: Claude agents inside the Workflow (Opus for foundation, serving CSS, dashboard, docs; Sonnet for data plumbing). Codex skipped: a workflow agent would have to babysit background Codex runs past the 10-minute foreground limit. (assumed)

## Todo

- [x] Understand: map the dashboard theme system, the pages data path, page serving + viewer, Tailwind v4 browser facts, skill/doc surfaces
- [x] Spec: pin module layout, function signatures, columns, query params, CSS layering
- [x] QA fixtures: `/tmp/pds-qa/fixtures/demo-leads.html` + 5 prod pages in `/tmp/pds-qa/fixtures/prod/`
- [x] Foundation: shared theme engine in `src/` (presets moved from `apps/ui`, re-exported), token contract, importer registry, page token CSS builder, `paper` preset
- [x] Data: migration 269 (`theme`, `theme_tokens`, `design_version`), types, DB layer, REST, MCP tool, OpenAPI
- [x] Serving: v2 head (layered base + primitives + Tailwind v4 + aliases), version gate, `__swarm-theme` / `__swarm-mode` resolution
- [x] Dashboard: iframe and Open link pass preset + mode (`key={src}` avoids history entries)
- [x] Agent guidance: pages skill design section + example rewrite, hardcoded-color nudge, docs
- [x] Orchestrator fixes: seed scripts catalog-report (+ .inline) and memory-eval pinned to `designVersion: 1`; apps/ui CLAUDE.md + DESIGN.md paths; ui-e2e pages.spec.ts expects `__swarm-mode=dark`; MCP.md + openapi regenerated; skill line on plain buttons
- [x] Verify (quick gates): 22 checks pass (lint, lint:slop, tsc:check:tsc, boundaries, migrations, dep-graph, rbac, openapi coverage, promises, skill checks, ui lint/tsc/tokens)
- [x] Verify (full, round 1): 18929 pass / 25 fail. 17 fail identically on a clean origin/main checkout (`/tmp/pds-main-baseline`, local env). Branch-caused: check-text-columns (2), db.ts freeze (1), script-connections migration replay (1). seat-mismatch-report is flaky (1 of 3 runs). Others in the 25 were load flakes under --parallel=4.
- [x] Review: standards + spec axes done (`review-standards.md`, `review-spec.md`); QA author feedback in `review-author.md`. Fix list: `2026-10-31-pages-design-system-fixes.md`.
- [x] QA authoring: 5 pages in `/tmp/pds-qa/fixtures/authored/` (0 color literals each)
- [x] Fixes: workflow `wf_70d42f38-762` done (reports `fix-report-{a,b,c}.md`). Migration is now `269_pages_design_system.sql`. Orchestrator extras: linear `<head>` lookup in `injectBrowserSdk` (pre-existing O(n^2) regex, timing test added) and `target="_self"` on `<swarm-diff-jumps>` links (pre-existing: `<base target="_blank">` opened them in a new tab).
- [x] Verify (round 2, quick): 25 gates pass incl. text-columns, openapi + MCP.md freshness, ui lint/tsc/tokens. No em dash in added lines (2 pre-existing ones on touched lines in apps/ui/CLAUDE.md).
- [x] Verify (round 2, full): 18966 pass / 17 fail. 16 fail on clean main too; the 17th (claude-routes-e2e foundry) passes alone on branch and main (load flake). Zero branch-caused failures.
- [x] E2E: `bun run e2e` 28/28 pass. `bun run e2e:ui -- --grep pages` first failed 4 (console 401s on `/p/tailwindcss/theme` and `/utilities`): the browser preload scanner fetches `@import` inside any `<style>` in the markup, even `type="text/tailwindcss"`. Fix: a script creates the `text/tailwindcss` element (`TAILWIND_SOURCE_SCRIPT` in page-head.ts), test guards no `@import` in markup styles. Re-run 6/6 pass.
- [x] Full `bun run e2e:ui`: 103 passed, 28 skipped, 0 failed.
- [x] QA render: 58 shots + recording in `/tmp/pds-qa/shots/` (gallery `/tmp/pds-qa/gallery.html`, report `qa-render-report.md`). v1 baseline pixel-identical. Dashboard passes theme/mode correctly (iframe src table in the report), history stays flat.
- [x] QA fixes: workflow `wf_248c1d7a-661` (Agent Q: hardcoded-color pages stay light, no html bg band, table scroll shadows, tfoot, print tables, in-page anchors, code chips, jump labels, skill lines)
- Deferred (follow-ups for Taras): solarized/tokyo muted-text contrast in the shared presets (dashboard too), Hive chart-1 hue differs by mode, importer does not check brand contrast, search-cancel glyph color.
- [x] Rebase onto main at `3d6d8a750`. All 23 gates passed. Generated files have no drift.
- [x] Final pages browser tests: 6 passed after rebase.
- [x] Final full suite: 19135 passed, 36 skipped, 4 failed. Main also fails the QuickJS binary-body test. The other three pass in isolation on main.
- [x] QA render: API seed, screenshot matrix, dashboard viewer check, and recording completed.
- [x] Commit implementation at `d5d8f5883`.
- [x] Upload five public-safe images and the recording. All five image links return HTTP 200.
- [x] Publish PR #2607 and request approval from desplega-bot.
- [x] Review B1: reject external CSS image functions in token maps and CSS blocks. The regression fails before the fix.
- [x] Review B2: compare the served v1 head against a fixture from main at `3d6d8a750`. A one-byte renderer mutation fails the test.
- [x] Review verification: 96 importer and head tests pass.
- [ ] Receive approval from desplega-bot on the final commit.

## Verification

- `bun run check:local`
- `bun run lint`
- `bun run lint:slop`
- `bun run tsc:check:tsc`
- `bun run test:root -- src/tests/pages-*.test.ts src/tests/theme-*.test.ts`
- `cd apps/ui && bun run lint && bunx tsc -b`
- `bash scripts/check-db-boundary.sh && bash scripts/check-migration-conflicts.sh && bun run check:dep-graph`
- `bun run docs:openapi` (commit regenerated output)
- `bun run build:seed-skill-files && bun run check:skill-sources && bun run check:seed-skill-files`
