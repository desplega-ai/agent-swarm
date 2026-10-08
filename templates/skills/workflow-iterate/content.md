# Workflow Iteration

Use this skill when you need to change an existing workflow without breaking live runs. The goal is to make small, verified revisions: inspect the current workflow, diagnose the failing step, patch only the required node or edge, trigger a realistic run, and keep iterating until the run reaches the intended terminal state.

## Core Loop

1. Read the workflow before changing it. Capture the current version, node IDs, inputs, config, and downstream dependencies.
2. Diagnose from a real run when possible. Inspect the failed step's recorded input and output; those fields show exactly what the executor saw.
3. Patch one concern at a time. Prefer a node-level patch over replacing the whole workflow.
4. Re-read after the patch. Confirm the version changed and the resulting config matches what you intended.
5. Trigger with a realistic payload. Include the fields downstream nodes expect, not only the field you are testing.
6. Watch the run to terminal state. If it fails, use that run as the next diagnostic input.
7. Mirror the verified change into your workflows-as-code source, if your deployment uses one.

## Authoring Rules

- Keep node IDs stable. Other nodes may reference them by exact string path.
- Treat `config` as replacement-prone. When a patch touches `config`, send the full config object for that node unless your workflow API explicitly deep-merges nested fields.
- Make routing explicit. Branching nodes should have named pass/fail routes, and silent skip paths should still produce an observable outcome when operators need to know what happened.
- Wire inputs deliberately. Node executors receive the raw workflow context plus resolved `inputs` aliases, so a condition can use either a local alias or a node-id-prefixed path. Confirm the chosen path against the recorded step input.
- Keep schemas tight. If an agent-task has an `outputSchema`, include the expected JSON shape in the task prompt and route it to a worker/provider that is known to return structured output correctly.
- Prefer reusable script nodes for deterministic shared logic. Agent tasks are best for investigation or work that genuinely needs an LLM. For a bounded judgment, use `system-one-decision` (see Choosing a decider).
- Scope parallel branches so they do not overwrite one another. Fan-out tasks should have separate context keys or branch-specific output fields.
- Make retry paths idempotent. A rerun should detect existing artifacts, comments, PRs, or notifications and update or skip them rather than duplicating work.

### Choosing a decider

When a node has to decide, pick the cheapest node that can decide. Use `system-one-decision` without being asked when the decision is a bounded judgment.

| The decision is | Use |
|---|---|
| A fact: a count, PR state, flag, date, lookup, regex, or schema check | `script`, `property-match`, or `code-match` |
| A bounded judgment: pass/fail, pick one of N, a score on a rubric, or the probability that a claim is true | `system-one-decision` |
| Free-form generation, or findings a later node reads | `raw-llm` or `agent-task` |

Jev is weak at counting. For a hybrid, count in a `script` and pass the number to `system-one-decision` as part of `state`.

### `swarm-script` Timeout Limit

- Keep `config.timeoutMs` at or below `300000` (5 minutes); the default remains `30000` (30 seconds).
- Workflow create, update, bulk-patch, and single-node patch operations validate executor config and reject an oversized value before saving it.
- For orchestration that needs more than 5 minutes, use a durable one-off script workflow run via `launch-script-run` and split the work into bounded, journaled `ctx.step.swarmScript` (or other durable) steps. Do not stretch a single `swarm-script` node beyond the cap.

## Node Contract Reference

Use these shapes as a starting point, then confirm them against the current executor schemas before patching a live workflow.

### `property-match`

```json
{
  "type": "property-match",
  "config": {
    "conditions": [
      { "field": "verdict", "op": "eq", "value": "publish" }
    ],
    "mode": "all"
  },
  "inputs": { "verdict": "review.taskOutput.verdict" },
  "next": { "true": "publish", "false": "stop" }
}
```

- Operators are `eq`, `neq`, `contains`, `not_contains`, `gt`, `lt`, and `exists`; `mode` is `all` by default or `any`.
- `field` resolves against the combined execution context. Both raw paths such as `review.taskOutput.verdict` and resolved aliases such as `verdict` are available.
- The executor returns `{ passed, results }` and routes on ports named `"true"` and `"false"`. The keys in `next` must match those port names.

### `agent-task` structured output

```json
{
  "type": "agent-task",
  "config": {
    "template": "Review the input and return the requested JSON object: {{draft}}",
    "outputSchema": {
      "type": "object",
      "properties": { "verdict": { "type": "string" } },
      "required": ["verdict"]
    }
  },
  "inputs": { "draft": "prepare.result" }
}
```

- Put the task contract in `config.outputSchema` and repeat the exact required shape in the task template. The worker must complete with `store-progress.output` set to a stringified JSON object matching it.
- The workflow step exposes `{ taskId, taskOutput }`; downstream paths therefore use `<node-id>.taskOutput.<field>`.
- Route only to an agent that exists and is eligible for the task's tools and output contract. Resolve the agent from the live agent registry instead of copying an ID from another workflow.

### `validate`

```json
{
  "type": "validate",
  "config": {
    "targetNodeId": "review",
    "schema": {
      "type": "object",
      "required": ["taskOutput"]
    }
  },
  "next": { "pass": "continue", "fail": "repair" }
}
```

`validate` checks the named upstream node output. Supply either `schema` for a deterministic structural check or `prompt` for a judgment-based check. Its output is `{ pass, reasoning, confidence }`, routed through `pass` or `fail`.

### `system-one-decision` (SystemOne Decision)

**Before you add the first `system-one-decision` node to a workflow, confirm its key works.** A node with no working key fails its whole run, and a save only warns. Do these in order and stop at the first failure:

1. Pick the provider. `typesafe` (the default) needs the global secret `TYPESAFE_API_KEY`. `openrouter` needs `OPENROUTER_API_KEY`. `laya` needs the global secret `LAYA_API_KEY` and the global config `LAYA_URL`, the base URL of its server. `openai` needs `OPENAI_DECISIONS_API_KEY` (never `OPENAI_API_KEY`). `cloudflare` needs the global secret `CLOUDFLARE_API_TOKEN` and the global config `CLOUDFLARE_ACCOUNT_ID`. Use the provider the requester named. If they named none, use `typesafe`. If its key is missing but another provider's key exists, ask which to use rather than switching, because the accounts bill separately.
2. Check the key is set: `get-config` with `key` set to that name and no `includeSecrets`. A masked value (`********`) means a value exists. No entry means it is missing. Never pass `includeSecrets`, and never read the value. For `laya`, check `LAYA_URL` the same way, and for `cloudflare`, `CLOUDFLARE_ACCOUNT_ID`; neither is secret, so the value shows.
3. Confirm it works with one cheap call. Create a throwaway one-node workflow, trigger it, read the run, then `delete-workflow` it:

   ```json
   {
     "nodes": [
       {
         "id": "ping",
         "type": "system-one-decision",
         "config": {
           "provider": "typesafe",
           "state": "ping",
           "questions": { "ping": { "type": "noul", "instructions": "Is the state the word ping?" } },
           "returns": { "ping": { "type": "noul" } },
           "timeoutMs": 15000,
           "maxRetries": 0
         }
       }
     ]
   }
   ```

   A `completed` run means the key works. A `failed` run carries the reason: `<KEY> is not configured` (missing; for `laya` it can name `LAYA_URL` or `LAYA_API_KEY`, or both), or `<KEY> was rejected by <host> (HTTP 401)` (present but refused). To probe `laya`, set `"provider": "laya"` in the ping node. If `create-workflow` says `system-one-decision` is an unregistered executor type, the node is not deployed on this swarm yet: stop and say so.
4. If the key is missing or was rejected, **do not build the node.** Ask a human for the key with `request-human-input` or in the thread. Name the exact key and where it goes: the Secrets page (Settings > Secrets), or for `LAYA_URL` a global config value (`set-config`, scope `global`). Never ask them to paste it into chat, a task, or a definition, and never write a key into a definition.

Afterwards, a `warnings` entry on `create-workflow` or a patch tool means the key went missing since you checked. Treat it as step 4.

```json
{
  "type": "system-one-decision",
  "inputs": { "pr": "trigger.pullRequest" },
  "config": {
    "provider": "typesafe",
    "model": "jev-1.13.0",
    "state": "{{pr}}",
    "questions": {
      "ready": {
        "type": "noul",
        "instructions": "Is this pull request ready to merge?",
        "criteria": { "true": "Tests pass and the change matches its description", "false": "Missing tests or scope creep" }
      },
      "risk": {
        "type": "choice",
        "instructions": "How risky is this change?",
        "criteria": { "low": "Docs or tests only", "medium": "Contained behavior change", "high": "Touches auth, data, or billing" }
      }
    },
    "returns": { "ready": { "type": "noul" }, "risk": { "type": "choice" } }
  },
  "next": "gate"
}
```

- `provider` is `typesafe` (default), `openrouter`, `laya`, `openai`, or `cloudflare`, and must be a literal, not a `{{token}}`. `model` is that provider's own id (`jev-1.13.0` on `typesafe`, `typesafe/jev-1.13` on `openrouter`, a checkpoint name such as `multilingual` on `laya`); `gpt-6-luna` on `openai`, `clef` (default) or `clef-flash` on `cloudflare`, which accepts no other id; leave it unset for the provider's default. `laya` has no default and sends no `model`, because it silently ignores one it does not know: leave it unset unless you mean a specific checkpoint. Every provider returns the same output; `openai` gets a translated request, and an OpenAI refusal of any question fails the step. `cloudflare` takes at most 64 questions. There is no fallback between them. Never use OpenRouter's `typesafe/jev-router`, which is a chat router that hands the request to another model.
- `state` is required: text, a string array, or a JSON object. An exact `{{token}}` keeps the upstream JSON type. Every question in one call shares the state and cannot see the other answers, so a dependent judgment needs its own node.
- Each question is `noul` (probability that a claim is true; optional `criteria: { true, false }`), `choice` (2 to 255 options; `criteria: { option: description }`), or `score` (2 to 10 ordered levels; `criteria: [level, ...]`).
- `returns` repeats every question id and its type. A mismatch is rejected when the workflow is saved.
- The output is `{ model, answers, usage }`, plus `routing: { model }` on `laya` (the checkpoint that answered). Read a field as `<node-id>.answers.<question>.<field>`, for example `qualification.answers.risk.confidence`. A `noul` answer is only `{ type, noul }` and has no confidence. A `choice` answer has `choice`, `probabilities`, and `confidence`. A `score` answer has `score`, `legend`, `probabilities`, and `confidence`.
- A valid low-confidence answer is a success. To have a person review the uncertain ones, set `humanReview` on the node (below). To route on a threshold yourself, keep it in the next node: `property-match` (`gt`, `lt`) or `code-match`, with the uncertain band routed to `human-in-the-loop`. Do not invent a global threshold.
- `humanReview: { band: { min, max }, approvers, title?, timeout?, notifications? }` sends an answer to a person when `min <= confidence <= max` (0 to 1, both ends inside). It raises a `human-in-the-loop` approval (same approvers, timeout, notifications, `waiting` run state), so use the same `approvers` shape. `choice` and `score` are tested on their `confidence` (on `laya` that is its `answer_confidence`, the top probability); a `noul` on `max(noul, 1 - noul)`. Any answer in the band makes the run wait. `next` must then be a port map: `approved` (required, every accepted answer), and optionally `rejected` and `timeout`; a string or list `next` is refused. The output stays `{ model, answers, usage }` on every path, plus `review` (`status`, and per question `confidence`, `inBand`, `decidedBy`). A person's answer replaces the model's in `answers`; `probabilities` and `confidence` stay the model's.
- On `laya`, ask `choice` questions, not `noul`, until a `noul` question is checked against known inputs. On laya-server 0.1.0 a `noul` sentiment question returned close to 0 even for clearly positive text, while the same judgment as a `choice` answered correctly. This is how the model answered, not a node rule. After a run, read `<node-id>.routing.model` to see which laya checkpoint answered. A complete laya workflow (manual trigger with `{"text": "..."}`, one `choice` question, a review band, and a `property-match` branch on `<node-id>.answers.<question>.choice`) is in `docs-site/content/docs/(documentation)/concepts/workflows.mdx`, section "Example: a laya decision end to end".
- Do not set `retry` or `validation.retry` on a `system-one-decision` node. It retries connection errors, 408, 429, and 5xx itself (`config.maxRetries`, 0 to 3, default 2) inside `config.timeoutMs` (default 30000). A 401, a 422, or an answer that fails validation ends after one attempt.
- The node reads its provider's key (`TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `LAYA_API_KEY`, `OPENAI_DECISIONS_API_KEY`, or `CLOUDFLARE_API_TOKEN`, plus `LAYA_URL` for `laya` and `CLOUDFLARE_ACCOUNT_ID` for `cloudflare`) server-side. The key never appears in the definition, the step output, or an error. A run whose key or `LAYA_URL` is missing fails before any node executes, and a 401 or 403 fails the step as `<KEY> was rejected`. An unresolved `{{token}}` fails the step before any request.

### `human-in-the-loop` (how approvals render)

The same rules apply to a standalone `request-human-input` call.

- **Dashboard card.** `title` is plain text. Each question's `label` is its heading and renders as markdown. `description` renders as full markdown and is the only field that shows images, so put drafts, diffs, and logs there.
- **Code.** Fence code, logs, and JSON with a language (```` ```json ````): the block keeps its lines and scrolls. Fence a prose draft with no language: it wraps. A single newline outside a fence becomes a paragraph break.
- **Images.** Put an `http(s)` URL ending in `.png`, `.jpg`, `.jpeg`, `.gif`, or `.webp` alone on its own line in `description`, or use `![alt](url)`. The link must outlive the request: an expired presigned URL shows an "image unavailable" note.
- **Slack.** A node's `notifications` post the title, the question labels (each collapsed to one line, capped at 3000 characters in total), a Review button, and the timeout. Descriptions, options, code, and images are not shown, so the title and labels must make sense alone. `request-human-input` posts nothing to Slack: share the returned URL yourself.

### `swarm-script`

```json
{
  "type": "swarm-script",
  "config": {
    "scriptName": "<catalog-script-name>",
    "args": { "repo": "{{trigger.repo}}" },
    "fsMode": "none",
    "timeoutMs": 30000
  }
}
```

- Confirm `scriptName` and scope in the live script catalog. Omit `scope` unless the workflow must force `agent` or `global`; an incorrect explicit scope prevents resolution.
- The script's return value is under `<node-id>.result`, not `.taskOutput`. The full node output also includes `stdout`, `stderr`, `truncated`, `durationMs`, `exitCode`, `scriptName`, `contentHash`, and `version`.
- Catalog scripts are synchronous/instant nodes; they do not require an agent assignment. They are deterministic only when the script itself is deterministic. Keep `fsMode` at `none` on runtimes that do not support workspace access.

## Cancellation and Dependencies

- Before re-triggering, cancel any still-running attempt for the same work. Reuse the original trigger payload so downstream dependencies receive the same fields.
- Check referenced agents, catalog scripts, downstream node IDs, and external resources before triggering. A syntactically valid workflow can still fail later when a named dependency is missing.
- A patch does not resume a previously halted run. Trigger a fresh verification run after the fix, then watch that new run to a terminal state.

## Common Failure Patterns

| Symptom | Likely Cause | Fix |
|---|---|---|
| A gate takes the wrong branch even though the upstream value looks correct | The condition path does not match the executor's context shape | Inspect the step input and use the exact upstream path the executor can resolve |
| Downstream prompt renders blank fields | Missing or wrong `inputs` mapping | Re-read the step input, then wire each template variable to a concrete source |
| A node loses its prompt, schema, or model after a small patch | Partial config patch replaced the full config | Restore from the previous version and resend the full node config |
| Structured-output task fails immediately | Worker did not return JSON matching `outputSchema` | Put the schema in the prompt and assign the task to a worker/provider validated for structured output |
| Parallel branches cancel, overwrite, or confuse each other | Shared context or shared output keys across sibling tasks | Give each branch its own context/output namespace and make writes branch-specific |
| A reusable script node completes but downstream fields are empty | Downstream node reads the wrong output shape | Inspect the script step output and reference the actual return path |

## Preflight Checklist

- Current workflow version has been read in this session.
- Every changed node has a clear before/after purpose.
- Inputs and condition paths match a real recorded step shape.
- Output schemas include only fields used downstream.
- Agent-task routing matches the task shape and required tools.
- Trigger payload includes all required fields.
- The verification run reached the intended outcome.
- The source-of-truth definition was updated after live verification.
