# Heartbeat runbook

Lead only. The heartbeat runbook is your `heartbeatMd` profile field. The server reads it on every checklist tick, every 30 minutes by default (`HEARTBEAT_CHECKLIST_INTERVAL_MS`).

## How the heartbeat works

- `heartbeatMd` has content: the server creates a `heartbeat-checklist` task with the current system status and a snapshot of your runbook. It skips the tick while you still have an open checklist task.
- `heartbeatMd` is empty, or holds only headers and comments: no checklist task, no cost.
- After a server restart: a `boot-triage` task arrives about 90 seconds later, only when the restart cut off work or left failures, orphans or superseded tasks to check. A clean boot creates none.
- The system status is gathered for you. You never create a checklist or boot-triage task yourself.
- The runbook text is part of every checklist task prompt. Every line you keep costs tokens on every tick.

Edit the runbook with a native Edit of its mirror `/workspace/HEARTBEAT.md`. The PostToolUse hook PUTs the file to the `heartbeatMd` field. An edit to any of the four mirrors (`SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`) PUTs all four, so an `update-profile` write to `heartbeatMd` is overwritten by the stale mirror the next time you edit one of them in the same session. The hook logs a refused write (for example a 400 from the tracked-item date check) to stderr only, so verify every edit by DB anchor: `SELECT instr(heartbeatMd, '<fragment of the new line>') FROM agents WHERE id = '<your agent id>'`. A 0 means the write was refused: PUT `{"heartbeatMd": <file text>}` to `$MCP_BASE_URL/api/agents/$AGENT_ID/profile` with `Authorization: Bearer $API_KEY` and `X-Agent-ID: $AGENT_ID` to read the error, fix the line, and re-check.

## Shape of the runbook

Two kinds of sections:

- Reference sections, not capped: Standing Orders, Governance, Playbook index. Evergreen rules and pointers.
- Tracked sections, capped: Active Blockers, Watch Items, Open Discussion. Live items with an end.

## The cap

- Tracked items across all tracked sections: 10. Absolute maximum 20, only during a real surge.
- Every tracked item states its lift trigger and a date. An item with no removal condition does not go in. Write the date as a bare `MM-DD` (`check 10-20`) or `DELETE MM-DD` for a past-date prune: those are the only forms the gate can see.
- Write an age trigger as a calendar date (opened date + N days), never as a day count computed at check time. A floored age fires a day late.
- Never arm a defer chain to re-check a tracked item. The next heartbeat already checks it. Defer only for work no scheduled pass owns.
- Incident detail goes to memory: `memory-store` at `swarm` scope, one line of pointer stays in the runbook.
- A tracked item that closes is deleted. First move its durable facts (the fix, the root cause, the rule it taught) to memory, then delete the whole line. Never strike it through or mark it done in place: a closed line is still loaded into every checklist task. Tracked lines are for live items only.
- At or over the cap: prune before you add, or instead of adding.
- Identify an item by its full leading text (marker, number, title), never by its number alone. Numbers repeat after pruning, so "delete item 278" can hit two items.
- A summary line that each sweep regenerates (a section header, a count) is a digest of the previous session. When it disagrees with an item, the item wins. Never cite the header as state.

## Handle a heartbeat-checklist task

0. Quiet check. Take the fast path when three things hold: every failed, stalled or reboot-interrupted task in the system status was already named in the previous heartbeat-checklist task's output (newest completed one via `get-tasks`); no mention has gone unanswered since the last heartbeat; and no tracked item in the task's runbook snapshot is at or past its date. On the fast path, run the two step 3 scripts. If they report nothing the previous heartbeat had not already triaged, complete with exactly one line, `Quiet. Same as <previousTaskId>: <N> failures (triaged), schedule-health <M>/<total>, controls ok.`, and skip steps 1, 2 and 4-7. A longer quiet output is a defect: no failure-set recap, no per-script bullets. Anything new means continue at step 1.
1. Read the latest runbook. The snapshot in the task may be stale.
2. Prune first. Check every tracked item against its lift trigger. Remove resolved, stale, and past-date items. A trigger tied to a pull request ("lift when #N merges") fires silently: read the state of every PR a trigger names. Merged means the lift fired, so act on it now. Closed without merge means the item is dead, so drop it.
3. Run the seeded scripts: `script-run` with name `schedule-health`, then `task-failure-audit`, both with `args: { days: 1, publishPage: false }`. They report failing schedules and failure clusters. Check any other standing order in the runbook yourself.
4. Read the system status and the script results for stalled tasks, idle workers next to open work, and anomalies.
5. Reboot-interrupted failures: the failure reason "Auto-failed by reboot sweep: worker session not found after server restart" means a restart cut the task off. For each one: `get-task-details` on the task, confirm a retry task tagged `reboot-retry` exists and moves, recreate the task when no retry exists and the work is still needed. Heartbeat and triage tasks get no retry. A worker crash outside a restart ("worker session not found" or "worker session heartbeat is stale" from the stall sweep) normally leaves a `superseded` task with a `resume` child instead; check that the child moves. None of these are "expected cleanup".
6. Act with your tools: create tasks, cancel stuck ones, post to Slack under the `slack-interaction` skill rules. Before you hand-write the output of a halted workflow node, read that run's `workflow_run_steps` for a queued retry or redrive of the same node. Pick one path and cancel the other first: a hand-write next to a pending retry becomes a duplicate write.
7. Update the runbook after pruning. Delete closed items as described in the cap; do not strike them through.
8. Complete the task with what you found and what you did. "All clear" is allowed only when no reboot-interrupted failure is untriaged and no standing order is actionable.

## Handle a boot-triage task

1. Prune first, as above.
2. Run the seeded triage: `script-run` with name `boot-triage`. It gathers recent real failures, stuck work on offline agents, orphaned pending or offered tasks, and superseded tasks with no resume child. Pass `repo` to also get the deploy PR context.
3. Reboot-interrupted work first: for each task listed, `get-task-details` on its retry, recreate a failed or stuck retry, cancel a retry nobody needs. Every item gets a verdict.
4. Supersede and resume: each `superseded` task from the last hour has a child with `taskType: "resume"` in a non-terminal status. A superseded task without one is lost work; recreate it.
5. Orphaned tasks: pending or offered tasks on offline workers are reassigned or cancelled.
6. Agents: every expected worker is online, or you name the missing ones.
7. Complete the task with the status of each reboot-interrupted task and the actions you took.

## The checklist gate

A gate script can run before each checklist tick and decide whether the tick needs you. It never runs for boot triage.

- `HEARTBEAT_CHECKLIST_GATE_SCRIPT` names a global script. Unset means the seeded `heartbeat-jev-gate` runs when a global `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` is set (an OpenRouter key behind an `OPENROUTER_BASE_URL` gateway does not count), or `CLOUDFLARE_API_TOKEN` (or `CLOUDFLARE_API_KEY`) with `CLOUDFLARE_ACCOUNT_ID`. `off` or an empty value turns the gate off.
- `heartbeat-jev-gate` sends a compact state (new failures, tracked items due or past their date, the previous checklist result, task and agent counts) to a SystemOne decision model, Jev or Clef (Clef only when it is the sole provider or `HEARTBEAT_JEV_GATE_PROVIDER=cloudflare`), and returns `{ quiet, reason, summary }`.
- `HEARTBEAT_CHECKLIST_GATE_MODE=shadow` (default): every checklist task is still created, tagged `heartbeat-gate:quiet`, `heartbeat-gate:wake` or `heartbeat-gate:error`. The prompt is unchanged. Handle the task as usual; your outcome is the check on the gate's verdict.
- `HEARTBEAT_CHECKLIST_GATE_MODE=enforce`: a quiet verdict skips the task. A wake verdict adds the gate's summary as a Gate Findings section. Enforce is opt-in; turn it on only after shadow tags agree with your own quiet outcomes.
- The gate fails open. A timeout (60 s), a script error or a malformed result is an `error` verdict, and the task is created in both modes.
- Preview a verdict with `script-run` on `heartbeat-jev-gate`, `args: { dryRun: true }`.
- The gate sees a tracked item as due when its line contains today's `MM-DD` as a bare token (`check 10-20`) or a `DELETE MM-DD` marker on or before today. A full `YYYY-MM-DD` date does not count: a line that only carries a re-verification stamp (`2026-10-20 ~10:45Z`) is invisible to the gate, so write the due date bare. A line with no date is invisible too, and a date already past is only caught through `DELETE MM-DD`, so the prune in step 2 still matters.

## Example standing orders

```markdown
## Standing Orders
- Stalled task (no progress for 45 min): read its last progress, steer it or cancel and recreate.
- Idle workers next to unassigned pool tasks: find out why the pool does not drain.
- Slack requests older than 1 hour without a task: create the task.

## Watch Items
- Linear webhook retries since 2026-08-18. Lift when zero retries for 48 h (check 08-22).
```
