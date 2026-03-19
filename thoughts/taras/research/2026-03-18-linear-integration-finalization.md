---
date: 2026-03-18T12:00:00Z
topic: "Linear Integration Finalization"
branch: linear-integration-foundation
pr: 161
status: draft
---

# Ticket Tracker Integration — Linear First

**Date**: 2026-03-18
**Branch**: `linear-integration-foundation`
**PR**: #161 (DRAFT) — **will be nuked and rebuilt from scratch**

> **Approach**: Delete all existing Linear code on this branch. Build a **generic ticket tracker abstraction** with Linear as the first provider. Single PR, no phased merges.

---

## 1. Architecture — Ticket Tracker Abstraction

Building from scratch with the abstraction baked in from day 1. Follows the same flat-convention pattern as VCS (`src/vcs/`, `src/github/`, `src/gitlab/`).

### 1.1 DB Schema: Generic Tables

**`oauth_apps`** — OAuth application configuration (one row per provider):
```sql
CREATE TABLE IF NOT EXISTS oauth_apps (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    provider TEXT NOT NULL UNIQUE,    -- 'linear', 'jira', 'trello', etc.
    clientId TEXT NOT NULL,
    clientSecret TEXT NOT NULL,
    authorizeUrl TEXT NOT NULL,       -- e.g. https://linear.app/oauth/authorize
    tokenUrl TEXT NOT NULL,           -- e.g. https://api.linear.app/oauth/token
    redirectUri TEXT NOT NULL,
    scopes TEXT NOT NULL,             -- Space or comma separated
    metadata TEXT DEFAULT '{}',       -- Provider-specific extras (JSON, e.g. actor=app)
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**`oauth_tokens`** — Token storage (one active token set per provider):
```sql
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
```

**`tracker_sync`** — Generic entity mapping for any tracker:
```sql
CREATE TABLE IF NOT EXISTS tracker_sync (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    provider TEXT NOT NULL,
    entityType TEXT NOT NULL CHECK (entityType IN ('task', 'epic')),
    providerEntityType TEXT,          -- 'issue', 'project', 'sub_issue', 'story', 'card'
    swarmId TEXT NOT NULL,
    externalId TEXT NOT NULL,
    externalIdentifier TEXT,          -- "SWARM-123", "PROJ-456"
    externalUrl TEXT,
    lastSyncedAt TEXT NOT NULL DEFAULT (datetime('now')),
    lastSyncOrigin TEXT CHECK (lastSyncOrigin IN ('swarm', 'external')),
    syncDirection TEXT NOT NULL DEFAULT 'inbound',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, entityType, swarmId),
    UNIQUE(provider, entityType, externalId)
);
```

**`tracker_agent_mapping`** — Generic agent-to-external-user mapping:
```sql
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
```

**`agent_tasks` source enum update** — Add `'linear'` to the CHECK constraint (table recreation with explicit column listing).

### 1.2 DB Query Layer: `src/be/db-queries/tracker.ts`

All tracker DB functions live in a dedicated module, provider-parameterized:

```typescript
// OAuth Apps
getOAuthApp(provider: string): OAuthApp | null
upsertOAuthApp(provider: string, data: OAuthAppData): OAuthApp

// OAuth Tokens
getOAuthTokens(provider: string): OAuthToken | null
storeOAuthTokens(provider: string, data: TokenData): OAuthToken
deleteOAuthTokens(provider: string): void
isTokenExpiringSoon(provider: string, bufferMs?: number): boolean

// Generic token refresh (uses oauth_apps.tokenUrl + oauth_tokens.refreshToken)
refreshOAuthToken(provider: string): OAuthToken | null

// Sync Mappings
getTrackerSync(provider: string, entityType: string, swarmId: string): TrackerSync | null
getTrackerSyncByExternalId(provider: string, entityType: string, externalId: string): TrackerSync | null
createTrackerSync(provider: string, data: TrackerSyncData): TrackerSync
updateTrackerSync(id: string, data: Partial<TrackerSyncData>): TrackerSync
deleteTrackerSync(id: string): void
getAllTrackerSyncs(provider?: string, entityType?: string): TrackerSync[]

// Agent Mappings
getTrackerAgentMapping(provider: string, agentId: string): TrackerAgentMapping | null
getTrackerAgentMappingByExternalUser(provider: string, externalUserId: string): TrackerAgentMapping | null
createTrackerAgentMapping(provider: string, data: AgentMappingData): TrackerAgentMapping
deleteTrackerAgentMapping(provider: string, agentId: string): void
getAllTrackerAgentMappings(provider?: string): TrackerAgentMapping[]
```

### 1.3 Directory Structure

```
src/tracker/             — Generic tracker types
  types.ts               — TrackerProvider type, shared interfaces

src/linear/              — Linear-specific code
  client.ts              — @linear/sdk wrapper with auto-refresh
  oauth.ts               — Linear PKCE flow specifics (uses generic DB functions)
  webhook.ts             — Webhook handler + AgentSessionEvent routing
  sync.ts                — Inbound/outbound sync logic, status mapping
  types.ts               — Linear webhook event types, API response types
  app.ts                 — isLinearEnabled(), initLinear(), resetLinear()

src/be/db-queries/
  tracker.ts             — Generic tracker CRUD (provider-parameterized)

src/http/trackers/
  linear.ts              — /api/trackers/linear/authorize, /callback, /webhook

src/tools/
  tracker-status.ts      — Show all connected trackers
  tracker-link-task.ts   — Link swarm task to external issue
  tracker-link-epic.ts   — Link swarm epic to external issue/project
  tracker-unlink.ts      — Remove a sync mapping
  tracker-sync-status.ts — Show sync mappings
  tracker-map-agent.ts   — Map agent to external user
```

### 1.4 HTTP Route Convention

All tracker routes live under `/api/trackers/{provider}/`:

| Route | Purpose |
|---|---|
| `GET /api/trackers/linear/authorize` | Redirect to Linear OAuth (requires API key) |
| `GET /api/trackers/linear/callback` | OAuth callback (bypasses API key auth) |
| `POST /api/trackers/linear/webhook` | Webhook receiver (signature-verified) |
| `GET /api/trackers/linear/status` | Connection status, token expiry |
| `GET /api/trackers/sync` | List all sync mappings (all providers) |
| `POST /api/trackers/sync` | Create manual sync mapping |
| `DELETE /api/trackers/sync/:id` | Remove sync mapping |
| `GET /api/trackers/agent-mappings` | List agent mappings (all providers) |
| `POST /api/trackers/agent-mappings` | Create agent mapping |
| `DELETE /api/trackers/agent-mappings/:id` | Remove agent mapping |

### 1.5 MCP Tool Naming

| Tool | Description |
|---|---|
| `tracker-status` | Show all connected trackers and their status |
| `tracker-link-task` | Link a swarm task to an external issue (any provider) |
| `tracker-link-epic` | Link a swarm epic to an external issue/project |
| `tracker-unlink` | Remove a sync mapping |
| `tracker-sync-status` | Show sync mappings and their state |
| `tracker-map-agent` | Map a swarm agent to an external user |

### 1.6 What Stays Provider-Specific

- `src/linear/client.ts` -- `@linear/sdk` wrapper (inherently Linear-specific)
- `src/linear/app.ts` -- Linear env var checks, init/reset lifecycle
- `src/linear/webhook.ts` -- Linear signature verification, `AgentSessionEvent` handling
- `src/linear/sync.ts` -- Linear status mapping, issue/project heuristics
- `src/http/trackers/linear.ts` -- Linear HTTP routes

### 1.7 No Abstract Interfaces

No `ITrackerClient` or factory patterns. The abstraction is a **convention** (generic DB tables + provider directory + route pattern), not an inheritance hierarchy. This matches the pragmatic VCS pattern.

---

## 2. OAuth Architecture

### 2.1 Two-Table Design: `oauth_apps` + `oauth_tokens`

Separating app config from tokens enables:
- **Auto-configuration**: The swarm can register new OAuth providers at runtime by inserting into `oauth_apps`
- **Generic token refresh**: `refreshOAuthToken(provider)` reads `oauth_apps.tokenUrl` and `oauth_tokens.refreshToken` -- no provider-specific code needed for the refresh grant
- **Single code path**: Store, refresh, expiry check, revoke all work identically across providers

### 2.2 OAuth Library: `oauth4webapi`

**Winner**: [`oauth4webapi`](https://github.com/panva/oauth4webapi) by Filip Skokan (panva).

| Criteria | `oauth4webapi` | `arctic` | `simple-oauth2` |
|---|---|---|---|
| **Bun** | Explicit support (Web Crypto + Fetch) | Works (Fetch-based) | Uses `wreck` (hapi), not ideal |
| **PKCE** | First-class, S256 | Supported | Not natively supported |
| **Generic providers** | Fully generic | Per-provider classes (wrong abstraction) | Generic but stale |
| **Token refresh** | `refreshTokenGrantRequest()` built-in | Some providers only | Unclear |
| **Maintenance** | Active (v3.8.5, ~20 days ago) | Active | ~2 years stale |
| **Dependencies** | Zero | Zero | `wreck` + others |

**Why not `arctic`**: Arctic's value is pre-configured provider classes (endpoint URLs baked in). But we need a generic system where adding a new tracker is config, not code. Arctic's generic fallback is basically `oauth4webapi` with less flexibility.

**Architecture with `oauth4webapi`**: One thin wrapper (~100 lines) that takes a config object (endpoints, clientId, scopes) and provides `buildAuthorizationURL()`, `exchangeCode()`, `refreshToken()`. Each tracker provider is just a config object. Token persistence goes to SQLite `oauth_tokens` table. No per-provider OAuth code.

### 2.3 Linear-Specific OAuth Details

Linear uses standard OAuth 2.0 with these specifics:
- **PKCE**: Required (S256 code challenge)
- **`actor=app`**: Must be included in authorization URL for bot identity
- **Token lifetime**: Access token 24hr, refresh token long-lived
- **Scopes**: `read,write,issues:create,comments:create,app:assignable,app:mentionable`

The `oauth_apps` row for Linear would have:
```json
{
  "provider": "linear",
  "authorizeUrl": "https://linear.app/oauth/authorize",
  "tokenUrl": "https://api.linear.app/oauth/token",
  "scopes": "read,write,issues:create,comments:create,app:assignable,app:mentionable",
  "metadata": "{\"actor\": \"app\", \"codeChallengeMethod\": \"S256\"}"
}
```

### 2.4 Platform Comparison

| Aspect | GitHub App | Slack App | Linear App |
|---|---|---|---|
| **Identity** | App ID + Private Key (PEM) | Bot Token + App Token | Client ID + Client Secret |
| **Webhook verification** | `x-hub-signature-256`, `sha256=` prefixed | `x-slack-signature`, `v0=` HMAC | `Linear-Signature`, plain hex HMAC |
| **Bot identity** | Automatic bot user | Bot user on install | `actor=app` creates bot user via OAuth |
| **Token lifetime** | 1hr installation tokens | Permanent bot token | 24hr access + refresh token |
| **Fits `oauth_apps`+`oauth_tokens`?** | No (JWT-based, not standard OAuth) | No (pre-generated tokens) | **Yes** (standard OAuth 2.0) |

The generic OAuth tables work for **standard OAuth 2.0 providers** (Linear, Jira, Trello, Asana). GitHub and Slack use non-standard auth and keep their own patterns.

---

## 3. Linear-Specific: Agent Interaction SDK

Linear has a first-class **Agent Interaction SDK** that defines how the integration works.

### 3.1 Entry Points

The app gets triggered in two ways:
1. **Delegation**: User assigns/delegates an issue to the app (`app:assignable`)
2. **@Mention**: User mentions the app in a comment (`app:mentionable`)

Both trigger `AgentSessionEvent` webhooks (NOT regular `Issue` webhooks).

### 3.2 AgentSessionEvent Flow

1. User delegates issue or @mentions app -> Linear sends `AgentSessionEvent` to `/api/trackers/linear/webhook`
2. App must respond within **10 seconds** with activity update
3. App creates swarm task from the issue
4. As task progresses, app updates the `AgentSession` state: `pending` -> `active` -> `complete`
5. Task completion updates Linear issue status

### 3.3 Webhook Signature Verification

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyLinearWebhook(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const computed = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (computed.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}
```

**Key**: Must use raw request body. Replay protection via `webhookTimestamp` (within ~60s).

### 3.4 Required Environment Variables

| Env Var | Purpose | Where to Get It |
|---|---|---|
| `LINEAR_CLIENT_ID` | OAuth app client ID | Settings > API > OAuth applications |
| `LINEAR_CLIENT_SECRET` | OAuth app client secret | Same page, shown once on creation |
| `LINEAR_SIGNING_SECRET` | Webhook HMAC verification | Webhook detail page in app config |
| `LINEAR_REDIRECT_URI` | OAuth callback URL | Must match app settings |
| `LINEAR_TEAM_ID` | Scoped team UUID (optional) | From Linear URL or API |

### 3.5 Linear App Setup Steps

1. Go to `https://linear.app/settings/api/applications`
2. Create new OAuth Application:
   - **Callback URLs**: `http://localhost:3013/api/trackers/linear/callback` (dev)
   - **Enable webhooks**: ON
   - **Webhook URL**: `https://<public-url>/api/trackers/linear/webhook`
   - **Agent session events**: ON
3. Copy Client ID, Client Secret, Webhook Signing Secret
4. Set env vars in `.env`

---

## 4. Polymorphic Mapping Design

**Model**: 1 issue -> N tasks, 1 issue -> 1 epic, 1 project -> 1 epic (polymorphic).

### Automatic Heuristics with Manual Override

| Linear Entity | Condition | Swarm Entity | Rationale |
|---|---|---|---|
| **Issue (no sub-issues)** | Standalone issue | **1 Task** | Simple 1:1 |
| **Issue (with sub-issues)** | Has children | **1 Epic** + **N Tasks** | Parent = goal, children = work breakdown |
| **Project** | — | **1 Epic** | Collection of related work |
| **Project issues** | In a project | **N Tasks** under epic | Natural grouping |

Manual override via MCP tools: `tracker-link-task`, `tracker-link-epic`.

The `tracker_sync` table handles this via:
- `entityType` = `'task'` or `'epic'` (swarm side)
- `providerEntityType` = `'issue'`, `'project'`, `'sub_issue'` (Linear side)

---

## 5. Two-Way Sync Architecture

### Conflict Resolution

**Linear is the source of truth** for externally-originated changes.

### Loop Prevention

Add `lastSyncOrigin` column to `tracker_sync`:
1. Webhook arrives -> check mapping
2. If `lastSyncOrigin = 'swarm'` AND `lastSyncedAt` within 30s -> skip (echo)
3. Otherwise, apply change, set `lastSyncOrigin = 'external'`
4. When swarm pushes to Linear, set `lastSyncOrigin = 'swarm'`

### Outbound Trigger

Post-update hooks in `db.ts` task state functions (`completeTask()`, `failTask()`, etc.) check for `tracker_sync` mapping and push changes.

### Status Mapping

| Linear State | Swarm Task Status |
|---|---|
| Backlog | `backlog` (or skip — don't create task) |
| Todo | `unassigned` |
| In Progress | `in_progress` |
| Done | `completed` |
| Cancelled | `cancelled` |

---

## 6. Testing Plan

### 6.1 Unit Tests

| Test | File | What to Test |
|---|---|---|
| OAuth PKCE generation | `src/linear/__tests__/oauth.test.ts` | Code verifier, challenge, base64url |
| Token storage (DB) | `src/be/db-queries/__tests__/tracker.test.ts` | Generic CRUD, upsert atomicity |
| Token refresh | `src/be/db-queries/__tests__/tracker.test.ts` | Expiry check, refresh flow |
| Client caching | `src/linear/__tests__/client.test.ts` | Cache hit, invalidation |
| `isLinearEnabled()` | `src/linear/__tests__/app.test.ts` | Env var combinations |
| Sync mapping CRUD | `src/be/db-queries/__tests__/tracker.test.ts` | Uniqueness, provider filtering |
| Agent mapping CRUD | `src/be/db-queries/__tests__/tracker.test.ts` | 1:1 constraints |

### 6.2 Integration Tests

| Test | What to Test |
|---|---|
| OAuth flow E2E | `/authorize` returns redirect, `/callback` exchanges code (mock Linear API) |
| Webhook signature | Valid/invalid signatures, replay protection |
| Inbound sync | Webhook -> task creation -> correct status mapping |
| Outbound sync | Task completion -> Linear API call |
| Loop prevention | Change from swarm -> Linear -> webhook -> no re-update |

### 6.3 Manual QA (Against Real Linear Workspace)

**OAuth Flow**:
1. `curl -H "Authorization: Bearer $API_KEY" http://localhost:3013/api/trackers/linear/authorize`
2. Authorize in browser (must be workspace admin for `actor=app`)
3. Verify: `curl -H "Authorization: Bearer $API_KEY" http://localhost:3013/api/trackers/linear/status`

**Inbound Sync**:
- @mention the app in a comment -> verify swarm task created
- Delegate issue to app -> verify swarm task via `AgentSessionEvent`
- Change status in Linear -> verify swarm task status updates
- Delete issue -> verify task cancelled

**Outbound Sync**:
- Complete swarm task -> verify Linear issue "Done"
- Fail swarm task -> verify Linear comment/status
- Task progress -> verify Linear comment (incremental)

**Edge Cases**:
- Token expires (24hr) -> auto-refresh
- Rate limits -> backoff/retry
- Duplicate webhooks -> idempotent (use `Linear-Delivery` header)
- 10-second AgentSessionEvent timeout -> fast acknowledgment

**Local dev webhooks**: `ngrok http 3013` or `cloudflared tunnel --url http://localhost:3013`

---

## 7. Implementation Order (Single PR)

All work lands in **one PR** on `linear-integration-foundation`.

### Phase 1: Nuke + Generic Foundation
1. Delete all existing Linear code from branch (revert to main state)
2. Create migration `008_tracker_integration.sql` with generic tables (`oauth_apps`, `oauth_tokens`, `tracker_sync`, `tracker_agent_mapping`) + `agent_tasks` source enum update
3. Create `src/tracker/types.ts` with `TrackerProvider` type
4. Create `src/be/db-queries/tracker.ts` with all generic CRUD functions
5. Unit tests for tracker DB functions

### Phase 2: Linear OAuth + Client
1. Create `src/linear/app.ts` (init/reset lifecycle)
2. Create `src/linear/oauth.ts` (PKCE flow with `actor=app`, uses generic DB)
3. Create `src/linear/client.ts` (`@linear/sdk` wrapper with auto-refresh)
4. Create `src/http/trackers/linear.ts` (authorize + callback routes)
5. Unit tests for OAuth and client

### Phase 3: Webhook + Inbound Sync
1. Add webhook handler to `src/linear/webhook.ts` (signature verification + `AgentSessionEvent` routing)
2. Add webhook route to `src/http/trackers/linear.ts`
3. Create `src/linear/sync.ts` (inbound sync: issue -> task, project -> epic, heuristics)
4. Status mapping (hardcoded defaults)
5. Integration tests with mocked webhooks

### Phase 4: MCP Tools + Outbound Sync
1. Create `tracker-*` MCP tools
2. Add outbound sync hooks in `db.ts` task state functions
3. Add loop prevention (`lastSyncOrigin` tracking)
4. Progress -> Linear comment sync

### Phase 5: Manual QA
1. Full OAuth flow against real Linear workspace
2. @mention and delegation QA
3. Bidirectional sync QA
4. Edge case testing
5. Dashboard UI (deferred to separate PR if too much scope)

---

## 8. Resolved Questions

1. **Can we @mention a Linear app?** -- **Yes.** `actor=app` + `app:mentionable` scope. Triggers `AgentSessionEvent` webhooks.

2. **Multi-workspace** -- **Single workspace per swarm.**

3. **Issue deletion** -- **Cancel the swarm task.** Backlog issues: use `backlog` status or don't create tasks.

4. **Sync approach** -- **Incremental only.** No history sync. Triggered only by app assignment/@mention.

5. **Which issues** -- **Only when assigned to app or @mentioned.**

### Remaining Open Question

- **Token scope**: Do we need `admin`? Minimum viable: `read,write,issues:create,comments:create,app:assignable,app:mentionable`.

---

## 9. Lessons from Prototype

These issues were found in the existing PR code. The rebuild avoids them:

1. **Auth bypass scope**: Only `/callback` bypasses API key auth, not `/authorize`
2. **Migration `SELECT *`**: Always explicit column listings
3. **Missing `actor=app`**: Required for bot identity
4. **No DB layer functions**: Build CRUD alongside migration
5. **Linear-specific everything**: Generic names from day 1

---

## 10. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Infinite sync loops | **Medium** | **Medium** | Origin tracking + timestamp guards |
| Linear API rate limits | **Low** | **Medium** | Backoff/retry + batch operations |
| Webhook delivery failures | **Low** | **Low** | Linear retries, idempotent handlers |
| 10s AgentSessionEvent timeout | **Medium** | **Low** | Fast ack, defer heavy work |
| Schema evolution | **Low** | **Medium** | Explicit column lists, migration tests |

---

## Review Errata

_Reviewed: 2026-03-19 by Claude_

### Critical

- [ ] **Migration 008 collision — no rollback strategy for existing databases.** The doc says to create `008_tracker_integration.sql`, but `008_linear_integration.sql` already exists on the branch and has been applied to databases (recent commits `fedf298`, `74ee4d8` fix columns in it). The migration runner uses checksums — deleting and replacing 008 will cause a checksum mismatch on any DB that already applied the old version. The doc needs to specify: (a) use a new migration 009 that drops Linear-specific tables and creates generic ones, OR (b) explicitly state this is a full branch reset where no existing databases matter and 008 gets replaced entirely.

### Important

- [ ] **10-second AgentSessionEvent timeout — no concrete deferral pattern.** Section 3.2 says "App must respond within 10 seconds" and the risk table says "fast ack, defer heavy work." But the doc never describes HOW to defer. Options include: `waitUntil` (if using Bun.serve), fire-and-forget promise, a background queue, or `setTimeout`. This is a critical design decision that shapes the entire webhook handler — it should be specified.

- [ ] **`oauth4webapi` adoption not operationalized in Phase 2.** Section 2.2 picks `oauth4webapi` as the winner and describes a thin wrapper architecture, but Phase 2 steps don’t mention: installing the package, removing the manual PKCE implementation in current `oauth.ts` (which uses raw `node:crypto`), or how the wrapper integrates with the generic DB layer. The transition path needs to be spelled out.

- [ ] **Existing env vars `LINEAR_DISABLE` and `LINEAR_ENABLED` missing from Section 3.4.** The current `app.ts` (lines 15-22) and `.env.example` (line 57) use these feature-flag env vars for init/reset lifecycle. The env var table in Section 3.4 only lists 5 vars and omits these. Should the rebuild keep them.

- [ ] **`admin` scope — open question should be resolved before implementation.** Section 8 asks "Do we need `admin`?" but the existing `oauth.ts` already includes `admin` in its scope list. Section 2.3’s recommended scopes explicitly exclude it. This contradiction will cause confusion during implementation — resolve it now (the answer is likely "no, minimum viable scopes are sufficient").

- [ ] **Loop prevention 30-second window is arbitrary and fragile.** Section 5 says "if `lastSyncOrigin = ‘swarm’` AND `lastSyncedAt` within 30s → skip." No justification for 30s is provided. Too short = missed echo suppression under network latency; too long = legitimate rapid changes get dropped. Consider using the `Linear-Delivery` header (mentioned in Section 6.3) as a dedup key instead of a timing window — it’s deterministic.

### Resolved

- [x] **`src/be/db-queries/` is intentional** — Confirmed by Taras: this is an intentional new pattern to start decomposing the monolithic `db.ts` into domain-specific query modules with proper unit test coverage. Future domains (VCS, Slack, etc.) may follow.
- [x] **`src/http/trackers/` route convention** — GitHub/GitLab use flat files (`src/http/webhooks.ts`) with routes at `/api/github/webhook`, `/api/gitlab/webhook`. Taras says either flat or nested is fine. Keep the doc’s proposed pattern — it groups multiple tracker routes (authorize, callback, webhook, status) which is more than a single webhook endpoint.
- [x] **Frontmatter missing `researcher` field** — structural gap, minor
- [x] **No explicit "Research Question" or "Summary" section** — this is a design doc more than a typical codebase research; format is appropriate for the content
- [x] **`syncDirection` default inconsistency** — doc says `DEFAULT ‘inbound’` (Section 1.1) but existing migration uses `DEFAULT ‘bidirectional’`. Noted; will be resolved when migration is rewritten
