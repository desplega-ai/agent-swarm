---
id: step-4
name: Authed mode on /p/:id
depends_on: [step-3]
status: done
claimed_by: orchestrator-step-4-2026-05-12
last_updated: 2026-05-12
last_updated_by: orchestrator-step-4-2026-05-12
---

# step-4: Authed mode on `/p/:id`

## Overview

Make `auth_mode='authed'` work end-to-end at the API layer. The cookie + proxy substrate from step-2 already exists; this step (a) narrows the 401 stub in `src/http/pages-public.ts` so a valid `page_session` cookie unlocks `/p/:id` for authed pages, and (b) tightens `POST /api/pages/:id/launch` to enforce that the bearer-presenting caller can launch any page (no per-page ACL in v1 — same trust model as the rest of the API). End-to-end: bearer-curl launches → cookie → curl with cookie → 200; without cookie → 401; the iframe in step-6 will use this flow.

## Changes Required:

#### 1. Cookie verification in `/p/:id`
**File**: `src/http/pages-public.ts` (extend step-3)
**Changes**: When `auth_mode === 'authed'`:
- Parse cookie header for `page_session=...`. If missing → 401.
- `verifyPageSession(token)` → if null → 401.
- If `payload.pageId !== id` → 403. (Cookie scoped to one page id; cross-page reuse rejected.)
- Otherwise serve the body identically to the public case (inject `BROWSER_SDK_JS`, set CSP).
- Same flow for `/p/:id.json` so the SPA can fetch it with cookie attached.

#### 2. Tighten launch endpoint
**File**: `src/http/pages.ts` (extend step-2 launch)
**Changes**: Confirm the launch route:
- Requires bearer auth (already true; default `auth: { apiKey: true }`).
- Looks up the page; 404 if missing.
- For `auth_mode === 'public'`: still issues a cookie (so even public pages can be loaded with cookie context if desired — keeps the path uniform; harmless).
- For `auth_mode === 'authed'`: issues cookie as before.
- For `auth_mode === 'password'`: **rejects** with 400 `{ error: "use ?key= or Basic auth on /p/:id directly" }`. Password mode issues its own cookie in step-5 from the public route.

#### 3. Cookie verification helper inlined or shared
**File**: `src/http/page-proxy.ts` (verify shared helper is reused)
**Changes**: Refactor `verifyPageSession` callers in `page-proxy.ts` and `pages-public.ts` to a single helper `extractAndVerifyCookie(req): {pageId, exp} | null` in `src/utils/page-session.ts`. Helper parses `req.headers.cookie`, splits on `;`, finds `page_session=`, awaits `verifyPageSession`.

#### 4. Tests
**File**: `src/tests/pages-authed-mode.test.ts` (new)
**Changes**:
- Create an authed HTML page.
- `GET /p/:id` without cookie → 401.
- `POST /api/pages/:id/launch` (bearer) → 204 + Set-Cookie.
- `GET /p/:id` with cookie → 200 + SDK injected.
- `GET /p/:id` with cookie for a DIFFERENT page id → 403.
- `GET /p/:id.json` with cookie → 200 + JSON metadata.

**File**: `src/tests/page-proxy-authed.test.ts` (extend step-2's proxy test)
**Changes**: With a cookie for an authed page, `GET /@swarm/api/me` returns the page's agentId.

**File**: `src/tests/launch-password-rejection.test.ts` (new)
**Changes**: Create a password page → POST launch → expect 400 with the "use ?key=" error.

### Success Criteria:

#### Automated Verification:
- [x] New tests pass: `bun test src/tests/pages-authed-mode.test.ts src/tests/page-proxy-authed.test.ts src/tests/launch-password-rejection.test.ts`
- [x] Lint: `bun run lint`
- [x] Typecheck: `bun run tsc:check`
- [x] No new OpenAPI routes; spec stays clean: `bun run docs:openapi && test -z "$(git status --porcelain openapi.json)"`
  - Note: response-only additions (`400` on launch, `403` on `/p/:id` + `/p/:id.json`) are committed. No new paths/operations.

#### Automated QA:
- [x] Full cookie-gated flow via curl, end-to-end:
  ```bash
  curl -sS -X POST http://localhost:3013/api/pages \
    -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
    -d '{"title":"Auth","contentType":"text/html","authMode":"authed","body":"<h1>secret</h1>"}'
  # id=<X>
  curl -sS -i http://localhost:3013/p/<X>   # → 401
  curl -sS -X POST http://localhost:3013/api/pages/<X>/launch \
    -H "Authorization: Bearer 123123" -c /tmp/jar
  curl -sS -b /tmp/jar http://localhost:3013/p/<X>   # → 200 + SDK script
  ```

#### Manual Verification:
- [ ] Open Chrome DevTools, manually set a `page_session` cookie with a hand-rolled invalid signature, reload `/p/:id` → confirm 401 (validates HMAC actually runs, not just presence check).

**Implementation Note**: Commit as `[step-4] authed-mode cookie gate on /p/:id`.
