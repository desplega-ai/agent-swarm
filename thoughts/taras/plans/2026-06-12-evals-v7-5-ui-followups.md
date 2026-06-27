---
date: 2026-06-12T14:45:00Z
topic: "Evals v7.5 — UI follow-ups from Taras (queued behind round 7)"
status: queued
branch: feat/evals-subproject
pr: 737
---

# Evals v7.5 — UI follow-ups (apply AFTER round 7 lands)

Seven items from Taras, reported 2026-06-12 ~14:40–15:00 while round 7 (`wj2ykmb5c`) was mid-wave-1.
Deliberately NOT injected into the running workflow — apply against the post-round-7 tree,
since WP-RD7 is rewriting the exact run-detail surfaces involved (Workers section, per-task
sub-tabs). Implement as a follow-up commit after the round-7 commit, before/with the main merge.

## 1. Run detail left panel: worker task-id overflow

Task IDs listed in the worker block overflow the left panel. Fix with truncation +
ellipsis (`min-width: 0` on the flex child, `text-overflow: ellipsis`) and full ID on
hover (existing portal tooltip) and/or click-to-copy. Check the round-7 Workers section
(roster / cost-per-worker / lead badge) for the same failure mode with long IDs.

## 2. Surface task status + outcome/error per task

We already store the swarm task records per attempt (runner persists a tasks artifact —
see `evals/src/runner/index.ts` "[artifacts] persisting transcript, session files, tasks").
Records carry task `status` and `outcome`/error payloads from the swarm task API.
Surface in run detail:
- status chip per task (reuse glyph-status / ConfigChip conventions),
- outcome text or error message, clamped with expand (same clamp pattern as WP-SCEN7
  desc/rubric).
Natural slot: the round-7 per-task transcript sub-tabs header. Cascade-skipped deps
(R6 `dependsOn` semantics) should read distinctly from real errors.

## 3. Run logs: selectable, copyable, searchable

Applies to ALL log surfaces (Logs tab incl. severity view, runner.log, boot/entrypoint
logs):
- text selection must work (audit for `user-select: none` / drag handlers swallowing it),
- "Copy all" button per log view (clipboard write of the raw log),
- search box: filter or highlight matching lines (case-insensitive substring is fine),
  with match count.

## 4. Transcript tab bar: sticky + status indicators

The transcript view's tab row (Live / All / per-task breakdown sub-tabs, the round-7
WP-RD7 surface) must be sticky to the top of the scroll container so it stays visible
while scrolling the transcript. Each tab gets a status indicator (reuse the glyph-status
language: running/passed/failed/error per task; live dot for Live).

## 5. Left bar task list: multi-row, dependency indicator, clickable

Tasks in the run-detail left panel should render as multiple rows (one per task — no
single-line cramming/overflow; complements item 1). Each row shows:
- a dependency indicator when the task has `dependsOn` (R6 semantics) — e.g. an arrow/link
  glyph with tooltip naming the dependency, distinct rendering for cascade-skipped,
- status chip (ties into item 2),
- clickable: selecting a task row focuses that task in the right panel (the per-task
  transcript sub-tab from WP-RD7).

## 6. Cost per task

Surface cost attribution per task, not just per attempt / per worker (WP-CORE adds
per-member attribution). Session costs are captured per harness session (session-costs.json
artifact) — map sessions → tasks to show a per-task cost figure in the left-bar task rows
(item 5) and/or per-task sub-tab header. If a clean session→task mapping isn't available
for some harness, render "—" rather than misattributing.

## 7. Worker identity: set TEMPLATE_ID correctly (no more `worker-7dd474ae`)

Workers currently boot without TEMPLATE_ID by default (WP-CORE's sandbox.test.ts:
"default member: no identity keys ... TEMPLATE_ID undefined"), so agents register with
generic hash names like `worker-7dd474ae`. Required:
- lead member boots with `AGENT_ROLE=lead` + `TEMPLATE_ID=official/lead` (compose
  reference: docker-compose.local.yml lead service),
- default worker members get a sensible default template too (pick the right slug from
  `templates/official/` — e.g. `coder` — confirm with the worker entrypoint),
- **verify slug format**: evals `types.ts` v7 comment says bare slug ("coder",
  "researcher") while compose uses namespaced `official/lead` — confirm what the
  entrypoint's profile fetch actually accepts and use that consistently.

## Verification

- `cd evals && bun run tsc:check && bun test src/`
- `bun run ui:build`, restart :4801, manual QA (Taras manual-QAs the SPA — no qa-use).
- Open a multi-worker run: long task IDs don't overflow; task status/outcome + cost per
  task visible; task rows clickable with dependency indicators; transcript tab bar stays
  pinned while scrolling with correct status glyphs; select+copy+search work on every
  log tab.
- Item 7 needs one cheap E2E (single scenario, lead + 1 worker) to confirm agents
  register with template-derived names instead of `worker-<hash>`.
