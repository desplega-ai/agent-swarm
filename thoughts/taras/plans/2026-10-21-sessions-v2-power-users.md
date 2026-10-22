---
date: 2026-10-21
author: Taras
topic: "Sessions v2: power-user sessions view (tree, triage, turn timeline, tabs, mobile)"
tags: [plan, ui, sessions, grouping, power-users]
status: completed
autonomy: autopilot
commit_per_phase: true
git_base: c0711aa2f
branch: feat/sessions-v2
---

# Sessions v2 Implementation Plan

## Overview

Replace the dashboard sessions page with the "A+B merged" design from `mockups/sessions-v2/`. The new view has a group tree sidebar, triage (Inbox, Later, Done, read state), a turn-shaped timeline with folded worker lines, tabs with one split, and a phone layout. The current page stays available behind a "Legacy sessions" toggle. One branch, one PR, one commit per phase.

- **Motivation**: brainstorm decision A34. A customer call showed that power users care about grouping. Taras approved the round 10 mockup ("love it") and asked for one PR.
- **Related**:
  - Brainstorm: `thoughts/taras/brainstorms/2026-10-20-sessions-ui-power-users.md` (Key Decisions 1 to 18, Amendments A1 to A34).
  - Research: `thoughts/taras/research/2026-10-20-sessions-ui-power-users.md`.
  - Spec: `mockups/sessions-v2/SPEC.md`. Round 10 is at the top, and newer rounds override older ones.
  - Polish checklist: `mockups/sessions-v2/UX-REVIEW-R9.md` (95 findings, each names the shipped primitive or token).
  - Mockup: `mockups/sessions-v2/option-ab-merged/index.html` and `mobile.html` (open them directly, no server).
  - The mockups moved out of the repo on 2026-10-22 (Taras: keep 48k lines of HTML out of PR #2329). They live in agent-fs at `/mockups/agent-swarm/sessions-v2/`, with the same layout. Every `mockups/sessions-v2/` path in this document points there.

## Current State Analysis

### Backend

- **Session list.** `GET /api/sessions` (`src/http/sessions.ts:407-458`, handler `:634-683`) calls `listRecentSessions` (`src/be/db.ts:12971-13073`).
  - A session is a root task (`parentTaskId IS NULL`). A recursive CTE walks the chain and returns `chainTaskCount`, `lastActivityAt`, and `latestStatus`.
  - Filters: `source`, `q` (root task text and title only), `requestedByUserId`, `contextKeyPrefix`, `scope` (`mine` or `shared`). Paging is `LIMIT`/`OFFSET`, default 25, no server maximum.
  - All filters sit in the seed `WHERE` of the recursive CTE. The CTE then walks the chain of every matching root before `ORDER BY lastActivityAt ... LIMIT`.
  - There is no filter on the asset key (`agent_tasks."key"`), no read-state filter, and no per-group counts.
  - `countSessions` (`db.ts:13081-13122`) returns a filter-aware `total`. It counts roots only and does not walk chains.
  - `SessionListItemSchema` is local to `src/http/sessions.ts:98-103`. It is not in `src/types.ts`.
- **Visibility.** `sessionViewerCondition` (`src/be/db/session-visibility.ts:10-29`). Scope `all` includes roots with `requestedByUserId IS NULL` (known exposure, out of scope here). The actor comes from `resolveSessionActor` (`src/http/session-access.ts:36-50`): a user token, or the operator key plus the `x-swarm-user-id` header (`src/http/favorite-owner.ts:17`). An operator with no picked user is a bypass actor and sees all roots.
- **Session detail.** `GET /api/sessions/{rootTaskId}` (`sessions.ts:460-484`, handler `:685-732`) returns `{root, chain, access, owner}`. `getRootTaskChain` is at `db.ts:12904-12918`.
- **Read state.** Table `inbox_item_state` (`src/be/migrations/057_inbox_item_state.sql`, plus `readAt` in 156 and `lastReadAt` in 227). Unique key `(userId, itemType, itemId)`. Routes: `GET /api/inbox-state`, `PATCH /api/inbox-state`, `PATCH /api/inbox-state/bulk` (1 to 200 items) in `src/http/inbox-state.ts`. Only clients write rows. The my-swarm app writes `to_read` rows with `itemId` = root task id.
- **The app's read rule** (`~/Documents/my-swarm/swarm-app/src/lib/inbox-sections.ts:22-33`, `threadState`): no row = unread. `dismissed` = hidden. `done` = hidden until newer activity than `lastUpdatedAt`, then unread. `snoozed` = Later until `snoozeUntil`, then unread. Otherwise unread when activity is newer than `lastReadAt ?? lastUpdatedAt`.
  - Mark read writes `{status:"open", readAt: now, lastReadAt: <session lastActivityAt>}`. Mark unread writes `lastReadAt: "1970-01-01T00:00:00.000Z"` (`swarm-app/src/lib/api.ts:257,261`).
  - A visit writes the read mark only when the thread is unread (`shouldMarkRead`, `inbox-sections.ts:113-115`). The write sets `status:"open"`, so an unconditional write ends a Done or Later state.
  - `upsertInboxState` (`db.ts:12640`) writes ISO timestamps, the same format as `agent_tasks.lastUpdatedAt`. Text comparison in SQL is safe.
- **Asset keys.** Column `agent_tasks."key"` with `idx_agent_tasks_asset_key` (`src/be/migrations/115_asset_namespace_keys.sql:8,21`). Root default key: `shared/task:<rootId>/` (`defaultAssetKey`, `src/assets/key.ts:81-84`). A child copies its parent's key (`db.ts:2683-2684`). `normalizeAssetKey` (`key.ts:45`): lowercase, trailing `/`, at most 255 characters, root `shared/` or `personal/<uid>/`. A segment can hold a `:`.
  - Schedule and workflow tasks take the schedule or workflow key (`src/scheduler/schedule-task.ts:25`, `src/workflows/executors/agent-task.ts:98`). Their defaults are `shared/schedule:<id>/` and `shared/workflow:<id>/`.
- **Moves.** `PATCH /api/assets/{entityType}/{id}/key` (route `src/http/assets.ts:170-185`, handler `:306-390`) with `cascade` for tasks. It checks `task.fs.mutate` on every chain task (`canMutateTaskNamespace`, `:186-200`, not exported). `moveAssetKey` (`db.ts:1736`) runs the full `auditAssetKeys` (`src/be/asset-key-audit.ts:104-188`, 7 tables) per call, and any issue (warnings included) returns 409. No bulk or prefix move exists.
  - The legacy RBAC policy admits every operator and every user for `task.fs.mutate` (`src/rbac/legacy-policy.ts:223-227`). So today a read-only sharee can move another person's session.
  - A move does not change `lastUpdatedAt` (`db.ts:1797`), so it does not change the read state.
- **Create with a key.** `POST /api/tasks` already accepts `key` (body field `src/http/tasks.ts:295`) and checks it with `authorizeAssetKeyWrite` (`:1084-1096`).
- **Shares.** Table `session_shares` (migration 230). Helpers in `src/be/session-shares.ts`. "Shared with me" is `GET /api/sessions?scope=shared`.
- **People.** `agent_tasks.requestedByUserId` (migration 031). `users` has `name` and `email` but no avatar or color column. No bulk user-by-ids endpoint exists. `GET /api/users` returns all users.
- **Approvals.** `approval_requests.sourceTaskId` links a request to a task (index `idx_approval_requests_task`), with `status` `pending|approved|rejected|timeout|cancelled` (migrations 020 and 140). The UI route is `/approval-requests/:id`.
- **Rename** ships: `PATCH /api/tasks/{id}/title` (`src/http/tasks.ts:760-781`), 120 characters, does not bump `lastUpdatedAt`.
- **Highest migration**: 232. This plan adds no migration.
- **Tests**: `src/tests/sessions.test.ts`, `inbox-state.test.ts`, `asset-key-api.test.ts`, `session-sharing-routes.test.ts`. Pattern: `initDb("./test-<name>.sqlite")`, a Node `createServer` that calls the handler, `listenOnFreePort`, `setRequestAuth` for the actor. `session-route-posture.test.ts` walks the route registry and checks the session posture of every route.
- **Handler chain.** `src/http/index.ts:345-415` calls each handler file in order. A new handler file needs an entry there and an import in `src/http/all-routes.ts`. Routes added to `src/http/sessions.ts` need neither.
- **Dev seed.** `scripts/seed.ts` writes through raw `bun:sqlite` and creates no users. Its tasks use sources `mcp`, `slack`, and `api` (`:664`), not `ui`. `seed:people` creates users through `POST /api/users`, so it needs a running API.

### Frontend (`apps/ui`)

- **Routes** `sessions` and `sessions/:rootTaskId` (`src/app/router.tsx:153-154`). `SessionsShell` (`src/components/sessions/sessions-shell.tsx`) has a 300 px list, `source:["ui"]` by default, and a "Switch session" `Select` below `lg` (`:312-334`).
- **Timeline.** `SessionTimeline` and `buildTimelineTree` (`src/components/sessions/session-timeline.tsx:339,135`) draw a parent-to-child tree with `ParallelGroup` (`task-card.tsx:350-414`). `session-conversation.tsx` has a "Latest" button and the composer. `composer-dock.tsx`, `task-outcome.tsx` (with `OutcomeCopyShell`), `share-session-dialog.tsx`, `session-presence.tsx`, `new-session-view.tsx`, `use-start-session.ts` all ship.
- **Data.** `listSessions`, `getSession`, `updateTaskTitle`, `listInboxState`, `patchInboxState` in `src/api/client.ts:3320-3444`. No client method calls `PATCH /api/inbox-state/bulk`. `createTask` already accepts `key`. Hooks in `src/api/hooks/use-sessions.ts` (`useSessions` with an options object) and `use-inbox-state.ts` (optimistic with rollback). Types are hand-written in `src/api/types.ts`. The user comes from `useCurrentUser()`.
- **Polling.** Every query polls every 10 s by default (`src/app/providers.tsx:15`).
- **Older APIs.** The hosted dashboard can talk to an older API. New surfaces sit behind `useFeatureGate(<min version>)` (`src/api/hooks/use-feature-gate.ts`), as sharing does (`lib/session-sharing.ts:19`). A dev-mode API bypasses the gate.
- **Primitives** that exist: `DataGrid`, `ListPager`, `SegmentedControl`, `TaskStatusIcon`, `StatusBadge`, `AgentAvatar`, `AvatarStack` (`components/comb/presence-avatars.tsx:33`, colors from `peerColor` in `lib/comb/presence.ts:398`, initials from `userInitials` in `components/shared/user-chip.tsx:6`), `Sheet`, `Dialog`, `AlertDialog`, `Popover`, `DropdownMenu`, `Tooltip`, `AnimatedReveal`, `EmptyState`, `MobileList`, `useIsMobile` (768 px), `Kbd`, `CopyValueButton`, `useCopyToClipboard`, `useLocalToggle`, `useUrlSearchState` (`hooks/use-url-search-state.ts`), `useAutoScroll` (`hooks/use-auto-scroll.ts`, used by `session-conversation.tsx:89`), `MiddleTruncation`, `BrandLogo`.
- **`useLocalToggle`** syncs other browser tabs through the `storage` event only (`use-local-toggle.ts:49-57`). Two hook instances in the same tab do not see each other's writes until a remount.
- **Missing primitives**: Checkbox (`radix-ui` 1.4 is installed), HoverCard (also in `radix-ui`), a drag-to-close bottom sheet (`vaul` is not installed), and a way for a page to add commands to `CommandMenu` (its groups are hard-coded, `command-menu.tsx:126-248`, mounted in `components/layout/root-layout.tsx:109`).
- **UI E2E.** The `mobile-iphone` Playwright project runs only `composer-enter-key.spec.ts` (`packages/ui-e2e/playwright.config.ts:33-36`). Other specs run on desktop Chromium only.
- **Global nav** is `<Sidebar collapsible="icon">` (`app-sidebar.tsx:393`). `useCollapseNavWhile` (`context-panel/context-session-panel.tsx:60-78`) collapses it while a view is active. That hook is local and not exported.
- **Libraries**: `@dnd-kit/*` (used by the kanban), `@tanstack/react-virtual`, `cmdk`, `motion`, Tailwind 4 (container queries built in).
- **Rules** (`apps/ui/CLAUDE.md`, `DESIGN.md`): DataGrid for data lists (MobileList below `md`), semantic tokens only (`bun run check:tokens`), `ease-swift` for sheets (400/250 ms), `ease-snappy` for menus (150/100 ms) and dialogs (200/150 ms), exits faster than enters, no animation on keyboard actions or polls.

## Desired End State

- `/sessions` and `/sessions/:rootTaskId` render the new view by default. "Legacy sessions" in the header (and in Cmd+K) switches to today's view, per browser. `?legacy=1` forces the old view.
- The sidebar shows Inbox, Later, Done, No group, My groups, and Shared with me, with counts from the server. Groups are key prefixes and nest by `/`. A shared session sits at its real key path. "Shared with me" holds other people's `personal/<owner>/` groups, by owner (brainstorm decision 4). Each container shows 10 rows, then "Show 10 more", then "View all N" (a group tab with DataGrid, ListPager, and SegmentedControl).
- Read, Done, and Later work from rows, menus, keys, the header, and the bulk bar. They write `inbox_item_state` with the same rule as the my-swarm app, so both clients agree.
- Users can create, rename, and delete groups, and move sessions by bulk selection, drag, the move picker, and Cmd+K.
- The session pane has the two-row header, the People pill, rename, share, and a turn timeline with folded worker lines, copy buttons, and long-title truncation (SPEC Round 8 to 10).
- Tabs and one split live in the URL. A status bar shows live counts.
- Below 768 px the view is a list screen, then a detail screen with history, bottom sheets, swipe, and long-press.
- Every gate command passes, the UI E2E suite passes, and the PR has screenshots and a recording.

## What We're NOT Doing

- Source sections for Slack and Telegram, the source filter, the source-key backfill, label maps, DM-only visibility (brainstorm A34). Slack sessions that I requested still appear in my tree, in No group.
- Two-way Slack: storing human Slack messages, relaying dashboard replies, the "Reply in the Slack thread" composer mode.
- The `conversations.replies` "oldest 20" bug and the `requestedByUserId IS NULL` exposure. Both are separate follow-ups.
- Forks and nested Slack-thread groups (withdrawn, A1 and A2).
- A server-side wake job for Later. The browser notifies while the dashboard is open (A13).
- Group colors, manual group order, group mute (decision 18).
- New tables or migrations.
- Changes to the my-swarm app.

## Implementation Approach

- **Backend first (Phases 1 and 2), then the frontend in layers (Phases 3 to 9), then polish and the PR (Phase 10).** Each phase leaves the app working. The new view stays behind the preference until Phase 3 makes it the default. Phase 3 lands the shell, so later phases fill it in.
- **The new view lives in `apps/ui/src/components/sessions-v2/`.** The legacy view keeps today's components unchanged, so "Legacy sessions" needs no frozen copy.
- **Executors** (per `desplega:delegate-work`): Phases 1 and 2 go to Codex `gpt-6.1-sol` at `high`. Phases 3 to 10 go to Opus agents (UI work). Each Opus agent loads the `dashboard-ui` skill first (primitives, motion, and the keyboard listener rules). Claude reviews every phase with `desplega:code-reviewing` before its commit.
- **Decisions.** "Asked" means Taras chose it. "Assumed" means Claude chose it in autopilot. Review the assumed ones first.

| # | Decision | Source |
|---|---|---|
| D1 | One PR with the full mockup UI plus the backend it needs. No source sections, no two-way Slack. | asked (A34) |
| D2 | The group tab uses `DataGrid`, `ListPager`, and `SegmentedControl` (MobileList below `md`). | asked (A34) |
| D3 | The new view is the default. "Legacy sessions" is a per-browser preference (`useLocalToggle("sessions:legacy")`) plus `?legacy=1`. | asked (A34) |
| D4 | A session's group is its root key with a trailing `<kind>:<id>/` leaf segment removed, where `<kind>` is `task`, `thread`, `schedule`, or `workflow`. Groups `shared/` and `personal/<me>/` are "No group". Moving into a group sets the root and its chain to the group key itself (the app does the same). | assumed, changed by review: the mockup also treats `personal/<me>/` as No group (`index.html:1590`), and a generic `<kind>:` rule would strip user group names that hold a `:` |
| D5 | Read state uses the app's `threadState` rule over `inbox_item_state` (`itemType='to_read'`, `itemId`=root id). `dismissed` (written by no dashboard flow) shows as Done and never wakes. One exception: a session with no row and no activity in the last 7 days counts as read. Without this, the first run shows every old session as unread. | assumed |
| D6 | "Needs you" = unread with latest status `failed` (app parity), OR a `pending` approval request whose `sourceTaskId` is in the chain (mockup R4). | assumed |
| D7 | The tree shows my sessions plus sessions shared with me (decision 4). Roots with no requester are not in the tree. A bypass actor sees all roots and gets no read state. | assumed |
| D8 | An empty group lives in `localStorage` (per browser) until a session moves in. After that the session keys are the truth. No new table. | assumed |
| D9 | A bulk move runs the existing key audit once per request, with today's blocking rule. A root moves only when the actor has `write` or `owner` session access and `task.fs.mutate` on every chain task. Other roots are skipped and reported, not failed. | assumed, changed by review: the legacy policy admits every operator and user for `task.fs.mutate` (`src/rbac/legacy-policy.ts:223-227`), so that check alone never skips a read-only sharee |
| D10 | A group rename or delete moves only roots the actor owns (session access `owner`, which a bypass actor has for every root). Other people's sessions stay and the response lists them. | assumed, changed by review: same reason as D9. "May mutate" admits every dashboard user, so it does not keep other people's sessions in place |
| D11 | The bottom sheet is the shadcn Drawer on `vaul` (one new dependency). Checkbox is the shadcn Checkbox on the installed `radix-ui`. | asked (Taras kept `vaul` after the review) |
| D12 | URL: `/sessions/:rootTaskId` is the focused session (old links keep working). `?tabs=<id,id,new>`, `?split=<id>`, `?view=<inbox|later|done|nogroup|key>`, `?q=`. | assumed (decision 14) |
| D13 | Users have no avatar column. Avatar stacks reuse `AvatarStack` with `peerColor(user.id)` and `userInitials`, plus a new optional `label` prop for the accessible name. A small `UserAvatar` (one avatar, for bubbles) uses the same `Avatar`, palette, and initials. | assumed, changed by review: `AvatarStack` already draws an initials stack on a seeded palette (`presence-avatars.tsx:33`), so a second stack component fails the deletion test |
| D14 | New routes avoid the `/api/sessions/{rootTaskId}` pattern: `GET /api/session-tree`, `POST /api/session-moves`, `POST /api/session-moves/prefix`. | assumed |
| D15 | The Cmd+I context panel (`components/session-panel/session-panel.tsx`) uses the new turn timeline in this PR, and follows the Legacy preference (decision 17). | asked |
| D16 | This PR also closes the old move route: `PATCH /api/assets/task/{id}/key` requires `write` or `owner` session access for a user actor. | asked |

## Quick Verification Reference

```bash
# Backend
bun run test:root -- src/tests/<file>.test.ts
bun run tsc:check:tsc
bun run lint
bun run docs:openapi && git status --short openapi.json docs-site/content/docs/api-reference
bun run check:rbac-coverage && bun run check:openapi-response-coverage
bash scripts/check-async-db-seam.sh && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bash scripts/check-db-boundary.sh

# Frontend
cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens
bun test apps/ui/src/lib/<file>.test.ts
bun run e2e:ui -- --grep @smoke

# Inner loop before every commit
bun run check:local
```

Local stack (LOCAL_TESTING.md:363-365, 448-460):

```bash
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run scripts/seed.ts --clean
DESPLEGA_TELEMETRY_ENV=test bun run start:http &   # API on :3013
cd apps/ui && bun run dev                          # UI on :5274
```

---

## Phase 0: Docs commit and branch

### Overview

Branch `feat/sessions-v2` from `main` exists, with one commit that adds the brainstorm, research, mockups, and this plan.

### Changes Required:

#### 1. Branch and docs
**Files**: `mockups/sessions-v2/**`, `thoughts/taras/brainstorms/2026-10-20-sessions-ui-power-users.md`, `thoughts/taras/research/2026-10-20-sessions-ui-power-users.md`, this plan.
**Changes**: `git switch -c feat/sessions-v2`. Commit the docs. Do not commit anything from `/tmp/sv2-prod/` or any `/tmp` screenshot.

### Success Criteria:

#### Automated Verification:
- [x] No customer names in the docs: `! grep -rniE "$SV2_CUSTOMER_RE" mockups/sessions-v2 thoughts/taras/` (the pattern lives outside the repo, so this file does not name the customer)
- [x] No em dashes in the docs: `! rg -n '\x{2014}' mockups/sessions-v2/*.md thoughts/taras/plans/2026-10-21-sessions-v2-power-users.md`
- [x] Branch is correct: `git branch --show-current` prints `feat/sessions-v2`

#### Automated QA:
- [x] `git show --stat HEAD` lists only `mockups/sessions-v2/` and `thoughts/taras/` files.

#### Manual Verification:
- [x] None.

**Implementation Note**: Commit `[phase 0] docs: sessions v2 brainstorm, research, mockups, plan`.

---

## Phase 1: Session filters, row fields, and the tree summary

### Overview

`GET /api/sessions` gains group, read-state, status, and person filters plus per-row read state and people. A new `GET /api/session-tree` returns every visible group with its counts. The session detail returns pending approvals. A dev seed creates grouped sessions for local QA.

### Changes Required:

#### 1. Key helpers
**File**: `src/assets/key.ts`
**Changes**:
- `keyPrefixRange(prefix)` returns `{lo: prefix, hi}`, where `hi` is the prefix with its last character incremented (`shared/a/` gives `shared/a0`). Prefix filters use `"key" >= ? AND "key" < ?`, so they use `idx_agent_tasks_asset_key`. `LIKE` scans the table.
- `sessionGroupKey(key)` removes a trailing `<kind>:<id>/` segment, where `<kind>` is `task`, `thread`, `schedule`, or `workflow` (D4). `shared/task:abc/` gives `shared/`. `shared/northwind/pricing/` stays as it is. A user group such as `shared/release:v2/` stays a group.

#### 2. Session queries
**Files**: `src/be/db.ts` (`listRecentSessions`, `countSessions`), new `src/be/db/session-tree.ts`
**Changes**:
- New list filters:
  - `keyPrefix` (range predicate, includes subgroups).
  - `groupKey` (exactly this group: key equals it, or equals it plus a leaf segment).
  - `noGroup` (group `shared/` or `personal/<viewer>/`, D4).
  - `triage`: `inbox`, `later`, `done`, `unread`.
  - `status`: `running` (latest status not in `TERMINAL_TASK_STATUSES`, `src/types.ts:331`, the app's `isActive`), `failed`, `needs` (D6).
  - `withUserId`: the requester, a chain requester, or an active share user.
- Where each filter goes:
  - Root filters (the key range, `groupKey`, `noGroup`, the viewer) go in the seed `WHERE` of the recursive CTE, as today. They limit the chains the CTE walks.
  - Chain filters (`triage`, `status`, `withUserId`) need chain aggregates. They go in the outer query, after `agg`.
  - `countSessions` runs the same CTE when a chain filter is set. Without one, it stays a plain root count.
- Group, No group, and Inbox lists hold only sessions in the Inbox state (not Later, not Done), as in the mockup (`option-ab-merged/index.html:2135-2144`). Group counts count the same set. The group list itself comes from every visible session, so a group whose sessions are all in Done still shows.
- Seed `triage=later` and `triage=done` from the viewer's `inbox_item_state` rows (`status IN ('snoozed','done','dismissed')`), so they do not walk every chain. Sort `later` by `snoozeUntil` ascending (mockup `ctxList`). Every other list keeps today's activity order.
- Read state uses a `LEFT JOIN` on `inbox_item_state` (`s`) for the viewer, with `itemType = 'to_read'`. Write the D5 rule once as a SQL fragment builder and reuse it in the list and the tree. Bind `now` and `now - 7 days` as ISO parameters, so tests can fix the clock:
  ```sql
  CASE
    WHEN s.id IS NULL THEN CASE WHEN a.lastActivityAt > :weekAgo THEN 'unread' ELSE 'read' END
    WHEN s.status = 'dismissed' THEN 'done'
    WHEN s.status = 'done' THEN CASE WHEN a.lastActivityAt > s.lastUpdatedAt THEN 'unread' ELSE 'done' END
    WHEN s.status = 'snoozed' THEN CASE WHEN s.snoozeUntil > :now THEN 'later' ELSE 'unread' END
    WHEN a.lastActivityAt > COALESCE(s.lastReadAt, s.lastUpdatedAt) THEN 'unread'
    ELSE 'read'
  END
  ```
- New row fields (optional in the zod schema, so old clients keep working):
  - `readState` (`unread|read|later|done`), `snoozeUntil`, `needsYou`.
  - `groupKey`: the `sessionGroupKey` of the root key. Flat lists show it as a muted label, so the client does not repeat the leaf rule.
  - `shared`: true when the root has an active share (the "shared" row icon, SPEC Round 7).
  - `people`: up to 8 `{id, name}` plus `peopleCount`. Requester first, then chain requesters, then share users.
  - `preview`: the `output` of the newest chain task that has one, skipping auto-review tasks (`source='system'` and `taskType='follow-up'`), cut to 200 characters. Without one, it is `null`. The row hover card shows it (mockup `previewOf`, `index.html:3166`).
  - Load `people`, `shared`, and `preview` in batched queries for the page, not per row.
- `getSessionTree(actor)` in `session-tree.ts`:
  - One query over visible roots (D7) with chain aggregates and the read-state join.
  - Group the rows in TypeScript by `sessionGroupKey`.
  - Return `{groups: [{key, total, unread, running, needsYou, lastActivityAt}], inbox, later, done, noGroup}`. Each section is `{total, unread, running, needsYou}`. Groups carry their own counts. The client builds the nesting and the roll-ups.
  - `groups` includes the groups of sessions shared with me. The client puts `personal/<other>/` groups under "Shared with me › <owner>" and every other group under My groups (decision 4).

#### 3. Routes
**File**: `src/http/sessions.ts`
**Changes**:
- Add the new query params to `listSessions`. Clamp `limit` to 200 in the handler. Do not reject a larger value, because existing callers (the my-swarm app, scripts) must keep working. Echo the clamped value in the response.
- Extend `SessionListItemSchema` where it lives (`src/http/sessions.ts:98-103`). Add `SessionTreeGroupSchema` and `SessionTreeResponseSchema` next to it.
- Add `GET /api/session-tree` with `route()` and a response schema. Keep it in `src/http/sessions.ts`, so no handler file is added (no change to `src/http/index.ts` or `src/http/all-routes.ts`).
- Extend the `getSession` response with `approvals: [{id, status, sourceTaskId, title}]` for pending requests in the chain.
- Run `bun run docs:openapi` and commit `openapi.json` and the docs-site API reference.

#### 4. Dev seed
**File**: `scripts/seed.ts`
**Changes**:
- Insert 3 users directly (`@example.com`, status `active`). `seed:people` cannot run here, because it needs a running API.
- Give about 60 % of roots a group key from a fixed list (`shared/northwind/pricing/`, `shared/northwind/ios/`, `shared/infra/`, `personal/<seeded userId>/notes/`). The personal key must name a seeded user. Otherwise the key audit warns and every move returns 409. Children inherit the key.
- Set `requestedByUserId` from the seeded users, and `source = 'ui'` on those roots, so the Legacy view lists them too.
- Spread root activity over the last 30 days, so D5 gives both unread and read sessions.
- Add one session share and a few `inbox_item_state` rows (done, snoozed, read). Add one root with a 120-character title that holds a long unbroken token.

#### 5. Tests
**File**: `src/tests/sessions-tree.test.ts` (new)
**Changes**: Cover each of these:
- The range filter: `shared/a/` matches `shared/a/b/` and not `shared/ab/`.
- `groupKey` vs `keyPrefix`, No group (`shared/` and `personal/<viewer>/`), and the leaf strip. `shared/release:v2/` is not stripped.
- Every branch of the D5 rule, including `dismissed` and the 7-day exception, with a fixed `now`.
- Later and Done sessions leave the group, No group, and Inbox lists. `triage=later` sorts by `snoozeUntil`.
- D6 for both a failed chain and a pending approval.
- `status=running` matches a chain whose latest status is `pending` or `in_progress`.
- People ordering and the cap of 8. `shared` and `preview` on a page of rows.
- Visibility: mine plus shared, no-requester roots excluded, a bypass actor sees everything.
- Tree counts match the list totals. A shared session's group shows in `groups`.
- `limit=500` returns at most 200 rows and echoes `limit: 200`.
- `EXPLAIN QUERY PLAN` of the prefix filter names `idx_agent_tasks_asset_key`.

### Success Criteria:

#### Automated Verification:
- [x] New and existing session tests pass: `bun run test:root -- src/tests/sessions-tree.test.ts src/tests/sessions.test.ts src/tests/sessions-detail-batch.test.ts src/tests/list-endpoint-slimming.test.ts src/tests/inbox-state.test.ts src/tests/session-route-posture.test.ts src/tests/session-sharing-routes.test.ts`
- [x] Types pass: `bun run tsc:check:tsc`
- [x] Lint passes: `bun run lint && bun run lint:slop`
- [x] OpenAPI is fresh: `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference` (after committing the regenerated files)
- [x] Route gates pass: `bun run check:rbac-coverage && bun run check:openapi-response-coverage`
- [x] DB seams pass: `bash scripts/check-async-db-seam.sh && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bash scripts/check-db-boundary.sh`

#### Automated QA:
- [x] Boot the seeded stack (Quick Verification Reference), then pick a user id: `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/users | jq -r '.users[0].id'`.
- [x] The tree has groups and counts: `curl -s -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" http://localhost:3013/api/session-tree | jq '.groups | length, .inbox'`
- [x] One group lists only its sessions: `curl -s -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" "http://localhost:3013/api/sessions?groupKey=shared/northwind/pricing/&limit=10" | jq '.total, ([.sessions[].root.key] | unique)'`
- [x] Pick an unread session: `curl -s -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" "http://localhost:3013/api/sessions?triage=unread&limit=1" | jq -r '.sessions[0] | .root.id, .lastActivityAt'`
- [x] Mark it read, then check that its `readState` becomes `read` and the tree's `inbox.unread` drops by 1: `curl -s -X PATCH -H "Authorization: Bearer 123123" -H "Content-Type: application/json" http://localhost:3013/api/inbox-state -d '{"userId":"<userId>","itemType":"to_read","itemId":"<rootId>","status":"open","lastReadAt":"<lastActivityAt>"}'`
- [x] Performance: a throwaway script in `/tmp` calls `initDb("/tmp/sv2-perf.sqlite")` (never the dev DB). It seeds 20,000 roots and 30,000 children, all visible to one user, with the `db.ts` functions. It then times one full sidebar poll: `getSessionTree`, plus one page each of `triage=inbox`, `triage=later`, `triage=done`, and one `groupKey`. Targets: the tree under 300 ms, a `groupKey` page under 50 ms, the full poll under 600 ms. Record the numbers under Appendix, Derail notes. If a target fails, stop and report before Phase 2.

#### Manual Verification:
- [x] None.

**Implementation Note**: Codex `gpt-6.1-sol` at `high`. Claude reviews the SQL for the D5 rule and the visibility join. Commit `[phase 1] feat(sessions): group filters, read state, and tree summary`.

---

## Phase 2: Bulk and prefix moves

### Overview

`POST /api/session-moves` moves up to 200 sessions into a group or to No group. `POST /api/session-moves/prefix` renames or deletes a group. Both run one key audit per request and report the sessions they skip.

### Changes Required:

#### 1. Split the move internals
**File**: `src/be/db.ts`
**Changes**: Split `moveAssetKey` into `assertAssetKeyMovesAllowed()` (the audit gate, same rule and same "blocked until" message as today) and `moveTaskChainKeyInTx(rootId, taskIds, key, changedBy)`. The existing route and `moveAssetKey` keep their behavior and call both.

#### 2. Session moves (DB only)
**File**: `src/be/db/session-moves.ts` (new)
**Changes**: This file does no permission checks. The HTTP handler does them (see 3), because `can()`, `resolveSessionActor`, and `authorizeAssetKeyWrite` need the request.
- `moveSessionChains({moves: [{rootId, taskIds, key}], changedBy})`:
  - Run `assertAssetKeyMovesAllowed()` once.
  - Move each root in its own `getDbClient().transaction()` (`BEGIN IMMEDIATE`). One transaction for 200 chains holds the write lock for every statement of every chain, and every worker write waits behind it.
  - Return the moved root ids. A repeated call moves nothing more, because tasks that already have the key are skipped.
- `listPrefixRoots({from, viewer, limit})` returns the roots in the `from` range with their chain task ids and `requestedByUserId`.

#### 3. Routes
**File**: `src/http/sessions.ts`. Keep both routes here, so no handler file is added.
**Changes**:
- `POST /api/session-moves`, body `{rootTaskIds: string[1..200], groupKey: AssetKey | null}`:
  - Check the target once with `authorizeAssetKeyWrite(groupKey, resolveHttpAuditUserId(req, myAgentId))`. A personal key of another user fails the whole request.
  - For each root, skip it with a reason when it does not exist, when the actor's session access (`sessionAccessFor`) is below `write`, or when `canMutateTaskNamespace` fails on a chain task. Export `canMutateTaskNamespace` from `src/http/assets.ts:186`.
  - `null` moves each root to `defaultAssetKey("task", rootId)`.
  - Response: `{moved: string[], skipped: [{rootTaskId, reason}]}`.
- `POST /api/session-moves/prefix`, body `{from: AssetKey, to: AssetKey | null}`:
  - Return 400 when `from` is a namespace root (`shared/` or `personal/<uid>/`). A rename of a root would move every session.
  - Return 400 when `to` starts with `from`. Moved roots would stay in the range, and the client loop would not end.
  - Take up to 200 roots in the range per call. Move only roots where the actor's session access is `owner` (D10). List the other visible roots in the range as skipped.
  - The new key is `to + key.slice(from.length)`. `null` resets to the default key (delete group). A new key over 255 characters skips that root.
  - Response: `{moved, skipped, remaining}`. `remaining` counts only roots the actor can still move, so the client loop ends. The client repeats the call while `remaining > 0`.
- Both use `rbac: { ungated: "per-session access, per-task task.fs.mutate, and asset-key write checks in the handler, as PATCH /api/assets/task/{id}/key" }`.
- An audit block returns 409 with the existing message.
- Regenerate OpenAPI.

#### 3b. Close the old move route (D16)
**File**: `src/http/assets.ts`
**Changes**: In the `PATCH /api/assets/{entityType}/{id}/key` handler, for `entityType` `task`, resolve the actor with `resolveSessionActor` and check `sessionAccessFor` on the task's session before any move. Below `write`, return 403 with `SESSION_READ_DENIED`-style copy ("You can view this session but not move it."). A bypass actor (agents, operator without a picked user) keeps today's behavior. This also covers `cascade`.

#### 4. Tests
**File**: `src/tests/sessions-move.test.ts` (new)
**Changes**: Cover each of these:
- Every chain task moves, and `asset_key_history` gets rows.
- A move to `null` gives `shared/task:<rootId>/`.
- A move keeps `lastUpdatedAt`, so the read state does not change.
- A root shared with the actor at `read` is skipped. A root shared at `write` moves. The others still move.
- A personal key of another user is rejected.
- A prefix rename keeps subgroups (`shared/a/b/` becomes `shared/c/b/`).
- A prefix rename skips a session shared with the actor, and lists it.
- `from` = `shared/` and `to` inside `from` both return 400.
- `remaining` paging works and reaches 0 when skipped roots stay in the range.
- An audit failure returns 409 and the audit runs once per request (spy on the audit).
- A repeated call does nothing more.
- The old route (D16): a `read` sharee gets 403 from `PATCH /api/assets/task/{id}/key`, with and without `cascade`. A `write` sharee and the owner still move it. An agent caller still moves it.

### Success Criteria:

#### Automated Verification:
- [x] Move tests pass: `bun run test:root -- src/tests/sessions-move.test.ts src/tests/asset-key-api.test.ts src/tests/asset-key-invariants.test.ts src/tests/session-route-posture.test.ts`
- [x] Types pass: `bun run tsc:check:tsc`
- [x] Lint passes: `bun run lint && bun run lint:slop`
- [x] OpenAPI is fresh: `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference`
- [x] Route gates pass: `bun run check:rbac-coverage && bun run check:openapi-response-coverage && bash scripts/check-rbac-boundary.sh`
- [x] DB seams pass: `bash scripts/check-async-db-seam.sh && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bash scripts/check-db-boundary.sh`

#### Automated QA:
- [x] On the seeded stack, move 2 sessions: `curl -s -X POST -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" -H "Content-Type: application/json" http://localhost:3013/api/session-moves -d '{"rootTaskIds":["<id1>","<id2>"],"groupKey":"shared/qa/moved/"}' | jq`
- [x] The tree shows `shared/qa/moved/` with total 2: `curl -s -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" http://localhost:3013/api/session-tree | jq '.groups[] | select(.key=="shared/qa/moved/")'`
- [x] Rename the group: `curl -s -X POST -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" -H "Content-Type: application/json" http://localhost:3013/api/session-moves/prefix -d '{"from":"shared/qa/moved/","to":"shared/qa/renamed/"}' | jq`
- [x] Delete it: `curl -s -X POST -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" -H "Content-Type: application/json" http://localhost:3013/api/session-moves/prefix -d '{"from":"shared/qa/renamed/","to":null}' | jq`
- [x] Both sessions are in No group: `curl -s -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" "http://localhost:3013/api/sessions?noGroup=true&limit=200" | jq '[.sessions[].root.id] | index("<id1>"), index("<id2>")'` prints two numbers.
- [x] The old route refuses a read-only sharee (D16): share a seeded session at `read` with a second user, then `curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <secondUserId>" -H "Content-Type: application/json" http://localhost:3013/api/assets/task/<rootId>/key -d '{"key":"shared/qa/blocked/","cascade":true}'` prints `403`.
- [x] A namespace root is refused: `curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" -H "Content-Type: application/json" http://localhost:3013/api/session-moves/prefix -d '{"from":"shared/","to":"shared/x/"}'` prints `400`.

#### Manual Verification:
- [x] None.

**Implementation Note**: Codex `gpt-6.1-sol` at `high`. Claude reviews the permission pre-check and the transaction boundaries. Commit `[phase 2] feat(sessions): bulk and prefix moves, close the old move route`. Mention the D16 behavior change in the PR body under Heads-up: the my-swarm app uses this route, and owners are not affected.

---

## Phase 3: Frontend foundation and the Legacy toggle

### Overview

The new shell renders on `/sessions` by default: a resizable sidebar frame, a pane area, URL state, and the Legacy toggle. The data layer and the new primitives exist. Later phases fill the sidebar and the pane.

### Changes Required:

#### 1. Data layer
**Files**: `apps/ui/src/api/types.ts`, `apps/ui/src/api/client.ts`, `apps/ui/src/api/hooks/use-sessions.ts`, `apps/ui/src/api/hooks/use-session-tree.ts` (new), `use-session-moves.ts` (new), `use-session-triage.ts` (new)
**Changes**:
- Mirror the Phase 1 and 2 types.
- Add client methods `getSessionTree`, `moveSessions`, `moveSessionPrefix`, and `patchInboxStateBulk` (`PATCH /api/inbox-state/bulk`, for the bulk bar).
- `useSessionTree()` uses key `["session-tree"]` and the app default polling.
- Extend the `useSessions` options with `groupKey`, `keyPrefix`, `noGroup`, `triage`, `status`, and `withUserId`. Do not add a second list hook.
- Every v2 list call sends `scope=tree` (added in Phase 1 review). It gives the same visibility as `GET /api/session-tree` (mine plus shared, no ownerless roots), so list totals match the tree counts. The default scope `all` still includes ownerless roots for the Legacy view.
- `useMoveSessions` and `useMovePrefix` loop on `remaining` and invalidate `["session-tree"]` and `["sessions"]`.
- `useSessionTriage(rootId)`:
  - `markRead` writes `{status:"open", readAt: now, lastReadAt: <lastActivityAt>}`. `markUnread` writes `lastReadAt: "1970-01-01T00:00:00.000Z"`. These are the app's shapes.
  - `done` writes `{status:"done"}`. `later(until)` writes `{status:"snoozed", snoozeUntil}`. `backToInbox` writes `{status:"open"}`.
  - Writes go through `patchInboxState` (one row) or `patchInboxStateBulk` (selection) with `itemType:"to_read"`.
  - Update the row's `readState` optimistically in the cached list pages, with rollback and a toast. On settle, invalidate `["session-tree"]` and `["sessions"]`. Do not recount the tree on the client, because that repeats the D5 rule.

#### 2. Shell, URL state, Legacy
**Files**: `apps/ui/src/pages/sessions/page.tsx`, `apps/ui/src/pages/sessions/[rootTaskId]/page.tsx`, `apps/ui/src/components/sessions-v2/sessions-v2-shell.tsx` (new), `apps/ui/src/components/sessions-v2/use-sessions-url-state.ts` (new, built on `useUrlSearchState`), `apps/ui/src/hooks/use-sessions-view.ts` (new), `apps/ui/src/lib/sessions-v2.ts` (new, `SESSIONS_V2_MIN_VERSION`), `apps/ui/src/hooks/use-collapse-nav-while.ts` (moved from `context-session-panel.tsx`)
**Changes**:
- `useSessionsView()` returns `legacy | v2` from `useLocalToggle("sessions:legacy", false)`. `?legacy=1|0` wins.
- `useSessionsView()` also returns `legacy` when `useFeatureGate(SESSIONS_V2_MIN_VERSION)` is not supported. An older API has no `/api/session-tree`. Set the constant to the patch after the `package.json` version, and recheck it before the merge.
- Call `useSessionsView()` once per page and pass the setter down to the header links. `useLocalToggle` does not sync two instances in the same tab, so a second instance would switch the view only after a reload.
- Both pages render the legacy components unchanged when the result is `legacy`.
- The v2 shell has a sidebar (320 px, resizable 260 to 520 px, arrow keys, Home resets) and collapses the global nav to icons while active.
- URL state per D12.
- A "Legacy sessions" link sits in the header. The legacy shell gets a "New sessions view" link.

#### 3. Primitives
**Files**: `apps/ui/src/components/ui/checkbox.tsx` (shadcn, `radix-ui`), `apps/ui/src/components/ui/hover-card.tsx` (shadcn, `radix-ui`), `apps/ui/src/components/ui/drawer.tsx` (shadcn, add `vaul` to `apps/ui/package.json` and the root lock), `apps/ui/src/components/comb/presence-avatars.tsx` (optional `label` prop on `AvatarStack`, D13), `apps/ui/src/components/shared/user-avatar.tsx` (new: one `UserAvatar`, D13), `apps/ui/src/components/shared/command-menu.tsx` (add `CommandMenuProvider` and `useCommandMenuGroup(id, heading, items)`, and expose the palette's search text. The static groups stay.), `apps/ui/src/components/layout/root-layout.tsx` (mount the provider around `CommandMenu`)
**Changes**: Use the motion tokens from `DESIGN.md`. The drawer opens 400 ms and closes 250 ms on `ease-swift`, and drags to close from anywhere. The hover card opens and closes on the menu timing (150/100 ms, `ease-snappy`).

### Success Criteria:

#### Automated Verification:
- [x] UI lint, types, and tokens pass: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b && bun check -b && bun run check:tokens`
- [x] The lockfile is in sync: `bun install --frozen-lockfile`
- [x] The images still build with the new lock: `docker build -f Dockerfile . && docker build -f Dockerfile.worker --target worker-slim . && docker build -f apps/evals/Dockerfile .`
- [x] The dashboard image builds and serves: `bun run docker:build:ui && bash scripts/smoke-ui-image.sh agent-swarm-ui:latest`
- [x] Smoke passes: `bun run e2e:ui -- --grep @smoke` (clean worktree at 3d6fcb184: 33 passed, 17 skipped)

#### Automated QA:
- [x] With agent-browser on the seeded stack, `http://localhost:5274/sessions` renders the v2 shell, and the global nav is collapsed to icons.
- [x] Click "Legacy sessions": the old shell renders at once, without a reload, and again after a reload. `?legacy=0` returns to v2.
- [x] `http://localhost:5274/sessions/<rootId>?tabs=<rootId>,new` keeps both tabs in the URL after a reload.
- [x] Zero console errors on each URL (`agent-browser errors`).

#### Manual Verification:
- [x] None.

**Implementation Note**: Opus agent. Commit `[phase 3] feat(ui): sessions v2 shell, data layer, Legacy toggle`.

---

## Phase 4: Sidebar tree and triage

### Overview

The sidebar shows every section and group with server counts, paged rows, read state, and triage from menus and keys. Later notifies in the browser.

### Changes Required:

#### 1. Tree
**Files**: `apps/ui/src/lib/session-groups.ts` (new: build the nested tree and the roll-ups from `groups[]`), `apps/ui/src/lib/session-groups.test.ts`, `apps/ui/src/components/sessions-v2/sidebar/session-tree.tsx`, `group-node.tsx`, `session-row.tsx`, `section-header.tsx`
**Changes**: Implement R4, R5, R6, R9, and R10.3 per the SPEC:
- Section order: search, Inbox, Later, Done, No group, My groups, Shared with me.
- My groups holds `shared/` groups and my `personal/<me>/` groups. Shared with me holds other people's `personal/<owner>/` groups, one node per owner, named from `/api/users` (decision 4, mockup `index.html:2204-2215`).
- Groups: `#` icon, a chevron only when the group has subgroups, count badges with a tooltip, subtree totals when folded, and a hover or focus "+".
- Section lists fetch rows only while open (`enabled` on the query), so a poll does not load every container.
- Rows:
  - Left slot: unread dot (a checkbox on hover).
  - Then a still `TaskStatusIcon` ring for running, a "Needs you" pill, or a failed mark.
  - Then the title (one line, ellipsis), the "shared" icon when `shared` is true, the avatar stack (`AvatarStack`, 3 plus "+N"), and the relative time.
  - Inbox, Later, and Done rows show the group as a muted label (`groupKey`).
  - A hover card (the new `HoverCard`) shows the crumb, the full title, `preview`, the status, the task count, the time, and the people (mockup `cardHTML`, `index.html:3326-3340`). The hover card replaces the title tooltip on sidebar rows.
- Paging: 10 rows, then "Show 10 more" once, then "View all N" (opens `?view=`).
- Fold state persists in `localStorage`.
- Empty states use `EmptyState`.

#### 2. Triage
**Files**: `apps/ui/src/components/sessions-v2/sidebar/row-menu.tsx`, `snooze-picker.tsx`, `apps/ui/src/hooks/use-later-notifier.ts`, `apps/ui/src/components/sessions-v2/use-list-keys.ts`
**Changes**:
- Row menu: DropdownMenu. Right-click and the ContextMenu key open the same menu (controlled `open`), so no ContextMenu primitive is needed. Items: Open, Open in new tab, Mark read or unread, Done, Later…, Move to group…. "Open in split" lands in Phase 8.
- Snooze options: In 1 hour, This evening, Tomorrow 09:00, Next week, Pick a date and time.
- Opening a session marks it read only when its `readState` is `unread` (the app's `shouldMarkRead`). The write sets `status:"open"`, so an unconditional write would end a Done or Later state.
- List keys when the list has focus: `j`, `k`, arrows, Home, End, Enter or `o`, `x`, `e`, `l`, `u`, `m`, `t`, `n`, `c`. `v` (split) lands in Phase 8. After Done or Later the cursor stays put and the next row moves up. Follow the keyboard listener rules in the `dashboard-ui` skill.
- With no current user (a bypass actor, D7), hide the triage controls. There is no `userId` to write.
- The Later notifier reads the Later list (sorted by `snoozeUntil`) and sets one timer for the next wake time. It asks for Notification permission on first use. It falls back to a toast.
- Icons: `Archive` for Done, `AlarmClock` for Later, `SquareDashed` for No group, `Hourglass` for Needs you. A session in Done or Later shows a pressed `Inbox` button.

### Success Criteria:

#### Automated Verification:
- [x] Tree builder tests pass: `bun test apps/ui/src/lib/session-groups.test.ts`
- [x] UI gates pass: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [x] Smoke passes: `bun run e2e:ui -- --grep @smoke` (clean worktree at 03dbfe7be)

#### Automated QA:
- [x] On the seeded stack, the sidebar counts match `curl -s -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" http://localhost:3013/api/session-tree | jq '.inbox, (.groups[] | select(.key=="shared/northwind/pricing/"))'` for Inbox and that group.
- [x] Open an unread session: the row loses its dot and Inbox unread drops by 1. Open a session in Done: it stays in Done.
- [x] Hover a row: the hover card shows the full title and the preview line.
- [x] Press `e` on a row: it moves to Done and the next row takes the cursor. Press `l` and choose "In 1 hour": it moves to Later with the wake time.
- [x] "Show 10 more" adds 10 rows, then "View all N" sets `?view=` in the URL.
- [x] Screenshots at 1440x900 and 1280x800 in light and dark: `/tmp/sessions-v2-build/p4-*.png`.

#### Manual Verification:
- [x] None.

**Implementation Note**: Opus agent. Commit `[phase 4] feat(ui): sessions tree sidebar and triage`.

---

## Phase 5: Organize and find

### Overview

Users can select many sessions, move them by bulk bar, drag, picker, or Cmd+K, and create, rename, and delete groups. They can start a session in a group and search with tokens. Cmd+K has a Sessions group.

### Changes Required:

#### 1. Selection and moves
**Files**: `apps/ui/src/components/sessions-v2/sidebar/bulk-bar.tsx`, `move-to-group-dialog.tsx`, `use-session-selection.ts`, `use-row-drag.ts`
**Changes**:
- One checked row turns on selection mode. The bulk bar has Done, Later, Mark read, Move, and Clear. `x` toggles. Escape clears.
- The move dialog is cmdk: fuzzy over groups plus a "Create group #name" row.
- Drag a row onto a group with dnd-kit (Mouse sensor `distance: 5`). The keyboard path is `m`.

#### 2. Groups
**Files**: `apps/ui/src/components/sessions-v2/sidebar/group-menu.tsx`, `apps/ui/src/lib/empty-groups.ts`
**Changes**:
- Group menu: New session here, New subgroup, Rename group, Delete group. Delete uses an AlertDialog confirm, and its sessions go to No group.
- Rename and delete call the prefix move. When the response lists skipped sessions (other people's sessions in a shared group), the toast shows the skipped count. The group then stays in the tree with those sessions.
- Groups under Shared with me get no menu, no "+", and no drop target.
- "New group" is an inline field: Enter saves, Escape cancels. It stores an empty group (D8).

#### 3. New session in a group
**Files**: `apps/ui/src/components/sessions-v2/new-session-tab.tsx`, `start-in-picker.tsx`
**Changes**:
- A "New session" tab holds the existing composer plus a "Start in" picker (my groups, personal groups, No group).
- The default is the group you started from.
- Send calls `POST /api/tasks` with `key`, and the tab turns into the new session. Add an optional `key` to `useStartSession` (`components/sessions/use-start-session.ts`). `api.createTask` already sends it. No group sends no `key`, so the server sets the default key.
- The tab strip lands in Phase 8. Until then, the "new" entry in `?tabs=` renders this tab in the pane.

#### 4. Search and Cmd+K
**Files**: `apps/ui/src/lib/session-search.ts` (token parser), `apps/ui/src/lib/session-search.test.ts`, `apps/ui/src/components/sessions-v2/sidebar/sidebar-search.tsx`, `apps/ui/src/components/sessions-v2/use-sessions-commands.ts`
**Changes**:
- Tokens: `with:<name>` (resolved to a user id from `/api/users`), `in:<group>`, `is:unread|running|later|done`. Free text goes to `q`.
- Results are one flat server list, paged by 50. Matching groups come from the tree.
- `/` focuses search and Escape restores the tree.
- Cmd+K "Sessions" group:
  - Jump to: with an empty palette, 5 sessions (needs and unread first). With text, a debounced `GET /api/sessions?q=<text>&limit=8`, so the palette finds every session, not only loaded rows (brainstorm decision 15).
  - Actions: New session, New session in group…, Next unread, Move to group…, Rename session, Mark read or unread, Done, Later…, Move back to the Inbox, Legacy sessions. "Open in split…", "Close the split", and "Show the guide" land in Phase 8.

### Success Criteria:

#### Automated Verification:
- [x] Parser tests pass: `bun test apps/ui/src/lib/session-search.test.ts`
- [x] UI gates pass: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [x] Smoke passes: `bun run e2e:ui -- --grep @smoke` (clean worktree at 77584691c)

#### Automated QA:
- [x] Select 3 rows, press `m`, choose "Create group #qa-bulk": the group appears with 3 sessions, and the server agrees: `curl -s -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" http://localhost:3013/api/session-tree | jq '.groups[] | select(.key=="shared/qa-bulk/") | .total'` prints `3`.
- [x] Drag one row onto another group: the row moves.
- [x] Rename `qa-bulk` to `qa-renamed`, then delete it. The sessions land in No group.
- [x] "+" on a group opens a New session tab with that group in "Start in". Send creates a session in that group.
- [x] `with:<seeded name> is:unread` shows only matching sessions.
- [x] Cmd+K, type "Done", Enter: the focused session moves to Done.
- [x] Record the move flow: `agent-browser record start /tmp/sessions-v2-build/p5-move.mp4 --cursor`. (recorded before the review fix round; Phase 10 records the final flows)

#### Manual Verification:
- [ ] None.

**Implementation Note**: Opus agent. Commit `[phase 5] feat(ui): groups, moves, search, and session commands`.

---

## Phase 6: Session pane header and long titles

### Overview

The session pane has the two-row header from SPEC Round 8 with People, rename, share, and triage. Every title surface truncates (R10.3). The pane body keeps today's `SessionTimeline` until Phase 7.

### Changes Required:

#### 1. Header
**Files**: `apps/ui/src/components/sessions-v2/pane/session-header.tsx`, `people-pill.tsx`, `people-popover.tsx`, `triage-buttons.tsx`, `apps/ui/src/components/sessions-v2/pane/session-pane.tsx` (header plus today's `SessionTimeline` and `ComposerDock`)
**Changes**:
- Row 1:
  - Left: the crumb (group path) and "Shared by <name> · can view" when that applies.
  - Right: presence avatars (reuse `SessionPresenceAvatars`), the People pill (count only), Mark read, Done, Later, Move, and an icon-only Share (reuse `ShareSessionButton`).
- Row 2:
  - Left: the title with inline rename. Port the logic from `pages/sessions/[rootTaskId]/page.tsx:50-61` and keep its gate (owner and Can edit, SPEC R8.2).
  - Right: the meta line with `StatusBadge`, the Later chip, an `AgentAvatar` stack, tasks, cost, started, and the Handoffs toggle.
  - The meta line drops started, then cost, then avatars, using Tailwind container queries on the pane.
- The People popover lists people with their access and last message, then agents with task counts, then "Share…".

#### 2. Long titles
**Files**: every title surface in `sessions-v2/`
**Changes**: One line, `min-w-0` chains, ellipsis, and the full title in a tooltip (R10.3). Sidebar rows use the hover card from Phase 4 instead.

### Success Criteria:

#### Automated Verification:
- [x] UI gates pass: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [x] Smoke passes: `bun run e2e:ui -- --grep @smoke` (clean worktree at 2ff77e0a7)

#### Automated QA:
- [x] Rename to the 120-character seeded title. Then measure `scrollWidth <= clientWidth` with `agent-browser eval` on the header title and the sidebar row. No horizontal page scroll at 1280 px. (The tab title is measured in Phase 8.) (Measured on the header rows and the sidebar row: a truncated title span always has scrollWidth > clientWidth by design.)
- [x] The meta line drops started, then cost, then the agent avatars when the pane is narrowed (agent-browser `set viewport 1024 800`). The status chip and the Handoffs toggle stay. (No seeded session has handoffs, so the toggle was checked with a DOM probe on Done and Later sessions at 1440, 1280, 1024, and 900.)
- [x] The Share icon shows only for the owner. As a Can view user (the seeded share), the pencil and Share are absent.
- [x] Open the People popover: it lists the requester and the share user with their access.

#### Manual Verification:
- [ ] None.

**Implementation Note**: Opus agent. Commit `[phase 6] feat(ui): session header and long titles`.

---

## Phase 7: Turn timeline

### Overview

The session pane body matches SPEC Round 8 to 10. It has a turn timeline with folded worker lines, the new message anatomy, copy buttons, and stable scrolling.

### Changes Required:

#### 1. Turn model
**Files**: `apps/ui/src/lib/session-turns.ts` (new), `apps/ui/src/lib/session-turns.test.ts`
**Changes**: `buildTurns(chain, {hideAutoReviews})` returns turns. Each turn is `{person?, reply, workers: [{agentId, steps: [{taskType, tries: AgentTask[]}]}], internal: AgentTask[], result?}`.
- A turn starts at each human message (a `ui` task with a requester, or the root).
- Lead tasks are replies. Children of the lead are worker tries, grouped by agent and task type. Retries are consecutive failed tries before a pass.
- `system` follow-ups, `deferred`, `resume`, and `superseded` tasks are internal.
- Auto-review tasks stay hidden, as in `buildTimelineTree`.
- Test it with fixtures shaped like `mockups/sessions-v2/demo-data-big.js` (sB1, sB2): turn count, worker spans, retry counts, and header totals.

#### 2. Timeline
**Files**: `apps/ui/src/components/sessions-v2/pane/turn-timeline.tsx`, `person-bubble.tsx`, `swarm-reply.tsx`, `worker-summary.tsx`, `worker-step.tsx`, `internal-line.tsx`, `approval-line.tsx`, `apps/ui/src/components/sessions-v2/pane/session-pane.tsx` (swap `SessionTimeline` for `TurnTimeline`)
**Changes**:
- Person bubbles follow R10.1: no name on mine, the avatar beside the bubble, the meta row below with a hover Copy.
- Swarm replies follow R10.2: no mark, text first, a footer with the time and an always-visible Copy.
- The worker line follows R8.3: an `AgentAvatar` stack and "Writer worked for 17m". It has done, running, and failed states, opens with `AnimatedReveal` (fast), and remembers its state per turn.
- Expanded steps reuse `TaskCard`, `TaskOutcome`, and `ChainOfThought` for the body.
- The approval line shows "Waiting for approval" with a link to `/approval-requests/<id>` (from the `approvals` field of the session detail).
- Follow mode reuses `useAutoScroll` (`hooks/use-auto-scroll.ts`, as `session-conversation.tsx:89` does). It sticks to the bottom within 100 px and holds still when a step expands. Reuse the "Latest" button from `session-conversation.tsx`.
- The composer is `ComposerDock`. Typing presence renders as a bubble row in the timeline flow, with the person's avatar and three pulsing dots (SPEC R10.4). It never overlaps a message.
- The "Latest" pill sits 8 to 12 px above the composer's top edge and never covers the composer or the typing bubble (R10.4).

#### 3. Cmd+I context panel (D15)
**Files**: `apps/ui/src/components/sessions/session-conversation.tsx`, `apps/ui/src/components/session-panel/session-panel.tsx`, `apps/ui/src/components/session-panel/session-panel.test.tsx`
**Changes**:
- `SessionConversation` gets a `timeline: "legacy" | "turns"` prop, default `"legacy"`. `"turns"` renders `TurnTimeline` with the same composer, typing bubble, and "Latest" pill.
- The legacy sessions page keeps `"legacy"`, so the Legacy view stays unchanged.
- `session-panel.tsx` passes `"turns"`, unless `useSessionsView()` returns `legacy`.
- The turn timeline must work in the panel width (about 420 px). Use container queries, not the window width. Bubbles cap at 85 % of the column.
- Update `session-panel.test.tsx` for the new prop.

### Success Criteria:

#### Automated Verification:
- [x] Turn tests pass: `bun test apps/ui/src/lib/session-turns.test.ts`
- [x] Panel tests pass: `bun test apps/ui/src/components/session-panel/session-panel.test.tsx`
- [x] UI gates pass: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [x] Smoke passes: `bun run e2e:ui -- --grep @smoke` (clean worktree at f1e5924cd)

#### Automated QA:
- [x] Open a seeded session with workers. The worker line shows the right agent count and duration, and expanding it shows the steps and holds the scroll.
- [x] Hover a person bubble: Copy fades in. Click Copy on a swarm reply: the icon becomes Check for 1.5 s.
- [x] Send a follow-up in the composer: the reply appears and the view follows it.
- [x] Open the Cmd+I panel on a page linked to a seeded session: it shows the turn timeline, with no horizontal scroll inside the panel. With the Legacy preference on, the panel shows today's timeline.
- [x] Scroll up while a second browser session types: the typing bubble and the "Latest" pill do not overlap each other, any message, or the composer (`getBoundingClientRect` checks with `agent-browser eval`).
- [x] Compare against the mockup at 1440x900 (side by side): `/tmp/sessions-v2-build/p7-*.png` and `/tmp/sessions-v2/option-ab-merged-r10-*.png`. `/tmp` does not survive a reboot. When those files are gone, capture the committed mockup: `agent-browser open "file://$PWD/mockups/sessions-v2/option-ab-merged/index.html?open=sB1" && agent-browser screenshot /tmp/sessions-v2-build/mock-sB1.png`.

#### Manual Verification:
- [ ] None.

**Implementation Note**: Opus agent. This is the riskiest phase. If a real chain does not fit the turn model (for example a session that a schedule started), render the rest with the legacy `TaskCard` in chain order, and note it in the plan. Commit `[phase 7] feat(ui): turn timeline, also in the Cmd+I panel`.

---

## Phase 8: Tabs, split, status bar, group tab, first-run guide

### Overview

Users can work in several tabs and one split, see live counts in a status bar, open a full group list, and get a guide on first use.

### Changes Required:

#### 1. Tabs and split
**Files**: `apps/ui/src/components/sessions-v2/tabs/tab-strip.tsx`, `all-tabs-menu.tsx`, `split-panes.tsx`
**Changes**:
- Tabs:
  - Each tab has a triage glyph, an ellipsis title, and a close button. A click opens in the current tab. Middle-click or `t` opens a new tab. "+" opens a New session tab.
  - Overflow: the strip keeps its scroll, reveals the active tab, fades at the edges, and has an "All tabs" menu.
- Split:
  - One split, two panes. Open it with `v`, the row menu ("Open in split"), Cmd+K ("Open in split…", "Close the split"), or by dragging a tab to the right edge of the pane (dnd-kit, SPEC Round 2 interaction 9, mockup `index.html:2406`).
  - It needs a second tab first ("Open a second session first. Then split.").
  - Closing a pane returns to one.
- No browser-owned shortcuts.

#### 2. Status bar
**File**: `apps/ui/src/components/sessions-v2/status-bar.tsx`
**Changes**: Running, Needs you, and Unread counts from the tree. Each is a toggle filter with `aria-pressed`. Also the tab and pane count, and a Keys button (`?`).

#### 3. Group tab
**File**: `apps/ui/src/components/sessions-v2/group-tab.tsx`
**Changes**:
- `DataGrid` with columns title, group, people, activity, and time. A row click opens the session.
- `ListPager` with server paging by 50, and `SegmentedControl` (`size="sm"`) with All, Unread, Running, and Needs you.
- A search box scoped to the group.
- `MobileList` below `md`.

#### 4. First-run guide
**File**: `apps/ui/src/components/sessions-v2/first-run-guide.tsx`
**Changes**:
- A Dialog with 4 steps: sessions in the sidebar, tabs and split, Done and Later, then search, keys, and the Legacy view. There is no sources step.
- Next, Back, Skip, and arrow keys. "Don't show again" is stored in `localStorage`. `?guide=1|0`.
- The Keys button and `?` open the keys step. `?` needs Shift, so the key listener allows Shift for this one key.
- Cmd+K gets "Show the guide".

### Success Criteria:

#### Automated Verification:
- [x] UI gates pass: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [x] Smoke passes: `bun run e2e:ui -- --grep @smoke` (clean worktree at 3e8269a15)

#### Automated QA:
- [x] Open 13 tabs at 1280 px. The active tab stays visible, clicking an overflowed tab keeps the scroll, and "All tabs" lists all 13.
- [x] Open the 120-character seeded session in a tab. `scrollWidth <= clientWidth` holds on the tab title (`agent-browser eval`), and the close button stays visible.
- [x] `v` opens the split. Dragging a tab to the right edge also opens it. Reloading keeps `?split=`. Closing a pane returns to one.
- [x] The status bar "Unread" toggle filters the sidebar.
- [x] "View all" opens the group tab. The pager moves to page 2 and the segmented filter changes the rows. (Checked as Morgan: Alex's Inbox holds exactly 50.)
- [x] A fresh profile shows the guide once. `?guide=0` hides it.
- [x] Record tabs and split: `agent-browser record start /tmp/sessions-v2-build/p8-tabs.mp4 --cursor`, then `agent-browser record stop`.

#### Manual Verification:
- [ ] None.

**Implementation Note**: Opus agent. Commit `[phase 8] feat(ui): tabs, split, status bar, group tab, guide`.

---

## Phase 9: Phone layout

### Overview

Below 768 px, the sessions view is a list screen, then a detail screen with history, bottom sheets, swipe, and long-press (SPEC R8.5 and R9). The legacy view keeps its "Switch session" select.

### Changes Required:

#### 1. Screens
**Files**: `apps/ui/src/components/sessions-v2/mobile/mobile-sessions.tsx`, `mobile-list-screen.tsx`, `mobile-detail-screen.tsx`, `mobile-group-screen.tsx`
**Changes**:
- List screen:
  - A large "Sessions" title, a New session icon, and "⋯" (Legacy sessions, theme, guide).
  - Search with token chips.
  - The same sections as desktop. Rows are at least 52 px, with 2 lines.
- Detail screen:
  - Pushed by the route `/sessions/:id`, so browser back works. It slides 300 ms in and 250 ms out on `ease-swift`, and fades only under reduced motion.
  - Top bar: back, title (tap to rename), People pill, "⋯".
  - One meta line. The composer pins with the safe-area inset and `visualViewport` keyboard handling.
- "View all" and New session are full-screen views.

#### 2. Sheets and touch
**Files**: `apps/ui/src/components/shared/responsive-overlay.tsx` (new: Popover on desktop, Drawer on phone), `apps/ui/src/hooks/use-swipe-row.ts`, `apps/ui/src/hooks/use-long-press.ts`
**Changes**:
- The snooze picker, People, Share, Move to group, Start in, the "⋯" actions, and the group menu all open as drawers.
- Swipe left for Done and right for Later. The threshold is 80 px, with a direction lock, the action color behind the row, and an undo toast.
- Long-press starts selection and shows a bottom bar (Done, Later, Read, Move, Cancel).
- Taps are at least 44 px. There are no tooltips and no key hints.

### Success Criteria:

#### Automated Verification:
- [x] UI gates pass: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [x] Smoke passes: `bun run e2e:ui -- --grep @smoke`. This runs desktop Chromium only. The `mobile-iphone` project runs only `composer-enter-key.spec.ts`, so phone coverage comes in Phase 10. (clean worktree at 1e96cd53c, before the rebase)

#### Automated QA:
- [x] At 390x844 (agent-browser `set viewport 390 844`): tap a row, the detail pushes, and browser back returns to the list at the same scroll position.
- [x] Swipe a row left past 80 px: it goes to Done, and Undo restores it. (CDP mouse pointer events; agent-browser has no real touch.)
- [x] Long-press a row: selection mode and the bottom bar appear. (CDP mouse pointer events; agent-browser has no real touch.)
- [x] Open the snooze drawer and drag it down from the middle: it closes. (CDP mouse pointer events; agent-browser has no real touch.)
- [x] No horizontal scroll at 375 px and 390 px. Screenshots: `/tmp/sessions-v2-build/p9-*.png`. Recording: `agent-browser record start /tmp/sessions-v2-build/p9-mobile.mp4 --cursor`, then `agent-browser record stop`.

#### Manual Verification:
- [ ] On a real iPhone (Safari), check swipe, long-press, the drawer drag, and the composer with the keyboard open. Agent-browser cannot reproduce real touch.

**Implementation Note**: Opus agent. Commit `[phase 9] feat(ui): sessions phone layout`.

---

## Phase 10: Polish, E2E, docs, and the PR

### Overview

The UX review checklist is closed, the UI E2E suite covers the new view, the docs describe it, and the PR is open with screenshots and recordings.

### Changes Required:

#### 1. Checklist pass
**File**: `mockups/sessions-v2/UX-REVIEW-R9.md` (read), this plan (Appendix table)
**Changes**: Walk every P0 and P1 finding against the build. Fix it, or record why it does not apply. Add a status table to the Appendix.

#### 2. UI E2E
**Files**: `packages/ui-e2e/boot/seed.ts`, `packages/ui-e2e/boot/manifest.ts`, `packages/ui-e2e/specs/routes.ts`, `packages/ui-e2e/specs/sessions-v2.spec.ts` (new), `packages/ui-e2e/playwright.config.ts`
**Changes**:
- Seed one session chain with a group key, a second user, and a share, through the API (`POST /api/tasks` with `key` and `requestedByUserId`, then the shares route), as `boot/seed.ts` does today.
- Add `sessions-v2` to the `mobile-iphone` project: `testMatch: /(composer-enter-key|sessions-v2)\.spec\.ts/`. Skip the desktop tests of the new spec on that project, and the phone test on `chromium` (`testInfo.project.name`).
- The spec covers:
  - The tree shows the seeded group.
  - Opening a session marks it read.
  - Done moves the session to Done.
  - The move dialog moves a session.
  - The Legacy toggle switches the view and back.
  - On the `mobile-iphone` project, the list opens the detail and back returns.
- Use role and name selectors.

#### 3. Docs
**Files**: `docs-site/content/docs/(documentation)/ui/sessions.mdx` (new), `docs-site/content/docs/(documentation)/ui/meta.json`
**Changes**: Groups (key prefixes), triage, keys, tabs and split, phone, and the Legacy view.

#### 4. PR
**Changes**:
- Capture before and after screenshots and recordings with agent-browser.
- Upload them with the `github-attach` skill.
- Write the body from `.github/pull_request_template.md`, check it, then create the PR.

### Success Criteria:

#### Automated Verification:
- [x] Full gate: `bun run check:local && bun run lint && bun run lint:slop && bun run tsc:check:tsc && bun run tsc:check && bun run test:root -- --parallel=4` (clean worktree: all pass except `quickjs executor > caps the binary bodies`, which fails the same way on clean main on macOS)
- [x] Black-box E2E: `bun run e2e`
- [x] UI E2E: `bun run e2e:ui && bun run e2e:ui:tsc && bunx biome check packages/ui-e2e` (90 passed, 0 flaky with `--retries=0`)
- [x] UI gates: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b && bun check -b && bun run check:tokens`
- [x] Route and DB gates: `bun run check:rbac-coverage && bun run check:openapi-response-coverage && bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh && bash scripts/check-rbac-boundary.sh && bash scripts/check-async-db-seam.sh && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bun run check:dep-graph`
- [x] Repo gates: `bash scripts/check-audit-columns.sh && bun scripts/check-text-columns.ts && bun run check:bun-version && bash scripts/check-test-spawn-sync.sh && bash scripts/gitleaks.sh`
- [x] No raw route matching: `! grep -rn 'matchRoute(' src/http/ --include='*.ts' | grep -v 'route-def.ts' | grep -v 'utils.ts'`
- [x] Images build (the lock changed in Phase 3): `docker build -f Dockerfile . && docker build -f Dockerfile.worker --target worker-slim . && docker build -f apps/evals/Dockerfile . && bun run docker:build:ui && bash scripts/smoke-ui-image.sh agent-swarm-ui:latest`
- [x] OpenAPI is fresh: `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference`
- [x] PR body passes: `bun scripts/check-pr-body.ts --title "feat(ui): sessions v2 with groups, triage, tabs, and a phone layout" --body-file /tmp/pr-body.md`

#### Automated QA:
- [x] One full agent-browser walk on the seeded stack at 1440, 1280 (split), and 390 px, in light and dark, with zero console errors. (28 pages, 0 console errors, no sideways scroll)
- [x] The new spec passes 3 times in a row on both projects: `bun run e2e:ui -- --no-build --repeat-each=3 specs/sessions-v2.spec.ts` (18 passed with `--retries=0`)

#### Manual Verification:
- [ ] Taras reviews the PR and the recordings.

**Implementation Note**: Opus agent for the checklist, E2E, and docs. Claude writes and opens the PR. Commit `[phase 10] test(ui): sessions v2 E2E, docs, polish`. Run `gh pr create --title "feat(ui): sessions v2 with groups, triage, tabs, and a phone layout" --body-file /tmp/pr-body.md`. Urgency is "nice to have" unless Taras says otherwise.

---

## Manual E2E

Run on the branch against a real local backend. Replace `<userId>`, `<rootId>`, and `<id1>`/`<id2>` with values from the first commands.

```bash
# 1. Fresh seeded stack (LOCAL_TESTING.md:363-365, 448-460)
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run scripts/seed.ts --clean          # Phase 1 seed: users, groups, shares, read state
DESPLEGA_TELEMETRY_ENV=test bun run start:http &
until curl -sf http://localhost:3013/health >/dev/null; do sleep 1; done
bun run seed:people                      # optional extra people. It needs the running API.
(cd apps/ui && bun run dev) &

# 2. Pick a user and read the tree
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/users | jq -r '.users[] | "\(.id) \(.name)"'
curl -s -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" http://localhost:3013/api/session-tree | jq '{inbox, later, done, noGroup, groups: [.groups[] | {key, total, unread}]}'

# 3. One group page and the people on each row
curl -s -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" "http://localhost:3013/api/sessions?groupKey=shared/northwind/pricing/&limit=10" | jq '.total, [.sessions[] | {title: .root.title, readState, needsYou, people: [.people[].name]}]'

# 4. Bulk move, rename, delete
curl -s -X POST -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" -H "Content-Type: application/json" http://localhost:3013/api/session-moves -d '{"rootTaskIds":["<id1>","<id2>"],"groupKey":"shared/e2e/moved/"}' | jq
curl -s -X POST -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" -H "Content-Type: application/json" http://localhost:3013/api/session-moves/prefix -d '{"from":"shared/e2e/moved/","to":"shared/e2e/renamed/"}' | jq
curl -s -X POST -H "Authorization: Bearer 123123" -H "x-swarm-user-id: <userId>" -H "Content-Type: application/json" http://localhost:3013/api/session-moves/prefix -d '{"from":"shared/e2e/renamed/","to":null}' | jq

# 5. Drive the UI (LOCAL_TESTING.md:461-487)
agent-browser skills get core
agent-browser open http://localhost:5274/sessions
agent-browser snapshot
agent-browser record start /tmp/sessions-v2-e2e.mp4 --cursor
#    open a session, press e, press l, select 3 rows, press m, create a group, open a tab, press v
agent-browser record stop
agent-browser screenshot /tmp/sessions-v2-e2e.png
agent-browser set viewport 390 844
agent-browser open http://localhost:5274/sessions
agent-browser screenshot /tmp/sessions-v2-e2e-phone.png
agent-browser errors
agent-browser close

# 6. Legacy toggle
agent-browser open "http://localhost:5274/sessions?legacy=1"
agent-browser snapshot   # the old 300 px list and the "Switch session" select below lg
agent-browser close

# 7. Before deploy: the move gate on production. Any issue (warnings included) blocks every move with 409, today and after this PR.
curl -s -H "Authorization: Bearer <PROD_API_KEY>" <PROD_API_URL>/api/assets/key-audit | jq '.ok, .fatalCount, .warningCount'
```

## Appendix

- **Follow-up plans**:
  - Source sections, source keys, backfill, labels, DM-only visibility (brainstorm decisions 5 to 8).
  - Two-way Slack (decision 10).
  - The `conversations.replies` "oldest 20" fix.
  - The `requestedByUserId IS NULL` exposure.
  - A server-side wake job for Later.
  - Removing the Legacy view.
- **Derail notes**:
  - Phase 1 performance numbers (20,000 roots, 30,000 children, one user, median of 3 runs, no index hints): tree 90 ms, Inbox page 92 ms plus count 64 ms, Later page 19 ms plus count 12 ms, Done page 27 ms plus count 19 ms, `groupKey` page 5 ms plus count 3 ms, full sidebar poll 331 ms. All targets pass. The spec reviewer measured one noisy run at 640 to 670 ms for the full poll. The Inbox list and its count each walk the full chain CTE, so watch that one if the poll grows.
  - Phase 1 review added `scope=tree` to `GET /api/sessions`. The default scope `all` keeps ownerless roots (Legacy behavior). The tree and `scope=tree` lists exclude them for user viewers. A bypass actor with `scope=tree` sees every root.
  - Phase 2 review (assumed, autopilot): a user's prefix move moves only roots that user requested. Roots with no requester in the range are not moved and not listed (the tree hides them). Without this, `sessionAccessForRoot` gives every user `owner` on an ownerless root, so a rename swept up agent-created roots, even under another user's `personal/` prefix. Bulk moves by id keep the old route's rule.
  - Known limit (not changed): `resolveHttpAuditUserId` ignores `x-swarm-user-id`. So an operator-key dashboard user (API key plus a picked user) gets 403 when a move or a new session targets `personal/<self>/`. User tokens (`aswt_`) work. Every key-writing route behaves this way today. The UI shows the server error. Follow-up for Taras.
  - Phase 3 scope addition (asked by Taras while he tested): the global nav got a collapse button in its header, a hover-to-expand logo when collapsed, and a more visible rail line. The rail hit area stays 16 px (8 px each side of the edge), because a 24 px rail took clicks from full-bleed content such as the v2 sidebar.
  - Phase 3 decisions: both session routes render one `SessionsPage` (two page components remounted the shell). `?legacy=1|0` stores the preference once and leaves the URL. `useCollapseNavWhile` restores the nav on unmount, with a hold count, and route-driven toggles do not animate. Until Phases 6 and 7, the v2 pane renders today's `SessionConversation` for the focused session, so old links keep working.
  - Phase 3: `bun run e2e:ui` must run in a clean worktree without `.env`. The repo `.env` loads real Slack tokens into the test API and breaks its boot. The local QA DB stores `SWARM_DEV_MODE=true`, because the API is 2.4.4 and `SESSIONS_V2_MIN_VERSION` is 2.4.5. The UI E2E test API needs the same for Phase 10 specs.
  - Phase 4 additions (asked by Taras while he tested): the global nav rail shows the `col-resize` cursor (this reverses the older "no resize cursor" rule), and the collapsed nav scrolls vertically (stock shadcn clipped it).
  - Phase 4 backend additions: `GET /api/sessions/{id}` returns `readState` and `lastActivityAt` for a user viewer (same SQL rule as the list), so read-on-open lives with the pane and works for deep links. List rows carry an optional `shares: [{userId, name, access}]` for the row label and hover card.
  - Phase 4 decisions backed by UX-REVIEW-R9: 1 avatar plus "+N" on rows, the shared icon only when no other avatar shows, Undo toasts (5200 ms, bottom-left). "Pick a date and time" is a Dialog, not the mockup's inline field.
  - Phase 1: `approvals` on the session detail is omitted when empty. The client reads a missing field as `[]`. Bypass actors get no `readState`.
  - Phase 5 review decisions: on the operator key (no `aswt_` token), the UI disables writes into `personal/` keys with "Personal groups need a user token." (Taras agreed). This covers the move dialog, Start in, drop targets, "+", and the New session here, New subgroup, and Rename items. Moves out of a personal group and Delete stay, because the server accepts them (probed live). Undo restores each session's exact previous key, and sends `null` only when `null` gives the same key. Moves are not optimistic: the toast comes after the server answers.
  - Phase 5 skipped (mockup only, not in the plan): Shift-click range selection, and keeping the Start in group in `?tabs=`. Free-text search matches root titles and text (server `q`), not people or group names.
  - Follow-ups from the Phase 5 review (after this PR): decide whether the operator key plus a picked user may write `personal/<self>/` keys (Taras leans yes, as the operator key can already read and move everything else). Show ownerless roots (unmapped Slack users, agent-started sessions) in an "Unassigned" section for operators, since `scope=tree` hides them from v2 while Legacy still shows them.
  - Phase 6 decisions: the session detail query key includes the viewer (`["session", id, userId]`). Before, a user switch showed the previous user's detail and read-on-open marked it read for the new user (a Phase 4 bug). Read-on-open is keyed by user, root, and activity. Triage refetches only the affected details. The header crumb is a button that reveals the group in the tree. The meta line order of drops: started and the Handoffs label under 65rem, cost under 55rem, agents under 45rem, tasks under 37.5rem. The status chip and the Handoffs icon never clip, and the Done or Later note truncates first. Cmd+K rows show the full title while highlighted. The rename gate is access other than Can view (SPEC R8.2).
  - Phase 7 turn model (decided in review, autopilot, following mockup sB1): `buildTurns` returns `{turns, rest}`. A turn opens at the root or at a person message: a `ui` task (with or without a requester), or a `slack` or `chat` task. A task-page Retry (a `ui` copy of its parent with the same prompt, type, and agent) is another try, not a message. A lead `deferred` wake-up splits a turn into parts. Each part shows its reply, its latest completed lead answer, and its own worker line, so a span never includes a wait. Lead notes in between stay under Handoffs. A lead task still running after the latest answer renders as a live line under it. Approvals render in their own part.
  - Phase 7 fallback (Implementation Note): a root that no person wrote (schedule, workflow, api, mcp) has no person bubble. It renders as the legacy `TaskCard`, and its workers fold under it as usual. Tasks with no path to the root go to `rest` and render as `TaskCard` in chain order. A late follow-up of turn N stays in turn N (turns group by ancestry, not time).
  - Phase 7 QA: the QA API loaded the repo `.env`, so one task completion wrote a memory with a real OpenAI embedding. The QA API now boots with the LLM and embedding keys blank, and QA tasks carry the `auto-generated` tag. `scripts/seed.ts` gained `seedTurnSessions` (fixed ids, runs last, existing rows unchanged) for workers, retries, an approval, handoffs, and a schedule root.
  - Phase 8 decisions: the group tab is the token `view` in `?tabs=`, `?view=` names its list, and one group tab is open at a time. A New session tab focused while the group tab is open uses `/sessions/new`. A click never replaces a New session tab or the group tab. The split holds one session (`?split=<id>`), and a session never shows in both panes: an open goes to the pane that already has it. Opening another session in the split sends the old one back to the main tabs. Status bar toggles are `is:` tokens in the sidebar search (new token `is:needs`), and the counts add Inbox, Later, and Done so each count equals its list. Middle-click opens a background tab with "Opened in a new tab." and does not mark read. `v` and `c` work outside the tree. `?guide=0` skips the guide for one load only, and the guide waits for "Who are you?". Tab state follows the server's latest-task rule. Only the conversation polls an open session; background tabs poll every 30 s.
  - Phase 10 notes from Phase 8: UI E2E specs must set localStorage `agent-swarm-sessions-v2-guide=off` (or pass `?guide=0` on every load), or the guide blocks clicks. The pane header status chip uses the Phase 6 rule (any live task shows RUNNING) and can disagree with the tab and row on chains with tied `lastUpdatedAt` (seen on 06ba3a2b).
  - Taras decision (2026-10-22, while testing Phase 8): every running mark spins (TaskStatusIcon `active`, 3 s turn) in rows, tabs, counts, phone rows, and worker steps. This reverses UX-REVIEW-R9 lines 55 and 88 (static rings in data rows). Reduced motion still stops it.
  - Phase 9 decisions: phones (below 768 px) get `MobileSessions`, with the URL as the screen stack (`useIsPhone` reads the breakpoint in the first render). `ResponsiveOverlay` is a Popover or Dialog from md up and a vaul Drawer on phones, so Share is a drawer on phones in the Legacy view too. Every drawer eats the click that ends a drag. Phone taps are at least 44 px, through `--hit-size: 44px` and the phone branch, and desktop sizes are unchanged. Search chips `with:` and `in:` suggest people and groups. A swiped Done row collapses in 150 ms (a height animation, which UX-REVIEW-R9 asks for). Crossing md swaps the whole tree and drops selection and unsent composer text.
  - Phase 9 open items for Taras (PR Heads-up): the app header stays on the phone list screen (SPEC R8.5 says none), because it is the only way to global nav. No `viewport-fit=cover` or `interactive-widget` meta change, because it is global. The real-iPhone check shows if the safe area and keyboard need them. No "Select all" (P2). The group screen pager buttons (shared `ListPager`) stay 32 px.
  - Phase 10 start: rebased onto origin/main 2a81a2129 (package.json 2.4.5), so `SESSIONS_V2_MIN_VERSION` is now 2.4.6. Only the generated API reference index conflicted (endpoint counts). The pre-rebase head is kept as branch `backup/sv2-pre-rebase-1e96cd53c` until the PR merges.
  - Pre-merge (2026-10-22): main released v2.4.6 from 92fc18110, then cut the v2.5.0 minor release, both without sessions v2. `SESSIONS_V2_MIN_VERSION` is now 2.5.1, so a dashboard never shows v2 against a 2.5.0 or older API that lacks `/api/session-tree`. The UI E2E keeps `SWARM_DEV_MODE=true` until package.json reaches 2.5.1.
  - Phase 10 decision: the pane header status chip follows the server's latest-task rule (`latestTask`), the same as the tab and the sidebar row, so the three agree. This reverses the Phase 6 rule (any live task shows RUNNING). A running older worker still shows in the timeline's worker line. On tied `lastUpdatedAt`, the server's pick follows SQLite scan order, so a rare tie can still differ.
  - If the production key audit is not clean (Manual E2E step 7), moves fail with 409 today too. Fixing the audit warnings is a separate task.
  - The app treats a missing read-state row as unread. D5 treats rows older than 7 days as read. The two clients can disagree on old sessions until the app adopts the same rule.
- **UX-REVIEW-R9 status** (Phase 10 checklist pass, every P0 and P1 finding; line numbers point into `mockups/sessions-v2/UX-REVIEW-R9.md`):

  | Line | Pri | Finding (short) | Status | Where or why |
  |---|---|---|---|---|
  | 19 | P1 | Running is a hand-rolled spinner | fixed in Phase 4 | TaskStatusIcon `active` in rows and counts (Phase 4), tabs and status bar (Phase 8), worker line (Phase 7). It spins everywhere (Taras decision 2026-10-22). |
  | 20 | P1 | Failed is a pink "!" disc | fixed in Phase 4 | TaskStatusIcon `failed` in rows, tabs (Phase 8), and steps and tries (Phase 7). |
  | 21 | P1 | Step states are hand-drawn glyphs | fixed in Phase 7 | worker-step.tsx and worker-summary.tsx use TaskStatusIcon. |
  | 22 | P1 | Status chip draws a dot | fixed in Phase 6 | StatusBadge with the `running` key. Phase 10 moves it to the server's latest-task rule. |
  | 23 | P1 | Done uses CircleCheck | fixed in Phase 4 | lucide Archive in rows, menus, bulk bars, header, Cmd+K, phone sheet, and swipe. |
  | 24 | P1 | Clock means five things | fixed in Phase 4 | AlarmClock for Later and wake times. Clock stays only for "In 1 hour" and the deferred handoff. |
  | 25 | P1 | Pressed "back to Inbox" state is invisible | fixed in Phase 6 | Inbox icon, `aria-pressed`, `bg-accent`. Also in the row menu, Cmd+K, and the phone sheet. |
  | 26 | P1 | No group is a dashed circle | fixed in Phase 4 | SquareDashed in rows, tree, Start in, move picker, and crumb. |
  | 27 | P1 | Swarm hex mark reads as a status | does not apply | SPEC R10.2 removed the mark from swarm replies. |
  | 28 | P1 | Worker avatars are grey squares | fixed in Phase 7 | AgentAvatarStack in the worker line, SessionAgents in the header, AgentAvatar in People. |
  | 29 | P1 | Telegram logo and BrandLogo marks | does not apply | Source sections and Slack or Telegram rows are out of scope (What We're NOT Doing, D1). |
  | 30 | P1 | Lowercase l keycap reads as 1 | fixed in Phase 4 | Uppercase keycaps. Handlers stay case-insensitive. |
  | 31 | P1 | Needs-you dot looks like the unread dot | fixed in Phase 8 | Hourglass in the status bar, the "N need you" pill in counts. |
  | 32 | P1 | People popover icon differs from Share | fixed in Phase 6 | `EVERYONE_ICON` in both. |
  | 33 | P1 | Tab glyph looks like Calendar | fixed in Phase 4 | ArrowRight for "View all N", AppWindow for tabs (Phase 8). |
  | 34 | P1 | Icon map literal traps | fixed now | Ellipsis for group actions, SquareX for "Close the split". |
  | 51 | P0 | Desktop toast off-center, no exit | fixed in Phase 4 | Sonner bottom-left with a 5200 ms Undo. |
  | 52 | P1 | No overlay has an exit | fixed in Phase 4 | Radix primitives with the shipped exits; phone sheets are the vaul Drawer (Phase 9). |
  | 53 | P1 | Worker steps snap open | fixed in Phase 7 | AnimatedReveal fast. |
  | 54 | P1 | Typing line shifts the layout | does not apply | Replaced by SPEC R10.4: a typing bubble row in the flow. |
  | 55 | P1 | 13 spinners turn at once | does not apply | Taras decision 2026-10-22: every running mark spins. |
  | 56 | P1 | Reduced motion removes all motion | fixed in Phase 9 | Fades stay; the push cross-fades in 150 ms. |
  | 57 | P1 | Sheet timing is off the tokens | fixed in Phase 3 | vaul Drawer 400/250 on ease-swift. |
  | 58 | P1 | Drawer primitive is missing | fixed in Phase 3 | `components/ui/drawer.tsx` (vaul, D11); ResponsiveOverlay in Phase 9. |
  | 59 | P1 | Phone push curve | fixed in Phase 9 | 300 in, 250 back, ease-swift. |
  | 60 | P1 | Swipe Done leaves a jumping gap | fixed in Phase 9 | Slide-out, then a 150 ms collapse. |
  | 61 | P1 | Flash fades to transparent | does not apply | The build has no row or tab flash. |
  | 62 | P1 | Rows flash on data changes | fixed in Phase 4 | No flash; the unread dot and bold title carry the news. |
  | 63 | P1 | Keyboard highlight leaves a trail | fixed in Phase 4 | `data-kb` and `NO_KEYBOARD_MOTION`. |
  | 64 | P1 | iOS back swipe slides twice | fixed in Phase 9 | Skips the slide on `hasUAVisualTransition`. |
  | 65 | P1 | Three liveness motions | fixed in Phase 7 | ChainOfThought live line, TaskStatusIcon plus `.shimmer-text` on the worker line. |
  | 80 | P0 | Tab strip breaks with many tabs | fixed in Phase 8 | Reveal, edge mask, wheel, All tabs. |
  | 81 | P1 | Key hints work only in the tree | fixed in Phase 6 | Pane keys e, u, l, m; c and v outside the tree (Phase 8). |
  | 82 | P1 | Open row is the dimmest row | fixed in Phase 4 | Open title in `text-foreground`, marker inside the row. |
  | 83 | P1 | Row metadata squeezes the title | fixed in Phase 4 | Lighter group label, one avatar plus "+N", title min width 45 %. |
  | 84 | P1 | Split header title truncates first | fixed in Phase 6 | Title min width, container queries drop meta items. |
  | 85 | P1 | Global sidebar missing from the layout math | fixed in Phase 3 | `useCollapseNavWhile`. |
  | 86 | P1 | Focus rings clipped or browser blue | fixed in Phase 8 | `ring-inset` on tabs, crumb is a ghost Button (Phase 6). |
  | 87 | P1 | Lowercase l keycap | fixed in Phase 4 | Same as line 30. |
  | 88 | P1 | Static running glyph in rows | does not apply | Reversed by the Taras decision of 2026-10-22. |
  | 89 | P1 | Triage state shown as a status chip | fixed in Phase 6 | TriageNote: "In Done", "Back Thu 09:00". |
  | 90 | P1 | Toast covers the composer | fixed in Phase 4 | Sessions toasts sit bottom-left. |
  | 91 | P1 | Send is enabled on an empty draft | fixed in Phase 3 | The shipped ComposerDock. |
  | 92 | P1 | Agents and people drawn two ways | fixed in Phase 7 | AgentAvatar for agents, UserAvatar for people (D13). |
  | 93 | P1 | Second Cmd+K palette | fixed in Phase 5 | One "Sessions" group in the global CommandMenu. |
  | 94 | P1 | Group tab uses hand-made rows | fixed in Phase 8 | DataGrid, ListPager, SegmentedControl (D2). |
  | 95 | P1 | Rows and tabs flash amber | fixed in Phase 4 | No flash. |
  | 111 | P0 | "Channels: off" row is cut | does not apply | The source filter sheet is not built. |
  | 112 | P0 | Timeline scroll anchoring | fixed in Phase 7 | useAutoScroll with `recheck`; the Latest pill has its own strip and a 44 px touch area (Phase 10). |
  | 113 | P1 | No keyboard handling | deferred (Taras) | `visualViewport` on pushed screens is built. The `viewport-fit=cover` and `interactive-widget` meta change is global, so it waits for Taras (PR Heads-up). |
  | 114 | P1 | Sheet drags only from the grab strip | fixed in Phase 9 | vaul drags from anywhere. |
  | 115 | P1 | Phone motion is off the tokens | fixed in Phase 9 | Drawer 400/250, push 300/250, swipe 200, all ease-swift. |
  | 116 | P1 | Desktop tree indentation on phones | fixed in Phase 9 | One indent step, no guide lines. |
  | 117 | P1 | with: and in: chips dead-end | fixed in Phase 9 | People and group suggestions. |
  | 118 | P1 | Phone composer differs from ComposerDock | fixed in Phase 9 | ComposerDock in bar mode. |
  | 119 | P1 | Tap targets under 44 px | fixed now | Phase 9 plus the search clear, the approval Review button, the group pager, and a full-width worker line on phones. |
  | 120 | P1 | Phone rename has no Cancel | fixed in Phase 9 | RenameBar with Cancel and Save; a blur cancels. |
  | 121 | P1 | Add people opens a popover inside the sheet | fixed now (partly) | AddPeopleView in the sheet, 48 px rows, 92 dvh. No "Saved" toast (deferred: the row shows at once, failures toast). |
  | 122 | P1 | Phone font sizes are off the scale | fixed now | Phase 9 kept phone text on the named scale. The Phase 10 review found 14 px bubbles: phone bubbles and replies are now 16 px, and row avatar initials 11 px. Desktop is unchanged. |
- **References**:
  - Research: `thoughts/taras/research/2026-10-20-sessions-ui-power-users.md`
  - Brainstorm: `thoughts/taras/brainstorms/2026-10-20-sessions-ui-power-users.md`
  - Mockup and spec: `mockups/sessions-v2/`
  - App read rule: `~/Documents/my-swarm/swarm-app/src/lib/inbox-sections.ts:22-33`

## Review log (2026-10-21)

Autopilot review by Claude (`desplega:reviewing`). Each change names what changed, why, and the evidence.

| # | Section | Change | Why | Evidence |
|---|---|---|---|---|
| 1 | D9, D10, Phase 2 | Moves check session access: `write` or `owner` for a bulk move, `owner` for a prefix move. | `task.fs.mutate` admits every operator and user under the legacy policy. It never skips a read-only sharee, and it does not keep other people's sessions in place. | `src/rbac/legacy-policy.ts:223-227` |
| 2 | Phase 2 | Permission checks move to the HTTP handler. `session-moves.ts` is DB only. `canMutateTaskNamespace` gets exported. | `can()`, `resolveSessionActor`, and `authorizeAssetKeyWrite` need the request. | `src/http/assets.ts:186-200,360-361` |
| 3 | Phase 2 | One transaction per root, not one for all roots. Prefix batch 200, not 1,000. | One `BEGIN IMMEDIATE` over 200 to 1,000 chains holds the write lock for every statement, and all worker writes wait. | `src/be/db.ts:1767-1823` (per-task statements) |
| 4 | Phase 2 | Reject `from` = namespace root and `to` inside `from`. `remaining` counts only movable roots. | A root rename moves everything. `to` inside `from` and skipped roots both keep the client loop running forever. | Phase 2 loop design |
| 5 | Phase 2 | Both routes stay in `src/http/sessions.ts`. | A new handler file also needs an entry in the handler chain, which the plan missed. | `src/http/index.ts:345-415` |
| 6 | Phase 1 | Root filters stay in the CTE seed. Chain filters go after `agg`. `countSessions` walks chains only for chain filters. Later and Done seed from `inbox_item_state`. | Read state, status, and chain requesters need chain aggregates. Today every filter sits in the seed, and the count never walks chains. | `src/be/db.ts:12977-13073,13081-13122` |
| 7 | Phase 1 | Group, No group, and Inbox lists exclude Later and Done. Later sorts by wake time. | The mockup's lists and counts use the Inbox set only. | `option-ab-merged/index.html:1910,2135-2144` |
| 8 | Phase 1, D5 | Explicit D5 SQL, `dismissed` maps to Done, bound `now`. | The plan named the rule but not its SQL. `dismissed` had no v2 state. | `inbox-sections.ts:22-33` |
| 9 | D4, Phase 1 | `personal/<me>/` is No group. The leaf kinds are `task`, `thread`, `schedule`, `workflow`. | The mockup treats `personal/<me>/` as No group. Keys can hold `:`, so a generic rule eats user group names. | `index.html:1590,1605-1609`, `src/assets/key.ts:45-75` |
| 10 | Phase 1, Phase 4 | Tree drops the flat `shared` section. Shared with me holds `personal/<owner>/` groups by owner. | Brainstorm decision 4 puts shared sessions at their real key path. | brainstorm decision 4, `index.html:2204-2215` |
| 11 | Phase 1 | `limit` clamps to 200 instead of rejecting. | A hard maximum returns 400 to existing callers. | `src/http/sessions.ts:416`, `swarm-app/src/lib/api.ts:470-475` |
| 12 | Phase 1 | Schemas extend `SessionListItemSchema` in `src/http/sessions.ts`. | The schema is not in `src/types.ts`. | `src/http/sessions.ts:98-103` |
| 13 | Phase 1, Phase 4 | New row fields `groupKey`, `shared`, `preview`. A row hover card replaces the title tooltip. | The mockup has a hover card with the latest output, a shared icon, and a group label. No phase or field covered them. | `index.html:3166-3172,3219,3326-3340`, SPEC Round 7 |
| 14 | Phase 1 | Seed inserts its own users and uses `source='ui'` on grouped roots. Activity spans 30 days. | `seed.ts` creates no users, and `seed:people` needs a running API. The Legacy view filters `source=ui`. | `scripts/seed.ts:664`, `scripts/seed-people.ts:7-8` |
| 15 | Phase 1 QA | Fixed the `jq` precedence. The read-mark step picks an unread root first. Perf script uses a `/tmp` DB and times a full sidebar poll. | `.total, [..] \| unique` pipes the number into `unique`. A random root can already be read under D5. | Phase 1 QA commands |
| 16 | Phase 3 | `useSessionsView` falls back to Legacy on an older API (`useFeatureGate`). | The hosted dashboard can talk to an API without `/api/session-tree`. | `api/hooks/use-feature-gate.ts`, `lib/session-sharing.ts:19` |
| 17 | Phase 3 | One `useSessionsView` instance per page. QA no longer needs a reload. | `useLocalToggle` syncs only other tabs through the `storage` event. | `hooks/use-local-toggle.ts:49-57` |
| 18 | Phase 3 | Triage write shapes from the app. Bulk client method. Row-level optimistic update, then invalidate. | Parity with the app. No client method calls `/api/inbox-state/bulk`. A client recount repeats D5. | `swarm-app/src/lib/api.ts:257,261`, `src/api/client.ts:3428-3460` |
| 19 | Phase 4 | Opening a session marks it read only when unread. | The mark sets `status:"open"`, which ends a Done or Later state. | `inbox-sections.ts:113-115` |
| 20 | D13, Phase 3 | Reuse `AvatarStack` with `peerColor`. Only one small `UserAvatar` is new. | A second stack component fails the deletion test. | `components/comb/presence-avatars.tsx:33`, `lib/comb/presence.ts:398` |
| 21 | Phase 7 | Follow mode reuses `useAutoScroll`. Dropped `use-timeline-follow.ts`. | The hook already exists with the 100 px rule. | `hooks/use-auto-scroll.ts:21`, `session-conversation.tsx:89` |
| 22 | Phases 6 to 10 | Split old Phase 6 into header (6) and timeline (7). Renumbered 7 to 10. | Old Phase 6 was too big for one agent session. Its QA also measured a tab title before tabs exist. | old Phase 6 QA |
| 23 | Phases 4, 5, 8 | Split, `v`, "Open in split", and "Show the guide" move to Phase 8. Drag-a-tab-to-split added. | They depend on the split and guide from Phase 8. The mockup has drag-to-split. | SPEC Round 2 interaction 9, `index.html:2406` |
| 24 | Phase 5 | Cmd+K searches the server with the palette text. Added `key` to `useStartSession`. Moved the skipped-count toast to rename and delete. | Brainstorm decision 15. The toast text sat under "New group". | brainstorm decision 15, `use-start-session.ts:75-78` |
| 25 | Phase 9, Phase 10 | Phone coverage: extend the `mobile-iphone` `testMatch`. Phase 9 smoke no longer claims phone coverage. | The phone project runs only `composer-enter-key.spec.ts`. | `packages/ui-e2e/playwright.config.ts:33-36` |
| 26 | Phase 3, Phase 10 | Added Docker image builds, `bun check -b`, and the missing gates from `runbooks/ci.md`. | `vaul` changes `bun.lock`, which triggers the image jobs. Phase 10 lacked several merge-gate commands. | `runbooks/ci.md:22-37,79-117` |
| 27 | Phases 1, 2 | OpenAPI check includes the docs-site API reference. Added `session-route-posture.test.ts`. Full curl commands in Phase 2, 4, 5 QA. | CI diffs both paths. The posture test walks every route. Elided commands do not run. | `runbooks/ci.md:34` |
| 28 | Manual E2E | `seed:people` runs after the API is up. `cd apps/ui` runs in a subshell. | `seed:people` calls the API. A bare `cd` moved the rest of the script. | `scripts/seed-people.ts:7-8` |
| 29 | Current State | Fixed cites: `SessionTimeline` `:339`, `CommandMenu` groups `:126-248`, `authorizeAssetKeyWrite` `:1084-1096`, audit `:104-188`, approval status `cancelled`. | Wrong line numbers or values. | the cited files |

Found and not fixed (needs Taras), resolved on 2026-10-21:

- The Cmd+I panel: Taras chose to include it in this PR (D15, Phase 7 item 3).
- `vaul`: Taras kept it (D11).
- The old move route lets a read-only sharee move a session: Taras chose to fix it in this PR (D16, Phase 2 item 3b).
