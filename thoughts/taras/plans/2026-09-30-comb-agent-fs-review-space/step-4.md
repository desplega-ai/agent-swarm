---
id: step-4
name: Comb shell, flag, connect
depends_on: []
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-4: Comb shell, flag, connect

**Repo:** agent-swarm. Works against agent-fs v0.14.0 (no agent-fs changes needed).

## Overview

The Comb entry point exists and is gated. A new config flag `COMB_ENABLED` (off by default) and a browser-facing `AGENT_FS_PUBLIC_URL` reach the dashboard through `/status` as `agent_fs.comb`. A beta "Comb" nav item appears only when the flag is on and agent-fs is configured. The route `/file/~/:orgId/:driveId/*` (and `/file`, which redirects to the swarm drive) renders a "Connect agent-fs" card. A human can create an agent-fs identity with their email, or paste an existing `af_` key, gets invited to the swarm drive, and can disconnect. The key lives only in this browser's localStorage and is never sent to the swarm API. agent-fs queries never persist in the dashboard's localStorage query cache.

When done: with the flag on, a human connects and sees "Connected as <name>" plus the drive root entry count. With the flag off, nothing changes for anyone.

## Changes Required:

#### 1. Config keys
**File**: `apps/ui/src/lib/configuration-catalog.ts`
**Changes**: in the Integrations group (or a new "Experimental" group if Integrations does not fit), add:
- `COMB_ENABLED`: `kind: "boolean"`, `defaultValue: "false"`, label "Comb (beta)", description "Show the agent-fs review space in the dashboard. Needs agent-fs.", `docsUrl` to the Comb docs page added in step-14 (`/docs/ui/comb`).
- `AGENT_FS_PUBLIC_URL`: `kind: "string"`, placeholder `https://agent-fs.example.com`, description "agent-fs URL that browsers use. Defaults to AGENT_FS_API_URL. Set it when the API reaches agent-fs on an internal hostname."

**File**: `src/be/swarm-config-guard.ts`
**Changes**: add `COMB_ENABLED` to the `booleanValidators([...])` list (~276). Add an http(s) URL validator for `AGENT_FS_PUBLIC_URL` (reuse an existing URL validator in the file if there is one).

**File**: `docs-site/content/docs/(documentation)/ui/configuration.mdx`
**Changes**: document both keys (same PR, per CLAUDE.md).

**File**: `docker-compose.local.yml` (api service env, ~113)
**Changes**: `AGENT_FS_PUBLIC_URL=${AGENT_FS_PUBLIC_URL:-http://localhost:7433}` so local compose works in a browser.

#### 2. `/status` comb block
**File**: `src/comb/config.ts` (new)
**Changes**: `getCombConfig()` returns `{ enabled, apiUrl, liveUrl, orgId, driveId }`:
- `enabled` = `COMB_ENABLED` is `"true"`/`"1"` (trimmed, case-insensitive) AND `AGENT_FS_API_URL` is set.
- `apiUrl` = `AGENT_FS_PUBLIC_URL` || `AGENT_FS_API_URL` || null (trailing slash stripped).
- `liveUrl` = `getAgentFsLiveUrl()` (`src/utils/constants.ts:85-88`).
- `orgId` / `driveId` = `getAgentFsDefaultOrgId()` / `getAgentFsDefaultDriveId()` (`src/utils/constants.ts:96-107`).
Read `process.env` on every call (config upserts reload env without a restart).

**File**: `src/http/status.ts` (`StatusAgentFsSchema` ~122-127, builder ~688-692)
**Changes**: add `comb: { enabled: boolean, api_url: string|null, live_url: string, org_id: string|null, drive_id: string|null }` to the schema and fill it from `getCombConfig()`.

**File**: `apps/ui/src/api/types.ts` (`StatusAgentFs` ~2720-2725)
**Changes**: add `comb?: {...}` (optional, so an older API still type-checks the UI).

#### 3. Browser agent-fs client, credential, context
**File**: `apps/ui/src/lib/agent-fs/client.ts` (new)
**Changes**: `AgentFsClient` mirroring `$AFS/live/src/api/client.ts` names: `constructor({endpoint, apiKey})`, `static register({endpoint, email})`, `static health(endpoint)` (public `GET /health`, returns `{version, features}`), `callOp<T>(orgId, op, params, driveId?, {signal})`, `getMe()`, `getRawUrl(orgId, driveId, path)`, `fetchRaw(orgId, driveId, path, {signal})`, `getSignedUrl(orgId, driveId, path, {disposition, expiresIn})`. Errors are an `AgentFsError {status, code, message}`. Messages must never contain the key (run them through the same `af_` scrub the attachments preview uses, `task-attachments-section.tsx:193-198`, moved to a shared helper if needed).

**File**: `apps/ui/src/lib/agent-fs/types.ts` (new)
**Changes**: copy the op result types Comb uses from `$AFS/packages/core/src/ops/types.ts` (`LsEntry`, `StatResult`, `CommentEntry`, `DiffChange`, notification entry, `MeResponse`). Header comment names the source commit.

**File**: `apps/ui/src/lib/agent-fs/credential-store.ts` (new)
**Changes**: key = `deriveStorageKey(apiUrl, "comb:agent-fs:" + endpoint)` (`apps/ui/src/hooks/use-dismissible-card-key.ts:11-13`). Value `{apiKey, userId, email, displayName, connectedAt}`. `read`, `write`, `clear`, plus a `storage` event subscription for cross-tab sync. Ignore malformed JSON.

**File**: `apps/ui/src/contexts/agent-fs-context.tsx` (new), mounted inside the existing providers in the app shell
**Changes**: `AgentFsProvider` + `useAgentFs()`. Reads `useStatusContext().data.agent_fs.comb`. State: `disabled | loading | needs-connect | invalid-key | ready`. Exposes `client`, `endpoint`, `orgId`, `driveId`, `liveUrl`, `me`, `features: Set<string>` (from `AgentFsClient.health`, empty when absent), `connect(credential)`, `disconnect()`. A 401 from `getMe()` moves to `invalid-key`. `disconnect()` clears the credential and removes all `["agent-fs", ...]` queries.

**File**: `apps/ui/src/api/hooks/use-agent-fs.ts` (new)
**Changes**: query-key helper `agentFsKey(endpoint, userId, ...rest)` → `["agent-fs", endpoint, userId, ...rest]`. Hooks in this step: `useAgentFsHealth`, `useAgentFsMe`, `useAgentFsLs(path)`. Later steps add hooks here.

**File**: `apps/ui/src/app/providers.tsx` (~22-64)
**Changes**: `persistOptions.dehydrateOptions.shouldDehydrateQuery = (q) => defaultShouldDehydrateQuery(q) && q.queryKey[0] !== "agent-fs"`.

#### 4. Connect card, route, nav
**File**: `apps/ui/src/components/comb/connect-card.tsx` (new)
**Changes**:
- "Create with my email": email prefilled from the current user (`current-user-context`), editable. Calls `AgentFsClient.register`. On 409 switch to the paste tab with "This email already has an agent-fs account. Paste its key."
- "Paste a key": `af_` key input (password field). Validates with `getMe()`.
- Then `POST /api/fs/members/invite {email: me.email, role: "editor"}` through a new `api.inviteAgentFsMember()` in `apps/ui/src/api/client.ts`. Then verify access with `ls` on the drive root. On invite failure (401/403/500) show "Ask a swarm admin to invite <email> to the drive" and do not save the credential.
- Copy under the form: "Your agent-fs key is stored in this browser only. Disconnect removes it."

**File**: `apps/ui/src/pages/comb/page.tsx` (new, default export)
**Changes**: by `useAgentFs().state`: `disabled` → `EmptyState` "Comb is off" with a link to Settings → Configuration. `needs-connect` / `invalid-key` → `ConnectCard`. `ready` → `PageHeader` "Comb", a "Connected as <displayName or email>" chip, a Disconnect button (`AlertDialog` confirm), and a placeholder body with the root entry count from `useAgentFsLs("/")` (step-5 replaces the body).

**File**: `apps/ui/src/app/router.tsx`
**Changes**: lazy page; routes `file` (redirects to `/file/~/<org_id>/<drive_id>/` when both ids exist, else renders the page) and `file/~/:orgId/:driveId/*`. Add before the `*` catch-all.

**File**: `apps/ui/src/components/layout/app-sidebar.tsx`
**Changes**: `NavItem.requires?: "comb"`. Comb item in WORK after Pages: path `/file`, `beta: { tooltip: "Review agent-fs files with the swarm" }`. The render loops (expanded ~467 and collapsed ~517) skip items whose `requires` is not met (`status.agent_fs.comb.enabled`).

**File**: `packages/ui-e2e/specs/routes.ts`
**Changes**: add `{ path: "/file", name: "Comb" }` (the E2E API has no agent-fs, so the page shows the "Comb is off" state).

#### 5. Tests
**File**: `src/tests/comb-status.test.ts` (new)
**Changes**: `buildStatusPayload()` with env permutations: flag off → `enabled:false`. Flag on without `AGENT_FS_API_URL` → `false`. `AGENT_FS_PUBLIC_URL` wins over `AGENT_FS_API_URL`. Ids come from `AGENT_FS_DEFAULT_*`. Restore env after each test.

**File**: `src/tests/swarm-config-guard*.test.ts` (existing guard test, or new `comb-config-guard.test.ts`)
**Changes**: `COMB_ENABLED` accepts `true/false/1/0`, rejects `yes`. `AGENT_FS_PUBLIC_URL` rejects a non-URL.

**File**: `apps/ui/src/lib/agent-fs/credential-store.test.ts`, `apps/ui/src/lib/agent-fs/client.test.ts` (new, `bun:test`)
**Changes**: namespacing by swarm API URL + endpoint. Malformed JSON reads as null. Client errors never contain the key (mock `fetch`). `callOp` posts `{op, ...params, driveId}` to `/orgs/<org>/ops`.

**File**: `apps/ui/src/app/providers.test.ts` (new) or a small exported `shouldPersistQuery` helper with its own test
**Changes**: `["agent-fs", ...]` queries are not dehydrated. Other successful queries are.

### Success Criteria:

#### Automated Verification:
- [x] Server tests pass: `bun run test:root -- src/tests/comb-status.test.ts src/tests/status.test.ts`
- [x] Guard tests pass: `bun run test:root -- src/tests/comb-config-guard.test.ts` (or the existing guard test file)
- [x] UI unit tests pass: `bun run test:root -- apps/ui/src/lib/agent-fs/credential-store.test.ts apps/ui/src/lib/agent-fs/client.test.ts`
- [x] Typecheck: `bun run tsc:check`
- [x] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [x] OpenAPI + response coverage: `bun run docs:openapi && bun run check:openapi-response-coverage && git status --short openapi.json`
- [x] UI E2E smoke includes the new route: `bun run e2e:ui -- --grep "smoke /file @smoke$"`

#### Automated QA:
- [x] Local Comb loop (root.md) with `COMB_ENABLED` unset: `agent-browser` opens `/file` and sees "Comb is off". The sidebar has no Comb item. Screenshot.
- [x] Set `COMB_ENABLED=true` in Settings → Configuration (agent-browser drives the toggle). Within one status poll (≤30 s) the sidebar shows "Comb" with a BETA tag. Screenshot.
- [x] Connect with a new email (`qa-connect-<random>@example.com`): the card registers, invites, and shows "Connected as ...". `agent-browser eval "Object.keys(localStorage).filter(k => k.includes('comb:agent-fs'))"` returns one key. `agent-browser eval "localStorage.getItem('agent-swarm-query-cache-v1')?.includes('\"agent-fs\"') ?? false"` returns `false`.
- [x] Register the same email again: the card switches to "Paste a key" with the 409 message. Paste the key from the first run: connects.
- [x] Disconnect: the credential key is gone from localStorage and the card is back.
- [x] Record the connect flow (`agent-browser record start/stop`), upload screenshots + recording to agent-fs per LOCAL_TESTING.md "When you need to verify a UI change".

#### Manual Verification:
- [ ] Taras reads the connect card copy and the key-storage warning and confirms the wording.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.

## Implementation Notes

Commit `19e52d7aa` on `feat/comb-1-shell` (worktree `/Users/taras/worktrees/agent-swarm/2026-09-30-comb-shell`). Evidence in `/tmp/comb-run/step-4/` (14 screenshots, `connect-flow.webm`). The last Automated QA box stays open until the orchestrator uploads the evidence.

Verification notes:
- UI E2E smoke: the first run failed before the test body, in the SUT seed (`POST /api/config/reload` answered 500 `Failed to reload config: undefined`). The retry passed (1 passed). The failure is in the E2E boot seed, not in Comb code.
- The literal cache check in Automated QA (`includes('"agent-fs"')`) is a false positive: the persisted `/status` payload already contains `"provider_id":"agent-fs"`. The intended check passed: no persisted query key starts with `"agent-fs"`, and the cache holds no `af_` text.
- The sidebar showed "Comb BETA" 10 s after the toggle.
- Also checked: an invalid pasted key ("agent-fs does not accept this key."), a revoked saved key (`invalid-key` state, the card opens on "Paste a key"), a dead `AGENT_FS_PUBLIC_URL` (`unreachable` state with Retry), and config guard 400s through the real `PUT /api/config`. The API log has no `af_` text.

Decisions and deviations:
- Invite order: the card first runs `ls` on the drive root with the human's key. It calls `POST /api/fs/members/invite` only on 403/404, then checks `ls` again. Reason: agent-fs `inviteToOrg` upserts the role, so inviting an existing admin as `editor` would downgrade them (for example the swarm bootstrap identity).
- After a fresh registration fails at the invite, the new key goes into the "Paste a key" field with a notice. Reason: agent-fs shows a new key only once. The credential is still not saved.
- Extra state `unreachable` (non-401 identity failure: network, 5xx), with a Retry button. The planned five states had no place for it.
- `/file` redirects to the drive only when Comb is enabled, so the flag-off URL stays `/file`.
- The `/health` query key is `agentFsKey(endpoint, null, "health")` (public call, `userId` null).
- `COMB_ENABLED` parsing reuses `isEnvFlagEnabled` from `src/utils/env-flag.ts`.
- `validateHttpBaseUrl` now serves both `OPENROUTER_BASE_URL` and `AGENT_FS_PUBLIC_URL`. The moved OpenRouter message lost its em dash (". Leave blank for openrouter.ai").
- The attachment preview scrubber moved to `apps/ui/src/lib/scrub-secrets.ts` (`scrubSecretText`). `AgentFsClient` also strips its own key from error messages and keeps the key in an ES private field.
- A new hand-written animated icon `components/icons/folder-open.tsx` (lucide `folder-open` path, transform-only lift) for the nav item.
- Breadcrumb label `file: "Comb"`. The org and drive id segments still render as truncated ids (step-5 owns in-page breadcrumbs).
- The UI E2E route name is `comb` (lowercase, like the other entries).
- `use-agent-fs.ts` imports `useAgentFs` from the context, and the context imports `useAgentFsHealth` / `useAgentFsMe` from the hooks file. The import cycle is benign: both sides reference each other only inside function bodies.

### Review fixes

Commit `7f3575934`. Evidence: `/tmp/comb-run/step-4/fix-breadcrumbs.png`, `/tmp/comb-run/step-4/fix-after-disconnect.png`. This subsection supersedes the invite-order reason, the `/health` key, and the import-cycle bullets above.

- Query keys: `agentFsKey(endpoint, userId, orgId, driveId, ...rest)` returns `["agent-fs", endpoint, userId, orgId, driveId, ...rest]`. Every key uses `useAgentFs().endpoint` (the old `me` key used the trimmed `client.endpoint`, so `connect()` eviction could miss it). `useAgentFsLs` keys on the org and drive it reads. `health` passes `null, null, null`. `me` passes `userId, null, null`.
- Any agent-fs 401: `recheckMeOnAuthError` (a query-cache subscription in the provider) invalidates `me` when another agent-fs query fails with a 401. `me` then fails, and the state becomes `invalid-key`. A 401 on `me` itself does not re-trigger (no loop). Every agent-fs query uses `retry: agentFsRetry`.
- Invite order reason (corrected): ls-first keeps an existing member's role, so a swarm viewer stays an agent-fs viewer (read-only). The swarm invite route already refuses to downgrade. That was not the reason.
- The context exposes `credential: Omit<AgentFsCredential, "apiKey">`. The key lives in the client (ES private field) and the provider's store snapshot only.
- No import cycle. `agentFsKey` and `agentFsRetry` moved to `lib/agent-fs/query.ts` (the hooks file re-exports them). `useAgentFsHealth` and `useAgentFsMe` are private to the context module.
- Credential read: `useSyncExternalStore` with `credentialSnapshot(apiUrl, endpoint)` (cached by the raw stored string) and `subscribeCredential`. `writeCredential` and `clearCredential` now notify same-tab subscribers, because the `storage` event fires only in other tabs. `subscribeCredential` takes `onChange: () => void` and an optional event target (for tests). A failed localStorage write no longer "lasts for this page": the dashboard needs localStorage anyway (`lib/config.ts`).
- Pure, tested helpers: `deriveAgentFsState`, `combEndpoint`, `navRequirementMet` (sidebar), `fileRedirectPath` (`/file`) in `lib/agent-fs/state.ts`. The connect flow is `connectWithKey` / `createAndConnect` in `components/comb/connect-flow.ts`, with injected `register`, `getMe`, `ls`, `invite`, `connect`. It returns an outcome (`connected`, `email-taken`, `failed` with an optional `newKey`) and never throws.
- Breadcrumbs on `/file/~/<org>/<drive>/...`: `~` and the org are dropped. The drive reads "Swarm drive" when it equals `useAgentFs().driveId`, else the first 8 characters. Extra (not asked): file path segments show their exact decoded names and skip `routeRedirects`. Before, a folder named `keys` read "API Keys", and `workflow-runs` linked to `/workflows`.
- `COMB_ENABLED` `docsUrl` is `ui/configuration#comb-beta` until step-14 adds `ui/comb`. `types.ts` header names e713bc6 (main after v0.14.0).
- Verification: targeted tests (104 pass across 9 files), `bun run tsc:check`, `apps/ui` lint, `tsc -b`, `check:tokens`, floating-promise and promise-sink checks all pass. Browser re-QA on a fresh DB and agent-fs: `/file` redirects to the drive, a new email connects ("Connected as ..."), the root `ls` resolves, the persisted query cache holds no agent-fs key, the trail reads `Home > Comb > Swarm drive > workflow-runs > design-doc v2.md`, disconnect removes the key, and a second register of the same email opens "Paste a key".
