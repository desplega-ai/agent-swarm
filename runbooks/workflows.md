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
- `profile` (preferred way to pick the model: a model profile name, see `list-model-profiles`; exclusive with `model` and `modelTier`). Save rejects a static unknown profile, or one a static `agentId` fails the profile check on (`Node "<id>" config.profile: …`). The node re-checks the interpolated value at run and fails with the check's message. Deleting a profile a definition names is not blocked; the node fails at run.
- `model` (concrete override; `modelTier` is deprecated, pass `profile: "<harness>-<tier>"` instead)
- `parentTaskId`

## Foreach nodes

`foreach` runs its `body` once per array item, waits for every item, then exposes one
parent-owned aggregate to downstream nodes. The body can be any registered executor except
`foreach`; `sub-workflow` runs one child workflow per item.

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
- `body.type` is any registered executor except `foreach` (nested fan-out is rejected, with the node
  id in the error). `body.config` is that executor's normal config, checked against its schema at
  authoring, and is interpolated separately for each child with `item` and zero-based `index`. A
  `script` body keeps the script-source allowlist: pass the item through `args`.
- Each child row carries the body's `nodeType`. Children are created `pending` in one transaction,
  then the foreach driver (`src/workflows/foreach-driver.ts`) starts them. Instant bodies (`script`,
  `swarm-script`, `raw-llm`, `notify`, ...) run one per item, each against its own watchdog budget,
  not the parent's. Async bodies (`agent-task`, `sub-workflow`, `human-in-the-loop`, `wait`,
  `system-one-decision` with `humanReview`) park, and their normal resume path settles the item
  through `settleForeachChild` (`src/workflows/foreach-join.ts`).
- A body's ports do not route. An approval `rejected`/`timeout` or a wait `timeout` still counts as a
  completed item; its `nextPort` is stored on the child row for display.
- Child steps have synthetic IDs `<foreachNodeId>#<itemKey>`. The parent remains waiting until all
  children are terminal; only the parent aggregate is written to workflow context.
- Empty arrays complete synchronously and still route to the successor.
- `concurrency` (an integer, 1 or more) caps how many items are in flight. Without it every item
  starts at once. The child rows are the state: `pending` is queued, `running` or `waiting` is in
  flight, and only the latest attempt row per item counts. Every item settlement starts the next
  queued item, and the recovery sweep backs that up after a restart. The in-flight count and the
  claim share one `BEGIN IMMEDIATE` transaction, so concurrent drives never exceed the cap.
- `failurePolicy` is `fail-fast` or `collect-outcomes` (see below).
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

Only an item that completed without an error counts in `okCount`. Failed, cancelled and skipped
items count in `failedCount`; `cancelledCount` is added when any item was cancelled.

### Failure policies

`config.failurePolicy` decides what a failed or cancelled item does. Without it, the policy follows
the workflow's `onNodeFailure`: `"continue"` means `collect-outcomes`, the default `"fail"` means
`fail-fast`. Existing definitions behave as before.

- **fail-fast**: the first failed or cancelled item cancels every queued item (`error: "not started:
  fail-fast after item <key> failed"`) and fails the run. Items already in flight finish and record
  their outcome on their row; they never revive the run. The parent step stays open, so a run retry
  resumes the fan-out.
- **collect-outcomes**: every item reaches a terminal state, the parent completes with its
  `failedCount`, and successors route. A failed agent-task item contributes a `failed` result whose
  output carries the `[FAILED: <reason>]` marker. Item failures do not count against the run's
  outcome; the parent step is authoritative.

### Retry with preserved siblings

`retry-workflow-run` on a failed fan-out adds a new attempt row for each item whose latest row is
`failed` or `cancelled`: same child node id and `nodeType`, a fresh step id, `input.attempt: n`, and
idempotency key `<runId>:<childNodeId>:<n>`. The fresh step id is a fresh invocation identity for
every body type: a new task, a new child run, a new approval or a new wait. Completed items are never
rerun, and earlier attempt rows stay as history. A double retry inserts nothing twice. Items are
picked when the retry commits, so a sibling that failed late is retried too. A retry whose new rows
would reach `WORKFLOW_MAX_STEPS_PER_RUN` is refused before it inserts anything, and the run stays
failed: the retry walk itself needs one step of headroom.

A collect-outcomes run completes, so it is not retried. To rerun its failed items, add a follow-up
wave over `{{w.results}}` filtered to `status != "completed"`, under a new node id.

### Dependency waves

Each wave is its own `foreach` node, so its item keys are independent. A script between waves
builds the next wave's items from earlier results. The running definition is never patched.

```yaml
- id: plan
  type: swarm-script
  config: { scriptName: plan-waves }   # result: { wave1: [...], wave2: [{ id, dependsOn }] }
  next: wave1
- id: wave1
  type: foreach
  inputs: { p: "plan" }
  config:
    over: "{{p.result.wave1}}"
    itemKey: id
    concurrency: 3
    failurePolicy: fail-fast
    body:
      type: sub-workflow
      config: { workflowId: "<build workflow id>", inputs: { spec: "{{item}}" } }
  next: prep2
- id: prep2
  type: swarm-script
  inputs: { p: "plan", w1: "wave1" }
  config:
    scriptName: prep-wave2           # returns wave2 jobs with `deps` from w1.results[].output
    args: { wave1: "{{w1}}", wave2: "{{p.result.wave2}}" }
  next: wave2
- id: wave2
  type: foreach
  inputs: { prep: "prep2" }
  config:
    over: "{{prep.result}}"
    itemKey: id
    concurrency: 3
    body:
      type: sub-workflow
      config:
        workflowId: "<build workflow id>"
        inputs: { spec: "{{item}}", deps: "{{item.deps}}" }
```

A sub-workflow passes a non-string input value to the child as JSON text, so the child parses
`trigger.spec`. `src/tests/workflow-foreach-retry.test.ts` runs this definition end to end.

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

Who may answer (`POST /api/approval-requests/{id}/respond`, permission `approval.respond`):

- Only a person. A user token (`aswt_`) or a page session signed for a user answers as that user's
  id. The shared key with no agent identity answers as `operator`. An agent is refused: an
  `aseph_` session token, the shared key with `X-Agent-ID`, or a page session with no signed-in
  user. The body's `respondedBy` is stored as an unverified `claimedRespondedBy`, never as
  `resolvedBy`.
- `approvers.users` entries match a user's id or email; `approvers.roles` entries match the user's
  `role`. With neither set, any person may answer. The operator may answer any request.
- `policy`: a rejection resolves the request at once. `any` resolves on the first approval,
  `{ min: N }` on N distinct responders, `all` when every listed user has approved (one approval
  when no users are listed). Until then the request stays `pending` and each answer is kept in
  `approvals`. A responder answers once.

Rendering limits:

- The dashboard approval page lists every question as its own card. No cap beyond the 100-question
  node limit.
- On the dashboard, `label` and `description` render as markdown. Fenced code with a language
  scrolls; without one it wraps. Only `description` turns a bare image URL on its own line (or
  `![alt](url)`) into an image. Author guidance lives in the `workflow-iterate` skill.
- The Slack notification lists question labels in one section block, capped by Block Kit at 3000
  characters. When the labels do not fit, the tail becomes `…and N more` and the reviewer answers
  on the dashboard via the card's button. Labels are escaped, so upstream text cannot add mentions
  or links.

## Sub-workflow nodes

A `sub-workflow` node runs another workflow as a child run and waits for it.

```yaml
- id: build
  type: sub-workflow
  inputs: { plan: "planner.taskOutput" }
  config:
    workflowId: "<child workflow id>"
    inputs: { spec: "{{plan.spec}}" }
  next: review
```

- `config.inputs` becomes the child's `trigger` data and is validated against the child's
  `triggerSchema`. The child must exist and be enabled.
- Output: `{ runId, outputs, error? }`. `outputs` holds the child's node outputs keyed by node id;
  `trigger` and `input` (which can hold resolved secrets) are left out. `error` is set when the child
  completed with a partial failure. Downstream: `inputs: { b: "build" }`, then
  `{{b.outputs.<childNodeId>.taskOutput}}`. The node routes on the `success` port.
- The child run walks on its own, outside the parent executor's 30s timeout. The step and the
  parent run stay `waiting` until the child run is terminal, so the parent never completes while its
  child is running, waiting on a human, or awaiting a retry.
- A child that fails, is cancelled, or is skipped (cooldown) fails the node and the parent run,
  whatever `onNodeFailure` says. Node `retry` is a new attempt: it starts a new child run, and the
  previous attempt's child can no longer settle the step.
- The child run stores the parent step and that step's attempt (`retryCount`) in
  `workflow_runs.parentStepId` / `parentStepAttempt` (unique together). One attempt has at most one
  child: a re-executed or recovered step reconnects to it, and concurrent executions get the same
  child. The child is created in one transaction with its initial context, and only while the
  parent step's attempt is still `running` in a live run. A step a crash left `running` is
  re-claimed by recovery under the same step id, so it reconnects instead of starting a second
  child. The child's terminal status emits `workflow.child.finished` after commit. The engine and
  the retry poller recheck the child once the step parks, and the recovery sweep resumes any
  waiting step whose child already finished, so a lost event or a restart does not strand the
  parent. Only the call that claims the waiting step routes its successors.
- Deleting a workflow fails every waiting step that started one of its runs as a child. Recovery
  also fails a waiting step whose child row is missing.
- Recursion is rejected: a workflow cannot invoke itself or any workflow already running in its
  ancestor runs, and nesting stops at 16 levels below the root run (`MAX_SUB_WORKFLOW_DEPTH`). The
  checks run when the node executes, not when the definition is saved.
- Not yet supported (tracked in the sub-workflow issue): pinning the child's definition version
  (the child runs its live definition), cancelling the child when the parent is cancelled, and a
  per-node timeout. As a `foreach` body, a run retry gives the failed item a new child run (see
  [Retry with preserved siblings](#retry-with-preserved-siblings)).

## Agent-task steps cut by a deploy

A deploy drain or heartbeat remediation fails an in-flight workflow-step task with
`superseded_workflow_task` (`SUPERSEDED_WORKFLOW_TASK_REASON`) instead of creating a resume child.
`scheduleTaskStepRetry` (`src/workflows/task-step-routing.ts`) turns that cut into a retry:

- An `agent-task` node without `retry` gets `SUPERSEDE_RETRY_POLICY`: one retry, `static`, 30s.
  Only this reason qualifies; any other failure follows `onNodeFailure` as before.
- An explicit node `retry` always wins. `retry: { maxRetries: 0 }` is the opt-out for a node with
  external side effects that must not run twice.
- A second cut exhausts the implicit retry and follows `onNodeFailure`.
- Foreach children (`<foreachId>#<key>`) are not covered: the retry poller resolves the node by
  exact id (`src/workflows/retry-poller.ts`) and cannot re-dispatch a child step. Automatic per-item
  retry is a follow-up to #2029; until then, a cut item follows its fan-out's failure policy, and a
  fail-fast run is resumed with `retry-workflow-run`, which reruns only the failed items.

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

Inline executable source may interpolate only `input`, `workflow`, `swarm`, and `run` values. It may not splice `trigger` data or declared upstream aliases directly into source. Pass those dynamic values through `config.args`, which the script receives as argv. For `runtime: "bash"`, the engine runs `bash -c <script> ...args`, so `args: ["a", "b"]` gives `$0=a` and `$1=b`; for `runtime: "ts"`, it runs `bun -e <script> -- ...args`, so the same args give `Bun.argv[1]="a"` and `Bun.argv[2]="b"`. A disallowed or unresolved source token fails the node before execution instead of running partially blanked code.

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

A `raw-llm` node's `model` picks its endpoint. A model prefixed with an OpenAI-compatible registry provider id (`nan/qwen3.8-flash`, `helmcode/<model>`) goes to that provider's base URL with its key (`NAN_API_KEY` or its alias), and fails when the key is missing instead of falling back to OpenRouter. Any other model goes to the resolved OpenRouter or OpenAI credential. Check `schema` support per model: NaN's `deepseek-v4-flash` rejects `json_schema` output, while `qwen3.8-flash`, `qwen3.6` and `gemma4` accept it.

Jev is weak at counting. For a hybrid, count in a `script` and pass the number to `system-one-decision` as part of `state`. The `workflow-iterate` skill carries the same rule for agents that edit workflows.

## SystemOne Decision nodes

A `system-one-decision` node (display name "SystemOne Decision") makes typed decisions with a SystemOne decisions model. Jev (through TypeSafe or OpenRouter) and Clef (on Cloudflare Workers AI) are peers; laya and OpenAI are also hosts (see Providers). The node name is not tied to one model. It answers at once, and waits only when `humanReview` sends an answer to a person (see Human review). One call sends one `state` and a map of questions, and the node returns one validated answer per question.

```yaml
- id: qualify
  type: system-one-decision
  inputs: { lead: "trigger.lead" }
  config:
    provider: typesafe # or openrouter, cloudflare, laya, openai; unset = SYSTEM_ONE_DEFAULT_PROVIDER
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

- `provider`: `typesafe`, `openrouter`, `laya`, `openai`, or `cloudflare`. Unset means the `SYSTEM_ONE_DEFAULT_PROVIDER` global config value, read at run time (`typesafe` when that is unset too). A literal, not a `{{token}}`, because it decides which settings are checked before the run starts. See Providers.
- `state` (required): text, a string array, or a JSON object. An exact `{{token}}` keeps the upstream JSON type; mixed text is interpolated as a string. Resolved content is never interpolated again.
- `questions` (required): a map of question id to a `noul`, `choice`, or `score` question. Ids match `[A-Za-z_][A-Za-z0-9_-]*`. Ids and types are static. Only `state` and the descriptions may use `{{tokens}}`.
  - `noul`: `instructions`, optional `criteria: { true?, false? }`. The answer is a probability that the claim is true.
  - `choice`: `instructions`, `criteria: { option: description }` with 2 to 255 options.
  - `score`: `instructions`, `criteria: [level, ...]` with 2 to 10 ordered levels.
- `returns` (required): every question id with its `type`. Config validation rejects a missing id, an extra id, or a type that disagrees with the question. It is checked, never sent to the API.
- `model`: the provider's own model id. Unset means the provider's default (`jev-latest` on `typesafe`, `~typesafe/jev-latest` on `openrouter`, `gpt-6-luna` on `openai`, `clef` on `cloudflare`). `cloudflare` accepts only `clef` and `clef-flash`, checked at save for a literal and at run for a `{{token}}`. `laya` has no default: unset sends no `model` and laya picks the checkpoint itself. Pin a version for a calibrated workflow: `jev-1.13.0` on `typesafe`, `typesafe/jev-1.13` on `openrouter`, a checkpoint name such as `multilingual` on `laya`.
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

`model` is the version the API reports. `requestId` is added when the API sends a request-id header. `routing` is `{ model }`, the checkpoint that answered, and is added only when the host reports one (`laya`); a missing or malformed `routing` is left out and never fails the step. `usage` is the token count of the successful call. Success needs exactly one answer of the declared type per question: a missing answer, an unknown choice, a score outside `0` to `levels - 1`, wrong probability keys, or a distribution that does not sum to 1 (tolerance `0.02`) fails the step. A `noul` answer stays `{ type, noul }`. It has no confidence field and the node never adds one.

Downstream nodes read `<alias>.answers.<question>.<field>` through an `inputs` mapping, for example `inputs: { qualification: "qualify" }` and `qualification.answers.authority.confidence`.

### Providers

| `provider` | Host | Key (global secret) | Default `model` |
|---|---|---|---|
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` | `jev-latest` |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `OPENROUTER_API_KEY` | `~typesafe/jev-latest` |
| `laya` | `<LAYA_URL>/v1/systemone` (`LAYA_URL` is a global config value) | `LAYA_API_KEY` | none: no `model` is sent |
| `openai` | `https://api.openai.com/v1/decisions` (beta) | `OPENAI_DECISIONS_API_KEY` | `gpt-6-luna` |
| `cloudflare` | `https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/ai/run/@cf/cloudflare/<model>` (`CLOUDFLARE_ACCOUNT_ID` is a global config value) | `CLOUDFLARE_API_TOKEN` | `clef` |

Every node gets the same output, so `returns`, the output shape, and the validation rules are the same on each provider. `typesafe`, `openrouter`, `laya`, and `cloudflare` take the SystemOne request as is; `openai` speaks its own Decisions format, and a per-provider `wire` translates it both ways (see Other backends: OpenAI). Confidence differs per host (see Human review). The list lives in `SYSTEM_ONE_PROVIDERS` (`src/workflows/executors/system-one-providers.ts`); adding a host is one entry there, plus a `wire` when it does not speak SystemOne. `openrouter` reads its key through `resolveWorkflowLlmConfig`, the resolver `raw-llm` uses, and never falls through to `OPENAI_API_KEY`.

A node that names no provider uses `SYSTEM_ONE_DEFAULT_PROVIDER` (Settings → Configuration, Workflows group; any decide host id, `typesafe` when unset). The executor, the readiness check, and the `system-one-decide` tool resolve it at each run (the stored global row first, then the environment), so switching the swarm to Clef is one setting and no workflow edit. The dashboard node card shows the effective provider and model. A node that names a provider ignores the setting. Because the default is resolved at run, a defaulted node's model allowlist and question limit are checked when it runs, not at save.

There is no fallback between providers. A node does not move to another provider when its key is missing: accounts bill separately and use different model ids, and the key the preflight names must be the key the node uses. Switch by setting `provider` or the default.

Use the decisions endpoint only. OpenRouter's `typesafe/jev-router` is a router that forwards a chat request to another model (a live call was served by `openai/gpt-6-luna`), and `~typesafe/jev-latest` rejects chat/completions with "is a decisions model". `openrouter` refuses to run when `OPENROUTER_BASE_URL` points at a gateway, because the key may be a gateway token and the decisions API is not a chat route.

### Keys and preflight

Each provider needs its key as a global secret (Settings > Secrets, or `set-config` with scope `global` and `isSecret` true). `laya` also needs `LAYA_URL`, its server's base URL, and `cloudflare` needs `CLOUDFLARE_ACCOUNT_ID`, as global config values (`set-config`, scope `global`, not secret). The swarm checks these before first use, and every message names the exact key or config value for the node's provider and where to set it. A `laya` or `cloudflare` node with neither set gets one message that names both:

- **Save** (`create-workflow`, `update-workflow`, `patch-workflow`, `patch-workflow-node`, and the matching HTTP routes): the save succeeds and returns a warning when a `system-one-decision` node's key (or, for `laya`, its `LAYA_URL`) is missing or unreadable. MCP puts it in the result message and `data.warnings`. HTTP adds `warnings` to the workflow body, only when there is one. It is a warning, not a rejection: definitions are also saved before a human has supplied the key (template installs, seeders, version restores, authoring ahead of a key request), and the key can change after any save, so a save-time gate would block valid work without guaranteeing anything.
- **Run start**: a run of a definition with a `system-one-decision` node whose key or `LAYA_URL` is missing fails before any node executes, with the same named error. The run is recorded as `failed`, has no steps, and sends no request. This is the guarantee. It covers manual, schedule, webhook, and event triggers.
- **Retry**: `retry-workflow-run` refuses, and leaves the run failed, when a node still to run needs a key or `LAYA_URL` that is missing.
- **A key that exists but is refused**: a 401 or 403 fails the step with `<KEY> was rejected by <host> (HTTP <status>)` and tells the operator to replace it. It is not retried. Presence is what the run-start check can confirm without a paid call, so a wrong key still surfaces at the first `system-one-decision` step; the `workflow-iterate` skill has authors confirm the key with one cheap call before building the node.

The key value never appears in a definition, a warning, a step output, or an error. `LAYA_URL` is where the `laya` key is sent, so a value that is not an `https` URL (plain `http` is accepted for `localhost` only), or that carries credentials, a query, or a fragment, is refused with `LAYA_URL is not a usable laya server URL` and is never echoed. A trailing slash is ignored and a path is kept (`https://host/laya/` becomes `https://host/laya/v1/systemone`).

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
- **Which number is the confidence.** `choice` and `score` answers report `confidence`, and it is used as the provider reports it. On `laya` that is its `answer_confidence`, the top probability, not its entropy-based `confidence` (see Other backends: laya). A `noul` answer reports none, so the band is tested against `max(noul, 1 - noul)`, the probability of the side the model took. The `noul` answer stays `{ type, noul }`; the tested number is recorded in `review.questions`. The number is the provider's own, so a band tuned on one provider or model does not carry to another.
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

`laya` (`@desplega.ai/laya-server`, from laya-js) answers the same kind of question on `POST /v1/systemone`. Set `provider: laya`; no other node field changes.

```yaml
- id: triage
  type: system-one-decision
  inputs: { ticket: "trigger.ticket" }
  config:
    provider: laya
    state: { message: "{{ticket}}" }
    questions:
      team:
        type: choice
        instructions: Which team should handle the ticket in `message`?
        criteria: { billing: Charges and invoices, technical: Bugs and outages, sales: Pricing }
    returns:
      team: { type: choice }
    humanReview:
      band: { min: 0.5, max: 0.8 }   # tested on answer_confidence, the top probability
      approvers: { users: [support-lead], policy: any }
  next: { approved: route, rejected: escalate, timeout: escalate }
```

Set `LAYA_URL` (global config, the server's base URL) and `LAYA_API_KEY` (global secret) first. The URL is never in the definition. A run of a `laya` node with either missing fails before any node executes.

| This node | laya (`SystemOneResult`, `POST /v1/systemone`) |
|---|---|
| request `{ state, model, questions }` | the same body. `model` is a checkpoint name (`english`, `multilingual`, `typed-decisions`) or omitted to auto-route, and the node omits it when its config sets none. laya-server also takes `max_len` and `head_max_len`, which the node does not send |
| question `{ type, instructions, criteria }` | the same shape. laya also accepts a list of labels for a `choice`. Limits differ: laya allows 100 choice options (node: 255) and 32 score levels (node: 10), and its docs advise against boolean-word labels such as `yes` |
| `model` | `model` (`laya-rl-agent`, the same for every checkpoint) |
| `routing.model` | `routing.model`: the checkpoint that answered (`english`). The rest of `routing` (`repo`, `reason`, `detection`) is not kept |
| `answers.<q>` `choice` / `score` / `noul`, `probabilities`, `legend` | the same fields and types; `score` is the expected level, so fractional |
| `answers.<q>.answer_confidence` | `answers.<q>.confidence` (see below) |
| `usage` `{ input_tokens, output_tokens }` | the same; `output_tokens` is `0`, and `usage.windows` from `predictLong` is dropped |
| not kept | laya's own `confidence`, `action`, `low_confidence`: dropped by the validator, as any extra provider field is |

Every row is checked by a test that feeds a laya-shaped result through the same validator and band (`src/tests/workflow-system-one-decision-review.test.ts`), and the mapping was run against `https://laya.agent-swarm.dev`.

- **`model` is not defaulted.** laya answers a `model` it does not know with HTTP 200 and routes on the text instead (`jev-latest` and a typo both went to `english`), so a default would be sent as if it meant something. Leaving `model` unset auto-routes. A `model` you set is sent as written, and a misspelled one is still ignored by laya: read `routing.model` to see which checkpoint answered.
- **Which confidence.** laya reports two numbers for a `choice` or `score`. Its `confidence` is entropy-based (a top probability of 0.47 reads about 0.15). Its `answer_confidence` is the top probability. The node reads `answer_confidence`, so `output.answers.<q>.confidence` and the `humanReview` band are the top probability. Reason: a `noul` answer's band number is already the probability of the side taken, and the band is one number per node, so it now means the same on every question type. Cost: laya's entropy-based number, which also reflects how the rest of the probability is spread, is not kept; a band copied from a TypeSafe workflow still needs tuning, and a laya server that omits `answer_confidence` fails the step (`answers.<q>.answer_confidence must be a finite number between 0 and 1`) rather than quietly falling back to the other number.
- **The key is required.** A laya server that runs without a token is not supported by this provider: the preflight asks for `LAYA_API_KEY`.
- **Prefer `choice` over `noul` on laya for now.** Observed on laya-server 0.1.0: a `noul` sentiment question returned close to 0 for every input, clearly positive text included, while the same judgment as a three-way `choice` answered positive 0.94, negative 0.98, and mixed 0.71. This is a model observation, not a node rule; the node accepts `noul` on laya and validates it as on any provider. Check a `noul` question against known inputs before routing on it.

A complete workflow (setup, a manual trigger, this node with a review band, and a branch on the answer) is the "Example: a laya decision end to end" section of [concepts/workflows.mdx](../docs-site/content/docs/(documentation)/concepts/workflows.mdx).

#### Self-hosting: running your own laya server

A swarm that uses `provider: laya` needs a laya server of its own. Nothing goes through a desplega API: the swarm's API server POSTs to `${LAYA_URL}/v1/systemone` with `Authorization: Bearer ${LAYA_API_KEY}` (`SYSTEM_ONE_PROVIDERS` in `src/workflows/executors/system-one-providers.ts`, request in `system-one-decision.ts`).

- **Run the server.** Install `@desplega.ai/laya-server` from npm (Node 22+), or build the image from laya-js's Dockerfile; no container image is published. laya-js has a Kubernetes example in `deploy/k8s` and per-platform guides in [docs/deploy](https://github.com/desplega-ai/laya-js/tree/main/docs/deploy). The weights download from the public Hugging Face repo `desplega/laya-onnx` with no token.
- **Reachability.** `LAYA_URL` must be reachable from the swarm's API server, not from the workers. It must be `https`, except for `localhost`.
- **The key.** Set the same value as `LAYA_API_KEY` in the laya server's environment and as the swarm's global secret. laya-server accepts unauthenticated calls when its `LAYA_API_KEY` is unset, but the swarm always requires the secret.
- **Sizing.** laya-js's docs size one fp32 checkpoint at about 3 GB of RAM, and the Kubernetes example requests 1 CPU with a 3 GiB limit. Its own evals measured the Docker image peaking at 7.0 GB RSS under load (laya-js PR #12, Phase 10); a fix is in progress. Until it lands, give the container about 8 GB, not 3 GiB.
- **No laya server?** Use `typesafe` (only `TYPESAFE_API_KEY`) or `cloudflare` (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`).

### Other backends: OpenAI

`openai` calls the OpenAI Decisions API (public beta, model `gpt-6-luna`). The node config is unchanged; the request and response are translated:

| Node | OpenAI request | OpenAI answer | Node answer |
|---|---|---|---|
| `noul` | `predicate`; `criteria.true` / `criteria.false` are appended to `instructions` as `True when:` / `False when:` | `probability` | `noul` |
| `choice` | `choices: [{ value: <option id>, description }]` | `choice`, `probabilities: [{ value, probability }]`, `confidence` | `choice`, `probabilities` map, `confidence` |
| `score` | `levels: [{ label }]`, a null level labelled by its index | `score`, `probabilities: [{ value: <level>, label, probability }]`, `confidence` | `score`, `probabilities` map, `legend` from the node's own criteria, `confidence` |

- `state`: a string is sent as `input`; a string array becomes one user message of `input_text` parts; a JSON object is sent as JSON text.
- Questions are sent in config order, each with `name: <question id>`. Answers are matched by `name`, so order does not matter. A duplicate or unknown name fails the step.
- **A refusal fails the step.** OpenAI can answer any question with `{ type: "refusal" }`. A refusal is not an answer of the declared type, so the step fails with `OpenAI refused question "<id>"; no decision was made`, is not retried, and keeps none of the other answers. Route it with the step's failure handling.
- `usage` keeps `input_tokens` and `output_tokens`; other usage detail is dropped.
- **The key is `OPENAI_DECISIONS_API_KEY`, never `OPENAI_API_KEY`.** A global `OPENAI_API_KEY` row reaches every worker's environment and can change harness auth, and the key needs Decisions beta access. A swarm with only `OPENAI_API_KEY` fails preflight with `OPENAI_DECISIONS_API_KEY is not configured`.
- `confidence` is OpenAI's own field, not the top probability (the guide's choice example has top probability 0.95 and confidence 0.93), so a band tuned on Jev does not carry over.

### Cloudflare Clef

`cloudflare` runs Clef (27B) or Clef-flash (9B) on Workers AI. Clef takes the SystemOne request unchanged; the response arrives in Cloudflare's `{ result, success, errors, messages }` envelope, which the node unwraps.

```yaml
- id: triage
  type: system-one-decision
  config:
    provider: cloudflare
    model: clef-flash        # or clef (the default)
    state: "{{ticket.body}}"
    questions:
      urgent: { type: noul, instructions: Is this request urgent? }
    returns:
      urgent: { type: noul }
```

- Needs `CLOUDFLARE_ACCOUNT_ID` (global config, the 32-character hex account id) and `CLOUDFLARE_API_TOKEN` (global secret, a token with the Workers AI permission on that account). When `CLOUDFLARE_API_TOKEN` is unset, the same bearer token is read from `CLOUDFLARE_API_KEY`, and a rejection names the key that was sent. A malformed account id is refused and never echoed.
- `model` is part of the URL, so only `clef` and `clef-flash` are accepted.
- At most 64 questions per node, checked at save. Choice and score limits match the node's own (255 options, 10 levels). The context window is 65,536 tokens; Cloudflare truncates longer state.
- `success: false` fails the step with Cloudflare's error code. HTTP errors read the code from `errors[0].code`. The `cf-ray` header is the `requestId`.
- Pricing: Clef $0.24 and Clef-flash $0.09 per 1M input tokens.
- Calibration does not carry over from Jev. On the heartbeat gate's replay of 229 checklist ticks, Clef needed a threshold of 0.2 where Jev used 0.5 to miss no tick the Lead acted on (57 quiet ticks against Jev's 100). Re-tune any threshold or `humanReview` band before moving a workflow from Jev to Clef.

### Thresholds, retries, and credentials

- A valid low-confidence answer is a successful evaluation. To review the uncertain band, set `humanReview`. To route on a threshold yourself, keep it in the next node: `property-match` (`gt`, `lt`, `eq`) or `code-match` for `>=`, then `human-in-the-loop`. There is no global threshold.
- The executor retries connection errors, HTTP 408, 429, and 5xx (including 529) with exponential backoff and jitter, up to `maxRetries`. It honors `Retry-After` and fails instead of retrying early when the wait does not fit the budget. It never retries 401, 422, other 4xx, redirects, or an invalid success body.
- A `system-one-decision` node must not set `retry` or `validation.retry`. Engine retries are not status-aware and would re-send rejected requests. Workflow create and update reject it, and a stored definition that has it fails the step before any request.
- The node reads its provider's key on the server (see Keys and preflight). Errors carry the HTTP status, a short error code, and the request id, not the provider's message or your state.
- Any unresolved `{{token}}` in a `system-one-decision` config fails the step before the request, because the call is paid and not idempotent.

## SystemOne Extraction nodes

A `system-one-extraction` node (display name "SystemOne Extraction") reads typed values out of a text, and up to 4 images, with a System One extraction model: Cloudflare's Clairic on Workers AI today. It answers at once. One call sends `state` and a map of typed fields, and the node returns one validated answer per field.

```yaml
- id: claim
  type: system-one-extraction
  inputs: { email: trigger.email }
  config:
    state: "{{email}}"
    fields:
      order_id: { type: text, instructions: Order number }
      amount_paid: { type: number, decimals: 2, unit: USD, instructions: Total paid including tax }
      days_since_delivery: { type: duration, unit: days, integer: true }
      damage: { type: list, items: text }
      repair_cost: { type: estimate, unit: USD, min: 10, max: 5000, scale: log, step: 1 }
  next: decide
```

### `system-one-extraction` config

| Field | Notes |
|---|---|
| `provider` | Extraction host id, a literal. `cloudflare` (default). |
| `model` | `clairic` (default, the only id Cloudflare serves). |
| `state` | The text to read. A structured whole-token value is sent as JSON text, and spans index into that text. May be empty only when `images` are sent. |
| `images` | Up to 4: a base64 `data:image/png|jpeg|webp` URL or `{ content_type, base64 }`. 4 MiB each and 8 MiB total, decoded. Remote URLs are refused. |
| `referenceDate` | `YYYY-MM-DD`; anchors dates written without a year. |
| `fields` | Map of field id to a typed spec (below). Ids are letters, digits, `_`, `-`, at most 64 characters, no dots, so `answers.<id>` is a valid path. Static: field ids and types cannot be `{{tokens}}`. |
| `timeoutMs`, `maxRetries` | As on `system-one-decision`. |

Field specs use Clairic's option names and are sent unchanged. Each type takes only its own options; an unknown option, a missing `items`, a missing `min`/`max`, `min >= max`, a `log` scale with `min <= 0`, `integer` with `decimals > 0`, or `horizon` outside 1-64 is refused at save.

| Type | Options |
|---|---|
| `text`, `date`, `time`, `datetime` | `instructions`, `null_threshold` (0-1, the `p_null` above which `value` is null; default 0.5) |
| `number` | + `unit`, `integer`, `decimals` (0-6) |
| `duration` | + `unit` (`seconds`, `minutes`, `hours`, `days`, `weeks`, `months`, `years`), `integer`, `decimals` |
| `list` | `instructions`, `items` (`text`, `number`, `date`; required), `decimals` (number lists only) |
| `estimate` | `instructions`, `unit`, `min`, `max` (numbers, or ISO dates for a date estimate), `step` (a positive number, or `month` / `year` for dates), `scale` (`linear`, `log`) |
| `forecast` | `instructions`, `unit`, `min`, `max` (numbers), `horizon` (1-64), `interval` (`step`, `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`), `scale` |

### `system-one-extraction` output

```json
{
  "model": "clairic",
  "answers": {
    "order_id": { "type": "text", "value": "A-88412", "guess": "A-88412", "p_null": 0.0019, "confidence": 0.9999996, "span": [10, 17] },
    "amount_paid": { "type": "number", "value": 701.1, "guess": 701.1, "p_null": 0.00000003, "confidence": 0.99997 },
    "days_since_delivery": { "type": "duration", "value": 11, "guess": 11, "unit": "days", "p_null": 0.00000003, "confidence": 0.9956 },
    "tracking_number": { "type": "text", "value": null, "guess": "A-88412", "p_null": 0.9999992, "confidence": 0.959, "span": [10, 17] },
    "damage": { "type": "list", "value": ["cracked screen", "dented corner"], "spans": [[50, 64], [71, 84]], "confidence": 0.63 },
    "repair_cost": { "type": "estimate", "value": 236, "mean": 236.26, "median": 213, "p10": 122, "p90": 370, "p_below": 0.0000044, "p_above": 0.0000025 }
  },
  "usage": { "input_tokens": 739, "output_tokens": 0 },
  "truncated": false,
  "requestId": "<cf-ray>"
}
```

The answers above are a live `@cf/cloudflare/clairic` response to the damaged-order email (`delivered_on` omitted), trimmed to fewer digits.

- `value` is `null` when the input does not determine the field. `guess` and `confidence` still describe what the model saw, so `tracking_number` above guessed the order number and returned null because `p_null` is above `null_threshold`.
- An estimate's `value` is the rounded `mean`, not the `median`. Branch on `median`, `p10`, or `p90` when the spread matters.
- Every declared field must come back once, with its declared type and a value of that type (strings for `text`/dates/times, numbers for `number`/`duration`, integers when `integer` is set, typed list items, estimate `median`/`p10`/`p90`, forecast arrays of `horizon` steps). Anything else fails the step with `SystemOne response failed validation: ...`. Unknown answer keys are dropped.
- There is no `humanReview`. A reviewer of an extracted value has to type a replacement of the right type (a date, a duration, a quantile), which the approval card has no inputs for. Route a low `confidence` or a high `p_null` to `human-in-the-loop` with `property-match`.

### Providers and credentials

The provider registry (`SYSTEM_ONE_HOSTS` in `src/workflows/executors/system-one-providers.ts`) serves both node types. A host declares a `decide` and/or `extract` service, each with its endpoint, models, limits, and wire; the credential, the deployment check, readiness, the transport (`system-one-transport.ts`), and every message are the host's. Cloudflare serves Clef (`decide`) and Clairic (`extract`) from one entry and one credential. Adding an extraction host (for example an open-weights Clairic server) is one `extract` block with an endpoint and a wire.

- Cloudflare needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (or `CLOUDFLARE_API_KEY`), the same as Clef. Saving warns and a run fails before any node executes when either is missing.
- Retries, the time budget, `Retry-After`, the ban on `retry` and `validation.retry`, and strict `{{token}}` resolution are the same as for `system-one-decision`.
- Pricing: Clairic is $0.10 per 1M input tokens, with no output charge. Fields that do not fit beside the state in one 8,192-token pass are split across parallel passes.

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
| `approval.resolved` | `src/http/approval-requests.ts` (respond route) | `{ requestId, status, responses, workflowRunId?, workflowRunStepId?, sourceTaskId? }`; the run and step id are absent for a standalone request, so a `wait` node with `scope: "global"` and no filter also fires for those |
| `workflow.child.finished` | `src/be/db.ts` (`updateWorkflowRun`, terminal status of a run with a `parentStepId`) | `{ childRunId, parentStepId }` |
| `agentmail.message.received` | `src/agentmail/handlers.ts:168` | inbox/message keyed payload |
| `slack.message` | `src/slack/handlers.ts` | `{ channel, text, user, ts, threadTs }` |
| `chat.message.received` | `src/integrations/chat-sdk/inbound.ts` | `{ adapter, channelId, threadId, userId, text, messageId }` |
| `chat.message.sent` | `src/integrations/chat-sdk/outbound.ts` (relay, `chat-reply`, `chat-post`) and `inbound.ts` (steering acknowledgement) | `{ adapter, channelId, threadId, text, taskId?, messageId? }` |
| `github.pull_request.<action>` | `src/http/webhooks.ts:177` | full GitHub PR payload |
| `github.issue.<action>` | `src/http/webhooks.ts:192` | GitHub issue payload |
| `github.issue_comment.created` | `src/http/webhooks.ts:202` | comment payload |
| `github.pull_request_review.submitted` | `src/http/webhooks.ts:211` | review payload |
| `gitlab.merge_request.<action>` | `src/http/webhooks.ts:294` | full GitLab MR payload |
| `gitlab.issue.<action>` | `src/http/webhooks.ts:308` | GitLab issue payload |
| `gitlab.note.created` | `src/http/webhooks.ts:318` | note payload |
| `gitlab.pipeline.<status>` | `src/http/webhooks.ts:327` | pipeline payload |
| `bitbucket.pull_request.created` | `src/http/webhooks.ts` (Bitbucket dispatch, `pullrequest:created`) | `{ repo, number, title?, body?, action, user_login }` |
| `bitbucket.pull_request.commented` | `src/http/webhooks.ts` (Bitbucket dispatch, `pullrequest:comment_created`) | `{ repo, number, title?, body?, action, user_login }` |
| `bitbucket.pull_request.merged` | `src/http/webhooks.ts` (Bitbucket dispatch, `pullrequest:fulfilled`) | `{ repo, number, title?, body?, action, user_login }` |
| `bitbucket.pull_request.declined` | `src/http/webhooks.ts` (Bitbucket dispatch, `pullrequest:rejected`) | `{ repo, number, title?, body?, action, user_login }` |

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
