# Workflow Structured Output

**CRITICAL:** When a task has an `outputSchema` or an "Output Format" JSON block, you MUST call `store-progress` with a JSON string in `output` that matches the schema exactly. Plain-text output will silently fail the task even if the work succeeded.

## Failure Reason → Fix (Read This First)

| `failureReason` contains | What it means | Fix |
|---|---|---|
| `Structured output required by outputSchema but not provided via store-progress` | You called `store-progress` with plain-text or no `output` | Re-call `store-progress` with `status: "completed"` and `output` = stringified JSON matching the schema |
| `output does not match schema` / `invalid JSON` | JSON is missing required fields or has wrong types | Re-read the schema, fix the JSON, re-call `store-progress` |

**You can re-call `store-progress` even after a rejection.** Fix the JSON and try again.

## Pre-flight Checklist

Before calling `store-progress` to complete any task:

1. **Does the task have an `outputSchema`, "Output Format" JSON block, or `deterministic|litmus|validation|context` tag?** If yes → structured output required.
2. **Can you quote the exact schema from the task description?** Find it. Copy it mentally.
3. **Have you built a JSON object with every `required` field using the exact key names?** No extras, no renames.
4. **Is your `output` a string (stringified JSON), not an object?** `store-progress.output` must be a string like `'{"skip":true,...}'`.
5. **Only after 1–4 pass:** call `store-progress(taskId, status="completed", output=<stringified JSON>)`.

## How to Spot a Structured-Output Task

Any of these signals means you need JSON output:

- The task description contains an `outputSchema` block or a TypeScript/JSON interface.
- The task has an "Output Format" or "Return a JSON object" section with keys like `skip`, `reason`, `contextPath`, `verdict`.
- Tags include `deterministic`, `litmus`, `validation`, `releases`, `context`.
- The task comes from a workflow (source = `workflow`).

When in doubt, assume structured output is required.

## How to Complete Correctly

1. **Build the JSON object** matching the schema — include every `required` field with exact key names.
2. **Stringify it** — `store-progress.output` must be a string, not an object.
3. **Call `store-progress`** with `status: "completed"` and the JSON string as `output`.

### Example — Skip Case

Task has schema `{skip: bool, reason?: str}` and you're skipping because the release already exists:

```
store-progress(taskId, status="completed", output='{"skip":true,"reason":"Release already exists for this week"}')
```

### Example — Full Run

```
store-progress(
  taskId,
  status="completed",
  output='{"skip":false,"contextPath":"docs-site-release-runs/2026-04-20/context.json","commitCount":42,"repos":["agent-swarm"]}'
)
```

## Anti-patterns That WILL Fail the Task

- `output: "Done. Context written to agent-fs at docs-site-release-runs/2026-04-20/context.json"`
- `output: "Published release notes for week of 2026-04-20"`
- `output: "Verdict: publish"`
- Calling `store-progress` with `status: "completed"` and no `output` at all
- JSON missing any `required` field from the schema
- JSON with extra keys instead of the schema's exact keys

## Recovery If You Realize Mid-Task

If you've done all the work but forgot the JSON contract, just call `store-progress` again with the correct JSON string in `output`. Your prior progress updates don't count as the final output.

## Trade-offs

**Why not just accept plain text?** Workflow gates (`property-match` nodes) read fields from the worker's output. If the output isn't valid JSON matching the schema, the gate can't evaluate and the workflow halts. The strict validation is intentional — it makes the worker/author contract explicit and catches integration bugs before they cause silent downstream failures.

## See Also

- **`workflow-iterate`** — the author-side counterpart. Read it if you're editing the workflow that produced this task or want to understand why a particular schema is shaped the way it is.
