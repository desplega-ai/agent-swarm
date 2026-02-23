---
date: 2026-02-23
researcher: Researcher (16990304-76e4-4017-b991-f3e37b34cf73)
topic: "Openclaw vs Agent-Swarm: Session, Task, and Heartbeat Lifecycle Comparison"
tags: [research, comparison, openclaw, agent-swarm, lifecycle, heartbeat, sessions, improvements]
status: complete
---

# Research: Openclaw vs Agent-Swarm Lifecycle Comparison

**Date**: 2026-02-23
**Researcher**: Researcher (Swarm Worker)
**Sources**: openclaw/openclaw repo (commit be422a9), desplega-ai/agent-swarm repo (main branch)

## Executive Summary

Openclaw and agent-swarm solve similar problems — orchestrating AI agent sessions, managing task lifecycles, and ensuring reliability — but take fundamentally different architectural approaches. Openclaw is a **single-gateway monolith** with file-based state, cross-process locking, and in-process promise-chain concurrency. Agent-swarm is a **distributed multi-agent system** with SQLite-backed state, an MCP server for tool dispatch, and a runner process managing Claude CLI subprocesses.

This research identifies **8 concrete improvements** agent-swarm could adopt from openclaw's patterns, prioritized by impact and feasibility.

---

## 1. Architecture Comparison

| Dimension | Openclaw | Agent-Swarm |
|---|---|---|
| **Process Model** | Single gateway process, in-process agents | Runner process spawning Claude CLI subprocesses |
| **State Storage** | JSON files with atomic temp+rename writes | SQLite with WAL mode |
| **Concurrency** | Promise-chain mutexes + file locks | SQLite transactions + atomic UPDATE...WHERE...RETURNING |
| **Session Identity** | Hierarchical keys (`agent:main:telegram:group:123`) | UUID-based (task-scoped, not session-scoped) |
| **Health Monitoring** | Multi-layer (heartbeat runner, wake system, channel health monitor) | Two-tier ping (runner loop + hook events) |
| **Error Recovery** | Exponential backoff, stale lock detection, PID liveness, watchdogs | Exit code detection, session-not-found retry, error tracker |
| **Graceful Shutdown** | Ordered teardown of 15+ subsystems | SIGTERM → pause tasks → close agent |
| **Task Scheduling** | Cron service with isolated agent runs + exponential backoff | Scheduler with setInterval polling (10s) |
| **Subagent Coordination** | Full registry with announce flow, cascading termination | Lead/worker model via task assignment |
| **Config Management** | File-watching with hot/warm/cold reload classification | Database-backed config with API |

---

## 2. Session Lifecycle Comparison

### Openclaw Sessions

Openclaw sessions are **conversation-scoped** with rich lifecycle management:

- **Hierarchical keys**: Sessions are identified by structured keys encoding the agent, channel, chat type, peer, thread, and subagent hierarchy
- **Freshness evaluation**: Sessions auto-expire via configurable policies (daily reset at 4 AM, or idle timeout after N minutes)
- **Token tracking**: Each session entry tracks `inputTokens`, `outputTokens`, `cacheRead`, `cacheWrite`, `contextTokens`
- **Transcript persistence**: JSONL files with atomic writes and archival on reset
- **Two-layer locking**: In-process promise queue per store path + cross-process file locks with PID-based stale detection
- **Watchdog timer**: 60s interval, force-releases locks held >5 minutes
- **Process cleanup**: Signal handlers (`exit`, `SIGINT`, `SIGTERM`, etc.) release all locks synchronously

### Agent-Swarm Sessions

Agent-swarm sessions are **task-scoped** with simpler lifecycle:

- **Task-bound**: Each Claude subprocess maps 1:1 to a task via `/tmp/agent-swarm-task-{pid}.json`
- **Active session tracking**: `active_sessions` table with `lastHeartbeatAt` for stale detection (30-minute cutoff)
- **Claude session ID**: Captured from subprocess stdout for `--resume` capability
- **No freshness policy**: Sessions live until the task completes or fails
- **No transcript management**: Claude Code manages its own conversation history
- **Stale cleanup**: On startup, deletes all active sessions for the agent (blunt approach)

### Key Differences

1. **Openclaw's session freshness is sophisticated** — daily resets and idle timeouts prevent stale conversation context from accumulating, which is important for long-running agents
2. **Openclaw's locking is more robust** — PID liveness checks, watchdog timers, and reentrant locks handle edge cases that agent-swarm doesn't face (since it uses SQLite transactions instead of file locks)
3. **Agent-swarm's task-scoped sessions are simpler** — but lack the concept of persistent agent "conversations" that survive across tasks

---

## 3. Heartbeat / Health Comparison

### Openclaw Heartbeats

Openclaw has a **sophisticated multi-layer heartbeat system** spanning 11+ files:

- **Wake system**: Coalescing, priority-based scheduler (250ms coalesce, 1s retry). Multiple wake requests are batched. Higher-priority reasons replace lower-priority pending wakes
- **10-stage execution pipeline**: Early exits -> preflight -> target resolution -> prompt construction -> visibility gate -> LLM call -> OK handling -> duplicate detection -> delivery -> error handling
- **Transcript pruning**: Captures transcript size before heartbeat LLM call, rolls back if response was "OK" (prevents transcript pollution)
- **Duplicate detection**: Compares against `lastHeartbeatText`; skips same text within 24 hours
- **Active hours gating**: Time-window restrictions on when heartbeats fire
- **Channel health monitor**: 5-minute interval checks with startup grace (60s), cooldown between restarts, rate limiting (3 restarts/hour)
- **Daemon health polling**: 120 attempts x 500ms with PID-based stale process detection and SIGTERM->SIGKILL escalation

### Agent-Swarm Health

Agent-swarm has a **two-tier ping system**:

- **Runner ping**: `POST /ping` on every main loop iteration (~2s). Updates agent status in DB. Binary idle/busy state
- **Hook ping**: Fires on every hook event (SessionStart, PreToolUse, PostToolUse, etc.) — provides intra-session liveness
- **Active session heartbeat**: `PUT /api/active-sessions/heartbeat/:taskId` endpoint exists but is **not called by the runner** — only exposed for external consumers
- **Stale detection**: `cleanupStaleSessions()` deletes sessions with heartbeat older than 30 minutes. On startup, deletes ALL sessions for the agent (not fine-grained)
- **No health monitor**: No periodic check that agents/services are actually functional beyond the ping

### Key Differences

1. **Openclaw proactively monitors health** with a dedicated heartbeat runner that prompts the AI, checks channels, and can restart stuck components. Agent-swarm's ping is passive — it just records "I'm alive"
2. **Openclaw prevents transcript pollution** by pruning no-op heartbeat exchanges. Agent-swarm has no equivalent
3. **Openclaw deduplicates heartbeat alerts** to prevent noise. Agent-swarm has no deduplication on notifications
4. **Openclaw's daemon health includes process-level recovery** (stale PID detection, SIGTERM->SIGKILL). Agent-swarm relies on PM2 for process management

---

## 4. Task / Cron Comparison

### Openclaw Cron

- **Three schedule types**: one-shot (`at`), interval (`every`), and cron expression (`cron`)
- **Error recovery**: Exponential backoff (30s -> 1min -> 5min -> 15min -> 60min). Auto-disables after 3 consecutive schedule errors
- **Job timeout**: Default 10 minutes, configurable per-job. Uses `Promise.race` with `AbortController`
- **Startup recovery**: Clears stale `runningAtMs` markers, runs missed past-due jobs while avoiding double-execution of interrupted ones
- **Isolated agent runs**: Full independent agent turn with model selection, thinking level, security wrapping
- **Concurrent execution**: Configurable `maxConcurrentRuns` (default 1) per timer tick
- **Force-reload**: Store is force-reloaded from disk before and after mutations to handle concurrent external edits

### Agent-Swarm Scheduler

- **Two schedule types**: cron expression or interval (no one-shot)
- **No error recovery**: If task creation fails, no backoff or retry
- **No job timeout**: Tasks run until Claude finishes or crashes; no configurable timeout
- **No startup recovery**: If the scheduler was down, missed schedules are simply skipped
- **Simple execution**: Creates tasks in the pool; no isolated execution mode
- **Single-threaded guard**: `isProcessing` flag prevents overlapping runs
- **Manual trigger**: `runScheduleNow()` creates task with extra tag without affecting regular schedule

### Key Differences

1. **Openclaw's error recovery is significantly more robust** — exponential backoff, auto-disable after consecutive failures, job-level timeouts
2. **Openclaw handles startup recovery** — runs missed past-due jobs after downtime. Agent-swarm silently drops them
3. **Openclaw isolates job execution** — dedicated agent turns for cron jobs vs agent-swarm just creating tasks in the pool

---

## 5. Error Recovery & Resilience Comparison

### Openclaw Patterns

| Pattern | Implementation |
|---|---|
| **Promise-chain mutex** | Module-level `Map<string, Promise<void>>` — no OS locks needed |
| **Exponential backoff** | Heartbeat wakes (1s), cron failures (30s->60min), subagent announce (1s->8s) |
| **Stale lock detection** | PID liveness checks, watchdog timer (60s, force-release at 5min) |
| **Tool loop detection** | 4 strategies: global circuit breaker (30 repeats), known poll no-progress (10/20), ping-pong (10/20), generic repeat (10) |
| **Command poll backoff** | Fixed schedule: 5s->10s->30s->60s, resets on new output |
| **Process signal cleanup** | Registers handlers on 5 signals, re-raises signal after cleanup |
| **Config hot-reload** | File watching with restart/hot/none classification, graceful deferral during active work |
| **State migration** | One-shot guards with rollback on failure |

### Agent-Swarm Patterns

| Pattern | Implementation |
|---|---|
| **SQLite transactions** | `getDb().transaction()` wrapping tool handlers |
| **Atomic claiming** | `UPDATE...WHERE status='unassigned' RETURNING *` |
| **Session-not-found retry** | Auto-retry without `--resume` flag |
| **Error tracking** | `SessionErrorTracker` accumulates API errors, result errors, stderr patterns |
| **Idempotent finish** | `POST /api/tasks/:id/finish` returns success if already finished |
| **Pause/resume on shutdown** | Tasks paused on SIGTERM, resumed on restart |
| **Task cancellation detection** | Hook checks `isTaskCancelled()` on every tool use |

### Key Differences

1. **Openclaw has tool loop detection** — 4 distinct strategies to detect agents stuck in repetitive patterns. Agent-swarm has no equivalent (relies on context compaction or max-turns limits)
2. **Openclaw has command poll backoff** — prevents agents from hammering polling endpoints. Agent-swarm's polling is fixed at 2s intervals
3. **Openclaw has stale lock detection with watchdogs** — agent-swarm's SQLite transactions don't need this, but it has no equivalent for detecting stuck subprocesses
4. **Openclaw's config hot-reload** with classification (restart vs hot vs none) is significantly more sophisticated than agent-swarm's static config

---

## 6. Subagent Coordination Comparison

### Openclaw

- **Central registry**: `SubagentRunRecord` with timestamps, lifecycle events, status tracking
- **Dual completion detection**: Lifecycle events (pub/sub) AND gateway RPC (`agent.wait`) — redundancy ensures no missed completions
- **Announce flow**: Multi-strategy delivery (steer/queue/direct) with exponential retry (1s->8s, max 3, 5min expiry)
- **Cascading termination**: Recursive subagent abort on parent stop
- **Process restart recovery**: Loads unfinished runs from disk, resumes pending work, retries unannounced completions
- **Output retrieval**: Reads child's latest assistant reply, retries if empty, defers if child has active descendants
- **Session hierarchy**: Explicit `spawnedBy`, `spawnDepth`, `forkedFromParent` fields

### Agent-Swarm

- **Task-based coordination**: Lead creates tasks for workers; workers report via `store-progress`
- **Follow-up mechanism**: On task completion, auto-creates a follow-up task for the lead with Slack context
- **No cascading termination**: Task cancellation is checked via polling (hook checks on each tool use), not pushed
- **No completion announce**: Lead discovers task completion via follow-up tasks or polling
- **Session continuity**: `parentTaskId` field enables session resumption across child tasks
- **Concurrent context**: Lead can query what workers are doing via `GET /api/concurrent-context`

### Key Differences

1. **Openclaw's announce flow is proactive** — subagent results are pushed to the requester with retry. Agent-swarm's follow-up tasks are created but may be delayed by the lead's polling cycle
2. **Openclaw cascades termination recursively** — stopping a parent stops all descendants immediately. Agent-swarm's cancellation relies on per-tool-use polling, which means the agent continues until its next tool call
3. **Openclaw recovers from restarts** — unfinished subagent runs are restored from disk. Agent-swarm pauses tasks but doesn't track subagent-level state

---

## 7. Concrete Improvement Recommendations

### Priority 1: High Impact, Medium Effort

#### 1.1 Tool Loop Detection

**Problem**: Agents can get stuck in repetitive tool call loops (e.g., repeatedly polling for results, retrying the same failing command). Currently, agent-swarm relies on Claude's built-in limits.

**Openclaw's approach**: 4 detector strategies with configurable thresholds, sliding-window history, warning -> critical escalation.

**Recommendation**: Implement a simplified version in the `PreToolUse` hook:
- Track the last N tool calls (name + args hash) per session
- Detect same-tool repeats (threshold: 10) and ping-pong patterns (threshold: 10)
- At warning threshold: inject a system message advising the agent to try a different approach
- At critical threshold: block the tool call with an explanation

**Files to modify**: `src/hooks/hook.ts` (PreToolUse handler), new `src/hooks/tool-loop-detection.ts`

**Estimated complexity**: ~200 lines of new code

---

#### 1.2 Active Session Heartbeat (Actually Use It)

**Problem**: The `heartbeatActiveSession()` function and `PUT /api/active-sessions/heartbeat/:taskId` endpoint exist but are never called. Active sessions only get a heartbeat at creation time, making `cleanupStaleSessions()` unreliable.

**Openclaw's approach**: Multiple layers of heartbeat with deduplication and active-hours gating.

**Recommendation**: Call the heartbeat endpoint from the `PostToolUse` hook (since it fires on every tool use):
- In `hook.ts` PostToolUse handler, call `PUT /api/active-sessions/heartbeat/:taskId` using the task file's taskId
- This gives fine-grained liveness data — if an agent hasn't used a tool in 30 minutes, its session is genuinely stale
- Also consider calling it from the runner's `checkCompletedProcesses()` loop for still-running processes

**Files to modify**: `src/hooks/hook.ts` (PostToolUse handler, ~10 lines)

**Estimated complexity**: ~10-20 lines

---

#### 1.3 Missed Schedule Recovery on Startup

**Problem**: If the scheduler was down (container restart, deploy), past-due scheduled tasks are silently dropped. They just wait for the next scheduled run.

**Openclaw's approach**: On startup, clears stale markers, identifies missed jobs, and runs them while avoiding double-execution.

**Recommendation**: Add a recovery step to `startScheduler()`:
- On startup, query `getDueScheduledTasks()` with `nextRunAt < now()`
- For each, execute the schedule immediately
- Mark them with a `"recovered"` tag so they're distinguishable from regular runs
- Update `nextRunAt` to the next scheduled time (not from the missed time)

**Files to modify**: `src/scheduler/scheduler.ts` (add recovery to `startScheduler()`, ~30 lines)

**Estimated complexity**: ~30-40 lines

---

### Priority 2: Medium Impact, Low-Medium Effort

#### 2.1 Exponential Backoff for Failed Scheduled Tasks

**Problem**: If a scheduled task fails repeatedly (e.g., a cron job creates a task that always fails), it keeps firing at the same interval with no backoff.

**Openclaw's approach**: Error backoff schedule (30s -> 1min -> 5min -> 15min -> 60min), auto-disable after 3 consecutive schedule errors.

**Recommendation**: Add error tracking to scheduled tasks:
- Add `consecutiveErrors INTEGER DEFAULT 0` and `lastErrorAt TEXT` columns to `scheduled_tasks`
- On task creation failure in `executeSchedule()`, increment counter and apply backoff to `nextRunAt`
- After 5 consecutive errors, auto-disable the schedule and log a warning
- Reset counter on successful execution
- Backoff schedule: 1min, 5min, 15min, 30min, 60min

**Files to modify**: `src/be/db.ts` (migration + helper), `src/scheduler/scheduler.ts` (error tracking)

**Estimated complexity**: ~50-60 lines

---

#### 2.2 Graceful Task Cancellation (Push vs Poll)

**Problem**: When a task is cancelled, the agent only discovers it at its next `PreToolUse` or `UserPromptSubmit` hook. If the agent is in a long-running operation (e.g., waiting for a subprocess), it won't notice for a while.

**Openclaw's approach**: Direct abort with cascading termination — kills child processes immediately.

**Recommendation**: Send SIGUSR1 to the Claude subprocess when a task is cancelled:
- In the runner's main loop (or via a separate check), periodically query for cancelled tasks
- Alternatively, add a webhook/SSE from the API that pushes cancellation events
- On receiving cancellation, send SIGUSR1 (or SIGTERM) to the Claude subprocess
- The hook's existing cancellation detection would then fire on the process's next tool call

**Files to modify**: `src/commands/runner.ts` (cancellation check in main loop), `src/http.ts` (optional webhook)

**Estimated complexity**: ~40-60 lines

---

#### 2.3 Task Progress Deduplication

**Problem**: Agents sometimes call `store-progress` with the same or very similar progress messages repeatedly, creating noise in task logs.

**Openclaw's approach**: Heartbeat deduplication — `lastHeartbeatText` comparison, skip if same text within 24 hours.

**Recommendation**: Add progress deduplication in `store-progress`:
- Store `lastProgressText` and `lastProgressAt` on the task
- Skip duplicate progress updates (same text within 5 minutes)
- Always allow status changes (completed/failed) regardless of dedup

**Files to modify**: `src/tools/store-progress.ts` (~15 lines), `src/be/db.ts` (migration + helper)

**Estimated complexity**: ~25-30 lines

---

### Priority 3: Lower Priority but Valuable

#### 3.1 Subprocess Stuck Detection

**Problem**: If a Claude subprocess hangs (not exiting, not making progress), the runner has no way to detect this. The process could occupy a concurrency slot indefinitely.

**Openclaw's approach**: Command poll backoff (5s->60s) and tool loop detection at critical threshold triggers intervention.

**Recommendation**: Add a maximum task duration with soft/hard limits:
- Soft limit (configurable, default 30 minutes): Log a warning, inject a "please wrap up" message via the task file or a signal
- Hard limit (configurable, default 60 minutes): Send SIGTERM to the subprocess, mark task as failed with timeout reason
- Track `startedAt` in `RunningTask` and check in the main loop

**Files to modify**: `src/commands/runner.ts` (timeout check in main loop, ~30 lines)

**Estimated complexity**: ~30-40 lines

---

#### 3.2 Config Hot-Reload

**Problem**: Configuration changes (e.g., updating capabilities, changing scheduler intervals) require a full restart. There's no hot-reload mechanism.

**Openclaw's approach**: File-watching with chokidar, 300ms debounce, change classification (restart/hot/none), graceful deferral during active work.

**Recommendation**: Implement a lightweight config reload for the API server:
- Watch the `swarm_config` table for changes (via a periodic poll or DB trigger)
- Classify changes: scheduler interval -> restart scheduler; agent capabilities -> no action needed (dynamic); new integrations -> restart needed
- For the scheduler specifically, expose a `PUT /api/scheduler/reload` endpoint that stops and restarts it with new config

**Files to modify**: `src/http.ts` (new endpoint), `src/scheduler/scheduler.ts` (reload method)

**Estimated complexity**: ~50-80 lines

---

## 8. Summary Matrix

| Improvement | Impact | Effort | Priority | Files |
|---|---|---|---|---|
| Tool loop detection | High | Medium | P1 | hook.ts, new file |
| Active session heartbeat | High | Low | P1 | hook.ts |
| Missed schedule recovery | High | Low | P1 | scheduler.ts |
| Exponential backoff for schedules | Medium | Low | P2 | db.ts, scheduler.ts |
| Graceful task cancellation (push) | Medium | Medium | P2 | runner.ts, http.ts |
| Task progress deduplication | Low | Low | P2 | store-progress.ts, db.ts |
| Subprocess stuck detection | Medium | Low | P3 | runner.ts |
| Config hot-reload | Low | Medium | P3 | http.ts, scheduler.ts |

---

## 9. Patterns Worth Noting (Not Direct Improvements)

These openclaw patterns are interesting but either don't apply to agent-swarm's architecture or would require major refactoring:

1. **Promise-chain mutexes**: Agent-swarm uses SQLite transactions, which are more appropriate for its multi-process architecture. No change needed.

2. **File-based state with atomic writes**: Agent-swarm's SQLite approach is actually superior for concurrent access. Openclaw uses files because it's a single-gateway model.

3. **Session freshness evaluation**: Interesting concept (daily reset, idle timeout), but agent-swarm's task-scoped sessions naturally expire when tasks complete. Could be relevant if agent-swarm adds persistent "conversation" sessions in the future.

4. **Reply queue system** (steer/followup/collect modes): Very specific to openclaw's messaging architecture. Agent-swarm's task-based model doesn't need this complexity.

5. **`unref()`'d timers**: Node.js-specific pattern for clean shutdown. Agent-swarm uses Bun, which handles this differently.

6. **Diagnostic event bus with recursion guard**: Useful for complex in-process event systems. Agent-swarm's architecture is distributed, so events flow through the API instead.

---

## 10. Architectural Observations

### Where Agent-Swarm is Already Better

1. **Atomic operations**: SQLite transactions with `UPDATE...WHERE...RETURNING` are simpler and more reliable than file-based locking with PID checks
2. **State visibility**: All state is in a queryable database, making debugging and monitoring easier than openclaw's JSON files
3. **Task deduplication**: Jaccard word similarity for detecting duplicate tasks is a smart optimization
4. **Pause/resume semantics**: Graceful shutdown pauses tasks for later resumption — openclaw doesn't have this concept
5. **Memory/embedding system**: Automatic indexing of task completions into searchable vector memory is unique to agent-swarm

### Where Openclaw is Better

1. **Health monitoring**: Multi-layer heartbeat with proactive AI prompting, channel health monitoring, and daemon health polling
2. **Error recovery**: Exponential backoff, auto-disable, tool loop detection, command poll backoff
3. **Subagent coordination**: Central registry, dual completion detection, announce flow with retry, cascading termination
4. **Transcript management**: Pruning no-op exchanges, archiving old transcripts, size-based rotation
5. **Config lifecycle**: Hot-reload with change classification and graceful deferral

---

## Open Questions

1. Should agent-swarm adopt openclaw's concept of "persistent agent conversations" that survive across tasks? Currently, each task gets a fresh conversation (or resumes a previous one via `--resume`).

2. Is tool loop detection better implemented in the hook (which runs in a separate process) or as a Claude Code extension? The hook approach adds latency to every tool call.

3. Should the heartbeat system be extended to include actual health checks (not just "I'm alive" pings)? For example, checking if the Claude subprocess is making progress (new log output) rather than just running.

4. Openclaw's announce flow solves a real problem — how does a parent agent learn about a child's results? Agent-swarm's follow-up task mechanism works but adds latency. Is a webhook/SSE push mechanism worth the complexity?
