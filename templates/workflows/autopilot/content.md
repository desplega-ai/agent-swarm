# Autopilot Feature Pipeline

Use this workflow as a canonical feature delivery pipeline. Customize roles and checks for your swarm.

```json
{
  "name": "Autopilot feature pipeline",
  "description": "Research, plan, implement, and verify a feature request.",
  "triggerSchema": {
    "type": "object",
    "required": ["request"],
    "properties": {
      "request": { "type": "string" },
      "repoUrl": { "type": "string" }
    }
  },
  "nodes": [
    {
      "id": "research",
      "type": "agent-task",
      "config": {
        "role": "researcher",
        "task": "Research this request for {{repoUrl}}: {{request}}. Return constraints, relevant files, risks, and suggested implementation approach."
      },
      "next": ["plan"]
    },
    {
      "id": "plan",
      "type": "agent-task",
      "inputs": { "research": "research" },
      "config": {
        "role": "reviewer",
        "task": "Create a focused implementation plan using the research output. Include files to touch, tests to run, and likely edge cases."
      },
      "next": ["implement"]
    },
    {
      "id": "implement",
      "type": "agent-task",
      "inputs": { "plan": "plan" },
      "config": {
        "role": "coder",
        "task": "Implement the plan for {{repoUrl}}. Keep the diff scoped, run relevant checks, and prepare a PR summary."
      },
      "next": ["verify"]
    },
    {
      "id": "verify",
      "type": "agent-task",
      "inputs": { "implementation": "implement" },
      "config": {
        "role": "reviewer",
        "task": "Review the implementation output. Verify tests/checks, identify residual risks, and recommend merge readiness."
      }
    }
  ]
}
```
