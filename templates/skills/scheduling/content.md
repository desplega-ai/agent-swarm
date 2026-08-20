# Scheduling

Use a schedule when work repeats on a clock, or when it must run once at a later time. On each tick the schedule creates one run. The run is a workflow, a catalog script, or an agent task.

## Tools

`list-schedules`, `create-schedule`, `update-schedule`, `patch-schedule`, `delete-schedule`, `run-schedule-now`. They are deferred. Load them with your harness tool search before the first call.

## Pick the target type

| The tick should | `targetType` | Required fields |
|---|---|---|
| Start a workflow | `workflow` | `workflowId` |
| Run a catalog script | `script` | `scriptName`, optional `scriptArgs` |
| Put a reasoning agent in the loop | `agent-task` (default) | `taskTemplate` |

Choose `agent-task` only when the run needs judgment, open-ended work, or tool orchestration that no workflow or script covers. An `agent-task` whose template says "trigger workflow X" or "run script Y" is wrong: use the direct target instead.

The agent-task fields `targetAgentId`, `model`, `modelTier`, `taskTemplate`, `priority`, and `tags` do not apply to workflow or script targets. Workflow cooldowns still gate workflow targets.

## Pick the timing

| Shape | Fields |
|---|---|
| Recurring on a cron | `scheduleType: "recurring"`, `cronExpression` (for example `0 9 * * 1-5`), `timezone` (default `UTC`) |
| Recurring on an interval | `scheduleType: "recurring"`, `intervalMs` (for example `3600000` for hourly) |
| Once, at a time | `scheduleType: "one_time"`, `runAt` (ISO datetime) |
| Once, after a delay | `scheduleType: "one_time"`, `delayMs` |

Give the schedule a unique `name` and a one-line `description` that says what a human gets from it.

## Write the task template (agent-task target)

The template is the whole task the agent receives. It must state:

- the goal and the inputs (IDs, repo, channel),
- where the result goes (a page, agent-fs, a Slack thread, a task output),
- what done looks like.

`targetAgentId` pins the task to one agent. Omit it to use the pool. `modelTier` (`smol`, `regular`, `smart`, `ultra`) is the portable way to pick a model. `model` is a provider-specific override.

Tasks created by a schedule are automatic tasks. Their completed output is not stored as memory unless the agent calls `store-progress` with `persistMemory: true`.

## Secrets

A `taskTemplate` and `scriptArgs` are stored as plain text and replayed on every run. They must not contain a token, password, or key. Call the external API from a script through a registered connection or a credential binding instead. See the `swarm-scripts` skill, section Secrets.

## Verify before you leave

1. `run-schedule-now` once and read the run result.
2. `list-schedules` with `name` to confirm `nextRunAt` and `enabled`.
3. For a script target, the script must exist at global scope: `script-search` by name.

## Repair a failing schedule

`list-schedules` with `lastRunStatus: "failed"` or `consecutiveErrorsMin: 3` lists the failing ones. Fix the cause, then `run-schedule-now` to confirm. A schedule you cannot fix now: `patch-schedule` with `enabled: false` and say so in your task output. A second schedule next to a broken one is not a fix.

## Related skills

- `scheduled-task-resilience`: waiting on CI, builds, deploys, or other slow jobs inside a scheduled task.
- `swarm-scripts`: writing the script a `script` target runs.
- `workflow-iterate`: building and testing the workflow a `workflow` target starts.
