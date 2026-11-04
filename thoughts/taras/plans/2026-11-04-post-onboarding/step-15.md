---
id: step-15
name: "Home command center + Needs-you badge"
track: E
depends_on: [step-5, step-11, step-13, step-16]
status: ready
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
- [ ] `bun run e2e:ui -- --grep "home"`
- [ ] `bun run check:local && bun run tsc:check:tsc`
- [ ] `rg -n "MobileNow" apps/ui/src` returns nothing (or only the retained `SectionQuery` helper module)

#### Automated QA:
- [ ] `AGENT_BROWSER_SESSION=po-step15`, local stack: seed one pending approval, one running task under `shared/po-qa/`, one failed task, star `shared/po-qa/`. Home screenshots at 1440 and 390 wide (`/tmp/po-step15-*.png`), compared with `mockups/post-onboarding/shots/r3-home-1440-light.png`: Needs you lists the approval and the failed task; In progress lists `po-qa · 1 running`; Favorites shows the starred group; the checklist card is present; the timeline sits below.
- [ ] Sidebar Home badge shows the count; approve the approval → the badge decrements on the next poll. Recording.
- [ ] Non-admin (`aswt_` for a Requester): Home shows their own checklist items and their sessions, no `DashboardNudges`. Screenshot.

#### Manual Verification:
- [ ] Taras compares the built Home with the approved mockup on his screen.

**Implementation Note**: This step is a vertical slice, QA-able on its own. UI routes to Opus. After completing this step, pause for manual confirmation. Commit as `[step-15] Home command center + Needs-you badge` after verification passes. Frontend PR: screenshots (desktop, phone, non-admin) and the badge recording in `## Before / after`.

### QA Spec (optional):

End-of-plan cross-track QA is covered by `root.md § Global Verification`. If the orchestrator wants a separate evidence doc, generate it with `desplega:qa` at `thoughts/taras/qa/2026-11-04-post-onboarding.md`.
