---
id: step-5
name: Refresh re-key + refresh-failed semantics
depends_on: [step-1]
status: done
assignee: fable-orchestrator-opus-step5
completed_at: 2026-07-23T02:30:00+0200
claimed_at: 2026-07-23T00:30:00+0200
---

# step-5: Refresh re-key + refresh-failed semantics

## Overview
Re-key the entire refresh machinery from provider-string to `authorizationId`: per-authorization sweep, dual-layer locks (`authz:<id>` lockKeys), persisted `refresh-failed` status with typed errors surfaced to scripts (replacing today's console-only failures and silent binding drops), and keepalive generalized off the hardcoded `["linear","jira"]` list. After this step an authorization that stops refreshing is visibly broken — in its status field, in dependent connections, and in script errors — instead of silently missing.

## Changes Required:

#### 1. Ensure/refresh core re-key
**Files**: `src/oauth/ensure-token.ts`, `src/be/db-queries/oauth.ts`
**Changes**: New primary entry points keyed by authorization: `ensureAuthorizationToken(authorizationId, bufferMs)`, `ensureAuthorizationTokenOrThrow`, `forceRefreshAuthorizationOrThrow`. In-process `refreshLocks` map + DB lock keyed `authz:<id>`; `tokenRowChanged` re-check via `tokenVersion`. Provider-string wrappers (`ensureToken(provider)` etc.) become one-liners resolving provider → default authorization (tracker callers migrate off them in step-8). On refresh success: update tokens (+rotation strictness via the `requiresRefreshTokenRotation` column — behavior identical to `src/oauth/wrapper.ts:228-235`), set `status='active'`, `lastRefreshedAt`, clear `lastErrorMessage`, bump `tokenVersion`. On failure: `status='refresh-failed'`, `lastErrorMessage` (scrubbed), throw typed `OAuthRefreshError { authorizationId, appId, reason: 'refresh_rejected'|'lock_timeout'|'no_refresh_token' }` (shape precedent: `CodexOAuthRefreshError`, `src/providers/codex-oauth/storage.ts:87-102`).

#### 2. Sweep per-authorization
**Files**: `src/be/oauth-refresh-sweep.ts`, `src/be/db-queries/oauth.ts` (`listOAuthTokenSweepRows` → `listAuthorizationSweepRows` joining apps)
**Changes**: Iterate authorizations (skip `revoked`); keep 15-min interval, 30-min expiry buffer, 7-day stale keep-alive; per-row try/catch persists `refresh-failed` instead of console-only. `refresh-failed` rows stay in the sweep (retry each pass) so transient provider outages self-heal; only `revoked` is terminal.

#### 3. Typed errors through the broker into scripts
**Files**: `src/be/oauth-credential-bindings.ts` (`resolveOAuthBindingToken(authorizationId)` — throws `OAuthRefreshError`; returns `undefined` only for genuinely-missing rows), `src/be/script-credential-broker.ts:32-42` (stop swallowing: convert failures into a `failedBindings: [{placeholder, allowedHosts, reason, authorizationLabel}]` list alongside resolved ones), `src/scripts-runtime/credential-broker/types.ts` + `broker.ts` + `fetch-patch.ts` (payload carries `failedBindings`; patched fetch throws `Error("OAuth authorization '<label>' is in refresh-failed state: <reason>")` when a request targets a failed binding's host with its placeholder present — instead of today's silent unsubstituted placeholder)
**Changes**: Also update `getOAuthBindingTokenStatus` to derive from persisted `status` + expiry (`ok|expiring|refresh-failed|revoked|missing`) so connection/binding list endpoints (`src/http/script-connections.ts:544,844,1650`, `src/tools/credential-bindings/tool.ts:146`) and later UI badges reflect reality.

#### 4. Keepalive generalization
**File**: `src/oauth/keepalive.ts`
**Changes**: Replace `KEEPALIVE_PROVIDERS = ["linear","jira"]` with: all `active` authorizations having a refresh token whose app sets `requiresRefreshTokenRotation=1` OR opts in via a new `keepAlive` app column/metadata flag (migrated jira/linear rows qualify automatically). Slack alert on failure preserved, message now names app+label.

#### 5. Tests
**Files**: `src/tests/oauth-refresh-sweep.test.ts` (rewrite to authorization keying; keep all 5 scenarios), `src/tests/oauth-refresh-failure.test.ts` (new: failure persists status; recovery flips back to active; broker surfaces failedBindings; sandbox fetch throws the typed message; lock contention across two authorizations of the same app proceeds independently), `src/tests/credential-broker.test.ts` (extend for failedBindings)

### Success Criteria:

#### Automated Verification:
- [ ] `bun test src/tests/oauth-refresh-sweep.test.ts src/tests/oauth-refresh-failure.test.ts src/tests/credential-broker.test.ts src/tests/oauth-credential-bindings.test.ts`
- [ ] Codex lock namespace untouched: `bun test src/tests/codex-oauth-refresh-lock.test.ts src/tests/codex-oauth-storage.test.ts`
- [ ] `bun run tsc:check` && `bun run lint` && `bash scripts/check-db-boundary.sh`
- [ ] `bun run docs:openapi` if any response schema changed (status enum) — commit artifacts

#### Automated QA:
- [ ] Boot server + mock provider whose token endpoint returns 400: seed an expiring authorization, trigger `POST /api/oauth-authorizations/{id}/refresh` (route from step-4) → status flips `refresh-failed` with `lastErrorMessage`; fix the mock → next refresh flips back `active`
- [ ] Run an inline script (`script_run`) against a connection bound to a `refresh-failed` authorization → script fails with the typed OAuth error message, not a 401 from an unsubstituted placeholder
- [ ] Two authorizations under one app: force-fail one → the other keeps resolving (per-authorization isolation, provable via script calls)

#### Manual Verification:
- [ ] None

**Implementation Note**: This step is a vertical slice — QA-able on its own. Pause for manual confirmation; commit `[step-5] refresh re-key + refresh-failed semantics` after verification passes.
