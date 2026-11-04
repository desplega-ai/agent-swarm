---
id: step-2
name: Dashboard mints its own named key silently, Comb on by default
track: A
depends_on: [step-1]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-2: Dashboard mints its own named key silently, Comb on by default

## Overview
The dashboard keeps holding an agent-fs key per browser (localStorage, as today), but it gets that key by itself: when no credential is stored, or the stored one is rejected, it calls `POST /api/fs/keys` with a label such as `Swarm dashboard · Chrome on macOS · 2026-11-04`, stores the result and continues. No "create account" or "paste a key" step. Comb resolves ON whenever the API has `AGENT_FS_API_URL`, with no browser-reachability probe (the proxy is the transport by default). After this step, a fresh browser with only the swarm connection opens `/file` and any `/file/~/...` link in-app with no extra click, and the user can see that browser's key listed by name in agent-fs.

## Impact on existing swarms (review question, Taras 2026-11-04)
- **Browsers that already hold a key** keep using it. The auto-mint runs only when no credential is stored or the stored one returns 401 (revoked). Nothing is migrated or cleared.
- **Swarms with `AGENT_FS_PUBLIC_URL` set** (direct browser access, e.g. the desplega production swarm): the endpoint stays the public URL. Only the connect flow changes.
- **Swarms with only `AGENT_FS_API_URL`** (Compose example, Helm): Comb was off because the address was not browser-reachable. It turns on through `<api>/agentfs` after upgrade. `COMB_ENABLED=false` opts out, documented in the release notes section of the PR.
- **Older agent-fs** (no member keys route): `POST /api/fs/keys` returns 501 and the UI falls back to today's paste-key form, with a hint to upgrade agent-fs. Nothing breaks, nothing improves until the pin moves.
- **Prod rollout order**: deploy agent-fs first (multi-key), then this.

## Changes Required:

#### 1. Auto-mint connect flow
**Files**: `apps/ui/src/components/comb/connect-flow.ts`, `use-connect-flow-deps.ts`, `connect-card.tsx`, `apps/ui/src/lib/agent-fs/state.ts:62-82`, `apps/ui/src/api/client.ts` (add `fsMe`, `mintFsKey`)
**Changes**: Replace `createAndConnect` / `connectWithKey` with `autoConnect()`: `GET /api/fs/me` → `ready` → `POST /api/fs/keys { label }` → `writeCredential` (`apps/ui/src/lib/agent-fs/credential-store.ts`) → `connect`. The credential's `userId`, `email` and `displayName` come from `/api/fs/me`, not from agent-fs `/auth/me`: admin-minted keys are **org-scoped** (agent-fs PR #153) and get 403 on `/auth/*`. Remove `getMe` (`client.ts:176`) from the connect path and from `useAgentFs` state probing (`apps/ui/src/lib/agent-fs/state.ts`, the `invalid-key` check should probe `POST /orgs/{org}/ops` `ls` on the shared drive instead). The paste-key fallback (primary key) still may call `/auth/me`. States: `needs-connect` and `invalid-key` both trigger `autoConnect` once per page load (guard against loops); `pending` shows a `PendingFilesCard` with the server reason; 501 shows the legacy paste-key form (keep that component, remove the "Create with my email" tab and the browser-side `register`, `client.ts:134-145`). The label is built from `navigator.userAgentData` / UA with a date. The `?connect=auto` query (`connect-card.tsx:42-63`, `join-flow.ts:99-101`) is no longer needed; `/join` sends joiners to `/file`.

#### 2. Setup Files step
**File**: `apps/ui/src/pages/setup/steps/step-files.tsx:56-60, 138-152, 205-210`
**Changes**: Runs the same `autoConnect()`; shows "Your files account is ready" on success, the pending reason on `pending`, the paste form only on 501. Keep `act({action:"complete", step:"files"})` and the 403 tolerance (`:83-94`). Remove the "This email already has an agent-fs account" state.

#### 3. Account menu
**File**: `apps/ui/src/components/comb/account-menu.tsx:38,118`
**Changes**: Show the current key's label; "Manage keys in agent-fs" link (`<live URL>/credentials` or the agent-fs keys page once it exists); "Forget this browser's key" (clears local storage; the next load mints a new one). Copy at `connect-card.tsx:174` becomes "This browser has its own named agent-fs key. Revoke it any time in agent-fs."

#### 4. Comb on whenever the API has agent-fs
**Files**: `src/utils/constants.ts:306-330`, `src/comb/config.ts:32-46`, `src/http/status.ts:773-797`
**Changes**: `getCombState`: explicit `COMB_ENABLED=false` → off; no `AGENT_FS_API_URL` → off; otherwise on. Drop the `isBrowserReachableUrl` branch and its reason strings. `getCombConfig.apiUrl`: `AGENT_FS_PUBLIC_URL` when set, else `<PUBLIC_MCP_BASE_URL>/agentfs` (proxy on by default after step-1). Tests: `src/tests/comb-status.test.ts`, `src/tests/comb-default.test.ts`. `.env.example` and `runbooks/local-development.md` explain the rule.

#### 5. Link opening stays in-app during the first paint
**Files**: `apps/ui/src/lib/comb/links.ts:143-150`, `apps/ui/src/components/shared/task-attachment-link.tsx:99-115`
**Changes**: `combLinkFor` treats `loading` and `needs-connect` (auto-mint in flight) as navigable, so a `/file/~/...` deep link does not bounce to the live URL while the key is minted.

#### 6. Tests
**Files**: `apps/ui/src/components/comb/connect-flow.test.ts` (both copies), `apps/ui/src/pages/setup/steps/step-files.test.tsx`, `apps/ui/src/lib/agent-fs/client.test.ts`, `packages/ui-e2e/specs/comb.spec.ts`
**Changes**: Unit: auto-mint on `needs-connect`, re-mint once on 401, pending card, 501 fallback, no loop. Playwright Comb spec (`@local`, needs `E2E_COMB_AGENT_FS_URL` at the pinned release): drop the key textbox fill (`:73,102`); assert the drive lists with no interaction; a second browser context with the same swarm `storageState` also lists it; agent-fs `GET /auth/keys` shows two labels.

### Success Criteria:

#### Automated Verification:
- [ ] `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b && bun run test`
- [ ] `bun run test:root -- src/tests/comb-status.test.ts src/tests/comb-default.test.ts src/tests/comb-links.test.ts src/tests/comb-config-guard.test.ts`
- [ ] `bun run check:local && bun run tsc:check:tsc`
- [ ] `rg -n "connect=auto|createAndConnect|Create with my email" apps/ui/src packages/ui-e2e` returns nothing
- [ ] `rg -n "/auth/me" apps/ui/src --glob '!**/*.test.*'` shows only the paste-key fallback path
- [ ] `E2E_COMB_AGENT_FS_URL=http://localhost:7433 bun run e2e:ui -- --grep "Comb"` passes against a local agent-fs at the pinned release

#### Automated QA:
- [ ] `AGENT_BROWSER_SESSION=po-step2`: stack = API with `AGENT_FS_API_URL` + local agent-fs (pinned release) + `apps/ui` dev server. New browser profile, set the swarm connection, open `/file`: the shared drive lists with no card. Screenshot `/tmp/po-step2-files.png`.
- [ ] `curl -H "Authorization: Bearer <that browser's key from localStorage>" http://localhost:7433/auth/keys` lists a label starting with `Swarm dashboard ·`.
- [ ] Revoke that key in agent-fs (`DELETE /auth/keys/:id`), reload `/file`: a new key is minted silently and the drive lists again. agent-fs now shows two labels, one revoked.
- [ ] Open `<app>/file/~/<org>/<drive>/<path>` of a file written by an agent in the fresh profile: renders in-app, tab URL stays on the dashboard. Screenshot `/tmp/po-step2-link.png`.
- [ ] Point the stack at an older agent-fs image: `/file` shows the paste-key form with the upgrade hint. Screenshot.
- [ ] Recording of the fresh-profile flow for the PR's `## Before / after`.

#### Manual Verification:
- [ ] Taras opens the local dashboard in a second browser profile and reaches a file in-app without a connect step, then sees the named key in agent-fs.

**Implementation Note**: This step is a vertical slice, QA-able on its own. UI routes to Opus. After completing this step, pause for manual confirmation. Commit as `[step-2] Dashboard mints its own named key silently, Comb on by default` after verification passes. Frontend PR: screenshots and recording in `## Before / after`.
