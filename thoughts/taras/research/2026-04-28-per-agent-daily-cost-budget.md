---
date: 2026-04-28T13:20:44Z
researcher: claude (taras)
git_commit: a822143cee25325e6ddefe12d1eacdc3a0deec90
branch: main
repository: agent-swarm
topic: "Per-agent daily cost budget with refusal-at-claim — codebase grounding"
tags: [research, codebase, claim-flow, providers, notifications, cost-tracking, budgets]
status: complete
autonomy: critical
last_updated: 2026-04-28
last_updated_by: claude (post file-review)
---

# Research: Per-agent daily cost budget — codebase grounding

**Date**: 2026-04-28T13:20:44Z
**Researcher**: claude (taras)
**Git Commit**: a822143cee25325e6ddefe12d1eacdc3a0deec90
**Branch**: main

## Research Question

Three foundational questions feeding the planning phase of the **per-agent daily cost budget with refusal-at-claim** feature (brainstorm: [`thoughts/taras/brainstorms/2026-04-28-per-agent-daily-cost-budget.md`](../brainstorms/2026-04-28-per-agent-daily-cost-budget.md)):

- **R1.** Where does the agent claim a task today? What's the API endpoint, the worker-side caller, and the response shapes? Is there a single chokepoint where the admission predicate slots in cleanly?
- **R2.** Does each supported harness (Claude Code, Codex, Gemini CLI, pi) emit token usage at session end — i.e. is brainstorm Decision #14 ("trust the harness") safe to plan against? What pricing/cost infrastructure already exists?
- **R3.** Where does the lead receive completion/failure notifications today, and where would a third "refused-budget" event slot in? Where should the `(task_id, day)` dedup state live?

## Summary

**R1 — Claim flow.** The dominant claim chokepoint is `GET /api/poll` (`src/http/poll.ts:71-318`), with the entire trigger-evaluation block inside one synchronous SQLite transaction (`poll.ts:102-229`). Three task-acquisition paths live in that transaction (offered, pre-assigned pending, unassigned-pool auto-claim), each gated by atomic single-statement `UPDATE ... WHERE status=… RETURNING *` and (for pending/pool) by `hasCapacity(agentId)`. Two MCP tools — `task-action` `claim` (`src/tools/task-action.ts:129-192`) and `poll-task` (`src/tools/poll-task.ts`) — provide secondary claim surfaces. A budget-admission predicate is most cleanly inserted **alongside `hasCapacity` calls**: at `poll.ts:127, 204` and `task-action.ts:134`. The "no task available" response is HTTP 200 with body `{ "trigger": null }`; a near-relative refusal envelope is `{ "trigger": { "type": "budget_refused", "cause": "agent" | "global", … } }`.

**R2 — Decision #14 verdict: SAFE to plan against.** All three providers in `src/providers/` (claude, codex, pi) extract token usage and emit it via a shared `CostData` interface that flows through `runner.ts:saveCostData` → `POST /api/session-costs` → `session_costs` table — **the entire pipeline already exists end-to-end**. Claude self-reports `total_cost_usd`; pi self-reports `stats.cost` (covers Anthropic/OpenAI/Google/OpenRouter via `@mariozechner/pi-ai`); Codex is the only PARTIAL — emits tokens but no USD, with cost computed locally against `CODEX_MODEL_PRICING` (`src/providers/codex-models.ts:97-141`). Gemini is not a separate provider — it routes through pi. There is **no global price-book table in DB yet**; Codex's hard-coded TS table is the natural seed.

**R3 — Notification path: follow-up task injection, not a webhook.** The lead is notified about task completion/failure by **inserting a new `agent_tasks` row** (assigned to the lead, `source: "system"`, `taskType: "follow-up"`, `parentTaskId: <originalTaskId>`) — done by `src/tools/store-progress.ts:306-362` calling `createTaskExtended`. The lead picks it up via the normal `task_assigned` `/api/poll` trigger. `completeTask`/`failTask` themselves only update DB + emit to in-process `workflowEventBus` (workflow-engine consumers only — does NOT reach leads). A third event type slots in by mirroring the `store-progress` pattern at the refusal site (`poll.ts:127-170`, `poll.ts:204-224`), registering a new template (`task.budget.refused` in `src/tools/templates.ts`), and persisting `(task_id, date)` dedup either as a column on `agent_tasks` (analog: deprecated `notifiedAt` column at `db.ts:809`) or a small `budget_refusal_notifications(task_id, date)` table (analog: `channel_read_state`).

## Detailed Findings

### R1. Claim flow & admission hook point

#### 1.1. Primary chokepoint: `GET /api/poll`

Route definition (uses the project's `route()` factory):
- `pollTriggers` registered at `src/http/poll.ts:27-39`. Auth: `apiKey: true, agentId: true`.
- Handler `handlePoll` at `src/http/poll.ts:71-318`.
- Wired into the global handler chain in `src/http/index.ts:115`.

Inside `handlePoll`, the entire trigger evaluation (lines 102-229) runs in `getDb().transaction(() => {...})`. Three task-acquisition paths, in priority order:

1. **Offered tasks** — `getOfferedTasksForAgent` → `claimOfferedTask` (atomic UPDATE, `src/be/db.ts:2356-2383`). `poll.ts:108-123`.
2. **Pre-assigned pending tasks** — `getPendingTaskForAgent` (`db.ts:989-1007`) → `startTask` (atomic UPDATE, `db.ts:1009-1041`). Gated by `hasCapacity(agentId)` (`db.ts:726-731`). `poll.ts:127-171`.
3. **Unassigned-pool auto-claim (workers only, `!agent.isLead`)** — `getUnassignedTaskIds(5)` → `claimTask` loop (atomic UPDATE, `db.ts:2139-2170`). Gated by `hasCapacity`. `poll.ts:197-225`.

Plus channel-activity / unread-mentions branches for leads (`poll.ts:176-187` and `poll.ts:250-310`) — not task claims.

Atomicity strategy: every claim DB function uses single-statement `UPDATE … WHERE status=… RETURNING *`, e.g. `db.ts:2147-2150` (`claimTask`) — comment at `db.ts:2140-2143` is explicit: *"Atomic claim: single UPDATE with WHERE guard ensures exactly-once claiming. No pre-read needed."* The DB runs in WAL mode with `busy_timeout=5000` (`db.ts:102-103`).

#### 1.2. Worker-side caller

`pollForTrigger()` at `src/commands/runner.ts:1328-1368`:
- Hits `GET ${apiUrl}/api/poll` with `X-Agent-ID` and `Authorization: Bearer ${apiKey}` headers.
- Outer poll loop: `runner.ts:2891+`, capacity gate at `runner.ts:2943`, call site at `runner.ts:2951-2957`.
- Trigger discriminator interface at `runner.ts:1247-1278`: `task_assigned | task_offered | unread_mentions | pool_tasks_available | channel_activity`.
- Dispatch via `buildPromptForTrigger` (`runner.ts:1370-1467`), provider session spawn at `runner.ts:2828`.
- Empty-poll bookkeeping: `MAX_EMPTY_POLLS=2` at `db.ts:654`; `incrementEmptyPollCount` (`db.ts:660`), `resetEmptyPollCount` (`db.ts:677`), `shouldBlockPolling` (`db.ts:690`).

#### 1.3. MCP-layer claim surfaces (secondary)

- `task-action` MCP tool, `action: "claim"` — `src/tools/task-action.ts:129-192`. Calls `hasCapacity` (line 134) then `claimTask` (line 163), inside `getDb().transaction(...)` (line 104).
- `poll-task` MCP tool — `src/tools/poll-task.ts:22-206`. Pending+offered only (no pool claim). Inner txn at `poll-task.ts:117-135` calls `getPendingTaskForAgent` + `startTask`.

#### 1.4. Response shapes

| Outcome | HTTP shape | Source |
|---------|-----------|--------|
| Task assigned (any path) | `200 { "trigger": { "type": "task_assigned" \| "task_offered", "taskId": "<uuid>", "task": {…AgentTask} } }` | `poll.ts:115-122, 160-169, 214-220, 313` |
| No task available | `200 { "trigger": null }` | `poll.ts:228, 313` |
| Missing agent header | `400 { "error": "Missing X-Agent-ID header" }` | `poll.ts:93` (helper `jsonError` at `src/http/utils.ts:55-58`) |
| Agent not found | `404 { "error": "Agent not found" }` | `poll.ts:241-243` |
| DB error | `500 { "error": "Database error occurred while polling for triggers: …" }` | `poll.ts:231-237` |

`task-action` MCP refusal patterns (string `message` only, `success: false`):
- No capacity (mirror analog): `"You have no capacity (N/M tasks). Complete a task first."` (`task-action.ts:134-141`).
- Race lost: `"Task '<id>' was already claimed by another agent. Try a different task."` (`task-action.ts:164-168`).
- Output schema at `task-action.ts:81-86`.

#### 1.5. Single chokepoint?

**Yes, with caveats.** `/api/poll` is the only path the runner ever uses. But MCP tools can claim too:

| # | Path | File:line | DB function |
|---|------|-----------|-------------|
| A | `/api/poll` → pre-assigned pending | `src/http/poll.ts:127-171` | `startTask` |
| B | `/api/poll` → unassigned pool (workers only) | `src/http/poll.ts:204-224` | `claimTask` |
| C | MCP `poll-task` → pre-assigned pending | `src/tools/poll-task.ts:117-135` | `startTask` |
| D | MCP `task-action` `claim` action | `src/tools/task-action.ts:129-192` | `claimTask` |

The cleanest insertion is **call-site adjacent to `hasCapacity`** (paths A, B, D — already gate-checked); for path C the gate would be added at `poll-task.ts:117`. Inserting inside `claimTask`/`startTask` themselves is *not* recommended — `startTask` is also called from non-claim paths (e.g. resume), so an in-function gate would inadvertently block resumption.

#### 1.6. Pitfalls / gotchas

- **Four claim paths**, not one. A budget hook at only `/api/poll` lets the in-session agent bypass via MCP `task-action` or `poll-task`.
- **`startTask` is overloaded** (claim + resume). Gate at call sites, not inside the function.
- **Worker poll thrash.** When budget is exhausted, the API will refuse on every `pollForTrigger` cycle (`runner.ts:1337-1366` sleeps `pollInterval`, default 2000 ms; `pollTimeout` 60000 ms or 5000 ms when other tasks are active). Refusal *responses* will fire at full poll rate even with notification dedup. Worker dispatch needs a `budget_refused` case that backs off, not just a no-op.
- **Lead vs worker asymmetry.** Path B is gated `!agent.isLead` (`poll.ts:189-196`). If budgets apply to leads, gate path A (assignment-driven), not B.
- **`acceptTask` (`db.ts:2201-2229`) for offered tasks has no `hasCapacity` check today.** If budget should refuse acceptance of *offered* tasks too, that's a fifth gate site.
- **Empty-poll count semantics.** Budget-refused polls likely shouldn't count as "empty" (they're refused, not absent). `incrementEmptyPollCount` calls (`poll-task.ts:138, 178`) need a separate path for refusal.

#### 1.7. Existing capacity-refusal precedent

`hasCapacity` is the pre-existing analog of a budget admission predicate. It is in-transaction, per-agent, returns boolean, and is called at every claim site already. Symmetry is exact — slot the budget check next to it, the audit/test surface mirrors what's already there.

### R2. Per-harness usage emission — Decision #14 sanity check

#### 2.1. Per-provider table

| Provider | Harness invocation | Output parsing | Emits usage? | Fields | Lands today | Notes |
|---|---|---|---|---|---|---|
| **Claude Code** | `Bun.spawn` of `claude` CLI with `--output-format stream-json` (`src/providers/claude-adapter.ts:233-242`) | `processJsonLine` at `claude-adapter.ts:390-492` | **YES (full)** | `total_cost_usd`, `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, `duration_ms`, `num_turns`, `is_error` from `result` JSON line (`claude-adapter.ts:414-437`) | DB `session_costs` | Claude **self-reports USD** — no price-book lookup needed. Cache read/write distinction baked in. Extended thinking folded into `output_tokens`. |
| **Codex** | `@openai/codex-sdk` spawning `codex app-server` JSON-RPC (`codex-adapter.ts:857-873`) | `handleEvent` at `codex-adapter.ts:463-618`; usage from `turn.completed` at `codex-adapter.ts:570-605`; `buildCostData` at `codex-adapter.ts:382-412` | **PARTIAL** — tokens YES, USD NO | SDK `Usage`: `input_tokens`, `cached_input_tokens`, `output_tokens`. NO native cost. | DB `session_costs`, USD computed via `computeCodexCostUsd` (`codex-models.ts:128-141`) against `CODEX_MODEL_PRICING` (`codex-models.ts:97-119`) | `cacheWriteTokens` hardcoded to 0 (`codex-adapter.ts:405-406`) — SDK doesn't distinguish. `input_tokens` is **per-turn sum** across sub-calls. Reasoning items emitted as `custom` event but not in `Usage`. `gpt-5.2-codex` falls back to `gpt-5.3-codex` pricing. `durationMs` = wall-clock. |
| **Gemini** | n/a — no standalone Gemini provider | n/a | n/a (routes through pi) | n/a | n/a | `createProviderAdapter` (`src/providers/index.ts:16-27`) accepts only `claude \| pi \| codex`. Gemini reaches the system as `openrouter/google/gemini-3-flash-preview` via pi (`pi-mono-adapter.ts:88-108`). Inherits pi's PASS rating. |
| **pi** (`@mariozechner/pi-coding-agent`) | In-process `createAgentSession()` (no subprocess) at `pi-mono-adapter.ts:522` | `agentSession.subscribe(handleAgentEvent)` at `pi-mono-adapter.ts:189-288`; final `agentSession.getSessionStats()` at `pi-mono-adapter.ts:301`; `buildCostData` at `pi-mono-adapter.ts:353-368` | **YES (full)** | `stats.cost`, `stats.tokens.{input,output,cacheRead,cacheWrite}`, `stats.userMessages + stats.assistantMessages` | DB `session_costs` | `stats.cost` is library-internal — `pi-ai` covers Anthropic/OpenAI/Google/OpenRouter pricing. `durationMs=0` (line 363 — `SessionStats` doesn't expose duration). |

#### 2.2. End-to-end cost data flow (identical for all providers)

1. Adapter emits `ProviderEvent { type: "result", cost: CostData }` (shape: `src/providers/types.ts:1-15`).
2. Runner listener at `src/commands/runner.ts:1751-1773` buffers a `session.end` event with cost.
3. After `waitForCompletion()`, runner calls `saveCostData` at `runner.ts:1886-1897` (awaited).
4. `saveCostData` (`runner.ts:1004-1027`) `POST /api/session-costs` with `Authorization: Bearer ${apiKey}` and `X-Agent-ID`.
5. Handler `handleSessionData` at `src/http/session-data.ts:168-193` calls `createSessionCost` (`src/be/db.ts:3558-3594`).
6. Persisted to `session_costs` table (schema: `src/be/migrations/001_initial.sql:179-196`).

#### 2.3. Existing pricing / cost-tracking infrastructure

**Database:**
- `session_costs` table (baseline migration). Columns: `id, sessionId, taskId, agentId, totalCostUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, durationMs, numTurns, model, isError, createdAt`.
- TS schema: `SessionCostSchema` at `src/types.ts:399-414`.

**DB query helpers (`src/be/db.ts`):**
| Function | Line | Purpose |
|---|---|---|
| `createSessionCost` | 3558 | Insert |
| `getSessionCostsByTaskId` | 3596 | Per-task |
| `getSessionCostsByAgentId` | 3600 | Per-agent |
| `getAllSessionCosts` | 3604 | Full table |
| `getSessionCostsFiltered` | 3610 | Date range + agentId |
| `getSessionCostSummary` | 3674 | Totals + daily + per-agent breakdown |
| `getDashboardCostSummary` | 3811 | Today + month-to-date |

**REST endpoints (`src/http/session-data.ts`):**
- `POST /api/session-costs` (line 53), `GET /api/session-costs` (108), `/summary` (79), `/dashboard` (97).

**Price book infrastructure:**
- `CODEX_MODEL_PRICING` at `src/providers/codex-models.ts:97-119` — TS const, per-million-token rates with `inputPerMillion`, `cachedInputPerMillion`, `outputPerMillion`.
- `computeCodexCostUsd(model, in, cached, out)` at `codex-models.ts:128-141`.
- **No DB-backed pricing table.** No `pricing` / `prices` / `price_book` rows.
- **No budget/spend code.** Grep `src/` for `budget`, `spend`, `daily_limit`, `cost_limit` returns nothing.

**Other plumbing:**
- `session.end` event also buffered to `/api/events/batch` at `runner.ts:1757-1772` (model, USD, tokens).
- Context-usage telemetry separate from cost: `runner.ts:1774-1814` POSTs to `/api/tasks/{id}/context`.

#### 2.4. Verdict: Decision #14 is SAFE

| Provider | Verdict | Justification |
|---|---|---|
| Claude Code | **PASS** | Full usage + USD self-reported. |
| Codex | **PARTIAL** | Tokens emitted; USD computed locally via existing TS price book. Cache writes always 0; per-turn-sum input. |
| pi (incl. Gemini routing) | **PASS** | Full usage + USD via `@mariozechner/pi-ai`. |

All providers already feed `session_costs`. The price-book DB-ification (Decision #12 in the brainstorm) is a low-risk migration of `CODEX_MODEL_PRICING` plus optional override rows for Claude/pi if we want to recompute USD from tokens rather than trusting harness-reported numbers.

### R3. Lead notification plumbing

#### 3.1. Where completion/failure is recorded

`src/be/db.ts`:
- `completeTask(id, output?)` — lines 1541-1575. Updates row, writes `agent_logs` audit entry, `import("../workflows/event-bus").then(...).emit("task.completed", …)` at lines 1561-1571.
- `failTask(id, reason)` — lines 1577-1605. Same shape; emits `task.failed` at 1592-1602.
- `cancelTask(id, reason?)` — lines 1607-1645; emits `task.cancelled`.
- `pauseTask` (1652) / `resumeTask` (1692) — no event-bus emit.

**Side effects of `completeTask`/`failTask` themselves:** DB row update, audit row, in-process `workflowEventBus` event. **No Slack post, no GitHub comment, no inbox row, no webhook fired here.**

#### 3.2. How leads "see" completion (the actual notification path)

The lead is notified **by inserting a follow-up `agent_tasks` row** that targets the lead. Source: `src/tools/store-progress.ts:306-362`.

End-to-end flow:
1. Worker calls MCP `store-progress(taskId, status: "completed" | "failed", output)`.
2. Inside the txn (`store-progress.ts:157, 184`): `completeTask` / `failTask` runs.
3. After commit (line 309): if `result.task` is set and the task isn't workflow-managed, `createTaskExtended` (`store-progress.ts:343-351`) inserts a new `agent_tasks` row with:
   - `agentId: leadAgent.id`
   - `source: "system"`, `taskType: "follow-up"`, `parentTaskId: <originalTaskId>`
   - body rendered from prompt template `task.worker.completed` or `task.worker.failed` (templates registered at `src/tools/templates.ts:14, 68`)
   - inherits `slackChannelId`, `slackThreadTs`, `slackUserId` so the lead can reply in-thread.
4. Lead's next `/api/poll` returns `{ trigger: { type: "task_assigned", taskId, task: …, requestedBy: … } }` (`src/http/poll.ts:160-169`).
5. Lead processes; if it ends, it calls `store-progress` itself.

**The old `tasks_finished` poll trigger has been retired** — see comment block at `src/http/poll.ts:189-196`. Helpers `getRecentlyFinishedWorkerTasks` (`db.ts:1368-1382`), `markTasksNotified` (`db.ts:1388-1401`), and the `notifiedAt` column at `db.ts:809` are remnants of that prior path; not wired into `/api/poll` anymore.

#### 3.3. Inbox / mentions table — UNRELATED

The `claimMentions` and `getInboxSummary` calls in `src/http/poll.ts:176-187` power **agent-to-agent chat**, not task lifecycle:
- Reads from `channel_messages` and `channel_read_state` (`getInboxSummary` at `db.ts:2921-3000+`, `getMentionsForAgent` at `db.ts:2869-2899`).
- `InboxMessage`/`InboxMessageSchema` (`src/types.ts:21-54`) is sourced from Slack/agentmail, not from `completeTask`/`failTask`.
- Tables `channel_messages`, `channel_read_state`, `inbox_messages` are **not written** by the task-lifecycle functions.

#### 3.4. Secondary transports — what they do/don't fire

| Transport | Fires on completion/failure? | Notes |
|---|---|---|
| **Slack** (`src/slack/`) | No — not from `completeTask`/`failTask` | Lead receives Slack context (`slackChannelId`, `slackThreadTs`, `slackUserId`) via the follow-up task body; lead uses `slack-reply` tool to post. Template at `src/tools/templates.ts:25-30` instructs this. |
| **GitHub** (`src/github/`) | No on completion. `addEyesReactionOnTaskStart` only fires from `startTask` (`db.ts:1037-1039`) and `claimTask` (`db.ts:2167`). | No completion-side GitHub posting in `completeTask`/`failTask`. |
| **`workflowEventBus`** | Yes (`task.completed`, `task.failed`, `task.cancelled`) | In-process only; consumed by workflow engine for DAG sequencing. Does NOT reach the lead. |
| **`src/hooks/`** | n/a | Worker-side hooks, not a notification bus. |

#### 3.5. Where a "refused-budget" event slots in

**Natural extension point**: insertion at the refusal site in `src/http/poll.ts`, mirroring `store-progress.ts:343-351`'s `createTaskExtended` call.

When the admission predicate refuses:
1. Skip `startTask` / `claimTask` (task stays `pending`/`unassigned`).
2. If not already deduped for `(taskId, today)`, insert a follow-up task to the lead via `createTaskExtended` (`db.ts:2002-2137` already supports `source: "system"`, `parentTaskId`, slack-context inheritance, custom `taskType`).
3. Register a third template — e.g. `task.budget.refused` — alongside `task.worker.completed`/`task.worker.failed` in `src/tools/templates.ts:14, 68`. Payload: cause (`agent` vs `global`), `agentId`, `agentSpend`, `agentBudget`, `globalSpend`, `globalBudget`, `resetAt`.

Both refusal sites need this:
- `src/http/poll.ts:127-170` (pre-assigned pending refused).
- `src/http/poll.ts:197-225` (pool refused).
- And mirror at `src/tools/task-action.ts:129-192` and `src/tools/poll-task.ts:117-135` if those surfaces are also gated.

Alternative considered: emit through `workflowEventBus` (mirror `db.ts:1561-1571`). **Rejected** — workflow bus is in-process workflow-engine only; doesn't reach leads. The follow-up task is the established lead-notification rail.

#### 3.6. Dedup-state location for `(task_id, day)`

Two patterns exist in the codebase. Both are valid; the brainstorm leaves the choice open.

| Option | Pattern in codebase | Pros | Cons |
|---|---|---|---|
| **Column on `agent_tasks`** (`budgetRefusalNotifiedDate TEXT`, UTC YYYY-MM-DD) | Analog: deprecated `notifiedAt` column at `db.ts:809` | Reuses closest existing analog. Dedup atomic with the same `agent_tasks` UPDATE that records the refusal. New forward-only migration — single `ALTER TABLE`. | One row per task; loses per-day audit on rollover. Adds a column for a feature that doesn't apply to all tasks. |
| **Separate `budget_refusal_notifications(task_id, date, agent_id, …)` table** with `PRIMARY KEY(task_id, date)` | Loose analog: `channel_read_state` (`db.ts:2929-2937`) shows the multi-key state pattern. | UNIQUE constraint enforces dedup at DB layer. Per-day audit row preserved across rollovers — full compliance trail. Doesn't pollute `agent_tasks`. | New table + new migration + new query helpers. Slightly more code. |

**Recommendation lean** (for the planner): **separate table** — the brainstorm explicitly lists "audit trail" (R6) as a requirement, and a dedicated `budget_refusal_notifications` table preserves a full per-day audit even if the same task survives multiple days. The cost is a single new migration plus 2-3 query helpers (`recordBudgetRefusalNotification`, `hasBudgetRefusalNotificationToday`).

## Code References

### R1 — Claim flow

| File | Line | Description |
|------|------|-------------|
| `src/http/poll.ts` | 27-39 | `pollTriggers` route registration |
| `src/http/poll.ts` | 71-318 | `handlePoll` — chokepoint |
| `src/http/poll.ts` | 102-229 | All-claim-paths transaction |
| `src/http/poll.ts` | 127-171 | Pre-assigned pending claim path (admission site A) |
| `src/http/poll.ts` | 197-225 | Pool auto-claim path (admission site B, workers only) |
| `src/http/poll.ts` | 313 | `json(res, result)` serialization (`{trigger}` envelope) |
| `src/http/utils.ts` | 49-58 | `json` / `jsonError` response helpers |
| `src/be/db.ts` | 726-731 | `hasCapacity` — analog gate |
| `src/be/db.ts` | 989-1007 | `getPendingTaskForAgent` |
| `src/be/db.ts` | 1009-1041 | `startTask` (atomic UPDATE) |
| `src/be/db.ts` | 2139-2170 | `claimTask` (atomic UPDATE) |
| `src/be/db.ts` | 2356-2383 | `claimOfferedTask` (atomic UPDATE) |
| `src/be/db.ts` | 2395-2402 | `getUnassignedTaskIds` |
| `src/tools/task-action.ts` | 129-192 | MCP `claim` action (admission site D) |
| `src/tools/poll-task.ts` | 22-206 | MCP `poll-task` tool (admission site C) |
| `src/commands/runner.ts` | 1247-1278 | `Trigger` type |
| `src/commands/runner.ts` | 1328-1368 | `pollForTrigger` worker caller |
| `src/commands/runner.ts` | 1370-1467 | `buildPromptForTrigger` (dispatch — needs `budget_refused` case) |
| `src/commands/runner.ts` | 2891-2957 | Main poll loop |

### R2 — Provider cost emission

| File | Line | Description |
|------|------|-------------|
| `src/providers/types.ts` | 1-15 | `CostData`, `ProviderEvent` shared contracts |
| `src/providers/index.ts` | 16-27 | `createProviderAdapter` — accepts only `claude\|pi\|codex` |
| `src/providers/claude-adapter.ts` | 233-242 | Claude CLI `Bun.spawn` |
| `src/providers/claude-adapter.ts` | 390-492 | `processJsonLine` — extracts `total_cost_usd` + tokens |
| `src/providers/codex-adapter.ts` | 382-412 | `buildCostData` |
| `src/providers/codex-adapter.ts` | 463-618 | `handleEvent`; `turn.completed` usage at 570-605 |
| `src/providers/codex-models.ts` | 97-141 | `CODEX_MODEL_PRICING` + `computeCodexCostUsd` |
| `src/providers/pi-mono-adapter.ts` | 88-108 | Model resolver (Gemini → OpenRouter routing) |
| `src/providers/pi-mono-adapter.ts` | 300-302 | `getSessionStats()` — final usage |
| `src/providers/pi-mono-adapter.ts` | 353-368 | `buildCostData` |
| `src/commands/runner.ts` | 1004-1027 | `saveCostData` — `POST /api/session-costs` |
| `src/commands/runner.ts` | 1751-1773 | Result-event handler buffers `session.end` |
| `src/commands/runner.ts` | 1886-1897 | Final cost save (awaited) |
| `src/http/session-data.ts` | 53-124 | `/api/session-costs` REST routes |
| `src/be/db.ts` | 3503-3525 | `session_costs` insert |
| `src/be/db.ts` | 3558-3824 | All session-cost CRUD + summary |
| `src/be/migrations/001_initial.sql` | 179-196 | `session_costs` schema |
| `src/types.ts` | 399-414 | `SessionCostSchema` |

### R3 — Notification plumbing

| File | Line | Description |
|------|------|-------------|
| `src/be/db.ts` | 1541-1575 | `completeTask` — emits `workflowEventBus` |
| `src/be/db.ts` | 1577-1605 | `failTask` — emits `workflowEventBus` |
| `src/be/db.ts` | 1607-1645 | `cancelTask` — emits `workflowEventBus` |
| `src/be/db.ts` | 2002-2137 | `createTaskExtended` (used to inject lead-notification tasks) |
| `src/be/db.ts` | 809 | Deprecated `notifiedAt` column (column-pattern analog for dedup) |
| `src/be/db.ts` | 1368-1401 | Deprecated `getRecentlyFinishedWorkerTasks` / `markTasksNotified` (no longer wired) |
| `src/be/db.ts` | 2929-2937 | `channel_read_state` (multi-key dedup analog) |
| `src/tools/store-progress.ts` | 306-362 | Lead-notification path: inserts follow-up task |
| `src/tools/store-progress.ts` | 343-351 | `createTaskExtended` call to mirror |
| `src/tools/templates.ts` | 14, 68 | `task.worker.completed` / `task.worker.failed` template registrations |
| `src/http/poll.ts` | 189-196 | Comment: old `tasks_finished` trigger retired |
| `src/workflows/event-bus.ts` | — | In-process bus (workflow engine consumers; not lead-facing) |

## Decisions resolved during file-review (2026-04-28)

These items were open at the end of research; Taras resolved each during the file-review pass. They feed directly into the planning phase.

- **D-R1. In-session MCP claim surfaces (`task-action`, `poll-task`).** Out of scope for V1. The budget gate sits on `/api/poll` only; in-session bypasses are accepted as a known limitation for V1. Revisit if it shows up in practice.
- **D-R2. `acceptTask` is gated by budget.** The budget DOES refuse acceptance of offered tasks. Add the predicate at `src/tools/task-action.ts:222-253` (the `accept` action) — this is the fifth gate site, alongside the four claim sites in R1 §1.5.
- **D-R3. Refused polls do NOT increment `emptyPollCount`.** Wire `budget_refused` outcomes to a separate path that bypasses `incrementEmptyPollCount` in `src/tools/poll-task.ts:138, 178` and any matching runner-side accounting. Refused ≠ empty.
- **D-R4. Worker back-off on `budget_refused`: exponential with a cap.** When `buildPromptForTrigger` (`runner.ts:1370-1467`) receives a `budget_refused` trigger, the runner backs off the poll interval exponentially (capped at some sane maximum — exact ceiling TBD in the plan, suggest something like 5–15 min). Avoids polling-load amplification when budgets are blown.
- **D-R5. Trust harness-reported USD; no re-derivation from tokens.** Reconciles brainstorm Decisions #12 and #14: the in-DB price book exists for Codex (the only provider that doesn't self-report USD); for Claude (`total_cost_usd`) and pi (`stats.cost`) we record what the harness reports as-is. The price book is authoritative only for Codex.
- **D-R6. `task.budget_refused` IS emitted to `workflowEventBus`.** For parity with `task.failed` / `task.cancelled` so DAG sequencing notices the refusal. Mirror the existing emit pattern at `src/be/db.ts:1561-1571`. (This is in addition to — not instead of — the follow-up task notification rail.)
- **D-R7. `pool_tasks_available` trigger is confirmed dead in production.** The server-side `/api/poll` handler (`src/http/poll.ts:189-225`) only ever returns `task_assigned` for the worker pool path (line 215) — auto-claim happens inline. The trigger type still appears in the runner's `Trigger` union (`runner.ts:1252`), the dispatch case (`runner.ts:1432`), and a few tests (`src/tests/runner-polling-api.test.ts:130, 461, 494, 498, 529`; `src/tests/pool-session-logs.test.ts:124, 152`), but the server never emits it. The runner case is unreachable from production. Cleanup is out of scope for this feature.

## Appendix

### Architecture notes

- **API server is sole DB owner.** Workers communicate over HTTP (`Authorization: Bearer ${apiKey}`, `X-Agent-ID` headers). Boundary enforced by `scripts/check-db-boundary.sh` (pre-push hook + CI).
- **All HTTP routes use `route()` factory** (`src/http/route-def.ts`) — auto-registers in OpenAPI. Any new endpoint MUST also be added to `scripts/generate-openapi.ts` and trigger `bun run docs:openapi`.
- **Forward-only SQL migrations** in `src/be/migrations/NNN_*.sql`. SQLite WAL mode, `busy_timeout=5000`. All claim flips use atomic single-statement `UPDATE … WHERE … RETURNING *`.
- **`bun:sqlite` transactions are synchronous** — no `await` inside `getDb().transaction(...)` callbacks. Side effects that need awaits go after commit (the `store-progress.ts:309` pattern is the canonical example).
- **The lead-notification rail is "follow-up tasks", not webhooks/Slack/inbox.** This is the cleanest discovery from R3 — refusal events should ride the same rail, not invent a new one.

### Historical context (from thoughts/)

- `thoughts/taras/brainstorms/2026-04-28-per-agent-daily-cost-budget.md` — the brainstorm this research feeds. Decisions #1-14, R1-R7 requirements.
- `thoughts/taras/research/2026-03-05-pi-mono-provider-research.md` — relevant if the planning phase needs to deepen on pi cost reporting.
- `thoughts/taras/research/2026-03-06-workflow-engine-design.md` — covers `workflowEventBus`, helpful if the plan adds `task.budget_refused` to the workflow bus.
- `thoughts/taras/research/2026-01-27-excessive-polling-issue.md` — context for poll-rate concerns when budgets thrash (R1.6 pitfall).

### Related research

- `thoughts/taras/research/2026-03-05-pi-mono-provider-research.md` — pi adapter and cost extraction
- `thoughts/taras/research/2026-03-06-workflow-engine-design.md` — `workflowEventBus` and DAG sequencing
- `thoughts/taras/research/2026-01-27-excessive-polling-issue.md` — poll-rate dynamics
