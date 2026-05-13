---
id: step-3
name: HTTP REST mutations + MCP tool + public /p/:id
depends_on: [step-2]
status: done
---

# step-3: HTTP REST mutations + MCP tool + public `/p/:id`

## Overview

Complete the REST surface on `/api/pages` (PUT with snapshot-before-update, DELETE, GET list, GET versions), add the `create_page` MCP tool (capability-gated by `pages` env flag, NOT yet in DEFAULT_CAPABILITIES — step-9 flips it), and ship the public-facing `/p/:id` + `/p/:id.json` routes that serve `auth_mode='public'` content. HTML gets the `BROWSER_SDK_JS` injected (reused verbatim from `src/artifact-sdk/browser-sdk.ts:2-29`); JSON content always 302-redirects to `${UI_URL}/artifacts/:id` because the JSON renderer lives in the SPA (step-7). Authed/password modes return 401 here — those are gated in step-4 / step-5.

## Changes Required:

#### 1. Extend `src/http/pages.ts`
**File**: `src/http/pages.ts`
**Changes**: Add the remaining REST routes — all bearer-authed:
- `PUT /api/pages/:id` — body is the same shape as POST. Before mutation, call `snapshotPage(id, myAgentId)` inside a `try { … } catch {}` (mirrors `src/http/workflows.ts:483-486, 523-526, 569-572`). Then `updatePage(id, patch)`. Return `{ id, version: <new MAX(version) + 1> }`. **Critical**: snapshot stores PRE-update content (i.e. what was on the parent row BEFORE this call); the parent then takes the new content. New version number is whatever was inserted into `page_versions` plus 1 — actually per the workflow pattern, the version stored in `page_versions` is the OLD content's version. Wait — re-read `src/http/workflows.ts:567` carefully and mirror exactly. The convention is: each update writes a version row containing the PRE-update parent state; that row's `version` = next sequential number. The "current head" is the parent itself. So returning `version` to the caller should mean either (a) the version row just written, or (b) a monotonic counter of how many edits have occurred. **Choose (b) — `MAX(page_versions.version) + 1` after the snapshot, representing "this page has been edited N times"**, and document this in `plugin/skills/pages/skill.md` (step-8).
- `DELETE /api/pages/:id` — `deletePage`; page_versions cascades. Return 204 / 404.
- `GET /api/pages` — `listAllPages(limit, offset)`. Query params `limit` (default 50), `offset` (default 0). Return `{ pages: Array<Page & { app_url: string, api_url: string }>, total: number }`. Each row carries both share-URL pointers (`api_url = ${API_URL}/p/:id`, `app_url = ${UI_URL}/artifacts/:id`) so consumers don't have to reconstruct them. Bearer-authed.
- `GET /api/pages/:id` (update step-1's read route) — extend response with the same `{ ..., app_url, api_url }` pointers.
- `GET /api/pages/:id/versions` — return `{ versions: PageVersion[] }`.
- `GET /api/pages/:id/versions/:version` — return single PageVersion or 404.

#### 2. Public `/p/:id` + `/p/:id.json` routes
**File**: `src/http/pages-public.ts` (new module — keep public surface separate from authed REST for readability)
**Changes**: Two routes, BOTH `route({ auth: { apiKey: false } })`:
- `GET /p/:id` — look up the page; 404 if missing.
  - `auth_mode === 'public'`: ungated.
  - `auth_mode === 'authed'`: return `401 { error: "authed mode requires page-session cookie; visit /artifacts/:id" }`. (step-4 narrows to also accept the cookie.)
  - `auth_mode === 'password'`: same 401 stub. (step-5 narrows to accept `?key=` / Basic.)
  - On success:
    - `contentType === 'text/html'`: respond `200 text/html` with the body wrapped to include `<script>${BROWSER_SDK_JS}</script>` injected immediately after `<head>` (or prepended if no `<head>`). Also inject `<base target="_blank">` so links open outside iframe.
    - `contentType === 'application/json'`: respond `302 Location: ${UI_URL}/artifacts/:id`.
  - Wrap the body response through `scrubSecrets()` (`src/utils/secret-scrubber.ts:197`) ONLY in log paths — NEVER in the actual served body, since the body is agent content. Logged request lines / error paths get scrubbed.
- `GET /p/:id.json` — same auth-mode rules. On success, return `{ id, version: currentVersion, title, description, contentType, authMode, body }` as JSON. Used by the SPA's `/artifacts/:id` renderer (step-6/7).
- Set restrictive CSP: `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self' ${UI_URL}`. The `'unsafe-inline'` is required for `BROWSER_SDK_JS` to execute; mitigated by sandboxed iframe at the SPA layer (step-6 uses `<iframe sandbox="allow-scripts allow-forms">`).

#### 3. MCP tool `create_page`
**File**: `src/tools/create-page.ts` (new — mirror a recent tool, e.g. `src/tools/memory-rate.ts` or `src/tools/store-progress.ts`, NOT the older `create-channel.ts`. The newer tools establish current conventions around `createToolRegistrar`, output shape, `requestInfo.agentId` guarding, structuredContent emission, and `ensure()` instrumentation placement.)
**Changes**:
```ts
createToolRegistrar(server)("create-page", {
  title: "Create or update a page",
  description: "Stores an HTML or JSON page in the swarm and returns shareable URLs. Versions are preserved automatically on update.",
  inputSchema: z.object({
    title: z.string().min(1),
    slug: z.string().optional(),
    body: z.string().min(1),
    contentType: PageContentTypeSchema,
    authMode: PageAuthModeSchema.default("public"),
    password: z.string().optional(),
    description: z.string().optional(),
    needsCredentials: z.array(z.object({name: z.string(), description: z.string()})).optional(),
  }),
  outputSchema: z.object({
    yourAgentId: z.string(),
    id: z.string(),
    version: z.number(),
    app_url: z.string(),
    api_url: z.string(),
  }),
}, async (input, requestInfo) => {
  if (!requestInfo.agentId) throw new Error("agent ID required");
  // upsert by (agentId, slug); if slug omitted, derive from title (kebab-case, fall back to id)
  // hash password if provided
  // call snapshotPage + updatePage on overwrite, or createPage on first-create
  // compute URLs from process.env.API_URL / process.env.UI_URL
});
```

#### 4. Register tool with capability gate
**File**: `src/server.ts`
**Changes**: After the existing capability blocks (`src/server.ts:155-200`), add:
```ts
// Pages capability
if (hasCapability("pages")) {
  registerCreatePageTool(server);
}
```
Do NOT yet add `pages` to `DEFAULT_CAPABILITIES` (`src/server.ts:123`). The tool is only available when the operator opts in via `CAPABILITIES=...,pages`. Step-9 flips the default.

#### 5. Wire public handler
**File**: `src/http/index.ts`
**Changes**: Add `handlePagesPublic` import and entry in `handlers` array, BEFORE `handlePages` and `handlePageProxy` (path prefixes are distinct: `/p/...` vs `/api/pages/...` vs `/@swarm/api/...`, but explicit ordering aids readability).

#### 6. OpenAPI imports
**File**: `scripts/generate-openapi.ts`
**Changes**: Add `import "../src/http/pages-public";`. Run `bun run docs:openapi`, commit `openapi.json` + `docs-site/content/docs/api-reference/**`.

#### 7. Tests
**File**: `src/tests/pages-versioning.test.ts` (new)
**Changes**: PUT three times → expect `page_versions` rows v1, v2, v3 holding pre-update snapshots in order; parent holds final state.

**File**: `src/tests/pages-public-html.test.ts` (new)
**Changes**: Create a public HTML page → GET `/p/:id` → assert response body contains the original HTML AND `<script>` containing `class SwarmSDK`. Assert `Content-Type: text/html` and CSP header present.

**File**: `src/tests/pages-public-json-redirect.test.ts` (new)
**Changes**: Create a public JSON page → GET `/p/:id` → assert `302` with `Location: ${UI_URL}/artifacts/:id`.

**File**: `src/tests/pages-public-authed-401.test.ts` (new)
**Changes**: Create an authed page → GET `/p/:id` → expect 401 (step-4 will flip this).

**File**: `src/tests/create-page-tool.test.ts` (new)
**Changes**: Set `CAPABILITIES=pages,...`, invoke the MCP tool with html input → assert response shape `{id, version, app_url, api_url}` and a row exists in `pages`.

### Success Criteria:

#### Automated Verification:
- [x] All new tests pass: `bun test src/tests/pages-versioning.test.ts src/tests/pages-public-html.test.ts src/tests/pages-public-json-redirect.test.ts src/tests/pages-public-authed-401.test.ts src/tests/create-page-tool.test.ts`
- [x] Existing tests still pass: `bun test`
- [x] Lint: `bun run lint`
- [x] Typecheck: `bun run tsc:check`
- [x] DB-boundary check: `bash scripts/check-db-boundary.sh`
- [x] OpenAPI fresh: `bun run docs:openapi && test -z "$(git status --porcelain openapi.json docs-site/content/docs/api-reference/)"`

#### Automated QA:
- [x] End-to-end public HTML via curl:
  ```bash
  curl -sS -X POST http://localhost:3013/api/pages \
    -H "Authorization: Bearer ${API_KEY:-123123}" -H "Content-Type: application/json" \
    -d '{"title":"Public Report","contentType":"text/html","authMode":"public","body":"<h1>Hi</h1>"}'
  curl -sS http://localhost:3013/p/<id> | grep -q "class SwarmSDK"
  ```
- [x] End-to-end versioning: PUT same id three times with different bodies → `GET /api/pages/<id>/versions` returns 3 rows (descending).
- [x] MCP tool (via stdio transport test harness or `bun run src/cli.tsx call-tool ...` if available): `create_page` returns `{id, version, app_url, api_url}` with URLs containing `/p/` and `/artifacts/` respectively.

#### Manual Verification:
- [ ] Open a public HTML page in Chrome via the `api_url` returned from the MCP tool. Confirm SDK is on `window.SwarmSDK` in DevTools console: `typeof window.SwarmSDK` → `"function"`. (Note: SDK calls will 401 because public pages don't issue cookies — this is the documented v1 behavior.)

**Implementation Note**: This step is the largest. After completion the public HTML path is fully agent-shippable. Authed/password/JSON-rendered paths come next. Commit as `[step-3] HTTP REST CRUD + create_page MCP tool + public /p/:id`.
