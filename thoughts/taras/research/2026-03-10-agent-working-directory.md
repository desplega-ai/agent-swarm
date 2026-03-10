---
date: 2026-03-10T12:00:00-05:00
researcher: claude
git_commit: 5447af8
branch: main
repository: agent-swarm
topic: "Agent working directory (cwd) for tasks — starting agents from repo directories"
tags: [research, codebase, worker, cwd, vcsRepo, github, gitlab, runner, provider]
status: complete
autonomy: autopilot
last_updated: 2026-03-10
last_updated_by: claude
---

# Research: Agent Working Directory (cwd) for Tasks

**Date**: 2026-03-10
**Researcher**: Claude
**Git Commit**: 5447af8
**Branch**: main

## Research Question

How can agents be made to start from a specific working directory (cwd), particularly for:
1. GitHub/GitLab webhook-triggered tasks where the repo should be the working directory
2. Tasks linked to repos via `vcsRepo`, which should start from the repo's `clonePath`
3. General agent startup where a directory can be specified

The solution must be fail-safe (if directory doesn't exist, fall back gracefully).

## Summary

The infrastructure for mapping repos to local directories already exists (`swarm_repos` table with `clonePath`), and the runner already clones/pulls repos when a task has `vcsRepo`. However, the **actual working directory** of the spawned agent process is never changed — it always inherits `process.cwd()` (which is `/workspace` in Docker). The repo context is only injected into the system prompt, not the process `cwd`.

The `ProviderSessionConfig` already has a `cwd: string` field, but it's hardcoded to `process.cwd()`. The Claude adapter ignores it entirely (doesn't pass it to `Bun.spawn()`), while the pi-mono adapter correctly uses it. The fix requires two changes: (1) resolve the effective `cwd` from the task's `vcsRepo` or a new explicit field, and (2) pass it through to all provider adapters.

## Detailed Findings

### 1. Current State: How Working Directory is Determined

The effective working directory flows through four layers:

1. **Container**: `Dockerfile.worker:147` sets `WORKDIR /workspace`
2. **Entrypoint**: `docker-entrypoint.sh:449` runs `exec /usr/local/bin/agent-swarm worker` from `/workspace`
3. **Runner**: `src/commands/runner.ts:1128` sets `cwd: process.cwd()` in `ProviderSessionConfig`
4. **Claude adapter**: `src/providers/claude-adapter.ts:63` calls `Bun.spawn(cmd, { env, stdout, stderr })` — **no `cwd` option**, so child inherits parent's cwd (`/workspace`)

Result: All Claude sessions start in `/workspace` regardless of the task's repo context.

### 2. The `ProviderSessionConfig.cwd` Field

Defined at `src/providers/types.ts:39`:
```typescript
export interface ProviderSessionConfig {
  // ...
  cwd: string;
  // ...
}
```

Set in exactly two places, both to `process.cwd()`:
- `src/commands/runner.ts:1128` (in `spawnProviderProcess()`)
- `src/commands/runner.ts:1286` (in `runProviderIteration()`, legacy AI-loop mode)

**Consumed differently by each adapter:**
- **Claude adapter** (`src/providers/claude-adapter.ts`): **Ignores `config.cwd`** — `Bun.spawn()` at line 63 only passes `env`, `stdout`, `stderr`
- **Pi-mono adapter** (`src/providers/pi-mono-adapter.ts`): **Uses `config.cwd`** — passes it to `createAgentSession()` at line 410, creates AGENTS.md symlink at line 372

### 3. The `swarm_repos` Registry — Repo-to-Directory Mapping

A full CRUD entity mapping remote repos to local filesystem paths:

**Schema** (`src/be/migrations/001_initial.sql:260-269`):
```sql
CREATE TABLE IF NOT EXISTS swarm_repos (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    clonePath TEXT NOT NULL UNIQUE,
    defaultBranch TEXT NOT NULL DEFAULT 'main',
    autoClone INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL
);
```

**Default `clonePath`** (`src/be/db.ts:5090`): `/workspace/repos/{name}`

**CRUD API**: `src/http/repos.ts` — `GET/POST/PUT/DELETE /api/repos`

### 4. How `vcsRepo` Flows from Task to Repo Clone

When the runner picks up a task with `vcsRepo` (`src/commands/runner.ts:2004-2018`):

1. **Fetch from registry**: `fetchRepoConfig()` (line 34) calls `GET /api/repos?name={repoName}` and matches by URL
2. **Convention fallback**: If not registered, constructs config with `clonePath: /workspace/repos/{name}`
3. **Clone/pull**: `ensureRepoForTask()` (line 70) clones if `.git/HEAD` missing, pulls if clean, warns if dirty
4. **System prompt injection only**: Sets `currentRepoContext` with `clonePath` and `claudeMd`, injected into prompt at `src/prompts/base-prompt.ts:392-438`

**The `clonePath` is never used as the process working directory.** It only appears in the system prompt text.

### 5. Task VCS Fields

Defined at `src/types.ts:105-112`:
```typescript
vcsProvider: z.enum(["github", "gitlab"]).optional(),
vcsRepo: z.string().optional(),        // e.g., "desplega-ai/agent-swarm"
vcsEventType: z.string().optional(),
vcsNumber: z.number().int().optional(),
vcsCommentId: z.number().int().optional(),
vcsAuthor: z.string().optional(),
vcsUrl: z.string().optional(),
```

Set by all GitHub handlers (`src/github/handlers.ts`) and GitLab handlers (`src/gitlab/handlers.ts`).

### 6. GitHub Webhook Flow (Repo Info Available)

The webhook payload provides `repository.full_name` (e.g., `"desplega-ai/agent-swarm"`) which becomes `vcsRepo` on the task. The payload also includes `repository.clone_url`, `repository.ssh_url`, etc., but these are **not typed** in `src/github/types.ts` and not extracted.

### 7. Services `cwd` — Existing Pattern for Process Working Directory

The services system already has an optional `cwd` field for PM2 processes:
- SQL: `src/be/migrations/001_initial.sql:157` — `cwd TEXT`
- Zod: `src/types.ts:277` — `cwd: z.string().optional()`
- Tool: `src/tools/register-service.ts:25` — `cwd: z.string().optional().describe("Working directory for the script.")`
- PM2: `src/http/ecosystem.ts:28` — `if (s.cwd) app.cwd = s.cwd;`

### 8. The `send-task` Tool — Current Input Schema

`src/tools/send-task.ts:16-286` accepts: `agentId`, `task`, `offerMode`, `taskType`, `tags`, `priority`, `dependsOn`, `epicId`, `parentTaskId`, `vcsRepo`, `model`, `allowDuplicate`.

Notably: `vcsRepo` is already accepted as an input parameter. When `epicId` is provided, `vcsRepo` is auto-inherited from the epic (lines 134-151).

**No `cwd` or `workDir` parameter exists on tasks today.**

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/providers/types.ts` | 39 | `ProviderSessionConfig.cwd` field definition |
| `src/commands/runner.ts` | 1128 | `cwd: process.cwd()` in `spawnProviderProcess()` |
| `src/commands/runner.ts` | 1286 | `cwd: process.cwd()` in `runProviderIteration()` |
| `src/commands/runner.ts` | 2004-2018 | `vcsRepo` resolution and repo cloning |
| `src/commands/runner.ts` | 33-52 | `fetchRepoConfig()` — API lookup for repo config |
| `src/commands/runner.ts` | 66-115 | `ensureRepoForTask()` — clone/pull logic |
| `src/providers/claude-adapter.ts` | 63-70 | `Bun.spawn()` — no `cwd` option passed |
| `src/providers/pi-mono-adapter.ts` | 410 | `cwd: config.cwd` — correctly passed to session |
| `src/prompts/base-prompt.ts` | 392-438 | `repoContext` injected into system prompt only |
| `src/types.ts` | 105-112 | Task VCS fields (`vcsRepo`, etc.) |
| `src/types.ts` | 482-493 | `SwarmRepoSchema` with `clonePath` |
| `src/be/db.ts` | 5090 | Default `clonePath` convention: `/workspace/repos/{name}` |
| `src/be/db.ts` | 1736-1824 | `createTaskExtended()` — main task creation |
| `src/github/handlers.ts` | 108-114 | VCS metadata set on GitHub tasks |
| `src/tools/send-task.ts` | 16-286 | `send-task` tool — accepts `vcsRepo` |
| `src/be/migrations/001_initial.sql` | 260-269 | `swarm_repos` table schema |
| `src/be/migrations/001_initial.sql` | 157 | Services `cwd` column — existing pattern |
| `Dockerfile.worker` | 147 | `WORKDIR /workspace` |

## Architecture Documentation

### Existing Infrastructure That Supports This Feature

1. **`swarm_repos` registry**: Full CRUD with `clonePath` field — already maps remote repos to local directories
2. **`vcsRepo` on tasks**: Already populated by GitHub/GitLab webhooks and accepted by `send-task`
3. **`ProviderSessionConfig.cwd`**: Already exists as a field, already consumed by pi-mono adapter
4. **`ensureRepoForTask()`**: Already clones/pulls repos and returns `clonePath`
5. **`currentRepoContext`**: Already resolved in the runner before spawning the provider process

### The Gap

The runner resolves `vcsRepo` → `clonePath` → clones repo → reads CLAUDE.md → injects into prompt. But then it sets `cwd: process.cwd()` ignoring the `clonePath` it just resolved. The Claude adapter further ignores `config.cwd` when spawning the process.

### Key Decision Points for Implementation

**Where to resolve effective cwd** — `src/commands/runner.ts`, in `spawnProviderProcess()` (line ~1100) and `runProviderIteration()` (line ~1260), after `ensureRepoForTask()` has run and `currentRepoContext` is set.

**How to resolve it (priority order):**
1. If `currentRepoContext?.clonePath` exists and the directory is valid → use it
2. Else → fall back to `process.cwd()` (current behavior)

**Where to pass it through:**
- Claude adapter: Add `cwd: this.config.cwd` to `Bun.spawn()` options at `src/providers/claude-adapter.ts:63`
- Pi-mono adapter: Already works

**Fail-safe check:** Verify the directory exists before using it (e.g., `fs.existsSync(path)` or `Bun.file(path + '/.git/HEAD').exists()`). If the clone failed or the directory was removed, fall back silently.

**Task-level documentation:** The task description built by the runner should include a comment about the working directory when it's set to a repo path, so the agent knows where it's operating from and why.

## Historical Context (from thoughts/)

- `thoughts/taras/research/2026-01-28-per-worker-claude-md.md` — Related research on per-worker CLAUDE.md, which touches on how agent configuration is loaded based on directory context.
- `thoughts/taras/research/2026-02-19-agent-native-swarm-architecture.md` — Broader architecture research that includes how agents interact with repos.

## Related Research

- `thoughts/taras/research/2026-01-28-per-worker-claude-md.md` — Per-worker CLAUDE.md loading
- `thoughts/taras/research/2026-02-19-swarm-gaps-implementation.md` — Swarm gaps including repo integration

## Open Questions

- Should there be an explicit `cwd` field on tasks (for non-VCS use cases), or is resolving from `vcsRepo` sufficient?
- For local (non-Docker) workers, should the `clonePath` in `swarm_repos` use absolute paths or paths relative to a configurable base directory?
- When a task has `vcsRepo` but the repo clone fails (network error, auth issue), should the task fail or proceed from the default directory?
- Should the `send-task` tool accept an explicit `cwd` parameter alongside `vcsRepo` for cases where the caller knows the exact directory?

## Review Errata

_Reviewed: 2026-03-10 by Claude_

### Critical

_(none)_

### Important

- [ ] **Missing: `--resume` session interaction with cwd changes.** The Claude adapter supports `--resume` for session continuity (stale session retry at `claude-adapter.ts:265-318`). The research doesn't investigate what happens when cwd changes between tasks on the same worker. If task A runs in `/workspace/repos/repo-a` and task B runs in `/workspace/repos/repo-b`, does the resumed session context break? This is relevant because the runner reuses provider processes in parallel mode.
- [ ] **Missing: Impact on `/workspace/personal` and `/workspace/shared` references.** The base prompt (`src/prompts/base-prompt.ts`) references `/workspace/personal` and `/workspace/shared/thoughts/` as agent filesystem locations. If the process cwd changes to a repo's `clonePath` (e.g., `/workspace/repos/agent-swarm`), these absolute paths still work — but the research should explicitly confirm this won't break relative path usage or any other assumptions in the base prompt that depend on cwd being `/workspace`.
- [ ] **Vague on "task comment" requirement.** The user specifically asked that "in the task there should be a comment on this." The research mentions this briefly under "Key Decision Points" → "Task-level documentation" but doesn't specify _where_ in the task flow this comment would be added (in the task description at creation time? appended to the prompt by the runner? logged as a task event?). This should be explored more concretely.

### Resolved

- [x] Historical Context and Related Research sections overlap (`per-worker-claude-md.md` appears in both) — minor duplication, not blocking
