---
id: step-9
name: Invite UI and the teammate path
depends_on: [step-5, step-7, step-8]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-9: Invite UI and the teammate path

## Overview

Admins invite teammates from People and from a closing card at the end of `/setup` (when the team size is not "Just me"). A teammate opens the link, the new `/join` page exchanges the code for a personal token and saves it as a normal dashboard connection, and the teammate lands on Home. If Comb is on, Comb connects the teammate's files account by itself. This step joins step-5 (connect flow), step-7 (no dead ends for non-admins) and step-8 (invite API).

Facts:
- Dashboard connections live in `localStorage` key `agent-swarm-connections` (`apps/ui/src/lib/config.ts:134-197`). Pages change them through `useConfig().addConnection` and `switchConnection` (`apps/ui/src/hooks/use-config.ts:218-230`), which also refresh the config state and reset queries. A URL `apiKey` that starts with `aswt_` becomes a per-tab embed connection instead (`use-config.ts:95-153`). A teammate needs persistence, so `/join` adds a connection. `addConnection` throws (private `assertConnectionsMutable`, `config.ts:51`) in builds with a baked deployment connection, and a deployment connection also wins over an embed connection (`config.ts:236-240`).
- `/connect` is the model for a page outside `RootLayout` that works with no connection: `apps/ui/src/pages/connect/{page.tsx,connect-flow.ts,connect-api.ts}`, routed at `apps/ui/src/app/router.tsx:120-143`.
- People has a "New user" button and dialog (`apps/ui/src/pages/people/page.tsx:285-304`, `new-user-dialog.tsx:17-157`). Roles come from `GET /api/rbac/roles`. The UI calls no role API today.
- Team size lives in the company profile (`apps/ui/src/lib/company-profile.ts:21`, value `"1"` = "Just me").

## Changes Required:

#### 1. API client and hooks
**Files**: `apps/ui/src/api/client.ts`, `apps/ui/src/api/hooks/use-users.ts`, `apps/ui/src/api/types.ts`
**Changes**: `createInvite({ email, name?, role })`, `useCreateInvite()`, `useRbacRoles()`. Types match the step-8 schemas.

#### 2. Version gate
**File**: new `apps/ui/src/api/hooks/use-invites-support.ts`
**Changes**: `INVITES_MIN_VERSION` (the first unreleased version on the merge day) and `useInvitesSupport()` over `useFeatureGate`, copied from `apps/ui/src/api/hooks/use-pool-keys-support.ts`. Every invite entry point renders nothing on an older API.

#### 3. Invite dialog
**Files**: new `apps/ui/src/pages/people/invite-dialog.tsx`, `apps/ui/src/pages/people/page.tsx`
**Changes**:
- An "Invite" button next to "New user", shown only for admins (`useIsAdmin()` from step-7) on a supported API.
- The dialog has email, optional name, and a role select with the three primary roles only (Requester preselected), because `POST /api/invites` accepts only `requester`, `viewer` and `admin`. Use `useRbacRoles()` only for the role descriptions. Role help:
  - Requester: "creates and follows own tasks";
  - Viewer: "reads only";
  - Admin: "full control".
- On success, show the link once, with a copy button, the expiry date ("Valid until <date>, one use"), and "Anyone with this link joins as <role>. Send it in a private message."
- When `apiReachable === "local"`, also show "Teammates cannot reach this swarm yet. It runs at <api url>. Reinstall with `--tunnel` or put it behind a domain."
- 409 `user_exists`: "<email> already has access."
- Follow `apps/ui/DESIGN.md` and the `dashboard-ui` skill for dialogs and copy buttons.

#### 4. End of setup
**File**: the last `/setup` step body or completion view (read `apps/ui/src/pages/setup/page.tsx` and `apps/ui/src/pages/setup/steps/` to find what renders after `first_task`)
**Changes**: An "Invite your team" card when the team size is not `"1"`, the user is an admin and the API is supported. It opens the same dialog.

#### 5. `/join` page
**Files**: new `apps/ui/src/pages/join/{page.tsx,join-flow.ts,join-api.ts}`, `apps/ui/src/app/router.tsx` (next to `/connect`)
**Changes**:
- Read `swarm` (the API URL) and `code` from the URL, and remove them from history at once (`history.replaceState`).
- `POST <swarm>/api/invites/exchange` with an explicit base URL, as `connect-api.ts:70-97` does.
- On success, `const conn = useConfig().addConnection({ name: <host of swarm>, apiUrl: swarm, apiKey: token })` and `useConfig().switchConnection(conn.id)`. When `addConnection` throws (a baked deployment connection), show "This dashboard is managed by its deployment. Open the invite in the dashboard of that swarm." and stop.
- Then `GET <swarm>/status` with the token. If `agent_fs.comb.enabled`, navigate to `/file?connect=auto`, else to `/`.
- 404 `code_invalid`: "This invite link is used or expired. Ask the admin for a new one."

#### 6. Comb auto-connect
**File**: `apps/ui/src/components/comb/connect-card.tsx`
**Changes**: When the URL has `connect=auto`, run "Create with my email" once (the `useConnectFlowDeps()` hook from step-5, a ref guard against double runs), then drop the parameter. The teammate's email comes from `useCurrentUser()` (the token-bound user). Step-6 lets a Requester or Viewer invite only their own email.

### Success Criteria:

#### Automated Verification:
- [x] Join flow logic: `bun run test:root -- apps/ui/src/pages/join/join-flow.test.ts` (new file; copy `apps/ui/src/pages/connect/connect-flow.test.ts`; cases: success saves a connection; 404 shows the expired copy; a baked deployment shows the managed message; Comb on gives `/file?connect=auto`)
- [x] Gate predicate: `bun run test:root -- apps/ui/src/api/hooks/use-invites-support.test.ts` (new; test the pure version check that the hook wraps; an older version hides the entry points. `SWARM_DEV_MODE` bypasses gates in ui-e2e, so this is the only proof)
- [x] Gates: `bun run check:local && bun run lint && bun run lint:slop && bun run tsc:check:tsc`
- [x] UI: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`
- [x] UI E2E: new `packages/ui-e2e/specs/invites.spec.ts` (copy `packages/ui-e2e/specs/connect.spec.ts`). The admin opens People, invites `e2e-ada@example.com` as Requester and reads the link. A second browser context opens it and lands on Home with the composer visible and no People item in the sidebar. Run: `bun run e2e:ui -- --no-build specs/invites.spec.ts`. Then `bun run e2e:ui:tsc && bunx biome check packages/ui-e2e`.

#### Automated QA:
- [x] Recorded agent-browser walk on the root Manual E2E part A stack (sessions `afo-step-9-admin` and `afo-step-9-ada`), per LOCAL_TESTING.md "When you need to verify a UI change". Admin invites Ada from People. Ada opens the link, lands on Home, opens Comb, and Comb connects without a key. Ada creates a task. Attach the screenshots and the 1.5x recording to the PR.
- [x] Reuse the link in a third session: the expired copy shows.

#### Manual Verification:
- [ ] Taras reads the dialog copy and the warning text once.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing it, pause for manual confirmation. Commit as `[step-9] invite UI and the teammate path` after verification passes.
