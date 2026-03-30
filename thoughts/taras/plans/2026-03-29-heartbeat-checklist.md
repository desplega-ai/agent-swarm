---
date: 2026-03-29
planner: Claude
topic: heartbeat-checklist
status: completed
autonomy: autopilot
commit_per_phase: true
research: thoughts/taras/research/2026-03-28-heartbeat-redesign.md
repository: agent-swarm
branch: main
---

# Heartbeat Redesign: HEARTBEAT.md Checklist — Implementation Plan

## Overview

Add a HEARTBEAT.md-based periodic checklist to the agent-swarm heartbeat module. The lead agent periodically receives a task containing a system status snapshot + user-defined standing orders from HEARTBEAT.md, reasons about both, and takes action if needed — or silently completes if nothing is actionable.

This extends (not replaces) the existing infrastructure heartbeat. The 90-second deterministic sweep (auto-fail dead workers, fix health mismatches, auto-assign pool tasks, clean stale resources) **stays as-is**. On a separate, longer interval (default 30 min), a new checklist check creates a `heartbeat-checklist` task for the lead with system status + HEARTBEAT.md content. Tier 3 escalation (`escalateToLead()`) is removed — its role is subsumed by the checklist.

## Current State Analysis

**Heartbeat module** (`src/heartbeat/heartbeat.ts`): 3-tier sweep on 90s interval:
- **Tier 1 (preflight)**: bail if no actionable DB state
- **Tier 2 (code-level)**: auto-fail dead workers (5/15 min), fix busy/idle mismatches, auto-assign pool tasks, clean stale resources
- **Tier 3 (escalation)**: create `taskType: "heartbeat"` task for lead if ambiguous stalls (30 min threshold) — with cooldown + dedup

**Agent profile fields**: `claudeMd`, `soulMd`, `identityMd`, `setupScript`, `toolsMd` — stored as TEXT columns on `agents` table. No `heartbeatMd`.

**Template system** (`templates/schema.ts`): 5 file slots (`claudeMd`, `soulMd`, `identityMd`, `toolsMd`, `setupScript`). Lead template (`templates/official/lead/`) uses 3 of them. No heartbeat file.

**Update-profile tool** (`src/tools/update-profile.ts`): Supports all 5 profile fields. Lead can self-edit.

### Key Discoveries:
- Latest migration: `026_drop_epics.sql` → next is `027`
- `updateAgentProfile()` at `src/be/db.ts:2251` uses COALESCE pattern — adding a field is mechanical
- Lead template has `CLAUDE.md`, `SOUL.md`, `IDENTITY.md` — no `TOOLS.md` or `setupScript`
- Tier 3 escalation (`heartbeat.ts:316-403`) has cooldown tracking, dedup guard, and marker-based task dedup
- `gatherSystemStatus()` will reuse existing DB functions: `getTaskStats()`, `getStalledInProgressTasks()`, `getAllAgents()`, `getIdleWorkersWithCapacity()`, `getUnassignedPoolTasks()`

## Desired End State

1. **New `agents.heartbeatMd` column** — TEXT, nullable, stores per-agent HEARTBEAT.md content
2. **Template `heartbeatMd` file slot** — lead template ships with effectively-empty default (all comments)
3. **Lead can self-edit** HEARTBEAT.md via `update-profile` tool
4. **Heartbeat module has separate 30-min interval** for checklist checks
5. **On tick**: gather system status → check HEARTBEAT.md emptiness → if non-empty, create `heartbeat-checklist` task for lead (with dedup guard)
6. **Lead receives task** with system status markdown + HEARTBEAT.md content → takes action using available tools or completes with brief summary. Tags: `["checklist", "auto-generated"]` (not `"heartbeat"` — that tag triggers the default listing filter)
7. **Tier 3 escalation removed** — stalled tasks with active sessions appear in system status section
8. **Existing 90s infrastructure sweep** (Tier 1-2) unchanged — auto-fail, health fixes, cleanup, auto-assign continue as-is

## Quick Verification Reference

```bash
bun run tsc:check              # TypeScript type check
bun run lint:fix               # Biome lint + format
bun test                       # Unit tests
bash scripts/check-db-boundary.sh  # Worker/API DB boundary
```

Key files:
- `src/heartbeat/heartbeat.ts` — Core sweep engine
- `src/heartbeat/templates.ts` — Prompt templates
- `src/be/db.ts` — DB functions (updateAgentProfile, session queries)
- `src/be/migrations/027_heartbeat_md.sql` — New migration
- `templates/schema.ts` — Template type definitions
- `templates/official/lead/` — Lead template
- `src/tools/update-profile.ts` — Profile update MCP tool
- `src/commands/runner.ts` — Template application

## What We're NOT Doing

- **Schedule auto-creation for UI visibility** — future enhancement; the checklist runs on its own interval
- **Programmatic output processing** — the lead takes actions directly using its tools (create tasks, post to Slack), no structured output parsing by the system
- **Removing deterministic auto-remediation** — Tier 1-2 stays at 90s; dead workers still auto-fail in 5/15 min
- **Epic/drive-loop integration** — epics are deprecated
- **Alert delivery system** — out of scope
- **Docker HEARTBEAT.md mount** — follows existing profile file patterns, no new mount mechanism needed

## Implementation Approach

4 phases, each independently verifiable:

1. **Database + Types** — Foundation: migration, db.ts updates, type additions
2. **Template + Profile API** — Storage and delivery: template schema, lead default, update-profile tool, runner application
3. **Heartbeat Module Redesign** — Core logic: system status snapshot, empty check, dedup, checklist interval, prompt template, remove Tier 3
4. **Testing + Pre-PR** — Unit tests, lint, typecheck, E2E validation

---

## Phase 1: Database + Types

### Overview

Add `heartbeatMd` column to the `agents` table and wire it through the DB layer.

### Changes Required:

#### 1. New Migration
**File**: `src/be/migrations/027_heartbeat_md.sql`
**Changes**: Add `heartbeatMd` TEXT column to `agents` table, defaulting to NULL.

```sql
ALTER TABLE agents ADD COLUMN heartbeatMd TEXT DEFAULT NULL;
```

#### 2. DB Functions
**File**: `src/be/db.ts`
**Changes**:

- **`VERSIONABLE_FIELDS`** (~line 226): Add `"heartbeatMd"` to the array. This automatically enables context versioning (change history) and the `ensureAgentProfileColumns()` compat guard for pre-migration DBs.

- **`updateAgentProfile()`** (~line 2251): Add `heartbeatMd` to the accepted updates object and the COALESCE UPDATE statement. Follow the exact same pattern as `claudeMd`, `soulMd`, etc. Context versioning is automatic via `VERSIONABLE_FIELDS`.

- **Agent SELECT queries**: Ensure `heartbeatMd` is included in queries that return full agent profile data (e.g., `getAgentById()`, `getAgentProfile()`). Check all places that destructure agent rows. The heartbeat module will read `heartbeatMd` from the lead agent row returned by existing lookup functions — no dedicated getter needed.

#### 3. Type Updates
**File**: `src/types.ts` (if agent types are defined here) or wherever `Agent` interface lives
**Changes**: Add `heartbeatMd: string | null` to the Agent type/interface.

### Success Criteria:

#### Automated Verification:
- [x] Migration applies on fresh DB: `rm -f agent-swarm-db.sqlite* && bun run start:http` (starts and exits cleanly)
- [x] Migration applies on existing DB: `bun run start:http` (existing DB picks up new column)
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Tests pass: `bun test`

#### Manual Verification:
- [x] Query `SELECT heartbeatMd FROM agents LIMIT 1` returns NULL for existing agents
- [x] `updateAgentProfile(id, { heartbeatMd: "# Test" })` works and persists
- [x] Agent lookup (e.g. `getAgentById(id)`) returns `.heartbeatMd` with stored content

**Implementation Note**: After completing this phase, pause for manual verification. Commit after verification passes.

---

## Phase 2: Template + Profile API

### Overview

Add `heartbeatMd` to the template system, create a default for the lead template, and update the profile update tool and runner application.

### Changes Required:

#### 1. Template Schema
**File**: `templates/schema.ts`
**Changes**:
- Add `heartbeatMd: string | null` to `TemplateConfig.files`
- Add `heartbeatMd: string` to `TemplateResponse.files`

#### 2. Lead Template Default
**File**: `templates/official/lead/HEARTBEAT.md` (new file)
**Changes**: Create an effectively-empty default that ships with the lead template. All comments — `isEffectivelyEmpty()` will skip this, costing zero LLM calls until the user or lead adds real content.

```markdown
# Heartbeat Checklist

<!-- Keep this section empty to skip periodic heartbeat checks (no LLM cost). -->
<!-- Add actionable items below when you want periodic checks. -->
<!-- The lead agent reads this every 30 minutes and acts on any items found. -->

<!-- Examples (uncomment to activate):
- Check Slack for unaddressed requests older than 1 hour
- Review active tasks for any that seem stuck or blocked
- If idle workers exist and unassigned tasks are available, investigate why auto-assignment didn't handle them
- Post a daily summary to #agent-status at 5pm
-->
```

#### 3. Lead Template Config
**File**: `templates/official/lead/config.json`
**Changes**: Add `"heartbeatMd": "HEARTBEAT.md"` to the `files` object.

#### 4. Update-Profile Tool
**File**: `src/tools/update-profile.ts`
**Changes**:
- Add `heartbeatMd` to the input schema — same pattern as other profile fields: `z.string().max(65536).optional()` with description "Heartbeat checklist content (HEARTBEAT.md). Checked periodically — add standing orders for the lead to review."
- Add workspace file write: when `heartbeatMd` is updated on self, write to `/workspace/HEARTBEAT.md` (same pattern as `soulMd` → `/workspace/SOUL.md` at lines 219-248).
- No field-level lead-only guard needed — the existing cross-agent guard already prevents non-leads from editing other agents. A non-lead setting `heartbeatMd` on itself is harmless (the heartbeat module only reads the lead's value).

#### 5. Runner Template Application
**File**: `src/commands/runner.ts` (~line 2186-2206)
**Changes**:
- Add `heartbeatMd` to the template application block: interpolate and apply from `cachedTemplate.files.heartbeatMd` (same pattern as `claudeMd`, `soulMd`, etc.).
- **Update the guard condition** at line 2186: add `!agentHeartbeatMd` to the existing check `!agentSoulMd || !agentIdentityMd || !agentToolsMd || !agentClaudeMd` so that a missing `heartbeatMd` also triggers template application on boot.
- Include `heartbeatMd` in the `PUT /api/agents/:id/profile` payload at lines 2220-2242.

#### 6. Profile HTTP Endpoints
**File**: `src/http/agents.ts` (or wherever agent profile GET/PUT endpoints live)
**Changes**: Ensure `heartbeatMd` is included in profile response payloads and accepted in profile update requests. No additional lead-only guard needed beyond the existing cross-agent check.

#### 7. Lead Template CLAUDE.md Update
**File**: `templates/official/lead/CLAUDE.md`
**Changes**: Add HEARTBEAT.md to the "Your Identity Files" section so the lead knows it exists and can edit it:

```markdown
- **`/workspace/HEARTBEAT.md`** — Your periodic checklist. The system reads this every 30 minutes
  and creates a task for you with system status + your standing orders. Edit to add/remove checks.
  Leave empty (or all comments) to disable periodic checks at zero cost.
```

This ensures the lead knows about the file from its first session — no separate prompt adaptation needed for work-on-task or other triggers, since the lead's CLAUDE.md is always loaded.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Tests pass: `bun test`
- [x] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [x] Template fetch for `official/lead` includes `heartbeatMd` file content
- [x] `update-profile` MCP tool accepts `heartbeatMd` parameter
- [x] Profile API GET returns `heartbeatMd` field
- [x] Runner applies `heartbeatMd` from template on boot (verify in agent row after template application)

**Implementation Note**: After completing this phase, pause for manual verification. Commit after verification passes.

---

## Phase 3: Heartbeat Module Redesign

### Overview

The core change. Add system status gathering, HEARTBEAT.md empty check, dedup guard, separate checklist interval, prompt template, and remove Tier 3 escalation.

### Changes Required:

#### 1. System Status Snapshot
**File**: `src/heartbeat/heartbeat.ts`
**Changes**: Add `gatherSystemStatus(): Promise<string>` function that collects current system state and formats it as markdown. This reuses existing DB functions — no new queries needed.

```typescript
async function gatherSystemStatus(): Promise<string> {
  const stats = getTaskStats();
  const stalledTasks = getStalledInProgressTasks(STALL_THRESHOLD_MINUTES);
  const agents = getAllAgents();
  const idleWorkers = getIdleWorkersWithCapacity();
  const poolTasks = getUnassignedPoolTasks(10);

  // Format as markdown sections with clear [AUTO-GENERATED] labels:
  // ## Task Overview [auto-generated]
  // - In Progress: N, Pending: N, Unassigned: N, ...
  //
  // ## Stalled Tasks [auto-generated]
  // - [taskId] "description" — assigned to agent-name, last update: Xm ago
  //
  // ## Agent Status [auto-generated]
  // - Online: N (X idle, Y busy), Offline: N
  //
  // ## Available Work [auto-generated]
  // - N unassigned pool tasks waiting
  // - N idle workers with capacity
}
```

The output should be concise — the lead doesn't need every detail, just enough to reason about system health. Each section MUST be clearly labeled `[auto-generated]` in the heading so the lead can distinguish system-provided data from their own standing orders in HEARTBEAT.md. This prevents confusion about what was written by the system vs. by the lead/user.

#### 2. Empty Content Detection
**File**: `src/heartbeat/heartbeat.ts`
**Changes**: Add `isEffectivelyEmpty(content: string): boolean` — returns true if the content has no actionable items.

A line is "empty" if it matches any of:
- Blank or whitespace-only
- Markdown header (`# ...`, `## ...`)
- HTML comment (`<!-- ... -->`)
- Empty list item (`- [ ]`, `- `, `* `)
- Comment-only (line is inside a `<!-- -->` block)

If ALL non-blank lines are headers, comments, or empty items → return true. Otherwise false.

#### 3. Checklist Check Logic
**File**: `src/heartbeat/heartbeat.ts`
**Changes**: Add the main `checkHeartbeatChecklist(): Promise<void>` function:

```
1. Find lead agent (getLeadAgent or equivalent) → returns full Agent row
   → If no lead registered, skip
2. Read lead.heartbeatMd from the agent row
   → If null or empty string, skip
3. Check isEffectivelyEmpty(content)
   → If true, skip (zero cost)
4. Dedup guard: check if lead already has an active task with taskType "heartbeat-checklist"
   → If yes, skip (don't pile up)
5. Gather system status: gatherSystemStatus()
6. Build prompt from template (see below)
7. Create task:
     createTaskExtended(resolvedPrompt, {
       taskType: "heartbeat-checklist",
       priority: 60,
       agentId: leadId,
       source: "system",
       tags: ["checklist", "auto-generated"]
     })
   NOTE: Do NOT use tag "heartbeat" — getTasks() (db.ts:1077) and getTaskCount()
   (db.ts:1153) exclude tasks with tags LIKE '%"heartbeat"%' by default.
   The taskType "heartbeat-checklist" is sufficient for identification.
8. Log: "Heartbeat checklist task created for lead"
```

#### 4. Prompt Template
**File**: `src/heartbeat/templates.ts`
**Changes**: Add new template `"heartbeat.checklist"`:

```
Task Type: Heartbeat Checklist
Goal: Review system status and your standing orders, take action if needed.

## Current System Status [auto-generated]
{{system_status}}

## Your Standing Orders (from HEARTBEAT.md)
{{heartbeat_content}}

## Instructions
1. Review the system status above for anything that needs attention (stalled tasks, idle workers with available work, anomalies).
2. Review your standing orders for any periodic checks or actions.
3. If something needs attention — take action now using your available tools (create tasks, post to Slack, cancel stuck tasks, etc.).
4. If everything looks healthy and no standing orders are actionable — complete this task with a brief "All clear" summary.
5. Do NOT create another heartbeat-checklist task — the system handles scheduling.
```

#### 5. Separate Interval + Lifecycle
**File**: `src/heartbeat/heartbeat.ts`
**Changes**:

- New config constant: `HEARTBEAT_CHECKLIST_INTERVAL_MS` (env: `HEARTBEAT_CHECKLIST_INTERVAL_MS`, default: `1800000` = 30 min)
- New config constant: `HEARTBEAT_CHECKLIST_DISABLE` (env: `HEARTBEAT_CHECKLIST_DISABLE`, default: unset)
- New variable: `let checklistInterval: ReturnType<typeof setInterval> | null`
- **`startHeartbeatChecklist(intervalMs?)`**: Starts the checklist interval. Runs initial check after 30s delay (give system time to boot). Skip if `HEARTBEAT_CHECKLIST_DISABLE` is set.
- **`stopHeartbeatChecklist()`**: Clears the interval.
- Update **`startHeartbeat()`** to also call `startHeartbeatChecklist()`
- Update **`stopHeartbeat()`** to also call `stopHeartbeatChecklist()`

#### 6. Remove Tier 3 Escalation
**File**: `src/heartbeat/heartbeat.ts`
**Changes**:

- Remove `escalateToLead()` function (lines ~327-403)
- Remove `evaluateEscalation()` from `codeLevelTriage()` — stalled tasks are no longer escalated via Tier 3; they appear in the system status section of the heartbeat-checklist task
- Remove escalation cooldown tracking variables (`lastEscalationAt`, `escalationCooldownMap`, etc.)
- Remove `resetEscalationCooldowns()` (testing utility)
- Keep `HeartbeatFindings.stalledTasks` — still collected by Tier 2, but no longer triggers escalation
- Remove `HeartbeatFindings.escalationNeeded` and `escalationReason` fields

**File**: `src/heartbeat/templates.ts`
**Changes**: Remove `"heartbeat.escalation.stalled"` template (replaced by `"heartbeat.checklist"`).

#### 7. HTTP Endpoint
**File**: `src/http/heartbeat.ts`
**Changes**: Add `POST /api/heartbeat/checklist` endpoint that manually triggers `checkHeartbeatChecklist()`. Useful for testing and manual triggering. Auth: apiKey required. Follow the same pattern as the existing `POST /api/heartbeat/sweep`.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Tests pass: `bun test`
- [x] Lint passes: `bun run lint:fix`
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [x] Start API with lead agent, set `heartbeatMd` to content with real items → verify heartbeat-checklist task created within interval
- [x] `POST /api/heartbeat/checklist` triggers the check manually
- [x] Verify system status section in the task description is readable, accurate, and clearly labeled `[auto-generated]`
- [x] Verify standing orders section shows HEARTBEAT.md content (not labeled auto-generated)
- [x] Verify Tier 3 escalation no longer creates separate "heartbeat" tasks

**Note**: The following are covered by unit tests in Phase 4 (not manual):
- `isEffectivelyEmpty()` edge cases (empty, comments-only, real content)
- Dedup guard (skip when active heartbeat-checklist exists)
- Skip when heartbeatMd is NULL or effectively empty
- Cross-agent guard on update-profile (existing behavior, no new field-level guard)

**Implementation Note**: This is the largest phase. After completing, do a thorough manual walkthrough. Commit after verification passes.

---

## Phase 4: Testing + Pre-PR

### Overview

Write unit tests for new functions, run full pre-PR checks, and do a Docker E2E validation.

### Changes Required:

#### 1. Unit Tests
**File**: `src/tests/heartbeat-checklist.test.ts` (new file)
**Tests**:

- **`isEffectivelyEmpty()`**:
  - Returns `true` for empty string
  - Returns `true` for whitespace-only
  - Returns `true` for headers-only (`# Title\n## Subtitle`)
  - Returns `true` for HTML comments only (`<!-- comment -->`)
  - Returns `true` for mix of headers + comments + empty items
  - Returns `false` for content with real list items (`- Check Slack`)
  - Returns `false` for content with plain text paragraphs

- **`gatherSystemStatus()`**:
  - Returns markdown string
  - Includes task stats section
  - Includes agent status section
  - Handles empty DB (no tasks, no agents) gracefully

- **`checkHeartbeatChecklist()`**:
  - Skips when no lead agent registered
  - Skips when heartbeatMd is NULL
  - Skips when heartbeatMd is effectively empty (all comments/headers)
  - Creates task when heartbeatMd has real content
  - Dedup: skips when active heartbeat-checklist task exists for lead
  - Created task has correct taskType (`"heartbeat-checklist"`), priority (60), tags (`["checklist", "auto-generated"]`)
  - Created task description includes `[auto-generated]` labels in system status sections
  - Created task description includes HEARTBEAT.md content without `[auto-generated]` label

- **`update-profile` heartbeatMd support**:
  - Any agent can set `heartbeatMd` on itself → succeeds
  - Non-lead agent cannot set `heartbeatMd` on another agent → rejected (existing cross-agent guard)
  - Lead agent can set `heartbeatMd` on any agent → succeeds

- **`gatherSystemStatus()` output labeling**:
  - All section headings include `[auto-generated]`
  - Output contains expected sections (Task Overview, Agent Status, etc.)

Use isolated SQLite DBs per test (same pattern as existing tests).

#### 2. Pre-PR Checks
Run all merge-gate checks:

```bash
bun run lint:fix
bun run tsc:check
bun test
bash scripts/check-db-boundary.sh
```

#### 3. E2E Validation (Docker)
Follow the `swarm-local-e2e` pattern:

1. Clean DB + start API: `rm -f agent-swarm-db.sqlite* && bun run start:http &`
2. Build Docker image: `bun run docker:build:worker`
3. Start lead container with `HEARTBEAT_CHECKLIST_INTERVAL_MS=60000` (1 min for testing)
4. Set heartbeatMd on lead via API: `curl -X PUT /api/agents/:id/profile -d '{"heartbeatMd": "- Check if any tasks are stuck"}'`
5. Wait ~90s for checklist to trigger
6. Verify heartbeat-checklist task created: `curl /api/tasks?taskType=heartbeat-checklist`
7. Verify task description includes system status section
8. Clean up: stop containers, kill API

### Success Criteria:

#### Automated Verification:
- [x] All unit tests pass: `bun test src/tests/heartbeat-checklist.test.ts`
- [x] Full test suite passes: `bun test`
- [x] Lint passes: `bun run lint:fix`
- [x] TypeScript compiles: `bun run tsc:check`
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [x] E2E: heartbeat-checklist task appears in lead's task queue
- [x] E2E: task description contains system status + HEARTBEAT.md content
- [x] E2E: with empty HEARTBEAT.md, no task created
- [x] Dashboard: heartbeat-checklist task visible in UI task list

**Implementation Note**: After all checks pass, this is ready for PR.

---

## Manual E2E Verification

After all phases complete, run this end-to-end verification:

```bash
# 1. Clean slate
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm

# 2. Start API (short checklist interval for testing)
HEARTBEAT_CHECKLIST_INTERVAL_MS=60000 bun run start:http &

# 3. Build Docker image
bun run docker:build:worker

# 4. Start lead container
docker run --rm -d \
  --name e2e-heartbeat-lead \
  --env-file .env.docker-lead \
  -e AGENT_ROLE=lead \
  -e MAX_CONCURRENT_TASKS=2 \
  -p 3201:3000 \
  agent-swarm-worker:latest

# 5. Wait for registration (~15s)
sleep 15
LEAD_ID=$(curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/agents | jq -r '.agents[] | select(.isLead==true) | .id')
echo "Lead ID: $LEAD_ID"

# 6. Verify default HEARTBEAT.md from template (should be effectively empty)
curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/agents/$LEAD_ID" | jq '.heartbeatMd'
# → Should be the template default (all comments)

# 7. Verify NO heartbeat-checklist task created (empty content = skip)
sleep 70
curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/tasks" | jq '[.tasks[] | select(.taskType=="heartbeat-checklist")] | length'
# → Should be 0

# 8. Set real HEARTBEAT.md content
curl -s -X PUT -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  "http://localhost:3013/api/agents/$LEAD_ID/profile" \
  -d '{"heartbeatMd": "# Heartbeat Checklist\n\n- Check if any tasks appear stuck or blocked\n- If idle workers exist with unassigned tasks, investigate"}'

# 9. Wait for next checklist tick
sleep 70

# 10. Verify heartbeat-checklist task was created
curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/tasks" | jq '.tasks[] | select(.taskType=="heartbeat-checklist") | {id, status, description}'
# → Should show one task with system status + HEARTBEAT.md content

# 11. Manual trigger test
curl -s -X POST -H "Authorization: Bearer 123123" http://localhost:3013/api/heartbeat/checklist
# → Should return success (or skip if dedup)

# 12. Cleanup
docker stop e2e-heartbeat-lead
kill $(lsof -ti :3013) 2>/dev/null
```

## Testing Strategy

- **Unit tests**: `isEffectivelyEmpty()`, `gatherSystemStatus()`, `checkHeartbeatChecklist()` — isolated SQLite DBs, no Docker needed
- **Integration**: Manual trigger via `POST /api/heartbeat/checklist` — verify prompt assembly and task creation
- **E2E**: Docker lead + API with short interval — verify full flow from boot to task creation

## References
- Research: `thoughts/taras/research/2026-03-28-heartbeat-redesign.md`
- Current heartbeat plan: `thoughts/shared/plans/2026-03-02-code-level-heartbeat.md`
- Drive loop research: `thoughts/taras/research/2026-03-08-drive-loop-concept.md`

---

## Review Errata

_Reviewed: 2026-03-29 by Claude_

### All Resolved

- [x] **Task listing filter** — Changed tags from `["heartbeat", "checklist"]` to `["checklist", "auto-generated"]` to avoid the `includeHeartbeat` exclusion filter. Added NOTE in Phase 3 step 3 pseudocode.
- [x] **`createTaskExtended()` signature** — Fixed pseudocode to `createTaskExtended(resolvedPrompt, { ... })` matching actual `(task: string, options?)` signature.
- [x] **`VERSIONABLE_FIELDS`** — Added explicit instruction to add `heartbeatMd` to `VERSIONABLE_FIELDS` in Phase 1 step 2. Enables context versioning and compat guard automatically.
- [x] **`ensureAgentProfileColumns()` compat guard** — Covered by adding to `VERSIONABLE_FIELDS` (above).
- [x] **Runner template condition** — Phase 2 step 5 now specifies updating the guard condition to include `!agentHeartbeatMd`.
- [x] **Workspace file write** — Phase 2 step 4 now includes `/workspace/HEARTBEAT.md` write instruction.
- [x] **Lead-only guard** — Simplified to use existing cross-agent pattern (no new field-level guard). Updated Phase 2 steps 4 and 6, and Phase 4 tests.
- [x] **`getAgentHeartbeatMd()` removed** — Phase 1 step 2 now reads from lead agent row directly. Phase 3 step 2 updated.
- [x] Frontmatter missing `topic` field — auto-fixed
- [x] HTTP endpoint "(Optional)" removed — depended on by E2E step 11
- [x] Priority 60 vs 70 — intentional (checklist is lower urgency than escalation)
