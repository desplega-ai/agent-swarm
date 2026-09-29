# Workflows runbook

Workflows are DAGs of nodes connected via `next`. Reference for authoring nodes with the `create-workflow` tool.

## Cross-node data access

Upstream outputs are **not** available by default. Declare an `inputs` mapping:

- Keys are local names for `{{interpolation}}`.
- Values are context paths (usually a node ID).
- Agent-task output shape is `{ taskId, taskOutput }`, so access via `localName.taskOutput.field`.
- For trigger data: `{ "pr": "trigger.pullRequest" }` → `{{pr.number}}`.
- For the current run: `{ "runId": "run.id" }` → `{{runId}}` (builtin, like `trigger`/`input` — useful for receipts/audit nodes correlating their output with the run).

Without `inputs`, upstream references are unavailable. Ordinary config values still render unresolved tokens as empty strings and report them in `diagnostics.unresolvedTokens`. Executable script source is stricter: disallowed or unresolved workflow tokens fail the node before execution.

## Structured output

Schema goes in `config.outputSchema` (not node-level). The agent produces JSON matching it; validated by `store-progress`.

## Large artifact handoffs

Agent-task nodes should not pass large raw artifacts directly into later LLM prompts. If a node writes a full debug/audit artifact such as a commit context, trace bundle, scrape result, or report dataset, it should also write a slim prompt artifact and return both paths:

```json
{
  "contextPath": "release-runs/2026-06-08/context.json",
  "contextSlimPath": "release-runs/2026-06-08/context-slim.json"
}
```

Downstream LLM nodes should read the slim path:

```bash
agent-fs --org <org-id> cat {{context.taskOutput.contextSlimPath}}
```

Keep the full path for audit/debugging only. Add an explicit prompt guard such as "Do not read `{{context.taskOutput.contextPath}}` unless a human asks for it." This prevents high-volume weeks from turning a normal structured-output task into a context-overflow failure before the agent can call `store-progress`.

Recommended slim commit shape:

```json
{
  "commits": [
    {
      "hash": "abc123...",
      "shortHash": "abc123",
      "author": "Name",
      "date": "2026-06-08",
      "message": "feat: add workflow run waterfall",
      "files": ["src/workflows/engine.ts", "apps/ui/src/pages/workflow-runs/[id]/page.tsx"]
    }
  ],
  "commitCountTotal": 70,
  "commitCountIncluded": 70,
  "truncated": false
}
```

Do not include patch bodies, diff hunks, raw `git log --stat` output, downloaded HTML, or other bulk text in the slim artifact. Cap arrays before prompt ingestion; for release-note workflows, 150 commits is a reasonable default.

## Interpolation

`{{path.to.value}}` in any string field inside `config`. Objects get JSON-stringified; nulls become empty strings.

## Agent-task config fields

- `template` (required)
- `outputSchema`
- `agentId`
- `routingReason` (optional; a configured `agentId` defaults to `human_pinned`: `skill`, `continuity`, `overflow`, `human_pinned`, or `reroute_fault`)
- `routingNote` (optional, maximum 200 characters)
- `tags`
- `priority` (0–100, default 50)
- `offerMode`
- `dir`
- `vcsRepo`
- `model`
- `parentTaskId`

## Foreach nodes

`foreach` fans out one `agent-task` child per array item, waits for every child, then exposes one
parent-owned aggregate to downstream nodes.

```yaml
- id: reflect
  type: foreach
  inputs: { agents: "gather.result.agents" }
  config:
    over: "{{agents}}"
    itemKey: id
    body:
      type: agent-task
      config:
        agentId: "{{item.id}}"
        template: "Reflect for {{item.name}} (index {{index}})"
  next: critique
```

- `over` must resolve to an array. An exact interpolation token preserves the array value instead
  of JSON-stringifying it.
- `itemKey` names a required non-empty string property whose value is unique across the array.
- `body.type` is restricted to `agent-task` in v1. `body.config` accepts the normal agent-task
  fields and is interpolated separately for each child with `item` and zero-based `index`.
- Child steps have synthetic IDs `<foreachNodeId>#<itemKey>`. The parent remains waiting until all
  children are terminal; only the parent aggregate is written to workflow context.
- Empty arrays complete synchronously and still route to the successor.
- `concurrency` is rejected in v1. All children are materialized in one fan-out.
- A `foreach` node in a cycle is rejected in v1. Child steps are scoped to the run, so a later
  parent iteration cannot safely re-adopt them.

The parent output shape is:

```json
{
  "results": [
    { "itemKey": "agent-id", "status": "completed", "output": { "taskId": "...", "taskOutput": {} } }
  ],
  "okCount": 1,
  "failedCount": 0
}
```

The workflow-level `onNodeFailure` policy applies to foreach children. The default `fail` stops the
run on the first failed/cancelled child. With `onNodeFailure: "continue"`, the child contributes a
`failed` result whose output contains the existing `[FAILED: <reason>]` marker; the remaining
children finish and the parent closes the join.

## Human-in-the-loop nodes

A `human-in-the-loop` node creates one approval card, pauses the run, and routes on the `approved`,
`rejected`, or `timeout` port. Question types: `approval`, `text`, `single-select`, `multi-select`,
`boolean`. The run is `rejected` only when an `approval` question is answered with a rejection.

`config.questions` is either a static array or one exact interpolation token that resolves to an
array built upstream, for example one question per item:

```yaml
- id: plan-card
  type: human-in-the-loop
  inputs: { t: "triage.taskOutput" }
  config:
    title: "Plan for {{t.count}} items"
    questions: "{{t.questions}}"
    approvers: { policy: any }
  next: { approved: execute, rejected: skip, timeout: skip }
```

- The exact token injects the raw array. A token with surrounding text is rejected at authoring
  time, because string interpolation would JSON-stringify the array.
- Resolved questions are validated at execute time with the same schema as static ones. The node
  fails, and no card is created, when the value is missing, not an array, empty, over 100
  questions, has a malformed item (the error names the index and field), repeats an `id`, or has a
  select question with no options. Unknown fields are stripped.
- Resolved questions are display data. They are stored as-is and never re-interpolated, so a
  `{{token}}` inside upstream text stays literal.
- Downstream nodes read answers by question id: `inputs: { decision: "plan-card" }`, then
  `{{decision.responses.<questionId>}}`. An optional question the human skipped is absent from
  `responses`, so give the consumer a default (for example the proposed action).

Rendering limits:

- The dashboard approval page lists every question as its own card. No cap beyond the 100-question
  node limit.
- The Slack notification lists question labels in one section block, capped by Block Kit at 3000
  characters. When the labels do not fit, the tail becomes `…and N more` and the reviewer answers
  on the dashboard via the card's button. Labels are escaped, so upstream text cannot add mentions
  or links.

## Script node types

There are two script-oriented workflow nodes:

- `script` runs inline `bash`, `ts`, or `python` source embedded directly in the workflow definition.
- `swarm-script` runs a TypeScript script from the reusable swarm catalog (`scripts` table). Use this when the logic should be shared across agents or reused by multiple workflows.

Both executors emit the `success` port. To branch on a check, add a `validation` block and a record `next` with `pass` and `fail` keys. When the node's `next` is a record that does not declare the executor's port, the validation result picks `pass` or `fail`. When `next` does declare the executor's port (for example `next: { success: ... }`), the executor port wins and validation does not reroute. The engine checkpoints the chosen port on the step, and recovery, resume, and retries route from that value. The same rule applies to every executor type (`resolveValidationPort` in `src/workflows/definition.ts`).

### `script` config

- `runtime` (required): `bash`, `ts`, or `python`.
- `script` (required): inline source to execute.
- `args`: optional string arguments passed to the script.
- `cwd`: optional working directory.
- `timeout`: optional wall-clock timeout in milliseconds, from `1000` through `300000`; defaults to `30000`. This value applies to both the inline script executor and the workflow step watchdog.

Inline executable source may interpolate only `input`, `workflow`, `swarm`, and `run` values. It may not splice `trigger` data or declared upstream aliases directly into source. Pass those dynamic values through `config.args`, which the script receives as argv. A disallowed or unresolved source token fails the node before execution instead of running partially blanked code.

### `swarm-script` config

- `scriptName` (required): catalog script name.
- `scope`: optional `agent` or `global`. If omitted, workflow execution tries the workflow creator's agent scope first, then global.
- `pinHash`: optional script content hash. When set, execution uses the matching `script_versions` row instead of the latest live source.
- `args`: optional JSON object passed to the script as its first argument. Values support normal workflow interpolation.
- `fsMode`: optional, defaults to `none`. `workspace-rw` is reserved for v2 worker-side execution and fails in v1 with a clear workflow-node error.
- `timeoutMs`: optional wall-clock timeout in milliseconds. Defaults to `30000` (30s), accepts integers from `1000` through `300000` (5m), and applies both to the workflow step timeout and the scripts-runtime `wallClockMs` resource budget.

Catalog script source is never workflow-interpolated. If it contains a token rooted at a built-in workflow value or a declared input alias, the node fails with guidance to pass that value through `config.args`; unrelated mustache text remains literal script data.

Agent-scoped lookup uses the workflow's `createdByAgentId`. If a workflow has no creator, `trigger.agentId` is accepted as a fallback; otherwise only global scripts can be resolved.

`timeoutMs` controls elapsed wall-clock time, not CPU time. The scripts runtime deliberately keeps a separate 60s CPU-time ulimit, so an I/O-bound or waiting script can use the full 5-minute wall-clock window while a hot loop is still terminated after roughly 60 CPU seconds. Workflow create, update, bulk-patch, and single-node patch operations validate executor config and reject values outside the allowed range before saving.

For orchestration that needs more than 5 minutes, use `launch-script-run` to start a durable one-off script workflow and split the operation into bounded, journaled `ctx.step.swarmScript` (or other durable) steps. The durable run can resume across process restarts; it does not raise the per-script runtime limit for an individual step.

Example:

```yaml
- id: parse
  type: swarm-script
  inputs: { issue: "trigger.linearIssue" }
  config:
    scriptName: parse-linear-issue
    args: { issue: "{{issue}}" }
    pinHash: "b7a0..."
    timeoutMs: 45000
```

Downstream nodes read the executor output from the node ID. The script's return value is under `result`, so an `inputs` mapping usually points at `parse.result.someField`.

## Choosing a decider

When a node has to decide, pick the cheapest node that can decide. Use `system-one-decision` for bounded judgments without waiting to be asked.

| The decision is | Use |
|---|---|
| A fact: a count, PR state, flag, date, lookup, regex, or schema check | `script`, `property-match`, or `code-match` |
| A bounded judgment: pass/fail, pick one of N, a score on a rubric, or the probability that a claim is true | `system-one-decision` |
| Free-form generation, or findings a later node reads | `raw-llm` or `agent-task` |

Jev is weak at counting. For a hybrid, count in a `script` and pass the number to `system-one-decision` as part of `state`. The `workflow-iterate` skill carries the same rule for agents that edit workflows.

## SystemOne Decision nodes

A `system-one-decision` node (display name "SystemOne Decision") makes typed decisions with a decisions model, through TypeSafe directly or through OpenRouter (see Providers). The model is a config field and defaults to Jev; the node name is not tied to one model. It answers at once, and waits only when `humanReview` sends an answer to a person (see Human review). One call sends one `state` and a map of questions, and the node returns one validated answer per question.

```yaml
- id: qualify
  type: system-one-decision
  inputs: { lead: "trigger.lead" }
  config:
    provider: typesafe # the default; or openrouter
    model: jev-1.13.0
    state: "{{lead}}"
    questions:
      fit:
        type: noul
        instructions: Is this a real engineering team seeking agent workflow automation?
        criteria: { true: A matching team with a concrete use case, false: Spam or no matching team }
      authority:
        type: choice
        instructions: What purchasing authority does the message support?
        criteria: { buyer: Can approve the purchase, champion: Influences the decision, unknown: Not established }
      urgency:
        type: score
        instructions: How urgent is the stated need?
        criteria: [No timeline, This quarter, Blocked now]
    returns:
      fit: { type: noul }
      authority: { type: choice }
      urgency: { type: score }
  next: gate
```

### `system-one-decision` config

- `provider`: `typesafe` (default) or `openrouter`. A literal, not a `{{token}}`, because it decides which key is checked before the run starts. See Providers.
- `state` (required): text, a string array, or a JSON object. An exact `{{token}}` keeps the upstream JSON type; mixed text is interpolated as a string. Resolved content is never interpolated again.
- `questions` (required): a map of question id to a `noul`, `choice`, or `score` question. Ids match `[A-Za-z_][A-Za-z0-9_-]*`. Ids and types are static. Only `state` and the descriptions may use `{{tokens}}`.
  - `noul`: `instructions`, optional `criteria: { true?, false? }`. The answer is a probability that the claim is true.
  - `choice`: `instructions`, `criteria: { option: description }` with 2 to 255 options.
  - `score`: `instructions`, `criteria: [level, ...]` with 2 to 10 ordered levels.
- `returns` (required): every question id with its `type`. Config validation rejects a missing id, an extra id, or a type that disagrees with the question. It is checked, never sent to the API.
- `model`: the provider's own model id. Unset means the provider's default (`jev-latest` on `typesafe`, `~typesafe/jev-latest` on `openrouter`). Pin a version for a calibrated workflow: `jev-1.13.0` on `typesafe`, `typesafe/jev-1.13` on `openrouter`.
- `timeoutMs`: `1000` through `300000`, default `30000`. The executor stops its own request `250` ms before the step watchdog.
- `maxRetries`: `0` through `3`, default `2`.
- `humanReview` (optional): send answers the model is unsure about to a person. See Human review.

The config has no endpoint, header, or key field, and unknown fields are rejected. The only host choice is `provider`, an id from a server-side list.

### `system-one-decision` output

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "fit": { "type": "noul", "noul": 0.82 },
    "authority": { "type": "choice", "choice": "buyer", "confidence": 0.75, "probabilities": { "buyer": 0.9, "champion": 0.07, "unknown": 0.03 } },
    "urgency": { "type": "score", "score": 1.7, "confidence": 0.65, "legend": { "0": "No timeline", "1": "This quarter", "2": "Blocked now" }, "probabilities": { "0": 0.05, "1": 0.2, "2": 0.75 } }
  },
  "usage": { "input_tokens": 400, "output_tokens": 80 }
}
```

`model` is the version the API reports. `requestId` is added when the API sends a request-id header. `usage` is the token count of the successful call. Success needs exactly one answer of the declared type per question: a missing answer, an unknown choice, a score outside `0` to `levels - 1`, wrong probability keys, or a distribution that does not sum to 1 (tolerance `0.02`) fails the step. A `noul` answer stays `{ type, noul }`. It has no confidence field and the node never adds one.

Downstream nodes read `<alias>.answers.<question>.<field>` through an `inputs` mapping, for example `inputs: { qualification: "qualify" }` and `qualification.answers.authority.confidence`.

### Providers

| `provider` | Host | Key (global secret) | Default `model` |
|---|---|---|---|
| `typesafe` (default) | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` | `jev-latest` |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `OPENROUTER_API_KEY` | `~typesafe/jev-latest` |

Both hosts take the same request and return the same answers, so `returns`, the output shape, the validation rules, and thresholds are identical on either. The list lives in `SYSTEM_ONE_PROVIDERS` (`src/workflows/executors/system-one-providers.ts`); adding a host is one entry there. `openrouter` reads its key through `resolveWorkflowLlmConfig`, the resolver `raw-llm` uses, and never falls through to `OPENAI_API_KEY`.

There is no fallback between providers. A node that names none uses `typesafe`, and it does not move to `openrouter` when the TypeSafe key is missing: the two accounts bill separately and use different model ids, and the key the preflight names must be the key the node uses. Switch by setting `provider`.

Use the decisions endpoint only. OpenRouter's `typesafe/jev-router` is a router that forwards a chat request to another model (a live call was served by `openai/gpt-6-luna`), and `~typesafe/jev-latest` rejects chat/completions with "is a decisions model". `openrouter` refuses to run when `OPENROUTER_BASE_URL` points at a gateway, because the key may be a gateway token and the decisions API is not a chat route.

### Keys and preflight

Each provider needs its key as a global secret (Settings > Secrets, or `set-config` with scope `global` and `isSecret` true). The swarm checks it before first use, and every message names the exact key for the node's provider and where to set it:

- **Save** (`create-workflow`, `update-workflow`, `patch-workflow`, `patch-workflow-node`, and the matching HTTP routes): the save succeeds and returns a warning when a `system-one-decision` node's key is missing or unreadable. MCP puts it in the result message and `data.warnings`. HTTP adds `warnings` to the workflow body, only when there is one. It is a warning, not a rejection: definitions are also saved before a human has supplied the key (template installs, seeders, version restores, authoring ahead of a key request), and the key can change after any save, so a save-time gate would block valid work without guaranteeing anything.
- **Run start**: a run of a definition with a `system-one-decision` node whose key is missing fails before any node executes, with the same named error. The run is recorded as `failed`, has no steps, and sends no request. This is the guarantee. It covers manual, schedule, webhook, and event triggers.
- **Retry**: `retry-workflow-run` refuses, and leaves the run failed, when a node still to run needs a key that is missing.
- **A key that exists but is refused**: a 401 or 403 fails the step with `<KEY> was rejected by <host> (HTTP <status>)` and tells the operator to replace it. It is not retried. Presence is what the run-start check can confirm without a paid call, so a wrong key still surfaces at the first `system-one-decision` step; the `workflow-iterate` skill has authors confirm the key with one cheap call before building the node.

The key value never appears in a definition, a warning, a step output, or an error.

### Human review

Set `humanReview` to define, in the same node, a confidence band whose answers go to a person instead of passing straight through. Absent, nothing changes.

```yaml
- id: qualify
  type: system-one-decision
  config:
    # ...state, questions, returns as above
    humanReview:
      band: { min: 0.5, max: 0.8 }   # 0 to 1, both ends inside the band
      approvers: { users: [head-of-sales], policy: any }
      title: Check the lead           # optional
      timeout: { seconds: 86400, action: reject }   # optional
      notifications: [{ channel: slack, target: C0123456 }]   # optional
  next: { approved: route, rejected: discard, timeout: escalate }
```

- **`band`** is `{ min, max }`, each `0` to `1`, `min <= max`. An answer is in the band when `min <= confidence <= max`. `approvers`, `timeout`, and `notifications` are the `human-in-the-loop` schemas, imported, not copied. `title` defaults to `Review decision: <node id>`.
- **Which number is the confidence.** `choice` and `score` answers report `confidence`, and it is used as reported. A `noul` answer reports none, so the band is tested against `max(noul, 1 - noul)`, the probability of the side the model took. The `noul` answer stays `{ type, noul }`; the tested number is recorded in `review.questions`. The number is the provider's own, so a band tuned on one provider or model does not carry to another.
- **Any answer in the band parks the node.** One approval request covers the whole node. It asks one `approval` question ("Accept these answers and continue?", id `$confirm`) and one question for each answer that is in the band: a `single-select` for `choice` (the options) and `score` (the levels), a `boolean` for `noul`. Answers outside the band are not asked and stay the model's. The card shows the model's answer and confidence, and the first 2000 characters of `state`, run through the secret scrubber.
- **Approve** with an empty answer to confirm what the model said, or pick another option to replace it. A replaced `noul` becomes `1` or `0`, a person being certain. `probabilities`, `legend`, and `confidence` always describe the model and are never edited. **Reject**, or let `timeout` run out, and nobody has accepted an answer: `answers` stays the model's.
- **Output.** The same `{ model, answers, usage }` a run without review returns, so downstream nodes read `<alias>.answers.<question>.<field>` on every path, plus a `review` block:

  ```json
  "review": {
    "status": "approved",
    "approvalRequestId": "…",
    "questions": {
      "fit":       { "confidence": 0.82, "inBand": false, "decidedBy": "model" },
      "authority": { "confidence": 0.75, "inBand": true,  "decidedBy": "human", "modelAnswer": "buyer" }
    }
  }
  ```

  `status` is `not_required` (nothing in the band, no request raised), `approved`, `rejected`, or `timeout`. `decidedBy` says who produced the value in `answers[id]`. `modelAnswer` is kept when a person decided, so an override stays auditable. A response that names something outside the options is treated as `rejected` with `review.reason`, never as a confirmation.
- **Ports.** With `humanReview`, `next` must be a port map: `approved` (required, carries every accepted answer, whether the model's or a person's, and every answer that never needed review), and optionally `rejected` and `timeout`. A string or list `next` is refused at authoring, because it would run the same successors after a rejection. A port `next` does not map ends that branch.
- **Reuse, not a second path.** The node raises the request through the `human-in-the-loop` executor, so approvers, timeout, Slack notifications, the `waiting` run state, the dashboard card, and the sweep that times requests out are all that executor's. The only new piece is the hook a step can implement to shape its own output when its approval resolves (`BaseExecutor.resolveApproval`, applied by `src/workflows/approval-resolution.ts` from both the live resume path and the recovery sweep). `human-in-the-loop` does not implement it and behaves as before.
- **The decision survives the wait.** The model's answer is stored on the waiting step before the request is raised. If the step is run again after its request exists (a crash between the two), the node reuses that stored decision and does not call the provider a second time. A step that has lost its stored decision fails with a message instead of asking again.
- **Not included.** No per-question band or per-question approvers (split the node instead), no auto-approve above the band (an answer above `max` passes), and no change to the run view: a waiting step shows the stored decision and its approval card lives on the approvals page.

### Other backends: laya

`@desplega/laya` and `@desplega/laya-server` (laya-js, private and unpublished) answer the same kind of question, and their result maps onto this node's output without a schema change. No laya provider ships in this change and the node does not depend on laya-js.

| This node | laya (`SystemOneResult`, `POST /v1/systemone`) |
|---|---|
| request `{ state, model, questions }` | the same body; `model` is a checkpoint name (`english`, `multilingual`, `typed-decisions`) or omitted to auto-route. laya-server also takes `max_len` and `head_max_len` |
| question `{ type, instructions, criteria }` | the same shape. laya also accepts a list of labels for a `choice`. Limits differ: laya allows 100 choice options (node: 255) and 32 score levels (node: 10), and its docs advise against boolean-word labels such as `yes` |
| `model` | `model` (`laya-rl-agent`) |
| `answers.<q>` `choice` / `score` / `noul`, `probabilities`, `legend`, `confidence` | the same fields and types; `score` is the expected level, so fractional |
| `usage` `{ input_tokens, output_tokens }` | the same; `usage.windows` from `predictLong` is dropped |
| not kept | `routing`, `answer_confidence`, `action`, `low_confidence`: dropped by the validator, as any extra provider field is |

Every row is checked by a test that feeds a laya-shaped result through the same validator and band (`src/tests/workflow-system-one-decision-review.test.ts`). The fixture is built from the laya-js source, not captured from a running server, because the checkpoints are private.

Plugging laya in later is one `SYSTEM_ONE_PROVIDERS` entry plus two small changes to the provider interface, none of which touch the node type, its config, or its output. The endpoint has to come from a deployment setting because a laya server has no fixed host, and the key has to be optional because a laya server may run without a token. Two things need a decision from the laya side, not from this node: laya's `confidence` for `choice` and `score` is entropy-based (its `answer_confidence` is the max probability), so a band would be tuned on that number unless the provider maps `answer_confidence` into `confidence`; and where the server URL lives.

### Thresholds, retries, and credentials

- A valid low-confidence answer is a successful evaluation. To review the uncertain band, set `humanReview`. To route on a threshold yourself, keep it in the next node: `property-match` (`gt`, `lt`, `eq`) or `code-match` for `>=`, then `human-in-the-loop`. There is no global threshold.
- The executor retries connection errors, HTTP 408, 429, and 5xx (including 529) with exponential backoff and jitter, up to `maxRetries`. It honors `Retry-After` and fails instead of retrying early when the wait does not fit the budget. It never retries 401, 422, other 4xx, redirects, or an invalid success body.
- A `system-one-decision` node must not set `retry` or `validation.retry`. Engine retries are not status-aware and would re-send rejected requests. Workflow create and update reject it, and a stored definition that has it fails the step before any request.
- The node reads its provider's key on the server (see Keys and preflight). Errors carry the HTTP status, a short error code, and the request id, not the provider's message or your state.
- Any unresolved `{{token}}` in a `system-one-decision` config fails the step before the request, because the call is paid and not idempotent.

## Trigger requester attribution

Each workflow run persists the trusted human requester in `workflow_runs.created_by` when one is available. MCP resolves the caller from the invoking agent's owned source or current task; authenticated HTTP uses its trusted request user or owned agent-task context; schedules use their creator; and Kapso routing uses the resolved canonical sender. Generic unsigned or HMAC webhooks and creatorless schedules stay unattributed, and an ownerless trigger never falls back to the workflow author.

Retry, resume, and recovery reconstruct requester context from the workflow run. Agent-task nodes created after a restart therefore keep the original `requestedByUserId` instead of losing attribution at the checkpoint boundary. Historical runs with `created_by = NULL` are not backfilled because no trustworthy requester can be recovered.

## Trigger schema

`triggerSchema` is an optional JSON Schema attached to a workflow that validates the `triggerData` payload for every trigger path — manual `/trigger`, webhooks, schedules, and MCP `trigger-workflow`. When set, mismatched payloads are rejected before the workflow starts (no run is created, no nodes execute). When unset (the default), any payload is accepted.

Use one when you want to fail fast and self-document the contract a webhook or upstream caller is expected to honor (e.g. "this workflow needs `pr.number`").

### Supported subset

The validator (`src/workflows/json-schema-validator.ts`) supports a deliberately minimal JSON-Schema subset:

- `type` — `"object"`, `"string"`, `"number"`, `"boolean"`, `"array"`
- `required` — array of required property names (objects only)
- `properties` — map of property name → schema (recursive)
- `enum` — array of allowed primitive values (strict equality)
- `const` — a single allowed value (strict equality)
- `items` — schema applied to every element of an array (recursive)

**All other keywords (`oneOf`, `anyOf`, `$ref`, `pattern`, `format`, `additionalProperties`, …) are silently ignored.** Authoring tools should surface this caveat near the editor, and reviewers should reject schemas that depend on unsupported keywords for correctness.

### Setting `triggerSchema`

| Surface | Method | Body field | `null` clears? |
|---|---|---|---|
| MCP | `create-workflow` | `triggerSchema?: object` | n/a (omit = none) |
| MCP | `update-workflow` | `triggerSchema?: object \| null` | yes |
| MCP | `patch-workflow` | `triggerSchema?: object \| null` | yes |
| HTTP | `POST /api/workflows` | `triggerSchema?: object` | n/a |
| HTTP | `PUT /api/workflows/{id}` | `triggerSchema?: object \| null` | yes |
| HTTP | `PATCH /api/workflows/{id}` | `triggerSchema?: object \| null` | yes |

Semantics: `undefined` / omitted = leave unchanged, object = set/replace, `null` = clear. Identical across all three update surfaces.

### How errors surface

When a trigger payload fails validation the engine throws `TriggerSchemaError` (`src/workflows/engine.ts:31-36`) carrying the per-field validator output. Each surface formats it differently but the underlying `details: string[]` array is identical:

**HTTP** — both `POST /api/workflows/{id}/trigger` and `POST /api/workflows/webhooks/{id}` return `400 Bad Request` with the frozen body shape:

```json
{
  "error": "TriggerSchemaError",
  "message": "Trigger schema validation failed: root: missing required property \"pr\"",
  "details": ["root: missing required property \"pr\""]
}
```

`details` is the array returned by `validateJsonSchema()` — one string per failing field, prefixed with the dotted path (e.g. `pr.number: expected type "number", got string`). The helper that writes this body lives at `src/http/utils.ts` (`triggerSchemaErrorResponse`).

**MCP** — `trigger-workflow` returns `success: false` with structured content alongside a human-readable bulleted message in `content[0].text`:

```json
{
  "success": false,
  "message": "Trigger payload did not match the workflow's triggerSchema (1 error).",
  "validationErrors": ["root: missing required property \"pr\""],
  "triggerSchema": { "type": "object", "required": ["pr"], "properties": { ... } }
}
```

The echoed `triggerSchema` lets agents self-correct without a follow-up `get-workflow` call. Generic non-validation failures still flow through the existing `Failed: ${err}` path.

### Cross-references

- Validator implementation + supported subset: `src/workflows/json-schema-validator.ts`
- Engine throw site: `src/workflows/engine.ts:31-36` (`TriggerSchemaError` class) and `:54-60` (validation gate)
- HTTP 400 helper: `src/http/utils.ts` (`triggerSchemaErrorResponse`)
- MCP error formatting: `src/tools/workflows/trigger-workflow.ts` (`TriggerSchemaError` branch)

## Event triggers

An enabled workflow can subscribe to an event that starts a new run:

```json
{ "type": "event", "eventName": "slack.message" }
```

The event payload becomes the run's `triggerData` and passes through the workflow's optional `triggerSchema` validation. `slack.message` is currently wired as a start trigger during workflow initialization; the generic dispatcher can support more named bus events as their listeners are added.

## Wait nodes

A `wait` node pauses a workflow until either a duration elapses or a named event satisfies a filter. It is async — the run transitions to `waiting` and resumes via the `wait-poller` (time mode + event-mode timeout) or the `workflowEventBus` listener (event mode).

### Modes

**Time mode** — pause for `durationMs`:

```yaml
- id: cool-down
  type: wait
  config: { mode: time, durationMs: 86400000 }   # 24h
  next: { default: downstream-node }              # or simply: next: downstream-node
```

`durationMs` accepts integers from `1` (1ms) to `31_536_000_000` (1 year). The **effective minimum** is ~5s — the wake-up poller ticks every 5s, so anything shorter still works but is rounded up to the next tick. There is no practical upper bound; the run just stays `waiting` until either the wake-up fires or the workflow is cancelled.

**Event mode** — pause until a named event arrives whose payload satisfies a filter:

```yaml
- id: pr-merged
  type: wait
  config:
    mode: event
    eventName: github.pull_request.merged
    filter: { number: "{{trigger.pr.number}}" }
    scope: run                       # 'run' (default) | 'global'
    timeoutMs: 86400000              # 24h — when reached, routes via 'timeout' port below
  next:
    event:   downstream-on-event
    timeout: downstream-on-timeout
```

`timeoutMs` accepts integers from `1` to `31_536_000_000` (1 year). Effective resolution is ~5s (poller cadence). Omit it for an unbounded wait (no `timeout` port needed).

`scope` semantics:

- `scope: run` (default): the listener requires the payload to carry `_runId` or `workflowRunId` matching this run's id. Run-scoped HTTP signals inject `_runId` automatically; built-in lifecycle events (`task.completed` and friends emitted from `src/be/db.ts`) already include `workflowRunId` in their payload, so they correlate naturally.
- `scope: global`: skip the run-id check. Use for cross-run signals (e.g. `release.cut` broadcasts).

### Output ports

- Time mode → `default` only.
- Event mode without timeout → `event`.
- Event mode with timeout → `event` (signal arrived) or `timeout` (`expiresAt` reached first).

### Signal endpoints

External callers can fire arbitrary events into the bus via two HTTP routes (both auth via `Authorization: Bearer ${API_KEY}`):

```bash
# Run-scoped: payload is augmented with { ..., _runId: "<runId>" } before emit.
curl -X POST http://localhost:3013/api/workflow-runs/<run-id>/events \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{ "name": "demo.signal", "payload": { "ok": true } }'

# Global broadcast: payload is emitted as-is. Wait nodes with scope: global can match.
curl -X POST http://localhost:3013/api/workflow-events \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{ "name": "release.cut", "payload": { "version": "1.2.3" } }'
```

### Built-in event names (no extra wiring required)

The following events are already emitted on `workflowEventBus` today and are usable from a wait node out of the box:

| Event | Source | Payload highlights |
|---|---|---|
| `task.completed` / `task.failed` / `task.cancelled` | `src/be/db.ts` (around the `completeTask`/`failTask`/`cancelTask` paths) | `{ taskId, output|failureReason, agentId, workflowRunId, workflowRunStepId }` |
| `task.created` / `task.progress` / `task.budget_refused` | `src/be/db.ts` | task-id keyed lifecycle payloads |
| `approval.resolved` | `src/http/approval-requests.ts:183` | `{ requestId, status, responses, workflowRunId, workflowRunStepId }` |
| `agentmail.message.received` | `src/agentmail/handlers.ts:168` | inbox/message keyed payload |
| `slack.message` | `src/slack/handlers.ts` | `{ channel, text, user, ts, threadTs }` |
| `github.pull_request.<action>` | `src/http/webhooks.ts:177` | full GitHub PR payload |
| `github.issue.<action>` | `src/http/webhooks.ts:192` | GitHub issue payload |
| `github.issue_comment.created` | `src/http/webhooks.ts:202` | comment payload |
| `github.pull_request_review.submitted` | `src/http/webhooks.ts:211` | review payload |
| `gitlab.merge_request.<action>` | `src/http/webhooks.ts:294` | full GitLab MR payload |
| `gitlab.issue.<action>` | `src/http/webhooks.ts:308` | GitLab issue payload |
| `gitlab.note.created` | `src/http/webhooks.ts:318` | note payload |
| `gitlab.pipeline.<status>` | `src/http/webhooks.ts:327` | pipeline payload |

For `task.completed` specifically, the canonical payload shape lives in `src/be/db.ts` next to the emit site. Because it includes `workflowRunId`, you can use a `scope: run` wait with a filter like `{ workflowRunId: "<the run id>" }` to correlate against a specific upstream task — see "Ordering caveat" below.

### What's NOT yet on the bus

The following sources do **not** currently emit on `workflowEventBus`. Hooking each one in is a one-line `workflowEventBus.emit(name, payload)` follow-up in the relevant handler — tracked as separate plans:

- Linear webhooks (`src/linear/`, `src/http/trackers/linear.ts`)
- Jira webhooks (`src/jira/`, `src/http/trackers/jira.ts`)
- Sentry alerts
- Stripe events
- Claude-managed callbacks

Until those land, fire signals manually via the HTTP endpoints above.

### Filters (event mode)

The `filter` field accepts two shapes:

**Object form (recommended)** — flat key/value map. Each key may use dot-paths into the payload; values must deep-equal:

```yaml
filter:
  number: 4242
  pr.author.login: alice
```

No `eval` risk, declarative, easiest to author. Missing keys → no-match. Type mismatch (string vs number) → no-match. Multiple keys must all match. Omitting `filter` matches any payload that satisfies the scope check.

**String form (escape hatch)** — JS arrow-function source:

```yaml
filter: "(payload) => payload.labels.some(l => l.name === 'release') && payload.number > 1000"
```

Compiled with `new Function(...)` inside a sandbox that shadows `require`, `process`, `Bun`, `globalThis`, `global`, `fetch`, `setTimeout`, `setInterval`, `eval`, `Function`, `AsyncFunction` to `undefined`. Result is coerced to boolean. Throws → no-match.

Hardening (all enforced):

- 50ms execution timeout — infinite loops and catastrophic-backtracking regex resolve to no-match.
- 2KB cap on filter source length (rejected at the Zod boundary).
- Parsed at executor-init time so syntax errors fail the workflow definition, not the first event.

Prefer the object form unless the predicate genuinely needs JS (multi-clause boolean logic, array membership, etc.).

### Ordering caveat

A wait node must subscribe to its event **before** the event fires. Chaining a wait directly off the upstream that emits the awaited event:

```yaml
# DOES NOT WORK — by the time execution reaches `wait`, `task.completed`
# has already been delivered to current listeners and is gone.
- id: t1
  type: agent-task
  next: w1
- id: w1
  type: wait
  config: { mode: event, eventName: task.completed }
```

…will hang forever, because the wait subscriber is only created after the upstream task completes, and the bus event is one-shot.

Two valid patterns:

1. **Fan-out** — branch the wait off an earlier node so the wait registers concurrently with the work that emits the event:

   ```yaml
   - id: entry
     type: script
     config: { runtime: bash, script: "echo go" }
     next: [t1, w1]                      # parallel
   - id: t1
     type: agent-task
     next: done
   - id: w1
     type: wait
     config:
       mode: event
       eventName: task.completed
       filter: { workflowRunId: "{{trigger.runId}}" }
     next: { event: done }
   - id: done
     type: notify
     config: { template: "both done" }
   ```

2. **External signal** — wait for an event whose source is downstream/external (HTTP `POST` to the signal endpoints, GitHub webhook, etc.). Subscription happens at the wait and the signal arrives later from outside.

### Multi-instance limitation

`workflowEventBus` is an in-process `EventEmitter` (`src/workflows/event-bus.ts`). With multiple API replicas, a signal emitted on instance A will not reach a wait paused on instance B. Single-instance only for v1; cross-instance fan-out (Redis pub/sub, etc.) is a separate plan.
