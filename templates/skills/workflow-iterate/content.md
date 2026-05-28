# Workflow Iterate Skill

The unified playbook for safely iterating on `agent-swarm` workflows: read-diagnose-patch-verify-trigger-watch, plus the hard-won gotchas that have caused silent failures, halted runs, and stranded PR stacks. Compiled from real production incidents across multiple swarm workflows.

This skill replaces `agent-swarm-workflow-author-gotchas` — the three gotchas previously documented there are now folded in as §3.1, §8, and §10.

> **Companion skill — `workflow-structured-output` (worker-side).** This skill is for workflow *authors* (people running `patch-workflow-node` / `create-workflow`). The companion skill `workflow-structured-output` is for the *workers* that get spawned by `agent-task` nodes: it tells them how to format `store-progress.output` as a stringified JSON matching the node's `outputSchema`. The two skills together describe both sides of the author/worker contract — if you set an `outputSchema` on an `agent-task` here, the assigned worker MUST follow `workflow-structured-output` or the task will silently fail validation. See §3.2 for the cross-reference at the contract boundary.

## 1. Mental model

A workflow is a DAG of typed nodes. Each node has:

| Field | Purpose |
|---|---|
| `id` | stable name used by `inputs` and `next` |
| `type` | `agent-task` \| `script` \| `swarm-script` \| `raw-llm` \| `validate` \| `property-match` \| `code-match` \| `notify` \| `vcs` \| `human-in-the-loop` \| `wait` |
| `config` | type-specific config (template, conditions, etc.) |
| `inputs` | `{localName: sourceRef}` — wires upstream outputs to this node's `{{interpolation}}` scope **for `agent-task` and `raw-llm` only — see §3.1 for the property-match exception** |
| `outputSchema` | JSON Schema validated against this node's output before downstream nodes run |
| `next` | next node id (string) OR port map `{pass, fail}` for branching nodes |

Node execution modes: **instant** executors (`property-match`, `code-match`, `notify`, `raw-llm`, `script`, `swarm-script`, `vcs`, `validate`) run synchronously in the engine — no worker is spawned. **async** executors (`agent-task`, `human-in-the-loop`, `wait`) suspend the run while an external actor (a worker, a human, or a timer) does its part. The §3.2 `config.agentId` routing gotchas apply ONLY to async `agent-task` nodes — instant nodes never pool-route.

`inputs` source refs:
- `"<previousNodeId>"` — output of an upstream node, accessed as `{{localName.field}}` in agent-task templates
- `"<previousNodeId>.<sub.path>"` — sub-path source ref (also only honored by template-rendering executors)
- `"trigger.<key>"` — value from the trigger payload, e.g. `"trigger.slackChannel"`

## 2. The iteration loop (always-on)

1. **READ** — `get-workflow` for current state and version. Never patch from memory.
2. **DIAGNOSE** — if a run failed or routed wrong, `get-workflow-run` and inspect both `input` AND `output` of the offending step. The recorded `input` is the EXACT scope the executor saw. If a field you expected isn't there, your wiring is wrong.
3. **PATCH** — prefer `patch-workflow-node` (partial, surgical, version-checked) over `update-workflow` (full replace). One concern per patch — easier to roll back. **But pass the FULL `config` object — see §4 shallow-merge gotcha.**
4. **VERIFY** — re-read the workflow. Confirm version bumped and the diff is what you intended.
5. **TRIGGER** — `trigger-workflow` with the *full* trigger payload (see §6). Capture the run ID.
6. **WATCH** — `get-workflow-run` until terminal. If it fails again, jump back to step 2.
7. **POST-FIX RE-TRIGGER** — if the patch resolved a halted run, you MUST re-trigger that halted state in the same session. See §10.
8. **SYNC TO REPO** — once the change is verified working, mirror it into your fleet's workflows-as-code repo (if one exists). See §13.

## 3. Known node schemas

### 3.1. `property-match` — the gate node (READ THIS CAREFULLY)

```json
{
  "type": "property-match",
  "config": {
    "conditions": [
      { "field": "<upstream-node-id>.taskOutput.<key>", "op": "eq", "value": "fix" }
    ]
  },
  "inputs": {},
  "next": { "pass": "<next-on-match>", "fail": "<next-on-no-match>" }
}
```

`op` enum: `eq` | `neq` | `contains` | `not_contains` | `gt` | `lt` | `exists`.

**🔴 CRITICAL — property-match `inputs` is IGNORED.** The `field` path is resolved against the **full raw workflow context**, where top-level keys are workflow node IDs (plus `trigger`). It does NOT use the `inputs`-mapped scope.

Empirical proof: with a recorded step `input` of
```
{ trigger: {...}, fetch-top-errors: {...}, research-and-score: {...}, await-error-pick: { taskOutput: { decision: "fix" } } }
```
and `inputs: { decision: "await-error-pick.taskOutput.decision" }` and `field: "decision"`, the gate evaluated `decision === undefined` → `passed:false` — even though `await-error-pick.taskOutput.decision` was `"fix"`.

**Root cause:** the property-match executor calls `resolvePath(context, cond.field)` against the raw global ctx, bypassing the inputs alias. Template interpolation (`{{review.taskOutput.verdict}}`) honors the alias map; `property-match` does not.

**The working pattern:** drop the `inputs` mapping, use the literal node-id-prefixed path:

```json
"config": { "conditions": [{ "field": "await-error-pick.taskOutput.decision", "op": "eq", "value": "fix" }] },
"inputs": {}
```

For node IDs containing characters that the dot-path resolver can't tokenize cleanly, quote the key:

```json
"field": "[\"review-task-output\"].taskOutput.verdict"
```

Hyphens in node IDs DO work in plain dotted paths — the resolver tokenizes on `.`, not `-`. Reach for the bracket-quoted form only when you actually hit a resolution problem.

**WRONG shapes / paths seen in the wild (do not use):**
- `config.input` + `config.expected` — never existed
- `config.conditions: [{ input, expected }]` — guessed shape, runtime rejects
- `field: "<localAlias>.<...>"` with the alias defined in `inputs` — alias is silently ignored
- `field: "<localAlias>.taskOutput.<...>"` ditto

Routing uses ports — the `next` field MUST be `{pass, fail}`, not a string. Port label on the failing edge is `"false"` (not `"fail"`) — visible in `nextPort` on the step record.

**TODO (executor fix):** build `interpolationCtx` and pass it as 2nd arg to `executor.run`, OR resolve `field` through the alias map. Until that lands, treat this as a permanent gotcha.

### 3.2. `agent-task`

```json
{
  "type": "agent-task",
  "config": {
    "agentId": "<uuid-of-claude-harness-worker>",
    "agentName": "Researcher",
    "template": "Investigate {{ctx.error.title}} ...",
    "outputSchema": { "...": "..." }
  },
  "inputs": { "ctx": "<upstream>" }
}
```

Every `{{interpolation}}` token must resolve to a key in `inputs` or `trigger.*`. Unresolved → empty string at runtime → silent bugs downstream.

For `agent-task` the `inputs` mapping IS honored — including sub-path source refs like `"upstream.taskOutput.field"`.

**🔴 PIN `config.agentId` IF THE TEMPLATE IS CLAUDE-SHAPED.** When the node's `template` involves multi-tool reasoning, `bun`/`gh`/`docker` calls, structured `outputSchema`, or Slack-aware output relay, you MUST pin `config.agentId` to a claude-harness worker:
- Picateclas `38d36438-58a0-45b5-8602-a5d52b07c2f1` — routine implementation
- Jackknife `c06cca59-187e-4aa6-8472-8ac6caf177af` — forward-deployed work
- Lead `d454d1a5-4df9-49bd-8a89-e58d6a657dc3` — Slack-posting nodes (lead-only privilege)
- Reviewer `a09d19a4-bd35-4593-9b6f-c2ccafccead8` — review-shaped tasks
- Researcher `16990304-76e4-4017-b991-f3e37b34cf73` — research-shaped tasks

NEVER pin a claude-shaped node to opencode-harness workers (Content Reviewer `fc637423`, Discoverability Optimizer `202b1a2e`, Tester `201b92d8` when on opencode/qwen, Content Strategist `7f95f57e` when on opencode). They instant-fail with `"opencode session error"` or silent-complete with stub output (e.g. `slack_ts: "unavailable_no_slack_context"`).

**🔴 ALSO NEVER pin an `outputSchema`-bearing node to a pi-harness worker (added 2026-05-25, Lead Rule #17).** The same prohibition applies to Content Writer `322999d8`, Content Strategist `7f95f57e` (when on pi), UX Principles Agent `22d30bc3` (when on pi), and any other pi-harness worker. They intermittently fail with `"Structured output required by outputSchema but not provided via store-progress"` because the pi harness does not reliably surface the `workflow-structured-output` skill at task-start — even when the schema is embedded in the template prompt. Confirmed 2026-05-25 cluster: `docs-site-releases` `plan-release` (7f95f57e) + `write-release` (322999d8) both halted; same pattern previously hit DES-458 litmus, weekly-perf-review peer-signal-fanout, and `how-to-generator-with-schema` create-pr. **For ANY node with `outputSchema`, pin to a claude-harness worker (Picateclas/Jackknife/Researcher) or a codex worker (Reviewer)** — never pi, never opencode, never pool. See memory `pi-provider-structured-output-failure-pattern-2026-05-25`.

If `config.agentId` is absent, the node pool-routes via `send-task` — and the dispatch races opencode/pi workers for the claim. This is the workflow-node analogue of Lead Rule #13 (schedules) — same root cause at a different layer. Three production incidents in 2 days (2026-05-17 `weekly-performance-review` `page-render` + `slack-roll-up`; 2026-05-18 `docs-site-releases-weekly` `litmus-approach` + `litmus-content`) — codified as a Pre-flight checklist item (§12) and shared memories `workflow-node-agentid-audit-2026-05-18` + `pi-provider-structured-output-failure-pattern-2026-05-25`.

**🔗 `outputSchema` is the contract with the worker side.** When you set an `outputSchema` on an `agent-task`, the runner validates the worker's `store-progress.output` against it and rejects completions that don't parse as matching JSON — with failure reason `"Structured output required by outputSchema but not provided via store-progress"`. The worker MUST stringify a JSON object containing every `required` field with the exact key names. Workers handling these tasks should consult the companion skill `workflow-structured-output` — it's the worker-side counterpart of this skill and exists specifically to keep them from silently failing your gate. As an author, do three things:
1. **Write `outputSchema` tightly.** Include only keys you actually need to gate or interpolate downstream. Loose schemas invite "looks ok" outputs that miss your `field` paths.
2. **Embed the schema (or a clear "Output Format" JSON block) in the agent's `template` prompt.** Workers shouldn't have to reverse-engineer your schema — paste it in.
3. **Pin `config.agentId` to a claude/codex worker (per the prohibition above).** Even with a perfect schema-in-template, pi/opencode workers will silently fail it; the only durable fix is provider pinning.

**🔴 PRIVILEGE-GATED TOOLS — do not embed `slack-post` / `slack-reply` / `slack-start-thread` calls in non-Lead `agent-task` templates.** These tools require lead privileges; a worker step that calls them fails with `"lead privileges required"`. The workflow may keep running on partial state (e.g. the worker returns `taskOutput` anyway) but the Slack notification is silently lost.

**Pattern:** route Slack-receipt steps through Lead. Either (a) make the Slack-posting node an `agent-task` with `config.agentId: "d454d1a5-..."` (Lead), or (b) put the message in the worker's `output` and let the runner relay it via the task's Slack metadata.

### 3.3. `validate`

Re-runs JSON Schema validation against an upstream output. Use it as a contract checkpoint before a costly node.

### 3.4. Sibling-task dispatch races on shared `contextKey` (added 2026-05-20)

**Symptom:** Worker tasks fail with `progress: null`, `failureReason: null` OR `failureReason: "Superseded by newer workflow task <id> in the same context"`, and a task description prefixed with `<sibling_tasks_in_progress>` referencing a `contextKey: task:workflow:<workflowId>:<runId>`. Two or more sibling tasks appear in `get-tasks` with adjacent (within seconds) `lastUpdatedAt` timestamps across different agents — but for the SAME workflow run.

**Real examples:**
1. **2026-05-19 08:20 UTC, workflow `33d00f44-...` blog pipeline.** Picateclas task `5379fb9e` and Reviewer task `b91a7db2` both spawned from the same node, both received a `<sibling_tasks_in_progress>` preamble saying "user has submitted new input while sibling were running," and both insta-aborted with `progress: null`. Worker never started executing. Lead audit on 2026-05-20 found these clustered with the same shape — see shared memory `sibling-tasks-in-progress-pattern-2026-05-20`.
2. **2026-05-27 — unified-daily-blog + agent-swarm-blog fan-out self-supersession (THE FAN-OUT VARIANT).** Both blog workflows fanned out pillar-assembly `agent-task` nodes (foundation / level-up / vibe) into the SAME `contextKey: task:workflow:<runId>`. Every assembly worker saw siblings in its preamble and **self-cancelled the older ones** to "avoid creating two overlapping PRs." Only the LAST-dispatched assembly survived, carrying whatever draft was in context → exactly 1 PR per run + pillar-label mismatch (Vibe slot received Foundation content) + empty slots for the remaining 2 pillars. Evidence — run `8108612c`: Foundation draft `d3a074a6` → Level-Up assembly `719a07e3` (parentTaskId=d3a074a6) superseded by Vibe assembly `4c5953ff`; both failed with `failureReason="Superseded by newer workflow assembly tasks in the same context"`. Same shape hit agent-swarm-blog run `727fbd00` (`bba1d38c` superseded by `94fe75c2`). **These failures are NOT lost work** — the run still completes and ships the surviving PR. Do NOT re-dispatch superseded assembly tasks. Do NOT treat as a provider-health issue (Lead Rule #16) — the failure is a deliberate self-supersession, not a codex/opencode session error. See shared memory `daily-blog-empty-slots-sibling-context-supersession-2026-05-27`.

**Root cause (workflow-design side):** the node(s) allowed concurrent dispatch on the same `contextKey`. The runner injected a "by the way, here's the input you didn't expect" preamble into each spawn — and the worker bails because it can't reason about "user submitted mid-run input." Per the 2026-05-27 confirmation, this also happens when the workflow itself fans out pillar assemblies into the shared workflow-run context (no user input involved).

**The working pattern (author-side):**

1. **Audit any `agent-task` node that accepts user-modifiable input mid-run** (Slack reply, threadTs follow-up, ack/approve buttons), AND any node that **fans out N parallel `agent-task` children sharing the workflow-run `contextKey`** (per the 2026-05-27 fan-out variant — pillar assemblies, peer-signal fanout, multi-branch generation). Both shapes have the race.
2. **Enforce single-instance-per-contextKey at the dispatcher.** The runner supports this via per-node config — check your fleet's runner docs for the exact field. For a quick fix, gate the node behind a `property-match` that checks `runState.<nodeId>.inFlight === false` before fanning out.
3. **Give each fan-out child its OWN `contextKey`.** This is the durable fan-out fix: instead of every pillar/branch worker seeing every sibling, scope the dispatch key per branch (e.g. `task:workflow:<runId>:pillar:<name>`). Per the 2026-05-27 memo, this is the recommended fix direction for the daily-blog supersession pattern.
4. **Make the worker template idempotent.** If a re-spawn happens, the worker should detect the existing run (via `kv-get` on a contextKey-derived key) and abort gracefully — not bail on the runner's preamble.
5. **Never let two workers from the same `contextKey` write to the same `outputSchema` field** — last-write-wins corrupts the gate downstream.

**Detection (Lead-side audit):** when the daily-evolution failure audit finds a cluster of `failed` tasks with `<sibling_tasks_in_progress>` in `task` AND (`failureReason: null` OR `failureReason` starting with `"Superseded by newer workflow"`) AND/OR `progress: null`, treat as a *workflow dispatcher race*, NOT a worker failure, NOT a provider-health issue. Don't waste evolution cycles on the worker's SOUL/IDENTITY. Fix the workflow node config or escalate to the runner team for `failureReason: "sibling_task_dispatch_collision"` synthesis.

**Cross-reference:** Lead Rule #17 (failure-reason-null + sibling-task cluster detection). See also shared memory `failure-reason-null-epidemic-2026-05-20` for the parallel observation that 15/15 swarm-wide fails over 7d had `failureReason: null` — sibling-task aborts contribute heavily to this gap.

### 3.5. `swarm-script` — run a catalog script deterministically (no agent, no LLM) (added 2026-05-20)

Runs a stored script from the swarm script catalog inline. It is an **instant-mode** executor: there is NO agent or worker in the loop. Unlike `agent-task`, it does NOT pool-route and you do NOT pin `config.agentId` — the entire §3.2 routing gotcha simply does not apply. It executes through the exact same runtime path as the `script_run` MCP tool (`runScript()` in `src/scripts-runtime/loader`), so a script that works under `script_run` works identically as a node.

```json
{
  "id": "list-prs",
  "type": "swarm-script",
  "label": "List open PRs",
  "config": {
    "scriptName": "github-list-open-prs",
    "scope": "global",
    "pinHash": "b7a0...",
    "args": { "repo": "{{trigger.repo}}", "limit": 5 },
    "fsMode": "none"
  }
}
```

Config fields:
- `scriptName` **(required)** — catalog script name. Discover candidates with the `script_search` MCP tool (semantic search — pass an empty `query` to list everything); manage the catalog with `script_upsert` / `script_delete`.
- `scope` (optional) — `agent` | `global`. Defaults to the creator's agent scope, then falls back to `global`. **Omit it unless you must force one** — a wrong *explicit* scope fails resolution.
- `pinHash` (optional) — pin to a specific `script_versions` content hash for reproducibility. Omit to always run the latest version.
- `args` (optional) — JSON object passed to the script. Values support `{{interpolation}}` from `inputs` / `trigger`.
- `fsMode` (optional) — `none` (default). `workspace-rw` is v2-only and fails clearly on a v1 runtime.

Output — written to context key `<nodeId>` and to the step's `output`:
```
{ result, stdout, stderr, truncated, durationMs, exitCode, scriptName, contentHash, version }
```
**🔴 The script's RETURN VALUE lives under `result`** — NOT `taskOutput` (that's the `agent-task` shape; conflating them is the most common swarm-script wiring bug). To consume it downstream:
- `agent-task` / `raw-llm`: `inputs: { prs: "list-prs.result" }` → `{{prs.prs}}`; or `inputs: { node: "list-prs" }` → `{{node.result.prs}}`.
- `property-match`: literal node-id-prefixed path, e.g. `field: "list-prs.result.count"` (`inputs` is ignored — see §3.1).

**`script` vs `swarm-script`:** `script` runs inline bash/ts/python embedded *in the workflow definition itself*; `swarm-script` runs a *reusable, versioned catalog* script by name. Prefer `swarm-script` for any logic shared across workflows — swapping `scriptName` (or `script_upsert`-ing a new script) gives you a new deterministic node with zero workflow-engine code changes.

**Minimal demo** — a one-node workflow needs no trigger configured; run it on demand via `trigger-workflow`. Reference example: workflow `demo-swarm-script-node` (`73d71dd8-8099-49f8-aa8a-83434606366b`) — a single `swarm-script` node running `github-list-open-prs`, completes in ~400ms with `exitCode 0`.

## 4. Patching rules (and the shallow-merge gotcha)

- **One concern per patch.** If you're changing a threshold AND a prompt AND a schema, do three patches. Easier diff, easier revert.
- **Always re-read the workflow before patching.** `patch-workflow-node` carries a version snapshot; if the workflow advanced, your patch is rejected.
- **🔴 `patch-workflow-node` SHALLOW-merges at the config level — pass the FULL `config` object every time.** Validated by 3 production incidents 2026-05-17 18:00–20:13 UTC on `weekly-performance-review` v5→v9: a partial `config: {agentId: "..."}` patch WIPED the entire `template` + `outputSchema` + `model` + `priority` + `tags` block on each affected node, requiring restoration patches (v7, v8) before the run could proceed. The config layer behavior contradicts what an intuitive "deep merge" would do — internally, the node-level merge is shallow (top-level keys replaced, not merged recursively). Schema is flat at config level: `{ template, outputSchema?, agentId?, agentName?, tags?, priority?, dir?, vcsRepo?, model? }` — there is NO `taskTemplate` wrapper. **To safely change one config field, always read the existing config first (via `get-workflow`), then pass the FULL config object with that one field changed.** See shared memory `patch-workflow-node-shallow-merge-gotcha-2026-05-17`.
- **Bump the node `version` explicitly. Do NOT reuse a version number.**
- **Prefer adding over rewriting.** If you can add a step that fixes the issue (e.g. an extra Slack post for transparency) without touching existing nodes, do that.
- **When patching property-match, set `inputs: {}` explicitly.** A leftover `inputs` mapping confuses readers (and yourself, three patches later) into thinking the node uses it.

## 5. Common failure modes (and how to recognize them)

| Symptom | Real cause | Fix |
|---|---|---|
| Gate returns `passed:false` despite the value being correct upstream | `field` path is a local alias instead of a node-id-prefixed path; `inputs` is ignored by property-match | Use `field: "<upstream-node-id>.taskOutput.<key>"`, drop `inputs` |
| Run "stops at the gate", user sees nothing | `property-match` route fired correctly but skip path is silent | Add an always-on Slack post on the *decision-making* node, not on the gate (gates have no comms). |
| Run fails on a `property-match` with cryptic schema error | Wrong `config` shape (`{input,expected}` instead of `{conditions:[{field,op,value}]}`) | See §3.1. |
| `agent-task` step fails with `"opencode session error"` or `"Codex Exec exited"` within <15s of dispatch | Node's `config.agentId` is unpinned OR pointing at an opencode-harness worker, and the template is claude-shaped | Pin `config.agentId` to a claude-harness worker (Picateclas/Jackknife/Lead/Reviewer/Researcher). See §3.2. Pass FULL config (§4). |
| `agent-task` step "completes" with stub output like `slack_ts: "unavailable_no_slack_context"` | Opencode worker silently completed a claude-shaped task (qa-use video, slack relay, gh CLI flow) | Same fix as above — pin to claude-harness worker. |
| Two adjacent tasks fail with identical `<sibling_tasks_in_progress>` preamble, `progress:null`, `failureReason:null`, same `contextKey` | Concurrent dispatch race on same node — workflow allowed sibling spawn before previous completed | See §3.4. Audit node for single-instance-per-contextKey enforcement; make worker template idempotent. |
| Fan-out shipped 1 PR instead of N expected (e.g. blog pipeline ships 1 of 3 pillars), other slots empty, pillar/branch label mismatched against content | Pillar/branch assembly fan-out shared one workflow-run `contextKey` → workers self-cancelled siblings to "avoid duplicate PR" — only the last-dispatched assembly survived | See §3.4 fan-out variant. Give each branch its own `contextKey` (e.g. `task:workflow:<runId>:pillar:<name>`). DO NOT re-dispatch superseded tasks — the run is not lost, just one survivor. See `daily-blog-empty-slots-sibling-context-supersession-2026-05-27`. |
| `agent-task` step fails with `"Structured output required by outputSchema but not provided via store-progress"` within <15s, on a pi/opencode worker, no real work logged | Pi/opencode harness did not surface `workflow-structured-output` skill at task-start; worker silently emitted no JSON | **(added 2026-05-25)** Pin `config.agentId` to a claude/codex worker. See §3.2 pi-harness paragraph + Lead Rule #17 + memory `pi-provider-structured-output-failure-pattern-2026-05-25`. Embedding the schema in the template prompt is NOT sufficient for pi-harness workers. |
| `agent-task` step fails with the same error but on a claude/codex worker | Worker called `store-progress` with plain-text or no `output` despite the node having an `outputSchema` | Worker side: see `workflow-structured-output` skill. Author side: confirm the schema is embedded in the template prompt so the worker can see it. |
| `swarm-script` step fails with a script-resolution / "script not found" error | `scriptName` not in the catalog, or an explicit `scope` that doesn't match where the script actually lives | Verify the name with the `script_search` MCP tool; drop the explicit `scope` to let it fall back agent→global. See §3.5. |
| Downstream node reads empty values from a `swarm-script` upstream | Wired to `.taskOutput.*` (agent-task shape) instead of `.result.*` | swarm-script return value is under `result` — use `field: "<node>.result.<key>"` or `inputs: { x: "<node>.result" }`. See §3.5. |
| After `patch-workflow-node`, downstream nodes start failing with empty `template` / missing `outputSchema` / wrong model | Partial `config: {agentId}` (or any partial config) wiped the rest of the config — shallow-merge gotcha (§4) | Restore by patching with the FULL config object. |
| Run fails mid-step with `"You have reached your specified API usage limits"` | Anthropic API quota exhausted on the agent's key — NOT a workflow bug | Wait for reset (date is in the error message) or switch credential key |
| Threshold too strict — `> 75` blocks everything | Real-world scores from research nodes cluster in 40–80; strict `> 75` rejects realistic 70-80 confidence | Use `>= 70` and tie-break by rank |
| `{{trigger.slackChannel}}` is empty → downstream Slack post crashes | Triggered without the Slack payload | Always pass `slackChannel`, `slackThreadTs`, `slackUserId` in the trigger payload for Slack-aware workflows |
| Workflow apparently fine but user confused | A run from earlier with stale data is what they're looking at | `list-workflow-runs` to find which run produced what they're seeing |
| Worker step's Slack post never lands; step still completes "successfully" with `output` containing the intended message | Worker called `slack-post`/`slack-reply` (lead-only) and silently fell through to returning script output | Move the Slack node onto a Lead `agent-task`, or use the runner's auto-relay of the worker's `output`. See §3.2. |
| `gh pr list --base <branch> --state open` returns 0 right after a merge | GitHub auto-retarget races deletion (~5–30s window) | Pre-merge retarget — see §8. |
| Halted-run loop has shipped a fix but the halt persists | Schedules don't retry past halts; they fire on their next cron tick with fresh inputs. The fix did NOT auto-rerun the halted iteration | Manually re-trigger in the same session, or set an explicit watch — see §10. |

## 6. Trigger payload — always send the full Slack context

For any workflow that posts to Slack at any point:

```json
{
  "slackChannel": "<channel-id>",
  "slackThreadTs": "<ts>",
  "slackUserId": "<user-id>",
  "...domain-specific keys..."
}
```

Even nodes that don't currently use these fields might tomorrow. Cheap to include, expensive to debug their absence.

## 7. Transparency pattern: never let a workflow silently stop

A gate (`property-match`) has no comms. If the gate routes to "skip", the user sees nothing.

**Rule:** every decision-making node (auto-selectors, scorers, anything that can route to a no-op branch) MUST post its full reasoning to the originating Slack thread *before* the gate evaluates — regardless of which branch will fire.

Pattern: in the auto-selector `agent-task` (or `script`), append a Slack post to the template:

```
*:bar_chart: Decision summary*
[rank 1] <error> — *<conf>* / 100 — _<rootCause>_
[rank 2] ...
*High-confidence (>80) count:* <N>
*Fix-eligible (≥70) count:* <M>
*Decision:* :white_check_mark: FIX rank N (conf X) | :wave: SKIP — none ≥ 70
```

This way the user always sees what was scored and why the workflow proceeded or skipped. No more "why did it stop?".

**Privilege note:** if the decision node runs on a worker (not Lead), the Slack post must come from a downstream Lead step or be relayed via the worker's `output` — workers cannot call `slack-post`/`slack-reply`. See §3.2.

## 8. Pre-merge retarget for branch-deletion nodes

**Symptom:** Workflow merges PR #N with `--delete-branch`. Open PRs that targeted the deleted branch are stranded — listed as 0 results (if the next iteration filters by `--state open --base <deleted>`) or pointing at a deleted base.

**Root cause:** GitHub's auto-retarget is best-effort and races the API for ~5–30s after deletion. Any "list open PRs with `baseRefName = X`" query inside that window sees inconsistent state.

**Pattern (validated in production PR-stack workflows):**

Inside any merge node, BEFORE `gh pr merge --delete-branch`:

1. List all open PRs whose `baseRefName == soon-to-be-deleted-branch`.
2. For each: `gh pr edit <num> --base <new-target>` to retarget on the parent of the merging PR (typically `main`, or the next ancestor still open).
3. Verify each retarget returns success.
4. ONLY THEN call `gh pr merge --delete-branch`.
5. Optional safety net: re-poll dependents post-merge and retarget any that GitHub auto-retargeted to the wrong base.
6. Emit BOTH `preMergeRetargetedPRs` AND `postMergeRetargetedPRs` in the node's output schema for log greppability.

**Where this applies:** any drain-the-stack workflow over GitHub PRs, GitLab MR stacks, Gerrit chains, or any pipeline that deletes a resource other nodes/PRs reference.

## 9. Cancelling and re-triggering

- **Cancel** before re-triggering if a long run is still in flight: `cancel-workflow-run` with the run ID. Do NOT trigger a parallel one — runs share resources and Slack threads will get spammed by both.
- **Re-trigger** with the *same* trigger payload that produced the original run (especially Slack context).
- After a patch, document the version bump in the Slack reply so the user can correlate (`workflow v8 → v9: lowered threshold to ≥70`).

## 10. Post-fix re-trigger discipline (the "fix shipped but not re-triggered" anti-pattern)

**Rule:** when you ship a fix to a scheduled or workflow-driven loop that previously halted on the bug you just fixed, the fix does NOT auto-rerun the halted iteration. You must do ONE of:

(a) Explicitly call `trigger-workflow` with the parameters of the halted run, OR
(b) Verify the next scheduled firing will re-attempt the halted state, AND that the buffer until then is acceptable, AND record an explicit watch.

**Cautionary tale:** a merge-loop fix shipped at 17:58 UTC unblocked a stack of 5 stranded PRs. The Slack thread acknowledged the fix. **8h later the next blocker digest still showed the same 5 PRs** — no one re-triggered, the schedule fires on fresh inputs (not retries), and the fix sat idle for a full cycle.

**Mandatory action after every workflow patch resolving a halted run** — in the SAME session that confirms the patch is live:

1. Call `trigger-workflow` with the parameters of the halted run, OR
2. Add a HEARTBEAT.md "Watch Item" with explicit re-trigger condition + buffer ("if next firing in N hours doesn't drive the run to completion, manually trigger").

NEVER assume "the fix is in, the schedule will pick it up." Schedules don't retry past halts; they fire on their next cron tick with fresh inputs.

**Detection trigger:** the blocker digest's "repeat-pattern" line ("same N PRs, same blockers, 0 PRs merged in 24h") would catch this any day. Add a single short-delay `ScheduleWakeup` (≤270s) or a 30-min checklist note immediately after ack-ing any workflow patch that resolves an in-flight halt.

## 11. Diagnosing a failed/wrong run — input AND output of the suspect step

```
get-workflow-run({ runId })
  → look at .steps[*]
  → find the first step whose status is "failed" OR whose output is wrong
  → READ ITS .input — that's the EXACT scope the executor saw
  → if the field you expected isn't there, your inputs wiring is wrong
  → for property-match, the input is the FULL workflow context (node-id keyed)
```

If the error mentions schema validation, the runtime is *telling you* the correct shape. Read it carefully — guessing (e.g. assuming `{input, expected}` shape) costs another iteration.

**Worked example — gate evaluation:**
- `await-error-pick.output.taskOutput.decision = "fix"` ✓
- `gate-on-fix.input.await-error-pick.taskOutput.decision = "fix"` ✓ (full context view)
- `gate-on-fix.config.conditions[0].field = "decision"` ✗ — looks for `"decision"` at top level
- → `decision` is undefined at top level → `undefined !== "fix"` → `passed:false`
- Fix: `field: "await-error-pick.taskOutput.decision"`

## 12. Pre-flight checklist before declaring a workflow "done"

- [ ] Every `agent-task` template's `{{tokens}}` resolve via `inputs` or `trigger.*`
- [ ] Every `agent-task` with an `outputSchema` embeds that schema (or an "Output Format" JSON block) inside its prompt template — workers shouldn't have to guess. Workers should also have `workflow-structured-output` available for the contract details.
- [ ] **Every `agent-task` node has `config.agentId` set** — pinning to a claude-harness worker (Picateclas/Jackknife/Lead/Reviewer/Researcher) for claude-shaped templates. Pool-routing is the default whenever `agentId` is absent; that's how nodes race opencode/pi workers. See §3.2.
- [ ] **(added 2026-05-25, Lead Rule #17)** Every `agent-task` node with an `outputSchema` is pinned to a claude/codex worker — NEVER to a pi-harness worker (Content Writer `322999d8`, Content Strategist `7f95f57e` on pi, UX Principles Agent `22d30bc3` on pi). Pi-harness workers silently fail outputSchema validation regardless of how well the template is written.
- [ ] **No `agent-task` node fans out into sibling spawns on the same `contextKey` without single-instance enforcement.** See §3.4. If the node accepts mid-run user input (Slack reply, approve button), confirm the dispatcher gates concurrent spawns. **If the node fans out N parallel children (pillar assemblies, peer-signal fanout, multi-branch generation), each child MUST get its OWN `contextKey` — sharing the workflow-run `contextKey` triggers the 2026-05-27 fan-out self-supersession variant.**
- [ ] Every `swarm-script` node's `scriptName` exists in the catalog (verify via the `script_search` MCP tool), and its `args` tokens resolve via `inputs`/`trigger`. swarm-script nodes need NO `config.agentId` — they're instant-mode, not agent-routed. See §3.5.
- [ ] Every `property-match` `field` is a literal node-id-prefixed dotted path (e.g. `"await-error-pick.taskOutput.decision"`), NOT a local alias
- [ ] Every `property-match` has `inputs: {}` (explicit empty — the field is ignored anyway, but signal intent)
- [ ] Every `property-match` has `next: {pass, fail}` (not a string), and `config.conditions: [{field, op, value}]`
- [ ] Every decision node posts its reasoning to Slack BEFORE the gate
- [ ] **No `slack-post` / `slack-reply` / `slack-start-thread` call appears inside a non-Lead `agent-task` template.** Slack-posting steps are Lead-assigned, or the message is in the worker's `output` for runner relay.
- [ ] Any node that deletes a branch or other shared resource has a **pre-deletion retarget step** (§8).
- [ ] No threshold uses strict `>` for ranges where boundary equality should pass — prefer `>=`.
- [ ] Trigger payload schema documents `slackChannel`, `slackThreadTs`, `slackUserId` if any node posts.
- [ ] **Every `patch-workflow-node` call you made passed the FULL `config` object** — not just the changed sub-field. The merge is shallow at config level. See §4.
- [ ] One end-to-end success run captured before handing back to user — verify the gate `passed:true` for the success path.
- [ ] Latest workflow version posted in the final Slack reply.
- [ ] If the patch unblocks a halted run: post-fix re-trigger executed OR an explicit watch logged (§10).
- [ ] If your fleet maintains a workflows-as-code repo: a sync PR is open or merged for the change (§13).

## 13. Sync back to a workflows-as-code repo

If your fleet maintains a workflows-as-code repo (canonical *runtime* is the live swarm DB; canonical *source-of-truth-for-humans* is a git repo), sync EVERY successful workflow change there before declaring the iteration done. Skipping this is the #1 reason the next agent will patch from a stale mental model.

> Where to find the canonical repo for your fleet: check `get-repos`, your `TOOLS.md`, or fleet-level config. Conventions below assume one workflow per directory under `workflows/<name>/` with a `workflow.json` and (optionally) a `scripts/` folder for inline scripts. Adapt to your repo's actual layout.

**When this applies:**
- `create-workflow` → new `workflows/<name>/` directory
- `update-workflow` / `patch-workflow-node` → diff in `workflows/<name>/workflow.json` and/or `scripts/*.sh`
- `delete-workflow` → remove the directory

**Steps:**

1. `cd` into the local clone of the repo (clone with `gh repo clone <org>/<repo>` if missing).
2. `git fetch origin && git checkout <default-branch> && git pull origin <default-branch>` — always base off the latest default branch. Do NOT base off any feature branch.
3. `git checkout -b sync/<workflow-name>-<short-summary>` (e.g. `sync/datadog-error-triage-lower-threshold`).
4. Pull live state into the repo. If the repo has a sync helper (commonly `tools/sync.sh pull <workflow-name>`), use it — it should fetch live, write `workflow.json`, extract inline scripts to `scripts/<node-id>.sh`, and replace inline `script` fields with `{ "scriptPath": "scripts/<node-id>.sh" }`. If no `pull` helper exists, add one as the symmetric inverse of `push` and document it in the README.
5. Run the repo's CI checks locally before pushing (typically `jq -e .`, `shellcheck`, repo-specific lint).
6. **Round-trip check (CRITICAL):** `tools/sync.sh push <workflow-name> --dry-run` (or equivalent) MUST show empty diff. If non-empty, your inlining/extraction is asymmetric — fix the tool before committing. CI relies on byte-exact round-trip.
7. Commit with `sync(<workflow-name>): <one-liner of what changed live>`. One workflow per commit, one workflow per PR.
8. `gh pr create --base <default-branch>` with a body that includes:
   - Live workflow id + version after the change
   - One-paragraph summary of what the workflow does or what changed
   - The empty `--dry-run` diff confirming round-trip equivalence
   - Whether this PR documents an already-deployed change (most common) or proposes a new one
9. Reply to the originating Slack thread with the PR URL.

**Do not:**
- Open the PR to anything other than the repo's default branch.
- Bundle multiple workflow changes in one PR — reviewers can't diff them cleanly.
- Push scripts without re-inlining for round-trip — CI will fail.
- Merge the sync PR yourself unless your fleet's policy explicitly allows it. Default to human review.

**Why:** prevents drift between live and repo, keeps `git log` as the canonical change history, gives reviewers a chance to catch regressions before another agent picks up an iteration.

## 14. When to escalate

- API quota errors → not a workflow problem; tell the user the reset time and stop iterating.
- Same patch fails twice in a row with similar schema errors → stop guessing. Use `db-query` or workflow runtime source to find the actual schema before the third attempt.
- User says "still not working" three times → re-read the entire workflow end-to-end before any further patch. The bug is probably not where you've been looking.
- User shows you a step's `output` proving the gate is wrong → trust the user. Inspect the recorded `input` of that step before re-patching; the wiring is the bug.
- Round-trip dry-run diff is non-empty after a `pull` (per §13.6) → that's a sync-tool bug, not a one-off. Fix the tool, not the workflow.

## See also

- **`workflow-structured-output`** — the worker-side counterpart of this skill. Use it (or ensure your workers have it) for any `agent-task` that defines an `outputSchema`.

