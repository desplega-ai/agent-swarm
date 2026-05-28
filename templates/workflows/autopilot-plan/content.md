# Autopilot Plan

Use this for planning when research already exists.

```json
{
  "name": "Autopilot plan",
  "description": "Create an implementation plan from existing context.",
  "triggerSchema": {
    "type": "object",
    "required": ["request", "context"],
    "properties": {
      "request": { "type": "string" },
      "context": { "type": "string" },
      "repoUrl": { "type": "string" }
    }
  },
  "nodes": [
    {
      "id": "plan",
      "type": "agent-task",
      "config": {
        "role": "reviewer",
        "task": "Using this context: {{context}}\nCreate a concrete implementation plan for {{request}} in {{repoUrl}}. Include sequence, files, tests, and rollback concerns."
      }
    }
  ]
}
```

## What It Does

A single-node workflow: takes an existing research output (or any context string) and a feature request, then produces a concrete implementation plan. Faster than the full autopilot pipeline when research has already been done.

## When to Use

Use this when you have an existing context (from a prior research run, an issue description, or a PR review) and want to turn it into a structured implementation plan without re-running the research phase. It's the "planning step only" building block of the autopilot suite.

## Customization Notes

- **`repoUrl`** is optional but important — without it the plan will be generic. Always pass it.
- **Expand the plan node** to include `outputSchema` if you want structured output (e.g., `files: string[], tests: string[], risks: string[]`).
- **Chain it:** Connect the output of this workflow as the `context` input to `autopilot` for a research → plan → implement pipeline.

## Trade-offs

**Single reviewer node:** Planning is done by one agent without a review step. Add a second `agent-task` node with `role: "reviewer"` if the plan needs independent validation before implementation starts.
