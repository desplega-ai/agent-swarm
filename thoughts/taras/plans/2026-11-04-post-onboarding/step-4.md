---
id: step-4
name: "Continue with your swarm" swarm endpoint
track: A
depends_on: [step-1, step-5]
external_deps: ["agent-fs release with org swarm_url + live SPA accepting #key= (Track B plan)"]
status: done
completed_at: 2026-11-04
assignee: po-orch-step-4
claimed_at: 2026-11-04T15:54:22Z
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
- [x] `bun run test:root -- src/tests/fs-routes.test.ts src/tests/agent-fs-provision-seeder.test.ts`
- [ ] `cd apps/ui && bun run lint && bunx tsc -b && bun run test -- fs-continue`
- [x] `bun run e2e --strict`
- [x] `bun run docs:openapi && git diff --exit-code openapi.json && bun run check:rbac-coverage && bun run check:openapi-response-coverage`
- [ ] `bun run check:local && bun run tsc:check:tsc`

#### Automated QA:
- [x] Local agent-fs at the Track B release: `curl -sS -X POST -H "Authorization: Bearer <aswt_>" -H 'content-type: application/json' -d '{"returnTo":"<AGENT_FS_LIVE_URL>/file/~/<org>/<drive>/x.md"}' <api>/api/fs/continue` returns a `redirectUrl` ending in `#key=af_...`; `curl -H "Authorization: Bearer <that key>" <agent-fs>/auth/me` returns the user; `GET /auth/keys` lists `live.agent-fs.dev · <date>`.
- [x] Same call with `returnTo: "https://evil.test/"` returns 400.
- [ ] `AGENT_BROWSER_SESSION=po-step4`: open `<app>/fs/continue?return_to=<live>/file/~/<org>/<drive>/x.md` in a profile with the swarm session: the tab ends on the live URL with the fragment stripped and the file shown (needs the Track B SPA change; otherwise assert the final URL only). Screenshot.
- [x] Grep the API log for the key value: zero hits.

#### Manual Verification:
- [ ] Taras tries the full round trip from live.agent-fs.dev once the agent-fs plan is deployed.

**Implementation Note**: This step is a vertical slice, QA-able on its own against a local agent-fs at the Track B release. If that release is not out when the wave starts, leave this step `ready` and run the others. Commit as `[step-4] Continue with your swarm swarm endpoint` after verification passes.

## Implementation notes

Commit `f1b21f26d` on `po/step-4` (2026-11-04). Done by Claude alone (small backend, no Codex round).

- **Blocker resolved**: agent-fs 0.18.17 answers `GET /auth/me` for org-scoped keys with 200 (contract option 1, verified by step-1 QA and again here with the fragment key). No SPA org-scoped mode is needed.
- **Route**: `POST /api/fs/continue` reuses the step-1 checks of `POST /api/fs/keys` (user identity, `fs.join.own`) and its status mapping (now `respondMintFailure` / `respondMintError` in `src/http/fs.ts`). Order: 401, 400 body, 403, 400 `invalid_return_to`, 429 (own limiter, 10/min per user), then mint. 200 sends `Cache-Control: no-store`.
- **Allowlist**: exact origin match against `getAgentFsLiveUrl()` and `AGENT_FS_APP_URL`. Scheme and port count (`http://live...` and `:8443` are rejected). A set `AGENT_FS_LIVE_URL` replaces the default `live.agent-fs.dev`.
- **Label**: `<return_to host> · <YYYY-MM-DD>`, so the default is `live.agent-fs.dev · 2026-11-04` and a self-hosted live app gets its own host.
- **Swarm URL deviation**: the provision seeder applies only when its hash changes, so a PATCH inside it would not run on every boot. `syncAgentFsOrgSwarmUrl(getAppUrl())` lives in `agent-fs-provision.ts` and runs after listen in `src/http/index.ts`, not awaited (like Chat SDK start). It uses the configured bootstrap key and org only and never provisions. 404 or 405 is `unsupported` (silent), other errors log one scrubbed warning. Real 0.18.17 answered the PATCH with 404 on both QA boots and the API logged nothing.
- **Page**: under `RootLayout`, `unlisted("agent-fs continue handoff")`, one lazy import plus one route entry in `routes.tsx`. A ref guard mints one key per visit (StrictMode). Errors map 400/403/409/429/501/503 to short messages with an "Open files here" link to `/file`.
- **UI test command**: `apps/ui` has no `test` script (same as step-5). Ran `bun test src/pages/fs-continue` from `apps/ui` (4 pass) and `bun test apps/ui/src --parallel=4` (2536 pass, 0 fail). A serial `bun test apps/ui/src` has 112 fails with or without the new file (mock.module leaks, pre-existing). The page test mocks `@/api/client` and the card, button and callout primitives, like `join/page.test.tsx`, because the `@/` alias does not resolve under bun test.
- **check:local**: 2 fails, both not from this step. `docs-index-footprint.test.js` expects 472 operations, and the base already has 474 (it fails the same way in the orchestrator worktree). `slack-mode-lifecycle.test.ts` timed out under load and passes alone.
- **Browser QA**: the live SPA does not yet read `#key=`. Real `live.agent-fs.dev` sends a key-less deep link to `/credentials` and drops the fragment. With `live.agent-fs.dev` stubbed in agent-browser, the tab ended on exactly `return_to` plus `#key=af_...`. The fragment strip and the file view need Track B.

