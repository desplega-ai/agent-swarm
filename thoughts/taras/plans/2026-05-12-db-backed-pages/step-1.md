---
id: step-1
name: Storage spine
depends_on: []
status: done
---

# step-1: Storage spine

## Overview

Land the `pages` entity end-to-end at the storage layer: two SQL migrations (parent `pages` table + history `page_versions` table), Zod schemas, server-side `db.ts` helpers (full CRUD + `snapshotPage` + version readers), and the two minimum HTTP routes (`POST /api/pages` and `GET /api/pages/:id`) so the slice is curl-able with a bearer token. Mirrors the existing workflow versioning pattern (`src/be/migrations/008_workflow_redesign.sql`, `src/workflows/version.ts:13-44`) so `snapshotPage(id, agentId)` MUST be called **before** `updatePage` writes new state — pre-update content is what's frozen in `page_versions`, not the new content.

## Changes Required:

#### 1. SQL migration — parent table

**Note on `body` semantics**: `body` stores the agent-emitted content verbatim. For `contentType='text/html'`, callers MAY pass either a fragment (`<h1>hi</h1>`) or a full document (`<!doctype html>...<html>...`). Step-3's `/p/:id` serving logic detects `<head>` and injects `BROWSER_SDK_JS` after it; if absent, it prepends the script. For `contentType='application/json'`, callers pass a JSON-render-compatible spec as a string (parsed at render time by step-7's renderer).

**File**: `src/be/migrations/059_pages.sql`
**Changes**: Create `pages` table.
```sql
CREATE TABLE pages (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agentId      TEXT NOT NULL,
  slug         TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  contentType  TEXT NOT NULL CHECK (contentType IN ('text/html','application/json')),
  authMode     TEXT NOT NULL DEFAULT 'public' CHECK (authMode IN ('public','authed','password')),
  passwordHash TEXT,
  body         TEXT NOT NULL,
  needsCredentials TEXT,  -- JSON array, reserved for follow-up; renderer ignores in v1
  createdAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agentId, slug)
);
CREATE INDEX idx_pages_agentId ON pages(agentId);
CREATE INDEX idx_pages_updatedAt ON pages(updatedAt DESC);
```

#### 2. SQL migration — history table
**File**: `src/be/migrations/060_page_versions.sql`
**Changes**: Create `page_versions` table.
```sql
CREATE TABLE page_versions (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  pageId              TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  snapshot            TEXT NOT NULL,  -- JSON: PageSnapshot
  changedByAgentId    TEXT,
  createdAt           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (pageId, version)
);
CREATE INDEX idx_page_versions_pageId ON page_versions(pageId);
```

#### 3. Zod schemas + types
**File**: `src/types.ts`
**Changes**: Add (placement next to `WorkflowSchema` / `WorkflowVersionSchema` near `src/types.ts:1042-1088`):
- `PageContentTypeSchema = z.enum(['text/html','application/json'])`
- `PageAuthModeSchema = z.enum(['public','authed','password'])` — mirrors `AgentTaskSourceSchema` pattern (`src/types.ts:56-70`); MUST be kept in sync with SQL `CHECK` constraint.
- `PageSnapshotSchema` — `{title, description?, contentType, authMode, passwordHash?, body, needsCredentials?}`. Omits id/agentId/slug/timestamps (these don't change across versions for a given page id).
- `PageSchema` — full parent row shape.
- `PageVersionSchema` — `{id, pageId, version, snapshot: PageSnapshotSchema, changedByAgentId?, createdAt}`.

#### 4. DB helpers
**File**: `src/be/db.ts`
**Changes**: Add a new section (after the workflow helpers). All functions are synchronous (`bun:sqlite`), import-only inside the API server (architecture invariant — verified by `scripts/check-db-boundary.sh`).
- `createPage(input: {agentId, slug, title, description?, contentType, authMode, passwordHash?, body, needsCredentials?}): Page` — single INSERT … RETURNING.
- `getPage(id: string): Page | null`
- `getPageBySlug(agentId: string, slug: string): Page | null`
- `listPagesByAgent(agentId: string, limit?, offset?): Page[]` — ORDER BY updatedAt DESC.
- `listAllPages(limit?, offset?): Page[]` — for the future swarm-wide listing UI (step-8).
- `updatePage(id: string, patch: Partial<UpdatablePageFields>): Page` — dynamic UPDATE; bumps `updatedAt`. Does NOT snapshot — caller must call `snapshotPage` first (mirrors workflow pattern).
- `deletePage(id: string): boolean` — cascades to page_versions via FK.
- `createPageVersion(input: {pageId, version, snapshot, changedByAgentId?}): PageVersion`
- `getPageVersions(pageId: string): PageVersion[]` — ORDER BY version DESC.
- `getPageVersion(pageId: string, version: number): PageVersion | null`

#### 5. `snapshotPage` helper
**File**: `src/pages/version.ts` (new module — mirrors `src/workflows/version.ts:13-44`)
**Changes**: Export `snapshotPage(pageId: string, agentId?: string)` that reads current parent state, builds a `PageSnapshot`, computes `nextVersion = (MAX(version) || 0) + 1`, and calls `createPageVersion`. Throws on missing parent. Caller catches and swallows (matches workflow pattern at `src/http/workflows.ts:484-486`).

#### 6. Minimal HTTP routes
**File**: `src/http/pages.ts` (new module)
**Changes**: Use the `route()` factory (`src/http/route-def.ts:84-142`). Default `auth: { apiKey: true }` (bearer required). Add two routes for this slice:
- `POST /api/pages` — body `{slug?, title, description?, contentType, authMode, password?, body, needsCredentials?}`. If `slug` omitted, generate from `title` via a kebab-case helper. If `password` provided, hash via `Bun.password.hash(password, 'bcrypt')` before storing as `passwordHash`. Returns `201 { id, version: 1 }` (no app_url/api_url yet — step-3 adds those).
- `GET /api/pages/:id` — returns the full Page row as JSON. 404 if not found.
- Export `handlePages()` dispatcher; follow workflow dispatcher shape (`src/http/workflows.ts:306-312, 439-452`).

#### 7. Wire handler into the HTTP entry point
**File**: `src/http/index.ts`
**Changes**: Import `handlePages` (line ~20-55 region), add to the central `handlers` array (`index.ts:122-158`).

#### 8. OpenAPI generator import
**File**: `scripts/generate-openapi.ts`
**Changes**: Add `import "../src/http/pages";` (the side-effect import that triggers `route()` registrations).

#### 9. Tests
**File**: `src/tests/pages-storage.test.ts` (new)
**Changes**: Unit tests against a fresh in-memory `bun:sqlite` db that applies migrations:
- create → get → list → updates increment via snapshot → delete cascades to versions.
- `snapshotPage` orders correctly: pre-update content lives in v1; post-update lives in parent.
- `UNIQUE(agentId, slug)` enforced.
- Password hash not equal to plaintext.

**File**: `src/tests/pages-http.test.ts` (new)
**Changes**: Boot the HTTP server with a fresh DB; bearer-curl POST `/api/pages` then GET `/api/pages/:id` end-to-end.

### Success Criteria:

#### Automated Verification:
- [x] Migrations apply cleanly on a fresh DB: `rm -f /tmp/test-pages.sqlite && DATABASE_PATH=/tmp/test-pages.sqlite bun run start:http` boots without error (Ctrl-C to stop)
- [x] Migrations apply cleanly on an existing DB: `bun run start:http` on the dev DB applies 059 + 060 idempotently (the migration runner is forward-only — already applied migrations skip; re-run is a no-op)
- [x] Schema test: `bun test src/tests/pages-storage.test.ts`
- [x] HTTP test: `bun test src/tests/pages-http.test.ts`
- [x] Lint: `bun run lint`
- [x] Typecheck: `bun run tsc:check`
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [x] OpenAPI regen produces a diff covering `POST /api/pages` + `GET /api/pages/:id`; commit it: `bun run docs:openapi && git diff --stat openapi.json`

#### Automated QA:
- [x] Agent-driven end-to-end via curl: start server (`bun run start:http`), then
  ```bash
  curl -sS -X POST http://localhost:3013/api/pages \
    -H "Authorization: Bearer ${API_KEY:-123123}" \
    -H "Content-Type: application/json" \
    -d '{"title":"Hello","contentType":"text/html","authMode":"public","body":"<h1>hi</h1>"}'
  # Or a full document: -d '{"title":"Full Doc","contentType":"text/html","authMode":"public","body":"<!doctype html><html><head><title>x</title></head><body><h1>hi</h1></body></html>"}'
  # → {"id":"<hex>","version":1}
  curl -sS http://localhost:3013/api/pages/<id> -H "Authorization: Bearer ${API_KEY:-123123}"
  # → full Page row JSON
  ```
- [x] Snapshot-before-update: re-POST with same slug (or use a manual UPDATE via test helper), confirm `page_versions` has v1 with PRE-update content.

#### Manual Verification:
- [ ] Visually inspect the generated OpenAPI diff to confirm route shape, schemas, and `tags: ['pages']` are sensible.

**Implementation Note**: This step is a vertical slice (DB + types + helpers + 2 HTTP routes + tests). After completing, pause for manual confirmation. If commit-per-step is enabled, commit as `[step-1] storage spine for db-backed pages`.
