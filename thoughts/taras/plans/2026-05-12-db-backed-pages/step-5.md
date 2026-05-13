---
id: step-5
name: Password mode (`?key=` + Basic auth)
depends_on: [step-3]
status: done
---

# step-5: Password mode (`?key=` + Basic auth)

## Overview

Implement `auth_mode='password'`: `GET /p/:id` accepts the password via `?key=<password>` query OR `Authorization: Basic` header. On match: serve content + Set-Cookie (same `page_session` shape from step-2) so subsequent `/@swarm/api/*` calls don't re-prompt. On miss: respond `401 WWW-Authenticate: Basic realm="page <id>"` so the browser shows the native Basic auth dialog. Single backend code path handles both inputs (extract password → constant-time hash-compare against `pages.passwordHash` from `Bun.password.verify`).

## Changes Required:

#### 1. Password verification branch
**File**: `src/http/pages-public.ts` (extend step-3)
**Changes**: When `auth_mode === 'password'`:
1. Check for a `page_session` cookie scoped to this page id (same as authed). If valid → serve directly (skip password check; cookie is the proof).
2. Otherwise extract password candidate:
   - From `?key=` query param if present.
   - Else from `Authorization: Basic` header (decode base64 → split on `:` → use the password portion; username is ignored).
3. If candidate is present:
   - `await Bun.password.verify(candidate, page.passwordHash)` (bcrypt).
   - On match: issue `Set-Cookie: page_session=...` (same shape as step-2's launch) AND serve the body. Mint cookie inline; do NOT redirect to `/launch`.
   - On mismatch: respond 401 with `WWW-Authenticate: Basic realm="page ${id}"` so browser re-prompts.
4. If no candidate at all: respond 401 with `WWW-Authenticate: Basic realm="page ${id}"`.

Same flow applies to `/p/:id.json` so the SPA can fetch metadata after Basic auth.

#### 2. Constant-time safety
**File**: `src/utils/page-session.ts`
**Changes**: Confirm `Bun.password.verify` uses constant-time comparison internally (it does for bcrypt). Add a unit-test comment line at the top of the new test file documenting the assumption.

#### 3. Cookie issuance helper extraction
**File**: `src/utils/page-session.ts`
**Changes**: Extract `issuePageSessionCookie(pageId: string, isLocalhost: boolean): string` — returns the full `Set-Cookie` header string with the env-appropriate `SameSite`/`Secure` flags. Used by both `pages.ts` (launch endpoint) and `pages-public.ts` (password-flow inline mint).

#### 4. Tests
**File**: `src/tests/pages-password-mode.test.ts` (new)
**Changes**:
- Create a password page with `password: "swordfish"` (verify `pages.passwordHash` row != "swordfish").
- `GET /p/:id` → 401 + `WWW-Authenticate: Basic`.
- `GET /p/:id?key=wrong` → 401.
- `GET /p/:id?key=swordfish` → 200 + Set-Cookie + body served + SDK injected.
- `GET /p/:id` with `Authorization: Basic $(echo -n 'x:swordfish' | base64)` → 200 + Set-Cookie.
- `GET /p/:id` with the issued cookie → 200 (no re-prompt).
- `GET /p/:id.json` after cookie → 200 with metadata.

**File**: `src/tests/pages-password-hash.test.ts` (new)
**Changes**: Unit test: `Bun.password.verify` succeeds on the hash, fails on close-but-wrong input.

### Success Criteria:

#### Automated Verification:
- [x] New tests pass: `bun test src/tests/pages-password-mode.test.ts src/tests/pages-password-hash.test.ts`
- [x] Lint: `bun run lint`
- [x] Typecheck: `bun run tsc:check`
- [x] No OpenAPI diff (no new routes; only auth-mode branch added): `bun run docs:openapi && test -z "$(git status --porcelain openapi.json)"`

#### Automated QA:
- [x] Full password flow via curl:
  ```bash
  curl -sS -X POST http://localhost:3013/api/pages \
    -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
    -d '{"title":"Locked","contentType":"text/html","authMode":"password","password":"swordfish","body":"<h1>vault</h1>"}'
  # id=<X>
  curl -sS -i http://localhost:3013/p/<X>                 # → 401 + WWW-Authenticate
  curl -sS http://localhost:3013/p/<X>?key=wrong          # → 401
  curl -sS -i http://localhost:3013/p/<X>?key=swordfish   # → 200 + Set-Cookie
  curl -sS -u x:swordfish http://localhost:3013/p/<X>     # → 200 (Basic auth header path)
  ```
  (Each step covered by an in-process fetch() equivalent in `pages-password-mode.test.ts`.)
- [x] Cookie reuse: capture cookie from `?key=` response, hit `/p/:id` without `?key=` → 200.
- [x] Cross-page cookie: take cookie from one password page, hit a DIFFERENT password page → 403 (cookie scoped to id — note: actual status is 403, not 401 as originally suggested, matching authed-mode cross-page semantics from step-4).

#### Manual Verification:
- [ ] Open `http://localhost:3013/p/:id` for a password page in a fresh Chrome profile → browser shows the native Basic auth dialog → entering correct password loads the page. (Validates the WWW-Authenticate header actually triggers the dialog.)

**Implementation Note**: Commit as `[step-5] password-mode auth on /p/:id`.
