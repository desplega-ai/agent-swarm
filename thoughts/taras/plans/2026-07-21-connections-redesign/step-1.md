---
id: step-1
name: Unified OAuth schema + migration 117 + store adapters
depends_on: []
status: done
assignee: fable-orchestrator-codex-sol-step1
claimed_at: 2026-07-22T00:00:00+0200
completed_at: 2026-07-22T19:30:00+0200
---

# step-1: Unified OAuth schema + migration 117 + store adapters

## Overview
Create the unified OAuth core: migration 117 rebuilds `oauth_apps` (drops UNIQUE provider, adds quirk/source columns), creates `oauth_authorizations` + `oauth_pending`, rebuilds `oauth_refresh_locks` with a generic `lockKey`, re-keys `script_credential_bindings` to `oauth_authorization_id`, carries every existing row over (009 tokens → one `default` authorization per app; 041 MCP tokens → `source:'dcr'` apps + authorizations; 041 pending → `oauth_pending` with `flow:'mcp'`), and **drops the legacy tables in the same migration**. An idempotent TS backfill encrypts plaintext secrets at boot. Storage accessors are rewritten as signature-preserving adapters so all three OAuth stacks (tracker, MCP-DCR, connections) keep passing their existing tests on the new tables — this step changes storage, not behavior.

## Changes Required:

#### 1. Migration 117
**File**: `src/be/migrations/117_unified_oauth.sql`
**Changes**: Per the Unified Schema Contract in `root.md`. Table-copy rebuilds (pattern: `112_script_connections_graphql.sql`). Carry-over rules:
- `oauth_apps`: preserve `id`/`provider`/`clientId`/`clientSecret`/`redirectUri`-era fields; lift `extraParams`/`tokenAuthStyle`/`tokenBodyFormat` out of `metadata` JSON into columns (leave Jira cloudId/webhookIds + Linear `actor` in `metadata`); set `scopeSeparator=','` for the `linear` row, `requiresRefreshTokenRotation=1` for the `jira` row; `clientSecretEncrypted=0`.
- `oauth_tokens` → `oauth_authorizations` (label `'default'`, `status='active'`, `tokensEncrypted=0`), then `DROP TABLE oauth_tokens`.
- `mcp_oauth_tokens` → one app per row (`source` from `clientSource` mapping `dcr|manual→dcr` app rows with `provider='mcp-'||mcpServerId`, `mcpServerId` set, AS-context URLs into columns/metadata, `clientSecretEncrypted=1`) + one authorization (`tokensEncrypted=1`, status per contract mapping), then `DROP TABLE mcp_oauth_tokens`.
- `mcp_oauth_pending` → `oauth_pending` (`flow='mcp'`; pending rows without a surviving app may be dropped — they expire in 10 min anyway), then `DROP TABLE mcp_oauth_pending`.
- `oauth_refresh_locks`: rebuild with `lockKey` PK, copy rows verbatim.
- `script_credential_bindings`: table-copy adding `oauth_authorization_id` backfilled via `oauth_provider` → `oauth_apps.provider` → its `default` authorization id; drop `oauth_provider`.

#### 2. TS encryption backfill
**File**: `src/be/oauth-encryption-backfill.ts` (new), wired into API boot after migrations (same place `swarm_config`'s scan runs, `src/be/db.ts:6931-6998` is the pattern)
**Changes**: One-shot, idempotent: encrypt `oauth_apps.clientSecret` where `clientSecretEncrypted=0`, and `oauth_authorizations.accessToken`/`refreshToken` where `tokensEncrypted=0`, via `encryptSecret`/`getEncryptionKey` (`src/be/crypto/`). Flip flags in the same transaction per row. Safe to re-run; no-op when nothing is flagged.

#### 3. Rewritten storage accessors (signature-preserving)
**File**: `src/be/db-queries/oauth.ts`
**Changes**: All existing exports (`getOAuthApp`, `getOAuthTokens`, `storeOAuthTokens`, `updateOAuthTokensAfterRefresh`, `deleteOAuthTokens`, `isTokenExpiringSoon`, `listOAuthTokenSweepRows`, `upsertOAuthApp`, lock functions) keep their provider-string signatures but resolve provider → app → `default` authorization internally; decrypt on read, encrypt on write (flags always 1 for new writes). `updateOAuthTokensAfterRefresh`: replace WHERE-refreshToken-equality with `tokenVersion` compare-and-increment (encrypted values are IV-fresh per write; string equality no longer works). Add new id-keyed primitives (`getOAuthAppById`, `listAuthorizationsForApp`, `getAuthorizationById`, `upsertAuthorization`, `updateAuthorizationTokens`) for later steps. Lock functions gain `lockKey` naming; provider-string callers pass through unchanged.

**File**: `src/be/db-queries/mcp-oauth.ts`
**Changes**: Same exports, now adapters over the unified tables: `getMcpOAuthToken(mcpServerId, userId)` → app by `mcpServerId` → its authorization (userId dimension preserved in signature, still null in practice); `upsertMcpOAuthToken` creates/updates app (`source:'dcr'`) + authorization; `insertMcpOAuthPending`/`consumeMcpOAuthPending`/`gcMcpOAuthPending` → `oauth_pending` with `flow='mcp'`; status values mapped per contract at the boundary so `src/http/mcp-oauth.ts` and the UI badges see the same strings as today.

#### 4. Credential-broker re-key
**Files**: `src/scripts-runtime/credential-broker/types.ts` (Zod: `oauthProvider` → `oauthAuthorizationId`), `src/scripts-runtime/credential-broker/broker.ts:35-38`, `src/be/script-credential-broker.ts:32-42`, `src/be/oauth-credential-bindings.ts` (`resolveOAuthBindingToken(authorizationId)`, `getOAuthBindingTokenStatus(authorizationId)`), `src/be/script-connections.ts` (binding row mapping + upsert validation), `src/http/script-connections.ts:544,786-788,844,1432-1435,1650`, `src/tools/credential-bindings/tool.ts:146` and its `upsert` schema
**Changes**: Mechanical re-key from provider string to `oauthAuthorizationId` end to end. HTTP/tool inputs accept `oauthAuthorizationId`; during this step the OAuth-app-upsert/authorize surfaces still operate per-provider (step-4 adds multi-authorization flows). Keep the legacy JSON-blob store reading as-is (retired in step-7); blob entries carrying `oauthProvider` resolve through a compatibility shim (provider → default authorization) inside `SwarmConfigCredentialBindingStore` normalization.

#### 5. Refresh-path plumbing kept equivalent
**Files**: `src/oauth/ensure-token.ts`, `src/oauth/wrapper.ts`, `src/oauth/ensure-mcp-token.ts`, `src/oauth/keepalive.ts`, `src/be/oauth-refresh-sweep.ts`
**Changes**: Only what compilation/storage requires: config construction reads quirk columns instead of `metadata` (`oauthAppRowToProviderConfig`, `src/oauth/ensure-token.ts:32-57`) — delete the hardcoded `provider === "jira"` rotation branch (now a column; `src/jira/oauth.ts:32` keeps working by reading the same column). In-memory PKCE map, sweep cadence, dual-layer locks, keepalive list all stay behaviorally identical (re-keying is step-5).

#### 6. Migration + backfill tests
**File**: `src/tests/unified-oauth-migration.test.ts` (new)
**Changes**: Build a pre-117 fixture DB (apply migrations through 116, insert: 2 tracker apps+tokens incl. jira/linear metadata, 1 script-connection provider app, 2 mcp_oauth_tokens (dcr + manual) + 1 pending, 3 bindings incl. one `authKind:'oauth'`, legacy blob entry). Assert post-117: row counts, id preservation, quirk-column lift, binding re-key, drops. Assert backfill: flags flip, values decrypt to originals, second run no-ops.

### Success Criteria:

#### Automated Verification:
- [ ] Migration + backfill tests pass: `bun test src/tests/unified-oauth-migration.test.ts`
- [ ] All prior OAuth suites green unchanged in intent: `bun test src/tests/oauth-credential-bindings.test.ts src/tests/oauth-refresh-sweep.test.ts src/tests/oauth-wrapper.test.ts src/tests/oauth-keepalive.test.ts src/tests/oauth-access-token-tool.test.ts src/tests/credential-broker.test.ts`
- [ ] Script-connections + MCP suites green: `bun test src/tests/script-connections.test.ts src/tests/script-connections-http.test.ts src/tests/script-connections-mcp.test.ts` (incl. the query-only-binding regression at `script-connections-http.test.ts:172-200` — Phase-0 verify-only guarantee)
- [ ] Codex lock suites untouched and green: `bun test src/tests/codex-oauth-refresh-lock.test.ts`
- [ ] `bun run tsc:check` && `bun run lint` && `bash scripts/check-db-boundary.sh` && `bun run check:rbac-coverage`
- [ ] `bun run docs:openapi` produces no route diff (this step adds no routes)

#### Automated QA:
- [ ] Fresh-DB boot: `rm -f agent-swarm-db.sqlite* && bun run start:http` starts clean; `sqlite3` shows new tables, no `oauth_tokens`/`mcp_oauth_*`
- [ ] Populated-DB boot: run the fixture-builder script from the migration test against a file DB, boot the server, verify carried rows + encrypted flags via sqlite3; boot a second time and verify backfill no-ops (log line)
- [ ] CLI walkthrough: `get-oauth-access-token` MCP tool still returns a token for a seeded provider app (proves adapter equivalence end-to-end)

#### Manual Verification:
- [ ] None — behavior-preserving step; real-provider dances happen in steps 4/8/11

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. Commit-per-step is enabled: commit `[step-1] unified OAuth schema + migration 117 + store adapters` after verification passes.
