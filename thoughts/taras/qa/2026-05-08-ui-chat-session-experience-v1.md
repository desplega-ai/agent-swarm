---
date: 2026-05-08
topic: "UI Chat/Session Experience v1 — QA Report"
author: taras
status: scaffold
plan: thoughts/taras/plans/2026-05-08-ui-chat-session-experience.md
related:
  - thoughts/taras/plans/2026-05-08-ui-chat-session-experience.md
  - thoughts/taras/research/2026-05-08-ui-chat-session-experience-research.md
  - thoughts/taras/brainstorms/2026-05-08-ui-chat-session-experience.md
---

# UI Chat/Session Experience v1 — QA Report

## Context

QA evidence collection for the bundled v1 launch covering the Sessions surface + Dashboard revamp + identity gate + version-gate. Frontend PRs touching `ui/` require a `qa-use` session with screenshots per the merge gate (`runbooks/testing.md`).

Run the API + UI dev servers per `LOCAL_TESTING.md`:

```bash
# Terminal 1
bun run start:http              # API on :3013

# Terminal 2
cd ui && pnpm dev               # UI on :5274

# Terminal 3 (optional, for full E2E with lead/worker)
bun run docker:build:worker
bun run pm2-start
```

## Scope

### In Scope (this report)
- `/sessions` (list)
- `/sessions/:rootTaskId` (detail + composer + transcript Sheet + parallel-group rendering)
- `/` (new dashboard: react-flow agent canvas + tabular fallback + action-items inbox)
- Identity boot modal + per-swarm namespacing
- Version-gate soft-degrade
- Console-error sweep
- Per-bucket inbox actions (dismiss / snooze / done)

### Out of Scope (deferred to v2 per plan §"What We're NOT Doing")
- Animated react-flow edges, pulse-on-active, failure visuals
- "Agent flagged this as interesting" signal
- Mobile-optimized timeline
- Custom user-authored quick-start templates
- Sharing / multi-user-visible sessions
- PR-awaiting-review bucket source
- Sub-second feel (SSE/WS)
- Hard version-block

---

## Test Cases

### Phase 3 — Identity gate

#### Scenario A — First-time identity modal

**Steps**:
1. `localStorage.clear()` in browser devtools
2. Navigate to `http://localhost:5274/`
3. Wait for `useHealth()` resolution
4. Identity modal should auto-pop
5. Click an existing user row from the list
6. Reload the page

**Expected**:
- Modal appears within ~500ms of page load
- Modal lists existing users from `/api/users` with name + email
- Modal has an inline "Create new user" form (name + optional email)
- Modal cannot be dismissed (no `X`, no escape-key)
- After picking, modal closes; main app renders
- After reload, modal does NOT re-pop (selection persisted)

**Actual**: _to be filled by implementer_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-A-modal-first-load.png`, `screenshots/scenario-A-modal-after-pick-reload.png`

---

#### Scenario A2 — Per-swarm namespacing

**Steps**:
1. With identity already picked on swarmId `A` (default local boot), confirm via `localStorage.getItem('agent-swarm-current-user:<swarmIdA>')`
2. In a separate terminal, start a second API: `SWARM_ID=swarm-b PORT=3014 bun run start:http`
3. In browser, point UI at the new swarm: `http://localhost:5274/?apiUrl=http://localhost:3014`
4. Identity modal must re-pop (different swarmId → different localStorage key)
5. Pick a different user
6. Switch back to the original URL: `http://localhost:5274/`

**Expected**:
- Modal re-pops on swarm switch
- Original identity intact when switching back
- Two separate localStorage keys present: `agent-swarm-current-user:<swarmIdA>` and `agent-swarm-current-user:swarm-b`

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-A2-modal-on-swarm-switch.png`, `screenshots/scenario-A2-localStorage-both-keys.png`

---

#### Scenario A3 — Auto-show on stale-userId (deleted-user case)

**Steps**:
1. Pre-seed `localStorage.setItem('agent-swarm-current-user:<swarmId>', 'non-existent-user-id')`
2. Reload page

**Expected**:
- `<CurrentUserProvider>` `state` recomputes to `needs-pick` because `useUsers()` has no row matching the stored id
- Identity modal re-pops

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-A3-modal-on-stale-userId.png`

---

#### Scenario B — `requestedByUserId` flows from CreateTaskDialog

**Steps**:
1. With identity picked, navigate to `/tasks`
2. Click "New Task"
3. Fill the form: `task: "QA scenario B test task"`
4. Submit
5. Run: `sqlite3 agent-swarm-db.sqlite "SELECT id, task, requestedByUserId FROM agent_tasks ORDER BY createdAt DESC LIMIT 1;"`

**Expected**:
- New row's `requestedByUserId` matches the picked user's id from localStorage

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-B-task-detail.png`, terminal capture of SQL output

---

#### Scenario C — `requestedByUserId` displayed on TaskDetailPage

**Steps**:
1. Open the task created in Scenario B at `/tasks/<id>`
2. Inspect the QuickStats rail

**Expected**:
- "Requested by" QuickStat shows the user's name (resolved via `useUsers()` cache)

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-C-task-detail-requested-by.png`

---

### Phase 4 — Sessions surface

#### Scenario D — Sessions list + detail + transcript Sheet

**Steps**:
1. Have at least one session (root task with chain children) — created via the `bun run pm2-start` lead/worker flow OR manually via curl (see plan Manual E2E step 7)
2. Navigate to `/sessions`
3. Confirm sidebar lists recent sessions
4. Click a session row
5. Detail panel renders a timeline
6. Click a task card
7. Sheet opens on the right with transcript

**Expected**:
- Sidebar shows root task title, last activity (relative time), task count, latest status
- Detail header: root title, requested-by user, status, total tasks
- Timeline cards collapsed by default (status + agent + last 1-2 log entries)
- Sheet contains `<SessionLogViewer>` with logs + compaction snapshots, plus a "Costs" sub-section

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-D-sessions-list.png`, `screenshots/scenario-D-detail.png`, `screenshots/scenario-D-sheet-open.png`

---

#### Scenario E — Composer creates next task in chain

**Steps**:
1. From a Session detail page, focus the composer at the bottom
2. Type "Now write a regression test"
3. Click Send (or `Cmd/Ctrl+Enter`)
4. Wait ~5s for polling tick
5. SQL spot-check: `sqlite3 agent-swarm-db.sqlite "SELECT id, parentTaskId, requestedByUserId, source FROM agent_tasks ORDER BY createdAt DESC LIMIT 1;"`

**Expected**:
- New card appears in the timeline within 5s
- `parentTaskId` matches the latest leaf in the chain
- `requestedByUserId` matches the picked user
- `source = 'api'`

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-E-composer-before.png`, `screenshots/scenario-E-after-send.png`, terminal capture of SQL

---

#### Scenario F — Parallel-group wrapper

**Steps**:
1. Create a 3-sibling parallel session via curl (plan Manual E2E step 7b):
   ```bash
   USER_ID=$(curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/users | jq -r '.users[0].id')
   ROOT=$(curl -s -X POST http://localhost:3013/api/tasks -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d "{\"task\":\"Parallel group test\",\"source\":\"api\",\"requestedByUserId\":\"$USER_ID\"}" | jq -r '.task.id')
   for i in 1 2 3; do curl -X POST http://localhost:3013/api/tasks -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d "{\"task\":\"sibling $i\",\"source\":\"api\",\"parentTaskId\":\"$ROOT\",\"requestedByUserId\":\"$USER_ID\"}"; done
   ```
2. Navigate to `/sessions/$ROOT`

**Expected**:
- Timeline shows the root, then a `[parallel · 3 tasks]` wrapper with the 3 siblings inside
- Wrapper styling matches `border-border bg-muted/30` (no raw palette literals)
- Sibling order = `createdAt` ascending

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-F-parallel-group.png`

---

#### Scenario G — Version-gate soft-degrade for `/sessions`

**Steps**:
1. Stop the API server
2. Edit `package.json` version: `"1.76.0"` → `"1.74.0"` (simulating a stale API)
3. Restart API: `bun run start:http`
4. In UI, reload `/sessions`

**Expected**:
- `/sessions` route renders the upgrade-required page (not the new UI)
- Sidebar entry for "Sessions" shows a disabled tooltip: "Requires API ≥ 1.76.0"
- Restoring `package.json` to `1.76.0` and restarting brings back full functionality

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-G-upgrade-required.png`, `screenshots/scenario-G-sidebar-disabled-tooltip.png`

---

### Phase 5 — Dashboard agent canvas

#### Scenario H — Canvas renders org chart

**Steps**:
1. Have ≥1 lead + ≥1 worker registered (via `bun run pm2-start`)
2. Navigate to `/`
3. Wait for canvas to render

**Expected**:
- Canvas renders within 2s
- Lead at top, worker(s) below
- Edges drawn lead → each worker
- Node sizes visually distinguishable between idle and most-active agents

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-H-canvas.png`

---

#### Scenario I — Click-through to agent detail

**Steps**:
1. Click a worker node on the canvas

**Expected**:
- Browser navigates to `/agents/<id>`

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-I-after-click.png`

---

#### Scenario J — Tabular fallback toggle

**Steps**:
1. From the dashboard, click the `[Table]` toggle at the top of the canvas region
2. AG Grid renders with columns: name, role, status, taskCount24h, cost24h
3. Click a column header to sort
4. Reload the page

**Expected**:
- Table renders the same agents
- Sort works (AG Grid built-in)
- After reload, view persists as Table (localStorage `agent-swarm-dashboard-view`)

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-J-table-view.png`, `screenshots/scenario-J-after-reload.png`

---

#### Scenario K — Dashboard version-gate fallback

**Steps**:
1. Force `package.json` version to `1.74.0` (per scenario G)
2. Reload `/`

**Expected**:
- Legacy 4-section dashboard renders unchanged (StatsBar + Agent Status Grid + Active Tasks Panel + Activity Feed)
- No new react-flow canvas, no inbox panel

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-K-legacy-dashboard.png`

---

### Phase 6 — Action-items inbox

#### Scenario L — All four buckets render seeded items

**Steps**:
1. Seed each bucket via API:
   - **Blocking**: have an agent in `waiting_for_credentials` state (via lead/worker flow or direct API)
   - **Blocking**: have a pending approval request via `POST /api/approval-requests`
   - **Broken**: cancel a task: `curl -X POST http://localhost:3013/api/tasks/<id>/cancel -H "Authorization: Bearer 123123"`
   - **To read**: complete a chain via the lead/worker
   - **To start**: ensure migration `057_task_templates.sql` ran (rows seeded)
2. Navigate to `/`
3. Inspect the inbox panel

**Expected**:
- All four buckets visible with non-zero counts
- Bucket headers + count badges accurate

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-L-inbox-all-buckets.png`

---

#### Scenario M — Dismiss persists across reload

**Steps**:
1. From any bucket, click "Dismiss" on an item
2. Item disappears optimistically
3. Reload the page

**Expected**:
- Item stays dismissed
- SQL: `sqlite3 agent-swarm-db.sqlite "SELECT itemType, itemId, status FROM inbox_item_state WHERE status='dismissed' ORDER BY lastUpdatedAt DESC LIMIT 1;"` → matches the dismissed item

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-M-before-dismiss.png`, `screenshots/scenario-M-after-dismiss-reload.png`, terminal SQL capture

---

#### Scenario N — Snooze flow

**Steps**:
1. From any bucket, click "Snooze ▼" on an item
2. Pick "1h"
3. Item disappears
4. SQL: `sqlite3 agent-swarm-db.sqlite "SELECT itemType, itemId, status, snoozeUntil FROM inbox_item_state ORDER BY lastUpdatedAt DESC LIMIT 1;"`

**Expected**:
- `status = 'snoozed'`
- `snoozeUntil` is approximately 1h in the future (allow ±30s)

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-N-snooze-menu.png`, terminal SQL capture

---

#### Scenario O — "To start" template pre-fills CreateTaskDialog

**Steps**:
1. In the "To start" bucket, click any template card (e.g. "Refactor a file")
2. `CreateTaskDialog` opens

**Expected**:
- `task` field is pre-filled from `template.prompt`
- `tags` field is pre-filled from `template.tags`
- User can edit before submitting

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-O-template-prefilled.png`

---

### Phase 7 — Polish + console-error sweep

#### Scenario P — Empty states

**Steps**:
1. With a fresh DB (`rm agent-swarm-db.sqlite && bun run start:http`), pick identity, then visit each surface:
   - `/sessions` (no sessions yet)
   - `/sessions/<some-id>` (chain-empty case)
   - `/` (canvas with no agents; inbox with all-empty buckets)

**Expected**:
- Each surface renders its `<EmptyState>` primitive (icon + headline + description + CTA)
- No CLS / layout-shifted skeletons

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-P-empty-sessions.png`, `screenshots/scenario-P-empty-detail.png`, `screenshots/scenario-P-empty-dashboard.png`, `screenshots/scenario-P-empty-inbox.png`

---

#### Scenario Q — Console-error sweep

**Steps**:
1. In browser devtools, before any navigation: instrument `window.console.error`:
   ```js
   const orig = window.console.error.bind(window.console);
   window.__sawError = false;
   window.console.error = (...args) => { window.__sawError = true; orig(...args); };
   ```
2. Run all qa-use scenarios A through O end-to-end
3. At end, evaluate `window.__sawError`

**Expected**:
- `window.__sawError === false`
- If true, devtools console history is captured as evidence and a follow-up issue is filed

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `screenshots/scenario-Q-console-clean.png` OR error log capture

---

### Final E2E (plan Manual E2E §1–12)

#### Scenario E2E-1 — Full walkthrough

**Steps**: run plan §"Manual E2E" steps 1 through 12 verbatim

**Expected**: every assertion in those steps passes

**Actual**: _to be filled_

**Status**: ☐ pass / ☐ fail / ☐ blocked

**Evidence**: `recordings/e2e-walkthrough.mp4` OR step-by-step screenshots

---

## Verdict

**Overall status**: ☐ PASS / ☐ FAIL / ☐ BLOCKED

**Summary**: _to be filled by implementer after running scenarios_

**Blockers (if any)**: _list any failed scenarios that block merge_

**Follow-ups**: _list any non-blocking issues discovered_

---

## Evidence Manifest

All screenshots and recordings live in: `thoughts/taras/qa/evidence/2026-05-08-ui-chat-session-experience-v1/`

Naming convention: `<scenario>-<descriptor>.png`

Required minimum (frontend merge gate per `runbooks/testing.md`):
- 1+ screenshot per UI page touched: `/sessions` list, `/sessions/:id` detail, dashboard canvas, dashboard inbox, identity modal, version-gate fallback page

External references:
- Plan: `thoughts/taras/plans/2026-05-08-ui-chat-session-experience.md`
- PR: _filled when opened_
- CI run: _filled when CI passes_
