---
date: 2026-10-23T13:33:31Z
topic: "Sessions v2: filter menu, select all, and a Done backfill"
status: done
---

# Sessions v2: filter menu, select all, and a Done backfill

## Goal
The sessions v2 sidebar has one filter icon at the right end of the search row. Its menu holds Show (Mine / All) and one checkbox per root source; a cleared source leaves every list and count, Inbox included. Both choices live in localStorage. A checkbox on each section and group row selects its loaded rows, and the bulk bar then offers "Select all N", which triages the whole list on the server (Done, Later, Read, Unread). A one-time migration moves each user's quiet, read sessions (no activity for 7 days) to Done, so the Inbox starts clean.

## Decisions
- Filter menu holds Show + Sources, stored in localStorage (asked).
- Old sessions: one-time backfill to Done, not a rolling rule (asked).
- Backfill cutoff: sessions that read as "read" today and had no activity in the 7 days before the run, for every user who sees them in the tree (owner, direct share, share with everyone). Snoozed, done, and unread rows stay (asked).
- Select all: loaded rows of one list, then "Select all N" on the server by filter (asked).
- Ownerless roots stay out of the tree; #2338 (source keys and sections) is the next plan (asked).
- Sources in the menu come from the tree response (`sources`: each root source with its count, before the hide filter), plus any hidden source, so a hidden source can come back. A static list of 16 sources is too long (assumed).
- Hidden sources go to the server as `hideSource` (an exclude list), so a new source shows by default (assumed).
- "Select all N" covers Done (or back to the Inbox from Done, the `e` toggle), Read, and Unread. Later and Move are left out: moves need a per-root access check with a 200 cap, and Later needs the date menu wired to a filter (assumed).
- No Undo toast on "Select all N": the rows were never loaded, so their old state is unknown. The way back is Select all in Done, then Done again (back to the Inbox) (assumed).
- Backfill also needs a finished latest task and no pending approval: QA showed stuck running sessions and pending approvals landing in Done (assumed, found in QA).
- The desktop bar says "10 of 50 · Select all" (short words: one line with five buttons). The phone top bar says "Select all" (loaded rows), then "Select all 50" (assumed).
- `taskSourceLabel` and the source mark move to `components/shared/task-source-mark.tsx`, shared by the task page and the filter menu (assumed).
- The backfill is a SQL migration (237), not a job: it writes only `inbox_item_state` rows, no key history. 233 to 236 are taken by open PRs (assumed).

## Todo
- [x] Server: `hideSource` filter on `GET /api/sessions` and `GET /api/session-tree`; `sources` counts in the tree
- [x] Server: `POST /api/session-triage` (bulk triage by list filter), RBAC posture, OpenAPI
- [x] Migration 237: Done backfill
- [x] Server tests (tree sources + hideSource, triage by filter, migration)
- [x] UI: hidden-sources store, query keys and params
- [x] UI: filter menu in the search row (desktop + phone), remove `ShowToggle`
- [x] UI: list checkbox on section and group rows, Cmd+A, "Select all N" in the bulk bars
- [x] UI E2E specs that name the Mine / All control (none do)
- [x] QA on /tmp/sff-qa (API :3123, UI :5294): filter menu, hide Slack, All, Cmd+A, Select all 50 → Read → Done, Done → back to Inbox, phone long-press → Select all → Select all 62
- [x] Code review (Standards + Spec), review fixes, commit, PR

## Verification
- `bun run test:root -- src/tests/sessions-tree.test.ts src/tests/migration-237-session-inbox-cleanup.test.ts src/tests/docs-index-footprint.test.js`
- `bun run tsc:check:tsc && bun run lint && bun run lint:slop`
- `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- `bun run check:rbac-coverage && bun run check:openapi-response-coverage && bun run docs:openapi`
- `bash scripts/check-migration-conflicts.sh`
- `cd apps/ui && bun run lint && bunx tsc -b && bun test src/lib/sessions-show.test.ts`
- Fresh DB + existing DB boot (migration 237)
- agent-browser on the QA stack: filter menu, select all, Select all N

## Resumed (2026-10-23)

Every "Fix before commit" item below is applied. `toggleList` and the whole-list rules moved into pure helpers in `tree-rows.ts` (`listSessionIds`, `listSelectState`, `fullListOf`, `wholeListTotal`) with unit tests. New server tests: Later list, sticky readAt, field-level parity with the PATCH write. New migration cases: dismissed, expired snooze, open rows with no cursor. The "Note only" items go to the PR Heads-up.

## Handoff (2026-10-23 ~16:05 BCN)

Taras chose a handoff at 40% context. State: every todo above is done except review fixes, commit, and PR. All work is UNCOMMITTED in the main checkout on branch `feat/sessions-filter-select-all` (from origin/main 39e19f30f; upstream still points at origin/main, so push with `git push -u origin feat/sessions-filter-select-all`). Verification already green: sessions-tree (17), migration-237 (1), docs-index-footprint (4), apps/ui sessions-show + triage-cache + tree-rows (20), `tsc:check:tsc`, apps/ui `lint` + `tsc -b`, `lint:slop`, floating-promises, promise-sinks, rbac-coverage, openapi-response-coverage, audit-columns, migration-conflicts, async-db-seam, db-boundary, fresh-DB boot and existing-DB boot of 237.

### Code review results (two Opus agents, Standards and Spec, both: no Critical)

Fix before commit:
- [Important] `src/be/db/session-tree.ts` `triageSessionList` copies the conflict rules of `upsertInboxState` (`src/be/db.ts:12611`): sticky readAt, conditional lastReadAt, snoozeUntil/dismissedAt reset. Add a cross-reference comment in both places.
- [Important] Tests: no test covers `useSessionSelection` (`fullList`, `wholeList`, `toggleList`, `selectList`). Pull the pure part into a testable helper or add a hook test. Server gaps: whole-list action on Later, `read` over a row with an existing readAt (sticky), a field-level check that list-triage rows equal the PATCH writes. Migration test gaps: dismissed row, expired snooze, open row with null lastReadAt.
- [Minor, real] "Select all N" shows on a fully loaded list: `tree-rows.ts:241` keeps the "View all" row after "Show 10 more" loads all 11 to 20. Offer only when `allRow.total` > the loaded row count.
- [Minor, real] `apps/ui/src/api/client.ts` ~3395: `triageSessionList` went between the JSDoc of `moveSessions` and the method. Move the doc back.
- [Minor] `use-session-triage.ts` toast: use `plural()` from `@/lib/sessions-v2`. `use-session-selection.ts`: the else branch of `toggleList` = `selectList`, call it. `session-tree.ts` `WHERE true`: add a comment (INSERT…SELECT…ON CONFLICT parse workaround). `api/types.ts` `sources` comment: drop "absent before 2.5.2". Bulk-bar label strings are derived twice (desktop + phone): one helper. `hideSource` query param: add the same `.max(32)` cap as the body.

Note only (decide or mention in the PR Heads-up):
- `session-tree.tsx` grew ~120 lines of whole-list logic; a `useWholeListTriage` hook would hold it.
- Later wake alerts (`hooks/use-later-notifier.ts:58`) read the tree, so a hidden source's snoozed session wakes with no alert.
- A group that holds only hidden-source sessions leaves Move targets, `in:` and Start-in (Mine already does this for machine-only groups).
- `lib/sessions-show.ts` now holds the whole filter; the name still says "show".

### Next steps
1. Apply the fixes above, re-run the Verification commands, then `bun run check:local`.
2. Commit (one commit is fine).
3. Media: restart the QA stack (recipe below), take the after screenshots and a recording (`agent-browser record start /tmp/sff-qa/flow.mp4`). Before image: reuse the #2347 desktop screenshot `https://github.com/user-attachments/assets/0303ecda-1ae7-407a-8b5d-2514c14a7dee`. The `github-attach` skill is NOT installed on this machine: upload images with `agent-fs write qa/agent-swarm/2026-10-23-sessions-filter/<name>.png --file …` + `agent-fs signed-url … --inline --json`, the mp4 with `agent-fs share-create`.
4. PR body per `.github/pull_request_template.md` (Risk: high, migration + bulk writes; Urgency: nice to have), check with `bun scripts/check-pr-body.ts`, then `gh pr create`.
5. Then `/desplega:create-plan` for #2338. Taras decisions: source sections collapsed by default (brainstorm A3/A11), the filter menu's Sources hide them; ownerless roots stay out (A17 env gate is a follow-up).
6. Cleanup after the PR: `rm -rf /tmp/sff-qa`, `agent-browser close` (session `sff-qa`), `df -h /`.

### QA stack (no servers running now)
- DB: `cp /tmp/sv2-qa/db.sqlite /tmp/sff-qa/db.sqlite` (a fresh copy re-runs 237; the current copy already has it plus QA triage writes).
- API :3123 from the repo root: `DATABASE_PATH=/tmp/sff-qa/db.sqlite PORT=3123 DESPLEGA_TELEMETRY_ENV=test SWARM_DEV_MODE=true` + every `*_DISABLE=true` (AGENTMAIL AZURE_DEVOPS BITBUCKET GITHUB GITLAB JIRA LINEAR SLACK OAUTH_KEEPALIVE OAUTH_REFRESH_SWEEP) + blank `OPENAI_API_KEY OPENROUTER_API_KEY ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN BUSINESS_USE_API_KEY SLACK_BOT_TOKEN SLACK_APP_TOKEN GITLAB_TOKEN DEVIN_API_KEY COMPOSIO_API_KEY GITHUB_APP_PRIVATE_KEY`, then `bun run start:http`.
- UI :5294: `cd apps/ui && VITE_PROXY_TARGET=http://localhost:3123 bunx vite --port 5294 --strictPort`.
- Browser: `AGENT_BROWSER_SESSION=sff-qa`, open `http://localhost:5294/sessions?apiUrl=http://localhost:5294&apiKey=123123&email=alex@example.com`, Save & Connect, Skip the guide. Alex = `09e89644-a1fc-4166-a0e1-f419b88ad7f1`. API probe: `bun /tmp/sff-qa/q.ts "/api/session-tree?hideSource=slack" <userId>`.
- Screenshots so far in `/tmp/sff-qa/*.png` (menu 03/04, list checkbox 05/06, offer 07, whole list 08, Cmd+A 10, phone 13 to 16).
