---
id: step-4
name: Static callback + DB pending + multi-authorization flow
depends_on: [step-1]
status: ready
---

# step-4: Static callback + DB pending + multi-authorization flow

## Overview
Replace the per-provider callback model with one static, state-keyed callback `${PUBLIC_MCP_BASE_URL}/api/oauth/callback` backed by the `oauth_pending` table (killing the in-memory PKCE map, `src/oauth/wrapper.ts:56-67`), enable N labeled authorizations per app with best-effort account-identity capture, expose the redirect URL *before* app creation, and register the new RBAC verbs. Legacy callback routes (`/api/oauth/{provider}/callback`, `/api/mcp-oauth/callback`) keep working as thin wrappers over the same state-keyed handler.

## Changes Required:

#### 1. DB-backed pending state for generic/tracker flows
**Files**: `src/oauth/wrapper.ts` (delete `pendingStates` map + `cleanupExpiredStates`; `buildAuthorizationUrl` writes an `oauth_pending` row — signature gains `{appId, label, flow}`; `exchangeCode` consumes by `state`), `src/be/db-queries/oauth.ts` (pending CRUD already exists from step-1 — extend for `flow='generic'|'tracker'`), one shared GC replacing the MCP-only timer (`src/http/mcp-oauth.ts:771-791` → generic `startOAuthPendingGc` in the boot path)
**Changes**: PKCE always-on for all flows; `codeVerifier` encrypted at rest (pattern from step-1's pending adapter). Wrapper stays worker-safe: it must not import `src/be/db` — pending reads/writes go through an injected store interface implemented API-side (wrapper is only invoked API-side today; keep the boundary explicit for `scripts/check-db-boundary.sh`).

#### 2. Static callback route + legacy wrappers
**Files**: `src/http/oauth-callback.ts` (new — `GET /api/oauth/callback`, public `auth:{apiKey:false}`, `rbac:{ungated:"external provider redirect, state-keyed"}`), `src/http/oauth-generic.ts` (per-provider callback becomes a wrapper delegating by `state`; drop the `DEDICATED_CALLBACK_PROVIDERS` linear-only 409 — resolve the linear/jira asymmetry by routing everything through the unified handler), `src/http/mcp-oauth.ts` (callback delegates to the same handler; `flow='mcp'` post-processing preserved: `setMcpServerAuthMethod(id,'oauth')` flip at `:487-488`), `src/http/all-routes.ts` (import new handler file)
**Changes**: Unified handler: consume `oauth_pending` by `state` (single-use), exchange code (app quirks from columns), upsert `oauth_authorizations` row keyed `(appId, label)`, run per-flow post-processing (`tracker`: Jira cloudId resolution into `metadata`; `mcp`: authMethod flip), then identity capture (#3), then redirect to `finalRedirect` or a simple success page.

#### 3. Identity capture (best-effort)
**File**: `src/oauth/identity-capture.ts` (new)
**Changes**: After token upsert: if `app.userinfoUrl` set → GET with Bearer, extract `email`/`login`/`sub` into `accountEmail` + `identityJson`; else if id_token present in the token response → decode claims (no signature verification needed — display-only). Failures logged (scrubbed), never fail the callback.

#### 4. Multi-authorization API surface + RBAC verbs
**Files**: `src/http/script-connections.ts` (rework `/api/oauth-apps` surface): `POST /api/oauth-apps/{id}/authorize-url` body `{label, finalRedirect?}`; `GET /api/oauth-apps/{id}/authorizations`; `DELETE /api/oauth-authorizations/{id}` (revoke best-effort via `revocationUrl` + delete); `POST /api/oauth-authorizations/{id}/refresh`; list/get responses include authorizations array (label, accountEmail, status, expiresAt, scope — never token material). `GET /api/oauth/redirect-uri` (tiny ungated-read route returning the static callback URL — the pre-creation display). `src/rbac/permissions.ts` + `src/rbac/legacy-policy.ts`: register `oauth-app.manage` + `oauth-authorization.manage`; apply to the new/changed non-GET routes (existing script-connection routes keep `script-connection.manage`).
**Changes**: App CRUD moves id-keyed (provider remains a display/lookup field); `assertOAuthAppUrlsSafe` SSRF checks unchanged. `src/tools/credential-bindings/tool.ts`: `oauth-authorize-url` action gains `label`; new `oauth-authorizations-list` action.

#### 5. Tests
**File**: `src/tests/oauth-callback-flow.test.ts` (new) + updates to `src/tests/oauth-wrapper.test.ts`
**Changes**: Mock provider via `Bun.serve`: full dance app → authorize-url(label) → callback(state) → authorization row (encrypted tokens, identity captured); second label → second authorization, first untouched; state replay rejected; expired pending GC'd; legacy per-provider callback wrapper still completes a flow; MCP flow flips `authMethod`; RBAC: non-admin denied on manage routes.

### Success Criteria:

#### Automated Verification:
- [ ] New tests pass: `bun test src/tests/oauth-callback-flow.test.ts src/tests/oauth-wrapper.test.ts`
- [ ] Suites from step-1 stay green: `bun test src/tests/oauth-credential-bindings.test.ts src/tests/unified-oauth-migration.test.ts`
- [ ] `bun run tsc:check` && `bun run lint` && `bash scripts/check-db-boundary.sh` && `bun run check:rbac-coverage` (new verbs registered)
- [ ] `bun run docs:openapi` — commit regenerated `openapi.json` + api-reference docs

#### Automated QA:
- [ ] Boot server + local mock OAuth provider; via curl: `GET /api/oauth/redirect-uri` (before any app exists) → static URL; create app → two authorize-url calls with labels `support`/`sales` → drive both redirects with curl → `GET /api/oauth-apps/{id}/authorizations` shows two rows with distinct labels + captured identity from the mock userinfo
- [ ] Restart the server mid-flow (after authorize-url, before callback) → callback still succeeds (pending state survived — the in-memory-map fragility fix, provable now)
- [ ] MCP-DCR flow against the mock AS still connects and flips `authMethod` (route through `/api/mcp-oauth/{id}/authorize` wrapper)

#### Manual Verification:
- [ ] One real-provider dance (e.g. a scratch Google OAuth app: two inboxes → two authorizations) — needs real credentials + browser

**Implementation Note**: This step is a vertical slice — QA-able on its own. Pause for manual confirmation; commit `[step-4] static callback + DB pending + multi-authorization flow` after verification passes.
