---
date: 2026-04-23T00:00:00Z
topic: "Provider-Aware Task UI: Devin Session URL"
status: completed
---

# Provider-Aware Task UI: Devin Session URL

**Status**: completed

## Overview

Surface provider-specific metadata in the task detail UI, starting with showing the Devin session URL as a clickable link. This requires three things: (1) tracking which provider ran a task, (2) storing provider-specific metadata (like the Devin session URL) in a generic JSON column, and (3) rendering provider-aware details in the dashboard.

## Current State Analysis

- The Devin API returns both `session_id` and `url` when creating a session (`src/providers/devin-adapter.ts:89-90`)
- `session_id` is stored in the `claudeSessionId` column via `PUT /api/tasks/{id}/claude-session` (`src/commands/runner.ts:1677`)
- The `url` is **not persisted** — it only appears as a log message string (`devin-adapter.ts:102`)
- The `session_init` ProviderEvent only carries `sessionId` — no URL or provider name (`src/providers/types.ts:19`)
- No `provider` column exists on `agent_tasks` — the UI cannot distinguish Claude/Codex/Devin/Pi tasks
- The task detail page shows `claudeSessionId` truncated to 12 chars with no link (`new-ui/src/pages/tasks/[id]/page.tsx:508-513`)
- The runner knows the provider from `process.env.HARNESS_PROVIDER` (`src/commands/runner.ts:2187`)

### Key Discoveries:
- `session_init` is emitted by all four adapters (claude, codex, pi, devin) — extending it is the natural place to carry provider metadata
- The runner's `saveProviderSessionId()` already PUTs to the API at session start — we extend this call, not add a new one
- `rowToAgentTask()` at `src/be/db.ts:822` maps all DB columns to API response — new columns appear automatically in the API
- Next migration number: `041`

## Desired End State

1. Every task records which provider ran it (`provider` column: `claude | codex | pi | devin`)
2. Provider-specific metadata is stored as JSON (`providerMeta` column)
3. For Devin tasks, `providerMeta` contains `{ "sessionUrl": "https://..." }`
4. The task detail page shows a provider badge and, for Devin tasks, a clickable link to the session
5. Future providers can store their own metadata without schema changes

**Verification**: Create a Devin task, check `GET /api/tasks/{id}` returns `provider: "devin"` and `providerMeta.sessionUrl`, confirm the UI shows a clickable link.

## Quick Verification Reference

Common commands:
- `bun test` — all unit tests
- `bun run lint:fix` — Biome lint + format
- `bun run tsc:check` — TypeScript check
- `cd new-ui && pnpm exec tsc --noEmit` — frontend type check

Key files:
- `src/be/migrations/041_provider_meta.sql` — new migration
- `src/be/db.ts` — `rowToAgentTask()`, `updateTaskClaudeSessionId()`
- `src/types.ts` — `AgentTaskSchema`
- `src/providers/types.ts` — `ProviderEvent`
- `src/commands/runner.ts` — `saveProviderSessionId()`, `session_init` handler
- `src/http/tasks.ts` — `updateClaudeSession` route
- `new-ui/src/api/types.ts` — frontend `AgentTask`
- `new-ui/src/pages/tasks/[id]/page.tsx` — task detail UI

## What We're NOT Doing

- Renaming `claudeSessionId` column or endpoint (legacy, too much churn)
- Adding provider tracking to `session_costs` (separate concern)
- Adding `provider`/`providerMeta` to `active_sessions` — this table is a transient concurrency tracker (rows are deleted on task completion). The pool task path (`saveProviderSessionIdOnActiveSession`) is a legacy code path largely superseded by atomic `claimTask()` in the poll handler. Provider data only needs to persist on `agent_tasks` where it's permanent.
- Building a Devin-specific session log parser in `session-log-viewer.tsx` (separate concern)
- Changing the tasks list page — only the task detail page for now

## Implementation Approach

Extend the existing `session_init` -> `saveProviderSessionId` -> `PUT /api/tasks/{id}/claude-session` flow to also carry `provider` and `providerMeta`. This keeps the change narrow — one new migration, one extended endpoint, one extended runner call, one UI change. The generic `providerMeta` JSON column is future-proof for other providers.

---

## Phase 1: Database + Backend Types

### Overview
Add `provider` and `providerMeta` columns to `agent_tasks`, update the DB layer and Zod schema to read/write them.

### Changes Required:

#### 1. Migration
**File**: `src/be/migrations/041_provider_meta.sql`
**Changes**: New file — `ALTER TABLE agent_tasks ADD COLUMN provider TEXT; ALTER TABLE agent_tasks ADD COLUMN providerMeta TEXT;`

#### 2. DB row type
**File**: `src/be/db.ts`
**Changes**:
- Add `provider: string | null` and `providerMeta: string | null` to `AgentTaskRow` interface
- In `rowToAgentTask()` (~line 822): map `provider` and parse `providerMeta` from JSON
- In `updateTaskClaudeSessionId()` (~line 1058): extend to accept optional `provider` and `providerMeta` params, include them in the UPDATE SQL

#### 3. Zod schema
**File**: `src/types.ts`
**Changes**: Add `provider: z.enum(["claude", "codex", "pi", "devin"]).optional()` and `providerMeta: z.record(z.string(), z.unknown()).optional()` to `AgentTaskSchema`

### Success Criteria:

#### Automated Verification:
- [x] Migration applies cleanly: `rm -f test-provider-meta.sqlite && bun run start:http` (check logs for migration 041)
- [x] Type check passes: `bun run tsc:check`
- [x] Existing tests pass: `bun test`

#### Manual Verification:
- [ ] `GET /api/tasks/{id}` returns `provider` and `providerMeta` fields (null for old tasks)
- [ ] Fresh DB + existing DB both boot without errors

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 2: Provider Event + Runner + API Endpoint

### Overview
Extend the `session_init` event to carry optional provider metadata, update the runner to pass it through, and extend the API endpoint to store it.

### Changes Required:

#### 1. Provider event type
**File**: `src/providers/types.ts`
**Changes**: Extend `session_init` variant to: `{ type: "session_init"; sessionId: string; provider?: string; providerMeta?: Record<string, unknown> }`

#### 2. Devin adapter
**File**: `src/providers/devin-adapter.ts`
**Changes**: In the constructor (~line 98), extend the `session_init` emit to include `provider: "devin"` and `providerMeta: { sessionUrl: sessionResponse.url }`

#### 3. All other adapters (required)
**Files**: `src/providers/claude-adapter.ts`, `src/providers/codex-adapter.ts`, `src/providers/pi-mono-adapter.ts`
**Changes**: Add `provider: "claude"` / `"codex"` / `"pi"` to their `session_init` emits (no `providerMeta` needed yet). This is required — without it, non-Devin tasks would have `provider: null`, making the UI badge unreliable.

#### 4. Runner — both session_init handlers
**File**: `src/commands/runner.ts`
**Changes**:
- Extend `saveProviderSessionId()` (~line 1029) to accept optional `provider` and `providerMeta` params, include them in the PUT body
- In the main `session_init` handler (~line 1675): pass `event.provider` and `event.providerMeta` through to `saveProviderSessionId()`
- In the AI-loop `session_init` handler in `runProviderIteration()` (~line 1991): also pass `event.provider` and `event.providerMeta` through to `saveProviderSessionId()`

#### 5. API endpoint
**File**: `src/http/tasks.ts`
**Changes**:
- Extend `updateClaudeSession` route body schema (~line 80) to accept optional `provider: z.string()` and `providerMeta: z.record(z.string(), z.unknown())`
- In the handler (~line 292): pass the new fields to `updateTaskClaudeSessionId()`

#### 6. OpenAPI regeneration
**Changes**: Run `bun run docs:openapi` to regenerate `openapi.json` after extending the route schema. Commit the regenerated files. (Required by CLAUDE.md — CI enforces freshness.)

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] All tests pass: `bun test`
- [x] Lint passes: `bun run lint:fix`
- [x] OpenAPI spec is fresh: `bun run docs:openapi` produces no diff

#### Manual Verification:
- [ ] Call `PUT /api/tasks/{id}/claude-session` with `{ "claudeSessionId": "test", "provider": "devin", "providerMeta": { "sessionUrl": "https://example.com" } }` — verify `GET /api/tasks/{id}` returns the stored values

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 3: Frontend — Task Detail UI

### Overview
Add `provider` and `providerMeta` to the frontend types and render provider-aware details in the task detail page.

### Changes Required:

#### 1. Frontend types
**File**: `new-ui/src/api/types.ts`
**Changes**: Add `provider?: string` and `providerMeta?: Record<string, unknown>` to the `AgentTask` interface

#### 2. Task detail page
**File**: `new-ui/src/pages/tasks/[id]/page.tsx`
**Changes**:
- Add a **provider badge** near the existing badges (status, source, model area) — e.g., `<Badge>DEVIN</Badge>` styled per provider
- Modify the **Session** MetaRow (~line 508-513): when `task.provider === "devin"` and `providerMeta?.sessionUrl` exists, render the session ID as a clickable external link to the Devin session URL (with an ExternalLink icon). For other providers, keep the existing truncated display.
- Consider adding a dedicated **Devin Session** MetaRow with the full URL link when `providerMeta?.sessionUrl` is present

### Success Criteria:

#### Automated Verification:
- [x] Frontend type check: `cd new-ui && pnpm exec tsc --noEmit`
- [x] Frontend lint: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Task detail page for a Devin task shows a provider badge and clickable session link
- [ ] Task detail page for a Claude task shows no provider-specific section (graceful fallback)
- [ ] Old tasks without `provider` set render normally (no regressions)
- [ ] The external link opens in a new tab

**Implementation Note**: After completing this phase, pause for manual confirmation.

### QA Spec (optional):

**Approach:** manual
**Test Scenarios:**
- [ ] TC-1: Devin task with session URL
  - Steps: 1. Navigate to task detail for a Devin task, 2. Check for provider badge, 3. Click session URL link
  - Expected: Badge shows "DEVIN", link opens Devin session in new tab
- [ ] TC-2: Claude task (no provider meta)
  - Steps: 1. Navigate to task detail for a Claude task
  - Expected: No provider badge clutter, session ID displays as before (truncated)
- [ ] TC-3: Legacy task (no provider column set)
  - Steps: 1. Navigate to task detail for a pre-existing task
  - Expected: No errors, no empty badge, graceful rendering

---

## Phase 4: Tests

### Overview
Add/update tests to cover the new columns, event fields, and API changes.

### Changes Required:

#### 1. Devin adapter test
**File**: `src/tests/devin-adapter.test.ts`
**Changes**: Verify `session_init` event now includes `provider: "devin"` and `providerMeta: { sessionUrl: ... }`

#### 2. API/DB integration test (if one exists for the claude-session endpoint)
**Changes**: Test that `PUT /api/tasks/{id}/claude-session` with `provider` + `providerMeta` persists and returns in `GET /api/tasks/{id}`

### Success Criteria:

#### Automated Verification:
- [x] All tests pass: `bun test`
- [x] Devin adapter test specifically: `bun test src/tests/devin-adapter.test.ts`

#### Manual Verification:
- [ ] Review test output for the new assertions

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Testing Strategy

- **Unit**: Devin adapter emits correct `session_init` shape, other adapters include `provider` field
- **Integration**: `PUT /api/tasks/{id}/claude-session` round-trip with new fields
- **Manual**: Dashboard UI shows provider badge + clickable Devin session link
- **Regression**: Old tasks without provider/providerMeta render normally

## References
- Devin harness provider plan: `thoughts/shared/plans/2026-04-23-devin-harness-provider.md`
- Devin API types: `src/providers/devin-api.ts:45-57`
- Task detail UI: `new-ui/src/pages/tasks/[id]/page.tsx`

---

## Review Errata

_Reviewed: 2026-04-23_

### Critical
- [x] **Pool task path not addressed.** Resolved: pool task path (`active_sessions`) explicitly scoped out in "What We’re NOT Doing" with rationale (transient table, legacy code path). Only `agent_tasks` needs the columns.

### Important
- [x] **OpenAPI regeneration missing.** Resolved: added as Phase 2 step 6 with `bun run docs:openapi` in automated verification.
- [x] **Direct task `session_init` handler not mentioned.** Resolved: Phase 2 step 4 now covers both the main handler (~line 1675) and the AI-loop handler in `runProviderIteration()` (~line 1991).
- [x] **Phase 2 step 3 should not be optional.** Resolved: renamed from "(optional, low-effort)" to "(required)" with explanation.

### Resolved
- [x] Frontmatter missing `planner` field — acceptable, not enforced by hook
- [x] Codex swarm events handler (`codex-swarm-events.ts:111`) verified safe — only reads `event.sessionId`, ignores extra fields
- [x] Migration number 041 confirmed correct (latest is 040)
