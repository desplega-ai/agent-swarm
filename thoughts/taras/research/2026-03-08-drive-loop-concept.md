---
date: 2026-03-08T18:00:00-05:00
researcher: Claude
git_commit: 94b35ac22ee9f35581f18281a6e69751d90ebad6
branch: main
repository: agent-swarm
topic: "Drive Loop: Making epics and goals actively drive work until done or blocked"
tags: [research, epics, drive-loop, autonomy, memory, self-improvement, architecture]
status: complete
autonomy: critical
last_updated: 2026-03-08
last_updated_by: Claude
---

# Research: Drive Loop Concept

**Date**: 2026-03-08
**Researcher**: Claude
**Git Commit**: 94b35ac
**Branch**: main

## Research Question

How can agent-swarm make epics (and general goals) actively drive work until done or blocked, rather than being passive containers? This includes understanding the current system's gaps, how external frameworks solve autonomous goal-driven loops, and what changes are needed to make the swarm function as a persistent, self-driving team.

## Summary

The agent-swarm has all the primitives for autonomous work — task creation, worker execution, follow-up notifications, memory indexing, epic tracking — but lacks the **control loop** that ties them together into continuous, goal-driven execution. The core gaps are:

1. **Epics are passive containers**, not active drivers. They store plan/prd fields that nothing reads programmatically. The `epic_progress_changed` trigger tells the lead what happened but doesn't enforce that the lead actually plans next steps.

2. **Follow-up tasks are informational, not directive.** When a worker completes a task, the lead gets a notification ("review needed") but no structured instruction to evaluate goal completion and drive next steps. The follow-up doesn't even mention the epic.

3. **No stall detection at the epic/goal level.** The heartbeat detects stalled individual tasks (30min threshold) but has no concept of an epic going silent. If all tasks complete but the epic goal isn't met, nothing triggers.

4. **Memory is created but not surfaced.** Task completions auto-index as agent-scoped memories with embeddings, but nothing auto-injects relevant memories into new tasks. Agents must manually call `memory-search`, which they rarely do (identified as Gap 9 in the 2026-02-20 self-improvement research).

External frameworks (CrewAI, AutoGen, LangGraph) solve the "keep working until done" problem with composable termination conditions, state checkpointing, and explicit evaluate→decide→act loops. The missing piece in agent-swarm is a **goal evaluation loop** that runs after each task completion and drives the system toward the goal.

## Detailed Findings

### 1. Current Epic System Architecture

#### Database Schema (`src/be/migrations/001_initial.sql:41-68`)

The `epics` table has rich fields that are largely unused by automation:

| Field | Type | Used By Automation? |
|-------|------|-------------------|
| `name` | TEXT NOT NULL UNIQUE | Yes — in trigger prompts |
| `goal` | TEXT NOT NULL | Yes — in trigger prompts |
| `prd` | TEXT nullable | **No** — only shown in UI |
| `plan` | TEXT nullable | **No** — only shown in UI |
| `status` | TEXT (draft/active/paused/completed/cancelled) | Yes — filters active epics |
| `priority` | INTEGER DEFAULT 50 | No — not used in any ordering logic |
| `researchDocPath` | TEXT nullable | **No** — stored but never loaded |
| `planDocPath` | TEXT nullable | **No** — stored but never loaded |
| `progressNotifiedAt` | TEXT nullable | Yes — deduplicates progress triggers |

The epic-task relationship is a simple FK: `agent_tasks.epicId REFERENCES epics(id) ON DELETE SET NULL`.

#### Status Transitions

No constraints — any status can transition to any other. Timestamps:
- `startedAt` set on first transition to `active` (`db.ts:4496-4498`)
- `completedAt` set on first transition to `completed` (`db.ts:4500-4505`)

#### MCP Tools (7 total, all DEFERRED)

`create-epic`, `update-epic`, `get-epic-details`, `list-epics`, `delete-epic`, `assign-task-to-epic`, `unassign-task-from-epic`. Only lead agents can create/modify epics (enforced per-tool).

#### Key Gap: plan/prd Fields Are Write-Only

The `plan` and `prd` fields are set via `create-epic` or `update-epic` but are **never read by any automation**. The `epic_progress_changed` trigger prompt (`runner.ts:914-1001`) only includes `epic.name`, `epic.goal`, `epic.progress`, `epic.status`, and `epic.taskStats`. The lead never sees the plan when deciding next steps.

### 2. Lead Agent Behavior and Follow-Up Processing

#### The Lead's System Prompt (`src/prompts/base-prompt.ts:11-181`)

The lead is defined as a **coordinator only** — it delegates all work and never implements. It has access to `get-swarm`, `get-tasks`, `get-task-details`, `send-task`, `inbox-delegate`, `store-progress`, plus Slack/inbox tools. The prompt includes templates for Research, Planning, Implementation, Quick Fix, and General tasks.

**Critical observation:** The lead prompt contains **no instructions about how to handle follow-up tasks** about completed worker work. It doesn't say "check if the epic goal is met" or "create next tasks to continue." The lead's behavior when processing follow-ups is entirely driven by the Claude model's interpretation of the follow-up task description.

#### Follow-Up Task Creation (`src/tools/store-progress.ts:231-272`)

When a worker calls `store-progress(status: "completed")`:

1. A follow-up task is created for the lead with:
   - `taskType: "follow-up"`
   - `parentTaskId: <original task ID>`
   - Slack context forwarded
   - Description: `"Worker task completed — review needed.\n\nAgent: {name}\nTask: \"{desc}\"\n\nOutput:\n{output (500 chars)}"`

2. For failed tasks: `"Worker task failed — action needed.\n\nFailure reason: {reason}"`

**The follow-up description does NOT mention the epic**, even when the completed task belongs to one. Epic awareness comes from the separate `epic_progress_changed` trigger, which has **lower priority** in the poll endpoint.

#### Two Parallel Mechanisms for Epic Tasks

When an epic-linked task completes, **both** fire independently:

1. **Mechanism A (store-progress follow-up):** Creates a generic follow-up task. Higher priority in polling (picked up as `task_assigned`). No epic context.

2. **Mechanism B (epic_progress_changed trigger):** Detected during polling via `getEpicsWithProgressUpdates()`. Lower priority (5th in the poll order). Includes epic name, goal, progress, task stats, and explicit instructions to plan next steps.

The lead processes Mechanism A first. By the time Mechanism B fires (if the lead has capacity), the lead may already be in a different session. This means the explicit "plan next steps" instruction from Mechanism B may never reach the lead.

#### Poll Priority Order for Lead (`src/http/poll.ts`)

1. Offered tasks
2. Pending tasks (including follow-ups) ← follow-ups land here
3. Unread mentions
4. Slack inbox messages
5. Epic progress changes ← epic-aware prompt lands here (lowest)

### 3. Heartbeat System and Stall Detection

#### Configuration (`src/heartbeat/heartbeat.ts:22-37`)

| Constant | Default | Purpose |
|----------|---------|---------|
| `DEFAULT_INTERVAL_MS` | 90s | Sweep interval |
| `STALL_THRESHOLD_MINUTES` | 30 min | Task stall detection |
| `STALE_CLEANUP_THRESHOLD_MINUTES` | 30 min | Resource cleanup |
| `MAX_AUTO_ASSIGN_PER_SWEEP` | 5 | Pool task auto-assignment cap |

#### Three-Tier Pipeline

- **Tier 1 (Preflight):** Cheap gate — bail if no in-progress tasks, no unassigned tasks, no idle workers.
- **Tier 2 (Triage):** Detect stalled tasks (in_progress > 30min with no `lastUpdatedAt` change), fix worker health mismatches (busy with 0 tasks, idle with active tasks), auto-assign pool tasks round-robin, clean up stale resources.
- **Tier 3 (Escalation):** If stalled tasks found → create a `taskType: "heartbeat"` triage task for the lead with priority 70.

#### Key Gap: No Epic-Level Stall Detection

The heartbeat operates exclusively at the individual task level. There is **no code anywhere** that detects:
- An epic with no active tasks that isn't completed
- An epic that hasn't had progress in X hours
- An epic where all tasks completed but the goal isn't met

If the lead fails to create follow-up tasks after a completion, the epic silently stalls forever.

### 4. Workflow and Schedule Systems

#### Workflows: Event-Driven DAG Engine

- **12 node types:** 6 triggers, 3 filters, 3 actions
- **Triggers:** `trigger-new-task`, `trigger-task-completed`, `trigger-webhook`, `trigger-email`, `trigger-slack-message`, `trigger-github-event`
- **Actions:** `create-task` (async — pauses workflow), `delegate-to-agent` (async), `send-message` (instant)
- **Async resume:** When a workflow creates a task, it pauses. On task completion, the event bus resumes the workflow and continues the DAG.
- **Agents can create/trigger workflows** via 9 MCP tools

#### Workflow-Epic Gap

There is **no connection** between workflows and epics:
- No `trigger-epic-*` node types
- No epic status change events on the event bus
- No action nodes that update epics
- Workflows can create tasks but cannot assign them to epics (the `create-task` node doesn't support `epicId`)

#### Schedules: Timer-Based Task Creation

- Cron expressions or interval-based, with timezone support
- Create tasks via `createTaskExtended()` with `source: "schedule"`
- Error backoff with auto-disable after 5 failures
- Can indirectly trigger workflows (via `task.created` event bus emission)

#### Where Workflows Fit

Workflows are well-suited for **reactive automation**: PR opened → classify → create review task. They are NOT suited for goal-driven work because:
- They're stateless DAGs (no memory of previous runs)
- They can't evaluate whether a goal is met
- They can't adapt their execution based on results
- They have no loop construct

However, workflows could be **valuable infrastructure for the drive loop**:
- A `trigger-task-completed` workflow could auto-post progress to Slack
- An `trigger-epic-status-changed` trigger (new) could fire on epic state transitions
- A `send-slack-message` action node (new) could enable stakeholder notifications

### 5. Memory System and Self-Improvement

#### Current Memory Architecture

From the 2026-02-20 plans and current codebase:

- **Storage:** `agent_memory` table with content, embedding (512-dim BLOB), scope (agent/swarm), source, tags
- **Auto-indexing on task completion** (`store-progress.ts:187-228`): Creates agent-scoped memory with embedding. Auto-promotes to swarm scope only for `research` type or `knowledge`/`shared` tags.
- **Session summarization:** Haiku summarizes transcript at Stop hook, indexed as `session_summary` memory
- **Memory search:** `memory-search` MCP tool with semantic similarity + keyword fallback

#### Self-Improvement Gaps (from `thoughts/researcher/research/2026-02-20-agent-self-improvement.md`)

10 gaps were identified. Most relevant to the drive loop:

- **Gap 9:** Memory retrieval is optional — agents rarely call `memory-search`
- **Gap 5:** No cross-task knowledge transfer (worker-to-worker only via swarm scope)
- **Gap 2:** No structured reflection protocol
- **Gap 10:** No swarm-level learning metrics

#### Approved Proposals (P1-P7)

Several were implemented:
- **P1** (index failed tasks) ✅ Done — `store-progress.ts:180-182` handles failed tasks
- **P3** (auto-promote research/knowledge to swarm) ✅ Done — `store-progress.ts:200-224`
- **P6** (inject-learning tool) ✅ Done — `src/tools/inject-learning.ts`

Not yet implemented:
- **P7** (memory-informed task prompting — search at task start, inject top 5) ❌ Not done — this is exactly the "server-side memory injection" gap

### 6. External Framework Patterns

#### CrewAI: Hierarchical Process

- Manager agent (analogous to lead) coordinates a crew
- Sequential or hierarchical execution modes
- Manager decides when the crew's goal is met
- **Termination:** Manager evaluates if the final answer satisfies the goal. If not, re-delegates.

#### AutoGen: Composable Termination Conditions

- `MaxMessageTermination(n)` — stop after N messages
- `TextMentionTermination("TERMINATE")` — stop when agent says a keyword
- Conditions compose: `cond1 | cond2`, `cond1 & cond2`
- **Key pattern:** Termination is explicit, composable, and evaluated after every agent turn

#### LangGraph: Stateful Loops with Checkpointing

- `should_continue()` function at each node decides whether to loop or end
- Thread-based state persistence via checkpointers (SQLite, Postgres)
- Resume from any checkpoint point
- **Key pattern:** State persists across sessions via serializable checkpoints

#### The Ralph Loop (Fresh Context per Cycle)

- Each cycle starts with a fresh context window
- State is passed via filesystem (progress files, todo lists)
- Prevents context rot in long-running tasks
- **Key pattern:** Don't rely on in-context memory for long tasks — use files

### 7. Historical Context from thoughts/

#### Previously Identified but Not Implemented

From `thoughts/researcher/plans/2026-02-20-agent-self-improvement-plan.md`:

**P7: Memory-Informed Task Prompting** — "Search memories at task start, inject top 5 results with >0.4 similarity into initial prompt." This is exactly the server-side memory injection concept. It was approved but never implemented.

**P5: Post-Task Reflection** — "REQUIRED in work-on-task command: write learnings, update identity/tools files." Would strengthen the compounding loop.

From `thoughts/taras/plans/2026-02-20-memory-system.md`:
- The memory system was designed with auto-indexing hooks but the retrieval/injection side was left as manual `memory-search` calls.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/be/migrations/001_initial.sql` | 41-68 | Epic table schema with plan/prd/status fields |
| `src/types.ts` | 402-448 | EpicStatusSchema, EpicSchema, EpicWithProgressSchema |
| `src/tools/store-progress.ts` | 231-272 | Follow-up task creation for lead (no epic context) |
| `src/tools/store-progress.ts` | 187-228 | Memory indexing on task completion |
| `src/commands/runner.ts` | 914-1001 | Epic progress trigger prompt (reads goal, not plan/prd) |
| `src/commands/runner.ts` | 868-880 | Generic task_assigned prompt building |
| `src/http/poll.ts` | 62-130 | Lead poll priority: pending tasks > epic progress (last) |
| `src/heartbeat/heartbeat.ts` | 138-141 | Task-level stall detection (30min threshold) |
| `src/heartbeat/heartbeat.ts` | 241-305 | Escalation to lead (task-level only) |
| `src/prompts/base-prompt.ts` | 11-181 | Lead system prompt (no follow-up handling instructions) |
| `src/workflows/engine.ts` | 22-122 | Workflow DAG execution engine |
| `src/workflows/triggers.ts` | 5-51 | Workflow trigger matching (no epic events) |
| `src/be/db.ts` | 4661-4707 | getEpicsWithProgressUpdates() query |
| `src/be/db.ts` | 4727-4739 | markEpicsProgressNotified() |
| `new-ui/src/pages/epics/[id]/page.tsx` | 595-596 | UI: only place plan/prd are rendered |

## Architecture Documentation

### Current Flow: Epic Task Completion

```
Worker completes task (epicId set)
  │
  ├─[1] store-progress creates follow-up for lead
  │     "Worker task completed — review needed" (NO epic context)
  │     Priority: HIGH (pending task, 2nd in poll order)
  │
  └─[2] epic_progress_changed trigger fires on next poll
        Includes: epic name, goal, progress, task stats
        Instructions: "Review, determine if complete, plan next steps"
        Priority: LOW (5th in poll order)

Lead processes [1] first → reviews output, maybe replies to Slack
Lead MAY process [2] later → IF it has capacity after [1]
                            → IF [2] hasn't been superseded by new triggers

If lead doesn't process [2] → epic silently stalls
If lead processes [2] but doesn't create tasks → epic silently stalls
If lead session crashes → epic silently stalls
No stall detection at epic level → nobody notices
```

### Proposed Flow: Drive Loop

```
Worker completes task (epicId set)
  │
  ├─[1] store-progress creates ENHANCED follow-up for lead
  │     Includes: epic context (goal, plan, progress, recent completions)
  │     Directive: "Evaluate goal completion. If not done, create next tasks."
  │     This REPLACES the separate epic_progress_changed trigger
  │
  └─[2] Epic Heartbeat (every 30-60 min)
        Scans active epics with no in-progress/pending tasks
        Creates lead task: "Epic X has stalled — evaluate and drive forward"
        Catches: lead crash, missed follow-ups, forgotten epics

Goal Evaluation Loop (in lead's follow-up processing):
  Read epic plan/prd → Check progress → Evaluate if goal met
    → YES: update-epic status=completed, notify stakeholder
    → NO, clear next steps: create tasks with epicId, continue
    → NO, unclear/blocked: notify stakeholder, set status=blocked

Safety Rails:
  - Max tasks per epic per cycle (prevent runaway creation)
  - Budget/token limits per epic
  - Human checkpoint after N completed tasks
  - Automatic blocked status if lead can't determine next steps
```

## Historical Context (from thoughts/)

### Directly Related Research

- `thoughts/shared/research/2026-01-16-epics-feature-research.md` — Original epic architecture research. Epics were designed as project containers with progress tracking, but no drive loop was in scope.

- `thoughts/researcher/research/2026-02-20-agent-self-improvement.md` — Identified Gap 9 (memory retrieval is optional) and proposed P7 (memory-informed task prompting). P7 was approved but never implemented. This is the server-side memory injection concept.

- `thoughts/taras/plans/2026-02-20-memory-system.md` — Memory system was designed with auto-indexing but manual retrieval. The plan anticipated this gap but deferred injection to a future iteration.

- `thoughts/taras/research/2026-03-06-workflow-engine-design.md` — Recent workflow engine research. Workflows were designed for reactive automation, not goal-driven loops.

### Related Plans

- `thoughts/shared/plans/2026-01-16-epics-feature-implementation.md` — 5-phase epic implementation. Phase 5 was testing. No drive loop was planned.
- `thoughts/researcher/plans/2026-02-20-agent-self-improvement-plan.md` — P7 (memory-informed prompting) approved but unimplemented.

## Open Questions (with Taras’s feedback)

1. **Non-epic goals:** When a user says “work on X” without an epic, should the system auto-create an epic? Or is there a lighter-weight “goal” concept?
   - **Decision:** Don’t auto-create. The lead should ask the user if they want to create an epic, not assume by default.

2. **Termination conditions:** How does the lead decide “the goal is met”?
   - **Decision:** User-confirmed completion. The last step of any epic should be user approval (“ok lgtm”), then the swarm marks it complete. Same pattern as when an epic is blocked for user feedback. Consider adding distinct statuses for “awaiting user review” vs “blocked on external dependency.”

3. **Budget and safety limits:** What prevents a drive loop from burning unlimited API credits?
   - **Decision:** Add a notion of “investment level” per epic — how much we’re willing to invest in terms of tasks/tokens/credits. Configurable per-epic.

4. **Follow-up deduplication:** The current dual-mechanism (store-progress follow-up + epic_progress_changed trigger) creates a race condition.
   - **Decision:** Must be resolved. Merge into a single mechanism or ensure idempotency. Race conditions are unacceptable.

5. **Workflow integration:** Should epic status changes emit events on the workflow event bus?
   - **Decision:** Yes. Epic status changes should emit events to enable workflows like “epic completed → post to Slack” or “epic blocked → create GitHub issue.”

6. **Worker-to-worker knowledge transfer:** Should epic tasks get a new memory scope?
   - **Decision:** No new scope needed. The existing shared memory and shared drive mechanisms are sufficient. Workers who want to share should use those existing channels.

7. **Lead session continuity:** Should the lead write `nextSteps` to the epic before session ends?
   - **Decision:** Yes. The lead should persist its reasoning about next steps to the epic’s `nextSteps` field so the next session can pick up seamlessly.

---

## Implementation Status

The **memory compounding** and **epic context** portions of this research have been implemented:
- **Plan**: `thoughts/taras/plans/2026-03-08-memory-self-improvement-enhancements.md` (status: implemented)
- **PR**: https://github.com/desplega-ai/agent-swarm/pull/148 (v1.37.0)
- **What was implemented**: Auto-promotion of epic-linked learnings, stricter memory prompting, epic-aware follow-ups with plan/nextSteps, server-side memory injection, dedup of follow-up vs epic_progress_changed triggers, `nextSteps` field on epics (decision #7 above)
- **What remains**: The drive loop itself (epic state machine, heartbeat, goal evaluation, investment limits) — decisions #1-3 and #5 above
