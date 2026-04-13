---
date: 2026-03-25
author: Claude
status: implemented
autonomy: critical
tags: [plan, mcp, servers, skills-parallel, providers, docker]
research: thoughts/taras/research/2026-03-25-mcp-server-support.md
---

# MCP Server Support Implementation Plan

## Overview

Add MCP server management to agent-swarm, allowing agents to define, install, and use additional MCP servers beyond the built-in `agent-swarm` and `agentmail` servers. Follows the same lifecycle as skills: stored in SQLite, installed per-agent via junction table, synced to `.mcp.json` (Claude) or injected as `customTools` via `McpHttpClient` (Pi-mono) at boot and between sessions.

## Current State Analysis

**What exists:**
- Two hardcoded MCP servers: `agent-swarm` (always) and `agentmail` (conditional on API key) — `docker-entrypoint.sh:275-295`
- Claude adapter creates per-session `.mcp.json` copies with task header injection — `src/providers/claude-adapter.ts:50-95`
- Pi-mono adapter connects via `McpHttpClient` to the swarm endpoint only — `src/providers/pi-mono-adapter.ts:363-424`
- Skills system provides a complete blueprint: two-table model, CRUD + install/uninstall, HTTP API, MCP tools, Docker sync, system prompt injection
- Config system supports scoped secrets with resolution — `src/http/config.ts`, `src/be/db.ts:4784-4944`
- `settings.json` has `enableAllProjectMcpServers: true` and explicit `permissions.allow` patterns — `Dockerfile.worker:113-128`

**What's missing:**
- No dynamic MCP server management — all servers are hardcoded
- No per-agent MCP server installation
- No API for CRUD operations on MCP server definitions
- No integration with the config system for MCP server secrets
- No UI for managing MCP servers

### Key Discoveries:
- Claude CLI supports `${VAR_NAME}` env var expansion in `.mcp.json` — `docker-entrypoint.sh:290-293` already uses `$AGENTMAIL_API_KEY`
- `enableAllProjectMcpServers: true` in `settings.json` auto-enables all `.mcp.json` servers, but `permissions.allow` still needs explicit `mcp__<name>__*` entries — `Dockerfile.worker:118-119`
- Pi-mono only supports HTTP transport via `McpHttpClient` — no stdio client exists and none will be built (resolved design decision)
- The runner already syncs skills between sessions (`src/commands/runner.ts:2069-2093`) — MCP server sync can follow the same pattern
- Migration 020 is the latest (`020_approval_requests.sql`) — next migration is 021

## Desired End State

Agents can:
1. **Create** MCP server definitions (stdio or HTTP) with scoped secrets
2. **Install/uninstall** MCP servers per-agent
3. **Use** installed MCP servers in Claude sessions (via `.mcp.json`) and Pi-mono sessions (via `customTools`)
4. **Manage** MCP servers via MCP tools (agent-facing) and REST API (UI/external)
5. **View** installed MCP servers in the dashboard with install/configure capabilities

Verification of end state:
- `curl GET /api/mcp-servers` returns list of defined servers
- `curl GET /api/agents/:id/mcp-servers` returns agent's installed servers
- Docker container boots with installed MCP servers merged into `.mcp.json`
- Claude sessions can call tools from installed MCP servers
- Pi-mono sessions discover tools from installed HTTP MCP servers
- Dashboard shows MCP server list and per-agent installation

## Quick Verification Reference

Common commands to verify the implementation:
- `bun run tsc:check` — TypeScript type checking
- `bun run lint:fix` — Biome lint + format
- `bun test` — Unit tests
- `bash scripts/check-db-boundary.sh` — Worker/API DB boundary check
- `bun run docs:openapi` — Regenerate OpenAPI spec

Key files to check:
- `src/be/migrations/021_mcp_servers.sql` — Migration DDL
- `src/types.ts` — Zod schemas
- `src/be/db.ts` — DB functions
- `src/http/mcp-servers.ts` — REST endpoints
- `src/tools/mcp-servers/` — MCP tools (7 files)
- `docker-entrypoint.sh` — Boot-time sync
- `src/providers/claude-adapter.ts` — Claude settings.json update
- `src/providers/pi-mono-adapter.ts` — Pi-mono tool injection
- `src/commands/runner.ts` — Between-session sync
- `src/prompts/base-prompt.ts` — System prompt injection
- `new-ui/src/pages/mcp-servers/` — Dashboard pages

## What We're NOT Doing

1. **Template integration** — Templates will NOT define default MCP servers (deferred)
2. **Remote registry** — No GitHub-based install flow for MCP servers. MCP servers are defined by their config, not fetched from repos
3. **Hot-reload** — MCP server changes take effect on the next session, not mid-session
4. **Publish/approval workflow** — No promotion flow. Scope is set at creation time; leads can create any scope
5. **OAuth flow** — OAuth-based MCP servers are out of scope for v1
6. **Health checks** — No reachability monitoring for installed MCP servers
7. **Stdio client for Pi-mono** — Pi-mono only supports HTTP MCP servers (resolved design decision)
8. **Conflict resolution** — If two servers provide same-named tools, that's the agent's problem. Claude namespaces as `mcp__<server>__<tool>` automatically
9. **Resource limits** — No cap on number of MCP servers per agent

## Implementation Approach

Follow the skills system blueprint exactly, adapting for MCP server specifics:

1. **Data layer first** — Migration, types, DB functions (no external dependencies)
2. **HTTP API** — REST endpoints using `route()` factory (depends on data layer)
3. **MCP tools** — Agent-facing tools (depends on data layer)
4. **Provider integration** — Docker entrypoint, Claude settings, Pi-mono adapter, runner, prompt (depends on HTTP API)
5. **Dashboard UI** — Pages, hooks, types (depends on HTTP API)

Key design decisions:
- **Secrets are never in `mcp_servers` table** — Only config key references (`envConfigKeys`, `headerConfigKeys`) pointing to `swarm_config` entries
- **Resolved secrets endpoint** — `GET /api/agents/:id/mcp-servers?resolveSecrets=true` returns actual values for boot-time injection
- **Pi-mono tool namespacing** — Tools from additional MCP servers are prefixed with `mcp__<server>__` to match Claude's convention and avoid conflicts
- **Permission model** — Workers create agent-scope only; leads create any scope (global, swarm, agent)

---

## Phase 1: Data Layer

### Overview
Create the database schema, Zod types, and DB functions for MCP server management. This is the foundation everything else builds on.

### Changes Required:

#### 1. Migration
**File**: `src/be/migrations/021_mcp_servers.sql` (new)
**Changes**: Create `mcp_servers` and `agent_mcp_servers` tables following skills pattern.

```sql
-- MCP server definitions
CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    scope TEXT NOT NULL CHECK(scope IN ('global', 'swarm', 'agent')),
    ownerAgentId TEXT REFERENCES agents(id),
    transport TEXT NOT NULL CHECK(transport IN ('stdio', 'http', 'sse')),
    -- Stdio fields
    command TEXT,
    args TEXT,          -- JSON array string
    -- HTTP/SSE fields
    url TEXT,
    headers TEXT,       -- JSON object string (non-secret headers only)
    -- Secret references (keys in swarm_config, NOT actual values)
    envConfigKeys TEXT,     -- JSON object: {"ENV_VAR": "config-key-name"}
    headerConfigKeys TEXT,  -- JSON object: {"Header-Name": "config-key-name"}
    -- Metadata
    isEnabled INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    UNIQUE(name, scope, COALESCE(ownerAgentId, ''))
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_scope ON mcp_servers(scope);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_owner ON mcp_servers(ownerAgentId);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_transport ON mcp_servers(transport);

-- Per-agent MCP server installation
CREATE TABLE IF NOT EXISTS agent_mcp_servers (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL REFERENCES agents(id),
    mcpServerId TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    isActive INTEGER NOT NULL DEFAULT 1,
    installedAt TEXT NOT NULL,
    UNIQUE(agentId, mcpServerId)
);

CREATE INDEX IF NOT EXISTS idx_agent_mcp_servers_agent ON agent_mcp_servers(agentId);
CREATE INDEX IF NOT EXISTS idx_agent_mcp_servers_server ON agent_mcp_servers(mcpServerId);
```

#### 2. Zod Schemas
**File**: `src/types.ts`
**Changes**: Add MCP server schemas after the existing skill schemas (~line 925). Follow the exact same pattern.

New types to add:
- `McpServerTransportSchema` — `z.enum(["stdio", "http", "sse"])`
- `McpServerScopeSchema` — `z.enum(["global", "swarm", "agent"])`
- `McpServerSchema` — Full server definition (17 fields, mirroring the table)
- `AgentMcpServerSchema` — Junction table record (5 fields)
- `McpServerWithInstallInfoSchema` — Extended with `isActive` + `installedAt`

Also add the `AgentTaskSourceSchema` enum value if MCP-server-related tasks need a source type (check if needed — likely not for v1 since there's no approval workflow).

#### 3. DB Functions
**File**: `src/be/db.ts`
**Changes**: Add MCP server functions after the skill functions section (~line 7393). Follow the same patterns: row types, converter functions, insert interface, CRUD + install/uninstall.

Functions to implement (9 total):

| Function | Signature | Notes |
|----------|-----------|-------|
| `createMcpServer` | `(insert: McpServerInsert) => McpServer` | UUID generation, defaults: `scope ?? "agent"`, `isEnabled: 1`, `version: 1` |
| `updateMcpServer` | `(id: string, updates: Partial<McpServerInsert> & { isEnabled?: boolean }) => McpServer \| null` | Dynamic SET, auto-bump `version` on config changes |
| `deleteMcpServer` | `(id: string) => boolean` | CASCADE deletes junction rows |
| `getMcpServerById` | `(id: string) => McpServer \| null` | Simple SELECT |
| `getMcpServerByName` | `(name: string, scope: string, ownerAgentId: string \| null) => McpServer \| null` | Matches unique index |
| `listMcpServers` | `(filters: { scope?, ownerAgentId?, transport?, isEnabled?, search? }) => McpServer[]` | Dynamic WHERE, ordered by name |
| `installMcpServer` | `(agentId: string, mcpServerId: string) => AgentMcpServer` | `INSERT ON CONFLICT DO UPDATE SET isActive = 1` (upsert) |
| `uninstallMcpServer` | `(agentId: string, mcpServerId: string) => boolean` | Hard DELETE from junction |
| `getAgentMcpServers` | `(agentId: string, activeOnly?: boolean) => McpServerWithInstallInfo[]` | JOIN query, filter `isEnabled = 1`, order by name |

Row conversion types:
- `McpServerRow` + `rowToMcpServer()` — converts `isEnabled` from `number` to `boolean`
- `AgentMcpServerRow` + `rowToAgentMcpServer()` — converts `isActive`
- `McpServerWithInstallRow` + `rowToMcpServerWithInstall()` — composes both

`McpServerInsert` interface — required fields: `name`, `transport`. Optional: `description`, `scope`, `ownerAgentId`, `command`, `args`, `url`, `headers`, `envConfigKeys`, `headerConfigKeys`.

#### 4. Seed Script Extension
**File**: `scripts/seed.ts`
**Changes**: Add MCP server seeding following the existing pattern (seedAgents, seedTasks, etc.).

1. Add `McpServerSeed` interface (~line 30-78 area)
2. Add `mcpServers: { count: number; data?: McpServerSeed[] }` to `SeedConfig`
3. Add `generateMcpServer()` function that creates realistic MCP server configs:
   - Mix of stdio (npx-based: GitHub, Slack, filesystem) and HTTP (search APIs, custom endpoints)
   - Vary scope across global/swarm/agent
   - Include `envConfigKeys`/`headerConfigKeys` for servers that need secrets
4. Add `seedMcpServers(db, config, agents)` function:
   - Uses `seedId("mcp_server", i)` for deterministic IDs
   - Creates ~4 servers by default (2 stdio global, 1 HTTP swarm, 1 HTTP agent-scoped)
   - Installs 2-3 servers per agent via `agent_mcp_servers` junction inserts
5. Add `seedMcpServers` call in `main()` after `seedAgents` (needs agent IDs for ownership/installation)
6. Add `mcp_servers` and `agent_mcp_servers` to `TABLES_IN_DELETE_ORDER` (before `agents`)
7. Add defaults to `scripts/seed.default.json`

**File**: `scripts/seed.default.json`
**Changes**: Add `mcpServers` config block:
```json
"mcpServers": {
  "count": 4,
  "data": [
    { "name": "github", "description": "GitHub API access", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "scope": "global" },
    { "name": "brave-search", "description": "Web search via Brave", "transport": "http", "url": "https://mcp.brave.com/v1", "scope": "swarm" }
  ]
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Migration applies on fresh DB: `rm -f agent-swarm-db.sqlite* && bun run start:http` (check for errors, then Ctrl+C)
- [ ] Migration applies on existing DB: `bun run start:http` (check no migration errors)
- [ ] DB boundary check passes: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] Confirm `mcp_servers` and `agent_mcp_servers` tables exist: `sqlite3 agent-swarm-db.sqlite ".tables" | grep mcp`
- [ ] Confirm indexes exist: `sqlite3 agent-swarm-db.sqlite ".indexes mcp_servers"`
- [ ] Spot-check a createMcpServer + getMcpServerById round-trip in a test

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 2: HTTP API

### Overview
Create REST endpoints for MCP server management using the `route()` factory. Wire into the handler chain and OpenAPI spec.

### Changes Required:

#### 1. HTTP Endpoint Handler
**File**: `src/http/mcp-servers.ts` (new)
**Changes**: Create 9 endpoints following the `src/http/skills.ts` pattern exactly. Use `route()` factory for auto-OpenAPI registration.

| Route | Method | Path | Pattern | Auth | Notes |
|-------|--------|------|---------|------|-------|
| `listMcpServersRoute` | GET | `/api/mcp-servers` | `["api","mcp-servers"]` | apiKey | Query: scope, transport, ownerAgentId, enabled, search |
| `getMcpServerRoute` | GET | `/api/mcp-servers/{id}` | `["api","mcp-servers",null]` | apiKey | |
| `createMcpServerRoute` | POST | `/api/mcp-servers` | `["api","mcp-servers"]` | apiKey | Body: name, transport, + transport-specific fields |
| `updateMcpServerRoute` | PUT | `/api/mcp-servers/{id}` | `["api","mcp-servers",null]` | apiKey | Body: partial update |
| `deleteMcpServerRoute` | DELETE | `/api/mcp-servers/{id}` | `["api","mcp-servers",null]` | apiKey | |
| `installMcpServerRoute` | POST | `/api/mcp-servers/{id}/install` | `["api","mcp-servers",null,"install"]` | apiKey | Body: { agentId } |
| `uninstallMcpServerRoute` | DELETE | `/api/mcp-servers/{id}/install/{agentId}` | `["api","mcp-servers",null,"install",null]` | apiKey | |
| `getAgentMcpServersRoute` | GET | `/api/agents/{id}/mcp-servers` | `["api","agents",null,"mcp-servers"]` | apiKey | Query: resolveSecrets (bool) |

The `getAgentMcpServersRoute` with `?resolveSecrets=true` resolves secret references:
- For each server's `envConfigKeys`, look up each value in `swarm_config` via `getResolvedConfig(agentId)` with `includeSecrets=true`
- Return additional `resolvedEnv` (object) and `resolvedHeaders` (object) fields with actual values
- Without `resolveSecrets`, these fields are omitted

**Validation in create/update handlers:**
- If `transport === "stdio"`: require `command`, validate `args` is valid JSON array if present
- If `transport === "http"` or `"sse"`: require `url`, validate URL format
- Validate `envConfigKeys` and `headerConfigKeys` are valid JSON objects if present

#### 2. Handler Chain Registration
**File**: `src/http/index.ts`
**Changes**: Import `handleMcpServers` and add to the handler chain (after skills handler at line 116).

#### 3. OpenAPI Spec Generation
**File**: `scripts/generate-openapi.ts`
**Changes**: Add import for `src/http/mcp-servers.ts` so route definitions are included in the generated spec.

Run `bun run docs:openapi` to regenerate `openapi.json`.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] OpenAPI spec regenerates: `bun run docs:openapi`
- [ ] DB boundary check passes: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] Start API: `bun run start:http`
- [ ] Create a stdio server: `curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" http://localhost:3013/api/mcp-servers -d '{"name":"github","description":"GitHub API","transport":"stdio","command":"npx","args":"[\"-y\",\"@modelcontextprotocol/server-github\"]","scope":"global"}'`
- [ ] List servers: `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/mcp-servers | jq`
- [ ] Create an HTTP server: `curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" http://localhost:3013/api/mcp-servers -d '{"name":"brave-search","description":"Web search","transport":"http","url":"https://mcp.brave.com/v1","headerConfigKeys":"{\"Authorization\":\"brave-api-key\"}","scope":"swarm"}'`
- [ ] Install for an agent: `curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" http://localhost:3013/api/mcp-servers/<id>/install -d '{"agentId":"<agent-id>"}'`
- [ ] Get agent's servers: `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/agents/<agent-id>/mcp-servers | jq`
- [ ] Get with resolved secrets: `curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/agents/<agent-id>/mcp-servers?resolveSecrets=true" | jq`

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 3: MCP Tools

### Overview
Create 7 agent-facing MCP tools for MCP server management. Register unconditionally in `server.ts` (same as skills).

### Changes Required:

#### 1. Tool Files
**Directory**: `src/tools/mcp-servers/` (new)
**Files**: 8 files (7 tools + barrel export)

| File | Tool Name | Description | Permission |
|------|-----------|-------------|------------|
| `index.ts` | — | Barrel export | — |
| `mcp-server-create.ts` | `mcp-server-create` | Create a new MCP server definition | Any agent (agent scope); lead required for swarm/global. **Auto-installs** for creating agent |
| `mcp-server-update.ts` | `mcp-server-update` | Update server config | Owner or lead |
| `mcp-server-delete.ts` | `mcp-server-delete` | Delete a server definition | Owner or lead. `destructiveHint: true` |
| `mcp-server-get.ts` | `mcp-server-get` | Get server details by ID or name | Any agent. Name resolution: agent > swarm > global |
| `mcp-server-list.ts` | `mcp-server-list` | List servers with filters | Any agent. Supports `installedOnly` flag |
| `mcp-server-install.ts` | `mcp-server-install` | Install server for an agent | Self-install always; cross-agent requires lead |
| `mcp-server-uninstall.ts` | `mcp-server-uninstall` | Uninstall from an agent | Self-uninstall always; cross-agent requires lead. `destructiveHint: true` |

Each tool follows the `createToolRegistrar` pattern from `src/tools/utils.ts`. Input schemas use Zod-compatible JSON Schema.

**`mcp-server-create` input schema:**
```typescript
{
  name: z.string(),
  description: z.string().optional(),
  transport: z.enum(["stdio", "http", "sse"]),
  scope: z.enum(["global", "swarm", "agent"]).optional(), // default: "agent"
  // Stdio
  command: z.string().optional(),
  args: z.string().optional(), // JSON array
  // HTTP/SSE
  url: z.string().optional(),
  headers: z.string().optional(), // JSON object (non-secret)
  // Secret references
  envConfigKeys: z.string().optional(), // JSON object
  headerConfigKeys: z.string().optional(), // JSON object
}
```

**`mcp-server-create` handler logic:**
1. Validate transport-specific fields (stdio needs command, http needs url)
2. Check scope permission (swarm/global requires lead via `getAgentById()` + `isLead` check)
3. Call `createMcpServer()` with `ownerAgentId: agentId`
4. Auto-install for creating agent via `installMcpServer(agentId, server.id)`
5. Return created server

#### 2. Server Registration
**File**: `src/server.ts`
**Changes**: Import and register all 7 MCP server tools after the skills block (~line 273). Add comment: `"MCP Servers - always registered (MCP server management is available to all agents)"`.

```typescript
// MCP Servers - always registered
import { registerMcpServerTools } from "./tools/mcp-servers/index.js";
registerMcpServerTools(server);
```

The barrel export registers all 7 tools.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] DB boundary check passes: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] Start API: `bun run start:http`
- [ ] Verify tools appear in MCP tool listing via curl (use the MCP session handshake from CLAUDE.md "MCP Tool Testing" section, then call `tools/list`)
- [ ] Test `mcp-server-create` tool via MCP protocol: create a stdio server and verify it appears in the DB
- [ ] Test `mcp-server-list` tool: verify it returns the created server
- [ ] Test `mcp-server-install` and `mcp-server-uninstall` tools

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 4: Provider Integration

### Overview
Integrate MCP server management into the Docker entrypoint, Claude adapter (settings.json), Pi-mono adapter (tool injection), runner (between-session sync), and system prompt.

This is the most complex phase — it touches 5 files across the boot and runtime paths.

### Changes Required:

#### 1. Docker Entrypoint — Boot-time MCP Server Sync
**File**: `docker-entrypoint.sh`
**Changes**: Extend Phase 9 (.mcp.json generation, lines 275-295) to fetch and merge installed MCP servers.

After the existing agentmail block (~line 293), add:

```bash
# === Installed MCP servers (from API) ===
if [ -n "$AGENT_ID" ] && [ -n "$API_KEY" ]; then
  log "Fetching installed MCP servers..."
  MCP_SERVERS_RESPONSE=$(curl -sf -H "Authorization: Bearer $API_KEY" \
    "${MCP_URL_HOST}/api/agents/${AGENT_ID}/mcp-servers?resolveSecrets=true" 2>/dev/null) || true

  if [ -n "$MCP_SERVERS_RESPONSE" ]; then
    SERVER_COUNT=$(echo "$MCP_SERVERS_RESPONSE" | jq '.mcpServers | length' 2>/dev/null || echo "0")
    if [ "$SERVER_COUNT" -gt 0 ]; then
      log "Merging $SERVER_COUNT installed MCP server(s) into .mcp.json"
      # Merge each server into MCP_JSON
      MCP_JSON=$(echo "$MCP_SERVERS_RESPONSE" | jq --argjson base "$MCP_JSON" '
        reduce .mcpServers[] as $srv ($base;
          if $srv.transport == "stdio" then
            .mcpServers[$srv.name] = {
              command: $srv.command,
              args: ($srv.args | fromjson // []),
              env: ($srv.resolvedEnv // {})
            }
          elif ($srv.transport == "http" or $srv.transport == "sse") then
            .mcpServers[$srv.name] = {
              type: $srv.transport,
              url: $srv.url,
              headers: (($srv.headers | fromjson // {}) * ($srv.resolvedHeaders // {}))
            }
          else . end
        )
      ')
    fi
  fi
fi
```

#### 2. Docker Entrypoint — Settings.json Permission Update
**File**: `docker-entrypoint.sh`
**Changes**: Add a new step after .mcp.json generation to update `settings.json` with permission patterns for installed MCP servers.

```bash
# === Update settings.json with MCP server permissions ===
if [ -n "$MCP_SERVERS_RESPONSE" ] && [ "$SERVER_COUNT" -gt 0 ]; then
  SETTINGS_FILE="$HOME/.claude/settings.json"
  if [ -f "$SETTINGS_FILE" ]; then
    log "Adding MCP server permission patterns to settings.json"
    UPDATED_SETTINGS=$(echo "$MCP_SERVERS_RESPONSE" | jq --slurpfile settings "$SETTINGS_FILE" '
      [.mcpServers[].name] |
      map("mcp__" + . + "__*") |
      . as $new_perms |
      $settings[0] |
      .permissions.allow = (.permissions.allow + $new_perms | unique)
    ')
    echo "$UPDATED_SETTINGS" > "$SETTINGS_FILE"
  fi
fi
```

#### 3. Pi-mono Adapter — Multi-server Tool Injection
**File**: `src/providers/pi-mono-adapter.ts`
**Changes**: After the existing swarm MCP client setup (~line 392), add logic to connect to additional installed HTTP MCP servers.

Update `createSession()` to:
1. Fetch agent's installed MCP servers from API (HTTP transport only)
2. For each HTTP server, create `McpHttpClient`, initialize, list tools
3. Convert tools with server-name prefix to avoid conflicts
4. Merge into the `customTools` array

```typescript
// After existing swarm tools setup (~line 392):

// Connect to additional installed MCP servers (HTTP only)
if (config.apiUrl && config.apiKey) {
  try {
    const mcpServersRes = await fetch(
      `${config.apiUrl}/api/agents/${config.agentId}/mcp-servers?resolveSecrets=true`,
      { headers: { Authorization: `Bearer ${config.apiKey}` } }
    );
    if (mcpServersRes.ok) {
      const { mcpServers } = await mcpServersRes.json();
      for (const srv of mcpServers) {
        if (srv.transport !== "http" && srv.transport !== "sse") {
          console.warn(`[pi-mono] Skipping MCP server "${srv.name}" — only HTTP transport is supported`);
          continue;
        }
        try {
          const resolvedHeaders = srv.resolvedHeaders ?? {};
          const srvClient = new McpHttpClient(srv.url, "", "", config.taskId);
          // Override headers for this client (auth comes from resolved headers, not API key)
          srvClient.customHeaders = resolvedHeaders;
          await srvClient.initialize();
          const srvTools = await srvClient.listTools();
          const prefixedTools = mcpToolsToDefinitions(
            srvClient, srvTools, `mcp__${srv.name}__`
          );
          customTools.push(...prefixedTools);
          console.log(`[pi-mono] Added ${srvTools.length} tools from MCP server "${srv.name}"`);
        } catch (err) {
          console.warn(`[pi-mono] Failed to connect to MCP server "${srv.name}":`, err);
        }
      }
    }
  } catch (err) {
    console.warn("[pi-mono] Failed to fetch installed MCP servers:", err);
  }
}
```

**Also update `mcpToolsToDefinitions()`** to accept an optional `prefix` parameter:

```typescript
function mcpToolsToDefinitions(
  mcpClient: McpHttpClient,
  tools: McpTool[],
  prefix = ""  // NEW: optional name prefix
): ToolDefinition[] {
  return tools.map((tool) => ({
    name: `${prefix}${tool.name}`,  // Apply prefix
    description: tool.description ?? "",
    // ... rest unchanged
  }));
}
```

**Also add `customHeaders` support to `McpHttpClient`:**

**File**: `src/providers/pi-mono-mcp-client.ts`
**Changes**: Add optional `customHeaders` property that gets merged into request headers in `send()`.

```typescript
public customHeaders: Record<string, string> = {};

// In send(), merge customHeaders:
const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  ...this.customHeaders,  // NEW: merge custom headers
};
if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
// ... rest unchanged
```

#### 4. Runner — Between-session MCP Server Sync
**File**: `src/commands/runner.ts`
**Changes**: After the existing skill fetch block (~line 2093), add MCP server fetch for system prompt injection and `.mcp.json` update.

```typescript
// Fetch installed MCP servers for prompt injection
let agentMcpServersSummary = "";
try {
  const mcpRes = await fetch(
    `${apiUrl}/api/agents/${agentId}/mcp-servers`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  if (mcpRes.ok) {
    const { mcpServers } = await mcpRes.json();
    const active = mcpServers.filter((s: any) => s.isActive && s.isEnabled);
    if (active.length > 0) {
      agentMcpServersSummary = active
        .map((s: any) => `- **${s.name}** (${s.transport}): ${s.description || "No description"}`)
        .join("\n");
    }
  }
} catch {
  // Non-fatal — continue without MCP server info
}
```

Pass `agentMcpServersSummary` to the prompt builder (see next change).

**Additionally**, trigger `.mcp.json` rebuild for Claude provider:
- After fetching MCP servers, if the provider is Claude, read the existing `/workspace/.mcp.json`, merge installed servers (same logic as entrypoint), and write back
- This ensures MCP server changes between sessions take effect without container restart
- For Pi-mono, tool injection happens at session creation time, so no file update needed

#### 5. System Prompt Injection
**File**: `src/prompts/base-prompt.ts`
**Changes**: Add an "Installed MCP Servers" section after the "Installed Skills" section (~line 77).

Update the function signature to accept `mcpServersSummary?: string`:

```typescript
// After the skills section:
if (mcpServersSummary) {
  prompt += `\n\n## Installed MCP Servers\n\nThe following MCP servers are configured for your use:\n${mcpServersSummary}\n`;
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] DB boundary check passes: `bash scripts/check-db-boundary.sh`
- [ ] Unit tests pass: `bun test`

#### Manual Verification:
- [ ] **Docker entrypoint test** (requires Docker):
  1. Start API: `rm -f agent-swarm-db.sqlite* && bun run start:http &`
  2. Create an MCP server and install for an agent via curl
  3. Build Docker image: `bun run docker:build:worker`
  4. Start worker: `docker run --rm -d --name e2e-mcp --env-file .env.docker -e MAX_CONCURRENT_TASKS=1 -p 3203:3000 agent-swarm-worker:latest`
  5. Check .mcp.json: `docker exec e2e-mcp cat /workspace/.mcp.json | jq` — verify installed MCP server appears
  6. Check settings.json: `docker exec e2e-mcp cat /home/worker/.claude/settings.json | jq '.permissions.allow'` — verify `mcp__<name>__*` pattern exists
  7. Cleanup: `docker stop e2e-mcp && kill $(lsof -ti :3013)`
- [ ] **System prompt test**: Verify the prompt includes "Installed MCP Servers" section by checking runner logs or system prompt output

**Implementation Note**: This phase has the most moving parts. Test entrypoint changes with a full Docker round-trip. After completing this phase, pause for manual confirmation. Create commit after verification passes.

### QA Spec (optional):

**Approach:** cli-verification
**Test Scenarios:**
- [ ] TC-1: Docker boot with installed MCP servers
  - Steps: 1. Create MCP server via API, 2. Install for agent, 3. Boot Docker container, 4. Check .mcp.json
  - Expected: Installed server appears in .mcp.json with correct transport config
- [ ] TC-2: Settings.json permission patterns
  - Steps: 1. Boot container with installed servers, 2. Check settings.json
  - Expected: `mcp__<name>__*` patterns in permissions.allow
- [ ] TC-3: Between-session sync
  - Steps: 1. Start worker, 2. Add new MCP server via API, 3. Wait for next task, 4. Check .mcp.json
  - Expected: New server appears after session boundary

---

## Phase 5: Dashboard UI

### Overview
Add MCP server management pages to the `new-ui/` dashboard, following the skills UI pattern.

### Changes Required:

#### 1. TypeScript Types
**File**: `new-ui/src/api/types.ts`
**Changes**: Add MCP server types mirroring the API response shapes.

```typescript
export interface McpServer {
  id: string;
  name: string;
  description: string | null;
  scope: "global" | "swarm" | "agent";
  ownerAgentId: string | null;
  transport: "stdio" | "http" | "sse";
  command: string | null;
  args: string | null;
  url: string | null;
  headers: string | null;
  envConfigKeys: string | null;
  headerConfigKeys: string | null;
  isEnabled: boolean;
  version: number;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface McpServerWithInstallInfo extends McpServer {
  isActive: boolean;
  installedAt: string;
}
```

#### 2. API Hooks
**File**: `new-ui/src/api/hooks/use-mcp-servers.ts` (new)
**Changes**: React Query hooks following the `use-skills.ts` pattern.

Hooks to implement:
- `useMcpServers(filters?)` — GET /api/mcp-servers
- `useMcpServer(id)` — GET /api/mcp-servers/:id
- `useCreateMcpServer()` — POST mutation
- `useUpdateMcpServer()` — PUT mutation
- `useDeleteMcpServer()` — DELETE mutation
- `useAgentMcpServers(agentId)` — GET /api/agents/:id/mcp-servers
- `useInstallMcpServer()` — POST install mutation
- `useUninstallMcpServer()` — DELETE uninstall mutation

Export from `new-ui/src/api/hooks/index.ts`.

#### 3. MCP Servers List Page
**File**: `new-ui/src/pages/mcp-servers/page.tsx` (new)
**Changes**: List page showing all MCP servers with scope/transport badges, search, and create button. Follow `pages/skills/page.tsx` layout.

Table columns: Name, Transport, Scope, Description, Enabled, Created

#### 4. MCP Server Detail Page
**File**: `new-ui/src/pages/mcp-servers/[id]/page.tsx` (new)
**Changes**: Detail/edit page showing server config, installed agents, and enable/disable toggle. Follow `pages/skills/[id]/page.tsx` layout.

Sections:
- Server info (name, description, transport, scope)
- Config details (command/args for stdio, url/headers for http)
- Secret references (envConfigKeys, headerConfigKeys — show key names, not values)
- Installed agents list with install/uninstall actions

#### 5. Agent Detail — MCP Servers Tab
**File**: `new-ui/src/pages/agents/[id]/page.tsx`
**Changes**: Add an "MCP Servers" tab alongside the existing tabs. Show installed MCP servers with install/uninstall actions. Follow the skills tab pattern.

#### 6. Router + Navigation
**File**: `new-ui/src/app/router.tsx`
**Changes**: Add routes for `/mcp-servers` and `/mcp-servers/:id`.

**File**: `new-ui/src/components/layout/app-sidebar.tsx`
**Changes**: Add "MCP Servers" link in the sidebar navigation (near the Skills link).

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [ ] Lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Start API + UI: `bun run pm2-start` (or `bun run start:http & cd new-ui && pnpm dev`)
- [ ] Navigate to MCP Servers page — verify list loads
- [ ] Create a new MCP server from the API, refresh page — verify it appears
- [ ] Click into server detail — verify config displays correctly
- [ ] Navigate to an agent's detail page — verify MCP Servers tab shows installed servers
- [ ] Install/uninstall a server from the agent detail page

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

### QA Spec (optional):

**Approach:** seeding (`bun run seed`) + browser-automation
**Setup:** Run `bun run seed --clean` to populate the DB with MCP server test data (added in Phase 1). The seed script creates ~4 MCP servers (2 stdio global, 1 HTTP swarm, 1 HTTP agent-scoped) and installs 2-3 per seeded agent. This provides repeatable test state with deterministic IDs.

```bash
# Seed all test data including MCP servers
bun run seed --clean
# Start API + UI
bun run start:http &
cd new-ui && pnpm dev
```

**Test Scenarios:**
- [ ] TC-1: MCP Servers list page
  - Steps: 1. Seed data via API, 2. Navigate to /mcp-servers, 3. Verify table shows seeded servers, 4. Filter by transport (stdio/http), 5. Filter by scope
  - Expected: Both seeded servers appear with correct transport/scope badges, filters narrow results
- [ ] TC-2: MCP Server detail page
  - Steps: 1. Navigate to /mcp-servers/:github-id, 2. Verify stdio config (command, args), 3. Navigate to /mcp-servers/:brave-id, 4. Verify HTTP config (url)
  - Expected: Transport-specific fields render correctly, secret key references shown (not values)
- [ ] TC-3: Agent MCP Servers tab
  - Steps: 1. Navigate to /agents/:agent-id, 2. Switch to MCP Servers tab, 3. Verify both servers listed, 4. Uninstall one, 5. Verify it disappears, 6. Reinstall it
  - Expected: Installed servers shown with correct state, install/uninstall toggles work

---

## Testing Strategy

### Unit Tests

**File**: `src/tests/mcp-servers.test.ts` (new)

Test coverage:
1. **DB functions**: Create, read, update, delete MCP servers. Install/uninstall junction operations. Upsert behavior on reinstall. Cascade delete behavior.
2. **Transport validation**: Stdio requires command, HTTP requires url.
3. **Scope/permission logic**: Workers can only create agent-scope. Leads can create any scope.
4. **Secret resolution**: Verify `resolveSecrets` returns actual values from config.
5. **Name uniqueness**: Same name allowed in different scopes, rejected in same scope+owner.

Test pattern: Isolated SQLite DB per test file (`./test-mcp-servers.sqlite`), `initDb()`/`closeDb()` in `beforeAll`/`afterAll`, cleanup in `afterAll`.

### Integration Tests

- **HTTP endpoints**: Minimal `node:http` handler with the mcp-servers route, test CRUD + install/uninstall flows via fetch
- **MCP tools**: Test tool registration and basic tool calls via MCP protocol handshake (see CLAUDE.md "MCP Tool Testing" section)

### Pre-PR Checks

```bash
bun run tsc:check            # Root TypeScript
bun run lint:fix             # Root Biome
bun test                     # All unit tests
bash scripts/check-db-boundary.sh  # Worker/API boundary
cd new-ui && pnpm exec tsc --noEmit  # UI TypeScript
cd new-ui && pnpm lint       # UI Biome
bun run docs:openapi         # OpenAPI spec
```

### Manual E2E

```bash
# 1. Clean DB + start API
rm -f agent-swarm-db.sqlite*
bun run start:http &

# 2. Create an MCP server
curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  http://localhost:3013/api/mcp-servers \
  -d '{"name":"github","description":"GitHub API","transport":"stdio","command":"npx","args":"[\"-y\",\"@modelcontextprotocol/server-github\"]","envConfigKeys":"{\"GITHUB_TOKEN\":\"github-token\"}","scope":"global"}'

# 3. Store a secret for it
curl -s -X PUT -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  http://localhost:3013/api/config \
  -d '{"scope":"global","key":"github-token","value":"ghp_xxx","isSecret":true}'

# 4. Register an agent (or use existing)
# (use join-swarm or existing agent)

# 5. Install the server for the agent
curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  http://localhost:3013/api/mcp-servers/<server-id>/install \
  -d '{"agentId":"<agent-id>"}'

# 6. Get resolved servers
curl -s -H "Authorization: Bearer 123123" \
  "http://localhost:3013/api/agents/<agent-id>/mcp-servers?resolveSecrets=true" | jq

# 7. Build and test Docker
bun run docker:build:worker
docker run --rm -d --name e2e-mcp --env-file .env.docker \
  -e MAX_CONCURRENT_TASKS=1 -p 3203:3000 agent-swarm-worker:latest

# 8. Verify .mcp.json includes the github server
docker exec e2e-mcp cat /workspace/.mcp.json | jq '.mcpServers.github'

# 9. Verify settings.json permissions
docker exec e2e-mcp cat /home/worker/.claude/settings.json | jq '.permissions.allow'

# 10. Cleanup
docker stop e2e-mcp
kill $(lsof -ti :3013) 2>/dev/null
```

## References

- Research: `thoughts/taras/research/2026-03-25-mcp-server-support.md`
- Skills blueprint: `thoughts/swarm-jackknife/plans/2026-03-24-skill-system-implementation.md`
- Pi-mono research: `thoughts/taras/research/2026-03-05-pi-mono-provider-research.md`
