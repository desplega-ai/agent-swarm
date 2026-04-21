# Plan: OAuth 2.0 MCP Support for Headless Swarm Deployments

**Date:** 2026-04-21
**Author:** Picateclas (`38d36438-58a0-45b5-8602-a5d52b07c2f1`)
**Status:** Design review — **no implementation yet**
**Source issue:** [#356 — No viable path for configuring OAuth 2.0 MCPs on headless swarm deployments](https://github.com/desplega-ai/agent-swarm/issues/356)
**Research precedent:** [`2026-04-21-oauth-mcp-integration.md`](https://github.com/desplega-ai/agent-swarm/issues/356#issuecomment-4291619305) (agent-fs: `thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research/...`)

---

## TL;DR

- Ship a **dashboard-initiated OAuth 2.1 + PKCE flow** for HTTP/SSE MCP servers. The swarm API proxies the authorization code exchange, stores refresh tokens, and injects fresh access tokens into `/workspace/.mcp.json` at worker boot.
- Reuse the Linear OAuth precedent (`src/oauth/wrapper.ts`, `src/oauth/ensure-token.ts`, migration `009_tracker_integration.sql`). **No new crypto code.**
- Add **one migration (`041_mcp_oauth_tokens.sql`)**, ~5 HTTP routes, one UI section extension on `/mcp-servers/[id]`, and a small change to `resolveSecrets` on the entrypoint hot path.
- Reuse `SECRETS_ENCRYPTION_KEY` (AES-256-GCM, from migration 038) to encrypt `accessToken` / `refreshToken` / `dcrClientSecret` at rest — do not inherit the plaintext posture of legacy `oauth_tokens`.
- Ship **per-swarm / lead-scoped** tokens in v1. Leave `userId` as a nullable column for per-user v2.
- **Harness-agnostic by construction** — tokens live in the API DB and surface only as `resolvedHeaders` on the existing `resolveSecrets` endpoint, which Claude Code and pi-mono already consume. See §4.4 for the harness matrix (Codex/Gemini are not yet implemented; they inherit OAuth for free if they adopt the same endpoint).
- **Do not implement yet.** This PR is plan-only; Taras decides on the five flagged open questions before any code change.

---

## Decisions Required From @tarasyarema

These carry directly from §5.3 of the research doc. Recommended default in bold.

| # | Decision | Recommendation | Rationale |
|---|---|---|---|
| D1 | **Scope ownership: per-swarm (C1) vs per-user (C2)?** | **C1 — per-swarm** | Matches how `swarm_config` and the Linear tracker OAuth already work. `userId` column left nullable for a future C2 upgrade without migrating rows. |
| D2 | **Encryption at rest for OAuth tokens?** | **Yes, reuse `SECRETS_ENCRYPTION_KEY`** (not optional) | Migration 038 already ships AES-256-GCM; refresh tokens are higher-value than static bearers. Implementation cost is small. This also paves a follow-up migration to encrypt the legacy `oauth_tokens` rows for the Linear tracker. |
| D3 | **Ship the `claude mcp`-on-laptop workaround as v0.5?** | **Yes** | Zero engineering cost, documented-only. Buys time while v1 is being built. Deprecate once v1 lands. |
| D4 | **Proxy (A) vs broker (B) — where do tokens live?** | **A — tokens land on the worker in `.mcp.json`** | Option B (full MCP HTTP proxy) is a ~10× larger lift and puts the API on every tool-call hotpath. Revisit if enterprise audit pushes us there. |
| D5 | **Per-agent OAuth installation granularity, or always swarm-level?** | **Always swarm-level for v1** | One Linear connection, all agents benefit. Per-agent OAuth adds an install matrix we don't need yet. |

If Taras says "yes to the defaults," the plan below stands as-is. Any "no" on D1/D2/D4 needs a design revision *before* implementation begins — call it out at review.

---

## 1. Scope

### In scope (this plan)
- HTTP and SSE transports for MCPs that advertise OAuth via RFC 9728 Protected Resource Metadata (PRMD).
- Dynamic Client Registration (RFC 7591) with manual fallback for ASes that reject DCR.
- Automatic token refresh on the API side; surgical refresh on worker 401.
- UI extension on `/mcp-servers/[id]` with a Connect / Reconnect / Disconnect workflow.
- Encryption at rest for all token material.

### Out of scope (explicitly)
- **Stdio MCPs** — spec leaves them on the static-env path; no change.
- **Static-bearer MCPs** (existing Linear paste-the-token, etc.) — keep working, no forced migration.
- **Full MCP HTTP proxy / broker** (option B in research) — not this release.
- **Step-up / incremental scope challenges** (403 `insufficient_scope`) — phase-2 polish.
- **Per-user token ownership** — schema leaves room; implementation deferred.
- **MCP marketplace / one-click install templates** — can layer on top later.

---

## 2. Data model changes

### 2.1 New migration: `041_mcp_oauth_tokens.sql`

```sql
-- OAuth tokens scoped per MCP server installation.
-- Distinct from oauth_tokens (009_tracker_integration.sql) which is keyed by
-- a single global `provider` string (one Linear per swarm, etc.). MCP tokens
-- need one row per mcp_servers.id.
--
-- Encryption: accessToken, refreshToken, dcrClientSecret are stored as
-- base64(iv || ciphertext || authTag) AES-256-GCM using SECRETS_ENCRYPTION_KEY
-- (same helper as swarm_config, migration 038). Never written plaintext.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    mcpServerId TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,  -- NULL = swarm-shared (C1 default)

    -- Token material (AES-256-GCM, base64-encoded; never plaintext)
    accessToken TEXT NOT NULL,
    refreshToken TEXT,
    tokenType TEXT NOT NULL DEFAULT 'Bearer',
    expiresAt TEXT,            -- ISO 8601 UTC; NULL = never-expires
    scope TEXT,                -- space-separated granted scopes

    -- Authorization server context
    resourceUrl TEXT NOT NULL,                  -- canonical MCP URL (RFC 8707 `resource` param)
    authorizationServerIssuer TEXT NOT NULL,    -- e.g. https://linear.app
    authorizeUrl TEXT NOT NULL,
    tokenUrl TEXT NOT NULL,
    revocationUrl TEXT,

    -- Client credentials (either DCR result or user-supplied)
    dcrClientId TEXT,
    dcrClientSecret TEXT,                       -- AES-256-GCM; nullable (public clients)
    clientSource TEXT NOT NULL CHECK(clientSource IN ('dcr','manual','preregistered')),

    -- Connection state
    status TEXT NOT NULL CHECK(status IN ('connected','expired','error','revoked')) DEFAULT 'connected',
    lastErrorMessage TEXT,
    lastRefreshedAt TEXT,

    -- Audit
    connectedByUserId TEXT REFERENCES users(id),  -- who clicked "Connect"
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),

    -- v1 = one row per MCP (C1). v2 relaxes to (mcpServerId, userId) composite.
    UNIQUE(mcpServerId, userId)
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_mcp ON mcp_oauth_tokens(mcpServerId);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_user ON mcp_oauth_tokens(userId);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_expires ON mcp_oauth_tokens(expiresAt);

-- Pending OAuth sessions (state -> PKCE verifier + mcpServerId) for the 60-second
-- window between /authorize and /callback. Not persistent beyond a few minutes.
CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
    state TEXT PRIMARY KEY,
    mcpServerId TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id),
    codeVerifier TEXT NOT NULL,
    nonce TEXT,
    resourceUrl TEXT NOT NULL,
    authorizationServerIssuer TEXT NOT NULL,
    tokenUrl TEXT NOT NULL,
    dcrClientId TEXT,
    dcrClientSecret TEXT,                       -- encrypted
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_pending_createdAt ON mcp_oauth_pending(createdAt);
```

### 2.2 `mcp_servers` extension

Add a single column — no destructive change:

```sql
ALTER TABLE mcp_servers ADD COLUMN authMethod TEXT NOT NULL DEFAULT 'static'
    CHECK(authMethod IN ('static','oauth','auto'));
```

- `static` (default for all existing rows) — today's behaviour: pull headers/env from `swarm_config` via `headerConfigKeys` / `envConfigKeys`.
- `oauth` — `resolveSecrets` ignores `headerConfigKeys['Authorization']` and injects a token from `mcp_oauth_tokens`.
- `auto` — on save, the API probes the MCP URL (PRMD + `WWW-Authenticate`) and flips to `oauth` if the server requires it. Useful for new rows.

### 2.3 Compatibility

- No change to `oauth_tokens` / `oauth_apps` — Linear keeps using them.
- Stdio MCPs untouched.
- Existing HTTP MCPs with static headers untouched until a user flips `authMethod` in the UI.
- `AgentTaskSourceSchema` in `src/types.ts` is unaffected (no new task source).

---

## 3. API surface

All routes use `src/http/route-def.ts` (`route()` factory) so they auto-register in OpenAPI. Live under `src/http/mcp-oauth.ts` (new file); handler chain registered in `src/http/index.ts`; imports added to `scripts/generate-openapi.ts`.

### 3.1 Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/mcp-oauth/:mcpServerId/metadata` | session | Probe PRMD + AS metadata for this MCP. Returns `{ requiresOAuth, authorizationServerIssuer, authorizeUrl, tokenUrl, scopes, dcrSupported }`. UI uses this when the user opens the detail page. |
| `GET` | `/api/mcp-oauth/:mcpServerId/authorize` | session | Builds PKCE state, does DCR if needed, issues `302` to provider. Query param `?redirect=<dashboard-url>` for final landing page. |
| `GET` | `/api/mcp-oauth/callback` | none (public) | Provider redirects here with `?code=&state=`. Exchanges code → tokens, `INSERT INTO mcp_oauth_tokens`, `302` back to dashboard. |
| `POST` | `/api/mcp-oauth/:mcpServerId/refresh` | API key | Forces a refresh. Used by workers on 401. Returns `{ accessToken, expiresAt }`. |
| `DELETE` | `/api/mcp-oauth/:mcpServerId` | session | Revoke: calls provider revocation URL if available, then deletes the token row. |
| `POST` | `/api/mcp-oauth/:mcpServerId/manual-client` | session | Fallback when DCR is unavailable: user pastes `client_id` / `client_secret` obtained from a pre-registered app at the provider. |

### 3.2 Extend existing endpoint

`GET /api/agents/:id/mcp-servers?resolveSecrets=true` (the entrypoint hot path, `src/http/mcp-servers.ts`) grows one branch:

- For each MCP with `authMethod='oauth'`:
  1. Look up `mcp_oauth_tokens` by `mcpServerId` (and `userId IS NULL` for C1).
  2. Call `ensureMcpToken(mcpServerId)` — mirrors `src/oauth/ensure-token.ts` — which refreshes if `expiresAt < now + 5min`.
  3. Inject `Authorization: Bearer <accessToken>` into `resolvedHeaders`.
  4. If refresh fails, include a structured `authError` field in the response so the entrypoint can log (not silently swallow).
- For `authMethod='static'`: unchanged path.

### 3.3 Pending-session garbage collection

`mcp_oauth_pending` rows older than 10 minutes are deleted on a cheap timer (`setInterval` in the HTTP boot path, similar to `src/oauth/keepalive.ts`).

### 3.4 SSRF hardening

Both `/metadata` and `/authorize` fetch user-controlled URLs. Add a minimal guard:
- Reject `localhost`, `127.0.0.0/8`, `::1`, `169.254.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, and link-local IPv6 unless an `MCP_OAUTH_ALLOW_PRIVATE_HOSTS=true` env flag is set (useful only for local dev).
- Only allow `https://` in production; allow `http://` when `NODE_ENV !== 'production'`.

---

## 4. Worker integration

### 4.1 `docker-entrypoint.sh` changes

Around line 369 (`curl ... /api/agents/${AGENT_ID}/mcp-servers?resolveSecrets=true`):

- **No new logic needed if the API returns OAuth headers already resolved.** The response shape is unchanged: `resolvedHeaders` now contains `Authorization: Bearer ...` for OAuth MCPs.
- Small hardening: wrap the write of `/workspace/.mcp.json` in `set +x` so Bearer tokens don't end up in boot logs. Already mostly true but worth explicit.
- New path: on `401` from an MCP at runtime, the Claude CLI calls the MCP's token URL itself only for servers it registered via `claude mcp add`. For `.mcp.json`-injected bearers, we can't rely on that. Mitigation: document that long-running tasks on OAuth MCPs use the shorter refresh window (refresh tokens with ≥1-hour lifetime are standard); if a task fails on 401, the next task's boot cycle re-injects a fresh token. This is acceptable for v1; revisit if we see real-world flakiness.

### 4.2 Optional v2 hook: `mcpAuthRefresh` helper

If we see 401-mid-task in the wild, ship a tiny Bash helper that calls `POST /api/mcp-oauth/:mcpServerId/refresh` and rewrites the `.mcp.json` header. Not part of v1 scope; track as follow-up.

### 4.3 Nothing changes for stdio MCPs

`envConfigKeys` keeps resolving from `swarm_config`. The `authMethod` column defaults to `static` on every existing row, so no behavioural drift.

### 4.4 Per-harness applicability

The storage + authorization layer (migration 041, `/api/mcp-oauth/*` routes, `mcp_oauth_tokens`, refresh helpers) is **fully harness-agnostic** — tokens live in the API-server DB and never encode a harness identity. The only per-harness surface is *how the resolved `Authorization: Bearer …` header lands in front of the MCP client*.

Today the repo ships two harnesses and has two more named but unimplemented. Both shipping harnesses already consume the same `GET /api/agents/:id/mcp-servers?resolveSecrets=true` endpoint that this plan extends, so v1 is effectively transparent to both.

| Harness | MCP support today | Config sink | Change required for OAuth v1 |
|---|---|---|---|
| **Claude Code** (`HARNESS_PROVIDER=claude`, default) — `src/providers/claude-adapter.ts` | First-class (stdio + HTTP + SSE) via `/workspace/.mcp.json` | `docker-entrypoint.sh:295–328` merges `resolveSecrets` response into `.mcp.json`; per-session copy at `/tmp/mcp-<taskId>.json` via `--mcp-config` (`claude-adapter.ts:116–183`) | **None beyond the plan.** `resolvedHeaders['Authorization']` already flows into `.mcp.json`. v0.5 laptop workaround (`claude mcp add`) is Claude-specific. |
| **Pi-Mono** (`HARNESS_PROVIDER=pi`) — `src/providers/pi-mono-adapter.ts` | Partial: HTTP + SSE only (no stdio). Discovers tools at runtime via `McpHttpClient` (`pi-mono-mcp-client.ts`) against the same installed-servers API. | Same API call: `pi-mono-adapter.ts:395–458` fetches `/api/agents/:id/mcp-servers?resolveSecrets=true`, filters `transport ∈ {http, sse}`, uses `srv.resolvedHeaders` for auth. Does **not** read `.mcp.json`. | **None.** Because pi-mono already merges `resolvedHeaders` into `McpHttpClient.customHeaders`, an OAuth-injected `Authorization: Bearer …` flows through with no adapter change. Stdio-OAuth is a non-issue (pi-mono has no stdio anyway; plan already scopes out stdio). |
| **Codex** | **Not implemented.** No provider module; `src/providers/index.ts` rejects unknown `HARNESS_PROVIDER` values. | — | Out of scope. When Codex lands, if it goes through the same `resolveSecrets` endpoint (recommended), it inherits OAuth for free. |
| **Gemini CLI** | **Not implemented.** Research-only doc (`thoughts/shared/research/2025-12-21-gemini-cli-integration.md`); no adapter, no entrypoint hook. | — | Out of scope. Same pattern as Codex on arrival. |

**Takeaway:** the harness-facing changes in this plan are limited to §4.1 (Claude/`.mcp.json`). Pi-mono benefits automatically because it already consumes the same API response. Codex and Gemini are non-existent today, so they don't constrain v1 — but building any new harness adapter against the `resolveSecrets` endpoint (rather than a harness-local config file) keeps this story clean. **v0.5 laptop workaround is Claude-only** — pi-mono has no interactive browser-OAuth CLI equivalent; non-Claude users wait for v1.

---

## 5. Encryption story

### 5.1 Reuse, don't reinvent

Migration `038_encrypted_secrets.sql` added an AES-256-GCM encryption helper gated by `SECRETS_ENCRYPTION_KEY` / `SECRETS_ENCRYPTION_KEY_FILE`. Use the same helper (extract if needed from `src/be/secrets/encrypt.ts` or wherever it lives post-038) for:

- `mcp_oauth_tokens.accessToken`
- `mcp_oauth_tokens.refreshToken`
- `mcp_oauth_tokens.dcrClientSecret`
- `mcp_oauth_pending.dcrClientSecret`

### 5.2 Fail-closed

If `SECRETS_ENCRYPTION_KEY` is missing on boot **and** `mcp_oauth_tokens` has any non-zero rows, the server refuses to start (exactly like `swarm_config` does post-038). No silent plaintext write.

### 5.3 Read path

All DB queries in `src/be/db-queries/mcp-oauth.ts` (new file) transparently decrypt. Tests assert that raw `SELECT` on the SQLite file returns base64, never plaintext.

### 5.4 Follow-up (separate PR)

`oauth_tokens.refreshToken` (Linear) is still plaintext. Track a follow-up ticket to retrofit encryption on that table using the same helper; out of scope here.

### 5.5 Logging

Token values **never** go through `console.log` / progress events / BU instrumentation payloads. Validators (`ensure()`) should reference the *existence* of a token, never the value.

---

## 6. Per-swarm vs per-user ownership

### 6.1 v1: per-swarm (C1) — recommended

- One row per MCP server. `userId IS NULL` means "swarm-shared".
- UI shows "Connected as: <connectedByUserId's email>" so it's clear who owns the session.
- All workers and agents share that token.
- Revocation is a single row delete.

### 6.2 v2: per-user (C2) — not in this plan

- `UNIQUE(mcpServerId, userId)` already allows it.
- Requires: user→agent mapping at task dispatch (don't have it today), token lookup keyed by task's requesting user, per-user consent UI.
- Ship only when the swarm grows a real multi-tenant model. Non-goal here.

### 6.3 What this decision commits us to

- We **don't** store `userId` on `.mcp.json` — workers never see who the token belongs to.
- If we move to C2, the entrypoint call grows a `userId` query param. That's a routing change, not a schema change. Cheap to do later.

---

## 7. UI changes

### 7.1 Touch list

- `new-ui/src/pages/mcp-servers/page.tsx` — **add one column** to the AG Grid: "Auth status" badge (`None` / `Static` / `OAuth connected` / `OAuth expired` / `OAuth error`).
- `new-ui/src/pages/mcp-servers/[id]/page.tsx` — **extend with an "Authentication" section** per the research §4.2 wireframe. Conditional on `transport=http|sse`.
- `new-ui/src/pages/mcp-servers/[id]/oauth-callback.tsx` — **new minimal landing page** rendered after the provider redirects. Just shows success/failure; closes itself after 2s or lets the user click back.
- `new-ui/src/api/hooks/use-mcp-oauth.ts` — **new hooks**: `useMcpOAuthStatus(id)`, `useConnectMcpOAuth()`, `useDisconnectMcpOAuth()`, `useRefreshMcpOAuth()`.

### 7.2 Behaviour

- **Save of a new HTTP MCP with `authMethod='auto'`** — UI calls `/metadata` and, if `requiresOAuth`, pops a toast: "This MCP requires OAuth. Click Connect to authorize." Does not auto-redirect.
- **Connect button** — opens `/api/mcp-oauth/:id/authorize` in a new tab (so the dashboard stays alive; post-redirect the new tab auto-closes via the landing page). React Query invalidates `useMcpServer(id)` on window focus.
- **Reconnect** — identical to Connect but UI confirms "this will delete the existing token".
- **Disconnect** — calls `DELETE /api/mcp-oauth/:id`.
- **Refresh now** — calls `POST /api/mcp-oauth/:id/refresh`, shows new expiry.

### 7.3 QA

Any PR touching `new-ui/` must include a `qa-use` session per repo policy. Planned screenshots:

1. Detail page disconnected state (Connect CTA visible).
2. Consent flow (record the redirect to a test provider — Linear dev has a no-op sandbox).
3. Connected state with expiry timer.
4. Error state after revocation.

---

## 8. Rollout

### 8.1 v0.5 (ship **this week** — zero engineering)

Document-only: **"Use `claude mcp add` on your laptop and mirror the token file into the swarm."** Content lives in `MCP.md`:

1. On your laptop: `claude mcp add --transport http <name> <url>` — browser opens, consent, token cached at `~/.claude/mcp-auth/<name>.json`.
2. Copy that file's contents into `swarm_config` as a secret entry (the MCP is configured with static bearer + that secret key).
3. Swarm worker entrypoint restores it on boot.
4. Deprecate when v1 lands.

**Caveat:** token refresh is on the user's laptop's next `claude mcp` invocation; if the refresh token expires without a laptop refresh, the workflow breaks. Acceptable for v0.5; document.

### 8.2 v1 (the implementation enabled by this plan)

Order of delivery (each a separate PR):

1. **Migration `041_mcp_oauth_tokens.sql` + DB queries + helpers** (`src/be/db-queries/mcp-oauth.ts`, `src/oauth/mcp-wrapper.ts` extending the Linear `wrapper.ts`). No UI, no route wiring.
2. **HTTP routes** `src/http/mcp-oauth.ts` + register in `src/http/index.ts` + regen `openapi.json`.
3. **Entrypoint integration** — extend `resolveSecrets` and add `resolveMcpOAuthHeader()` to `src/http/mcp-servers.ts`. Smoke-test the Docker entrypoint round-trip.
4. **UI** — list column, detail section, hooks, callback page. Includes `qa-use` screenshots.
5. **Docs** — update `MCP.md` with the in-dashboard flow; mark the v0.5 workaround deprecated.

Each PR is individually reviewable and ships green without depending on the next.

### 8.3 v2 (not this plan)

- Per-user tokens (C2).
- On-401 mid-task refresh helper in the worker.
- MCP marketplace / template store.
- Step-up scope challenges.
- Encrypt the legacy Linear `oauth_tokens` table.

---

## 9. Tests

### 9.1 Unit tests (add to `src/tests/`)

- `mcp-oauth-wrapper.test.ts` — PKCE S256 verifier generation, URL build with `resource=`, state randomness.
- `mcp-oauth-queries.test.ts` — encrypt/decrypt roundtrip for token columns against an isolated `./test-mcp-oauth.sqlite`.
- `mcp-oauth-ensure-token.test.ts` — refresh path: not-expiring (no call), expiring (refresh), refresh failure (status=error), revoked (status=revoked).
- `mcp-oauth-routes.test.ts` — minimal `node:http` handler per repo pattern (unique port, e.g. 13041); covers `/authorize` redirect, `/callback` happy path + bad state + expired pending, `/metadata` probe.
- `mcp-oauth-ssrf.test.ts` — reject loopback / RFC1918 URLs unless the allowlist flag is set.

### 9.2 Integration tests

- `docker-entrypoint` round-trip: spin up API + worker (reuse the `swarm-local-e2e` skill), pre-populate a mock OAuth MCP, verify `.mcp.json` contains a Bearer header.
- Migration idempotency: run `041` against a fresh DB and against a DB with legacy MCPs; assert `authMethod='static'` on pre-existing rows.
- `scripts/check-db-boundary.sh` must pass (no worker-side imports of `src/be/db`).

### 9.3 UI tests

`qa-use` session capturing the four states in §7.3.

### 9.4 Business-use instrumentation

Add one new flow in `task` and `api` flows:

- `api.mcp_oauth.callback_succeeded` — act event after INSERT (outside the transaction).
- `api.mcp_oauth.token_refreshed` — act event.
- `api.mcp_oauth.token_refresh_failed` — assert with `status === 'error'`.
- `task.mcp_oauth.header_injected` — hooks on the worker side, `depIds` pointing to `api.mcp_oauth.token_refreshed`.

---

## 10. Documentation impact

| File | Change |
|---|---|
| `MCP.md` | New "OAuth 2.0" section: Connect flow, refresh mechanics, troubleshooting. Mark the v0.5 workaround as deprecated once v1 lands. |
| `DEPLOYMENT.md` | Add `SECRETS_ENCRYPTION_KEY` dependency note (already required post-038, reiterate). |
| `new-ui/README.md` | Mention the new `/mcp-servers/[id]/oauth-callback` route. |
| `openapi.json` | Regenerated via `bun run docs:openapi` after routes land. CI enforces freshness. |
| `CLAUDE.md` | Optional: add a short "MCP OAuth" block under the MCP server section, similar to the Secrets encryption block. |
| Troubleshooting | New block: "DCR refused — register manually: paste client_id/secret at `/manual-client`." |

---

## 11. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| DCR refused by provider (Microsoft, some Atlassian tiers) | Medium | `/manual-client` fallback route + UI panel to paste `client_id`/`client_secret`. |
| Refresh-token race between concurrent workers | Low | Refresh lives on the API; serialize per `mcpServerId` via a simple in-memory mutex. |
| Provider revocation mid-task | Medium | `status='revoked'` flag; next `resolveSecrets` surfaces `authError`; UI badge flips; re-connect CTA surfaces. |
| Token leak via entrypoint logs | Medium | `set +x` around `.mcp.json` write; no `cat` of the file in the script. |
| SSRF via PRMD fetch | Medium | Allowlist described in §3.4. |
| Losing `SECRETS_ENCRYPTION_KEY` | **High** | Same risk profile as migration 038 — documented in CLAUDE.md. Reiterate in `MCP.md`. |
| Linear / existing `oauth_tokens` stays plaintext | Medium | Tracked as follow-up PR (§5.4). Not blocking. |

---

## 12. Estimate

| Work unit | Effort |
|---|---|
| Migration + DB queries + OAuth MCP wrapper | 1 day |
| HTTP routes (+ SSRF guard, openapi regen) | 1 day |
| Entrypoint integration + encrypted-header tests | 0.5 day |
| UI extension + hooks + callback page + `qa-use` | 1.5 days |
| Docs + v0.5 workaround doc + v1 announcement | 0.5 day |
| **Total** | **~4.5 days** for a single engineer, split across 5 PRs. |

---

## 13. What this plan explicitly does NOT do

- **It does not implement anything.** No code, no migration run, no UI change. This PR is a design document awaiting @tarasyarema's answers on D1–D5.
- It does not change any behaviour for stdio MCPs or static-bearer MCPs.
- It does not retrofit encryption on the Linear tracker's `oauth_tokens` table (follow-up).
- It does not introduce per-user tokens (v2).
- It does not add a full MCP HTTP proxy / broker (option B rejected).
- It does not ship harness support for Codex or Gemini CLI — those providers are not yet in the repo (§4.4). When they arrive, they get OAuth for free if they consume the `resolveSecrets` endpoint.

---

## Appendix A — Files touched when v1 is implemented (forward reference)

| Concern | Path | Change |
|---|---|---|
| DB migration | `src/be/migrations/041_mcp_oauth_tokens.sql` | **new** |
| DB queries | `src/be/db-queries/mcp-oauth.ts` | **new** |
| OAuth wrapper extension | `src/oauth/mcp-wrapper.ts` | **new** (wraps `wrapper.ts` with PRMD + DCR) |
| OAuth refresh helper | `src/oauth/ensure-mcp-token.ts` | **new** |
| HTTP routes | `src/http/mcp-oauth.ts` | **new** |
| HTTP handler chain | `src/http/index.ts` | +1 import |
| OpenAPI generator | `scripts/generate-openapi.ts` | +1 import |
| Existing MCP endpoint | `src/http/mcp-servers.ts` | extend `resolveSecrets` path |
| `mcp_servers.authMethod` column | (same migration 041) | minor ALTER |
| Entrypoint | `docker-entrypoint.sh` | log hardening only |
| UI list | `new-ui/src/pages/mcp-servers/page.tsx` | +1 column |
| UI detail | `new-ui/src/pages/mcp-servers/[id]/page.tsx` | +1 section |
| UI callback | `new-ui/src/pages/mcp-servers/[id]/oauth-callback.tsx` | **new** |
| UI hooks | `new-ui/src/api/hooks/use-mcp-oauth.ts` | **new** |
| Docs | `MCP.md`, `DEPLOYMENT.md`, `CLAUDE.md` | updates |

## Appendix B — References

- Research doc: `thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research/2026-04-21-oauth-mcp-integration.md` (agent-fs org `648a5f3c-35c8-4f11-8673-b89de52cd6bd`).
- MCP Authorization spec: https://modelcontextprotocol.io/specification/draft/basic/authorization
- RFC 9728 (Protected Resource Metadata): https://datatracker.ietf.org/doc/html/rfc9728
- RFC 8414 (AS Metadata): https://datatracker.ietf.org/doc/html/rfc8414
- RFC 7591 (DCR): https://datatracker.ietf.org/doc/html/rfc7591
- RFC 8707 (Resource Indicators): https://www.rfc-editor.org/rfc/rfc8707.html
- OAuth 2.1: https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13
- Linear tracker precedent: `src/http/trackers/linear.ts`, migration `009_tracker_integration.sql`
- Secrets encryption precedent: migration `038_encrypted_secrets.sql`, CLAUDE.md "Secrets encryption" section.
