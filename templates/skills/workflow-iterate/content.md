# Workflow Iterate Skill

The unified playbook for safely editing, triggering, debugging, and improving agent-swarm workflows. Compiled from real production incidents.

## The Iteration Loop (Always-On)

1. **READ** — `get-workflow` for current state and version. Never patch from memory.
2. **DIAGNOSE** — if a run failed, `get-workflow-run` and inspect both `input` AND `output` of the offending step.
3. **PATCH** — prefer `patch-workflow-node` (surgical, version-checked) over `update-workflow` (full replace). **Pass the FULL `config` object — see shallow-merge gotcha below.**
4. **VERIFY** — re-read the workflow. Confirm version bumped.
5. **TRIGGER** — `trigger-workflow` with the full trigger payload. Capture the run ID.
6. **WATCH** — `get-workflow-run` until terminal. If it fails again, jump back to step 2.
7. **POST-FIX RE-TRIGGER** — if the patch resolved a halted run, you MUST re-trigger in the same session.

## Node Types

| Type | Mode | Notes |
|---|---|---|
| `agent-task` | Async | Spawns a worker. Pin `config.agentId` to a claude-harness worker. |
| `swarm-script` | Instant | Runs a catalog script — no agent, no LLM. Output under `.result`, NOT `.taskOutput`. |
| `property-match` | Instant | Gate node. `inputs` is IGNORED — use literal node-id-prefixed field paths. |
| `script` | Instant | Inline bash/ts/python embedded in the workflow. |
| `raw-llm` | Instant | Direct LLM call. |
| `validate` | Instant | JSON schema validation on upstream output. |
| `notify` | Instant | Sends a notification. |

## Critical Gotchas

### `patch-workflow-node` Shallow-Merges at Config Level

**Confirmed incident:** A `config: {agentId: "..."}` patch WIPED the entire `template` + `outputSchema` + `model` block on affected nodes.

**Rule:** ALWAYS read the existing config first (`get-workflow`), then pass the FULL config object with only one field changed.

### `property-match` Ignores `inputs`

The `field` path is resolved against the **full raw workflow context** (node-id-keyed), NOT the `inputs`-mapped aliases.

**Working pattern:**
```json
"config": { "conditions": [{ "field": "await-error-pick.taskOutput.decision", "op": "eq", "value": "fix" }] },
"inputs": {}
```

**Wrong (does NOT work):**
```json
"inputs": { "decision": "await-error-pick.taskOutput.decision" },
"config": { "conditions": [{ "field": "decision", "op": "eq", "value": "fix" }] }
```

### `agent-task` Nodes: Pin `config.agentId`

When the template involves multi-tool reasoning or structured `outputSchema`, pin to a claude-harness worker:
- Picateclas `38d36438-...` — routine implementation
- Jackknife `c06cca59-...` — forward-deployed work
- Lead `d454d1a5-...` — Slack-posting nodes (lead-only privilege)
- Reviewer `a09d19a4-...` — review-shaped tasks
- Researcher `16990304-...` — research-shaped tasks

**Never pin `outputSchema`-bearing nodes to pi-harness workers** — they intermittently fail with `"Structured output required by outputSchema but not provided via store-progress"`.

### `swarm-script` Return Value Is Under `.result`, Not `.taskOutput`

```json
// In downstream agent-task inputs:
"inputs": { "prs": "list-prs.result" }
// NOT: "inputs": { "prs": "list-prs.taskOutput" }

// In property-match conditions:
"field": "list-prs.result.count"
// NOT: "field": "list-prs.taskOutput.count"
```

### Post-Shipping: Do NOT `ScheduleWakeup`. Complete and Exit.

If you shipped a PR and want to "wait for CI" via `ScheduleWakeup`, the heartbeat reaper treats your suspended session as dead. Once you've shipped, exit. See `scheduled-task-resilience` skill.

## `outputSchema` Contract

When you set an `outputSchema` on an `agent-task`, the runner validates the worker's `store-progress.output` against it. If the worker's output doesn't parse as matching JSON, the node fails.

As an author:
1. Embed the schema (or an "Output Format" JSON block) inside the `template` prompt.
2. Pin `config.agentId` to a claude/codex worker.
3. Workers should consult the `workflow-structured-output` skill for how to comply.

## Transparency Pattern

Gates (`property-match`) are silent — if the gate routes to "skip", the user sees nothing. Every decision-making node must post its reasoning to Slack BEFORE the gate evaluates.

## Post-Fix Re-Trigger Discipline

When you ship a fix to a halted run, the fix does NOT auto-rerun the halted iteration. You MUST either:
(a) Explicitly call `trigger-workflow` with the halted run's parameters, OR
(b) Record an explicit watch with a re-trigger condition.

Never assume "the schedule will pick it up" — schedules fire on their next cron tick with fresh inputs, not retries.

## Pre-flight Checklist Before Declaring a Workflow "Done"

- [ ] Every `agent-task` template's `{{tokens}}` resolve via `inputs` or `trigger.*`
- [ ] Every `agent-task` node has `config.agentId` set to a claude/codex worker
- [ ] Every `agent-task` with `outputSchema` embeds the schema in the `template` prompt
- [ ] No `agent-task` with `outputSchema` is pinned to a pi-harness worker
- [ ] Every `property-match` uses `field: "<node-id>.taskOutput.<key>"` (not a local alias)
- [ ] Every `property-match` has `inputs: {}` (explicit empty) and `next: {pass, fail}`
- [ ] Every `swarm-script` node's `scriptName` exists in the catalog
- [ ] Downstream nodes reading `swarm-script` output use `.result.*` not `.taskOutput.*`
- [ ] No `slack-post`/`slack-reply` inside a non-Lead `agent-task` template
- [ ] `patch-workflow-node` calls passed the FULL `config` object (not a subset)

## See Also

- **`workflow-structured-output`** — the worker-side counterpart. Use it when assigned an `agent-task` with an `outputSchema`.
