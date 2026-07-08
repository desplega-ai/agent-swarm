---
date: 2026-07-08T10:00:00Z
topic: "Script Connections MVP — OpenAPI-by-URL, OAuth bindings, ctx.mcp, GraphQL"
status: completed — QA passed (see thoughts/shared/qa/2026-07-08-script-connections-mvp-qa.md)
author: Claude (orchestrator) + Taras
tags: [plan, scripts-runtime, credential-broker, script-connections, oauth, mcp, graphql]
---

# Script Connections MVP — OpenAPI-by-URL, OAuth bindings, ctx.mcp, GraphQL

> **Branch / worktree:** `feat/script-connections-mvp` at `/Users/taras/Documents/code/agent-swarm-cdx-connections`
> **Executor:** Codex (`codex-implement`), sequential phases
> **Predecessor context:** PRs #830 (credential broker), #838 (typed API connection registry), research doc `2026-06-26-executor-sh-ideas-worth-building.md` (agent-fs)

## Goal

Complete the executor.sh-inspired "register external APIs, work with them from swarm scripts" story. Four increments on top of the existing `script_connections` + `script_credential_bindings` system:

1. **OpenAPI connections registered by spec URL** (with etag-aware refresh) — today only inline JSON works.
2. **OAuth-backed credential bindings** — a binding can resolve its secret from `oauth_tokens` (auto-refreshed) instead of a static swarm_config key; plus generic OAuth app registration + callback so new providers need zero code.
3. **`ctx.mcp.<slug>.<tool>()`** — scripts call tools on externally-installed MCP servers (`mcp_servers` table) through a server-side proxy; MCP credentials never enter the script subprocess.
4. **GraphQL connections** — `ctx.api.<slug>.graphql(query, variables)` with host allowlisting + credential binding.

## Architecture constraints (bind Codex to these)

- **DB boundary**: nothing under `src/scripts-runtime/`, `src/providers/`, `src/commands/` may import `src/be/db` or `bun:sqlite` (`scripts/check-db-boundary.sh`). All DB work lives in `src/be/`; the script subprocess receives only resolved data on `SwarmConfigPayload` via stdin.
- **API key**: only via `getApiKey()` from `src/utils/api-key.ts` (`scripts/check-api-key-boundary.sh`).
- **Routes**: only via `route()` from `src/http/route-def.ts`. Every non-GET route needs `rbac: { permission }` or `rbac: { ungated: "<reason>" }`; new verbs register in BOTH `src/rbac/permissions.ts` and `src/rbac/legacy-policy.ts`. New route FILE → import in `src/http/all-routes.ts` + `bun run docs:openapi`.
- **New MCP tools**: register in `SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts`) or add to `EXCLUDED_TOOLS` (`scripts/check-sdk-tool-registration.ts`) with a reason. The existing `credential-bindings` / `script-connections` tools are excluded (lead-only management) — follow that pattern for new lead-only actions.
- **Migrations**: forward-only SQL, next free number is **109**. Never edit an applied migration. Test against fresh AND existing DB.
- **Secrets**: any value that could be a token goes through `registerVolatileSecret` (scrubber) when resolved, exactly like `src/be/script-credential-broker.ts:21-38` does today. Never log raw tokens.
- **Style**: Bun APIs (`Bun.serve`, `bun:sqlite`, `Bun.file`), Biome formatting, match surrounding code.

## Key existing wiring (read these before each phase)

- Run path: `POST /api/scripts/run` → `src/http/scripts.ts:508-516` → `runScript({ egressSecrets: buildScriptCredentialBindings(...), apiConnections: getScriptApiConnectionDescriptors(...) })`.
- Resolution: `src/be/script-credential-broker.ts` — `buildScriptCredentialBindings()` builds the config map from `getResolvedConfig()`, wires `CredentialBroker` with `RelationalCredentialBindingStore`, registers volatile secrets. **This is the only place secret values are attached.** The workflow executor path `src/workflows/executors/swarm-script.ts:76` also calls it.
- Subprocess: `src/scripts-runtime/loader.ts:52-53` puts `egressSecrets` + `apiConnections` on `SwarmConfigPayload` (`src/scripts-runtime/executors/types.ts:8-16`); `src/scripts-runtime/eval-harness.ts:87-95` installs the fetch patch and builds `ctx` (`src/scripts-runtime/ctx.ts`).
- Connections DB layer: `src/be/script-connections.ts` (tables from `src/be/migrations/101_script_connections.sql`). OpenAPI parsing/codegen: `extractOperations` + `buildGeneratedArtifacts` (same file, ~line 450-590). Descriptors: `getScriptApiConnectionDescriptors` (~line 719).
- Tools: `src/tools/script-connections/tool.ts` (actions: list / upsert-openapi / disable; verb `script-connection.manage`), `src/tools/credential-bindings/tool.ts` (list / upsert / disable / import-legacy; verb `credential-binding.manage`).
- Types → scripts: `src/be/scripts/typecheck.ts:287` `scriptSdkTypesWithGeneratedApis(getScriptApiTypes(context))`; agent-discoverable via `script-query-types` tool.
- Generic OAuth: `src/oauth/wrapper.ts` (`buildAuthorizationUrl`, `exchangeCode`, `refreshAccessToken`, `OAuthProviderConfig`), `src/oauth/ensure-token.ts`, DB queries in `src/be/db-queries/oauth.ts` (`getOAuthApp`, `upsertOAuthApp`, `getOAuthTokens`, `storeOAuthTokens`, `updateOAuthTokensAfterRefresh`, `isTokenExpiringSoon`, `acquireOAuthRefreshLock`/`releaseOAuthRefreshLock`). Linear is the reference consumer (`src/linear/oauth.ts`). There is NO generic authorize/callback HTTP route today (only MCP-specific `src/http/mcp-oauth.ts`).
- Server-side MCP client: **does not exist**. Only the worker-side `McpHttpClient` in `src/providers/pi-mono-mcp-client.ts` (Streamable HTTP, initialize handshake, SSE parsing, customHeaders). `mcp_servers` rows carry `url`, `headers`, `envConfigKeys`/`headerConfigKeys` (swarm_config key refs), and OAuth via `src/oauth/ensure-mcp-token.ts` (encrypted `mcp_oauth_tokens`).

---

## Phase 1 — OpenAPI connections by spec URL + refresh

The `script_connections` schema already has `openapi_spec_source_kind ('url'|'inline'|'agent_fs')`, `openapi_spec_source`, `openapi_spec_etag`, `openapi_spec_fetched_at` — all dormant. Wire them.

### Changes

- [x] `src/be/script-connections.ts`: add `fetchOpenapiSpec(url, { etag? })` helper (server-side `fetch`, `Accept: application/json`, 15s timeout via AbortController, capture `ETag` response header, handle 304). Reject non-http(s) URLs and private/loopback hosts unless `NODE_ENV !== "production"` — mirror the SSRF posture of `assertUrlSafe` in `src/oauth/mcp-wrapper.ts` (reuse it if importable without cycles). Parse JSON; if the body is YAML, try `Bun.YAML.parse` when available, otherwise fail with a clear "JSON specs only" error.
- [x] `upsertScriptConnection`: accept `openapiSpecUrl` — when present (and no inline `openapiSpecJson`), fetch the spec, then store `openapi_spec_source_kind='url'`, `openapi_spec_source=<url>`, `openapi_spec_json`, `openapi_spec_etag`, `openapi_spec_fetched_at`, and run the existing `buildGeneratedArtifacts` codegen. Generation errors go to `generation_error` as today (do not throw away the row).
- [x] New exported `refreshScriptConnection(id, userId)`: for `kind='openapi'` + `source_kind='url'` rows, re-fetch with `If-None-Match: <etag>`; on 304 only bump `openapi_spec_fetched_at`; on 200 re-store spec + regenerate artifacts (version bumps via the existing UPDATE path).
- [x] `src/tools/script-connections/tool.ts`: add `openapiSpecUrl` input field to `upsert-openapi`, and a new `refresh` action (`id` required). Both stay behind the existing `script-connection.manage` verb — no new RBAC entries.
- [x] Tests in `src/tests/script-connections.test.ts` (extend): upsert-by-URL happy path (mock fetch or serve a spec from a local `Bun.serve` fixture), etag 304 no-op refresh, changed-spec refresh regenerates types, invalid spec records `generation_error`, YAML/invalid content rejection.

### Verification

```bash
cd /Users/taras/Documents/code/agent-swarm-cdx-connections
bun run tsc:check
bun test src/tests/script-connections.test.ts
bun run lint
```

---

## Phase 2 — OAuth-backed credential bindings + generic OAuth registration

A credential binding gains `authKind: 'config' | 'oauth'`. For `oauth` bindings, `buildScriptCredentialBindings` resolves the value from `oauth_tokens` (refreshing when expiring) instead of swarm_config. Registration of OAuth apps + the authorize/callback loop becomes generic.

### Design decisions (fixed — do not re-litigate)

- The binding keeps its `configKey` as the **placeholder key** (e.g. `LINEAR_OAUTH` → scripts send `Authorization: Bearer [REDACTED:LINEAR_OAUTH]`). `authKind='oauth'` + `oauthProvider` only change WHERE the value comes from.
- **No changes to the scripts-runtime broker.** `src/be/script-credential-broker.ts` pre-populates the config map: for each active oauth binding, look up a fresh access token and set `configMap[binding.configKey] = accessToken` before calling `broker.resolveBindings`. The broker/fetch-patch remain oauth-agnostic. Keeps the DB boundary clean.
- Token freshness: script runs are hard-capped at 60s, so a token fresh at spawn is sufficient. Use the existing ensure/refresh helpers (`src/oauth/ensure-token.ts`, `isTokenExpiringSoon`, refresh locks) — do not hand-roll refresh.
- `oauth_tokens` stays plaintext-at-rest in this MVP (parity with Linear). Leave a `TODO(secrets-cipher)` comment referencing `src/be/crypto/secrets-cipher.ts` where tokens are stored — encryption is an explicit follow-up.
- If an oauth binding has no stored token (user never authorized), the binding resolves to nothing and is **skipped** (same as an unset config key today) — scripts get a clean "placeholder not substituted" failure, and the `credential-bindings list` output should surface `tokenStatus: 'ok' | 'expiring' | 'missing'` per oauth binding.

### Changes

- [x] Migration `src/be/migrations/109_oauth_credential_bindings.sql`: `ALTER TABLE script_credential_bindings ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'config' CHECK(auth_kind IN ('config','oauth'));` and `ADD COLUMN oauth_provider TEXT;` (SQLite allows ADD COLUMN with CHECK). Keep the unique identity index untouched.
- [x] `src/scripts-runtime/credential-broker/types.ts`: extend `CredentialBindingSchema` with `authKind` (default `'config'`) + `oauthProvider` (optional; zod refine: required when `authKind==='oauth'`). Type-only — no behavior change in the broker.
- [x] `src/be/script-connections.ts`: persist/read the two new columns in `upsertCredentialBinding` / `bindingFromRow` / `listRelationalCredentialBindings`.
- [x] `src/be/script-credential-broker.ts`: before `resolveBindings`, for each active `authKind='oauth'` binding call a new `resolveOAuthBindingToken(provider)` (in `src/be/` — wraps `getOAuthApp` + `getOAuthTokens` + expiry check + locked refresh via existing helpers) and inject into the config map + `registerVolatileSecret`.
- [x] `src/tools/credential-bindings/tool.ts`: `upsert` accepts `authKind` + `oauthProvider`; `list` decorates oauth bindings with `tokenStatus`. Add two new lead-only actions behind the existing `credential-binding.manage` verb:
  - `oauth-app-upsert` — `{provider, clientId, clientSecret, authorizeUrl, tokenUrl, scopes[], extraParams?}` → `upsertOAuthApp`. `redirectUri` is computed server-side as `<public base url>/api/oauth/<provider>/callback` (see route below); reuse the same base-url helper `src/http/mcp-oauth.ts` uses (`getPublicMcpBaseUrl`/`getAppUrl` in `src/utils/constants.ts`).
  - `oauth-authorize-url` — `{provider}` → returns the `buildAuthorizationUrl(...)` URL for the human to open.
- [x] New route file `src/http/oauth-generic.ts`: `GET /api/oauth/:provider/callback` — loads the `oauth_apps` row, calls `exchangeCode(config, code, state)`, `storeOAuthTokens`, responds with a tiny "authorized, you can close this tab" HTML page. GET → no rbac field needed. **Skip providers that already have dedicated callbacks (`linear`)**: reject with 409 pointing at the existing flow, to avoid two live callback URLs for one provider. Import the file in `src/http/all-routes.ts`; run `bun run docs:openapi` and commit `openapi.json` + regenerated api-reference docs.
- [x] Tests: new `src/tests/oauth-credential-bindings.test.ts` — migration columns round-trip; oauth binding resolves via injected token; expiring token triggers refresh path (mock `fetch` for the token endpoint); missing token → binding skipped + `tokenStatus: 'missing'`; generic callback exchanges code and stores tokens; linear rejected on generic callback.

### Verification

```bash
cd /Users/taras/Documents/code/agent-swarm-cdx-connections
bun run tsc:check
bun test src/tests/oauth-credential-bindings.test.ts src/tests/script-connections.test.ts src/tests/credential-broker.test.ts src/tests/db-queries-oauth.test.ts src/tests/ensure-token.test.ts
bun run lint
bun run docs:openapi && git diff --stat openapi.json   # regenerated output must be committed
```

---

## Phase 3 — `ctx.mcp`: script access to installed MCP servers via server-side proxy

Greenfield on the server side: the API server currently never connects to external MCP servers. Build a minimal server-side MCP HTTP client, a proxy route, connection registration (`kind='mcp'`, the `mcp_server_id` column already exists), and the script-side `ctx.mcp` registry. **Secrets (headers, OAuth tokens) are resolved and attached server-side only** — strictly stronger isolation than the fetch-patch path.

### Design decisions (fixed)

- **Client**: extract the transport out of `src/providers/pi-mono-mcp-client.ts` into a shared `src/mcp-client/http-client.ts` (initialize handshake, session id, SSE/JSON response parsing, `listTools`, `callTool`, customHeaders). `src/providers/pi-mono-mcp-client.ts` re-exports/wraps it so worker code is untouched. If `bun run check:dep-graph` objects to the new location, prefer `src/utils/mcp-http-client.ts`. Do NOT import `src/be/db` from the client itself.
- **Server-side auth resolution** in a new `src/be/mcp-proxy.ts`: given an `mcp_servers` row → merge `headers` + resolve `headerConfigKeys` from swarm_config (same pattern as `src/http/mcp-servers.ts:183-233` / the create/update tools) + attach OAuth `Authorization` via `ensureMcpToken` (`src/oauth/ensure-mcp-token.ts`) when the server row uses OAuth.
- **Proxy route** `POST /api/script-connections/:id/mcp-call` (new file `src/http/script-connection-proxy.ts`), body `{tool: string, arguments?: object}`. Auth: standard bearer + `X-Agent-ID`. `rbac: { permission: "script-connection.invoke" }` — **new verb**, registered in `src/rbac/permissions.ts` (namespace `script-connection`) and mapped in `src/rbac/legacy-policy.ts` as allowed for ALL authenticated agents (workers included — mirror whichever policy `script.run`-class verbs use; it is NOT leadOnly). Route checks the connection exists, is `enabled`, `kind='mcp'`, and scope-matches the caller (global, or agent-scoped to this agent) before dialing out. 30s timeout on the outbound call; response passed back verbatim as JSON (`{ok, result | error}`).
- **Registration**: `script-connections` tool gains `upsert-mcp` action — `{slug, mcpServerId, displayName?, scope?, scopeId?}`. On upsert the server dials the MCP server, `listTools`, and stores: `generated_runtime_json` = `{slug, kind:'mcp', connectionId, tools:[{name, description, inputSchema}]}`, `generated_types` = a `ctx.mcp` interface (`<Pascal(slug)>Mcp { <toolNameCamel>(args: <from inputSchema, fall back to Record<string, JsonValue>>): Promise<JsonValue> }`). Tool-list fetch failure → `generation_error` on the row, not a thrown error.
- **Runtime**: `SwarmConfigPayload` gains `mcpConnections?: ScriptMcpConnectionDescriptor[]` (descriptor = slug + connectionId + tool list; NO urls, NO headers, NO secrets). `src/http/scripts.ts` (and the workflow swarm-script executor) populate it via a new `getScriptMcpConnectionDescriptors({agentId})`. `buildCtx` gains `mcp` built by a new `src/scripts-runtime/mcp-client.ts` registry: each tool method POSTs to `${mcpBaseUrl}/api/script-connections/<connectionId>/mcp-call` with the bearer — reuse the exact request/auth pattern of the generic bridge in `src/scripts-runtime/swarm-sdk.ts:332+` (`Redacted.value(config.mcpBaseUrl)` etc.). Camel-case tool names for method names; keep the raw name in the wire payload.
- **Types surface**: `scriptSdkTypesWithGeneratedApis` in `src/be/scripts/typecheck.ts` must include mcp connections' `generated_types` and declare `ctx.mcp` alongside `ctx.api` so `script-upsert` typecheck and `script-query-types` both see it. Update `scripts/bundle-script-types.ts` output accordingly (regenerate the checked-in `.d.ts` if it is checked in).

### Changes

- [x] `src/mcp-client/http-client.ts` extraction + provider re-wrap (no worker behavior change).
- [x] `src/be/mcp-proxy.ts` — auth resolution + `callMcpServerTool(serverId, tool, args)` + `listMcpServerTools(serverId)`.
- [x] `src/http/script-connection-proxy.ts` route (+ `all-routes.ts` import, + rbac verb in `permissions.ts` / `legacy-policy.ts`, + `bun run docs:openapi`).
- [x] `src/be/script-connections.ts` — `upsert-mcp` support: mcp descriptor/type generation + `getScriptMcpConnectionDescriptors`.
- [x] `src/tools/script-connections/tool.ts` — `upsert-mcp` action.
- [x] `src/scripts-runtime/`: `executors/types.ts` payload field, `mcp-client.ts` registry, `ctx.ts` wiring (`ctx.mcp`), `api-types.ts` descriptor type.
- [x] `src/be/scripts/typecheck.ts` + `scripts/bundle-script-types.ts` — ctx.mcp in the SDK surface.
- [x] `src/http/scripts.ts` + `src/workflows/executors/swarm-script.ts` — pass `mcpConnections`.
- [x] Tests: new `src/tests/script-connections-mcp.test.ts` — spin an in-process MCP server via `Bun.serve` (or reuse how `scripts-mcp-e2e.test.ts` boots one) as the "external" server; register it in `mcp_servers` with a `headerConfigKeys` secret; `upsert-mcp` generates the tool list + types; proxy route calls a tool end-to-end and the secret header arrives at the fake server; rbac (worker allowed, unauthenticated 401); disabled/enabled + scope checks; runtime registry unit test (mock fetch) for `ctx.mcp.<slug>.<tool>()` request shape.

### Verification

```bash
cd /Users/taras/Documents/code/agent-swarm-cdx-connections
bun run tsc:check
bun test src/tests/script-connections-mcp.test.ts src/tests/scripts-mcp-e2e.test.ts src/tests/scripts-runtime.test.ts src/tests/scripts-typecheck.test.ts
bun run lint
bash scripts/check-db-boundary.sh
bun run check:dep-graph
bun run check:rbac-coverage
bun run docs:openapi && git status --short openapi.json
```

---

## Phase 4 — GraphQL connections (`ctx.api.<slug>.graphql(query, variables)`)

Thin, untyped-result GraphQL support: a connection kind that pairs an endpoint + credential binding with a single generated `graphql()` method. No introspection codegen in this MVP.

### Changes

- [x] Migration `src/be/migrations/110_script_connections_graphql.sql`: SQLite cannot alter a CHECK constraint — rebuild `script_connections` (create `script_connections_new` with `kind IN ('raw','openapi','mcp','graphql')`, copy all rows, drop old, rename, recreate indexes). Keep column order/defaults identical to 101 (+ nothing else changed). This MUST be verified against an existing DB, not just a fresh one.
- [x] `src/be/script-connections.ts`: `kind: 'graphql'` in `ScriptConnectionKind`; upsert path for graphql requires `baseUrl` (the endpoint) + `allowedHosts`; generates `generated_runtime_json` `{slug, kind:'graphql', baseUrl, credential}` and `generated_types` `interface <Pascal(slug)>Api { graphql<T = JsonValue>(query: string, variables?: Record<string, JsonValue>): Promise<T> }`. Include graphql connections in `getScriptApiConnectionDescriptors`.
- [x] `src/scripts-runtime/api-types.ts` + `api-client.ts`: descriptor union gains the graphql shape; `createApiRegistryClient` builds `{ graphql(query, variables) }` for it — POST `{query, variables}` with `content-type: application/json`, apply the credential `headerTemplate`/`queryTemplate` placeholders exactly like the openapi path, throw on non-2xx and on an `errors`-only GraphQL response body.
- [x] `src/tools/script-connections/tool.ts`: `upsert-graphql` action (`slug`, `baseUrl`, `allowedHosts`, `credentialBindingId?`, scope fields). Existing verb, no new RBAC.
- [x] Tests: extend `src/tests/script-connections.test.ts` (upsert-graphql, descriptor + types generation, migration rebuild keeps existing rows) and `src/tests/scripts-runtime.test.ts` or a new file for the client (mock fetch: correct POST body, placeholder header applied, GraphQL `errors` surfaced as thrown error).

### Verification

```bash
cd /Users/taras/Documents/code/agent-swarm-cdx-connections
bun run tsc:check
bun test src/tests/script-connections.test.ts src/tests/scripts-runtime.test.ts src/tests/credential-broker.test.ts
bun run lint
```

---

## Phase 5 — Docs, drift checks, full CI mirror

- [x] Update `MCP.md` tool reference for the changed/added tool actions (`script-connections`: upsert-openapi URL mode, refresh, upsert-mcp, upsert-graphql; `credential-bindings`: authKind/oauth actions).
- [x] Regenerate + commit any drift artifacts: `openapi.json` + `docs-site/content/docs/api-reference/**` (`bun run docs:openapi`), regenerated `src/scripts-runtime/types/*.d.ts` if `bundle-script-types` output is checked in.
- [x] Full CI mirror (from `runbooks/ci.md`):

```bash
cd /Users/taras/Documents/code/agent-swarm-cdx-connections
bun install --frozen-lockfile
bun run lint
bun run tsc:check
bun test
bash scripts/check-db-boundary.sh
bash scripts/check-api-key-boundary.sh
bun run check:dep-graph
bun run check:rbac-coverage
bun run scripts/check-sdk-tool-registration.ts
```

All green before hand-off.

---

## Manual E2E (run after Phase 5, against a real local backend)

From the worktree, scratch DB:

```bash
cd /Users/taras/Documents/code/agent-swarm-cdx-connections
rm -f agent-swarm-db.sqlite
bun run start:http   # port 3013, AGENT_SWARM_API_KEY defaults to 123123
```

1. **Join as lead agent** (fresh DB → first agent):
```bash
curl -s -X POST http://localhost:3013/mcp -H 'Authorization: Bearer 123123' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"join-swarm","arguments":{"name":"e2e-lead"}}}'
# capture <AGENT_ID>; all subsequent MCP calls add -H 'X-Agent-ID: <AGENT_ID>'
```
2. **Phase 1 — OpenAPI by URL**: `script-connections` `upsert-openapi` with `openapiSpecUrl: "https://petstore3.swagger.io/api/v3/openapi.json"`, slug `petstore`. Then `refresh` → expect 304/no-change. Then `script-run` (inline) with `return await ctx.api.petstore.getPetById({ path: { petId: 1 } })` (or the generated op name from `script-query-types`) → JSON pet payload.
3. **Phase 2 — OAuth binding**: `credential-bindings` `oauth-app-upsert` for a disposable provider (a GitHub OAuth app works: authorizeUrl `https://github.com/login/oauth/authorize`, tokenUrl `https://github.com/login/oauth/access_token`) → `oauth-authorize-url` → open in browser → callback lands on `/api/oauth/github-test/callback` → `credential-bindings list` shows `tokenStatus: ok`. Then `upsert` binding `{configKey: "GH_OAUTH", authKind: "oauth", oauthProvider: "github-test", allowedHosts: ["api.github.com"], headerTemplate: "Authorization: Bearer [REDACTED:GH_OAUTH]"}` and `script-run`: `const r = await ctx.stdlib.fetch("https://api.github.com/user", { headers: { Authorization: "Bearer [REDACTED:GH_OAUTH]" } }); return r.login` → returns the authorizing user's login. If no browser/OAuth app is available at QA time: seed `oauth_tokens` directly with a PAT and verify the resolution path only (note the shortcut in the QA report).
4. **Phase 3 — ctx.mcp (self-referential)**: `mcp-server-create` pointing at the swarm itself: url `http://localhost:3013/mcp`, `headerConfigKeys: {"Authorization": "SWARM_SELF_BEARER"}` with `set-config SWARM_SELF_BEARER="Bearer 123123" secret:true`. Then `script-connections` `upsert-mcp` slug `swarmself` → `script-query-types` shows `ctx.mcp.swarmself`. `script-run`: `return await ctx.mcp.swarmself.getSwarmInfo({})` (any read-only tool) → live data, and confirm the outbound call came from the API server, not the script subprocess.
5. **Phase 4 — GraphQL**: `script-connections` `upsert-graphql` slug `countries`, baseUrl `https://countries.trevorblades.com/`, allowedHosts `["countries.trevorblades.com"]`, no binding. `script-run`: `return await ctx.api.countries.graphql("query { country(code: \"UA\") { name capital } }")` → `{ country: { name: "Ukraine", capital: "Kyiv" } }`.
6. **Existing-DB migration check**: stop server, `cp` a pre-branch DB (or the main repo's dev DB) into the worktree, start server → boot applies 109+110 cleanly, `script-connections list` still returns pre-existing rows.
7. **Secret hygiene spot-check**: run a script that `console.log`s a request it makes with a placeholder — session logs must show `<redacted>`/scrubbed values, never the raw token.

Record evidence (commands + outputs) for the QA report.
