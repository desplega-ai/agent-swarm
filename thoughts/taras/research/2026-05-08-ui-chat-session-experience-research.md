---
date: 2026-05-08T00:00:00Z
researcher: taras
git_commit: a2e86719892a82623f75d0885eb3996afb49cf83
branch: main
repository: agent-swarm
topic: "UI chat / session experience in ui/ — sessions as task chains + dashboard revamp"
tags: [research, codebase, ui, sessions, slack, react-flow, dashboard, action-items, agent_tasks, parent_task_id]
status: complete
autonomy: critical
last_updated: 2026-05-08
last_updated_by: taras
---

# Research: UI chat / session experience in ui/ — sessions as task chains + dashboard revamp

**Date**: 2026-05-08
**Researcher**: taras
**Git Commit**: a2e86719892a82623f75d0885eb3996afb49cf83
**Branch**: main

## Research Question

Document what exists in the codebase to answer the v1-bundle plan in `thoughts/taras/brainstorms/2026-05-08-ui-chat-session-experience.md`: a top-level "Sessions" page (timeline + msg + task cards) + dashboard revamp (react-flow agent canvas + 4-bucket action-items inbox), shipped together. Specifically, seven focus areas:

1. Slack thread → `parentTaskId` → lead-queue flow (the spec UI sessions mirror)
2. `agent_tasks.source` enum constraint (CHECK vs free-form)
3. Task-detail page live-update mechanism in `ui/`
4. Manual task creation API path (does `parentTaskId` work today?)
5. Existing dashboard primitives in `ui/`
6. React-flow availability and existing graph-viz precedent
7. Action-item bucket data sources (Blocking / Broken / To read / To start)

## Summary

The architectural premise of the brainstorm — *"a UI session is structurally identical to a Slack thread; reuse `parentTaskId`"* — is **correct and already buildable today**. The chain primitive (`agent_tasks.parentTaskId`), the create endpoint (`POST /api/tasks` already accepts `parentTaskId` and persists it through `createTaskExtended`), the lead pickup mechanism (`GET /api/poll` long-poll), the live-update layer (`@tanstack/react-query` polling at 5s on `/api/tasks/{id}` and `/api/tasks/{id}/session-logs`), and the multi-task context propagation via Claude `--resume &lt;parentSessionId&gt;` all exist and run in production for Slack today. The UI client at `ui/src/api/client.ts:215` simply doesn't pass `parentTaskId` yet.

The schema delta for v1 is **small but non-zero**: `agent_tasks.source` is `CHECK`-constrained to 11 values (none of which is `'ui'`/`'ui-session'`); adding one is a forward-only `agent_tasks` table-rebuild migration plus a paired update to `AgentTaskSourceSchema` in `src/types.ts:56-69`. Per-user dismiss/snooze state for the action-items inbox would also require a new table — there is no existing per-user UI-state surface in the DB. Aside from those two adds, every other backend primitive needed for v1 already exists.

The dashboard revamp lands on a healthier-than-expected base: `@xyflow/react` v12 is already installed (`ui/package.json:19`) with a working dagre layout pipeline, custom typed nodes, theme-awareness, and animation primitives — used today only for the **workflow** DAG viewer (`ui/src/components/workflows/`), not for agents. The shadcn primitive set is rich (30 files), the layout shell uses sidebar+main with hardcoded nav groups (`ui/src/components/layout/app-sidebar.tsx`), and all data flows through a unified `ApiClient` + react-query hooks pattern (`ui/src/api/`). Three of the four action-item buckets have a clean data source today (`approval_requests` for "blocking — agent asked", `agent_tasks.status='failed'/'cancelled'` for "broken", `agent_tasks.output` + `agent_memory` for "to read"); "To start" needs a new task-template registry (the existing `templates/` directory is **agent persona templates**, not session prompts), and "PRs awaiting review" / "missing API keys (general)" / "paused awaiting input" are gaps with no current data source.

## Detailed Findings

### 1. Slack thread → `parentTaskId` → lead pickup (architectural reference)

**Inbound (Socket Mode, no public webhook).** Bolt app constructed in `src/slack/app.ts:34-39` with `socketMode: true`. Channel events route through `app.event("message", ...)` registered at `src/slack/handlers.ts:345`; this is the single fan-in for both initial @-mentions and thread replies (thread replies arrive as `message` events with `thread_ts` set). The DM/"AI app" surface uses `app.assistant(createAssistant())` at `src/slack/app.ts:52`, defined at `src/slack/assistant.ts:18-156`. Hardening guards: `wasEventSeen` (`src/slack/event-dedup.ts:91`), `isBotMessage` (`src/slack/handlers.ts:175-183`), `isUserAllowed` (`src/slack/handlers.ts:98-144`), in-process dedup cache (`src/slack/handlers.ts:307-316`), rate limiter 10/60s (`src/slack/handlers.ts:323-341`).

**Initial vs follow-up branching.** `routeMessage` at `src/slack/router.ts:26-97` — when no explicit `swarm#&lt;uuid&gt;` match is present and a `threadContext` (channelId + threadTs) is present, calls `getAgentWorkingOnThread(channelId, threadTs)` (`src/slack/router.ts:69` → `src/be/db.ts:1553-1568`) to find the thread's existing agent. The "is this a follow-up?" determination is purely the presence of `msg.thread_ts` plus a successful lookup. For lead-bound tasks, the most-recent task in the same `(channelId, threadTs)` is fetched at `src/slack/handlers.ts:623` via `getMostRecentTaskInThread` (`src/be/db.ts:1595-1606`) and passed as `parentTaskId` at `src/slack/handlers.ts:631`. Backing index: `idx_agent_tasks_slack_thread (slackChannelId, slackThreadTs, status)` from `src/be/migrations/040_slack_thread_composite_index.sql:2-3`.

**Cross-ingress sibling lookup (alternate parent-discovery).** `applySiblingAwareness` in `src/tasks/sibling-awareness.ts:74-96` calls `getInProgressTasksByContextKey(contextKey)` (`src/be/db.ts:1529-1545`) where the Slack key is `slackContextKey({channelId, threadTs}) = "task:slack:{channelId}:{threadTs}"` from `src/tasks/context-key.ts:78-82`. Backing index: `idx_agent_tasks_context_key_status` from `src/be/migrations/042_task_context_key.sql:12-13`. `pickResumeParent` (`src/tasks/sibling-block.ts:126-149`) wires `parentTaskId` from the agent's own most-recent in-flight sibling.

**Task creation.** Path: `createTaskWithSiblingAwareness` (`src/tasks/sibling-awareness.ts:138-144`) → `withSiblingAwareness` (lines 111-131; mutates description + may fill `parentTaskId`) → `createTaskExtended` (`src/be/db.ts:2124-2259`). Initial status comes from inputs at `src/be/db.ts:2127-2133`: `offeredTo` → `"offered"`, `agentId` → `"pending"`, else `"unassigned"`. The INSERT writes 41 columns (`src/be/db.ts:2175-2230`) including `parentTaskId`, `slackChannelId`, `slackThreadTs`, `slackUserId`, `requestedByUserId` (resolved via `resolveUser({slackUserId})` at `src/slack/handlers.ts:396`), and `contextKey`. After insert, `createLogEntry({ eventType: "task_created", ... })` runs at `src/be/db.ts:2235-2241` and a `task.created` event fires on the workflow event bus at `src/be/db.ts:2245-2255`.

**Lead pickup.** The lead is **not** push-notified; it long-polls. `pollForTrigger` in `src/commands/runner.ts:1371-1411` calls `GET /api/poll` with `X-Agent-ID` + `Authorization: Bearer ${apiKey}`. Handler is `handlePoll` at `src/http/poll.ts:110-476`. Order: offered tasks → `getPendingTaskForAgent(myAgentId)` (`src/be/db.ts:1055-1073` — `WHERE agentId=? AND status='pending' ORDER BY priority DESC, createdAt ASC`) → mentions → worker auto-claim from unassigned pool (lines 287-367). `startTask(taskId)` at `src/be/db.ts:1075-1107` atomically transitions `pending → in_progress` with guard `WHERE id=? AND status NOT IN ('completed','failed','cancelled')`. Returns `{ trigger: { type: "task_assigned", taskId, task, requestedBy? } }` (lines 251-260). The lead's poll **does not filter by `parentTaskId`** — it gets one row at a time; chain context is reconstituted at execution (see below).

**Prompt-construction across the chain.** Two layers contribute history:

- **Layer A — task description (text injection).** Built at task-creation time. Slack `&lt;thread_context&gt;` block from `getThreadContext` (`src/slack/handlers.ts:217-262`) — pulls up to 20 prior messages via `client.conversations.replies` and renders via template `slack.message.thread_context` (`src/slack/templates.ts:42-55`). Sibling-awareness block from `prependSiblingBlock` (`src/tasks/sibling-block.ts:155-164`) renders `&lt;sibling_tasks_in_progress&gt;` listing in-flight siblings. Both blocks are concatenated into `agent_tasks.task` before INSERT.
- **Layer B — Claude session resume (provider-level).** At pickup, `src/commands/runner.ts:3206-3223` (and the paused-resume path at lines 2913-2926) inspects `task.parentTaskId` and calls `fetchProviderSessionId(apiUrl, apiKey, parentTaskId)` (`src/commands/runner.ts:1174-1190`) which `GET /api/tasks/{parentTaskId}` and reads `claudeSessionId`. If present, the provider is launched with `--resume &lt;parentSessionId&gt;` — chat history is loaded by Claude itself, not text-injected. The lead's actual prompt envelope uses template `task.trigger.assigned` (`src/commands/templates.ts:17-32`) which expands to `/work-on-task &lt;uuid&gt;\n\nTask: "&lt;task_text&gt;"\n\n...`.

**Outbound replies (3 paths).** All write to `task.slackChannelId` / `task.slackThreadTs` on the same `agent_tasks` row — there is no separate "messages" table. (a) Watcher poller `startTaskWatcher` (`src/slack/watcher.ts:414`) ticks every 3s and updates the Slack tree message via `chat.postMessage` / `chat.update`; helpers in `src/slack/responses.ts:29-93`. (b) `slack-reply` MCP tool (`src/tools/slack-reply.ts:14-156`) — agent posts to thread directly. (c) Initial assignment tree message posted by the message handler at `src/slack/handlers.ts:719-734`. After completion, `markTaskSlackReplySent(taskId)` (`src/be/db.ts:1114-1116`) sets `slackReplySent=1`.

**Status state machine** (enum `AgentTaskStatusSchema` at `src/types.ts:4-15`): `backlog | unassigned | offered | reviewing | pending | in_progress | paused | completed | failed | cancelled`. No SQL CHECK on the `status` column itself (`src/be/migrations/001_initial.sql:75`); enforced only by the Zod schema at write paths. Transitions: insert→{pending|unassigned|offered}, claim/start→`in_progress`, `completeTask`→`completed` (`src/be/db.ts:1628-1671`), `failTask`→`failed` (`src/be/db.ts:1673-1710`), `cancelTask`→`cancelled` (`src/be/db.ts:1712-1748`), `pauseTask`→`paused` (graceful-shutdown only, `src/be/db.ts:1753-1791`). Worker-completion synthesizes a follow-up task to the lead with `parentTaskId = completedTaskId, source="system", taskType="follow-up"` at `src/tools/store-progress.ts:402-461` — this is how chains continue across worker handoffs.

### 2. `agent_tasks.source` enum + `parentTaskId` schema

**Current CHECK constraint.** `src/be/migrations/043_jira_source.sql:16` (most recent table-rebuild touching `source`):

```sql
source TEXT NOT NULL DEFAULT 'mcp' CHECK(source IN (
  'mcp', 'slack', 'api', 'github', 'gitlab', 'agentmail',
  'system', 'schedule', 'workflow', 'linear', 'jira'
))
```

11 allowed values; default `'mcp'`. `AgentTaskSourceSchema` at `src/types.ts:56-69` is the same 11-value Zod enum, kept in sync with the SQL CHECK per the project rule in `CLAUDE.md`.

**`parentTaskId` declaration.** `src/be/migrations/043_jira_source.sql:37`: `parentTaskId TEXT,` — nullable, **no FOREIGN KEY** (self-references conceptually but enforced only at app level). Indexed by `idx_agent_tasks_parentTaskId` from `src/be/migrations/034_slack_reply_sent.sql:4` (recreated in `043_jira_source.sql:119`).

**Migration history affecting `source`.** `001_initial.sql:70-111` (initial 7 values: mcp/slack/api/github/agentmail/system/schedule); `004_workflow_source.sql:15` (+workflow); `006_vcs_provider.sql:17` (+gitlab, github→vcs rename); `009_tracker_integration.sql:90` (+linear); `026_drop_epics.sql:15` (rebuild for epic removal); `043_jira_source.sql:16` (+jira, current effective).

**Where `source` is written.** `src/slack/*` writes `"slack"`; `src/gitlab/handlers.ts:106,208,310,386` writes `"gitlab"`; `src/agentmail/handlers.ts` writes `"agentmail"`; `src/scheduler/scheduler.ts` writes `"schedule"`; `src/workflows/executors/agent-task.ts:86` writes `"workflow"`; `src/http/tasks.ts:272` defaults to `"api"`. The HTTP body schema declares `source: z.string().optional()` (`src/http/tasks.ts:65`) — **no enum validation at the route layer**; only the SQL CHECK gates writes.

**UI today.** `ui/src/api/client.ts:215-234` (`createTask`) does **not** send a `source` field, so dashboard-created tasks land with `source='api'`. There is no existing `'ui'`/`'manual'`/`'dashboard'`/`'web'` value used for `agent_tasks.source` (the `'manual'` literal that grep finds is on `agent_memory.source`, not `agent_tasks`).

**Verdict.** Adding `'ui-session'` (or whatever the chosen source is) requires a forward-only `agent_tasks` table-rebuild migration (the established pattern, last done in `043_jira_source.sql`) plus a paired one-line update to `AgentTaskSourceSchema` in `src/types.ts:56-69`. Or: keep using `'api'` for UI-session-spawned tasks if attribution by source isn't required — the brainstorm's naming preference vs. data-model parsimony is a judgment call.

### 3. Task-detail page live-update mechanism in `ui/`

**Stack correction.** `ui/` is **React 19 + Vite 7 + react-router-dom v7**, not Next.js. Folder convention `src/pages/&lt;route&gt;/page.tsx` mimics App Router naming but is hand-wired in `ui/src/app/router.tsx`. Dev port 5274 (`ui/vite.config.ts`).

**Page.** `ui/src/pages/tasks/[id]/page.tsx` — `TaskDetailPage` default export at line 451. Five react-query hooks fan out from `useParams().id` (lines 454-461): `useTask`, `useTaskSessionLogs`, `useAgents`, `useSessionCosts({taskId})`, `useTaskContext`.

**Mechanism.** TanStack Query v5 with global polling defaults set at `ui/src/app/providers.tsx:7-15`: `refetchInterval: 5000, staleTime: 2000, retry: 2`. Per-hook overrides: `useTaskSessionLogs` explicitly 5s (`ui/src/api/hooks/use-tasks.ts:35`), `useTaskContext` explicitly 10s (line 44). Mutations (`useCancelTask`, `usePauseTask`, `useResumeTask`) invalidate `["task"]` for instant refetch (lines 65-97). **No SSE, no WebSocket, no `EventSource`, no streaming `fetch`** anywhere in `ui/src/` (verified by grep).

**Endpoints feeding the page.**

| Hook | Method/Path | Handler |
|---|---|---|
| `useTask` | `GET /api/tasks/{id}` | `src/http/tasks.ts:120-131,424-437` (returns task + logs from `getLogsByTaskId`) |
| `useTaskSessionLogs` | `GET /api/tasks/{taskId}/session-logs` | `src/http/session-data.ts:41-52,168-176` |
| `useTaskContext` | `GET /api/tasks/{id}/context` | `src/http/context.ts:41-43` |
| `useSessionCosts` | `GET /api/session-costs?taskId=...` | `src/http/session-data.ts:121-123` |
| `useAgents` | `GET /api/agents?include=tasks` | `src/http/agents.ts` |

All `application/json`. Auth: `Authorization: Bearer ${apiKey}` from `ui/src/api/client.ts:110-119`; server check at `src/http/core.ts:129-145`.

**Live-data backing tables.** Status badge + activity timeline → `agent_tasks` + `agent_log` (`src/be/db.ts:1948-2006`, row shape `{id, eventType, agentId, taskId, oldValue, newValue, metadata, createdAt}`, event types include `task_created/status_change/progress/offered/accepted/rejected/claimed/released`). Session-log viewer (LLM transcript, `tool_use`, `tool_result`, `thinking`) → `session_logs` table (`src/be/db.ts:3527-3582`), parsed by `ui/src/components/shared/session-log-viewer.tsx`. Costs → `session_costs` (`isError BOOLEAN` flag at `src/be/migrations/001_initial.sql:192`).

**Latency feel.** ~2.5s avg lag on `useTask` (5s poll), ~5s on `useTaskContext` (10s poll). No incremental cursor — each tick re-ships the full task+logs payload. Auto-scroll via `ui/src/hooks/use-auto-scroll.ts` keeps the log pane pinned.

**Reuse for session timeline.** Per-task hooks dedupe by query key (taskId), so naively a session timeline for N tasks fans out 5N requests/5s. What's missing: (a) **no parent/ancestor filter** on `GET /api/tasks` (`src/http/tasks.ts:29-47` supports `status`, `agentId`, `scheduleId`, `search`, `includeHeartbeat`, `limit`, `offset` only) — to fetch a chain in one round trip, add a `parentTaskId`/`rootTaskId`/`ancestorTaskId` filter or a dedicated `GET /api/sessions/{rootId}/tasks`; (b) no `?since=&lt;cursor&gt;` for incremental log fetch; (c) sub-second feel would need a new transport (SSE/WS), not a polling extension. Auth model unchanged (still Bearer).

### 4. Manual task creation API path

**Endpoint.** `POST /api/tasks` declared via `route()` at `src/http/tasks.ts:49-73`, registered at `src/http/index.ts:127`, dispatched from the request loop at `src/http/index.ts:151-153`. Body schema (`src/http/tasks.ts:55-68`):

- Required: `task: z.string().min(1)`
- Optional: `agentId`, `taskType`, `tags: string[]`, `priority: number`, `dependsOn: string[]`, `offeredTo`, `dir`, `parentTaskId: string`, `source: string` (no enum), `outputSchema`, `contextKey`

**`parentTaskId` is fully supported end-to-end.** Read at `src/http/tasks.ts:64`, forwarded to options at `:271`, persisted via `createTaskWithSiblingAwareness` (`src/tasks/sibling-awareness.ts:138-144`) → `createTaskExtended` (`src/be/db.ts:2124`). Inheritance from parent (Slack/AgentMail/contextKey/requestedByUser metadata) at `src/be/db.ts:2136-2161`. INSERT writes the field at `src/be/db.ts:2219`. Sibling-awareness only auto-fills `parentTaskId` if caller did **not** pass one (`options.parentTaskId ?? result.parentTaskId` at `src/tasks/sibling-awareness.ts:128`) — explicit values win.

**`source` field.** Defaults to `"api"` at `src/http/tasks.ts:272` when the body omits it. UI client never sets it. Type assertion only (`as AgentTaskSource` at line 272) — arbitrary strings would write through if the SQL CHECK didn't gate them.

**UI client side.**
- Form: `ui/src/pages/tasks/page.tsx:53` (`CreateTaskDialog`); `TaskFormData` shape at lines 35-42 has `task, agentId, taskType, tags, priority, dependsOn` — **no `parentTaskId`, `source`, `contextKey`**.
- Submit: `ui/src/pages/tasks/page.tsx:317-330` (`handleCreateSubmit`) calls `createTask.mutate(...)`.
- Mutation hook: `ui/src/api/hooks/use-tasks.ts:48-63` (`useCreateTask`), invalidates `["tasks"]` on success.
- HTTP: `ui/src/api/client.ts:215-234` (`createTask`); headers from `getHeaders()` at `:110-119` send `Content-Type: application/json` + `Authorization: Bearer ${apiKey}`. **No `X-Agent-ID`** is sent (the dashboard is a human user, not an agent).
- Form auto-fills `agentId` to lead at `ui/src/pages/tasks/page.tsx:96-97` (`form.agentId || leadAgent?.id`).

**Lead pickup is identical to Slack-spawned tasks** — both insert via `createTaskExtended`, both emit `task_created` log + `task.created` event, both surface to lead via the `pending`-for-this-agent branch of `/api/poll` (`src/http/poll.ts:177-260`). No queueing-path difference.

**Existing `parentTaskId`-set sites (server side):** Slack (`src/slack/handlers.ts:631`, `src/slack/assistant.ts:101`, `src/slack/actions.ts:74`), GitLab (`src/gitlab/handlers.ts:319,394`), heartbeat auto-retry (`src/heartbeat/heartbeat.ts:293`), sibling-awareness auto-wire (`src/tasks/sibling-awareness.ts:128`), and the manual route itself (`src/http/tasks.ts:271`).

**Existing UI usage of `parentTaskId`.** Read-only display only: detail page renders a "Parent" link at `ui/src/pages/tasks/[id]/page.tsx:540-549`. Type field present in `ui/src/api/types.ts:70`. **No write site in `ui/`.**

**Authn/authz.** Bearer API-key check via `src/http/core.ts:129-145` — `POST /api/tasks` does not opt out of `apiKey` auth, so it requires the key. `creatorAgentId` populated from `X-Agent-ID` header if present (`src/http/tasks.ts:264`); UI client doesn't send it, so `creatorAgentId = null` for dashboard-created tasks. **No org/user scoping** on this endpoint — `requestedByUserId` exists in `CreateTaskOptions` (`src/be/db.ts:2085`) but is not in the route body schema and is populated only by adapter ingresses (Slack et al.).

**Verdict.** Same endpoint serves "start session" (no `parentTaskId`) and "post follow-up" (with `parentTaskId`) — **yes, but the UI client and form need to add `parentTaskId` (and optionally `source`, `contextKey`) to their request shape**. Server-side: zero changes required.

### 5. ui/ dashboard primitives inventory

**Stack.** Vite 7 + React 19 + react-router-dom v7 (data router). Path alias `@/ → ./src/` (`ui/vite.config.ts`, `ui/tsconfig.json`).

**Routes** (`ui/src/app/router.tsx`, all wrapped in `RootLayout`):
`/` (dashboard), `/agents`, `/agents/:id`, `/tasks`, `/tasks/:id`, `/chat`, `/chat/:channelId`, `/services`, `/schedules`, `/schedules/:id`, `/workflows`, `/workflows/:id`, `/workflow-runs/:id`, `/approval-requests`, `/approval-requests/:id`, `/usage`, `/budgets`, `/config`, `/integrations`, `/integrations/:id`, `/templates`, `/templates/:id`, `/templates/:id/history/:version`, `/mcp-servers`, `/mcp-servers/:id`, `/skills`, `/skills/:id`, `/repos`, `/repos/:id`, `/keys`, `/debug`, `/memory`, `*` (404). **No `/sessions` route exists.**

**Current home.** `ui/src/pages/dashboard/page.tsx` — single scrollable column: `&lt;StatsBar&gt;` (`ui/src/components/shared/stats-bar.tsx`, fed by `useStats`/`useHealth`/`useDashboardCosts`) → 2-col row (top-3 agents from `useAgents` sorted lead/busy/idle/waiting/offline; top-3 active tasks from `useTasks({status:"in_progress"})`) → activity feed (`useLogs(15)` with `&lt;ActivityItem&gt;`). **No charts, no tables, no widgets system.**

**Agents view.** `ui/src/pages/agents/page.tsx` — `&lt;DataGrid&gt;` (ag-grid wrapper at `ui/src/components/shared/data-grid.tsx`). Columns: name (with lead crown), role, status, capacity, capabilities, lastUpdatedAt. Filter: search + status select. Row click → `/agents/:id`. **No graph/canvas viz for agents today.**

**Tasks list/detail.** List: `ui/src/pages/tasks/page.tsx` (ag-grid + `CreateTaskDialog`, full-width). Detail: `ui/src/pages/tasks/[id]/page.tsx` uses `DetailPageBody` + `DetailPageRail` (`QuickStats`) — main + 280px right rail. Tabs (logs/context/cost), `&lt;Streamdown&gt;`, `&lt;SessionLogViewer&gt;`, `&lt;Progress&gt;`, `&lt;CollapsibleSection&gt;`. **No shared SplitView / master-detail-in-same-route component.**

**Integrations.** List: `ui/src/pages/integrations/page.tsx` — grid of `&lt;IntegrationCard&gt;` filtered by category (`comm`, `issues`, `llm`, `observability`, `payments`, `email`, `other`) + search. Catalog source-of-truth: `ui/src/lib/integrations-catalog.ts` (fields/keys/disable-keys per integration). Status logic: `ui/src/lib/integrations-status.ts`. Per-integration components in `ui/src/components/integrations/`: `integration-card.tsx`, `integration-status-badge.tsx`, `field-renderer.tsx`, plus OAuth sections for Linear/Jira/Codex/Claude-Managed. Shared `oauth-section.tsx` at `ui/src/components/shared/oauth-section.tsx`.

**Shared component primitives** (`ui/src/components/ui/`, configured via `ui/components.json` style `new-york`, base `neutral`, lucide). 30 files across surface/forms/overlays/display + repo-specific HOCs:
`stat-panel.tsx`, `info-row.tsx`, `settings-row.tsx`, `page-header.tsx`, `detail-page-layout.tsx` (exports `DetailPageBody`, `DetailPageRail`, `QuickStats`/`QuickStat`, `Relationships`/`Relationship`, `DangerZone`, `DetailPageSection` — canonical 1fr+280px master-rail layout used by every detail page).

Shared composites (`ui/src/components/shared/`): `data-grid.tsx`, `stats-bar.tsx`, `status-badge.tsx`, `session-log-viewer.tsx`, `session-id.tsx`, `json-viewer.tsx`, `command-menu.tsx` (cmdk), `name-connection-modal.tsx`, `error-boundary.tsx`, `page-skeleton.tsx`, `empty-state.tsx`, `agent-link.tsx`, `usage-summary.tsx`, `collapsible-section.tsx`, `collapsible-description.tsx`, `oauth-section.tsx`, `workflow-node-shell.tsx`.

**Layout shell.** `ui/src/main.tsx` → `App.tsx` → `&lt;Providers&gt;` (TanStack Query, ThemeProvider, ConfigProvider, TooltipProvider) + `&lt;RouterProvider&gt;` + `&lt;Toaster&gt;`. `RootLayout` (`ui/src/components/layout/root-layout.tsx`): `&lt;ConfigGuard&gt; → &lt;SidebarProvider&gt; → &lt;AppSidebar /&gt; + &lt;SidebarInset&gt;{ AppHeader + main { ErrorBoundary { Suspense { Outlet } } } }&lt;/&gt;` + global `&lt;CommandMenu /&gt;` + `&lt;NameConnectionModal /&gt;`. Nav is **hardcoded** in `app-sidebar.tsx`'s `navGroups` const — groups: Core (Dashboard/Agents/Tasks), AI (Skills/MCP Servers/Memory), Operations (Schedules/Workflows/Usage/Budgets), Configuration (Integrations/Templates/Approvals/Repos), System (Config/API Keys/Debug). Header (`app-header.tsx`): breadcrumbs + health indicator (`useHealth`) + active connection name + theme toggle.

**State/data layer.** TanStack Query 5.90, `refetchInterval: 5000`, `staleTime: 2000`. Single `ApiClient` at `ui/src/api/client.ts`. Hooks split by resource under `ui/src/api/hooks/` (one file per resource — agents, tasks, stats, costs, channels, schedules, workflows, services, skills, mcp-servers, mcp-oauth, memory, integrations-meta, jira-status, linear-status, config-api, api-keys, budgets, prompt-templates, approval-requests, repos, db-query). No SWR, no Redux/Zustand. Pure client SPA. Vite proxy `/api → http://localhost:3013`.

**Styling.** Tailwind v4 via `@tailwindcss/vite` plugin (no `tailwind.config.js`; tokens in CSS). Global at `ui/src/styles/globals.css` — `@theme {}` block with OKLCH design tokens (Zinc + amber primary). Semantic status tokens (`--color-status-{success,active,error,info,pending,warning,paused,neutral}` + `-strong` + `-foreground`). Action-type tokens for workflow nodes. Dark mode via `@custom-variant dark`. Token-drift guard: `ui/scripts/check-design-tokens.sh` (`pnpm check:tokens`). Animation: `tw-animate-css` package.

**Notable surface for revamp.** Closest pattern to an action-items inbox today: `/approval-requests` (list + detail, ag-grid). "Sessions" terminology in `ui/` is scoped to a single task's session (session-log-viewer / session-id / `useTaskSessionLogs` / `useSessionCosts`) — there is **no top-level `/sessions` page or `Session` model** today.

### 6. React-flow availability + graph viz precedent

**Installed.** `ui/package.json:19` — `"@xyflow/react": "^12.10.1"`. The legacy `reactflow` package name is NOT present anywhere. `templates-ui/` and `docs-site/` do not have it.

**Companion libs.**
- `ui/package.json:26` — `"dagre": "^0.8.5"` (DAG layout) + `@types/dagre` ^0.7.54 (devDep)
- `docs-site/package.json:17` — `"mermaid": "^11.12.3"` (docs only, not in `ui/`)
- `ui/package.json:32` — `"recharts": "^3.7.0"` (used only on `/usage`)
- `ui/package.json:20-21` — `ag-grid-*` (data grids; not graph)
- **NOT installed in `ui/`:** `cytoscape`, `vis-network`, `visx`, `elkjs`, top-level `d3`, `framer-motion`, `motion`, `react-spring`, `lottie-react`.

**Existing precedent — workflows DAG.** Fully implemented under `ui/src/components/workflows/`, all imports from `@xyflow/react`:
- `workflow-graph.tsx:1` — `import { Background, Controls, ReactFlow } from "@xyflow/react"`. Style import `@xyflow/react/dist/style.css` at line 3.
- `workflow-graph.tsx:63-78` — `&lt;ReactFlow ... &gt;&lt;Background/&gt;&lt;Controls/&gt;&lt;/&gt;` with `nodesDraggable={false}`, `nodesConnectable={false}`, `elementsSelectable={false}` (read-only viewer), `proOptions={{ hideAttribution: true }}`, `colorMode={theme === "dark" ? "dark" : "light"}`.
- `graph-utils.ts:1` — `Edge`, `MarkerType`, `Node` types. Layout: preferred custom topological-staircase (`applyStairLayout` at `:162`); fallback `applyDagreLayout` at `:254` (`rankdir: "TB"`, `nodesep: 80`, `ranksep: 100`, `acyclicer: "greedy"`); `detectBackEdges` DFS at `:108` to exclude cycle-closing edges from layout.
- Custom typed nodes: `trigger-node.tsx`, `condition-node.tsx`, `action-node.tsx` — composed via shared shell `ui/src/components/shared/workflow-node-shell.tsx` which renders `&lt;Handle type="target" position={Position.Top}&gt;` / `source` at `Position.Bottom`. Multi-port distribution at lines 92-107.
- Edge animation today: react-flow's built-in `edge.animated = true` (SVG marching-ants), used at `workflow-graph.tsx:45` and `graph-utils.ts:85`. Status-driven node/edge coloring (emerald=complete, amber animated=selected) keyed off `stepStatus`.

**Consumers.** `ui/src/pages/workflows/[id]/page.tsx:69,263,376` (definition viewer) and `ui/src/pages/workflow-runs/[id]/page.tsx:15,193` (live run viewer; passes `steps` for status-driven coloring).

**`templates-ui/` graph viz.** None.

**Verdict.** Adding the agent canvas v1 (org-chart spine, lead → workers, node size by 24h activity, click-through) reuses the same lib + dagre pipeline + custom-node shell pattern. The "live overlay" v2 (animated task lozenges, pulsing edges) is feasible with the existing `edge.animated` primitive plus a small motion lib choice if richer animation than SVG marching-ants is desired (no `framer-motion` installed today, but `tw-animate-css` exists).

### 7. Action-item bucket data sources

**Bucket 1 — Blocking progress.**

- *Paused awaiting input:* **gap.** `agent_tasks.status='paused'` is exclusively the graceful-shutdown state — comment at `src/be/db.ts:1753-1756`, status-enum comment at `src/types.ts:11`. `pauseTask` only fires from `in_progress` (`src/be/db.ts:1757-1791`). The `was_paused` column (migration `024_add_was_paused.sql`) supports BU `depIds`, not user-input semantics. **No `awaiting_input` / `pending_question` column exists.**
- *Agent asked a question:* **clean source.** `approval_requests` table — schema at `src/be/migrations/020_approval_requests.sql:4-33` (`status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','timeout'))`); pending-only index at line 41. Created by the `request-human-input` MCP tool (`src/tools/request-human-input.ts:31-117`); `sourceTaskId` ties row to source task. Listed via `listApprovalRequests({status, workflowRunId, limit})` at `src/be/db.ts:6739` and `GET /api/approval-requests?status=pending` (`src/http/approval-requests.ts:112-127`). **Caveat:** the MCP-tool path does not push notifications — only the workflow `human-in-the-loop` executor does (`src/workflows/executors/human-in-the-loop.ts:170-265` — Block Kit message with "Review & Respond" button).
- *PRs awaiting human review:* **gap.** GitHub integration is webhook-only and only acts when the bot itself is the requested reviewer (`src/github/handlers.ts:252-326` — `action === "review_requested" && isBotAssignee(...)` at line 255 → creates `agent_tasks` of `taskType: "github-pr"`). No poller, no `gh pr list` integration, no listing of "PRs the human still owes a review on". `vcsNumber`/`vcsRepo`/`vcsAuthor` columns on `agent_tasks` (`src/types.ts:142-151`) only get populated for bot-involved PRs.
- *Missing API keys / setup needed:* **partial.** `agents.status='waiting_for_credentials'` + `agents.credentialMissing` JSON array (migration `053_agent_waiting_for_credentials_status.sql:25,41`). Setter `updateAgentCredentialState` at `src/be/db.ts:606`, route `PUT /api/agents/{id}/credential-status` (`src/http/agents.ts:422-441`). Listing `GET /api/agents/credential-status?status=waiting_for_credentials` (`src/http/agents.ts:404-420`). Worker self-reports from `src/commands/credential-wait.ts:135` when booting and seeing a missing required env var. `claude-managed` has a single-shot test endpoint `POST /api/integrations/claude-managed/test` (`src/http/integrations.ts:32-46,92-122`). **No general "is integration X configured?" health aggregator across `swarm_config`.**

**Bucket 2 — Broken.** `agent_tasks.status='failed'` (set by `failTask` at `src/be/db.ts:1673-1710`, stores `failureReason` column declared in `001_initial.sql:107`) and `'cancelled'` (set by `cancelTask` at `src/be/db.ts:1712-1748`). Both present in baseline; no SQL CHECK on `status`. Stats query: `getTaskStats()` at `src/be/db.ts:1383-1436`. Notification cursor: `getRecentlyFinishedWorkerTasks()` filters status IN ('completed','failed') with `notifiedAt IS NULL` (`src/be/db.ts:1455`). **No dedicated errors / error_logs table** — failure data lives on `agent_tasks` itself (`failureReason`, `finishedAt`). Adjacent: `agent_log` event stream (`task_status_change` rows), `swarm_events` typed events including `system.error`/`api.error`/`task.timeout` (event names at `src/types.ts:494-523`), `session_costs.isError BOOLEAN` (`001_initial.sql:192`), `scheduled_tasks.consecutiveErrors`/`lastErrorAt`/`lastErrorMessage` (`001_initial.sql:232-234`). Errored agents: status enum is `'idle'|'busy'|'offline'|'waiting_for_credentials'` (`053_*.sql:24-25`) — **no `'errored'` status**; `'offline'` is heartbeat-lapse only. No agent-level `failureReason`.

**Bucket 3 — To read.** Final agent output: `agent_tasks.output` TEXT, written by `completeTask(id, output)` at `src/be/db.ts:1628-1671`; column declared in baseline `001_initial.sql:108`. Caller: `store-progress` MCP tool at `src/tools/store-progress.ts:196-222`. Optional structured output: `agent_tasks.outputSchema` JSON-Schema (migration `013_task_output_schema.sql`); `store-progress` validates JSON before persisting (lines 163-193). **No separate "summary" / "completion report" table.** Adjacent: (a) follow-up task to lead synthesized for every worker completion (`src/tools/store-progress.ts:402-461`, `taskType: "follow-up"`, `parentTaskId` set, prompt templates `task.worker.completed`/`task.worker.failed`); (b) `agent_memory` row written with `source: "task_completion"` and `sourceTaskId` (lines 307-361, schema `001_initial.sql:271-287`, fields `name, content, summary, embedding, tags`); (c) `slackReplySent` boolean (`034_slack_reply_sent.sql:1`). **No "agent flagged this as interesting" boolean** — closest signal is `agent_tasks.tags` JSON (free-form; `store-progress` checks `tags?.includes("knowledge"||"shared")` for memory promotion at `src/tools/store-progress.ts:336-338`) and `agent_memory.tags` (`001_initial.sql:284`).

**Bucket 4 — To start.** **Gap — no task-template registry exists.** The `templates/` and `templates-ui/` directories are **agent persona templates**, not session prompts: schema at `templates/schema.ts:1-25` defines `agentDefaults: { role, capabilities, maxTasks, isLead? }` plus per-field markdown files (`SOUL.md`, `IDENTITY.md`, `CLAUDE.md`, `TOOLS.md`, `start-up.sh`, optional `HEARTBEAT.md`). Existing templates: `coder`, `lead`, `tester`, `reviewer`, `researcher`, `forward-deployed-engineer`, `content-writer`, `content-strategist`, `content-reviewer`, `discoverability-optimizer`, `ux-principles`. Registry server `templates-ui/src/lib/templates.ts:24-101` exposes `/api/templates` (`templates-ui/src/app/api/templates/route.ts:15-18`). Adjacent surfaces: (a) `prompt_templates` table (`014_prompt_templates.sql`, schema `src/types.ts:1067-1080`) renders integration messages like `slack.message.thread_context`, `task.worker.completed`, `github.pull_request.review_requested` — **not** user-facing quick-starts; (b) `WorkflowTemplate` schema at `src/types.ts:897-913` defines DAGs of nodes (closer in spirit, but oriented at automation pipelines); (c) `scheduled_tasks.taskTemplate TEXT NOT NULL` (`001_initial.sql:222`) — the literal task body for cron-style schedules.

**Per-user dismiss / snooze state.** **Gap — no per-user UI-state table exists.** `inbox_messages` (`001_initial.sql:198-214`) is keyed on `agentId` (the lead **agent** managing Slack-routed work, not a human user); status enum `'unread'|'processing'|'read'|'responded'|'delegated'`. `channel_read_state` (`001_initial.sql:137-145`) is per-`agentId`. `users` table (`031_user_registry.sql`, schema `src/types.ts:217-233`) is identity-only (slackUserId, linearUserId, githubUsername, emailAliases) — no UI/notification-state columns. Adding a `user_inbox_state(userId, itemType, itemId, status, snoozeUntil, ...)` table (or similar) would be a new forward-only migration.

**Existing Slack "agent asked a question" surface (the path to mirror natively).**
1. Agent calls MCP tool `request-human-input` — `src/tools/request-human-input.ts:31-117`. Handler resolves `sourceTaskId` from `X-Source-Task-Id` header or `getAgentCurrentTask(agentId)` (lines 79-85), then calls `createApprovalRequest({id, title, questions, approvers: { policy: "any" }, sourceTaskId, timeoutSeconds})` (lines 87-95) — **no `notificationChannels` is passed**, so no Slack post happens from this path. Returns `Created approval request "${id}". Human can respond at: ${appUrl}/approval-requests/${id}` (lines 100-104).
2. DB row written via `createApprovalRequest` at `src/be/db.ts:6639-6695` with `status='pending'` and FK `sourceTaskId → agent_tasks.id`.
3. Slack notification (workflow path only) — `HumanInTheLoopExecutor.dispatchNotifications` at `src/workflows/executors/human-in-the-loop.ts:170-265` posts a Block Kit message with "Review & Respond" button linking `${getAppUrl()}/approval-requests/${requestId}` and persists `messageTs` back into `approval_requests.notificationChannels` (lines 243-260).
4. Human responds in UI → `POST /api/approval-requests/{id}/respond` (`src/http/approval-requests.ts:92-110,138-228`): determines `status: 'approved'|'rejected'` from response (lines 155-164), calls `resolveApprovalRequest(id, {status, responses, resolvedBy})` (line 166 → `src/be/db.ts:6713`).
5. Tie-back to source task — branch B (standalone, lines 194-224): renders prompt template `hitl.follow_up`, calls `createTaskExtended(taskText, {agentId: sourceTask.agentId, parentTaskId: sourceTaskId, source: "system", taskType: "hitl-follow-up", tags: ["hitl","follow-up"], slackChannelId/ThreadTs/UserId from source})`. The follow-up task ties back via `parentTaskId` and re-engages the agent through the normal poll loop. (Branch A, workflow request: emits `workflowEventBus.emit("approval.resolved", ...)` at lines 182-190.)

**Note on the original Slack "ask a question" intent.** When an agent posts a Slack message asking the human something (without using `request-human-input`), there is **no programmatic linkage** between that message and a "blocked" state. The agent simply ends its turn (the task transitions to `completed` via `store-progress`); the human's reply enters via `src/slack/handlers.ts:432-494`, creating a NEW task in the same thread routed by `routeMessage`. `slackReplySent` flags whether the agent has posted on the thread (used for minimal vs. full Block Kit rendering), not a "waiting" state.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/slack/app.ts` | 34-39 | Bolt Socket Mode app constructor |
| `src/slack/handlers.ts` | 345 | `app.event("message", ...)` — single fan-in for initial + thread replies |
| `src/slack/handlers.ts` | 623, 631 | `getMostRecentTaskInThread` lookup + `parentTaskId` wiring for lead |
| `src/slack/router.ts` | 26-97 | `routeMessage` — branch on thread context |
| `src/slack/assistant.ts` | 18-156 | DM/"AI app" thread handler (mirror of channel logic) |
| `src/be/db.ts` | 1553-1568 | `getAgentWorkingOnThread` SQL |
| `src/be/db.ts` | 1595-1606 | `getMostRecentTaskInThread` SQL |
| `src/be/db.ts` | 1529-1545 | `getInProgressTasksByContextKey` (sibling-awareness) |
| `src/be/db.ts` | 2124-2259 | `createTaskExtended` — the canonical insert |
| `src/be/db.ts` | 2175-2230 | The 41-column INSERT statement |
| `src/be/db.ts` | 1055-1073 | `getPendingTaskForAgent` SQL — lead/worker pickup |
| `src/be/db.ts` | 1075-1107 | `startTask` atomic transition pending → in_progress |
| `src/be/db.ts` | 1628-1671 | `completeTask` |
| `src/be/db.ts` | 1673-1710 | `failTask` (writes `failureReason`) |
| `src/be/db.ts` | 1712-1748 | `cancelTask` |
| `src/be/db.ts` | 1753-1791 | `pauseTask` (graceful-shutdown only) |
| `src/be/db.ts` | 6639-6695 | `createApprovalRequest` |
| `src/be/db.ts` | 6713, 6739 | `resolveApprovalRequest`, `listApprovalRequests` |
| `src/http/poll.ts` | 110-476 | `GET /api/poll` long-poll handler |
| `src/http/poll.ts` | 177-260 | Pending-for-this-agent branch |
| `src/http/tasks.ts` | 49-73 | `POST /api/tasks` route definition + body schema |
| `src/http/tasks.ts` | 257-307 | Manual task creation handler |
| `src/http/tasks.ts` | 271-272 | `parentTaskId` forwarding + `source` defaulting to `"api"` |
| `src/http/approval-requests.ts` | 138-228 | Approval response handler with follow-up task synthesis |
| `src/http/approval-requests.ts` | 194-224 | Branch B — standalone HITL → follow-up `agent_tasks` row |
| `src/http/approval-requests.ts` | 112-127 | `GET /api/approval-requests?status=pending` |
| `src/http/agents.ts` | 404-420 | `GET /api/agents/credential-status?status=waiting_for_credentials` |
| `src/http/agents.ts` | 422-441 | `PUT /api/agents/{id}/credential-status` |
| `src/http/integrations.ts` | 92-122 | `POST /api/integrations/claude-managed/test` |
| `src/http/session-data.ts` | 41-52, 121-123 | session-logs + session-costs routes |
| `src/http/context.ts` | 41-43 | task context route |
| `src/http/core.ts` | 129-145 | Bearer API-key auth gate |
| `src/commands/runner.ts` | 1371-1411 | `pollForTrigger` long-poll loop |
| `src/commands/runner.ts` | 1174-1190 | `fetchProviderSessionId` (parent's claudeSessionId) |
| `src/commands/runner.ts` | 3206-3223, 2913-2926 | `--resume &lt;parentSessionId&gt;` wiring |
| `src/commands/runner.ts` | 1421-1456 | `buildPromptForTrigger` envelope |
| `src/commands/templates.ts` | 17-32 | `task.trigger.assigned` template |
| `src/tools/request-human-input.ts` | 31-117 | MCP tool that creates approval_requests |
| `src/tools/store-progress.ts` | 196-222 | Completion/failure write path |
| `src/tools/store-progress.ts` | 402-461 | Worker → lead follow-up task synthesis |
| `src/tools/store-progress.ts` | 307-361 | `agent_memory` row with `source="task_completion"` |
| `src/tools/slack-reply.ts` | 14-156 | Worker-initiated outbound Slack reply |
| `src/tasks/sibling-awareness.ts` | 74-96, 111-131 | `applySiblingAwareness` + `withSiblingAwareness` |
| `src/tasks/sibling-block.ts` | 126-149, 155-164 | `pickResumeParent`, `prependSiblingBlock` |
| `src/tasks/context-key.ts` | 78-82 | `slackContextKey({channelId, threadTs})` |
| `src/slack/watcher.ts` | 414, 428 | 3 s outbound tree-message watcher |
| `src/slack/responses.ts` | 29-93 | `chat.postMessage` / `chat.update` adapters |
| `src/slack/templates.ts` | 42-55 | `slack.message.thread_context` template |
| `src/types.ts` | 4-15 | `AgentTaskStatusSchema` (10 statuses) |
| `src/types.ts` | 56-69 | `AgentTaskSourceSchema` (11 sources) |
| `src/types.ts` | 105 | `AgentTaskSchema` |
| `src/types.ts` | 142-151 | VCS columns on agent_tasks |
| `src/types.ts` | 217-233 | `users` table schema |
| `src/types.ts` | 494-523 | `swarm_events` event-name list |
| `src/types.ts` | 1067-1080 | `prompt_templates` schema |
| `src/types.ts` | 897-913 | `WorkflowTemplate` schema |
| `src/be/migrations/001_initial.sql` | 70-111 | Initial `agent_tasks` schema |
| `src/be/migrations/043_jira_source.sql` | 16, 37 | Current `source` CHECK + `parentTaskId` declaration |
| `src/be/migrations/034_slack_reply_sent.sql` | 1, 4 | `slackReplySent` column + parent index |
| `src/be/migrations/040_slack_thread_composite_index.sql` | 2-3 | Slack thread composite index |
| `src/be/migrations/042_task_context_key.sql` | 12-13 | `contextKey` column + index |
| `src/be/migrations/020_approval_requests.sql` | 4-33, 41 | Approval requests table + pending index |
| `src/be/migrations/053_agent_waiting_for_credentials_status.sql` | 24-25, 41 | Agent credential status + missing array |
| `src/be/migrations/024_add_was_paused.sql` | 1 | `was_paused` column |
| `src/be/migrations/013_task_output_schema.sql` | — | `outputSchema` column |
| `src/be/migrations/014_prompt_templates.sql` | — | Prompt templates table |
| `templates/schema.ts` | 1-25 | Agent persona template config schema |
| `templates-ui/src/lib/templates.ts` | 24-101 | Template registry server |
| `ui/src/app/router.tsx` | — | All ui/ routes (no `/sessions`) |
| `ui/src/app/providers.tsx` | 7-15 | TanStack Query global defaults (5s poll, 2s stale) |
| `ui/src/components/layout/root-layout.tsx` | — | Shell composition |
| `ui/src/components/layout/app-sidebar.tsx` | — | Hardcoded `navGroups` (Core/AI/Operations/Configuration/System) |
| `ui/src/pages/dashboard/page.tsx` | — | Current home (StatsBar + 2-col + activity feed) |
| `ui/src/pages/tasks/[id]/page.tsx` | 451, 454-461 | TaskDetailPage + 5-hook fan-out |
| `ui/src/pages/tasks/[id]/page.tsx` | 540-549 | Read-only "Parent" link rendering |
| `ui/src/pages/tasks/page.tsx` | 35-42, 53, 96-97, 317-330 | TaskFormData / CreateTaskDialog / agentId default / submit |
| `ui/src/pages/integrations/page.tsx` | — | Integrations grid |
| `ui/src/lib/integrations-catalog.ts` | — | Integrations source-of-truth |
| `ui/src/api/client.ts` | 110-119, 215-234 | getHeaders + createTask client |
| `ui/src/api/hooks/use-tasks.ts` | 22-28, 30-37, 39-46, 48-63, 65-97 | useTask / useTaskSessionLogs / useTaskContext / useCreateTask / mutations |
| `ui/src/api/types.ts` | 70 | `parentTaskId?` on AgentTask |
| `ui/src/components/shared/data-grid.tsx` | — | ag-grid wrapper |
| `ui/src/components/ui/detail-page-layout.tsx` | — | DetailPageBody/DetailPageRail/QuickStats — canonical 1fr+280px layout |
| `ui/src/components/workflows/workflow-graph.tsx` | 1-3, 63-78 | `@xyflow/react` consumer (read-only) |
| `ui/src/components/workflows/graph-utils.ts` | 108, 162, 254 | detectBackEdges / applyStairLayout / applyDagreLayout |
| `ui/src/components/shared/workflow-node-shell.tsx` | — | Custom-node base with Handles |
| `ui/src/components/shared/session-log-viewer.tsx` | — | Streaming log render with auto-scroll |
| `ui/package.json` | 19, 26, 32 | `@xyflow/react` ^12.10.1, `dagre` ^0.8.5, `recharts` ^3.7.0 |
| `ui/src/styles/globals.css` | — | OKLCH design tokens (Zinc + amber) + semantic status tokens |

## Open Questions

These aren't blockers — they're decisions the brainstorm intentionally deferred or codebase realities that surfaced during research:

- ~~**Source attribution.** Add a new `'ui-session'` (or `'ui'`) value to the `agent_tasks.source` enum, or keep using the default `'api'` for sessions-spawned tasks?~~ **RESOLVED (2026-05-08, taras):** Drop the SQL `CHECK` constraint on `agent_tasks.source` entirely; rely on Zod (`AgentTaskSourceSchema` at `src/types.ts:56-69`) as the single source of truth. Tighten the HTTP route at `src/http/tasks.ts:65` from `source: z.string().optional()` to `AgentTaskSourceSchema.optional()` so the route enforces enum membership (currently the SQL CHECK is the only gate; the route accepts any string). Other write paths (`src/slack/*`, `src/gitlab/*`, `src/scheduler/*`, `src/workflows/executors/*`, `src/agentmail/*`) already pass typed `AgentTaskSource` literals into `createTaskExtended` and are TS-checked. One-time migration cost: a single `agent_tasks` table-rebuild to drop the CHECK; future enum additions become one-line `src/types.ts` edits.
- **Per-user dismiss/snooze schema.** A new table is required (no precedent). Shape options: a single `user_inbox_state(userId, itemType, itemId, status, snoozeUntil, dismissedAt)` table, or per-bucket tables. Tied to the `users` table identity at `src/types.ts:217-233`.
- **PR-awaiting-review data source.** No data source exists. Options: GitHub API poller (new), GitHub webhook for `review_request.created` (extends `src/github/handlers.ts` beyond bot-only filtering), or simply omit this from v1 Blocking-bucket and surface only `approval_requests` + `waiting_for_credentials` agents.
- **Generic "missing API keys / setup" health.** No aggregator exists. v1 could read just `agents.status='waiting_for_credentials'` and `claude-managed/test` and call it good; a fuller health surface would be a new endpoint scanning `swarm_config` + per-integration probes.
- **Task templates registry.** "To start" needs a new table (or new use of `prompt_templates`). Existing `templates/` is reserved for agent personas — repurposing would be confusing. Likely shape: `task_templates(id, title, description, category, prompt, tags, createdBy, createdAt)`.
- **"Awaiting input" for follow-up posts.** When an agent posts to Slack waiting for a reply (without `request-human-input`), the task is marked `completed` and there is no "blocked" signal. v1 could either (a) require the agent to use `request-human-input` for proper blocking semantics, (b) introduce a soft `awaiting_input` status (would touch the state machine), or (c) infer from heuristics. None of these is implied by the brainstorm.
- **Sub-second feel for the session timeline.** Reusing 5s polling matches today's task-detail page, but the "chat" framing might invite a sub-second expectation. If so, that's an SSE/WS layer (new), not a polling extension.
- ~~**Transcript expansion shape on session task cards.**~~ **RESOLVED (2026-05-08, taras):** Side panel via shadcn `Sheet` (`ui/src/components/ui/sheet.tsx`), embedding the existing `SessionLogViewer` (`ui/src/components/shared/session-log-viewer.tsx`) plus the existing taskId-keyed hooks (`useTaskSessionLogs`, `useTaskContext`, `useSessionCosts`). Click a task card → Sheet opens with the same content surface as `/tasks/:id`. Inline-expand is reserved for *summary* expansion only (status-change log entries, key tool calls — short content); full transcripts go in the Sheet so the timeline layout stays stable while inspecting. Reuse is near-total — no new viewer component required.
- **Chain fetch endpoint.** No `parentTaskId`/`rootTaskId`/`ancestorTaskId` filter on `GET /api/tasks` today (`src/http/tasks.ts:29-47`). For a session timeline page with N tasks in the chain, naive N-hook fanout works for small N; a dedicated `GET /api/sessions/{rootId}` (or similar) is the cleaner shape.
- **`creatorAgentId` for UI sessions.** UI client doesn't send `X-Agent-ID`, so dashboard-created tasks have `creatorAgentId = null`. Tying sessions to a specific human user requires populating `requestedByUserId` from the route — which today only adapters do.
- **Workflow-template overlap.** `WorkflowTemplate` schema (`src/types.ts:897-913`) is the closest existing concept to "quick-start" — re-use vs. invent-new is a design call, not a code constraint.

## Appendix

- **Architecture notes.**
  - The API server (`src/http/`, `src/be/db.ts`, `src/tools/`, `src/server.ts`) is the **sole owner** of the SQLite database. Worker-side code (`src/commands/`, `src/hooks/`, `src/providers/`, `src/prompts/`, `src/cli.tsx`) talks to the API over HTTP using `API_KEY` and `X-Agent-ID` headers (boundary enforced by `scripts/check-db-boundary.sh`).
  - All HTTP routes use the `route()` factory from `src/http/route-def.ts` (auto-registers in OpenAPI). Adding `parentTaskId` write support to ui/ requires no new routes.
  - The chain primitive (`agent_tasks.parentTaskId`) is the universal shape: Slack threads, GitLab MRs, scheduler, sibling-awareness, heartbeat retries, HITL follow-ups, and worker-completion follow-ups all use the same field. UI sessions are not a new flow — they are the **same flow on a different surface**.
  - Sub-second stream feel is not a current architecture goal anywhere — the entire `ui/` is polling-based.
  - `@xyflow/react` is already a first-class dependency with a working dagre layout pipeline, custom typed nodes, and theme-awareness. The agent canvas v1 is engineering-light.
- **Historical context (from thoughts/).** The brainstorm `thoughts/taras/brainstorms/2026-05-08-ui-chat-session-experience.md` is the direct input to this research. A separate brainstorm `thoughts/taras/brainstorms/2026-05-07-cloud-deployment-personalization.md` and its research file `thoughts/taras/research/2026-05-07-cloud-personalization-research.md` exist on a different topic (cloud personalization) — neither is load-bearing for this work.
- **Related research.**
  - `thoughts/taras/brainstorms/2026-05-08-ui-chat-session-experience.md` — input brainstorm; this research answers its "Next Steps" focus areas verbatim.
