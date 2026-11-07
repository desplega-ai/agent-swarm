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

The agent-task fields `targetAgentId`, `profile`, `model`, `modelTier`, `taskTemplate`, `priority`, and `tags` do not apply to workflow or script targets. Workflow cooldowns still gate workflow targets.

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

`targetAgentId` pins the task to one agent. Omit it to use the pool. `profile` is the preferred way to pick a model: a named harness + model + effort (see `list-model-profiles`). With `targetAgentId`, the agent must pass the profile check (`check-model-profile`), or the save is refused. `model` is a provider-specific override. `modelTier` is deprecated: pass `profile: "<harness>-<tier>"` for the same model. `profile` is exclusive with `model` and `modelTier`; on update, setting one clears the other.

Tasks created by a schedule are automatic tasks. Their completed output is not stored as memory unless the agent calls `store-progress` with `persistMemory: true`.

## Use cases: one key for the schedule and its results

A recurring job that a person comes back to is a use case. Its planning session, the schedule, the runs, pages, and result files share one asset key, so the dashboard shows them as one Sessions group.

- The key is `shared/<slug>/`, or `personal/<user>/<slug>/` for private work. Agree the short slug with the requester, for example `shared/competitor-watch/`.
- `create-schedule` and `create-page` use the key of the calling task when that key is a use-case group. Otherwise pass `key` explicitly. Runs get the schedule's key.
- The task template tells each run to write its result under the key in the shared drive, for example `shared/competitor-watch/report-<YYYY-MM-DD>.md`, and to compare with the earlier reports in that folder.
- End the planning reply with the "lives in" line: `This use case lives in Sessions → competitor-watch: <APP_URL>/sessions?view=shared/competitor-watch/`.

### One-time ask or lasting change

In a use-case session, decide what the request changes:

- A request for one time only ("also check Acme today"): a normal task in the key. Do not change the schedule.
- A request that changes the future runs ("from now on also include pricing"): change the schedule. Read the current template with `list-schedules` (`key` is the use-case key), then call `update-schedule` with the full new `taskTemplate`:

```
update-schedule { scheduleId: "<id>", taskTemplate: "Research the 5 competitors in shared/competitor-watch/competitors.md. Include their pricing. Write shared/competitor-watch/report-<YYYY-MM-DD>.md and compare with the previous report." }
```

Then show the change as a `diff` block in your reply, and ask the requester to confirm it:

```diff
- Research the 5 competitors in shared/competitor-watch/competitors.md. Write shared/competitor-watch/report-<YYYY-MM-DD>.md and compare with the previous report.
+ Research the 5 competitors in shared/competitor-watch/competitors.md. Include their pricing. Write shared/competitor-watch/report-<YYYY-MM-DD>.md and compare with the previous report.
```

## Check back later

A task whose answer needs time (a build, a deploy, a reply) calls `defer-task` with `delayMs` or `runAt`, a `summary` of what you did so far, and a `note` that says what is pending. The tool completes the task and creates the one-off schedule for you. The task reaches its final state (`completed`) on this call, and the `summary` becomes its output. The wake-up task carries the deferred task as its parent, so you receive that task's context. Add `checks` to list what to verify on wake-up. Do not hand-roll this with `create-schedule`.

When waiting on tasks, include `wakeOn:{event:"settled",taskIds:["<id>"],mode:"all"}` alongside `delayMs` or `runAt`. The displayed time is a ceiling; matching task outcomes wake you sooner. The task whose outcome wakes you creates no separate follow-up for you; the wake-up task is where you review it. In `mode:"all"`, a member that settles while others are pending still creates its follow-up.

## Secrets

A `taskTemplate` and `scriptArgs` are stored as plain text and replayed on every run. They must not contain a token, password, or key. Call the external API from a script through a registered connection or a credential binding instead. See the `swarm-scripts` skill, section Secrets.

## Verify before you leave

1. `run-schedule-now` once and read the run result.
2. `list-schedules` with `name` to confirm `nextRunAt` and `enabled`.
3. For a script target, the script must exist at global scope: `script-search` by name.

## Repair a failing schedule

Schedules fail in two places. A schedule whose spawned tasks fail: `get-tasks` with `scheduleId` and `status: "failed"`. A schedule the scheduler could not dispatch at all: `list-schedules` with `lastRunStatus: "failed"` or `consecutiveErrorsMin: 1`; these errors back off and auto-disable after 5. The `list-schedules` filters never see spawned-task failures. Fix the cause, then `run-schedule-now` to confirm. A schedule you cannot fix now: `patch-schedule` with `enabled: false` and say so in your task output. A second schedule next to a broken one is not a fix.

## Related skills

- `scheduled-task-resilience`: waiting on CI, builds, deploys, or other slow jobs inside a scheduled task.
- `swarm-scripts`: writing the script a `script` target runs.
- `workflow-iterate`: building and testing the workflow a `workflow` target starts.
