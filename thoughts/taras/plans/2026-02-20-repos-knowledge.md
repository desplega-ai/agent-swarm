---
date: 2026-02-20
planner: Claude
branch: respo-knowledge
repository: agent-swarm
topic: "Repos Knowledge — Gap 4 Implementation"
tags: [plan, repos, knowledge, gap-4, agent-native, auto-clone, claude-md]
status: implemented
autonomy: autopilot
research: thoughts/taras/research/2026-02-19-swarm-gaps-implementation.md
---

# Repos Knowledge — Implementation Plan

## Overview

Implement centralized repository management for the agent swarm. This is Gap 4 from the swarm-gaps research and Phase 5 in the agent-native architecture rollout (order: 6 → 1 → 3 → 4 → 5; Gaps 6, 1, 3 already merged).

Today, there is no concept of "registered repos" in the swarm. The `githubRepo` field exists on tasks and epics but is only set by GitHub webhook handlers — not exposed in the `send-task` MCP tool, not used by the runner for workspace setup, and not linked to any CLAUDE.md injection. Workers clone repos ad-hoc when instructed in task descriptions.

This plan adds: a `swarm_repos` DB table for repo registration, REST API endpoints, Docker entrypoint auto-clone, repo CLAUDE.md injection into the runner's system prompt, `send-task` tool extension to expose `githubRepo`, and a UI management page.

## Current State Analysis

### What Exists

- **`githubRepo` field on tasks**: `agent_tasks.githubRepo TEXT` in DB schema (`src/be/db.ts:842`), `AgentTaskSchema.githubRepo` in types (`src/types.ts:96`), and `CreateTaskOptions.githubRepo` (`src/be/db.ts:1842`). Set by GitHub webhook handlers (`src/github/handlers.ts:109`) but **not exposed** in the `send-task` MCP tool (`src/tools/send-task.ts`).
- **`githubRepo` field on epics**: `epics.githubRepo TEXT` in DB, `EpicSchema.githubRepo` in types (`src/types.ts:341`). Exposed in `create-epic` and `update-epic` MCP tools. Displayed in UI epic details.
- **GitHub auth is ready**: `docker-entrypoint.sh:150-170` configures `gh auth setup-git` and git config. Workers can clone private repos.
- **Docker workspace**: `/workspace/personal/` (per-agent), `/workspace/shared/` (shared). No `/workspace/repos/` directory.
- **Startup script mechanism**: `docker-entrypoint.sh:229-314` executes `/workspace/start-up.*`. Runs after GitHub auth setup.
- **Lead base prompt mentions clone**: `src/prompts/base-prompt.ts` includes task templates with `git clone {repo_url}` as text instructions. No automation.
- **Runner writes identity files before spawn**: SOUL.md and IDENTITY.md are written to `/workspace/` before spawning Claude (`src/commands/runner.ts:1601-1618`). Same pattern can be used for repo CLAUDE.md.
- **Runner composes system prompt**: `buildSystemPrompt()` calls `getBasePrompt()` with soul/identity injection (`src/commands/runner.ts:1420-1431`). Repo context can be injected here.
- **Runner fetches profile at startup**: `GET /me` to get soul/identity content (`src/commands/runner.ts:1536-1548`).
- **`swarm_config` table exists** (from Gap 6, PR #60): Can be used for repo-scoped config.
- **No repo management table or API**: Zero infrastructure for tracking registered repos.

### Key Discoveries

- The runner's `buildPromptForTrigger()` (`src/commands/runner.ts:698-749`) builds the task prompt from the trigger but does NOT use `githubRepo` for any workspace setup or clone instructions.
- `createTaskExtended()` already accepts `githubRepo` in its options (`src/be/db.ts:1842`) — the `send-task` tool just doesn't pass it through.
- The `swarm_config` table already has a `repo` scope (`src/be/db.ts:329-345`), so repo-scoped config can reference repos by ID once they exist.
- The existing CRUD pattern (epics, config) uses: Row type → `rowToEntity()` → exported functions → REST endpoints in `http.ts` with path segment matching.
- The Docker entrypoint already has a curl pattern for fetching config from the API (`docker-entrypoint.sh:88-112`) that can be reused for fetching repos.

## Desired End State

1. A `swarm_repos` table stores registered repositories (URL, name, branch, clone path, auto-clone flag)
2. REST API at `/api/repos` supports full CRUD
3. Docker entrypoint auto-clones registered repos at container start
4. The `send-task` MCP tool exposes `githubRepo` so leads can associate tasks with repos
5. When a task has `githubRepo`, the runner ensures the repo is cloned/up-to-date, reads CLAUDE.md from the filesystem, and injects it into the system prompt scoped to the repo directory
6. UI has a "REPOS" tab for managing registered repositories

### Verification of End State

```bash
# API works
curl -H "Authorization: Bearer $API_KEY" http://localhost:${PORT:-3013}/api/repos

# Register a repo with custom clone path
curl -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://github.com/desplega-ai/agent-swarm","name":"agent-swarm","defaultBranch":"main","clonePath":"/workspace/repos/agent-swarm","autoClone":true}' \
  http://localhost:${PORT:-3013}/api/repos

# Type check passes
bun run tsc:check

# Lint passes
bun run lint:fix
```

## Quick Verification Reference

Common commands:
- `bun run tsc:check` — TypeScript type checking
- `bun run lint:fix` — Biome lint + format
- `bun test` — Run all tests
- `bun run start:http` — Start HTTP server

Key files to check:
- `src/be/db.ts` — Table + CRUD functions
- `src/types.ts` — Zod schemas
- `src/http.ts` — REST API endpoints
- `src/tools/send-task.ts` — githubRepo exposure
- `src/commands/runner.ts` — Repo context injection
- `docker-entrypoint.sh` — Auto-clone logic
- `ui/src/components/ReposPanel.tsx` — UI management

## What We're NOT Doing

- **CLAUDE.md caching in the API** — The API server has no access to worker volumes. Instead, each worker reads CLAUDE.md directly from the cloned repo filesystem at task time.
- **Non-GitHub first-class support** — `gh repo clone` is the primary clone method (already installed + authenticated in Docker). Non-GitHub URLs fall back to `git clone` (requires separate auth setup). The field is called `githubRepo` for a reason.
- **Per-agent repo access control** — All agents get access to all registered repos (no junction table).
- **Branch management** — Only `defaultBranch` is tracked. Workers can switch branches as needed.
- **Webhook-driven repo sync** — No automatic pull on push events. Workers pull on task start if the repo is clean.
- **Monorepo CLAUDE.md discovery** — Only root-level `CLAUDE.md` is read. Nested CLAUDE.md files in subdirectories are left to the agent to discover at runtime.
- **Sync endpoint** — No API endpoint to trigger repo sync. Workers handle clone/pull autonomously.

## Implementation Approach

Five phases, each independently verifiable:

1. **DB + Types + CRUD**: Schema (with `clonePath`), functions, Zod types — no CLAUDE.md cache fields
2. **REST API**: HTTP endpoints for CRUD (no sync endpoint)
3. **send-task Extension + Runner Repo Context**: Expose `githubRepo` in the MCP tool; runner ensures clone/pull, reads CLAUDE.md from filesystem, injects into system prompt with directory-scoping note
4. **Docker Entrypoint Auto-Clone**: Fetch repos from API, clone at container start
5. **UI**: Repos management tab in the dashboard

---

## Phase 1: Database Schema + CRUD Functions + Types

### Overview

Add the `swarm_repos` table to SQLite, define TypeScript types/Zod schemas, and implement all CRUD functions in `db.ts`.

### Changes Required:

#### 1. Zod Schema
**File**: `src/types.ts`
**Changes**: Add `SwarmRepoSchema` after the `SwarmConfigSchema` (~line 386):

```typescript
// ============================================================================
// Swarm Repos Types (Centralized Repository Management)
// ============================================================================

export const SwarmRepoSchema = z.object({
  id: z.string().uuid(),
  url: z.string().min(1),               // Git remote URL (HTTPS or SSH)
  name: z.string().min(1).max(100),      // Short name, used as clone dir name
  clonePath: z.string().min(1),          // Absolute path where repo is cloned (e.g., /workspace/repos/agent-swarm)
  defaultBranch: z.string().default("main"),
  autoClone: z.boolean().default(true),  // Clone on worker start
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});

export type SwarmRepo = z.infer<typeof SwarmRepoSchema>;
```

**Design note**: `clonePath` is configurable per repo. Defaults to `/workspace/repos/<name>` when not provided at creation time. No `claudeMdContent` or `lastSyncedAt` — the API server has no access to worker volumes, so CLAUDE.md is read from the filesystem by the runner at task time.

#### 2. Database Table
**File**: `src/be/db.ts`
**Changes**: Add `CREATE TABLE IF NOT EXISTS swarm_repos` inside the `initSchema` transaction (after `swarm_config` indexes, ~line 349):

```sql
CREATE TABLE IF NOT EXISTS swarm_repos (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  clonePath TEXT NOT NULL UNIQUE,
  defaultBranch TEXT NOT NULL DEFAULT ‘main’,
  autoClone INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL
)
```

Index:
```sql
CREATE INDEX IF NOT EXISTS idx_swarm_repos_name ON swarm_repos(name)
```

#### 3. Row Type + Converter
**File**: `src/be/db.ts`
**Changes**: Add after existing row types:

```typescript
type SwarmRepoRow = {
  id: string;
  url: string;
  name: string;
  clonePath: string;
  defaultBranch: string;
  autoClone: number; // SQLite boolean
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToSwarmRepo(row: SwarmRepoRow): SwarmRepo {
  return {
    id: row.id,
    url: row.url,
    name: row.name,
    clonePath: row.clonePath,
    defaultBranch: row.defaultBranch,
    autoClone: row.autoClone === 1,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}
```

#### 4. CRUD Functions
**File**: `src/be/db.ts`
**Changes**: Add exported functions:

- `getSwarmRepos(filters?: { autoClone?: boolean; name?: string }): SwarmRepo[]` — list all or filtered
- `getSwarmRepoById(id: string): SwarmRepo | null`
- `getSwarmRepoByName(name: string): SwarmRepo | null`
- `getSwarmRepoByUrl(url: string): SwarmRepo | null` — useful for dedup checking
- `createSwarmRepo(data: { url, name, clonePath?, defaultBranch?, autoClone? }): SwarmRepo` — if `clonePath` is omitted, default to `/workspace/repos/<name>`
- `updateSwarmRepo(id: string, updates: Partial<{ url, name, clonePath, defaultBranch, autoClone }>): SwarmRepo | null`
- `deleteSwarmRepo(id: string): boolean`

Follow the existing patterns: use `getDb().prepare<RowType, [params]>()`, `RETURNING *`, `crypto.randomUUID()` for IDs, ISO timestamps.

#### 5. Unit Tests
**File**: `src/tests/swarm-repos.test.ts` (new file)
**Changes**: Follow the pattern from `src/tests/epics.test.ts`:

- `beforeAll`: `initDb()` with isolated test DB (`./test-swarm-repos.sqlite`)
- `afterAll`: `closeDb()` + clean up DB files (`.sqlite`, `-wal`, `-shm`)
- Tests:
  - Create a repo, verify all fields (including default `clonePath`)
  - Create with custom `clonePath`, verify it's used
  - List repos, verify count
  - List with `autoClone` filter
  - Get by ID, by name, by URL
  - Update fields (name, clonePath, defaultBranch, autoClone)
  - Delete, verify gone
  - Uniqueness: duplicate URL → throws, duplicate name → throws, duplicate clonePath → throws

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Unit tests pass: `bun test src/tests/swarm-repos.test.ts`
- [x] Server starts without errors: `bun run start:http` (ctrl+c after startup)
- [x] Table exists: `sqlite3 agent-swarm-db.sqlite ".schema swarm_repos"`

#### Manual Verification:
- [x] Start server, confirm no migration errors in console output
- [x] Verify the unique constraints work (URL, name, and clonePath are all unique)

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding.

---

## Phase 2: REST API Endpoints

### Overview

Add CRUD endpoints under `/api/repos` in `http.ts`. No sync endpoint — workers handle clone/pull autonomously.

### Changes Required:

#### 1. Repos Endpoints
**File**: `src/http.ts`
**Changes**: Add route blocks after the config endpoints (before the 404 fallback). Import new DB functions at the top.

**Endpoints:**

| Method | Path | Query Params | Body | Response |
|--------|------|-------------|------|----------|
| GET | `/api/repos` | `autoClone`, `name` | — | `{ repos: SwarmRepo[] }` |
| GET | `/api/repos/:id` | — | — | `SwarmRepo` (unwrapped) |
| POST | `/api/repos` | — | `{ url, name, clonePath?, defaultBranch?, autoClone? }` | `SwarmRepo` (created, 201) |
| PUT | `/api/repos/:id` | — | `{ url?, name?, clonePath?, defaultBranch?, autoClone? }` | `SwarmRepo` (updated) |
| DELETE | `/api/repos/:id` | — | — | `{ success: true }` |

**Route matching patterns:**

```
GET /api/repos/:id       → pathSegments = ["api", "repos", id] && !pathSegments[3]
GET /api/repos           → pathSegments = ["api", "repos"] && !pathSegments[2]
POST /api/repos          → method === "POST" && pathSegments = ["api", "repos"] && !pathSegments[2]
PUT /api/repos/:id       → method === "PUT" && pathSegments = ["api", "repos", id] && !pathSegments[3]
DELETE /api/repos/:id    → method === "DELETE" && pathSegments = ["api", "repos", id] && !pathSegments[3]
```

**POST create validation:**
1. Require `url` and `name`
2. Check uniqueness of both `url` and `name`
3. If `clonePath` is omitted, default to `/workspace/repos/<name>`
4. `autoClone` defaults to true if not provided

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Create repo: `curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d '{"url":"https://github.com/desplega-ai/agent-swarm","name":"agent-swarm"}' http://localhost:3013/api/repos | jq .`
- [x] Create repo with custom path: `curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d '{"url":"https://github.com/desplega-ai/other","name":"other","clonePath":"/workspace/custom/other"}' http://localhost:3013/api/repos | jq .`
- [x] List repos: `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/repos | jq .`
- [x] Get by ID: `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/repos/<id> | jq .`
- [x] Update repo: `curl -s -X PUT -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d '{"defaultBranch":"develop"}' http://localhost:3013/api/repos/<id> | jq .`
- [x] Delete repo: `curl -s -X DELETE -H "Authorization: Bearer 123123" http://localhost:3013/api/repos/<id> | jq .`

#### Manual Verification:
- [x] Verify uniqueness: try creating two repos with same URL — expect 409
- [x] Verify uniqueness: try creating two repos with same name — expect 409
- [x] Verify list filtering: create repos with different autoClone values, filter with `?autoClone=true`
- [x] Verify name filtering: `?name=agent-swarm` returns only matching repo
- [x] Verify default clonePath: create repo without clonePath, check response has `/workspace/repos/<name>`

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding.

---

## Phase 3: send-task Extension + Runner Repo Context

### Overview

Two changes: (1) expose `githubRepo` in the `send-task` MCP tool so leads can associate tasks with repos, and (2) when the runner processes a task with `githubRepo`, ensure the repo is cloned and up-to-date, read its CLAUDE.md from the filesystem, and inject it into the system prompt with an explicit directory-scoping note.

### Changes Required:

#### 1. Expose githubRepo in send-task
**File**: `src/tools/send-task.ts`
**Changes**: Add `githubRepo` to the input schema (after `parentTaskId`, ~line 55):

```typescript
githubRepo: z
  .string()
  .optional()
  .describe(
    "GitHub repo identifier (e.g., 'desplega-ai/agent-swarm'). Links the task to a registered repo for workspace context."
  ),
```

Add `githubRepo` to the destructured args (~line 65):
```typescript
{ agentId, task, offerMode, taskType, tags, priority, dependsOn, epicId, parentTaskId, githubRepo },
```

Pass `githubRepo` through to all `createTaskExtended()` calls (~lines 131, 175, 194):
```typescript
githubRepo: effectiveGithubRepo,
```

**Auto-inherit from epic**: When `epicId` is provided and `githubRepo` is not, derive it from the epic's `githubRepo` field:
```typescript
// Auto-inherit githubRepo from epic if not explicitly provided
let effectiveGithubRepo = githubRepo;
if (epicId && !githubRepo) {
  const epic = getEpicById(epicId);
  if (epic?.githubRepo) {
    effectiveGithubRepo = epic.githubRepo;
  }
}
```

Use `effectiveGithubRepo` in all `createTaskExtended()` calls.

#### 2. Runner: Fetch Repo Config from API
**File**: `src/commands/runner.ts`
**Changes**: Add a helper to fetch the registered repo config (to get `clonePath`, `url`, etc.) from the API:

```typescript
/** Fetch repo config for a task's githubRepo (e.g., "desplega-ai/agent-swarm") */
async function fetchRepoConfig(
  apiUrl: string,
  apiKey: string,
  githubRepo: string,
): Promise<{ url: string; name: string; clonePath: string; defaultBranch: string } | null> {
  try {
    // Try by name first (cheap — exact match via query param)
    const repoName = githubRepo.split("/").pop() || githubRepo;
    const resp = await fetch(`${apiUrl}/api/repos?name=${encodeURIComponent(repoName)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { repos: Array<{ url: string; name: string; clonePath: string; defaultBranch: string }> };
    // If name filter returned results, pick the best match (URL match preferred)
    return data.repos.find((r) => r.url.includes(githubRepo))
      ?? data.repos[0]
      ?? null;
  } catch {
    return null;
  }
}
```

#### 3. Runner: Ensure Repo Cloned + Pull if Clean + Warn if Dirty
**File**: `src/commands/runner.ts`
**Changes**: Add a helper that handles the per-task repo setup. Uses `gh repo clone` for GitHub repos (already installed and authenticated in Docker), with `git clone` fallback for non-GitHub URLs.

```typescript
/** Check if a URL is a GitHub repo (URL or owner/repo shorthand) */
function isGitHubRepo(url: string): boolean {
  return url.includes("github.com") || /^[\w.-]+\/[\w.-]+$/.test(url);
}

/**
 * Ensure a repo is cloned and up-to-date for a task.
 * Returns: { clonePath, claudeMd, warning }
 * - warning is surfaced to the agent in the system prompt so it knows about issues.
 */
async function ensureRepoForTask(
  repoConfig: { url: string; name: string; clonePath: string; defaultBranch: string },
  role: string,
): Promise<{ clonePath: string; claudeMd: string | null; warning: string | null }> {
  const { url, name, clonePath, defaultBranch } = repoConfig;

  try {
    const gitHeadExists = await Bun.file(`${clonePath}/.git/HEAD`).exists();

    if (!gitHeadExists) {
      // 1. Not cloned yet — use gh for GitHub repos, git clone for others
      console.log(`[${role}] Cloning ${name} to ${clonePath}...`);
      if (isGitHubRepo(url)) {
        await Bun.$`gh repo clone ${url} ${clonePath} -- --branch ${defaultBranch} --single-branch`.quiet();
      } else {
        await Bun.$`git clone --branch ${defaultBranch} --single-branch ${url} ${clonePath}`.quiet();
      }
      console.log(`[${role}] Cloned ${name}`);
    } else {
      // 2. Already cloned — check if clean, then pull
      console.log(`[${role}] Repo ${name} already cloned at ${clonePath}`);
      const statusResult = await Bun.$`cd ${clonePath} && git status --porcelain`.quiet();
      const statusOutput = statusResult.text().trim();

      if (statusOutput === "") {
        // Clean — safe to pull
        console.log(`[${role}] Pulling ${name} (${defaultBranch})...`);
        await Bun.$`cd ${clonePath} && git pull origin ${defaultBranch} --ff-only`.quiet();
        console.log(`[${role}] Pulled ${name}`);
      } else {
        // 3. Dirty — warn the agent, do NOT pull
        console.warn(`[${role}] Repo ${name} has uncommitted changes, skipping pull`);
        const warning = `WARNING: The repo "${name}" at ${clonePath} has uncommitted changes. A git pull was skipped to avoid losing work. You may need to commit or stash changes before pulling updates.`;

        // Still read CLAUDE.md even if dirty
        let claudeMd: string | null = null;
        const claudeMdFile = Bun.file(`${clonePath}/CLAUDE.md`);
        if (await claudeMdFile.exists()) {
          claudeMd = await claudeMdFile.text();
        }
        return { clonePath, claudeMd, warning };
      }
    }

    // 4. Read CLAUDE.md from the repo root (if it exists)
    let claudeMd: string | null = null;
    const claudeMdFile = Bun.file(`${clonePath}/CLAUDE.md`);
    if (await claudeMdFile.exists()) {
      claudeMd = await claudeMdFile.text();
      console.log(`[${role}] Read CLAUDE.md from ${clonePath}/CLAUDE.md (${claudeMd.length} chars)`);
    } else {
      console.log(`[${role}] No CLAUDE.md found at ${clonePath}/CLAUDE.md`);
    }

    return { clonePath, claudeMd, warning: null };
  } catch (err) {
    // 5. Clone/pull FAILED — surface this to the agent so it knows
    const errorMsg = (err as Error).message;
    console.warn(`[${role}] Error setting up repo ${name}: ${errorMsg}`);
    const warning = `ERROR: Failed to clone/setup repo "${name}" at ${clonePath}: ${errorMsg}. The repo may not be available. You may need to clone it manually.`;
    return { clonePath, claudeMd: null, warning };
  }
}
```

**Key design**: On failure, the `warning` field is populated and surfaced to the agent in the system prompt (see step 4 below). The agent always knows if something went wrong — it's never silently swallowed.

In the task processing loop, when a trigger is a `task_assigned` type:

```typescript
const taskGithubRepo = trigger.task?.githubRepo;
let repoClaudeMd: string | null = null;
let repoWarning: string | null = null;
let repoClonePath: string | null = null;

if (taskGithubRepo && opts.apiUrl) {
  const repoConfig = await fetchRepoConfig(opts.apiUrl, opts.apiKey || "", taskGithubRepo);
  if (repoConfig) {
    const result = await ensureRepoForTask(repoConfig, role);
    repoClaudeMd = result.claudeMd;
    repoWarning = result.warning;
    repoClonePath = result.clonePath;
  } else {
    // Repo not registered in API — fall back to convention-based clone
    const repoName = taskGithubRepo.split("/").pop() || taskGithubRepo;
    const fallbackConfig = {
      url: taskGithubRepo,
      name: repoName,
      clonePath: `/workspace/repos/${repoName}`,
      defaultBranch: "main",
    };
    const result = await ensureRepoForTask(fallbackConfig, role);
    repoClaudeMd = result.claudeMd;
    repoWarning = result.warning;
    repoClonePath = result.clonePath;
  }
}
```

#### 4. Inject Repo CLAUDE.md into System Prompt (Directory-Scoped)
**File**: `src/prompts/base-prompt.ts`
**Changes**: Extend `BasePromptArgs` to accept repo context:

```typescript
export type BasePromptArgs = {
  // ... existing fields
  repoContext?: {
    claudeMd?: string | null;  // null if CLAUDE.md not found or clone failed
    clonePath: string;
    warning?: string | null;   // dirty repo warning or clone failure
  };
};
```

In `getBasePrompt()`, after the identity injection, add repo context:

```typescript
if (args.repoContext) {
  prompt += "\n\n## Repository Context\n\n";

  // Always surface warnings (dirty state, clone failures)
  if (args.repoContext.warning) {
    prompt += `⚠️ ${args.repoContext.warning}\n\n`;
  }

  // Inject CLAUDE.md with strict directory scoping
  if (args.repoContext.claudeMd) {
    prompt += `The following CLAUDE.md is from the repository cloned at \`${args.repoContext.clonePath}\`. `;
    prompt += `**IMPORTANT: These instructions apply ONLY when working within the \`${args.repoContext.clonePath}\` directory.** `;
    prompt += `Do NOT apply these rules to files outside that directory.\n\n`;
    prompt += args.repoContext.claudeMd + "\n";
  } else if (!args.repoContext.warning) {
    prompt += `Repository is cloned at \`${args.repoContext.clonePath}\` but has no CLAUDE.md file.\n`;
  }
}
```
```

**File**: `src/commands/runner.ts`
**Changes**: Pass repo context to `buildSystemPrompt()`:

Add `currentRepoContext` variable alongside `agentSoulMd`/`agentIdentityMd`. Set it per-task from the trigger processing above.

Update `buildSystemPrompt()` to pass `repoContext`:
```typescript
const buildSystemPrompt = () => {
  return getBasePrompt({
    role,
    agentId,
    swarmUrl,
    capabilities,
    name: agentProfileName,
    description: agentDescription,
    soulMd: agentSoulMd,
    identityMd: agentIdentityMd,
    repoContext: currentRepoContext,
  });
};
```

Where `currentRepoContext` is set per-task:
```typescript
let currentRepoContext: BasePromptArgs["repoContext"] | undefined;
// ... in trigger processing:
if (repoClonePath) {
  // Always set context if we have a clone path — even on failure,
  // the warning will tell the agent what went wrong
  currentRepoContext = {
    claudeMd: repoClaudeMd,
    clonePath: repoClonePath,
    warning: repoWarning,
  };
} else {
  currentRepoContext = undefined;
}
```

Note: `currentRepoContext` is set per-task from the trigger's `githubRepo` field, while `agentSoulMd`/`agentIdentityMd` are set once per runner lifecycle.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test`

#### Manual Verification:
- [x] Register a repo via API, then create a task with `githubRepo` matching that repo
- [x] Start a worker, assign the task, verify runner logs show: clone/pull, CLAUDE.md read, system prompt injection
- [x] Verify the system prompt injection works (prompt length grew from 5011→7016 chars with repo context)
- [ ] Verify dirty repo warning: manually modify a file in the cloned repo, assign a new task, verify the dirty warning appears in the prompt (skipped — would require modifying files inside container)
- [x] Verify the `send-task` MCP tool accepts `githubRepo` parameter (curl test via MCP session)
- [x] Verify auto-inherit: create an epic with `githubRepo`, create a task for that epic without `githubRepo`, confirm task gets the epic's `githubRepo`
- [ ] Verify fallback: create a task with a `githubRepo` that's NOT registered — runner should still clone using convention-based path (skipped — code path verified via code review)

**Implementation Note**: Phase verified via Docker E2E. Dirty repo warning and unregistered repo fallback skipped (code paths verified by review).

---

## Phase 4: Docker Entrypoint Auto-Clone

### Overview

Update the Docker entrypoint to fetch registered repos from the API and auto-clone them at container start. This ensures repos are available before any task is assigned.

### Changes Required:

#### 1. Docker Entrypoint Repo Clone
**File**: `docker-entrypoint.sh`
**Changes**: Add a repo clone step after the swarm config fetch (line 112) and after GitHub auth setup (line 170). Position: after GitHub auth is configured (so `git clone` can authenticate) and before the startup script (so repos are available to startup scripts).

```bash
# ---- Auto-clone registered repos ----
echo ""
echo "=== Repo Auto-Clone ==="
if [ -n "$AGENT_ID" ]; then
    echo "Fetching registered repos from API..."
    if curl -s -f -H "Authorization: Bearer ${API_KEY}" \
       -H "X-Agent-ID: ${AGENT_ID}" \
       "${MCP_URL}/api/repos?autoClone=true" \
       > /tmp/swarm_repos.json 2>/dev/null; then

        REPO_COUNT=$(jq '.repos | length' /tmp/swarm_repos.json 2>/dev/null || echo "0")
        if [ "$REPO_COUNT" -gt 0 ]; then
            echo "Found $REPO_COUNT repos to clone..."

            jq -c '.repos[]' /tmp/swarm_repos.json | while read -r repo; do
                REPO_URL=$(echo "$repo" | jq -r '.url')
                REPO_NAME=$(echo "$repo" | jq -r '.name')
                REPO_BRANCH=$(echo "$repo" | jq -r '.defaultBranch // "main"')
                REPO_DIR=$(echo "$repo" | jq -r '.clonePath')

                # Ensure parent directory exists
                mkdir -p "$(dirname "$REPO_DIR")"

                if [ -d "${REPO_DIR}/.git" ]; then
                    echo "  Pulling ${REPO_NAME} (${REPO_BRANCH}) at ${REPO_DIR}..."
                    cd "$REPO_DIR" && git pull origin "$REPO_BRANCH" --ff-only 2>/dev/null || echo "  Warning: Could not pull ${REPO_NAME}"
                    cd /workspace
                else
                    echo "  Cloning ${REPO_NAME} to ${REPO_DIR} (branch: ${REPO_BRANCH})..."
                    gh repo clone "$REPO_URL" "$REPO_DIR" -- --branch "$REPO_BRANCH" --single-branch 2>/dev/null || echo "  Warning: Could not clone ${REPO_NAME}"
                fi
            done
        else
            echo "No repos registered for auto-clone"
        fi
        rm -f /tmp/swarm_repos.json
    else
        echo "Warning: Could not fetch repos (API may not be ready)"
    fi
else
    echo "Skipping repo clone (no AGENT_ID)"
fi
echo "==============================="
```

**Placement**: After `echo "==============================="` for the GitHub auth section (~line 172), before the AI Tracker setup (~line 195). This ensures GitHub credentials are configured before clone attempts.

**Design decisions:**
- Uses `--single-branch` to minimize disk usage
- Uses `--ff-only` for pulls to avoid merge conflicts
- Each clone/pull failure is non-fatal (warning only)
- Creates `/workspace/repos/` directory structure

### Success Criteria:

#### Automated Verification:
- [x] Entrypoint syntax is valid: `bash -n docker-entrypoint.sh`
- [x] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [x] Register a repo via API, build Docker image, start container, verify repo is cloned at `/workspace/repos/<name>/`
- [x] Restart container, verify pull works (no re-clone) — confirmed "Already up to date."
- [x] Verify private repos can be cloned (uses GITHUB_TOKEN from .env.docker) — confirmed with desplega-ai/agent-swarm
- [x] Verify failure is non-fatal: registered invalid URL, container showed "Warning: Could not clone bad-repo", other repos cloned fine, worker started normally

**Implementation Note**: Phase fully verified via Docker E2E.

---

## Phase 5: UI Repo Management Page

### Overview

Add a "REPOS" tab to the dashboard with a table of registered repos and add/edit/delete capabilities.

### Changes Required:

#### 1. TypeScript Types
**File**: `ui/src/types/api.ts` (or wherever UI types live)
**Changes**: Add `SwarmRepo` interface matching the API response shape. Check if the UI has a central types file or imports from the backend.

#### 2. API Client Methods
**File**: `ui/src/lib/api.ts`
**Changes**: Add methods to `ApiClient`:

```typescript
async getRepos(filters?: { autoClone?: boolean }): Promise<{ repos: SwarmRepo[] }>
async getRepoById(id: string): Promise<SwarmRepo>
async createRepo(data: { url: string; name: string; clonePath?: string; defaultBranch?: string; autoClone?: boolean }): Promise<SwarmRepo>
async updateRepo(id: string, data: Partial<{ url: string; name: string; clonePath: string; defaultBranch: string; autoClone: boolean }>): Promise<SwarmRepo>
async deleteRepo(id: string): Promise<{ success: boolean }>
```

#### 3. React Query Hooks
**File**: `ui/src/hooks/queries.ts`
**Changes**: Add hooks:

```typescript
export function useRepos(filters?: { autoClone?: boolean })
export function useCreateRepo()   // useMutation
export function useUpdateRepo()   // useMutation
export function useDeleteRepo()   // useMutation
```

#### 4. Repos Panel Component
**File**: `ui/src/components/ReposPanel.tsx` (new file)
**Changes**: Create a panel with:

- **Table columns**: Name, URL, Clone Path, Default Branch, Auto-Clone (toggle), Actions (edit/delete)
- **Add button**: Opens a form/modal with URL, Name, Clone Path (optional, shows default), Default Branch, Auto-Clone checkbox
- **Edit**: Inline editing or modal for name/clonePath/branch/autoClone
- **Delete**: Confirmation before delete

Follow existing panel patterns:
- `Card variant="outlined"` wrapper
- Hex accent icon in header
- Beehive theme colors via local `colors` object
- MUI Joy components: `Table`, `Input`, `Button`, `IconButton`, `Switch`, `Modal`

#### 5. Dashboard Integration
**File**: `ui/src/components/Dashboard.tsx`
**Changes**:

1. Add `"repos"` to the `activeTab` type and URL param handling
2. Add `<Tab value="repos">REPOS</Tab>` in the TabList (after CONFIG tab)
3. Add `<TabPanel value="repos">` with the `ReposPanel` component
4. Import `ReposPanel` lazily

### Success Criteria:

#### Automated Verification:
- [x] UI type check passes: `cd ui && pnpm run tsc` (build includes tsc)
- [x] UI builds without errors: `cd ui && pnpm run build`
- [x] Backend lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Navigate to REPOS tab in the dashboard (visual browser test)
- [ ] Add a repo entry (with and without custom clonePath), verify it appears in the table (visual browser test)
- [ ] Toggle auto-clone, verify the change persists on refresh (visual browser test)
- [ ] Edit clone path, verify the change persists (visual browser test)
- [ ] Delete a repo entry, verify removal (visual browser test)
- [ ] Verify table handles empty state gracefully (visual browser test)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Manual E2E Verification

After all phases are complete, run through this end-to-end:

```bash
# 1. Start the server
bun run start:http

# 2. Register a repo
curl -s -X POST -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://github.com/desplega-ai/agent-swarm","name":"agent-swarm","defaultBranch":"main","autoClone":true}' \
  http://localhost:3013/api/repos | jq .

# 3. Create a task with githubRepo (via MCP session)
# Initialize MCP session first (see CLAUDE.md for MCP tool testing pattern)
# Then call send-task with githubRepo: "desplega-ai/agent-swarm"

# 4. Start worker, verify:
#    a) Runner logs show: clone, CLAUDE.md read, system prompt injection
#    b) System prompt contains "These instructions apply ONLY when working within" + clonePath
#    c) Repo is cloned at the configured clonePath
#    d) If repo is dirty, system prompt contains the dirty warning

# 5. Docker E2E (if available):
bun run docker:build:worker
# Start worker container, check:
#   a) Entrypoint logs show "Repo Auto-Clone" section
#   b) Repo exists at clonePath with .git/
#   c) Assign task with githubRepo, check system prompt includes directory-scoped repo context

# 6. UI verification:
#   a) Open dashboard, navigate to REPOS tab
#   b) Verify repo entry shows with correct data (including clonePath)
#   c) Test add/edit/delete operations
```

## Testing Strategy

- **Unit tests**: Add a test file `src/tests/swarm-repos.test.ts` for CRUD functions (following `src/tests/epics.test.ts` pattern with isolated SQLite DB)
- **API tests**: Curl commands in each phase's verification section serve as integration tests
- **Type safety**: `bun run tsc:check` catches schema mismatches
- **Lint**: `bun run lint:fix` ensures code style consistency
- **Docker E2E**: Build worker image, start container, verify auto-clone and repo context injection

## References

- Research: `thoughts/taras/research/2026-02-19-swarm-gaps-implementation.md` (Gap 4 section, lines 273-301)
- Architecture: `thoughts/taras/research/2026-02-19-agent-native-swarm-architecture.md`
- Env management plan (reference pattern): `thoughts/taras/plans/2026-02-20-env-management.md`
- Worker identity plan (reference pattern): `thoughts/taras/plans/2026-02-20-worker-identity.md`
- Session attach plan: `thoughts/taras/plans/2026-02-20-session-attach.md`
