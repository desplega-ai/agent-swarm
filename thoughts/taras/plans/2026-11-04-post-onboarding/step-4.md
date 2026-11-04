---
id: step-4
name: "Continue with your swarm" swarm endpoint
track: A
depends_on: [step-1, step-5]
external_deps: ["agent-fs release with org swarm_url + live SPA accepting #key= (Track B plan)"]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-4: "Continue with your swarm" swarm endpoint

## Overview
A key-less user on the live agent-fs UI clicks "Continue with <swarm>" and lands on the dashboard at `/fs/continue?return_to=<live URL>`. The dashboard (which holds the swarm session) calls `POST /api/fs/continue`. The API checks the session, allowlists `return_to`, mints a **named** key for that user through the step-1 service (`live.agent-fs.dev · <date>`), and returns the redirect URL with the key in the fragment. The dashboard replaces the location; the live SPA stores the key and strips the fragment. The swarm session is a bearer in localStorage (not a cookie), so the hop must go through the SPA. Contract: `root.md § Track B contract`.

Trade-off recorded: a named key in a fragment is longer-lived than the 1-hour session token first considered. It never reaches a server (fragment), the SPA strips it on load, and the user can revoke it by name in agent-fs. If Taras wants expiry, agent-fs can add `expiresAt` to keys later without changing this flow.

Blocker to settle in the Track B plan: admin-minted keys are **org-scoped** (agent-fs PR #153) and get 403 on `/auth/me`, `/auth/keys` and the org list. The live SPA today resolves identity through `/auth/me` on credential load. Track B must either let `GET /auth/me` answer for org-scoped keys (identity plus `scopedOrgId`) or make the SPA work in an org-scoped mode (open the deep-linked org directly). The first is smaller. Record the choice in `root.md § Track B contract` before this step is claimed.

## Changes Required:

#### 1. `POST /api/fs/continue`
**File**: `src/http/fs.ts`
**Changes**: `route()` with `rbac: { permission: "fs.join.own" }`. Body `{ returnTo: z.string().url() }`. Handler: acting user from `authUserId()` (401 when none); `returnTo` origin must equal the origin of `getAgentFsLiveUrl()` or of the configured `AGENT_FS_APP_URL`, else `400 invalid_return_to`; `mintUserAgentFsKey(userId, "live.agent-fs.dev · <YYYY-MM-DD>")` (409 pending, 501 unsupported); respond `schema: z.object({ redirectUrl })` where `redirectUrl = returnTo` with `#key=<af_...>` replacing any fragment. Never log the key (`scrubSecrets`). Rate limit 10/min per user. `bun run docs:openapi`.

#### 2. Dashboard route `/fs/continue`
**Files**: `apps/ui/src/pages/fs-continue/page.tsx` (new), `apps/ui/src/app/routes.tsx`
**Changes**: Route under `RootLayout` with `unlisted("agent-fs continue handoff")`. The page reads `return_to`, shows "Continuing to <host>…", calls `api.fsContinue({ returnTo })` and `window.location.replace(redirectUrl)`. On 400/409/501 it shows the error and a link to `/file`. When the dashboard has no session yet, the `/setup` bounce prior art (`apps/ui/src/components/layout/root-layout.tsx:103`, `from` with pathname + search + hash) brings the user back here after connecting. This is the only step besides step-5 that edits `routes.tsx`; it runs after step-5 and adds exactly one route line.

#### 3. Provision the org's swarm URL
**File**: `src/be/seed/agent-fs-provision.ts`
**Changes**: After the shared org exists, `PATCH /orgs/{orgId}` with `{ swarmUrl: getAppUrl() }` when the agent-fs server supports it (ignore 404 on older agent-fs). Idempotent on every boot.

#### 4. Tests
**Files**: `src/tests/fs-routes.test.ts`, new `scripts/e2e/scenarios/platformb-fs-continue.ts`, `scripts/e2e/coverage-manifest.json`, `apps/ui/src/pages/fs-continue/page.test.tsx` (new)
**Changes**: Allowlist accepted and rejected origins (including `https://live.agent-fs.dev.evil.test`), key in fragment only, 401 without user, 409 pending, 501 unsupported, key never in the API log. The page test mocks the API and asserts `location.replace` is called with the fragment URL.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/fs-routes.test.ts src/tests/agent-fs-provision-seeder.test.ts`
- [ ] `cd apps/ui && bun run lint && bunx tsc -b && bun run test -- fs-continue`
- [ ] `bun run e2e --strict`
- [ ] `bun run docs:openapi && git diff --exit-code openapi.json && bun run check:rbac-coverage && bun run check:openapi-response-coverage`
- [ ] `bun run check:local && bun run tsc:check:tsc`

#### Automated QA:
- [ ] Local agent-fs at the Track B release: `curl -sS -X POST -H "Authorization: Bearer <aswt_>" -H 'content-type: application/json' -d '{"returnTo":"<AGENT_FS_LIVE_URL>/file/~/<org>/<drive>/x.md"}' <api>/api/fs/continue` returns a `redirectUrl` ending in `#key=af_...`; `curl -H "Authorization: Bearer <that key>" <agent-fs>/auth/me` returns the user; `GET /auth/keys` lists `live.agent-fs.dev · <date>`.
- [ ] Same call with `returnTo: "https://evil.test/"` returns 400.
- [ ] `AGENT_BROWSER_SESSION=po-step4`: open `<app>/fs/continue?return_to=<live>/file/~/<org>/<drive>/x.md` in a profile with the swarm session: the tab ends on the live URL with the fragment stripped and the file shown (needs the Track B SPA change; otherwise assert the final URL only). Screenshot.
- [ ] Grep the API log for the key value: zero hits.

#### Manual Verification:
- [ ] Taras tries the full round trip from live.agent-fs.dev once the agent-fs plan is deployed.

**Implementation Note**: This step is a vertical slice, QA-able on its own against a local agent-fs at the Track B release. If that release is not out when the wave starts, leave this step `ready` and run the others. Commit as `[step-4] Continue with your swarm swarm endpoint` after verification passes.
