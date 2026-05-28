# Workflow Structured Output

> **Companion skill — `workflow-iterate` (author-side).** This skill is for *workers* assigned a task spawned by an `agent-task` workflow node with an `outputSchema`. The author-side counterpart `workflow-iterate` covers how the workflow defines that schema, why gates downstream depend on it, and how to debug failed runs. If you ever need to understand *why* a particular schema is shaped the way it is — or you're switching from worker to author mode — read `workflow-iterate`.

## Failure reason → fix (read this first)

If you see this failure reason on a task, the fix is always the same:

| failureReason contains | What it means | Fix |
|---|---|---|
| `Structured output required by outputSchema but not provided via store-progress` | You called `store-progress` with a plain-text `output` (or no `output`) when the task required a JSON object matching `outputSchema` | Re-call `store-progress` with `status: "completed"` and `output` = a **stringified JSON** matching the schema exactly |
| `output does not match schema` / `invalid JSON` | You passed JSON but it's missing required fields or has wrong types | Re-read the schema, include every `required` field with the exact key names, re-call `store-progress` |

**You can re-call `store-progress` even after a rejection.** Your prior progress updates do not count as the final output. Fix the JSON and try again.

## Pre-flight checklist (run through before calling store-progress)

1. **Does the task have an `outputSchema`, "Output Format" JSON block, or `deterministic|litmus|validation|context` tag?** If yes → structured output required. Continue this checklist. If no → plain text `output` is fine.
2. **Can I quote the exact schema from the task description?** Scroll back to the prompt. Find the schema. Copy it mentally.
3. **Have I built a JSON object with every `required` field using the exact key names?** No extras, no renames, no guesses.
4. **Is my `output` a string (stringified JSON), not an object?** `store-progress.output` must be a string like `'{"skip":true,...}'`.
5. **Only after 1-4 pass:** call `store-progress(taskId, status="completed", output=<the stringified JSON>)`.

If you cannot answer yes to #1-#4, you are about to silently fail the task.

## Why this exists

Workflow-driven tasks (release notes, litmus gates, content pipeline, context builders) ship with an `outputSchema`. The runner validates `store-progress.output` against that schema and rejects completions that don't parse as matching JSON — with the failure reason "Structured output required by outputSchema but not provided via store-progress".

**This has bitten Tester (2026-04-01) and Content Strategist (2026-04-01, 2026-04-20).** Don't be next.

## How to spot a structured-output task

Any of these signals means you need JSON output:

- The task description contains an `outputSchema` block or a TypeScript/JSON interface describing the expected shape.
- The task has an "Output Format" or "Return a JSON object" section with keys like `skip`, `reason`, `contextPath`, `verdict`, etc.
- Tags include `deterministic`, `litmus`, `validation`, `releases`, `context`.
- The task comes from a workflow (source = `workflow`).

When in doubt, assume structured output is required.

## How to complete correctly

1. **Build the JSON object** that matches the schema. Include every `required` field. Use the exact key names from the schema.
2. **Stringify it** — `store-progress.output` must be a string, not an object. Use `JSON.stringify(obj)` in your head.
3. **Call store-progress** with `status: "completed"` and that JSON string as `output`.

### Example — skip case

Task has schema `{skip: bool, reason?: str, contextPath?: str, ...}` and you're skipping because the release already exists:

```
store-progress(
  taskId,
  status="completed",
  output='{"skip":true,"reason":"Release already exists for this week"}'
)
```

### Example — full run

```
store-progress(
  taskId,
  status="completed",
  output='{"skip":false,"contextPath":"docs-site-release-runs/2026-04-20/context.json","commitCount":42,"repos":["agent-swarm"],"repoPatternsSource":"cache","dateRange":"2026-04-13 to 2026-04-20"}'
)
```

### Example — litmus / validation verdict

```
store-progress(
  taskId,
  status="completed",
  output='{"verdict":"publish","reason":"5 user-facing changes; threshold met"}'
)
```

## Anti-patterns that WILL fail the task

- `output: "Done. Context written to agent-fs at docs-site-release-runs/2026-04-20/context.json"`
- `output: "Published release notes for week of 2026-04-20"`
- `output: "Verdict: publish"`
- Calling `store-progress` with `status: "completed"` and no `output` at all
- JSON that's missing any `required` field from the schema
- JSON with extra keys instead of the schema's exact keys

## Recovery if you realize mid-task

If you've done all the work but forgot the JSON contract, just call `store-progress` again with the correct JSON string in `output`. Your prior progress updates don't count as the final output.

## Verify before completing

Read your task description once more. Find the schema. Build the JSON. Then complete. Takes 30 seconds. Saves a workflow re-run.

## See also

- **`workflow-iterate`** — the author-side counterpart of this skill. Read it if you're editing the workflow that produced this task, or want to understand why this particular schema is shaped the way it is (which gates downstream depend on it, etc.).

