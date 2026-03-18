---
title: Debug Tab — Database Explorer
author: claude
date: 2026-03-18
status: implemented
autonomy: autopilot
---

# Debug Tab — Database Explorer

Add a **Debug** tab to the dashboard with a SQL query interface that executes read-only queries against the SQLite database and displays results in a grid. Also expose the same functionality as a lead-only MCP tool.

## Scope

- Backend: new `POST /api/db-query` endpoint (read-only SQL execution)
- Backend: new `db-query` MCP tool (lead-only)
- Frontend: new Debug page with table browser sidebar, Monaco SQL editor, and results grid

---

## Phase 1: Backend — `db-query` endpoint + MCP tool

**Files to create/modify:**
- `src/http/db-query.ts` (new)
- `src/http/index.ts` (add handler to stack)
- `src/tools/db-query.ts` (new — MCP tool)
- `src/server.ts` (register MCP tool)
- `src/tools/tool-config.ts` (add to deferred tools)

### 1.1 Create shared query executor

Extract the core SQL execution logic into a shared function in `src/http/db-query.ts` (or a shared util) so both the REST endpoint and MCP tool can reuse it:

```typescript
export function executeReadOnlyQuery(
  sql: string,
  params: any[] = [],
  maxRows?: number,
): DbQueryResult {
  const stmt = getDb().prepare(sql);

  // Use bun:sqlite's built-in readonly check — handles subqueries, CTEs,
  // lowercase, any syntax. SQLite itself determines if the statement writes.
  if (!stmt.readonly) {
    throw new Error("Only read-only queries are allowed");
  }

  const start = performance.now();
  const rows = stmt.all(...params);          // array of objects
  const columns = stmt.columns().map(c => c.name); // column metadata
  const elapsed = Math.round(performance.now() - start);

  // Optionally cap rows (for MCP tool context size)
  const capped = maxRows ? rows.slice(0, maxRows) : rows;

  // Convert objects → arrays (matching column order)
  const rowArrays = capped.map((row: any) => columns.map((col) => row[col]));

  return { columns, rows: rowArrays, elapsed, total: rows.length };
}
```

### 1.2 Create `src/http/db-query.ts` — REST endpoint

Route definition using the existing `route()` factory:

```typescript
const dbQuery = route({
  method: "post",
  path: "/api/db-query",
  pattern: ["api", "db-query"],
  summary: "Execute a read-only SQL query",
  tags: ["debug"],
  body: z.object({
    sql: z.string().min(1).max(10_000),
    params: z.array(z.any()).optional().default([]),
  }),
  responses: {
    200: { description: "Query results" },
    400: { description: "Invalid or disallowed SQL" },
  },
  auth: { apiKey: true },
});
```

Handler calls `executeReadOnlyQuery()`, catches errors → `jsonError(res, error.message, 400)`.

**Response type:**
```typescript
{
  columns: string[];
  rows: any[][];
  elapsed: number;  // ms
  total: number;
}
```

### 1.3 Register REST handler in `src/http/index.ts`

Add `handleDbQuery` to the handler chain near `handleConfig`:

```typescript
import { handleDbQuery } from "./db-query.js";
if (await handleDbQuery(req, res, pathSegments, queryParams)) return;
```

### 1.4 Create `src/tools/db-query.ts` — MCP tool (lead-only)

```typescript
const MCP_MAX_ROWS = 100;

export const registerDbQueryTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "db-query",
    {
      title: "Execute database query",
      description: "Execute a read-only SQL query against the swarm database. Lead-only. Results capped at 100 rows.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        sql: z.string().describe("SQL query (read-only only — writes are rejected)"),
        params: z.array(z.any()).optional().default([]).describe("Query parameters"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        columns: z.array(z.string()),
        rows: z.array(z.array(z.any())),
        elapsed: z.number(),
        total: z.number(),
        truncated: z.boolean(),
      }),
    },
    async (args, requestInfo, _meta) => {
      // Lead-only check
      const callerAgent = requestInfo.agentId ? getAgentById(requestInfo.agentId) : null;
      if (!callerAgent?.isLead) {
        return {
          content: [{ type: "text", text: "Only the lead agent can use this tool." }],
          structuredContent: { success: false, columns: [], rows: [], elapsed: 0, total: 0, truncated: false },
        };
      }

      try {
        const result = executeReadOnlyQuery(args.sql, args.params, MCP_MAX_ROWS);
        const truncated = result.total > MCP_MAX_ROWS;
        const text = formatAsTextTable(result)
          + (truncated ? `\n(Showing ${MCP_MAX_ROWS} of ${result.total} rows)` : "");
        return {
          content: [{ type: "text", text }],
          structuredContent: { success: true, ...result, truncated },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Query error: ${err.message}` }],
          structuredContent: { success: false, columns: [], rows: [], elapsed: 0, total: 0, truncated: false },
        };
      }
    }
  );
};
```

### 1.5 Register MCP tool in `src/server.ts`

Add to always-registered tools (since it self-guards with lead check):

```typescript
import { registerDbQueryTool } from "./tools/db-query.js";
registerDbQueryTool(server);
```

### 1.6 Add to `src/tools/tool-config.ts`

Add `"db-query"` to `DEFERRED_TOOLS` (no need to be core — lead uses it on-demand).

### Verification

```bash
# Start server
bun run start:http &

# Test REST endpoint — valid query
curl -s -X POST http://localhost:3013/api/db-query \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT name FROM sqlite_master WHERE type=\"table\" ORDER BY name"}' | jq .
# Expect: { columns: ["name"], rows: [["agents"], ...], elapsed: <num>, total: <num> }

# Test REST endpoint — rejected mutation
curl -s -X POST http://localhost:3013/api/db-query \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"sql": "DROP TABLE agents"}' | jq .
# Expect: 400 { error: "Only SELECT, PRAGMA, EXPLAIN, and WITH queries are allowed" }

# Test REST endpoint — invalid SQL
curl -s -X POST http://localhost:3013/api/db-query \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM nonexistent_table"}' | jq .
# Expect: 400 { error: "no such table: nonexistent_table" }

# Type check
bun run tsc:check
```

MCP tool verification (via MCP session handshake — see CLAUDE.md for full steps):
1. Initialize MCP session with a lead agent's X-Agent-ID
2. Call `tools/call` with `name: "db-query"`, `arguments: { sql: "SELECT count(*) as cnt FROM agents" }`
3. Expect structured result with columns/rows
4. Repeat with a non-lead agent ID → expect "Only the lead agent" error

---

## Phase 2: Frontend — API integration

**Files to create/modify:**
- `new-ui/src/api/types.ts` (add types)
- `new-ui/src/api/client.ts` (add method)
- `new-ui/src/api/hooks/use-db-query.ts` (new)
- `new-ui/src/api/hooks/index.ts` (re-export)

### 2.1 Add types to `new-ui/src/api/types.ts`

```typescript
export interface DbQueryRequest {
  sql: string;
  params?: any[];
}

export interface DbQueryResponse {
  columns: string[];
  rows: any[][];
  elapsed: number;
  total: number;
}

export interface TableInfo {
  name: string;
  columns: { name: string; type: string; notnull: boolean; pk: boolean }[];
}
```

### 2.2 Add method to `new-ui/src/api/client.ts`

```typescript
async dbQuery(sql: string, params?: any[]): Promise<DbQueryResponse> {
  return this.fetch<DbQueryResponse>("/api/db-query", {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  });
}
```

### 2.3 Create `new-ui/src/api/hooks/use-db-query.ts`

```typescript
// On-demand query execution (mutation)
export function useDbQuery() {
  return useMutation({
    mutationFn: ({ sql, params }: DbQueryRequest) => api.dbQuery(sql, params),
  });
}

// Auto-fetch table list (query — for sidebar)
export function useTableList() {
  return useQuery({
    queryKey: ["db-tables"],
    queryFn: () => api.dbQuery("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),
    staleTime: 30_000, // tables don't change often
  });
}

// Fetch table columns on demand (lazy query)
export function useTableColumns(tableName: string | null) {
  return useQuery({
    queryKey: ["db-table-columns", tableName],
    queryFn: () => api.dbQuery(`PRAGMA table_info('${tableName}')`),
    enabled: !!tableName,
    staleTime: 60_000,
  });
}
```

### 2.4 Re-export from `new-ui/src/api/hooks/index.ts`

### 2.5 Install Monaco editor

```bash
cd new-ui && pnpm add @monaco-editor/react
```

### Verification

```bash
cd new-ui && pnpm exec tsc --noEmit  # Types compile
```

---

## Phase 3: Frontend — Debug page

**Files to create/modify:**
- `new-ui/src/pages/debug/page.tsx` (new)
- `new-ui/src/components/layout/app-sidebar.tsx` (add nav item)
- `new-ui/src/app/router.tsx` (add route)

### 3.1 Create `new-ui/src/pages/debug/page.tsx`

**Layout — two-panel with table browser sidebar:**
```
┌──────────────────────────────────────────────────────────┐
│ Debug — Database Explorer                                 │
├────────────┬─────────────────────────────────────────────┤
│ Tables     │ Monaco SQL Editor (~200px height)            │
│            │ SELECT * FROM agents LIMIT 10                │
│ ▸ agents   │                                              │
│ ▾ tasks    │ [Execute (⌘↵)]            3 rows · 2ms      │
│   · id     ├─────────────────────────────────────────────┤
│   · agentId│ AG Grid DataGrid                             │
│   · task   │ (dynamic columns from query result)          │
│   · status │                                              │
│ ▸ agent_log│                                              │
│ ▸ epics    │                                              │
│ ▸ ...      │                                              │
└────────────┴─────────────────────────────────────────────┘
```

**Left sidebar — Table Browser (~220px wide, border-right):**
- On mount: `useTableList()` fetches all table names from `sqlite_master`
- Each table is a collapsible item (chevron icon)
- On click/expand: `useTableColumns(tableName)` fetches `PRAGMA table_info`
- Shows column name + type (e.g., `id TEXT`, `status TEXT`, `isLead INTEGER`)
- Clicking a table name populates the Monaco editor with `SELECT * FROM <table> LIMIT 50`
- Use shadcn `ScrollArea` for the table list, simple div structure (no tree component needed)

**Right panel — Query Runner + Results:**
- **Top**: Monaco editor (`@monaco-editor/react`) for SQL input
  - Language: `sql`
  - Theme: follow app theme (dark → `vs-dark`, light → `vs`)
  - Height: ~200px (resizable via drag handle would be nice but not required)
  - Default value: `SELECT name, type FROM sqlite_master WHERE type='table' ORDER BY name`
  - Keybinding: Cmd/Ctrl+Enter to execute
- **Toolbar row**: Execute button + stats display (`N rows · Xms`) + error message if any
- **Bottom**: `DataGrid` (AG Grid) with dynamically generated columns from response

**Components used:**
- `@monaco-editor/react` — SQL editor
- `DataGrid` (AG Grid wrapper) — results display
- `Button` — Execute
- `Badge` — elapsed time, row count
- `ScrollArea` — table browser scrolling

**Dynamic column generation** (same pattern as before):
```typescript
const columnDefs = useMemo(() => {
  if (!data?.columns) return [];
  return data.columns.map((col) => ({
    field: col,
    headerName: col,
    flex: 1,
    minWidth: 120,
  }));
}, [data?.columns]);

// Convert row arrays → objects for AG Grid
const rowData = useMemo(() => {
  if (!data) return [];
  return data.rows.map((row) =>
    Object.fromEntries(data.columns.map((col, i) => [col, row[i]]))
  );
}, [data]);
```

**Behavior summary:**
- Ctrl/Cmd+Enter to execute from editor
- Execute calls `useDbQuery()` mutation
- On success: dynamic AG Grid columns from response
- On error: red error text below the editor toolbar
- Loading state on Execute button during query
- Table browser click → populate editor + auto-execute

### 3.2 Add to sidebar in `app-sidebar.tsx`

Add to the **System** group (alongside Config, Repos):

```typescript
{ title: "Debug", path: "/debug", icon: Bug }  // Bug from lucide-react
```

### 3.3 Add route to `router.tsx`

```typescript
const DebugPage = lazy(() => import("@/pages/debug/page"));
// In children:
{ path: "debug", element: <DebugPage /> },
```

### Verification

```bash
cd new-ui
pnpm exec tsc --noEmit   # Types compile
pnpm lint                 # Biome passes
pnpm dev                  # Visual check
```

Manual E2E:
1. Start backend: `bun run start:http`
2. Start UI: `cd new-ui && pnpm dev`
3. Open http://localhost:5274/debug
4. Verify: Debug tab visible in sidebar under System
5. Left sidebar: tables listed, click to expand columns, click table name → editor populated
6. Execute default query → see results in grid
7. Type `DROP TABLE agents` → Execute → see blocked error
8. Type `SELECT * FROM nonexistent` → Execute → see SQLite error
9. Verify Cmd+Enter shortcut works
10. Verify elapsed time and row count display
11. Verify Monaco theme follows app dark/light mode

---

## Phase 4: Pre-PR checks

```bash
# Root project
bun run lint:fix
bun run tsc:check

# UI
cd new-ui
pnpm lint
pnpm exec tsc --noEmit
```

---

## Summary

| Phase | What | Files |
|-------|------|-------|
| 1 | Backend endpoint + MCP tool | `src/http/db-query.ts` (new), `src/http/index.ts`, `src/tools/db-query.ts` (new), `src/server.ts`, `src/tools/tool-config.ts` |
| 2 | Frontend API layer + Monaco dep | `new-ui/src/api/types.ts`, `client.ts`, `hooks/use-db-query.ts` (new), `hooks/index.ts`, `package.json` |
| 3 | Debug page + nav | `new-ui/src/pages/debug/page.tsx` (new), `app-sidebar.tsx`, `router.tsx` |
| 4 | Lint + typecheck | — |

Estimated touch points: 4 new files, 7 modified files.
