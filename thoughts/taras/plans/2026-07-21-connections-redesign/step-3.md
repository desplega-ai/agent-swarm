---
id: step-3
name: Spec server extraction + baseUrl provenance
depends_on: []
status: ready
---

# step-3: Spec server extraction + baseUrl provenance

## Overview
Make the backend read the spec's own server declaration: extract OpenAPI 3 `servers[]` and Swagger 2 `host`+`basePath`+`schemes` at upsert and refresh, store `baseUrl` provenance (`spec`-derived vs `user`-set, migration 118), prefill from spec when the user omits baseUrl, let an explicit user value win with a visible mismatch warning, and have `refresh` auto-update only spec-derived values. Today zero code touches `spec.servers` (`extractOperations`, `src/be/script-connections.ts:487-598` reads only `spec.paths`); the only extraction lives client-side in the apis.guru flow (`apps/ui/src/pages/connections/page.tsx:414-448`).

## Changes Required:

#### 1. Migration 118
**File**: `src/be/migrations/118_base_url_provenance.sql` (new)
**Changes**: `ALTER TABLE script_connections ADD COLUMN base_url_source TEXT NOT NULL DEFAULT 'user' CHECK(base_url_source IN ('user','spec'))` (plain ADD COLUMN — no CHECK rewrite of existing columns needed). Existing rows keep `'user'` (accurate: all current baseUrls were user-typed).

#### 2. Spec server extraction
**File**: `src/be/script-connections.ts`
**Changes**: New `extractSpecBaseUrl(spec, specSourceUrl?)`: OAS3 → `servers[0].url` (resolve relative server URLs against the spec's own URL when `openapi_spec_source_kind='url'`; skip templated URLs containing `{...}` unless all variables have defaults — substitute defaults); Swagger 2 → `scheme://host/basePath` preferring `https` from `schemes`. In `upsertScriptConnection`: no caller baseUrl + spec declares one → use it, `base_url_source='spec'`; caller baseUrl given → keep it, `'user'`, and when spec disagrees include `baseUrlMismatch: {specUrl, effectiveUrl}` in the result. In `refreshScriptConnection`: re-extract; update stored baseUrl only when `base_url_source='spec'`; never clobber `'user'` rows (surface the mismatch instead). When baseUrl was spec-derived, default `allowedHosts` from its hostname if the caller supplied none (same fallback rule as `src/tools/script-connections/tool.ts:380`).

#### 3. Surface provenance + mismatch
**Files**: `src/http/script-connections.ts` (upsert/refresh/list/get responses include `baseUrlSource` + optional `baseUrlMismatch`), `src/tools/script-connections/tool.ts` (same fields in tool output text; `upsert-openapi` no longer requires `baseUrl` when the spec declares one)
**Changes**: Additive response fields; `bun run docs:openapi` regen.

#### 4. Tests
**File**: `src/tests/spec-base-url.test.ts` (new)
**Changes**: Cover: OAS3 absolute `servers[0]`; OAS3 relative server resolved against spec URL; templated server with defaults; Swagger 2 host+basePath+schemes (https preferred); no-servers spec (baseUrl stays required); user-override wins + mismatch reported; refresh updates spec-derived, preserves user-set; migration 118 default on existing rows. Keep `operationUrl` base-path-prefix tests green (`src/scripts-runtime/api-client.ts:54-72` — runtime joining is already correct, do not touch).

### Success Criteria:

#### Automated Verification:
- [ ] New tests pass: `bun test src/tests/spec-base-url.test.ts`
- [ ] Existing suites green: `bun test src/tests/script-connections.test.ts src/tests/script-connections-http.test.ts src/tests/script-apis-mcp.test.ts`
- [ ] `bun run tsc:check` && `bun run lint` && `bun run docs:openapi` (commit regenerated artifacts)

#### Automated QA:
- [ ] Boot server; upsert an OpenAPI connection via curl with a spec that declares `servers[0]` and **no** baseUrl in the request → stored `base_url` = spec value, `baseUrlSource='spec'`; call `refresh` after changing the served spec's server URL → stored baseUrl follows
- [ ] Repeat with an explicit user baseUrl differing from the spec → response carries `baseUrlMismatch`, refresh does not clobber
- [ ] Run a script that calls `ctx.api.<slug>` against a local mock spec server to prove the derived baseUrl is actually used end-to-end

#### Manual Verification:
- [ ] None

**Implementation Note**: This step is a vertical slice — QA-able on its own. Pause for manual confirmation; commit `[step-3] spec server extraction + baseUrl provenance` after verification passes.
