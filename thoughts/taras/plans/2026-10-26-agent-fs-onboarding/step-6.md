---
id: step-6
name: Requester and Viewer API access
depends_on: []
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-6: Requester and Viewer API access

## Overview

A user token with the Requester role can create, follow, steer, pause, resume, cancel and rename its own tasks, keep its inbox and triage state, and join the swarm's agent-fs drive with its own email. A Viewer gets the per-user UI state and the drive as viewer. Ownership stays enforced by the existing session wall. Operator and admin behavior does not change. Risk: high (RBAC). Label the PR `risk:high`.

Facts (non-admin spike, `thoughts/taras/plans/2026-10-26-agent-fs-onboarding/spikes/non-admin/README.md`):
- Admission (`src/rbac/admission.ts:34-59`, wired at `src/http/core.ts:602-620`) admits a non-grant-all user only for GETs and for routes whose verb the role holds. `rbac: {ungated}` is denied too (pinned by `src/tests/rbac-admission.test.ts:256-283`).
- Live baseline: a Requester got the admission 403 on 39 of 63 calls. After `route-edits.patch`: 19, and every one left is admin-only by design. Foreign tasks move from `403 adm` to `403 ses`, so ownership holds. The operator and admin columns did not change.
- Confirmed live: after the fix, `PATCH /api/inbox-state` with another user's `userId` returns 200. The handler needs a guard.
- `POST /api/fs/members/invite` has no handler authorization (`src/http/fs.ts:108-131, 264-275`). It must not get a verb without an own-email rule.

## Changes Required:

#### 1. Route verbs and built-in roles (from the patch)
**Files**: `src/http/tasks.ts`, `src/http/inbox-state.ts`, `src/http/sessions.ts`, `src/http/telemetry-ui.ts`, `src/be/rbac-roles.ts`, `scripts/check-rbac-coverage.ts`
**Changes**: `git apply thoughts/taras/plans/2026-10-26-agent-fs-onboarding/spikes/non-admin/route-edits.patch` (applies on main `4b88368b5`). It sets:
- `task.create.own` on `POST /api/tasks`;
- `task.cancel.own` on cancel;
- `task.action.own` on pause, resume and `PATCH /api/tasks/{id}/title`;
- `favorite.write.own` on inbox-state (upsert and bulk), session-triage and the UI telemetry relay;
- `task.fs.mutate` on session-moves and prefix;
- requester gains `task.steer.own` and `comb.presence`, viewer gains `comb.presence`;
- it deletes the matching `ROUTE_RBAC_BACKLOG` lines.

Built-in roles re-sync at boot (`ensureRbacSeedsSynced`, `src/be/rbac-roles.ts:374`). This is additive: an install that narrowed users to Requester gains two verbs. Default installs (all admins) see no change. Say so in the PR.

#### 2. Own-user guard for per-user state
**Files**: `src/http/inbox-state.ts` (both handlers, about 50-90), `src/http/sessions.ts` (session-triage, about 633-663)
**Changes**: For `auth.kind === "user"`, reject a body `userId` that is not `auth.user.id` with 403. Operator calls keep today's behavior.

#### 3. Join the drive with your own email
**Files**: `src/rbac/permissions.ts`, `src/rbac/legacy-policy.ts`, `src/be/rbac-roles.ts`, `src/http/fs.ts` (route def 108-131, handler 264-275)
**Changes**:
- New verb `fs.join.own`: "Join the swarm's shared agent-fs drive with your own account email". Map it in `LEGACY_POLICY` the way `favorite.write.own` is mapped. Give it to requester and viewer.
- Route: replace `rbac: {ungated}` with `rbac: { permission: "fs.join.own" }`.
- Handler: when the caller is a user without grant-all, require `can("fs.join.own")` (this is the live call site the coverage check needs). Require a body email equal, ignoring case, to `auth.user.email`. Invite with the stored `auth.user.email` spelling. Force the role: `editor` when the user can `task.fs.mutate`, else `viewer`. Operator and grant-all callers keep today's behavior. The existing rank check in `inviteEmailToSharedOrg` (`src/be/seed/agent-fs-provision.ts:213-234`) stays: it is what stops an invite from demoting the bootstrap admin (accounts spike, finding 5). Note: until step-5 lands, the boot seeder still invites by the free-text profile role, so it can upgrade an RBAC Viewer to agent-fs `editor` at the next boot. That is today's behavior; step-5 fixes it.

#### 4. Tests that pin the old denial
**Files**: `src/tests/rbac-admission.test.ts` (429-486), `src/tests/rbac-admission-e2e.test.ts` (255), `src/tests/rbac-roles.test.ts` (`REQUESTER_VERBS` line 18, viewer subset 190-200, repair 235-247)
**Changes**: The spike found 7 tests that fail with the patch. Rewrite them to the new behavior: Requester create returns 201 with an audit row for `task.create.own`. Keep one test that a verb-less non-GET (`POST /api/db-query`) is still 403 for a Requester.

### Success Criteria:

#### Automated Verification:
- [x] RBAC suites: `bun run test:root -- src/tests/rbac-admission.test.ts src/tests/rbac-roles.test.ts src/tests/rbac-admission-e2e.test.ts src/tests/rbac-wire-e2e.test.ts src/tests/user-roles-http.test.ts`
- [x] New cases, run with `bun run test:root -- src/tests/rbac-admission.test.ts`:
  - Requester creates, cancels, pauses, resumes, steers and renames its own task;
  - the same calls on another user's task return `403` from the session wall;
  - a Viewer cannot create;
  - a Requester `PATCH /api/inbox-state` for another `userId` returns 403;
  - a Requester `POST /api/fs/members/invite` with another email returns 403, and with its own email calls agent-fs with role `editor` (fetch stub, as in `src/tests/agent-fs-provision-seeder.test.ts`);
  - a Viewer with its own email gets role `viewer`.
- [x] Comb batch regression: `bun run test:root -- src/tests/comb-review-batch.test.ts`
- [x] Coverage and boundary: `bun run check:rbac-coverage && bash scripts/check-rbac-boundary.sh`
- [x] Gates: `bun run check:local && bun run lint && bun run lint:slop && bun run tsc:check:tsc`

#### Automated QA:
- [x] Re-run the live matrix on the step's worktree: `bun thoughts/taras/plans/2026-10-26-agent-fs-onboarding/spikes/non-admin/build-matrix.ts <worktree> /tmp/afo-step-6/m.md /tmp/afo-step-6/m.json`. Diff `m.json` against `spikes/non-admin/matrix-after-fix.json`. Expected differences: the inbox-state cross-user rows now `403`, and `fs/members/invite` with the caller's own email passes admission. The operator and admin columns are identical to the baseline `matrix.json`. Delete `/tmp/afo-step-6` afterwards.

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing it, pause for manual confirmation. Commit as `[step-6] Requester and Viewer API access` after verification passes.
