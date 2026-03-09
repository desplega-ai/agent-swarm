---
date: 2026-03-08T19:00:00-05:00
topic: "Memory & Self-Improvement Enhancements"
planner: Claude
git_commit: 94b35ac22ee9f35581f18281a6e69751d90ebad6
branch: main
repository: agent-swarm
tags: [plan, memory, self-improvement, epic-context, auto-promotion]
status: implemented
autonomy: critical
last_updated: 2026-03-09
last_updated_by: Claude
---

# Memory & Self-Improvement Enhancements Implementation Plan

## Overview

The agent-swarm creates memories correctly (task completions, session summaries, manual learnings) but fails to **surface** them when they'd be useful. Agents are instructed to call `memory-search` but rarely do (Gap 9 from self-improvement audit). Meanwhile, the lead's follow-up tasks for epic-linked work contain no epic context, and the auto-promotion filter is too narrow — most implementation learnings stay agent-scoped and invisible to the rest of the swarm.

This plan implements four improvements that make memory compounding automatic rather than opt-in, and make epic context flow through the system where it's needed.

## Current State Analysis

### Memory Injection (P7 — never implemented)

`fetchRelevantMemories()` in `runner.ts:1039-1077` already exists and works — it searches memories by embedding similarity and formats results as markdown. It's called at `runner.ts:2122-2134` for `task_assigned` and `task_offered` triggers only. However:
- It only searches with the task description as the query, missing epic context
- It doesn't include epic plan/prd/nextSteps
- It doesn't include recent completed task summaries from the same epic
- Resumed tasks get **zero** memory injection (`runner.ts:1940-2056`)

### Memory Prompting

`BASE_PROMPT_FILESYSTEM` in `base-prompt.ts:204-258` contains the memory instructions. The key line is:

> **Session boot:** At the start of each session, use `memory-search` to recall relevant context for your current task. Your past learnings are searchable.

This is advisory — agents can and do skip it. There's no enforcement in `work-on-task.md` either.

### Auto-Promotion Filter

`store-progress.ts:200-205` — the `shouldShareWithSwarm` boolean:
```typescript
const shouldShareWithSwarm =
  status === "completed" &&
  (result.task!.taskType === "research" ||
    result.task!.tags?.includes("knowledge") ||
    result.task!.tags?.includes("shared"));
```

This excludes all `implementation`, `planning`, `quick-fix`, and `general` tasks from swarm-scope promotion. Workers on the same epic can't see each other's learnings unless they were explicitly tagged.

### Epic Context in Follow-ups

`store-progress.ts:231-272` creates follow-up tasks for the lead when workers finish. The follow-up description includes agent name, task description, and output — but does NOT include the task's `epicId`, the epic's goal/plan/nextSteps, or any directive to evaluate epic progress. The `epicId` string does not appear anywhere in `store-progress.ts`.

Separately, the `epic_progress_changed` trigger (`poll.ts:117-130`, prompt at `runner.ts:914-1001`) fires at lower priority and includes epic name, goal, progress, and task stats — but NOT plan/prd fields.

### Key Discoveries:
- `fetchRelevantMemories()` already works and formats nicely — we just need to enrich its query and extend its reach (`runner.ts:1039-1077`)
- Follow-up task creation has no `epicId` reference at all (`store-progress.ts:231-272`)
- The epic progress trigger only includes `epic.name`, `epic.goal`, `epic.progress`, `epic.status`, `epic.taskStats` — NOT `epic.plan` or `epic.prd` (`runner.ts:914-1001`)
- `inject-learning` creates agent-scoped memories (`inject-learning.ts:71-78`) — never swarm-scoped
- `searchMemoriesByVector` does brute-force cosine similarity in JS (`db.ts:5264-5324`) — works fine for current scale but worth noting
- Resumed tasks bypass memory injection entirely (`runner.ts:1940-2056`)

## Desired End State

1. **Every task starts with relevant memories injected automatically** — agents don't need to remember to call `memory-search`. The runner does it server-side before spawning Claude, including epic-specific context.
2. **Agent prompts enforce memory usage** — the instructions are stronger and integrated into the `work-on-task` flow, not just advisory.
3. **Implementation task learnings compound across the swarm** — epic-linked task completions auto-promote to swarm scope. Lead-injected learnings are swarm-scoped by default.
4. **The lead always has epic context when reviewing follow-ups** — follow-up tasks include the epic's goal, plan, and nextSteps. The dual-mechanism race condition is resolved.

## Quick Verification Reference

Common commands to verify the implementation:
- `bun run tsc:check`
- `bun run lint:fix`
- `bun test`

Key files to check:
- `src/commands/runner.ts` — Memory injection enrichment
- `src/tools/store-progress.ts` — Auto-promotion + epic-aware follow-ups
- `src/tools/inject-learning.ts` — Swarm-scope default
- `src/prompts/base-prompt.ts` — Stricter memory instructions
- `plugin/commands/work-on-task.md` — Memory check step

## What We're NOT Doing

- **Drive Loop**: Epic state machine, epic heartbeat, goal evaluation loop — separate plan
- **Epic event bus integration**: Workflow events for epic status changes — separate plan
- **New memory scopes**: No epic-scoped or team-scoped memories — existing agent/swarm scopes are sufficient (per Taras's decision)
- **Vector index optimization**: The brute-force cosine similarity in JS is fine for current scale
- **Pre-compaction memory flush**: Interesting OpenClaw pattern but separate effort

## Implementation Approach

Four phases, ordered by dependency (Phase 3 depends on knowing the auto-promotion rules from Phase 1, Phase 4 depends on the enriched query patterns from Phase 3). Each phase is independently testable.

---

## Phase 1: Broaden Auto-Promotion of Learnings

### Overview
Expand the `shouldShareWithSwarm` filter in `store-progress.ts` to include epic-linked tasks, and change `inject-learning.ts` to use swarm scope by default.

### Changes Required:

#### 1. Expand auto-promotion filter
**File**: `src/tools/store-progress.ts`
**Changes**: Modify the `shouldShareWithSwarm` condition (lines 200-205) to also promote completed tasks that belong to an active epic:

```typescript
const shouldShareWithSwarm =
  status === "completed" &&
  (result.task!.taskType === "research" ||
    result.task!.tags?.includes("knowledge") ||
    result.task!.tags?.includes("shared") ||
    (result.task!.epicId != null));
```

This ensures all epic-linked task completions become visible to other workers, enabling cross-worker knowledge transfer within the same project.

#### 2. Change inject-learning to swarm scope
**File**: `src/tools/inject-learning.ts`
**Changes**: Change `scope: "agent"` to `scope: "swarm"` at line 73. The lead's learnings are organizational knowledge — they should be visible to all workers, not just the target.

```typescript
createMemory({
  agentId: targetAgentId,
  scope: "swarm",  // was "agent"
  name: `Lead feedback: ${category} — ${learning.slice(0, 60)}`,
  content: `[Lead Feedback — ${category}]\n\n${learning}`,
  source: "manual",
})
```

#### 3. Update existing tests
**File**: `src/tests/self-improvement.test.ts`
**Changes**:
- Add test case: "epic-linked task promotes to swarm scope" — create a task with `epicId` set, complete it, verify swarm memory is created
- Update "regular task does NOT promote" test: ensure regular tasks **without** epicId still don't promote
- Update inject-learning test: verify scope is now "swarm" instead of "agent"

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Tests pass: `bun test src/tests/self-improvement.test.ts`
- [x] All tests pass: `bun test`

#### Manual Verification:
- [x] Start server, create a task with epicId, complete it via store-progress, verify both agent-scoped AND swarm-scoped memories exist in the DB
- [x] Use inject-learning tool, verify the created memory has scope "swarm"

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 2: Stricter Memory Prompting

### Overview
Strengthen memory usage instructions across all agent roles and integrate a memory check step into the work-on-task flow.

### Changes Required:

#### 1. Strengthen memory instructions in base prompt
**File**: `src/prompts/base-prompt.ts`
**Changes**: Replace the advisory "Session boot" paragraph in `BASE_PROMPT_FILESYSTEM` (around lines 226-227) with a stronger directive:

Replace:
```
**Session boot:** At the start of each session, use `memory-search` to recall relevant context for your current task. Your past learnings are searchable.
```

With:
```
**REQUIRED — Memory recall:** At the start of EVERY task, you MUST use `memory-search` with your task description to recall relevant context before doing any work. Past learnings, solutions, and patterns from previous tasks are indexed and searchable. Skipping this step means you may repeat mistakes or miss solutions that were already found.

Do this FIRST, before reading files, writing code, or making plans.
```

#### 2. Add memory check to work-on-task command
**File**: `plugin/commands/work-on-task.md`
**Changes**: Add an explicit memory search step early in the task workflow (after fetching task details, before starting work):

```markdown
## Step 2: Recall Relevant Memories

Before starting any work, search your memory for relevant context:
1. Use `memory-search` with the task description as query
2. If the task has an epicId, also search with the epic name/goal
3. Review any returned memories — they may contain solutions, patterns, or warnings from previous tasks
4. Use `memory-get` on any highly relevant results to get full details

This step is NOT optional. Past learnings compound your effectiveness.
```

#### 3. Add memory reminder to lead follow-up handling
**File**: `src/prompts/base-prompt.ts`
**Changes**: In `BASE_PROMPT_LEAD`, add instructions for how to handle follow-up tasks:

```
### Handling Follow-Up Tasks

When you receive a follow-up about a completed or failed worker task:
1. **Search memory first** — use `memory-search` to check if similar tasks have been attempted before
2. Review the output/failure reason
3. If the task belongs to an epic, check the epic's progress and plan
4. Decide: is the goal met? If not, create next task(s). If blocked, notify the stakeholder.
```

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test`

#### Manual Verification:
- [x] Read the rendered system prompt for a worker agent and verify the memory instructions are prominent and directive
- [x] Read the work-on-task.md file and verify the memory check step is clearly positioned before any work begins
- [x] Start a worker, assign a task, observe in logs/session that it calls memory-search early

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 3: Epic-Aware Follow-Up Tasks (Merge Dual Mechanism)

### Overview
Enrich the follow-up task created in `store-progress.ts` with epic context (goal, plan, nextSteps), and resolve the race condition between the follow-up and the `epic_progress_changed` trigger. Also enrich the epic progress trigger prompt to include plan/prd fields.

### Changes Required:

#### 1. Add epic context to follow-up task description
**File**: `src/tools/store-progress.ts`
**Changes**: After line 237 (where we check `!taskAgent.isLead`), look up the task's epic if `result.task.epicId` exists. Include the epic's goal, plan (truncated), and nextSteps in the follow-up description.

```typescript
// After checking !taskAgent.isLead and finding leadAgent
let epicContext = "";
if (result.task.epicId) {
  const epic = getEpicWithProgress(result.task.epicId);
  if (epic) {
    epicContext = `\n\n## Epic Context\n`;
    epicContext += `**Epic:** ${epic.name}\n`;
    epicContext += `**Goal:** ${epic.goal}\n`;
    epicContext += `**Progress:** ${epic.progress}% (${epic.taskStats.completed}/${epic.taskStats.total} tasks)\n`;
    if (epic.plan) {
      epicContext += `**Plan:**\n${epic.plan.slice(0, 1000)}\n`;
    }
    if (epic.nextSteps) {
      epicContext += `**Next Steps:**\n${epic.nextSteps}\n`;
    }
    epicContext += `\n**Action Required:** Review the output above in the context of this epic. `;
    epicContext += `If the epic goal is not yet met, create the next task(s) with epicId="${result.task.epicId}". `;
    epicContext += `If blocked or unclear, notify the stakeholder. `;
    epicContext += `If the goal is met, update the epic status to completed.`;
  }
}
```

Then append `epicContext` to the follow-up description. Also pass `epicId` to the follow-up task creation:
```typescript
createTaskExtended(followUpDescription + epicContext, {
  agentId: leadAgent.id,
  source: "system",
  taskType: "follow-up",
  parentTaskId: taskId,
  epicId: result.task.epicId || undefined,  // NEW: link follow-up to epic
  slackChannelId: result.task.slackChannelId,
  slackThreadTs: result.task.slackThreadTs,
  slackUserId: result.task.slackUserId,
})
```

#### 2. Enrich epic progress trigger with plan/prd
**File**: `src/commands/runner.ts`
**Changes**: In the `epic_progress_changed` prompt builder (around lines 948-983), add the epic's `plan` and `prd` fields to the per-epic section:

```typescript
// After the epic goal line in the prompt builder
if (epic.plan) {
  prompt += `**Plan:**\n${epic.plan.slice(0, 2000)}\n\n`;
}
if (epic.prd) {
  prompt += `**PRD:**\n${epic.prd.slice(0, 1000)}\n\n`;
}
```

#### 3. Add nextSteps field to epics table
**File**: `src/be/migrations/NNN_add_epic_next_steps.sql` (new migration, next number)
**Changes**:

```sql
ALTER TABLE epics ADD COLUMN nextSteps TEXT;
```

Also update:
- `src/types.ts` — Add `nextSteps` to EpicSchema
- `src/be/db.ts` — Update `rowToEpic` mapper, `updateEpic` function, and `getEpicById` to include the new field

#### 4. Expose nextSteps in update-epic tool
**File**: `src/tools/epics/update-epic.ts`
**Changes**: Add `nextSteps` as an optional string parameter so the lead can persist its reasoning about what to do next.

#### 5. Deduplicate follow-up and epic_progress_changed
**Files**: `src/tools/store-progress.ts`
**Changes**: After creating the follow-up for an epic-linked task, call `markEpicsProgressNotified([result.task.epicId])` (import from `db.ts`). This updates the `progressNotifiedAt` watermark so the same completion doesn't also trigger an `epic_progress_changed` event. This makes Mechanism A (follow-up) the primary path for per-task completions, while Mechanism B (epic progress) acts as a catch-all for batched completions or edge cases.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Migration applies cleanly on fresh DB: `rm agent-swarm-db.sqlite && bun run start:http` (check startup logs)
- [x] Migration applies cleanly on existing DB: `bun run start:http` (check startup logs)
- [x] All tests pass: `bun test`

#### Manual Verification:
- [x] Create an epic with a plan, assign a task to it, complete the task. Verify the follow-up task description includes epic context (goal, plan, progress, action directive).
- [x] Verify the follow-up task has the correct `epicId` set.
- [x] Check that `epic_progress_changed` does NOT re-fire for the same task completion (dedup via `progressNotifiedAt`).
- [x] Test the `update-epic` tool with `nextSteps` field — verify it persists and appears in `get-epic-details`.

**Implementation Note**: After completing this phase, pause for manual confirmation. This is the riskiest phase — the dual-mechanism deduplication needs careful testing.

---

## Phase 4: Server-Side Memory Injection (P7)

### Overview
Enrich the `fetchRelevantMemories()` function to include epic context in its search query, and extend memory injection to cover all trigger types and resumed tasks. Also inject recent completed task summaries for epic-linked tasks.

### Changes Required:

#### 1. Enrich memory search query with epic context
**File**: `src/commands/runner.ts`
**Changes**: Modify the memory injection block at lines 2122-2134. When the task has an `epicId`, construct a richer search query that includes the epic's goal and plan excerpt:

```typescript
if (trigger.type === "task_assigned" || trigger.type === "task_offered") {
  const task = trigger.task;
  let searchQuery = task.task; // task description

  // Enrich with epic context for better memory retrieval
  if (task.epicId) {
    const epic = getEpicWithProgress(task.epicId);
    if (epic) {
      searchQuery = `[Epic: ${epic.name}] ${epic.goal}\n\n${task.task}`;
    }
  }

  const memoryContext = await fetchRelevantMemories(apiUrl, apiKey, agentId, searchQuery);
  if (memoryContext) {
    triggerPrompt += memoryContext;
  }

  // Also inject recent completed task summaries from the same epic
  if (task.epicId) {
    const epicTaskContext = await fetchEpicTaskContext(apiUrl, apiKey, task.epicId, task.id);
    if (epicTaskContext) {
      triggerPrompt += epicTaskContext;
    }
  }
}
```

#### 2. Create fetchEpicTaskContext helper
**File**: `src/commands/runner.ts`
**Changes**: Add a new function that fetches recent completed task summaries from the same epic. This gives the current worker visibility into what previous workers accomplished:

```typescript
async function fetchEpicTaskContext(
  apiUrl: string,
  apiKey: string,
  epicId: string,
  currentTaskId: string,
): Promise<string | null> {
  // Fetch recent completed tasks for this epic (exclude current task)
  const response = await fetch(`${apiUrl}/api/tasks?epicId=${epicId}&status=completed&limit=5`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return null;
  const tasks = await response.json();

  const relevant = tasks.filter((t: any) => t.id !== currentTaskId);
  if (relevant.length === 0) return null;

  let context = "\n\n### Recent Epic Task Completions\n\n";
  context += "These tasks were recently completed in the same epic:\n\n";
  for (const t of relevant.slice(0, 5)) {
    context += `- **${t.task.slice(0, 100)}**: ${(t.output || "no output").slice(0, 200)}\n`;
  }
  return context;
}
```

**Note**: Verify that the tasks API endpoint supports `?epicId=` and `?status=` query filters. If not, add them to `src/http/tasks.ts`.

#### 3. Extend memory injection to resumed tasks
**File**: `src/commands/runner.ts`
**Changes**: In the paused task resume phase (lines 1940-2056), after building the resume prompt, add memory injection:

```typescript
// After buildResumePrompt returns, before spawnClaudeProcess
const resumeSearchQuery = task.task;
const resumeMemoryContext = await fetchRelevantMemories(apiUrl, apiKey, agentId, resumeSearchQuery);
if (resumeMemoryContext) {
  resumePrompt += resumeMemoryContext;
}
```

#### 4. Extend memory injection to epic_progress_changed trigger
**File**: `src/commands/runner.ts`
**Changes**: After the `buildPromptForTrigger()` call, extend the memory injection block to also cover `epic_progress_changed`:

```typescript
// For epic progress triggers, search memories related to the epic goals
if (trigger.type === "epic_progress_changed" && trigger.epics) {
  const epicQueries = trigger.epics.map((e: any) => `${e.epic.name}: ${e.epic.goal}`).join("\n");
  const memoryContext = await fetchRelevantMemories(apiUrl, apiKey, agentId, epicQueries);
  if (memoryContext) {
    triggerPrompt += memoryContext;
  }
}
```

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test`

#### Manual Verification:
- [x] Start server and worker. Create some memories manually. Assign a task and observe in worker logs that the prompt includes "Relevant Past Knowledge" section.
- [x] Create an epic with 2 tasks. Complete task 1, then assign task 2. Verify task 2's prompt includes both memory context AND "Recent Epic Task Completions" section with task 1's summary.
- [x] Pause a worker mid-task (kill container). Resume it. Verify the resumed task gets memory injection.
- [x] Trigger an `epic_progress_changed` event. Verify the lead's prompt includes memory context related to the epic goals.

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Testing Strategy

### Unit Tests
- **Phase 1**: Extend `self-improvement.test.ts` with epic-linked promotion test and inject-learning scope test
- **Phase 3**: Add tests for epic context in follow-up descriptions, nextSteps field persistence
- **Phase 4**: Add tests for `fetchEpicTaskContext` helper, enriched search query construction

### Integration Tests
- Test the full flow: create epic → create task with epicId → complete task → verify follow-up has epic context + swarm memory created + memory searchable

### Manual E2E
```bash
# Start server
bun run start:http

# Create an agent
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  http://localhost:3013/api/agents -d '{"name":"test-worker","isLead":false}'

# Create an epic with a plan
# (use MCP or API to create epic with plan field set)

# Create a task linked to the epic
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  http://localhost:3013/api/tasks -d '{"task":"Implement feature X","epicId":"<epic-id>","agentId":"<worker-id>"}'

# Complete the task via store-progress (through MCP)
# Verify: follow-up task has epic context, swarm memory exists, next task gets memory injection
```

## Implementation Summary

**Implemented**: 2026-03-09 by Claude
**PR**: https://github.com/desplega-ai/agent-swarm/pull/148
**Version**: 1.37.0
**Branch**: `feat/memory-self-improvement-enhancements`

### Commits
1. `ec03155` — Phase 1: Broaden auto-promotion of learnings
2. `1c71f0a` — Phase 2: Strengthen memory prompting across agent roles
3. `210b478` — Phase 3: Epic-aware follow-up tasks and deduplication
4. `6e7c611` — Phase 4: Server-side memory injection enrichment
5. `7a114f0` — Bump version to 1.37.0

### E2E Verification
- All 1118 unit tests pass
- Migration 005 applies cleanly on fresh and existing DBs
- Live server E2E: swarm memory promotion, inject-learning scope, epic-aware follow-ups, nextSteps, dedup all confirmed
- Docker worker E2E: server-side memory injection (`task_assigned` trigger) confirmed — worker received 4 "Relevant Past Knowledge" entries and 2 "Recent Epic Task Completions"
- Prompt-based enforcement (Phase 2) confirmed as fallback for `pool_tasks_available` triggers

### What's Left (from "What We're NOT Doing")
The drive loop (epic state machine, goal evaluation loop) remains a separate effort — see the drive loop research below.

## References

### Upstream research (2026-03-08 learning loop session)
- `thoughts/taras/research/2026-03-08-drive-loop-concept.md` — Drive loop research with codebase analysis. This plan implements the **memory compounding** and **epic context** portions identified in that research. The drive loop itself (epic state machine, heartbeat, goal evaluation) is deferred to a separate plan.
- `thoughts/taras/research/2026-03-08-openclaw-memory-patterns.md` — OpenClaw memory patterns (web research). Informed the auto-promotion and memory injection design.
- `thoughts/swarm-researcher/research/2026-02-23-openclaw-vs-agent-swarm-comparison.md` — OpenClaw vs agent-swarm comparison

### Original gap analysis
- `thoughts/researcher/plans/2026-02-20-agent-self-improvement-plan.md` — Original P7 proposal (memory injection at task start)
- `thoughts/researcher/research/2026-02-20-agent-self-improvement.md` — Gap analysis identifying Gap 9 (agents don't call memory-search). This plan addresses Gap 9 via both server-side injection (Phase 4) and prompt enforcement (Phase 2).
