---
date: 2026-05-27
researcher: Claude (verbose mode)
git_commit: 21f145cd7a228ca819dc8d0cc8a6c9bad69fd4c2
branch: main
repository: agent-swarm
topic: "Fake-OAuth on /mcp-user per MCP 2025-11-25 authorization spec"
tags: [oauth, mcp, mcp-user, authorization, dcr, pkce, user-tokens, aswt]
status: complete
last_updated: 2026-05-27
---

# Research: Fake-OAuth on the user MCP

## Research Question

Add OAuth 2.1 support to the existing user MCP endpoint (`/mcp-user`) per the [MCP 2025-11-25 authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), so external MCP clients (Claude Desktop, Claude.ai, ChatGPT, Cursor, …) can complete the standard OAuth handshake and connect.

Constraint chosen by Taras: the access token returned at `/token` is the user's existing `aswt_<…>` personal access token (or one minted on the fly). The Authorization Server is a thin "fake" layer that goes through the OAuth motions but ultimately hands back a swarm-native token that the existing `resolveUserByToken` path validates as today.

Authorize-step UX (Taras choice): the user pastes their `aswt_` token on the consent page. No login/session plumbing.

## Summary

The work splits into five pieces:

1. **Mint a generalized Authorization Server.** Stand up `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register` (DCR), `/oauth/authorize` (paste-aswt consent page), `/oauth/token` (code → token exchange + refresh grant) under a single new handler file `src/http/swarm-oauth.ts`. All four endpoints must be public (no swarm-API-key gate). The AS is named `swarm_oauth_*` (not `mcp_user_*`) so the same scaffolding can later serve other inbound surfaces (the normal agent `/mcp`, swarm-app OAuth login). v1 only wires the user MCP resource.
2. **Convert `/mcp-user`'s 401 to a spec-compliant `WWW-Authenticate: Bearer resource_metadata="…"` header.** Today (`src/http/mcp-user.ts:9-13`) the 401 has only `Content-Type: application/json` — no header at all. This is the only change needed to the *resource* surface; the bearer validation path stays untouched.
3. **Add DB tables for the AS state.** Three new tables in a single forward-only migration `src/be/migrations/077_swarm_oauth.sql`: `swarm_oauth_clients` (DCR registrations), `swarm_oauth_codes` (short-lived auth codes carrying PKCE challenge + user binding + resource + scope), `swarm_oauth_grants` (refresh-token → access-token mapping). The access token IS a row in the existing `user_tokens` table — no new access-token table.
4. **Audience-bind the issued token.** The spec mandates the resource server reject tokens not issued for itself. Since the access token is `aswt_…`, audience can be derived by joining `user_tokens.id` → `swarm_oauth_grants.accessTokenId` → `swarm_oauth_grants.resource`. For v1 we likely skip the audience check on `/mcp-user` (every `aswt_` already authorizes the user across the swarm — see Fork B). Decision deferred to the in-conversation pass.
5. **Design forks** — see §11; one (Fork A: token shape) is decided as A2 (mint fresh `aswt_` per `/token`), the rest pending the live discussion.

**Net code estimate** (rough, for sizing only): ~1 handler file (~500 LoC), 1 migration, 1 DB-queries file, 1 frontend consent page, 1 test file. Reuses `assertUrlSafe`, `computeExpiresAt`, the encrypted-row pattern, the pending-GC pattern, and the `route()` factory.

## Detailed Findings

### 1. MCP 2025-11-25 authorization spec — what we MUST implement

The spec is OAuth 2.1 + PKCE + RFC 8707 audience binding, layered on:

| RFC | Surface | Spec stance |
|---|---|---|
| [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) | PRMD at `/.well-known/oauth-protected-resource` | **MUST implement** (server side) |
| [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) | AS metadata at `/.well-known/oauth-authorization-server` | **MUST** (one of this or OIDC Discovery) |
| [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) | Dynamic Client Registration | **MAY** — but in practice MUST for Claude Desktop etc. |
| [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636) | PKCE | S256 is MTI for the AS |
| [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html) | Resource indicator on `authorize` + `token` | **MUST** accept (server) and send (client) |

**Specific requirements distilled** (citations all from `mcp-auth-spec-2025-11-25`):

#### Protected Resource Metadata
- `GET https://<resource>/.well-known/oauth-protected-resource[/<path>]` returns JSON.
- Required field: `resource` (the canonical resource URL, e.g. `https://api.swarm.example.com/mcp-user`).
- Recommended fields: `authorization_servers: [<issuer-url>]`, `scopes_supported: ["mcp:user"]` (we can use a single scope), `bearer_methods_supported: ["header"]`.
- Path construction: well-known suffix goes **between host and path** (RFC 9728 §3). For resource URL `https://api.swarm.example.com/mcp-user`, the PRMD lives at `https://api.swarm.example.com/.well-known/oauth-protected-resource/mcp-user`.

#### 401 WWW-Authenticate (RFC 6750)
- On 401 from `/mcp-user`, **MUST** include `WWW-Authenticate: Bearer resource_metadata="https://api.swarm.example.com/.well-known/oauth-protected-resource/mcp-user"`.
- **SHOULD** also include `scope="mcp:user"` for client guidance.

#### Authorization Server Metadata
- `GET https://<as-issuer>/.well-known/oauth-authorization-server[/<issuer-path>]`. Our AS issuer = the API base, so it lives at `<APP_URL>/.well-known/oauth-authorization-server`.
- Required fields: `issuer`, `authorization_endpoint`, `token_endpoint`, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]` (public clients only — no client secret).
- For DCR: include `registration_endpoint`.

#### Authorize endpoint
- `GET /oauth/authorize?response_type=code&client_id=<id>&redirect_uri=<uri>&code_challenge=<S256>&code_challenge_method=S256&state=<opaque>&scope=mcp:user&resource=https%3A%2F%2Fapi.swarm.example.com%2Fmcp-user`.
- Server **MUST** validate that `redirect_uri` matches one registered for `client_id`.
- Server **MUST** bind the `code_challenge` to the issued code; the token endpoint will verify the code_verifier.
- `resource` parameter (RFC 8707) **MUST** be echoed into the issued code's binding so the audience is preserved.

#### Token endpoint
- `POST /oauth/token`, `Content-Type: application/x-www-form-urlencoded`.
- `grant_type=authorization_code`: body has `code`, `code_verifier`, `redirect_uri`, `client_id`, `resource`. Server verifies `BASE64URL(SHA256(code_verifier)) == stored.code_challenge`. Returns JSON `{access_token, token_type:"Bearer", expires_in?, refresh_token?, scope}`.
- `grant_type=refresh_token`: body has `refresh_token`, `client_id`, optional `scope`, `resource`. Returns same shape. **MUST rotate refresh_token** for public clients.
- Bearer transport: `Authorization: Bearer <access_token>` only — **MUST NOT** appear in URI query.

#### Dynamic Client Registration
- `POST /oauth/register`, JSON body conforming to RFC 7591. Minimal fields the AS must accept and echo back: `client_name`, `redirect_uris` (array of HTTPS URIs or loopback), `grant_types`, `response_types`, `token_endpoint_auth_method`.
- Response is `client_id` (generated), `client_id_issued_at`, plus all submitted metadata. For public clients (PKCE), no `client_secret` is returned.

#### Audience binding (RFC 8707)
- Issued tokens **MUST** be rejected by `/mcp-user` if the audience doesn't match. Since we issue `aswt_` tokens (which today have no audience field), see the design fork in §10 below.

#### Spec tensions with the chosen design
- *SHOULD issue short-lived access tokens.* `aswt_` tokens are long-lived today.
- *MUST rotate refresh tokens* (public clients). If we use the same `aswt_` for both access and refresh, rotation is undefined.

### 2. Current `/mcp-user` auth surface

File: `src/http/mcp-user.ts` (111 lines total).

- **Bearer extraction** (`mcp-user.ts:15-20`): rejects unless `Authorization: Bearer aswt_<…>`. Tokens not starting with `aswt_` are dropped before `resolveUserByToken` is ever called.
- **Active-user resolution** (`mcp-user.ts:22-28`): calls `resolveUserByToken` (`src/be/users.ts:490-514`), then enforces `user.status === "active"`. Both `"invited"` and `"suspended"` are 401.
- **401 emission** (`mcp-user.ts:9-13`): plain `{"error": "Unauthorized"}` with only `Content-Type: application/json`. **No `WWW-Authenticate` header anywhere in the codebase today** — confirmed by absence in `src/`.
- **Session→user binding** (`mcp-user.ts:30-78`): `transportsUser` and `sessionUsers` maps owned by `src/http/index.ts:106-108`. The `mcp-session-id` header is server-generated via `randomUUID()` (`mcp-user.ts:62`); cross-user hijack is prevented by re-checking `sessionUsers[sessionId] === user.id` on every subsequent request (`mcp-user.ts:45-47`).
- **Dispatcher exemption**: `/mcp-user` already bypasses the global swarm-API-key gate via a hard-coded URL check at `src/http/core.ts:243-246`. We will need to add similar exemptions (or use the `route({auth:{apiKey:false}})` mechanism) for the new OAuth + well-known endpoints.

The new OAuth handlers do not need to touch this file beyond the 401 header upgrade.

### 3. User token lifecycle (`aswt_`)

File: `src/be/users.ts`. Schema: `src/be/migrations/067_users_first_class.sql:67-79`.

- **Mint** (`mintToken`, `users.ts:431-453`): plaintext = `aswt_` + `base62(randomBytes(24))` (≈143 bits). Persists `tokenHash = sha256(plaintext)` and `tokenPreview = plaintext.slice(-4)` in `user_tokens`. Plaintext returned exactly once.
- **HTTP route**: `POST /api/users/:id/mcp-tokens` (`src/http/users.ts:521-539`) is the only place plaintext leaves the API. Requires the swarm API key.
- **Revocation** (`revokeToken`, `users.ts:459-482`): soft-deletes via `revokedAt` timestamp. No rotation endpoint exists.
- **Validation** (`resolveUserByToken`, `users.ts:490-514`): sha256-hashes incoming plaintext, looks up `user_tokens.tokenHash`, returns null if missing/revoked, best-effort updates `lastUsedAt`, returns the `User` via `findUserById`.
- **Scrubber coverage**: `src/utils/secret-scrubber.ts:131` redacts `aswt_[A-Za-z0-9]{20,}` from logs.
- **UI**: `ui/src/pages/people/[id]/mint-token-dialog.tsx` shows the plaintext once with client config snippets via `buildMcpClientSnippets`. After the OAuth flow is added, this dialog will likely need an "OAuth setup URL" alternative (out of scope for this research).

### 4. Existing OAuth scaffolding — reusable vs not

Two parallel stacks exist for OUTBOUND OAuth:

**`src/oauth/wrapper.ts`** (legacy Linear/Jira tracker OAuth) — in-memory pending state, `OAuthProviderConfig`, outbound `buildAuthorizationUrl`/`exchangeCode`/`refreshAccessToken`. Not relevant.

**`src/oauth/mcp-wrapper.ts`** (new — outbound MCP per 2025 spec). Most reusable pieces:

| Helper | File:Line | Reusable for inbound AS? |
|---|---|---|
| `assertUrlSafe(url, opts)` SSRF guard | `mcp-wrapper.ts:63-97` | YES — for DCR redirect_uri validation |
| `computeExpiresAt(seconds)` | `mcp-wrapper.ts:408-411` | YES — pure |
| `DcrRequest` / `DcrResponse` interfaces | `mcp-wrapper.ts:214-230` | YES — as request/response shape |
| `AuthorizationServerMetadata` interface | `mcp-wrapper.ts:169-179` | YES — as response shape |
| `discoverProtectedResourceMetadata` | `mcp-wrapper.ts:129-165` | NO — we're producing, not consuming |
| `discoverAuthorizationServerMetadata` | `mcp-wrapper.ts:185-210` | NO — same reason |
| `buildAuthorizeUrl` / `exchangeCodeForTokens` / `refreshMcpToken` / `revokeMcpToken` | `mcp-wrapper.ts:272-405` | NO — outbound client side; we implement the server side |
| `registerClient` | `mcp-wrapper.ts:232-249` | NO — we are the DCR server, not client |

**Crypto** (direction-agnostic): `src/be/crypto/secrets-cipher.ts:34-90` (`encryptSecret`/`decryptSecret`, AES-256-GCM), `src/be/crypto/key-bootstrap.ts:73-155` (`getEncryptionKey`), `src/be/crypto/index.ts` barrel. Pattern: encrypt sensitive payloads at rest in DB. Useful if we store anything sensitive in `mcp_user_oauth_codes` (we shouldn't need to — codes are short-lived random strings).

**Pending GC pattern**: `src/be/db-queries/mcp-oauth.ts:433-437` (`gcMcpOAuthPending`) + `src/http/mcp-oauth.ts:697-717` (`startMcpOAuthPendingGc`, `setInterval(...).unref()`). Mirror this for `mcp_user_oauth_codes` cleanup.

**PKCE verify**: no helper exists today. The codebase generates verifier+challenge via `oauth4webapi` in two places (`src/oauth/mcp-wrapper.ts:273-275`, `src/oauth/wrapper.ts:66-68`), but verification = re-hashing the verifier and comparing to the stored challenge. ~10 lines:

```ts
import { createHash } from "node:crypto";
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function verifyPkceS256(verifier: string, storedChallenge: string): boolean {
  const computed = base64url(createHash("sha256").update(verifier).digest());
  // constant-time compare against storedChallenge
  return computed.length === storedChallenge.length &&
    Buffer.from(computed).equals(Buffer.from(storedChallenge));
}
```

### 5. Route + OpenAPI conventions

Authoritative dispatcher: `src/http/index.ts` (NOT `src/server.ts` which is the MCP server factory).

**Route registration** uses `route()` factory at `src/http/route-def.ts:148-206`, which auto-registers into `routeRegistry` as a side effect at import time. The `isPublicRoute()` check (`route-def.ts:70-81`) walks the registry looking for an entry with `auth.apiKey === false`.

**To add a new public-no-apiKey route** (this is the entire pattern for the four OAuth endpoints + two well-known endpoints in `src/http/swarm-oauth.ts`):
1. Declare `const myRoute = route({ ..., auth: { apiKey: false } })` in the handler file.
2. Add `import { handleSwarmOauth } from "./swarm-oauth"` to `src/http/index.ts:28-75` and append `handleSwarmOauth` to the `handlers[]` array at `src/http/index.ts:202-244`. Order matters but is "first match wins" — since our paths (`/oauth/...`, `/.well-known/...`) don't collide with anything existing, append near the end.
3. Add the file path to `scripts/generate-openapi.ts` import list.
4. Run `bun run docs:openapi` and commit `openapi.json` + `docs-site/content/docs/api-reference/**`.

**`getPathSegments`** at `src/http/utils.ts:43-47` splits on `/` and filters falsy. So `/.well-known/oauth-protected-resource/mcp-user` → `[".well-known", "oauth-protected-resource", "mcp-user"]`. The leading dot is preserved in the first segment.

**Hard-coded URL bypasses already exist** at `src/http/core.ts:243-246` (the `/mcp-user` exemption). We do NOT need a new one — `route({auth:{apiKey:false}})` is the cleaner mechanism. The only hard-coded bypass should be added if we want to special-case behavior in `handleCore` itself, which we don't.

**Existing public-no-apiKey routes** (precedent shapes to mirror):
- `GET /api/mcp-oauth/callback` (`src/http/mcp-oauth.ts:182-199`) — OAuth redirect target. Closest precedent for our `/oauth/authorize` + `/oauth/token`.
- All `*/webhook` endpoints in `src/http/webhooks.ts:53-107`.
- `GET /p/{id}`, `GET /p/{id}.json` in `src/http/pages-public.ts:34-65` — useful for the HTML consent page.

### 6. DB schema needs

Schema migrations: `src/be/migrations/NNN_*.sql`, forward-only. Runner: `src/be/migrations/runner.ts`, invoked from `src/be/db.ts:164`. Latest applied: `076_kapso_sender_user_backfill.sql`. **Next free slot: `077_`** (numbers `045` and `075` are absent from the sequence; runner doesn't require contiguity).

Style conventions to copy (from `src/be/migrations/041_mcp_oauth_tokens.sql`):
- `id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))`
- `createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
- `CHECK(col IN ('a','b','c'))` with single-quoted, no-space enum values
- `REFERENCES users(id) ON DELETE CASCADE` for owned rows
- `UNIQUE(<composite>)` at the bottom of the table def

**Proposed tables for `077_swarm_oauth.sql`** (sketches — not final SQL).

Per file-review feedback: tables are **generalized** as `swarm_oauth_*` (not `mcp_user_oauth_*`) so the same scaffolding can later host OAuth for the normal agent `/mcp` endpoint, swarm-app OAuth login, or any other inbound surface. Discrimination happens via the `resource` column already required by RFC 8707 — every code/grant carries the canonical resource URL it was minted for, and `/mcp-user` (or any future resource) verifies the bound resource matches itself when accepting a token. Clients are registered globally (no resource scoping at the client level) — standard AS behavior; per-resource authorization is enforced at code-issuance time.

```sql
-- DCR registrations. Public clients only for v1; no client_secret column.
-- Global — same client can request tokens for any resource the AS serves.
CREATE TABLE IF NOT EXISTS swarm_oauth_clients (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  clientId TEXT NOT NULL UNIQUE,
  clientName TEXT,
  redirectUris TEXT NOT NULL,                      -- JSON array
  grantTypes TEXT NOT NULL,                        -- JSON array, e.g. ["authorization_code","refresh_token"]
  responseTypes TEXT NOT NULL,                     -- JSON array, e.g. ["code"]
  tokenEndpointAuthMethod TEXT NOT NULL DEFAULT 'none'
    CHECK(tokenEndpointAuthMethod IN ('none')),    -- public client only for v1
  scope TEXT,                                      -- space-separated requested scopes
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Optional: track which user registered this client (audit only; not authorization).
  -- NULL for anonymous DCR.
  registeredByUserId TEXT REFERENCES users(id)
);
CREATE INDEX idx_swarm_oauth_clients_clientId ON swarm_oauth_clients(clientId);

-- Short-lived authorization codes (single-use, ~10 min TTL). GC'd by a timer.
-- `resource` discriminates which inbound surface this code is bound to
-- (e.g. https://api.swarm.example.com/mcp-user vs. .../mcp vs. .../app).
CREATE TABLE IF NOT EXISTS swarm_oauth_codes (
  code TEXT PRIMARY KEY,                           -- the opaque code value
  clientId TEXT NOT NULL REFERENCES swarm_oauth_clients(clientId) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirectUri TEXT NOT NULL,                       -- echoed back at /token
  codeChallenge TEXT NOT NULL,                     -- S256 only
  codeChallengeMethod TEXT NOT NULL DEFAULT 'S256'
    CHECK(codeChallengeMethod IN ('S256')),
  resource TEXT NOT NULL,                          -- RFC 8707 audience binding + surface discriminator
  scope TEXT,
  expiresAt TEXT NOT NULL,
  consumedAt TEXT,                                 -- mark single-use; do NOT delete on consume (lets us detect replays)
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_swarm_oauth_codes_expires ON swarm_oauth_codes(expiresAt);
```

**Plus, per Fork A's A2 decision**, one small grants table to make refresh-token rotation work:

```sql
-- Maps a refresh_token to the aswt_ access token it can refresh. Both are
-- rotated together on grant_type=refresh_token. The actual aswt_ lives in
-- user_tokens (this row just points at it via accessTokenId).
--
-- accessTokenKind/accessTokenId is a polymorphic pointer so this same table
-- can later carry refresh tokens that mint other access-token kinds (e.g.
-- a session cookie for swarm-app OAuth login). v1 only mints 'user_token'.
CREATE TABLE IF NOT EXISTS swarm_oauth_grants (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  refreshToken TEXT NOT NULL UNIQUE,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clientId TEXT NOT NULL REFERENCES swarm_oauth_clients(clientId) ON DELETE CASCADE,
  accessTokenKind TEXT NOT NULL DEFAULT 'user_token'
    CHECK(accessTokenKind IN ('user_token')),     -- v1: only user_tokens rows
  accessTokenId TEXT NOT NULL,                     -- FK enforced in application code per kind
  scope TEXT,
  resource TEXT NOT NULL,                          -- same surface discriminator as codes
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revokedAt TEXT
);
CREATE INDEX idx_swarm_oauth_grants_userId ON swarm_oauth_grants(userId);
```

No separate `oauth_tokens` table — for v1, the access token IS a row in `user_tokens`, looked up + revoked via the existing helpers in `src/be/users.ts`. Future access-token kinds add their own `accessTokenKind` enum value + lookup path; the AS plumbing (clients, codes, grants, the four `/oauth/*` endpoints, the two well-known endpoints) stays shared.

**Resource-server side**: when `/mcp-user` (or any future resource) accepts a token, it MAY verify audience by joining back through `swarm_oauth_grants` on `accessTokenId` and checking `resource` matches its canonical URL. For the chosen design (Fork B — see Open Questions) we likely skip this check in v1, since every `aswt_` already grants access to `/mcp-user` by virtue of being a valid user token.

### 7. Test conventions

Pattern is **no shared helpers** — every HTTP test file rolls its own `removeDbFiles`, `listen`, `createTestServer`. Per-file SQLite paths (`./test-<name>.sqlite`) wiped pre/post via the `.sqlite/-wal/-shm` triplet. `beforeEach` truncates tables explicitly.

Closest existing references:
- `src/tests/mcp-user-route.test.ts` — full MCP-user HTTP harness including `mcpPost`/`initialize`/`notifyInitialized` helpers. Use it as the parent template since our access-token-use case ends with a `/mcp-user` initialize call.
- `src/tests/user-token-routes.test.ts` — `authedFetch` + env-mutation pattern for the swarm API key save/restore (`AGENT_SWARM_API_KEY`).
- `src/tests/mcp-oauth-wrapper.test.ts` — `globalThis.fetch` stubbing pattern + reading `URLSearchParams` off captured POST bodies. Useful for asserting token-endpoint request shape from a synthetic MCP client.
- `src/tests/pages-public-json-redirect.test.ts:82-85` — the `fetch(url, { redirect: "manual" })` + Location-header assertion pattern. Required for `/oauth/authorize` consent flow tests.
- `src/tests/jira-oauth.test.ts:19-25` — **explicit warning** to use `spyOn(module, fn)` instead of `mock.module(...)` (which is process-global and not restorable). Apply same constraint here.

Load-bearing import for `isPublicRoute` to see the new routes (per `src/tests/core-auth.test.ts:12-16`): tests for `/oauth/authorize` etc. must `import "../http/swarm-oauth"` even if they don't directly call the handler.

PKCE helper: no shared utility. Either import `generatePKCE` from `src/providers/codex-oauth/pkce.ts` or duplicate ~20 lines inline.

## Code References

### Resource server (existing — touch lightly)
- `src/http/mcp-user.ts:9-13` — `unauthorized()`: ONLY change for resource-server side is adding `WWW-Authenticate` header
- `src/http/mcp-user.ts:15-20` — `extractBearer()`: leave as-is
- `src/http/mcp-user.ts:22-28` — `resolveActiveUser()`: leave as-is
- `src/be/users.ts:431-453` — `mintToken()`
- `src/be/users.ts:459-482` — `revokeToken()`
- `src/be/users.ts:490-514` — `resolveUserByToken()`

### Routing infrastructure (read; don't modify)
- `src/http/route-def.ts:148-206` — `route()` factory and `RouteHandle`
- `src/http/route-def.ts:70-81` — `isPublicRoute()`
- `src/http/core.ts:241-256` — global swarm-API-key gate + `/mcp-user` exemption
- `src/http/index.ts:202-244` — handler dispatch array (append new handler here)
- `src/http/openapi.ts:18-101` — `generateOpenApiSpec()`
- `scripts/generate-openapi.ts` — handler-import list (append new file here)

### Reusable OAuth helpers
- `src/oauth/mcp-wrapper.ts:63-97` — `assertUrlSafe()` (for DCR redirect_uri validation)
- `src/oauth/mcp-wrapper.ts:408-411` — `computeExpiresAt()`
- `src/oauth/mcp-wrapper.ts:169-179` — `AuthorizationServerMetadata` interface (response shape)
- `src/oauth/mcp-wrapper.ts:214-230` — `DcrRequest` / `DcrResponse` interfaces
- `src/be/crypto/secrets-cipher.ts:34-90` — `encryptSecret` / `decryptSecret` (only if we encrypt anything at rest)

### Precedent shapes
- `src/http/mcp-oauth.ts:182-199` — public OAuth callback route declaration (mirror for `/oauth/token`)
- `src/http/mcp-oauth.ts:697-717` — pending-GC timer pattern (mirror for code GC)
- `src/be/migrations/041_mcp_oauth_tokens.sql` — table conventions to mirror
- `src/be/db-queries/mcp-oauth.ts:419-431` — `consumeMcpOAuthPending` single-shot read+delete pattern (mirror for code consumption)
- `src/http/pages-public.ts:34-65` — public HTML response route (precedent for the consent page)
- `src/http/users.ts:521-539` — token-minting handler shape

### Tests to mirror
- `src/tests/mcp-user-route.test.ts` — full `/mcp-user` HTTP harness
- `src/tests/user-token-routes.test.ts:91-98` — `authedFetch` pattern
- `src/tests/pages-public-json-redirect.test.ts:82-85` — manual-redirect assertion
- `src/tests/mcp-oauth-wrapper.test.ts:315-357` — captured-POST-body assertion

## Design Forks

### Fork A: Access token TTL & shape — **DECIDED: option A2**

Spec says **SHOULD** issue short-lived access tokens; Taras chose "same token re-emitted" (long-lived `aswt_`). The original "return the existing aswt_ verbatim" can't work because we don't keep plaintext (sha256-hashed in `user_tokens`), so we settled on:

> **A2 — Mint a fresh `aswt_` per `/token` call, labeled `oauth:<clientId>` (or `oauth:<clientName>`).**
>
> - Each successful `grant_type=authorization_code` exchange calls `mintToken(userId, "oauth:<clientId>", actor)` (`src/be/users.ts:431-453`) and returns the plaintext as `access_token` in the OAuth response.
> - `expires_in` is returned in the response (e.g. 3600 s) but the `aswt_` itself is long-lived — clients refresh, but no aswt_ ever truly expires server-side until revoked.
> - On `grant_type=refresh_token`: we `revokeToken(oldTokenId, actor)` and `mintToken(...)` a fresh one. The refresh_token is its own opaque value (separate from the access aswt_) stored in a new `mcp_user_oauth_grants` table linking `(refreshToken, userId, clientId, accessTokenId)`. (See §6 — this is a small addition to the schema we hadn't listed.)
> - Audit-clean: the existing tokens table UI (`ui/src/pages/people/[id]/tokens-table.tsx`) shows these rows labeled `oauth:claude-desktop`, etc. Users can revoke them with the same flow as PATs.

Rejected options (kept for context):
1. ~~Return existing `aswt_` verbatim~~ — impossible; no plaintext retained.
3. ~~`aswt-ac_` + `aswt-rt_` prefixes in a new grants table~~ — more spec-faithful, but adds a token kind to the codebase and forces `resolveUserByToken` to learn the new prefix. A2 wins on delta vs. invariant churn.

### Fork B: Audience binding

The spec requires `/mcp-user` to reject tokens whose audience doesn't include itself. With option A2 above, the new `aswt_` rows are indistinguishable from regular user PATs — both grant access to `/mcp-user`. That's actually fine for the chosen design (the "audience" of any `aswt_` is implicitly "anything the user can do"), but it means we technically do NOT bind audience as the spec requires. The fake-OAuth choice subsumes this.

If we want to honor it: add an `audience TEXT` column to `user_tokens` (NULL = all), set it to the resource URL on OAuth-minted rows, and have `mcp-user.ts:22-28` accept only NULL-audience or matching-audience tokens.

### Fork C: Authorize-step UX

Taras chose "paste your aswt_ token" — simplest. Implementation:

- `GET /oauth/authorize?…` returns HTML page with a `<textarea>` for the aswt_, hidden inputs for `client_id`/`redirect_uri`/`state`/`code_challenge`/`code_challenge_method`/`scope`/`resource`.
- `POST /oauth/authorize` validates the pasted aswt_ via `resolveUserByToken`, validates `redirect_uri` against the registered client, generates a code, persists `(code, clientId, userId, redirectUri, codeChallenge, resource, scope, expiresAt)` to `mcp_user_oauth_codes`, redirects to `redirect_uri?code=…&state=…`.

Two sub-questions to iron in conversation:
- **Where does the consent page live?** Inline HTML in `src/http/swarm-oauth.ts` (simplest, single file) or a real route under `ui/` (better UX, more plumbing — ui SPA would need an unauthenticated route)?
- **Branding.** A bare `<textarea>` is jarring. ~30 lines of inline CSS gets us a passable page.

## Decisions Log

All resolved in the in-conversation pass. The implementation plan should treat these as fixed.

| # | Question | Decision | Implication |
|---|---|---|---|
| 1 | **Fork A** — access-token shape | **A2** — `mintToken(userId, "oauth:<clientId>", actor)` on every `/token` call; refresh-grant = `revokeToken(old) + mintToken(new)` | Access token is an `aswt_` in `user_tokens`. Refresh token is opaque, stored in `swarm_oauth_grants`. Audit-clean — OAuth-issued tokens show up in the existing PAT UI labeled `oauth:claude-desktop` etc. |
| 2 | **Fork B** — audience binding on `/mcp-user` | **Skip in v1** | `/mcp-user` accepts any active `aswt_` regardless of issuance path. Spec's audience MUST is satisfied trivially because `aswt_` is implicitly bound to "the whole swarm". Revisit if we ever issue tokens scoped to a single resource. |
| 3 | **Fork C** — consent page UX | **Inline HTML** in `src/http/swarm-oauth.ts` | ~50 LoC of HTML + inline CSS for a textarea + branded styling. No SPA route, no UI build coupling. |
| 4 | DCR posture | **Open, no rate limit** | `POST /oauth/register` accepts any RFC 7591 body. Validates `redirect_uris` are HTTPS or loopback only. No per-IP throttling in v1. Add rate limiting later if abuse appears. |
| 5 | Client auth method | **PKCE-only (`none`)** | `token_endpoint_auth_methods_supported: ["none"]`. No confidential clients. No `client_secret` in DCR response. |
| 6 | `/oauth/revoke` (RFC 7009) | **Include in v1** | ~20 LoC. Lets clients clean up tokens on sign-out. Accepts `token` + `token_type_hint` (`access_token` → revoke the `aswt_`; `refresh_token` → revoke both the `aswt_` and the grant row). |

## Related Research

- `thoughts/taras/research/2026-05-18-user-identity-refactor.md` — the broader user-identity refactor that introduced `users` + `user_tokens` + `user_external_ids`. Context for why `aswt_` exists.
- `thoughts/taras/research/2026-05-21-client-side-mcp-grounding.md` — adjacent: how MCP clients ground server identity. Relevant if we add Client ID Metadata Documents support later.

## Suggested Next Steps

1. ~~Decision pass on Forks A/B/C with Taras~~ — done; see Decisions Log above.
2. **`/desplega:create-plan`** keyed off this research doc to produce the phased implementation plan. Likely phasing:
   - Phase 1: migration `077_swarm_oauth.sql` + DB-queries file `src/be/db-queries/swarm-oauth.ts`.
   - Phase 2: handler `src/http/swarm-oauth.ts` covering `/.well-known/oauth-protected-resource[/mcp-user]`, `/.well-known/oauth-authorization-server`, `POST /oauth/register`, `GET+POST /oauth/authorize`, `POST /oauth/token`, `POST /oauth/revoke`. Inline HTML consent page.
   - Phase 3: `WWW-Authenticate` header on `/mcp-user` 401s (`src/http/mcp-user.ts:9-13`).
   - Phase 4: tests in `src/tests/swarm-oauth.test.ts` covering DCR → authorize → token → /mcp-user happy path + replay + bad PKCE + revoke.
   - Phase 5: docs (`bun run docs:openapi` + a guide in `docs-site/`).
3. Manual E2E: connect Claude Desktop to a local `/mcp-user` via the new OAuth handshake and successfully call `send-task`.
