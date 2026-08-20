# Heartbeat runbook

Lead only. The heartbeat runbook is your `heartbeatMd` profile field. The server reads it every 30 minutes.

## How the heartbeat works

- `heartbeatMd` has content: the server creates a `heartbeat-checklist` task with the current system status and a snapshot of your runbook.
- `heartbeatMd` is empty: no heartbeat, no cost.
- After a server restart: a `boot-triage` task arrives within about 30 seconds.
- The system status is gathered for you. You never create a checklist or boot-triage task yourself.

Edit the runbook with `update-profile` and the `heartbeatMd` field. `/workspace/HEARTBEAT.md` is a mirror of that field.

## Shape of the runbook

Two kinds of sections:

- Reference sections, not capped: Standing Orders, Governance, Playbook index. Evergreen rules and pointers.
- Tracked sections, capped: Active Blockers, Watch Items, Open Discussion. Live items with an end.

## The cap

- Tracked items across all tracked sections: 10. Absolute maximum 20, only during a real surge.
- Every tracked item states its lift trigger and a date. An item with no removal condition does not go in.
- Incident detail goes to memory: `memory-store` at `swarm` scope, one line of pointer stays in the runbook.
- At or over the cap: prune before you add, or instead of adding.

## Handle a heartbeat-checklist task

1. Read the latest runbook. The snapshot in the task may be stale.
2. Prune first. Check every tracked item against its lift trigger. Remove resolved, stale, and past-date items.
3. Run the seeded audit: `script-run` with name `Heartbeat Audit` and `args: { heartbeatMarkdown: <the runbook text> }`. It reports resolved stale PRs, pool-target risk schedules, schedule and provider failure clusters, and whether the daily blocker digest ran today.
4. Read the system status and the audit result for stalled tasks, idle workers next to open work, and anomalies.
5. Reboot-interrupted failures: a failure reason "worker session not found" or "worker session heartbeat is stale" means a server restart cut the task off. For each one: `get-task-details` on the task, confirm a retry task tagged `reboot-retry` exists and moves, recreate the task when no retry exists and the work is still needed. These are never "expected cleanup".
6. Act with your tools: create tasks, cancel stuck ones, post to Slack under the `slack-interaction` skill rules.
7. Update the runbook after pruning.
8. Complete the task with what you found and what you did. "All clear" is allowed only when no reboot-interrupted failure is untriaged and no standing order is actionable.

## Handle a boot-triage task

1. Prune first, as above.
2. Run the seeded triage: `script-run` with name `boot-triage`. It gathers the deploy PR context, recent real failures, stuck work on offline agents, orphaned pending or offered tasks, and superseded tasks with no resume child.
3. Reboot-interrupted work first: for each task listed, `get-task-details` on its retry, recreate a failed or stuck retry, cancel a retry nobody needs. Every item gets a verdict.
4. Supersede and resume: each `superseded` task from the last hour has a child with `taskType: "resume"` in a non-terminal status. A superseded task without one is lost work; recreate it.
5. Orphaned tasks: pending or offered tasks on offline workers are reassigned or cancelled.
6. Agents: every expected worker is online, or you name the missing ones.
7. Complete the task with the status of each reboot-interrupted task and the actions you took.

## Example standing orders

```markdown
## Standing Orders
- Stalled task (no progress for 45 min): read its last progress, steer it or cancel and recreate.
- Idle workers next to unassigned pool tasks: find out why the pool does not drain.
- Slack requests older than 1 hour without a task: create the task.

## Watch Items
- Linear webhook retries since 2026-08-18. Lift when zero retries for 48 h (check 2026-08-22).
```
