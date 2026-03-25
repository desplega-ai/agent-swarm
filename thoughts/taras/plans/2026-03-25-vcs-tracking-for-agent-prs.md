---
date: 2026-03-25T19:00:00-04:00
author: Claude + Taras
topic: "VCS tracking for agent-created PRs"
tags: [plan, github, vcs, task-lifecycle, pr-tracking]
status: ready
autonomy: autopilot
source: thoughts/taras/brainstorms/2026-03-25-vcs-tracking-gap.md
last_updated: 2026-03-25
last_updated_by: Claude
---

# VCS Tracking for Agent-Created PRs — Implementation Plan

## Summary

Close the gap where tasks created outside GitHub webhooks (Slack, manual, etc.) lose track of PRs created by agents during execution. Adds automatic branch→PR detection on the worker side and a new API endpoint to update VCS fields on tasks.

## Architecture

```
Worker (Docker)                              API Server
┌─────────────────────┐                    ┌───────────────────┐
│ runner.ts            │                    │ tasks.ts          │
│                      │                    │                   │
│ detectVcsForTask()   │─── PATCH ────────→│ /api/tasks/:id/vcs│
│  ├─ git branch       │   /api/tasks/     │  └─ updateTaskVcs()│
│  ├─ gh pr list       │   {id}/vcs        │     └─ UPDATE DB   │
│  └─ cache result     │                    │                   │
│                      │                    │                   │
│ Called from:         │                    │ findTaskByVcs()   │
│  1. checkCompleted() │                    │  now matches this │
│  2. periodic (60s)   │                    │  task too!        │
└─────────────────────┘                    └───────────────────┘
```

## Phases

---

### Phase 1: API — DB Function + HTTP Endpoint

**Goal:** Add the ability to update VCS fields on an existing task.

#### 1.1 DB function: `updateTaskVcs()`

**File:** `src/be/db.ts`

Add after `updateTaskClaudeSessionId()` (~line 937). Follow Pattern B (inline prepared statement):

```typescript
export function updateTaskVcs(
  taskId: string,
  vcs: {
    vcsProvider: "github" | "gitlab";
    vcsRepo: string;
    vcsNumber: number;
    vcsUrl: string;
  },
): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, number, string, string, string]>(
      `UPDATE agent_tasks
       SET vcsProvider = ?, vcsRepo = ?, vcsNumber = ?, vcsUrl = ?, lastUpdatedAt = ?
       WHERE id = ? RETURNING *`,
    )
    .get(vcs.vcsProvider, vcs.vcsRepo, vcs.vcsNumber, vcs.vcsUrl, new Date().toISOString(), taskId);
  return row ? rowToAgentTask(row) : null;
}
```

Notes:
- Always sets all four VCS fields together (atomic update)
- Uses `RETURNING *` to return the updated task (convention)
- `lastUpdatedAt` is always updated (convention)
- Does NOT check if vcsNumber was already set — caller decides (idempotent by design)

#### 1.2 HTTP endpoint: `PATCH /api/tasks/:id/vcs`

**File:** `src/http/tasks.ts`

Add route definition near the other task sub-resource routes:

```typescript
const updateTaskVcsRoute = route({
  method: "patch",
  path: "/api/tasks/{id}/vcs",
  pattern: ["api", "tasks", null, "vcs"],
  summary: "Update VCS (PR/MR) info for a task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({
    vcsProvider: z.enum(["github", "gitlab"]),
    vcsRepo: z.string(),
    vcsNumber: z.number().int().positive(),
    vcsUrl: z.string().url(),
  }),
  responses: {
    200: { description: "VCS info updated" },
    404: { description: "Task not found" },
  },
  auth: { apiKey: true },
});
```

Add handler in `handleTasks()`:

```typescript
if (updateTaskVcsRoute.match(req.method, pathSegments)) {
  const parsed = await updateTaskVcsRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  const task = updateTaskVcs(parsed.params.id, parsed.body);
  if (!task) {
    jsonError(res, "Task not found", 404);
    return true;
  }
  json(res, task);
  return true;
}
```

#### 1.3 Register in OpenAPI

**File:** `scripts/generate-openapi.ts`

Import `src/http/tasks.ts` if not already imported (it likely is). The `route()` factory auto-registers, so just running `bun run docs:openapi` should pick it up.

#### Verification

```bash
bun run tsc:check
bun run lint:fix
bun test src/tests/http-api-integration.test.ts  # existing task API tests
# Manual: start API, call the endpoint
curl -s -X PATCH "http://localhost:3013/api/tasks/<task-id>/vcs" \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"vcsProvider":"github","vcsRepo":"owner/repo","vcsNumber":42,"vcsUrl":"https://github.com/owner/repo/pull/42"}'
```

---

### Phase 2: Worker — Detection Function

**Goal:** Add a function that detects if the current working directory has a PR for its branch.

#### 2.1 Detection function: `detectVcsForTask()`

**File:** `src/commands/runner.ts`

Add a new function near the other API-calling helpers (after `saveProviderSessionId`, ~line 883):

```typescript
/**
 * Detect if the task's working directory has an open PR for the current branch.
 * If found, report VCS info to the API so webhook events can link back to this task.
 */
async function detectVcsForTask(
  apiUrl: string,
  apiKey: string,
  taskId: string,
  workingDir: string,
): Promise<void> {
  try {
    // 1. Check if inside a git repo
    const isGit = await Bun.$`git -C ${workingDir} rev-parse --is-inside-work-tree`
      .quiet()
      .text();
    if (isGit.trim() !== "true") return;

    // 2. Get current branch
    const branch = (await Bun.$`git -C ${workingDir} branch --show-current`.quiet().text()).trim();
    if (!branch || branch === "main" || branch === "master") return;

    // 3. Get remote URL to determine provider and repo
    const remoteUrl = (
      await Bun.$`git -C ${workingDir} remote get-url origin`.quiet().text()
    ).trim();

    // 4. Detect provider and check for PR/MR
    let vcsProvider: "github" | "gitlab";
    let prJson: string;

    if (remoteUrl.includes("github.com") || remoteUrl.includes("github")) {
      vcsProvider = "github";
      prJson = (
        await Bun.$`gh pr list --head ${branch} --json number,url --limit 1`.quiet().text()
      ).trim();
    } else if (remoteUrl.includes("gitlab")) {
      vcsProvider = "gitlab";
      prJson = (
        await Bun.$`glab mr list --source-branch ${branch} --json iid,web_url --per-page 1`
          .quiet()
          .text()
      ).trim();
    } else {
      return; // Unknown provider
    }

    // 5. Parse result
    const prs = JSON.parse(prJson);
    if (!Array.isArray(prs) || prs.length === 0) return;

    const pr = prs[0];
    const vcsNumber = pr.number ?? pr.iid;
    const vcsUrl = pr.url ?? pr.web_url;
    if (!vcsNumber || !vcsUrl) return;

    // 6. Extract repo from remote URL
    const repoMatch = remoteUrl.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    if (!repoMatch) return;
    const vcsRepo = repoMatch[1];

    // 7. Report to API
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    await fetch(`${apiUrl}/api/tasks/${taskId}/vcs`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ vcsProvider, vcsRepo, vcsNumber, vcsUrl }),
    });

    console.log(`[VCS] Linked task ${taskId} to ${vcsProvider} ${vcsRepo}#${vcsNumber}`);
  } catch {
    // Fire-and-forget — detection failure should never block task execution
  }
}
```

Key design decisions:
- **Fire-and-forget** — wrapped in try/catch, never throws. VCS detection is a nice-to-have, not a requirement.
- **Provider detection** from remote URL — supports both GitHub and GitLab.
- **Skips main/master** — no PR to find on the default branch.
- **Uses `Bun.$`** — follows project convention (not `execa`).
- **Extracts repo from remote URL** — doesn't rely on task's `vcsRepo` being set.

#### 2.2 Cache to avoid repeated checks

Add a `Set<string>` at module level in runner.ts to track tasks that already have VCS linked:

```typescript
const vcsDetectedTasks = new Set<string>();
```

Guard the detection call:

```typescript
if (!vcsDetectedTasks.has(taskId)) {
  await detectVcsForTask(apiUrl, apiKey, taskId, workingDir);
  // After successful detection (or if task already has vcsNumber), add to set
  vcsDetectedTasks.add(taskId);
}
```

The cache prevents re-running `gh pr list` every check cycle. It resets on runner restart (which is fine — new process, new state).

#### Verification

```bash
bun run tsc:check
bun run lint:fix
```

---

### Phase 3: Runner Integration — Call Sites

**Goal:** Wire `detectVcsForTask()` into the runner at the right moments.

#### 3.1 At task completion: `checkCompletedProcesses()`

**File:** `src/commands/runner.ts`, function `checkCompletedProcesses()` (~line 1639)

Before calling `ensureTaskFinished()` at line 1682, add VCS detection:

```typescript
// Detect VCS before finishing — last chance to link a PR
const taskDir = task.workingDir || task.dir;
if (taskDir && !vcsDetectedTasks.has(taskId)) {
  await detectVcsForTask(apiUrl, apiKey, taskId, taskDir);
  vcsDetectedTasks.add(taskId);
}
```

This is the guaranteed call site — runs for every completed task, regardless of how the agent finished.

#### 3.2 Periodic during execution: main poll loop

> **Note:** This runs in `src/commands/runner.ts` which is the shared runner for all providers (Claude, Pi-mono, etc.). `detectVcsForTask()` uses `git`/`gh` CLI commands — provider-agnostic.

**File:** `src/commands/runner.ts`, in the main polling loop (~line 2373)

Add a periodic VCS check for all running tasks. Throttle to once per 60 seconds per task:

```typescript
const vcsCheckTimestamps = new Map<string, number>();
const VCS_CHECK_INTERVAL = 60_000; // 60 seconds

// Inside the main loop, after checkCompletedProcesses():
const now = Date.now();
for (const [taskId, runningTask] of state.activeTasks) {
  const lastCheck = vcsCheckTimestamps.get(taskId) ?? 0;
  if (now - lastCheck < VCS_CHECK_INTERVAL) continue;
  if (vcsDetectedTasks.has(taskId)) continue;

  const taskDir = runningTask.workingDir || runningTask.dir;
  if (!taskDir) continue;

  vcsCheckTimestamps.set(taskId, now);
  // Non-blocking — don't await, just fire
  detectVcsForTask(apiUrl, apiKey, taskId, taskDir).then(() => {
    // On success, mark as detected to stop future checks
    // (detectVcsForTask logs on success, so we know it worked)
  });
}
```

Notes:
- 60-second interval prevents GitHub API rate limit issues
- Fire-and-forget (no await) — doesn't block the poll loop
- Skips tasks already in `vcsDetectedTasks` cache
- Cleans up automatically when task completes (removed from `activeTasks`)

#### 3.3 Wire workingDir into RunningTask

Check if `RunningTask` (or the equivalent tracked object in `state.activeTasks`) already carries the working directory. If not, add it when the task is spawned at line 2690. The task's `dir` field or the resolved working directory from `spawnProviderProcess()` should be captured.

#### Verification

```bash
bun run tsc:check
bun run lint:fix
bun test  # Full test suite
```

---

### Phase 4: Unit Tests

**Goal:** Test the DB function and HTTP endpoint.

#### 4.1 DB function test

**File:** `src/tests/vcs-tracking.test.ts` (new)

```
- Test updateTaskVcs() sets all VCS fields correctly
- Test updateTaskVcs() with non-existent task returns null
- Test updateTaskVcs() updates lastUpdatedAt
- Test updateTaskVcs() overwrites existing VCS fields (last PR wins)
- Test findTaskByVcs() finds task after updateTaskVcs() is called
```

Follow existing test conventions: isolated SQLite DB, `initDb()`/`closeDb()` in `beforeAll`/`afterAll`.

#### 4.2 HTTP endpoint test

In existing `src/tests/http-api-integration.test.ts` or new file:

```
- Test PATCH /api/tasks/:id/vcs with valid body → 200 + updated task
- Test PATCH /api/tasks/:id/vcs with invalid task ID → 404
- Test PATCH /api/tasks/:id/vcs with invalid body (missing fields) → 400
- Test PATCH /api/tasks/:id/vcs without auth → 401
- Test idempotency: call twice with same data → both return 200
- Test overwrite: call with PR #1, then PR #2 → task has PR #2
```

#### Verification

```bash
bun test src/tests/vcs-tracking.test.ts
bun test src/tests/http-api-integration.test.ts
```

---

### Phase 5: OpenAPI + Lint

**Goal:** Ensure everything is clean.

```bash
bun run docs:openapi          # Regenerate openapi.json
bun run lint:fix              # Biome lint + format
bun run tsc:check             # TypeScript type check
bash scripts/check-db-boundary.sh  # Worker/API DB boundary
```

The DB boundary check is critical — `detectVcsForTask()` lives in `src/commands/runner.ts` (worker-side) and must NOT import from `src/be/db`. It only calls the API via HTTP.

---

### Phase 6: Manual E2E Verification

**Goal:** Verify end-to-end that an agent-created PR gets linked and webhook events flow correctly.

```bash
# 1. Clean DB + start API
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &

# 2. Create a task manually (simulating non-GitHub origin)
TASK_ID=$(curl -s -X POST "http://localhost:3013/api/tasks" \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"task":"Create a test PR","vcsRepo":"desplega-ai/agent-swarm"}' | jq -r '.id')
echo "Task: $TASK_ID"

# 3. Simulate worker detecting a PR (manual call)
curl -s -X PATCH "http://localhost:3013/api/tasks/$TASK_ID/vcs" \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"vcsProvider":"github","vcsRepo":"desplega-ai/agent-swarm","vcsNumber":999,"vcsUrl":"https://github.com/desplega-ai/agent-swarm/pull/999"}' | jq .

# 4. Verify the task now has VCS fields
curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/tasks/$TASK_ID" | jq '{vcsProvider, vcsRepo, vcsNumber, vcsUrl}'
# Expected: {"vcsProvider":"github","vcsRepo":"desplega-ai/agent-swarm","vcsNumber":999,"vcsUrl":"..."}

# 5. Verify findTaskByVcs would now match
# (This is what webhook handlers use to link follow-up events)
# Can test by sending a simulated webhook — or just verify the DB directly

# 6. Cleanup
kill $(lsof -ti :3013) 2>/dev/null
```

For full Docker E2E (optional, if time permits):
**Production validation:** Deploy and verify with a real worker task in production — create a non-GitHub task, let an agent create a PR, confirm VCS fields get linked and subsequent webhook events (reviews, CI) create follow-up tasks.

---

## Files Changed

| File | Change |
|------|--------|
| `src/be/db.ts` | Add `updateTaskVcs()` function |
| `src/http/tasks.ts` | Add `PATCH /api/tasks/:id/vcs` route + handler |
| `src/commands/runner.ts` | Add `detectVcsForTask()`, call from `checkCompletedProcesses()` + periodic loop |
| `src/tests/vcs-tracking.test.ts` | New: DB + HTTP endpoint tests |
| `openapi.json` | Regenerated (auto) |

## Out of Scope

- GitLab MR detection (designed for, not implemented — `glab` command path is sketched but untested)
- Hook-based interception of `gh pr create` (future nice-to-have)
- Multi-PR tracking per task (YAGNI — last PR wins)
- Webhook-side fallback matching by branch name (future robustness improvement)
