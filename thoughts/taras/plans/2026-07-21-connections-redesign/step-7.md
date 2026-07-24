---
id: step-7
name: Embedded connection auth + derived bindings
depends_on: [step-1]
status: done
assignee: fable-orchestrator-opus-step7
completed_at: 2026-07-23T02:30:00+0200
claimed_at: 2026-07-23T00:30:00+0200
---

# step-7: Embedded connection auth + derived bindings

## Overview
Collapse the connection↔binding↔credential triad: connection upsert accepts auth inline — `{type: bearer|header|query, secret | configKey, headerName?/paramName?}` or `{type: oauth, authorizationId}` — persisting inline secrets to `swarm_config` under the derived key `connection.<slug>.secret` (write-only, encrypted, scrubber-covered) and auto-managing the binding row internally (hosts derived from baseUrl, template from auth type, with escape-hatch overrides). The standalone binding surface survives only for spec-less raw `fetch()` egress; the legacy `SCRIPT_CREDENTIAL_BINDINGS` JSON-blob store is retired. The egress substitution + host-allowlist guard keeps its behavior exactly (scripts never see raw secrets).

## Changes Required:

#### 1. Migration 120 + schema
**File**: `src/be/migrations/120_connection_embedded_auth.sql` (new)
**Changes**: `script_connections` ADD COLUMNs: `auth_type` CHECK `('none','bearer','header','query','oauth')` DEFAULT 'none', `auth_config_key`, `auth_authorization_id` (FK oauth_authorizations ON DELETE SET NULL), `auth_param_name` (header name for `header`, query param for `query`), `auth_template_override`, `auth_hosts_override_json`. `script_credential_bindings` ADD COLUMN `managed_by_connection_id` (FK script_connections ON DELETE CASCADE, nullable) — managed bindings are hidden from the standalone surface. Data backfill: connections with a `credential_binding_id` get `auth_type` inferred from the binding (header template with `Authorization: Bearer` → `bearer`; other header → `header` + name; query → `query`) and the binding marked managed.

#### 2. Upsert embeds auth + derivation
**Files**: `src/be/script-connections.ts` (`upsertScriptConnection`), `src/http/script-connections.ts` (upsert body gains `auth`; `maybeCreateInlineBinding` `:761-801` replaced by the derivation path, gaining the OAuth branch it never had), `src/tools/script-connections/tool.ts` (`upsert-openapi`/`upsert-graphql` gain `auth`; old flat `configKey`/template args kept as deprecated aliases mapping onto `auth`)
**Changes**: Derivation: hosts = `[new URL(baseUrl).hostname]` unless override; template by type — `bearer` → `Authorization: Bearer [REDACTED:<KEY>]`, `header` → `<headerName>: [REDACTED:<KEY>]`, `query` → `<paramName>=[REDACTED:<KEY>]` (query-only derivation must NOT default a header — the Phase-0 regression test `src/tests/script-connections-http.test.ts:172-200` guards this and must stay green); `oauth` → bearer template resolved via `authorizationId` (validated to exist). Placeholder key: inline `secret` → write `swarm_config` key `connection.<slug>.secret` (`isSecret:true`, encrypted, `refreshSecretScrubberCache()` after write) and use it; explicit `configKey` → use as-is (shared/rotated secrets). Managed binding row upserted with `managed_by_connection_id`, `source='connection'`; re-derived on every connection upsert/refresh (slug/baseUrl/auth changes propagate); deleted with the connection. `kind:'mcp'` connections reject `auth` (they resolve via `mcp_servers`) — closes the accepts-but-ignores gap.

#### 3. Standalone surface reduced to raw-fetch
**Files**: `src/http/script-connections.ts` (binding list excludes managed rows by default; `?includeManaged=true` for debugging), `src/tools/credential-bindings/tool.ts` (list likewise; description text repositions bindings as "advanced: raw fetch() egress"), `src/be/script-credential-broker.ts` + `src/scripts-runtime/credential-broker/store.ts` (delete `SwarmConfigCredentialBindingStore` fallback + `CREDENTIAL_BINDINGS_CONFIG_KEY`), `src/be/script-connections.ts` (`importLegacyCredentialBindings` deleted), `src/tools/credential-bindings/tool.ts` (`import-legacy` action removed), `src/tools/swarm-config/set-config.ts:99` (reserved-key guard removed)
**Changes**: One-shot TS boot migration (same file as step-1's encryption backfill or a sibling): any remaining `SCRIPT_CREDENTIAL_BINDINGS` blob entries → relational rows, then delete the config key. Broker resolution order becomes relational-only.

#### 4. Connection responses carry auth summary
**Files**: `src/http/script-connections.ts`, `src/tools/script-connections/tool.ts`
**Changes**: list/get include `auth: {type, configKey?, authorizationId?, status}` (status from step-1's `getOAuthBindingTokenStatus` — never secret material). `bun run docs:openapi` regen.

#### 5. Tests
**File**: `src/tests/connection-embedded-auth.test.ts` (new) + extend `src/tests/script-connections.test.ts`
**Changes**: One-call upsert per auth type → managed binding derived correctly (hosts/template/key); inline secret lands encrypted in swarm_config under derived key and scrubber redacts it in logs; configKey path; oauth path validates authorizationId; re-upsert with changed slug/baseUrl re-derives; connection delete cascades managed binding; managed bindings hidden from standalone list; blob-store migration one-shot + idempotent; sandbox e2e: script calls `ctx.api.<slug>` and egress substitution works unchanged; mcp-kind rejects auth.

### Success Criteria:

#### Automated Verification:
- [ ] `bun test src/tests/connection-embedded-auth.test.ts src/tests/script-connections.test.ts src/tests/script-connections-http.test.ts src/tests/credential-broker.test.ts src/tests/swarm-config-reserved-keys.test.ts`
- [ ] Phase-0 regression stays green (query-only auth → no header default): `bun test src/tests/script-connections-http.test.ts`
- [ ] `bun run tsc:check` && `bun run lint` && `bash scripts/check-db-boundary.sh` && `bun run docs:openapi` (commit artifacts)

#### Automated QA:
- [ ] Boot server; single curl creates an openapi connection with `auth:{type:'bearer', secret:'test-tok-123'}` → swarm_config has encrypted `connection.<slug>.secret`; run an inline script hitting the connection against a local mock API → mock receives `Authorization: Bearer test-tok-123`, while `script_run` output/logs show only `[REDACTED:...]`
- [ ] Same flow with `auth:{type:'query', paramName:'api_key', ...}` → mock receives the query param, **no** Authorization header
- [ ] Standalone binding created for a raw-fetch host still substitutes in a plain `fetch()` script (the surviving advanced path)

#### Manual Verification:
- [ ] None

**Implementation Note**: This step is a vertical slice — QA-able on its own. Pause for manual confirmation; commit `[step-7] embedded connection auth + derived bindings` after verification passes.
