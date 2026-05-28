# Swarm Script Node Demo

Use this as a minimal example for reusable script catalog nodes.

```json
{
  "name": "Swarm script node demo",
  "description": "Run a catalog script and summarize the result.",
  "triggerSchema": {
    "type": "object",
    "required": ["topic"],
    "properties": {
      "topic": { "type": "string" }
    }
  },
  "nodes": [
    {
      "id": "collect",
      "type": "swarm-script",
      "config": {
        "scriptName": "example-fetch-context",
        "input": { "topic": "{{topic}}" }
      },
      "next": ["summarize"]
    },
    {
      "id": "summarize",
      "type": "agent-task",
      "inputs": { "context": "collect" },
      "config": {
        "role": "researcher",
        "task": "Summarize the script result for {{topic}} and explain how downstream workflow nodes can use it."
      }
    }
  ]
}
```

## What It Does

A two-node workflow that demonstrates the `swarm-script` node type: runs a catalog script to collect context, then passes the result to an agent-task node for summarization. The key teaching: `swarm-script` output lives under `.result`, not `.taskOutput`.

## When to Use

Use as a reference when building a workflow that calls a reusable catalog script. Fork this template to replace `example-fetch-context` with any real catalog script from your swarm.

## Key Pattern: `swarm-script` Output Is Under `.result`

```
"inputs": { "context": "collect" }  // ← swarm-script output
// In the task: {{context.result.someField}}
// NOT: {{context.taskOutput.someField}}
```

## Customization Notes

- Replace `"scriptName": "example-fetch-context"` with a real script name from your catalog. Use `script-search` to find available scripts.
- `swarm-script` nodes don't need `config.agentId` — they're instant-mode, not agent-routed.
- The downstream `agent-task` node should pin `config.agentId` to a claude-harness worker for reliable execution.

## Trade-offs

**Script catalog required:** This workflow assumes `example-fetch-context` exists in the catalog. For a truly self-contained demo, replace it with an inline `script` node instead.
