# Workflow Structured Output

> **Companion skill — `workflow-iterate` (author-side).** This skill is for *workers* assigned a task spawned by an `agent-task` workflow node with an `outputSchema`. The author-side counterpart `workflow-iterate` covers how the workflow defines that schema, why gates downstream depend on it, and how to debug failed runs. If you ever need to understand *why* a particular schema is shaped the way it is — or you're switching from worker to author mode — read `workflow-iterate`.

## Failure reason → fix (read this first)

If you see this failure reason on a task, the fix is always the same:

| failureReason contains | What it means | Fix |
|---|---|---|
| `Task has an outputSchema but no output was provided` | You called `store-progress` without an `output` when the task required a JSON object matching `outputSchema` | Re-call `store-progress` with `status: "completed"` and `output` = a **stringified JSON** matching the schema exactly |
| `Task output must be valid JSON` / `Task output does not match the outputSchema` | You passed invalid JSON, omitted required fields, or used the wrong types | Re-read the schema, include every `required` field with the exact key names, re-call `store-progress` |

**You can re-call `store-progress` even after a rejection.** Your prior progress updates do not count as the final output. Fix the JSON and try again.

## Pre-flight checklist (run through before calling store-progress)

1. **Do the task details contain an actual `outputSchema`?** If yes, runtime
   enforcement is active: continue with that exact schema.
2. **If there is no `outputSchema`, does the user provide an explicit JSON Output
   Format or interface?** Honor it as the requested output contract even though
   the runner is not enforcing an `outputSchema`.
3. **Are workflow origin or tags such as `deterministic`, `litmus`, `validation`,
   or `context` the only signals?** They are heuristics only. Re-read the task
   details for an actual schema or explicit format. If neither exists, do not
   invent one; plain-text output is allowed.
4. **Can I quote the exact required shape from the task details?** Use its exact
   keys and types, with every required field and no guessed renames.
5. **Is my `output` a string (stringified JSON), not an object?** For a structured
   contract, `store-progress.output` should be a JSON string.
6. **Only after the applicable contract is clear:** call `store-progress` with
   `status: "completed"` and the stringified JSON, or use plain text when no
   structured contract exists.

If the required shape is unclear, re-read the task details. Never synthesize a
schema from tags or workflow origin.

## Why this exists

When a task has an actual `outputSchema`, the runner validates
`store-progress.output` against it and rejects missing output, invalid JSON, or
schema mismatches with one of the current messages listed above. A JSON Output
Format or interface without `task.outputSchema` remains a user instruction, but
it is not the same runtime enforcement mechanism. Missing the distinction can
turn completed work into a rejected terminal update, so check the task contract
before reporting completion.

## How to spot a structured-output task

Treat these signals differently:

- An actual `task.outputSchema` means JSON is runtime-enforced.
- An explicit "Output Format", "Return a JSON object", or TypeScript/JSON
  interface is a user contract to return that shape, even without runtime
  enforcement.
- Tags such as `deterministic`, `litmus`, `validation`, `releases`, or `context`,
  and `source = workflow`, only tell you to inspect the task details carefully.
  They do not prove a schema exists.

When in doubt, re-read the task details and its `outputSchema`. Do not invent a
schema or required fields.

## How to complete correctly

1. **Build the JSON object** that matches the actual `outputSchema` or explicit
   user-provided JSON format. Include every required field and use the exact key
   names from that contract.
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
  output='{"skip":false,"contextPath":"release-runs/2026-04-20/context.json","commitCount":42,"repos":["example-repo"],"repoPatternsSource":"cache","dateRange":"2026-04-13 to 2026-04-20"}'
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

## Anti-patterns for an `outputSchema` task

- `output: "Done. Context written to agent-fs at release-runs/2026-04-20/context.json"`
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
