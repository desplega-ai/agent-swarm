# Workflows runbook

Workflows are DAGs of nodes connected via `next`. Reference for authoring nodes with the `create-workflow` tool.

## Cross-node data access

Upstream outputs are **not** available by default. Declare an `inputs` mapping:

- Keys are local names for `{{interpolation}}`.
- Values are context paths (usually a node ID).
- Agent-task output shape is `{ taskId, taskOutput }`, so access via `localName.taskOutput.field`.
- For trigger data: `{ "pr": "trigger.pullRequest" }` → `{{pr.number}}`.

Without `inputs`, upstream references silently resolve to empty strings — check `diagnostics.unresolvedTokens`.

## Structured output

Schema goes in `config.outputSchema` (not node-level). The agent produces JSON matching it; validated by `store-progress`.

## Large artifact handoffs

Agent-task nodes should not pass large raw artifacts directly into later LLM prompts. If a node writes a full debug/audit artifact such as a commit context, trace bundle, scrape result, or report dataset, it should also write a slim prompt artifact and return both paths:

```json
{
  "contextPath": "release-runs/2026-06-08/context.json",
  "contextSlimPath": "release-runs/2026-06-08/context-slim.json"
}
```

Downstream LLM nodes should read the slim path:

```bash
agent-fs --org <org-id> cat {{context.taskOutput.contextSlimPath}}
```

Keep the full path for audit/debugging only. Add an explicit prompt guard such as "Do not read `{{context.taskOutput.contextPath}}` unless a human asks for it." This prevents high-volume weeks from turning a normal structured-output task into a context-overflow failure before the agent can call `store-progress`.

Recommended slim commit shape:

```json
{
  "commits": [
    {
      "hash": "abc123...",
      "shortHash": "abc123",
      "author": "Name",
      "date": "2026-06-08",
      "message": "feat: add workflow run waterfall",
      "files": ["src/workflows/engine.ts", "apps/ui/src/pages/workflow-runs/[id]/page.tsx"]
    }
  ],
  "commitCountTotal": 70,
  "commitCountIncluded": 70,
  "truncated": false
}
```

Do not include patch bodies, diff hunks, raw `git log --stat` output, downloaded HTML, or other bulk text in the slim artifact. Cap arrays before prompt ingestion; for release-note workflows, 150 commits is a reasonable default.

## Interpolation

`{{path.to.value}}` in any string field inside `config`. Objects get JSON-stringified; nulls become empty strings.

## Agent-task config fields

- `template` (required)
- `outputSchema`
- `agentId`
- `tags`
- `priority` (0–100, default 50)
- `offerMode`
- `dir`
- `vcsRepo`
- `model`
- `parentTaskId`

## Script node types

There are two script-oriented workflow nodes:

- `script` runs inline `bash`, `ts`, or `python` source embedded directly in the workflow definition.
- `swarm-script` runs a TypeScript script from the reusable swarm catalog (`scripts` table). Use this when the logic should be shared across agents or reused by multiple workflows.

### `script` config

- `runtime` (required): `bash`, `ts`, or `python`.
- `script` (required): inline source to execute.
- `args`: optional string arguments passed to the script.
- `cwd`: optional working directory.
- `timeout`: optional wall-clock timeout in milliseconds, minimum `1000`; defaults to `30000`. This value applies to both the inline script executor and the workflow step watchdog.

### `swarm-script` config

- `scriptName` (required): catalog script name.
- `scope`: optional `agent` or `global`. If omitted, workflow execution tries the workflow creator's agent scope first, then global.
- `pinHash`: optional script content hash. When set, execution uses the matching `script_versions` row instead of the latest live source.
- `args`: optional JSON object passed to the script as its first argument. Values support normal workflow interpolation.
- `fsMode`: optional, defaults to `none`. `workspace-rw` is reserved for v2 worker-side execution and fails in v1 with a clear workflow-node error.
- `timeoutMs`: optional wall-clock timeout in milliseconds. Defaults to `30000` (30s), accepts integers from `1000` through `60000`, and applies both to the workflow step timeout and the scripts-runtime `wallClockMs` resource budget.

Agent-scoped lookup uses the workflow's `createdByAgentId`. If a workflow has no creator, `trigger.agentId` is accepted as a fallback; otherwise only global scripts can be resolved.

`timeoutMs` controls elapsed wall-clock time, not CPU time. The scripts runtime also applies its resource caps: the default wall-clock budget is 30s, and the subprocess has a 60s CPU-time ulimit. Raising `timeoutMs` above 30s gives I/O-bound or waiting scripts more elapsed time, but CPU-bound scripts can still be terminated by the 60s CPU ulimit before the wall-clock timeout fires. The schema caps `timeoutMs` at 60s so workflows cannot request more elapsed time than the current CPU ceiling can coherently support.

Example:

```yaml
- id: parse
  type: swarm-script
  inputs: { issue: "trigger.linearIssue" }
  config:
    scriptName: parse-linear-issue
    args: { issue: "{{issue}}" }
    pinHash: "b7a0..."
    timeoutMs: 45000
```

Downstream nodes read the executor output from the node ID. The script's return value is under `result`, so an `inputs` mapping usually points at `parse.result.someField`.

## Trigger schema

`triggerSchema` is an optional JSON Schema attached to a workflow that validates the `triggerData` payload for every trigger path — manual `/trigger`, webhooks, schedules, and MCP `trigger-workflow`. When set, mismatched payloads are rejected before the workflow starts (no run is created, no nodes execute). When unset (the default), any payload is accepted.

Use one when you want to fail fast and self-document the contract a webhook or upstream caller is expected to honor (e.g. "this workflow needs `pr.number`").

### Supported subset

The validator (`src/workflows/json-schema-validator.ts`) supports a deliberately minimal JSON-Schema subset:

- `type` — `"object"`, `"string"`, `"number"`, `"boolean"`, `"array"`
- `required` — array of required property names (objects only)
- `properties` — map of property name → schema (recursive)
- `enum` — array of allowed primitive values (strict equality)
- `const` — a single allowed value (strict equality)
- `items` — schema applied to every element of an array (recursive)

**All other keywords (`oneOf`, `anyOf`, `$ref`, `pattern`, `format`, `additionalProperties`, …) are silently ignored.** Authoring tools should surface this caveat near the editor, and reviewers should reject schemas that depend on unsupported keywords for correctness.

### Setting `triggerSchema`

| Surface | Method | Body field | `null` clears? |
|---|---|---|---|
| MCP | `create-workflow` | `triggerSchema?: object` | n/a (omit = none) |
| MCP | `update-workflow` | `triggerSchema?: object \| null` | yes |
| MCP | `patch-workflow` | `triggerSchema?: object \| null` | yes |
| HTTP | `POST /api/workflows` | `triggerSchema?: object` | n/a |
| HTTP | `PUT /api/workflows/{id}` | `triggerSchema?: object \| null` | yes |
| HTTP | `PATCH /api/workflows/{id}` | `triggerSchema?: object \| null` | yes |

Semantics: `undefined` / omitted = leave unchanged, object = set/replace, `null` = clear. Identical across all three update surfaces.

### How errors surface

When a trigger payload fails validation the engine throws `TriggerSchemaError` (`src/workflows/engine.ts:31-36`) carrying the per-field validator output. Each surface formats it differently but the underlying `details: string[]` array is identical:

**HTTP** — both `POST /api/workflows/{id}/trigger` and `POST /api/workflows/webhooks/{id}` return `400 Bad Request` with the frozen body shape:

```json
{
  "error": "TriggerSchemaError",
  "message": "Trigger schema validation failed: root: missing required property \"pr\"",
  "details": ["root: missing required property \"pr\""]
}
```

`details` is the array returned by `validateJsonSchema()` — one string per failing field, prefixed with the dotted path (e.g. `pr.number: expected type "number", got string`). The helper that writes this body lives at `src/http/utils.ts` (`triggerSchemaErrorResponse`).

**MCP** — `trigger-workflow` returns `success: false` with structured content alongside a human-readable bulleted message in `content[0].text`:

```json
{
  "success": false,
  "message": "Trigger payload did not match the workflow's triggerSchema (1 error).",
  "validationErrors": ["root: missing required property \"pr\""],
  "triggerSchema": { "type": "object", "required": ["pr"], "properties": { ... } }
}
```

The echoed `triggerSchema` lets agents self-correct without a follow-up `get-workflow` call. Generic non-validation failures still flow through the existing `Failed: ${err}` path.

### Cross-references

- Validator implementation + supported subset: `src/workflows/json-schema-validator.ts`
- Engine throw site: `src/workflows/engine.ts:31-36` (`TriggerSchemaError` class) and `:54-60` (validation gate)
- HTTP 400 helper: `src/http/utils.ts` (`triggerSchemaErrorResponse`)
- MCP error formatting: `src/tools/workflows/trigger-workflow.ts` (`TriggerSchemaError` branch)

## Wait nodes

A `wait` node pauses a workflow until either a duration elapses or a named event satisfies a filter. It is async — the run transitions to `waiting` and resumes via the `wait-poller` (time mode + event-mode timeout) or the `workflowEventBus` listener (event mode).

### Modes

**Time mode** — pause for `durationMs`:

```yaml
- id: cool-down
  type: wait
  config: { mode: time, durationMs: 86400000 }   # 24h
  next: { default: downstream-node }              # or simply: next: downstream-node
```

`durationMs` accepts integers from `1` (1ms) to `31_536_000_000` (1 year). The **effective minimum** is ~5s — the wake-up poller ticks every 5s, so anything shorter still works but is rounded up to the next tick. There is no practical upper bound; the run just stays `waiting` until either the wake-up fires or the workflow is cancelled.

**Event mode** — pause until a named event arrives whose payload satisfies a filter:

```yaml
- id: pr-merged
  type: wait
  config:
    mode: event
    eventName: github.pull_request.merged
    filter: { number: "{{trigger.pr.number}}" }
    scope: run                       # 'run' (default) | 'global'
    timeoutMs: 86400000              # 24h — when reached, routes via 'timeout' port below
  next:
    event:   downstream-on-event
    timeout: downstream-on-timeout
```

`timeoutMs` accepts integers from `1` to `31_536_000_000` (1 year). Effective resolution is ~5s (poller cadence). Omit it for an unbounded wait (no `timeout` port needed).

`scope` semantics:

- `scope: run` (default): the listener requires the payload to carry `_runId` or `workflowRunId` matching this run's id. Run-scoped HTTP signals inject `_runId` automatically; built-in lifecycle events (`task.completed` and friends emitted from `src/be/db.ts`) already include `workflowRunId` in their payload, so they correlate naturally.
- `scope: global`: skip the run-id check. Use for cross-run signals (e.g. `release.cut` broadcasts).

### Output ports

- Time mode → `default` only.
- Event mode without timeout → `event`.
- Event mode with timeout → `event` (signal arrived) or `timeout` (`expiresAt` reached first).

### Signal endpoints

External callers can fire arbitrary events into the bus via two HTTP routes (both auth via `Authorization: Bearer ${API_KEY}`):

```bash
# Run-scoped: payload is augmented with { ..., _runId: "<runId>" } before emit.
curl -X POST http://localhost:3013/api/workflow-runs/<run-id>/events \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{ "name": "demo.signal", "payload": { "ok": true } }'

# Global broadcast: payload is emitted as-is. Wait nodes with scope: global can match.
curl -X POST http://localhost:3013/api/workflow-events \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{ "name": "release.cut", "payload": { "version": "1.2.3" } }'
```

### Built-in event names (no extra wiring required)

The following events are already emitted on `workflowEventBus` today and are usable from a wait node out of the box:

| Event | Source | Payload highlights |
|---|---|---|
| `task.completed` / `task.failed` / `task.cancelled` | `src/be/db.ts` (around the `completeTask`/`failTask`/`cancelTask` paths) | `{ taskId, output|failureReason, agentId, workflowRunId, workflowRunStepId }` |
| `task.created` / `task.progress` / `task.budget_refused` | `src/be/db.ts` | task-id keyed lifecycle payloads |
| `approval.resolved` | `src/http/approval-requests.ts:183` | `{ requestId, status, responses, workflowRunId, workflowRunStepId }` |
| `agentmail.message.received` | `src/agentmail/handlers.ts:168` | inbox/message keyed payload |
| `github.pull_request.<action>` | `src/http/webhooks.ts:177` | full GitHub PR payload |
| `github.issue.<action>` | `src/http/webhooks.ts:192` | GitHub issue payload |
| `github.issue_comment.created` | `src/http/webhooks.ts:202` | comment payload |
| `github.pull_request_review.submitted` | `src/http/webhooks.ts:211` | review payload |
| `gitlab.merge_request.<action>` | `src/http/webhooks.ts:294` | full GitLab MR payload |
| `gitlab.issue.<action>` | `src/http/webhooks.ts:308` | GitLab issue payload |
| `gitlab.note.created` | `src/http/webhooks.ts:318` | note payload |
| `gitlab.pipeline.<status>` | `src/http/webhooks.ts:327` | pipeline payload |

For `task.completed` specifically, the canonical payload shape lives in `src/be/db.ts` next to the emit site. Because it includes `workflowRunId`, you can use a `scope: run` wait with a filter like `{ workflowRunId: "<the run id>" }` to correlate against a specific upstream task — see "Ordering caveat" below.

### What's NOT yet on the bus

The following sources do **not** currently emit on `workflowEventBus`. Hooking each one in is a one-line `workflowEventBus.emit(name, payload)` follow-up in the relevant handler — tracked as separate plans:

- Slack messages (`src/slack/`)
- Linear webhooks (`src/linear/`, `src/http/trackers/linear.ts`)
- Jira webhooks (`src/jira/`, `src/http/trackers/jira.ts`)
- Sentry alerts
- Stripe events
- Claude-managed callbacks

Until those land, fire signals manually via the HTTP endpoints above.

### Filters (event mode)

The `filter` field accepts two shapes:

**Object form (recommended)** — flat key/value map. Each key may use dot-paths into the payload; values must deep-equal:

```yaml
filter:
  number: 4242
  pr.author.login: alice
```

No `eval` risk, declarative, easiest to author. Missing keys → no-match. Type mismatch (string vs number) → no-match. Multiple keys must all match. Omitting `filter` matches any payload that satisfies the scope check.

**String form (escape hatch)** — JS arrow-function source:

```yaml
filter: "(payload) => payload.labels.some(l => l.name === 'release') && payload.number > 1000"
```

Compiled with `new Function(...)` inside a sandbox that shadows `require`, `process`, `Bun`, `globalThis`, `global`, `fetch`, `setTimeout`, `setInterval`, `eval`, `Function`, `AsyncFunction` to `undefined`. Result is coerced to boolean. Throws → no-match.

Hardening (all enforced):

- 50ms execution timeout — infinite loops and catastrophic-backtracking regex resolve to no-match.
- 2KB cap on filter source length (rejected at the Zod boundary).
- Parsed at executor-init time so syntax errors fail the workflow definition, not the first event.

Prefer the object form unless the predicate genuinely needs JS (multi-clause boolean logic, array membership, etc.).

### Ordering caveat

A wait node must subscribe to its event **before** the event fires. Chaining a wait directly off the upstream that emits the awaited event:

```yaml
# DOES NOT WORK — by the time execution reaches `wait`, `task.completed`
# has already been delivered to current listeners and is gone.
- id: t1
  type: agent-task
  next: w1
- id: w1
  type: wait
  config: { mode: event, eventName: task.completed }
```

…will hang forever, because the wait subscriber is only created after the upstream task completes, and the bus event is one-shot.

Two valid patterns:

1. **Fan-out** — branch the wait off an earlier node so the wait registers concurrently with the work that emits the event:

   ```yaml
   - id: entry
     type: script
     config: { runtime: bash, script: "echo go" }
     next: [t1, w1]                      # parallel
   - id: t1
     type: agent-task
     next: done
   - id: w1
     type: wait
     config:
       mode: event
       eventName: task.completed
       filter: { workflowRunId: "{{trigger.runId}}" }
     next: { event: done }
   - id: done
     type: notify
     config: { template: "both done" }
   ```

2. **External signal** — wait for an event whose source is downstream/external (HTTP `POST` to the signal endpoints, GitHub webhook, etc.). Subscription happens at the wait and the signal arrives later from outside.

### Multi-instance limitation

`workflowEventBus` is an in-process `EventEmitter` (`src/workflows/event-bus.ts`). With multiple API replicas, a signal emitted on instance A will not reach a wait paused on instance B. Single-instance only for v1; cross-instance fan-out (Redis pub/sub, etc.) is a separate plan.
