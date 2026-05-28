# Script Backends Test

A diagnostic workflow that verifies all three script backends (TypeScript, Python, shell) are working correctly. Run this after enabling or upgrading script catalog infrastructure.

## Configuration

```json
{
  "name": "Script backends test",
  "description": "Verify script backends and summarize results.",
  "triggerSchema": {
    "type": "object",
    "properties": {
      "message": { "type": "string" }
    }
  },
  "nodes": [
    {
      "id": "typescript",
      "type": "swarm-script",
      "config": { "scriptName": "echo-typescript", "input": { "message": "{{message}}" } },
      "next": ["python", "shell"]
    },
    {
      "id": "python",
      "type": "swarm-script",
      "config": { "scriptName": "echo-python", "input": { "message": "{{message}}" } }
    },
    {
      "id": "shell",
      "type": "swarm-script",
      "config": { "scriptName": "echo-shell", "input": { "message": "{{message}}" } }
    }
  ]
}
```

## What It Does

A three-node fan-out that runs the same `message` through `echo-typescript`, `echo-python`, and `echo-shell` catalog scripts in parallel. The TypeScript node fans out to both Python and shell; all three run concurrently. If any node fails, you know exactly which backend is broken.

**Important:** This workflow requires `echo-typescript`, `echo-python`, and `echo-shell` scripts to exist in your catalog. These are the canonical "hello world" scripts for each runtime. If they're missing, install them or substitute any catalog script that accepts a `message` input.

## When to Use

- After enabling a new script backend (TypeScript, Python, or shell) for the first time
- After upgrading `bun`, Python, or shell runtime versions in the worker image
- After a production incident that may have broken the script executor
- As a deployment smoke test in CI or post-deploy runbooks

## Customization Notes

- **Replace echo scripts:** Swap `echo-typescript` / `echo-python` / `echo-shell` for any real catalog script. The pattern (fan-out from node 1 to nodes 2+3) is reusable for any parallel-execution test.
- **Add an agent-task summarizer:** Extend with a fourth node that reads all three `swarm-script` outputs (remember: under `.result`, not `.taskOutput`) and produces a health summary.
- **Reduce to one backend:** Remove nodes you don't need. A single-node version is a minimal "does the script runtime work?" check.

## Trade-offs

**Catalog dependency:** This template only works if the echo scripts exist in your catalog. If you're setting up a brand-new swarm, create the echo scripts first. Use `script-upsert` or fork the `example-fetch-context` script as a starting point.

**No assertion logic:** The workflow runs the scripts and surfaces their output, but does not automatically assert correctness. Add an `agent-task` node that checks each output contains the expected `message` value if you want a true pass/fail health check.
