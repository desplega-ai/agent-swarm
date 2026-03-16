---
date: 2026-03-16T14:00:00-05:00
researcher: Claude
git_commit: 3f114cc
branch: main
repository: agent-swarm
topic: "Route wrapper pattern for automatic OpenAPI spec generation"
tags: [research, openapi, route-wrapper, zod-to-openapi, api-docs, refactor]
status: complete
autonomy: autopilot
last_updated: 2026-03-16
last_updated_by: Claude
---

# Research: Route Wrapper Pattern for Automatic OpenAPI Spec Generation

**Date**: 2026-03-16
**Researcher**: Claude
**Git Commit**: 3f114cc
**Branch**: main
**Builds on**: `thoughts/taras/research/2026-03-16-openapi-docs-generation.md`

## Research Question

Can we replace `matchRoute()` with a `route()` wrapper that serves as a single source of truth for both HTTP routing and OpenAPI spec generation, eliminating the need for a separate route definitions file?

## Goal

Generate a complete OpenAPI 3.1 spec from the route definitions themselves — no separate `routes.ts` file, no manual maintenance, no drift. When a developer adds or changes an endpoint, the route definition IS the documentation.

## Summary

The proposal is to introduce a `route()` helper that wraps the existing `matchRoute()` pattern with Zod schemas for params, query, body, and responses. Each route definition is both a runtime router+validator and an OpenAPI metadata source. A build-time script collects all definitions via `routeRegistry` and generates `openapi.json`. The migration is incremental — old `matchRoute()` and new `route()` calls coexist.

This approach provides three benefits in one change: OpenAPI spec generation, runtime input validation (currently absent for most endpoints), and full TypeScript type inference for request inputs.

## Detailed Findings

### 1. Current Routing Pattern

Every HTTP handler uses `matchRoute()` from `src/http/utils.ts:69-87`:

```typescript
// src/http/utils.ts
export function matchRoute(
  method: string | undefined,
  pathSegments: string[],
  expectedMethod: string,
  pattern: readonly (string | null)[],  // null = dynamic segment
  exact = false,
): boolean;
```

Handler files follow a consistent pattern (`src/http/tasks.ts`, `src/http/agents.ts`, etc.):

```typescript
export async function handleTasks(req, res, pathSegments, queryParams, myAgentId) {
  // Route 1
  if (matchRoute(req.method, pathSegments, "GET", ["api", "tasks"], true)) {
    const status = queryParams.get("status");
    const limit = queryParams.get("limit") ? Number(queryParams.get("limit")) : undefined;
    // ... handler logic, no input validation ...
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tasks, total }));
    return true;
  }

  // Route 2
  if (matchRoute(req.method, pathSegments, "POST", ["api", "tasks"], true)) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    // ... no validation, trusts input ...
    return true;
  }

  return false;
}
```

**Problems with current approach:**
- No input validation — malformed requests can crash handlers or produce unexpected behavior
- No type safety on request bodies — `parseBody<T>` is a cast, not validation
- No documentation — the API surface is only discoverable by reading source code
- Query param parsing is repeated inline in every handler

### 2. Proposed Route Wrapper

#### Core Types (`src/http/route-def.ts`)

```typescript
import type { IncomingMessage, ServerResponse } from "node:http";
import * as z from "zod";
import { matchRoute, parseBody, json, jsonError } from "./utils";

// ─── Types ───────────────────────────────────────────────────────────────────

type HttpMethod = "get" | "post" | "put" | "delete" | "patch";

interface RouteResponseDef {
  description: string;
  schema?: z.ZodType;
}

interface RouteDef<
  TParams extends z.ZodType = z.ZodType,
  TQuery extends z.ZodType = z.ZodType,
  TBody extends z.ZodType = z.ZodType,
> {
  method: HttpMethod;
  path: string;                              // OpenAPI-style: "/api/tasks/{id}"
  pattern: readonly (string | null)[];       // matchRoute-style: ["api", "tasks", null]
  exact?: boolean;                           // default true
  summary: string;
  description?: string;
  tags: string[];
  params?: TParams;
  query?: TQuery;
  body?: TBody;
  responses: Record<number, RouteResponseDef>;
  auth?: {
    apiKey?: boolean;                        // default true
    agentId?: boolean;                       // requires X-Agent-ID
  };
}

interface ParsedRequest<TParams, TQuery, TBody> {
  params: TParams;
  query: TQuery;
  body: TBody;
}

interface RouteHandle<TParams, TQuery, TBody> {
  /** Check if this route matches the request */
  match(method: string | undefined, pathSegments: string[]): boolean;

  /** Parse + validate params, query, body. Returns 400 on validation failure. */
  parse(
    req: IncomingMessage,
    res: ServerResponse,
    pathSegments: string[],
    queryParams: URLSearchParams,
  ): Promise<ParsedRequest<TParams, TQuery, TBody> | null>;

  /** The raw definition (for OpenAPI generation) */
  def: RouteDef;
}

// ─── Registry ────────────────────────────────────────────────────────────────

/** Global registry — collected at build time by the OpenAPI generator */
export const routeRegistry: RouteDef[] = [];

// ─── Factory ─────────────────────────────────────────────────────────────────

export function route<
  TParams extends z.ZodType = z.ZodUndefined,
  TQuery extends z.ZodType = z.ZodUndefined,
  TBody extends z.ZodType = z.ZodUndefined,
>(def: RouteDef<TParams, TQuery, TBody>): RouteHandle<
  z.infer<TParams>,
  z.infer<TQuery>,
  z.infer<TBody>
> {
  routeRegistry.push(def as RouteDef);

  return {
    def: def as RouteDef,

    match(method, pathSegments) {
      return matchRoute(method, pathSegments, def.method.toUpperCase(), def.pattern, def.exact ?? true);
    },

    async parse(req, res, pathSegments, queryParams) {
      try {
        // Extract path params from dynamic segments
        const rawParams: Record<string, string> = {};
        if (def.params) {
          const paramNames = def.path.match(/\{(\w+)\}/g)?.map(p => p.slice(1, -1)) ?? [];
          for (let i = 0; i < def.pattern.length; i++) {
            if (def.pattern[i] === null && paramNames.length > 0) {
              rawParams[paramNames.shift()!] = pathSegments[i];
            }
          }
        }

        // Parse + validate each part
        const params = def.params ? def.params.parse(rawParams) : undefined;
        const query = def.query
          ? def.query.parse(Object.fromEntries(queryParams))
          : undefined;
        const body = def.body ? def.body.parse(await parseBody(req)) : undefined;

        return { params, query, body } as ParsedRequest<
          z.infer<TParams>,
          z.infer<TQuery>,
          z.infer<TBody>
        >;
      } catch (err) {
        if (err instanceof z.ZodError) {
          jsonError(res, `Validation error: ${err.errors.map(e => `${e.path.join(".")}: ${e.message}`).join(", ")}`, 400);
          return null;
        }
        throw err;
      }
    },
  };
}
```

**Estimated size: ~80-100 lines** for the complete implementation.

#### Route Definition Example

```typescript
// src/http/tasks.ts (top of file, co-located with handler)

const listTasks = route({
  method: "get",
  path: "/api/tasks",
  pattern: ["api", "tasks"],
  summary: "List tasks",
  tags: ["Tasks"],
  query: z.object({
    status: AgentTaskStatusSchema.optional(),
    agentId: z.string().uuid().optional(),
    epicId: z.string().uuid().optional(),
    scheduleId: z.string().uuid().optional(),
    search: z.string().optional(),
    includeHeartbeat: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
  }),
  responses: {
    200: {
      description: "Paginated task list",
      schema: z.object({
        tasks: z.array(AgentTaskSchema),
        total: z.number(),
      }),
    },
  },
});

const createTask = route({
  method: "post",
  path: "/api/tasks",
  pattern: ["api", "tasks"],
  summary: "Create a new task",
  tags: ["Tasks"],
  body: z.object({
    task: z.string().min(1),
    agentId: z.string().uuid().optional(),
    taskType: z.string().max(50).optional(),
    tags: z.array(z.string()).optional(),
    priority: z.number().int().min(0).max(100).default(50),
    dependsOn: z.array(z.string().uuid()).optional(),
    source: AgentTaskSourceSchema.default("api"),
    dir: z.string().min(1).startsWith("/").optional(),
    parentTaskId: z.string().uuid().optional(),
    model: z.enum(["haiku", "sonnet", "opus"]).optional(),
  }),
  responses: {
    201: { description: "Task created", schema: AgentTaskSchema },
    400: { description: "Validation error", schema: z.object({ error: z.string() }) },
  },
  auth: { apiKey: true },
});

const getTask = route({
  method: "get",
  path: "/api/tasks/{id}",
  pattern: ["api", "tasks", null],
  summary: "Get task details",
  tags: ["Tasks"],
  params: z.object({ id: z.string().uuid() }),
  responses: {
    200: { description: "Task with logs", schema: AgentTaskSchema.extend({ logs: z.array(AgentLogSchema) }) },
    404: { description: "Task not found", schema: z.object({ error: z.string() }) },
  },
});

const cancelTask = route({
  method: "post",
  path: "/api/tasks/{id}/cancel",
  pattern: ["api", "tasks", null, "cancel"],
  summary: "Cancel a task",
  tags: ["Tasks"],
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    reason: z.string().optional(),
  }).optional(),
  responses: {
    200: { description: "Task cancelled", schema: z.object({ success: z.literal(true), task: AgentTaskSchema }) },
    404: { description: "Task not found" },
    400: { description: "Task already finished" },
  },
});
```

#### Handler Usage (After)

```typescript
export async function handleTasks(req, res, pathSegments, queryParams, myAgentId) {
  // GET /api/tasks
  if (listTasks.match(req.method, pathSegments)) {
    const parsed = await listTasks.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true; // validation failed, 400 already sent
    const { query } = parsed;
    const tasks = getAllTasks({
      status: query.status,
      agentId: query.agentId,
      // ... fully typed, no manual queryParams.get() needed
    });
    const total = getTasksCount(query);
    json(res, { tasks, total });
    return true;
  }

  // POST /api/tasks
  if (createTask.match(req.method, pathSegments)) {
    const parsed = await createTask.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = createTaskExtended({
      ...parsed.body,
      creatorAgentId: myAgentId,
      source: parsed.body.source ?? "api",
    });
    json(res, task, 201);
    return true;
  }

  // GET /api/tasks/:id
  if (getTask.match(req.method, pathSegments)) {
    const parsed = await getTask.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = getTaskById(parsed.params.id);
    if (!task) return jsonError(res, "Task not found", 404), true;
    const logs = getLogsByTaskId(parsed.params.id);
    json(res, { ...task, logs });
    return true;
  }

  return false;
}
```

### 3. OpenAPI Spec: Live at Runtime + File Dump for CI

Since `routeRegistry` is populated at module load time (handler imports trigger `route()` calls), the spec can be **computed live at runtime** — no file read needed. The dump script exists only for CI freshness checks.

#### Live spec generator (`src/http/openapi.ts`)

This module exports a function that builds the OpenAPI doc from the registry. It's called both at runtime (for `/openapi.json`) and by the dump script:

```typescript
// src/http/openapi.ts
import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import { routeRegistry } from "./route-def";

extendZodWithOpenApi(z);

let cachedSpec: string | null = null;

interface OpenApiOptions {
  version: string;       // from package.json
  serverUrl?: string;    // from MCP_BASE_URL or computed from PORT
}

export function generateOpenApiSpec(opts: OpenApiOptions): string {
  // Cache the spec — it only changes when the process restarts
  if (cachedSpec) return cachedSpec;

  const registry = new OpenAPIRegistry();

  // Register Bearer auth
  registry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "API key via Authorization: Bearer <API_KEY>",
  });

  // Register X-Agent-ID header
  registry.registerComponent("securitySchemes", "agentId", {
    type: "apiKey",
    in: "header",
    name: "X-Agent-ID",
    description: "Agent UUID for agent-scoped operations",
  });

  // Convert route definitions to OpenAPI paths
  for (const routeDef of routeRegistry) {
    const responses: Record<string, any> = {};
    for (const [code, resDef] of Object.entries(routeDef.responses)) {
      responses[code] = {
        description: resDef.description,
        ...(resDef.schema && {
          content: {
            "application/json": { schema: resDef.schema },
          },
        }),
      };
    }

    registry.registerPath({
      method: routeDef.method,
      path: routeDef.path,
      summary: routeDef.summary,
      description: routeDef.description,
      tags: routeDef.tags,
      request: {
        ...(routeDef.params && { params: routeDef.params }),
        ...(routeDef.query && { query: routeDef.query }),
        ...(routeDef.body && {
          body: {
            content: { "application/json": { schema: routeDef.body } },
          },
        }),
      },
      responses,
      security: routeDef.auth?.apiKey !== false ? [{ bearerAuth: [] }] : undefined,
    });
  }

  // Determine the server URL dynamically:
  // - At runtime: use MCP_BASE_URL env var (already set in .env for each environment)
  //   or compute from PORT env var (e.g., http://localhost:3014)
  // - In dump script: defaults to localhost:3013
  const serverUrl = opts.serverUrl
    || process.env.MCP_BASE_URL
    || `http://localhost:${process.env.PORT || "3013"}`;

  const generator = new OpenApiGeneratorV31(registry.definitions);
  const doc = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Agent Swarm API",
      version: opts.version,
      description:
        "Multi-agent orchestration API for Claude Code, Codex, and Gemini CLI. " +
        "Enables task distribution, agent communication, and service discovery.\n\n" +
        "MCP tools are documented separately in [MCP.md](./MCP.md).",
    },
    servers: [
      { url: serverUrl, description: serverUrl.includes("localhost") ? "Local development" : "Production" },
    ],
  });

  cachedSpec = JSON.stringify(doc, null, 2);
  return cachedSpec;
}
```

#### Runtime serving (in `src/http/core.ts`, pre-auth)

```typescript
// Served before auth gate, like /health
if (req.url === "/openapi.json") {
  const version = (await Bun.file("package.json").json()).version;
  // serverUrl is derived from MCP_BASE_URL or PORT at runtime — always correct
  const spec = generateOpenApiSpec({ version });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(spec);
  return true;
}
if (req.url === "/docs" || req.url === "/docs/") {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(SCALAR_HTML);  // points to /openapi.json
  return true;
}
```

The spec is computed once on first request and cached for the lifetime of the process. Restarts pick up new route definitions automatically.

#### Dump script for CI (`scripts/generate-openapi.ts`)

```typescript
// scripts/generate-openapi.ts
// Imports handlers to populate routeRegistry, then dumps the spec to a file
import { generateOpenApiSpec } from "../src/http/openapi";

// Import all handler files to trigger route() registrations
import "../src/http/tasks";
import "../src/http/agents";
import "../src/http/epics";
// ... all other handlers ...

const version = (await Bun.file("package.json").json()).version;
// Dump script uses localhost:3013 as canonical URL for the committed file
const spec = generateOpenApiSpec({ version, serverUrl: "http://localhost:3013" });
await Bun.write("openapi.json", spec);
console.log(`Generated openapi.json (${(spec.length / 1024).toFixed(1)}KB)`);
```

**Key insight**: The live API always serves the truth (computed from the running code's route definitions). The dumped `openapi.json` file is just a snapshot for CI comparison — if it drifts, the merge gate fails and forces a re-dump. This means the `/openapi.json` endpoint is always accurate, even if someone forgets to run the dump script.

**Estimated sizes**: `src/http/openapi.ts` ~80 lines, `scripts/generate-openapi.ts` ~15 lines

### 4. Query Param Type Coercion

One subtlety: query params always arrive as strings from `URLSearchParams`. Zod's `z.coerce` handles this:

```typescript
query: z.object({
  limit: z.coerce.number().int().optional(),        // "50" → 50
  includeHeartbeat: z.coerce.boolean().optional(),   // "true" → true
  status: AgentTaskStatusSchema.optional(),           // string enum, no coerce needed
})
```

The `parse()` method in the route wrapper uses `Object.fromEntries(queryParams)` which produces `Record<string, string>`. Zod coerce transforms these to the correct types. This replaces all the inline `Number(queryParams.get("limit"))` patterns.

### 5. Migration Strategy

The migration is **fully incremental** — old and new patterns coexist:

```
Phase 0: Add route-def.ts (~80 lines) + generate-openapi.ts (~80 lines) + Scalar viewer (~20 lines)
Phase 1: Convert repos.ts (5 endpoints, simplest handler — proof of concept)
Phase 2: Convert remaining handlers one file at a time (any order)
Phase 3: CI freshness check
```

During migration, unconverted handlers still use `matchRoute()` directly — they just won't appear in the OpenAPI spec until converted. The spec grows organically as handlers are converted.

**Per-handler conversion effort**: Each endpoint takes ~15-30 lines of route definition + simplifying the handler body (removing inline parsing). For a 5-endpoint handler file, that's ~30 minutes of mechanical work.

### 6. Estimated File Sizes

| File | Lines | Purpose |
|------|-------|---------|
| `src/http/route-def.ts` | ~80-100 | Route wrapper, registry, types |
| `scripts/generate-openapi.ts` | ~80 | Collects registry, generates spec |
| Route definitions (total across all handlers) | ~1,200-1,500 | ~20-25 lines per endpoint × 62 endpoints |
| Generated `openapi.json` | ~3,000-5,000 | Full spec with all schemas |

The route definitions are **co-located** in each handler file (not a separate file), so the 1,200-1,500 lines are distributed across 15 handler files — averaging ~80-100 lines of definitions per file. This is additional code, but it replaces the inline query/body parsing that currently exists.

**Net line change per handler**: Roughly neutral. You add ~20-25 lines of route definition per endpoint but remove ~10-15 lines of inline parsing (`queryParams.get()`, `parseBody()`, manual `Number()` casts, etc.).

### 7. Docs Viewer Integration

Same as the parent research — Scalar served at `/docs`, pre-auth:

```typescript
// In src/http/core.ts (pre-auth section, alongside /health)
if (req.url === "/docs" || req.url === "/docs/") {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(SCALAR_HTML);
  return true;
}
if (req.url === "/openapi.json") {
  const spec = await Bun.file("openapi.json").text();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(spec);
  return true;
}
```

### 8. CI No-Drift Guarantee

Same merge gate pattern as `build:pi-skills`:

```yaml
- name: Check OpenAPI spec freshness
  run: |
    bun run docs:openapi
    git diff --exit-code openapi.json || {
      echo "::error::openapi.json is out of date. Run 'bun run docs:openapi' and commit."
      exit 1
    }
```

The key insight: since route definitions are co-located with handlers and imported by the generator at build time, there is no separate file to drift. If you add a route with a `route()` definition, the spec updates automatically on next `bun run docs:openapi`. If you add a route with raw `matchRoute()` (forgetting to use the wrapper), it simply won't appear in the spec — CI won't catch this, but code review should.

**Optional enhancement**: A lint rule or test that ensures every `matchRoute()` call in handler files has a corresponding `route()` definition. This could be a simple grep-based check in CI:

```bash
# Fail if any matchRoute() calls exist outside of route-def.ts
UNREGISTERED=$(grep -rn "matchRoute(" src/http/ --include="*.ts" | grep -v "route-def.ts" | grep -v "utils.ts")
if [ -n "$UNREGISTERED" ]; then
  echo "::error::Found raw matchRoute() calls. Convert to route() definitions:"
  echo "$UNREGISTERED"
  exit 1
fi
```

This check only becomes enforced after the full migration is complete.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/http/utils.ts` | 69-87 | Current `matchRoute()` function |
| `src/http/utils.ts` | 40-46 | `parseBody<T>()` — replaced by route wrapper |
| `src/http/utils.ts` | 49-52 | `json()` helper — kept as-is |
| `src/http/utils.ts` | 55-58 | `jsonError()` helper — kept as-is |
| `src/http/tasks.ts` | 28-52 | Example: GET /api/tasks handler (migration target) |
| `src/http/tasks.ts` | 55-93 | Example: POST /api/tasks handler (migration target) |
| `src/http/repos.ts` | 1-132 | Simplest handler file (5 endpoints, good pilot) |
| `src/types.ts` | 1-643 | All Zod schemas (reused directly in route definitions) |
| `scripts/generate-mcp-docs.ts` | 1-416 | Existing doc gen pattern (inspiration) |

## Architecture Documentation

### How route() Integrates with Existing Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Handler file (e.g., src/http/tasks.ts)                  │
│                                                         │
│  const listTasks = route({ ... })  ──→ routeRegistry    │
│  const createTask = route({ ... }) ──→ routeRegistry    │
│                                                         │
│  export async function handleTasks(req, res, ...) {     │
│    if (listTasks.match(...)) {                          │
│      const { query } = await listTasks.parse(...)       │
│      ...                                                │
│    }                                                    │
│  }                                                      │
└─────────────────────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
         at runtime            build time (CI)
              │                     │
              ▼                     ▼
┌──────────────────────┐  ┌────────────────────────────┐
│ src/http/openapi.ts  │  │ scripts/generate-openapi.ts│
│                      │  │                            │
│ generateOpenApiSpec()│  │ imports handlers →         │
│ (cached on 1st call) │  │ generateOpenApiSpec() →    │
│                      │  │ writes openapi.json        │
│ Served live at:      │  │                            │
│  GET /openapi.json   │  │ CI: git diff --exit-code   │
│  GET /docs (Scalar)  │  │       openapi.json         │
└──────────────────────┘  └────────────────────────────┘
         │
         │ always accurate — computed from running code
         ▼
┌─────────────────────────────────────────────────────────┐
│ /docs → Scalar UI (interactive "Try It" API explorer)   │
│ /openapi.json → live spec (cached, recomputed on restart│
└─────────────────────────────────────────────────────────┘
```

### What Changes vs What Stays

| Component | Changes? | Details |
|-----------|----------|---------|
| `src/http/utils.ts` | No | `matchRoute()`, `json()`, `jsonError()` stay as-is |
| `src/http/index.ts` | No | Handler chain pattern unchanged |
| Handler signatures | No | `handleTasks(req, res, pathSegments, queryParams, myAgentId)` unchanged |
| Handler file structure | Minimal | Add route defs at top, simplify inline parsing |
| `src/types.ts` | No | Zod schemas imported directly, not modified |
| Auth flow | No | API key + `X-Agent-ID` logic stays in `handleCore` |

## Related Research
- `thoughts/taras/research/2026-03-16-openapi-docs-generation.md` — Parent research covering library evaluation, Hono migration assessment, endpoint catalog, and Scalar viewer recommendation

## Open Questions (Resolved)

- ~~Should the `route()` wrapper support streaming responses (e.g., SSE for MCP)?~~ **No** — MCP uses `StreamableHTTPServerTransport` with its own protocol. Keep it out of the route wrapper.
- ~~Should validation errors include the full Zod error path or just a summary?~~ **Full paths** — the project is OSS, no need to hide internal schema structure. Full paths are more useful for debugging.
- ~~Is `z.coerce` sufficient for all query param type conversions?~~ **Yes, likely sufficient.** Handle edge cases (e.g., comma-separated arrays) as they come with custom helpers if needed.
