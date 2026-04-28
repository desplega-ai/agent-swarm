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
