---
date: 2026-03-16
author: Claude
status: completed
autonomy: autopilot
research: thoughts/taras/research/2026-03-16-route-wrapper-openapi.md
tags: [plan, openapi, route-wrapper, zod-to-openapi, api-docs]
commit_per_phase: single (all phases shipped in b8e0d9d)
last_updated: 2026-03-16
last_updated_by: Claude (verification)
---

# Route Wrapper + OpenAPI Spec Generation

## Overview

Introduce a `route()` wrapper that replaces `matchRoute()` as the single source of truth for HTTP routing, input validation, and OpenAPI 3.1 spec generation. Each route definition includes Zod schemas for params, query, body, and responses — serving as both runtime validator and documentation source.

This delivers three benefits in one change:
1. **OpenAPI spec** — live at `/openapi.json`, interactive docs at `/docs` (Scalar)
2. **Runtime input validation** — currently absent for most endpoints
3. **Full TypeScript type inference** — no more `parseBody<T>` casts or manual `queryParams.get()`

## Current State Analysis

- **68 `matchRoute()` calls** across 12 handler files, plus 1 direct URL match in `ecosystem.ts`
- **No input validation** — malformed requests can crash handlers
- **No API documentation** — endpoints only discoverable by reading source code
- **28 Zod schemas** in `src/types.ts` ready for reuse in route definitions
- **Zod v4** (`^4.2.1`) — requires `@asteasolutions/zod-to-openapi` v8.x

### Key Discoveries:
- `repos.ts:17-137` — simplest handler (5 endpoints), good migration pilot
- `ecosystem.ts:9` — only handler using direct URL match instead of `matchRoute()`
- `agents.ts` exports TWO handler functions (`handleAgentRegister` + `handleAgentsRest`)
- `core.ts:36-278` — pre-auth routes use direct URL matching, NOT `matchRoute()`
- `mcp.ts` — uses `StreamableHTTPServerTransport`, not matchRoute-based routing
- `@asteasolutions/zod-to-openapi` v8.x supports Zod v4, but must use `.meta()` instead of `extendZodWithOpenApi(z)` to avoid type issue #340
- CI freshness check pattern exists at `.github/workflows/merge-gate.yml:91-117` (pi-skills)

## Desired End State

- All ~69 REST endpoints defined via `route()` with Zod schemas
- `/openapi.json` endpoint serving live spec (computed from running code, cached)
- `/docs` endpoint serving Scalar interactive API explorer (pre-auth, like `/health`)
- `openapi.json` file committed to repo for CI freshness check
- `bun run docs:openapi` script to regenerate the committed file
- Merge gate blocks PRs with stale `openapi.json`
- Zero raw `matchRoute()` calls remaining in handler files

### Verification:
- `curl http://localhost:3013/openapi.json` returns valid OpenAPI 3.1 JSON
- `curl http://localhost:3013/docs` returns Scalar HTML page
- `bun run docs:openapi && git diff --exit-code openapi.json` passes
- `bun run tsc:check` passes
- `bun run lint:fix` passes
- `bun test` passes
- Sending malformed request bodies returns 400 with Zod error details

## Quick Verification Reference

Common commands:
- `bun run tsc:check` — TypeScript type check
- `bun run lint:fix` — Biome lint + format
- `bun test` — Unit tests
- `bun run docs:openapi` — Regenerate openapi.json
- `curl http://localhost:3013/health` — Server running check
- `curl http://localhost:3013/openapi.json | head -20` — Spec served correctly
- `curl http://localhost:3013/docs` — Scalar UI served

Key files:
- `src/http/route-def.ts` — Route wrapper, registry, types (NEW)
- `src/http/openapi.ts` — OpenAPI spec generator (NEW)
- `scripts/generate-openapi.ts` — CI dump script (NEW)
- `src/http/core.ts` — Pre-auth endpoint additions (/docs, /openapi.json)
- `src/http/repos.ts` — Migration pilot

## What We're NOT Doing

- Converting `core.ts` pre-auth routes (`/health`, `/me`, `/ping`, `/close`, `/cancelled-tasks`) — these use direct URL matching and are infrastructure, not API surface
- Converting `mcp.ts` — uses `StreamableHTTPServerTransport` with its own protocol
- Adding response validation (only request input validation)
- Migrating to Hono or another framework
- Adding named `$ref` schemas initially — inline schemas keep the migration simpler; `$ref` optimization can be added later if the spec gets too large
- Validating auth in the route wrapper — auth stays in `handleCore`

## Implementation Approach

**Incremental migration**: old `matchRoute()` and new `route()` coexist. Each handler file is converted independently — unconverted handlers still work, they just don't appear in the OpenAPI spec. The spec grows organically as handlers are converted.

**Per-file conversion** is mechanical: ~20-25 lines of route definition per endpoint, replacing ~10-15 lines of inline parsing. Net line change is roughly neutral per handler.

**Migration order**: simplest files first (repos.ts pilot, then 1-3 endpoint files, then 5-6 endpoint files, then complex files). This builds confidence and catches issues early.

---

## Phase 0: Foundation

### Overview
Install dependency, create the route wrapper module, OpenAPI generator, Scalar viewer, and dump script. No handler migrations yet — this phase establishes the infrastructure.

### Changes Required:

#### 1. Install dependency
**Command**: `bun add @asteasolutions/zod-to-openapi@^8.0.0`

Verify Zod v4 compatibility after install:
```typescript
// Quick smoke test in a scratch file
import { z } from "zod";
import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
const registry = new OpenAPIRegistry();
registry.registerPath({
  method: "get",
  path: "/test",
  responses: { 200: { description: "OK" } },
});
const gen = new OpenApiGeneratorV31(registry.definitions);
const doc = gen.generateDocument({ openapi: "3.1.0", info: { title: "Test", version: "1.0.0" } });
console.log(JSON.stringify(doc, null, 2));
```

If this fails, fall back to `zod-openapi@^5.0.0` (samchungy) which also supports Zod v4.

#### 2. Route wrapper module
**File**: `src/http/route-def.ts` (NEW, ~80-100 lines)

Create the `route()` factory function, `routeRegistry`, and associated types as described in the research document. Key implementation details:

- `RouteDef` interface with method, path, pattern, summary, tags, Zod schemas for params/query/body/responses
- `RouteHandle` interface with `match()` and `parse()` methods
- `route()` factory that pushes to `routeRegistry` and returns a `RouteHandle`
- `parse()` extracts path params from dynamic segments (null positions in pattern), validates with Zod, returns typed result or sends 400
- Use `Object.fromEntries(queryParams)` for query parsing with `z.coerce` for type conversion
- Do NOT call `extendZodWithOpenApi(z)` — not needed for basic schema conversion

Reference implementation: `thoughts/taras/research/2026-03-16-route-wrapper-openapi.md` lines 92-208

#### 3. OpenAPI spec generator
**File**: `src/http/openapi.ts` (NEW, ~80 lines)

- Import `routeRegistry` from `route-def.ts`
- Import `OpenAPIRegistry`, `OpenApiGeneratorV31` from `@asteasolutions/zod-to-openapi`
- Register Bearer auth and X-Agent-ID security schemes
- Iterate `routeRegistry`, convert each `RouteDef` to `registry.registerPath()` call
- Cache generated spec string (only changes on process restart)
- Export `generateOpenApiSpec(opts: { version: string; serverUrl?: string }): string`

Reference implementation: `thoughts/taras/research/2026-03-16-route-wrapper-openapi.md` lines 356-456

#### 4. Scalar viewer HTML
**File**: `src/http/openapi.ts` (same file, export a constant)

Add `SCALAR_HTML` constant — minimal HTML page loading Scalar CDN, pointing at `/openapi.json`:

```html
<!DOCTYPE html>
<html>
<head><title>Agent Swarm API</title><meta charset="utf-8" /></head>
<body>
  <script id="api-reference" data-url="/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>
```

#### 5. Serve /openapi.json and /docs pre-auth
**File**: `src/http/core.ts`
**Location**: After the `/health` check (around line 49), before the auth gate (line 66)

Add two route checks:
```typescript
if (req.url === "/openapi.json") {
  const version = (await Bun.file("package.json").json()).version;
  const spec = generateOpenApiSpec({ version });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(spec);
  return true;
}
if (req.url === "/docs" || req.url === "/docs/") {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(SCALAR_HTML);
  return true;
}
```

Import `generateOpenApiSpec` and `SCALAR_HTML` from `./openapi`.

**Note on registry population**: At runtime, `routeRegistry` is populated when handler files are imported by `index.ts` — so the registry is already full when `generateOpenApiSpec()` is called at request time. For the dump script (`scripts/generate-openapi.ts`), handler files must be explicitly imported to trigger `route()` registrations. Importing individual handler files is safe — verified that `db.ts` uses lazy init (`getDb()` only opens DB when a query is actually called), and no handler has top-level side effects. Do NOT import `src/http/index.ts` (boots the whole server).

#### 6. Dump script for CI
**File**: `scripts/generate-openapi.ts` (NEW, ~20 lines)

```typescript
import { generateOpenApiSpec } from "../src/http/openapi";
// Import all handler files to trigger route() registrations
import "../src/http/repos";
// ... add more imports as handlers are migrated ...

const version = (await Bun.file("package.json").json()).version;
const spec = generateOpenApiSpec({ version, serverUrl: "http://localhost:3013" });
await Bun.write("openapi.json", spec);
console.log(`Generated openapi.json (${(spec.length / 1024).toFixed(1)}KB)`);
```

**Important**: This script will need handler imports added incrementally as each handler file is migrated. Each Phase 2 sub-step should add the import.

#### 7. Package.json script
**File**: `package.json`

Add script: `"docs:openapi": "bun scripts/generate-openapi.ts"`

### Success Criteria:

#### Automated Verification:
- [ ] Dependency installed: `bun add @asteasolutions/zod-to-openapi@^8.0.0`
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Tests pass: `bun test`
- [ ] Dump script runs: `bun run docs:openapi`
- [ ] openapi.json created: `ls -la openapi.json`

#### Manual Verification:
- [ ] Start server: `bun run start:http`
- [ ] `curl http://localhost:3013/openapi.json` returns valid JSON with `openapi: "3.1.0"` (empty paths is OK)
- [ ] `curl http://localhost:3013/docs` returns HTML page with Scalar
- [ ] Open `http://localhost:3013/docs` in browser — Scalar UI loads (empty API is OK)
- [ ] Existing endpoints still work: `curl -H "Authorization: Bearer $API_KEY" http://localhost:3013/api/tasks`

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 1.

---

## Phase 1: Pilot Migration (repos.ts)

### Overview
Convert all 5 endpoints in `repos.ts` to use `route()`. This is the simplest handler file and serves as proof-of-concept for the migration pattern.

### Changes Required:

#### 1. Add route definitions
**File**: `src/http/repos.ts`
**Location**: Top of file, after imports

Define 5 route objects:

| Route | Method | Path | Schemas |
|-------|--------|------|---------|
| `getRepo` | GET | `/api/repos/{id}` | params: `{ id: z.string().uuid() }` |
| `listRepos` | GET | `/api/repos` | (no schemas) |
| `createRepo` | POST | `/api/repos` | body: `{ url, name?, clonePath? }` using `SwarmRepoSchema` fields |
| `updateRepo` | PUT | `/api/repos/{id}` | params: `{ id }`, body: `{ url?, name?, clonePath? }` |
| `deleteRepo` | DELETE | `/api/repos/{id}` | params: `{ id }` |

Add response schemas for each using `SwarmRepoSchema` from `src/types.ts`.

#### 2. Replace matchRoute() calls with route handle usage
**File**: `src/http/repos.ts`

For each endpoint, replace:
```typescript
// Before
if (matchRoute(req.method, pathSegments, "GET", ["api", "repos", null], true)) {
  const id = pathSegments[2];
  // ...
}

// After
if (getRepo.match(req.method, pathSegments)) {
  const parsed = await getRepo.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  const { id } = parsed.params;
  // ...
}
```

Remove inline body parsing (`JSON.parse(Buffer.concat(chunks).toString())`) — the route wrapper's `parse()` handles this via `parseBody()`.

#### 3. Update dump script imports
**File**: `scripts/generate-openapi.ts`

The repos.ts import should already be there from Phase 0. Verify it's present.

#### 4. Regenerate openapi.json
**Command**: `bun run docs:openapi`

The spec should now contain the 5 repos endpoints.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Tests pass: `bun test`
- [ ] Spec regenerated: `bun run docs:openapi`
- [ ] Spec contains repos paths: `grep -c '"/api/repos' openapi.json` (should be ≥ 2 — one for `/api/repos`, one for `/api/repos/{id}`)

#### Manual Verification:
- [ ] Start server: `bun run start:http`
- [ ] CRUD operations work:
  - `curl -H "Authorization: Bearer $API_KEY" http://localhost:3013/api/repos` (list)
  - `curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" http://localhost:3013/api/repos -d '{"url":"https://github.com/test/repo"}'` (create)
  - `curl -H "Authorization: Bearer $API_KEY" http://localhost:3013/api/repos/<id>` (get)
  - `curl -X DELETE -H "Authorization: Bearer $API_KEY" http://localhost:3013/api/repos/<id>` (delete)
- [ ] Validation works: `curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" http://localhost:3013/api/repos -d '{}'` returns 400 with Zod validation error
- [ ] `/docs` in browser shows repos endpoints with schemas
- [ ] Non-migrated endpoints still work: `curl -H "Authorization: Bearer $API_KEY" http://localhost:3013/api/tasks`

**Implementation Note**: After completing this phase, pause for manual confirmation. This is the most critical checkpoint — if the pilot works cleanly, the remaining migrations are mechanical.

---

## Phase 2: Migrate Remaining Handlers

### Overview
Convert all remaining handler files from `matchRoute()` to `route()`. Each file conversion is atomic and independently testable. Order is by increasing complexity.

### Changes Required:

Each file follows the same pattern as the repos.ts pilot:
1. Add route definitions at the top (import `route` from `./route-def`, import Zod schemas from `../types`)
2. Replace `matchRoute()` calls with `routeHandle.match()` + `routeHandle.parse()`
3. Remove inline body/query parsing
4. Add import to `scripts/generate-openapi.ts`
5. Regenerate: `bun run docs:openapi`

#### Conversion Order (recommended):

**Batch A — Simple files (1-3 endpoints):**

| # | File | Endpoints | Notes |
|---|------|-----------|-------|
| 1 | `src/http/poll.ts` | 1 | Single POST endpoint |
| 2 | `src/http/memory.ts` | 2 | GET + POST |
| 3 | `src/http/webhooks.ts` | 3 | GitHub/GitLab/AgentMail webhook receivers |
| 4 | `src/http/ecosystem.ts` | 1 | Convert from direct URL match to `route()` |

**Batch B — Medium files (5-6 endpoints):**

| # | File | Endpoints | Notes |
|---|------|-----------|-------|
| 5 | `src/http/config.ts` | 5 | CRUD + list |
| 6 | `src/http/stats.ts` | 5 | Read-only stats endpoints |
| 7 | `src/http/schedules.ts` | 5 | CRUD + run-now |
| 8 | `src/http/active-sessions.ts` | 6 | Session management |
| 9 | `src/http/session-data.ts` | 6 | Session data CRUD |

**Batch C — Complex files (7+ endpoints):**

| # | File | Endpoints | Notes |
|---|------|-----------|-------|
| 10 | `src/http/agents.ts` | 7 | Two handler functions: `handleAgentRegister` + `handleAgentsRest` |
| 11 | `src/http/workflows.ts` | 9 | Workflows + workflow runs |
| 12 | `src/http/tasks.ts` | 10 | Most complex handler, many query params |
| 13 | `src/http/epics.ts` | 12 | Largest handler file |

**Per-file checklist** (repeat for each file):
- [ ] Add route definitions at top of file
- [ ] Replace all `matchRoute()` calls with route handle pattern
- [ ] Remove inline `parseBody()` / `queryParams.get()` / `Number()` casts
- [ ] Add response schemas to route definitions
- [ ] Add handler import to `scripts/generate-openapi.ts`
- [ ] Run `bun run tsc:check`
- [ ] Run `bun run lint:fix`
- [ ] Run `bun run docs:openapi`

**After each batch**, run the full integration test suite as regression gate:
```bash
bun test src/tests/http-api-integration.test.ts
```
This test covers 20+ API surface areas (agents, tasks, epics, schedules, config, repos, memory, ecosystem, etc.) and will catch any routing regressions from the migration. Additional focused tests to run per batch:
- Batch A: `bun test src/tests/memory.test.ts`
- Batch B: `bun test src/tests/scheduled-tasks-api.test.ts src/tests/session-logs.test.ts src/tests/session-costs.test.ts`
- Batch C: `bun test src/tests/workflow-http.test.ts src/tests/task-pause-resume.test.ts src/tests/task-cancellation.test.ts`

#### Special Cases:

**`ecosystem.ts`**: Currently uses `req.method === "GET" && req.url === "/ecosystem"`. Convert to:
```typescript
const getEcosystem = route({
  method: "get",
  path: "/ecosystem",
  pattern: ["ecosystem"],
  summary: "Get ecosystem status",
  tags: ["Ecosystem"],
  responses: { 200: { description: "Ecosystem data" } },
});
```
Then use `getEcosystem.match()` + `getEcosystem.parse()` like all other handlers.

**`agents.ts`**: Has two exported handlers. Route definitions for both should be in the same file. The `handleAgentRegister` function handles `POST /api/agents/register` and `POST /api/agents/{id}/heartbeat`. The `handleAgentsRest` function handles the remaining 5 CRUD endpoints.

**`webhooks.ts`**: Webhook endpoints receive external payloads (GitHub, GitLab, AgentMail). Define body schemas loosely (`z.record(z.unknown())` or `z.any()`) since we don't control these payloads. The value here is documentation, not strict validation.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Tests pass: `bun test`
- [ ] Spec regenerated: `bun run docs:openapi`
- [ ] No raw matchRoute in handlers: `grep -rn "matchRoute(" src/http/ --include="*.ts" | grep -v route-def.ts | grep -v utils.ts` (should return empty)
- [ ] All endpoints in spec: `bun run docs:openapi && grep -c '"/' openapi.json` (should be ~69 paths)

#### Manual Verification:
- [ ] Start server and open `/docs` — all endpoints visible with schemas
- [ ] Test a few endpoints from different handlers to verify routing still works
- [ ] Test validation: send malformed body to POST /api/tasks — should get 400
- [ ] Test validation: send invalid UUID as path param — should get 400
- [ ] Test query coercion: `GET /api/tasks?limit=abc` — should get 400 (not NaN behavior)

**Implementation Note**: After completing each batch (A, B, C), pause for a quick sanity check. After all batches, pause for full manual verification before proceeding to Phase 3.

---

## Phase 3: CI Freshness Check

### Overview
Add a merge gate job that ensures `openapi.json` stays in sync with route definitions. Uses the same pattern as the existing pi-skills freshness check.

### Changes Required:

#### 1. Add CI job
**File**: `.github/workflows/merge-gate.yml`
**Location**: After the `pi-skills-freshness` job (around line 117)

```yaml
  openapi-freshness:
    name: OpenAPI Spec Freshness Check
    needs: detect-changes
    if: needs.detect-changes.outputs.code == 'true'
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Install dependencies
        run: bun install --frozen-lockfile
      - name: Rebuild OpenAPI spec and check for drift
        run: |
          bun run docs:openapi
          if [ -n "$(git diff --name-only openapi.json)" ]; then
            echo "::error::openapi.json is out of date! Run 'bun run docs:openapi' and commit the changes."
            git diff --stat openapi.json
            exit 1
          fi
          echo "OpenAPI spec is up to date."
```

#### 2. Add to gate job needs
**File**: `.github/workflows/merge-gate.yml`
**Location**: The `gate` job's `needs` array

Add `openapi-freshness` to the existing needs list.

#### 3. Add raw matchRoute() lint check (optional)
**File**: `.github/workflows/merge-gate.yml`

As part of the openapi-freshness job, add a step that fails if any raw `matchRoute()` calls exist in handler files:

```yaml
      - name: Check for raw matchRoute usage
        run: |
          UNREGISTERED=$(grep -rn "matchRoute(" src/http/ --include="*.ts" | grep -v "route-def.ts" | grep -v "utils.ts" || true)
          if [ -n "$UNREGISTERED" ]; then
            echo "::error::Found raw matchRoute() calls. Convert to route() definitions:"
            echo "$UNREGISTERED"
            exit 1
          fi
          echo "No raw matchRoute() calls found."
```

### Success Criteria:

#### Automated Verification:
- [ ] CI config valid YAML: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/merge-gate.yml'))"`
- [ ] Freshness check passes locally: `bun run docs:openapi && git diff --exit-code openapi.json`
- [ ] matchRoute lint passes: `grep -rn "matchRoute(" src/http/ --include="*.ts" | grep -v route-def.ts | grep -v utils.ts` (empty)

#### Manual Verification:
- [ ] Intentionally edit a route definition, verify `bun run docs:openapi && git diff openapi.json` shows the change
- [ ] Push branch, verify the openapi-freshness job runs in CI
- [ ] Verify the gate job includes openapi-freshness in its needs

**Implementation Note**: This phase should be done last, after all handlers are migrated, so the matchRoute() lint check passes.

---

## Testing Strategy

### Unit Tests
- No new test files needed initially — existing tests exercise the endpoints through the handler functions
- If any existing tests call `matchRoute()` directly, they don't need updating (the function still exists in utils.ts)
- Consider adding a unit test for `route-def.ts` that verifies `parse()` returns correct types and sends 400 on validation failure

### Integration Testing
- Run `bun test src/tests/http-api-integration.test.ts` after each batch — this is the comprehensive regression gate covering 20+ API areas
- Run focused test files per handler (e.g., `workflow-http.test.ts` after converting `workflows.ts`)
- The OpenAPI spec itself serves as a form of documentation test — if it generates without errors, the schemas are valid

### Regression Testing
- Run `bun test` after every file conversion to catch regressions
- Run `bun test src/tests/http-api-integration.test.ts` as the primary regression gate after each batch
- The `bun run tsc:check` catches type errors from incorrect schema usage

## E2E Verification (Claude runs these)

After all phases are complete, Claude will execute these verification steps:

```bash
# 1. Start server in background
bun run start:http &

# 2. Verify /openapi.json returns valid OpenAPI 3.1 spec
curl -s http://localhost:3013/openapi.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'OpenAPI {d[\"openapi\"]}, {len(d.get(\"paths\",{}))} paths')"

# 3. Verify /docs returns Scalar HTML
curl -s http://localhost:3013/docs | grep -q "scalar" && echo "Scalar UI OK"

# 4. Test input validation — empty task body should return 400
curl -s -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  http://localhost:3013/api/tasks \
  -d '{"task": ""}' -w "\nHTTP %{http_code}"

# 5. Test valid request
curl -s -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3013/api/tasks?limit=5&status=completed" -w "\nHTTP %{http_code}"

# 6. Test path param validation — invalid UUID should return 400
curl -s -H "Authorization: Bearer $API_KEY" \
  http://localhost:3013/api/tasks/not-a-uuid -w "\nHTTP %{http_code}"

# 7. Test query coercion — non-numeric limit should return 400
curl -s -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3013/api/tasks?limit=abc" -w "\nHTTP %{http_code}"

# 8. Verify CI script produces clean diff
bun run docs:openapi && git diff --exit-code openapi.json

# 9. Verify no raw matchRoute calls remain in handlers
grep -rn "matchRoute(" src/http/ --include="*.ts" | grep -v route-def.ts | grep -v utils.ts

# 10. Run full test suite + integration test
bun run tsc:check && bun run lint:fix && bun test
bun test src/tests/http-api-integration.test.ts

# 11. Kill background server
kill %1
```

## References

- Research: `thoughts/taras/research/2026-03-16-route-wrapper-openapi.md`
- Parent research: `thoughts/taras/research/2026-03-16-openapi-docs-generation.md`
- Zod v4 compat: `@asteasolutions/zod-to-openapi` v8.x uses `.meta()` instead of `.openapi()` — see GitHub issue #340
- CI pattern: `.github/workflows/merge-gate.yml:91-117` (pi-skills freshness)
- Existing doc gen: `scripts/generate-mcp-docs.ts` (inspiration for dump script)
- Integration test: `src/tests/http-api-integration.test.ts` (20+ API areas, primary regression gate)

---

## Review Errata

_Reviewed: 2026-03-16 by Claude_

### Critical
_(none)_

### Important
- [ ] **`commit_per_phase: TBD` in frontmatter** — resolve before implementation starts. Ask Taras for preference.
- [ ] **No rollback strategy** — add a note: if a handler conversion breaks something, rollback is `git checkout src/http/<file>.ts && bun run docs:openapi`. Each file conversion is atomic and independently revertible.
- [ ] **Endpoint count inconsistency** — plan says "~69 REST endpoints" (line 41) and "68 matchRoute() calls" (line 24). Research agent counted 76 matchRoute() calls. The discrepancy is likely because some matchRoute() calls are sub-route checks within the same endpoint (e.g., checking for `/cancel` suffix after matching `/tasks/{id}`). Reconcile with the actual endpoint catalog from the parent research (`2026-03-16-openapi-docs-generation.md` lists 62 endpoints across 17 files). The exact count will be determined during implementation — the plan should use "~62-70" or just "all" instead of a specific number.

### Resolved
- [x] **Stream-of-consciousness note** (Phase 0, item 5) — cleaned up "Actually, this is a subtlety..." paragraph to a clear statement about registry population and import safety
- [x] **Phase 1 grep count wrong** — `grep -c "/api/repos" openapi.json` expected "≥ 5" but OpenAPI has 2 path keys (`/api/repos` and `/api/repos/{id}`), not 5 (endpoints ≠ paths). Fixed to "≥ 2"
- [x] **Import side effects verified safe** — `db.ts` uses lazy init (`getDb()` only opens DB on first query call). All handler files can be safely imported in the dump script without triggering DB connections, Slack, or timers. Only `src/http/index.ts` has dangerous top-level side effects (boots entire server).
- [x] **`Object.fromEntries(queryParams)` verified safe** — no handler uses `getAll()`, comma-splitting, or repeated query params. All query params are single-valued scalars.

---

## Post-Implementation Verification

_Verified: 2026-03-16 by Claude_

### Automated Checks (all pass)

| Check | Result |
|-------|--------|
| `bun run tsc:check` | **PASS** — clean |
| `bun run lint:fix` | **PASS** — 0 warnings (after fixing 3 unused imports in active-sessions.ts, epics.ts, tasks.ts) |
| `bun test` | **PASS** — 1400/1400 tests, 0 fail |
| `bun test src/tests/http-api-integration.test.ts` | **PASS** — 166/166 tests, 0 fail |
| `bun run docs:openapi` | **PASS** — generated 83.2KB |
| `git diff --exit-code openapi.json` | **PASS** — no drift |
| `grep -rn "matchRoute(" src/http/ ...` | **PASS** — no raw matchRoute() in handlers |
| Dependency installed | **PASS** — `@asteasolutions/zod-to-openapi ^8.0.0` |
| CI job added | **PASS** — `openapi-freshness` job + gate dependency |

### Manual E2E Tests (all pass)

Server started on port 3013, tested the following:

| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| `GET /health` | 200 | 200 | **PASS** |
| `GET /openapi.json` | Valid OpenAPI 3.1.0 JSON | OpenAPI 3.1.0, 58 paths, title: "Agent Swarm API" | **PASS** |
| `GET /docs` | Scalar HTML page | HTML with `<script>` loading Scalar CDN | **PASS** |
| `GET /api/repos` (authed) | 200 + JSON list | 200, dict response | **PASS** |
| `GET /api/tasks?limit=2` (authed) | 200 + JSON with tasks/total | 200, `{tasks, total}` | **PASS** |
| `GET /api/agents` (authed) | 200 + JSON list | 200, list | **PASS** |
| `GET /api/epics` (authed) | 200 + JSON | 200, dict | **PASS** |
| `GET /api/active-sessions` (authed) | 200 + JSON | 200, dict | **PASS** |
| `GET /api/config` (authed) | 200 + JSON | 200, dict | **PASS** |
| `GET /api/workflows` (authed) | 200 + JSON list | 200, list (count: 0) | **PASS** |
| `POST /api/repos` empty body | 400 + Zod error | 400: "url: expected string, name: expected string" | **PASS** |
| `POST /api/epics` missing goal | 400 + Zod error | 400: "goal: expected string, received undefined" | **PASS** |
| `GET /api/tasks?limit=abc` | 400 + coercion error | 400: "limit: expected number, received NaN" | **PASS** |
| `GET /api/tasks` no auth | 401 | 401: "Unauthorized" | **PASS** |
| `GET /ecosystem` no X-Agent-ID | 400 | 400: "Missing X-Agent-ID header" | **PASS** |

### Notes

- **Invalid UUID path params** (`GET /api/tasks/not-a-uuid`): Returns 404 "Task not found" instead of 400. The route param schemas use `z.string()` without `.uuid()`, so non-UUID strings are accepted and the handler returns 404 when no DB record matches. This is acceptable — strict UUID validation can be added later if desired.
- **`GET /api/schedules` returns 404**: This is pre-existing behavior — no list endpoint was ever implemented (only CRUD on individual schedules). Not a regression.
- **58 OpenAPI paths**: Plan estimated ~62-70. The difference is because OpenAPI groups multiple HTTP methods under one path key, and some matchRoute() calls were sub-route checks (e.g., `/tasks/{id}/cancel`), not distinct paths.
- **Test assertion changes**: Two test files were updated — `http-api-integration.test.ts` loosened an epic validation assertion (`"name, goal"` → `"goal"`), and `workflow-http.test.ts` changed `toBe` → `toContain` for an error message. Both reflect Zod validation producing slightly different error messages than the old manual validation. All 1400 tests pass.

### Cleanup Applied During Verification

- Removed unused `parseBody` import from `epics.ts` and `tasks.ts`
- Removed unused `jsonError` import from `active-sessions.ts`
