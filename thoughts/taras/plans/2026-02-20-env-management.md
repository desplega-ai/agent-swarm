---
date: 2026-02-20
planner: Claude
branch: claw-env-management
repository: agent-swarm
topic: "Env Management API — Gap 6 Implementation"
tags: [plan, env-management, config, gap-6, agent-native]
status: draft
autonomy: autopilot
research: thoughts/taras/research/2026-02-19-swarm-gaps-implementation.md
---

# Env Management API — Implementation Plan

## Overview

Implement a centralized environment/config management system for the agent swarm. This is Gap 6 from the swarm-gaps research and the first phase in the agent-native architecture rollout (order: 6 → 1 → 2 → 3 → 4 → 5).

Today, env vars are scattered across flat `.env` files (`.env`, `.env.docker`, `.env.docker-lead`) with no centralized store, no per-agent config, no per-repo config, and no UI for management. The only env-like storage is `services.env` (a JSON column for PM2 service env vars).

This plan adds: a `swarm_config` DB table with scoped key-value storage, REST API endpoints, Docker entrypoint integration (exporting config as env vars), and a UI management page.

## Current State Analysis

### What Exists

- **Flat `.env` files**: `.env` (API server), `.env.docker` (worker), `.env.docker-lead` (lead). Workers receive env vars via Docker `--env-file` or docker-compose `environment:` blocks.
- **No config DB table**: The only env-like DB storage is `services.env` JSON column (`src/be/db.ts:157`).
- **No config API**: No REST endpoints for config CRUD. The UI's `ConfigModal.tsx` only stores API URL and API key in localStorage.
- **Docker entrypoint**: Validates only `CLAUDE_CODE_OAUTH_TOKEN` and `API_KEY` (`docker-entrypoint.sh:4-13`). Has one `curl` call pattern (ecosystem fetch at lines 49-51) that we can model after.
- **Per-agent config**: Only `maxTasks`, `claudeMd`, `role`, `capabilities` on the `agents` table.

### Key Discoveries

- DB table creation goes inside `initSchema` transaction in `src/be/db.ts` (before line 325)
- DB CRUD follows: Row type → `rowToEntity` converter → exported functions using `getDb().prepare()` with `RETURNING *`
- REST routes use manual `if` checks on `pathSegments` in `src/http.ts`; query params via `parseQueryParams()`; body parsing inline with `for await`
- UI uses MUI Joy Tabs in `Dashboard.tsx`; API calls via `ApiClient` class + React Query hooks; beehive theme with local `colors` objects
- Docker entrypoint curl pattern: `-s -f -H "Authorization: Bearer ${API_KEY}" -H "X-Agent-ID: ${AGENT_ID}"` with temp file output

## Desired End State

1. A `swarm_config` table stores key-value pairs scoped to `global`, `agent`, or `repo`
2. REST API at `/api/config` supports CRUD with scope filtering and resolved (merged) config
3. Docker entrypoint fetches resolved config and exports as env vars before launching the agent — this is the primary mechanism agents use to access config (via `process.env`)
4. UI has a "CONFIG" tab with sub-tabs for Global, Per-Agent, and Per-Repo config management
5. Secrets are masked in API responses by default; an `?includeSecrets=true` param reveals them
6. The `envPath` feature auto-writes `KEY=VALUE` to `.env` files on the filesystem when config is created/updated

### Verification of End State

```bash
# API works (port from MCP_PORT env var or default 3013)
curl -H "Authorization: Bearer $API_KEY" http://localhost:${MCP_PORT:-3013}/api/config?scope=global
curl -H "Authorization: Bearer $API_KEY" http://localhost:${MCP_PORT:-3013}/api/config/resolved?agentId=<uuid>

# Type check passes
bun run tsc:check

# Lint passes
bun run lint:fix
```

## Quick Verification Reference

Common commands:
- `bun run tsc:check` — TypeScript type checking
- `bun run lint:fix` — Biome lint + format
- `bun run start:http` — Start HTTP server (port 3013)
- `bun run dev:http` — Dev with hot reload

Key files to check:
- `src/be/db.ts` — Table + CRUD functions
- `src/http.ts` — REST API endpoints
- `src/types.ts` — Zod schemas
- `docker-entrypoint.sh` — Config injection
- `ui/src/components/ConfigPanel.tsx` — UI management

## What We're NOT Doing

- **Encryption at rest** — secrets stored as plain text in SQLite (per research decision #5)
- **Config versioning/history** — no audit trail for config changes
- **Config validation** — no schema validation on values (free-form text)
- **Real-time config push** — config is pulled at container start, not pushed via WebSocket
- **MCP tool for config** — agents access config via `process.env` (injected at container start), no dedicated MCP tool needed
- **Nested/hierarchical keys** — flat key-value only, no dotted key paths
- **Config from file import/export** — no bulk import from `.env` files into DB

## Implementation Approach

Four phases, each independently verifiable:

1. **DB + Types**: Schema, CRUD functions, Zod types
2. **REST API**: HTTP endpoints for CRUD + resolved config
3. **Docker Entrypoint**: Fetch resolved config and export as env vars at container start
4. **UI**: Config management tab in the dashboard

---

## Phase 1: Database Schema + CRUD Functions + Types

### Overview

Add the `swarm_config` table to SQLite, define the TypeScript types/Zod schemas, and implement all CRUD + resolution functions in `db.ts`.

### Changes Required:

#### 1. Zod Schema
**File**: `src/types.ts`
**Changes**: Add `SwarmConfigSchema` and related types after the existing schemas (~line 135):

```typescript
export const SwarmConfigSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(["global", "agent", "repo"]),
  scopeId: z.string().nullable(),  // agentId or repoId, null for global
  key: z.string().min(1).max(255),
  value: z.string(),
  isSecret: z.boolean(),
  envPath: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});

export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;
```

#### 2. Database Table
**File**: `src/be/db.ts`
**Changes**: Add `CREATE TABLE IF NOT EXISTS swarm_config` inside the `initSchema` transaction (before the closing `}` at ~line 325). Add indexes for common queries.

```sql
CREATE TABLE IF NOT EXISTS swarm_config (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('global', 'agent', 'repo')),
  scopeId TEXT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  isSecret INTEGER NOT NULL DEFAULT 0,
  envPath TEXT,
  description TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  UNIQUE(scope, scopeId, key)
)
```

Indexes:
```sql
CREATE INDEX IF NOT EXISTS idx_swarm_config_scope ON swarm_config(scope)
CREATE INDEX IF NOT EXISTS idx_swarm_config_scope_id ON swarm_config(scope, scopeId)
CREATE INDEX IF NOT EXISTS idx_swarm_config_key ON swarm_config(key)
```

#### 3. Row Type + Converter
**File**: `src/be/db.ts`
**Changes**: Add after existing row types (after the epics section):

```typescript
type SwarmConfigRow = {
  id: string;
  scope: string;
  scopeId: string | null;
  key: string;
  value: string;
  isSecret: number;  // SQLite boolean
  envPath: string | null;
  description: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToSwarmConfig(row: SwarmConfigRow): SwarmConfig {
  return {
    id: row.id,
    scope: row.scope as "global" | "agent" | "repo",
    scopeId: row.scopeId ?? null,
    key: row.key,
    value: row.value,
    isSecret: row.isSecret === 1,
    envPath: row.envPath ?? null,
    description: row.description ?? null,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}
```

#### 4. CRUD Functions
**File**: `src/be/db.ts`
**Changes**: Add exported functions following the existing pattern:

- `getSwarmConfigs(filters?: { scope?, scopeId?, key? }): SwarmConfig[]` — list with optional filters
- `getSwarmConfigById(id: string): SwarmConfig | null` — single by ID
- `upsertSwarmConfig(data: { scope, scopeId?, key, value, isSecret?, envPath?, description? }): SwarmConfig` — insert or update by (scope, scopeId, key) unique constraint
- `deleteSwarmConfig(id: string): boolean` — delete by ID
- `getResolvedConfig(agentId?: string, repoId?: string): SwarmConfig[]` — returns merged config with scope resolution (repo > agent > global). Returns one entry per key with the most-specific scope winning.

The `getResolvedConfig` function logic:
1. Fetch all `global` configs
2. If `agentId` provided, fetch all `agent` configs for that agent, overlay on global (same key = agent wins)
3. If `repoId` provided, fetch all `repo` configs for that repo, overlay on agent+global (same key = repo wins)
4. Return the merged set

#### 5. Secret Masking Helper
**File**: `src/be/db.ts`
**Changes**: Add a helper that masks secret values:

```typescript
export function maskSecrets(configs: SwarmConfig[]): SwarmConfig[] {
  return configs.map(c => c.isSecret ? { ...c, value: "********" } : c);
}
```

#### 6. envPath Writer Helper
**File**: `src/be/db.ts`
**Changes**: Add a helper that writes config values to `.env` files when `envPath` is set. This is called by `upsertSwarmConfig` after successful DB write.

```typescript
function writeEnvFile(configs: SwarmConfig[]): void {
  // Group configs by envPath
  // For each envPath, read existing file, update/add matching keys, write back
  // Skip if envPath is null
}
```

Note: The `envPath` writer only runs on the API server (where the DB lives). For Docker workers, the entrypoint fetches config and exports as env vars — the `envPath` feature is for the API server's own filesystem or shared volumes.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Server starts without errors: `bun run start:http` (ctrl+c after startup)
- [x] Table exists: `sqlite3 agent-swarm-db.sqlite ".schema swarm_config"`

#### Manual Verification:
- [x] Start server, confirm no migration errors in console output
- [x] Verify the unique constraint works (try inserting duplicate scope+scopeId+key via DB directly)

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding.

---

## Phase 2: REST API Endpoints

### Overview

Add CRUD and resolved-config endpoints under `/api/config` in `http.ts`, following the existing routing and response patterns.

### Changes Required:

#### 1. Config Endpoints
**File**: `src/http.ts`
**Changes**: Add route blocks in the REST API section (after the scheduled-tasks endpoints, before the 404 fallback). Import new DB functions at the top of the file.

**Endpoints:**

| Method | Path | Query Params | Body | Response |
|--------|------|-------------|------|----------|
| GET | `/api/config` | `scope`, `scopeId`, `includeSecrets` | — | `{ configs: SwarmConfig[] }` |
| GET | `/api/config/resolved` | `agentId`, `repoId`, `includeSecrets` | — | `{ configs: SwarmConfig[] }` |
| GET | `/api/config/:id` | `includeSecrets` | — | `SwarmConfig` (unwrapped) |
| PUT | `/api/config` | — | `{ scope, scopeId?, key, value, isSecret?, envPath?, description? }` | `SwarmConfig` (upserted, 200/201) |
| DELETE | `/api/config/:id` | — | — | `{ success: true }` |

**Normal vs Resolved:**
- `GET /api/config?scope=global` — returns **raw entries** for a specific scope. No merging. Exactly what's stored in the DB. Used by the UI for CRUD management.
- `GET /api/config/resolved?agentId=X` — returns the **merged result** across all scopes (global + agent + repo), with scope resolution applied (most-specific wins). One entry per unique key. Used by the Docker entrypoint to get the final set of env vars for an agent.

**Route matching patterns:**

```
GET /api/config/resolved → pathSegments = ["api", "config", "resolved"] && !pathSegments[3]
GET /api/config/:id      → pathSegments = ["api", "config", pathSegments[2]] && !pathSegments[3] && pathSegments[2] !== "resolved"
GET /api/config          → pathSegments = ["api", "config"] && !pathSegments[2]
PUT /api/config          → method === "PUT" && pathSegments = ["api", "config"] && !pathSegments[2]
DELETE /api/config/:id   → method === "DELETE" && pathSegments = ["api", "config", pathSegments[2]] && !pathSegments[3]
```

**Important ordering**: The `GET /api/config/resolved` route MUST come before `GET /api/config/:id` since "resolved" would otherwise match as an `:id` parameter.

**Secret handling**: By default, `maskSecrets()` is applied to all responses. If `includeSecrets=true` query param is present, raw values are returned.

**PUT upsert logic**:
1. Parse body, validate required fields (`scope`, `key`, `value`)
2. Validate scope is one of `global`, `agent`, `repo`
3. If scope is `global`, ensure `scopeId` is null
4. If scope is `agent` or `repo`, require `scopeId`
5. Call `upsertSwarmConfig()` — returns the created/updated config
6. If `envPath` is set, trigger env file write
7. Return the config (masked if secret, unless `includeSecrets=true`)

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Create global config: `curl -s -X PUT -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d '{"scope":"global","key":"TEST_KEY","value":"test_value","description":"A test config"}' http://localhost:3013/api/config | jq .`
- [x] List global config: `curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/config?scope=global" | jq .`
- [x] Create secret: `curl -s -X PUT -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d '{"scope":"global","key":"SECRET_KEY","value":"s3cret","isSecret":true}' http://localhost:3013/api/config | jq .`
- [x] Verify masking: `curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/config?scope=global" | jq '.configs[] | select(.key == "SECRET_KEY") | .value'` — should return `"********"`
- [x] Verify reveal: `curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/config?scope=global&includeSecrets=true" | jq '.configs[] | select(.key == "SECRET_KEY") | .value'` — should return `"s3cret"`
- [x] Get resolved config: `curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/config/resolved" | jq .`
- [x] Delete config: `curl -s -X DELETE -H "Authorization: Bearer 123123" http://localhost:3013/api/config/<id> | jq .`

#### Manual Verification:
- [x] Test scope override: create a global key, then an agent-scoped key with the same name, verify resolved endpoint returns the agent-scoped value
- [x] Test upsert: PUT the same scope+scopeId+key twice with different values, verify only one entry exists with the updated value
- [x] Test validation: PUT with missing `key` field, verify 400 error

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding.

---

## Phase 3: Docker Entrypoint Integration

### Overview

Update the Docker entrypoint to fetch resolved config from the API and export as env vars at container start. This is the primary mechanism agents use to access config — via `process.env` in their Claude sessions.

### Changes Required:

#### 1. Docker Entrypoint Config Fetch
**File**: `docker-entrypoint.sh`
**Changes**: Add a config fetch step between the PM2 restoration (line 78) and MCP config creation (line 88). This position:
- Is after `MCP_URL` is computed (line 17)
- Is after `AGENT_ID` is available
- Is before the startup script (line 203), so config vars are available to startup scripts
- Is before the agent binary launch (line 352)

```bash
# ---- Fetch swarm config from API ----
if [ -n "$AGENT_ID" ]; then
    echo "Fetching swarm config from API..."
    if curl -s -f -H "Authorization: Bearer ${API_KEY}" \
       -H "X-Agent-ID: ${AGENT_ID}" \
       "${MCP_URL}/api/config/resolved?agentId=${AGENT_ID}&includeSecrets=true" \
       > /tmp/swarm_config.json 2>/dev/null; then

        CONFIG_COUNT=$(jq ‘.configs | length’ /tmp/swarm_config.json 2>/dev/null || echo "0")
        if [ "$CONFIG_COUNT" -gt 0 ]; then
            echo "Found $CONFIG_COUNT config entries, exporting as env vars..."
            # Write key=value pairs to a temp env file (jq handles JSON escaping,
            # we write raw values one per line). Then source it with set -a.
            jq -r ‘.configs[] | "\(.key)=\(.value)"’ /tmp/swarm_config.json > /tmp/swarm_config.env 2>/dev/null || true
            if [ -f /tmp/swarm_config.env ]; then
                set -a
                . /tmp/swarm_config.env
                set +a
                rm -f /tmp/swarm_config.env
            fi
        fi
        rm -f /tmp/swarm_config.json
    else
        echo "Warning: Could not fetch swarm config (API may not be ready)"
    fi
fi
# ---- End swarm config fetch ----
```

**Why `set -a` + `source` instead of `eval`**: The `eval` approach is vulnerable to shell injection — a config value containing shell metacharacters (e.g., `"; rm -rf /; "`) would execute arbitrary commands. The `source` approach with `set -a` (auto-export) treats each line as a literal `KEY=VALUE` assignment without shell interpretation of the value.

**Caveat**: Values containing newlines won’t work with this approach (the `.env` file format is one entry per line). If multi-line values are needed in the future, we’d need a different mechanism (e.g., base64-encode values or write a proper shell script with quoting). For now, single-line values cover all practical env var use cases.

DB config unconditionally overwrites any existing env vars. This is intentional — DB-managed config is the source of truth. If a Docker env var and a DB config key collide, the DB value wins.

### Success Criteria:

#### Automated Verification:
- [x] Entrypoint syntax is valid: `bash -n docker-entrypoint.sh`
- [x] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] If Docker environment available: build worker image, start container with some config in DB, verify env vars are exported (check with `env | grep <KEY>` inside the container)
- [ ] Verify that config entries with secrets are exported with their actual values (not masked)

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding. Docker testing may require `bun run docker:build:worker` if available.

---

## Phase 4: UI Config Management Page

### Overview

Add a "CONFIG" tab to the dashboard with sub-tabs for Global, Per-Agent, and Per-Repo config management. Each sub-tab shows a table of config entries with add/edit/delete capabilities.

### Changes Required:

#### 1. API Client Methods
**File**: `ui/src/lib/api.ts`
**Changes**: Add methods to `ApiClient`:

```typescript
// Config API methods
async getConfigs(filters?: { scope?: string; scopeId?: string; includeSecrets?: boolean }): Promise<{ configs: SwarmConfig[] }>
async getResolvedConfig(params?: { agentId?: string; repoId?: string; includeSecrets?: boolean }): Promise<{ configs: SwarmConfig[] }>
async upsertConfig(data: { scope: string; scopeId?: string; key: string; value: string; isSecret?: boolean; envPath?: string; description?: string }): Promise<SwarmConfig>
async deleteConfig(id: string): Promise<{ success: boolean }>
```

#### 2. TypeScript Types
**File**: `ui/src/types/api.ts`
**Changes**: Add `SwarmConfig` interface matching the API response shape.

#### 3. React Query Hooks
**File**: `ui/src/hooks/queries.ts`
**Changes**: Add hooks:

```typescript
export function useConfigs(filters?: { scope?: string; scopeId?: string })
export function useResolvedConfig(params?: { agentId?: string; repoId?: string })
export function useUpsertConfig()   // useMutation
export function useDeleteConfig()   // useMutation
```

#### 4. Config Panel Component
**File**: `ui/src/components/ConfigPanel.tsx` (new file)
**Changes**: Create a panel with:

- **Sub-tabs**: Global | Per-Agent | Per-Repo (using nested MUI Joy `Tabs`)
- **Global tab**: Table of all global configs. Add button opens an inline form or modal.
- **Per-Agent tab**: Dropdown to select an agent, then table of that agent's configs.
- **Per-Repo tab**: Text input for repo ID (or dropdown if repos are tracked), then table.
- **Table columns**: Key, Value (masked for secrets with reveal toggle), Description, envPath, Actions (edit/delete)
- **Add/Edit form**: Key (text), Value (text/password for secrets), isSecret (checkbox), envPath (optional text), Description (optional text)
- **Delete**: Confirmation before delete

Follow existing panel patterns:
- `Card variant="outlined"` wrapper
- Hex accent icon in header
- Beehive theme colors via local `colors` object
- MUI Joy components: `Table`, `Input`, `Button`, `IconButton`, `Checkbox`, `Select`, `Option`

#### 5. Dashboard Integration
**File**: `ui/src/components/Dashboard.tsx`
**Changes**:

1. Add `"config"` to the `activeTab` type and URL param handling
2. Add `<Tab value="config">CONFIG</Tab>` in the TabList
3. Add `<TabPanel value="config">` with the `ConfigPanel` component
4. Add a case in `handleTabChange` for `"config"` that clears unrelated selections
5. Optionally: change the Header settings gear to navigate to the config tab instead of (or in addition to) opening the ConfigModal

#### 6. Redirect Settings Gear (optional)
**File**: `ui/src/components/Header.tsx`
**Changes**: The gear icon currently opens the ConfigModal (for API URL/key). We could:
- Keep ConfigModal as-is (it configures the dashboard's own connection)
- Add a separate "Swarm Config" button or link that navigates to the config tab
- Or: move the API connection settings into the config tab as well

Recommendation: Keep the gear icon opening ConfigModal (it's dashboard-specific local config). The new CONFIG tab is for swarm-wide env config. They serve different purposes.

### Success Criteria:

#### Automated Verification:
- [x] UI type check passes: `cd ui && bun run tsc` (or equivalent)
- [x] UI builds without errors: `cd ui && bun run build`
- [x] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Navigate to CONFIG tab in the dashboard
- [ ] Global sub-tab: add a config entry, verify it appears in the table
- [ ] Add a secret: verify value is masked, click reveal to see it
- [ ] Per-Agent sub-tab: select an agent, add agent-scoped config
- [ ] Edit an existing config entry (change value), verify update
- [ ] Delete a config entry, verify removal
- [ ] Verify responsive layout on mobile (table should scroll or collapse)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Manual E2E Verification

After all phases are complete, run these commands to verify the full feature end-to-end:

```bash
# 1. Start the server
bun run start:http

# 2. Create global config entries
curl -s -X PUT -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"scope":"global","key":"OPENAI_API_KEY","value":"sk-test-123","isSecret":true,"description":"OpenAI API key for embeddings"}' \
  http://localhost:3013/api/config | jq .

curl -s -X PUT -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"scope":"global","key":"DEFAULT_BRANCH","value":"main","description":"Default git branch"}' \
  http://localhost:3013/api/config | jq .

# 3. Create agent-scoped config (use a real agent ID from your swarm)
AGENT_ID="<your-agent-id>"
curl -s -X PUT -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d "{\"scope\":\"agent\",\"scopeId\":\"${AGENT_ID}\",\"key\":\"DEFAULT_BRANCH\",\"value\":\"develop\",\"description\":\"Agent prefers develop branch\"}" \
  http://localhost:3013/api/config | jq .

# 4. Verify scope resolution (agent overrides global for DEFAULT_BRANCH)
curl -s -H "Authorization: Bearer 123123" \
  "http://localhost:3013/api/config/resolved?agentId=${AGENT_ID}" | jq .
# Expected: DEFAULT_BRANCH=develop (agent), OPENAI_API_KEY=******** (global, masked)

# 5. Verify secret reveal
curl -s -H "Authorization: Bearer 123123" \
  "http://localhost:3013/api/config/resolved?agentId=${AGENT_ID}&includeSecrets=true" | jq .
# Expected: OPENAI_API_KEY=sk-test-123 (revealed)

# 6. List all global config
curl -s -H "Authorization: Bearer 123123" \
  "http://localhost:3013/api/config?scope=global" | jq .

# 7. Delete a config entry
CONFIG_ID="<id-from-step-2>"
curl -s -X DELETE -H "Authorization: Bearer 123123" \
  "http://localhost:3013/api/config/${CONFIG_ID}" | jq .

# 8. Open UI dashboard, navigate to CONFIG tab, verify entries are visible
open http://localhost:5274  # or wherever the UI is served

# 9. (If Docker available) Test entrypoint integration
# Build worker image, start with AGENT_ID set, verify env vars appear
```

## Testing Strategy

- **No unit tests in this phase**: The codebase does not have an established test suite pattern. Focus on manual verification via curl commands and UI interaction.
- **Type safety**: `bun run tsc:check` catches schema mismatches between DB functions and API handlers.
- **Lint**: `bun run lint:fix` ensures code style consistency.
- **Integration testing**: The curl commands in each phase's verification section serve as integration tests.

## References

- Research: `thoughts/taras/research/2026-02-19-swarm-gaps-implementation.md` (Gap 6 section, lines 333-383)
- Architecture: `thoughts/taras/research/2026-02-19-agent-native-swarm-architecture.md`
- Previous CLAUDE.md work: `thoughts/taras/research/2026-01-28-per-worker-claude-md.md`
