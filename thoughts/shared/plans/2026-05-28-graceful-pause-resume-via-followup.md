---
date: 2026-05-28T12:00:00Z
planner: claude
topic: "Graceful Worker Task Pause & Resume via Follow-Up"
status: completed
---

# Graceful Worker Task Pause & Resume via Follow-Up

**Approach:** Automatic supersede + fresh-session follow-up (no native `--resume`)

## Overview

### Motivation

Workers occasionally need to terminate a task they cannot finish in the current process:

- **Graceful shutdown** — SIGTERM during container redeploy, scale-down, or host migration.
- **Context-window pressure** — provider session hits compaction or hard limit mid-task (future trigger; see Phase 6).

Today's `pause` flow (`pauseTaskViaAPI` at `src/commands/runner.ts:1018`, called from the shutdown handler at `src/commands/runner.ts:1194`) marks the task `paused` and relies on a boot-time scanner to "resume" via the provider's `--resume` session ID. This is fragile across host changes, provider model bumps, container restarts, and any path where the worker that picks the task back up isn't the same OS process. It also leaves the task semantically open with no clear handoff for an operator inspecting the dashboard.

This plan replaces the pause/resume path with: terminate the original task as `superseded`, spawn a fresh follow-up task (`taskType: "resume"`) that any worker can pick up, and rely on an **enriched context preamble** to carry continuity instead of provider session state.

### Related

- Existing follow-up creation: `src/tasks/worker-follow-up.ts` (`createWorkerTaskFollowUp`, line 30)
- Existing context preamble: `src/commands/context-preamble.ts` (`buildContextPreamble`, default 2000-token budget)
- Existing pause flow: `src/commands/runner.ts:1018` + `:1194`
- Parent-task inheritance behavior: `src/be/db.ts:2614-2640` (`createTaskExtended`)
- Terminal-status guards: `src/be/db.ts` lines 1176, 1247, 1254, 1929 (mutations) and 1693, 1711, 1869 (stats)

## Current State Analysis

| Concern | Today | After |
|---|---|---|
| Shutdown handler | `pauseTaskViaAPI(...)` → sets `status='paused'` | `supersedeTaskViaAPI(...)` → original terminal-ly `superseded`, resume follow-up created |
| Continuity mechanism | Provider `--resume` session ID, replayed on boot by same/any worker | Enriched preamble (parent description + last-N session_logs summary + artifacts) on a fresh session |
| Cross-host resilience | Brittle — session ID often unusable on a different worker | Native — any worker can pick up the `resume` task from the unassigned pool |
| Terminal-status taxonomy | `completed`, `failed`, `cancelled` (+ `paused` as a non-terminal limbo) | Adds `superseded` as an explicit terminal status |
| Audit trail | Pause event in `agent_logs`, then a silent revival | Explicit `task_superseded` event with `resumeTaskId` cross-reference |
| Workflow tasks | Pause + resume runs through the same path (semantics unclear) | Workflow tasks are **carved out** (fail back to engine; see C3 / Phase 3.5) |

## Desired End State

A worker that cannot finish a task in-process:

1. Calls `POST /api/tasks/{id}/supersede` with a `reason`.
2. The API atomically: marks the task `superseded` (terminal), emits a `task_superseded` log + event, creates a `resume` follow-up task with explicit inheritance (`model`, `dir`, `vcsRepo`, `vcsProvider`, all Slack/AgentMail fields, `contextKey`, `requestedByUserId`) and `parentTaskId` set to the original.
3. The resume task routes to the **same worker** when it is online (heartbeat within 30s) and below its concurrent-task cap, otherwise to the unassigned pool.
4. The receiving worker builds a `buildResumeContextPreamble()` (twice the regular budget, including last-N session log summaries) and starts a brand-new provider session.
5. The original task is read-only — agents cannot `completeTask` / `failTask` / `cancelTask` it; UI shows it linked to the resume task via `parentTaskId`.

For **workflow** tasks (where `workflowRunStepId IS NOT NULL`): supersede instead marks the task `failed` with reason `superseded_workflow_task` and emits the standard workflow `task.failed` event so the engine's retry/failure policy handles it. No resume follow-up is created.

## What We're NOT Doing

- **Legacy paused-task cleanup.** The boot-time `paused` scanner stays as a safety net for pre-deploy in-flight tasks; full removal is tracked separately (see Appendix — Follow-up Plans).
- **Workflow-task resume.** Carved out (see Phase 3.5). The workflow engine, not this plan, is responsible for recovery semantics inside a workflow run.
- **Dashboard UI for `superseded` badge + filter.** Tracked as a separate UI PR (see Appendix — Follow-up Plans).
- **Full session-state replay.** Preamble carries summaries of `session_logs` entries, not raw tool-call transcripts. This is a deliberate cost/correctness tradeoff (Phase 2.2 has the budget allocation).
- **Context-limit auto-supersede trigger.** Phase 6 (separately gated). Graceful shutdown is the only trigger in v1.
- **Cross-org / cross-tenant supersede.** Resume task always inherits the parent's `requestedByUserId` and `contextKey`; no anonymization step.

## Implementation Approach

- Phase 1 — Schema/types: add `superseded` status, `task_superseded` event, `supersedeTask()` mutator.
- Phase 2 — Follow-up core: `createResumeFollowUp()` (explicit inheritance, workflow-task carve-out) + `buildResumeContextPreamble()` (4000-token budget, session_logs summary).
- Phase 3 — Shutdown wiring: replace `pauseTaskViaAPI` with `supersedeTaskViaAPI`, add fallback chain, dispatch resume preamble in the poll loop.
- Phase 4 — API + guards: `POST /api/tasks/{id}/supersede` route, add `superseded` to terminal guards (enumerated per-site), exempt `"resume"` from re-delegation guard.
- Phase 5 — Tests: unit + integration covering supersede, routing fallback, idempotency, workflow carve-out.
- Phase 6 (out of scope for v1) — Context-limit auto-supersede + Dashboard UI surface for `superseded`.

## Quick Verification Reference

```bash
bun run tsc:check
bun run lint                                # NOT lint:fix (CI runs read-only)
bash scripts/check-db-boundary.sh
bash scripts/check-api-key-boundary.sh
bun test src/tests/task-supersede-resume.test.ts
bun test                                    # full suite
bun run docs:openapi && git diff openapi.json
```

---

## Phase 1: Schema & Types

### 1.1 Migration — `src/be/migrations/079_task_status_superseded.sql` (DECISION)

The `agent_tasks.status` column is free TEXT on new databases — no CHECK constraint to extend. **Decision: do not add a migration file.** Instead, document the status taxonomy in a code comment above `AgentTaskStatusSchema` (types.ts:4) so future readers don't need to grep migrations.

> *Note: migration numbering jumps 074 → 076 on disk; 075 is intentionally missing (no plan owns it).*

### 1.2 `src/types.ts` — Add `"superseded"` to `AgentTaskStatusSchema`

```diff
   "cancelled",
+  "superseded",
```

Add a one-line code comment listing all terminal statuses so the next reader doesn't need to chase guards across `db.ts`.

### 1.3 `src/types.ts` — Add `"task_superseded"` to `AgentLogEventTypeSchema`

### 1.4 `src/be/db.ts` — Enumerated terminal-guard updates

Per-site decisions (the plan's original "three locations" was an undercount):

| Line | Site | Action |
|---|---|---|
| 1176 | `UPDATE ... SET status = CASE WHEN status IN ('completed','failed','cancelled') THEN status ELSE 'in_progress' END` (status-reset path) | **Add** `'superseded'` — a superseded task must not be flipped back to `in_progress`. |
| 1247 | `completeTask()` early-return guard | **Add** `'superseded'` — cannot complete a superseded task. |
| 1254 | `UPDATE ... WHERE status NOT IN ('completed','failed','cancelled') RETURNING *` | **Add** `'superseded'` — same reasoning. |
| 1929 | `cancelTask()` (or sibling) early-return guard | **Add** `'superseded'`. |
| 1693 | Stats `SUM(CASE WHEN status='completed' ...)` etc. | **Leave** — `superseded` is not "completed" for metrics purposes. |
| 1711 | Stats / dashboard rollup | **Leave** — same reason. |
| 1869 | Stats / dashboard rollup | **Leave**. |

Verification (Automated, see Verification block below) includes a grep that the new enum value appears in the four mutator sites and is absent from the three stats sites.

### 1.5 `src/be/db.ts` — New `supersedeTask()` function

```ts
export function supersedeTask(
  id: string,
  args: { reason: string; resumeTaskId: string | null }
): AgentTask
```

- Validates current status is `in_progress` (returns `alreadyFinished`-shaped error otherwise — match the shape of `completeTask`'s idempotency path).
- Single transaction: updates `status='superseded'`, sets `finishedAt`, writes `task_superseded` to `agent_logs` with `{ reason, resumeTaskId }` payload, emits a workflow event-bus event.
- Calls `ensure('task.superseded', { taskId: id, reason, resumeTaskId })` **after** the transaction commits (business-use instrumentation; see CLAUDE.md `<important if="...business-use...">`).

### Success Criteria

#### Automated Verification

```bash
bun run tsc:check
bun run lint
bash scripts/check-db-boundary.sh
grep -nE "'superseded'" src/be/db.ts | wc -l   # expect ≥ 5 (4 mutators + supersedeTask body)
grep -n "task_superseded" src/types.ts          # expect 1 match
```

#### Automated QA

`src/tests/task-supersede-resume.test.ts`:
- `supersedeTask()` transitions `in_progress` → `superseded` and sets `finishedAt`.
- `supersedeTask()` on already-`superseded` task returns the same idempotency shape as `completeTask()` on a completed task.
- `completeTask` / `failTask` / `cancelTask` on a `superseded` task short-circuit (terminal-guard coverage).

#### Manual Verification

In a local API server (`bun run start:http`):

```bash
# create a task, mark it in_progress, then call supersede via the route in Phase 4
curl -X POST http://localhost:3013/api/tasks/$TASK_ID/supersede \
  -H "Authorization: Bearer $AGENT_SWARM_API_KEY" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "Content-Type: application/json" \
  -d '{"reason":"graceful_shutdown"}'

# verify
sqlite3 agent-swarm-db.sqlite "SELECT status, finishedAt FROM agent_tasks WHERE id='$TASK_ID';"
sqlite3 agent-swarm-db.sqlite "SELECT eventType, payload FROM agent_logs WHERE taskId='$TASK_ID' ORDER BY createdAt DESC LIMIT 1;"
```

---

## Phase 2: Core Logic — Resume Follow-Up Creation

### 2.1 `src/tasks/worker-follow-up.ts` — New `createResumeFollowUp()` function

Key differences from `createWorkerTaskFollowUp()`:

- `taskType: "resume"` (bypasses re-delegation guard — see Phase 4.2).
- **Workflow-task carve-out** (resolves Open Question #3): if `parent.workflowRunStepId IS NOT NULL`, **do not** create a resume follow-up. Instead, return `{ kind: 'workflow-skip', stepId }` so the caller can `failTask(parent.id, 'superseded_workflow_task')` and let the workflow engine's retry/failure policy take over.
- Explicit parent-field inheritance (resolves Open Question #5 / C6). `createTaskExtended` (db.ts:2614-2640) only inherits `slack*`, `agentmail*`, `requestedByUserId`, `contextKey` — it does NOT inherit `model`, `dir`, `vcsRepo`, `vcsProvider`. We pass these explicitly from `createResumeFollowUp` rather than extending `createTaskExtended`'s central inheritance list, because changing central behavior risks regressions in unrelated follow-up flows (chosen approach (a) of C6).
- Inherited explicitly: `model`, `dir`, `vcsRepo`, `vcsProvider`. Inherited transitively via `createTaskExtended` parent-id lookup: `slackChannelId`, `slackThreadTs`, `slackUserId`, `agentmailInboxId`, `agentmailThreadId`, `requestedByUserId`, `contextKey`. Not inherited (workflow carve-out): `workflowRunId`, `workflowRunStepId`.
- Same-worker routing with **explicit liveness/capacity spec** (resolves I7): preferred worker = `parent.assignedTo`. Worker is "available" if heartbeat is within `WORKER_LIVENESS_WINDOW_SECONDS` (default 30s, env-overridable) AND current `in_progress` task count < the worker's `maxConcurrentTasks`. The check + assignment happens in the same DB transaction as `createTaskExtended` to close the race window. If unavailable, leave `assignedTo NULL` and let the regular polling routing pick it up.
- Tags: `["auto-resume", "reason:<reason>"]` where `<reason>` is constrained to the enum below (resolves I5).
- Slight priority boost (+10, capped at 100).

**Reason enum** (defined in `src/types.ts` as `ResumeReasonSchema = z.enum([...])`):

| Reason | Trigger |
|---|---|
| `graceful_shutdown` | Worker receives SIGTERM / SIGINT |
| `context_limits` | Phase 6 — context-window pressure |
| `manual_supersede` | Operator-triggered (future: dashboard button) |

### 2.2 `src/commands/context-preamble.ts` — New `buildResumeContextPreamble()`

Token budget (resolves C5):

- `CONTEXT_PREAMBLE_RESUME_MAX_TOKENS` — default `4000` (2x regular preamble). Env-overridable via `CONTEXT_PREAMBLE_RESUME_MAX_TOKENS`.
- Allocation (justifies M4 magic numbers):
  - **40% — full parent task description** (not truncated). The 200-char truncation in the regular preamble is too aggressive for resume; the resume agent needs the original brief verbatim.
  - **35% — last-N session_logs summary**. Read up to 50 recent `session_logs` rows for the parent task ID (via API; never `bun:sqlite` worker-side). Bucket by tool-call boundaries (`tool_use_id`) and emit per-tool one-line summaries: `[12:03:11] Read src/foo.ts (256 lines)`, `[12:03:14] Edit src/foo.ts (+12/-3)`, etc. This is the single biggest correctness lever — without tool-call history the resume agent will redo completed work. **The summary lines MUST pass through `scrubSecrets` before insertion** (resolves I2).
  - **15% — in-progress artifacts/attachments index**. Names + sizes only — content is read on-demand if the resume agent decides to.
  - **10% — fixed framing**: "Resuming Interrupted Task" header, continuation instructions ("Do not redo work already completed below — extend it"), task ID linkage.
- Hard cap on total chars (`CONTEXT_PREAMBLE_RESUME_MAX_TOKENS * 4`); truncates the session-log summary section first (FIFO from oldest), then artifacts, never the task description.

### Success Criteria

#### Automated Verification

```bash
bun run tsc:check
bun run lint
bash scripts/check-db-boundary.sh
grep -n 'from.*be/db' src/commands/context-preamble.ts  # expect zero matches
grep -n 'from.*be/db' src/tasks/worker-follow-up.ts     # expect zero matches
grep -n 'scrubSecrets'  src/commands/context-preamble.ts # expect ≥ 1 match (in buildResumeContextPreamble)
```

#### Automated QA

`src/tests/task-supersede-resume.test.ts`:
- `createResumeFollowUp()` with `parent.workflowRunStepId === null` creates a task with `taskType="resume"`, `parentTaskId` set, inherited `model` / `dir` / `vcsRepo` / `vcsProvider`.
- `createResumeFollowUp()` with `parent.workflowRunStepId !== null` returns `{ kind: 'workflow-skip', stepId }` and does NOT create a task.
- Routing: when the parent's `assignedTo` worker has a fresh heartbeat + capacity, the resume task is pre-assigned. When stale OR at capacity, `assignedTo` is `NULL`.
- `buildResumeContextPreamble()` honors the 4000-token cap, never truncates the task description, and a sample preamble containing a fake bearer token has the token scrubbed.

#### Manual Verification

Build a preamble manually and inspect it:

```bash
bun run src/cli.tsx debug-build-resume-preamble --task-id "$TASK_ID" | less
# Check: header present, full description present, last tool-call lines present, no plaintext secrets.
```

---

## Phase 3: Trigger Integration — Graceful Shutdown

### 3.1 `src/commands/runner.ts` — New `supersedeTaskViaAPI()` helper

Mirrors `pauseTaskViaAPI` (line 1018). HTTP `POST` to `/api/tasks/{id}/supersede` with `{ reason }` body. Returns `{ ok: true, resumeTaskId }` on success.

### 3.2 `src/commands/runner.ts` — Update shutdown handler (line 1194)

Replace the existing `pauseTaskViaAPI(...)` call. Fallback chain:

1. `supersedeTaskViaAPI(...)` — primary.
2. If supersede returns 5xx / network error, fall through to `pauseTaskViaAPI(...)` (legacy, still works) — preserves graceful behavior during partial deploys where API is older than worker.
3. If both fail, `failTask(...)` with reason `worker_shutdown_failed_supersede`.

### 3.3 `src/commands/runner.ts` — Legacy resume-on-boot safety net (kept)

Existing boot-time `paused`-task scanner stays. Add a comment block above it documenting:

- This is a safety net for tasks paused by old worker builds during partial-deploy windows.
- Cleanup plan: see Appendix — Follow-up Plans.

### 3.4 `src/commands/runner.ts` — Context preamble dispatch in poll loop

When the poll loop picks up a task with `taskType === "resume"`, call `buildResumeContextPreamble()` instead of `buildContextPreamble()`. Otherwise unchanged.

### 3.5 `src/http/tasks.ts` (preview of Phase 4 route) — Workflow-task carve-out

The route handler (Phase 4.1) calls `createResumeFollowUp()` first. If the return is `{ kind: 'workflow-skip' }`, the route instead invokes `failTask(parentId, 'superseded_workflow_task')` and emits a `workflow.step.failed` event, returning `{ success: true, kind: 'workflow-failed', resumeTaskId: null }`. The worker treats this as a successful supersede call (no fallback to legacy pause).

### Success Criteria

#### Automated Verification

```bash
bun run tsc:check
bun run lint
bash scripts/check-db-boundary.sh
bash scripts/check-api-key-boundary.sh
grep -n 'from.*be/db' src/commands/runner.ts  # expect zero matches
grep -n 'supersedeTaskViaAPI' src/commands/runner.ts  # expect ≥ 2 (definition + call site)
```

#### Automated QA

Extend `src/tests/runner-context-preamble.test.ts` (or add to `task-supersede-resume.test.ts`):
- Poll loop with `taskType="resume"` dispatches to `buildResumeContextPreamble`.
- Shutdown handler fallback chain: mock the API to return 500 → expect `pauseTaskViaAPI` call → mock that to fail → expect `failTask`.

#### Manual Verification

```bash
# 1. Start a worker with a small max-concurrent and one in-progress task.
bun run pm2-start
# 2. Send SIGTERM to the worker container:
docker exec -it $WORKER_CONTAINER kill -TERM 1
# 3. Watch logs:
bun run pm2-logs | grep -E "supersede|resume"
# 4. Verify in DB: original task superseded, resume task pending or in_progress.
sqlite3 agent-swarm-db.sqlite "SELECT id, status, taskType, parentTaskId, assignedTo FROM agent_tasks WHERE id='$TASK_ID' OR parentTaskId='$TASK_ID';"
```

---

## Phase 4: API & Guard Updates

### 4.1 `src/http/tasks.ts` — New `POST /api/tasks/{id}/supersede` route

Use the `route()` factory (CLAUDE.md mandate — `src/http/tasks.ts` already uses it; do NOT use raw `matchRoute`):

```ts
const supersedeTaskRoute = route({
  method: "POST",
  path: "/api/tasks/:id/supersede",
  // ...zod request/response schemas...
  handler: async (req, ctx) => { ... },
});
```

- Validates task is `in_progress` AND owned by requesting agent (`X-Agent-ID` matches `assignedTo`).
- Calls `createResumeFollowUp({ parentId: id, reason })`:
  - If `{ kind: 'workflow-skip' }` → `failTask(id, 'superseded_workflow_task')`, emit `workflow.step.failed`, return `{ success, kind: 'workflow-failed', resumeTaskId: null, task }`.
  - Otherwise → `supersedeTask(id, { reason, resumeTaskId: resume.id })`, return `{ success, kind: 'resumed', task, resumeTaskId, resumeTaskStatus }`.
- All state mutations followed by `ensure(...)` (business-use instrumentation, I1).

### 4.2 `src/tools/send-task.ts` — Clarify re-delegation guard exemption

Existing guard checks `taskType === "follow-up"`. `"resume"` is a distinct value and naturally bypasses. Add a one-line comment so the next reader doesn't add `taskType === "resume"` to the guard.

### 4.3 `src/tools/store-progress.ts` — Add `"superseded"` to terminal status check

Prevents agents from racing a status-overwrite into a `superseded` task. Search for the existing `["completed", "failed", "cancelled"]` literal and add `"superseded"`. Also re-check any reads of `task.status` in this file that conditionally fork on terminal status.

### 4.4 `scripts/generate-openapi.ts` — Import `supersedeTaskRoute`

Required so the new route appears in `openapi.json`. Verification step below regenerates and checks.

### Success Criteria

#### Automated Verification

```bash
bun run tsc:check
bun run lint
bun run docs:openapi
grep 'supersede' openapi.json  # expect path + schema matches
git diff openapi.json           # expect changes (commit them)
```

#### Automated QA

`src/tests/task-supersede-resume.test.ts`:
- HTTP `POST /api/tasks/:id/supersede` happy path returns `{ success: true, kind: 'resumed', resumeTaskId }`.
- Ownership: same call from a different `X-Agent-ID` returns 403.
- Idempotency: second supersede on a now-`superseded` task returns the same shape (`alreadyFinished`-style).
- Workflow carve-out: a task with `workflowRunStepId` set returns `{ kind: 'workflow-failed', resumeTaskId: null }` and the task ends `failed` (not `superseded`).

#### Manual Verification

```bash
# Workflow carve-out manual check
TASK_ID=...  # a task that has workflowRunStepId set
curl -X POST http://localhost:3013/api/tasks/$TASK_ID/supersede \
  -H "Authorization: Bearer $AGENT_SWARM_API_KEY" \
  -H "X-Agent-ID: $AGENT_ID" -H "Content-Type: application/json" \
  -d '{"reason":"graceful_shutdown"}'
# Expect: response.kind === "workflow-failed", task.status === "failed", no child resume task.
```

---

## Phase 5: Testing

### 5.1 `src/tests/task-supersede-resume.test.ts` (create)

Covers (each item resolves an I8 gap):

- `supersedeTask()` status transition (`in_progress` → `superseded`).
- Terminal guard inclusion at all four mutator sites (parameterize over `completeTask`/`failTask`/`cancelTask`).
- `createResumeFollowUp()` happy path: routing + field inheritance.
- `createResumeFollowUp()` workflow carve-out: returns `{ kind: 'workflow-skip' }`, creates no task.
- Routing fallback: same worker stale heartbeat → unassigned; same worker at capacity → unassigned.
- HTTP route happy path + ownership + idempotency (per Phase 4 spec).
- Preamble: 4000-token cap, full-description preservation, `scrubSecrets` on log summary lines.
- SIGTERM end-to-end (integration): spawn an in-process worker mock, send SIGTERM, assert supersede call + resume task created.
- Double-supersede idempotency at the HTTP layer.

### Success Criteria

#### Automated Verification

```bash
bun test src/tests/task-supersede-resume.test.ts
bun test  # full suite
```

#### Automated QA

The unit/integration test file IS the QA artifact for this feature. Coverage targets:

- All four mutator-site guards exercised.
- Both routing branches (same-worker pre-assign vs. pool) exercised.
- Workflow carve-out branch exercised.

#### Manual Verification

CI must be green on the PR. No additional manual step.

---

## Manual E2E

Concrete commands against a local stack (set `TASK_ID`, `AGENT_ID`, `AGENT_SWARM_API_KEY` env vars). Run after `bun run start:http` (API on `:3013`):

```bash
# --- 1. Spin up worker + create a task ---
bun run pm2-start
# Use the CLI to create a worker, then create + assign a task and start it.
# (Substitute your local worker creation flow; see LOCAL_TESTING.md for the exact pattern.)
TASK_ID="task_..."     # an in_progress task assigned to AGENT_ID
AGENT_ID="agent_..."   # the worker handling TASK_ID

# --- 2. Sanity: confirm task is in_progress ---
curl -s "http://localhost:3013/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $AGENT_SWARM_API_KEY" \
  -H "X-Agent-ID: $AGENT_ID" | jq '.status'
# expect: "in_progress"

# --- 3. Supersede ---
curl -X POST "http://localhost:3013/api/tasks/$TASK_ID/supersede" \
  -H "Authorization: Bearer $AGENT_SWARM_API_KEY" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "Content-Type: application/json" \
  -d '{"reason":"graceful_shutdown"}' | jq
# expect: { success: true, kind: "resumed", resumeTaskId: "task_...", task: { status: "superseded", ... } }

RESUME_ID=$(curl -s ... | jq -r '.resumeTaskId')  # capture from previous response

# --- 4. Verify original is terminal ---
curl -s "http://localhost:3013/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $AGENT_SWARM_API_KEY" -H "X-Agent-ID: $AGENT_ID" \
  | jq '{status, finishedAt}'
# expect: status="superseded", finishedAt set

# --- 5. Verify resume task is correct ---
curl -s "http://localhost:3013/api/tasks/$RESUME_ID" \
  -H "Authorization: Bearer $AGENT_SWARM_API_KEY" -H "X-Agent-ID: $AGENT_ID" \
  | jq '{taskType, parentTaskId, model, dir, vcsRepo, vcsProvider, assignedTo, status}'
# expect: taskType="resume", parentTaskId=TASK_ID, model/dir/vcsRepo/vcsProvider inherited,
#         assignedTo=AGENT_ID (if heartbeat fresh + capacity) else null, status="pending" or "in_progress"

# --- 6. Try to complete the superseded task — must short-circuit ---
curl -X POST "http://localhost:3013/api/tasks/$TASK_ID/finish" \
  -H "Authorization: Bearer $AGENT_SWARM_API_KEY" -H "X-Agent-ID: $AGENT_ID" \
  -H "Content-Type: application/json" \
  -d '{"status":"completed","result":"x"}' | jq
# expect: alreadyFinished-shaped response, task unchanged

# --- 7. Graceful-shutdown trigger end-to-end ---
# Pick a worker container running an in_progress task and SIGTERM it:
docker exec -it "$WORKER_CONTAINER" kill -TERM 1
bun run pm2-logs --lines 200 | grep -E "supersede|task_superseded|resume"
# expect: a "supersedeTaskViaAPI" log followed by a resume-task-created log

# --- 8. Workflow carve-out ---
# (Requires a task with workflowRunStepId set — see runbooks/workflows.md to create one.)
WORKFLOW_TASK_ID="task_..."
curl -X POST "http://localhost:3013/api/tasks/$WORKFLOW_TASK_ID/supersede" \
  -H "Authorization: Bearer $AGENT_SWARM_API_KEY" -H "X-Agent-ID: $AGENT_ID" \
  -H "Content-Type: application/json" \
  -d '{"reason":"graceful_shutdown"}' | jq '.kind, .resumeTaskId'
# expect: "workflow-failed", null
# verify original task status:
curl -s "http://localhost:3013/api/tasks/$WORKFLOW_TASK_ID" \
  -H "Authorization: Bearer $AGENT_SWARM_API_KEY" -H "X-Agent-ID: $AGENT_ID" \
  | jq '.status'
# expect: "failed" (engine retry/failure policy now applies)
```

---

## Appendix

### Follow-up Plans

- **Phase 6 — Context-limit auto-supersede trigger.** Wire compaction-event detection in the worker to call `supersedeTaskViaAPI` proactively when the provider session approaches context limits. Out of scope for v1.
- **Legacy paused-task cleanup.** After this plan is deployed everywhere, the boot-time `paused`-task scanner in `runner.ts` and the entire `paused` status path can be removed. Track as a separate plan after one quarter of clean signal that no new `paused` tasks are being created.
- **Dashboard UI: `superseded` badge + filter.** Add a status badge color and a filter chip in `ui/`. Should also surface the `parentTaskId → resumeTaskId` lineage in the task detail view.

### Derail Notes

- Considered but rejected: re-using provider `--resume` session ID on the new task. Rejected because session IDs are not portable across hosts and the very triggers we care about (container shutdown, context pressure) often invalidate the session.
- Considered but rejected: keeping `paused` as the canonical state and adding a `resumeTaskId` column. Rejected — `paused` is non-terminal, which means downstream logic that filters terminal tasks (stats, dashboards, completion checks) all need a special case; an explicit terminal `superseded` is cleaner.

### References

- `src/tasks/worker-follow-up.ts` — existing follow-up plumbing
- `src/commands/context-preamble.ts:14-19` — existing token budget constants
- `src/commands/runner.ts:1018,1194` — existing pause flow
- `src/be/db.ts:2614-2640` — `createTaskExtended` inheritance list
- `src/http/tasks.ts:34,195,207` — existing `route()` factory usage + pause routes
- CLAUDE.md `<important if="adding or modifying database schema or migrations">`
- CLAUDE.md `<important if="adding or modifying HTTP API endpoints">`
- CLAUDE.md `<important if="adding business-use instrumentation or events">`
- CLAUDE.md `<important if="writing code that logs, prints, stores, or transports sensitive values">`

### Open Questions (resolved by this revision)

| # | Question | Resolution |
|---|---|---|
| 1 | Context-limit auto-supersede? | Phase 6, out of v1 scope. Tracked in Follow-up Plans. |
| 2 | Legacy paused tasks cleanup migration? | No migration. Legacy resume-on-boot stays as safety net; full removal tracked in Follow-up Plans. |
| 3 | Workflow tasks | **Carved out.** See Phase 2.1 + Phase 3.5 + Phase 4.1 — workflow tasks `fail` instead of supersede; no resume follow-up. |
| 4 | Dashboard UI for `superseded` | Out of v1 scope. Tracked in Follow-up Plans. |
| 5 | `createTaskExtended` model inheritance gap | **Resolved.** `createResumeFollowUp` reads parent and passes `model`, `dir`, `vcsRepo`, `vcsProvider` explicitly. Central `createTaskExtended` is left unchanged to avoid regressions in other follow-up flows. |

---

## Review Errata

_Reviewed: 2026-05-29 by claude (autonomy=critical, output=auto-apply)_

### Applied — Critical

- [x] **C1 — Missing required plan sections.** Added Overview (Motivation + Related), Current State Analysis, Desired End State, What We're NOT Doing, Implementation Approach (one-liners), Quick Verification Reference, and Appendix.
- [x] **C2 — Manual E2E rewritten as concrete commands** with env-var placeholders, including curl/jq for happy path, terminal-guard short-circuit, SIGTERM end-to-end, and workflow carve-out.
- [x] **C3 — Workflow-task carve-out added.** `createResumeFollowUp` returns `{ kind: 'workflow-skip' }` for workflow-step tasks; route falls back to `failTask` so the workflow engine handles recovery. Spec wired through Phases 2.1, 3.5, and 4.1.
- [x] **C4 — Terminal-guard sites enumerated per-line** in Phase 1.4. Five mutator sites get `superseded`; three stats sites are explicitly left alone.
- [x] **C5 — Fresh-session continuity spec expanded.** Phase 2.2 now defines a 4000-token budget broken down as 40% description / 35% session-log tool-call summary / 15% artifacts / 10% framing, reads from `session_logs`, and passes summary lines through `scrubSecrets`.
- [x] **C6 — Inheritance approach chosen (option a).** `createResumeFollowUp` explicitly reads parent and passes `model`, `dir`, `vcsRepo`, `vcsProvider`; `createTaskExtended` left unchanged.

### Applied — Important

- [x] **I1 — Business-use instrumentation** noted at Phase 1.5 (`supersedeTask`) and Phase 4.1 (route handler).
- [x] **I2 — `scrubSecrets`** added to Phase 2.2 preamble spec + automated-verification grep.
- [x] **I3 — Phase verification subsections restructured** into Automated Verification / Automated QA / Manual Verification across all five phases.
- [x] **I4 — Phase 1.1 migration approach corrected.** No migration file; document in code comment instead.
- [x] **I5 — Reason enum defined** (`graceful_shutdown` / `context_limits` / `manual_supersede`) as `ResumeReasonSchema`.
- [x] **I6 — Legacy pause-resume cleanup** explicitly marked out of scope in "What We're NOT Doing" with a Follow-up Plan reference.
- [x] **I7 — Same-worker liveness/capacity spec added** (30s heartbeat window, capacity check vs `maxConcurrentTasks`, same-transaction assignment).
- [x] **I8 — Phase 5 test coverage expanded** to include workflow carve-out, routing fallback (stale + capacity), preamble cap, SIGTERM end-to-end, double-supersede idempotency.
- [x] **I9 — Dashboard UI** explicitly out of v1 scope, tracked in Follow-up Plans.

### Applied — Minor

- [x] **M1** — `planner: claude` added to frontmatter.
- [x] **M2** — Open Questions moved into Appendix as a resolution table.
- [x] **M3** — Migration numbering 074 → 076 gap noted inline in Phase 1.1.
- [x] **M4** — Magic numbers (4000 tokens, allocation %, +10 priority) justified inline in Phase 2.2 / 2.1.
- [x] **M5** — file:line references added throughout (`runner.ts:1018`, `db.ts:2614-2640`, etc.).

### Remaining

None. All findings auto-applied per `--output=auto-apply` and the user's authorization to apply Criticals.

### Reviewer notes for the planner

Two assumption-level calls I made on the planner's behalf — worth a sanity check before implementation:

1. **C3 carve-out direction.** I chose "workflow tasks fail back to the engine" rather than "workflow tasks supersede inside the engine's lifecycle." The fail-back is simpler and matches how `createWorkerTaskFollowUp` already treats workflow tasks, but if the engine has retry policies that interact badly with a `failed` step at this boundary, you may want to instead emit a dedicated `workflow.step.superseded` event and let the engine choose.
2. **C5 session_logs read path.** I specified "via API; never `bun:tsqlite` worker-side" since `buildResumeContextPreamble` runs in the worker. If there's no existing endpoint to fetch session_logs for a task, add one in Phase 4 (or expose via the existing context-bundle endpoint if one exists).
