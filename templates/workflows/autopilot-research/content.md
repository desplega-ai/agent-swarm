# Autopilot Research

The research-only leg of the autopilot pipeline. Use this when a request needs codebase discovery and option mapping before any implementation begins — especially for requests where the right approach isn't obvious up front.

## Configuration

```json
{
  "name": "Autopilot research",
  "description": "Research a request and produce implementation options.",
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
      "id": "map",
      "type": "agent-task",
      "config": {
        "role": "researcher",
        "task": "Map the codebase and product context for {{request}} in {{repoUrl}}. Return relevant files, existing patterns, and unknowns."
      },
      "next": ["options"]
    },
    {
      "id": "options",
      "type": "agent-task",
      "inputs": { "map": "map" },
      "config": {
        "role": "reviewer",
        "task": "Produce 2-3 implementation options with tradeoffs, risk, and recommended next step."
      }
    }
  ]
}
```

## What It Does

A two-node sequential pipeline: a researcher maps the codebase and product context for the request, then a reviewer synthesizes the map into 2-3 concrete implementation options with risk and trade-offs. The `map` node's output is explicitly passed to the `options` node via `inputs`.

This is the first stage of the full autopilot suite. It's designed to answer "what are my options?" before any implementation starts.

## When to Use

- Any request where the right implementation path is unclear before diving in
- Spike work — you want to understand the landscape before committing
- Planning a feature that touches multiple systems and you need options mapped out
- Onboarding a codebase: pass a broad `request` like "map the auth layer" to get a quick orientation

## Customization Notes

- **`repoUrl`** is optional but strongly recommended — without it, the map step has no grounding and will produce vague output.
- **Chain it forward:** Pass the `options` node output as the `context` input to the `autopilot-plan` template to continue into structured planning without re-running research.
- **Add `outputSchema` to the options node** for structured downstream consumption. Example: `{ "type": "object", "properties": { "options": { "type": "array" }, "recommended": { "type": "string" } } }`.
- **Pin `agentId`** on both nodes to a Claude-harness worker for consistent codebase access.

## Trade-offs

**No implementation:** This workflow produces options only — it does not write or change code. Pair it with `autopilot-plan` and then `autopilot` for a full pipeline.

**Research quality scales with `repoUrl` access:** If the researcher can't clone or access the repo, the map will be shallow. Ensure the assigned agent has repo access credentials or use a public repo URL.

**Two reviewers, no tie-breaking:** The `map` and `options` roles are different agents. If the researcher's map is incomplete, the `options` node cannot self-correct. Add a third agent-task node with role `lead` to reconcile if you see quality issues.
