# Workflow Iteration

Use this skill when you need to change an existing workflow without breaking live runs. The goal is to make small, verified revisions: inspect the current workflow, diagnose the failing step, patch only the required node or edge, trigger a realistic run, and keep iterating until the run reaches the intended terminal state.

## Core Loop

1. Read the workflow before changing it. Capture the current version, node IDs, inputs, config, and downstream dependencies.
2. Diagnose from a real run when possible. Inspect the failed step's recorded input and output; those fields show exactly what the executor saw.
3. Patch one concern at a time. Prefer a node-level patch over replacing the whole workflow.
4. Re-read after the patch. Confirm the version changed and the resulting config matches what you intended.
5. Trigger with a realistic payload. Include the fields downstream nodes expect, not only the field you are testing.
6. Watch the run to terminal state. If it fails, use that run as the next diagnostic input.
7. Mirror the verified change into your workflows-as-code source, if your deployment uses one.

## Authoring Rules

- Keep node IDs stable. Other nodes may reference them by exact string path.
- Treat `config` as replacement-prone. When a patch touches `config`, send the full config object for that node unless your workflow API explicitly deep-merges nested fields.
- Make routing explicit. Branching nodes should have named pass/fail routes, and silent skip paths should still produce an observable outcome when operators need to know what happened.
- Wire inputs deliberately. Node executors receive the raw workflow context plus resolved `inputs` aliases, so a condition can use either a local alias or a node-id-prefixed path. Confirm the chosen path against the recorded step input.
- Keep schemas tight. If an agent-task has an `outputSchema`, include the expected JSON shape in the task prompt and route it to a worker/provider that is known to return structured output correctly.
- Prefer reusable script nodes for deterministic shared logic. Agent tasks are best for judgment, investigation, or work that genuinely needs an LLM.
- Scope parallel branches so they do not overwrite one another. Fan-out tasks should have separate context keys or branch-specific output fields.
- Make retry paths idempotent. A rerun should detect existing artifacts, comments, PRs, or notifications and update or skip them rather than duplicating work.

### `swarm-script` Timeout Limit

- Keep `config.timeoutMs` at or below `300000` (5 minutes); the default remains `30000` (30 seconds).
- Workflow create, update, bulk-patch, and single-node patch operations validate executor config and reject an oversized value before saving it.
- For orchestration that needs more than 5 minutes, use a durable one-off script workflow run via `launch-script-run` and split the work into bounded, journaled `ctx.step.swarmScript` (or other durable) steps. Do not stretch a single `swarm-script` node beyond the cap.

## Node Contract Reference

Use these shapes as a starting point, then confirm them against the current executor schemas before patching a live workflow.

### `property-match`

```json
{
  "type": "property-match",
  "config": {
    "conditions": [
      { "field": "verdict", "op": "eq", "value": "publish" }
    ],
    "mode": "all"
  },
  "inputs": { "verdict": "review.taskOutput.verdict" },
  "next": { "true": "publish", "false": "stop" }
}
```

- Operators are `eq`, `neq`, `contains`, `not_contains`, `gt`, `lt`, and `exists`; `mode` is `all` by default or `any`.
- `field` resolves against the combined execution context. Both raw paths such as `review.taskOutput.verdict` and resolved aliases such as `verdict` are available.
- The executor returns `{ passed, results }` and routes on ports named `"true"` and `"false"`. The keys in `next` must match those port names.

### `agent-task` structured output

```json
{
  "type": "agent-task",
  "config": {
    "template": "Review the input and return the requested JSON object: {{draft}}",
    "outputSchema": {
      "type": "object",
      "properties": { "verdict": { "type": "string" } },
      "required": ["verdict"]
    }
  },
  "inputs": { "draft": "prepare.result" }
}
```

- Put the task contract in `config.outputSchema` and repeat the exact required shape in the task template. The worker must complete with `store-progress.output` set to a stringified JSON object matching it.
- The workflow step exposes `{ taskId, taskOutput }`; downstream paths therefore use `<node-id>.taskOutput.<field>`.
- Route only to an agent that exists and is eligible for the task's tools and output contract. Resolve the agent from the live agent registry instead of copying an ID from another workflow.

### `validate`

```json
{
  "type": "validate",
  "config": {
    "targetNodeId": "review",
    "schema": {
      "type": "object",
      "required": ["taskOutput"]
    }
  },
  "next": { "pass": "continue", "fail": "repair" }
}
```

`validate` checks the named upstream node output. Supply either `schema` for a deterministic structural check or `prompt` for a judgment-based check. Its output is `{ pass, reasoning, confidence }`, routed through `pass` or `fail`.

### `swarm-script`

```json
{
  "type": "swarm-script",
  "config": {
    "scriptName": "<catalog-script-name>",
    "args": { "repo": "{{trigger.repo}}" },
    "fsMode": "none",
    "timeoutMs": 30000
  }
}
```

- Confirm `scriptName` and scope in the live script catalog. Omit `scope` unless the workflow must force `agent` or `global`; an incorrect explicit scope prevents resolution.
- The script's return value is under `<node-id>.result`, not `.taskOutput`. The full node output also includes `stdout`, `stderr`, `truncated`, `durationMs`, `exitCode`, `scriptName`, `contentHash`, and `version`.
- Catalog scripts are synchronous/instant nodes; they do not require an agent assignment. They are deterministic only when the script itself is deterministic. Keep `fsMode` at `none` on runtimes that do not support workspace access.

## Cancellation and Dependencies

- Before re-triggering, cancel any still-running attempt for the same work. Reuse the original trigger payload so downstream dependencies receive the same fields.
- Check referenced agents, catalog scripts, downstream node IDs, and external resources before triggering. A syntactically valid workflow can still fail later when a named dependency is missing.
- A patch does not resume a previously halted run. Trigger a fresh verification run after the fix, then watch that new run to a terminal state.

## Common Failure Patterns

| Symptom | Likely Cause | Fix |
|---|---|---|
| A gate takes the wrong branch even though the upstream value looks correct | The condition path does not match the executor's context shape | Inspect the step input and use the exact upstream path the executor can resolve |
| Downstream prompt renders blank fields | Missing or wrong `inputs` mapping | Re-read the step input, then wire each template variable to a concrete source |
| A node loses its prompt, schema, or model after a small patch | Partial config patch replaced the full config | Restore from the previous version and resend the full node config |
| Structured-output task fails immediately | Worker did not return JSON matching `outputSchema` | Put the schema in the prompt and assign the task to a worker/provider validated for structured output |
| Parallel branches cancel, overwrite, or confuse each other | Shared context or shared output keys across sibling tasks | Give each branch its own context/output namespace and make writes branch-specific |
| A reusable script node completes but downstream fields are empty | Downstream node reads the wrong output shape | Inspect the script step output and reference the actual return path |

## Preflight Checklist

- Current workflow version has been read in this session.
- Every changed node has a clear before/after purpose.
- Inputs and condition paths match a real recorded step shape.
- Output schemas include only fields used downstream.
- Agent-task routing matches the task shape and required tools.
- Trigger payload includes all required fields.
- The verification run reached the intended outcome.
- The source-of-truth definition was updated after live verification.
