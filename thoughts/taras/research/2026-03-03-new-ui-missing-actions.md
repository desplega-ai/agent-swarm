---
date: 2026-03-03
researcher: claude
branch: main
commit: ca4c4ab
repo: desplega-ai/agent-swarm
tags: [new-ui, dashboard, actions, gap-analysis]
status: complete
---

# Research: Missing Action Features in new-ui Dashboard

## Research Question

What action features (mutations/write operations) does the backend support that the new-ui dashboard does not currently expose? Identify all CRUD gaps between the backend API/MCP tools and the dashboard UI.

## Summary

The backend exposes **50 MCP tools** (30 write, 20 read) and **68 HTTP endpoints**. The new-ui currently implements only **8 backend mutations**. This leaves significant gaps around **tasks** (create, cancel, pause/resume), **schedules** (full CRUD), **epics** (full CRUD), and **channels** (create/delete). Services, memory, agent management, and Slack are out of scope (agent-facing features).

## Current new-ui Write Operations (8 mutations)

| # | Operation | Endpoint | Page |
|---|-----------|----------|------|
| 1 | Rename agent | `PUT /api/agents/:id/name` | Agent Detail |
| 2 | Edit agent profile (5 md fields) | `PUT /api/agents/:id/profile` | Agent Detail |
| 3 | Send chat message | `POST /api/channels/:id/messages` | Chat |
| 4 | Create/update config entry | `PUT /api/config` | Config |
| 5 | Delete config entry | `DELETE /api/config/:id` | Config |
| 6 | Create repo | `POST /api/repos` | Repos |
| 7 | Update repo | `PUT /api/repos/:id` | Repos |
| 8 | Delete repo | `DELETE /api/repos/:id` | Repos |

## Read-Only Pages (no write actions)

- Dashboard (`/`)
- Agents List (`/agents`)
- Tasks List (`/tasks`)
- Task Detail (`/tasks/:id`)
- Epics List (`/epics`)
- Epic Detail (`/epics/:id`)
- Schedules List (`/schedules`)
- Schedule Detail (`/schedules/:id`)
- Services (`/services`)
- Usage (`/usage`)

---

## Gap Analysis: Missing Actions by Entity

### 1. Tasks (HIGH priority — most impactful gap)

**Backend supports but UI lacks:**

| Action | MCP Tool | API Endpoint | Notes |
|--------|----------|-------------|-------|
| Create task | `send-task` | `POST /api/tasks` | Create a task and assign/offer to an agent |
| Cancel task | `cancel-task` | N/A (via MCP only) | Cancel pending/in-progress task |
| Pause task | N/A | `POST /api/tasks/:id/pause` | Pause in-progress task |
| Resume task | N/A | `POST /api/tasks/:id/resume` | Resume paused task |
| Task pool actions | `task-action` | N/A (via MCP) | claim, release, accept, reject, to_backlog, from_backlog |

**Where to add in UI:**
- Tasks List (`/tasks`): "Create Task" button (opens form dialog)
- Task Detail (`/tasks/:id`): "Cancel", "Pause", "Resume" action buttons based on task status

### 2. Schedules (HIGH priority — full CRUD missing)

**Backend supports but UI lacks:**

| Action | MCP Tool | API Endpoint | Notes |
|--------|----------|-------------|-------|
| Create schedule | `create-schedule` | N/A (MCP only) | Cron or interval-based |
| Update schedule | `update-schedule` | N/A (MCP only) | Modify any field |
| Delete schedule | `delete-schedule` | N/A (MCP only) | Permanent deletion |
| Run now | `run-schedule-now` | N/A (MCP only) | Trigger immediate execution |
| Enable/disable | `update-schedule` (enabled field) | N/A (MCP only) | Toggle schedule on/off |

**Where to add in UI:**
- Schedules List (`/schedules`): "Create Schedule" button, enable/disable toggle per row
- Schedule Detail (`/schedules/:id`): "Edit", "Delete", "Run Now", enable/disable toggle

**Note:** Schedule mutations are only available via MCP tools, not REST endpoints. The UI would need to either:
- (a) Call tools via the MCP endpoint (`POST /mcp`), or
- (b) Add REST endpoints for schedule CRUD in the backend

### 3. Epics (HIGH priority — full CRUD missing)

**Backend supports but UI lacks:**

| Action | MCP Tool | API Endpoint | Notes |
|--------|----------|-------------|-------|
| Create epic | `create-epic` | `POST /api/epics` | With goal, description, PRD, plan |
| Update epic | `update-epic` | `PUT /api/epics/:id` | Status, fields, lead agent |
| Delete epic | `delete-epic` | `DELETE /api/epics/:id` | Tasks unassigned, not deleted |
| Assign task to epic | `assign-task-to-epic` | `POST /api/epics/:id/tasks` | Link existing task |
| Unassign task from epic | `unassign-task-from-epic` | N/A (MCP only) | Remove task from epic |

**Where to add in UI:**
- Epics List (`/epics`): "Create Epic" button
- Epic Detail (`/epics/:id`): "Edit", "Delete", status change buttons, "Add Task" button on Board/Tasks tab

### 4. Channels (MEDIUM priority)

**Backend supports but UI lacks:**

| Action | MCP Tool | API Endpoint | Notes |
|--------|----------|-------------|-------|
| Create channel | `create-channel` | N/A (MCP only) | Public or DM type |
| Delete channel | `delete-channel` | N/A (MCP only) | Lead only, cannot delete "general" |

**Where to add in UI:**
- Chat page (`/chat`): "Create Channel" button in channel sidebar, delete option per channel

**Note:** Channel mutations are MCP-only. Same consideration as schedules — need REST endpoints or MCP calls from UI.

### 5-8. Out of Scope

Services, Memory, Agent Management, and Slack Integration are **out of scope** — these are agent-facing features that don't need UI exposure.

---

## Prioritized Implementation Recommendation

### Tier 1 — High Impact, REST endpoints already exist
1. **Create Task** — `POST /api/tasks` (form: description, agent, type, tags, priority, dependencies)
2. **Cancel Task** — needs REST endpoint (currently MCP only via `cancel-task`)
3. **Pause/Resume Task** — `POST /api/tasks/:id/pause` and `/resume` (buttons on task detail)
4. **Epic CRUD** — `POST/PUT/DELETE /api/epics` + `POST /api/epics/:id/tasks` (all endpoints exist)

### Tier 2 — High Impact, needs new REST endpoints
5. **Schedule CRUD** — No REST endpoints exist, need to add them
6. **Run Schedule Now** — Same
7. **Enable/Disable Schedule** — Same, via update endpoint

### Tier 3 — Medium Impact, needs new REST endpoints
8. **Create/Delete Channel** — Need to add REST endpoints

---

## Backend Endpoint Gap: REST vs MCP

Several operations are available only via MCP tools but lack REST API endpoints. For the UI to use these, either:

**Approach: Add REST endpoints** (confirmed)
- `POST /api/schedules` — create schedule
- `PUT /api/schedules/:id` — update schedule
- `DELETE /api/schedules/:id` — delete schedule
- `POST /api/schedules/:id/run` — run now
- `POST /api/tasks/:id/cancel` — cancel task
- `POST /api/channels` — create channel
- `DELETE /api/channels/:id` — delete channel

---

## Code References

### Backend
- MCP tools: `src/tools/` (50 tools across 30+ files)
- HTTP routes: `src/http/` (13 handler files, 68 endpoints)
- Tool config: `src/tools/tool-config.ts`
- Route matching: `src/http/utils.ts:69-87`

### new-ui
- API hooks: `new-ui/src/api/hooks/` (8 mutation hooks)
- API client: `new-ui/src/api/client.ts`
- Pages: `new-ui/src/pages/` (15 route pages)
- Router: `new-ui/src/app/router.tsx:21-44`
