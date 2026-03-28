---
date: 2026-03-26T12:00:00Z
topic: "Workflow & Run Detail Pages — UI Improvements"
type: research
status: complete
scope: new-ui workflow and run detail pages
---

# Research: Workflow & Run Detail Pages — UI Improvements

**Date:** 2026-03-26
**Scope:** `new-ui/src/pages/workflows/[id]/page.tsx`, `new-ui/src/pages/workflow-runs/[id]/page.tsx`, and related components in `new-ui/src/components/workflows/`

---

## 0. Proposed Wireframes

**Design principles for all output rendering:**
- All output text must be **pretty-printed** (rendered as markdown where possible, not raw strings)
- All entity references must be **linked** to their pages (tasks → `/tasks/:id`, agents → agent detail, workflows → `/workflows/:id`, approval requests → `/approval-requests/:id`)
- Long content must be **collapsed by default** with a toggle to expand (show byte size in the toggle label)
- **Input** stays as `JsonTree` (no smart parsing needed)
- **Output** gets smart rendering by step type (task link, formatted text, etc.) with "Raw JSON" as opt-in fallback

### Workflow Run Detail Page (`/workflow-runs/:id`)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ← Back to PR Review Pipeline                                              │
│                                                                           │
│ Run of PR Review Pipeline    ● COMPLETED    Mar 26, 14:32    ⏱ 2m 14s    │
│ Created by: worker-01                                                     │
│                                                                           │
│ ┌─ Step Summary ──────────────────────────────────────────────────────┐    │
│ │  ●●●●○  4/5 completed  ·  1 skipped                               │    │
│ └─────────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│ ▸ Trigger Data                                                            │
│   { "pullRequest": { "number": 42, "repo": "agent-swarm" } }             │
│                                                                           │
│ ┌──────────────────────────────┐ ┌────────────────────────────────────┐    │
│ │        GRAPH PANEL           │ │  Steps (5)           [⇕] [⇕⇕]    │    │
│ │                              │ │                                    │    │
│ │   ┌──────────────┐           │ │  ┌────────────────────────────┐    │    │
│ │   │ fetch-pr     │           │ │  │ ▸ Fetch PR Data            │    │    │
│ │   │ AGENT-TASK   │           │ │  │   AGENT-TASK  ● COMPLETED  │    │    │
│ │   │ ● completed  │           │ │  │   ⏱ 12s                    │    │    │
│ │   └──────┬───────┘           │ │  └────────────────────────────┘    │    │
│ │          │                   │ │                                    │    │
│ │   ┌──────┴───────┐           │ │  ┌────────────────────────────┐    │    │
│ │   │ run-review   │           │ │  │ ▾ Run Code Review          │    │    │
│ │   │ AGENT-TASK   │           │ │  │   AGENT-TASK  ● COMPLETED  │    │    │
│ │   │ ● completed  │           │ │  │   ⏱ 1m 42s                 │    │    │
│ │   └──────┬───────┘           │ │  │                             │    │    │
│ │          │                   │ │  │  ┌─ Task ───────────────┐   │    │    │
│ │   ┌──────┴───────┐           │ │  │  │ → abc123  ● done     │   │    │    │
│ │   │ post-comment  │          │ │  │  │   Agent: reviewer-01  │   │    │    │
│ │   │ NOTIFY       │          │ │  │  └────────────────────────┘   │    │    │
│ │   │ ● completed  │          │ │  │                              │    │    │
│ │   └──────────────┘          │ │  │  ┌─ Agent Output ─────────┐  │    │    │
│ │                              │ │  │  │ ▸ Show output (2.4 KB) │  │    │    │
│ │                              │ │  │  └────────────────────────┘  │    │    │
│ │                              │ │  │                              │    │    │
│ │                              │ │  │  ▸ Raw JSON                  │    │    │
│ │                              │ │  └──────────────────────────────┘    │    │
│ │                              │ │                                    │    │
│ │                              │ │  ┌────────────────────────────┐    │    │
│ │                              │ │  │ ▸ Post Comment             │    │    │
│ │                              │ │  │   NOTIFY  ● COMPLETED      │    │    │
│ │                              │ │  │   ⏱ 3s                     │    │    │
│ │                              │ │  └────────────────────────────┘    │    │
│ └──────────────────────────────┘ └────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key changes from current:**
- Back button → links to parent workflow (not global runs list)
- Step summary bar with colored dots
- Trigger data collapsible section
- Step cards: task link badge (clickable `→ abc123`), agent name, collapsible output
- "Raw JSON" is collapsed by default, opt-in toggle

### Step Card — Expanded (agent-task type)

```
┌──────────────────────────────────────────────────────────────────┐
│ ▾ Run Code Review        AGENT-TASK   ● COMPLETED   ⏱ 1m 42s   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Started: Mar 26, 14:32     Finished: Mar 26, 14:34             │
│  Duration: 1m 42s           Port: default                        │
│                                                                  │
│  ┌─ Task ────────────────────────────────────────────────────┐   │
│  │  → abc1234f   ● completed                                │   │
│  │  Agent: reviewer-01 (coder)                               │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─ Output ──────────────────────────────────────────────────┐   │
│  │  ▸ Show task output (2.4 KB)                              │   │
│  │  ┌────────────────────────────────────────────────────┐   │   │
│  │  │ { "summary": "LGTM, minor nit on line 42...",     │   │   │
│  │  │   "approved": true, "comments": 3 }               │   │   │
│  │  └────────────────────────────────────────────────────┘   │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ⚠ Diagnostics: 1 unresolved token (cityData.population)        │
│                                                                  │
│  ▸ Raw Input JSON                                                │
│  ▸ Raw Output JSON                                               │
└──────────────────────────────────────────────────────────────────┘
```

### Step Card — Expanded (human-in-the-loop type)

```
┌──────────────────────────────────────────────────────────────────┐
│ ▾ Approval Gate          HITL   ● WAITING          ⏱ pending    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Started: Mar 26, 14:34     Status: Awaiting approval            │
│                                                                  │
│  ┌─ Approval Request ───────────────────────────────────────┐   │
│  │  → req-789abc   ⏳ PENDING                               │   │
│  │  "Review and approve the deployment to production"        │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ▸ Raw Input JSON                                                │
└──────────────────────────────────────────────────────────────────┘
```

### Workflow Detail Page — Node Inspector (agent-task)

```
┌─ Node Inspector ─────────────────────────────────────────────────┐
│                                                                  │
│  run-review    AGENT-TASK    ASYNC                               │
│  "Run the code review on the PR"                                 │
│                                                                  │
│  ┌─ Template ────────────────────────────────────────────────┐   │
│  │  Review PR #{{trigger.pullRequest.number}} in             │   │
│  │  {{trigger.pullRequest.repo}}.                            │   │
│  │  Focus on correctness, security, and style.               │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Agent: → reviewer-01                                            │
│  Priority: 80     Offer mode: true                               │
│  Tags: review, pr                                                │
│                                                                  │
│  ┌─ Output Schema ───────────────────────────────────────────┐   │
│  │  ▸ { type: "object", required: ["summary", "approved"] } │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ─── Connections ─────────────────────────────────────────────   │
│  Next: post-comment (default)                                    │
│                                                                  │
│  ▸ Raw Configuration JSON                                        │
└──────────────────────────────────────────────────────────────────┘
```

### Workflow Detail Page — Header (enhanced)

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Back to Workflows                                            │
│                                                                 │
│ PR Review Pipeline  [ON/OFF]  5 NODES  4 EDGES                  │
│                                                                 │
│ Review PRs automatically when webhooks fire                     │
│                                                                 │
│ Created by: → worker-01    Dir: /repos/agent-swarm              │
│ Repo: github.com/org/agent-swarm                                │
│                                                                 │
│ ┌─ Triggers ──────────┐  ┌─ Cooldown ─┐                        │
│ │ WEBHOOK (hmac: ab**) │  │ 5m         │    [▶ Trigger] [🗑]   │
│ │ SCHEDULE sch-123     │  └────────────┘                        │
│ └──────────────────────┘                                        │
│                                                                 │
│ [Definition]  [Runs (12)]  [Versions (4)]                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. Current State Summary

### Workflow Detail Page (`/workflows/:id`)

The page has two tabs: **Definition** (graph + node inspector) and **Runs** (AG Grid table).

**What works well:**
- ReactFlow DAG visualization with dagre layout
- Click-to-inspect node in the side panel
- Enable/disable toggle, trigger button, delete with confirmation
- Runs table with status, started, duration, error columns — clickable to navigate

**What's missing or weak:**

| Issue | Detail |
|-------|--------|
| **No agent link** | `createdByAgentId` is available in the `Workflow` type but never displayed |
| **No workspace info** | Backend has `dir` and `vcsRepo` fields (added in migration 015) but the UI type and page don't show them |
| **No trigger schema** | Backend supports `triggerSchema` but it's not in the UI type or displayed |
| **No version history** | `useWorkflowVersions` hook exists, API endpoint exists, but no tab/section shows version history |
| **Node inspector is JSON-heavy** | Config, next, validation, retry all render as `JsonTree`. For `agent-task` nodes, the template text is buried in JSON. For nodes with `agentId` in config, no link to agent page |
| **Runs table is bare** | Only shows status, started, duration, error. No run ID (truncated), no step count summary, no trigger data preview |

### Workflow Run Detail Page (`/workflow-runs/:id`)

Split layout: graph (with step status overlay) on left, expandable step cards on right.

**What works well:**
- Graph nodes show border colors based on step status
- Edges animate (green) when both source and target are completed
- Step cards are expandable with expand/collapse all
- Graph click scrolls to step card and highlights it
- Retry button for failed runs
- Error alerts for run-level and step-level errors

**What's missing or weak:**

| Issue | Detail |
|-------|--------|
| **No task links** | For `agent-task` steps, the output contains `{ taskId, taskOutput }` but `taskId` is just shown as raw JSON. Should be a clickable link to `/tasks/:taskId` |
| **No agent info on steps** | `agent-task` nodes have `config.agentId` but steps don't show which agent was assigned or is running the task |
| **JSON dumps dominate** | Input and output sections show raw `JsonTree` for everything. For `agent-task` steps, the `taskOutput` could be huge and swamps the panel. Should be collapsible/opt-in |
| **No `diagnostics` field** | Backend returns `diagnostics` (JSON) and `nextPort` (string) on steps, but the UI type (`WorkflowRunStep`) doesn't include them and they're never shown |
| **No trigger data** | `run.triggerData` and `run.context` are available but not displayed anywhere |
| **No link to workflow** | Header says "Run of {workflowName}" but the workflow name isn't a link to `/workflows/:workflowId` |
| **Step card metadata is sparse** | Only shows started, finished, duration. No step ID, no idempotency key, no retry info unless retry > 0 |
| **`step-detail-sheet.tsx` is orphaned** | A `Sheet`-based component exists in `components/workflows/` but is never imported or used by any page |
| **No approval request link** | For `human-in-the-loop` steps, there's no link to the related approval request |
| **Back button goes to wrong place** | "Back to Runs" navigates to `/workflows?tab=runs` (global runs list) but if user came from a workflow detail page's runs tab, they'd expect to go back there |

---

## 2. Data Available but Not Surfaced

### Backend fields returned by API but missing from UI types

| Field | Source | Available in API response? | In UI type? |
|-------|--------|---------------------------|-------------|
| `Workflow.dir` | Migration 015 | Yes (GET /api/workflows/:id) | **No** |
| `Workflow.vcsRepo` | Migration 015 | Yes | **No** |
| `Workflow.triggerSchema` | Migration 012 | Yes | **No** |
| `WorkflowRunStep.diagnostics` | Migration 010 | Yes (GET /api/workflow-runs/:id) | **No** |
| `WorkflowRunStep.nextPort` | Migration 011 | Yes | **No** |

### Data inside existing fields but not parsed/linked

| Data | Where it lives | Current rendering | Should be |
|------|---------------|-------------------|-----------|
| `step.output.taskId` (agent-task steps) | `output` JSON blob | Raw JSON tree | Clickable link: `→ /tasks/:taskId` |
| `step.output.taskOutput` (agent-task steps) | `output` JSON blob | Raw JSON tree | Separated: task link + collapsible output |
| `node.config.agentId` | Node config JSON | Raw JSON tree | Agent name with link: `→ /agents` (filtered) |
| `node.config.template` | Node config JSON | Raw JSON tree | Rendered as styled text block |
| `run.triggerData` | `WorkflowRun` | Not shown | Collapsible section in run header |
| `run.context` | `WorkflowRun` | Not shown | Collapsible section or debug panel |
| `workflow.createdByAgentId` | `Workflow` | Not shown | Agent name badge in header |

---

## 3. Specific Improvement Areas

### 3.1 Step Cards — Smart Output Rendering

Instead of dumping all output as JSON, parse the step type and render accordingly:

**For `agent-task` steps:**
- Extract `taskId` → render as clickable link badge: `Task: abc123 →`
- Extract `taskOutput` → render as collapsible section (collapsed by default)
- Show agent assignment from config: `Agent: worker-01`

**For `human-in-the-loop` steps:**
- Show approval status
- Link to approval request page if one exists

**For `script` / `raw-llm` steps:**
- Output is typically a string — render as pre-formatted text, not JSON tree

**For all steps:**
- **Input**: Keep as `JsonTree` (no change needed)
- **Output**: Smart rendering by step type; raw JSON as opt-in toggle
- Show `diagnostics.unresolvedTokens` as warnings if present
- All entity IDs (taskId, agentId, approvalRequestId) must be clickable links to their pages
- Long output collapsed by default with byte size label

### 3.2 Node Inspector — Structured Config Display

Instead of one big `JsonTree` for config, parse known executor types and show structured fields:

**For `agent-task` nodes:**
- `template` → Rendered text block with monospace font
- `agentId` → Agent link
- `outputSchema` → Collapsible schema viewer
- `tags`, `priority`, `offerMode` → Inline badges
- `dir`, `vcsRepo` → Workspace info

**For `script` nodes:**
- `command` → Code block
- `timeout` → Badge

**For `raw-llm` nodes:**
- `prompt` → Text block
- `model` → Badge

Fallback: "Raw config" collapsible JSON tree for fields not explicitly rendered.

### 3.3 Cross-Navigation Links

| From | To | How |
|------|----|-----|
| Run header "Run of {name}" | `/workflows/:workflowId` | Make workflow name a link |
| Step card (agent-task) | `/tasks/:taskId` | Extract from output, render as link badge |
| Step card (HITL) | `/approval-requests/:id` | Need to add approval request lookup |
| Workflow header | Agent page | Show `createdByAgentId` as linked badge |
| Node inspector (agent-task) | Agent page | `config.agentId` as linked badge |
| Run back button | Workflow detail runs tab | Navigate to `/workflows/:workflowId?tab=runs` instead of global |

### 3.4 Missing Sections

**Workflow detail page:**
1. **Version history tab** — The hook `useWorkflowVersions` already exists. Add a "Versions" tab showing version timeline with diffs
2. **Workspace info** — Show `dir` and `vcsRepo` in metadata area
3. **Created by** — Show agent name/link in header

**Run detail page:**
1. **Trigger data section** — Collapsible card in header showing what triggered the run
2. **Context section** — Debug/advanced collapsible showing run context
3. **Step summary bar** — Quick visual: `3/5 completed, 1 running, 1 pending` with colored dots

### 3.5 UI Type Updates Needed

Add to `new-ui/src/api/types.ts`:

```typescript
// WorkflowRunStep — add missing fields
interface WorkflowRunStep {
  // ... existing fields ...
  diagnostics?: unknown;  // JSON with unresolvedTokens, etc.
  nextPort?: string;      // Which output port was taken
}

// Workflow — add missing fields
interface Workflow {
  // ... existing fields ...
  dir?: string;
  vcsRepo?: string;
  triggerSchema?: unknown;
}
```

---

## 4. Priority Ranking

### P0 — High impact, straightforward
1. **Task links in agent-task steps** — Most impactful single change. Parse `output.taskId`, render as link
2. **Workflow name as link in run header** — One-line fix, huge usability win
3. **Fix back button** — Navigate to parent workflow's runs tab, not global
4. **Trigger data display** — Show what triggered a run

### P1 — Medium effort, good UX improvement
5. **Smart step output rendering** — Parse by step type instead of JSON dump
6. **Agent info on steps** — Show which agent is assigned/ran a step
7. **Step summary bar** — Visual status overview at top of run page
8. **Add `diagnostics`/`nextPort` to UI types and display**

### P2 — Larger effort, nice to have
9. **Structured node inspector** — Parse config by executor type
10. **Version history tab** — Hook exists, needs UI
11. **Workspace info** — Add `dir`/`vcsRepo` to workflow header
12. **Approval request links** — For HITL steps

---

## 5. Files to Modify

| File | Changes |
|------|---------|
| `new-ui/src/api/types.ts` | Add `diagnostics`, `nextPort` to `WorkflowRunStep`; add `dir`, `vcsRepo`, `triggerSchema` to `Workflow` |
| `new-ui/src/pages/workflow-runs/[id]/page.tsx` | Smart step rendering, task links, trigger data, workflow link, back button fix, step summary |
| `new-ui/src/pages/workflows/[id]/page.tsx` | Agent link, workspace info, version history tab, structured node inspector |
| `new-ui/src/components/workflows/step-card.tsx` | Extract `StepCard` to its own file, add smart output parsing |
| `new-ui/src/components/workflows/step-detail-sheet.tsx` | Either integrate or remove the orphaned component |

---

## 6. Design Considerations

- **"Mission Control" theme**: Maintain the existing zinc/amber design language. Use amber for interactive links, emerald for success states
- **Information density**: The current layout is good for graph + panel. Don't break that — enhance the panel content
- **JSON should be opt-in**: Default to parsed/structured view. Offer "Raw JSON" toggle per section for debugging
- **Consistency**: Task links should use the same style as approval request links in the approval requests page (existing pattern at `src/pages/approval-requests/[id]/page.tsx:206-208`)
