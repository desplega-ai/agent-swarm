# Multi-Agent Orchestration Patterns in Agent Swarm

Agent Swarm is an open-source company operating system in which a lead agent delegates work to a team of worker agents. Delegation happens through tasks, which chain, fan out, wait for people, and resume after failure, and through workflows, which execute directed graphs of steps. This guide describes the five orchestration patterns those primitives support, with configuration examples taken from the codebase.

## Sequential delegation

Use sequential delegation when each step needs the result of the previous one: research, then drafting, then review, then merge. The next step must not start early, and it must see what the earlier step produced.

At the task level, the lead creates a task with `send-task` and lists earlier task IDs in `dependsOn`. A task with dependencies is never offered or claimable until every listed dependency is `completed`, and the gate checks for `completed` specifically, so a dependent cannot proceed on a failed parent. Direct assignment uses `agentId` with a `routingReason` and a routing note; omitting `agentId` puts the task in the pool instead. For continuity across steps, `parentTaskId` gives the child a bounded context preamble from the task chain, capped by `CONTEXT_PREAMBLE_MAX_TOKENS` (default 2000), and auto-routes to the same worker unless an `agentId` is given.

The `/mcp-user` ingress assigns each new user task directly to the online Lead. A busy Lead keeps the task pending until capacity returns. The call fails without creating a task when no Lead is online.

```
send-task(
  task: "Deploy to production",
  dependsOn: ["build-task-id", "test-task-id"]
)
```

Inside a workflow, `next` as a string chains one node to the next. A later node reads an earlier node's output only through an explicit `inputs` mapping; without it, templates referencing upstream nodes resolve to empty strings and the token is reported in run diagnostics. Inside a durable script workflow run, `ctx.step.agentTask` dispatches a swarm task and blocks until it reaches a terminal status, so a plan → review → implement chain waits at each step.

What it does not do automatically: a dependency that fails, is cancelled, or is superseded cascade-fails its dependents with a reason naming the blocked dependency, rather than leaving them blocked. The one exception is supersede: dependents that never started have the superseded id swapped for the resume task id, so they are not failed.

Go deeper: [Task Lifecycle](https://docs.agent-swarm.dev/docs/concepts/task-lifecycle) and [Workflows](https://docs.agent-swarm.dev/docs/concepts/workflows).

## Parallel execution

Use parallel execution when the subtasks are independent: several reviewers judging the same change, a list of items processed one per agent, or research fanned out across competitors. Wall time is bounded by the slowest branch, not the sum.

In a workflow, a `next` value given as an array fans out to several nodes at once, and the engine executes all pending nodes in parallel. Convergence is the mirror image: a node with several predecessors waits for all of them, and only for predecessors on edges actually taken. For list-shaped work, the `foreach` node creates one `agent-task` child per array item, waits for every child, and emits one aggregate result to its successors. In a durable script workflow run, `ctx.step.agentTask` calls inside `Promise.all` dispatch and wait concurrently. Outside workflows, a lead can send several `send-task` calls without `dependsOn`, and a later task waits for the set.

```yaml
- id: review-by-agent
  type: foreach
  inputs: { agents: "discover.result.agents" }
  config:
    over: "{{agents}}"
    itemKey: id
    body:
      type: agent-task
      config:
        agentId: "{{item.id}}"
        template: "Review the change as {{item.name}} (index {{index}})"
  next: summarize
```

What it does not do automatically: in `foreach` v1, the child body is limited to `agent-task`, all children fan out together, and a `concurrency` setting is rejected. One failed branch fails the whole run under the default `onNodeFailure: "fail"`; `"continue"` lets the remaining children finish and records failed entries in the aggregate next to `okCount` and `failedCount`, with the run marked completed and a partial-failure error when only some branches failed. Script runs cap agent tasks at `SCRIPT_RUN_MAX_AGENT_TASKS` (default 50) and end `aborted_limit` past it, and every parallel step needs its own label — a repeated literal label in a loop is rejected at launch.

Go deeper: [Workflows](https://docs.agent-swarm.dev/docs/concepts/workflows), [Script workflow runs](https://docs.agent-swarm.dev/docs/guides/script-workflow-runs), and the repo's [`runbooks/workflows.md`](https://github.com/desplega-ai/agent-swarm/blob/main/runbooks/workflows.md).

## Human-in-the-loop

Use a human gate when a step is irreversible or needs accountability: deploys, publishes, payments, plan sign-off. The standing advice in the playbooks is to gate the irreversible steps only, not every step.

The `human-in-the-loop` workflow node pauses the run until a person responds in the dashboard. It creates an approval request at `/approval-requests/{id}` and resumes on the matching `next` port: `approved`, `rejected`, or `timeout`. Questions can be approval, text, single-select, multi-select, or boolean, and they can be built at run time from an upstream node's output, with validation when the node runs. The `system-one-decision` node reuses the same executor through `humanReview`, sending only answers inside a confidence band to a person. From inside a task, the `request-human-input` tool creates an approval request and returns at once with the request id and URL; the answer arrives later as a follow-up task. Mid-flight correction works too: `steer-task` sends new instructions to a running task, `queue` delivering at the next turn boundary and `steer` interrupting, and the worker acknowledges with `accept-steer`. Agents may steer tasks they created, the lead may steer any task, and Slack thread replies can steer the lead's in-progress task.

```json
{
  "id": "approve-deploy",
  "type": "human-in-the-loop",
  "label": "Approve Deployment",
  "config": {
    "title": "Deploy to production?",
    "questions": [
      { "type": "approval", "label": "Approve this deployment?" },
      { "type": "text", "label": "Any notes?" }
    ]
  },
  "next": { "approved": "deploy", "rejected": "notify-rejected" }
}
```

What it does not do automatically: the node has no timeout unless you set one, the only timeout action is reject, and on expiry the run resumes on the `timeout` port. A request with no timeout is auto-cancelled after `APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS` days (default 7), and any workflow run it gates is cancelled with it. `request-human-input` never blocks the calling agent, and `humanInTheLoop` is stubbed in script workflows v1. A run is `rejected` only when an approval question is answered with a rejection, and `humanReview` requires a port map for `next`. Interrupt-mode steering depends on the harness: Claude Code, Codex, opencode, and Devin support queue only, while pi-mono and Claude Managed support steer, and under the default degrade policy an unsupported steer falls back to queue. Steering can be switched off with `STEERING_ENABLED=false`.

Go deeper: [Workflows](https://docs.agent-swarm.dev/docs/concepts/workflows), the [HITL gates playbook](https://docs.agent-swarm.dev/docs/playbooks/patterns/hitl-gates), and [Task steering](https://docs.agent-swarm.dev/docs/guides/task-steering).

## Error handling and retries

Use retries when a step can fail transiently — a flaky API, a rate limit, a worker that restarts mid-task — and use the failure policies to decide what one dead branch does to the rest of the run.

Any workflow node accepts a `retry` block as a node-level field. `maxRetries` defaults to 3, `strategy` to `exponential` (with `static` and `linear` as alternatives), `baseDelayMs` to 1000 and `maxDelayMs` to 60000; backoff is exponential with full jitter, and a retry poller runs every five seconds by default. When an `agent-task` step loses its worker, the heartbeat fails the task and the workflow dispatches a fresh one for the same step, restoring upstream outputs from checkpoints first. Definition-level `onNodeFailure` decides the blast radius once retries are spent: `"fail"` marks the run failed, while `"continue"` treats the failed node as completed with error output and hands downstream convergence nodes a `[FAILED: reason]` marker. A `validate` node checks a step's output and routes `pass` or `fail`, re-throwing rate-limit errors so the node's own retry policy backs off. `retry-workflow-run` re-runs a failed run, reconstructing the branch each completed step selected and never reviving a branch that was not taken. `system-one-decision` retries connection errors, 408, 429, and 5xx itself, so it takes no `retry` block. In script workflow runs, `failOnTaskFailure` defaults to throwing on a failed task; set it false to receive the failure and decide in code. Outside workflows, graceful shutdown pauses running tasks and resumes them on restart, and the heartbeat detects stalled tasks, pins recovery to the original agent, and escalates to the lead after `HEARTBEAT_RESUME_PIN_GRACE_MIN` minutes (default 10).

```json
  "retry": {
    "maxRetries": 3,
    "strategy": "exponential",
    "baseDelayMs": 1000,
    "maxDelayMs": 60000
  }
}
```

What it does not do automatically: a node with no `retry` block is never retried — the defaults apply only once the block is present. A cancelled task is never retried, and plain tasks carry no retry counter; their recovery comes from heartbeat resume and lead re-delegation, capped at `HEARTBEAT_MAX_RESUME_GENERATIONS` (default 3), after which the task is failed instead of escalated. `system-one-decision` never retries a 401, a 422, or an answer that fails validation. A failed or cancelled task cascade-fails its `dependsOn` dependents. `script` and `swarm-script` nodes are capped at five minutes; longer work belongs in `launch-script-run`.

Go deeper: [Workflows](https://docs.agent-swarm.dev/docs/concepts/workflows) and [Task Lifecycle](https://docs.agent-swarm.dev/docs/concepts/task-lifecycle).

## Stateful multi-step workflows

Use a stateful workflow when the process spans hours or days, must survive crashes and restarts, recurs on a schedule, or waits on an external event.

The workflow engine writes an atomic checkpoint to the database after every step and resumes from the last checkpoint on crash, storing each node's output in the run context under its node id. That context also carries the built-in `trigger`, `input`, `workflow`, `swarm`, and `run` values, plus upstream outputs declared through `inputs`. Loops are allowed, and iteration-aware idempotency keys give each pass its own checkpoint. A `wait` node pauses for a fixed time or until a workflow event arrives, with an optional timeout that resumes on the `timeout` port. Runs start from webhook, schedule, manual, or event triggers, and schedules can target an agent task, a workflow, or a script. Durable script workflow runs journal every `ctx.step.*` result by run id and label, replay completed steps on restart instead of re-running them, and resume polling the same task id when an `agentTask` wait was in flight. At the agent level, `defer-task` completes the current task and books one continuation for the same agent, with `wakeOn` waking it early when the tasks it watches settle.

```json
{
  "taskId": "<current-task-id>",
  "delayMs": 1800000,
  "wakeOn": { "event": "settled", "taskId": "<build-task-id>" },
  "summary": "Submitted the build; validation is pending.",
  "note": "Read the build result, then verify the deployment."
}
```

What it does not do automatically: upstream outputs are not available for interpolation unless you declare them in `inputs`. In script runs, a reused label replays the first journaled result — it means "same logical step", not "another step with the same name" — and the run ends `aborted_limit` past `SCRIPT_RUN_MAX_STEPS` (default 1000), `SCRIPT_RUN_MAX_AGENT_TASKS` (default 50), or `SCRIPT_RUN_MAX_WALL_MS` (default one day). Script runs are for one-off work; anything recurring, versioned, or operator-edited belongs in a workflow definition. `defer-task` needs a `delayMs` or `runAt` ceiling and rejects a set containing an already-terminal task. A scheduled automation with missing setup reports `needs_setup` and is skipped without retry, and a trigger that fires inside a workflow's cooldown window produces a `skipped` run.

Go deeper: [Workflows](https://docs.agent-swarm.dev/docs/concepts/workflows), [Script workflow runs](https://docs.agent-swarm.dev/docs/guides/script-workflow-runs), and [Scheduling](https://docs.agent-swarm.dev/docs/concepts/scheduling).
