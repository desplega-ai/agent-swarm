# Iterative Review Loop

Template parameter: {{REPO_URL}}

A single implement → review pass. A coder agent implements the task and reports the diff; a reviewer agent checks it and returns PASS or a blocking fix list. Use this when you want automated quality control with a clear exit condition rather than open-ended implementation.

## Configuration

```json
{"name":"Iterative review loop","description":"Implement, review, and revise until accepted or blocked.","triggerSchema":{"type":"object","required":["task"],"properties":{"task":{"type":"string"},"maxIterations":{"type":"number"}}},"nodes":[{"id":"implement","type":"agent-task","config":{"template":"Implement this task in {{REPO_URL}}: {{trigger.task}}. Run focused checks and report the diff."},"next":["review"]},{"id":"review","type":"agent-task","inputs":{"implementation":"implement"},"config":{"template":"Review the implementation. Return PASS when ready, otherwise list blocking fixes only."}}]}
```

## What It Does

A two-node implement → review pass:

1. **Implement node (coder):** Takes the `task` description and `repoUrl`, produces a working implementation, runs focused checks (lint, types, relevant tests), and reports the diff.

2. **Review node (reviewer):** Reads the implementation output, checks correctness and quality, and returns either `PASS` (implementation is accepted) or a list of blocking fixes only (no nitpicks — only what must change before this can ship).

The trigger’s `maxIterations` is only a hint to the agents, not an engine-enforced ceiling. The global engine limits are `WORKFLOW_MAX_ITERATIONS` (default 100 node executions per graph walk, reset on resume) and `WORKFLOW_MAX_STEPS_PER_RUN` (default 500 total steps per run).

**Note:** The shipped definition has no back-edge, so it runs once. The engine supports native loops through port back-edges: add a separate entry node before `implement`, then a `property-match` node after review whose `false` port routes back to `implement` when the verdict is FAIL.

## When to Use

- Small, well-defined tasks where one round of review is usually sufficient
- Automated code review before a PR is created — coder implements, reviewer checks
- Pair-programming simulation: two agents, different roles, single pass
- Quality gates on generated content (docs, configs, scripts) that need independent verification before delivery

## Customization Notes

- **`maxIterations`** is declared in the trigger schema but is not enforced by the engine. It's a hint to the agents — include it in the implement node's task prompt if you want the coder to self-limit attempts.
- **Pin `agentId`** on the implement node to a coder-capable agent with repo access. Pin the review node to a reviewer-capable agent that can reason about code quality.
- **Add a PR creation node:** Extend with a third agent-task node that takes the reviewer's PASS output and creates a pull request via `gh pr create`.
- **Add structured output to the review node:** Use `outputSchema: { "type": "object", "properties": { "verdict": { "type": "string", "enum": ["PASS", "FAIL"] }, "fixes": { "type": "array" } } }` to make the verdict machine-readable for downstream automation.

## Trade-offs

**Single pass as shipped:** Native iteration requires adding a port back-edge and an explicit budget check if you want to enforce the trigger’s `maxIterations`. The global engine limits are safety backstops, not a review-round budget.

**Reviewer quality matters:** The review node's output is only as good as the reviewer agent's judgment. For high-stakes code, add a second reviewer node or route to a human-in-the-loop step before the PASS verdict is accepted.

**Scope creep risk:** Coder agents sometimes expand scope beyond the `task` description. Constrain with explicit instructions: `"Only implement exactly what is described. Do not refactor surrounding code."`
