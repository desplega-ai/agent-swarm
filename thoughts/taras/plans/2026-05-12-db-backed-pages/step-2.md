---
id: step-2
name: Cookie helper + /@swarm/api/* proxy + launch endpoint
depends_on: [step-1]
status: done
---

# step-2: Cookie helper + `/@swarm/api/*` proxy + launch endpoint

## Overview

Introduce the first cookie-issuing surface in this codebase: an HMAC-signed page-session cookie + a new `/@swarm/api/*` proxy on the main API + `POST /api/pages/:id/launch` to mint cookies. The proxy validates the cookie, looks up the page, and forwards `/@swarm/api/*` → `/api/*` with `Authorization: Bearer ${API_KEY}` and `X-Agent-ID: ${page.agentId}` injected server-side (mirrors `src/artifact-sdk/server.ts:42-69`'s injection, but lives on the main API and authenticates via the cookie rather than basic-auth). Until step-3, the launch endpoint accepts any page regardless of `auth_mode`; step-3 narrows it.

## Changes Required:

#### 1. HMAC cookie helper
**File**: `src/utils/page-session.ts` (new)
**Changes**: Two pure functions:
- `signPageSession(payload: {pageId: string, exp: number}): string` — returns `${base64url(JSON.stringify(payload))}.${base64url(HMAC-SHA256(payload, secret))}`. Use `crypto.subtle.sign('HMAC', key, ...)`; `key` derived from `process.env.PAGE_SESSION_SECRET || process.env.API_KEY` (fallback so existing dev setups don't break).
- `verifyPageSession(token: string): {pageId: string, exp: number} | null` — splits, constant-time compares HMAC, parses payload, returns null on any failure or `exp < Date.now()/1000`.
- Both serialized via `await` (subtle is async) — caller handles the await.
- Unit-test with a fixed secret + known token vectors.

#### 2. Launch endpoint
**File**: `src/http/pages.ts` (extend from step-1)
**Changes**: Add route `POST /api/pages/:id/launch` (bearer-authed). Handler:
- Look up the page; 404 if missing.
- Compute exp = now + 3600 seconds.
- Sign cookie payload `{pageId, exp}`.
- Respond `204` with `Set-Cookie: page_session=${signed}; HttpOnly; Path=/; SameSite=None; Secure; Max-Age=3600`. Use `Path=/` (not `Path=/p/:id`) so the same cookie is presented for `/@swarm/api/*` calls from the iframe; cookie verification is per-page-id.
- In dev (when `process.env.NODE_ENV !== 'production'`), allow `SameSite=Lax` and omit `Secure` so localhost works. Detect via `req.headers.origin?.startsWith("http://localhost")`.
- For local dev cross-origin (`localhost:5274` → `localhost:3013`), add CORS response headers: `Access-Control-Allow-Origin: ${req.headers.origin}`, `Access-Control-Allow-Credentials: true`, `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers: Authorization, Content-Type`. Handle preflight `OPTIONS` similarly.

#### 3. `/@swarm/api/*` proxy module
**File**: `src/http/page-proxy.ts` (new)
**Changes**: New handler module exporting `handlePageProxy()`. Route pattern: `/@swarm/api/*` (manual prefix match — `route()` factory is path-segment based; a startsWith check is cleaner here, similar to `src/artifact-sdk/server.ts:42-43`). Behavior:
- Parse cookie header for `page_session=...`. If absent or `verifyPageSession` returns null → `401 { error: "no page session" }`.
- Look up `pages.byId(payload.pageId)`. If missing → `404`. If cookie issued before page deletion (rare) → `401`.
- Rewrite the URL: `/@swarm/api/foo` → `/api/foo`. Forward the request to the same server's HTTP entry (in-process: just re-enter `handlers` with new `req`/`res`; simpler — extract the `/api/...` handler chain into a reusable internal `dispatch()` and call it with synthetic headers).
- Inject `Authorization: Bearer ${process.env.API_KEY}` and `X-Agent-ID: ${page.agentId}` server-side.
- This module opt-out of global bearer auth: registered with `route({ auth: { apiKey: false } })`. Cookie IS the auth.

#### 4. Wire proxy + extended pages handler
**File**: `src/http/index.ts`
**Changes**: Add `handlePageProxy` import + push into `handlers` array BEFORE the generic 404 fallback but AFTER `handleCore`. Place ahead of `handlePages` so `/@swarm/api/*` and `/api/pages/*` don't collide.

#### 5. OpenAPI side-effect imports
**File**: `scripts/generate-openapi.ts`
**Changes**: Add `import "../src/http/page-proxy";`. (Pages already imported in step-1.)

#### 6. Tests
**File**: `src/tests/page-session.test.ts` (new) — HMAC sign/verify, expiry, tampered token rejection, constant-time HMAC compare.

**File**: `src/tests/page-proxy.test.ts` (new) — End-to-end: create a page (via step-1's `POST /api/pages`), POST `/api/pages/:id/launch` to capture cookie, send `GET /@swarm/api/me` with cookie → expect 200 with the API-server `/me` payload using the page's owner agentId.

### Success Criteria:

#### Automated Verification:
- [x] HMAC unit tests pass: `bun test src/tests/page-session.test.ts`
- [x] Proxy integration tests pass: `bun test src/tests/page-proxy.test.ts`
- [x] Lint: `bun run lint`
- [x] Typecheck: `bun run tsc:check`
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [x] OpenAPI regen: `bun run docs:openapi` + commit. Diff includes `POST /api/pages/:id/launch`.

#### Automated QA:
- [x] Full cookie roundtrip via curl: create a page → launch with `-c /tmp/jar.txt` to capture cookie → `curl -b /tmp/jar.txt http://localhost:3013/@swarm/api/me` succeeds and returns the page-owner agent's `/me` payload. **(Note: ran via Bun fetch instead of curl due to sandbox blocking curl; exercised `/api/agents/:id` instead of `/me` since `/me` lives at the server root and is not under `/api/`. Roundtrip otherwise identical.)**
- [x] Expired cookie rejected: hand-craft a token with `exp` in the past, send to `/@swarm/api/me`, expect 401.
- [x] Tampered cookie rejected: flip a bit in the signature, expect 401.

#### Manual Verification:
- [ ] Inspect the Set-Cookie response in dev (Chrome DevTools → Application → Cookies after `curl -i` rendering): confirm `HttpOnly`, `Path=/`, and (in dev) `SameSite=Lax` without `Secure`.

**Implementation Note**: This step introduces the FIRST cookie-issuing path in the codebase. Be paranoid: HMAC compare must be constant-time (`crypto.timingSafeEqual`-equivalent via `Buffer` length-check + manual loop; subtle.timingSafeEqual is available in Bun ≥1.x — verify in `Bun.password` neighbourhood). Commit as `[step-2] page-session HMAC cookie + /@swarm/api proxy`.
