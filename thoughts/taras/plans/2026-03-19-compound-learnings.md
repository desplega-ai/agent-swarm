---
date: 2026-03-19T00:00:00Z
topic: "Compound Learnings for Tasks and Schedules"
status: draft
---

# Plan: Compound Learnings for Tasks and Schedules

## Goal

Add a `compound` field to tasks and schedules that enables automatic per-task learning extraction at session end via LLM summarization, storing structured, categorized learnings in memory.

## Current State

- **Session summary** (Stop hook): Reads last 20KB of transcript, sends to Haiku with a generic "extract learnings" prompt, stores as `source: "session_summary"`, agent-scoped. Not task-aware, not categorized.
- **Task completion memory** (store-progress): Stores raw `Task: {desc}\n\nOutput: {output}` as `source: "task_completion"`. No LLM summarization. Auto-promotes to swarm scope for research/knowledge/epic tasks.
- Gap: No **task-specific, LLM-summarized, categorized** learning extraction exists.

## Desired End State

- Tasks and schedules have a `compound` field: `"off" | "self" | "swarm" | "both"`
- When a task with `compound` set completes, the Stop hook runs a **task-aware** Haiku prompt that extracts learnings by category (mistakes, patterns, codebase knowledge, environment, failed approaches, recommendations)
- Learnings stored with `source: "compound"` in the configured scope(s)
- Workers auto-recall compound learnings via existing `memory-search` at task start (already mandated by base prompt)
- Schedules pass `compound` through to created tasks

## What We're NOT Doing

- No custom `compoundPrompt` per schedule (deferred)
- No dedicated UI dashboard for compound memories (existing `memory-search` suffices)
- No transcript optimization/trimming (v1 uses raw last 20,000 characters of transcript)
- No changes to the memory recall flow (base prompt already mandates `memory-search` at task start)

## Quick Verification Reference

```bash
bun run tsc:check        # Type check
bun run lint:fix          # Lint + format
bun test                  # Unit tests
```

## Overview

```
Schedule (compound: "swarm")
  → Scheduler creates task (compound: "swarm")
    → Worker picks up task, runs in its own Claude session
      → Session ends (Stop hook fires)
        → Hook fetches full task from API → sees compound: "swarm"
        → Reads transcript (up to 20KB)
        → Sends task-specific prompt to Haiku:
            "You were asked to: {task description}"
            "The outcome was: {output}"
            "Extract learnings by category..."
        → Stores result in memory with source: "compound", scope: "swarm"
        → Skips generic session summary (compound replaces it)
```

### Compound Strategies

| Value | Behavior |
|-------|----------|
| `"off"` (default) | No compound learning. Existing behavior unchanged. |
| `"self"` | Extract learnings, store agent-scoped only. |
| `"swarm"` | Extract learnings, store swarm-scoped (all agents can search). |
| `"both"` | Store in both agent and swarm scopes. |

---

## Phase 1: Schema & Types

### Overview
Add `compound` column to task and schedule tables, update the `agent_memory` CHECK constraint to accept `"compound"` as a source, and update TypeScript types.

### Changes Required

**1.1 Migration file:** `src/be/migrations/008_compound.sql`

```sql
ALTER TABLE agent_tasks ADD COLUMN compound TEXT DEFAULT 'off';
ALTER TABLE scheduled_tasks ADD COLUMN compound TEXT DEFAULT 'off';

-- Rebuild agent_memory to update CHECK constraint (SQLite can't ALTER CHECK)
CREATE TABLE agent_memory_new (
    id TEXT PRIMARY KEY,
    agentId TEXT,
    scope TEXT NOT NULL CHECK(scope IN ('agent', 'swarm')),
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT,
    embedding BLOB,
    source TEXT NOT NULL CHECK(source IN ('manual', 'file_index', 'session_summary', 'task_completion', 'compound')),
    sourceTaskId TEXT,
    sourcePath TEXT,
    chunkIndex INTEGER DEFAULT 0,
    totalChunks INTEGER DEFAULT 1,
    tags TEXT DEFAULT '[]',
    createdAt TEXT NOT NULL,
    accessedAt TEXT NOT NULL
);
INSERT INTO agent_memory_new SELECT * FROM agent_memory;
DROP TABLE agent_memory;
ALTER TABLE agent_memory_new RENAME TO agent_memory;

-- Recreate indexes (SQLite drops them with the table)
CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agentId);
CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory(scope);
CREATE INDEX IF NOT EXISTS idx_agent_memory_source ON agent_memory(source);
CREATE INDEX IF NOT EXISTS idx_agent_memory_created ON agent_memory(createdAt);
CREATE INDEX IF NOT EXISTS idx_agent_memory_source_path ON agent_memory(sourcePath);
```

**1.2 Type changes:** `src/types.ts`
- Add `compound` to `AgentTaskSchema` (enum: `"off" | "self" | "swarm" | "both"`, default `"off"`)
- Add `compound` to `ScheduledTaskSchema` (same enum)
- Add `"compound"` to `AgentMemorySource` schema

**1.3 DB functions:** `src/be/db.ts`
- Add `compound` to `CreateTaskOptions` interface
- Add `compound` to `createTaskExtended()` INSERT statement
- Add `compound` to `CreateScheduledTaskData` interface
- Add `compound` to `createScheduledTask()` INSERT
- Add `compound` to `updateScheduledTask()` dynamic update fields

### Verification
```bash
bun run tsc:check
rm -f agent-swarm-db.sqlite* && bun run start:http
sqlite3 agent-swarm-db.sqlite "PRAGMA table_info(agent_tasks)" | grep compound
sqlite3 agent-swarm-db.sqlite "PRAGMA table_info(scheduled_tasks)" | grep compound
sqlite3 agent-swarm-db.sqlite "SELECT sql FROM sqlite_master WHERE name='agent_memory'" | grep compound
```

---

## Phase 2: Tool Integration

### Overview
Wire `compound` through the MCP tools (`send-task`, `create-schedule`, `update-schedule`) and the scheduler so tasks created from schedules inherit the compound setting.

### Changes Required

**2.1 `src/tools/send-task.ts`**
- Add `compound` to input schema (enum `"off" | "self" | "swarm" | "both"`, optional, default `"off"`)
- Pass through to `createTaskExtended()`

**2.2 `src/tools/schedules/create-schedule.ts`**
- Add `compound` to input schema (same enum)
- Pass through to `createScheduledTask()`

**2.3 `src/tools/schedules/update-schedule.ts`**
- Add `compound` to updateable fields

**2.4 `src/scheduler/scheduler.ts`**
- In `executeSchedule()`: pass `schedule.compound` to `createTaskExtended()`
- In `recoverMissedSchedules()`: same
- In `runScheduleNow()`: same

### Verification
```bash
bun run tsc:check
bun run lint:fix
bun test
```

---

## Phase 3: Store-Progress Deduplication

### Overview
Skip raw `task_completion` memory creation for compound tasks — the Stop hook will produce a richer, LLM-summarized version. Raw output remains accessible via `get-task-details`.

### Changes Required

**3.1 `src/tools/store-progress.ts`**

Inside the existing status/success guard (line 178), add a compound check before the memory creation IIFE:

```typescript
// Line 178: if ((status === "completed" || status === "failed") && result.success && result.task) {
const taskCompound = result.task?.compound ?? "off";
if (taskCompound === "off") {
  // Existing behavior: create raw task_completion memory (lines 179-232)
  (async () => { ... })();
}
// If compound is set, skip — the Stop hook will handle learning extraction
```

### Verification
```bash
bun run tsc:check
bun test
```

---

## Phase 4: Stop Hook — Compound Learning Extraction

### Overview
The core of the feature. When a task has `compound` set, the Stop hook fetches the full task, runs a task-specific Haiku prompt with categorized output, and stores learnings in the configured scope(s). Replaces the generic session summary for compound tasks.

### Changes Required

**4.1 Fetch full task from API** — `src/hooks/hook.ts`

Add new `fetchFullTask()` helper (separate from existing `fetchTaskDetails()` which is used by PreCompact):

```typescript
interface FullTaskData {
  id: string;
  task: string;
  status: string;
  output?: string;
  failureReason?: string;
  compound?: string;
}

async function fetchFullTask(taskId: string): Promise<FullTaskData | null> {
  const apiUrl = process.env.MCP_BASE_URL || "http://localhost:3013";
  const apiKey = process.env.API_KEY || "";
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetch(`${apiUrl}/api/tasks/${taskId}`, { headers });
    if (!response.ok) return null;
    return (await response.json()) as FullTaskData;
  } catch {
    return null;
  }
}
```

**4.2 Compound-specific summarization prompt** — `src/hooks/hook.ts`

Task-aware, category-structured prompt (replaces generic one when `compound !== "off"`):

```typescript
const compoundPrompt = `You are extracting reusable learnings from a completed agent task.

## Task Context
**Task:** ${taskDescription}
**Outcome:** ${status === "completed" ? "Completed successfully" : "Failed"}
${output ? `**Output:** ${output.slice(0, 2000)}` : ""}
${failureReason ? `**Failure Reason:** ${failureReason}` : ""}

## Instructions
Extract learnings that would help ANY agent performing a SIMILAR task in the future.
Structure your response in these categories (skip empty categories):

### Mistakes & Corrections
What went wrong and what fixed it. Include the wrong approach AND the correction.

### Effective Patterns
Reusable approaches, APIs, or techniques that worked well.

### Codebase Knowledge
Important file paths, architecture decisions, gotchas, conventions discovered.

### Environment & Tooling
Service URLs, config details, CLI quirks, tool behaviors learned.

### Failed Approaches
What was tried and didn't work, and WHY it didn't work (so others don't repeat it).

### Recommendations
Concrete advice for similar future tasks.

If the session was routine with no significant learnings, respond with exactly: "No significant learnings."

## Session Transcript (last portion)
${transcript}`;
```

**4.3 Scope-aware memory storage** — `src/hooks/hook.ts`

```typescript
const scopes: Array<"agent" | "swarm"> = [];
if (compound === "self" || compound === "both") scopes.push("agent");
if (compound === "swarm" || compound === "both") scopes.push("swarm");

for (const scope of scopes) {
  await fetch(`${apiUrl}/api/memory/index`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      agentId: agentInfo.id,
      content: summary,
      name: `Compound: ${taskDescription.slice(0, 80)}`,
      scope,
      source: "compound",
      sourceTaskId: taskId,
    }),
  });
}
```

**4.4 Error handling** — `src/hooks/hook.ts`

Wrap compound extraction in try/catch. On failure, log a warning and fall through to the existing generic session summary as fallback (so learnings are never silently lost):

```typescript
try {
  // Run compound extraction (4.2 + 4.3 above)
} catch (err) {
  console.error("[compound] extraction failed, falling back to generic session summary:", err);
  // Fall through to existing session summary below
}
```

**4.5 Dedup with generic session summary** — `src/hooks/hook.ts`

In the Stop hook's session summarization block, branch on compound:

```typescript
if (fullTask?.compound && fullTask.compound !== "off") {
  // Run compound extraction (4.4 above, with fallback)
} else {
  // Existing generic session summary logic
}
```

### Verification
```bash
bun run tsc:check
bun run lint:fix
```

---

## Phase 5: Base Prompt Update

### Overview
Document compound learnings in the base prompt so workers know about the feature.

### Changes Required

**5.1 `src/prompts/base-prompt.ts`**

Update the "What gets auto-indexed" section (~line 291) to add:

```
- Compound learnings (when your task has `compound` set, structured learnings are extracted at session end)
```

### Verification
```bash
bun run tsc:check
```

---

## Phase 6: Version Bump

### Overview
Bump version for the new feature (minor bump — new capability, backward compatible).

### Changes Required

**6.1 `package.json`**
- Bump version from current → next minor (e.g., `1.45.1` → `1.46.0`)

### Verification
```bash
bun run tsc:check
```

---

## Phase 7: E2E Verification

### Overview
Full round-trip test to validate compound learnings work end-to-end. These steps will be executed automatically during implementation.

### Test Plan

1. Clean DB + start API server
2. Build Docker worker image with compound changes
3. Start a worker container
4. Wait for worker registration, capture worker ID
5. Create a task with `compound: "self"` assigned to the worker
6. Poll task until completion
7. Verify compound memory was created (`source: "compound"`)
8. Verify NO raw `task_completion` memory was created (dedup working)
9. Create a one-time schedule with `compound: "swarm"`, verify the created task inherits `compound: "swarm"`
10. Cleanup containers and API server

---

## Files Changed (Summary)

| File | Change |
|------|--------|
| `src/be/migrations/008_compound.sql` | Add `compound` column to `agent_tasks` and `scheduled_tasks`; rebuild `agent_memory` with updated CHECK |
| `src/types.ts` | Add `compound` to task/schedule schemas, add `"compound"` to memory source |
| `src/be/db.ts` | Add `compound` to `CreateTaskOptions`, `createTaskExtended`, `CreateScheduledTaskData`, `createScheduledTask`, `updateScheduledTask` |
| `src/tools/send-task.ts` | Add `compound` param to input schema |
| `src/tools/schedules/create-schedule.ts` | Add `compound` param to input schema |
| `src/tools/schedules/update-schedule.ts` | Add `compound` to updateable fields |
| `src/scheduler/scheduler.ts` | Pass `compound` from schedule to task in `executeSchedule`, `recoverMissedSchedules`, `runScheduleNow` |
| `src/tools/store-progress.ts` | Skip raw `task_completion` memory when task has `compound` set |
| `src/hooks/hook.ts` | Add `fetchFullTask()`, compound-specific prompt, scope-aware storage, dedup with session summary |
| `src/prompts/base-prompt.ts` | Update "What gets auto-indexed" to mention compound learnings |
| `package.json` | Version bump |
