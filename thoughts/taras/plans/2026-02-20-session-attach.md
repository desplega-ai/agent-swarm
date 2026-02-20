---
date: 2026-02-20T10:00:00Z
topic: "Session Attachment Implementation Plan"
author: Claude
branch: claw-session-attach
repository: agent-swarm
tags: [plan, session-attach, gap-3, runner, hooks]
status: draft
---

# Session Attachment Implementation Plan

## Overview

Implement session continuity for agent tasks. Today every task spawns a fresh Claude session (`-p` only). This plan adds `parentTaskId` linking between tasks and uses Claude CLI's `--resume` flag to continue child tasks in the parent's conversation context. Also implements the PreCompact hook to inject goal reminders before context compaction.

## Current State Analysis

- **Runner is one-shot**: `spawnClaudeProcess()` (`runner.ts:959`) always spawns with `-p` flag. No `--resume` or `--continue` used anywhere.
- **No parent linkage**: `agent_tasks` has no `parentTaskId` column. Tasks link to epics via `epicId` and to each other via `dependsOn`, but there's no session hierarchy.
- **Resume is prompt-based**: When a paused task resumes (`buildResumePrompt()` at `runner.ts:247`), it starts a fresh session injecting previous `progress` text. All conversation history is lost.
- **No Claude session ID tracking**: The runner generates its own `sessionId` for log grouping (`runner.ts:1271`) but never captures Claude CLI's internal session ID from stream-json output.
- **PreCompact hook is empty**: `hook.ts:510-512` — no-op with comment "Covered by SessionStart hook."
- **stream-json init message has session_id**: `{"type":"system","subtype":"init","session_id":"<uuid>"}` — emitted as the first message.
- **`--resume` works with `-p`**: Officially supported in headless mode. Each `--resume` invocation generates a NEW session ID (must chain from latest).

### Key Discoveries:
- `Trigger` interface (`runner.ts:486-513`) includes `task?: unknown` — the full task object from poll response, so `parentTaskId` will be available on it
- Poll endpoint (`http.ts:488-492`) returns `task: { ...pendingTask, status: "in_progress" }` — full task object spread
- Two call sites for `spawnClaudeProcess`: paused-task resume (`runner.ts:1437`) and trigger-based (`runner.ts:1533`)
- `TaskFileData` (`runner.ts:6-10`) written to `/tmp/agent-swarm-task-{pid}.json` contains `taskId` + `agentId` — hook reads via `TASK_FILE` env var
- Cost data is already fire-and-forget via `saveCostData()` (`runner.ts:1063-1080`) — same pattern for session ID storage

## Desired End State

1. Tasks can reference a parent task via `parentTaskId`
2. When a child task spawns, the runner automatically adds `--resume <parentSessionId>` so the Claude session continues from where the parent left off
3. Every task's Claude session ID is captured and stored in `claudeSessionId`
4. If the parent's session ID is unavailable, the system falls back gracefully to a fresh session (current behavior)
5. The PreCompact hook injects a goal reminder before context compaction to preserve task focus
6. The `send-task` MCP tool and HTTP API accept `parentTaskId` for creating child tasks

**Verification**: A lead can call `send-task` with `parentTaskId`, the worker picks up the child task, the runner spawns Claude with `--resume <parentSessionId>`, and the child session has the parent's conversation context.

## Quick Verification Reference

Common commands:
- `bun run tsc:check` — Type check
- `bun run lint:fix` — Lint & format
- `bun run start:http` — Start HTTP server (port 3013)

Key files:
- `src/be/db.ts` — Schema, migrations, `createTaskExtended`, `AgentTaskRow`, `rowToAgentTask`
- `src/commands/runner.ts` — `spawnClaudeProcess`, `buildPromptForTrigger`, trigger processing
- `src/tools/send-task.ts` — MCP tool for creating tasks
- `src/hooks/hook.ts` — PreCompact hook
- `src/types.ts` — `AgentTaskSchema`
- `src/http.ts` — REST API endpoints

## What We're NOT Doing

- **Memory system (Gap 2)**: No session summarization, memory indexing, or embedding work
- **Identity (Gap 1)**: No SOUL.md/IDENTITY.md changes
- **Deep prompt changes for child tasks**: The child task gets the parent's conversation context via `--resume`. We don't need special prompt modifications — the existing `buildPromptForTrigger` prompt works fine since `--resume` provides the conversation history
- **Recursive session chains**: We store `claudeSessionId` per task, which naturally supports A→B→C chains (C resumes from B's session ID, B resumed from A's). No special recursive logic needed.
- **UI changes**: No dashboard modifications for parent/child relationships (can come later)

## Implementation Approach

Five phases, each building on the previous:

1. **DB Schema + Types** — Add columns, update type system
2. **Session ID Capture** — Parse stream-json init message, store to DB
3. **send-task + API Extension** — Enable parent-child task creation
4. **--resume Logic** — Runner resolves parent session ID and passes `--resume` flag
5. **PreCompact Hook** — Goal reminder injection before context compaction

---

## Phase 1: DB Schema + Type System

### Overview
Add `parentTaskId` and `claudeSessionId` columns to `agent_tasks`, update all type definitions and the row-to-object mapper. Add a lightweight API endpoint for session ID updates.

### Changes Required:

#### 1. Database Migration
**File**: `src/be/db.ts`
**Changes**: Add two new column migrations using the existing try/catch ALTER TABLE pattern (after the last `agent_tasks` migration, currently around line 617).

```typescript
// Session attachment columns
try {
  db.run(`ALTER TABLE agent_tasks ADD COLUMN parentTaskId TEXT`);
} catch { /* exists */ }
try {
  db.run(`ALTER TABLE agent_tasks ADD COLUMN claudeSessionId TEXT`);
} catch { /* exists */ }
```

#### 2. AgentTaskRow Type
**File**: `src/be/db.ts:880-914`
**Changes**: Add two fields to the `AgentTaskRow` type:

```typescript
parentTaskId: string | null;
claudeSessionId: string | null;
```

#### 3. rowToAgentTask Mapper
**File**: `src/be/db.ts:916-952`
**Changes**: Add mapping for both new fields:

```typescript
parentTaskId: row.parentTaskId ?? undefined,
claudeSessionId: row.claudeSessionId ?? undefined,
```

#### 4. AgentTaskSchema (Zod)
**File**: `src/types.ts:59-109`
**Changes**: Add two optional fields to the schema:

```typescript
parentTaskId: z.uuid().optional(),
claudeSessionId: z.string().optional(),
```

#### 5. CreateTaskOptions Interface
**File**: `src/be/db.ts:1760-1782`
**Changes**: Add `parentTaskId` to the interface:

```typescript
parentTaskId?: string;
```

(`claudeSessionId` is NOT in `CreateTaskOptions` — it's set by the runner after process spawn, not at creation time.)

#### 6. createTaskExtended Function
**File**: `src/be/db.ts:1784-1847`
**Changes**: Add `parentTaskId` to the INSERT statement. Update the column list, VALUES placeholders, and the `.get()` arguments to include `options?.parentTaskId ?? null`.

#### 7. API Endpoint for Session ID Update
**File**: `src/http.ts`
**Changes**: Add new endpoint `PUT /api/tasks/:id/claude-session` that accepts `{ claudeSessionId: string }` and updates the task row. This is called by the runner after capturing the session ID from stream-json output.

```typescript
// PUT /api/tasks/:id/claude-session - Update Claude session ID (called by runner)
if (req.method === "PUT" && pathSegments[2] === "claude-session") {
  // Parse body, validate taskId exists, update claudeSessionId column
}
```

Also add a convenience DB function `updateTaskClaudeSessionId(taskId: string, sessionId: string)` in `db.ts`.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Server starts: `bun run start:http` (no crash)
- [x] Column exists: `sqlite3 agent-swarm-db.sqlite ".schema agent_tasks" | grep parentTaskId`
- [x] Column exists: `sqlite3 agent-swarm-db.sqlite ".schema agent_tasks" | grep claudeSessionId`

#### Manual Verification:
- [ ] Create a task via API with `parentTaskId` field — verify it's stored and returned
- [ ] Call `PUT /api/tasks/:id/claude-session` with a session ID — verify it persists
- [ ] GET the task — verify both `parentTaskId` and `claudeSessionId` are in the response

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 2: Session ID Capture

### Overview
Modify the runner's stdout stream parsing to capture Claude CLI's session ID from the `init` message and store it via the new API endpoint. This applies to both `spawnClaudeProcess` (parallel worker mode) and `runClaudeIteration` (legacy mode).

### Changes Required:

#### 1. Helper: Store Session ID via API
**File**: `src/commands/runner.ts`
**Changes**: Add a fire-and-forget helper function (near the existing `saveCostData` and `ensureTaskFinished` helpers):

```typescript
/** Save Claude session ID for a task (fire-and-forget) */
async function saveClaudeSessionId(
  apiUrl: string,
  apiKey: string,
  taskId: string,
  claudeSessionId: string,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  await fetch(`${apiUrl}/api/tasks/${taskId}/claude-session`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ claudeSessionId }),
  });
}
```

#### 2. Parse Init Message in `spawnClaudeProcess`
**File**: `src/commands/runner.ts:1043-1084` (inside the stdout line processing loop)
**Changes**: Add a branch before the existing `json.type === "result"` check to capture the init message:

```typescript
// Capture Claude session ID from init message
if (json.type === "system" && json.subtype === "init" && json.session_id) {
  if (opts.taskId) {
    saveClaudeSessionId(
      opts.apiUrl || "",
      opts.apiKey || "",
      opts.taskId,
      json.session_id,
    ).catch((err) => console.warn(`[runner] Failed to save session ID: ${err}`));
  }
}
```

This must come BEFORE the `json.type === "result"` check so it fires on the first JSON line.

#### 3. Parse Init Message in `runClaudeIteration` (legacy mode)
**File**: `src/commands/runner.ts:878-902` (the legacy mode stdout parsing)
**Changes**: Same init message parsing as above. Note: legacy mode doesn't have `opts.taskId` or API config readily available, so this may need to be skipped or passed through. Since the parallel mode (`spawnClaudeProcess`) is the primary target, legacy mode is lower priority — add a TODO comment if the plumbing is too complex.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Start a worker, assign it a task, check logs for `"type":"system","subtype":"init"` line
- [ ] After task starts, query `GET /api/tasks/:id` — verify `claudeSessionId` is populated
- [ ] Verify session ID capture is non-blocking (doesn't slow down stream processing)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 3: send-task, inbox-delegate, API + Lead Prompt

### Overview
Add `parentTaskId` parameter to all task creation surfaces — `send-task` MCP tool, `inbox-delegate` MCP tool, and HTTP endpoints. Critically, also update the lead's base prompt so it knows WHEN to use `parentTaskId` for session continuity.

**Context from review**: The lead's base prompt (`src/prompts/base-prompt.ts:11-167`) currently has zero guidance on task relationships. It doesn't mention `dependsOn` or any chaining mechanism. Without prompt guidance, the lead won't know to pass `parentTaskId` — especially in Slack flows where follow-up messages arrive as new inbox messages.

### Changes Required:

#### 1. send-task MCP Tool — Schema + Auto-Routing
**File**: `src/tools/send-task.ts:21-49`
**Changes**: Add `parentTaskId` to the input schema:

```typescript
parentTaskId: z
  .uuid()
  .optional()
  .describe("Parent task ID for session continuity. Child task will resume the parent's Claude session. Auto-routes to the same worker unless agentId is explicitly provided."),
```

**Worker affinity auto-routing**: When `parentTaskId` is provided and `agentId` is NOT explicitly set, look up the parent task's `agentId` and use it as the target worker. This ensures the child task runs on the same machine where the parent's Claude session data lives (required for `--resume` to work).

```typescript
// Auto-route to parent's worker if no explicit agentId
let effectiveAgentId = agentId;
if (parentTaskId && !agentId) {
  const parentTask = getTaskById(parentTaskId);
  if (parentTask?.agentId) {
    effectiveAgentId = parentTask.agentId;
    // Log or include in response message that auto-routing was applied
  }
}
```

If the lead explicitly passes `agentId`, that takes precedence (the lead knows what they're doing). If the parent task has no `agentId` (unassigned/pool task), skip auto-routing and let it go to the pool.

Pass `parentTaskId` through to `createTaskExtended` in all three call sites (unassigned at line 115, offered at line 158, direct assignment at line 176). Use `effectiveAgentId` instead of `agentId` for the routing decision.

#### 2. inbox-delegate MCP Tool
**File**: `src/tools/inbox-delegate.ts:12-31`
**Changes**: Add `parentTaskId` to the input schema:

```typescript
parentTaskId: z
  .uuid()
  .optional()
  .describe("Parent task ID. If the Slack message is a follow-up to a previous task, pass the parent task ID so the worker continues in the same session."),
```

Pass it through to `createTaskExtended` at line 85-92.

#### 3. Lead Base Prompt — Session Continuity Guidance
**File**: `src/prompts/base-prompt.ts`
**Changes**: Add a section after the delegation tools list (around line 58) explaining when to use `parentTaskId`:

```
### Session Continuity (parentTaskId)
When delegating a FOLLOW-UP task that should continue from a previous task's work:
- Pass \`parentTaskId\` with the previous task's ID
- The worker will resume the parent's Claude session, preserving full conversation context
- The child task is auto-routed to the same worker (session data is local to each worker)
- You can override with an explicit \`agentId\` if needed, but session resume only works on the same worker

Example scenarios:
- Worker researched a topic → you send an implementation task with parentTaskId = research task ID
- Slack user says "now do X" in the same thread → delegate with parentTaskId = previous task in that thread
- A task was partially done → send follow-up with parentTaskId to continue with context

**Important**: Session resume requires the child task to run on the SAME worker as the parent, because Claude's session data is stored locally. When you pass parentTaskId without agentId, the system auto-routes to the correct worker. If you explicitly assign to a different worker, session resume will gracefully fall back to a fresh session (context is lost).
```

#### 4. HTTP POST /api/tasks
**File**: `src/http.ts:1095-1137`
**Changes**: Pass `parentTaskId` from request body to `createTaskExtended`:

```typescript
const task = createTaskExtended(body.task, {
  // ... existing fields ...
  parentTaskId: body.parentTaskId || undefined,
});
```

#### 5. HTTP POST /api/epics/:id/tasks
**File**: `src/http.ts:1583-1641`
**Changes**: Same — pass `parentTaskId` if present in body.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Create a parent task via API, note its ID
- [ ] Create a child task via `POST /api/tasks` with `parentTaskId` set to parent's ID
- [ ] GET the child task — verify `parentTaskId` is present
- [ ] Via MCP: call `send-task` with `parentTaskId` but NO `agentId` — verify task is auto-routed to the parent's worker
- [ ] Via MCP: call `send-task` with `parentTaskId` AND explicit `agentId` — verify explicit `agentId` takes precedence
- [ ] Via MCP: call `inbox-delegate` with `parentTaskId` — verify task is created with the field
- [ ] Start a lead session — verify the base prompt includes session continuity guidance (check `--append-system-prompt` output)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 4: --resume Logic in Runner

### Overview
When the runner spawns a Claude process for a task that has `parentTaskId`, it looks up the parent task's `claudeSessionId` and adds `--resume <sessionId>` to the command. Falls back to fresh session if unavailable.

### Changes Required:

#### 1. Helper: Fetch Parent Session ID
**File**: `src/commands/runner.ts`
**Changes**: Add helper function to fetch a task's `claudeSessionId` via API:

```typescript
/** Fetch Claude session ID for a task (for --resume) */
async function fetchClaudeSessionId(
  apiUrl: string,
  apiKey: string,
  taskId: string,
): Promise<string | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetch(`${apiUrl}/api/tasks/${taskId}`, { headers });
    if (!response.ok) return null;
    const data = await response.json() as { claudeSessionId?: string };
    return data.claudeSessionId || null;
  } catch {
    return null;
  }
}
```

#### 2. Trigger Processing — Resolve Parent Session
**File**: `src/commands/runner.ts:1501-1556` (the trigger processing block in the main polling loop)
**Changes**: After `buildPromptForTrigger`, check if the trigger's task has `parentTaskId`. If so, resolve the parent's `claudeSessionId` and inject `--resume` into additional args:

```typescript
if (trigger) {
  const triggerPrompt = buildPromptForTrigger(trigger, prompt);

  // Resolve --resume for child tasks with parentTaskId
  let effectiveAdditionalArgs = opts.additionalArgs || [];
  const taskObj = trigger.task as { parentTaskId?: string } | undefined;
  if (taskObj?.parentTaskId) {
    const parentSessionId = await fetchClaudeSessionId(apiUrl, apiKey, taskObj.parentTaskId);
    if (parentSessionId) {
      effectiveAdditionalArgs = [...effectiveAdditionalArgs, "--resume", parentSessionId];
      console.log(
        `[${role}] Child task — resuming parent session ${parentSessionId.slice(0, 8)}`,
      );
    } else {
      console.log(
        `[${role}] Child task — parent session ID not found, starting fresh`,
      );
    }
  }

  // ... rest of spawn logic, using effectiveAdditionalArgs ...
}
```

#### 3. Paused Task Resume — Same Logic
**File**: `src/commands/runner.ts:1393-1455` (paused task resume loop)
**Changes**: When resuming a paused task, also check for `parentTaskId`. However, for paused tasks, we should prefer the task's own `claudeSessionId` (if it was captured before pause) over the parent's. This enables true session resume:

```typescript
// For paused tasks, prefer own session ID first, then parent's
let effectiveAdditionalArgs = opts.additionalArgs || [];
if (task.claudeSessionId) {
  effectiveAdditionalArgs = [...effectiveAdditionalArgs, "--resume", task.claudeSessionId];
  console.log(`[${role}] Resuming task's own session ${task.claudeSessionId.slice(0, 8)}`);
} else if (task.parentTaskId) {
  const parentSessionId = await fetchClaudeSessionId(apiUrl, apiKey, task.parentTaskId);
  if (parentSessionId) {
    effectiveAdditionalArgs = [...effectiveAdditionalArgs, "--resume", parentSessionId];
  }
}
```

Note: The paused task's `task` object comes from the API response which fetches via `SELECT *` — the new columns will be present after Phase 1's migration.

#### 4. Verify Paused Task API Response
**File**: `src/commands/runner.ts` — find where paused tasks are fetched (around line 1370-1390)
**Changes**: Verify the API response for paused tasks includes all fields including `parentTaskId` and `claudeSessionId`. Since the DB query uses `SELECT *` and `rowToAgentTask` maps all fields, this should work automatically. Just verify the type assertion.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Create a task, let a worker run it, verify `claudeSessionId` is captured
- [ ] Create a child task with `parentTaskId` pointing to the completed task
- [ ] Assign child task to a worker — verify runner logs show `--resume <sessionId>` in the spawned command
- [ ] Verify the child Claude session has context from the parent session (check Claude's behavior)
- [ ] Test fallback: create a child task pointing to a task with no `claudeSessionId` — verify fresh session starts without error

**Implementation Note**: After completing this phase, pause for manual confirmation. This is the critical phase — thorough testing needed.

---

## Phase 5: PreCompact Hook — Goal Reminder

### Overview
Implement the PreCompact hook to inject a goal reminder before Claude compacts context. This ensures the task description and current progress survive compaction.

### Changes Required:

#### 1. PreCompact Handler
**File**: `src/hooks/hook.ts:510-512`
**Changes**: Replace the empty `case "PreCompact"` handler with logic to fetch the current task's description and inject a reminder:

```typescript
case "PreCompact": {
  // Inject goal reminder before context compaction
  const taskFileData = await readTaskFile();
  if (taskFileData?.taskId) {
    try {
      const taskDetails = await fetchTaskDetails(taskFileData.taskId);
      if (taskDetails) {
        const reminder = [
          "=== GOAL REMINDER (injected before context compaction) ===",
          `Task ID: ${taskDetails.id}`,
          `Task: ${taskDetails.task}`,
        ];
        if (taskDetails.progress) {
          reminder.push(`Current Progress: ${taskDetails.progress}`);
        }
        reminder.push("=== Continue working on this task after compaction ===");
        console.log(reminder.join("\n"));
      }
    } catch {
      // Don't block compaction if fetch fails
    }
  }
  break;
}
```

#### 2. Helper: Fetch Task Details via API
**File**: `src/hooks/hook.ts`
**Changes**: Add a helper function (near the existing API helper functions) to fetch task details:

```typescript
async function fetchTaskDetails(taskId: string): Promise<{
  id: string;
  task: string;
  progress?: string;
} | null> {
  const apiUrl = process.env.MCP_BASE_URL || "http://localhost:3013";
  const apiKey = process.env.API_KEY || "";
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetch(`${apiUrl}/api/tasks/${taskId}`, { headers });
    if (!response.ok) return null;
    return await response.json() as { id: string; task: string; progress?: string };
  } catch {
    return null;
  }
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Trigger PreCompact hook manually (or via a long-running session) — verify goal reminder appears in stdout
- [ ] Verify hook doesn't block or slow down compaction on API failure

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 6: Automated Tests

### Overview
Add a test file covering session attachment features. Follows existing `bun:test` patterns: isolated test DB, minimal HTTP handler, direct DB function calls. File: `src/tests/session-attach.test.ts`.

### Test Cases:

#### DB Layer Tests
1. **Migration**: `parentTaskId` and `claudeSessionId` columns exist after `initDb()`
2. **createTaskExtended with parentTaskId**: Task created with `parentTaskId` field, verify it persists and is returned by `getTaskById()`
3. **updateTaskClaudeSessionId**: New DB function correctly sets `claudeSessionId` on an existing task, returns updated task
4. **claudeSessionId NOT set at creation**: Verify `createTaskExtended` does not set `claudeSessionId` (it's set later by the runner)

#### API Layer Tests (minimal HTTP handler pattern)
5. **PUT /api/tasks/:id/claude-session**: Returns 200, updates the field, subsequent GET returns the session ID
6. **PUT /api/tasks/:id/claude-session with invalid task**: Returns 404
7. **POST /api/tasks with parentTaskId**: Task created with parentTaskId via API
8. **GET /api/tasks/:id**: Returns `parentTaskId` and `claudeSessionId` fields

#### Auto-Routing Tests (DB-level, no HTTP needed)
9. **send-task auto-routing**: Create a parent task assigned to worker A. Create child task with `parentTaskId` but no explicit `agentId`. Verify the child is assigned to worker A's `agentId` (simulating the `send-task` auto-routing logic).
10. **send-task explicit override**: Create child task with both `parentTaskId` and explicit `agentId` (worker B). Verify the child is assigned to worker B (explicit wins).
11. **send-task parent with no agent**: Parent task is unassigned (pool). Child task with `parentTaskId` but no `agentId` goes to pool too (no auto-routing when parent has no agent).

#### Edge Cases
12. **Fallback when parent has no claudeSessionId**: `getTaskById(parentTaskId)` returns task but `claudeSessionId` is null — verify the lookup returns null gracefully
13. **parentTaskId referencing non-existent task**: Verify task creation still works (no FK constraint enforcement needed — the parent may be deleted later)

### Changes Required:

#### 1. Test File
**File**: `src/tests/session-attach.test.ts`
**Changes**: New file following the pattern from `src/tests/task-pause-resume.test.ts` — isolated test DB (`./test-session-attach.sqlite`), `beforeAll` with `initDb()`, `afterAll` with `closeDb()` + cleanup.

#### 2. DB Helper Export
**File**: `src/be/db.ts`
**Changes**: Ensure `updateTaskClaudeSessionId` is exported (already planned in Phase 1).

### Success Criteria:

#### Automated Verification:
- [ ] All tests pass: `bun test src/tests/session-attach.test.ts`
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Review test file — verify coverage of happy paths, edge cases, and auto-routing logic

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Testing Strategy

### Automated Tests
- `bun test src/tests/session-attach.test.ts` — Session attachment test suite (Phase 6)
- `bun run tsc:check` — Type checking after each phase
- `bun run lint:fix` — Lint after each phase

### What's NOT Tested Automatically
- Runner's `spawnClaudeProcess` with `--resume` (spawns real Claude processes — integration test only)
- PreCompact hook's API call (tested manually via long-running session)
- Session ID capture from stream-json (requires real Claude CLI output)

These are tested manually via the E2E section below.

### Manual E2E Verification

```bash
# 1. Start the server
bun run start:http

# 2. Create a parent task
curl -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"task": "Research the best approach for caching", "agentId": "<WORKER_ID>"}'
# Note the returned task ID as PARENT_ID

# 3. Wait for worker to pick up and run the parent task
# Check task status:
curl -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks/<PARENT_ID>
# Verify claudeSessionId is populated after the task starts

# 4. Create a child task
curl -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"task": "Implement the caching approach from the parent task", "agentId": "<WORKER_ID>", "parentTaskId": "<PARENT_ID>"}'
# Note the returned task ID as CHILD_ID

# 5. Verify child task has parentTaskId
curl -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks/<CHILD_ID>
# Should show parentTaskId = PARENT_ID

# 6. Watch worker logs — should see:
# "[worker] Child task — resuming parent session <session_id_prefix>"
# The Claude CLI command should include --resume <parentSessionId>

# 7. Verify the child session has parent context
# The child Claude session should "know" about the parent's work without re-explaining

# 8. Test fallback — create child with bogus parentTaskId
curl -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"task": "Test fallback", "agentId": "<WORKER_ID>", "parentTaskId": "00000000-0000-0000-0000-000000000000"}'
# Worker should log "parent session ID not found, starting fresh" and proceed normally

# 9. Test via MCP send-task tool (from a lead agent session)
# The lead should be able to:
#   send-task with parentTaskId to create a child task
#   Worker picks it up with --resume

# 10. Verify PreCompact hook
# During a long-running task, force compaction (or check hook output)
# Should see "GOAL REMINDER" with task description in the output
```

## References
- Research: `thoughts/taras/research/2026-02-19-swarm-gaps-implementation.md` (Gap 3)
- Claude CLI headless docs: `--resume` works with `-p`
- Issue: Each `--resume` generates a new session ID (must chain from latest)
- Issue: Prefer `init` message over `result` message for session ID capture (result sometimes fails to emit)
