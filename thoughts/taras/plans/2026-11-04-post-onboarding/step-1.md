---
id: step-1
name: Named agent-fs keys minted on demand + proxy on by default
track: A
depends_on: []
external_deps: ["agent-fs v0.18.17 (PR #153 merged 2026-11-04 13:06 BCN, released 13:10 BCN): POST /orgs/{orgId}/members/{userId}/keys, GET /auth/me for org-scoped keys, keys UI in live. Docker image publish was still running at 13:10 BCN; confirm the image tag exists before bumping pins."]
status: done
completed_at: 2026-11-04
assignee: po-orch-step-1
claimed_at: 2026-11-04T15:11:02Z
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-1: Named agent-fs keys minted on demand + proxy on by default

## Overview
The swarm never stores a user's agent-fs key. The API mints a **named** key for the acting user on demand through agent-fs multi-key (`POST /orgs/{orgId}/members/{userId}/keys` with the bootstrap admin key, agent-fs PR #153), returns the plaintext once to the caller, and forgets it. Each browser (and later the live UI, step-4) gets its own labelled key, so the user can list and revoke them in agent-fs. The server also makes sure the user has an agent-fs account and shared-org membership first, which removes the `409 email-taken` dead end. The `/agentfs/*` proxy stays a transport (forwards the caller's `af_` key, never the swarm key) and turns on by default. After this step, `POST /api/fs/keys {"label":"test"}` with an `aswt_` token returns a fresh `af_` key that agent-fs accepts on `/orgs/<shared org>/...`, and `GET /auth/keys` (with the user's primary key) lists it under that label.

Decision (Taras, review 2026-11-04): no server-held key table. On-demand named keys instead, so the user can revoke them later from agent-fs.

**Facts from agent-fs PR #153 that shape this step** (`https://github.com/desplega-ai/agent-fs/pull/153`, open, Taras approved, merge + release pending):
- Admin route: `POST /orgs/{orgId}/members/{userId}/keys` body `{ label }` (1-100 chars) → `201 { id, label, createdAt, apiKey, userId, orgId }`. 403 non-admin, 404 when caller or target is not in the org (so the swarm must invite first).
- **Admin-minted keys are org-scoped.** They reach only `/orgs/{orgId}` and below with the member's live role. `/auth/*`, `/mcp`, `/invites`, other orgs and the org list return 403. So the dashboard must stop calling agent-fs `/auth/me` with the minted key and take identity from the swarm's `GET /api/fs/me` instead (step-2). The dashboard's other calls (`/orgs/{org}/ops`, `/orgs/{org}/drives/{drive}/files/...`, `/orgs/{org}/drives/{drive}/events`, `apps/ui/src/lib/agent-fs/client.ts:166,185,317`) are all under the org and keep working.
- Self routes `POST/GET /auth/keys`, `DELETE /auth/keys/{keyId}` exist for keys the user mints with their primary key. The list shows `orgId` and `createdByUserId`, so a member sees and can revoke keys the swarm minted for them.
- Audit events `api_key_created` (`method: "admin"`) and `api_key_revoked`.

## Changes Required:

#### 1. Mint service
**File**: `src/be/agent-fs-user-keys.ts` (new)
**Changes**: `ensureUserAgentFsAccount(userId)` and `mintUserAgentFsKey(userId, label)`.
- Account: resolve the swarm user's email (`src/be/users.ts`). Call `inviteEmailToSharedOrg` (`src/be/seed/agent-fs-provision.ts:250-287`) with the role derived like `resolveInvite` (`src/http/fs.ts:263-284`: `editor` for `task.fs.mutate` or grants-all, else `viewer`). `already_member` / `added` → look up the member's agent-fs user id in the shared org (members list, bootstrap key). `pending` (no account) → try `POST /auth/register` with the user's email; a 201 gives a primary key (return it as this mint's key, then invite); a 403 `REGISTRATION_DOMAIN_NOT_ALLOWED` or other failure → `{ status: "pending", reason }`.
- Mint: `POST /orgs/{sharedOrgId}/members/{agentFsUserId}/keys` with `{ label }` using the bootstrap key (`API_AGENT_FS_API_KEY` resolution order, `agent-fs-provision.ts:168-190`). agent-fs 404 on that route → `{ status: "unsupported" }` (old agent-fs). Return `{ apiKey, keyId, label, orgId }` once. Never persist, never log (`scrubSecrets` on every error path).
- Label convention: `<surface> · <client hint> · <YYYY-MM-DD>`, e.g. `Swarm dashboard · Chrome on macOS · 2026-11-04`, `live.agent-fs.dev · 2026-11-04`. Max 100 chars (agent-fs limit), sanitized.

#### 2. Routes
**File**: `src/http/fs.ts`
**Changes**:
- `GET /api/fs/me` (GET, no `rbac`): `schema: { status: "ready"|"pending"|"off"|"unsupported", agentFsUserId?, email, displayName?, orgId, driveId, reason? }`. Calls `ensureUserAgentFsAccount` for the acting user (`authUserId()`; operator key + `X-Swarm-User-Id` per `src/http/favorite-owner.ts:17-58`; operator with no user → 401). This is the identity source for the dashboard because org-scoped keys cannot call agent-fs `/auth/me`.
- `POST /api/fs/keys` (`rbac: { permission: "fs.join.own" }`): body `{ label: z.string().min(1).max(100) }`, `schema: { apiKey, keyId, label, agentFsUserId, orgId, driveId }`. 409 when `pending`, 501 `agent_fs_too_old` when `unsupported`. Rate limit 5/min per user. The response is marked for the secret scrubber (follow `POST /api/fs/agent-credentials`, `src/http/fs.ts:106-121`).
- `bun run docs:openapi`.

#### 3. Lifecycle hook
**File**: `src/http/users.ts:1268-1294`
**Changes**: After a successful invite exchange, `getDbClient().afterCommit(() => ensureUserAgentFsAccount(userId))` fire-and-forget with error logging. No key is minted here; the browser mints its own on first visit (step-2).

#### 4. Proxy on by default
**Files**: `src/utils/constants.ts:345-347`, `src/be/swarm-config-guard.ts:563-564`, `apps/ui/src/lib/configuration-catalog.ts` (`AGENT_FS_PROXY` entry), `.env.example:374-378`, `charts/agent-swarm/values.yaml:329`, `charts/agent-swarm/templates/api-statefulset.yaml:71-93`, `docs-site/content/docs/(documentation)/ui/configuration.mdx`
**Changes**: `isAgentFsProxyEnabled()` defaults to `true` when `AGENT_FS_API_URL` is set. The proxy's auth model is unchanged: it forwards a caller-supplied `af_` bearer (`src/http/agentfs-proxy.ts:263-270`) and never the swarm key (`src/tests/agentfs-proxy.test.ts:607` stays). Helm sets `AGENT_FS_PROXY` whenever agent-fs is enabled.

#### 5. Pin the agent-fs version
**Files**: `src/commands/onboard/compose-generator.ts`, `docker-compose.example.yml`, `docker-compose.local.yml`, `charts/agent-swarm/values.yaml`, `runbooks/local-development.md`
**Changes**: Bump the `agent-fs` image tag to the release that ships PR #153 (the PR bumps the package versions; read the released tag after merge). Record the version under `external_deps` above. The chart version sync check blocks deploys until the pins match.

#### 6. Tests
**Files**: `src/tests/agent-fs-user-keys.test.ts` (new), `src/tests/fs-routes.test.ts`, `src/tests/invites-http.test.ts`, `src/tests/agentfs-proxy.test.ts` (default flip only), `scripts/e2e/scenarios/platformb-fs.ts` (extend) or a new `platformb-fs-keys.ts`, `scripts/e2e/coverage-manifest.json`
**Changes**: Fake agent-fs upstream gains `/orgs/:org/members`, `/orgs/:org/members/:id/keys` (201 shape from PR #153, 404 when not a member), `/auth/register` (201 / 409 / 403). Cases: mint for an existing member; mint after register for a new email; pending on a domain-restricted register; 501 on old agent-fs; label sanitization and the 100-char cap; the key never appears in captured logs; rate limit; invite exchange triggers the account ensure. E2E scenario covers `GET /api/fs/me` and `POST /api/fs/keys` against the fake upstream.

### Success Criteria:

#### Automated Verification:
- [x] `bun run test:root -- src/tests/agent-fs-user-keys.test.ts src/tests/fs-routes.test.ts src/tests/invites-http.test.ts src/tests/agentfs-proxy.test.ts src/tests/agent-fs-provision-seeder.test.ts`
- [x] `bun run check:local && bun run tsc:check:tsc`
- [x] `bun run e2e --strict`
- [x] `bun run docs:openapi && git diff --exit-code openapi.json && bun run check:rbac-coverage && bun run check:openapi-response-coverage`
- [x] `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh`

#### Automated QA:
- [x] Against a local agent-fs built from `feat/multi-api-keys` or the released tag (`AGENT_FS_API_URL=http://localhost:7433`): create a user, mint an `aswt_` token (invite + exchange, see `scripts/e2e/scenarios/invites.ts`), then `curl -sS -X POST -H "Authorization: Bearer <aswt_>" -H 'content-type: application/json' -d '{"label":"qa · curl · 2026-11-04"}' <api>/api/fs/keys` returns an `af_` key. `curl -H "Authorization: Bearer <that key>" -X POST http://localhost:7433/orgs/<shared org>/ops -d '{"op":"ls","path":"/"}'` succeeds. `curl -H "Authorization: Bearer <that key>" http://localhost:7433/auth/me` returns 403 (org-scoped, expected).
- [x] With the user's primary key: `GET /auth/keys` lists the label with `orgId` set.
- [x] Repeat the mint: a second key appears; the first still works (multi-key, not reset).
- [x] An email the agent-fs server refuses to register (`AGENT_FS_REGISTER_ALLOWED_DOMAINS` set to another domain): `GET /api/fs/me` returns `pending` with a reason, `POST /api/fs/keys` returns 409.
- [x] `rg -c 'af_[0-9a-f]{64}' <api log>` is 0.

#### Manual Verification:
- [ ] The agent-fs v0.18.17 Docker image exists (`docker manifest inspect ghcr.io/desplega-ai/agent-fs:0.18.17` or the registry the pins use) before the pins move.

**Implementation Note**: This step is a vertical slice, QA-able on its own through curl. Backend routes to Codex `gpt-6.1-sol` (high). After completing this step, pause for manual confirmation. Commit as `[step-1] Named agent-fs keys minted on demand + proxy on by default` after verification passes.

## Implementation notes

- Commit `d11682e9c` on `po/step-1`. Backend by Codex gpt-6.1-sol (high), reviewed and finished by Claude.
- External dep: agent-fs **v0.18.17** (image `ghcr.io/desplega-ai/agent-fs:0.18.17` confirmed with `docker manifest inspect`). The pins in compose, chart, worker image and `src/commands/onboard/agent-fs-version.ts` were already 0.18.17 on main, so change 5 was a no-op.
- Deviation: the account flow registers before it invites (members list, then `POST /auth/register`, then `inviteEmailToSharedOrg`). Inviting first leaves a dangling pending invite in agent-fs, because register does not accept pending invites.
- Deviation: a mint always returns a named, org-scoped key. The primary key from a register is discarded, never returned or stored. Reason: a browser must never hold an unscoped key, and every browser key stays revocable by name.
- Fact: at v0.18.17, `GET /auth/me` answers org-scoped keys with 200 (Track B item 3 landed in the same release). Other `/auth/*` routes (for example `GET /auth/keys`) return 403. QA checked both.
- `register` returns 200 (not 201) in agent-fs. An old agent-fs is detected by a plain-text 404 on the keys route. A JSON `NOT_FOUND` there means the member is gone, and maps to `pending`.
- New `resolveAgentFsSharedContext()` in `agent-fs-provision.ts`: it uses the configured bootstrap key, org and drive with no agent-fs calls and no config writes, and falls back to `ensureAgentFsSharedProvisioning()`. `inviteEmailToSharedOrg` now uses it too, so the invite route no longer rewrites 5 config rows and resets the file provider on every call.
- Status mapping for `POST /api/fs/keys`: 400 bad label, 401 no user identity (agent callers and page sessions are refused), 403 RBAC, 409 pending, 429 rate limit (5/min per user), 501 `agent_fs_too_old`, 502 agent-fs failure, 503 `agent_fs_not_configured`. 201 has `Cache-Control: no-store`. The minted key is registered with `registerVolatileSecret`.
- The proxy default flip also changes Comb: with `AGENT_FS_API_URL` set and a browser-reachable API URL, Comb is now on with no other setting. `src/tests/comb-links.test.ts` pins `AGENT_FS_PROXY=false` to keep its premise.
- Helm: `agentFs.proxy` defaults to `true`, and the template always emits `AGENT_FS_PROXY` with the value, so `proxy: false` opts out.
- QA ran against a real agent-fs 0.18.17 container (`AGENT_FS_REGISTER_ALLOWED_DOMAINS=example.com,swarm.local`). The invite hook was proved by a direct register returning 409 after an exchange.

