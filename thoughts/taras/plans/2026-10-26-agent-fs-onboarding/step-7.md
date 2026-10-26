---
id: step-7
name: Role-aware dashboard
depends_on: [step-6]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-7: Role-aware dashboard

## Overview

The dashboard learns the caller's grants from `GET /api/whoami` and stops showing what the role cannot do. A Requester or Viewer is not sent to `/setup`, does not see admin-only pages and Settings, and does not see buttons that return 403. The server stays the source of truth: hiding is convenience. When grants are unknown (operator key, pending query, older API), the UI shows everything, as today.

Facts (non-admin research and spike):
- `GET /api/whoami` returns `{kind, user}` with no grants (`src/http/users.ts:159-180`, handler 692-702). The server has `getUserGrant(userId)` and `listUserRoles(userId)` (`src/be/rbac-roles.ts:185, 238`).
- whoami is queried only for `aswt_` tokens and never refetched (`apps/ui/src/api/hooks/use-whoami.ts:20-29`, `apps/ui/src/contexts/current-user-context.tsx:98-110`).
- `isAdminLike(user)` reads the free-text profile role, not RBAC (`apps/ui/src/lib/user-role.ts`). Leave its 6 prompt call sites alone.
- `NavItem.minRole` (`apps/ui/src/components/layout/app-sidebar.tsx:93-98`) and `UserRole` (`apps/ui/src/api/types.ts:568-571`) are unused and use the wrong role names.
- `OnboardingRedirect` sends every user to `/setup` (`apps/ui/src/components/onboarding/onboarding-redirect.tsx:37-58`, early return at 51).

## Changes Required:

#### 1. whoami grants
**File**: `src/http/users.ts` (`whoamiRoute` schema 168-175, handler 693-702)
**Changes**: Add optional `grants: { grantsAll: boolean, verbs: string[], roles: string[] }`. For `kind: "user"`, fill it from `getUserGrant` and `listUserRoles`, with `grantsAll: true` when RBAC is off (`isRbacEnabled()`, `src/rbac/admission.ts:30-32`). For the operator key, `grantsAll: true`. Then `bun run docs:openapi`.

#### 2. Grant hooks
**Files**: `apps/ui/src/api/types.ts` (`WhoamiResponse` 609-612; delete the unused `UserRole`), `apps/ui/src/contexts/current-user-context.tsx` (63-76), `apps/ui/src/api/hooks/use-whoami.ts` (22-28), new `apps/ui/src/lib/use-can.ts`
**Changes**:
- Expose `grants` on the current-user context.
- `useCan(verb): boolean` and `useIsAdmin(): boolean`. Both return `true` when the tab uses the operator key, when whoami is pending or failed, or when `grants` is absent.
- `useGrantsKnown(): boolean`: `true` for operator-key tabs and once whoami has answered with `grants`.
- Give the whoami query `staleTime: 60_000` and `refetchOnWindowFocus: true`, so a role change shows up.
- Keep the module free of `@/` imports that root-run tests cannot resolve (use relative imports, as in `apps/ui/src/pages/setup/steps/agents/agent-models.test.tsx`).

#### 3. No `/setup` for non-admins
**Files**: `onboarding-redirect.tsx:51`, `apps/ui/src/components/onboarding/setup-pill.tsx:21`, `apps/ui/src/components/onboarding/setup-checklist-card.tsx:31`, `apps/ui/src/components/layout/health-badge.tsx:175`, `apps/ui/src/components/sessions-v2/first-run-guide.tsx:213`, `apps/ui/src/components/support/lead-credential-dialog.tsx:29`, `apps/ui/src/pages/setup/page.tsx:254`
**Changes**: Return early when `!useCan("config.write.any")`. `OnboardingRedirect` also returns early while `!useGrantsKnown()` on a token-bound tab, so a Requester is never sent to `/setup` before whoami answers (an older API without `grants` keeps today's redirect once whoami answers). A non-admin who opens `/setup` directly sees "Setup is for admins. Ask an admin of this swarm to finish it." and a link to `/`.

#### 4. Navigation and Settings
**Files**: `apps/ui/src/components/layout/app-sidebar.tsx` (items 124-176, render 598-601 and 729, Settings flyout 188-200), `apps/ui/src/pages/settings/settings-layout.tsx` (`SETTINGS_NAV` 42-54, filter 98-102), `apps/ui/src/app/router.tsx` (181-203)
**Changes**:
- Replace `minRole` with `adminOnly?: boolean` and filter with `useIsAdmin()` where `isGated` is applied.
- Admin-only nav: Workflows, Scripts, Schedules, Skills, MCP Servers, Connections, Memory, Templates, Apps, People.
- Visible to all: Home, Tasks, Sessions, Pages, Comb, Approvals, Agents. Usage is admin-only. `/chat` is not in the sidebar (it calls `/api/channels`, which no route serves).
- On Approvals, hide approve and reject unless `useCan("approval.respond")`.
- Settings for non-admins: only Appearance and the browser-local Connections page. A small `AdminRoute` wrapper on the hidden Settings routes redirects to `/settings/appearance`.

#### 5. Buttons the role cannot use
**Files**: `apps/ui/src/components/shared/task-composer.tsx`, `apps/ui/src/pages/tasks/[id]/task-actions.tsx`, `apps/ui/src/components/steering/steer-composer.tsx`, `apps/ui/src/components/sessions/task-card.tsx`
**Changes**: Hide create when `!useCan("task.create.own")`, cancel when `!useCan("task.cancel.own")`, pause, resume and rename when `!useCan("task.action.own")`, and steer when `!useCan("task.steer.own")`. After step-6 a Requester holds all five, so this matters for Viewers.

### Success Criteria:

#### Automated Verification:
- [x] whoami: `bun run test:root -- src/tests/whoami-route.test.ts` (new: a Requester token gets `grants.roles` `["requester"]` and `grantsAll: false`; the operator key gets `grantsAll: true`; `RBAC_ENABLED=false` gives `grantsAll: true`)
- [x] Hook logic: `bun run test:root -- apps/ui/src/lib/use-can.test.ts` (new; test the pure decision function `canWithGrants(grants, verb, { operatorTab, pending })` that `useCan` wraps; cases: operator, pending, absent grants, a Requester verb, a missing verb)
- [x] Settings layout: `bun run test:root -- apps/ui/src/pages/settings/settings-layout.test.tsx` (mock the new hook there; add a non-admin case that lists only Appearance and Connections)
- [x] Onboarding redirect: `bun run test:root -- apps/ui/src/components/onboarding/onboarding-redirect.test.tsx` (new; copy the mock.module pattern of `apps/ui/src/pages/settings/settings-layout.test.tsx`; a non-admin is not redirected, an admin is, a token-bound tab with pending whoami is not)
- [x] Routes and docs: `bun run docs:openapi && bun run check:openapi-response-coverage`
- [x] Gates: `bun run check:local && bun run lint && bun run lint:slop && bun run tsc:check:tsc`
- [x] UI: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`

#### Automated QA:
- [x] agent-browser walk with three tabs on a local stack, each with its own session name (`afo-step-7-admin`, `afo-step-7-requester`, `afo-step-7-viewer`). Mint the two tokens with `POST /api/users`, `PUT /api/users/{id}/roles` and `POST /api/users/{id}/mcp-tokens` in a script that never prints them, and open `http://localhost:5274/?apiUrl=http://localhost:3013&apiKey=<token>`. With onboarding still open:
  - the admin is sent to `/setup`;
  - the Requester and the Viewer land on Home;
  - the Requester's sidebar has no People or Workflows, and it creates a task from the composer;
  - the Viewer sees no composer;
  - Screenshot each sidebar for the PR.
- [x] Demotion: change the Requester to Viewer with `PUT /api/users/{id}/roles`, focus the tab again, and the composer disappears within one refetch.

#### Manual Verification:
- [ ] Taras checks the admin-only page list once.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing it, pause for manual confirmation. Commit as `[step-7] role-aware dashboard` after verification passes.
