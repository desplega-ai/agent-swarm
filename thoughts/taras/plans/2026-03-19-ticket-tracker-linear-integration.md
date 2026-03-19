---
date: 2026-03-19
planner: claude
topic: "Ticket Tracker Integration — Linear First"
branch: linear-integration-foundation
pr: 161
status: completed
autonomy: verbose
commit_per_phase: true
research: thoughts/taras/research/2026-03-18-linear-integration-finalization.md
---

# Ticket Tracker Integration — Linear First

## Overview

Nuke the existing Linear prototype on the `linear-integration-foundation` branch and rebuild from scratch with:
1. A **generic OAuth module** (`src/oauth/` + `src/be/db-queries/oauth.ts`) — reusable across the entire swarm, not just trackers
2. A **generic tracker abstraction** (convention-based: generic DB tables + provider directory + route pattern)
3. **Linear as the first provider** — OAuth, webhooks, AgentSessionEvent, bidirectional sync

Single PR (#161), nuked and rebuilt from scratch.

## Current State Analysis

**Existing code on branch** (to be deleted):
- `src/linear/` (5 files): app.ts, client.ts, oauth.ts, types.ts, index.ts
- `src/http/linear.ts`: OAuth authorize + callback routes at `/api/linear/*`
- `src/be/migrations/008_linear_integration.sql`: Linear-specific tables (`linear_oauth_tokens`, `linear_sync`, `linear_agent_mapping`)
- Wired into `src/http/index.ts` (init + route handler) and `src/http/core.ts` (auth bypass)
- `openapi.json` has Linear routes registered
- `src/types.ts:66` has `"linear"` in `AgentTaskSourceSchema`

**What's missing:**
- No webhook handler / AgentSessionEvent support
- No sync logic (inbound or outbound)
- No MCP tools
- No generic tracker abstraction (tables are Linear-specific)
- No `src/be/db-queries/` modules (queries inline in oauth.ts)
- `actor=app` missing from OAuth URL
- Manual PKCE implementation (plan: adopt `oauth4webapi`)
- OAuth scopes include `admin` (should be dropped)

**Patterns to follow** (from research):
- Init lifecycle: `isXxxEnabled()` / `initXxx()` / `resetXxx()` — from `src/github/app.ts`
- HTTP routes: `route()` factory + `handleXxx()` → `Promise<boolean>` — from `src/http/linear.ts`
- Webhook handling: signature verify → parse body → dispatch — from `src/http/webhooks.ts`
- Task creation: `createTaskExtended()` with source/type metadata — from `src/github/handlers.ts`
- MCP tools: `registerXxxTool(server)` via `createToolRegistrar` + Zod — from `src/tools/get-task-details.ts`
- Tool grouping: subdirectory with barrel index — from `src/tools/epics/`
- Tool registration: in `src/server.ts`, add to `DEFERRED_TOOLS` in `src/tools/tool-config.ts`

## Desired End State

After all phases:
1. Generic `oauth_apps` + `oauth_tokens` tables serve any OAuth provider in the swarm
2. Generic `tracker_sync` + `tracker_agent_mapping` tables serve any ticket tracker
3. `src/oauth/wrapper.ts` provides reusable OAuth 2.0 + PKCE via `oauth4webapi`
4. Linear integration fully works: OAuth, webhooks, AgentSessionEvent, bidirectional sync
5. 6 MCP tools for tracker management
6. Setup documentation in `.env.example` + inline code comments
7. Full test coverage: unit + integration + manual E2E

### Key Discoveries:
- Migration 008 is safe to replace (branch not merged to main, no production DBs)
- `src/http/core.ts:85-87` handles auth bypass for OAuth callback — needs updating for new route paths
- `src/http/index.ts:96` calls `handleLinear()` in handler chain — needs replacing with `handleTrackers()`
- `src/http/index.ts:190` calls `initLinear()` on startup — keep same pattern
- `src/server.ts:114-180` registers all MCP tools — new tracker tools go here
- `src/tools/tool-config.ts` classifies tools as CORE or DEFERRED — tracker tools are DEFERRED
- `createTaskExtended()` in `src/be/db.ts` is the universal task creation function
- `route()` in `src/http/route-def.ts` auto-registers routes for OpenAPI generation

## Quick Verification Reference

Common commands:
- `bun run lint:fix` — Biome lint + format
- `bun run tsc:check` — TypeScript type check
- `bun test` — Run all unit tests
- `bun test src/tests/<file>.test.ts` — Run specific test

Key files (after implementation):
- `src/be/migrations/008_tracker_integration.sql` — Generic tables
- `src/be/db-queries/oauth.ts` — Generic OAuth CRUD
- `src/be/db-queries/tracker.ts` — Tracker sync/mapping CRUD
- `src/oauth/wrapper.ts` — Generic OAuth wrapper (oauth4webapi)
- `src/linear/` — Linear-specific code (app, oauth, client, webhook, sync, types)
- `src/http/trackers/linear.ts` — Linear HTTP routes
- `src/tools/tracker/` — Tracker MCP tools

## What We're NOT Doing

- **Dashboard UI for Linear** — deferred to a separate PR
- **Jira/Trello/Asana providers** — architecture supports them, but only Linear implemented
- **History sync** — only incremental, triggered by app assignment/@mention
- **Multi-workspace** — single Linear workspace per swarm
- **Abstract interfaces / factory pattern** — convention-based abstraction only (matches VCS pattern)

## Implementation Approach

**Nuke and rebuild**: Delete all existing Linear code, replace migration 008, build fresh with generic abstractions from day 1.

**Key design decisions** (agreed with Taras):
- `oauth4webapi` for generic OAuth wrapper (serves entire swarm, not just trackers)
- Generic OAuth module in `src/oauth/` + `src/be/db-queries/oauth.ts` (separate from tracker code)
- Fire-and-forget promise for 10-second AgentSessionEvent timeout
- `Linear-Delivery` header dedup for loop prevention (not timing window)
- Routes at `/api/trackers/linear/*` (OAuth flow accessed via tracker routes, backed by generic internals)
- Drop `admin` scope — minimum viable: `read,write,issues:create,comments:create,app:assignable,app:mentionable`

---

## Phase 1: Nuke + Generic Foundation

### Overview
Delete all existing Linear code. Create new migration 008 with generic tables. Build the generic DB query layer for OAuth and tracker sync/mapping. Add `TrackerProvider` type.

### Changes Required:

#### 1. Delete existing Linear code
**Files to delete**:
- `src/linear/app.ts`
- `src/linear/client.ts`
- `src/linear/oauth.ts`
- `src/linear/types.ts`
- `src/linear/index.ts`
- `src/http/linear.ts`
- `src/be/migrations/008_linear_integration.sql`

#### 2. Remove Linear references from HTTP wiring
**File**: `src/http/index.ts`
**Changes**:
- Remove import of `handleLinear` (line ~23)
- Remove `handleLinear` from handler chain (line ~96)
- Remove `initLinear()` call from startup (line ~190) — will be re-added in Phase 2

**File**: `src/http/core.ts`
**Changes**:
- Remove import of `initLinear`/`resetLinear` from `../linear` (line ~14)
- Remove auth bypass for `/api/linear/authorize` and `/api/linear/callback` (lines ~85-87)
- Remove `resetLinear()` call from config reload (lines ~112-113)

**File**: `openapi.json`
**Changes**:
- Remove Linear route entries (will be auto-regenerated when new routes are added)

#### 3. Create new migration
**File**: `src/be/migrations/008_tracker_integration.sql`
**Changes**: Replace the old Linear-specific migration with generic tables:

```sql
-- Generic OAuth application configuration (one row per provider)
CREATE TABLE IF NOT EXISTS oauth_apps (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    provider TEXT NOT NULL UNIQUE,
    clientId TEXT NOT NULL,
    clientSecret TEXT NOT NULL,
    authorizeUrl TEXT NOT NULL,
    tokenUrl TEXT NOT NULL,
    redirectUri TEXT NOT NULL,
    scopes TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generic OAuth token storage (one active token set per provider)
CREATE TABLE IF NOT EXISTS oauth_tokens (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    provider TEXT NOT NULL UNIQUE,
    accessToken TEXT NOT NULL,
    refreshToken TEXT,
    expiresAt TEXT NOT NULL,
    scope TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (provider) REFERENCES oauth_apps(provider)
);

-- Generic tracker entity mapping
CREATE TABLE IF NOT EXISTS tracker_sync (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    provider TEXT NOT NULL,
    entityType TEXT NOT NULL CHECK (entityType IN ('task', 'epic')),
    providerEntityType TEXT,
    swarmId TEXT NOT NULL,
    externalId TEXT NOT NULL,
    externalIdentifier TEXT,
    externalUrl TEXT,
    lastSyncedAt TEXT NOT NULL DEFAULT (datetime('now')),
    lastSyncOrigin TEXT CHECK (lastSyncOrigin IN ('swarm', 'external')),
    lastDeliveryId TEXT,
    syncDirection TEXT NOT NULL DEFAULT 'inbound',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, entityType, swarmId),
    UNIQUE(provider, entityType, externalId)
);

-- Generic agent-to-external-user mapping
CREATE TABLE IF NOT EXISTS tracker_agent_mapping (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    provider TEXT NOT NULL,
    agentId TEXT NOT NULL,
    externalUserId TEXT NOT NULL,
    agentName TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, agentId),
    UNIQUE(provider, externalUserId)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider);
CREATE INDEX IF NOT EXISTS idx_tracker_sync_swarm ON tracker_sync(provider, entityType, swarmId);
CREATE INDEX IF NOT EXISTS idx_tracker_sync_external ON tracker_sync(provider, entityType, externalId);
CREATE INDEX IF NOT EXISTS idx_tracker_agent_agentId ON tracker_agent_mapping(provider, agentId);
```

Plus the `agent_tasks` table recreation with `'linear'` in the source CHECK constraint. **Copy lines 54-114 from the current `008_linear_integration.sql`** — this is a 60-line block that: creates `agent_tasks_new` with the updated CHECK, copies data via `INSERT INTO ... SELECT * FROM`, drops the old table, renames, and recreates all indexes. Do not write this from scratch — the column listing and index definitions must exactly match the existing table.

#### 4. Create tracker types
**File**: `src/tracker/types.ts` (new)
**Changes**: Define `TrackerProvider` type and shared interfaces:
```typescript
export type TrackerProvider = "linear"; // extend as providers are added

export interface TrackerSync { /* matches tracker_sync table */ }
export interface TrackerAgentMapping { /* matches tracker_agent_mapping table */ }
```

#### 5. Create generic OAuth DB query layer
**File**: `src/be/db-queries/oauth.ts` (new)
**Changes**: All OAuth DB functions, provider-parameterized:
- `getOAuthApp(provider)`, `upsertOAuthApp(provider, data)`
- `getOAuthTokens(provider)`, `storeOAuthTokens(provider, data)`, `deleteOAuthTokens(provider)`
- `isTokenExpiringSoon(provider, bufferMs?)`

#### 6. Create tracker DB query layer
**File**: `src/be/db-queries/tracker.ts` (new)
**Changes**: All tracker sync/mapping DB functions:
- `getTrackerSync(provider, entityType, swarmId)`, `getTrackerSyncByExternalId(...)`, `createTrackerSync(...)`, `updateTrackerSync(...)`, `deleteTrackerSync(id)`, `getAllTrackerSyncs(provider?, entityType?)`
- `getTrackerAgentMapping(provider, agentId)`, `getTrackerAgentMappingByExternalUser(...)`, `createTrackerAgentMapping(...)`, `deleteTrackerAgentMapping(...)`, `getAllTrackerAgentMappings(provider?)`

#### 7. Unit tests
**File**: `src/tests/db-queries-oauth.test.ts` (new)
**Changes**: Test all OAuth DB CRUD operations with isolated test DB

**File**: `src/tests/db-queries-tracker.test.ts` (new)
**Changes**: Test all tracker sync/mapping CRUD operations, uniqueness constraints, provider filtering

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] OAuth DB tests pass: `bun test src/tests/db-queries-oauth.test.ts`
- [ ] Tracker DB tests pass: `bun test src/tests/db-queries-tracker.test.ts`
- [ ] All existing tests still pass: `bun test`
- [ ] Server starts cleanly: `bun run start:http` (check no crash, migration applies)
- [ ] Fresh DB works: `rm -f agent-swarm-db.sqlite* && bun run start:http`
- [ ] OpenAPI spec regenerated: `bun run docs:openapi` (commit the updated `openapi.json`)

#### Manual Verification:
- [ ] Verify migration creates all 4 generic tables (inspect with `sqlite3`)
- [ ] Verify `agent_tasks` still works with `'linear'` source
- [ ] Verify no leftover Linear references: `grep -r "linear_oauth_tokens\|linear_sync\|linear_agent_mapping" src/`
- [ ] Verify old routes are gone: `curl http://localhost:3013/api/linear/authorize` returns 404

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

---

## Phase 2: Generic OAuth Wrapper + Linear OAuth

### Overview
Install `oauth4webapi`. Build a generic OAuth 2.0 + PKCE wrapper. Implement Linear-specific OAuth (with `actor=app`, correct scopes). Create HTTP routes at `/api/trackers/linear/`. Wire into server startup.

### Changes Required:

#### 1. Install oauth4webapi
**Command**: `bun add oauth4webapi`

#### 2. Create generic OAuth wrapper
**File**: `src/oauth/wrapper.ts` (new)
**Changes**: Thin wrapper (~100-150 lines) around `oauth4webapi`:
- `OAuthProviderConfig` interface: endpoints, clientId, scopes, PKCE method, extra params
- `buildAuthorizationUrl(config)` → URL + state + codeVerifier (stored in-memory with TTL cleanup)
- `exchangeCode(config, code, state)` → tokens (persisted via `src/be/db-queries/oauth.ts`)
- `refreshToken(config, provider)` → refreshed tokens (persisted)

In-memory pending state map with 10-minute TTL (same pattern as current `oauth.ts` but generic).

**File**: `src/oauth/index.ts` (new barrel)

#### 3. Create Linear app lifecycle
**File**: `src/linear/app.ts` (new — same pattern as before)
**Changes**: `isLinearEnabled()`, `initLinear()`, `resetLinear()` following GitHub pattern.
- Check `LINEAR_DISABLE`, `LINEAR_ENABLED`, `LINEAR_CLIENT_ID`
- On init: upsert the `oauth_apps` row for Linear with endpoints, scopes, metadata

#### 4. Create Linear OAuth config
**File**: `src/linear/oauth.ts` (new)
**Changes**: Linear-specific OAuth configuration:
- Provider config object with Linear endpoints, scopes (`read,write,issues:create,comments:create,app:assignable,app:mentionable` — no `admin`), `actor=app` in metadata
- `getLinearAuthorizationUrl()` → calls generic `buildAuthorizationUrl()` with Linear config
- `handleLinearCallback(code, state)` → calls generic `exchangeCode()` with Linear config

#### 5. Create Linear client wrapper
**File**: `src/linear/client.ts` (new — similar to before)
**Changes**: `@linear/sdk` wrapper with auto-refresh:
- `getLinearClient()` — reads tokens from generic `oauth_tokens` via `getOAuthTokens("linear")`
- `withLinearClient(fn)` — auto-retry on auth errors, uses generic `refreshToken()`
- `resetLinearClient()`

#### 6. Create Linear types
**File**: `src/linear/types.ts` (new)
**Changes**: Linear-specific types:
- `LinearTokenResponse` (OAuth token endpoint response shape)
- Linear webhook event types (for Phase 3)

**File**: `src/linear/index.ts` (new barrel)

#### 7. Create HTTP route handler
**File**: `src/http/trackers/linear.ts` (new)
**Changes**: Define routes using `route()` factory (following `src/http/linear.ts` / `src/http/webhooks.ts` pattern):

```typescript
const linearAuthorize = route({
  method: "get",
  path: "/api/trackers/linear/authorize",
  pattern: ["api", "trackers", "linear", "authorize"],
  summary: "Redirect to Linear OAuth consent screen",
  tags: ["Trackers"],
  responses: {
    302: { description: "Redirect to Linear OAuth" },
    500: { description: "Failed to generate authorization URL" },
    503: { description: "Linear integration not configured" },
  },
});

const linearCallback = route({
  method: "get",
  path: "/api/trackers/linear/callback",
  pattern: ["api", "trackers", "linear", "callback"],
  summary: "Handle Linear OAuth callback",
  tags: ["Trackers"],
  auth: { apiKey: false },
  query: z.object({
    code: z.string(),
    state: z.string(),
  }),
  responses: {
    200: { description: "OAuth complete" },
    400: { description: "Invalid state or code" },
    500: { description: "Token exchange failed" },
  },
});

const linearStatus = route({
  method: "get",
  path: "/api/trackers/linear/status",
  pattern: ["api", "trackers", "linear", "status"],
  summary: "Linear connection status, token expiry, workspace info, expected webhook URL",
  tags: ["Trackers"],
  responses: {
    200: { description: "Connection status" },
    503: { description: "Linear integration not configured" },
  },
});
```

- Handler: `export async function handleLinearTracker(req, res, pathSegments): Promise<boolean>`
- Uses `match()` only for authorize/status (no body/params), `parse()` for callback (query params)

**File**: `src/http/trackers/index.ts` (new barrel)
**Changes**: Aggregate tracker handlers:
```typescript
export async function handleTrackers(req, res, pathSegments): Promise<boolean> {
  return await handleLinearTracker(req, res, pathSegments);
  // Future: || await handleJiraTracker(...)
}
```

#### 8. Wire into server
**File**: `src/http/index.ts`
**Changes**:
- Import `handleTrackers` from `./trackers`
- Add `() => handleTrackers(req, res, pathSegments)` to handler chain
- Import `initLinear` from `../linear`
- Add `initLinear()` call in server listen callback

**File**: `src/http/core.ts`
**Changes**:
- Import `initLinear`/`resetLinear` from `../linear`
- Add auth bypass for `/api/trackers/linear/callback` only
- Add `resetLinear()` to config reload

#### 9. Update .env.example
**File**: `.env.example`
**Changes**: Update Linear env vars section to match new architecture, document `LINEAR_SIGNING_SECRET` for Phase 3

#### 10. Unit tests
**File**: `src/tests/oauth-wrapper.test.ts` (new)
**Changes**: Test generic OAuth wrapper:
- `buildAuthorizationUrl()` generates correct URL with PKCE
- State TTL cleanup works
- Token persistence via DB functions

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] OAuth wrapper tests pass: `bun test src/tests/oauth-wrapper.test.ts`
- [ ] All existing tests pass: `bun test`
- [ ] Server starts cleanly: `bun run start:http`
- [ ] OpenAPI spec regenerated: `bun run docs:openapi` (commit the updated `openapi.json`)

#### Manual Verification:
- [ ] `GET /api/trackers/linear/authorize` returns 302 redirect to `linear.app/oauth/authorize` with `actor=app` in URL
- [ ] Redirect URL contains correct scopes (no `admin`), `code_challenge_method=S256`
- [ ] `GET /api/trackers/linear/status` returns connection status (should show "not connected" before OAuth)
- [ ] `GET /api/trackers/linear/callback` with invalid state returns 400
- [ ] Old routes `/api/linear/*` still return 404
- [ ] `oauth_apps` row for "linear" is created on server startup (check via `sqlite3`)

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

---

## Phase 3: Webhook + Inbound Sync

### Overview
Implement Linear webhook handling with signature verification, AgentSessionEvent processing, and inbound sync (Linear issues → swarm tasks, projects → epics). Fire-and-forget for heavy work. Linear-Delivery header dedup.

### Changes Required:

#### 1. Create webhook handler
**File**: `src/linear/webhook.ts` (new)
**Changes**:
- `verifyLinearWebhook(rawBody, signature, secret)` — HMAC-SHA256 with timing-safe comparison
- `handleLinearWebhook(rawBody, headers)` — main dispatcher:
  1. Verify signature using `LINEAR_SIGNING_SECRET`
  2. Check `Linear-Delivery` header for dedup (store in `tracker_sync.lastDeliveryId` or separate in-memory set with TTL)
  3. Parse event type from body
  4. Dispatch to appropriate handler
- `handleAgentSessionEvent(event)` — the primary entry point:
  1. Respond immediately (fire-and-forget pattern)
  2. In deferred promise: create swarm task via `createTaskExtended()` with `source: "linear"`
  3. Update AgentSession state via Linear API (`pending` → `active`)
- `handleIssueUpdate(event)` — status change sync
- `handleIssueDelete(event)` — cancel corresponding swarm task

#### 2. Create inbound sync logic
**File**: `src/linear/sync.ts` (new)
**Changes**:
- Status mapping: Linear states → swarm task statuses
  - Backlog → skip (don't create task)
  - Todo → `unassigned`
  - In Progress → `in_progress`
  - Done → `completed`
  - Cancelled → `cancelled`
- Polymorphic mapping heuristics:
  - Issue (no sub-issues) → 1 Task
  - Issue (with sub-issues) → 1 Epic + N Tasks
  - Project → 1 Epic, project issues → N Tasks under epic
- `syncIssueToTask(issue)` — creates/updates task, creates `tracker_sync` mapping
- `syncIssueToEpic(issue)` — creates/updates epic, syncs sub-issues as tasks
- Uses `createTrackerSync()` from generic DB layer

#### 3. Add webhook route
**File**: `src/http/trackers/linear.ts`
**Changes**: Add webhook route using `route()` factory (follows `src/http/webhooks.ts` pattern — no body schema, manual raw body reading for signature verification):

```typescript
const linearWebhook = route({
  method: "post",
  path: "/api/trackers/linear/webhook",
  pattern: ["api", "trackers", "linear", "webhook"],
  summary: "Handle Linear webhook events (signature-verified)",
  tags: ["Trackers"],
  auth: { apiKey: false },
  responses: {
    200: { description: "Event accepted" },
    401: { description: "Invalid signature" },
    503: { description: "Linear integration not configured" },
  },
});
```

- Uses `match()` only (no `parse()`) — raw body is read manually for HMAC signature verification (same pattern as `githubWebhook` in `src/http/webhooks.ts`)
- Fire-and-forget pattern: respond 200 immediately, run heavy work in deferred promise
- **Error handling**: Wrap deferred work in try/catch — log errors via `console.error` with webhook event context. Do not silently swallow failures. If `createTaskExtended()` fails, log the full error + webhook payload for debugging.

**File**: `src/http/core.ts`
**Changes**:
- Add auth bypass for `/api/trackers/linear/webhook`

#### 4. Dedup storage
**File**: `src/linear/webhook.ts`
**Changes**:
- In-memory `Set<string>` with TTL for `Linear-Delivery` header values
- TTL of 5 minutes (covers Linear's retry window)
- Cleanup on each new webhook arrival

#### 5. Integration tests
**File**: `src/tests/linear-webhook.test.ts` (new)
**Changes**:
- Test signature verification (valid/invalid/missing)
- Test AgentSessionEvent → task creation
- Test dedup (same delivery ID rejected)
- Test status mapping (all Linear states)
- Test fire-and-forget pattern (200 response before task creation completes)
- Mock `@linear/sdk` API calls

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Webhook tests pass: `bun test src/tests/linear-webhook.test.ts`
- [ ] All existing tests pass: `bun test`
- [ ] OpenAPI spec regenerated: `bun run docs:openapi` (commit the updated `openapi.json`)

#### Manual Verification:
- [ ] `POST /api/trackers/linear/webhook` with invalid signature returns 401
- [ ] `POST /api/trackers/linear/webhook` with valid signature returns 200
- [ ] Duplicate `Linear-Delivery` header is rejected
- [ ] AgentSessionEvent creates a swarm task with `source: "linear"`
- [ ] Response arrives within 1-2 seconds (fire-and-forget works)

**Implementation Note**: After completing this phase, pause for manual confirmation. Full webhook testing requires ngrok/cloudflared for real Linear webhooks (Phase 6). This phase uses mocked webhooks. Commit after verification passes.

---

## Phase 4: MCP Tools + Outbound Sync

### Overview
Create 6 MCP tools for tracker management. Implement outbound sync (swarm task status changes → Linear issue updates). Loop prevention with delivery ID tracking.

### Changes Required:

#### 1. Create tracker MCP tools
**Directory**: `src/tools/tracker/` (new)

**File**: `src/tools/tracker/tracker-status.ts`
- Show all connected trackers and their OAuth status (token expiry, workspace info)
- Read-only, uses `getOAuthTokens()` + `getOAuthApp()`

**File**: `src/tools/tracker/tracker-link-task.ts`
- Link a swarm task to an external issue (manual override)
- Creates `tracker_sync` row with `entityType: "task"`

**File**: `src/tools/tracker/tracker-link-epic.ts`
- Link a swarm epic to an external issue/project
- Creates `tracker_sync` row with `entityType: "epic"`

**File**: `src/tools/tracker/tracker-unlink.ts`
- Remove a sync mapping by ID
- Destructive, uses `deleteTrackerSync()`

**File**: `src/tools/tracker/tracker-sync-status.ts`
- Show all sync mappings with their state (last sync time, direction, origin)
- Read-only, uses `getAllTrackerSyncs()`

**File**: `src/tools/tracker/tracker-map-agent.ts`
- Map a swarm agent to an external user (for assignment sync)
- Creates `tracker_agent_mapping` row

**File**: `src/tools/tracker/index.ts` (barrel)

#### 2. Register tools
**File**: `src/server.ts`
**Changes**: Import and register all 6 tracker tools in a new `// Tracker` section

**File**: `src/tools/tool-config.ts`
**Changes**: Add all 6 tools to `DEFERRED_TOOLS` set:
```typescript
// Tracker (6)
"tracker-status",
"tracker-link-task",
"tracker-link-epic",
"tracker-unlink",
"tracker-sync-status",
"tracker-map-agent",
```

#### 3. Outbound sync via event bus (not db.ts modification)
**File**: `src/linear/outbound.ts` (new)
**Changes**: Subscribe to `workflowEventBus` events and sync to Linear:
- `initLinearOutboundSync()` — called from `initLinear()`, subscribes to event bus
- `teardownLinearOutboundSync()` — called from `resetLinear()`, unsubscribes
- Event handlers (each checks for `tracker_sync` mapping before acting):
  - `task.completed` → mark Linear issue Done + add completion comment
  - `task.failed` → add failure comment on Linear issue
  - `task.cancelled` → update Linear issue status
  - `task.progress` → add progress comment on Linear issue (new event, see below)

**File**: `src/workflows/event-bus.ts`
**Changes**: No code changes needed — the event bus is generic. But `db.ts` needs a new emission:

**File**: `src/be/db.ts`
**Changes** (minimal — only add missing event emissions, no integration-specific imports):
- In `updateTaskProgress()`: add `workflowEventBus.emit("task.progress", { taskId, progress })` via dynamic import (same pattern as existing `task.completed`/`task.failed` emissions)
- This keeps `db.ts` integration-agnostic — it emits generic events, listeners decide what to do

**File**: `src/linear/sync.ts`
**Changes**: Add outbound sync functions called by `outbound.ts` handlers:
- `syncTaskCompletionToLinear(taskId, output)` — mark issue Done + add completion comment
- `syncTaskFailureToLinear(taskId, reason)` — add failure comment on Linear issue
- `syncTaskProgressToLinear(taskId, progress)` — add comment on Linear issue

**Rationale**: This follows the existing pattern — `db.ts` has zero integration-specific imports today. GitHub is inbound-only, Slack polls the DB, Workflows subscribe to the event bus. Linear outbound sync subscribes to the same event bus, keeping `db.ts` clean.

#### 4. Loop prevention
**File**: `src/linear/outbound.ts`
**Changes**:
- Before outbound sync: check `tracker_sync.lastSyncOrigin`
- If `lastSyncOrigin = 'external'` and `lastSyncedAt` within 5s → skip (belt-and-suspenders with delivery ID)
- After outbound sync: update `lastSyncOrigin = 'swarm'`, `lastSyncedAt = now()`
- Primary dedup is `Linear-Delivery` header (Phase 3), this is fallback only

#### 5. Unit tests
**File**: `src/tests/tracker-tools.test.ts` (new)
**Changes**: Test all 6 MCP tools via direct function calls (not full HTTP)

**File**: `src/tests/linear-outbound-sync.test.ts` (new)
**Changes**: Test outbound sync functions with mocked Linear API

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Tracker tools tests pass: `bun test src/tests/tracker-tools.test.ts`
- [ ] Outbound sync tests pass: `bun test src/tests/linear-outbound-sync.test.ts`
- [ ] All existing tests pass: `bun test`
- [ ] OpenAPI spec regenerated: `bun run docs:openapi` (commit the updated `openapi.json`)

#### Manual Verification:
- [ ] MCP tool `tracker-status` returns connected tracker info (or "no trackers connected")
- [ ] MCP tool `tracker-link-task` creates a sync mapping in DB
- [ ] MCP tool `tracker-sync-status` shows the mapping just created
- [ ] MCP tool `tracker-unlink` removes the mapping
- [ ] Tools appear in DEFERRED_TOOLS and are discoverable via Tool Search

**Implementation Note**: After completing this phase, pause for manual confirmation. Outbound sync to real Linear requires OAuth tokens (Phase 6). Commit after verification passes.

---

## Phase 5: Documentation + Setup Guide

### Overview
Document the Linear integration setup process. Update `.env.example` with all required variables. Add inline code comments for non-obvious decisions. Update CLAUDE.md if needed.

### Changes Required:

#### 1. Update .env.example
**File**: `.env.example`
**Changes**: Complete Linear section with all required/optional env vars:
```bash
# ── Linear Integration ──
# LINEAR_DISABLE=true          # Set to disable Linear integration
# LINEAR_CLIENT_ID=            # OAuth app client ID (Settings > API > OAuth applications)
# LINEAR_CLIENT_SECRET=        # OAuth app client secret (shown once on creation)
# LINEAR_REDIRECT_URI=http://localhost:3013/api/trackers/linear/callback
# LINEAR_SIGNING_SECRET=       # Webhook HMAC verification secret
# LINEAR_TEAM_ID=              # Optional: scope to a specific team
```

#### 2. Add setup documentation
**File**: `src/linear/README.md` (new)
**Changes**: Step-by-step Linear app setup:
1. Create OAuth Application at `linear.app/settings/api/applications`
2. Configure callback URLs
3. Enable webhooks + Agent session events
4. Copy credentials to `.env`
5. Run OAuth flow: `curl -H "Authorization: Bearer $API_KEY" http://localhost:3013/api/trackers/linear/authorize`
6. Verify connection: `curl -H "Authorization: Bearer $API_KEY" http://localhost:3013/api/trackers/linear/status`

#### 3. Add architecture notes
**File**: `src/oauth/README.md` (new)
**Changes**: Brief doc explaining generic OAuth module:
- How `oauth_apps` + `oauth_tokens` tables work
- How to add a new OAuth provider
- How `oauth4webapi` wrapper is used

#### 4. Update MCP.md
**File**: `MCP.md`
**Changes**: Add tracker tools section with descriptions

### Success Criteria:

#### Automated Verification:
- [ ] Lint passes: `bun run lint:fix`
- [ ] All tests pass: `bun test`

#### Manual Verification:
- [ ] `.env.example` has complete Linear section with comments
- [ ] `src/linear/README.md` is clear and actionable
- [ ] `src/oauth/README.md` explains the generic pattern
- [ ] MCP.md includes tracker tools

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

---

## Phase 6: Full End-to-End Testing

### Overview
Comprehensive testing split into two categories: automated tests Claude can run independently, and manual tests requiring Taras's help (real Linear workspace, ngrok, etc.).

### Automated E2E (Claude can run):

#### 1. Server startup E2E
```bash
# Fresh DB + server start
rm -f agent-swarm-db.sqlite*
bun run start:http &
sleep 2

# Verify tables exist
sqlite3 agent-swarm-db.sqlite ".tables" | grep -E "oauth_apps|oauth_tokens|tracker_sync|tracker_agent_mapping"

# Verify no old tables
sqlite3 agent-swarm-db.sqlite ".tables" | grep -v "linear_oauth_tokens\|linear_sync\|linear_agent_mapping"

# Verify routes respond
curl -s -o /dev/null -w "%{http_code}" http://localhost:3013/api/trackers/linear/status
# Expected: 503 (not configured) or 200

# Verify old routes gone
curl -s -o /dev/null -w "%{http_code}" http://localhost:3013/api/linear/authorize
# Expected: 404

kill $(lsof -ti :3013)
```

#### 2. Full test suite
```bash
bun test
bun run tsc:check
bun run lint:fix
```

#### 3. MCP tool integration test
```bash
# Start server, initialize MCP session, call tracker-status tool
# (Using the MCP Streamable HTTP test pattern from CLAUDE.md)
```

### Manual E2E (Taras helps):

#### 1. OAuth Flow
- [x] Set `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_REDIRECT_URI`, `LINEAR_SIGNING_SECRET` in `.env`
- [x] Start server: `bun run start:http`
- [x] Visit `http://localhost:3013/api/trackers/linear/authorize` in browser
- [x] Authorize the app (must be workspace admin for `actor=app`)
- [x] Verify callback success page
- [x] Check status: `curl -H "Authorization: Bearer $API_KEY" http://localhost:3013/api/trackers/linear/status`
- [x] Verify `oauth_tokens` row exists: `sqlite3 agent-swarm-db.sqlite "SELECT provider, scope, expiresAt FROM oauth_tokens"`

#### 2. Inbound Sync (requires ngrok/cloudflared)

> **Webhook setup is manual.** Linear doesn't have an API to programmatically register webhooks for OAuth apps. You configure the webhook URL once in Linear's app settings (Settings > API > OAuth applications > your app > Webhook URL + enable "Agent session events"). The `/status` endpoint will display the expected webhook URL so you know what to configure. For local dev, use a tunnel URL.

- [x] Start tunnel: `ngrok http 3013` (or `cloudflared tunnel --url http://localhost:3013`)
- [x] In Linear app settings, set Webhook URL to `<tunnel-url>/api/trackers/linear/webhook` and enable "Agent session events"
- [x] @mention the app in a Linear comment → verify swarm task created
- [x] Delegate issue to app → verify swarm task via `AgentSessionEvent`
- [x] Change status in Linear → verify swarm task status updates
- [x] Delete issue → verify task cancelled

#### 3. Outbound Sync
- [x] Complete swarm task → verify Linear issue marked "Done"
- [x] Fail swarm task → verify Linear comment with failure info
- [x] Task progress update → verify Linear comment

#### 4. Edge Cases
- [ ] Token expires (wait 24hr or manually expire) → verify auto-refresh
- [ ] Duplicate webhooks (replay same delivery) → verify idempotent
- [ ] Invalid webhook signature → verify 401
- [ ] Server restart mid-sync → verify no data loss

### Success Criteria:

#### Automated Verification:
- [ ] All tests pass: `bun test`
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Server startup E2E passes (fresh DB)
- [ ] OpenAPI spec is fresh: check `openapi.json` includes tracker routes

#### Manual Verification:
- [x] Full OAuth flow works with real Linear workspace
- [x] @mention creates swarm task
- [x] Bidirectional status sync works
- [ ] Duplicate webhook delivery is deduplicated
- [ ] Token auto-refresh works

**Implementation Note**: Automated E2E runs first. Manual E2E requires Taras to set up Linear app credentials and ngrok tunnel.

---

## Testing Strategy

| Layer | What | Where |
|-------|------|-------|
| Unit | OAuth DB CRUD | `src/tests/db-queries-oauth.test.ts` |
| Unit | Tracker sync/mapping CRUD | `src/tests/db-queries-tracker.test.ts` |
| Unit | OAuth wrapper (PKCE, URL generation) | `src/tests/oauth-wrapper.test.ts` |
| Unit | MCP tracker tools | `src/tests/tracker-tools.test.ts` |
| Unit | Outbound sync functions | `src/tests/linear-outbound-sync.test.ts` |
| Integration | Webhook signature + dispatch | `src/tests/linear-webhook.test.ts` |
| Integration | Inbound sync (mocked Linear API) | `src/tests/linear-webhook.test.ts` |
| E2E (automated) | Server startup, fresh DB, routes | Phase 6 automated section |
| E2E (manual) | Real OAuth, webhooks, bidirectional sync | Phase 6 manual section |

## References

- Research: `thoughts/taras/research/2026-03-18-linear-integration-finalization.md`
- PR: #161 on `linear-integration-foundation` branch
- Linear Agent Interaction SDK: https://linear.app/docs/agent-interaction-sdk
- `oauth4webapi`: https://github.com/panva/oauth4webapi
- `@linear/sdk`: https://www.npmjs.com/package/@linear/sdk

---

## Review Errata

_Reviewed: 2026-03-19 by Claude_

### Critical

- [x] **Phase 4 Outbound Sync: Architecture breaks `db.ts` isolation pattern.** — RESOLVED: Rewrote Phase 4 §3 to use `workflowEventBus` subscription in `src/linear/outbound.ts` instead of modifying `db.ts` directly. The plan proposes adding Linear-specific sync calls directly into `src/be/db.ts` (`completeTask()`, `failTask()`, `updateTaskProgress()`). Today, `db.ts` has **zero integration-specific imports** — only `bun:sqlite`, types, and the migration runner. The existing event bus (`workflowEventBus`) is consumed via dynamic import specifically to avoid coupling. No existing integration (GitHub, Slack, Workflows) modifies these functions — GitHub is inbound-only (calls db functions as a consumer), Slack polls the DB every 3s, Workflows subscribe to the event bus. **Recommended approach**: Emit new events from `db.ts` (e.g., `task.completed` already exists) and subscribe to them in a new `src/linear/outbound.ts` module — consistent with the workflow pattern and keeps `db.ts` integration-agnostic. The `workflowEventBus` already emits `task.completed` and `task.created`; extend it with `task.failed`, `task.cancelled`, `task.progress` and subscribe from the Linear module.

### Important

- [x] **Migration 008 `agent_tasks` table recreation SQL not shown.** — RESOLVED: Added explicit reference to copy lines 54-114 from current migration in Phase 1 §3. The plan mentions "Plus the `agent_tasks` table recreation with `'linear'` in the source CHECK" but doesn't include the SQL. The current migration 008 has 60+ lines of table recreation (CREATE new → INSERT SELECT → DROP old → ALTER RENAME → recreate indexes). The plan should either include the full SQL inline or explicitly reference "copy lines 54-114 from current `008_linear_integration.sql`" so the implementer doesn't miss columns or indexes.

- [x] **OpenAPI spec regeneration step missing from phase verification.** — RESOLVED: Added `bun run docs:openapi` to Automated Verification in Phases 1-4. Phase 1 removes Linear routes from `openapi.json` and Phase 6 checks that tracker routes are present, but no phase runs `bun run docs:openapi` to regenerate the static file. The CI merge gate enforces freshness (`scripts/generate-openapi.ts`). Each phase that adds or removes routes should include `bun run docs:openapi` in its Automated Verification checklist, and the resulting `openapi.json` changes should be committed.

- [x] **Phase 3 fire-and-forget error handling unspecified.** — RESOLVED: Added explicit error handling guidance in Phase 3 §3 (try/catch + console.error with context). The plan says "respond 200 immediately, run heavy work in unresolved promise" but doesn't address what happens when the deferred work fails (e.g., `createTaskExtended()` throws, Linear API call fails). At minimum: log errors. Consider whether failed task creation should be retried or surfaced. The existing event bus emissions in `db.ts` wrap in `try {} catch {}` that silently swallow errors — this is a known weak pattern that shouldn't be replicated.

### Minor

- [x] **Frontmatter missing `planner` field.** Plan template requires `planner:` in frontmatter — auto-fixed.
- [ ] **`server.ts` tool registration range inaccurate.** Plan says lines 114-180; actual range is 114-208 (includes memory + workflow capability blocks). Won't affect implementation but worth correcting for accuracy.
- [ ] **`tracker_sync.syncDirection` lacks CHECK constraint.** Column defaults to `'inbound'` but unlike `entityType` (which has `CHECK IN ('task', 'epic')`), `syncDirection` has no constraint validating allowed values. Add `CHECK (syncDirection IN ('inbound', 'outbound', 'bidirectional'))`.
- [ ] **`tracker_sync.lastSyncOrigin` nullability ambiguous.** Column has `CHECK (lastSyncOrigin IN ('swarm', 'external'))` but is nullable. The plan should clarify: is NULL the "never synced" state? If so, document it. If not, add `NOT NULL DEFAULT 'swarm'`.
- [ ] **In-memory PKCE state and webhook dedup lost on restart.** OAuth pending state map (Phase 2) and dedup set (Phase 3) are in-memory with TTL. Server restart during OAuth flow = flow fails; restart during webhook replay window = duplicates slip through. Acceptable trade-off for single-instance deployment but should be documented as a known limitation.

### Codebase Reference Accuracy

All 11 file:line references were verified. 10/11 are accurate. One inaccuracy:
- `src/server.ts:114-180` → actual tool registration range is **114-208**

Additional confirmations:
- `@linear/sdk` is already in `package.json` (v77.0.0) — no install needed
- `src/be/db-queries/` directory does not exist yet (plan creates it — correct)
- `openapi.json` is auto-generated via `route()` registry + `scripts/generate-openapi.ts`
