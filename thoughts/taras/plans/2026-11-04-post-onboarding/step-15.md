---
id: step-15
name: "Home command center + Needs-you badge"
track: E
depends_on: [step-5, step-11, step-13, step-16]
status: done
completed_at: 2026-11-04
assignee: po-orch-step-15
claimed_at: 2026-11-04T16:59:57Z
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-15: Home command center + Needs-you badge

> Design reference (approved 2026-11-04): `mockups/post-onboarding/r3-home.html`. Decision: `root.md § Design decisions (step-16)`, "Round 3 decisions".

## Overview
Home becomes the command center: **Needs you** (pending approvals, sessions that need you, agents blocked on credentials, runs failed in the last 24h), **In progress** (running sessions grouped by key), **Favorites** (starred use cases, pages, workflows, schedules, agent-fs paths), the post-onboarding checklist (step-13), and the activity timeline below. The sidebar Home entry shows a Needs-you count. Desktop and phone share one layout (`MobileNow` retires). After this step, an owner with one pending approval, one running use case and one starred group sees all three above the fold on Home and a "1" badge on Home in the sidebar.

## Changes Required:

#### 1. Needs you
**Files**: `apps/ui/src/components/home/needs-you.tsx` (new), reuse `apps/ui/src/components/dashboard/mobile-now.tsx:33-49` (`SectionQuery`, `MobileNowView` pieces) and `apps/ui/src/lib/recent-failures.ts:27-41`
**Changes**: Four sub-lists: approvals via `useApprovalRequestSummaries({status:"pending"})` (`apps/ui/src/api/hooks/use-approval-requests.ts:20-27`); sessions via `useSessions({status:"needs", limit:20})` (`GET /api/sessions?status=needs`, `src/be/db/session-tree.ts:388`); credential-blocked agents via `useCredentialMissingAgents` (`GET /api/agents/credential-status`); failed in 24h via `useTasks({status:"failed", limit:50, orderBy:"lastUpdatedAt"})` + `summarizeRecentFailures`. Dedupe: a session whose `needsYou` comes from a pending approval appears once (under approvals) by matching `approval.taskId` to the session root. Each row links to the entity. Empty state: "Nothing needs you."

#### 2. In progress by key
**File**: `apps/ui/src/components/home/in-progress.tsx` (new)
**Changes**: `useSessionTree()` groups with `running > 0` (`apps/ui/src/api/hooks/use-session-tree.ts:37-53`; shape `src/http/sessions.ts:163-179`) rendered as rows "<group label> · N running" linking to `/sessions?view=<key>`, plus a "No group" row for `noGroup.running`. Workflow runs are out of scope (no global endpoint, see root.md Appendix).

#### 3. Favorites
**File**: `apps/ui/src/components/home/favorites.tsx` (new)
**Changes**: `useFavorites` for every type (`key` from step-11, `page`, `workflow`, `schedule`, `agent-fs-path`); cards with icon by type; `key` → `/sessions?view=<key>`, `agent-fs-path` → `/file/~/<id>`. Empty state tells how to star things.

#### 4. Home layout
**File**: `apps/ui/src/pages/home/unified-home.tsx:34-119`
**Changes**: Admin-only `DashboardNudges` banner on top. Then a two-column widget grid on `xl` with equal column widths and aligned tops: left = Needs you, In progress (grouped by use case); right = the post-onboarding checklist (step-13) and Favorites. Below, full width, the activity timeline as a widget (`AgentActivityTimeline`, same agent lanes and now-line as today). Every section uses one shared `HomeWidget` chrome (`apps/ui/src/components/home/home-widget.tsx`, new): title, count or status, one action link on the right, a list body (no cards inside cards). Below `xl`: single column in the order Needs you, checklist, In progress, Favorites, timeline. Drop `MobileNow` (the widgets cover phones). Keep the version gate behavior (`:75-119`). `SetupChecklistCard` takes the checklist slot while onboarding is open for admins. The mockup's "Add a widget" ghost tile is NOT built (user-built widgets is a later idea, see `root.md` Appendix).

#### 5. Needs-you badge
**File**: `apps/ui/src/components/layout/app-sidebar.tsx:616-644`
**Changes**: `badges["/"] = treeCount(tree, "needsYou") + credentialsCount` when > 0 (`treeCount`, `apps/ui/src/lib/sessions-v2.ts:342-349`; it skips the `inbox` section, add it since Home counts everything). Gate on `gates["1.82.0"]` like the others. This is the one post-step-5 edit to the sidebar file and touches only the badge map.

#### 6. Tests
**Files**: `apps/ui/src/components/home/*.test.tsx` (new), `apps/ui/src/pages/home/unified-home.test.tsx`, `packages/ui-e2e/specs/home.spec.ts` (extend)
**Changes**: Needs-you dedupe; In-progress rows from a tree fixture; Favorites per type; layout renders sections in order; badge count. Playwright: fixture seeds a pending approval (`workflow-approvals.ts` shows the API calls), a running task under a key, and a `key` favorite; Home shows each; the Home sidebar badge reads "1".

### Success Criteria:

#### Automated Verification:
- [ ] `cd apps/ui && bun run lint && bunx tsc -b && bun run test -- home needs-you in-progress favorites app-sidebar`
- [x] `bun run e2e:ui -- --grep "home"`
- [ ] `bun run check:local && bun run tsc:check:tsc`
- [x] `rg -n "MobileNow" apps/ui/src` returns nothing (or only the retained `SectionQuery` helper module)

#### Automated QA:
- [x] `AGENT_BROWSER_SESSION=po-step15`, local stack: seed one pending approval, one running task under `shared/po-qa/`, one failed task, star `shared/po-qa/`. Home screenshots at 1440 and 390 wide (`/tmp/po-step15-*.png`), compared with `mockups/post-onboarding/shots/r3-home-1440-light.png`: Needs you lists the approval and the failed task; In progress lists `po-qa · 1 running`; Favorites shows the starred group; the checklist card is present; the timeline sits below.
- [x] Sidebar Home badge shows the count; approve the approval → the badge decrements on the next poll. Recording.
- [x] Non-admin (`aswt_` for a Requester): Home shows their own checklist items and their sessions, no `DashboardNudges`. Screenshot.

#### Manual Verification:
- [ ] Taras compares the built Home with the approved mockup on his screen.

**Implementation Note**: This step is a vertical slice, QA-able on its own. UI routes to Opus. After completing this step, pause for manual confirmation. Commit as `[step-15] Home command center + Needs-you badge` after verification passes. Frontend PR: screenshots (desktop, phone, non-admin) and the badge recording in `## Before / after`.

### QA Spec (optional):

End-of-plan cross-track QA is covered by `root.md § Global Verification`. If the orchestrator wants a separate evidence doc, generate it with `desplega:qa` at `thoughts/taras/qa/2026-11-04-post-onboarding.md`.

## Implementation notes

Commit `4e58e9d86` on `po/step-15` (2026-11-04). All UI, by Opus. No Codex round.

- **Badge formula (deviation)**: the plan's `treeCount(tree, "needsYou") + credentials` plus the `inbox` section is wrong twice. The `inbox` counts overlap No group and the groups (`session-tree.ts` adds a row to both), so adding it double counts. And the tree only sees approvals with a `sourceTaskId` in a visible session, so a standalone or workflow approval (the Playwright fixture's kind) reads 0. The badge now is the Needs-you pill: `useNeedsYou()` (`hooks/use-needs-you.ts`) reads pending approval summaries, `GET /api/sessions?status=needs&scope=tree` and credential-blocked agents, and `needsYouItems()` (`lib/needs-you.ts`) dedupes. A session drops out when its root is an approval source, or when only a pending approval explains its `needsYou` (not an unread failure), because every pending approval is listed. Failures of the last 24h are listed but not counted (they would hold the badge up for a day). Gated on `1.82.0` like the other badges; the sessions query also waits for the sessions v2 gate (an older server ignores `status=needs`).
- **Cost**: the sidebar now polls approvals (5s), the needs page and credential status (10s) on every page. They share caches with Home.
- **In progress** shows the group rows (`<label> · N` from the tree) and, as in the approved mockup, up to 3 running sessions under each group (one page of `status=running`). "No group" comes last. A starred group gets the filled star.
- **Favorites**: one `useFavorites` per type, rows resolve their names with `usePage` / `useWorkflow` / `useScheduledTask`. A key with no group reads "No sessions"; a missing page, workflow or schedule reads "... not found". `agent-fs-path` lists only the dashboard favorites, not agent-fs stars held in agent-fs (`useCombFavorites`); follow-up if wanted. No "Manage" action (nothing to manage it with).
- **HomeWidget** (`components/home/home-widget.tsx`) is the chrome of all five widgets. The checklist card and the timeline now render through it (timeline title "Swarm activity", count hidden on phones so "Activity" keeps its room). `SetupChecklistCard` takes a `className` and sits in the checklist slot. Grid: two `xl` columns via `display: contents` columns plus `order-*`, so below `xl` the order is Needs you, checklist, In progress, Favorites. Home scrolls itself; the timeline is `h-80 md:h-[28rem]`.
- **MobileNow** and its test are deleted. Its read-state helpers live in `components/home/section-state.tsx`.
- **Fleet benchmark**: `offStateAllowed` is now just "telemetry off" (the card is on Usage). Two card tests rewritten for that.
- **Hooks**: `useApprovalRequestSummaries` and `useCredentialMissingAgents` take `{ enabled }`; the stale line ref in the credential hook comment is fixed.
- **UI test box stays unticked**: `apps/ui` has no `test` script. Equivalent passed: `bun run lint`, `bunx tsc -b`, `bun run check:tokens`, `bun test home needs-you in-progress favorites app-sidebar` (35 pass, there is no app-sidebar test; the badge count is covered by `lib/needs-you.test.ts`), and `bun test apps/ui/src --parallel=4` (2611 pass).
- **check:local box stays unticked**: Biome and `bun check` passed; the tests failed only on `src/tests/claude-routes-e2e.test.ts` (foundry route, `kill() EPERM`), which fails the same way on the unchanged base `948617832`. `tsc:check:tsc`, `lint:slop`, `e2e:ui:tsc` passed.
- **Playwright**: new home test seeds a running task under a fresh key on its own agent, a key favorite, then a standalone approval. It checks the badge equals the pill, then answers the approval and checks both drop by one. Full suite `bun run e2e:ui -- --retries 0`: 146 passed, 28 skipped. Home specs repeated 3x with no retries: green.
- **QA**: seeded the failed task under `shared/po-qa/` too, and the server queued a follow-up in that chain, so In progress read `po-qa · 2 running` (the session is honestly running). Requester (`aswt_`): no nudges, own `churn-review` session, checklist without Open on swarm items, no badge; every Home read answered 200.

