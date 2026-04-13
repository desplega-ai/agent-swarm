---
date: 2026-03-24T00:00:00Z
researcher: Researcher
topic: "Human-in-the-Loop Workflow Node"
tags: [research, hitl, workflows, human-in-the-loop]
status: complete
repository: desplega-ai/agent-swarm
---

# Human-in-the-Loop Node Type for Agent Swarm Workflows

**Date:** 2026-03-24
**Author:** Researcher (agent-swarm)
**Status:** Research / Design Proposal (Updated with Taras's review feedback + Reviewer's gap analysis)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Existing Approaches in Workflow Systems](#2-existing-approaches-in-workflow-systems)
3. [Our Workflow Engine: Current State](#3-our-workflow-engine-current-state)
4. [Proposed Design: `human-in-the-loop` Node Type](#4-proposed-design-human-in-the-loop-node-type)
5. [Notification & Approval Channels](#5-notification--approval-channels)
6. [Database Schema Changes](#6-database-schema-changes)
7. [Security Considerations](#7-security-considerations)
8. [Implementation Recommendations](#8-implementation-recommendations)
9. [Open Questions (Resolved)](#9-open-questions-resolved)

---

## 1. Executive Summary

Taras wants a new workflow node type that **pauses execution and waits for human approval/input** before continuing. This enables workflows where critical decisions require human review — e.g., approving a PR merge, reviewing generated content before publishing, or authorizing a deployment.

After researching 7 major workflow systems and analyzing our existing engine architecture, I propose a **generic approval/request system** that serves dual purposes:

1. **As a workflow executor** (`human-in-the-loop` node type) — pauses a workflow run and resumes on approval
2. **As an agent tool** — any agent can send a question/request to a user via an MCP tool that calls the HTTP API (never direct DB access from worker code)

The system:

- Leverages our existing **async executor pattern** (same as `agent-task`) to pause and resume workflows
- Uses a **web UI as the primary channel** (`APP_URL/requests/<id>`) with Slack/email as additional parallel notification mechanisms
- Supports **multi-question approval requests** with rich input types: approval, text, single-select, **multi-select**, and boolean
- Each request contains a **`questions` JSONB array** — extending the `AskUserQuestion` tool format to support multiple questions per request
- Handles **timeouts** by treating them as **rejected** (no escalation chains in v1)
- Supports **N-of-M approver policies**
- Uses a new generic **`approval_requests`** table for state tracking (migration `019_approval_requests.sql`)
- Provides a **read-only history UI** to view all past/resolved requests
- Includes **recovery handling** for approval requests that expire or resolve during server downtime

---

## 2. Existing Approaches in Workflow Systems

### 2.1 GitHub Actions — Environment Protection Rules

**Mechanism:** Jobs targeting a protected environment are paused until required reviewers approve. The workflow run enters a "waiting" state visible in the GitHub UI.

**Notification:** Reviewers receive email and GitHub UI notifications. No native Slack integration (though third-party Actions like `trstringer/manual-approval` use GitHub Issues with comments as an approval mechanism).

**Approval:** Reviewers approve/reject via the GitHub UI (or API). An optional review comment can be added (text only, not structured data).

**Timeout:** Configurable wait timer, default 30 days. On timeout, the run is **cancelled** (not failed — important distinction).

**Multiple approvers:** Up to 6 required reviewers per environment. **Any one** of the required reviewers can approve (1-of-N). No support for requiring multiple approvals (N-of-M).

**Data passing:** No structured data passing. Only a free-text comment on approval.

**Key insight:** Simple approve/reject model. Environment-scoped (not per-step). The timeout-cancels-run behavior is notable.

### 2.2 Temporal — Signals and Activities

**Mechanism:** Temporal offers two patterns for human interaction:
1. **Signals**: The workflow calls `workflow.wait_condition()` waiting for a signal. External code (UI, API) sends a signal to the workflow, which resumes.
2. **Activities with task tokens**: An activity can return a task token, and external code completes it later via `asyncComplete()`.

**Notification:** Temporal has no built-in notification. The application must implement notifications (email, Slack, etc.) as a separate activity before the wait.

**Approval:** Via Temporal's signal API (`client.get_workflow_handle().signal()`). Signals can carry arbitrary typed payloads.

**Timeout:** Built-in via `workflow.wait_condition(timeout=timedelta(...))`. On timeout, the condition returns `False` and the workflow decides what to do (fail, retry, escalate).

**Multiple approvers:** Modeled as application logic. The workflow accumulates signals in a list and checks `len(approvals) >= required` in its wait condition. Fully flexible N-of-M.

**Data passing:** Signals carry arbitrary typed data. Full structured input support.

**Key insight:** Most flexible approach. The workflow is a long-running program, not a config-driven DAG. Signals + wait conditions are the gold standard for HITL. Our design should aim for this level of flexibility within our config-driven model.

### 2.3 n8n — Wait Node

**Mechanism:** The Wait node pauses execution and creates a unique **webhook URL**. The workflow resumes when that URL is called (via form submission, API call, or another system). State is persisted to the database.

**Notification:** n8n doesn't auto-notify. Users add a Send Email or Slack node before the Wait node to notify approvers, passing the resume webhook URL.

**Approval:** Via the generated webhook URL. The incoming HTTP request body becomes available to downstream nodes. n8n also supports Form nodes that render an HTML form at the webhook URL, collecting structured input.

**Timeout:** Configurable "Resume after" duration (e.g., 1 hour). On timeout, the workflow continues via a "timeout" output branch (allowing different handling).

**Multiple approvers:** No built-in support. Would require custom logic (multiple Wait nodes or external aggregation).

**Data passing:** Full support — the HTTP request body or form submission data flows into the workflow context.

**Key insight:** The webhook-URL-as-resume-token pattern is elegant and channel-agnostic. The timeout-as-separate-branch pattern is very useful. We should adopt both ideas.

### 2.4 Zapier — Human in the Loop

**Mechanism:** Zapier's HITL is a built-in action type. When a Zap reaches a HITL step, it pauses and sends a notification to assigned users. The Zap's run shows as "Waiting" in the dashboard.

**Notification:** Zapier sends notifications through its own UI/email system. The assigned user sees a task in their Zapier dashboard with context from previous steps.

**Approval:** Users approve, reject, or provide data via the Zapier dashboard. Three modes:
1. **Request Approval** — approve/reject binary choice
2. **Collect Data** — form fields for structured input (text, number, dropdown, date, boolean)
3. **Pause for Review** — displays data for review before continuing

**Timeout:** No automatic timeout in the HITL step itself. The Zap remains paused indefinitely until human action.

**Multiple approvers:** Single assignee. No N-of-M support. Can assign to "anyone in the workspace."

**Data passing:** Full structured data via form fields. Fields are defined in the Zap configuration and values flow to subsequent steps.

**Key insight:** The three modes (approve, collect data, review) are a useful UX taxonomy. The form-field approach for data collection is clean. We should support all three patterns.

### 2.5 AWS Step Functions — Callback Pattern (waitForTaskToken)

**Mechanism:** A state uses the `.waitForTaskToken` integration pattern. Step Functions generates a unique **task token** and passes it to a service (SNS, SQS, Lambda). The execution pauses until `SendTaskSuccess(taskToken, output)` or `SendTaskFailure(taskToken, error)` is called.

**Notification:** Not built-in. The pattern typically: (1) Lambda publishes to SNS topic → email with approve/reject links, or (2) publishes to SQS → custom UI reads and presents approval form.

**Approval:** Via `SendTaskSuccess(taskToken, outputJSON)` or `SendTaskFailure(taskToken, error, cause)` API calls. The approve/reject links in emails typically hit an API Gateway → Lambda that calls SendTaskSuccess/Failure.

**Timeout:** `HeartbeatSeconds` and `TimeoutSeconds` on the task state. On timeout, a `States.Timeout` error is thrown, catchable by a Catch block for custom handling (retry, notify, fail).

**Multiple approvers:** Not built-in. Must be modeled with a parallel state or external aggregation logic.

**Data passing:** `SendTaskSuccess` accepts arbitrary JSON output that flows into the state machine's context.

**Key insight:** The task-token pattern is the canonical approach for durable async resume. We already use a similar pattern with our `agent-task` executor (correlation via task ID). The email-with-approval-links pattern (API Gateway → Lambda → SendTaskSuccess) maps well to our email notification design.

### 2.6 Prefect — Pause and Resume with Inputs

**Mechanism:** `pause_flow_run(wait_for_input=ApprovalSchema)` suspends the flow run. The run enters a "Paused" state. It resumes when input is submitted via the Prefect UI or API (`resume_flow_run(run_id, data)`).

**Notification:** Prefect Cloud sends notifications to configured channels (Slack, email, PagerDuty) via Automations. Can trigger on "Flow run paused" events.

**Approval:** Via Prefect UI form (auto-generated from the Pydantic schema) or API call. The `wait_for_input` parameter defines the schema — can be a simple approve/reject or complex structured data.

**Timeout:** `pause_flow_run(timeout=300)` — on timeout, the flow run fails with a `Paused` exception, catchable for custom handling.

**Multiple approvers:** No built-in support. Single resume action.

**Data passing:** Full Pydantic model support. The schema defines fields with types, defaults, and validation. Returned data is typed and validated.

**Key insight:** Using a schema to define what input is needed from the human is excellent. Auto-generating UI forms from the schema (Pydantic/JSON Schema) is a powerful pattern. We should use JSON Schema for our `inputSchema` — it aligns with our existing `inputSchema`/`outputSchema` pattern on nodes.

### 2.7 Retool Workflows — Human-in-the-Loop Blocks

**Mechanism:** "Human in the Loop" block type pauses the workflow and presents a form in the Retool UI. The form is rendered from a connected Retool App. The workflow waits until the form is submitted.

**Notification:** Email notifications to assigned users with a link to the form. Slack integration available via separate blocks before the HITL block.

**Approval:** Via the Retool UI form. Rich form capabilities (dropdowns, text fields, file uploads, conditional fields).

**Timeout:** Configurable timeout. On timeout, the workflow can fail or continue via a timeout branch.

**Multiple approvers:** No built-in N-of-M. Single approver.

**Data passing:** Full structured data via form submissions.

**Key insight:** The form-first approach is great for complex data collection but requires a UI. For our headless system, Slack interactive messages and email forms are the closest equivalents.

### 2.8 Summary Comparison

| System | Pause Mechanism | Notification | Data Input | Timeout | N-of-M |
|--------|----------------|--------------|------------|---------|--------|
| GitHub Actions | Environment gate | Email/UI | Comment only | Cancel after N days | 1-of-N |
| Temporal | Signal + wait_condition | Custom (activity) | Typed signal payload | wait_condition timeout | Custom logic |
| n8n | Webhook URL | Custom (pre-Wait node) | HTTP body / Form | Timeout branch | No |
| Zapier | HITL action | Dashboard/email | Form fields | None (waits forever) | No |
| AWS Step Functions | Task token | Custom (SNS/SQS) | JSON via SendTaskSuccess | TimeoutSeconds | Custom logic |
| Prefect | pause_flow_run | Automations | Pydantic schema | pause timeout | No |
| Retool | HITL block | Email + UI | Rich forms | Timeout branch | No |

**Common patterns across all systems:**
1. A **unique token/ID** ties the paused execution to the approval action
2. The workflow run enters a **"waiting"** state (we already have this)
3. **Notification is separate from the wait** — you notify, then wait
4. **Resume is an API call** at its core (even when wrapped in UI buttons)
5. **Timeout handling** varies: fail, cancel, auto-approve, or branch

---

## 3. Our Workflow Engine: Current State

### 3.1 Architecture Summary

Our engine executes **DAG-based workflows** with parallel batch execution and convergence gating. Key characteristics:

- **8 executor types**: `property-match`, `code-match`, `notify`, `raw-llm`, `script`, `vcs`, `validate`, `agent-task`
- **Two executor modes**: `instant` (synchronous) and `async` (pause and resume)
- **Async resume pattern**: The `agent-task` executor creates a task, returns `{ async: true, waitFor: "task.completed", correlationId: taskId }`, and the engine checkpoints the step as "waiting". When the task completes, `resume.ts` catches the event and resumes the workflow.
- **Port-based routing**: Executors return a `nextPort` string; the `next` field on nodes maps ports to successor node IDs (e.g., `{ "true": "nodeA", "false": "nodeB" }`)
- **Convergence gating**: A node only executes when ALL its active-edge predecessors are complete
- **State persistence**: All state in SQLite — `workflow_runs` (run-level), `workflow_run_steps` (step-level), context accumulation via checkpointing
- **Event bus**: Internal `EventEmitter` (`src/workflows/event-bus.ts`) — see section 3.3 for complete event list
- **Existing notify executor**: Already supports `swarm`, `slack`, and `email` (stub) channels
- **Recovery**: `src/workflows/recovery.ts` handles incomplete runs on server restart — currently recovers `running` runs (re-walks graph) and `waiting` runs (checks if the linked task completed/failed/cancelled during downtime)

### 3.2 What We Can Reuse

The async executor pattern is directly reusable. The `human-in-the-loop` executor will:

1. Create an `approval_request` record (like `agent-task` creates a task)
2. Return `{ async: true, waitFor: "approval.resolved", correlationId: requestId }`
3. The engine checkpoints the step as "waiting"
4. When the approval resolves, `resume.ts` catches the event and continues the workflow

Additionally:

- **Port-based routing** → `approved` / `rejected` / `timeout` output ports
- **Notify executor** → reuse for sending notifications on Slack/email alongside the primary web UI
- **Context system** → approval responses flow into workflow context for downstream nodes (via `inputs` mapping — see section 4.7)
- **Event bus** → add `approval.resolved` event alongside existing events
- **Recovery** → extend `recovery.ts` to handle approval-waiting runs (see section 3.5)

### 3.3 Event Bus: Complete Event List

The workflow event bus (`src/workflows/event-bus.ts`) is an internal `EventEmitter` singleton. The complete list of events currently emitted:

**Task events** (from `src/be/db.ts`):
| Event | Description |
|-------|-------------|
| `task.created` | New task inserted into the DB |
| `task.completed` | Task marked as completed (with output) |
| `task.failed` | Task marked as failed (with failure reason) |
| `task.cancelled` | Task cancelled |
| `task.progress` | Task progress update stored |

**GitHub webhook events** (from `src/http/webhooks.ts`):
| Event | Description |
|-------|-------------|
| `github.pull_request.{action}` | PR opened, closed, merged, etc. |
| `github.issue.{action}` | Issue opened, closed, etc. |
| `github.issue_comment.created` | Comment added to issue/PR |
| `github.pull_request_review.submitted` | PR review submitted |

**GitLab webhook events** (from `src/http/webhooks.ts`):
| Event | Description |
|-------|-------------|
| `gitlab.merge_request.{action}` | MR opened, merged, etc. |
| `gitlab.issue.{action}` | Issue opened, closed, etc. |
| `gitlab.note.created` | Note (comment) created |
| `gitlab.pipeline.{status}` | Pipeline status change |

**AgentMail events** (from `src/agentmail/handlers.ts`):
| Event | Description |
|-------|-------------|
| `agentmail.message.received` | Inbound email received |

**Slack events** (from `src/slack/handlers.ts`):
| Event | Description |
|-------|-------------|
| `slack.message` | Message received in a monitored channel |

**New event to add for HITL:**
| Event | Description |
|-------|-------------|
| `approval.resolved` | Approval request resolved (approved/rejected/timeout) |

### 3.4 What's New

- New **`human-in-the-loop` executor type** registered in the executor registry
- New **`approval_requests` table** (migration `019_approval_requests.sql`)
- New **web UI pages**: `APP_URL/requests/<id>` (respond) and `APP_URL/requests` (history)
- New **API endpoints** using the `route()` factory from `src/http/route-def.ts` (see section 8.1)
- New **resume handler** for `approval.resolved` events
- New **recovery handler** for approval-waiting runs in `recovery.ts`
- **Dual-purpose system**: works as workflow executor AND as a standalone agent MCP tool (following the MCP tool → HTTP API → DB boundary)

### 3.5 Recovery Handling for Approval-Waiting Runs

**Current state:** `recovery.ts` handles two categories of incomplete workflow runs on server restart:
1. **`running` runs** — re-walks the graph to continue execution
2. **`waiting` runs** — checks if the linked *task* completed/failed/cancelled during downtime

**Gap:** Currently, recovery only handles task-based waiting runs (correlation via `task.id`). It does not handle approval-based waiting runs.

**Required addition (Phase 1):** Extend `recoverIncompleteRuns()` in `recovery.ts` to also recover approval-waiting runs:

```typescript
// New: recover approval-waiting runs
async function recoverApprovalWaitingRuns(): Promise<number> {
  // Query workflow_run_steps with status "waiting" where the
  // correlationId maps to an approval_request (not a task)
  // For each:
  //   1. Check approval_requests table for current status
  //   2. If status is "approved" or "rejected":
  //      - Checkpoint step with response data
  //      - Set run back to "running"
  //      - Find successors and walkGraph()
  //   3. If status is "timeout" (expired while server was down):
  //      - Check if expires_at < now
  //      - Auto-reject the request
  //      - Checkpoint step with timeout response
  //      - Set run back to "running" and continue via "timeout" port
  //   4. If status is still "pending" but expires_at < now:
  //      - Resolve as timeout/rejected
  //      - Continue workflow via "timeout" port
  //   5. If status is still "pending" and not expired:
  //      - Leave as-is (still waiting for human input)
  //      - The normal event-driven resume path will handle it
}
```

**Integration point:** Call `recoverApprovalWaitingRuns()` from `recoverIncompleteRuns()` alongside the existing task-based recovery. The existing pattern of `getStuckWorkflowRuns()` should be extended (or a parallel query added) to also find approval-waiting steps by checking if the `correlationId` exists in the `approval_requests` table.

---

## 4. Proposed Design: `human-in-the-loop` Node Type

### 4.1 Node Configuration Overview

The HITL node uses a **multi-question model** where each approval request contains an array of questions. Each question has a type that determines how it's rendered in the UI and what response format it expects.

This design is aligned with the `AskUserQuestion` tool format but extended to support multiple questions and richer input types (especially multi-select).

### 4.2 Node Config Schema

```typescript
interface HITLNodeConfig {
// Title displayed at the top of the approval request
title: string;  // supports {{template}} variables from workflow context

// Array of questions to present to the human
questions: Question[];

// Who can respond
approvers: ApproverConfig;

// Timeout behavior
timeout?: {
seconds: number;       // max wait time
action: "reject";      // v1: timeout = rejected (per Taras's feedback)
};

// Additional notification channels (web UI is always primary)
notifications?: NotificationConfig[];
}

// Question types
type Question =
| ApprovalQuestion     // yes/no approval
| TextQuestion         // free-text input
| SingleSelectQuestion // pick one from options
| MultiSelectQuestion  // pick multiple from options
| BooleanQuestion;     // true/false toggle

interface QuestionBase {
id: string;           // unique within the request, used as key in response
label: string;        // the question text displayed to the user
required?: boolean;   // default: true
description?: string; // optional help text
}

interface ApprovalQuestion extends QuestionBase {
type: "approval";
// Renders as Approve / Reject buttons
// Response: { approved: boolean }
}

interface TextQuestion extends QuestionBase {
type: "text";
placeholder?: string;
multiline?: boolean;  // textarea vs input
// Response: { value: string }
}

interface SingleSelectQuestion extends QuestionBase {
type: "single-select";
options: SelectOption[];
// Response: { value: string } (the selected option's value)
}

interface MultiSelectQuestion extends QuestionBase {
type: "multi-select";
options: SelectOption[];
minSelections?: number;  // default: 0 (unless required, then 1)
maxSelections?: number;  // default: unlimited
// Response: { values: string[] } (array of selected option values)
}

interface BooleanQuestion extends QuestionBase {
type: "boolean";
defaultValue?: boolean;
// Response: { value: boolean }
}

interface SelectOption {
value: string;     // stored value
label: string;     // display label
description?: string;  // optional description/help text
}

interface ApproverConfig {
users?: string[];      // user IDs or Slack user IDs
roles?: string[];      // role names (resolved to users at runtime)
policy: "any" | "all" | { min: number };  // who must respond
}

interface NotificationConfig {
channel: "slack" | "email";
target: string;  // Slack channel/user ID or email address
}
```

**Comparison with AskUserQuestion tool:**

| Feature | AskUserQuestion | HITL Node |
|---------|----------------|-----------|
| Single question | `question: string` | `questions: Question[]` (array) |
| Input types | Text only | text, approval, single-select, multi-select, boolean |
| Options | Not supported | `options: SelectOption[]` on select types |
| Multi-select | Not supported | `type: "multi-select"` with min/max selections |
| Approval flow | Not applicable | `type: "approval"` with approve/reject |
| Multiple responders | No | Yes (N-of-M policies) |

### 4.3 Example: Node Configuration in Workflow YAML

```yaml
nodes:
- id: "review-pr-approval"
type: "human-in-the-loop"
config:
title: "Review PR #{{context.pr_number}}: {{context.pr_title}}"
questions:
- id: "approval"
type: "approval"
label: "Do you approve merging this PR?"

- id: "merge_strategy"
type: "single-select"
label: "How should this be merged?"
options:
- value: "squash"
label: "Squash and merge"
description: "Combines all commits into one"
- value: "merge"
label: "Create a merge commit"
- value: "rebase"
label: "Rebase and merge"

- id: "post_merge_actions"
type: "multi-select"
label: "What should happen after merge?"
required: false
options:
- value: "delete_branch"
label: "Delete source branch"
- value: "deploy_staging"
label: "Deploy to staging"
- value: "notify_team"
label: "Notify team in Slack"
- value: "create_release"
label: "Create a release tag"

- id: "comments"
type: "text"
label: "Any additional comments?"
required: false
multiline: true
placeholder: "Optional notes for the team..."

approvers:
users: ["{{context.pr_author}}"]
policy: "any"
timeout:
seconds: 86400
action: "reject"
notifications:
- channel: "slack"
target: "{{context.slack_channel}}"
next:
approved: "merge-pr"
rejected: "notify-rejection"
timeout: "notify-timeout"
```

### 4.4 Example: Questions JSON Structure (DB Storage)

The `questions` field in the `approval_requests` table stores this JSONB array:

```json
[
{
"id": "approval",
"type": "approval",
"label": "Do you approve merging this PR?",
"required": true
},
{
"id": "merge_strategy",
"type": "single-select",
"label": "How should this be merged?",
"required": true,
"options": [
{ "value": "squash", "label": "Squash and merge", "description": "Combines all commits into one" },
{ "value": "merge", "label": "Create a merge commit" },
{ "value": "rebase", "label": "Rebase and merge" }
]
},
{
"id": "post_merge_actions",
"type": "multi-select",
"label": "What should happen after merge?",
"required": false,
"options": [
{ "value": "delete_branch", "label": "Delete source branch" },
{ "value": "deploy_staging", "label": "Deploy to staging" },
{ "value": "notify_team", "label": "Notify team in Slack" },
{ "value": "create_release", "label": "Create a release tag" }
],
"minSelections": 0
},
{
"id": "comments",
"type": "text",
"label": "Any additional comments?",
"required": false,
"multiline": true,
"placeholder": "Optional notes for the team..."
}
]
```

### 4.5 Example: Response JSON Structure (DB Storage)

The `responses` field stores the answers keyed by question ID:

```json
{
"approval": { "approved": true },
"merge_strategy": { "value": "squash" },
"post_merge_actions": { "values": ["delete_branch", "deploy_staging"] },
"comments": { "value": "LGTM! Let's ship it." }
}
```

### 4.6 Port Routing Logic

The executor determines the output port based on the responses:

1. If any `type: "approval"` question has `approved: false` → port `"rejected"`
2. If timeout occurs → port `"timeout"`
3. Otherwise → port `"approved"`

The full response object is merged into the workflow context under `steps.<nodeId>.responses` for downstream nodes to consume.

### 4.7 Downstream Node `inputs` Mapping

Per the workflow authoring guide in CLAUDE.md, **upstream step outputs are NOT available for interpolation by default**. Only `trigger` (trigger data) and `input` (workflow-level resolved inputs) are in scope. To access the HITL node's response data, downstream nodes **MUST declare an `inputs` mapping**.

**Example: Downstream node accessing HITL responses**

```json
{
  "nodes": [
    {
      "id": "review-pr-approval",
      "type": "human-in-the-loop",
      "config": {
        "title": "Review PR #{{trigger.pr_number}}",
        "questions": [
          { "id": "approval", "type": "approval", "label": "Approve merge?" },
          { "id": "merge_strategy", "type": "single-select", "label": "Merge method?", "options": [...] }
        ],
        "approvers": { "policy": "any" },
        "timeout": { "seconds": 86400, "action": "reject" }
      },
      "next": { "approved": "merge-pr", "rejected": "notify-rejection", "timeout": "notify-timeout" }
    },
    {
      "id": "merge-pr",
      "type": "agent-task",
      "inputs": { "review": "review-pr-approval" },
      "config": {
        "template": "Merge the PR using {{review.responses.merge_strategy.value}} strategy. Reviewer comment: {{review.responses.comments.value}}"
      }
    }
  ]
}
```

**Key points:**
- The `inputs` key `"review"` is a local name — it maps to the HITL node ID `"review-pr-approval"`
- HITL node output shape: `{ requestId: string, status: string, responses: { ... } }`
- Access response fields via `review.responses.<questionId>.<field>`
- Without the `inputs` mapping, templates referencing the HITL node will silently resolve to empty strings (check `diagnostics.unresolvedTokens` on the step)

---

## 5. Notification & Approval Channels

### 5.1 Primary: Web UI (Always Active)

Every approval request gets a dedicated page at `APP_URL/requests/<id>`.

**The web UI is the primary channel.** All other channels (Slack, email) are additional parallel notification mechanisms that link back to the web UI.

The UI renders the questions array dynamically:
- `approval` → Approve / Reject button pair
- `text` → Input field or textarea
- `single-select` → Radio buttons or dropdown
- `multi-select` → Checkboxes with optional min/max selection constraints
- `boolean` → Toggle switch

**Auth:** API key required (passed via URL token or header).

### 5.2 Additional: Slack

A Slack message is sent with a summary of the request and a **link to the web UI** for full interaction. For simple requests (single approval question only), inline Slack buttons can be provided.

For multi-question requests, Slack shows a preview of the questions and a "Respond in UI →" button linking to `APP_URL/requests/<id>`.

**Slack action handlers** for inline approval buttons should be registered in `src/slack/actions.ts` (not `app.ts` directly), following the existing pattern where `actions.ts` handles Slack interactive component callbacks.

**Slack message updates:** After resolution, the original Slack message is updated with the outcome — but **only in threads** (no random channel messages, per Taras's feedback).

**Auth:** Slack presence (being in the channel/DM).

### 5.3 Additional: Email (Future)

Email notification with a link to the web UI. Simple approval-only requests could include approve/reject links directly in the email.

### 5.4 History UI

`APP_URL/requests` — a **read-only** page showing all past/resolved approval requests. Filterable by status, workflow, date. Each entry links to the full request detail page showing the questions and responses.

---

## 6. Database Schema Changes

### 6.1 Migration: `019_approval_requests.sql`

The next migration number is `019` (current highest is `018_fix_seed_double_version.sql`).

```sql
-- 019_approval_requests.sql
CREATE TABLE IF NOT EXISTS approval_requests (
id TEXT PRIMARY KEY,                    -- UUID

-- Generic fields (always present)
title TEXT NOT NULL,                    -- Display title for the request
questions JSONB NOT NULL,              -- Array of Question objects (see section 4.4)

-- Source context (one of these pairs will be set)
workflow_run_id TEXT,                   -- FK → workflow_runs.id (if from workflow)
workflow_step_id TEXT,                  -- FK → workflow_run_steps.id (if from workflow)
source_task_id TEXT,                    -- FK → tasks.id (if from agent tool)

-- Approver policy
approvers JSONB NOT NULL,              -- { users: [...], roles: [...], policy: "any"|"all"|{min:N} }

-- State
status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | timeout
responses JSONB,                       -- Keyed by question ID (see section 4.5)
resolved_by TEXT,                      -- user ID of who responded
resolved_at DATETIME,                  -- when resolved

-- Timeout
timeout_seconds INTEGER,               -- NULL = no timeout
expires_at DATETIME,                   -- computed: created_at + timeout_seconds

-- Notifications sent
notification_channels JSONB,           -- [{ channel: "slack", target: "...", messageTs: "..." }]

-- Metadata
created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- For the history UI
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_created ON approval_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_requests_workflow ON approval_requests(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(source_task_id);
-- For recovery: find pending requests that may have expired during downtime
CREATE INDEX IF NOT EXISTS idx_approval_requests_expires ON approval_requests(expires_at) WHERE status = 'pending';
```

**Key design decisions:**
- **`questions JSONB`** replaces the old single `question TEXT` field — supports multiple questions of different types per request
- **`responses JSONB`** stores answers keyed by question ID — each question type has its own response shape
- **Generic/dual-purpose**: `workflow_run_id` for workflow use, `source_task_id` for agent tool use — same table serves both
- **On timeout → treated as rejected** (no escalation in v1)
- **No delegation** (removed from v1 scope)
- **No revocation** (removed from v1 scope)
- **Recovery index** on `expires_at` for efficient expired-request lookups during server restart

### 6.2 Dual-Purpose Behavior

When an approval request is resolved:

| Source | Behavior |
|--------|----------|
| **Workflow run** (`workflow_run_id` set) | Emit `approval.resolved` event → `resume.ts` picks it up → workflow continues via the appropriate port |
| **Agent tool** (`source_task_id` set) | Create a follow-up task with the response data, linked to `source_task_id` as parent. The agent picks up the response in the next task. |

### 6.3 Worker/API Boundary for Agent Tool Usage

**Architecture invariant:** Workers have NO local database access. The agent tool for creating HITL approval requests must follow the established MCP tool → HTTP API → DB path:

```
Agent (worker container)
  → MCP tool: "request-human-input"
    → HTTP POST /api/approval-requests (with API_KEY + X-Agent-ID headers)
      → API server creates record in approval_requests table
        → Returns request ID + web UI URL to agent
```

The MCP tool definition lives in `src/tools/` and calls the HTTP API. The HTTP endpoint (defined using `route()` factory) handles DB operations. Workers **never** import from `src/be/db` or `bun:sqlite` — this is enforced by `scripts/check-db-boundary.sh` (pre-push hook + CI merge gate).

This is the same pattern used by all other worker-facing MCP tools (e.g., `store-progress`, `send-task`, etc.).

---

## 7. Security Considerations

### 7.1 Authorization (Simplified for v1)

| Channel | Auth Method |
|---------|-------------|
| Web UI (`APP_URL/requests/<id>`) | API key (in URL token or Authorization header) |
| Slack | Being present in the channel/DM where the notification was sent |
| API | API key in Authorization header |

No complex RBAC in v1. The approvers list in the request defines who can respond, but enforcement is channel-dependent.

### 7.2 Request Tokens

Each approval request ID serves as a bearer token for that specific request. The ID is a UUID — unguessable but should still be transmitted over HTTPS only.

### 7.3 Input Validation

- Responses are validated against the questions schema (correct types, required fields, valid option values for select types)
- Multi-select responses are validated against `minSelections`/`maxSelections` constraints
- Text responses are sanitized to prevent XSS

---

## 8. Implementation Recommendations

### 8.1 Phase 1 — Core (MVP)

1. **DB migration**: Create `019_approval_requests.sql` with the schema from section 6.1 (includes recovery index on `expires_at`)

2. **Executor**: `human-in-the-loop` executor that creates a request and returns async

3. **Resume handler**: Listen for `approval.resolved` in `resume.ts`, resume workflow with response data and route to appropriate port

4. **Recovery handler** (BLOCKING): Extend `recovery.ts` `recoverIncompleteRuns()` to handle approval-waiting runs (see section 3.5). Must handle:
   - Requests resolved during downtime → checkpoint and resume
   - Requests expired during downtime → auto-reject and resume via "timeout" port
   - Requests still pending and not expired → leave as-is

5. **API endpoints** — all using `route()` factory from `src/http/route-def.ts`:
   ```typescript
   // src/http/approval-requests.ts

   // Create a new approval request (used by both executor and MCP tool)
   const createApprovalRoute = route({
     method: "post",
     path: "/api/approval-requests",
     pattern: ["api", "approval-requests"],
     summary: "Create a new approval request",
     tags: ["ApprovalRequests"],
     body: z.object({ title: z.string(), questions: z.array(...), ... }),
     responses: { 201: { description: "Request created" }, 400: { description: "Validation error" } },
     auth: { apiKey: true },
   });

   // Get approval request details
   const getApprovalRoute = route({
     method: "get",
     path: "/api/approval-requests/{id}",
     pattern: ["api", "approval-requests", null],
     summary: "Get approval request details",
     tags: ["ApprovalRequests"],
     params: z.object({ id: z.string().uuid() }),
     responses: { 200: { description: "Request details" }, 404: { description: "Not found" } },
     auth: { apiKey: true },
   });

   // Respond to an approval request
   const respondApprovalRoute = route({
     method: "post",
     path: "/api/approval-requests/{id}/respond",
     pattern: ["api", "approval-requests", null, "respond"],
     summary: "Submit a response to an approval request",
     tags: ["ApprovalRequests"],
     params: z.object({ id: z.string().uuid() }),
     body: z.object({ responses: z.record(z.unknown()), respondedBy: z.string().optional() }),
     responses: { 200: { description: "Response recorded" }, 400: { description: "Validation error" }, 404: { description: "Not found" }, 409: { description: "Already resolved" } },
     auth: { apiKey: true },
   });

   // List approval requests (for history UI)
   const listApprovalsRoute = route({
     method: "get",
     path: "/api/approval-requests",
     pattern: ["api", "approval-requests"],
     summary: "List approval requests with filters",
     tags: ["ApprovalRequests"],
     query: z.object({ status: z.string().optional(), workflowRunId: z.string().optional(), limit: z.coerce.number().optional() }),
     responses: { 200: { description: "List of approval requests" } },
     auth: { apiKey: true },
   });
   ```

   After creating the handler file:
   - Import and add to handler chain in `src/http/index.ts`
   - Add the import to `scripts/generate-openapi.ts`
   - Run `bun run docs:openapi` to regenerate `openapi.json`

6. **MCP tool**: `request-human-input` tool in `src/tools/` — calls the HTTP API endpoints above (respects worker/API boundary). Worker code never touches `src/be/db`.

7. **Web UI**: `APP_URL/requests/:id` — render questions dynamically, submit responses

8. **Slack notification**: Post message with link to web UI (inline buttons for approval-only). Slack action handlers for inline approval buttons registered in `src/slack/actions.ts`.

### 8.2 Phase 2 — Polish

1. **History UI**: `APP_URL/requests` — read-only list of all past requests
2. **Slack thread updates**: Update original Slack message with outcome (threads only)
3. **Agent tool integration**: Allow agents to create approval requests via MCP tool (uses HTTP API, not direct DB)
4. **Timeout worker**: Background job that checks `expires_at` and auto-rejects expired requests
5. **N-of-M approval**: Track multiple responders, resolve when policy is met

### 8.3 Phase 3 — Future

1. Email notifications
2. Conditional questions (show question B only if question A answer is X)
3. File upload question type
4. Rich text / markdown in question descriptions

---

## 9. Open Questions (Resolved)

All open questions from the initial draft have been resolved per Taras's review:

| Question | Resolution |
|----------|------------|
| Delegation? | **No** — removed from v1 scope |
| Revocation? | **No** — not for v1 |
| Escalation on timeout? | **No** — timeout = rejected. No escalation chains |
| Slack message updates after resolution? | **Yes** — but only in threads (no random channel messages) |
| UI for viewing resolved requests? | **Yes** — read-only history page at `APP_URL/requests` |
| Multi-question support? | **Yes** — `questions` JSONB array replaces single `question TEXT` |
| Multi-select support? | **Yes** — `multi-select` question type with options and min/max constraints |

---

## Appendix: Review Gap Tracking

This document has been updated to address all gaps identified by the Reviewer agent:

| # | Gap | Status | Section |
|---|-----|--------|---------|
| 1 | Recovery handling for approval-waiting runs (BLOCKING) | **Addressed** | §3.2, §3.5, §8.1 item 4 |
| 2 | `route()` factory required for API endpoints (BLOCKING) | **Addressed** | §3.4, §8.1 item 5 |
| 3 | Migration numbering (`019`) | **Addressed** | §1, §6.1 |
| 4 | Slack action handlers in `src/slack/actions.ts` | **Addressed** | §5.2, §8.1 item 8 |
| 5 | Downstream nodes need `inputs` mapping | **Addressed** | §4.7 (new section) |
| 6 | Worker/API boundary for agent tool | **Addressed** | §1, §3.4, §6.3 (new section), §8.1 items 5-6 |
| 7 | Event bus event list incomplete | **Addressed** | §3.3 (new section with complete list) |
