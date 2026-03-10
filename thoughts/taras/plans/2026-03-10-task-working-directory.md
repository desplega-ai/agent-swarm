---
date: 2026-03-10
planner: claude
topic: "Add working directory (dir) support to agent tasks"
status: draft
autonomy: autopilot
research: thoughts/taras/research/2026-03-10-agent-working-directory.md
last_updated: 2026-03-10
last_updated_by: claude
---

# Task Working Directory (`dir`) Implementation Plan

## Overview

Add an optional `dir` field (full filesystem path) to tasks so agents start from a specific working directory. This enables proper CLAUDE.md/AGENTS.md loading from repos, supports GitHub/GitLab webhook flows where the repo is the natural starting point, and works as a general-purpose mechanism for any task that should run from a specific directory.

## Current State Analysis

- Tasks have `vcsRepo` (e.g., `"desplega-ai/agent-swarm"`) but no explicit directory field
- The runner clones repos to `clonePath` via `ensureRepoForTask()` and injects the path into the **system prompt only** — never into the process working directory
- `ProviderSessionConfig` already has a `cwd: string` field, hardcoded to `process.cwd()` at `runner.ts:1128` and `runner.ts:1286`
- Claude adapter ignores `config.cwd` — `Bun.spawn()` at `claude-adapter.ts:63` passes no `cwd` option
- Pi-mono adapter already uses `config.cwd` correctly at `pi-mono-adapter.ts:410`
- All `/workspace/*` paths in the base prompt are absolute (23 references) — changing cwd is safe
- Each task gets its own `Bun.spawn()` process — no cwd bleed between parallel tasks
- `--resume` is per-task with isolated session IDs — no conflict with per-task cwd

### Key Discoveries:
- `spawnProviderProcess()` opts has no `cwd` param (`runner.ts:1091-1109`)
- `currentRepoContext.clonePath` is available in scope when `spawnProviderProcess()` is called (`runner.ts:2015`) but not forwarded
- `trigger.task` is typed as `unknown` — fields accessed via inline `as` type assertions (`runner.ts:2005`)
- Next migration number: **007** (latest is `006_vcs_provider.sql`)
- `createTaskExtended()` has 35 columns in its INSERT (`db.ts:1749-1795`)

## Desired End State

When a task has a `dir` field set to a valid directory path, the agent process starts from that directory. This means:

1. `claude` CLI runs with `cwd` set to the task's `dir` → automatic CLAUDE.md loading from repo
2. `pi-mono` sessions use the same `cwd` → automatic AGENTS.md loading
3. The prompt includes a note about the working directory so the agent knows where it is and why
4. If `dir` is set but the path doesn't exist, the agent falls back to `process.cwd()` silently (with a warning in the system prompt)

**Resolution priority for effective cwd:**
1. Task's `dir` field (explicit, highest priority)
2. `currentRepoContext.clonePath` (resolved from `vcsRepo` → `swarm_repos` registry)
3. `process.cwd()` (default fallback, current behavior)

### How to verify:
- Create a task via API with `dir: "/tmp/test-dir"` → agent starts in `/tmp/test-dir`
- Create a task with `vcsRepo` pointing to a registered repo → agent starts in repo's `clonePath`
- Create a task with no `dir` and no `vcsRepo` → agent starts in `process.cwd()` (unchanged behavior)
- Create a task with `dir` pointing to nonexistent path → agent starts in `process.cwd()` with warning

## Quick Verification Reference

Common commands to verify the implementation:
- `bun run tsc:check` — TypeScript type check
- `bun run lint:fix` — Biome lint + format
- `bun test` — Unit tests

Key files to check:
- `src/types.ts` — `AgentTaskSchema` with new `dir` field
- `src/be/db.ts` — `AgentTaskRow`, `rowToAgentTask()`, `CreateTaskOptions`, `createTaskExtended()`
- `src/be/migrations/007_task_dir.sql` — New migration
- `src/commands/runner.ts` — cwd resolution logic in `spawnProviderProcess()`
- `src/providers/claude-adapter.ts` — `cwd` in `Bun.spawn()` options
- `src/tools/send-task.ts` — `dir` in input schema

## What We're NOT Doing

- NOT adding auto-cloning logic based on `dir` — that's `vcsRepo`/`ensureRepoForTask()`'s job
- NOT removing the system prompt repo context injection — that stays as complementary context
- NOT changing the Docker container's WORKDIR or entrypoint
- NOT making `dir` required — it's fully optional with graceful fallback
- NOT adding `dir` to the GitHub/GitLab webhook handlers directly — those tasks get `dir` resolved from `vcsRepo` → `clonePath` at runtime in the runner
- NOT adding UI for the `dir` field in this phase

## Implementation Approach

Three phases: (1) schema + storage, (2) runner + adapters wiring, (3) prompt annotation. Each is independently testable.

---

## Phase 1: Add `dir` Field to Task Schema and Storage

### Overview
Add the `dir` column to the database and thread it through all layers: migration, types, DB functions, API, and MCP tools.

### Changes Required:

#### 1. Database Migration
**File**: `src/be/migrations/007_task_dir.sql`
**Changes**: New migration file adding the `dir` column.

```sql
-- Add optional working directory field to tasks
ALTER TABLE agent_tasks ADD COLUMN dir TEXT;
```

#### 2. Zod Schema
**File**: `src/types.ts`
**Changes**: Add `dir` field to `AgentTaskSchema` after `claudeSessionId` (around line 128).

```typescript
dir: z.string().optional(), // Working directory (full path) for the agent process
```

#### 3. Database Row Type
**File**: `src/be/db.ts`
**Changes**:
- Add `dir: string | null` to `AgentTaskRow` type (around line 689)
- Add `dir: row.dir ?? undefined` to `rowToAgentTask()` (around line 735)
- Add `dir?: string` to `CreateTaskOptions` interface (around line 1695)
- Add `dir` column + placeholder + value binding to `createTaskExtended()` INSERT (lines 1749-1795)

#### 4. MCP `send-task` Tool
**File**: `src/tools/send-task.ts`
**Changes**:
- Add `dir` to input schema: `dir: z.string().optional().describe("Working directory (full path) for the agent to start in. If the directory doesn't exist, falls back to the default working directory.")`
- Destructure `dir` from input (around line 87)
- Pass `dir` to all three `createTaskExtended()` call sites (lines 188, 234, 255)

#### 5. HTTP POST Handler
**File**: `src/http/tasks.ts`
**Changes**: Add `dir: body.dir || undefined` to the `createTaskExtended()` call (around line 79).

### Success Criteria:

#### Automated Verification:
- [ ] Migration applies cleanly on fresh DB: `rm -f agent-swarm-db.sqlite && bun run start:http` (then Ctrl+C)
- [ ] Migration applies cleanly on existing DB: `bun run start:http` (then Ctrl+C)
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Tests pass: `bun test`

#### Manual Verification:
- [ ] Create a task via curl with `dir` field: `curl -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" http://localhost:3013/api/tasks -d '{"task":"test","dir":"/tmp/test"}'` — verify `dir` appears in response
- [ ] Get task details: `curl -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks/<id>` — verify `dir` is persisted
- [ ] Create a task without `dir` — verify it returns `dir: undefined` (no regression)

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding.

---

## Phase 2: Wire cwd Through Runner and Claude Adapter

### Overview
Make the runner resolve the effective working directory from the task's `dir` field (or `clonePath` from `vcsRepo`), pass it through to `spawnProviderProcess()`, and have the Claude adapter use it in `Bun.spawn()`.

### Changes Required:

#### 1. Claude Adapter — Pass `cwd` to `Bun.spawn()`
**File**: `src/providers/claude-adapter.ts`
**Changes**: Add `cwd: this.config.cwd` to the `Bun.spawn()` options at line 63.

```typescript
this.proc = Bun.spawn(cmd, {
  cwd: this.config.cwd,  // <-- NEW: use task-specific working directory
  env: {
    ...(config.env || process.env),
    TASK_FILE: taskFilePath,
  } as Record<string, string>,
  stdout: "pipe",
  stderr: "pipe",
});
```

#### 1b. Pi-Mono Adapter — Verify existing cwd passthrough
**File**: `src/providers/pi-mono-adapter.ts`
**Changes**: No code changes needed — pi-mono already passes `config.cwd` at line 410. However, since `config.cwd` was always `process.cwd()` before, this is the first time it will receive task-specific directories. **Verify** that `createAgentSession()` handles non-default cwd paths correctly (e.g., the AGENTS.md symlink at line 372 uses `config.cwd`).

#### 2. Runner — Add `cwd` to `spawnProviderProcess()` opts
**File**: `src/commands/runner.ts`
**Changes**:
- Add `cwd?: string` to `spawnProviderProcess()` opts type (around line 1091)
- Change `cwd: process.cwd()` to `cwd: opts.cwd || process.cwd()` at line 1128

#### 3. Runner — Resolve effective cwd from task
**File**: `src/commands/runner.ts`
**Changes**: In the trigger handling block (around line 2004-2047), after `ensureRepoForTask()` and before `spawnProviderProcess()`, resolve the effective cwd:

```typescript
import { existsSync, statSync } from "node:fs";

// Resolve effective working directory (priority: task.dir > repoContext.clonePath > process.cwd())
const taskDir = (trigger.task as { dir?: string } | undefined)?.dir;
let effectiveCwd: string | undefined;

if (taskDir) {
  // Explicit dir on task — validate it exists and is a directory
  try {
    if (existsSync(taskDir) && statSync(taskDir).isDirectory()) {
      effectiveCwd = taskDir;
    } else {
      console.warn(`[runner] Task dir "${taskDir}" does not exist or is not a directory, falling back to default cwd`);
    }
  } catch {
    console.warn(`[runner] Failed to check task dir "${taskDir}", falling back to default cwd`);
  }
}

if (!effectiveCwd && currentRepoContext?.clonePath) {
  // Resolved from vcsRepo — already validated by ensureRepoForTask()
  effectiveCwd = currentRepoContext.clonePath;
}
```

> **Note**: Bun natively supports `node:fs` — `existsSync`/`statSync` are the idiomatic way to check directory existence. We also verify `isDirectory()` to prevent passing a file path as cwd.

Then pass `effectiveCwd` to `spawnProviderProcess()`:
```typescript
const runningTask = await spawnProviderProcess(
  adapter,
  {
    // ... existing opts ...
    cwd: effectiveCwd,  // <-- NEW
  },
  logDir,
  isYolo,
);
```

#### 4. Runner — Same for `runProviderIteration()` (legacy AI-loop)
**File**: `src/commands/runner.ts`
**Changes**: Apply the same pattern in `runProviderIteration()` — accept optional `cwd` in opts and use `opts.cwd || process.cwd()` at line 1286. The legacy path is used less but should be consistent.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Tests pass: `bun test`
- [ ] Claude adapter test covers `cwd` in spawn: check `src/tests/claude-adapter.test.ts`

#### Manual Verification:
- [ ] Start API + worker locally. Create a task with `dir: "/tmp"`. Check worker logs to see the claude CLI was started from `/tmp`.
- [ ] Create a task with `dir: "/nonexistent/path"`. Verify worker log shows fallback warning and agent starts from default cwd.
- [ ] Create a task with `vcsRepo` pointing to a registered repo (no explicit `dir`). Verify agent starts from the repo's `clonePath`.
- [ ] Create a task with neither `dir` nor `vcsRepo`. Verify agent starts from `process.cwd()` (unchanged behavior).

**Implementation Note**: After completing this phase, pause for manual confirmation. This is the critical phase — verify all four scenarios work.

---

## Phase 3: Prompt Annotation — Tell the Agent About Its Working Directory

### Overview
When the agent starts from a non-default directory, annotate the task prompt so the agent knows where it is and why. This addresses the user's requirement that "in the task there should be a comment on this."

### Changes Required:

#### 1. Runner — Annotate prompt with cwd info
**File**: `src/commands/runner.ts`
**Changes**: In the trigger handling block, after resolving `effectiveCwd` and before calling `spawnProviderProcess()`, append a working directory note to the trigger prompt:

```typescript
// Annotate prompt with working directory context
if (effectiveCwd && effectiveCwd !== process.cwd()) {
  triggerPrompt += `\n\n---\n**Working Directory**: You are starting in \`${effectiveCwd}\`. `;
  if (taskDir) {
    triggerPrompt += `This was explicitly set on the task.`;
  } else if (currentRepoContext?.clonePath) {
    triggerPrompt += `This is the repository clone path for this task's VCS repo.`;
  }
  triggerPrompt += ` You can still access any path on the filesystem — this is just your starting directory.`;
}
```

This goes into the **prompt** (not the system prompt), so it appears as the task instruction the agent sees. It's clear, non-intrusive, and explains both the what and the why.

#### 2. System Prompt — Add fallback warning when dir doesn't exist
**File**: `src/commands/runner.ts`
**Changes**: When the task's `dir` was specified but doesn't exist (the fallback case from Phase 2), include this in the system prompt warning:

```typescript
if (taskDir && !effectiveCwd) {
  // Dir was specified but doesn't exist — note it in system prompt
  const cwdWarning = `Note: The task requested working directory "${taskDir}" but it does not exist. Falling back to default directory.`;
  // Append to taskSystemPrompt or pass through buildSystemPrompt
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Tests pass: `bun test`

#### Manual Verification:
- [ ] Create a task with `dir: "/tmp"`. Check agent's input prompt includes the working directory note.
- [ ] Create a task with `vcsRepo` (no explicit `dir`). Check agent's input prompt includes the repo clone path note.
- [ ] Create a task with no `dir` and no `vcsRepo`. Verify no working directory note appears (no regression).
- [ ] Create a task with `dir: "/nonexistent"`. Check system prompt includes the fallback warning.

**Implementation Note**: After completing this phase, pause for final verification.

---

## Testing Strategy

### Unit Tests
- **Migration test**: Add to existing migration test suite — verify `dir` column exists after migration
- **`createTaskExtended()` test**: Create task with `dir`, verify it's stored and retrieved
- **`rowToAgentTask()` test**: Verify `dir` mapping from DB row to domain type
- **Claude adapter test**: Verify `cwd` is passed to `Bun.spawn()` options

### Integration Tests
- **E2E with Docker worker**: Create task with `dir` via API, verify worker starts Claude in that directory
- **Fallback test**: Create task with nonexistent `dir`, verify fallback + warning

### Manual E2E Verification

```bash
# Start API server
bun run start:http &

# 1. Test explicit dir
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  http://localhost:3013/api/tasks \
  -d '{"task":"Say hi","agentId":"<worker-uuid>","dir":"/tmp"}'

# 2. Test vcsRepo resolution (register a repo first)
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  http://localhost:3013/api/repos \
  -d '{"url":"https://github.com/desplega-ai/agent-swarm","name":"agent-swarm","clonePath":"/workspace/repos/agent-swarm"}'

curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  http://localhost:3013/api/tasks \
  -d '{"task":"Say hi","agentId":"<worker-uuid>","vcsRepo":"desplega-ai/agent-swarm"}'

# 3. Test fallback (nonexistent dir)
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  http://localhost:3013/api/tasks \
  -d '{"task":"Say hi","agentId":"<worker-uuid>","dir":"/nonexistent/path"}'

# 4. Test no dir, no vcsRepo (regression check)
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  http://localhost:3013/api/tasks \
  -d '{"task":"Say hi","agentId":"<worker-uuid>"}'

# Check worker logs for each case
docker logs <worker-container>
```

## References

- Research: `thoughts/taras/research/2026-03-10-agent-working-directory.md`
- Related: `thoughts/taras/research/2026-01-28-per-worker-claude-md.md` — per-worker CLAUDE.md loading

## Review Errata

_Reviewed: 2026-03-10 by Claude (file-review + structured review)_

### Critical

- [ ] **Pi-mono `cleanupAgentsMdSymlink` can delete real AGENTS.md files.** At `pi-mono-adapter.ts:125-136`, `cleanupAgentsMdSymlink()` calls `unlinkSync(agentsMd)` without checking if the file is actually a symlink. The creation guard (`createAgentsMdSymlink`, line 114) prevents overwriting an existing `AGENTS.md`, but the cleanup has no such guard. If cwd is set to a repo directory that has its own `AGENTS.md`, and the creation was skipped, the cleanup could still attempt to delete the real file. **This is a pre-existing bug that becomes dangerous when cwd points to repo directories.** Add a `lstatSync` check before deleting, or skip cleanup when `createAgentsMdSymlink` returned `false`. This should be addressed in Phase 2.

### Important

- [ ] **Phase 2 code snippet uses mixed Bun/Node APIs for dir validation.** The example code uses both `Bun.file().exists()` AND `require("node:fs").existsSync()`. Per project convention (CLAUDE.md: "Use Bun APIs, not Node.js equivalents"), use `Bun.file()` or `fs.statSync` from Bun — not `require("node:fs")`. Simplify to something like: `const dirExists = await Bun.file(taskDir).exists()` or use `import { existsSync } from "node:fs"` (Bun supports it natively).
- [ ] **No existing tests for `spawnProviderProcess()` or `runProviderIteration()`.** The plan should note that Phase 2 has no existing test coverage to build on. At minimum, add a unit test that constructs a `ProviderSessionConfig` with a custom `cwd` and verifies the Claude adapter passes it to `Bun.spawn()`.
- [ ] **Stale session retry automatically preserves cwd — confirm in plan.** The retry at `claude-adapter.ts:287-292` uses `...this.config` spread, which carries `cwd` forward. Once `Bun.spawn()` gets `cwd: this.config.cwd`, retries will automatically use the correct cwd. No extra work needed, but worth noting explicitly in Phase 2 as a "free" benefit.

### Resolved (from file-review)

- [x] **Pi-mono adapter not mentioned in Phase 2** — Added section 1b covering pi-mono verification and the `createAgentsMdSymlink` interaction
- [x] `triggerPrompt` is a `let` variable at `runner.ts:1924` with existing `+=` pattern — Phase 3 annotation fits naturally
- [x] `Bun.spawn()` accepts `cwd` option — confirmed by existing usage in `scripts/e2e-workflow-test.ts:186` and `src/tests/http-api-integration.test.ts:104`
