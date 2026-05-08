---
date: 2026-05-08T00:00:00Z
topic: "UI Chat/Session Experience — v1 (Sessions surface + Dashboard revamp)"
author: taras
status: draft
related:
  - thoughts/taras/brainstorms/2026-05-08-ui-chat-session-experience.md
  - thoughts/taras/research/2026-05-08-ui-chat-session-experience-research.md
---

# UI Chat/Session Experience v1 Implementation Plan

## Overview

Bundled v1 launch in `ui/`: a **Sessions** experience (`/sessions`, `/sessions/:id`) that renders a task chain as a chat-style timeline with composer, and a **Dashboard revamp** (`/`) replacing today's page with a static `@xyflow/react` org-chart canvas (lead → workers, sized by 24h activity) plus a four-bucket action-items inbox (Blocking / Broken / To read / To start). Backend changes are minimal and additive: Zod becomes the single source of truth for `agent_tasks.source`, `requestedByUserId` is plumbed end-to-end, a new chain-fetch endpoint, two new tables (`inbox_item_state`, `task_templates`), HTTP routes for users (DB functions already exist), and a minor version bump (`1.75.0 → 1.76.0`) so the UI can soft-degrade against older self-hosted API servers.

- **Motivation**: replace the current task-table dashboard and Slack-only thread experience with a first-class in-product session/chat surface; align v1 with what's already plumbed (`parentTaskId`, `SessionLogViewer`, polling) so we ship in predictable, independently-reviewable phases.
- **Self-hosted version-gate**: bump `package.json` to `1.76.0`. The UI checks `GET /health` (already returns `version` — `src/http/core.ts:100-113`) and soft-degrades new surfaces when the API is older. No hard block; users on a stale API still see the legacy dashboard and a banner pointing at upgrade docs. `/health` is also extended to return a stable `swarmId` so UI state can be namespaced per deployment.
- **Identity**: a "who are you?" modal lists rows from a new `GET /api/users` endpoint (DB functions already exist at `src/be/db.ts:8285-8475`), persists the picked id in `localStorage` under `agent-swarm-current-user:<swarmId>`, and feeds `requestedByUserId` to every task create from the UI (existing CreateTaskDialog included). The modal **auto-pops** whenever no entry exists for the current swarm — so existing users on an upgraded API are prompted exactly once, and a single browser pointed at multiple swarms keeps separate identities.
- **Related**:
  - `thoughts/taras/brainstorms/2026-05-08-ui-chat-session-experience.md` (PRD)
  - `thoughts/taras/research/2026-05-08-ui-chat-session-experience-research.md` (research)
  - `src/types.ts:56-69` (AgentTaskSourceSchema), `src/types.ts:217-233` (UserSchema)
  - `src/http/tasks.ts:29-47,55-68,257-307` (tasks routes), `src/http/core.ts:100-113` (`/health` returns version)
  - `src/be/db.ts:2085-2259` (createTaskExtended w/ requestedByUserId), `src/be/db.ts:8262-8475` (user fns)
  - `src/be/migrations/043_jira_source.sql` (latest agent_tasks rebuild), `031_user_registry.sql` (users + requestedByUserId column), `034_slack_reply_sent.sql:4` (parentTaskId index)
  - `ui/src/app/router.tsx`, `ui/src/app/providers.tsx:7-15` (TanStack polling defaults)
  - `ui/src/api/client.ts:215-234` (createTask), `ui/src/api/hooks/use-tasks.ts:48-63` (useCreateTask)
  - `ui/src/pages/tasks/page.tsx:35-42,317-330` (TaskFormData + submit), `ui/src/pages/dashboard/page.tsx:315-477` (current dashboard)
  - `ui/src/components/shared/session-log-viewer.tsx:805` (transcript), `ui/src/components/ui/sheet.tsx`, `ui/src/components/shared/data-grid.tsx`, `ui/src/components/ui/detail-page-layout.tsx`
  - `ui/src/components/workflows/workflow-graph.tsx`, `ui/src/components/workflows/graph-utils.ts`, `ui/src/components/shared/workflow-node-shell.tsx` (xyflow + dagre patterns)
  - `ui/src/styles/globals.css:49-86` (OKLCH status tokens)
  - `LOCAL_TESTING.md`, `CLAUDE.md`, `runbooks/ci.md`, `runbooks/local-development.md`

## Current State Analysis

**Backend already in place:**
- `parentTaskId` column on `agent_tasks` (`043_jira_source.sql:37`) with index (`034_slack_reply_sent.sql:4`).
- `requestedByUserId` column on `agent_tasks` referencing `users(id)` (`031_user_registry.sql:27`); accepted by `createTaskExtended` (`src/be/db.ts:2085`); read by `src/tools/get-task-details.ts:48-49` and `src/http/poll.ts:248`. **NOT** in the HTTP create body (`src/http/tasks.ts:55-68`).
- Source CHECK constraint in `agent_tasks` is the *only* enum gate today — `src/http/tasks.ts:65` is `source: z.string().optional()`. Fix: drop the CHECK, tighten Zod to `AgentTaskSourceSchema.optional()` (`src/types.ts:56-69`).
- Users table (`031_user_registry.sql:2-17`) + DB functions exist (`getAllUsers`, `getUserById`, `createUser`, `updateUser`, `resolveUser` — `src/be/db.ts:8285-8475`). No HTTP layer (`src/http/users.ts` does not exist).
- `/health` already returns `{ status, version }` from `package.json` (`src/http/core.ts:100-113`).
- Approvals: `GET /api/approval-requests?status=pending` returns `{ approvalRequests }` (`src/http/approval-requests.ts:112-127`).
- Credentials: `GET /api/agents/credential-status?status=waiting_for_credentials` returns `{ agents: [{ agentId, name, status, missing[], provider, lastCheckedAt }] }` (`src/http/agents.ts:182-194,404-419`).
- `route()` factory + auto-OpenAPI registration at `src/http/route-def.ts:84-104`.

**Backend missing:**
- No chain fetch — `GET /api/tasks?...` filters do not include `parentTaskId` / `rootTaskId` (`src/http/tasks.ts:29-47`). Naive timeline = N polls.
- No HTTP CRUD for users (DB functions are HTTP-orphaned).
- No `inbox_item_state` table.
- No `task_templates` table (the existing `templates/` directory is **agent personas**, not session prompts).

**Frontend in place:**
- `react-router-dom` v7 in `ui/src/app/router.tsx`; pages = `ui/src/pages/<route>/page.tsx` (lazy-imported, default-exported).
- TanStack Query polling defaults: `refetchInterval: 5000`, `staleTime: 2000` (`ui/src/app/providers.tsx:7-15`).
- `SessionLogViewer({ logs, compactionSnapshots?, className? })` at `ui/src/components/shared/session-log-viewer.tsx:805`.
- Hooks: `useTask, useTaskSessionLogs (5s), useTaskContext (10s), useCreateTask` in `ui/src/api/hooks/use-tasks.ts`; `useSessionCosts` in `ui/src/api/hooks/use-costs.ts:15-22`.
- shadcn `Sheet` (`ui/src/components/ui/sheet.tsx`), `DataGrid` (`ui/src/components/shared/data-grid.tsx`), `detail-page-layout.tsx` (`ui/src/components/ui/detail-page-layout.tsx`).
- Workflow graph: `@xyflow/react` v12.10.1 + `dagre` v0.8.5 already installed (`ui/package.json:19,26`); reusable patterns in `ui/src/components/workflows/workflow-graph.tsx`, `graph-utils.ts` (`applyDagreLayout` line 254), `WorkflowNodeShell` (`ui/src/components/shared/workflow-node-shell.tsx`).
- Design tokens (OKLCH): `--color-status-{success,active,error,info,pending,warning,paused,neutral}` and `--color-action-*` in `ui/src/styles/globals.css:49-86`.
- localStorage convention (key prefix `agent-swarm-*`) used in `ui/src/hooks/use-theme.ts`, `ui/src/lib/config.ts`, `ui/src/pages/tasks/[id]/page.tsx:471,475`.

**Frontend missing:**
- No `/sessions` route, no sessions pages.
- No identity context / user picker / current-user provider; no `useApiVersion` hook; no version-gate.
- `ui/src/api/client.ts:215-234` `createTask` does NOT pass `parentTaskId`, `source`, `requestedByUserId`, `offeredTo`, `dir`, `outputSchema`, or `contextKey` (server accepts all of these).
- `TaskFormData` (`ui/src/pages/tasks/page.tsx:35-42`) lacks `parentTaskId`, `source`, `requestedByUserId`.
- Current `DashboardPage` (`ui/src/pages/dashboard/page.tsx:315-477`) is StatsBar + Agent Status Grid + Active Tasks Panel + Activity Feed — to be replaced.

## Desired End State

**Sessions** — At `/sessions` users see a split view: left = sidebar list of recent sessions (latest activity first), right = selected session detail. Selecting a session loads the full chain in one round trip via `GET /api/sessions/{rootTaskId}`. The detail panel renders user messages and task cards in chronological order; sibling tasks (same `parentTaskId`) are visually grouped under a `[parallel · N tasks]` wrapper. Card click opens a shadcn `Sheet` on the right embedding the existing `SessionLogViewer` plus `useTaskSessionLogs` / `useTaskContext` / `useSessionCosts`. The composer at the bottom of the detail panel posts a new task with `parentTaskId` set to the latest leaf in the chain, `source: "api"`, and `requestedByUserId` from the identity context. Live updates piggyback on TanStack Query polling (5s).

**Dashboard at `/`** — Two regions: (1) an `@xyflow/react` org-chart canvas (lead at top, workers below) where node size scales with last-24h task count + token usage; nodes are click-through to `/agents/:id`; a tabular fallback toggle is always available. (2) An action-items inbox with four buckets — Blocking (pending approvals + agents `waiting_for_credentials`), Broken (`failed`/`cancelled` tasks with `failureReason`), To read (recently completed root sessions), To start (cards from `task_templates`, click pre-fills `CreateTaskDialog`). Each item supports dismiss / snooze / done with state persisted per user via the new `inbox_item_state` table.

**Self-hosted soft-degrade** — UI fetches `GET /health` once on boot, caches via TanStack. If `version < 1.76.0`, the new `/sessions` route renders an "Upgrade required" page; the dashboard falls back to today's `DashboardPage`; the sidebar entry for Sessions shows a tooltip hint. Boot modal shows up only after the version check passes.

**Auditability** — Every task created from the UI carries `requestedByUserId`. `TaskDetailPage` displays the requested-by user (read-only QuickStat).

## What We're NOT Doing

v1 explicitly excludes:
- Animated react-flow edges, pulse-on-active edges, failure visuals on edges.
- "Agent flagged this as interesting" signal — every completed root session = a card.
- Mobile-optimized session timeline.
- Custom user-authored quick-start templates (registry is read-only / seed-only in v1).
- Sharing / multi-user-visible sessions.
- PR-awaiting-review bucket source.
- Generic integration-health aggregator.
- "Awaiting input" task status (`paused` stays graceful-shutdown only).
- New `sessions` table (session = root task + chained children, derived).
- SSE/WebSocket transport for sub-second feel.
- Hard version block — degraded UX is intentional.

## Implementation Approach

- **Backend changes are additive** — new migrations, new routes, new schemas. The only mutation to existing surface is dropping the `agent_tasks.source` SQL CHECK and tightening the Zod to take its place, plus adding `requestedByUserId` to the `POST /api/tasks` body.
- **Identity is the keystone** — Phase 1 establishes the identity contract; Phase 3 wires the boot UI; everything after assumes a `userId` is available client-side.
- **Reuse the workflow-viewer pattern** for the agent canvas (`workflow-graph.tsx` + `graph-utils.ts` + `WorkflowNodeShell`) — no greenfield xyflow integration.
- **Reuse SessionLogViewer + transcript hooks** verbatim inside a `Sheet` — no new transcript component.
- **Polling, not streaming** — every UI surface is TanStack Query at 5s; no new transport layer.
- **Soft version-gate** via `useApiVersion` + `useFeatureGate(minVersion)` helpers; no hard kill switch.
- **Phase commits** — one `[phase N] <desc>` commit after each phase passes manual verification.

## Quick Verification Reference

Backend (root):
- Type-check: `bun run tsc:check`
- Lint (CI parity, read-only): `bun run lint`
- Unit tests: `bun test`
- DB boundary: `bash scripts/check-db-boundary.sh`
- OpenAPI freshness: `bun run docs:openapi`
- Server: `bun run start:http`

UI (`ui/`):
- Type-check (CI parity): `cd ui && pnpm exec tsc -b`
- Lint: `cd ui && pnpm lint`
- Design tokens: `cd ui && pnpm check:tokens`
- Dev server: `cd ui && pnpm dev` (port 5274)

---

## Phase 1: Source-enum cleanup, audit field, swarmId, version bump

### Overview

Drop the SQL CHECK on `agent_tasks.source`, tighten the Zod schema to `AgentTaskSourceSchema.optional()`, add `requestedByUserId` to the `POST /api/tasks` body, add a stable `swarmId` to `/health` (so the UI can namespace per-deployment localStorage), bump `package.json` to `1.76.0`, and regenerate `openapi.json`. Pure backend, no UI touch. Ships independently — no v1 UI feature depends on the version bump landing in this phase, but downstream phases gate against it.

**Independent shippability note**: this phase ships `1.76.0` to production with no UI consumer until Phase 3+. Stale-API users hitting an in-between deploy see a `1.76.0` API but the same UI as before. No regression — just no new features yet. Acceptable.

### Changes Required:

#### 1. Forward-only migration: drop `source` CHECK
**File**: `src/be/migrations/055_drop_agent_tasks_source_check.sql` *(new)*
**Changes**: Table-rebuild migration that mirrors `043_jira_source.sql:10-58` *minus* the `CHECK(source IN (...))` line; preserve all other columns, defaults, indexes, FKs (especially `requestedByUserId TEXT REFERENCES users(id)` from `031_user_registry.sql:27` — easy to drop silently in a rebuild), and triggers (`043_jira_source.sql:62-119`). No data migration — existing rows valid. Verification command lives in Success Criteria: run `PRAGMA foreign_key_list(agent_tasks)` before and after to confirm all FKs survive.

#### 2. Tighten Zod
**File**: `src/http/tasks.ts` (~line 65)
**Changes**: `source: z.string().optional()` → `source: AgentTaskSourceSchema.optional()` (import from `src/types.ts:56-69`). Defaults stay at handler line 272.

#### 3. Add `requestedByUserId` to POST body
**File**: `src/http/tasks.ts` (~lines 55-68 + handler at 271)
**Changes**: Append `requestedByUserId: z.string().optional()` to the body schema; forward to `createTaskWithSiblingAwareness` alongside `parentTaskId`. DB layer already accepts (`src/be/db.ts:2085`).

#### 4. `swarmId` exposed on `/health`
**File**: `src/be/migrations/058_swarm_metadata.sql` *(new)*
**Changes**:
```sql
CREATE TABLE IF NOT EXISTS swarm_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  swarmId TEXT NOT NULL DEFAULT (lower(hex(randomblob(8)))),
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO swarm_metadata (id) VALUES (1);
```
Single-row table; auto-seeded with a 16-char hex id on first migration apply. Stable across restarts.

**File**: `src/be/db.ts`
**Changes**: Add `getSwarmId(): string` cached at boot — single SELECT. **Precedence rule**: `process.env.SWARM_ID` always wins if set, otherwise read the row. State explicitly: env override is the operator's contract — across replicas, all replicas pointing at the same DB MUST set the same `SWARM_ID` (or none). Changing `SWARM_ID` mid-deployment is supported but invalidates all per-swarm `localStorage` identities (acceptable; users re-pick once). The cache lives until process restart; no runtime invalidation.

**File**: `src/http/core.ts:100-113`
**Changes**: Extend the `/health` JSON to include `swarmId`. Final shape: `{ status: "ok", version: "1.76.0", swarmId: "<hex>" }`.

#### 5. Version bump
**File**: `package.json`
**Changes**: `"version": "1.75.0"` → `"version": "1.76.0"`. Update `runbooks/ci.md` if it references a specific version (it doesn't today — drift check only).

#### 6. Regenerate OpenAPI
**Files**: `openapi.json`, `docs-site/content/docs/api-reference/**`
**Changes**: Run `bun run docs:openapi`. Commit regenerated outputs.

### Success Criteria:

#### Automated Verification:
- [ ] Type-check passes: `bun run tsc:check`
- [ ] Lint passes (CI parity): `bun run lint`
- [ ] Unit tests pass: `bun test`
- [ ] DB boundary clean: `bash scripts/check-db-boundary.sh`
- [ ] OpenAPI matches: `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference`
- [ ] Docs-site embeds the new version: `grep -r '"1.76.0"' docs-site/content/docs/api-reference | head` returns rows (otherwise the openapi regen didn't pick up the bump)
- [ ] Migration applies on a fresh DB: `rm agent-swarm-db.sqlite && bun run start:http` exits 0 boot
- [ ] Migration applies on the existing DB (back up first): `bun run start:http` against the working tree's DB exits 0 boot
- [ ] FK preservation across the table-rebuild: `sqlite3 agent-swarm-db.sqlite "PRAGMA foreign_key_list(agent_tasks);"` returns the `requestedByUserId → users(id)` FK both before and after migration `055`

#### Automated QA:
- [ ] `curl -X POST` to `POST /api/tasks` with `source: "mcp"` succeeds (200 + task row)
- [ ] `curl -X POST` to `POST /api/tasks` with `source: "garbage"` returns 400 (Zod rejects, not the SQL CHECK)
- [ ] `curl -X POST` to `POST /api/tasks` with a valid `requestedByUserId` writes the column (verify via `sqlite3 agent-swarm-db.sqlite "SELECT id, requestedByUserId FROM agent_tasks ORDER BY createdAt DESC LIMIT 1"`)
- [ ] `curl http://localhost:3013/health` returns `{ status: "ok", version: "1.76.0", swarmId: "<16-char hex>" }`
- [ ] `swarmId` is stable across restarts: capture once, restart server, capture again, verify identical
- [ ] `SWARM_ID=prod-us-east bun run start:http` honors the env override on `/health`

#### Manual Verification:
- [ ] Diff `openapi.json` review: only the `source` enum tightening + new `requestedByUserId` field + version bump appear

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 1] source enum cleanup + requestedByUserId + swarmId on /health + bump 1.76.0`.

---

## Phase 2: New tables + new HTTP routes (foundations for sessions / inbox / templates / users)

### Overview

Stand up every new HTTP contract v1 depends on: two migrations (`inbox_item_state`, `task_templates` + seed), six new routes via the `route()` factory (users `GET`/`POST`, sessions list + chain, inbox-state `GET`/`PATCH`, task-templates `GET`), extensions to existing `GET /api/tasks` (multi-status CSV + `createdAfter` filter so the dashboard can bound activity-window fetches), and tolerant handling for unknown `requestedByUserId` in `POST /api/tasks`. Update `scripts/generate-openapi.ts`, regenerate `openapi.json`. Still backend-only. Curlable end-to-end.

**Independent shippability note**: routes ship with no UI consumer until Phase 3+. That's intentional — the API contract is reviewable in isolation, and rollback is just dropping the routes.

### Changes Required:

#### 1. Migration: `inbox_item_state`
**File**: `src/be/migrations/056_inbox_item_state.sql` *(new)*
**Changes**:
```sql
CREATE TABLE IF NOT EXISTS inbox_item_state (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  itemType TEXT NOT NULL,           -- enforced via Zod (`InboxItemTypeSchema`), not SQL CHECK (Phase 1 lesson). NOTE: direct SQL inserts can bypass; HTTP layer is the only writer.
  itemId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  snoozeUntil TEXT,
  dismissedAt TEXT,
  doneAt TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(userId, itemType, itemId)
);
CREATE INDEX IF NOT EXISTS idx_inbox_item_state_userId_status
  ON inbox_item_state(userId, status);
```

#### 2. Migration: `task_templates` + seed
**File**: `src/be/migrations/057_task_templates.sql` *(new)*
**Changes**:
```sql
CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  category TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO task_templates (title, description, prompt, category, tags) VALUES
  ('Refactor a file', 'Improve a file without changing behavior', 'Refactor the file at <path> for readability while preserving behavior. Run typecheck + tests after.', 'engineering', '["refactor"]'),
  ('Investigate a bug', 'Reproduce, root-cause, and propose a fix', 'Investigate the following bug: <symptom>. Reproduce locally, identify the root cause, and propose a fix.', 'engineering', '["debug"]'),
  ('Open a PR', 'Create a PR for the current branch', 'Open a PR from the current branch with a clear summary and test plan.', 'git', '["git","pr"]'),
  ('Write tests for X', 'Cover an under-tested module', 'Write unit tests for <module>. Aim for ~80% line coverage.', 'engineering', '["test"]'),
  ('Daily triage', 'Review failed tasks + pending approvals', 'Triage the action-items inbox: dismiss noise, escalate blockers, summarize unread sessions.', 'ops', '["triage"]');
```

#### 3. Zod schemas + DB functions
**File**: `src/types.ts`
**Changes**: New `InboxItemTypeSchema = z.enum(["approval","credential_missing","broken_task","to_read","to_start_template"])`, `InboxItemStatusSchema = z.enum(["open","snoozed","dismissed","done"])`, `InboxItemStateSchema`, `TaskTemplateSchema`. Existing `UserSchema` re-exported.

**File**: `src/be/db.ts`
**Changes**: Add:
- `listInboxState({ userId, status?, itemType? })`,
- `upsertInboxState({ userId, itemType, itemId, status, snoozeUntil?, dismissedAt?, doneAt? })`,
- `listTaskTemplates({ category? })`,
- `getRootTaskChain(rootTaskId)` (recursive CTE walking `parentTaskId`; returns `AgentTask[]` ordered by `createdAt`),
- `listRecentSessions({ limit, offset })` returning rows with `lastActivityAt` (computed as `MAX(t.lastUpdatedAt)` over the chain via correlated subquery; named column shape: `{ root: AgentTask, chainTaskCount: number, lastActivityAt: string, latestStatus: AgentTaskStatus }`),
- Extend `getAllTasks(filters)` to accept `status: string | string[]` (CSV-parsed at HTTP layer) and `createdAfter?: string` (ISO timestamp). Single SQL change — `IN (?, ?, …)` for status, `AND createdAt >= ?` for the time filter. Confirm existing query still works for single-status callers.

#### 4. Extend existing `POST /api/tasks` + `GET /api/tasks`
**File**: `src/http/tasks.ts`
**Changes**:
- Multi-status CSV: query schema accepts `status: z.string().optional()` already; HTTP layer splits on `,` before forwarding to `getAllTasks`. Validates each token against `AgentTaskStatusSchema`.
- New query param: `createdAfter: z.string().datetime().optional()` (ISO 8601). Forwarded to `getAllTasks`.
- **Tolerant `requestedByUserId`**: in the POST handler at `:271`, before calling `createTaskWithSiblingAwareness`, check `getUserById(parsed.body.requestedByUserId)`; if the user does not exist, set the field to `undefined` and log a warning (`console.warn` is fine — no Sentry plumbing in v1) rather than letting the FK fail at insert. Prevents the deleted-user race from turning into a 500.

#### 5. New routes (all via `route()` factory — auto-registers in OpenAPI)
**File**: `src/http/users.ts` *(new)*
**Changes**:
- `GET /api/users` — `{ users: User[] }`. Calls `getAllUsers()`.
- `POST /api/users` — body `{ name, email?, role?, slackUserId?, ... }`, calls `createUser`. Returns `{ user: User }`. Auth: `apiKey: true` (no `agentId` requirement).

**File**: `src/http/sessions.ts` *(new)*
**Changes**:
- `GET /api/sessions` — query `{ limit?, offset? }`. Returns `{ sessions: Array<{ root: AgentTask, chainTaskCount: number, lastActivityAt: string, latestStatus: AgentTaskStatus }> }`.
- `GET /api/sessions/{rootTaskId}` — params `{ rootTaskId: z.string() }`. Returns `{ root: AgentTask, chain: AgentTask[] }`.

**File**: `src/http/inbox-state.ts` *(new)*
**Changes**:
- `GET /api/inbox-state` — query `{ userId: z.string(), status?, itemType? }`. Returns `{ items: InboxItemState[] }`.
- `PATCH /api/inbox-state` — body `{ userId, itemType, itemId, status, snoozeUntil? }`. Upserts. Returns `{ item: InboxItemState }`.

**File**: `src/http/task-templates.ts` *(new)*
**Changes**:
- `GET /api/task-templates` — query `{ category? }`. Returns `{ templates: TaskTemplate[] }`.

#### 6. Wire into `scripts/generate-openapi.ts` + regen
**Files**: `scripts/generate-openapi.ts`, `openapi.json`, `docs-site/content/docs/api-reference/**`
**Changes**: Add imports for the new handler files (mirror existing imports). Run `bun run docs:openapi`.

### Success Criteria:

#### Automated Verification:
- [ ] Type-check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] Unit tests pass: `bun test`
- [ ] DB boundary clean: `bash scripts/check-db-boundary.sh`
- [ ] Migrations apply fresh + existing: `rm agent-swarm-db.sqlite && bun run start:http` and again against working DB
- [ ] OpenAPI matches: `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference`
- [ ] New unit tests for `getRootTaskChain` and `listRecentSessions` in `src/tests/sessions.test.ts` (covers empty chain, single-root chain, 3-level chain, parallel siblings)

#### Automated QA:
- [ ] `curl http://localhost:3013/api/users` returns at least one row (seeded migration 031 plus any locally created)
- [ ] `curl -X POST http://localhost:3013/api/users -d '{"name":"QA Bot"}'` returns 200 + new user
- [ ] After creating a 3-task chain via `POST /api/tasks` (root → child → grandchild), `curl http://localhost:3013/api/sessions/{root}` returns `{ root, chain: [3 tasks] }` in dependency order
- [ ] `curl http://localhost:3013/api/sessions?limit=10` returns recent root tasks ordered by `lastActivityAt`
- [ ] `curl http://localhost:3013/api/task-templates` returns ≥5 seeded rows
- [ ] `curl -X PATCH http://localhost:3013/api/inbox-state -d '{"userId":"...","itemType":"approval","itemId":"abc","status":"snoozed","snoozeUntil":"2026-05-09T00:00:00Z"}'` upserts; subsequent `GET /api/inbox-state?userId=...` returns it
- [ ] Multi-status CSV: `curl 'http://localhost:3013/api/tasks?status=failed,cancelled'` returns rows where status ∈ {failed, cancelled} (single round trip)
- [ ] `createdAfter` filter: `curl 'http://localhost:3013/api/tasks?createdAfter=2026-05-07T00:00:00Z'` returns only tasks created on/after the timestamp
- [ ] Tolerant `requestedByUserId`: `curl -X POST /api/tasks -d '{"task":"test","requestedByUserId":"<random-non-existent-id>"}'` returns 200, the inserted row has `requestedByUserId` NULL, and a warning is logged (verify via `bun run start:http` stderr)

#### Manual Verification:
- [ ] Visual diff of `openapi.json`: only new endpoints + new schemas appear

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 2] new tables + endpoints (users, sessions, inbox-state, task-templates)`.

---

## Phase 3: Identity gate + UI client plumbing

### Overview

Add a "who are you?" identity modal in `ui/` that lists / creates rows in the `users` table. Storage key is **namespaced per swarm**: `agent-swarm-current-user:<swarmId>` where `swarmId` comes from the extended `/health` response (Phase 1). The modal **auto-pops** the moment `useHealth()` resolves with no entry for the current swarm — so first-time visitors and existing users on a freshly-upgraded API both get prompted exactly once, and a single browser pointed at multiple swarms (e.g. `localhost` + `prod`) keeps separate identities. Add `useApiVersion()` and `useFeatureGate(minVersion)` hooks. Plumb `parentTaskId`, `source`, `requestedByUserId` through `ui/src/api/client.ts`, `useCreateTask`, and the existing `CreateTaskDialog`. Display `requestedByUserId` (read-only) in `TaskDetailPage`.

### Changes Required:

#### 1. Health, version, swarmId, and feature-gate hooks (extend existing `useHealth`)
**File**: `ui/src/api/hooks/use-stats.ts` (extend — `useHealth` already exists at line 11)
**Changes**: Extend `useHealth()` to surface the new `swarmId` field on the typed response. Add convenience selectors: `useApiVersion()` and `useSwarmId()` (both wrap `useHealth().data?.<field>`). Set `staleTime: 30_000` (NOT `Infinity` — covers the swarmId-switch-mid-session case where a user re-points the UI at a different deployment URL; 30s is fast enough to react, slow enough to avoid hot polling). Reuse the existing query key.

**File**: `ui/src/lib/semver.ts` *(new)*
**Changes**: Tiny `compareSemver(a, b): -1 | 0 | 1` helper. No new dep.

**File**: `ui/src/api/hooks/use-feature-gate.ts` *(new)*
**Changes**: `useFeatureGate(minVersion: "1.76.0")` returns `{ supported: boolean, currentVersion, requiredVersion }` using `useApiVersion()` + `compareSemver`.

#### 2. Identity context + boot modal
**File**: `ui/src/api/hooks/use-users.ts` *(new)*
**Changes**: `useUsers()` (query), `useCreateUser()` (mutation). Both call new endpoints from Phase 2.

**File**: `ui/src/api/client.ts`
**Changes**: Add `listUsers(): Promise<User[]>`, `createUser(data): Promise<User>`. Reuse `getHeaders()`.

**File**: `ui/src/contexts/current-user-context.tsx` *(new)*
**Changes**: `<CurrentUserProvider>` with `localStorage` persistence of `userId`. Storage key is **namespaced per swarm**: `agent-swarm-current-user:${swarmId}` where `swarmId` is read from `useHealth()`. State machine — `state: "pending" | "needs-pick" | "ready"`:
- `pending` while `useHealth()` is loading or `useUsers()` is loading.
- `needs-pick` when no `userId` in localStorage for the current swarmId, OR when the stored `userId` doesn't match any row in `useUsers()` (covers the deleted-user case — provider re-derives `state` from the join).
- `ready` when both resolved and userId matches.

**Multi-tab semantics**: provider attaches a `window.addEventListener("storage", ...)` listener to react to `localStorage` writes from other tabs. When another tab calls `setUserId` or `clearUser`, this tab updates state without a reload. When `swarmId` changes (different `useHealth()` response, e.g. user pointed at a new deployment URL), provider recomputes the storage key and may re-enter `needs-pick`.

Exposes `useCurrentUser(): { state, userId: string | null, user: User | null, setUserId: (id: string) => void, clearUser: () => void }`.

**File**: `ui/src/components/identity/identity-modal.tsx` *(new)*
**Changes**: shadcn `Dialog` (not `Sheet`) listing `useUsers()` rows with select + inline "Create new" form (`name`, optional `email`). On submit → `setUserId` then close. Cannot dismiss without a selection (no `X` close, no escape-key dismiss).

**File**: `ui/src/app/providers.tsx`
**Changes**: Mount `<CurrentUserProvider>` inside the QueryClient provider. Render `<IdentityModal />` automatically whenever `useCurrentUser().state === "needs-pick"` AND `useFeatureGate("1.76.0").supported` is true. This means: first-time visitors see it on first load; existing users keep their selection across reloads; users on a freshly-upgraded API hit `needs-pick` exactly once; users pointed at a different swarm (different `swarmId`) get prompted again for that swarm.

#### 3. Plumb fields through createTask
**File**: `ui/src/api/client.ts:215-234`
**Changes**: Extend `createTask` signature to accept `{ task, agentId?, taskType?, tags?, priority?, dependsOn?, parentTaskId?, source?, requestedByUserId?, contextKey? }`. Forward all to JSON body.

**File**: `ui/src/api/hooks/use-tasks.ts:48-63`
**Changes**: `useCreateTask` mutation type widens to match.

**File**: `ui/src/pages/tasks/page.tsx:35-42,317-330`
**Changes**: `TaskFormData` type widens (don't surface `parentTaskId` in the form UI in v1; it's API-only). Form `handleCreateSubmit` reads `userId` from `useCurrentUser()` and passes it as `requestedByUserId`. `source` defaults to `"api"` (omit; let server default).

#### 4. Read-only `requestedByUserId` display
**File**: `ui/src/pages/tasks/[id]/page.tsx`
**Changes**: In QuickStats, render "Requested by" with the user name (look up via `useUsers()` cache) when `task.requestedByUserId` present.

### Success Criteria:

#### Automated Verification:
- [ ] UI type-check passes (CI parity): `cd ui && pnpm exec tsc -b`
- [ ] UI lint passes: `cd ui && pnpm lint`
- [ ] Design tokens unchanged: `cd ui && pnpm check:tokens`
- [ ] Backend type-check still green (no API contract drift): `bun run tsc:check`

#### Automated QA:
- [ ] qa-use scenario A: with `localStorage.clear()`, load `http://localhost:5274/`, identity modal appears, list shows seeded users, creating a new user closes the modal, reload preserves selection.
- [ ] qa-use scenario A2 (per-swarm namespacing): with a chosen identity for swarmId `A`, restart server with `SWARM_ID=swarm-b bun run start:http`, reload UI; modal **must** re-prompt (different swarmId → different localStorage key). Pick a different user, then point UI back at swarm A; original identity is still intact.
- [ ] qa-use scenario A3 (auto-show on upgrade): pre-seed `localStorage["agent-swarm-current-user:<swarmId>"]` to a non-existent userId, reload — `<IdentityModal />` re-pops because `useUsers()` returns no match (defensive: `state` recomputes to `needs-pick`).
- [ ] qa-use scenario B: from `/tasks`, click "New Task", submit; verify `agent_tasks.requestedByUserId` matches the picked user (`sqlite3 ... "SELECT requestedByUserId FROM agent_tasks ORDER BY createdAt DESC LIMIT 1"`).
- [ ] qa-use scenario C: open a task detail page where `requestedByUserId` is set; QuickStat shows the user's name.

#### Manual Verification:
- [ ] Boot modal copy reads naturally; create-new form accessible via keyboard alone.
- [ ] No legacy code paths regressed (open existing `/tasks`, `/agents`, `/workflows` pages and confirm rendering).

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 3] identity boot gate + parentTaskId/requestedByUserId plumbing`.

---

## Phase 4: Sessions surface (`/sessions`, `/sessions/:id`)

### Overview

Add the new `/sessions` route with split view: sidebar list + selected session detail. Detail renders a chronological timeline of user messages + task cards, with a `[parallel · N tasks]` wrapper grouping siblings sharing a `parentTaskId`. Card click opens a shadcn `Sheet` embedding `SessionLogViewer` + transcript hooks. Composer at the bottom posts a new task with `parentTaskId` set. Soft-degrade behind `useFeatureGate("1.76.0")`.

### Changes Required:

#### 1. Route registration
**File**: `ui/src/app/router.tsx`
**Changes**: Add `<Route path="sessions" element={<SessionsPage />} />` and `<Route path="sessions/:rootTaskId" element={<SessionDetailPage />} />` (or react-router v7 nested-route equivalent matching existing patterns).

#### 2. Sessions list page
**File**: `ui/src/pages/sessions/page.tsx` *(new — default export)*
**Changes**: Two-column layout. Left = `SessionsSidebar` rendering `useSessions()` (query against `GET /api/sessions?limit=50`); each row = card with root task title, last activity (relative time), task count badge, latest status pill. Right = either selected `<SessionDetailPage />` or empty state. Uses `detail-page-layout.tsx`'s grid primitives.

#### 3. Sessions detail page
**File**: `ui/src/pages/sessions/[rootTaskId]/page.tsx` *(new — default export)*
**Changes**:
- Fetch `useSession(rootTaskId)` against `GET /api/sessions/{rootTaskId}`.
- Header strip: root task title, `requestedByUserId` link, status, total tasks, total cost (sum of `useSessionCosts({ taskId: rootTaskId })` extended for chain — see Phase 5 for the inbox flow that may need this).
- Timeline: `<SessionTimeline chain={...} />`.
- Composer at bottom: `<SessionComposer rootTaskId={...} latestLeafTaskId={...} />`.

#### 4. Timeline component + parallel-group wrapper
**File**: `ui/src/components/sessions/session-timeline.tsx` *(new)*
**Changes**: Build a tree from the flat `chain[]` keyed on `parentTaskId`, then render via DFS by `createdAt` (spawn order, NOT completion order — completion order is misleading because finishes can interleave). Algorithm:

1. Identify the root: the task whose `parentTaskId` is `null` AND whose id matches `rootTaskId` from the URL. Any other `parentTaskId === null` rows in `chain` are anomalies — render them in a small "orphan" footer with a console.warn (defensive: should not happen if the chain endpoint is correct).
2. Build `childrenByParent: Map<string, AgentTask[]>` and sort each list by `createdAt`.
3. Recursive render: for each parent, walk its children in `createdAt` order. If `children.length === 1`, render the child inline. If `children.length >= 2`, wrap them in `<ParallelGroup count={N}>` with the children themselves rendered in `createdAt` order *inside* the group; their own children render outside the group as the chain continues from each.
4. **Mixed sequential + parallel + nested**: handled naturally by recursion. A chain like `root → 3 parallel → summary → 2 parallel → done` produces: card(root) → ParallelGroup(3 cards) → card(summary) → ParallelGroup(2 cards) → card(done).
5. **Status pill** uses `<Badge size="tag">` + `--color-status-*` tokens (per `ui/CLAUDE.md`). Markdown content (task descriptions, agent output) renders via `<Streamdown>` per the global rule.
6. **Empty case**: `chain.length === 0` is rendered as the empty session state with a "Start typing below" hint focused on the composer.

Selected mock:

```text
session: "Investigate the auth bug"
─────────────────────────────────────────────
> User · 2 minutes ago
  Investigate the auth bug

  ▸ Task #1842 · scan recent commits        ✓ done · 12s
       (click → opens Sheet w/ full transcript)

  ┌─ parallel · 3 tasks ──────────────────────┐
  │ ▸ Task #1843 · check tests       ✓ done  │
  │ ▸ Task #1844 · diff main vs HEAD ⏳ run    │
  │ ▸ Task #1845 · grep auth code    ⏳ run    │
  └────────────────────────────────────────────┘

  ▸ Task #1846 · summary report           ⏳ pending

> User · just now
  ─── Composer (textarea + Send) ───
```

Card collapsed-by-default body: status pill, agent name, started-at, latest tool/key activity (top 1-2 bullets from `useTaskSessionLogs`'s already-cached data — pull from QueryClient cache, no extra fetch).

#### 5. Task card + Sheet panel
**File**: `ui/src/components/sessions/task-card.tsx` *(new)*
**Changes**: Card composed from `<Card>` shadcn primitive (per `ui/CLAUDE.md` compose-only rule). Status pill = `<Badge size="tag">` with status token classnames. Body = agent name (via `<AgentLink />`), started-at, top 1-2 cached log entries. Click opens `<TaskDetailSheet taskId={...} />`. **`<ParallelGroup>`** is a thin wrapper using `border-border bg-muted/30 rounded-md` (no raw palette literals — would fail `pnpm check:tokens`); header strip says "parallel · N tasks" via `<Badge variant="outline" size="tag">`.

**File**: `ui/src/components/sessions/task-detail-sheet.tsx` *(new)*
**Changes**: Wraps shadcn `Sheet` (`side="right"`); inside renders the existing `<SessionLogViewer logs={useTaskSessionLogs(taskId).data?.logs} compactionSnapshots={useTaskContext(taskId).data?.snapshots} />`, plus a "Costs" sub-section using `useSessionCosts({ taskId })`. No new transcript code.

**Secret-scrubbing note**: this introduces no new server→client egress paths. `useTaskSessionLogs` and `useTaskContext` already hit existing endpoints whose payloads are scrubbed on the server side via `scrubSecrets` (per `runbooks/secret-scrubbing.md`). Confirm during implementation that the new chain endpoint (Phase 2) also scrubs anything that might leak through `agent_tasks.output` or `agent_tasks.failureReason`. Add an explicit verification step.

#### 6. Composer
**File**: `ui/src/components/sessions/session-composer.tsx` *(new)*
**Changes**: textarea + Send button + cmd/ctrl-enter submit. On submit: `useCreateTask({ task: input, parentTaskId: latestLeafTaskId, requestedByUserId: useCurrentUser().userId })`. Optimistic — show pending bubble, clear input, scroll to bottom. Invalidate `["session", rootTaskId]` on success.

#### 7. Sidebar navigation entry
**File**: `ui/src/components/layout/sidebar.tsx` (or wherever the existing sidebar is — confirm during implementation)
**Changes**: Add "Sessions" link above "Tasks". When `useFeatureGate("1.76.0").supported === false`, render disabled w/ tooltip `Requires API ≥ 1.76.0`.

#### 8. Version gate page
**File**: `ui/src/components/feature-gate/upgrade-required.tsx` *(new)*
**Changes**: Generic component `<UpgradeRequired feature="Sessions" requiredVersion="1.76.0" currentVersion={...} />`. Used by both Sessions pages.

### Success Criteria:

#### Automated Verification:
- [ ] UI type-check: `cd ui && pnpm exec tsc -b`
- [ ] UI lint: `cd ui && pnpm lint`
- [ ] Design tokens: `cd ui && pnpm check:tokens`

#### Automated QA:
- [ ] qa-use scenario D: load `/sessions`, sidebar shows seeded sessions, click one, detail loads, click a task card, Sheet opens with transcript, dismiss Sheet, composer present at bottom.
- [ ] qa-use scenario E: from session detail composer, submit "Run /tmp/foo.sh"; new task appears in the timeline within 5s (polling tick), `parentTaskId` matches the latest leaf.
- [ ] qa-use scenario F: pin a 3-sibling parallel session (created via API), open it, verify the `[parallel · 3 tasks]` wrapper renders all three.
- [ ] qa-use scenario G: simulate stale API by editing `package.json` version to `1.74.0` locally; reload — `/sessions` renders the upgrade-required page; sidebar entry shows the disabled tooltip.

#### Manual Verification:
- [ ] Composer feels responsive (no >300ms perceived lag on submit).
- [ ] Sheet close animation isn't janky on the Activity Monitor.
- [ ] Empty session state (no chain children yet) renders without layout shift.

### QA Spec (optional):

**QA Doc**: `thoughts/taras/qa/2026-05-08-ui-chat-session-experience-v1.md` (generate via `desplega:qa` before handoff). Cross-cutting screenshot evidence required by frontend merge gate (per `runbooks/testing.md`). Scenarios D–G + Phase 5–6 scenarios live in the doc, not here.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 4] sessions surface (/sessions, /sessions/:id)`.

---

## Phase 5: Dashboard react-flow agent canvas at `/`

### Overview

Replace `ui/src/pages/dashboard/page.tsx` with a new dashboard whose top region is a static `@xyflow/react` org-chart canvas (lead → workers, sized by 24h activity) and whose bottom region is reserved for the action-items inbox added in Phase 6. Reuse `workflow-graph.tsx` + `graph-utils.ts` + `WorkflowNodeShell`. Tabular fallback always available. Click-through to `/agents/:id`. Soft-degrade to today's dashboard when `useFeatureGate("1.76.0").supported === false`.

### Changes Required:

#### 1. Extract legacy dashboard FIRST (mechanical move, separate sub-step for diff readability)
**File**: `ui/src/pages/dashboard/legacy-dashboard.tsx` *(new)*
**Changes**: Move the existing 4-section dashboard body (StatsBar + Agent Status Grid + Active Tasks Panel + Activity Feed — currently `ui/src/pages/dashboard/page.tsx:315-477`) verbatim into a `LegacyDashboard` default-exported component. No behavior change. This is purely a copy-then-delete to keep the diff for the new dashboard reviewable.

#### 2. Replace dashboard root
**File**: `ui/src/pages/dashboard/page.tsx`
**Changes**: New body is `if (!useFeatureGate("1.76.0").supported) return <LegacyDashboard />;` then render the new `<NewDashboard />` (Phase 5 sub-steps 3+ + Phase 6 inbox).

#### 3. Agent canvas
**File**: `ui/src/components/dashboard/agent-canvas.tsx` *(new)*
**Changes**: Reuse `workflow-graph.tsx` skeleton: `<ReactFlow nodes={...} edges={...} nodesDraggable={false} fitView><Background /><Controls /></ReactFlow>`. Layout via `applyDagreLayout` (`graph-utils.ts:254`) tuned for top-down org chart (`rankdir: "TB"`). Edges: lead → each worker. Nodes: custom `<AgentNode />`.

**Performance bound**: target 50+ nodes per the PRD. dagre layout + xyflow rendering both scale O(N+E); 50 nodes with ≤ 50 edges is well within smooth-render territory (workflow-graph.tsx already proves this). No `nodesConnectable`, no `nodesDraggable`, no animation in v1.

**File**: `ui/src/components/dashboard/agent-node.tsx` *(new)*
**Changes**: Wraps `WorkflowNodeShell`. Body = avatar/icon + name + role pill + 24h stats (task count, cost). Width/height computed from a normalized "activity score" (formula below). Click → `navigate('/agents/${id}')`.

#### 4. Activity-score data (pinned to real sources — no `useUsageDaily()`, that hook does not exist)
**File**: `ui/src/api/hooks/use-agent-activity.ts` *(new)*
**Changes**: `useAgentActivity({ windowHours: 24 })` returns `{ agents: Array<{ agentId, taskCount24h, cost24h }> }`. Data sources:
- `useAgents()` for the agent roster.
- `useTasks({ createdAfter: <ISO 24h ago>, limit: 1000 })` — bounded fetch (≤ 1000 task rows/day is more than enough; if exceeded, surface a warning). Server-side `createdAfter` filter ships in Phase 2.
- `useDashboardCosts()` (`ui/src/api/hooks/use-costs.ts:117`) — already aggregates server-side. Provides per-agent `cost24h`. Token usage is *not* a separate dimension in v1 — cost is a strict super-signal of token usage and the canvas is visually saturated by two dimensions; drop tokens from the score.

**Activity score formula** (starting heuristic, label as such, tune in v1.1):
`score(agent) = 0.6 * normalize(taskCount24h) + 0.4 * normalize(cost24h)`
`size(agent) = MIN_SIZE + (MAX_SIZE - MIN_SIZE) * score(agent)`

If both dimensions are zero across the swarm, fall back to constant `MIN_SIZE` (no normalization on a zero vector).

#### 5. Tabular fallback
**File**: `ui/src/components/dashboard/agent-table.tsx` *(new)*
**Changes**: `DataGrid` over the same `useAgentActivity()` data. Columns: name, role, status, taskCount24h, cost24h. Toggle button at top of canvas: `[Canvas | Table]`. Persisted in `localStorage` key `agent-swarm-dashboard-view`.

### Success Criteria:

#### Automated Verification:
- [ ] UI type-check: `cd ui && pnpm exec tsc -b`
- [ ] UI lint: `cd ui && pnpm lint`
- [ ] Design tokens: `cd ui && pnpm check:tokens`

#### Automated QA:
- [ ] qa-use scenario H: load `/`, canvas renders within 2s, lead at top, ≥1 worker below, edges drawn.
- [ ] qa-use scenario I: click a worker node, navigates to `/agents/{id}`.
- [ ] qa-use scenario J: toggle to "Table" view; AG Grid renders the same agents with sortable activity columns.
- [ ] qa-use scenario K: with `package.json` version forced to `1.74.0` and the FE rebuilt, load `/` — legacy dashboard renders unchanged.

#### Manual Verification:
- [ ] Canvas remains smooth (no jank) with ≥10 worker nodes locally.
- [ ] Node sizing is visually distinguishable between an idle agent and the most-active one (not a marginal 5px difference).
- [ ] Tabular fallback toggle persists across reload.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 5] dashboard react-flow agent canvas + tabular fallback`.

---

## Phase 6: Action-items inbox (4 buckets, dismiss/snooze/done)

### Overview

Add the four-bucket inbox below the agent canvas on `/`: Blocking (pending approvals + agents `waiting_for_credentials`), Broken (failed/cancelled tasks via `?status=failed,cancelled` — the multi-status CSV from Phase 2), To read (recently completed root sessions), To start (rows from `task_templates` — click pre-fills `CreateTaskDialog`). Each item supports dismiss / snooze / done via `PATCH /api/inbox-state`. State scoped by `userId` from identity context. Polling at the global 5s default.

**Polling-rate budget** (per dashboard tick, every 5s):
- `useApprovalRequests({ status: "pending" })` — 1 request
- `useCredentialMissingAgents()` — 1 request
- `useTasks({ status: "failed,cancelled", createdAfter: <7d ago> })` — 1 request (CSV merges what would otherwise be 2)
- `useSessions({ limit: 50 })` — 1 request (already needed by Sessions sidebar; cached query, not a re-fetch)
- `useTaskTemplates()` — 1 request, `staleTime: Infinity` (templates rarely change)
- `useInboxState({ userId })` — 1 request

Budget: ~5 polled requests/5s on the dashboard. Inbox-state filtering happens client-side via a `Set<itemKey>` of `dismissed | snoozed-still-active | done` items joined against bucket source data. **No N+1**: each bucket source is a single list call, the join is O(N+M).

### Changes Required:

#### 1. Per-bucket data hooks
**File**: `ui/src/api/hooks/use-inbox.ts` *(new)*
**Changes**: 
- `useBlockingInbox()` — combines `useApprovalRequests({ status: "pending" })` + `useCredentialMissingAgents()` (new wrapper hook over `GET /api/agents/credential-status?status=waiting_for_credentials`). Filters out items with `inbox_item_state.status IN ('snoozed','dismissed','done')` for the current user.
- `useBrokenInbox()` — fetches `useTasks({ status: "failed,cancelled", createdAfter: <7d ago> })` (one call via the Phase 2 multi-status CSV), filters via inbox-state.
- `useToReadInbox()` — uses `GET /api/sessions?limit=50` (Phase 2), filters to those whose latest task is `completed` within last 7 days, filters via inbox-state.
- `useToStartInbox()` — `useTaskTemplates()` query.

#### 2. Inbox UI
**File**: `ui/src/components/dashboard/inbox-panel.tsx` *(new)*
**Changes**: Four columns (or stacked at narrow widths via Tailwind responsive utilities). Each column = bucket header + count badge + scrollable card list. Uses `--color-status-*` tokens for severity.

**File**: `ui/src/components/dashboard/inbox-card.tsx` *(new)*
**Changes**: Card primitive with title, subtitle, footer actions: Dismiss (×), Snooze (▼ menu: 1h, 4h, 1d), Done (✓). Click body → contextual deep link (approval → `/approval-requests/:id`, broken → `/tasks/:id`, to-read → `/sessions/:rootTaskId`, to-start → triggers Phase 6.3).

#### 3. "To start" → CreateTaskDialog wiring
**File**: `ui/src/components/dashboard/inbox-panel.tsx`
**Changes**: Click on a template card → opens existing `CreateTaskDialog` (`ui/src/pages/tasks/page.tsx:53`) with `task` pre-filled from `template.prompt`, `tags` pre-filled from `template.tags`. Dialog already supports controlled prop pattern (verify during implementation; refactor if not).

#### 4. Dismiss/snooze/done mutation (with explicit race semantics)
**File**: `ui/src/api/hooks/use-inbox-state.ts` *(new)*
**Changes**: `useUpdateInboxItem()` mutation against `PATCH /api/inbox-state`. Strict TanStack flow:
- `onMutate`: snapshot current `["inbox-state", userId]` cache, optimistically merge the new state into it (Map-based merge keyed by `itemType+itemId`), return rollback ref.
- `onError`: revert to snapshot, fire a `toast.error(...)`.
- `onSettled`: invalidate `["inbox-state", userId]` to converge with server.

**Polling tick interaction**: when a polling tick re-fetches `useInboxState`, the merge function joins server response with any in-flight optimistic mutation by `itemType+itemId` so an optimistically-dismissed item does not flicker back. With 5 rapid dismisses, all five `onMutate` callbacks accumulate into the same cache entry; PATCH calls execute in parallel; `onSettled` is per-mutation but the invalidation is debounced via TanStack's default coalescing.

#### 5. Replace placeholder slot in dashboard
**File**: `ui/src/pages/dashboard/page.tsx`
**Changes**: Render `<InboxPanel />` below `<AgentCanvas />` (or `<AgentTable />`).

### Success Criteria:

#### Automated Verification:
- [ ] UI type-check: `cd ui && pnpm exec tsc -b`
- [ ] UI lint: `cd ui && pnpm lint`
- [ ] Design tokens: `cd ui && pnpm check:tokens`

#### Automated QA:
- [ ] qa-use scenario L: seed a pending approval + a `waiting_for_credentials` agent + a `failed` task + a recently completed root session via API; load `/`; all four buckets render the seeded items.
- [ ] qa-use scenario M: dismiss an inbox item; reload — item stays dismissed.
- [ ] qa-use scenario N: snooze for 1h; verify `inbox_item_state.snoozeUntil` is ~1h in the future via SQL.
- [ ] qa-use scenario O: click a "To start" template card → `CreateTaskDialog` opens with prompt pre-filled.

#### Manual Verification:
- [ ] Bucket counts match what's actually visible (no off-by-one from inbox-state filter).
- [ ] Snooze menu copy + UX is unambiguous.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 6] action-items inbox (4 buckets, dismiss/snooze/done)`.

---

## Phase 7: Polish, empty states, qa-use sweep, full verification

### Overview

Empty states for every new surface, loading skeletons, a clean qa-use session capturing screenshots of all four UI pages, and a final pass of every CI check before opening the bundled PR.

### Changes Required:

#### 1. Empty states (use existing `EmptyState` primitive)
**Files**: `ui/src/pages/sessions/page.tsx`, `ui/src/pages/sessions/[rootTaskId]/page.tsx`, `ui/src/components/dashboard/agent-canvas.tsx`, `ui/src/components/dashboard/inbox-panel.tsx`
**Changes**: Reuse `<EmptyState icon={...} title="..." description="..." />` from `ui/src/components/shared/empty-state.tsx` (per `ui/CLAUDE.md` primitives catalog). Each: icon + headline + 1-line context + primary CTA (e.g., Sessions empty → "Start your first session" → composer-focused). Inbox bucket empty → "All clear" line per bucket.

#### 2. Loading skeletons (use existing `<Skeleton />` and `<PageSkeleton />` primitives)
**Files**: same surfaces above
**Changes**: TanStack Query `isLoading` branches render skeletons matching the layout: sidebar rows = `<Skeleton className="h-12 w-full" />` repeated; timeline cards = `<Skeleton className="h-16 w-full" />`; full-page initial load = `<PageSkeleton />`. Both already exist per `ui/CLAUDE.md` primitives catalog.

#### 3. qa-use session
**File**: `thoughts/taras/qa/2026-05-08-ui-chat-session-experience-v1.md` *(new — generated via `desplega:qa`)*
**Changes**: Captures all qa-use scenarios across phases 3–6. Screenshots embedded for: identity modal, sessions list, session detail (collapsed cards + Sheet open), parallel-group wrapper, dashboard canvas + table toggle, inbox panel with all 4 buckets, version-gate page.

#### 4. Final sweep
- `bun run tsc:check`, `bun run lint`, `bun test`, `bash scripts/check-db-boundary.sh`, `bun run docs:openapi` (commit drift if any), `cd ui && pnpm exec tsc -b`, `pnpm lint`, `pnpm check:tokens`.

### Success Criteria:

#### Automated Verification:
- [ ] All backend checks: `bun run tsc:check && bun run lint && bun test && bash scripts/check-db-boundary.sh`
- [ ] OpenAPI clean: `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference`
- [ ] All UI checks: `cd ui && pnpm exec tsc -b && pnpm lint && pnpm check:tokens`

#### Automated QA:
- [ ] All qa-use scenarios A–O re-run end-to-end in a single session, screenshots stored in QA doc.

#### Manual Verification:
- [ ] Every empty state has been visually confirmed (clear DB → load each page).
- [ ] Loading state never flashes a layout-shifted skeleton (no CLS).
- [ ] No console errors during the qa-use walkthrough — verified deterministically via the instrumented hook (`window.console.error = (...args) => { window.__sawError = true; orig(...args); }`); qa-use script asserts `window.__sawError === undefined` at end.

**Implementation Note**: After this phase, the bundle is PR-ready. Final commit: `[phase 7] polish, empty states, qa-use sweep`.

---

## Manual E2E

Real commands sourced from `LOCAL_TESTING.md`. Execute end-to-end after Phase 7, with a clean DB.

```bash
# 0. Verify port + clean state
lsof -i :3013 || true       # confirm 3013 free
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm

# 1. Start API server (foreground, watch logs)
bun run start:http
# Confirm: "Server listening on http://localhost:3013"

# 2. In another terminal: start UI dev server
cd ui && pnpm dev   # port 5274

# 3. Verify version contract
curl -s http://localhost:3013/health
# expect: {"status":"ok","version":"1.76.0"}

# 4. Open http://localhost:5274/ in browser
#    - Identity modal appears (no localStorage entry)
#    - Pick "Taras" or create a new user
#    - Modal closes
#    - Dashboard renders: agent canvas (likely empty initially) + inbox (empty buckets)

# 5. In another terminal: spin up lead + worker via Docker (uses pm2 helpers)
bun run docker:build:worker
bun run pm2-start
# Confirm: pm2 status shows api, lead, worker green

# 6. Watch the canvas populate
#    - Reload /  -> the lead + worker now render with sized nodes

# 7. Create a session via curl (simulating an API caller)
USER_ID=$(curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/users | jq -r '.users[0].id')
echo "USER_ID=$USER_ID"
curl -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d "{\"task\":\"Investigate the auth bug\",\"source\":\"api\",\"requestedByUserId\":\"$USER_ID\"}"
# Capture returned task id (e.g. ROOT_TASK_ID=...)

# 7b. Force a parallel-group: spawn 3 child tasks sharing the same parentTaskId
for i in 1 2 3; do
  curl -X POST http://localhost:3013/api/tasks \
    -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
    -d "{\"task\":\"Parallel work $i\",\"source\":\"api\",\"parentTaskId\":\"$ROOT_TASK_ID\",\"requestedByUserId\":\"$USER_ID\"}"
done

# 8. Reload /sessions -> sidebar shows the new session
#    - Click it -> detail loads via GET /api/sessions/{rootTaskId}
#    - Wait ~10s for the lead to spawn child tasks
#    - Verify timeline cards appear; click one -> Sheet opens with transcript
#    - If parallel siblings exist, parallel-group wrapper is visible

# 9. Submit a follow-up via the composer
#    - Type "Now write a regression test"; Send
#    - Verify a new card appears within 5s
#    - SQL spot-check: parentTaskId matches the latest leaf
sqlite3 agent-swarm-db.sqlite "SELECT id, parentTaskId, requestedByUserId, source FROM agent_tasks ORDER BY createdAt DESC LIMIT 5;"

# 10. Trigger inbox-state mutations across all four buckets
#  10a. Broken: cancel one of the worker tasks
TASK_TO_CANCEL=$(curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks?limit=5 | jq -r '.tasks[0].id')
curl -X POST "http://localhost:3013/api/tasks/$TASK_TO_CANCEL/cancel" -H "Authorization: Bearer 123123"
#       Reload /, "Broken" bucket shows the cancelled task; Dismiss; reload; item stays dismissed.
#  10b. Snooze: pick a "Broken" item, snooze 1h; verify SQL:
sqlite3 agent-swarm-db.sqlite "SELECT itemType, itemId, status, snoozeUntil FROM inbox_item_state ORDER BY lastUpdatedAt DESC LIMIT 5;"
#  10c. To-read: complete a chain (the lead/worker should naturally complete the parallel group from 7b);
#       reload, the root session should appear in the "To read" bucket.
#  10d. To-start: click any template card → CreateTaskDialog opens with `task` pre-filled from `template.prompt`.

# 10e. Per-swarm namespacing — start a second API on a different port + SWARM_ID
SWARM_ID=swarm-b PORT=3014 bun run start:http &
#       Visit http://localhost:5274/?apiUrl=http://localhost:3014; identity modal re-pops.
#       Pick a different user. Switch back to the default URL — original identity intact.

# 10f. Canvas/table toggle persistence
#       Click "Table" toggle on the dashboard. Reload. View should still be Table.

# 10g. Console-error sweep
#       In the browser devtools, ensure window.console.error has not been called during the walkthrough.
#       (Optional automation: prepend `window.console.error = (...args) => { window.__sawError = true; orig(...args); }`)

# 11. Stale-API soft-degrade smoke test
#     - Stop API; revert package.json to 1.75.0; restart API
git stash; sed -i.bak 's/"1.76.0"/"1.75.0"/' package.json; bun run start:http
#     - Reload UI; confirm:
#       * /sessions renders the upgrade-required page
#       * Dashboard falls back to legacy 4-section dashboard
#       * Sidebar Sessions entry has disabled tooltip
#     - Restore version
git checkout package.json

# 12. Cleanup
bun run pm2-stop
kill $(lsof -ti :3013) 2>/dev/null || true
```

---

## Appendix

- **Autonomy mode**: Critical (per `/desplega:create-plan` invocation).
- **Commit cadence**: Yes — one `[phase N] <desc>` commit per phase after manual verification passes.
- **Required minimum API version**: `1.76.0` (current: `1.75.0`).
- **Frontend QA gate**: per `runbooks/testing.md`, frontend PRs require a qa-use session with screenshots — covered by Phase 7's QA doc.
- **OpenAPI drift**: regenerated in Phases 1, 2, and again at the end of Phase 7 if any handler signatures shift.
- **Derail notes** (out of scope, captured for v2):
  - "Awaiting input" first-class status — need a new `task_status` value + lead semantics; defer.
  - SSE/WebSocket transport for sub-second feel; today's 5s polling is acceptable.
  - PR-awaiting-review bucket source — needs GH API poller or webhook extension.
  - Generic missing-keys-health aggregator (beyond per-agent `waiting_for_credentials`).
  - Per-feature gating (vs the simpler whole-feature soft degrade) if the API contract diverges within a single batch.
- **References**:
  - PRD: `thoughts/taras/brainstorms/2026-05-08-ui-chat-session-experience.md`
  - Research: `thoughts/taras/research/2026-05-08-ui-chat-session-experience-research.md`
  - Project rules: `CLAUDE.md`, `ui/CLAUDE.md`
  - CI gate map: `runbooks/ci.md`
  - Local dev: `runbooks/local-development.md`
  - Local testing: `LOCAL_TESTING.md`
  - Secret scrubbing: `runbooks/secret-scrubbing.md`

## Review Errata

_Reviewed: 2026-05-08 by `desplega:reviewing` (Auto-apply mode)_

### Applied (Critical)
- [x] Migration numbers renumbered `054→055..057→058` to avoid collision with existing `054_agent_harness_provider.sql`.
- [x] Phase 5 activity-score data source pinned to real hooks (`useAgents`, `useTasks` with bounded `createdAfter`, `useDashboardCosts`); dropped the made-up `useUsageDaily()`.
- [x] Phase 2 extends `GET /api/tasks` with `createdAfter` filter so the dashboard fetch is bounded.
- [x] Phase 4 timeline algorithm explicitly spec'd (tree-build → DFS by `createdAt` → group siblings ≥ 2; nested parallel + out-of-order completion handled).
- [x] Phase 2 server-side handling of unknown `requestedByUserId`: treat as `null` + log warn rather than 500 (deleted-user race).
- [x] Phase 6 dismiss-state filter strategy made explicit (server-side `useInboxState` query + client-side O(N+M) join); Broken bucket consolidated into one `?status=failed,cancelled` CSV call (Phase 2 contract).

### Applied (Important)
- [x] `getSwarmId()` precedence rule documented: env var wins; cached at boot; cross-replica must align; mid-deployment changes invalidate per-swarm localStorage identities.
- [x] Phase 1 FK preservation verification step added (`PRAGMA foreign_key_list(agent_tasks)` before/after).
- [x] Phase 3 `<CurrentUserProvider>` adds a `storage` event listener for cross-tab cohesion; deleted-user case handled via `state` recompute.
- [x] `useHealth` `staleTime` set to `30_000` (not `Infinity`) so swarmId switch mid-session is detected.
- [x] Phase 6 dismiss-race semantics specified (TanStack `onMutate` snapshot, optimistic merge, polling-tick join).
- [x] Phase 4 secret-scrubbing note added; chain endpoint validation step.
- [x] Manual E2E expanded to cover all four buckets (Broken, Snooze, To read, To start), parallel-group spawn via curl, per-swarm namespacing (10e), canvas/table toggle persistence (10f), console-error sweep (10g), `<userId>` extraction via `jq`.
- [x] Phase 1 docs-site version grep added to verification.

### Applied (Minor)
- [x] `inbox_item_state.itemType` Zod-only flagged with note in the migration.
- [x] `<ParallelGroup>` styling pinned to `border-border bg-muted/30` tokens (no raw palette literals).
- [x] Activity-score formula labeled as "starting heuristic, tune in v1.1".
- [x] Console-error verification made deterministic via `window.console.error` instrumentation.
- [x] Phase 5 sub-step 1 = legacy-dashboard extraction (mechanical move, separate sub-step for diff readability).
- [x] Phase 1 + Phase 2 visibility / "ships with no UI consumer until Phase 3+" notes added.
- [x] `lastActivityAt` column shape pinned in `listRecentSessions` return type.
- [x] Reuse existing `useHealth` (`use-stats.ts:11`), `EmptyState`, `<Skeleton />`, `PageSkeleton`, `<Card>`, `<Badge size="tag">`, `<Streamdown>`, `<AgentLink />` primitives per `ui/CLAUDE.md`.

### Remaining
_(none — all Critical and Important auto-applied with user authorization)_
