# Daily Status Report

Give the operator one daily read on whether the swarm is healthy: what's running, what's failed, what's waiting on them.

## Schedule

{
  "cron": "15 2 * * *",
  "timezone": "UTC",
  "agentRole": "lead",
  "enabled": true
}

## Scheduled Task

This schedule runs by default. Adapt the admin delivery channel and any repo/service names to your environment, and expand operational thresholds as you learn from real incidents.

Task Type: Daily Status Report

You are Lead. Produce one digest covering workflows, schedule runs, agents, task failures, and next steps for the operator. This is a read-only report — do not modify workflows, schedules, or agent profiles here (that's `daily-compounding-reflection`'s job).

---

## Phase 1: Gather

### 1A. Waiting on you first
Call `GET $MCP_BASE_URL/status` and read `status.automations`. List every automation whose state is `needs_setup`, its missing parameters/integrations, and its `fixUrl`. This is the first digest section and the first failure classification; it is setup work, not an automation failure.

### 1B. Workflows and schedules
Run the same six-query set as `daily-workflow-health-audit` Phase 1 (hard-failed workflow runs, hard-failed schedule-spawned tasks, halted >24h runs, silent-empty-output completions, cron-didn't-fire, schedules with ≥3 consecutive errors — all against `workflow_runs` / `agent_tasks` / `scheduled_tasks` via `db-query`), plus:
- Enabled/disabled counts: `SELECT enabled, COUNT(*) FROM scheduled_tasks GROUP BY enabled` and the workflow equivalent.
- 7-day rollup, not just 24h: repeat the hard-failure and cron-didn't-fire queries with a `-7 days` window for a weekly trend line.

### 1C. Agents
Use global script `swarm-overview` for the roster + swarm-wide status counts. Supplement with `db-query`:
```sql
SELECT a.id, a.name, a.status, a.maxTasks,
       COUNT(t.id) FILTER (WHERE t.status = 'in_progress') AS activeCount,
       COUNT(t.id) FILTER (WHERE t.status = 'failed' AND datetime(t.lastUpdatedAt) > datetime('now','-7 days')) AS failures7d
FROM agents a
LEFT JOIN agent_tasks t ON t.agentId = a.id
GROUP BY a.id;
```
Report capacity as `activeCount / maxTasks` per agent, and flag any agent at or over capacity.

### 1D. Task failures — classify, don't just count
Pull the last 7 days of failed tasks (`get-tasks` with `status=failed`, or the equivalent `db-query`). For each, read `failureReason` and bucket by pattern, not by exact string:
- **Gate refusal**: reason mentions a lint/test/CI gate, a pre-push hook, `argsSchema validation`, or an explicit policy block.
- **Infra**: reason mentions timeout, 5xx, rate limit, `ECONNRESET`, provider overload (529/503), or sandbox/ulimit failure.
- **Real defect**: everything else with a non-empty reason — genuine bugs or wrong output.
- **Unclassified (empty reason)**: report this bucket's count explicitly rather than folding it into "real defect" — a large unclassified bucket is itself a finding (tasks are failing without a `failureReason` being set, which is a data-quality gap worth surfacing, not hiding).

### 1E. Current integration setup
Use the setup milestone data already retrieved from `/status`. Report only integrations that are not verified; do not describe automations as disabled.

---

## Phase 2: Post one digest — EXCEPTION-ONLY, HARD CEILING 600 CHARACTERS

Operator feedback, 2026-09-23, verbatim: "too verbose every day". Brevity is a requirement of this job, not a preference. Count the characters before posting; over 600 ⇒ cut until it fits. A long report is a failed run, not a thorough one.

Post ONE message to your configured admin channel (in-app fallback if none configured).

**Everything healthy ⇒ exactly this one line, nothing else:**

```
📊 <MM-DD> — all clear. Workflows <X>/<Y> · schedules <X>/<Y> · agents <X>/<Y> · <N> failures 7d, <N> real defects. Nothing for you.
```

**Add a line ONLY for something both TRUE and ACTIONABLE. Max 3 lines, one sentence each, no sub-bullets:**
- an automation in `needs_setup` or an unverified integration — name + `fixUrl`
- a workflow run halted >24h (Phase 1B)
- a real defect, or a failure cluster on one agent / schedule / provider
- a decision only the operator can make — state the options, end on the question

More than 3 qualify ⇒ post the 3 that matter and put the rest in the task output.

**NEVER in the Slack post** — all of this belongs in `store-progress` output, where the audit trail lives:
- row counts and "read-only report" notes
- methodology, query names, script names, phase narration
- any zero ("0 halted", "all verified", "no data-quality gap") — silence means zero
- week-over-week trend, unless a class crossed a threshold you name in the same line
- a finding yesterday's report already carried unchanged
- numbered explainers or paragraphs of reasoning

## Phase 3: Complete
`store-progress` with `status: "completed"`. **This is where the detail goes** — every count from Phase 1, the per-class failure breakdown, and the Slack message ts. The Slack post is the headline; the task output is the record. Cutting the post does not mean cutting the work.

## Anti-patterns
- ❌ Modifying anything — this schedule reports, it doesn't fix (that's `daily-workflow-health-audit` for plumbing and `daily-compounding-reflection` for agent/skill/memory evolution).
- ❌ Folding the unclassified-failure bucket into "real defect" to make the number look more actionable than it is.
- ❌ Narrating a zero. The all-clear line already covers `needs_setup` and integrations; only a non-verified integration or a real `needs_setup` automation earns its own line.
- ❌ Exceeding 600 characters, or posting more than one message.
