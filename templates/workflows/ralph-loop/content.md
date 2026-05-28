# Iterative Review Loop

A bounded implement → review loop. A coder agent implements the task and reports the diff; a reviewer agent checks it and returns PASS or a blocking fix list. Use this when you want automated quality control with a clear exit condition rather than open-ended implementation.

## Configuration

```json
{
  "name": "Iterative review loop",
  "description": "Implement, review, and revise until accepted or blocked.",
  "triggerSchema": {
    "type": "object",
    "required": ["task"],
    "properties": {
      "task": { "type": "string" },
      "repoUrl": { "type": "string" },
      "maxIterations": { "type": "number" }
    }
  },
  "nodes": [
    {
      "id": "implement",
      "type": "agent-task",
      "config": {
        "role": "coder",
        "task": "Implement this task in {{repoUrl}}: {{task}}. Run focused checks and report the diff."
      },
      "next": ["review"]
    },
    {
      "id": "review",
      "type": "agent-task",
      "inputs": { "implementation": "implement" },
      "config": {
        "role": "reviewer",
        "task": "Review the implementation. Return PASS when ready, otherwise list blocking fixes only."
      }
    }
  ]
}
```

## What It Does

A two-node implement → review loop:

1. **Implement node (coder):** Takes the `task` description and `repoUrl`, produces a working implementation, runs focused checks (lint, types, relevant tests), and reports the diff.

2. **Review node (reviewer):** Reads the implementation output, checks correctness and quality, and returns either `PASS` (implementation is accepted) or a list of blocking fixes only (no nitpicks — only what must change before this can ship).

The `maxIterations` parameter is declarative: the reviewer signals PASS when done. The workflow engine handles the iteration ceiling.

**Note:** In the current workflow schema, looping back is not native — the review node does not automatically re-trigger the implement node. To iterate, re-trigger the workflow with the reviewer's feedback as the new `task` input, or extend with a `workflow-iterate` skill pattern.

## When to Use

- Small, well-defined tasks where one round of review is usually sufficient
- Automated code review before a PR is created — coder implements, reviewer checks
- Pair-programming simulation: two agents, different roles, single pass
- Quality gates on generated content (docs, configs, scripts) that need independent verification before delivery

## Customization Notes

- **`maxIterations`** is passed in but not natively enforced by the two-node shape. It's a hint to the agents — include it in the implement node's task prompt if you want the coder to self-limit attempts.
- **Pin `agentId`** on the implement node to a coder-capable agent with repo access. Pin the review node to a reviewer-capable agent that can reason about code quality.
- **Add a PR creation node:** Extend with a third agent-task node that takes the reviewer's PASS output and creates a pull request via `gh pr create`.
- **Add structured output to the review node:** Use `outputSchema: { "type": "object", "properties": { "verdict": { "type": "string", "enum": ["PASS", "FAIL"] }, "fixes": { "type": "array" } } }` to make the verdict machine-readable for downstream automation.

## Trade-offs

**No native loop:** This workflow is a single implement → review pass. True multi-iteration requires re-triggering or a more complex DAG. Use the `workflow-iterate` skill if you need the lead agent to drive multiple rounds based on reviewer feedback.

**Reviewer quality matters:** The review node's output is only as good as the reviewer agent's judgment. For high-stakes code, add a second reviewer node or route to a human-in-the-loop step before the PASS verdict is accepted.

**Scope creep risk:** Coder agents sometimes expand scope beyond the `task` description. Constrain with explicit instructions: `"Only implement exactly what is described. Do not refactor surrounding code."`
