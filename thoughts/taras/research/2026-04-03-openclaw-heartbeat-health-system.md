---
date: 2026-04-03T12:00:00Z
topic: "OpenClaw Heartbeat & Health-Check System"
source: "https://github.com/openclaw/openclaw"
---

# OpenClaw Heartbeat & Health-Check System Research

**Source:** https://github.com/openclaw/openclaw
**Project:** Personal AI assistant (TypeScript gateway + macOS/iOS/Android clients)

---

## Executive Summary

OpenClaw has a sophisticated, multi-layered health and heartbeat system spanning five distinct subsystems:

1. **Heartbeat Runner** -- periodic agent turns in the main session (agent-level "are things OK?")
2. **Channel Health Monitor** -- background watchdog for messaging channel connections (WhatsApp, Slack, Discord, etc.)
3. **Presence System** -- lightweight ephemeral tracking of connected clients/nodes
4. **Gateway Boot / BOOT.md** -- one-shot startup triage after gateway restart
5. **Cron Restart Catch-up** -- detection and replay of missed scheduled jobs after downtime

These are independent systems that interact at well-defined boundaries. The heartbeat is the most interesting for our use case.

---

## 1. Heartbeat Mechanism (Agent-Level Periodic Turns)

### What It Does

The heartbeat runs **periodic agent turns** in the main session. It sends a prompt to the AI model asking it to check if anything needs attention, then processes the response. It is NOT a simple ping/pong -- it's a full LLM inference call.

### Key Files

- `src/infra/heartbeat-runner.ts` -- Main orchestrator
- `src/infra/heartbeat-wake.ts` -- Wake/scheduling system with coalescing
- `src/infra/heartbeat-summary.ts` -- Config resolution
- `src/infra/heartbeat-events.ts` -- Event emission for UI
- `src/infra/heartbeat-reason.ts` -- Reason classification
- `src/infra/heartbeat-active-hours.ts` -- Time-of-day gating
- `src/infra/heartbeat-visibility.ts` -- Per-channel visibility config
- `src/infra/heartbeat-events-filter.ts` -- Filters heartbeat noise from cron events
- `src/auto-reply/heartbeat.ts` -- HEARTBEAT_OK token processing

### Default Interval

- **30 minutes** (default), or **1 hour** when Anthropic OAuth/setup-token is detected
- Configurable via `agents.defaults.heartbeat.every` (duration string, default unit = minutes)
- `0m` disables heartbeat entirely
- Can be restricted to active hours via `heartbeat.activeHours` with timezone support

### What Gets Tracked / Stored

Per heartbeat event (`HeartbeatEventPayload`):
```typescript
type HeartbeatEventPayload = {
  ts: number;                    // timestamp
  status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed";
  to?: string;                   // recipient
  accountId?: string;            // multi-account channel id
  preview?: string;              // message preview
  durationMs?: number;           // how long the run took
  hasMedia?: boolean;
  reason?: string;               // why the heartbeat ran
  channel?: string;              // delivery channel
  silent?: boolean;              // was it suppressed?
  indicatorType?: "ok" | "alert" | "error";
};
```

Per-agent state tracked by the runner:
```typescript
type HeartbeatAgentState = {
  agentId: string;
  heartbeat?: HeartbeatConfig;
  intervalMs: number;
  lastRunMs?: number;    // last execution timestamp
  nextDueMs: number;     // next scheduled execution
};
```

### Response Contract -- HEARTBEAT_OK

The model is expected to reply `HEARTBEAT_OK` if nothing needs attention. This token is:
- Stripped when it appears at the start or end of the reply
- The reply is dropped entirely if remaining content is <= `ackMaxChars` (default: 300 chars)
- If `HEARTBEAT_OK` appears in the middle, it's NOT treated specially
- For alerts, the model returns text WITHOUT `HEARTBEAT_OK`
- An effectively empty `HEARTBEAT.md` (only blanks/headers) causes the heartbeat to be skipped entirely

### Heartbeat Prompt

Default prompt (sent verbatim as user message):
```
Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.
Do not infer or repeat old tasks from prior chats.
If nothing needs attention, reply HEARTBEAT_OK.
```

### Wake Reasons

Heartbeats can be triggered by multiple reasons, classified into kinds:

```typescript
type HeartbeatReasonKind =
  | "retry"         // previous attempt failed, retrying
  | "interval"      // regular scheduled tick
  | "manual"        // user-triggered via CLI
  | "exec-event"    // async command completed
  | "wake"          // system event or ACP spawn
  | "cron"          // cron job triggered it
  | "hook"          // lifecycle hook triggered it
  | "other";
```

### Wake Coalescing (Interesting Pattern)

The `heartbeat-wake.ts` implements a **priority-based coalescing queue**:

- Multiple wake requests within a 250ms window are coalesced
- Each wake has a priority: retry (0) < interval (1) < default (2) < action (3)
- Higher-priority reasons replace lower-priority ones for the same agent/session target
- Retry wakes use a 1-second delay and are "sticky" (normal wakes can't preempt retry timers)
- Wake targets are keyed by `agentId::sessionKey`
- If the main queue is busy ("requests-in-flight"), the heartbeat is skipped and retried

### Per-Agent Heartbeats

If any `agents.list[]` entry includes a `heartbeat` block, ONLY those agents run heartbeats. Otherwise, the default agent runs heartbeats. Each agent can have its own:
- Interval, model, prompt
- Delivery target and channel
- Active hours window
- `lightContext` (only inject HEARTBEAT.md) and `isolatedSession` (no conversation history)

### Visibility Controls (3-Layer Precedence)

Per-account > per-channel > channel-defaults > built-in defaults:

```typescript
type ResolvedHeartbeatVisibility = {
  showOk: boolean;       // false by default (suppress HEARTBEAT_OK)
  showAlerts: boolean;   // true by default (show alert content)
  useIndicator: boolean; // true by default (emit indicator events for UI)
};
```

If ALL THREE are false, the heartbeat run is skipped entirely (no model call).

---

## 2. Channel Health Monitor (Connection-Level Watchdog)

### What It Does

Background monitor that checks messaging channel connections (WhatsApp, Slack, Discord, etc.) and restarts them when they go unhealthy. This catches the "half-dead WebSocket" scenario where the connection appears alive but events stop flowing.

### Key Files

- `src/gateway/channel-health-monitor.ts` -- Background monitor loop
- `src/gateway/channel-health-policy.ts` -- Health evaluation logic

### Timing Constants

```typescript
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000;            // 5 minutes
const DEFAULT_MONITOR_STARTUP_GRACE_MS = 60_000;          // 1 min startup grace
const DEFAULT_CHANNEL_CONNECT_GRACE_MS = 120_000;         // 2 min per-channel connect grace
const DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS = 30 * 60_000; // 30 min stale socket threshold
const DEFAULT_COOLDOWN_CYCLES = 2;                        // 2 check cycles between restarts
const DEFAULT_MAX_RESTARTS_PER_HOUR = 10;                 // rolling cap
const BUSY_ACTIVITY_STALE_THRESHOLD_MS = 25 * 60_000;     // 25 min busy-state timeout
```

### Health Evaluation States

```typescript
type ChannelHealthEvaluationReason =
  | "healthy"                  // all good
  | "unmanaged"                // channel not configured/enabled -- skip
  | "not-running"              // channel stopped
  | "busy"                     // actively processing (healthy if recent)
  | "stuck"                    // busy but no activity for 25+ minutes
  | "startup-connect-grace"    // just started, give it time
  | "disconnected"             // explicitly disconnected
  | "stale-socket";            // connected but no events for 30+ minutes
```

### Smart Restart Logic

The monitor implements several guardrails:
1. **Startup grace period** (60s) -- no checks right after gateway boot
2. **Per-channel connect grace** (120s) -- no checks right after a channel starts
3. **Cooldown between restarts** -- 2 check cycles (10 min) minimum between restarts of the same channel
4. **Rolling hourly cap** -- max 10 restarts per channel per hour
5. **Busy-state awareness** -- if a channel is actively processing, it's healthy (unless stuck for 25+ min)
6. **Stale lifecycle detection** -- if `lastRunActivityAt` is from a previous lifecycle, busy state is ignored
7. **Mode-aware** -- Telegram (long-polling) and webhook-mode channels skip the stale-socket check
8. **Per-channel opt-out** -- individual channels can disable health monitoring
9. **Manual stop detection** -- manually stopped channels are not auto-restarted

### Restart Reasons

```typescript
type ChannelRestartReason =
  | "gave-up"        // stopped after 10+ reconnect attempts
  | "stopped"        // stopped but hasn't exhausted attempts
  | "stale-socket"   // connected but silent for too long
  | "stuck"          // busy but no progress
  | "disconnected";  // explicitly disconnected
```

---

## 3. Presence System (Client/Node Tracking)

### What It Does

Lightweight, ephemeral in-memory tracking of the gateway itself and connected clients (macOS app, iOS/Android nodes, WebChat, CLI). Used for the macOS app "Instances" tab.

### Key Files

- `src/infra/system-presence.ts` -- Server-side presence store
- `apps/macos/Sources/OpenClaw/PresenceReporter.swift` -- macOS client presence beacon
- `apps/macos/Sources/OpenClaw/SystemPresenceInfo.swift` -- System info collection

### Data Model

```typescript
type SystemPresence = {
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
  deviceFamily?: string;       // "Mac", "Windows", "Linux"
  modelIdentifier?: string;    // e.g., "Mac14,6"
  lastInputSeconds?: number;   // seconds since last user input
  mode?: string;               // "ui", "webchat", "cli", "gateway", "node"
  reason?: string;             // "self", "connect", "periodic", "launch"
  deviceId?: string;
  roles?: string[];
  scopes?: string[];
  instanceId?: string;         // stable client identity
  text: string;                // human-readable summary
  ts: number;                  // last update (ms since epoch)
};
```

### Behavior

- **TTL:** 5 minutes -- entries older than this are pruned
- **Max entries:** 200 (oldest dropped first by timestamp)
- **Key resolution:** `deviceId > instanceId > host > ip > text prefix`
- **Gateway self-entry** seeded at startup so UIs always show the gateway host
- **CLI commands** are excluded from presence to avoid spamming the list
- **Loopback IPs** from tunnel connections are ignored to preserve real client IPs
- **macOS client** sends presence beacons every **180 seconds** (3 minutes) via `system-event` WS method

### Presence Sources

1. Gateway self-entry (on startup)
2. WebSocket `connect` handshake (except CLI mode)
3. `system-event` periodic beacons (from macOS app, iOS/Android nodes)
4. Node connects with `role: node`

---

## 4. Gateway Boot / BOOT.md (Startup Triage)

### What It Does

Runs a one-shot agent turn on gateway startup using a `BOOT.md` file from the workspace. This is the "restart triage" mechanism -- it lets the agent check for anything that needs attention after a restart.

### Key Files

- `src/gateway/boot.ts` -- Boot runner
- `docs/reference/templates/BOOT.md` -- Template reference

### How It Works

1. On gateway startup, looks for `BOOT.md` in the agent workspace
2. If found and non-empty, runs a full agent turn with the boot prompt
3. Creates an isolated session (`boot-YYYY-MM-DD_HH-MM-SS-<uuid8>`) to avoid polluting the main session
4. **Snapshots and restores the main session mapping** after the boot run, so the boot turn doesn't disrupt normal session state
5. If `BOOT.md` is missing or empty, boot is skipped (`status: "skipped"`)
6. Boot prompt instructs the agent to use the message tool for sending, then reply with `SILENT_REPLY_TOKEN`

### Boot Prompt Construction

```typescript
function buildBootPrompt(content: string) {
  return [
    "You are running a boot check. Follow BOOT.md instructions exactly.",
    "",
    "BOOT.md:",
    content,
    "",
    "If BOOT.md asks you to send a message, use the message tool.",
    "Use the `target` field (not `to`) for message tool destinations.",
    "After sending with the message tool, reply with ONLY: SILENT_REPLY_TOKEN.",
    "If nothing needs attention, reply with ONLY: SILENT_REPLY_TOKEN.",
  ].join("\\n");
}
```

### Session Mapping Snapshot/Restore

Critical detail: the boot run creates a snapshot of the main session mapping before running, then restores it afterward. This prevents the boot agent turn from becoming the "last message" in the main session, which would break delivery routing.

---

## 5. Cron Restart Catch-up (Missed Job Detection)

### What It Does

When the cron service starts (after a restart), it detects jobs that were due during downtime and runs them immediately, with staggering to prevent overload.

### Key Files

- `src/cron/service/timer.ts` -- Contains `runMissedJobs` and `planStartupCatchup`
- `src/cron/service.restart-catchup.test.ts` -- Tests

### Constants

```typescript
const DEFAULT_MISSED_JOB_STAGGER_MS = 5_000;           // 5s between missed jobs
const DEFAULT_MAX_MISSED_JOBS_PER_RESTART = 5;          // cap immediate runs
const MIN_REFIRE_GAP_MS = 2_000;                        // safety net vs spin-loops
```

### How It Works

1. On `CronService.start()`, calls `runMissedJobs()`
2. `planStartupCatchup()` scans all jobs for overdue ones (`nextRunAtMs < now`)
3. Sorts missed jobs by `nextRunAtMs` (oldest first)
4. Takes up to `maxMissedJobsPerRestart` (default: 5) for immediate execution
5. Defers remaining missed jobs to their next regular schedule
6. Logs the stagger decision with counts
7. `executeStartupCatchupPlan()` runs the immediate candidates
8. `applyStartupCatchupOutcomes()` persists results

---

## 6. Stale Process Detection (Port/PID Cleanup)

### What It Does

Before restarting the gateway, cleans up stale gateway processes that may still hold the port, preventing EADDRINUSE errors.

### Key Files

- `src/infra/restart-stale-pids.ts` -- Synchronous stale PID cleanup
- `src/cli/daemon-cli/restart-health.ts` -- Restart health checking with port diagnostics

### How It Works (`restart-stale-pids.ts`)

1. Uses `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc` to find processes listening on the gateway port
2. Filters to only OpenClaw gateway processes (excludes current PID, deduplicates IPv4/IPv6)
3. Sends SIGTERM, waits 600ms
4. Sends SIGKILL to survivors, waits 400ms
5. Polls port with `lsof` every 50ms (up to 2s budget) until confirmed free
6. Each poll has a short 400ms timeout to prevent a single hung lsof from consuming the budget

### Restart Health (`restart-health.ts`)

Higher-level restart health checking:
1. Inspects gateway service runtime status
2. Checks port usage and identifies stale listeners
3. Probes gateway reachability via WebSocket (`ws://127.0.0.1:<port>`)
4. Classifies port listeners as "gateway" vs "unknown"
5. Handles auth-close (code 1008) as "reachable" to avoid false negatives
6. Waits up to 60s (120 attempts x 500ms) for healthy restart

---

## 7. Standing Orders (Not a System -- Agent Instructions)

Standing orders are NOT a runtime mechanism. They are **markdown instructions** placed in `AGENTS.md` or a similar workspace file that define what the agent should do autonomously. They are loaded into the agent's context every session via workspace bootstrap files.

Key pattern: Standing orders define WHAT (scope, approval gates, escalation rules), while cron jobs define WHEN. The heartbeat serves as the periodic "check-in" that can trigger standing order execution.

Example structure:
```
Standing Order: "You own the daily inbox triage"
    |
Cron Job (8 AM daily): "Execute inbox triage per standing orders"
    |
Agent: Reads standing orders -> executes steps -> reports results
```

---

## Interesting Patterns for Our Use Case

### 1. Heartbeat as Agent-Level Autonomy Loop

OpenClaw's heartbeat is fundamentally different from a traditional healthcheck. It's not "is the process alive?" -- it's "does the AI have anything to say?" The HEARTBEAT_OK/alert response contract is elegant:
- Silent by default (suppress OK acknowledgments)
- Only surface real alerts to the user
- Per-channel visibility controls

### 2. Wake Coalescing with Priority

The `heartbeat-wake.ts` pattern of priority-based coalescing is worth studying:
- Multiple triggers within 250ms are batched
- Higher-priority reasons (manual, exec-event) replace lower-priority ones (interval, retry)
- Retry wakes have sticky timers that can't be preempted
- The queue is keyed by agent+session target

### 3. Session Snapshot/Restore for Boot

The boot runner's pattern of snapshotting the main session, running the boot turn in an isolated session, then restoring the main session mapping is a clean way to do startup triage without side effects.

### 4. Channel Health: Stale Socket Detection

The "stale-socket" pattern is valuable: a connected channel that hasn't received events in 30+ minutes is treated as unhealthy. This catches the common "half-dead WebSocket" scenario. The multi-layer grace periods (startup, connect, busy) prevent false positives.

### 5. Cron Restart Catch-up with Stagger

The bounded catch-up after restart (max 5 immediate, rest deferred) with 5s stagger prevents thundering herd on restart. Jobs are sorted oldest-first so the most overdue ones run first.

### 6. Stale PID Cleanup Before Restart

The synchronous port-polling pattern after killing stale processes is thorough: it waits for the kernel to fully release the port (not just the process to die) to prevent EADDRINUSE races with the new process.
