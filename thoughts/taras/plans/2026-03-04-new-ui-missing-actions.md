---
date: 2026-03-04T10:00:00Z
topic: "New-UI Missing Action Features"
type: plan
status: draft
research: thoughts/taras/research/2026-03-03-new-ui-missing-actions.md
tags: [new-ui, dashboard, actions, CRUD, schedules, tasks, epics, channels]
---

# New-UI Missing Action Features Implementation Plan

## Overview

Implement write operations (create, update, delete, and action triggers) across the new-ui dashboard for tasks, epics, schedules, and channels. This requires adding 7 new REST endpoints in the backend and building corresponding UI components (forms, dialogs, action buttons) in the frontend.

## Current State Analysis

The backend exposes 50 MCP tools and 68 HTTP endpoints, but the new-ui only implements 8 write operations (agent rename/profile edit, chat messages, config CRUD, repo CRUD). Major entities — tasks, epics, schedules, channels — are entirely read-only in the dashboard.

### Key Discoveries:
- Task create (`POST /api/tasks`), pause (`POST /api/tasks/:id/pause`), and resume (`POST /api/tasks/:id/resume`) REST endpoints already exist (`src/http/tasks.ts:53-90,244-325`)
- Epic CRUD REST endpoints already exist: create (`POST /api/epics`, `src/http/epics.ts:45-70`), update (`PUT /api/epics/:id`, line 90), delete (`DELETE /api/epics/:id`, line 111), assign task (`POST /api/epics/:id/tasks`, line 127)
- Schedule mutations are MCP-only — no REST endpoints exist. Business logic lives in `src/tools/schedules/`
- Task cancel is MCP-only (`src/tools/cancel-task.ts`) — no REST endpoint exists
- Channel create/delete are MCP-only (`src/tools/create-channel.ts`, `src/tools/delete-channel.ts`)
- Frontend uses consistent patterns: `ApiClient` singleton + `useMutation` hooks + `Dialog`/`AlertDialog` components (`new-ui/src/api/client.ts`, `new-ui/src/pages/repos/page.tsx`)
- Backend uses `matchRoute()` utility for route matching (`src/http/utils.ts:69-87`) with handler chain in `src/http/index.ts:84-99`
- Schedule detail page has no dedicated query hook — it fetches all schedules and does `.find()` (`new-ui/src/pages/schedules/[id]/page.tsx:114`)
- Auth matrix: schedule update/delete require creator OR lead; task cancel requires creator OR lead; channel delete requires lead only; create operations have no role restrictions

## Desired End State

All four entities have full action support in the dashboard:
- **Tasks page**: "Create Task" button with form dialog; task detail page has Cancel, Pause, Resume buttons based on status
- **Epics page**: "Create Epic" button with form dialog; epic detail page has Edit, Delete, status change actions and "Add Task" button
- **Schedules page**: "Create Schedule" button with form dialog; schedule detail page has Edit, Delete, Run Now buttons and Enable/Disable toggle
- **Chat page**: "Create Channel" button in sidebar; delete channel option per channel

## Quick Verification Reference

Common commands:
- Backend lint: `bun run lint:fix`
- Backend typecheck: `bun run tsc:check`
- Backend tests: `bun test`
- Frontend lint: `cd new-ui && pnpm lint`
- Frontend typecheck: `cd new-ui && pnpm exec tsc --noEmit`

Key files:
- Backend routes: `src/http/tasks.ts`, `src/http/epics.ts`, `src/http/schedules.ts` (new), `src/http/index.ts`
- Frontend API client: `new-ui/src/api/client.ts`
- Frontend hooks: `new-ui/src/api/hooks/use-tasks.ts`, `use-epics.ts`, `use-schedules.ts`, `use-channels.ts`
- Frontend pages: `new-ui/src/pages/tasks/`, `epics/`, `schedules/`, `chat/`

## What We're NOT Doing

- Services management (agent-facing)
- Memory search/browse (agent-facing)
- Agent context history/diff (agent-facing)
- Slack integration UI (agent-facing)
- Task pool actions (claim, release, backlog — advanced agent-facing)
- Optimistic updates in mutations (not used anywhere in current codebase)
- Unassign task from epic (MCP-only, no REST endpoint, low priority)

## Implementation Approach

**6 phases**, TDD for backend then frontend by entity:

1. **Backend Tests (TDD Red)**: Write integration tests for all 7 new REST endpoints first — tests should fail
2. **Backend Implementation (TDD Green)**: Implement the endpoints to make the tests pass
3. **Frontend - Tasks**: Create task dialog + Cancel/Pause/Resume action buttons
4. **Frontend - Epics**: Create/Edit/Delete dialogs + status change + assign task
5. **Frontend - Schedules**: Create/Edit/Delete dialogs + Run Now + Enable/Disable toggle
6. **Frontend - Channels**: Create channel dialog + delete channel

Backend follows TDD: write failing tests → implement → verify tests pass. Frontend phases follow the established pattern: add `ApiClient` method → add `useMutation` hook → build UI component → wire up. E2E verification uses `qa-use` browser automation CLI.

---

## Phase 1: Backend Tests (TDD Red)

### Overview
Write integration tests for all 7 new REST endpoints first. Tests should fail since the endpoints don't exist yet. Add new `describe` blocks to the existing `src/tests/http-api-integration.test.ts` file, which already spawns the real server and uses the `api()` helper with `get()`, `post()`, `put()`, `del()` convenience functions.

### Changes Required:

#### 1. Schedule CRUD tests
**File**: `src/tests/http-api-integration.test.ts`
**Changes**: Add a new `describe("Schedule CRUD")` block (after the existing "Epics" section around line 912). Tests should:

- **POST /api/schedules** — create with cron expression:
  - 201 success with `{ name, taskTemplate, cronExpression: "0 * * * *" }` — verify response has `id`, `name`, `nextRunAt`, `enabled: true`
  - 400 for missing `name`
  - 400 for missing `taskTemplate`
  - 400 for invalid cron expression
  - 409/400 for duplicate name
  - Store `ids.schedule` for subsequent tests

- **GET /api/schedules/:id** — fetch single:
  - 200 success, verify all fields match creation
  - 404 for non-existent ID

- **PUT /api/schedules/:id** — update:
  - 200 success with `{ name: "updated-name" }` — verify name changed
  - 200 success with `{ enabled: false }` — verify `nextRunAt` is cleared
  - 200 success with `{ enabled: true }` — verify `nextRunAt` is recalculated
  - 404 for non-existent ID

- **POST /api/schedules/:id/run** — run now:
  - 200 success — verify response includes created task info, verify `lastRunAt` updated
  - 400 for disabled schedule (disable first, then try run)
  - 404 for non-existent ID

- **DELETE /api/schedules/:id** — delete:
  - 200 success with `{ success: true }`
  - 404 for non-existent ID
  - Verify GET after delete returns 404

#### 2. Task cancel tests
**File**: `src/tests/http-api-integration.test.ts`
**Changes**: Add a new `describe("Task Cancel")` block (after existing "Task Pause & Resume" around line 538). Tests should:

- **POST /api/tasks/:id/cancel** — cancel:
  - Create a pending task, cancel it — 200 with `{ success: true, task }`, verify `status: "cancelled"`
  - 400 for already-completed task (finish a task, then try cancel)
  - 404 for non-existent task ID
  - Optionally test with `{ reason: "test reason" }` body, verify `failureReason` is set

#### 3. Channel create/delete tests
**File**: `src/tests/http-api-integration.test.ts`
**Changes**: Extend the existing `describe("Channels & Messages")` block (around line 918). Add tests:

- **POST /api/channels** — create:
  - 201 success with `{ name: "test-channel" }` — verify response has `id`, `name`, `type: "public"`
  - 201 with optional `description` and `type: "dm"`
  - 400/409 for duplicate channel name
  - 400 for missing `name`
  - Store created channel ID for delete test

- **DELETE /api/channels/:id** — delete:
  - 200 success with `{ success: true }`
  - 403/400 for trying to delete "general" channel (ID `00000000-0000-4000-8000-000000000001`)
  - 404 for non-existent channel ID
  - Verify GET `/api/channels` no longer includes deleted channel

### Success Criteria:

#### Automated Verification:
- [x] Tests compile: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] New tests FAIL with 404 errors (endpoints don't exist yet): `bun test src/tests/http-api-integration.test.ts`

#### Manual Verification:
- [x] Review test file — verify test cases cover happy paths, validation errors, and edge cases
- [x] Confirm test failures are 404s (route not found), not test infrastructure issues

**Implementation Note**: After this phase, confirm tests fail for the right reasons (404 Not Found) before proceeding to Phase 2.

---

## Phase 2: Backend Implementation (TDD Green)

### Overview
Implement the 7 new REST endpoints to make the Phase 1 tests pass. Reuse existing DB functions and business logic from the MCP tools.

### Changes Required:

#### 1. New schedule routes handler
**File**: `src/http/schedules.ts` (new file)
**Changes**: Create a new handler file `handleSchedules()` with 5 routes, following the pattern from `src/http/epics.ts`:

| Route | Logic Source |
|-------|-------------|
| `GET /api/schedules/:id` (exact) | Call `getScheduledTaskById()`, return 200 or 404. |
| `POST /api/schedules` (exact) | Replicate `src/tools/schedules/create-schedule.ts:115-206`. Validate name uniqueness via `getScheduledTaskByName()`, validate cron with `CronExpressionParser.parse()`, validate `targetAgentId` via `getAgentById()`, calculate `nextRunAt` via `calculateNextRun()`, call `createScheduledTask()`. Return 201. |
| `PUT /api/schedules/:id` (exact) | Replicate `src/tools/schedules/update-schedule.ts:89-223`. Lookup by ID, validate new cron/targetAgent/name, build partial update, recalculate `nextRunAt` when timing fields change, call `updateScheduledTask()`. Return 200. |
| `DELETE /api/schedules/:id` (exact) | Replicate `src/tools/schedules/delete-schedule.ts:37-90`. Lookup by ID, call `deleteScheduledTask()`. Return `{ success: true }`. |
| `POST /api/schedules/:id/run` | Replicate `src/tools/schedules/run-schedule-now.ts:33-89`. Lookup by ID, verify enabled, call `runScheduleNow()`, return updated schedule + created task info. Return 200. |

**Auth note**: MCP tools enforce creator-or-lead auth because agents call them. REST endpoints are called from the admin dashboard which is already behind API_KEY auth, so role-based checks are unnecessary. This matches the pattern of existing epic REST endpoints (`src/http/epics.ts`) which have no role checks.

#### 2. Task cancel endpoint
**File**: `src/http/tasks.ts`
**Changes**: Add `POST /api/tasks/:id/cancel` route before the generic `GET /api/tasks/:id` route (around line 119). Replicate logic from `src/tools/cancel-task.ts:49-89`:
- Get task by ID, verify status is `pending` or `in_progress`
- Call `cancelTask(taskId, reason)` from `src/be/db.ts:2029`
- Call `updateAgentStatusFromCapacity()` if task had an agent
- Return `{ success: true, task: cancelledTask }`

#### 3. Channel create/delete endpoints
**File**: `src/http/epics.ts` (channels are already handled here, lines 181-285)
**Changes**: Add 2 new routes in the existing `handleEpics` function, after the existing channel routes:

| Route | Logic Source |
|-------|-------------|
| `POST /api/channels` (exact) | Replicate `src/tools/create-channel.ts:28-58`. Validate name uniqueness via `getChannelByName()`, call `createChannel()`. Return 201. |
| `DELETE /api/channels/:id` (exact) | Replicate `src/tools/delete-channel.ts:28-93`. Lookup by ID, protect "general" channel (ID `00000000-0000-4000-8000-000000000001`), call `deleteChannel()`. Return `{ success: true }`. |

#### 4. Register new schedule handler
**File**: `src/http/index.ts`
**Changes**: Import `handleSchedules` and add it to the handler array (around line 98, after `handleEpics`).

### Success Criteria:

#### Automated Verification:
- [x] All tests pass: `bun test src/tests/http-api-integration.test.ts`
- [x] Typecheck passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Full test suite passes: `bun test`

#### Manual Verification:
- [x] Start server (`bun run start:http`) and smoke-test one endpoint with curl to confirm real-world behavior matches tests (verified via integration tests — server needs restart for live curl)

**Implementation Note**: After completing this phase, pause for manual verification. All subsequent frontend phases depend on these endpoints.

---

## Phase 3: Frontend — Task Actions

### Overview
Add task creation from the tasks list page and Cancel/Pause/Resume action buttons on the task detail page.

### Changes Required:

#### 1. API client methods
**File**: `new-ui/src/api/client.ts`
**Changes**: Add 4 new methods to the `ApiClient` class following Pattern B (parse error body):

```
createTask(data: CreateTaskPayload): Promise<AgentTask>
  POST /api/tasks — body: { task, agentId?, taskType?, tags?, priority?, dependsOn? }

cancelTask(id: string, reason?: string): Promise<{ success: boolean; task: AgentTask }>
  POST /api/tasks/:id/cancel — body: { reason? }

pauseTask(id: string): Promise<{ success: boolean; task: AgentTask }>
  POST /api/tasks/:id/pause — no body

resumeTask(id: string): Promise<{ success: boolean; task: AgentTask }>
  POST /api/tasks/:id/resume — no body
```

#### 2. Mutation hooks
**File**: `new-ui/src/api/hooks/use-tasks.ts`
**Changes**: Add 4 new hooks following the existing pattern (`useMutation` + `onSuccess` cache invalidation):

- `useCreateTask()` — invalidates `["tasks"]`
- `useCancelTask()` — invalidates `["tasks"]`, `["task"]` (detail), and `["stats"]` (dashboard counts)
- `usePauseTask()` — invalidates `["tasks"]`, `["task"]`
- `useResumeTask()` — invalidates `["tasks"]`, `["task"]`

#### 3. Export new hooks
**File**: `new-ui/src/api/hooks/index.ts`
**Changes**: Add exports for `useCreateTask`, `useCancelTask`, `usePauseTask`, `useResumeTask`

#### 4. Create Task dialog on tasks list page
**File**: `new-ui/src/pages/tasks/page.tsx`
**Changes**: Follow the RepoDialog/ConfigEntryDialog pattern:
- Define `TaskFormData` interface and `emptyForm` constant
- Create `TaskDialog` component with fields: Description (textarea, required), Agent (select dropdown from `useAgents()`), Task Type (input), Tags (input, comma-separated), Priority (number input 0-100, default 50), Dependencies (input, comma-separated task IDs)
- Add `dialogOpen` state and "Create Task" button in the page header (next to filters)
- Wire `handleSubmit` to `useCreateTask().mutate()`

#### 5. Action buttons on task detail page
**File**: `new-ui/src/pages/tasks/[id]/page.tsx`
**Changes**: Add action buttons in the header area (around line 476-503, next to status badge):
- **Cancel** button: shown when status is `pending` or `in_progress`. Red/destructive variant. Opens an AlertDialog confirmation before calling `useCancelTask().mutate()`
- **Pause** button: shown when status is `in_progress`. Calls `usePauseTask().mutate()` directly (lightweight action, no confirmation needed)
- **Resume** button: shown when status is `paused`. Primary variant. Calls `useResumeTask().mutate()` directly

### Success Criteria:

#### Automated Verification:
- [ ] Frontend typecheck: `cd new-ui && pnpm exec tsc --noEmit`
- [ ] Frontend lint: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Tasks list page shows "Create Task" button
- [ ] Create task dialog opens with correct fields, submits successfully
- [ ] New task appears in the list after creation
- [ ] Task detail page shows Cancel button for pending/in_progress tasks
- [ ] Task detail page shows Pause button for in_progress tasks
- [ ] Task detail page shows Resume button for paused tasks
- [ ] Cancel confirmation dialog works correctly
- [ ] Buttons disappear/change after status transitions
- [ ] No action buttons shown for completed/failed/cancelled tasks

**Implementation Note**: After completing this phase, pause for manual verification with the dev server running (`bun run dev:http` + `cd new-ui && pnpm dev`).

---

## Phase 4: Frontend — Epic CRUD

### Overview
Add epic creation from the epics list page and Edit/Delete/Status actions on the epic detail page, plus task assignment.

### Changes Required:

#### 1. API client methods
**File**: `new-ui/src/api/client.ts`
**Changes**: Add 4 new methods:

```
createEpic(data: CreateEpicPayload): Promise<Epic>
  POST /api/epics — body: { name, goal, description?, priority?, tags?, leadAgentId? }

updateEpic(id: string, data: Partial<Epic>): Promise<Epic>
  PUT /api/epics/:id — body: partial fields

deleteEpic(id: string): Promise<{ success: boolean }>
  DELETE /api/epics/:id

assignTaskToEpic(epicId: string, data: { taskId?: string; task?: string }): Promise<AgentTask>
  POST /api/epics/:id/tasks — body: { taskId } or { task, ... }
```

#### 2. Mutation hooks
**File**: `new-ui/src/api/hooks/use-epics.ts`
**Changes**: Add 4 hooks:

- `useCreateEpic()` — invalidates `["epics"]`
- `useUpdateEpic()` — invalidates `["epics"]`, `["epic"]`
- `useDeleteEpic()` — invalidates `["epics"]`
- `useAssignTaskToEpic()` — invalidates `["epic"]`, `["tasks"]`

#### 3. Export new hooks
**File**: `new-ui/src/api/hooks/index.ts`
**Changes**: Add exports for epic mutation hooks

#### 4. Create Epic dialog on epics list page
**File**: `new-ui/src/pages/epics/page.tsx`
**Changes**: Follow the established CRUD dialog pattern:
- Define `EpicFormData` interface with fields: Name (required), Goal (required, textarea), Description (textarea), Priority (number 0-100), Tags (comma-separated input), Lead Agent (select from `useAgents()`)
- Create `EpicDialog` component reusable for both create and edit
- Add "Create Epic" button in the page header
- Add action column to AG Grid with Edit and Delete buttons (following repos pattern)
- Add `AlertDialog` for delete confirmation

#### 5. Edit/Delete/Status actions on epic detail page
**File**: `new-ui/src/pages/epics/[id]/page.tsx`
**Changes**: Add action buttons in the header area (around lines 335-347):
- **Edit** button: opens `EpicDialog` in edit mode, pre-populated with current epic data
- **Delete** button: opens `AlertDialog` confirmation, redirects to `/epics` on success
- **Status dropdown**: a `Select` component allowing status transitions (draft → active → paused/completed/cancelled). Calls `useUpdateEpic()` with `{ status: newStatus }`
- **Add Task** button on Tasks/Board tab: opens a small dialog to either enter a task ID (to assign existing) or enter a task description (to create new). Calls `useAssignTaskToEpic()`

### Success Criteria:

#### Automated Verification:
- [ ] Frontend typecheck: `cd new-ui && pnpm exec tsc --noEmit`
- [ ] Frontend lint: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Epics list page shows "Create Epic" button
- [ ] Create epic dialog has correct fields, submits successfully
- [ ] Epic detail page shows Edit, Delete, and Status controls
- [ ] Edit dialog pre-populates with current data, updates correctly
- [ ] Delete confirmation works, redirects to epics list
- [ ] Status dropdown transitions work (verify status badge updates)
- [ ] Add Task button works on the Tasks tab (both assign existing and create new)
- [ ] Epics list has action column with Edit/Delete buttons per row

**Implementation Note**: After completing this phase, pause for manual verification.

---

## Phase 5: Frontend — Schedule CRUD

### Overview
Add schedule creation, editing, deletion, run-now, and enable/disable toggle to the schedules pages.

### Changes Required:

#### 1. API client methods
**File**: `new-ui/src/api/client.ts`
**Changes**: Add 5 new methods:

```
fetchSchedule(id: string): Promise<ScheduledTask>
  GET /api/schedules/:id

createSchedule(data: CreateSchedulePayload): Promise<ScheduledTask>
  POST /api/schedules — body: { name, taskTemplate, cronExpression?, intervalMs?, ... }

updateSchedule(id: string, data: Partial<ScheduledTask>): Promise<ScheduledTask>
  PUT /api/schedules/:id

deleteSchedule(id: string): Promise<{ success: boolean }>
  DELETE /api/schedules/:id

runScheduleNow(id: string): Promise<{ schedule: ScheduledTask; task: AgentTask }>
  POST /api/schedules/:id/run
```

#### 2. Add detail query hook
**File**: `new-ui/src/api/hooks/use-schedules.ts`
**Changes**: Add `useScheduledTask(id)` query hook with key `["scheduled-task", id]`. This replaces the current pattern of fetching all schedules and doing `.find()`.

#### 3. Mutation hooks
**File**: `new-ui/src/api/hooks/use-schedules.ts`
**Changes**: Add 4 mutation hooks:

- `useCreateSchedule()` — invalidates `["scheduled-tasks"]`
- `useUpdateSchedule()` — invalidates `["scheduled-tasks"]`, `["scheduled-task"]`
- `useDeleteSchedule()` — invalidates `["scheduled-tasks"]`
- `useRunScheduleNow()` — invalidates `["scheduled-tasks"]`, `["scheduled-task"]`, `["tasks"]` (a new task is created)

#### 4. Export new hooks
**File**: `new-ui/src/api/hooks/index.ts`
**Changes**: Add exports for schedule mutation hooks and `useScheduledTask`

#### 5. Create Schedule dialog on schedules list page
**File**: `new-ui/src/pages/schedules/page.tsx`
**Changes**: Follow established CRUD dialog pattern:
- Define `ScheduleFormData` with fields: Name (required), Task Template (required, textarea), Schedule Type (radio: Cron / Interval), Cron Expression (input, shown when cron selected), Interval (number input in minutes, shown when interval selected), Description (textarea), Task Type (input), Tags (comma-separated), Priority (number 0-100), Target Agent (select from `useAgents()`), Timezone (input, default "UTC"), Model (select: haiku/sonnet/opus), Enabled (switch, default true)
- Create `ScheduleDialog` component reusable for create and edit
- Add "Create Schedule" button in the page header
- Add action column to AG Grid with Edit and Delete buttons
- Add Enable/Disable toggle in the AG Grid (inline `Switch` component per row that calls `useUpdateSchedule()` with `{ enabled: !current }`)
- Add `AlertDialog` for delete confirmation

#### 6. Actions on schedule detail page
**File**: `new-ui/src/pages/schedules/[id]/page.tsx`
**Changes**:
- Replace the `useScheduledTasks().find()` pattern with `useScheduledTask(id)` for cleaner data fetching
- Add action buttons in the header area (around lines 150-168):
  - **Edit** button: opens `ScheduleDialog` in edit mode
  - **Delete** button: opens `AlertDialog`, redirects to `/schedules` on success
  - **Run Now** button: calls `useRunScheduleNow().mutate()`, shows success feedback
  - **Enable/Disable** toggle: `Switch` component calling `useUpdateSchedule()` with `{ enabled: !current }`

### Success Criteria:

#### Automated Verification:
- [ ] Frontend typecheck: `cd new-ui && pnpm exec tsc --noEmit`
- [ ] Frontend lint: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Schedules list page shows "Create Schedule" button
- [ ] Create schedule dialog has correct fields with cron/interval toggle
- [ ] Created schedule appears in the list
- [ ] Enable/Disable toggle works inline in the list (badge updates)
- [ ] Schedule detail page shows Edit, Delete, Run Now, and Enable/Disable controls
- [ ] Edit dialog pre-populates correctly
- [ ] Run Now creates a task (verify in tasks list)
- [ ] Delete confirmation works, redirects to schedules list
- [ ] Cron expression validation feedback (if invalid cron is entered)

**Implementation Note**: After completing this phase, pause for manual verification.

---

## Phase 6: Frontend — Channel Management

### Overview
Add channel creation and deletion to the chat page.

### Changes Required:

#### 1. API client methods
**File**: `new-ui/src/api/client.ts`
**Changes**: Add 2 new methods:

```
createChannel(data: { name: string; description?: string; type?: "public" | "dm" }): Promise<Channel>
  POST /api/channels — body: { name, description?, type? }

deleteChannel(id: string): Promise<{ success: boolean }>
  DELETE /api/channels/:id
```

#### 2. Mutation hooks
**File**: `new-ui/src/api/hooks/use-channels.ts`
**Changes**: Add 2 hooks:

- `useCreateChannel()` — invalidates `["channels"]`
- `useDeleteChannel()` — invalidates `["channels"]`, `["messages"]` (clear message caches for deleted channel)

#### 3. Export new hooks
**File**: `new-ui/src/api/hooks/index.ts`
**Changes**: Add exports for `useCreateChannel`, `useDeleteChannel`

#### 4. Create Channel UI in chat sidebar
**File**: `new-ui/src/pages/chat/page.tsx`
**Changes**:
- Add a "+" button at the top of the channel sidebar (next to the "Channels" heading)
- Clicking opens a `Dialog` with fields: Name (required), Description (optional), Type (select: Public / DM, default Public)
- On submit, calls `useCreateChannel().mutate()`, then navigates to the new channel

#### 5. Delete Channel option
**File**: `new-ui/src/pages/chat/page.tsx`
**Changes**:
- Add a small trash icon button next to each channel name in the sidebar (except "general")
- Clicking opens an `AlertDialog` confirmation
- On confirm, calls `useDeleteChannel().mutate()`, navigates to "general" channel if the deleted channel was active
- The "general" channel should not show a delete option

### Success Criteria:

#### Automated Verification:
- [ ] Frontend typecheck: `cd new-ui && pnpm exec tsc --noEmit`
- [ ] Frontend lint: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Chat sidebar shows "+" button for creating channels
- [ ] Create channel dialog works, new channel appears in sidebar
- [ ] Channels (except "general") show a delete option
- [ ] Delete confirmation works, navigates away from deleted channel
- [ ] "general" channel has no delete option
- [ ] Creating a channel and immediately chatting in it works

**Implementation Note**: After completing this phase, pause for final manual verification.

---

## Manual E2E Verification

After all phases are complete, run the full stack and verify end-to-end:

```bash
# Start backend
bun run start:http

# Start frontend (separate terminal)
cd new-ui && pnpm dev
```

Then verify each feature using `qa-use` browser automation CLI (`/qa-use:verify`):

1. **Tasks**: Create a task from UI → verify it appears → cancel it → verify status changes
2. **Epics**: Create an epic → edit it → change status → assign a task → delete it
3. **Schedules**: Create a cron schedule → edit it → disable/enable → run now → verify task created → delete
4. **Channels**: Create a channel → send a message → delete the channel → verify redirect to general

## Testing Strategy

- **Backend**: Existing test patterns in `src/tests/` use isolated SQLite DBs. Add tests for the new REST endpoints (schedule CRUD, task cancel, channel create/delete) following the same pattern
- **Frontend**: Typecheck + lint are the primary automated checks. Manual testing covers the UI interactions
- **Integration**: The manual E2E section above serves as the integration test plan

## References
- Research: `thoughts/taras/research/2026-03-03-new-ui-missing-actions.md`
- Backend route patterns: `src/http/utils.ts`, `src/http/index.ts`
- Frontend patterns: `new-ui/src/pages/repos/page.tsx` (canonical CRUD dialog), `new-ui/src/api/hooks/use-repos.ts` (canonical mutation hooks)
