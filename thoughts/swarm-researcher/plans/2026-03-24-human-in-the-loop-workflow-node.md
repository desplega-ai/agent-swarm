---
date: 2026-03-24T00:00:00Z
author: Picateclas
topic: "Implementation Plan: Human-in-the-Loop Workflow Node"
tags: [plan, hitl, workflows, human-in-the-loop]
status: proposed
repository: desplega-ai/agent-swarm
related_research: thoughts/swarm-researcher/research/2026-03-24-human-in-the-loop-workflow-node.md
pr: "#230"
---

# Implementation Plan: Human-in-the-Loop Workflow Node

Based on the [HITL research doc](../research/2026-03-24-human-in-the-loop-workflow-node.md), this plan breaks the feature into concrete implementation phases.

---

## Phase 1: Core (MVP)

### 1.1 Database Migration — `019_approval_requests.sql`

**File:** `src/be/migrations/019_approval_requests.sql`

Create the `approval_requests` table with:
- `id` (TEXT PK, UUID)
- `title` (TEXT NOT NULL)
- `questions` (JSONB NOT NULL) — array of Question objects (approval, text, single-select, multi-select, boolean)
- `workflow_run_id` / `workflow_step_id` — FK to workflow tables (for workflow-sourced requests)
- `source_task_id` — FK to tasks (for agent-tool-sourced requests)
- `approvers` (JSONB NOT NULL) — `{ users, roles, policy }`
- `status` (TEXT, default 'pending') — pending | approved | rejected | timeout
- `responses` (JSONB) — keyed by question ID
- `resolved_by`, `resolved_at`
- `timeout_seconds`, `expires_at`
- `notification_channels` (JSONB)
- `created_at`, `updated_at`

Indexes: status, created_at DESC, workflow_run_id, source_task_id, expires_at (partial, WHERE status='pending').

**Testing:** Verify with fresh DB (`rm agent-swarm-db.sqlite && bun run start:http`) and existing DB (incremental migration).

### 1.2 HITL Executor

**File:** `src/workflows/executors/human-in-the-loop.ts`

Register a new executor type `human-in-the-loop` in the executor registry.

Executor logic:
1. Parse node config: `title`, `questions`, `approvers`, `timeout`, `notifications`
2. Interpolate template variables in `title` and question labels
3. Create an `approval_request` record via HTTP POST `/api/approval-requests`
4. Return `{ async: true, waitFor: "approval.resolved", correlationId: requestId }`
5. Engine checkpoints the step as "waiting"

Output ports: `approved`, `rejected`, `timeout`

### 1.3 Event Bus — `approval.resolved` Event

**File:** `src/workflows/event-bus.ts`

Add new event type `approval.resolved` alongside existing task/github/slack events. Emitted when an approval request is resolved (approved, rejected, or timed out).

### 1.4 Resume Handler

**File:** `src/workflows/resume.ts`

Add a listener for `approval.resolved` events:
1. Look up the workflow_run_step by correlationId (the approval request ID)
2. Checkpoint the step with response data
3. Determine output port: `approved` / `rejected` / `timeout` (based on response — if any approval question has `approved: false` → rejected)
4. Continue workflow execution via the appropriate port

### 1.5 Recovery Handler

**File:** `src/workflows/recovery.ts`

Extend `recoverIncompleteRuns()` to handle approval-waiting runs:
1. Query `workflow_run_steps` with status "waiting" where correlationId maps to `approval_requests`
2. For resolved requests: checkpoint step and resume workflow
3. For expired-during-downtime requests: auto-reject, resume via "timeout" port
4. For still-pending/not-expired: leave as-is (normal event flow handles them)

### 1.6 API Endpoints

**File:** `src/http/approval-requests.ts`

All endpoints use the `route()` factory from `src/http/route-def.ts`:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/approval-requests` | Create a new approval request |
| GET | `/api/approval-requests/{id}` | Get request details |
| POST | `/api/approval-requests/{id}/respond` | Submit response |
| GET | `/api/approval-requests` | List requests (history, filterable) |

After creating:
1. Import and add to handler chain in `src/http/index.ts`
2. Add import to `scripts/generate-openapi.ts`
3. Run `bun run docs:openapi` to regenerate `openapi.json`

### 1.7 MCP Tool — `request-human-input`

**File:** `src/tools/request-human-input.ts`

MCP tool that agents can call to create approval requests. Calls HTTP POST `/api/approval-requests` (never touches DB directly — respects worker/API boundary).

Parameters: `title`, `questions` array, `approvers`, `timeout`.
Returns: `{ requestId, url }` (URL to web UI for the request).

### 1.8 Web UI — Request Response Page

**File:** `new-ui/` (Next.js dashboard)

Page at `APP_URL/requests/:id`:
- Renders questions dynamically by type (approval → buttons, text → input, select → radio/checkbox, boolean → toggle)
- Validates required fields and multi-select constraints
- Submits response via POST `/api/approval-requests/{id}/respond`
- Shows status (pending/resolved) and response data after submission

### 1.9 Slack Notification

**Files:** `src/slack/` handlers

When a HITL node creates an approval request with Slack notification config:
1. Post message to target channel/user with request summary + link to web UI
2. For simple approval-only requests: include inline Approve/Reject buttons
3. Register Slack action handlers in `src/slack/actions.ts` for inline buttons
4. On resolution: update original Slack message with outcome (threads only)

---

## Phase 2: Polish

### 2.1 History UI

Page at `APP_URL/requests` — read-only list of all past/resolved requests. Filterable by status, workflow, date. Links to detail pages.

### 2.2 Slack Thread Updates

After resolution, update the original Slack message with the outcome. Only in threads, no random channel messages.

### 2.3 Agent Tool Integration

Full integration allowing agents to create ad-hoc approval requests outside of workflows via the `request-human-input` MCP tool. Response delivered as a follow-up task linked via `parentTaskId`.

### 2.4 Timeout Worker

Background job (cron or interval) that:
1. Queries `approval_requests` where `expires_at < NOW()` and `status = 'pending'`
2. Auto-rejects expired requests
3. Emits `approval.resolved` event to resume waiting workflows

### 2.5 N-of-M Approval

Track multiple responders per request. Resolve when policy is met (`any` = first response, `all` = all must respond, `{ min: N }` = N responses needed).

---

## Phase 3: Future

- Email notifications with approve/reject links
- Conditional questions (show question B only if question A answer is X)
- File upload question type
- Rich text / markdown in question descriptions

---

## Implementation Order (Recommended)

1. **Migration** (1.1) — foundation, no dependencies
2. **API endpoints** (1.6) — needed by everything else
3. **Executor** (1.2) + **Event bus** (1.3) — core workflow integration
4. **Resume handler** (1.4) — complete the async loop
5. **Recovery handler** (1.5) — resilience (blocking per research doc)
6. **MCP tool** (1.7) — agent-facing interface
7. **Web UI** (1.8) — human-facing interface
8. **Slack** (1.9) — notification channel

Each step should be a separate PR or commit for clean review.

---

## Key Architecture Constraints

- **Worker/API boundary**: Workers call HTTP APIs, never import `src/be/db`. Enforced by `scripts/check-db-boundary.sh`.
- **`route()` factory**: All new HTTP endpoints must use it (from `src/http/route-def.ts`). No raw `matchRoute`.
- **Migration naming**: Next number is `019`. Use `IF NOT EXISTS` for safety.
- **Slack actions**: Register in `src/slack/actions.ts`, not `app.ts`.
- **`inputs` mapping**: Downstream nodes must declare `inputs` to access HITL response data.
- **Timeout = rejected**: No escalation chains in v1.

---

## Pre-PR Checklist (per change)

```bash
bun run lint:fix
bun run tsc:check
bun test
bash scripts/check-db-boundary.sh
```

For UI changes:
```bash
cd new-ui && pnpm lint && pnpm exec tsc --noEmit
```
