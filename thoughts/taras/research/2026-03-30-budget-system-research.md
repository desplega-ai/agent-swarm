---
date: 2026-03-30T12:00:00-07:00
researcher: Claude
git_commit: df06969
branch: main
repository: agent-swarm
topic: "Task execution engine, cost tracking, and budget system feasibility"
tags: [research, codebase, tasks, cost-tracking, budgeting, usage]
status: complete
autonomy: autopilot
last_updated: 2026-03-30
last_updated_by: Claude
---

# Research: Task Execution Engine, Cost Tracking, and Budget System Feasibility

**Date**: 2026-03-30
**Researcher**: Claude
**Git Commit**: df06969
**Branch**: main

## Research Question

How does the task execution engine work and how does it relate to cost/usage tracking? The goal is to build a budgeting system that supports global + per-agent controls with granular timeframes. Map out: (1) task lifecycle and execution flow, (2) current cost/usage tracking mechanisms, (3) where budget checks could be enforced, (4) key database tables and schemas involved, (5) API endpoints relevant to tasks and usage.

## Summary

The agent-swarm system uses a centralized API server that owns the SQLite database, with workers polling for tasks and spawning provider sessions (Claude CLI or pi-mono) to execute them. Cost data flows through two paths: automatic extraction from provider output (runner-side) and explicit self-reporting via the `store-progress` MCP tool (agent-side). Both converge on the `session_costs` table via `POST /api/session-costs`.

Currently, cost tracking is **purely observational** — there are no budget tables, spending caps, or enforcement mechanisms in the database or application layer. The only capacity-related limit is `maxTasks` on agents (concurrency control, not spending). However, the system has several well-defined chokepoints where budget enforcement could be inserted: task creation, task claiming/polling, session spawning, and cost recording. The existing `swarm_config` table with its `global > agent > repo` scope resolution pattern provides a natural home for budget configuration.

The existing `swarm_config` table with its `global > agent > repo` scope resolution pattern provides a natural home for budget configuration, and the workflow cooldown system provides a reference for time-windowed gating.

## Detailed Findings

### 1. Task Lifecycle and Execution Flow

#### 1.1 Task Creation

Tasks enter the system through multiple paths, all converging on `createTaskExtended()` (`src/be/db.ts:1833`):

- **MCP tools**: `send-task` (agent-to-agent), `task-action` with `action: "create"` (pool tasks)
- **External sources**: GitHub/GitLab webhooks (`src/github/handlers.ts`, `src/gitlab/handlers.ts`), Slack messages (`src/slack/handlers.ts`), Linear sync (`src/linear/sync.ts`), AgentMail (`src/agentmail/handlers.ts`)
- **Internal**: Scheduler (`src/scheduler/scheduler.ts`), workflow executor (`src/workflows/executors/agent-task.ts`), follow-up tasks from `store-progress` completion
- **REST API**: `POST /api/tasks` (`src/http/tasks.ts:237`)

Initial status is determined by the creation parameters:
- `offered` if `offeredTo` is set
- `pending` if `agentId` is set (direct assignment)
- `backlog` if explicitly requested
- `unassigned` otherwise (pool task)

#### 1.2 Task State Machine

```
                  +--> offered --> reviewing --> pending --> in_progress --> completed
                  |        |                                    |      \--> failed
 (create) --> unassigned --+--> in_progress (auto-claim)        +--> paused --> in_progress (resume)
                  |                                             +--> cancelled
                  +--> backlog --> unassigned
                  |
                  +--> pending (direct assign) --> in_progress --> ...
```

Terminal states: `completed`, `failed`, `cancelled`. Guards at `startTask()` (`db.ts:912`) prevent revival of terminal tasks.

Key transition functions in `src/be/db.ts`:
| Function | From | To | Line |
|---|---|---|---|
| `createTaskExtended()` | — | `offered`/`pending`/`backlog`/`unassigned` | 1833 |
| `claimTask()` | `unassigned` | `in_progress` | 1958 |
| `claimOfferedTask()` | `offered` | `reviewing` | 2170 |
| `acceptTask()` | `offered`/`reviewing` | `pending` | 2015 |
| `rejectTask()` | `offered`/`reviewing` | `unassigned` | 2045 |
| `startTask()` | `pending` | `in_progress` | 907 |
| `completeTask()` | any | `completed` | 1376 |
| `failTask()` | any | `failed` | 1412 |
| `cancelTask()` | non-terminal | `cancelled` | 1442 |
| `pauseTask()` | `in_progress` | `paused` | 1487 |
| `resumeTask()` | `paused` | `in_progress` | 1527 |
| `releaseTask()` | `pending`/`in_progress` | `unassigned` | 1986 |

#### 1.3 Polling and Assignment

Workers run a main loop in `src/commands/runner.ts:2619-2938` that:

1. Pings the server (`POST /ping`)
2. Checks completed provider processes (`checkCompletedProcesses()` at line 1803)
3. Checks for cancellations (`GET /cancelled-tasks`)
4. Polls for triggers if under capacity (`GET /api/poll`)

The server-side poll (`src/http/poll.ts:69-297`) runs within a **single SQLite transaction** with this priority order:

1. **Offered tasks** (highest): `claimOfferedTask()` — `offered` → `reviewing`
2. **Pending tasks**: `startTask()` — `pending` → `in_progress` (requires `hasCapacity()`)
3. **Unread mentions**: `claimMentions()`
4. **Worker auto-claim**: `claimTask()` — atomic `UPDATE WHERE status='unassigned'` (race-safe)
5. **Channel activity** (lowest, leads only): Slack channel monitoring

#### 1.4 Provider Session Spawning

`spawnProviderProcess()` (`runner.ts:1372-1751`):

1. Fetches resolved env config (`GET /api/config/resolved`) — **this is a key budget enforcement point**
2. Creates `ProviderSessionConfig` with prompt, model, cwd, env
3. Spawns provider session via `adapter.createSession(config)` — for Claude, this spawns `claude` subprocess
4. Registers event handlers for `session_init`, `tool_start`, `result`, `context_usage`, `compaction`, `raw_log`
5. On completion: saves cost data, reports final context snapshot

#### 1.5 Task Completion

Two paths to completion:

**Agent-side (primary)**: Agent calls `store-progress` MCP tool with `status: "completed"` or `"failed"` → calls `completeTask()`/`failTask()` in `db.ts`

**Runner-side (fallback)**: `ensureTaskFinished()` (`runner.ts:475-546`) calls `POST /api/tasks/{id}/finish` when provider process exits. Idempotent — returns `alreadyFinished: true` if agent already reported via `store-progress`.

### 2. Current Cost/Usage Tracking Mechanisms

#### 2.1 Cost Data Type

Defined in `src/providers/types.ts:1-15`:

```typescript
interface CostData {
  sessionId: string;
  taskId?: string;
  agentId: string;
  totalCostUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs: number;
  numTurns: number;
  model: string;
  isError: boolean;
}
```

#### 2.2 Cost Ingestion Paths

**Path A — Automatic (runner-side)**:
1. Claude CLI emits `type: "result"` JSON with `total_cost_usd` and `usage` fields
2. `claude-adapter.ts:388-426` builds `CostData` from this output
3. `runner.ts:1700-1707` — on session completion, `saveCostData()` sends `POST /api/session-costs`

**Path B — Explicit (agent-side)**:
1. Agent calls `store-progress` MCP tool with optional `costData` field
2. `store-progress.ts:221-236` calls `createSessionCost()` with generated session ID `mcp-{taskId}-{timestamp}`

**Path C — Direct HTTP**:
1. External clients can `POST /api/session-costs` directly (`session-data.ts:168-192`)

All three paths converge on `createSessionCost()` (`db.ts:3368`) → `session_costs` table.

#### 2.3 Cost Query and Reporting

DB functions in `src/be/db.ts`:
- `getSessionCostsByTaskId()` — line 3406
- `getSessionCostsByAgentId()` — line 3410
- `getSessionCostsFiltered()` — line 3420 (date range + agent filter)
- `getSessionCostSummary()` — line 3484 (totals, daily breakdown, per-agent breakdown)
- `getDashboardCostSummary()` — line 3621 (`costToday` + `costMtd`)

HTTP endpoints in `src/http/session-data.ts`:
- `GET /api/session-costs` — filtered list
- `GET /api/session-costs/summary` — aggregated by day/agent/both
- `GET /api/session-costs/dashboard` — today + month-to-date

#### 2.4 Context Usage Tracking

Table `task_context_snapshots` (`src/be/migrations/022_context_usage.sql`):
- Tracks `contextUsedTokens`, `contextTotalTokens`, `contextPercent` per snapshot
- Event types: `progress` (throttled 30s), `compaction`, `completion`
- Aggregate columns on `agent_tasks`: `compactionCount`, `peakContextPercent`, `totalContextTokensUsed`, `contextWindowSize`

Endpoints in `src/http/context.ts`:
- `POST /api/tasks/{id}/context` — record snapshot
- `GET /api/tasks/{id}/context` — get history + summary

#### 2.5 What's Missing (No Budget Enforcement)

A search across all 27 migration files and the full codebase returned **zero results** for `budget`, `spending limit`, `allowance`, or `quota` (in the context of LLM costs). The system tracks costs but does not enforce any limits. The only capacity limit is `maxTasks` on agents (concurrency, not spending).

### 3. Existing Guard Patterns (Reference for Budget Enforcement)

#### 3.1 Agent Capacity System (`db.ts:623-674`)

```typescript
hasCapacity(agentId)     // activeCount < maxTasks
getRemainingCapacity()   // maxTasks - activeCount
updateAgentStatusFromCapacity() // sets idle/busy
```

This is the closest existing pattern to what a budget system would need — a function that checks a limit before allowing task execution.

#### 3.2 Runner Capacity Gate (`runner.ts:2670-2674`)

```typescript
if (state.activeTasks.size < state.maxConcurrent) {
  // ... poll for triggers
} else {
  console.log(`At capacity, waiting...`);
  await Bun.sleep(1000);
}
```

#### 3.3 Config System — Scope Resolution (`db.ts:4438-4464`)

The `swarm_config` table uses a layered scope model:
- Scopes: `global`, `agent`, `repo`
- Resolution: `global` < `agent` < `repo` (more specific wins)
- `getResolvedConfig(agentId?, repoId?)` merges all applicable configs

This is the natural home for budget settings. A budget could be configured at:
- `global` scope: system-wide spending cap
- `agent` scope: per-agent spending cap
- `repo` scope: per-repository spending cap

#### 3.4 Workflow Cooldown (`src/workflows/cooldown.ts`)

Time-windowed gating with configurable `hours`, `minutes`, `seconds`. Useful reference for timeframe-based budget windows.

#### 3.5 Scheduler Backoff (`src/scheduler/scheduler.ts:119-133`)

Exponential backoff with auto-disable at 5 consecutive errors. Useful reference for budget breach behavior (warn → throttle → disable).

### 4. Key Database Tables

#### 4.1 `agent_tasks` (Final schema from `026_drop_epics.sql`)

48 columns. Key fields for budgeting:
- `id`, `agentId`, `status`, `source`, `priority`, `model`
- `createdAt`, `finishedAt` (for timeframe queries)
- `compactionCount`, `peakContextPercent`, `totalContextTokensUsed`, `contextWindowSize`

No cost columns on the task table itself — costs live in `session_costs` linked by `taskId`.

#### 4.2 `session_costs`

14 columns. This is the **primary cost data table**:
- `id`, `sessionId`, `taskId` (FK nullable), `agentId` (FK)
- `totalCostUsd` (REAL), `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` (INTEGER)
- `durationMs`, `numTurns`, `model`, `isError`, `createdAt`

Indexes: `createdAt`, `taskId`, `agentId`, `(agentId, createdAt)` — well-indexed for budget queries.

#### 4.3 `agents`

19 columns. Key fields for budgeting:
- `id`, `name`, `isLead`, `status` (idle/busy/offline)
- `maxTasks` — the only existing limit field
- No budget/spending fields exist

#### 4.4 `swarm_config`

11 columns. Layered config with scope resolution:
- `scope` (global/agent/repo), `scopeId`, `key`, `value`
- Already supports the exact scope hierarchy a budget system needs

#### 4.5 `events`

General-purpose event store with `category`, `event`, `status`, `source`, `agentId`, `taskId`, `numericValue`, `data`. Could be used for budget-related events (warnings, breaches, resets).

#### 4.6 `task_context_snapshots`

Context window usage tracking per task. Supplements cost data with resource utilization metrics.

### 5. Budget Enforcement Points (Where to Insert Checks)

Based on the task lifecycle, there are **five key chokepoints** where budget checks could be enforced:

#### 5.1 Task Creation (`createTaskExtended()` at `db.ts:1833`)

**What**: Check budget before allowing a new task to be created.
**Pros**: Earliest possible enforcement, prevents work from even starting.
**Cons**: Cost of a task is unknown at creation time. Would need estimated cost or just cap task count.
**How**: Add a pre-check function called at the top of `createTaskExtended()`, or in the HTTP/MCP handlers that call it.

#### 5.2 Poll/Claim Gate (`GET /api/poll` at `poll.ts:69-297`)

**What**: Check agent's or global budget before returning a trigger.
**Pros**: Central chokepoint — all task assignments flow through here. Can check actual spending.
**Cons**: Task has already been created; this just prevents execution.
**How**: Add a budget check alongside the existing `hasCapacity()` check. If over budget, return null trigger (like no tasks available). Agent enters idle/sleep loop.

This is the **highest-value enforcement point** because it's already transactional and controls all task→execution transitions.

#### 5.3 Session Spawning (`spawnProviderProcess()` at `runner.ts:1372`)

**What**: Check budget before spawning a provider process.
**Pros**: Last chance before incurring cost. Worker-side, so doesn't need DB access (could check via API).
**Cons**: Task is already `in_progress` — would need to pause or release it if over budget.
**How**: `fetchResolvedEnv()` at line 1398 already calls the API. Add a budget check call here. If over budget, pause the task and skip spawning.

#### 5.4 Cost Recording (`createSessionCost()` at `db.ts:3368`)

**What**: After cost is recorded, check if budget is now exceeded and take action.
**Pros**: Works on actual spending, not estimates. Can trigger alerts, pause agents, etc.
**Cons**: Reactive, not preventive — cost has already been incurred.
**How**: Add a post-insert check in `createSessionCost()` that sums recent costs against the budget threshold. If exceeded, emit an event, update agent status, or create a system task.

#### 5.5 Heartbeat Sweep (`runHeartbeatSweep()` at `heartbeat.ts:455`)

**What**: Periodic budget enforcement during the heartbeat cycle.
**Pros**: Can catch spending that accumulated between check-in cycles. Good for alerts and auto-remediation.
**Cons**: Not real-time — runs on heartbeat interval. Reactive.
**How**: Add a `checkBudgets()` function to the heartbeat sweep that queries current spending, compares against thresholds, and takes actions (warn → pause → block).

### 6. Existing API Surface for Budget System

#### 6.1 Already Available (no changes needed)

- `GET /api/session-costs/summary` — aggregated costs by day/agent with date filtering
- `GET /api/session-costs/dashboard` — `costToday` and `costMtd`
- `GET /api/session-costs` — filtered cost records
- `GET /api/config/resolved` — scope-resolved configuration (for budget config)
- `PUT /api/config` — upsert config entries (for setting budgets)
- `GET /api/stats` — task counts by status

#### 6.2 Would Need to Be Added

- `GET /api/budget/status` — current spending vs. budget for an agent/global
- `GET /api/budget/check` — pre-flight budget check (can this agent start a task?)
- `POST /api/budget/alert` — emit budget warning/breach notifications
- MCP tool: `check-budget` — agents can self-check their remaining budget
- Budget enforcement in poll endpoint — return "budget_exceeded" instead of task

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/be/db.ts` | 1833 | `createTaskExtended()` — task creation entry point |
| `src/be/db.ts` | 623-674 | Agent capacity system (`hasCapacity`, `getRemainingCapacity`) |
| `src/be/db.ts` | 907 | `startTask()` — pending → in_progress with terminal guard |
| `src/be/db.ts` | 1958 | `claimTask()` — atomic pool claim |
| `src/be/db.ts` | 3368 | `createSessionCost()` — cost record insertion |
| `src/be/db.ts` | 3484 | `getSessionCostSummary()` — aggregated cost reporting |
| `src/be/db.ts` | 3621 | `getDashboardCostSummary()` — costToday + costMtd |
| `src/be/db.ts` | 4438 | `getResolvedConfig()` — scope-cascading config resolution |
| `src/http/poll.ts` | 69-297 | `pollTriggers` — central assignment chokepoint |
| `src/http/session-data.ts` | 53-124 | Session cost API endpoints |
| `src/http/tasks.ts` | 237-497 | Task CRUD and finish endpoints |
| `src/http/config.ts` | — | Config REST API (upsert, resolve, list) |
| `src/commands/runner.ts` | 1372-1751 | `spawnProviderProcess()` — session spawning |
| `src/commands/runner.ts` | 847-870 | `saveCostData()` — runner-side cost reporting |
| `src/commands/runner.ts` | 2619-2938 | Main polling loop |
| `src/providers/claude-adapter.ts` | 388-426 | Cost extraction from Claude CLI output |
| `src/tools/store-progress.ts` | 221-236 | Agent self-reported cost via MCP |
| `src/tools/store-progress.ts` | 306-361 | Follow-up task creation on completion |
| `src/tools/send-task.ts` | 15-302 | Task creation MCP tool |
| `src/heartbeat/heartbeat.ts` | 248-277 | `autoAssignPoolTasks` — capacity-gated assignment |
| `src/heartbeat/heartbeat.ts` | 455 | `runHeartbeatSweep()` — periodic maintenance |
| `src/workflows/cooldown.ts` | — | Reference for time-windowed gating |
| `src/be/migrations/001_initial.sql` | 179-196 | `session_costs` table DDL |
| `src/be/migrations/001_initial.sql` | 246-256 | `swarm_config` table DDL |
| `src/types.ts` | 4-15 | `AgentTaskStatusSchema` |
| `src/types.ts` | 356-373 | `SessionCostSchema` |
| `src/types.ts` | 490-506 | `SwarmConfigSchema` |

## Architecture Documentation

### Data Flow: Task → Cost

```
1. Task Created
   send-task/API/webhook → createTaskExtended() → DB (pending/unassigned/offered)

2. Task Discovered & Claimed
   Worker polls GET /api/poll → Server (in transaction):
     offered → claimOfferedTask() → reviewing
     pending → startTask() → in_progress
     unassigned → claimTask() → in_progress

3. Provider Session Spawned
   buildPromptForTrigger() → spawnProviderProcess() → adapter.createSession()
   → Bun.spawn("claude", ...) → registerActiveSession()

4. During Execution
   Claude stdout → parseJsonLine():
     tool_start → POST /api/tasks/{id}/progress (throttled 3s)
     context_usage → POST /api/tasks/{id}/context (throttled 30s)
     raw_log → POST /api/session-logs (batched)
   Agent → store-progress MCP → updateTaskProgress() / completeTask() / failTask()

5. Session Ends
   waitForCompletion() → saveCostData() → POST /api/session-costs → session_costs table
   checkCompletedProcesses() → ensureTaskFinished() → POST /api/tasks/{id}/finish
   → completeTask()/failTask() → workflowEventBus.emit()
   → updateAgentStatusFromCapacity()

6. Post-Completion
   Memory indexing (async)
   Follow-up task for lead (if worker task)
```

### Config Scope Resolution

```
global (key: "budget.daily.limit", value: "100")
  ↓ overridden by
agent (scopeId: "agent-uuid", key: "budget.daily.limit", value: "50")
  ↓ overridden by
repo (scopeId: "org/repo", key: "budget.daily.limit", value: "25")
```

`getResolvedConfig(agentId, repoId)` returns the most-specific value.

## Historical Context (from thoughts/)

- `thoughts/taras/plans/2026-03-25-context-usage-tracking.md` — Plan for context usage tracking feature (related: context snapshots track resource utilization)
- `thoughts/shared/plans/2026-01-15-usage-cost-tracking-ui.md` — Plan for the usage/cost tracking UI currently in the dashboard
- `thoughts/taras/plans/2026-03-25-generic-events-table.md` — Plan for the generic events table (could be leveraged for budget events)

## Design Decisions (from review)

- **Estimated vs. actual cost**: Hard enforce when budget is exceeded. Additionally, pre-estimate task cost based on the last 7 days of data. If no data from the last 7 days, skip pre-estimation (no block).
- **Granularity of timeframes**: Support all timeframes (hourly, daily, weekly, monthly, rolling-window, calendar-based). Design the system to be easily configurable and extendable.
- **Enforcement actions**: Block polling when budget is exceeded. Budget state should be dynamically computed (not stored) so it can be exposed via a backend API for UI consumption.
- **Budget inheritance**: Both global and agent budgets apply independently. If both exist, both are checked. Budget status is computed at query time from `session_costs` data against the configured limits — no stored budget state, purely backend-computed on each check.
- **In-flight tasks**: Allow running tasks to complete. Budget enforcement only blocks *new* task assignments, never interrupts in-progress work.
- **Budget reset mechanism**: Schedule-based, matching the configured timeframe (daily resets daily, weekly resets weekly, etc.).
- **Multi-model budgets**: Configurable per-model budgets, defaulting to "all models" if not specified. Must work for both Claude and pi providers.
