---
date: 2026-05-04T00:00:00Z
planner: Claude
branch: main
repository: agent-swarm
topic: "Wait Node for Workflow Engine"
tags: [plan, workflow, wait, scheduler, events]
status: completed
autonomy: critical
last_updated: 2026-05-04
last_updated_by: Claude (orchestrator)
---

# Wait Node for Workflow Engine Implementation Plan

## Overview

Add a new `wait` node type to the workflow engine supporting two modes:
1. **Wait for time** — pause workflow for a configurable duration (1ms → ∞)
2. **Wait for event** — pause workflow until a defined external event arrives

- **Motivation**: Workflows currently lack a primitive to pause execution without spinning up a long-running agent. Needed for time-gated steps (e.g. "wait 24h then check"), human-in-the-loop pauses, and signal-based fan-in (webhook, slack reply, GitHub event).
- **Related**: `runbooks/workflows.md`, `src/workflow/*` (TBD via research)

## Current State Analysis

The workflow engine lives in `src/workflows/`. It is an in-process DAG executor with an event-bus-driven resume mechanism — exactly the right shape for a wait node.

### Executor model

- **Registry**: `src/workflows/executors/registry.ts:61` — `createExecutorRegistry()` registers all node types. Adding a new node = a new `BaseExecutor` subclass plus one `registry.register(...)` line.
- **Base contract**: `src/workflows/executors/base.ts:36` — every executor has `type`, `mode: "instant" | "async"`, `configSchema`, `outputSchema`, and an `execute()` method.
- **Async result shape**: `src/workflows/executors/base.ts:28` — `{ async: true, waitFor: string, correlationId: string }`. Returning this puts the run into `waiting` state.
- **Engine async dispatch**: `src/workflows/engine.ts:541-545` — when `async` is set, the engine calls `checkpointStepWaiting(runId, stepId, ctx)` and returns `{ outcome: "waiting" }`.

### Existing node types (9 total — verified against `src/workflows/executors/registry.ts:64-75`)

- **7 instant**: `property-match`, `code-match`, `notify`, `raw-llm`, `script`, `vcs`, `validate`.
- **2 async**: `agent-task` (`src/workflows/executors/agent-task.ts`), `human-in-the-loop` (`src/workflows/executors/human-in-the-loop.ts`).
- **Pattern reference for "wait for event"**: HITL — creates an `approval_requests` row, returns `{async, waitFor: "approval.resolved", correlationId: requestId}`, has timeout via `expiresAt`, has output ports `approved/rejected/timeout`.
- **Pattern reference for "wait for time"**: `src/workflows/retry-poller.ts:24` — `startRetryPoller` ticks every 5s scanning `workflow_run_steps` rows where `nextRetryAt <= now`; this is the existing template for time-driven wakeup.

### Pause/resume infrastructure

- **Event bus**: `src/workflows/event-bus.ts:29` — `workflowEventBus` is a singleton in-process `EventEmitter`. Events: `task.completed`, `task.failed`, `task.cancelled`, `approval.resolved`.
- **Resume listener**: `src/workflows/resume.ts:38` — `setupWorkflowResumeListener` subscribes the listed events, looks up the step, checkpoints with output, calls `walkGraph` from successors.
- **Crash recovery on startup**: `src/workflows/recovery.ts:27` — `recoverIncompleteRuns` re-walks `running` runs, scans `getStuckWorkflowRuns()` for completed-while-down agent tasks, and `recoverApprovalWaitingRuns()` auto-rejects approvals where `expiresAt < now`.

### Persistence

- **`workflow_runs`**: status (`pending|running|waiting|completed|failed|cancelled`), `context` JSONB.
- **`workflow_run_steps`**: status (`pending|running|waiting|completed|failed|cancelled`), `nodeType`, `output`, `idempotencyKey`, `retryCount`, `nextRetryAt`. The poller already scans `nextRetryAt`.
- **`approval_requests`** (`src/be/migrations/020_approval_requests.sql`): side table for HITL with `expiresAt` index `WHERE status = 'pending'` — direct precedent for the side-table approach.

### Event sources (for `wait-for-event`)

Existing webhook receivers / lifecycle events that could be event-mode sources:

- **Webhook routes** live in the consolidated handler `src/http/webhooks.ts` (routes `api/github/webhook`, `api/gitlab/webhook`, `api/agentmail/webhook`). GitHub and GitLab handlers ALREADY emit on `workflowEventBus` today: `github.pull_request.<action>` (`src/http/webhooks.ts:177`), `github.issue.<action>` (`:192`), `github.issue_comment.created` (`:202`), `github.pull_request_review.submitted` (`:211`), `gitlab.merge_request.<action>` (`:294`), `gitlab.issue.<action>` (`:308`), `gitlab.note.created` (`:318`), `gitlab.pipeline.<status>` (`:327`). AgentMail also emits `agentmail.message.received` from `src/agentmail/handlers.ts:168`.
- **NOT yet on the bus**: Slack (`src/slack/`), Linear/Jira webhooks (handlers under `src/linear/`, `src/jira/` plus `src/http/trackers/{linear,jira}.ts`), Sentry, Stripe, Claude-managed callbacks. Each is a one-line `workflowEventBus.emit(...)` follow-up per source.
- **Built-in task lifecycle on the bus** (already): `task.created`, `task.completed`, `task.failed`, `task.cancelled`, `task.progress`, `task.budget_refused` — all emitted from `src/be/db.ts`. `approval.resolved` is emitted from `src/http/approval-requests.ts:183` when a HITL request is resolved.
- **DB-level events**: `agent_task_events` table also records task status changes (separate from bus events).
- **Manual triggers**: no current "external signal this run" endpoint.

### What's missing (gap analysis)

1. **No `wait` executor type** — confirmed nothing matches `wait|sleep|delay|pause` in `src/workflows/executors/`.
2. **No generic event-correlation table** — if `wait-for-event` needs to listen for non-task, non-approval signals, there's no infra to subscribe to a webhook-derived event by name.
3. **5-second poll resolution** — the retry poller's tick interval is the floor for DB-driven wakeup. Sub-second waits need a different mechanism (in-process `setTimeout` is the natural fit, with DB persistence as backstop for restart).
4. **No "external signal" endpoint** — to emit a custom event into a paused run, callers would need a new API like `POST /api/workflow-runs/:runId/events`.

## Desired End State

A new `wait` async executor is registered. Workflow authors can:

```yaml
# Time mode — single port "default" → single target (matches WorkflowNodeSchema.next: Record<string,string>)
- id: cool-down
  type: wait
  config: { mode: time, durationMs: 86400000 }    # 24h
  next: { default: downstream-node }              # or simply: next: downstream-node

# Event mode — declarative filter (object: flat / dot-path equality).
# Port-routed `next` is Record<string,string> — one target per port.
# To fan out from a port, point at an intermediate node whose `next: [a, b]` does the fan-out.
- id: pr-merged
  type: wait
  config:
    mode: event
    eventName: github.pull_request.merged
    filter: { number: "{{trigger.pr.number}}" }
    timeoutMs: 86400000                            # 24h
  next:
    event:   downstream-on-event
    timeout: downstream-on-timeout

# Event mode — JS-function filter (string: arrow-fn body, returns boolean)
- id: tagged-merge
  type: wait
  config:
    mode: event
    eventName: github.pull_request.merged
    filter: "(payload) => payload.labels.some(l => l.name === 'release') && payload.number > 1000"
    timeoutMs: 3600000                             # 1h
  next:
    event:   release-pipeline
    timeout: give-up
```

Effective resolution: ~5s (driven by the existing 5s retry-poller cadence). Upper bound: unlimited (`durationMs` or `expiresAt` may be far-future or omitted entirely).

External callers can fire arbitrary events via `POST /api/workflow-runs/:runId/events` (run-scoped) or `POST /api/workflow-events` (global broadcast). Built-in adapters in webhook handlers also fire events automatically (Phase 4 wires the first one — agent-task lifecycle — and the rest become follow-ups).

State survives API restart: paused waits are recovered on boot, expired waits auto-fire `timeout`, fired-while-down events are reapplied.

## What We're NOT Doing

- **Sub-5s waits**: out of scope per user decision. The 1ms theoretical minimum becomes ~5s effective minimum (documented). If needed later, a dedicated short-interval poller is a follow-up plan.
- **Cron / recurring schedules**: this node fires once. Recurrence belongs to workflow triggers, not nodes.
- **Persistent durable queue**: events are best-effort to in-memory listeners + a DB scan at startup; we are not adding Kafka/Redis/etc.
- **Per-event-source rich adapters in this plan**: only the agent-task lifecycle adapter is shipped. Slack/GitHub/Linear/Jira/Sentry adapters are explicit follow-up plans.
- **UI / dashboard surface**: the `new-ui/` integration for visualizing paused waits is a follow-up.
- **Templates UI exposure**: not in scope.
- **Multi-instance API replicas**: `workflowEventBus` is an in-process `EventEmitter` (`src/workflows/event-bus.ts:9`). With multiple API replicas, a signal emitted on instance A would not reach a wait paused on instance B. Single-instance only for v1; cross-instance fan-out (Redis pub/sub, etc.) is a separate plan.

## Implementation Approach

- **Mirror the HITL pattern end-to-end.** HITL is the closest existing precedent: async executor, side table with `expiresAt`, output ports, recovery branch. We clone it.
- **One new async executor `WaitExecutor`**, discriminated config (`mode: "time" | "event"`), in `src/workflows/executors/wait.ts`, registered in `src/workflows/executors/registry.ts:75`.
- **One new side table `wait_states`** with columns: `id`, `workflowRunId`, `workflowRunStepId`, `mode`, `wakeUpAt` (time mode), `eventName` + `eventFilter` (event mode), `expiresAt` (event-mode timeout), `status` (`pending|fired|timeout`), `firedPayload` (event-mode result), timestamps.
- **Time mode** uses the existing 5s retry-poller pattern — a new `wait-poller.ts` scans `wait_states WHERE status='pending' AND wakeUpAt <= now` and calls `resumeWaitState(id, "fired", undefined, registry)` directly (no bus re-emission).
- **Event mode rides the existing `workflowEventBus`** — no parallel pub/sub. The wait listener subscribes to **any** event name configured on the wait_state. Built-in event names (`task.completed`, `task.failed`, `task.cancelled`, `approval.resolved`) are already emitted today in `src/be/db.ts` and `src/workflows/resume.ts` — wait nodes get them for free. New `workflowEventBus` events from external sources flow in via two thin HTTP endpoints:
  - `POST /api/workflow-runs/:runId/events` — run-scoped signal: emits `eventBus.emit(name, { ...payload, runId })`.
  - `POST /api/workflow-events` — global broadcast: emits `eventBus.emit(name, payload)`.
  - Filter: dual-form. Either an **object** (flat key/dot-path deep-equal — declarative, lowest learning curve) or a **string** (arrow-fn body evaluated in a sandbox, returning boolean — escape hatch for complex predicates). Reuses the same sandbox pattern as `src/workflows/executors/code-match.ts:50` (shadow dangerous globals via `new Function`). JSONLogic / JMESPath is overkill for v1.
  - On match, the wait listener atomically updates `wait_states` to `status='fired'` and continues the graph walk. No `wait.fired` re-emission needed; the bus event itself is the signal.
- **Timeout in event mode** uses `expiresAt`. Same poller scan also picks up `WHERE status='pending' AND expiresAt <= now` and calls `resumeWaitState(id, "timeout", undefined, registry)`.
- **Output ports**: time mode → `default`. Event mode without timeout → `event`. Event mode with timeout → `event` | `timeout`.
- **Recovery** adds a sibling to `recoverApprovalWaitingRuns`: `recoverWaitStates` scans for already-fired (manual signal arrived while down — unlikely but possible if the API persisted but failed to emit) and expired waits.
- **No "built-in adapter" code is needed for agent-task lifecycle or GitHub/GitLab events** — `task.completed` / `task.failed` / `task.cancelled` (and friends from `src/be/db.ts`), `approval.resolved` (`src/http/approval-requests.ts:183`), `agentmail.message.received`, and the `github.*` / `gitlab.*` events from `src/http/webhooks.ts` are already on the bus today and become valid event names a wait node can subscribe to. Phase 4 collapses into documentation + a fan-out e2e verification test. Slack/Linear/Jira/Sentry/Stripe/Claude-managed callbacks are NOT on the bus today; bringing each in is a one-line `workflowEventBus.emit(...)` in the relevant handler — covered as explicit follow-up plans.
- **Sequence rationale**: schema → time mode (smallest, proves engine integration) → event mode primitives → first built-in adapter. Each phase is end-to-end demoable.

## Quick Verification Reference

- Type check: `bun run tsc:check`
- Lint: `bun run lint`
- Tests: `bun test`
- Server: `bun run start:http`
- Workflow runbook: `runbooks/workflows.md`

---

## Phase 1: Schema, types, and DB queries

### Overview

A new migration creates `wait_states` and exposes typed CRUD/scan queries. No executor yet — this phase is pure data layer.

### Changes Required:

#### 1. New migration

**File**: `src/be/migrations/049_wait_states.sql` (highest existing on `main` at plan time is `048_agent_provider.sql`; re-verify with `ls src/be/migrations/` at implementation time in case other PRs land first)
**Changes**: Create `wait_states` table mirroring `approval_requests`:

```sql
CREATE TABLE IF NOT EXISTS wait_states (
  id TEXT PRIMARY KEY,
  workflowRunId TEXT NOT NULL,
  workflowRunStepId TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('time', 'event')),
  wakeUpAt DATETIME,                       -- mode='time'; NULL for event mode
  eventName TEXT,                          -- mode='event'
  eventFilter JSONB,                       -- mode='event'; flat key/val match
  expiresAt DATETIME,                      -- mode='event' optional timeout
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'fired', 'timeout')),
  firedPayload JSONB,                      -- payload that satisfied an event wait
  resolvedAt DATETIME,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wait_states_step ON wait_states(workflowRunStepId);
CREATE INDEX IF NOT EXISTS idx_wait_states_run ON wait_states(workflowRunId);
CREATE INDEX IF NOT EXISTS idx_wait_states_wake ON wait_states(wakeUpAt) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_wait_states_expire ON wait_states(expiresAt) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_wait_states_event ON wait_states(eventName) WHERE status = 'pending';
```

#### 2. DB queries

**File**: `src/be/db.ts`
**Changes**: Add (paths anchored to existing approval-request helpers as the model):

- `createWaitState(input)` — insert.
- `getWaitStateByStepId(stepId)` — idempotency lookup (mirror `getApprovalRequestByStepId`).
- `getDueWaitStates()` — `SELECT … WHERE status='pending' AND ((mode='time' AND wakeUpAt <= now) OR (mode='event' AND expiresAt IS NOT NULL AND expiresAt <= now))`.
- `getPendingWaitsByEvent(name, runId?)` — for signal lookup. `runId` optional (run-scoped vs global).
- `resolveWaitState(id, { status, firedPayload? })` — atomic state transition (returns `{updated: boolean}` for race-safety).
- `getStuckWaitRuns()` — analog of `getStuckWorkflowRuns` for recovery. JOINs `workflow_runs` (waiting) → `workflow_run_steps` (waiting, nodeType='wait') → `wait_states`. Returns rows in either of two stuck states: (a) `wait_states.status ≠ 'pending'` (signal arrived/timeout fired while down — needs explicit resume since the bus event was lost), or (b) `wait_states.status = 'pending'` AND (`wakeUpAt <= now` OR `expiresAt <= now`) (overdue — would also be picked up by the poller's first tick, but explicit recovery avoids the up-to-5s startup latency window).

#### 3. Types

**File**: `src/types.ts`
**Changes**: Add `WaitMode = "time" | "event"`, `WaitStateStatus`, `WaitStateRow` Zod schemas matching the SQL CHECK constraints (per project convention — keep in sync with migration).

### Success Criteria:

#### Automated Verification:
- [x] Type check: `bun run tsc:check`
- [x] Lint: `bun run lint`
- [x] DB-boundary check: `bash scripts/check-db-boundary.sh`
- [x] New migration applies cleanly to a fresh DB: `rm agent-swarm-db.sqlite && bun run start:http` (server boots without error; `wait_states` table exists)
- [x] New migration applies to an existing DB: `bun run start:http` against a pre-existing DB shows no migration errors
- [x] Unit test: `bun test src/tests/workflow-wait-state-queries.test.ts` (new file) — covers create / get-by-step / get-due / resolve race-safety / get-stuck

#### Automated QA:
- [x] Sub-agent: open a SQLite shell on a freshly-bootstrapped DB and verify the schema matches the migration (tables + indexes)

#### Manual Verification:
- [ ] Confirm the chosen migration number doesn't collide with anything in flight on `main`

**Implementation Note**: After this phase, pause for manual confirmation. Commit-per-phase: `[phase 1] add wait_states table and DB queries`.

---

## Phase 2: WaitExecutor — time mode end-to-end

### Overview

A `wait` node with `mode: "time"` pauses a workflow for a configurable duration and resumes via the existing 5s poller cadence. This phase delivers a fully-working time-based wait — demoable end-to-end.

### Changes Required:

#### 1. WaitExecutor

**File**: `src/workflows/executors/wait.ts` (new)
**Changes**: New `WaitExecutor extends BaseExecutor` with:
- `type = "wait"`, `mode = "async"`.
- `configSchema`: discriminated union on `mode`. Time variant: `{ mode: "time", durationMs: number().int().min(1) }` — note `min(1)` honours the 1ms input grammar even though effective resolution is ~5s.
- `outputSchema`: `{ waitId, mode, firedAt, payload? }`.
- `execute`:
  1. Idempotency: `getWaitStateByStepId(meta.stepId)` — if exists and resolved, return `{ status: "success", output, nextPort: "default" }`; if pending, return the async marker.
  2. Insert `wait_states` row with `wakeUpAt = now + durationMs`.
  3. Return `{ status: "success", async: true, waitFor: "wait.fired", correlationId: waitId } as unknown as ExecutorResult<WaitOutput>`. Mirror HITL's exact pattern at `src/workflows/executors/human-in-the-loop.ts:131-138,161-166` — `AsyncExecutorResult` extends `ExecutorResult` so `status` is required, and the type assertion is needed because `output` is absent on the async marker. `waitFor` is informational only (engine doesn't dispatch on it for waits — resume happens via the poller and bus listeners directly).

#### 2. Registry

**File**: `src/workflows/executors/registry.ts`
**Changes**: Import + `registry.register(new WaitExecutor(deps))` after the existing async executors (line 75 area). Update `src/workflows/executors/index.ts` to re-export.

#### 3. Resumption helper

**File**: `src/workflows/resume.ts`
**Changes**: Add `export async function resumeWaitState(waitId, status: "fired"|"timeout", payload?, registry)`:
1. Atomically `resolveWaitState(waitId, { status, firedPayload: payload })` — returns `{updated: boolean}`. Race-safe: only the first caller advances; concurrent callers see `updated: false` and return.
2. Load `wait_state`, `workflow_run_step`, `workflow_run`. Bail if step is no longer `waiting`.
3. Decide port: time mode → `default`; event mode + status=fired → `event`; event mode + status=timeout → `timeout`.
4. Call `checkpointStep` with `{ output: { waitId, status, payload }, nextPort: port }`, set run back to `running`.
5. `walkGraph` from `getSuccessors(definition, step.nodeId, port)`.

This is the single resume entry point shared by the poller (Phase 2) and the bus listener (Phase 3). No `wait.fired` / `wait.timeout` bus events — internal function call only.

#### 4. Wakeup poller

**File**: `src/workflows/wait-poller.ts` (new)
**Changes**: Tick every 5s (use the same default as retry-poller), call `getDueWaitStates()`, for each:
- If `wakeUpAt <= now`: call `resumeWaitState(id, "fired", undefined, registry)`.
- If `expiresAt <= now` (event-mode timeout): call `resumeWaitState(id, "timeout", undefined, registry)`.

Wire `startWaitPoller(registry)` from `src/workflows/index.ts:43-61` (`initWorkflows`). Add `stopWaitPoller()` for clean shutdown.

#### 5. Recovery branch

**File**: `src/workflows/recovery.ts`
**Changes**: Add `recoverWaitStates(registry)` called from `recoverIncompleteRuns`. Scans `getStuckWaitRuns()`, for any rows already past `wakeUpAt` resumes via the same code path the poller would.

### Success Criteria:

#### Automated Verification:
- [x] Type check: `bun run tsc:check`
- [x] Lint: `bun run lint`
- [x] All workflow tests pass: `bun test src/tests/workflow-*.test.ts`
- [x] New unit test: `bun test src/tests/workflow-wait-time.test.ts` — exercises a full workflow with a time-wait node, asserts step transitions `pending → waiting → completed`, asserts run finishes after `wakeUpAt + poll-tick`
- [x] Recovery test: `bun test src/tests/workflow-wait-recovery.test.ts` — simulate a "server died while waiting" scenario by inserting a `wait_states` row with `wakeUpAt` in the past, call `recoverIncompleteRuns`, assert run completes

#### Automated QA:
- [x] Sub-agent walkthrough: start `bun run dev:http`, create a workflow definition with a 10s `wait` node via `create-workflow` MCP tool (or direct HTTP), trigger it, observe via `get-workflow-run` that step is `waiting` for ~10s, then `completed`. Capture timestamps. — verified live 2026-05-04, evidence in `thoughts/taras/qa/2026-05-04-wait-node-workflow-engine.md` § A
- [x] Long-wait persistence: create a wait of 60s, restart the API server mid-wait (`bun run pm2-restart`), confirm the run still completes after the original `wakeUpAt`. — verified live 2026-05-05 against a throwaway server on `:3517` with `kill -9` mid-wait; recovery resumed past the original `wakeUpAt`. Evidence in `thoughts/taras/qa/2026-05-04-wait-node-workflow-engine.md` § E. Also covered deterministically by `src/tests/workflow-wait-recovery.test.ts`

#### Manual Verification:
- [ ] Confirm 5s poller cadence is acceptable for the demo durations (no surprise drift)

**Implementation Note**: After this phase, pause for manual confirmation. Commit-per-phase: `[phase 2] add wait node — time mode`.

---

## Phase 3: WaitExecutor — event mode + signal API

### Overview

Extends the wait node with `mode: "event"`, ships the two HTTP endpoints for external signalling, the filter matcher, and the timeout handler. After this phase, workflows can pause for arbitrary external events with optional timeout and routed output ports.

### Changes Required:

#### 1. WaitExecutor — event variant

**File**: `src/workflows/executors/wait.ts`
**Changes**: Extend `configSchema` discriminated union (Zod 4 form):
```ts
configSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("time"), durationMs: z.number().int().min(1).max(31_536_000_000) /* 1y ceiling */ }),
  z.object({
    mode: z.literal("event"),
    eventName: z.string().min(1),
    filter: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
    scope: z.enum(["run", "global"]).default("run"),
    timeoutMs: z.number().int().min(1).max(31_536_000_000).optional(),
  }),
]);
```
Insert `wait_states` row with `eventName`, `eventFilter`, `expiresAt = now + timeoutMs` (or NULL).

**`scope` semantics** (the listener enforces this — without it the field is dead config):
- `scope: "run"` (default): the wait listener only matches if `payload._runId === waitState.workflowRunId`. The run-scoped HTTP endpoint (Step 3 below) injects `_runId` into the payload; built-in events emitted from `src/be/db.ts` already include `workflowRunId` (use that field name as the equivalent) — the matcher accepts either `_runId` or `workflowRunId` and compares against `waitState.workflowRunId`.
- `scope: "global"`: skip the run-id check — any payload satisfying the filter resolves the wait. Use for cross-run signals (e.g., a `release.cut` broadcast).

#### 2. Filter matcher

**File**: `src/workflows/wait-filter.ts` (new)
**Changes**: `matchesFilter(payload, filter)` accepts two shapes — discriminated by `typeof`:

- **Object form** — flat key-path equality on the filter object. Each filter key may use dot-paths (`pr.number`); each value compared with deep equal (numbers/strings/booleans/arrays). Lowest learning curve, declarative, no eval risk.
- **String form** — JS arrow-function body, e.g. `"(payload) => payload.labels.some(l => l.name === 'release')"`. Evaluated via `new Function(...SANDBOX_KEYS, "payload", \`"use strict"; return (${filter})(payload);\`)` reusing the shadow-globals list from `src/workflows/executors/code-match.ts:19-30` (`require`, `process`, `Bun`, `globalThis`, `global`, `fetch`, `setTimeout`, `setInterval` all shadowed to `undefined`). Catches `throw` and treats as no-match. Result must be coerced to boolean (`!!`).

No filter ⇒ matches anything. Zod schema for the filter field: `z.union([z.record(z.string(), z.unknown()), z.string()]).optional()`.

**Hardening for the string form** (must hold before merge):
- Wrap `fn(...)` execution in a hard timeout (e.g. 50ms) to defang infinite loops or pathological regex. Bun's `Bun.deadline()` or a watchdog on a worker thread; out-of-band kill is fine since the result is "no-match" on timeout.
- Cap filter source string length at 2KB at the Zod boundary — defense against giant payload-stuffed scripts that survive the sandbox just by being huge.
- Reject any string filter that fails to produce an arrow-function expression (`(${filter})` parse fail) at executor-init time, not at first event — surfaces bad workflows early.
- Even though `import` is keyword-blocked by `"use strict"`, also block `eval`, `Function`, and `AsyncFunction` by adding them to `SANDBOX_KEYS`. The `code-match` precedent at `src/workflows/executors/code-match.ts:19-28` does NOT shadow these — wait-filter should, because filter strings are higher-volume and authored by less-trusted workflow authors than code-match scripts.

#### 3. Wait event listener + HTTP endpoints

**File**: `src/workflows/resume.ts` (extend) + `src/http/workflow-events.ts` (new)
**Changes**:
- **Bus subscription is dynamic.** On startup (`initWorkflows`), scan `wait_states WHERE status='pending' AND eventName IS NOT NULL`, build a `Map<eventName, Set<waitId>>`, and register one `eventBus.on(eventName, …)` per distinct name. As new event-mode waits are created, `WaitExecutor.execute` calls a helper `subscribeWaitToBus(waitId, eventName)` that registers the listener if not already present and adds to the set. On resolution, remove from the set; if the set becomes empty, `eventBus.off(eventName, …)`.
- **Listener-cap note**: `InProcessEventBus` calls `setMaxListeners(100)` (`src/workflows/event-bus.ts:13`). One listener per distinct `eventName` keeps us well under that ceiling for normal use, but if a deployment routinely has >100 distinct event names with concurrent waits, raise the cap inside `InProcessEventBus` (e.g., `setMaxListeners(1000)`).
- **Payload size**: webhook payloads (e.g., GitHub PR events) can be 50KB+. `firedPayload` stores the raw payload that satisfied the filter — cap at 64KB at the DB-write boundary (truncate + add a `truncated: true` marker), or project only the fields named in `filter`. Pick truncate-with-marker for v1; revisit if downstream nodes need the full payload.
- **Bus handler logic**: when an event fires, iterate the set, look up each `wait_state`, apply `matchesFilter(payload, filter)`, and on match call `resumeWaitState(id, "fired", payload, registry)` (the helper added in Phase 2). Race-safety lives inside `resumeWaitState`'s atomic `resolveWaitState` step.
- **HTTP endpoints**, both via `route()` factory:
  - `POST /api/workflow-runs/:runId/events` body `{name, payload}` → `workflowEventBus.emit(name, { ...payload, _runId: runId })`. Listener filters by `_runId` when configured.
  - `POST /api/workflow-events` body `{name, payload}` → `workflowEventBus.emit(name, payload)`.
  - Both auth via standard `Authorization: Bearer ${API_KEY}`.
- Add both to `scripts/generate-openapi.ts` imports per the project rule, then `bun run docs:openapi`.

#### 4. Timeout handling

**File**: `src/workflows/wait-poller.ts` (already extended in Phase 2 step 4), `src/workflows/recovery.ts`
**Changes**: Recovery's `recoverWaitStates` (added in Phase 2) calls `resumeWaitState(..., "timeout", ...)` for any `wait_states WHERE status='pending' AND expiresAt <= now` discovered at startup. Verify port routing lands on `timeout`.

### Success Criteria:

#### Automated Verification:
- [x] Type check: `bun run tsc:check`
- [x] Lint: `bun run lint`
- [x] Unit test: `bun test src/tests/workflow-wait-filter.test.ts` — must cover ALL of:
  - **(a) Object form** — exact equality, dot-path nested keys (`pr.number`), array equality (deep), missing keys → no-match, type-mismatch (string vs number) → no-match, no-filter → match-everything, multiple keys must all match.
  - **(b) String form — happy path** — arrow-fn evaluates correctly, returns boolean directly, returns truthy non-boolean (coerced via `!!`), throws → no-match, undefined return → no-match.
  - **(c) String form — sandbox penetration** (each is its own test case, must all return no-match without throwing into caller):
    - Direct global access: `(p) => process.env.PATH`, `(p) => require('fs')`, `(p) => globalThis.fetch`, `(p) => Bun.version`, `(p) => global.process`.
    - Indirect global access via constructor chain: `(p) => p.constructor.constructor('return process')()` (the classic VM-escape via `Function` constructor — must be blocked by adding `Function` and `AsyncFunction` to `SANDBOX_KEYS`).
    - `eval` reflection: `(p) => eval('process.env')`.
    - Async escape: `(p) => (async () => process.env)()`.
    - DoS via infinite loop: `(p) => { while(true){} }` — must terminate within the 50ms timeout and resolve to no-match.
    - DoS via pathological regex (catastrophic backtracking): `(p) => /^(a+)+$/.test('a'.repeat(30) + 'X')` — must terminate within timeout.
    - Side-effect attempts: `(p) => { p.injected = true; return true }` — assert the original payload is structurally unchanged after the call (defensive copy or freeze).
  - **(d) Zod-boundary rejections** — filter string >2KB rejected at parse, filter string that isn't a valid arrow-fn expression rejected at executor init (not at first event).
  - **(e) `scope` enforcement** — run-scope rejects mismatched `_runId`/`workflowRunId`, global-scope ignores it; both forms tested with the same scope matrix.
- [x] Integration test: `bun test src/tests/workflow-wait-event.test.ts` — workflow with event-wait, fire signal via direct function call, assert run completes via `event` port
- [x] Timeout test: same file, with `timeout.seconds: 1`, fire poller manually (or wait), assert routing to `timeout` port
- [x] HTTP test: `bun test src/tests/workflow-wait-http.test.ts` — start server (or use existing test harness), POST to both endpoints, assert paused run completes
- [x] OpenAPI freshness: `bun run docs:openapi` then `git diff --exit-code openapi.json` — must be clean after regen

#### Automated QA:
- [x] Sub-agent walkthrough: create a workflow with an event-wait node + 30s timeout. Curl `POST /api/workflow-runs/<run-id>/events` with matching payload, observe completion via `event` port. Repeat with non-matching filter; observe timeout via `timeout` port. — verified live 2026-05-04, evidence in `thoughts/taras/qa/2026-05-04-wait-node-workflow-engine.md` §§ B, C

#### Manual Verification:
- [ ] Race scenario inspection: have two concurrent runs waiting on the same `eventName`, fire a global signal, confirm both fire and `firedPayload` is recorded on each row

**Implementation Note**: After this phase, pause for manual confirmation. Commit-per-phase: `[phase 3] add wait node — event mode + signal API`.

---

## Phase 4: End-to-end verification with existing bus events + docs

### Overview

The existing `workflowEventBus` already emits `task.completed`, `task.failed`, `task.cancelled`, `task.created`, `task.progress`, `task.budget_refused` (all from `src/be/db.ts`), `approval.resolved` (`src/http/approval-requests.ts:183`), `agentmail.message.received` (`src/agentmail/handlers.ts:168`), and the GitHub/GitLab webhook events listed in Current State Analysis. Phase 3's listener subscribes by configurable event name, so all of these are usable from a wait node without any new emit code. This phase is **verification + documentation only** — no new application logic.

**Important ordering note**: chaining a wait *directly* off the upstream that emits the awaited event (linear `agent-task → wait { eventName: task.completed }`) does NOT work — execution only reaches the wait *after* the upstream task completes, by which point the bus event has already been delivered to current listeners and no longer exists. The wait must subscribe BEFORE the event fires. The two valid patterns are: (a) **fan-out** — branch the wait off an earlier node so the wait registers concurrently with the work that will emit the event; or (b) **external signal** — wait for an event whose source is downstream/external (HTTP `POST` to the signal endpoints, a future webhook source, etc.). Slack, Linear, Jira, Sentry, Stripe, and Claude-managed callbacks are NOT on the bus today; bringing each in is a one-line `workflowEventBus.emit(...)` in the relevant handler — covered as explicit follow-up plans.

### Changes Required:

#### 1. Documentation

**File**: `runbooks/workflows.md`
**Changes**: Append a `## Wait nodes` section documenting:
- The two modes and config shape.
- Effective minimum (~5s) and unbounded maximum.
- Output ports (time → `default`; event → `event` / optional `timeout`).
- The two signal endpoints (`POST /api/workflow-runs/:runId/events`, `POST /api/workflow-events`).
- **Built-in event names available out-of-the-box** (no extra wiring needed): `task.completed`, `task.failed`, `task.cancelled`, `approval.resolved`. With payload shapes referencing `src/workflows/resume.ts:18-33`.
- Filter forms (object vs JS string) with a security note about sandbox shadowing.
- A "what's NOT yet on the bus" call-out: external webhooks (slack/github/etc.) require their handler to call `workflowEventBus.emit`; this is a one-line follow-up plan per source.

**File**: `MCP.md`
**Changes**: Add a one-line note under the workflows section pointing to the new node type.

#### 2. CLI / tooling exposure verification

**File**: `src/tools/workflows/create-workflow.ts`
**Changes**: No code change required — validation is purely Zod-driven via the executor registry. Confirm by adding a test that round-trips a wait-node-containing definition through `create-workflow`.

#### 3. End-to-end test against the existing bus

**File**: `src/tests/workflow-wait-builtin-events.test.ts` (new)
**Changes**: A **fan-out** workflow (NOT linear `agent-task → wait`, which would be ordering-broken — by the time execution reaches a chained wait node, the upstream's `task.completed` event has already fired and there's nothing left to listen for). Shape:

```
entry (script: emit two parallel branches)
  ├─ agent-task        # fires `task.completed` when it finishes
  └─ wait { eventName: "task.completed",
           filter: { workflowRunId: "{{trigger.runId}}" } }
                       # subscribes the moment the workflow starts
                       # → both branches converge at terminal node
```

Run it; complete the upstream `agent-task`; assert the wait resolves via the existing `task.completed` bus event (no new emit code added). The filter on `workflowRunId` is the key — the bus event emitted at `src/be/db.ts:1620` already includes `workflowRunId` in the payload, so the wait correlates without requiring an extra signal.

### Success Criteria:

#### Automated Verification:
- [x] Type check: `bun run tsc:check`
- [x] Lint: `bun run lint`
- [x] All tests: `bun test`
- [x] Built-in event integration test: `bun test src/tests/workflow-wait-builtin-events.test.ts` — passes with NO production-code changes outside of Phases 1–3
- [x] OpenAPI drift: `bun run docs:openapi` then `git diff --exit-code openapi.json docs-site/content/docs/api-reference` (defensive — fails the merge gate if any version bump or route touch slipped in past Phase 3)
- [x] `create-workflow` accepts a wait-node definition: round-trip test in suite

#### Automated QA:
- [x] Sub-agent walkthrough: define and run a 2-node workflow (`agent-task` → `wait` keyed on `task.completed` filtered by `taskId`). Capture run trace showing the wait fires when the upstream task completes — no manual signal POST required. — verified DEGRADED 2026-05-04 via `POST /api/workflow-events` signal injection (real agent-task spawn requires worker container); full fan-out flow covered by `src/tests/workflow-wait-builtin-events.test.ts`. Evidence in `thoughts/taras/qa/2026-05-04-wait-node-workflow-engine.md` § D

#### Manual Verification:
- [ ] Read the runbook update top-to-bottom; confirm a workflow author could write a wait node from the docs alone, including using built-in events

**Implementation Note**: After this phase, pause for manual confirmation. Commit-per-phase: `[phase 4] wait node — docs and built-in event verification`.

---

## Manual E2E

Real-world dry-run against a local server, anchored to `LOCAL_TESTING.md`-style commands:

```bash
# 0. Boot the API + UI (per CLAUDE.md)
bun run pm2-start
# or, for hot reload:
bun run dev:http

# 1. Create a workflow with a 30s time-wait
curl -X POST http://localhost:3013/api/workflows \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "wait-time-demo",
    "definition": {
      "nodes": [
        { "id": "w1", "type": "wait",
          "config": { "mode": "time", "durationMs": 30000 },
          "next": { "default": "done" } },
        { "id": "done", "type": "notify",
          "config": { "channel": "log", "message": "wait finished" } }
      ]
    }
  }'

# 2. Trigger it; capture <run-id>
curl -X POST http://localhost:3013/api/workflows/<workflow-id>/run \
  -H "Authorization: Bearer 123123"

# 3. Inspect: should be `waiting` for ~30s, then `completed`
curl http://localhost:3013/api/workflow-runs/<run-id> -H "Authorization: Bearer 123123"

# 4. Restart server during the wait — confirm it still completes
bun run pm2-restart

# 5. Event-mode test
curl -X POST http://localhost:3013/api/workflows -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" -d '{
    "name": "wait-event-demo",
    "definition": {
      "nodes": [
        { "id": "w1", "type": "wait",
          "config": { "mode": "event", "eventName": "demo.signal",
                      "filter": { "ok": true },
                      "timeoutMs": 60000 },
          "next": { "event": "yay", "timeout": "nay" } },
        { "id": "yay", "type": "notify", "config": { "message": "got it" } },
        { "id": "nay", "type": "notify", "config": { "message": "timed out" } }
      ]
    }
  }'

# 6. Trigger the event-wait, capture <run-id>, then fire the signal
curl -X POST http://localhost:3013/api/workflow-runs/<run-id>/events \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{ "name": "demo.signal", "payload": { "ok": true } }'
# → run advances via "event" port

# 7. Repeat without firing the signal; wait 60s; assert "timeout" port

# 8. Built-in adapter: workflow with agent-task → wait on agent-task.completed
#    Fire an agent-task that succeeds; observe wait release
```

Capture screenshots / trace JSON for each step into `thoughts/taras/qa/2026-05-04-wait-node-workflow-engine.md` if the QA Spec is generated.


## Appendix

- **Follow-up plans**:
  - **Built-in adapters for remaining sources**: Slack message, Linear issue events, Jira issue events, Sentry alerts, Stripe events, Claude-managed callbacks. Each adapter is a one-line `workflowEventBus.emit(name, payload)` call inside the relevant handler. (GitHub, GitLab, AgentMail, agent-task lifecycle, and `approval.resolved` are already emitting today.)
  - **Sub-second wait resolution**: dedicated short-interval poller or in-process `setTimeout` for waits under 5s. Only if a real use case appears.
  - **UI surface**: `new-ui/` view for paused waits (filter by run, by event name; manual fire button for ops).
  - **Templates UI**: expose wait nodes in the templates registry.

- **Derail notes**:
  - The user originally specified 1ms minimum but accepted the 5s effective floor in design Q&A. If sub-second waits become a need, reopen.
  - The filter matcher is intentionally minimal (flat key/dot-path equality). If complex predicates surface (range comparisons, OR groupings, regex), upgrade to JSONLogic — already vetted-friendly format.
  - `recoverWaitStates` doesn't currently auto-replay events that arrived while the API was down (no event-source persistence). The behaviour is "missed signals are missed unless the source retries". Document this.
  - `idempotencyKey` collision: confirm `${runId}:${nodeId}:${iteration}` semantics still hold for wait nodes inside loops (loops re-run nodes per iteration; wait should re-create state per iteration).

- **References**:
  - Runbook: `runbooks/workflows.md`
  - HITL precedent: `src/workflows/executors/human-in-the-loop.ts`, `src/be/migrations/020_approval_requests.sql`
  - Async executor contract: `src/workflows/executors/base.ts:28`
  - Engine async dispatch: `src/workflows/engine.ts:541-545`
  - Resume listener: `src/workflows/resume.ts:38`
  - Recovery: `src/workflows/recovery.ts:27`
  - Retry-poller pattern: `src/workflows/retry-poller.ts:24`
  - User constraints (original): 1ms minimum wait, no upper bound (5s effective floor agreed)

## Review Errata

_Reviewed: 2026-05-04 by Claude (auto-apply mode)_

All findings below were verified against the codebase before being applied.

### Applied — Critical

- [x] **Migration number collision** — original plan said `036_wait_states.sql`, but `036_memory_ttl_staleness.sql` already exists; highest existing on `main` is `048_agent_provider.sql`. Changed to `049_wait_states.sql`.
- [x] **`next` field shape mismatch** — `WorkflowNodeSchema.next` is `Record<string, string>` (one target per port), not `Record<string, string[]>`. Corrected all YAML examples in Desired End State and the JSON examples in Manual E2E. Added a comment noting that fan-out from a port requires an intermediate node.
- [x] **Phase 4 e2e demo logically broken** — `agent-task → wait { eventName: "task.completed" }` (linear) cannot work because the wait subscriber is only created AFTER the upstream's `task.completed` has already fired. Rewrote the test as a **fan-out** workflow (`entry → [agent-task, wait]`) so the wait registers concurrently with the work that emits the event. Added an explicit ordering note to the Phase 4 overview, and a wait-must-subscribe-first call-out for the broader pattern.
- [x] **Fabricated file paths in Current State Analysis** — `src/http.ts:1184` (file is a 1-line re-export), `src/http/github-webhook.ts`, `src/http/linear-webhook.ts`, `src/http/jira-webhook.ts`, `src/http/sentry-webhook.ts`, `src/http/stripe-webhook.ts`, `src/http/managed-callbacks.ts` do not exist. Real consolidated handler is `src/http/webhooks.ts`. Replaced. Also confirmed and documented that **GitHub/GitLab/AgentMail webhook events ALREADY emit on `workflowEventBus`** today (`src/http/webhooks.ts:177,192,202,211,294,308,318,327`; `src/agentmail/handlers.ts:168`) and that `approval.resolved` is emitted from `src/http/approval-requests.ts:183`. Removed GitHub/GitLab from the "Built-in adapters" follow-up list.

### Applied — Important

- [x] **`scope` was a dead config field** — added an explicit "scope semantics" subsection to Phase 3 Step 1 describing how the run-scoped listener checks `payload._runId === waitState.workflowRunId` (or `payload.workflowRunId` for built-in events from `src/be/db.ts`).
- [x] **`execute` return shape didn't compile** — `AsyncExecutorResult` extends `ExecutorResult` (status required). Updated Phase 2 Step 1 to mirror HITL's exact pattern at `src/workflows/executors/human-in-the-loop.ts:131-138,161-166` including the `as unknown as ExecutorResult<…>` cast.
- [x] **Multi-instance not addressed** — added "Multi-instance API replicas" to "What We're NOT Doing" with a pointer to `src/workflows/event-bus.ts:9` showing the in-process `EventEmitter`.
- [x] **`setMaxListeners(100)` cap** — added a Phase 3 note about the ceiling at `src/workflows/event-bus.ts:13` and how to raise it if a deployment exceeds 100 distinct event names.
- [x] **`firedPayload` size** — added a 64KB cap-with-truncation-marker recommendation to Phase 3.
- [x] **`getStuckWaitRuns` recovery scope** — clarified that the query must cover both (a) status≠pending (signal arrived while down) AND (b) status=pending with overdue `wakeUpAt`/`expiresAt`, not only the former.
- [x] **OpenAPI freshness defensive regen** — Phase 4 verification step now also diffs `docs-site/content/docs/api-reference` so a slipped version bump fails the merge gate.
- [x] **Discriminated-union shape unspecified** — replaced the prose description in Phase 3 Step 1 with an explicit Zod 4 `z.discriminatedUnion("mode", [...])` example.
- [x] **`durationMs` had no upper bound** — added `.max(31_536_000_000)` (1 year) sanity ceiling in the Zod schema example.

### Applied — Minor

- [x] Executor count `10 total` → `9 total` (verified against `src/workflows/executors/registry.ts:64-75`).
- [x] Test file names `wait-state-queries.test.ts`, `wait-filter.test.ts` → `workflow-wait-state-queries.test.ts`, `workflow-wait-filter.test.ts` to match the existing `workflow-*.test.ts` convention.
- [x] `wait-filter.test.ts` test now also covers `scope: run/global` enforcement.

### Applied — Post-implementation

- [x] **Migration `050_wait_states_scope.sql`** — Phase 3's `scope: "run" | "global"` field needed a dedicated DB column for the bus listener to enforce in O(1) without parsing JSON on every event. Original Phase 1 schema didn't include it (Phase 1 shipped time-mode only), so a follow-up migration was added during Phase 3. The column is `eventScope TEXT NOT NULL DEFAULT 'run' CHECK (eventScope IN ('run', 'global'))`. Existing time-mode rows safely default to `'run'` (never traverses the bus path).
- [x] **`timeout: { seconds: N }` → `timeoutMs: N`** — original Phase 3 schema used `{ seconds: number }`, inconsistent with time-mode's `durationMs`. Renamed for symmetry and to make UI formatting trivial (raw ms → pretty-print + absolute timestamp). All examples (Desired End State YAML, Phase 3 Zod, Manual E2E JSON), tests (`workflow-wait-event.test.ts`, `workflow-wait-builtin-events.test.ts`), runbook, and executor updated. Schema also gained the `.max(31_536_000_000)` (1 year) ceiling that `durationMs` already had.

### Applied — File-review pass

- [x] **Filter matcher needs clear unit + penetration tests** (line 327, your comment): expanded Phase 3 verification with explicit test cases for (a) object form, (b) string form happy path, (c) sandbox penetration — including direct global access (`process`, `require`, `globalThis`, `Bun`, `global`), the `constructor.constructor('return process')()` Function-constructor escape, `eval` reflection, async escape, infinite-loop DoS, catastrophic-backtracking regex DoS, and side-effect attempts. Added (d) Zod-boundary length/parse-validity rejection and (e) cross-scope coverage. Also added a "Hardening for the string form" subsection in Phase 3 Step 2 with the corresponding implementation requirements: 50ms execution timeout, 2KB filter source cap, parse-at-init validation, and adding `eval`/`Function`/`AsyncFunction` to `SANDBOX_KEYS` (stricter than `code-match`'s shadow list because filter strings are higher-volume and authored by less-trusted workflow authors).

### Verified — No action

- `src/workflows/executors/base.ts:28,36` — citations correct.
- `src/workflows/executors/registry.ts:61,75` — citations correct; `WaitExecutor` insertion point after line 75 is right.
- `src/workflows/engine.ts:541-545` async-dispatch citation correct.
- `src/workflows/event-bus.ts:29` `workflowEventBus` singleton citation correct.
- `src/workflows/resume.ts:38` listener citation correct; `:18-33` payload-shape citation correct.
- `src/workflows/recovery.ts:27` `recoverIncompleteRuns` entry-point correct; existing recovery sweep already does `task.completed`/`approval.resolved` recovery — `recoverWaitStates` slots in cleanly as a sibling.
- `src/workflows/retry-poller.ts:24` poller pattern correct; uses `setTimeout`-chaining, default 5000ms — wait-poller should mirror this pattern (not `setInterval`).
- `src/workflows/executors/code-match.ts:19-30,50` sandbox citation correct; `SANDBOX_KEYS` list (`require, process, Bun, globalThis, global, fetch, setTimeout, setInterval`) reusable as documented.
- `src/be/migrations/020_approval_requests.sql` precedent correct.
- HITL output ports `approved/rejected/timeout` — confirmed in `human-in-the-loop.ts:117-129`.
- `initWorkflows` in `src/workflows/index.ts:43-61` — wiring point for `startWaitPoller` confirmed.
