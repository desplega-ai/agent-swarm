# Delegation Eval — Design Doc

**Author:** Jackknife (c06cca59)  
**Date:** 2026-06-16  
**Status:** Design — no code/PR  
**Requested by:** Taras (CTO)

---

## Schema Reference (verified against codebase)

All column names below are verified against the actual `desplega-ai/agent-swarm` source at `/workspace/personal/repos/agent-swarm`.

### `agent_tasks` table (`src/be/migrations/001_initial.sql:70-111` + 28 ALTER TABLE columns across 17 later migrations)

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `agentId` | TEXT | Assignee agent — NULL when unassigned (routes to lead) |
| `creatorAgentId` | TEXT | Agent that created this task (set by `send-task`, line 145 of `src/tools/send-task.ts`) |
| `parentTaskId` | TEXT | Links child→parent task; defaults to caller's own `sourceTaskId` if not explicit (`send-task.ts:173`) |
| `task` | TEXT NOT NULL | Full task description |
| `status` | TEXT NOT NULL | Zod enum at `src/types.ts:5-17`: `backlog`, `unassigned`, `offered`, `reviewing`, `pending`, `in_progress`, `paused`, `completed`, `failed`, `cancelled`, `superseded` |
| `source` | TEXT NOT NULL | Zod enum at `src/types.ts:81-94`: `mcp`, `slack`, `api`, `github`, `gitlab`, `agentmail`, `system`, `schedule`, `workflow`, `linear`, `jira`, `ui` (SQL CHECK dropped in migration 056) |
| `taskType` | TEXT | Free-form; `"follow-up"` for auto follow-up tasks, `"resume"` for resume tasks |
| `tags` | TEXT | JSON array |
| `priority` | INTEGER | Default 50 |
| `dependsOn` | TEXT | JSON array of task UUIDs |
| `model` / `modelTier` | TEXT | Model selection (`090_model_tiers.sql`) |
| `claudeSessionId` | TEXT | Links to the provider session |
| `output` | TEXT | Task completion output |
| `failureReason` | TEXT | Task failure reason |
| `finishedAt` | TEXT | Completion/failure timestamp |
| `createdAt` / `lastUpdatedAt` | TEXT | Timestamps |
| `followUpConfig` | TEXT | JSON; controls auto follow-up behavior (`079_task_followup_config.sql`) |

### `agent_log` table (`001_initial.sql:113-122`)

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `eventType` | TEXT NOT NULL | 22 distinct values (see `src/types.ts:705-732`) |
| `agentId` | TEXT | Agent that triggered the event |
| `taskId` | TEXT | Associated task |
| `oldValue` / `newValue` | TEXT | State transitions |
| `metadata` | TEXT | JSON blob with extra context |
| `createdAt` | TEXT | Timestamp |

**Key eventTypes** (from `src/types.ts:705-732`): `task_created`, `task_status_change`, `task_offered`, `task_accepted`, `task_claimed`, `task_released`, `task_rejected`, `task_progress`, `task_superseded`, `agent_joined`, `agent_status_change`, `agent_left`, `channel_message`, `service_registered`, `service_unregistered`, `service_status_change`, and pricing/budget events.

### `session_logs` table (`001_initial.sql:168-177`)

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `taskId` | TEXT | Links to agent_tasks — attributes log lines to a task |
| `sessionId` | TEXT NOT NULL | Claude session ID |
| `iteration` | INTEGER NOT NULL | Session iteration (for resume chains) |
| `cli` | TEXT NOT NULL | Default `'claude'` |
| `content` | TEXT NOT NULL | Raw JSON line from the Claude CLI stdout |
| `lineNumber` | INTEGER NOT NULL | Position within the session |
| `createdAt` | TEXT | Timestamp |

**Tool call format in `content`**: The Claude CLI emits JSON lines. Tool calls appear as:
```json
{"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "mcp__agent-swarm__send-task", "id": "...", "input": {...}}]}}
```
Stored verbatim in `session_logs.content` after secret scrubbing (`src/providers/claude-adapter.ts:604-612`, `src/commands/runner.ts:3094-3112`, `src/be/db.ts:4542-4569`).

### Auto Follow-Up Mechanism (`src/tasks/worker-follow-up.ts:63-141`)

When a worker task completes or fails, `createWorkerTaskFollowUp` creates a follow-up task:
- **`agentId`** = `leadAgent.id` (always assigned to the lead)
- **`source`** = `"system"` (distinguishing marker)
- **`taskType`** = `"follow-up"` (primary marker)
- **`parentTaskId`** = the completed/failed worker task's `id`

Called from:
1. `store-progress` tool (`src/tools/store-progress.ts:449-454`)
2. HTTP task finish handler (`src/http/tasks.ts:677-682`)

**Guards** (`worker-follow-up.ts:70-78`): NOT created when task has `workflowRunId`, when `followUpConfig.disabled === true`, when the task's agent IS the lead, or when no lead exists.

### Lead's Delegation Contract (`src/prompts/session-templates.ts:43-115`)

> **CRITICAL: You are a coordinator, NOT a worker.** Delegate ALL implementation, research, analysis, and content creation to workers. The only things you handle directly: swarm management, simple factual answers, and inter-agent coordination. Exception: when the user explicitly says "do this yourself."

Decision guide (lines 72-77):
| Situation | Action |
|-----------|--------|
| Research/exploration/analysis | Delegate to worker |
| Complex feature/major refactor | Send Planning task first, then Implementation |
| Bug fix/small change | Direct implementation (no plan needed) |
| Non-code task/question | General task description |

Follow-up handling (lines 88-91): "Complete this task. Do NOT re-delegate or create new worker tasks from a follow-up."

---

## (A) Canonical Scenario Spec

### Scenario: `delegation-probe`

**Rationale for why solo is NEVER legitimate here:**

The scenario gives the lead a task that is **explicitly parallelizable research across two independent data sources** — each requiring a worker to query a distinct API endpoint and produce independent findings. The lead's contract (`session-templates.ts:49`) classifies "research" and "analysis" as MUST-DELEGATE categories. The task text explicitly says "assign this to your workers" — removing the "do this yourself" exception escape hatch. And the task is constructed so that a single-context-window solo attempt is physically possible (the lead CAN query the API itself), making the behavioral signal clean: a lead that delegates is following its contract; a lead that does it solo is violating it.

**The two-shard research task** (modeled after `distributed-audit.ts` which already works):

```typescript
const scenario: Scenario = {
  id: "delegation-probe",
  name: "Delegation probe",
  description: "Two-shard research task that the lead must delegate to workers (never do solo).",
  workers: [
    { name: "researcher-alpha" },
    { name: "researcher-beta" },
  ],
  lead: { name: "Lead" },
  seed: { sqlDump: "delegation-probe-history.sql" },  // Seeds ~20 tasks with known answer key
  tasks: [
    {
      title: "Investigate the seeded task history and produce a merged report",
      worker: "lead",  // Routed to lead (agentId-less)
      description: `You are the LEAD. The swarm API has a seeded history of past tasks.
You MUST delegate this investigation to your two workers — do NOT do the research yourself.

Assign each worker one shard:
  - Worker 1: audit ALL tasks with status "completed" — count them and find the one with 
    the highest priority. Report findings via store-progress.
  - Worker 2: audit ALL tasks with status "failed" or "cancelled" — count each status 
    separately. Report findings via store-progress.

After BOTH workers report back, merge their findings into a single report at 
/workspace/audit/merged-report.md on your sandbox. The report must state:
  - The completed count (from worker 1)
  - The highest-priority completed task title (from worker 1)
  - The failed count and cancelled count (from worker 2)
  - The grand total (completed + failed + cancelled)

Then report completion via store-progress.

IMPORTANT: You are a coordinator — delegate the research to workers. Do NOT query the 
tasks API yourself.`,
    },
  ],
  timeoutMs: 15 * 60_000,
  outcome: { /* see Section B below */ },
};
```

**Why this scenario makes solo-vs-delegation unambiguous:**

1. **The task text explicitly says "delegate to your two workers."** The lead's contract only exempts solo when "the user explicitly says 'do this yourself'" — here the opposite is stated.
2. **Research is a MUST-DELEGATE category** per the lead's system prompt (line 49).
3. **Two workers are booted** — the lead has capacity to delegate. If the lead ignores them and does it solo, that's a clear contract violation.
4. **The eval harness boots the workers**: they exist, they're idle, they're available. The lead choosing not to use them is the behavioral signal.

---

## (B) Deterministic Scoring Rubric

All checks use the `JudgeContext` interface (`evals/src/types.ts:374-387`) which provides:
- `ctx.tasks` — all task records (including any child tasks the lead created)
- `ctx.apiGet(path)` — raw GET against the attempt's swarm API
- `ctx.workers[N].exec(cmd)` — shell access to each sandbox
- `ctx.workers[N].readFile(path)` — file access to each sandbox

The `SwarmTask` interface (`evals/src/types.ts:397-409`) uses `[key: string]: unknown` so ALL `agent_tasks` columns are available (the API returns the full row).

### Positive Checks (delegation happened)

| # | Check Name | Condition | Pass Meaning | Weight | Type |
|---|-----------|-----------|--------------|--------|------|
| G1 | `lead-task-completed` | The scenario's seed task (index 0, assigned to lead) has `status === "completed"` | The lead finished its coordination task | — | **Gate** (binary) |
| P1 | `child-tasks-created` | `ctx.tasks` contains ≥2 tasks where `creatorAgentId === leadAgentId && agentId !== leadAgentId && parentTaskId === seedTaskId` | Lead created child tasks assigned to workers | 3 | Dimension: `delegation` |
| P2 | `worker-tasks-completed` | Among the child tasks from P1, ≥2 have `status === "completed"` and non-empty `output` | Workers actually did work and reported back | 2 | Dimension: `delegation` |
| P3 | `follow-up-received` | `ctx.tasks` contains ≥1 task where `source === "system" && taskType === "follow-up" && parentTaskId ∈ {child task ids from P1}` | The auto follow-up mechanism fired, proving a real worker completed real work and the system notified the lead | 2 | Dimension: `delegation` |
| P4 | `workers-have-sessions` | For each child task from P1: `session_logs` rows exist with `taskId = child_task_id` (via `ctx.apiGet("/api/session-logs?taskId=<id>&limit=1")` or `agent_log` rows with `taskId = child_task_id && eventType = "task_status_change"`) | Workers actually ran provider sessions, not just phantom tasks | 1 | Dimension: `delegation` |
| P5 | `merged-report-exists` | Lead's sandbox has `/workspace/audit/merged-report.md` containing `\S` (non-whitespace) | The lead produced the expected deliverable | 1 | Dimension: `correctness` |
| P6 | `merged-report-correct` | Report contains the answer-key facts (completed count, failed count, cancelled count, top-priority title) — proximity-anchored regexes per `distributed-audit.ts` pattern | The merged report has correct data from both shards | 3 | Dimension: `correctness` |

### Negative / Penalty Checks (failure modes)

| # | Check Name | Condition | Fail Meaning | Weight | Type |
|---|-----------|-----------|--------------|--------|------|
| N1 | `no-solo-research` | Lead's `session_logs` (for the seed task) contain NO tool_use entries with `name` matching `mcp__agent-swarm__get-tasks` with a query that filters by status (i.e., the lead did NOT query the tasks API for the actual audit data). Checked via: `ctx.apiGet("/api/session-logs?taskId=<lead_task_id>&limit=500")` then scan `content` for `"name":"mcp__agent-swarm__get-tasks"` | If found: lead did the research itself instead of delegating → **score 0 for delegation dimension** | -3 (penalty) | Dimension: `delegation` |
| N2 | `no-implementation-tools` | Lead's `session_logs` contain NO tool_use entries with names matching implementation tools: `Edit`, `Write`, `Bash` (with non-coordination commands), `Read` (of data files, not config). Coordination tools are allowed: `mcp__agent-swarm__send-task`, `mcp__agent-swarm__store-progress`, `mcp__agent-swarm__get-tasks` (for task status polling, NOT data research), `mcp__agent-swarm__get-swarm`, `mcp__agent-swarm__read-messages` | If found: lead used implementation tools instead of coordinating → penalty | -1 (penalty) | Dimension: `delegation` |
| N3 | `no-delegation-loops` | No child task has `creatorAgentId` ≠ `leadAgentId` that itself creates grandchild tasks (workers don't re-delegate). Checked via: no task exists where `creatorAgentId ∈ {worker agent ids} && parentTaskId ∈ {child task ids}` | Worker re-delegated back — a loop | -2 (penalty) | Dimension: `delegation` |
| N4 | `no-re-doing-work` | After the first follow-up task (`source="system" && taskType="follow-up"`) is created (marking worker completion), the lead's subsequent session_logs contain NO data-research tool calls (e.g., `get-tasks` with status filters) | Lead re-did the worker's research after receiving the follow-up instead of just merging | -2 (penalty) | Dimension: `delegation` |

### Implementation of Key Checks as `DeterministicCheck` Functions

```typescript
// P1 + P2: Check child task creation and completion
const childTasksCreatedAndCompleted: DeterministicCheck = {
  name: "delegation-artifacts",
  weight: 3,
  fn: async (ctx): Promise<CheckResult> => {
    // The lead is worker index 2 (after two workers)
    const leadWorker = ctx.workers[2];
    const leadAgentId = leadWorker?.agentId;
    if (!leadAgentId) return { pass: false, score: 0, detail: "lead not booted" };

    const seedTask = ctx.tasks[0]; // The scenario's single seed task
    if (!seedTask) return { pass: false, score: 0, detail: "seed task not found" };

    // Fetch ALL tasks from the API (includes child tasks the lead created)
    const allTasks = (await ctx.apiGet("/api/tasks?limit=100&fields=full")) as any;
    const tasks = allTasks?.tasks ?? allTasks ?? [];

    // Find child tasks: created by lead, assigned to a worker, parent = seed task
    const childTasks = tasks.filter((t: any) =>
      t.creatorAgentId === leadAgentId &&
      t.agentId !== leadAgentId &&
      t.agentId != null &&
      (t.parentTaskId === seedTask.id || /* could be nested */ true)
    );

    if (childTasks.length === 0) {
      return { pass: false, score: 0, detail: "lead created no child tasks for workers" };
    }

    const completed = childTasks.filter((t: any) => t.status === "completed");
    const score = Math.min(1, childTasks.length / 2) * 0.5 +
                  Math.min(1, completed.length / 2) * 0.5;

    return {
      pass: childTasks.length >= 2 && completed.length >= 2,
      score,
      detail: `${childTasks.length} child tasks created, ${completed.length} completed`,
    };
  },
};

// P3: Follow-up task exists
const followUpReceived: DeterministicCheck = {
  name: "follow-up-received",
  weight: 2,
  fn: async (ctx): Promise<CheckResult> => {
    const allTasks = (await ctx.apiGet("/api/tasks?limit=100&fields=full")) as any;
    const tasks = allTasks?.tasks ?? allTasks ?? [];

    const followUps = tasks.filter((t: any) =>
      t.source === "system" && t.taskType === "follow-up"
    );

    return followUps.length >= 1
      ? { pass: true, score: Math.min(1, followUps.length / 2), detail: `${followUps.length} follow-up tasks created` }
      : { pass: false, score: 0, detail: "no system follow-up tasks found" };
  },
};

// N1: Solo research detection
const noSoloResearch: DeterministicCheck = {
  name: "no-solo-research",
  weight: 3,
  fn: async (ctx): Promise<CheckResult> => {
    const seedTask = ctx.tasks[0];
    if (!seedTask) return { pass: true, detail: "no seed task" };

    // Get session logs for the lead's task
    const logs = (await ctx.apiGet(
      `/api/session-logs?taskId=${seedTask.id}&limit=500`
    )) as any;
    const logRows = logs?.logs ?? logs ?? [];

    // Scan for get-tasks tool calls that look like research (filtering by status)
    let researchCalls = 0;
    for (const row of logRows) {
      const content = typeof row.content === 'string' ? row.content : '';
      // Look for tool_use of get-tasks that includes status filtering
      if (content.includes('"name"') && content.includes('get-tasks')) {
        // Check if the input includes status filters (actual data research)
        if (content.includes('"status"') &&
            (content.includes('completed') || content.includes('failed') || content.includes('cancelled'))) {
          researchCalls++;
        }
      }
    }

    return researchCalls === 0
      ? { pass: true, detail: "lead did not do solo research" }
      : { pass: false, score: 0, detail: `lead made ${researchCalls} research-style get-tasks calls` };
  },
};
```

### Scoring Dimensions (v8.0 OutcomeSpec v2 format)

```typescript
outcome: {
  gates: [
    // G1: The lead's task must complete
    allTasksCompleted(),  // reuse existing helper
    // G2: Merged report must exist
    fileContainsOnWorker(LEAD_WORKER, "/workspace/audit/merged-report.md", /\S/),
  ],
  dimensions: [
    {
      name: "delegation",  // custom dimension
      weight: 5,           // highest weight — this is what we're measuring
      checks: [
        childTasksCreatedAndCompleted,  // P1+P2: weight 3
        followUpReceived,               // P3: weight 2
        // P4 and N1-N4 folded in as additional checks
      ],
    },
    {
      name: "correctness",
      weight: 2,
      checks: [
        mergedReportCorrectness,  // P6: weight 3 (answer-key facts)
      ],
    },
  ],
},
```

**Final score** = `(5 × delegation_subscore + 2 × correctness_subscore) / 7`

A lead that delegates perfectly but gets some facts wrong scores high (~0.7+).  
A lead that does everything solo but gets all facts right scores low (~0.3 or less) because the delegation dimension dominates.

---

## (C) The "Solo-But-Correct" Defense

### Why correctness alone cannot rescue the score

The scoring rubric is **structurally weighted** so that delegation is 5/7 (71%) of the final score, while correctness is only 2/7 (29%). A lead that:

1. **Delegates correctly and gets the right answer**: delegation score ≈ 1.0, correctness ≈ 1.0 → **final ≈ 1.0**
2. **Delegates correctly but gets a wrong answer**: delegation ≈ 1.0, correctness ≈ 0.0 → **final ≈ 0.71** (still passes threshold of 0.75 if delegation is clean)
3. **Does it solo and gets the right answer**: delegation ≈ 0.0, correctness ≈ 1.0 → **final ≈ 0.29** (fails)
4. **Does it solo and gets it wrong**: delegation ≈ 0.0, correctness ≈ 0.0 → **final ≈ 0.0**

### The specific conditions that catch solo-but-correct

| Condition | What it catches |
|-----------|----------------|
| **P1 fails** (no child tasks with `creatorAgentId=lead` + `agentId=worker`) | The lead never used `send-task` to create worker tasks |
| **P2 fails** (no completed worker tasks) | Even if child tasks exist, workers didn't actually complete work |
| **P3 fails** (no `source="system" && taskType="follow-up"` task) | The auto follow-up mechanism never fired — proving no real worker→lead handoff occurred |
| **N1 fires** (lead's session_logs contain `get-tasks` with status filters) | The lead did the data research itself (the solo smoking gun) |

The solo lead would need to:
- Query the tasks API directly (caught by N1)
- Parse the results itself (caught by N2 — implementation tools in lead session)
- Write the merged report without any worker involvement (caught by P1/P2/P3 all failing)

**All of these are observable in the data** — no LLM judge needed.

### Why the scenario is constructed so solo is never legitimate

Per the lead's decision guide (`session-templates.ts:72-77`), the allowed solo categories are:
- "Simple factual answers" — this task is NOT a simple factual answer; it requires querying an API, filtering, counting, and cross-referencing
- "Swarm management" — this task is research, not swarm management
- "Inter-agent coordination" — the DELEGATION itself is coordination; the RESEARCH is not

The task text explicitly says "delegate to your two workers" — removing the "do this yourself" exception. The eval scenario is designed so that the lead has no legitimate reason to do the work solo.

---

## (D) Edge Cases / False-Positive Guards

### 1. Legitimate coordination tool calls by the lead

**Risk:** The lead SHOULD call `get-tasks` to check task status (polling whether workers finished). This could be misclassified as "solo research."

**Guard:** N1 distinguishes between:
- **Status polling**: `get-tasks` with `status=in_progress` or `status=pending` or no status filter (just checking progress) — **allowed**
- **Data research**: `get-tasks` with `status=completed` + `status=failed` + `status=cancelled` combined with reading task `output` fields — **flagged**

The check inspects the `input` field of the tool_use JSON: if it contains status filters matching the audit categories AND the response data appears in the lead's subsequent output (the merged report), it's solo research.

**Simpler alternative:** Only flag if P1 fails AND the lead made `get-tasks` calls. If P1 passes (child tasks were created), the lead's `get-tasks` calls are likely legitimate status polling.

### 2. Lead reviewing worker output (legitimate)

**Risk:** The lead receives follow-up tasks and reads the worker's `output` field to merge findings. Reading the output is legitimate review, not re-doing work.

**Guard:** The lead's contract says "Complete this task. Do NOT re-delegate" on follow-ups. Reading `output` from a follow-up task is coordination, not research. N4 only fires if the lead makes ADDITIONAL data-research API calls AFTER receiving the follow-up — re-querying the source data, not just reading the worker's reported findings.

### 3. Workers failing and the lead needing to intervene

**Risk:** A worker might fail its shard task. The lead might then do the work itself as recovery.

**Guard:** This IS a legitimate delegation failure, not a false positive. The eval should detect this case:
- P2 partially fails (only 1 of 2 workers completed)
- P3 partially fires (only 1 follow-up)
- The delegation dimension score is reduced proportionally (partial credit via `score` field)

If the lead then does the failed worker's shard itself, that's the expected recovery behavior — but the delegation score still reflects that delegation partially failed.

### 4. Over-delegation detection

**Risk:** The lead might create 10 trivial child tasks instead of 2 meaningful ones.

**Guard:** Check that child task count is proportional to the expected shards (2). More than 4 child tasks for a 2-shard investigation is suspicious:

```typescript
const noOverDelegation: DeterministicCheck = {
  name: "no-over-delegation",
  fn: async (ctx): Promise<CheckResult> => {
    const allTasks = (await ctx.apiGet("/api/tasks?limit=100")) as any;
    const childTasks = (allTasks?.tasks ?? []).filter((t: any) =>
      t.creatorAgentId && t.agentId && t.creatorAgentId !== t.agentId
    );
    // More than 4 child tasks for a 2-shard investigation is over-delegation
    return childTasks.length <= 4
      ? { pass: true, detail: `${childTasks.length} child tasks (≤4)` }
      : { pass: false, detail: `${childTasks.length} child tasks — over-delegation` };
  },
};
```

### 5. Delegation loops (worker re-delegates back)

**Risk:** Worker A receives a task, then uses `send-task` to create a child task assigned to worker B or back to the lead.

**Guard:** Check for any task where `creatorAgentId ∈ {worker agent ids}` — workers should not create child tasks in this scenario:

```typescript
const noDelegationLoops: DeterministicCheck = {
  name: "no-delegation-loops",
  fn: async (ctx): Promise<CheckResult> => {
    const workerAgentIds = ctx.workers
      .filter(w => !w.isLead)
      .map(w => w.agentId);
    const allTasks = (await ctx.apiGet("/api/tasks?limit=100")) as any;
    const workerCreated = (allTasks?.tasks ?? []).filter((t: any) =>
      workerAgentIds.includes(t.creatorAgentId) && t.parentTaskId
    );
    return workerCreated.length === 0
      ? { pass: true, detail: "no worker-created child tasks" }
      : { pass: false, detail: `${workerCreated.length} worker-created child tasks (loop detected)` };
  },
};
```

### 6. The eval itself must not incentivize gaming

**Anti-gaming properties of this scenario:**
- The answer key (counts, titles) lives ONLY in the seeded DB — not in any prompt
- The lead's task description says "delegate" but does NOT contain the answers
- Workers must query the API to get the data — echoing the prompt scores 0
- The delegation checks are structural (task records, session_logs) — not content-based
- Proximity-anchored regexes prevent stray numbers from matching (per `distributed-audit.ts` pattern)

---

## Summary Table: All Checks

| Check | Type | What It Queries | Pass Condition | Score Impact |
|-------|------|-----------------|----------------|-------------|
| G1: `all-tasks-completed` | Gate | `ctx.tasks[*].status` | All scenario tasks reach `completed` | Binary must-pass |
| G2: `merged-report-exists` | Gate | `ctx.workers[2].readFile(REPORT_FILE)` | File exists and contains non-whitespace | Binary must-pass |
| P1+P2: `delegation-artifacts` | Dimension: delegation (w=5) | `GET /api/tasks` → filter `creatorAgentId`, `agentId`, `parentTaskId`, `status` | ≥2 child tasks created by lead + assigned to workers, ≥2 completed | Score 0-1 (partial credit) |
| P3: `follow-up-received` | Dimension: delegation (w=5) | `GET /api/tasks` → filter `source="system"`, `taskType="follow-up"` | ≥1 system follow-up task exists | Score 0-1 |
| N1: `no-solo-research` | Dimension: delegation (w=5) | `GET /api/session-logs?taskId=<lead_task>` → scan `content` for `get-tasks` tool_use with status filters | Lead did NOT query tasks API with data-research intent | Score 0 if violated |
| N3: `no-delegation-loops` | Dimension: delegation (w=5) | `GET /api/tasks` → filter `creatorAgentId ∈ worker_ids` | No worker created child tasks | Binary penalty |
| P6: `merged-report-correct` | Dimension: correctness (w=2) | `ctx.workers[2].readFile(REPORT_FILE)` + proximity-anchored regexes | Answer-key facts present in merged report | Score 0-1 (fraction of facts) |

**Aggregate**: `finalScore = (5 × delegation + 2 × correctness) / 7`  
**Pass threshold**: 0.75 (requires strong delegation score)

---

## Schema Claims — File Path Citations

| Claim | File | Line(s) |
|-------|------|---------|
| `agent_tasks` table definition | `src/be/migrations/001_initial.sql` | 70-111 |
| `creatorAgentId` set by send-task | `src/tools/send-task.ts` | 145 |
| `parentTaskId` defaults to caller's sourceTaskId | `src/tools/send-task.ts` | 173 |
| Status values (Zod enum) | `src/types.ts` | 5-17 |
| Source values (Zod enum) | `src/types.ts` | 81-94 |
| Source CHECK constraint dropped | `src/be/migrations/056_drop_agent_tasks_source_check.sql` | 1-9 |
| `agent_log` table definition | `src/be/migrations/001_initial.sql` | 113-122 |
| `agent_log` eventType enum | `src/types.ts` | 705-732 |
| `session_logs` table definition | `src/be/migrations/001_initial.sql` | 168-177 |
| Session log write path (adapter) | `src/providers/claude-adapter.ts` | 604-612 |
| Session log write path (runner) | `src/commands/runner.ts` | 3094-3112 |
| Session log write path (DB) | `src/be/db.ts` | 4542-4569 |
| Auto follow-up creation | `src/tasks/worker-follow-up.ts` | 63-141 |
| Follow-up: `source="system"` | `src/tasks/worker-follow-up.ts` | 134 |
| Follow-up: `taskType="follow-up"` | `src/tasks/worker-follow-up.ts` | 135 |
| Follow-up: `parentTaskId` = worker task id | `src/tasks/worker-follow-up.ts` | 136 |
| Follow-up call from store-progress | `src/tools/store-progress.ts` | 449-454 |
| Follow-up call from HTTP finish | `src/http/tasks.ts` | 677-682 |
| Follow-up guard conditions | `src/tasks/worker-follow-up.ts` | 70-78 |
| Lead delegation contract | `src/prompts/session-templates.ts` | 43-115 |
| "coordinator, NOT a worker" rule | `src/prompts/session-templates.ts` | 49 |
| Decision guide | `src/prompts/session-templates.ts` | 72-77 |
| Follow-up handling rule | `src/prompts/session-templates.ts` | 88-91 |
| `createTaskExtended` (INSERT logic) | `src/be/db.ts` | 2945, 3087-3146 |
| Status resolution in createTaskExtended | `src/be/db.ts` | 2948-2954 |
| `task_created` log event | `src/be/db.ts` | 3152 |
| `modelTier` column | `src/be/migrations/090_model_tiers.sql` | 1 |
| `followUpConfig` column | `src/be/migrations/079_task_followup_config.sql` | 1 |
| JudgeContext interface | `evals/src/types.ts` | 374-387 |
| SwarmTask interface (open-ended `[key: string]: unknown`) | `evals/src/types.ts` | 397-409 |
| DeterministicCheck interface | `evals/src/types.ts` | 170-179 |
| OutcomeSpec v2 (gates + dimensions) | `evals/src/types.ts` | 224-240 |
| Existing scenario model (`distributed-audit.ts`) | `evals/scenarios/distributed-audit.ts` | 204-346 |
| Existing deterministic helpers | `evals/src/judge/deterministic.ts` | 1-509 |
