---
date: 2026-07-23T18:55:00+0200
author: taras
topic: "Connections redesign (PR #990, steps 1-10) — unified OAuth core, embedded auth, curated integrations"
tags: [qa, connections, oauth, script-connections]
status: pass
source_plan: thoughts/taras/plans/2026-07-21-connections-redesign/root.md
related_pr: https://github.com/desplega-ai/agent-swarm/pull/990
environment: local
last_updated: 2026-07-23
last_updated_by: taras
---

# Connections Redesign (PR #990) — QA Report

## Context

Functional validation of steps 1-10 of the connections redesign on branch `connections-redesign` (PR #990), including the 4 codex-review fixes in commit `666f7e2d` (migration scope preservation, OAuth binding UI compat, GitHub Accept header, refresh-token rotation enforcement). This QA session precedes step-11 (committed E2E harness + docs), which will formalize the gauntlet.

Depth selected: **Core + tracker/MCP folds**. UI QA: **agent-browser driven with screenshots** (Taras reviews evidence).

## Scope

### In Scope
- Merge-gate style checks on the branch (lint, typecheck, targeted tests, boundary/dep/rbac/vendored checks)
- Migration consolidation (117–121 merged into a single 117) — fresh-DB and populated pre-redesign-DB boots (carry-over, encryption backfill, idempotency, scoped-blob preservation, all connection/binding types)
- API-level E2E: OAuth app → 2 authorizations → 2 connections (embedded auth) → script run with 2 distinct Bearer tokens against a mock API
- Refresh semantics: sweep refresh, refresh-failed status, recovery, manual-refresh rotation enforcement
- Tracker fold (mocked provider through unified core) and MCP-DCR resolution (`resolveSecrets=true`)
- UI surfaces via agent-browser: connections page, OAuth apps/authorizations, single-flow connection dialog, raw-fetch credential dialog

### Out of Scope
- Step-11 deliverables (committed `scripts/e2e-connections-redesign.ts`, docs-site guides, dead-code sweep)
- Real-provider (Google two-inbox) manual pass — step-11 manual verification
- Docker compose swarm E2E (excluded by depth selection)
- Full `bun test` locally (server-dependent + known concurrency flakes; CI on the pushed commit is the suite evidence)

## Test Cases

### TC-1: Branch health — lint / typecheck / targeted tests / static checks
**Steps:**
1. `bun run lint` && `bun run tsc:check`
2. Targeted tests: `bun test src/tests/oauth-wrapper.test.ts src/tests/script-connections-http.test.ts src/tests/connection-embedded-auth.test.ts src/tests/credential-broker.test.ts src/tests/oauth-credential-bindings.test.ts src/tests/oauth-refresh-sweep.test.ts` (+ any mcp-oauth / script-connections sibling test files)
3. `bash scripts/check-db-boundary.sh` && `bun run check:dep-graph` && `bun run check:rbac-coverage` && `bun run check:vendored-openapi`
4. `bun run docs:openapi` → `git diff --exit-code openapi.json`

**Expected Result:** All pass; no openapi drift.
**Actual Result:**
- `bun run lint` → clean, 1162 files checked, no fixes applied.
- `bun run tsc:check` → clean, no diagnostics.
- Targeted tests: ran the QA-doc set plus every mcp-oauth/script-connections/tracker sibling (29 files total: oauth-wrapper, script-connections-http, connection-embedded-auth, credential-broker, oauth-credential-bindings, oauth-refresh-sweep, mcp-oauth-{ensure-token,manual-client,queries,resolve-secrets,wrapper}, script-connections{,-mcp}, unified-oauth-migration, db-queries-{oauth,tracker}, oauth-{callback-flow,presets,refresh-failure}, credential-{check,status-api,status-routing,wait}, credentials, oauth-access-token-tool, jira-oauth, oauth-keepalive, tracker-{fold,tools}) → **401 pass / 0 fail**, 1357 expect() calls.
- `bash scripts/check-db-boundary.sh` → pass (0 violations). `bun run check:dep-graph` → pass (12 pre-existing warn-only worker→db-boundary advisories, 0 errors, unrelated to this PR). `bun run check:rbac-coverage` → pass (52 verbs, 179 routes covered). `bun run check:vendored-openapi` → pass (5 specs).
- `bun run docs:openapi` regenerated `openapi.json` (541.6KB, 316 operations) with **zero diff** against the committed file (`git status --porcelain openapi.json docs-site` empty both before and after regeneration) — no drift, nothing to restore.
**Status:** PASS

Evidence: `/tmp/qa-pr990/tc1-lint.log`, `tc1-tsc.log`, `tc1-targeted-tests.log`, `tc1-checks.log`, `tc1-openapi-{before,run,after}.log`.

### TC-2: Fresh-DB migration boot (merged migration)
**Steps:**
1. Boot API against a brand-new SQLite DB (isolated path, not the dev DB), after the 117–121 → single-117 migration merge.
2. Inspect schema: `oauth_apps` (no provider UNIQUE, quirk columns, source), `oauth_authorizations`, `oauth_pending`, `oauth_refresh_locks.lockKey`, `script_credential_bindings.oauth_authorization_id`, embedded-auth + baseUrl-provenance + vendored-source + keepalive columns.

**Expected Result:** Clean boot, single consolidated migration 117 applied, unified schema present, no legacy `oauth_tokens`/`mcp_oauth_tokens`/`mcp_oauth_pending` tables.
**Actual Result:** Booted branch server (`PORT=3113`, isolated `DATABASE_PATH=/tmp/qa-pr990/tc2-fresh.sqlite`, fixed `SECRETS_ENCRYPTION_KEY`, integrations disabled) against a brand-new file. `_migrations` shows exactly one row at version 117 (`117_unified_oauth`) with 111–116 preceding it and **no** 118–121 rows. Schema inspection confirmed all expected shapes:
- `oauth_apps`: only a non-unique `idx_oauth_apps_provider` index (no `provider` UNIQUE constraint); quirk columns present (`scopeSeparator`, `tokenAuthStyle`, `tokenBodyFormat`, `requiresRefreshTokenRotation`, `extraParamsJson`, `source`, `clientSecretEncrypted`).
- `oauth_authorizations`, `oauth_pending` present with expected columns (`tokensEncrypted`, `tokenVersion`, `status`, `flow`, `contextJson`, etc.).
- `oauth_refresh_locks.lockKey` present (renamed from legacy `provider`).
- `script_credential_bindings.oauth_authorization_id` present; legacy `oauth_provider` column gone.
- `script_connections` carries embedded-auth columns (`auth_type`, `auth_config_key`, `auth_authorization_id`, `auth_param_name`, `auth_template_override`, `auth_hosts_override_json`), `base_url_source` (baseUrl provenance), and `openapi_spec_source_kind` CHECK includes `'vendored'`.
- No `keepAlive` dedicated column — confirmed by design it lives in `oauth_apps.metadata` JSON (per migration 117), not a schema column.
- `oauth_tokens` / `mcp_oauth_tokens` / `mcp_oauth_pending` tables absent (query returned zero rows).
- `PRAGMA integrity_check` → `ok`; `PRAGMA foreign_key_check` → no violations.
**Status:** PASS

Evidence: `/tmp/qa-pr990/tc2-migrations.log`, `tc2-schema.log`, `tc2-boot.log`.

### TC-3: Backward compat — populated pre-redesign DB carry-over, all connection/binding types
**Steps:**
1. Build a pre-redesign fixture DB from `main` (worktree, migrations ≤116): boot once, then seed:
   - Tracker `oauth_apps` + `oauth_tokens` (plaintext tokens, incl. a Jira-style row with rotation + a Linear-style row with `,` scope separator)
   - An `mcp_oauth_tokens` row (each `clientSource`/status worth covering) + a `mcp_oauth_pending` row
   - **Connections of all kinds**: openapi (spec-stored), graphql, raw-fetch — each linked to a `credential_binding_id` where applicable
   - **Bindings of all types**: `auth_kind='config'` (header-template + query-template variants, global/agent/repo scopes), `auth_kind='oauth'` with legacy `oauth_provider` string
   - Agent-scoped + repo-scoped `swarm_config` rows holding legacy `SCRIPT_CREDENTIAL_BINDINGS` blobs whose entries omit `scope` (plus one explicit-global entry)
2. Copy fixture; boot the branch server against the copy.
3. Assert **auth consistency**: tracker apps/tokens carried into `oauth_apps`/`oauth_authorizations` (default label, quirk columns populated — rotation flag, scope separator), tokens encrypted at rest (`tokensEncrypted=1`, ciphertext ≠ plaintext, decrypts back to original), MCP rows carried with status mapping (`connected`→`active` etc.).
4. Assert **connection/binding consistency**: every connection row survives with its kind-specific columns intact and still resolves its binding; `oauth_provider` bindings re-keyed to `oauth_authorization_id` pointing at the right migrated authorization; config bindings untouched (templates, scopes, active flags verbatim); blob entries migrated relationally with **containing-row scope preserved** (P1 fix `666f7e2d`) and explicit scopes untouched; blob key retired.
5. Functional probe post-migration: a script run against a migrated config-binding connection and a migrated oauth-binding connection still substitutes credentials.
6. Boot a second time → no-op (row counts stable, no duplicate migration work).

**Expected Result:** Zero-manual-step upgrade holds for every auth/connection/binding shape; scoped blobs stay scoped.
**Actual Result:**

Built the fixture from `origin/main` (`git worktree add /tmp/qa-pr990/main-tree origin/main`, `bun install`), booted it once against `/tmp/qa-pr990/fixture.sqlite` (schema landed at migration 116, legacy tables `oauth_tokens`/`mcp_oauth_tokens`/`mcp_oauth_pending` present), killed it. Seeded directly via a bun script (`resolveEncryptionKey` + `bun:sqlite`, mirroring `pre117Database()` from `unified-oauth-migration.test.ts` plus additional rows for connections/bindings/scoped blobs not covered by that fixture):
- Tracker apps/tokens: `linear` (comma scope separator), `jira` (rotation + basic/json quirks), `vendor` (plain) — 3 `oauth_apps` + 3 `oauth_tokens` rows.
- `mcp_oauth_tokens`: one `dcr`/`connected` row, one `manual`/`error` row (both AES-encrypted at rest, pre-redesign style) + one `mcp_oauth_pending` row.
- `script_credential_bindings` (5): header/global (`PLAIN_SECRET`), query/global (`QUERY_SECRET`), oauth/global keyed by legacy `oauth_provider='vendor'` string, header/agent-scoped, query/repo-scoped.
- `script_connections` (4): `openapi`/global, `graphql`/repo-scoped, `raw` (raw-fetch)/global bound to the oauth binding, `openapi`/agent-scoped — each with `credential_binding_id` set.
- `swarm_config` `SCRIPT_CREDENTIAL_BINDINGS` legacy blobs (3 rows): global (vendor oauth-provider entry, duplicate of the relational row above — proves de-dup via the identity unique index), agent-scoped (`agent-fixture-2`) with one entry omitting `scope` + one entry with an **explicit** `scope: "global"`, repo-scoped (`repo-fixture-2`) with one entry omitting `scope`.
- Row-count inventory recorded **before** migration (`tc3-inventory-before.log`): `oauth_apps=3, oauth_tokens=3, mcp_servers=2, mcp_oauth_tokens=2, mcp_oauth_pending=1, oauth_refresh_locks=1, script_credential_bindings=5, script_connections=4, swarm_config=4`.

Copied the fixture, booted the **branch** server against the copy. Boot log showed `[migrations] Applied: 117_unified_oauth`, `[oauth-encryption] Migrated 3 app secret(s) and 3 authorization token set(s)`, `[credential-bindings] Migrated 4 legacy SCRIPT_CREDENTIAL_BINDINGS entr(ies) to relational rows and retired the blob key` (4 = 1 duplicate vendor entry correctly skipped by the identity unique index + 3 net-new).

Post-migration assertions, all confirmed:
- **Counts:** `oauth_apps=5` (3 tracker + 2 mcp-app-*), `oauth_authorizations=5`, `oauth_pending=1`, `oauth_refresh_locks=1`, `script_credential_bindings=8` (5 original + 3 net-new from the blob, dup skipped), `script_connections=4` (unchanged), `swarm_config=1` (down from 4 — blob key retired, one unrelated app-boot row remains). Legacy tables absent. `PRAGMA integrity_check` → `ok`, `foreign_key_check` → clean.
- **Auth consistency:** `linear` app has `scopeSeparator=','`; `jira` has `tokenAuthStyle='basic'`, `tokenBodyFormat='json'`, `requiresRefreshTokenRotation=1`; all three `clientSecretEncrypted=1`. All 5 authorizations `tokensEncrypted=1`. MCP status mapping confirmed: `connected`→`active`, `error`→`refresh-failed`. Decrypted `linear` clientSecret, access/refresh tokens, and `vendor` access token all round-trip to their original plaintext values (ciphertext ≠ plaintext).
- **Connection/binding consistency:** all 4 connections survive with `credential_binding_id` intact and `base_url_source='user'`. The oauth-kind binding (`binding-oauth`) was re-keyed from `oauth_provider='vendor'` to `oauth_authorization_id='token-vendor'`, correctly resolving to the vendor authorization. Blob-migrated bindings landed exactly as the P1 fix (`666f7e2d`) specifies: `AGENT_BLOB_SECRET` → `scope='agent', scope_id='agent-fixture-2'` (inherited from the containing swarm_config row — **omitted-scope entries correctly stayed scoped, not leaked to global**), `REPO_BLOB_SECRET` → `scope='repo', scope_id='repo-fixture-2'` (inherited), `EXPLICIT_GLOBAL_BLOB_SECRET` → `scope='global', scope_id=NULL` (explicit scope correctly won over the agent-scoped container).
- **Functional probe (live, not just DB-level):** widened `binding-config`/`binding-oauth` allowed-hosts to include `localhost` (fixture-only tweak, post-inventory), rebooted the branch server with `PLAIN_SECRET=qa-plain-secret-value` env fallback, created an agent, and ran an inline script via `POST /api/scripts/run` doing two `fetch()` calls with `[REDACTED:PLAIN_SECRET]` and `[REDACTED:VENDOR_OAUTH]` placeholder headers against a local mock. The mock captured **`Authorization: Bearer qa-plain-secret-value`** (config-kind binding resolved via env fallback) and **`Authorization: Bearer vendor-access-token`** (oauth-kind binding resolved through the re-keyed `oauth_authorization_id` → decrypted real token) — proving both migrated binding types substitute real credentials end-to-end post-migration. Server log had no raw secret values (scrubbed/absent). Also ran `credential-broker.test.ts` (part of TC-1's 401-pass suite) as the broker-unit-level complement.
- **Second boot → no-op:** re-booted the branch server against the already-migrated file; log showed `[oauth-encryption] No plaintext OAuth secrets to migrate.` and no `Applying: 117` line (already applied) and no credential-bindings migration log line (blob key already gone). Row counts before vs. after second boot are byte-identical (`diff` clean).
**Status:** PASS

Evidence: `/tmp/qa-pr990/tc3-seed.log`, `tc3-inventory-before.log`, `tc3-migrate-boot.log`, `tc3-after-counts.log`, `tc3-auth-consistency.log`, `tc3-encryption-verify.log`, `tc3-connection-consistency.log`, `tc3-functional-probe-response.json`, `tc3-functional-probe-captured.jsonl`, `tc3-before-second-boot-counts.log`, `tc3-after-second-boot-counts.log`, `tc3-second-boot.log`. Fixture DBs preserved at `/tmp/qa-pr990/fixture.sqlite` (pre-migration) and `fixture-migrated.sqlite` (post-migration).

### TC-4: Unified OAuth E2E — app → 2 authorizations → 2 connections → script run
**Steps:**
1. Boot API + in-process mock OAuth provider (authorize/token endpoints) + mock downstream API (records Authorization headers).
2. Create OAuth app (manual source) via API; start authorize flow twice (labels `support`, `sales`) driving the static callback `/api/oauth/callback` with state+code via HTTP.
3. Create two connections with embedded `auth: {type:'oauth', authorizationId: …}` against the mock API spec.
4. `script_run` a script calling both `ctx.api.<slugA>` and `ctx.api.<slugB>`.
5. Assert mock API received two **different** Bearer tokens; script/session logs contain no raw tokens (scrubbed).

**Expected Result:** Full happy path works end to end with per-authorization tokens.
**Actual Result:** Booted branch server (`PORT=3116`, isolated DB, `MCP_BASE_URL=http://localhost:3116`) + a consolidated mock provider/downstream API (`Bun.serve` on `:3800`, handles `POST /token` for both grant types and captures `Authorization` headers on any other path). Created a lead agent.
- `POST /api/oauth-apps` with `provider: "e2e-vendor"`, `authorizeUrl`/`tokenUrl` pointed at the mock → app created, `redirectUri` correctly forced to the static callback (`http://localhost:3116/api/oauth/callback`).
- `POST /api/oauth-apps/{id}/authorize-url` twice (`label: support`, `label: sales`) → two distinct PKCE authorize URLs + states.
- Simulated the browser redirect by hitting `GET /api/oauth/callback?code=<support|sales>-auth-code&state=...` for each → both `200`. `GET /api/oauth-apps/{id}/authorizations` shows two `active` authorizations (`support`, `sales`) each with `hasRefreshToken: true`.
- `POST /api/script-connections` twice (`kind: "openapi"`, inline minimal spec with a `listItems` operation at `/items`, `baseUrl: http://localhost:3800`, `auth: {type: "oauth", authorizationId: <support|sales id>}`) → both created with `authType: "oauth"`, auto-derived managed bindings (`connection.<slug>.oauth`), `tokenStatus: "ok"`.
- `POST /api/scripts/run` with an inline script calling `ctx.api.e2eVendorSupport.listItems({})` and `ctx.api.e2eVendorSales.listItems({})` → both returned `{ok:true}`, `exitCode: 0`.
- Mock's captured log shows **two distinct Bearer tokens**: `Bearer access-for-support-auth-code` and `Bearer access-for-sales-auth-code` — proving per-authorization token isolation through the embedded-auth → managed-binding → egress-substitution pipeline.
- Server boot log and the `session_logs` table were both checked for the raw token strings — zero matches (scrubbed/never logged).
**Status:** PASS

Evidence: `/tmp/qa-pr990/tc4-app-create.log`, `tc4-authurl-{support,sales}.log`, `tc4-callback-{support,sales}.log`, `tc4-authorizations.log`, `tc4-conn-{support,sales}-response.log`, `tc4-script-response.log`, `tc4-captured.jsonl`.

### TC-5: Refresh semantics — sweep, refresh-failed, recovery, rotation enforcement
**Steps:**
1. Expire an authorization's token; trigger refresh (sweep or ensure-token path) against mock token endpoint → succeeds, `tokenVersion` bumps.
2. Make mock token endpoint fail → refresh flips authorization `status` to `refresh-failed` with `lastErrorMessage`; broker/script path surfaces a typed error (not a silent placeholder).
3. Restore endpoint → recovery back to `active`.
4. Manual refresh endpoint (`/api/oauth-authorizations/{id}/refresh`) with `requiresRefreshTokenRotation` app: mock 200 **without** new refresh_token → 502, nothing persisted; with rotated token → 200 and rotation persisted (fix `666f7e2d`).

**Expected Result:** Persisted failure semantics + strict rotation.
**Actual Result:** Reused the TC-4 server/mock/`support` authorization.
1. **Sweep/ensure-token refresh:** set `expiresAt` to the past directly in the DB, then re-ran the same `ctx.api.e2eVendorSupport.listItems({})` script (no manual refresh call — relies purely on the ensure-token path triggered by the expired-token check inside the fetch pipeline). Succeeded transparently; `tokenVersion` bumped `1→2`, `expiresAt` renewed, `status` stayed `active`; mock captured the freshly refreshed Bearer token (`refreshed-access-1-refresh-for-support-auth-code`).
2. **Refresh failure:** expired the token again, flipped the mock's `/token` to `500` via `POST /_control {"failToken":true}`, re-ran the script → script run returned `exitCode:1`, `error: "eval_error"`, with a clear typed error surfaced to the script (**not** a silent placeholder): `Error: OAuth authorization 'e2e-vendor (support)' is in refresh-failed state: refresh_rejected` (thrown from `credential-broker/fetch-patch.ts:assertNoFailedBinding`). DB confirmed `status='refresh-failed'`, `lastErrorMessage='Token refresh failed (500): {"error":"server_error"}'`, `tokenVersion` unchanged from the failed attempt.
3. **Recovery:** restored the mock (`failToken:false`), re-ran the script → succeeded, DB shows `status='active'` again, `lastErrorMessage` cleared, `tokenVersion` bumped to `3`.
4. **Manual refresh + rotation enforcement:** created a second oauth app (`e2e-vendor-rotating`) with `requiresRefreshTokenRotation=1` (set via direct column update — no HTTP field exposes this outside curated presets), completed one authorization against the mock. `POST /api/oauth-authorizations/{id}/refresh` with the mock configured to **omit** `refresh_token` on the refresh grant → **502** `"...response did not include a rotated refresh_token"`, and the authorization row was **byte-identical** before/after (diffed `tokenVersion`/`accessToken`/`refreshToken`/`status` — no change persisted). Reconfigured the mock to return a rotated `refresh_token` (`qa-rotated-refresh-token-xyz`) → **200** `{"ok":true,"status":"active","expiresAt":"..."}` (never returns token values, per spec), DB shows `tokenVersion` bumped `1→2` and the encrypted `refreshToken` column decrypts to exactly `qa-rotated-refresh-token-xyz` — rotation persisted correctly.
**Status:** PASS

Evidence: `/tmp/qa-pr990/tc5-script{1,2,3}-response.log`, `tc5-rotation-before.log`, `tc5-rotation-after-fail.log`, `tc5-manual-refresh-{1,2}.log`, `tc5-control-{fail,restore,omit,rotated}.log`.

### TC-6: Tracker fold — legacy wrapper flow on the unified core
**Steps:**
1. Using a mocked provider, run the tracker-style OAuth flow (legacy init/callback routes from step-8) end to end.
2. Assert tokens land in `oauth_authorizations` (not any legacy table), refresh lock uses `authz:<id>` key, legacy callback route still functional.

**Expected Result:** Tracker stack fully folded; no writes outside unified tables.
**Actual Result:** Rebooted the server with `LINEAR_CLIENT_ID`/`LINEAR_CLIENT_SECRET` set and `LINEAR_REDIRECT_URI` pinned to the running port — `initLinear()` boot-seeding fired (`[Linear] Integration initialized`), landing a `linear` `oauth_apps` row with the expected quirks (`scopeSeparator=','`, `redirectUri=.../api/trackers/linear/callback`). Overrode `authorizeUrl`/`tokenUrl` on that row directly to the mock (mirrors what `seedMockTrackerApp()` does in `tracker-fold.test.ts` — the boot-time seed hardcodes real Linear URLs, not env-overridable).
- `GET /api/trackers/linear/authorize` → `302` with a well-formed `Location` (mock authorize URL, comma-joined scopes, `actor=app`, PKCE challenge, state).
- `GET /api/trackers/linear/callback?code=linear-auth-code&state=...` → `200` "linear authorized" success page.
- DB: token landed **only** in `oauth_authorizations` (`status='active'`, `tokensEncrypted=1`) joined to the `linear` `oauth_apps` row; confirmed `oauth_tokens`/`mcp_oauth_tokens`/`mcp_oauth_pending` do not exist as tables at all on this branch (query for those names returns empty).
- `POST /api/trackers/linear/refresh` (after expiring the token in DB) → `200 {"connected":true,...}`, `tokenVersion` bumped `1→2`, `status` stayed `active` — the **legacy tracker route is fully functional** against the unified core.
- `captureLinearAppUserId` (best-effort Linear GraphQL viewer call to the real `api.linear.app`, not mockable without a fetch interceptor) failed as expected in the boot log (non-fatal, swallowed per `runTrackerCallbackPostProcess()` in `src/http/oauth-callback.ts`) — did not block the `200` callback response, matching the "best-effort" contract asserted by `tracker-fold.test.ts`.
- Refresh lock key format: confirmed by source (`src/oauth/ensure-token.ts:249,330` — `` `authz:${authorizationId}` ``) rather than caught mid-flight in the DB (locks are acquired+released within the same call and the table was empty after each successful refresh in TC-5/TC-6, as expected for a released lock). The ensure-token and manual-refresh paths exercised in TC-5/TC-6 only succeed by going through this exact lock-acquire code path.
- Scoped Jira's equivalent flow to the unit-test suite only (`jira-oauth.test.ts` + the jira half of `tracker-fold.test.ts`, both green in TC-1's 401-pass run) rather than re-running it live — time-boxed to one live tracker (linear) given the mechanism (single unified callback + shared post-process dispatch) is provider-agnostic and already covered per-provider at the unit level.
**Status:** PASS

Evidence: `/tmp/qa-pr990/tc6-boot.log`, `tc6-authorize-headers.log`, `tc6-callback.log`, `tc6-post-callback-db.log`, `tc6-refresh.log`.

### TC-7: MCP-DCR resolution through unified tables
**Steps:**
1. Mock AS + MCP server row; complete (or seed) an MCP OAuth authorization through the unified store.
2. `GET /api/agents/:id/mcp-servers?resolveSecrets=true` → Authorization header resolves from `oauth_authorizations` (Bearer normalization intact).

**Expected Result:** MCP auth resolves via unified core.
**Actual Result:** Created an MCP server row (`POST /api/mcp-servers`, transport `http`, `url: http://localhost:3800/mcp`). Stopped the server briefly and seeded a DCR-style MCP OAuth authorization through the **real production function** `upsertMcpOAuthToken()` (`src/be/db-queries/mcp-oauth.ts` — a facade that writes directly into `oauth_apps`/`oauth_authorizations`, not a legacy table) rather than raw SQL, per the "seed through the unified store" allowance. Verified in the DB: a `mcp-<serverId>` `oauth_apps` row (`source='dcr'`) joined to an `active` `oauth_authorizations` row.
- Restarted the server, installed the MCP server on an agent (`POST /api/mcp-servers/{id}/install`).
- `GET /api/agents/{id}/mcp-servers?resolveSecrets=true` initially returned `resolvedHeaders: {}` because the seeded MCP server's `authMethod` was still the default `static` — the resolver only injects `Authorization` when `authMethod==='oauth'` (`src/http/mcp-servers.ts:278`). Set `authMethod='oauth'` directly (mirroring what the real DCR callback does on completion — confirmed at `src/http/mcp-oauth.ts:488`, a fixture-completeness step, not a product gap since I bypassed the real callback by seeding).
- Re-queried → `resolvedHeaders: {"Authorization": "Bearer qa-mcp-dcr-access-token"}`, `authError: null` — **Bearer normalization intact**, resolved straight from the unified `oauth_authorizations` row through `getMcpOAuthToken()`'s decrypt path.
- Checked the server boot log for the raw seeded access/refresh/client-secret token strings — zero matches (never logged in plaintext).
**Status:** PASS

Evidence: `/tmp/qa-pr990/tc7-mcp-server-create.log`, `tc7-seed.log`, `tc7-install.log`, `tc7-mcp-servers-resolved2.log`.

### TC-8: UI — OAuth apps & authorizations + single-flow connection creation (agent-browser)
**Steps:**
1. Boot API + UI; navigate to Connections.
2. OAuth apps page: create app (check static callback URL shown pre-create in the dialog), presets visible for curated providers, authorization list renders status.
3. Single-flow connection dialog: create a connection with inline OAuth (authorize against local mock provider via popup or fallback), spec-derived baseUrl provenance visible.
4. Raw-fetch credential dialog: `authKind: oauth` now shows the **OAuth Authorization** picker (fix `666f7e2d`), create binding, grid shows "OAuth Account" as provider/label link.
5. Screenshots at each step → `thoughts/taras/qa/screenshots/2026-07-23-connections-redesign/`.

**Expected Result:** All surfaces functional; no dead dialogs; fix-2 flow creates an OAuth-backed binding successfully.
**Actual Result:** Booted an isolated API (`DATABASE_PATH=/tmp/qa-pr990/tc8-ui.sqlite`, fixed `SECRETS_ENCRYPTION_KEY`, integrations disabled, port 3013) + the UI dev server (Vite via portless on `http://127.0.0.1:4469`, proxying `/api` → 3013) + an adapted mock provider (`/tmp/qa-pr990/mock-oauth-ui.ts` on :3800 — the TC-3..7 mock plus a `GET /authorize` that auto-approves and 302-redirects to the static callback with code+state). Drove everything with agent-browser. First load gated behind the API-connect panel (entered key `123123`) then the "Who are you?" identity gate (created person "QA TC8"); both are expected app-level gates, not connections-redesign surfaces. Per sub-step:

1. **Connections page renders (list + catalog browser) — PASS.** The RESOURCES → Connections page renders the four-tab shell (Connections / OAuth Apps / Playground / Raw fetch credentials), search + Kind/Scope filters, and the empty connections DataGrid (Slug/Kind/Target/Ops/Credential/Enabled/Refresh/Created/Updated). Opening **Add Connection** shows the catalog browser: blessed entries (GitHub, Linear, Slack, Gmail, Jira all `BLESSED`), OpenAPI/GraphQL/MCP entries (Atlassian, Cloudflare, Stripe, Spotify, …), MCP/OpenAPI/GraphQL kind filters, search, and the "Not listed? Enter a provider domain" fetch + "Skip - start from scratch". (Screenshots 02, 03.)

2. **OAuth apps page — PASS.** Add OAuth App dialog shows the **static callback URL BEFORE creation**, inside the dialog: `http://localhost:3013/api/oauth/callback` in a copyable field with the note "Register this exact URL in the provider console first — the authorization won't complete until it's whitelisted there." (Screenshot 04.) The **Preset** picker lists curated providers — Google, Slack, GitHub, Jira (Atlassian), Linear, Notion (+ Custom) (Screenshot 05). Created a **mock** app via Custom (no preset) + Advanced: provider `mockprov`, client id/secret, Authorize URL `http://localhost:3800/authorize`, Token URL `http://localhost:3800/token` (Screenshot 06) → app saved, grid row shows `mockprov / MANUAL / mock-client-id / http://localhost:3013/api/oauth/callback / 0 accounts / no accounts`. The detail page's **Authorizations** list renders (empty state "No authorizations yet") and, post-authorize (sub-step 3), a `support` row with an `ACTIVE` status badge + Re-authorize/Refresh/Revoke actions and "expires in 59m" (Screenshots 07, 09).

3. **Authorize flow from the UI → active — PASS.** "Authorize account" → label `support` → the app opens the authorize URL in a new tab (`window.open(url, "_blank", "noopener,noreferrer")`). The tab hit the mock `/authorize`, 302-redirected to `…/api/oauth/callback?code=…&state=…`, and rendered the API's **"OAuth Authorized"** success page (Screenshot 08). The detail page's polling authorizations query then showed `support` **active** with `hasRefreshToken: true` (confirmed both in-UI and via `GET /api/oauth-apps/{id}/authorizations`). Popup completion worked without needing the blocked-popup fallback.

4. **Single-flow connection with inline OAuth — PASS (one UI-polish note).** Add Connection → Manual form → OpenAPI, slug `mockConn`, allowed hosts `localhost`, **Base URL left blank**, inline JSON spec declaring `servers:[{url:"http://localhost:3800"}]` + a `listItems` GET `/items`. Auth = **OAuth** → the `OAuthInlineConnect` sub-flow (OAuth App select → mockprov, Authorization select → `support`, showing the active badge — Screenshot 10). Saved → connection created with `authType: "oauth"`, `authAuthorizationId` = the support authorization, auto-derived managed binding `connection.mockConn.oauth` (tokenStatus `ok`), operationCount 1. **Spec-derived baseUrl provenance confirmed at the data layer**: the API returns `baseUrl: "http://localhost:3800/"` with **`baseUrlSource: "spec"`** (extracted from the spec's `servers` because the field was left blank). The detail page's Target row shows the derived `http://localhost:3800/` (Screenshot 11). Note: `baseUrlSource` itself is **not surfaced anywhere in the UI** (`grep -rn baseUrlSource apps/ui/src` → 0 hits); the "Spec source: INLINE" row is the spec-source-kind, not the baseUrl provenance. See Issues Found (low).

5. **Raw-fetch credential dialog (fix `666f7e2d`) — PASS.** Raw fetch credentials tab → Add Binding → Auth kind = **OAuth** renders the **`OAuthInlineConnect` "OAuth Authorization" picker** (OAuth App select + preset/client-id/secret create path + authorize flow) — **not** a provider free-text/select (Screenshot 12). Selected mockprov + the `support` authorization, config key `MOCK_OAUTH_BINDING`, allowed host `localhost` (header template auto-filled `Authorization: Bearer [REDACTED:MOCK_OAUTH_BINDING]`) (Screenshot 13) → binding created (`authKind: "oauth"`, `oauthAuthorizationId` = support, `tokenStatus: "ok"`, `source: "user"`). The bindings grid's **"OAuth Account" column** renders **`mockprov / support`** as a link (blue, external-link icon) pointing to `/connections/oauth-apps/mockprov`; clicking it resolves via the provider-slug fallback to the app detail page (Screenshot 14).

6. **General sweep — PASS.** After a clean `console --clear` + fresh reload and navigating all four tabs, the UI produced **zero `[error]`-level console messages** (only a cosmetic AG Grid `#48` valueFormatter warning for the `allowedHosts` object column, plus vite/devtools debug lines). No dead dialogs, no stuck spinners, all grids rendered with live data, and every navigation resolved. (The earlier raw console buffer contained Clerk / `apps/web/.../DemoClient.tsx` parse errors — those originate from the unrelated **swarm-studio** dev server sharing the Chrome session, not agent-swarm's UI, which uses Vite and no Clerk.)
**Status:** PASS (all 6 sub-steps; one low-severity UI-polish note — baseUrl provenance stored but not surfaced in the UI)

### TC-9: Real-provider OAuth pass (Linear + Jira)

**Context:** TC-1..8 exercised only local mock OAuth providers. This pass validates the unified OAuth core against the **real Linear** provider (real client credentials from `.env`, port-pinned localhost callback) on an isolated fresh DB (`DATABASE_PATH=/tmp/qa-pr990/tc9-real.sqlite`, fixed `SECRETS_ENCRYPTION_KEY`, Linear/Jira enabled, `SLACK/GITHUB_DISABLE=true`, server on 3013; migrations applied clean to `117_unified_oauth`). Consent was completed by Taras in his own logged-in browser — agent-browser's Chrome instance was not signed in to either provider. **No token/secret value was printed or logged anywhere**; all token comparisons use SHA-256 fingerprints + encrypted-column/structural checks only.

#### Leg A — Linear (real, localhost callback) — PASS

**Steps:**
1. Boot isolated server; drive `GET /api/trackers/linear/authorize` (folded onto the unified state-keyed core via `buildAuthorizationUrl(flow='tracker')`) → 302 to `linear.app/oauth/authorize`; approve consent; land on `http://localhost:3013/api/trackers/linear/callback`.
2. Assert authorization row (active, encrypted) + linear app-row metadata.
3. Real api.linear.app probe with the issued token.
4. Force expiry + trigger refresh → assert a real refresh against Linear's token endpoint.

**Expected Result:** Active encrypted authorization; token authenticates against Linear; refresh bumps `tokenVersion`, keeps `status=active`.

**Actual Result:**
- **Authorize/consent:** `/authorize` seeded a pending row and 302'd to Linear with `redirect_uri=http://localhost:3013/api/trackers/linear/callback` (env-pinned `LINEAR_REDIRECT_URI`, independent of `PUBLIC_MCP_BASE_URL`), comma-separated scopes + `actor=app` + PKCE S256. agent-browser's Chrome hit a **Linear login wall** (not signed in), so — per Taras's mid-run policy — I handed the authorize-start URL to Taras, who approved consent in his own browser (Screenshot 15 = the login wall that triggered the hand-off). I polled the isolated DB until the authorization went active.
- **Authorization row (`oauth_authorizations`):** exactly one row for the linear app — `status=active`, `label=default`, `tokensEncrypted=1`, `tokenVersion=1`, `expiresAt≈+24h`, `scope="app:assignable app:mentionable comments:create issues:create read write"`. App row (`oauth_apps` provider=linear): `redirectUri=http://localhost:3013/api/trackers/linear/callback`, `requiresRefreshTokenRotation=0`, `metadata={"actor":"app","keepAlive":true}` (per `initLinear`), `clientSecretEncrypted` set, `scopeSeparator=","`.
- **Encryption at rest:** `accessToken`/`refreshToken` columns hold opaque AES-256-GCM base64 (`base64(iv12‖ct‖tag16)`, 102/104 bytes) — **not** `lin_…` plaintext, binary payload. Round-trip decrypt with the run's key succeeds (plaintext prefix `li…`, cipher≠plain), proving the stored form is genuinely encrypted yet decryptable by the product's own cipher.
- **Real API probe:** decrypted access token → live `POST https://api.linear.app/graphql { viewer, organization }` returned **HTTP 200**, `viewer.name="(dev) Agent Swarm"` (the `actor=app` bot identity), `organization.urlKey="desplega-labs-test"`. Independently, the callback's own tracker post-process (`captureLinearAppUserId`) persisted the bot id into `kv_entries` (`namespace=integration:linear:bot-app-user-id`, key=org id, value=viewer id) — a second real Linear call proving the freshly-exchanged token authenticates.
- **Refresh (real, against Linear's token endpoint):** forced `expiresAt→past`, then `POST /api/trackers/linear/refresh` → **HTTP 200**; `tokenVersion 1→2`, `status` stays `active`, new future `expiresAt`, `lastRefreshedAt` set; access token changed **and refresh token rotated** (both plaintext fingerprints changed), re-encrypted (`tokensEncrypted=1`).
- **Manual endpoint (fix `666f7e2d`) against real Linear:** `POST /api/oauth-authorizations/{id}/refresh` → **HTTP 200**, body `{"ok":true,"status":"active","expiresAt":…}` with **no token values** (leak-scan of the response body for the raw tokens = false); `tokenVersion 2→3`, access changed, refresh rotated, status active — validating the single-authorization force-refresh + rotation-persistence path end-to-end against a real provider (this is the manual-endpoint/rotation test the plan scoped to Leg B, here satisfied on Linear).
- **Secret hygiene:** server log scanned in-sandbox — the raw access token / refresh token / client secret appear **zero** times; zero suspicious `Bearer <token>` lines; zero `lin_oauth`/`lin_api` occurrences.

**Status:** PASS

![Linear consent — login wall that triggered the hand-off to Taras](screenshots/2026-07-23-connections-redesign/15-linear-consent.png)

#### Leg B — Jira/Atlassian (real, ngrok callback) — SKIPPED (environmental)

**Steps (planned):** bring up `https://taras-swarm.ngrok.dev` → 3013, drive `/api/trackers/jira/authorize`, assert active+encrypted authorization + `requiresRefreshTokenRotation=1` + `cloudId` metadata, then force-expiry rotation + manual-refresh rotation enforcement (the key Atlassian mandatory-rotation test).

**Actual Result:** Wiring verified live up to the consent screen. I started the `swarm-api` ngrok endpoint (`taras-swarm.ngrok.dev` → 3013, tunnel health 200), and the jira `oauth_apps` row seeded correctly — `redirectUri=https://taras-swarm.ngrok.dev/api/trackers/jira/callback` (derived from `PUBLIC_MCP_BASE_URL`), `requiresRefreshTokenRotation=1`, `extraParamsJson={"audience":"api.atlassian.com"}`, `scopes` include `offline_access`, space `scopeSeparator`, `clientSecretEncrypted` set. `/api/trackers/jira/authorize` 302'd to `auth.atlassian.com/authorize`, which redirected to an Atlassian **login wall** (Screenshot 16). Before completing consent, Taras determined the **Atlassian dev OAuth app credentials were most likely revoked previously** and opted out of this leg. Per his instruction it is recorded as **skipped (environmental)** — not blocked, not failed — and the ngrok tunnel was torn down.

**Consequence:** Real **mandatory refresh-token rotation** (Atlassian's rotate-on-every-exchange contract) remains covered only by unit tests + the mock-provider rotation test (TC-5); it is **not** validated against a live provider that *requires* rotation. Mitigant: Leg A did exercise real rotation end-to-end (Linear rotated on every refresh, and the manual `/refresh` endpoint enforced + persisted it), and the jira app-row config that drives rotation was confirmed correct. **Flag as a step-11 candidate:** re-run Leg B once a valid Atlassian OAuth app is registered.

**Status:** SKIPPED (environmental — dev Atlassian app likely revoked; Taras opted out)

![Jira/Atlassian consent — login wall (leg skipped before consent)](screenshots/2026-07-23-connections-redesign/16-jira-atlassian-login.png)

## Edge Cases & Exploratory Testing
- TC-3: legacy `SCRIPT_CREDENTIAL_BINDINGS` blob de-duplication — an oauth-provider blob entry that duplicated an already-relational binding (same `config_key`/scope/templates) was correctly skipped by the identity unique index during the one-shot blob migration (4 attempted inserts logged, 3 net-new rows landed) rather than erroring or double-counting.
- TC-3: scope-inheritance vs. explicit-scope precedence for blob entries — deliberately placed an explicit `scope: "global"` entry inside an **agent-scoped** container row to prove the P1 fix (`666f7e2d`) applies inheritance only when the entry omits `scope`, and that an explicit value always wins over the container. Confirmed correct on both axes.
- TC-5: ensure-token auto-refresh (no manual call) was exercised as the primary refresh trigger, not just the manual endpoint — confirms the credential-broker fetch-patch path itself detects expiry and refreshes transparently mid-script-run.
- TC-5: confirmed the refresh-failure error surfaced to script code is a real thrown `Error` with a descriptive message (`assertNoFailedBinding` in `fetch-patch.ts`), not a placeholder string or a silently-succeeding request with an empty/invalid Authorization header.
- TC-7: caught a real fixture-completeness gap (not a product bug) — seeding via `upsertMcpOAuthToken()` alone doesn't flip `mcp_servers.authMethod` to `'oauth'` the way the real DCR callback does, so `resolveSecrets=true` silently returned empty headers with no error until `authMethod` was set to match. Worth calling out to whoever writes the step-11 e2e harness: **seeding an MCP DCR authorization directly must also set `authMethod='oauth'`**, or the harness will get a false negative on header resolution.

## Evidence

### Screenshots
- **TC-1 through TC-7**: none captured — API-level only (no UI surface exercised).
- **TC-8** (UI, agent-browser): 14 screenshots under `thoughts/taras/qa/screenshots/2026-07-23-connections-redesign/`, embedded below:

  **01 — initial API-connect gate (app onboarding, pre-identity)**
  ![01 connections list](screenshots/2026-07-23-connections-redesign/01-connections-list.png)

  **02 — script-connections page: four-tab shell + empty grid**
  ![02 connections page tabs](screenshots/2026-07-23-connections-redesign/02-connections-page-tabs.png)

  **03 — Add Connection catalog browser (blessed + OpenAPI/GraphQL/MCP entries)**
  ![03 add connection catalog](screenshots/2026-07-23-connections-redesign/03-add-connection-catalog.png)

  **04 — Add OAuth App dialog: static callback URL shown pre-create**
  ![04 oauth app dialog redirect uri](screenshots/2026-07-23-connections-redesign/04-oauth-app-dialog-redirect-uri.png)

  **05 — curated preset list (Google/Slack/GitHub/Jira/Linear/Notion)**
  ![05 oauth presets dropdown](screenshots/2026-07-23-connections-redesign/05-oauth-presets-dropdown.png)

  **06 — Custom+Advanced app filled with mock authorize/token URLs**
  ![06 oauth app filled mock](screenshots/2026-07-23-connections-redesign/06-oauth-app-filled-mock.png)

  **07 — new mock app detail, empty authorizations**
  ![07 oauth app detail no auth](screenshots/2026-07-23-connections-redesign/07-oauth-app-detail-no-auth.png)

  **08 — "OAuth Authorized" callback page (popup completed against mock)**
  ![08 oauth callback success](screenshots/2026-07-23-connections-redesign/08-oauth-callback-success.png)

  **09 — app detail: `support` authorization ACTIVE + app config**
  ![09 oauth authorization active](screenshots/2026-07-23-connections-redesign/09-oauth-authorization-active.png)

  **10 — Add Connection OAuth inline-connect with support selected**
  ![10 connection inline oauth selected](screenshots/2026-07-23-connections-redesign/10-connection-inline-oauth-selected.png)

  **11 — connection detail (Target = spec-derived `http://localhost:3800/`)**
  ![11 connection detail baseurl provenance](screenshots/2026-07-23-connections-redesign/11-connection-detail-baseurl-provenance.png)

  **12 — Add Binding authKind=oauth → OAuthInlineConnect picker (fix `666f7e2d`)**
  ![12 binding oauth authorization picker](screenshots/2026-07-23-connections-redesign/12-binding-oauth-authorization-picker.png)

  **13 — OAuth-backed binding filled (config key + support authorization)**
  ![13 binding oauth filled](screenshots/2026-07-23-connections-redesign/13-binding-oauth-filled.png)

  **14 — bindings grid "OAuth Account" column → `mockprov / support` link**
  ![14 bindings grid oauth account](screenshots/2026-07-23-connections-redesign/14-bindings-grid-oauth-account.png)

  **15 — TC-9 Leg A: real Linear consent — login wall in agent-browser Chrome that triggered the hand-off to Taras**
  ![15 linear consent](screenshots/2026-07-23-connections-redesign/15-linear-consent.png)

  **16 — TC-9 Leg B: real Atlassian consent — login wall (Jira leg skipped before consent, dev app likely revoked)**
  ![16 jira atlassian login](screenshots/2026-07-23-connections-redesign/16-jira-atlassian-login.png)

### Logs & Output
All command logs, request/response bodies, and DB inventories live under `/tmp/qa-pr990/` (not committed — dev-machine scratch). Key files, by TC:
- **TC-1**: `tc1-lint.log`, `tc1-tsc.log`, `tc1-targeted-tests.log` (401 pass / 0 fail), `tc1-checks.log` (boundary/dep-graph/rbac/vendored-openapi), `tc1-openapi-{before,run,after}.log` (no drift).
- **TC-2**: `tc2-boot.log`, `tc2-migrations.log` (single row at 117), `tc2-schema.log` (full `PRAGMA table_info` dumps).
- **TC-3**: `tc3-seed.log`, `tc3-inventory-before.log`, `tc3-migrate-boot.log`, `tc3-after-counts.log`, `tc3-auth-consistency.log`, `tc3-encryption-verify.log`, `tc3-connection-consistency.log`, `tc3-functional-probe-{response.json,captured.jsonl}`, `tc3-{before,after}-second-boot-counts.log`. Fixture DBs preserved: `fixture.sqlite` (pre-migration, from `main`), `fixture-migrated.sqlite` (post-migration, from this branch).
- **TC-4**: `tc4-app-create.log`, `tc4-authurl-{support,sales}.log`, `tc4-callback-{support,sales}.log`, `tc4-authorizations.log`, `tc4-conn-{support,sales}-response.log`, `tc4-script-response.log`, `tc4-captured.jsonl` (two distinct Bearer tokens).
- **TC-5**: `tc5-script{1,2,3}-response.log`, `tc5-rotation-{before,after-fail}.log`, `tc5-manual-refresh-{1,2}.log`, `tc5-control-*.log`.
- **TC-6**: `tc6-boot.log`, `tc6-authorize-headers.log`, `tc6-callback.log`, `tc6-post-callback-db.log`, `tc6-refresh.log`.
- **TC-7**: `tc7-mcp-server-create.log`, `tc7-seed.log`, `tc7-install.log`, `tc7-mcp-servers-resolved2.log`.
- **TC-9**: `tc9-server.log` (boot + integration init, secret-scrubbed), `tc9-ngrok.log`, `tc9-linear-authorize-url.txt`, `tc9-jira-authorize-url.txt`, `tc9-poll.js` (DB poll for authorization activation). The isolated DB `tc9-real.sqlite` held real (encrypted) Linear tokens and was **deleted** after evidence capture; assertions ran in-sandbox and printed only fingerprints/booleans, never token values.
- **Shared infra**: `mock-server.ts` (consolidated OAuth-provider + downstream-API mock used by TC-3's functional probe and TC-4/5/6/7), `mock-captured.jsonl` (running capture log).

### External Links
- [PR #990](https://github.com/desplega-ai/agent-swarm/pull/990)
- Review-fix commit: `666f7e2d`

## Issues Found
- **[Low / doc-worthy] TC-7 fixture gotcha**: seeding an MCP DCR authorization directly via `upsertMcpOAuthToken()` does not set `mcp_servers.authMethod='oauth'` (the real `/api/mcp-oauth/{id}/callback` flow does this as a side effect — `src/http/mcp-oauth.ts:488`). Without it, `resolveSecrets=true` returns `resolvedHeaders: {}` with no `authError`, which reads as a silent no-op rather than a clear signal to set `authMethod`. Not a product bug (the real flow always sets it), but worth a one-line callout in the step-11 e2e harness/docs so future seed helpers don't hit the same false negative.
- No functional, security, or data-integrity issues found in TC-1 through TC-7. The P1 fix (`666f7e2d`, containing-row scope preservation for scope-omitted legacy blob entries) and the rotation-enforcement fix both verified correct under live conditions, not just unit tests.
- **[Low / UI-polish] TC-8 baseUrl provenance not surfaced in the UI**: connections created with a blank Base URL correctly derive it from the spec and store `baseUrlSource: "spec"` in the API, but that provenance is never rendered in `apps/ui` (`grep -rn baseUrlSource apps/ui/src` → 0 hits). The connection detail page shows the derived URL as "Target" and a "Spec source" row that reflects the OpenAPI *spec-source-kind* (inline/url/vendored), not where the baseUrl came from — so a user can't tell at a glance whether a base URL was spec-derived or user-entered. Not a functional defect (the connection resolves and calls the right host); a small transparency gap worth a badge/label next to Target if surfacing provenance is intended.
- **[Informational / real-provider finding] TC-9 Leg A — Linear DOES issue and rotate refresh tokens**: the `oauth_apps` row for linear is seeded `requiresRefreshTokenRotation=0` with the in-code comment "Linear does not rotate refresh tokens" (`src/linear/app.ts`), and Linear is opted into the keepalive job via `metadata.keepAlive=true` instead. Against the **real** provider, Linear both returned a refresh token at consent *and* returned a rotated refresh token on every refresh (verified across two real refreshes: `tokenVersion` 1→2→3, refresh-token plaintext fingerprint changed each time). The generic wrapper's `nextRefreshToken = refreshed.refreshToken ?? old` path persisted the rotated token correctly, so there is **no functional bug** — but the code comment/assumption is inaccurate and could mislead a future maintainer. Consider softening the comment (Linear may rotate; the code handles it regardless).
- **[Environmental / not a defect] TC-9 Leg B — Jira/Atlassian real leg not run**: the Atlassian dev OAuth app is likely revoked (Taras opted out at the login wall). Real mandatory-rotation validation (Atlassian rotate-on-every-exchange) is therefore still covered only by unit tests + mock TC-5. Re-run Leg B when a valid Atlassian app is available (step-11 candidate). The jira app-row config that drives rotation (`requiresRefreshTokenRotation=1`, `audience`, `offline_access`, ngrok redirect) was confirmed seeded correctly.
- **[Informational] TC-8 fix `666f7e2d` verified in the live UI**: the raw-fetch credential dialog's `authKind: oauth` path renders the `OAuthInlineConnect` "OAuth Authorization" picker (not the old free-text provider input), an OAuth-backed binding was created end-to-end, and the bindings grid's "OAuth Account" column renders the provider/label as a working link. No dead dialogs or broken data wiring observed; the only console error noise came from an unrelated swarm-studio dev server sharing the browser session.

## Verdict
**Status**: PASS
**Summary**: All 8 test cases pass — branch health (401/401 targeted tests + CI merge gate green on `c5fefbfd`), consolidated-migration fresh boot, full backward-compat carry-over across every auth/connection/binding shape (P1 scope fix verified live, second-boot no-op), OAuth E2E with per-authorization tokens, refresh/rotation semantics, tracker + MCP folds, and all UI surfaces via agent-browser (14 screenshots). Only two low-severity, non-blocking notes: the step-11 fixture gotcha (MCP `authMethod` side effect) and `baseUrlSource` provenance not yet surfaced in the UI. **TC-9 (real-provider pass)**: Leg A (real Linear, localhost) **PASS** — active encrypted authorization, live api.linear.app HTTP 200 probe (bot `actor=app` identity), and real refresh + rotation against Linear's token endpoint via both the tracker `/refresh` and the manual `/api/oauth-authorizations/{id}/refresh` endpoint (`tokenVersion` 1→2→3, no token values in responses, no secrets in logs); Leg B (real Jira/Atlassian) **SKIPPED (environmental)** — dev Atlassian app likely revoked, Taras opted out, so live Atlassian mandatory-rotation remains unit-test/mock-only and is flagged as a step-11 re-run candidate. Overall verdict unchanged: **PASS**.

## Appendix
- **Plan**: `thoughts/taras/plans/2026-07-21-connections-redesign/root.md` (step-11 = formal gauntlet, this QA precedes it)
- **Review round**: 4 codex threads fixed in `666f7e2d`, replied + resolved on PR #990; migrations 118–121 consolidated into `117_unified_oauth.sql` in `c5fefbfd`.
- **Notes**: Full local `bun test` intentionally excluded (server-dependent tests + documented concurrency flakes); CI on pushed `c5fefbfd` is fully green and serves as suite evidence. Remaining before merge: step-11 (committed E2E harness, docs-site guides, dead-code sweep, real-provider manual pass).
