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
- Wire inputs deliberately. Template-rendering nodes usually read from their `inputs` aliases, while condition/gate nodes may resolve paths against the raw workflow context. Verify the executor's behavior before relying on aliases in a condition.
- Keep schemas tight. If an agent-task has an `outputSchema`, include the expected JSON shape in the task prompt and route it to a worker/provider that is known to return structured output correctly.
- Prefer reusable script nodes for deterministic shared logic. Agent tasks are best for judgment, investigation, or work that genuinely needs an LLM.
- Scope parallel branches so they do not overwrite one another. Fan-out tasks should have separate context keys or branch-specific output fields.
- Make retry paths idempotent. A rerun should detect existing artifacts, comments, PRs, or notifications and update or skip them rather than duplicating work.

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
