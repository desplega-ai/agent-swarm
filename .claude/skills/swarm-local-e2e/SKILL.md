---
name: swarm-local-e2e
description: Guide for running local E2E tests with API server, Docker lead/worker containers, task creation, log verification, UI dashboard, and cleanup
---

# Local E2E Testing Guide

Run full end-to-end tests of the agent swarm locally with a real API server and Docker containers.

## When to Use This Skill

This skill should be invoked in two modes:

1. **User-requested QA**: The user asks you to run E2E tests, verify a feature, or QA a specific flow. Follow the steps below targeting what they asked for.

2. **Automated change verification**: After implementing changes that touch the API, runner, polling, task lifecycle, session logs, Docker entrypoint, or worker/lead behavior — use this skill proactively to verify the changes work end-to-end. Determine what's testable based on the diff:
   - **Task lifecycle changes** (poll, runner, store-progress): Create assigned + pool tasks, verify they complete and have correct logs
   - **Session log changes**: Run two sequential tasks on the same agent, verify log isolation (unique sessionIds, no cross-contamination)
   - **Docker / entrypoint changes**: Build image, start containers, verify boot logs and registration
   - **UI changes**: Start the dashboard, use agent-browser/qa-use to verify rendering
   - **API endpoint changes**: Call the endpoint directly and verify the response

You do not need to run every step — pick the subset relevant to the changes being tested.

## Prerequisites

- OrbStack or Docker Desktop running (`open -a OrbStack` if needed)
- `.env` with `API_KEY` and `PORT` configured
- `.env.docker-lead` with lead config (`AGENT_ID`, `CLAUDE_CODE_OAUTH_TOKEN`, `MCP_BASE_URL`)
- `.env.docker` with worker config (`AGENT_ID`, `CLAUDE_CODE_OAUTH_TOKEN` or `OPENROUTER_API_KEY`, `MCP_BASE_URL`)

## Step 1: Determine Your Port

Check `.env` for the configured port — do **not** assume 3013:

```bash
grep ^PORT= .env
```

Use this value as `$PORT` throughout. In worktrees, each worktree may have a different port. Always verify and use the value from `.env`.

Also verify the Docker env files match:
```bash
grep MCP_BASE_URL .env.docker-lead .env.docker
# Both should point to http://host.docker.internal:$PORT
```

If they don't match, update them before starting containers.

## Step 2: Clean DB + Start API Server

```bash
# Kill any existing API process on your port
lsof -ti :$PORT | xargs kill 2>/dev/null

# Clean DB for fresh state
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm

# Start API server
bun run start:http &
# Wait ~3s for startup, confirm "MCP HTTP server running on http://localhost:$PORT/mcp"
```

## Step 3: Build Docker Image

```bash
bun run docker:build:worker
```

This builds `agent-swarm-worker:latest` from the current code. **Rebuild after every code change.**

## Step 4: Start Lead Container

Use a **unique container name** to avoid conflicts with other worktrees (e.g. include branch name or feature):

```bash
docker run --rm -d \
  --name e2e-lead-$(git branch --show-current | tr '/' '-') \
  --env-file .env.docker-lead \
  -e AGENT_ROLE=lead \
  -e MAX_CONCURRENT_TASKS=1 \
  -p 3201:3000 \
  agent-swarm-worker:latest
```

Wait ~15s, then verify:
```bash
docker logs e2e-lead-$(git branch --show-current | tr '/' '-') 2>&1 | tail -5
# Should see: "[lead] Polling for triggers (0/1 active)..."
```

If port 3201 is taken by another worktree, pick a different host port (e.g. `-p 3211:3000`).

## Step 5: Start Worker Container

```bash
docker run --rm -d \
  --name e2e-worker-$(git branch --show-current | tr '/' '-') \
  --env-file .env.docker \
  -e MAX_CONCURRENT_TASKS=1 \
  -p 3203:3000 \
  agent-swarm-worker:latest
```

Wait ~15s, then verify:
```bash
docker logs e2e-worker-$(git branch --show-current | tr '/' '-') 2>&1 | tail -5
# Should see: "[worker] Polling for triggers (0/1 active)..."
```

## Step 6: Verify Registration

Use `context-mode execute` (not curl directly due to hook restrictions):

```javascript
const headers = { 'Authorization': 'Bearer $API_KEY', 'Content-Type': 'application/json' };
const agents = await (await fetch('http://localhost:$PORT/api/agents', { headers })).json();
for (const a of agents.agents) {
  console.log(`${a.name} | isLead: ${a.isLead} | status: ${a.status} | id: ${a.id}`);
}
```

Should show both lead and worker registered as `idle`. Save the agent IDs for task creation.

## Step 7: Create Tasks

### Assigned task (picked up by lead)

```javascript
const t = await (await fetch('http://localhost:$PORT/api/tasks', {
  method: 'POST', headers,
  body: JSON.stringify({ task: 'Say hello. Call store-progress with status completed.', agentId: LEAD_ID })
})).json();
console.log('Task:', t.id, '| status:', t.status);
```

**Important**: Use `agentId` (not `assignedTo`) to assign tasks. Wrong param silently creates an unassigned task.

### Pool task (auto-claimed by worker)

```javascript
const t = await (await fetch('http://localhost:$PORT/api/tasks', {
  method: 'POST', headers,
  body: JSON.stringify({ task: 'Say hello. Call store-progress with status completed.' })
})).json();
console.log('Pool task:', t.id, '| status:', t.status);
```

Workers auto-claim unassigned tasks at poll time. Leads do **not** auto-claim pool tasks.

## Step 8: Monitor Progress

```bash
# Watch lead logs (use your container name)
docker logs -f e2e-lead-$(git branch --show-current | tr '/' '-') 2>&1 | tail -20

# Watch worker logs
docker logs -f e2e-worker-$(git branch --show-current | tr '/' '-') 2>&1 | tail -20
```

Poll task status:
```javascript
const t = await (await fetch('http://localhost:$PORT/api/tasks/<task-id>', { headers })).json();
console.log(t.status);  // pending → in_progress → completed/failed
```

## Step 9: Verify Session Logs

```javascript
const logs = await (await fetch('http://localhost:$PORT/api/tasks/<task-id>/session-logs', { headers })).json();
console.log('Log count:', logs.logs.length);
// Should be > 0 for completed tasks
```

For **log isolation** verification (multiple sequential tasks from same agent):
```javascript
const [l1, l2] = await Promise.all([
  fetch('http://localhost:$PORT/api/tasks/<task1>/session-logs', { headers }).then(r => r.json()),
  fetch('http://localhost:$PORT/api/tasks/<task2>/session-logs', { headers }).then(r => r.json()),
]);
const s1 = [...new Set(l1.logs.map(l => l.sessionId))];
const s2 = [...new Set(l2.logs.map(l => l.sessionId))];
console.log('Unique sessionIds:', s1[0] !== s2[0]);  // Should be true
```

## Step 10: Test the Dashboard UI

Start the dashboard to visually verify tasks, logs, and agent status:

```bash
cd new-ui && pnpm run dev &
# Defaults to port from APP_URL in .env (check with: grep APP_URL ../.env)
```

If the UI port is taken by another worktree, start on an alternate:
```bash
cd new-ui && pnpm run dev --port 5276
```

The UI connects to the API via `VITE_API_URL` (check `new-ui/.env` or defaults to `http://localhost:$PORT`).

### Visual verification with agent-browser / qa-use

Use `agent-browser` or `qa-use` to automate UI checks:

```bash
# Quick visual gut-check with agent-browser
agent-browser --url http://localhost:5175 snapshot

# Or use qa-use to verify specific flows
qa-use explore http://localhost:5175
```

Things to verify in the UI:
- **Agents page**: Lead and worker both show as registered with correct status
- **Tasks page**: Tasks appear with correct status, assigned agent, and timestamps
- **Task detail → Logs tab**: Session logs render in the conversation viewer (not "No session data available")
- **Task detail → Outcome tab**: Completed tasks show output
- **Costs**: Session costs appear for completed tasks

## Step 11: Cleanup

```bash
# Stop containers (use your branch-specific names)
docker stop e2e-lead-$(git branch --show-current | tr '/' '-') e2e-worker-$(git branch --show-current | tr '/' '-') 2>/dev/null

# Stop API server
lsof -ti :$PORT | xargs kill 2>/dev/null

# Stop UI dev server (if started)
lsof -ti :5175 | xargs kill 2>/dev/null
```

## Troubleshooting

### Docker daemon not running
```
ERROR: Cannot connect to the Docker daemon
```
Fix: `open -a OrbStack` and wait ~5s.

### Container name conflict
```
docker: Error response from daemon: Conflict. The container name "..." is already in use
```
Another worktree has a container with the same name. Either stop it (`docker stop <name>`) or use a different name suffix.

### Lead not picking up tasks
- Verify task was created with `agentId` (not `assignedTo`) — wrong param silently creates an unassigned task
- Check task status isn't already `in_progress` (e.g. from a manual poll call that consumed the trigger)
- Restart container if stuck: `docker restart <container-name>`

### Worker not picking up pool tasks
- Workers auto-claim via poll. Leads do **not** claim pool tasks.
- Check worker has capacity: `docker logs <container> 2>&1 | grep "capacity"`
- If "At capacity" — a previous task is still running. Wait or restart.

### Poll returns 404
- Poll endpoint is **GET** `/api/poll` (not POST)
- Requires `X-Agent-ID` header with a valid agent UUID

### Port conflicts (worktrees)
```bash
lsof -i :3013  # Check what's using the port
```
If another worktree is running, set a different `PORT` in `.env` and update `MCP_BASE_URL` in `.env.docker*` to `http://host.docker.internal:<new-port>`.

### Session logs show 0 entries
- Task must have actually run (status `completed` or `failed`, not just `in_progress`)
- Check `claudeSessionId` is set on the task: `GET /api/tasks/<id>` should show it
- If logs were stored under wrong taskId, check the `session_logs` table directly

### Task cancellation doesn't stop Claude
Direct API cancellation (`POST /api/tasks/<id>/cancel`) updates the DB but doesn't kill the Claude process inside Docker. Use `docker restart <container>` to force-stop.

### Keep tasks trivial
Use simple tasks like "Say hello" for E2E tests. Complex tasks waste time and API credits.

### UI shows stale data
The dashboard auto-polls every 5 seconds. If data looks stale, hard-refresh (Cmd+Shift+R) or check `VITE_API_URL` points to the correct API port.
