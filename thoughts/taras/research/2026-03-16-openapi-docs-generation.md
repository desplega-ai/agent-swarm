---
date: 2026-03-16T12:00:00-05:00
researcher: Claude
git_commit: 3f114cc
branch: main
repository: agent-swarm
topic: "OpenAPI documentation generation for the agent-swarm REST API"
tags: [research, openapi, api-docs, zod-to-openapi, scalar, documentation]
status: complete
autonomy: autopilot
last_updated: 2026-03-16
last_updated_by: Claude
---

# Research: OpenAPI Documentation Generation for the Agent Swarm REST API

**Date**: 2026-03-16
**Researcher**: Claude
**Git Commit**: 3f114cc
**Branch**: main

## Research Question

What is the best approach for auto-generating OpenAPI documentation for the agent-swarm REST API? The API has ~62 endpoints using raw `node:http` with Bun, Zod schemas for domain entities, and an existing auto-generated MCP tools reference (`MCP.md`). The goal is an automatic approach that doesn't require manual maintenance.

## Summary

The agent-swarm REST API has **62 endpoints** across 17 handler files, with **zero documentation** outside of the auto-generated `MCP.md` for MCP tools. The REST API (used by the dashboard, external integrations, and `curl`) is completely undocumented.

The recommended approach is a **build-time script** using `@asteasolutions/zod-to-openapi` that generates an OpenAPI 3.1 spec from route definitions + existing Zod schemas, paired with **Scalar** as a zero-dependency docs viewer served at `/docs`. This mirrors the existing `generate-mcp-docs.ts` pattern and requires no framework migration. A CI freshness check can enforce the spec stays in sync.

Migration to Hono was evaluated and **rejected** — the OpenAPI "auto-generation" claim is misleading (you still write all schemas manually), and the migration cost (~77 route rewrites across 14 files) doesn't justify the benefit.

## Detailed Findings

### 1. Current API Surface

The REST API is served via `node:http` `createServer` (`src/http/index.ts:52`), with a custom handler chain pattern. Each handler module (`src/http/*.ts`) exports a function like `handleTasks(req, res, pathSegments, queryParams, myAgentId)` that returns `Promise<boolean>` — first match wins.

**62 endpoints** were cataloged across these domains:

| Domain | Endpoints | Handler File |
|--------|-----------|--------------|
| Core | 7 | `src/http/core.ts` |
| Agents | 7 | `src/http/agents.ts` |
| Tasks | 10 | `src/http/tasks.ts` |
| Epics | 5 | `src/http/epics.ts` |
| Channels + Messages | 6 | `src/http/epics.ts` |
| Workflows | 9 | `src/http/workflows.ts` |
| Schedules | 5 | `src/http/schedules.ts` |
| Config | 5 | `src/http/config.ts` |
| Memory | 2 | `src/http/memory.ts` |
| Stats | 5 | `src/http/stats.ts` |
| Repos | 5 | `src/http/repos.ts` |
| Poll | 1 | `src/http/poll.ts` |
| Ecosystem | 1 | `src/http/ecosystem.ts` |
| Session Data | 6 | `src/http/session-data.ts` |
| Active Sessions | 6 | `src/http/active-sessions.ts` |
| Webhooks | 3 | `src/http/webhooks.ts` |
| MCP | 3 | `src/http/mcp.ts` |

Route matching uses `matchRoute()` (`src/http/utils.ts:69-87`) with literal and dynamic (`null`) segment patterns.

### 2. Existing Zod Schemas

`src/types.ts` contains **28 Zod schemas** covering all domain entities:

- `AgentTaskSchema`, `AgentTaskStatusSchema`, `AgentTaskSourceSchema`
- `AgentSchema`, `AgentStatusSchema`, `AgentWithTasksSchema`
- `EpicSchema`, `EpicStatusSchema`, `EpicWithProgressSchema`
- `WorkflowSchema`, `WorkflowDefinitionSchema`, `WorkflowNodeSchema`, `WorkflowEdgeSchema`
- `WorkflowRunSchema`, `WorkflowRunStepSchema`
- `ScheduledTaskSchema`
- `SwarmConfigSchema`, `SwarmConfigScopeSchema`
- `SwarmRepoSchema`
- `AgentMemorySchema`, `AgentMemoryScopeSchema`, `AgentMemorySourceSchema`
- `ChannelSchema`, `ChannelMessageSchema`, `ChannelTypeSchema`
- `ServiceSchema`, `ServiceStatusSchema`
- `SessionLogSchema`, `SessionCostSchema`
- `ActiveSessionSchema`
- `AgentLogSchema`, `AgentLogEventTypeSchema`
- `ContextVersionSchema`, `ChangeSourceSchema`, `VersionableFieldSchema`
- `InboxMessageSchema`, `InboxMessageStatusSchema`

These schemas represent ~70% of the OpenAPI component definitions needed.

### 3. Recommended Approach: `@asteasolutions/zod-to-openapi` + Script

#### Library: `@asteasolutions/zod-to-openapi`

- **Maturity**: ~1.7M weekly npm downloads, ~1,500 GitHub stars, MIT license
- **How it works**: Framework-agnostic. Provides `OpenAPIRegistry` to register schemas and paths, then `OpenApiGeneratorV31` to emit a plain JS object (the OpenAPI spec)
- **Key API**:
  - `extendZodWithOpenApi(z)` — adds `.openapi()` method to Zod types
  - `registry.register(name, zodSchema)` — register component schema
  - `registry.registerPath({method, path, request, responses})` — register endpoint
  - `generator.generateDocument(config)` — produce full OpenAPI spec object
- **Zod compatibility**: v7.x for Zod v3 (which agent-swarm uses), v8.x for Zod v4

#### Script Pattern: `scripts/generate-openapi.ts`

Create a script analogous to `scripts/generate-mcp-docs.ts` that:

1. Imports all Zod schemas from `src/types.ts`
2. Extends them with `.openapi()` metadata (names, examples, descriptions)
3. Defines route registrations for all 62 endpoints using `registry.registerPath()`
4. Generates the full OpenAPI 3.1.0 spec
5. Writes to `openapi.json` (and optionally `API.md` for markdown reference)

**Route definition approach**: Create a `src/http/openapi-routes.ts` file that defines all route metadata in a declarative structure:

```typescript
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { AgentTaskSchema, AgentSchema, ... } from "../types";

export function registerRoutes(registry: OpenAPIRegistry) {
  // ── Tasks ──
  registry.registerPath({
    method: "get",
    path: "/api/tasks",
    summary: "List tasks",
    request: {
      query: z.object({
        status: AgentTaskStatusSchema.optional(),
        agentId: z.string().uuid().optional(),
        epicId: z.string().uuid().optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      }),
    },
    responses: {
      200: {
        description: "Task list",
        content: {
          "application/json": {
            schema: z.object({
              tasks: z.array(AgentTaskSchema),
              total: z.number(),
            }),
          },
        },
      },
    },
  });
  // ... more routes
}
```

**CI enforcement**: Add to `.github/workflows/merge-gate.yml`:
```yaml
- name: Check OpenAPI freshness
  run: |
    bun run docs:openapi
    git diff --exit-code openapi.json
```

#### Alternative considered: `zod-openapi` (by samchungy)

- Uses Zod's native `.meta()` instead of extending prototypes
- Smaller community (~121 dependents vs 1.7M downloads)
- Cleaner approach but less battle-tested
- **Verdict**: `@asteasolutions/zod-to-openapi` is the safer choice for a production project

### 4. Docs Viewer: Scalar

**Recommendation: Scalar** — zero npm dependencies, single CDN script, modern UI.

| Feature | Scalar | Swagger UI | Redoc | RapiDoc |
|---------|--------|-----------|-------|---------|
| CDN files needed | 1 (JS) | 2 (JS+CSS) | 1 (JS) | 1 (JS) |
| "Try It" client | Yes | Yes | Paid only | Yes |
| UI quality | Excellent | Dated | Excellent | Good |
| Bundle size | ~1MB | ~1.5MB | ~800KB | ~300KB |
| Maintenance | Very active | Moderate | Active | Low |

**Integration** — serve a static HTML page at `/docs`:

```typescript
const DOCS_HTML = `<!doctype html>
<html>
<head>
  <title>Agent Swarm API</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <div id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  <script>
    Scalar.createApiReference('#app', { url: '/openapi.json' })
  </script>
</body>
</html>`;
```

Add to `handleCore` in `src/http/core.ts`:
```typescript
if (req.url === "/docs") {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(DOCS_HTML);
  return true;
}
if (req.url === "/openapi.json") {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(await Bun.file("openapi.json").text());
  return true;
}
```

No npm install required. No CSS file. Same-origin means no CORS issues. Dark mode and themes built in.

### 5. Hono Migration: NOT Recommended

A thorough evaluation of migrating to Hono for OpenAPI concluded it's **not worth it**:

| Factor | Assessment |
|--------|-----------|
| Migration effort | High: 77 `matchRoute()` calls across 14 files, full rewrite |
| OpenAPI "automation" | Misleading: `@hono/zod-openapi` still requires manual Zod schemas per route |
| MCP compatibility | Solvable via `@hono/mcp` but changes integration pattern |
| Performance | Would actually improve (ironic — `Bun.serve()` > `node:http` compat) |
| Incremental path | Poor: essentially all-or-nothing |

**Key insight**: Hono's OpenAPI integration (`@hono/zod-openapi`) requires rewriting every route with `createRoute()` and adding schema annotations to every endpoint. You'd be paying the migration cost AND still writing all the schemas manually. The script-based `zod-to-openapi` approach achieves the same result without touching any runtime code.

**If Hono migration is desired later** (for framework benefits, not OpenAPI), it should be a separate initiative budgeting 3-4 days. Hono is already in `package.json` (used by artifact SDK), and `@hono/mcp` exists for the MCP transport.

### 6. Existing Docs Pattern: `generate-mcp-docs.ts`

The project already has a precedent: `scripts/generate-mcp-docs.ts` (`bun run docs:mcp`):

- Discovers tool categories from `src/server.ts`
- Discovers tool files via glob in `src/tools/`
- Parses Zod schema fields from each tool file (regex-based extraction)
- Generates `MCP.md` with tables for each tool's parameters

The OpenAPI generation script should follow the same pattern:
- `bun run docs:openapi` — generates `openapi.json`
- CI freshness check — `git diff --exit-code openapi.json`
- Same location in `scripts/` directory

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/http/index.ts` | 52-115 | Main HTTP server + handler chain |
| `src/http/utils.ts` | 69-87 | `matchRoute()` function |
| `src/http/utils.ts` | 40-58 | `parseBody()`, `json()`, `jsonError()` helpers |
| `src/http/core.ts` | 36-278 | Core routes (health, auth, me, ping, close) |
| `src/types.ts` | 1-643 | All 28 Zod schemas |
| `scripts/generate-mcp-docs.ts` | 1-416 | MCP docs generator (pattern to follow) |
| `src/tools/send-task.ts` | 16-40 | Example MCP tool with Zod inputSchema |

## Architecture Documentation

### Authentication Model
- API key via `Authorization: Bearer <API_KEY>` (env-based, optional)
- Agent identity via `X-Agent-ID` header (required for agent-scoped operations)
- Webhook routes skip API key auth, use their own signature verification
- No role-based access control at HTTP layer

### Handler Chain Pattern
1. `handleCore` runs first — handles OPTIONS, `/health` (pre-auth), auth gate, then `/me`, `/cancelled-tasks`, `/ping`, `/close`
2. Remaining handlers iterate in order (lines 89-106) — first match wins
3. 404 returned if no handler matches

### Request/Response Conventions
- JSON responses with `Content-Type: application/json`
- List endpoints return `{ items: T[], total?: number }`
- Create endpoints return 201 with created object
- Delete endpoints return `{ success: true }` or 204
- Errors return `{ error: string }` with appropriate status code

## Historical Context

No prior research exists on API documentation for this project. The `MCP.md` auto-generation pattern (commit history) was established as the project's documentation convention and should be extended to cover the REST API.

## Related Research
- No directly related research documents exist in `thoughts/taras/research/`

## Open Questions

> **Resolved**: All endpoints should be documented in the OpenAPI spec. For the initial research catalog/map we can skip some, but the spec itself should be comprehensive.

- ~~Should the OpenAPI spec cover webhook endpoints?~~ **Yes** — document all endpoints. Webhooks can be tagged separately and note their different auth model (signature verification vs Bearer token)
- ~~Should internal endpoints be included?~~ **Yes** — mark with `x-internal: true` or tag as "Internal" so Scalar can visually distinguish them
- Should the MCP endpoint (`/mcp`) be documented in the OpenAPI spec, or kept separate in `MCP.md`? The JSON-RPC protocol doesn't map cleanly to REST — **Recommendation: keep separate**, just link to `MCP.md` from the spec description
- What level of response schema detail is needed? Some endpoints return complex nested objects (e.g., `GET /api/poll` returns different shapes based on trigger type) — use `oneOf` / discriminated unions where appropriate

## Proposed Implementation Plan

### Phase 1: OpenAPI Spec Generation Script

**Estimated file sizes:**
- `src/openapi/schemas.ts` — ~200-300 lines. Imports the 28 existing Zod schemas from `src/types.ts` and registers them with `.openapi("Name")` metadata. Mostly boilerplate wrapping
- `src/openapi/routes.ts` — ~1,500-2,000 lines. The bulk of the work: 62 `registry.registerPath()` calls, each ~25-35 lines (method, path, summary, tags, request params/body, response schema). This is the tedious-but-straightforward part
- `scripts/generate-openapi.ts` — ~50-80 lines. Imports schemas + routes, calls `generateDocument()`, writes to file
- Generated `openapi.json` — ~3,000-5,000 lines (typical for 62 endpoints with full schemas). For reference, a 40-endpoint API typically produces ~100-150KB of OpenAPI JSON

**Steps:**
1. Install `@asteasolutions/zod-to-openapi`
2. Create `src/openapi/schemas.ts` — register existing Zod schemas with OpenAPI metadata
3. Create `src/openapi/routes.ts` — declarative route definitions for all 62 endpoints
4. Create `scripts/generate-openapi.ts` — generates `openapi.json`
5. Add `"docs:openapi": "bun scripts/generate-openapi.ts"` to `package.json`

### Phase 2: Docs Viewer
1. Add `/openapi.json` endpoint in `src/http/core.ts` (serves generated file)
2. Add `/docs` endpoint in `src/http/core.ts` (serves Scalar HTML)
3. Both endpoints are pre-auth (like `/health`)

### Phase 3: CI Integration — No-Drift Guarantee

The spec is generated from code, so drift is prevented by treating the generated `openapi.json` as a build artifact with a CI freshness check:

1. **Merge gate step** — Add to `.github/workflows/merge-gate.yml`:
   ```yaml
   - name: Check OpenAPI spec freshness
     run: |
       bun run docs:openapi
       git diff --exit-code openapi.json || {
         echo "::error::openapi.json is out of date. Run 'bun run docs:openapi' and commit the result."
         exit 1
       }
   ```
   This is the same pattern used for `bun run build:pi-skills` freshness enforcement.

2. **Pre-PR checklist** — Add `bun run docs:openapi` to `CLAUDE.md` pre-PR checklist alongside `bun run lint:fix` and `bun run tsc:check`

3. **How it works**: When a developer adds/changes an endpoint in `src/http/*.ts`, they must also update the corresponding route definition in `src/openapi/routes.ts` and regenerate. If they forget, CI fails. The Zod schemas in `src/types.ts` are imported directly (not duplicated), so schema changes automatically flow through on next `bun run docs:openapi`.

### Estimated Effort
- Phase 1: The bulk of the work (~80%). `routes.ts` at ~1,500-2,000 lines is tedious but mechanical — each endpoint is ~30 lines of declarative metadata
- Phase 2: ~20 lines of code
- Phase 3: ~5 lines of YAML + docs update
