---
date: 2026-03-28T12:00:00-05:00
researcher: Claude
git_commit: 1ac7169bfd16074eb2d98efb4e62fefeb5f0bd3b
branch: main
repository: agent-swarm
topic: "Heartbeat Redesign: From Code-Level Triage to Lead-Managed HEARTBEAT.md Checklist"
tags: [research, heartbeat, lead, nudging, periodic-tasks, templates, cost-optimization]
status: complete
autonomy: critical
last_updated: 2026-03-28
last_updated_by: Claude
---

# Research: Heartbeat Redesign — HEARTBEAT.md Checklist Approach

**Date**: 2026-03-28
**Researcher**: Claude
**Git Commit**: 1ac7169
**Branch**: main

## Research Question

How can we adapt the current agent-swarm heartbeat system to work like an OpenClaw-style HEARTBEAT.md checklist — a periodic standing-orders file that the lead agent reads every N minutes, acts on if anything is actionable, and silently skips if nothing needs attention? What exists today, what needs to change, and how does the template system fit in?

## Summary

The current heartbeat is a **server-side code-level triage module** (`src/heartbeat/`) that runs every 90 seconds on the API server. It detects stalled tasks, auto-fails dead workers, auto-assigns pool tasks, and escalates ambiguous situations to the lead by creating tasks. It does NOT inject prompts into the lead's session or use any checklist file — it's pure code operating on DB state.

The OpenClaw-style HEARTBEAT.md approach is fundamentally different: a markdown checklist file that gets periodically injected as a prompt into the lead agent. If nothing is actionable, the lead replies "HEARTBEAT_OK" and the exchange is silently pruned. If something needs attention, the lead acts or alerts.

These two systems solve **different problems** and could coexist. The current heartbeat handles infrastructure concerns (worker health, task lifecycle) via code. The HEARTBEAT.md approach would handle higher-level standing orders (check Slack, review daily goals, scan for blocked epics) via LLM reasoning. The key design challenge is how to trigger the lead to read HEARTBEAT.md periodically, since the current architecture spawns new Claude sessions per trigger — there's no "inject prompt into idle lead" mechanism.

## Detailed Findings

### 1. Current Heartbeat System

#### Architecture

The heartbeat lives in `src/heartbeat/` and is a server-side `setInterval` loop (default 90s) with a 3-tier pipeline:

| Tier | Name | What It Does |
|------|------|-------------|
| 1 | Preflight Gate | Cheap DB check — bail if no actionable state (`heartbeat.ts:94-114`) |
| 2 | Code-Level Triage | Stall detection, worker health fixes, pool auto-assignment, stale cleanup (`heartbeat.ts:123-155`) |
| 3 | Escalation | Creates a `taskType: "heartbeat"` task for the lead if ambiguous stalls exist (`heartbeat.ts:316-403`) |

#### Stall Detection (3 severity levels)

| Condition | Threshold | Action |
|-----------|-----------|--------|
| No active session | 5 min | Auto-fail task, set agent idle |
| Session exists, stale heartbeat | 15 min | Auto-fail task, delete session |
| Session exists, fresh heartbeat | 30 min | Add to `stalledTasks` → escalate to lead |

#### Worker-Side Heartbeat Reporting

Workers keep sessions fresh via two signals:
- **Runner ping**: `POST /ping` every poll loop iteration (~2-5s) → updates `agents.lastUpdatedAt` (`runner.ts:137-153`)
- **PostToolUse hook**: `PUT /api/active-sessions/heartbeat/{taskId}` on every tool call → updates `active_sessions.lastHeartbeatAt` (`hook.ts:851-861`). **Workers only** — leads don't send session heartbeats.

#### Escalation to Lead

When Tier 3 triggers, it creates a task assigned to the lead with `taskType: "heartbeat"`, priority 70, using the `heartbeat.escalation.stalled` prompt template (`heartbeat/templates.ts:14-30`). Has cooldown (15 min) and dedup guards.

#### Key Files

- `src/heartbeat/heartbeat.ts` — Core sweep engine (all 3 tiers)
- `src/heartbeat/templates.ts` — Escalation prompt template
- `src/heartbeat/index.ts` — Barrel export
- `src/http/heartbeat.ts` — `POST /api/heartbeat/sweep` manual trigger
- `src/http/active-sessions.ts` — Session CRUD + heartbeat endpoints
- `src/hooks/hook.ts:851-861` — Worker-side PostToolUse heartbeat
- `src/be/db.ts:4978-5154` — All DB functions (session CRUD, stall queries)
- `src/be/migrations/001_initial.sql:289-299` — `active_sessions` table schema

#### Configuration (env vars, `heartbeat.ts:33-52`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `HEARTBEAT_INTERVAL_MS` | 90000 (90s) | Sweep interval |
| `HEARTBEAT_STALL_THRESHOLD_MIN` | 30 | Fresh-heartbeat stall (escalation) |
| `HEARTBEAT_STALL_NO_SESSION_MIN` | 5 | No-session stall (auto-fail) |
| `HEARTBEAT_STALL_STALE_HB_MIN` | 15 | Stale-heartbeat (auto-fail) |
| `HEARTBEAT_STALE_CLEANUP_MIN` | 30 | Stale resource cleanup |
| `HEARTBEAT_MAX_AUTO_ASSIGN` | 5 | Max pool tasks auto-assigned/sweep |
| `HEARTBEAT_ESCALATION_COOLDOWN_MS` | 900000 (15m) | Escalation cooldown |
| `HEARTBEAT_DISABLE` | unset | Set "true" to disable |

### 2. Lead Agent Prompting & Session Architecture

#### How the Lead Gets Work

The lead runs a `while(true)` polling loop (`runner.ts:2596`) that calls `GET /api/poll` every 2 seconds. When a trigger is found, a **new Claude CLI process** is spawned (`runner.ts:1372`). Each trigger = fresh session with full system prompt + trigger-specific user prompt. Default concurrency: 2 sessions.

There is **no mechanism to inject a prompt into an already-running session**. The lead's "idle" state is the polling loop waiting for triggers.

#### Trigger Sources (what "nudges" the lead today)

| Source | Mechanism | Priority in Poll |
|--------|-----------|-----------------|
| Offered tasks | `task_offered` trigger | 1st |
| Assigned/pending tasks (incl. follow-ups) | `task_assigned` trigger | 2nd |
| Unread @mentions | `unread_mentions` trigger | 3rd |
| Slack inbox messages | `inbox_messages` trigger | 4th |
| Epic progress changes | `epic_progress_changed` trigger | 5th |
| Slack channel activity | `channel_activity` trigger (lead-only, throttled 60s) | 6th |

External systems create tasks for the lead: `store-progress` follow-ups, heartbeat escalations, GitHub webhooks, Slack messages, scheduler cron, AgentMail.

#### System Prompt Composition

Built by `getBasePrompt()` (`base-prompt.ts:47`) using composite template `system.session.lead` (`session-templates.ts:567-584`), which chains: role → register → **lead instructions** → filesystem → self-awareness → context mode → guidelines → system. The lead template (`session-templates.ts:43-232`) is the largest block with delegation rules, Slack handling, task templates, follow-up handling, and session continuity instructions.

#### Hooks that Augment Sessions

- **SessionStart** (`hook.ts:686`): Injects concurrent session context (other active sessions, recent delegations, active tasks) to prevent duplication
- **PreCompact** (`hook.ts:763`): Injects goal reminder before context compaction
- **System tray** (`hook.ts:587-645`): Every hook invocation outputs inbox/task counts as informational stdout

### 3. Template System

#### Structure

Templates are directories under `templates/<category>/<name>/` containing:
- `config.json` — Metadata, `agentDefaults` (role, capabilities, maxTasks, isLead), file mappings
- Up to 5 content files: `CLAUDE.md`, `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `start-up.sh`

9 official templates: `lead`, `coder`, `researcher`, `reviewer`, `tester`, `forward-deployed-engineer`, `content-writer`, `content-reviewer`, `content-strategist`.

#### Template Application Flow

1. Worker boots with `TEMPLATE_ID` env var (e.g. `official/coder`)
2. `fetchTemplate()` fetches from registry with 24h disk cache (`runner.ts:1898-1953`)
3. `agentDefaults` applied (role, capabilities, maxTasks)
4. Template files interpolated with `{{agent.name}}`, `{{agent.role}}`, etc. (`runner.ts:2186-2206`)
5. Persisted via `PUT /api/agents/:id/profile` → written to `agents` table columns

#### Where HEARTBEAT.md Could Fit

The template schema (`templates/schema.ts`) currently has 5 file slots: `claudeMd`, `soulMd`, `identityMd`, `toolsMd`, `setupScript`. A `heartbeatMd` slot could be added. Alternatively, HEARTBEAT.md could be a separate concept stored differently (e.g. as a config key, or in the agent's workspace).

### 4. Schedule System (Existing Periodic Mechanism)

The scheduler (`src/scheduler/scheduler.ts`) runs its own `setInterval` (10s) independently of the heartbeat. Schedules can create tasks via cron expressions or intervals with:
- `targetAgentId` — can target the lead specifically
- Error backoff with auto-disable after 5 failures
- One-time or recurring

A schedule targeting the lead with a cron expression could serve as the "nudge" mechanism — creating a periodic task that says "Read your HEARTBEAT.md and act on it."

### 5. Historical Context

#### Code-Level Heartbeat Plan (`thoughts/shared/plans/2026-03-02-code-level-heartbeat.md`)

This is the plan that produced the current `src/heartbeat/` module. It was scoped specifically to infrastructure triage (stall detection, worker health, auto-assignment) and explicitly noted it was NOT replacing the scheduler. It was implemented and merged.

#### Drive Loop Research (`thoughts/taras/research/2026-03-08-drive-loop-concept.md`)

Identified that the current heartbeat operates at individual task level only — no epic-level stall detection, no goal evaluation. Proposed an "Epic Heartbeat" that scans active epics with no in-progress/pending tasks and creates lead tasks. Parts of this were implemented in PR #148 (v1.37.0): epic-aware follow-ups, nextSteps field, dedup of follow-up vs epic_progress_changed. The drive loop itself (heartbeat, goal evaluation) was NOT implemented.

#### Related: Scheduled Tasks Plans

- `thoughts/shared/research/2026-01-15-scheduled-tasks.md` — Original scheduled tasks research
- `thoughts/taras/plans/2026-03-06-one-time-scheduled-tasks.md` — One-time schedule support
- `thoughts/taras/plans/2026-03-21-schedule-wf-trigger-and-workspace.md` — Schedule-workflow integration

### 6. Gap Analysis: Current System vs. HEARTBEAT.md Approach

| Aspect | Current Heartbeat | HEARTBEAT.md (OpenClaw-style) |
|--------|-------------------|-------------------------------|
| **What it is** | Server-side code module (setInterval) | Markdown checklist file read by LLM |
| **Who runs it** | API server (no LLM involved for Tier 1-2) | Lead agent (LLM reads + reasons) |
| **What it checks** | DB state: stalled tasks, worker health, pool tasks | Arbitrary: "check email", "review blocked epics", "scan Slack" |
| **Cost per tick** | Near-zero (DB queries only, LLM only for Tier 3 escalation) | 1 LLM call per tick (unless checklist is empty) |
| **Customizable** | Env var thresholds only | Free-form markdown — any instructions |
| **When it skips** | Preflight gate (no actionable DB state) | Checklist is empty/effectively empty |
| **No-op handling** | Just logs and continues | LLM replies "HEARTBEAT_OK" → exchange pruned from context |
| **Storage** | `active_sessions` table, `agents` table | File on disk/DB (HEARTBEAT.md content) |

#### What HEARTBEAT.md Would Add

1. **Standing orders**: Instructions the lead checks periodically regardless of task triggers. E.g. "If no tasks in progress for 30 min, check Slack for requests" or "Review daily goal progress at 9am and 5pm."
2. **Proactive behavior**: The current system is reactive — the lead only wakes when tasks/triggers arrive. HEARTBEAT.md would let the lead proactively scan for work.
3. **User-configurable**: Non-technical users could edit HEARTBEAT.md to change the lead's behavior without touching code or env vars.

#### What the Current Heartbeat Does That HEARTBEAT.md Cannot Replace

1. **Stall detection & auto-remediation**: Cross-referencing `lastHeartbeatAt` vs task age requires DB access. An LLM reading a checklist can't do this.
2. **Worker health fixes**: Correcting busy/idle mismatches requires direct DB writes.
3. **Pool task auto-assignment**: Atomic `claimTask()` in a transaction.
4. **Stale resource cleanup**: Deleting stale sessions, releasing stuck reviews/mentions/inbox.

**These two systems should coexist.** The current heartbeat handles infrastructure. HEARTBEAT.md handles higher-level standing orders.

### 7. How the Nudge Could Work

Since there's no "inject prompt into idle lead" mechanism, the nudge must create a **task** that the lead's polling loop picks up. Three approaches:

#### Approach A: Schedule-Based Nudge (Simplest)

Use the existing scheduler to create a periodic task for the lead:
- Create a schedule with `targetAgentId = leadAgent.id` and a cron like `*/30 * * * *`
- Task description: "Read your HEARTBEAT.md checklist and act on any actionable items. If nothing needs attention, reply HEARTBEAT_OK."
- The lead receives this as a normal `task_assigned` trigger, spawns a session, reads HEARTBEAT.md from its profile/workspace, acts or replies OK
- On HEARTBEAT_OK: the task completes with no further action

**Pros**: No code changes needed — just a schedule entry. **Cons**: Creates a real task in the DB every tick (visible in task lists), always spawns a full Claude session (expensive even for no-ops).

#### Approach B: Heartbeat Module Extension (Moderate) ← SELECTED

Extend the existing `src/heartbeat/heartbeat.ts` sweep to add a "Tier 0" that checks the lead's HEARTBEAT.md:

1. Store HEARTBEAT.md content in a new DB column (e.g. `agents.heartbeatMd`) or as a config key
2. On each sweep, check if HEARTBEAT.md is effectively empty → skip LLM call
3. If non-empty, create a `taskType: "heartbeat-checklist"` task for the lead with the checklist injected as the prompt
4. Add dedup: if the lead already has an active heartbeat-checklist task, skip
5. Separate interval from the infrastructure heartbeat (e.g. `HEARTBEAT_CHECKLIST_INTERVAL_MS`, default 30 min)

**Pros**: Reuses existing infrastructure, cost-optimized (skips empty checklists), separate interval. **Cons**: Mixes two concerns in one module. Still creates a full Claude session per tick.

#### Approach C: Runner-Level Periodic Prompt (Most OpenClaw-Like)

Add a periodic prompt injection directly in the lead's runner polling loop:

1. The runner tracks a `lastChecklistRun` timestamp
2. When idle (no triggers from poll) and `lastChecklistRun` > N minutes ago:
   - Fetch HEARTBEAT.md content from API (or local cache)
   - If effectively empty → skip
   - If non-empty → spawn a lightweight Claude session with just the checklist prompt (no full task creation)
   - If response is "HEARTBEAT_OK" → don't create a task, don't log the exchange
   - If response has actionable content → create a task or post to Slack
3. The session is minimal: system prompt + HEARTBEAT.md + "Follow it strictly. Reply HEARTBEAT_OK if nothing."

**Pros**: Most faithful to OpenClaw design, no task pollution for no-ops, isolated lightweight session. **Cons**: Requires runner code changes, needs a way to detect HEARTBEAT_OK response and silently discard, runner currently doesn't fetch/cache HEARTBEAT.md.

### 8. HEARTBEAT.md Storage Options

| Option | Where | Pros | Cons |
|--------|-------|------|------|
| New `agents.heartbeatMd` column | DB | Consistent with other profile fields, per-agent | Migration needed, one more column |
| Config key `heartbeat_checklist` | `config` table (already exists) | No migration, uses existing config API | Not template-aware, scoped to global/agent |
| Template file slot | `templates/schema.ts` | Consistent with template system, ships with templates | Only applied at boot, manual edits need separate path |
| Agent workspace file | Filesystem in Docker | Most OpenClaw-like, agent can self-edit | Only accessible inside container, not via API |

**Recommendation**: New `agents.heartbeatMd` column (similar to `claudeMd`, `soulMd`, etc.) + a `heartbeatMd` file slot in templates. This gives template-driven defaults + per-agent API editability + the lead can update its own HEARTBEAT.md via `update-profile`.

### 9. Cost Optimization Patterns

From the OpenClaw design:

1. **Empty checklist skip**: `isHeartbeatContentEffectivelyEmpty()` — parse HEARTBEAT.md, if only blank lines/headers/empty list items → skip LLM call entirely. Zero cost for inactive checklists.

2. **Isolated session**: Don't send the full conversation history. Only send: system prompt + HEARTBEAT.md + the heartbeat instruction prompt. Keeps token usage to ~2-5K per tick.

3. **HEARTBEAT_OK pruning**: If the LLM responds with just "HEARTBEAT_OK", don't persist the exchange anywhere — no task, no log, no context pollution. Silently discard.

4. **Dedup suppression**: Track `lastHeartbeatText` and `lastHeartbeatSentAt`. If the LLM returns the exact same alert text within 24 hours, suppress the delivery. Prevents nagging.

5. **Separate interval**: HEARTBEAT.md checks should run on a much longer interval than infrastructure heartbeat (30 min vs 90s). Different env var.

### 10. Template Integration

#### Lead Template Addition

Add `heartbeatMd` to the lead template (`templates/official/lead/`):

```markdown
# Heartbeat Checklist

# Keep this file empty to skip heartbeat API calls.
# Add tasks below when you want the lead to check something periodically.

# Examples:
# - Check Slack for unaddressed requests
# - Review active epics for stalled progress
# - If idle workers exist and unassigned tasks available, investigate
```

Ships effectively empty (all comments) → no cost until opted in.

#### Schema Update

Add `heartbeatMd` to `TemplateConfig.files` in `templates/schema.ts`:

```typescript
files: {
  claudeMd: string | null;
  soulMd: string | null;
  identityMd: string | null;
  toolsMd: string | null;
  setupScript: string | null;
  heartbeatMd: string | null;  // NEW
}
```

And to `TemplateResponse`:
```typescript
heartbeatMd: string;  // NEW
```

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/heartbeat/heartbeat.ts` | 33-52 | Current heartbeat configuration constants |
| `src/heartbeat/heartbeat.ts` | 94-114 | Tier 1 preflight gate |
| `src/heartbeat/heartbeat.ts` | 123-155 | Tier 2 code-level triage |
| `src/heartbeat/heartbeat.ts` | 316-403 | Tier 3 escalation to lead |
| `src/heartbeat/heartbeat.ts` | 414-455 | `runHeartbeatSweep()` orchestration |
| `src/heartbeat/heartbeat.ts` | 497-511 | `startHeartbeat()` lifecycle |
| `src/heartbeat/templates.ts` | 14-30 | Escalation prompt template |
| `src/http/heartbeat.ts` | 8-43 | Manual sweep endpoint |
| `src/http/active-sessions.ts` | 76-85, 166-172 | Session heartbeat PUT endpoint |
| `src/hooks/hook.ts` | 851-861 | Worker PostToolUse heartbeat writer |
| `src/commands/runner.ts` | 2596 | Lead polling loop (`while(true)`) |
| `src/commands/runner.ts` | 1372 | Session spawning (`spawnProviderProcess`) |
| `src/commands/runner.ts` | 1898-1953 | Template fetching with cache |
| `src/commands/runner.ts` | 2186-2206 | Template interpolation and application |
| `src/http/poll.ts` | 62-290 | Poll endpoint with trigger priorities |
| `src/prompts/session-templates.ts` | 43-232 | Lead system prompt template |
| `src/prompts/session-templates.ts` | 567-584 | Lead composite template |
| `src/prompts/base-prompt.ts` | 47-173 | System prompt assembly |
| `src/scheduler/scheduler.ts` | 1-100 | Schedule execution loop |
| `src/be/migrations/001_initial.sql` | 289-299 | `active_sessions` table |
| `src/be/db.ts` | 4978-5154 | Session and stall DB functions |
| `src/be/db.ts` | 2251-2329 | `updateAgentProfile()` |
| `templates/schema.ts` | 1-35 | Template config and response types |
| `templates/official/lead/` | — | Lead template directory |
| `src/tools/store-progress.ts` | 305-361 | Follow-up task creation for lead |

## Architecture Documentation

### Current Flow: Heartbeat Sweep

```
API Server (setInterval, 90s)
  │
  ├─ Tier 1: preflightGate()
  │   → getTaskStats() + getAllAgents()
  │   → Skip if nothing actionable
  │
  ├─ Tier 2: codeLevelTriage()
  │   ├─ detectAndRemediateStalledTasks()
  │   │   → Cross-reference task age vs session heartbeat age
  │   │   → Auto-fail dead/crashed, flag ambiguous
  │   ├─ checkWorkerHealth()
  │   │   → Fix busy/idle mismatches
  │   ├─ autoAssignPoolTasks()
  │   │   → Atomic claimTask() for idle workers
  │   └─ cleanupStaleResources()
  │       → Sessions, reviews, mentions, inbox, workflows
  │
  └─ Tier 3: escalateToLead()
      → Create taskType:"heartbeat" task if ambiguous stalls
      → Cooldown + dedup guards
```

### Proposed Flow: HEARTBEAT.md Checklist (Approach C)

```
Heartbeat Module (Approach B — extended sweep)
  │
  ├─ Existing Tier 1-2-3: infrastructure triage (REPLACED/simplified)
  │
  └─ New: checkHeartbeatChecklist() (every 30m, separate interval)
      │
      ├─ Fetch HEARTBEAT.md content (agents.heartbeatMd or config)
      │
      ├─ isEffectivelyEmpty(content)?
      │   → Parse markdown: skip lines that are blank, # headers only,
      │     or empty list items (- [ ]). If no remaining content → empty.
      │   → YES: skip, no LLM call, reset timer
      │
      ├─ Run automated code-level checks (system status snapshot)
      │   → Inject findings into prompt context alongside checklist
      │
      ├─ NO: create taskType:”heartbeat-checklist” for lead
      │   → Dedup: if lead already has active heartbeat-checklist task, skip
      │   → Prompt includes HEARTBEAT.md + automated check results
      │   → Uses structured output schema:
      │     { status: “ok” | “action_needed”,
      │       actions?: { description: string, type: “task”|”slack”|”note” }[],
      │       summary?: string }
      │
      ├─ Response status = “ok”?
      │   → Complete task silently, no further action
      │
      └─ Response status = “action_needed”?
          → Process actions array (create tasks, post to Slack, etc.)
          → Dedup: same summary within 24h? suppress
```

**Structured output**: The lead responds with a JSON schema rather than free-text. `status: “ok”` replaces “HEARTBEAT_OK” string matching. `actions` array provides typed actionable items the system can process programmatically.

**isEffectivelyEmpty()**: Parses HEARTBEAT.md line by line. A line is “empty” if it's blank, a markdown header (`# ...`), a comment (`<!-- ... -->`), or an empty list item (`- [ ]`, `- `). If ALL lines are empty → skip the LLM call entirely.

### Coexistence: Both Systems Running

```
┌──────────────────────────────┐    ┌──────────────────────────────┐
│   Infrastructure Heartbeat    │    │    HEARTBEAT.md Checklist     │
│   (src/heartbeat/)            │    │    (runner-level)             │
│                               │    │                               │
│   Interval: 90s               │    │   Interval: 30m (configurable)│
│   Runs on: API server         │    │   Runs on: Lead runner        │
│   Cost: ~0 (DB queries)       │    │   Cost: 1 LLM call per tick   │
│   Checks: stalls, health,     │    │   Checks: whatever is in      │
│     auto-assign, cleanup      │    │     HEARTBEAT.md              │
│   Escalates: creates task     │    │   Acts: creates tasks, posts  │
│     for lead (rare)           │    │     to Slack, or HEARTBEAT_OK │
│                               │    │                               │
│   KEEP AS-IS                  │    │   NEW — lead-managed          │
└──────────────────────────────┘    └──────────────────────────────┘
```

## Historical Context (from thoughts/)

### Directly Related

- `thoughts/shared/plans/2026-03-02-code-level-heartbeat.md` — The plan that produced the current `src/heartbeat/` module. Scoped to infrastructure triage only. Implemented and merged.

- `thoughts/taras/research/2026-03-08-drive-loop-concept.md` — Identified gaps in the heartbeat (no epic-level stall detection) and proposed an "Epic Heartbeat." Parts implemented in PR #148 (v1.37.0). The drive loop itself was NOT implemented — the HEARTBEAT.md approach could subsume this.

### Scheduling Context

- `thoughts/shared/research/2026-01-15-scheduled-tasks.md` — Original scheduled tasks research
- `thoughts/shared/plans/2026-01-15-scheduled-tasks-implementation.md` — Implementation plan
- `thoughts/taras/plans/2026-03-06-one-time-scheduled-tasks.md` — One-time schedule support
- `thoughts/taras/plans/2026-03-21-schedule-wf-trigger-and-workspace.md` — Schedule-workflow integration

### Lead Management Context

- `thoughts/shared/plans/2026-01-12-lead-inbox-model.md` — Lead inbox model (how the lead receives work)
- `thoughts/shared/plans/2025-12-23-worker-lead-spawn-triggers.md` — Worker/lead spawn trigger design
- `thoughts/shared/research/2025-12-22-runner-loop-architecture.md` — Runner loop architecture

## Decisions (from review feedback)

1. **Approach**: **B — Heartbeat Module Extension**. KISS. Remove the current infrastructure-only approach and replace with a unified heartbeat that combines automated code checks + HEARTBEAT.md checklist. Runs on start + default interval. Auto-create a schedule for visibility to the user.

2. **Storage**: New `agents.heartbeatMd` column — consistent with other profile fields (`claudeMd`, `soulMd`, etc.).

3. **Who maintains it**: Lead can self-edit via `update-profile`. Also mountable like other profile files (same pattern as CLAUDE.md, SOUL.md mount in Docker).

4. **HEARTBEAT_OK detection**: **Structured output**. Schema: `{ status: “ok” | “action_needed”, actions?: [...], summary?: string }`. No string matching.

5. **Alert delivery**: Skipped — not needed for initial implementation.

6. **Drive loop / Epics**: Epics are deprecated. No epic integration.

7. **Concurrency**: Single lead, but must be concurrency-safe (lead runs multiple concurrent sessions). Dedup guard: if an active `heartbeat-checklist` task already exists for the lead, skip creating another.

8. **Automated checks section**: YES — the heartbeat should include a section of code-level automated checks (system status: stalled tasks, idle workers, pool state, stale resources) whose results get injected into the HEARTBEAT.md prompt context. This gives the LLM real data to reason about alongside the standing orders. The current Tier 1-2 infrastructure checks become the “automated checks” feeding into the LLM prompt rather than acting autonomously.

## Remaining Open Questions

1. **Automated checks scope**: Which of the current Tier 1-2 checks should become automated check inputs to the LLM vs. remain as direct code-level actions (e.g., should pool auto-assignment stay as code, or should the lead decide)?

2. **Schedule visibility**: Should the auto-created schedule be editable by the user (interval, enable/disable) or read-only?

3. **Mount path**: Where does the heartbeat file get mounted in Docker? Same pattern as `~/.claude/CLAUDE.md`?
