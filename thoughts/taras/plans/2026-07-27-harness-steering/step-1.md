---
id: step-1
name: Core steering storage + service + HTTP + RBAC
depends_on: []
status: done
assignee: codex-gpt-5.6-sol (orchestrated)
claimed_at: 2026-07-27
completed_at: 2026-07-27
---

> **Orchestrator amendment (2026-07-27):** step-1 additionally ships the two worker-callback routes
> step-3 needs — `POST /api/steering-messages/{id}/delivered` and `POST /api/steering-messages/{id}/undeliverable`
> — plus `getSteeringMessageById(id)` and the `markSteeringUndeliverable(id, reason)` service seam.
> The original spec listed only three routes, which would have forced step-3 to edit step-1-owned files.
> Ownership is unchanged: step-1 still owns every steering route.

# step-1: Core steering storage + service + HTTP + RBAC

## Overview

The contract every other step forks from. Creates the `task_steering_messages` table, its Zod types, the complete `src/be/db.ts` helper set (**including helpers only later steps consume**), the core steering service that owns the `steer → queue → follow-up task` fallback ladder, the RBAC verbs, and three HTTP routes: the caller-facing `POST /api/tasks/{id}/steer`, the UI-facing `GET /api/tasks/{id}/steering-messages`, and the worker-facing `GET /api/steering-messages`.

**This step owns every change to `src/be/migrations/`, `src/be/db.ts`, `src/types.ts`, `src/rbac/*`, and the steering routes in `src/http/tasks.ts` for this entire plan.** No other step edits those files. Deliver the full helper surface even where this step has no caller yet — steps 2, 3, 9 and 10 depend on it existing.

## Changes Required:

#### 1. Migration
**File**: `src/be/migrations/121_task_steering_messages.sql`
**Changes**: New table. Follow the `072_task_attachments.sql` conventions exactly — **snake_case columns for new tables** (only legacy `agent_tasks` uses camelCase), `ON DELETE CASCADE` on the task FK, `ON DELETE SET NULL` for soft user refs, ISO-8601-with-Z timestamps via `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` (plain `datetime('now')` fails `z.iso.datetime()`), inline `CHECK (col IN (...))` on enums, and `idx_<table>_<col>` index naming.

```sql
CREATE TABLE task_steering_messages (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  body               TEXT NOT NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('steer','queue')),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','delivered','handled','promoted','cancelled')),
  delivered_mode     TEXT CHECK (delivered_mode IN ('steer','queue')),  -- what ACTUALLY happened
  source             TEXT NOT NULL,          -- ui | mcp | script | slack | api  (Zod is SoT, no CHECK — see migration 056)
  created_by_kind    TEXT NOT NULL CHECK (created_by_kind IN ('user','agent','system')),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_agent_id TEXT,
  promoted_task_id   TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  delivered_at       TEXT,
  handled_at         TEXT
);
CREATE INDEX idx_task_steering_messages_task ON task_steering_messages(task_id);
CREATE INDEX idx_task_steering_messages_pending
  ON task_steering_messages(task_id, status) WHERE status = 'pending';
```

Add a header comment explaining the lifecycle and, per repo convention (see `072` vs `056`), state explicitly that `mode`/`status`/`created_by_kind` keep SQL CHECKs synced with Zod while `source` is Zod-only.

⚠️ **Verify `121` is still free before writing** (`ls src/be/migrations/ | sort -V | tail -3`). PR #1003 (extension system) claims 118–121 on an unmerged branch — renumber if it landed first.

#### 2. Types
**File**: `src/types.ts`
**Changes**: New `// ===...===` block modelled on the Task Attachments block at `:505-595`. Add `SteerModeSchema` (`z.enum(["steer","queue"])`), `SteeringStatusSchema`, `SteeringSourceSchema`, `SteeringMessageSchema` (full row, camelCase fields), and `SteerOutcomeSchema` — the discriminated result decision 14 requires:

```ts
export const SteerOutcomeSchema = z.enum([
  "steered",   // delivered as an interrupt
  "queued",    // delivered at a turn boundary (incl. steer→queue degradation)
  "promoted",  // no live delivery possible → follow-up task created
]);

/** Decision 16 — callers opt into a hard failure instead of a silent downgrade. */
export const OnUnsupportedSchema = z.enum(["degrade", "fail"]).default("degrade");

/**
 * Static per-provider capability map. MUST stay in sync with each adapter's
 * `traits.steerModes` (step-3) — asserted by a test, not by convention.
 */
export const PROVIDER_STEER_CAPABILITIES: Record<HarnessProvider, SteerMode[]> = {
  "pi":             ["steer", "queue"],
  "claude-managed": ["steer", "queue"],
  "devin":          ["steer", "queue"],   // narrow to ["queue"] if step-7's `working`-state finding says so
  "opencode":       ["steer", "queue"],   // steer is lossy (abort+prompt)
  "claude":         ["queue"],            // decision 13
  "codex":          [],                   // decision 4 — always promoted
};
```

Add a comment stating the CHECK-sync obligation for `mode`/`status`/`createdByKind` (mirroring the note at `:509-511`).

#### 3. DB helpers — the full set
**File**: `src/be/db.ts`
**Changes**: New `// ===...===\n// Task Steering Messages\n// ===...===` section placed after the Task Attachments section (~`:2922`). Add a private `TaskSteeringMessageRow` type + `rowToSteeringMessage(row)` mapper (snake_case → camelCase), following `rowToAgentTask` (`:1259-1349`). Ship **all** of these, even those with no caller yet:

- `createSteeringMessage(args): SteeringMessage`
- `getSteeringMessagesForTask(taskId, opts?: { status? }): SteeringMessage[]` — UI + preamble read side
- `getPendingSteeringForTask(taskId): SteeringMessage[]` — worker delivery read side
- `getPendingSteeringForAgent(agentId): SteeringMessage[]` — agent-scoped worker poll (mirrors `getRecentlyCancelledTasksForAgent` at `:2880-2892`)
- `markSteeringDelivered(id, deliveredMode: SteerMode): SteeringMessage | null`
- `markSteeringHandled(id): SteeringMessage | null` — consumed by step-3's `accept-steer`
- `markSteeringPromoted(id, promotedTaskId): SteeringMessage | null` — consumed by step-2
- `cancelPendingSteeringForTask(taskId): number`
- `hasPendingSteering(taskId): boolean` — consumed by step-2's heartbeat guard
- `getLatestLeadTaskInThread(channelId, threadTs): AgentTask | null` — **new**, consumed by step-10. Joins `agent_tasks.agentId → agents.isLead` (`source='slack'`, `ORDER BY createdAt DESC, rowid DESC LIMIT 1`). None of the three existing thread lookups (`:2315-2330`, `:2336-2350`, `:2357-2368`) filter on lead-ness — see root.md "Current State Analysis".

Follow the `cancelTask` pattern (`:2551-2608`): prepared-statement getters, then telemetry / `createLogEntry` side effects in `try/catch` **after** the mutation.

Also emit a `createLogEntry({ eventType: "task_steering", ... })` on create and on delivery so steering shows up in the task activity feed.

#### 4. Core steering service
**File**: `src/be/steering.ts` (new)
**Changes**: `requestSteering(args): SteerResult` — the single write path all four surfaces call. Responsibilities:

1. Load the task; 404 if missing.
2. **Paused → auto-start** (decision 9): if `status === "paused"`, resume it before proceeding.
3. Resolve the target's provider (from the assigned agent's `harnessProvider`). **If `onUnsupported === "fail"`** and the requested `mode` is not in `PROVIDER_STEER_CAPABILITIES[provider]`, return **422** naming the provider and its supported modes — **no row is created** (decision 16). Otherwise compute the **effective mode** via the degradation ladder:
   - `codex` → always `promoted` (decision 4): create a follow-up task immediately, return `{ outcome: "promoted", promotedTaskId }`.
   - `claude` + requested `steer` → downgrade to `queue` (decision 13).
   - task not `in_progress` (and not resumable) → `promoted`.
   - otherwise → row created `pending` with the requested mode; the runner reports the real outcome later.
4. `scrubSecrets` (`src/utils/secret-scrubber.ts`) the body **before** any logging.
5. Return `{ outcome, steeringMessageId?, promotedTaskId?, effectiveMode, degradedFrom? }` so every caller can render what actually happened (decision 14).

The promotion helper (`promoteSteeringToTask`) lives in step-2 — export a small internal seam here (e.g. an injected callback or a thin function step-2 fills in) so this step ships with a working codex path. **Simplest**: implement `promoteSteeringToTask` here using `createTaskExtended` directly, and let step-2 extend it to the terminal-status sweep.

#### 5. RBAC verbs
**Files**: `src/rbac/permissions.ts`, `src/rbac/legacy-policy.ts`
**Changes**: Mirror the `task.cancel.*` entries exactly.

```ts
// permissions.ts — alongside :44-47
"task.steer.own": { description: "Steer a task the principal requested.", namespace: "task" },
"task.steer.any": { description: "Steer any task (beyond tasks the caller created).", namespace: "task" },

// legacy-policy.ts — alongside :149-153
"task.steer.any": leadOrTaskCreator,
"task.steer.own": requesterOwnsTask,
```

`LEGACY_POLICY` is an exhaustive `satisfies Record<PermissionVerb, LegacyRule>` — omitting either entry is a compile error.

#### 6. HTTP routes
**File**: `src/http/tasks.ts` (already side-effect-imported at `src/http/all-routes.ts:55` — no new import needed)
**Changes**: Three `route()` definitions + handlers in the existing dispatch loop (`:515-601`).

```ts
const steerTaskRoute = route({
  method: "post",
  path: "/api/tasks/{id}/steer",
  pattern: ["api", "tasks", null, "steer"],
  summary: "Deliver a steering message to a running task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({
    message: z.string().min(1),
    mode: SteerModeSchema.default("queue"),         // decision 14 — default queue
    onUnsupported: OnUnsupportedSchema,             // decision 16 — default "degrade"
    requestedByUserId: z.string().optional(),
  }),
  rbac: { permission: "task.steer.own" },           // inline — NOT the ROUTE_RBAC_BACKLOG
  responses: {
    200: { description: "Steering accepted (see `outcome` for what actually happened)" },
    400: {...}, 403: {...}, 404: {...},
    422: { description: "Requested mode unsupported by the target harness and onUnsupported=fail" },
  },
});
```

Note the neighbouring `cancelTaskRoute` (`:149-161`) has **no** `rbac:` — it is grandfathered in `ROUTE_RBAC_BACKLOG` (`scripts/check-rbac-coverage.ts:306`). Do **not** copy that; new routes declare `rbac:` inline (pattern: `src/http/config.ts:195`).

Also add:
- `GET /api/tasks/{id}/steering-messages` — UI read side, returns `{ messages: SteeringMessage[] }`.
- `GET /api/steering-messages?taskId=` — worker read side. Model auth on `GET /cancelled-tasks` (`src/http/core.ts:354-406`): require `X-Agent-ID`, scope to that agent, optional `taskId` narrowing, envelope `{ messages: [...] }`. Unlike `/cancelled-tasks`, use the `route()` factory so it lands in OpenAPI.

#### 7. Derived fields on task reads
**Files**: `src/http/tasks.ts` (+ the session detail response)
**Changes**: Add two derived fields to the task detail and session responses:

- **`isLeadTask: boolean`** — resolved from the assigned agent's `isLead`. The UI has no `isLead` on its `AgentTask` type (`apps/ui/src/api/types.ts:128-172`) and lead-ness is only resolved in application code today (`src/slack/router.ts:81`). Decisions 5 and 6 both need it; step-9 and step-10 consume it.
- **`supportedSteerModes: SteerMode[]`** — `PROVIDER_STEER_CAPABILITIES[task's provider]` (decision 16). Lets step-9's toggle disable/annotate Interrupt on `claude`/`codex` **before** the user picks it, instead of offering a control that silently does something else.

### Success Criteria:

#### Automated Verification:
- [ ] Typecheck passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] Unit tests pass: `bun test src/tests/steering-core.test.ts` (new — cover: row lifecycle transitions, the codex→promoted ladder, claude steer→queue downgrade, paused auto-start, `getLatestLeadTaskInThread` returning only lead-assigned tasks, secret scrubbing of the body, **`onUnsupported:"fail"` returns 422 and creates no row**, `onUnsupported` defaults to `"degrade"` when omitted, and `supportedSteerModes` on a task read matches `PROVIDER_STEER_CAPABILITIES`)
- [ ] Full suite green: `bun test`
- [ ] DB boundary holds: `bash scripts/check-db-boundary.sh`
- [ ] RBAC coverage passes with the new verbs and **no** backlog entry: `bun run check:rbac-coverage`
- [ ] OpenAPI regenerated and committed: `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference/`
- [ ] Fresh DB boots and creates the table: `rm -f agent-swarm-db.sqlite* && bun run start:http` then `sqlite3 agent-swarm-db.sqlite ".schema task_steering_messages"`
- [ ] Existing DB migrates cleanly: boot against a pre-existing DB, confirm `SELECT version FROM _migrations ORDER BY version DESC LIMIT 1` is `121`

#### Automated QA:
- [ ] Agent starts the API (`bun run start:http`), creates a task via `POST /api/tasks`, calls `POST /api/tasks/{id}/steer` with `{"message":"hi"}` (no `mode`) and shows the response defaults to `queue`
- [ ] Agent shows `GET /api/tasks/{id}/steering-messages` returns the row with `status:"pending"`
- [ ] Agent shows `GET /api/steering-messages?taskId=<id>` **without** `X-Agent-ID` returns 400, and **with** a valid agent id returns the row
- [ ] Agent demonstrates the codex ladder: steer a task assigned to a `harnessProvider: "codex"` agent → response `outcome:"promoted"` and `GET /api/tasks?parentTaskId=<id>` shows the new follow-up task
- [ ] Agent demonstrates RBAC denial: steer as a non-creator, non-lead principal with RBAC enabled → 403
- [ ] Agent demonstrates decision 16 on a claude-assigned task: `{"mode":"steer"}` → `200 outcome:"queued"` with `degradedFrom:"steer"`, while `{"mode":"steer","onUnsupported":"fail"}` → `422` and `GET /api/tasks/{id}/steering-messages` shows **no** new row
- [ ] Agent shows `GET /api/tasks/{id}` returns `supportedSteerModes: ["queue"]` for a claude task and `[]` for a codex task

#### Manual Verification:
- [ ] Taras confirms the `task_steering_messages` column set and the `SteerOutcome` vocabulary are the shape he wants before 5 dependent steps build on them

**Implementation Note**: Vertical slice — the whole write/read API is usable via `curl` with no worker or UI. After completing, pause for manual confirmation, then commit `[step-1] core steering storage, service, HTTP routes and RBAC`.
