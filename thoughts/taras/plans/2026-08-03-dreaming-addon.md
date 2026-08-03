---
date: 2026-08-03T00:00:00+0200
author: Taras (planned by Claude)
topic: "Dreaming add-on — foreach executor, seeders, dream workflow, cutover"
tags: [plan, workflows, foreach, seeding, addons, dreaming]
status: draft
brainstorm: thoughts/taras/brainstorms/2026-07-31-compounding-engine-workflow.md
autonomy: critical
---

# Dreaming Add-on (fka Compounding Engine) Implementation Plan

## Overview

Replace the monolithic daily-evolution scheduled task with the **Dreaming add-on**: a single global
`dream` workflow that fans out one reflection task per live agent (new `foreach` executor), converges
on a Lead critique, and commits an approved delta set via a mechanical apply script — shipped as a
seeded bundle (workflow + schedule + skill + scripts + config keys) that survives operator edits.

- **Motivation**: the daily-evolution monolith (schedule `cdfa3f00-…`) is a Lead context bottleneck,
  serial, rotation-by-vibes, prose-enforced — see brainstorm.
- **Related**: `thoughts/taras/brainstorms/2026-07-31-compounding-engine-workflow.md` (all decisions
  resolved except add-on hash granularity, `concurrency` field, schema location),
  `runbooks/workflows.md`, `runbooks/seed-scripts.md`, `runbooks/skills.md`.

## Current State Analysis

All claims verified against latest `main` (`9fd30265`) on 2026-08-03 by parallel research spikes.

### Engine execution (Phase 1 ground)

- `walkGraph` executes all pending nodes in one `Promise.all` batch and gates a successor on every
  predecessor with an *active* edge being completed (`activeEdges` set keyed `src→dest`) —
  `src/workflows/engine.ts:266-330`. This convergence gate is what the critique join reuses.
- **Node types are NOT a closed union.** `WorkflowNodeSchema.type` is a plain `z.string()`
  (`src/types.ts:1514-1560`); `validateDefinition` only checks `registry.has(node.type)`
  (`src/workflows/definition.ts:204-211`). A new `foreach` executor needs exactly: a new
  `src/workflows/executors/foreach.ts` implementing `BaseExecutor`, one `registry.register(...)` line
  in `createExecutorRegistry` (`src/workflows/executors/registry.ts:63-82`), and (cosmetic) the
  `create-workflow` tool description text (`src/tools/workflows/create-workflow.ts:22-40`).
- **Idempotency forces distinct child nodeIds.** `executeStep` computes
  `iteration = getStepCountForNode(runId, node.id)` and `idempotencyKey = runId:node.id:iteration`
  (`src/workflows/engine.ts:423-444`; `src/be/db.ts:9471-9487`). N children sharing a nodeId collide.
  Additionally the agent-task executor de-dupes on `getTaskByWorkflowRunStepId(meta.stepId)`
  (`src/workflows/executors/agent-task.ts:53-127`) — so each child needs its own
  `workflow_run_steps` row with a distinct synthetic nodeId (`reflect#<agentId>`).
- `workflow_run_steps.nodeId` is free `TEXT NOT NULL`, no FK/CHECK (`src/be/migrations/003_workflows.sql`,
  `008_workflow_redesign.sql`); full column set incl. `idempotencyKey`, `diagnostics`, `nextPort` at
  `src/types.ts:2144-2173`. Synthetic ids persist fine.
- **Step-count guard**: `WORKFLOW_MAX_STEPS_PER_RUN` (default 500) counts every step row ever
  inserted, checked at the top of each `walkGraph` (`src/workflows/engine.ts:256-265`) — the guard N
  children accumulate against; 6-ish agents is far below it.
- `interpolate`/`deepInterpolate` live in `src/utils/template.ts` (engine-independent by design;
  `src/workflows/template.ts:1-13` is a re-export shim) — the foreach executor can do its own
  per-item `{item, index}` interpolation. Note `interpolateNodeConfig` special-cases `swarm-script`
  args with `preserveRawTokens` (`src/workflows/engine.ts:737-756`); foreach needs its own pass.
- `checkpointStep` writes `ctx[nodeId] = result.output` (plain overwrite, no accumulator —
  `src/workflows/checkpoint.ts:7-29`); downstream `inputs` sourcePaths resolve via a dotted-path walk
  (`src/workflows/engine.ts:467-523`); unresolved tokens are soft — empty string + `console.warn` +
  `diagnostics.unresolvedTokens`. Hence the parent must aggregate children into one ctx key.
- Async executors return `{async: true, waitFor: 'task.completed', correlationId}`; engine sets step
  + run to `waiting` and `walkGraph` short-circuits (`src/workflows/engine.ts:293-296,308,603-606`).
- `config.outputSchema` on an agent-task node is passed into the created task and enforced
  worker-side by `store-progress`; the engine-level `node.outputSchema` check (`engine.ts:608-619`)
  validates the executor's `{taskId, taskOutput}` envelope only.
- **`code-match` is the gate node we need**: sandboxed `new Function` over the input ctx, coerces the
  result to a port name, rejects ports not in `outputPorts`, returns `nextPort`; `next` as a port
  record `{true: 'x', false: 'y'}` routes via `getSuccessors(def, nodeId, port)`
  (`src/workflows/executors/code-match.ts:7-88`, `src/workflows/definition.ts:71-100`).

### Resume & failure paths — the landmine, confirmed

- `resumeFromTaskCompletion` routes via `getSuccessors(workflow.definition, step.nodeId)`
  (`src/workflows/resume.ts:103-154`, call at `:138`). A nodeId not in `def.nodes` returns `[]`
  (`src/workflows/definition.ts:76-77`) → `finalizeOrWait(run.id)` (`resume.ts:151-153`), which marks
  the run **completed** if no other step is `waiting` (`resume.ts:160-172`). Silent early
  completion — `critique` never runs. **Confirmed.**
- Same landmine in `handleTaskFailure` (`resume.ts:179-227`; `getSuccessors` at `:211`) and on the
  crash-recovery path `recoverWaitingRuns` (`src/workflows/recovery.ts:106-158`, esp. `:121-124`).
- `onNodeFailure: 'continue'` (definition-level) checkpoints a failed task as completed with
  `taskOutput: "[FAILED: <reason>] …"` (`resume.ts:196-226`, shape at `:202-205`) — v1's per-child
  failure policy for free.
- `retryFailedRun` throws `Node X not found in workflow definition` for unknown nodeIds
  (`resume.ts:249-278`, throw at `:270`).
- **Complete list of nodeId-keyed sites needing child→parent resolution**: `resume.ts:138`,
  `resume.ts:211`, `checkpoint.ts:23` (ctx key), `engine.ts:176-201` (re-walk `def.nodes.find` +
  `getSuccessors`), `engine.ts:219-231` (activeEdges reconstruction), `engine.ts:242,249,390-399`
  (completedNodeIds/predecessor gating), `recovery.ts:121-124`, `resume.ts:270` (retry).
- Task-completion wiring is a pure in-process `workflowEventBus` (`src/be/db.ts:2907-2963` emit;
  `resume.ts:46-89` listeners); emitters: `store-progress` (`src/tools/store-progress.ts:256,283`)
  and `PATCH /api/tasks/:id` (`src/http/tasks.ts:1056,1065`).

### Scripts, skills, config (Phase 3 ground)

- Seeded catalog scripts: `src/be/seed-scripts/index.ts:52-319` (name/description/intent/source; one
  file per `catalog/*.ts`). `compound-insights` confirmed swarm-wide, **no `agentId` arg**
  (`catalog/compound-insights.ts:4-34,349-370`) → `dream-agent-slice` is genuinely new. Reusable:
  `gh-pr-snapshot`, `task-failure-audit`, `tool-usage`, `schedule-health`, `memory-eval`,
  `memory-dedup-check`, `smart-recall`, `catalog-report`.
- `swarm-script` executor: timeout clamped [1s, 60s], default 30s; `fsMode: 'workspace-rw'` hard-fails
  (v2) (`src/workflows/executors/swarm-script.ts:13-29,60-65,151-159`).
- Script SDK surface (`src/scripts-runtime/sdk-allowlist.ts`): `config_get/list/set/delete`,
  `slack_post/reply/startThread/uploadFile`, `profile_update`, `db_query` all available — dream-apply
  and dream-receipt are implementable as catalog scripts.
- ⚠️ **`config_get` resolves ONLY `swarm_config` DB rows (repo > agent > global), never
  `process.env`** (`src/be/db.ts:8108-8134`, `src/tools/swarm-config/get-config.ts:57-65`). An
  env-only `DREAMING_ENABLED` is invisible to scripts. Env/DB precedence at boot/reload:
  `src/http/core.ts:53-101,122-140`.
- ⚠️ **No anchored-edit primitive exists.** `update-profile` is whole-field replacement
  (`soulMd`/`identityMd`/`claudeMd`/`toolsMd`/`heartbeatMd`) with a ≥200-char guard on
  soul/identity, plus workspace file sync on self-update (`src/tools/update-profile.ts:107-129,218-236,307-348`).
  Anchored section ops must be implemented inside `dream-apply` as read → local splice → whole-field
  write. Raw profile reads: `my-agent-info` (self), `get-swarm includeFull:true` (all), or `db_query`.
- Skill seeding: `templates/skills/<name>/{config.json,content.md}` + static text-imports +
  `BUILT_IN_SKILL_SOURCES` entry in `src/be/seed-skills/index.ts:10-53,115-125`; swarm-scoped, so
  every foreach target can load `dreaming` with zero per-agent install.
- Config catalog: entries in `apps/ui/src/lib/configuration-catalog.ts`; validators in
  `VALIDATED_KEYS` (`src/be/swarm-config-guard.ts`); global rows persist via PUT `/api/config`.
- ⚠️ **JSON-schema validator subset** (prior learning, `src/workflows/json-schema-validator.ts`):
  only `type/required/properties/enum/const/items` are enforced; `oneOf`/`pattern`/`format` are
  silently ignored. `ReflectionDelta`/`ApprovedDeltaSet` must be designed within the subset; the
  tagged union's per-kind field requirements are enforced by `dream-apply` itself, not the schema.

### Seed harness & schedules (Phase 2 ground)

- `Seeder<T>` interface: `kind`, `items()`, `upstreamHash(item)`, `apply(item, action, opts?)`
  (`src/be/seed/types.ts:43-55`); `SeedItem` = stable `key` + `contentHash` comparable with
  `upstreamHash` (`types.ts:27-36`). `seed_state(kind, key, seededHash, seededAt)` PK `(kind,key)`
  (`src/be/migrations/070_seed_state.sql:16-22`).
- Pristine-vs-user-modified logic is generic, in `runSeeder` (`src/be/seed/runner.ts:30-65`):
  absent → create; upstream ≠ seededHash → **skippedUserModified** (never touched); pristine +
  source changed → update; pristine + unchanged → no-op (adopts identical unrecorded entities).
  User-modification detection is implicit: `upstreamHash()` returns the live row's stored
  contentHash, which only changes on user edits.
- Registry order `[agentFsProvision, scripts, skills]`, sequential (`src/be/seed/registry.ts:15-20`;
  `runner.ts:88-98`); invoked once at API boot (`src/http/index.ts:547-552`,
  `scriptEmbeddingMode: 'skip'`). Ordered array ⇒ workflows-before-schedules works.
- Pattern to copy — `scriptsSeeder` (`src/be/seed-scripts/index.ts:274-319`): static array →
  `{key: name, contentHash: computeContentHash(source)}`; `upstreamHash()` = live row's contentHash
  or null; `apply()` re-runs the full upsert pipeline for create AND update. `computeContentHash` =
  SHA-256 hex (`src/be/db.ts:453-457`).
- `scheduled_tasks` columns (post-103/115): `name` UNIQUE, `cronExpression`, `timezone`,
  `enabled` (default 1), `targetType` CHECK `('agent-task','workflow','script')`, `workflowId`
  (CHECK: required when targetType='workflow'), `modelTier`, `key` (asset namespace), audit fields
  (`src/be/migrations/103_schedule_target_type.sql:12-53`). `getScheduledTaskByName` exists
  (`src/be/db.ts:7424-7429`).
- `workflows` table: `name` UNIQUE, `definition` JSON, `enabled`, `triggers`, `triggerSchema`,
  `dir`/`vcs_repo`, `key` (`003_workflows.sql`, `012`, `015`, `082`, `115`; `src/be/db.ts:8745-8767`).
  ⚠️ **No `getWorkflowByName` exists** despite the UNIQUE constraint — `workflowsSeeder` needs a new
  name-keyed lookup (or a `listWorkflows` name filter, unverified).
- `create-workflow` validates via `validateDefinition` before insert (`src/tools/workflows/create-workflow.ts:14,110-137`);
  `createWorkflow` itself doesn't re-validate — the seeder should call `validateDefinition` explicitly.
- Schedule→workflow dispatch: `startScheduler` interval → `processSchedules` → `executeSchedule` →
  `dispatchScheduleTarget` → `getWorkflow(schedule.workflowId)` + `workflow.enabled` check →
  `startWorkflowExecution(workflow, {scheduleId, scheduleName, firedAt}, registry, {triggerType: 'schedule'})`
  (`src/scheduler/scheduler.ts:120-153,379-397,422-439`).
- Seed tests: `src/tests/seed.test.ts` (generic harness, fake seeder, 7 tests) and
  `src/tests/seed-scripts.test.ts` (real seeder incl. `user-modified script is preserved`,
  `:180-208`) — the disable-survives-reseed regression test mirrors that pattern in a new
  `src/tests/seed-schedules.test.ts`.
- `src/workflows/templates.ts` is single-workflow `{{var}}` substitution only
  (`:7-21,31-54,79-86`) — no bundle concept; add-ons are new design, not pattern-copy.
- ⚠️ **`templates/schedules/` is a copy-paste gallery, not a seed source**: read at runtime by
  `apps/templates-ui/src/lib/templates.ts` off the filesystem; `runAllSeedersCandidate`/`must`
  flags in its `config.json` are gallery-UI metadata only, with **zero** references under `src/`
  (`templates/schema.ts:39-63`). Naming-collision risk between the gallery's
  `daily-compounding-reflection` and the new seeded schedule.

### UI (Phase 1 fallback ground)

- Steps render data-driven (`apps/ui/src/pages/workflow-runs/[id]/page.tsx:267-284`); synthetic
  children appear automatically. `step-card.tsx:57-58` resolves node by exact
  `n.id === step.nodeId` → undefined for synthetic ids (label degrades; type badge is fine — it uses
  `step.nodeType`, `:79`; `AgentInfo`/config sub-renders silently vanish, `:132-140`).
- Graph status aggregation, selection/highlight, and expand/scroll all key on exact nodeId:
  `graph-utils.ts:40-44,56-58`, `workflow-graph.tsx:36-55`, `page.tsx:33,65-78,101,108-115,248,272-282`.
  One strip-suffix/resolve-parent helper routed through these sites suffices.
- `WorkflowNodeType` is a plain string alias client-side (`apps/ui/src/api/types.ts:950`); no palette
  exists; unknown types fall back to generic icon/category/JsonTree — `foreach` needs zero UI type
  registration beyond the synthetic-id fallback.

### Monolith & templates (Phase 4 ground)

- **The monolith prompt is NOT prod-only**: `templates/schedules/daily-compounding-reflection/`
  (v1.0.0, ~1.6K words, `must: true`, placeholders `SLACK_CHANNEL_ID`/`TIMEZONE`) and
  `templates/schedules/daily-blocker-digest/` (~830 words) exist in-repo, alongside 6 other schedule
  templates. Prod's `cdfa3f00` prompt (~4.5K words) has evolved well past the template → cutover
  needs a prod-DB fetch + diff to transplant the delta (rotation list, AgentMail-is-REST gotcha,
  RESOLVED-STALE rule, migrated-host list).
- `scheduled_tasks.enabled` exists (`001_initial.sql:11`), `targetType`/`workflowId` from
  `103_schedule_target_type.sql`; precedent for row-mutating migrations exists
  (`030_iso8601_date_consistency.sql:93-108`). Next free migration number: **126**.
- Seeder registry today: `agentFsProvision`, `scripts`, `skills` only (`src/be/seed/registry.ts:15`).
- `src/heartbeat/templates.ts:31` references `daily-blocker-digest` (staleness check) — heartbeat
  prompt text must be updated when the digest schedule is absorbed into `dream`.

## Desired End State

1. A generic `foreach` executor exists: `over` an array, one agent-task child per item, synthetic
   child step ids `<nodeId>#<itemKey>`, parent-owned join + aggregation into
   `ctx[nodeId] = {results: [{itemKey, status, output}], okCount, failedCount}`. A run containing a
   foreach **cannot** complete before the foreach's successor runs (the Q1 landmine is the
   acceptance test), including across crash-recovery and retry.
2. `workflowsSeeder` + `schedulesSeeder` are new seedable kinds; an operator's disable/retime/edit
   survives every restart and every shipped-source change (regression-tested).
3. Add-ons exist as a **code-level composition manifest** (per-entity hashing preserved) — Dreaming
   is the first entry; no add-ons table or UI in v1 (Taras: iterate later toward a template
   primitive + UI/skill exposure).
4. A fresh install dreams daily with zero manual steps: seeded `dream` workflow + enabled daily
   schedule + `dreaming` skill + `dream-agent-slice`/`dream-apply`/`dream-receipt` catalog scripts +
   `DREAMING_ENABLED`/`DREAMING_SLACK_CHANNEL` config catalog entries + docs (Add-ons section,
   Dreaming page, both with the "fka compounding" continuity note).
5. Workers propose (schema-validated JSON via task `outputSchema`), Lead critiques in one turn, only
   `dream-apply` mutates state, every bounced anchored op surfaces as `HELD` in the same day's
   receipt; quiet days cost one script execution (activity gate).
6. Prod cutover: monolith knowledge transplanted into the skill, `cdfa3f00` + `daily-blocker-digest`
   schedules retired by migration, heartbeat references updated, gallery entries carry a
   supersession note.

## What We're NOT Doing

- Peer critique (agent-critiques-agent) — deferred to v2 (brainstorm decision 4).
- Per-node `failurePolicy` on `foreach` — definition-level `onNodeFailure: "continue"` suffices (Q5).
- `reduce` / nested-foreach — v1 is one consumer, one primitive. `body.type` is restricted to
  `agent-task` in v1.
- **`concurrency` on `foreach`** — *pushback on the brainstorm's "ship the field unused" leaning*:
  an accepted-but-ignored field is a silent lie (same failure mode as the triggerSchema subset
  learning), and real bounded dispatch adds state reconstruction to the trickiest new path (the
  join) for a 6-item consumer. v1 **rejects** `concurrency` in `validateDefinition` with "not
  supported in v1"; the field ships when a >dozens-item consumer exists.
- Per-anchor cooldowns, add-ons UI/API, add-on-as-template-primitive refactor — later iterations.
- Renaming `compound-insights` or the gallery entries (supersession notes only).
- New model-tier pinning in the dream workflow — **no `modelTier`/`model` on any node; agents run on
  their own defaults** (Taras).

## Implementation Approach

- **Parent owns the join.** The foreach executor materializes child steps + tasks and stays
  `waiting`; resume/recovery route synthetic child ids back to the parent, and only when all
  children are terminal does the parent complete with the aggregate — reusing `walkGraph`'s existing
  convergence gate for everything downstream. No changes to the batch scheduler.
- **Synthetic id contract**: `<parentNodeId>#<itemKey>`, `itemKey` = `agent.id` (UUID — cannot
  contain `#`; parse at the **first** `#`; `validateDefinition` rejects definition node ids
  containing `#`).
- **Delta schemas fit the validator subset** (`type/required/properties/enum/const/items` only — no
  `oneOf`): one shared module exports the JSON schemas + per-kind TS validators; the workflow
  builder imports it and `dream-apply` bundles it (catalog-report bundling precedent). Strict
  per-kind enforcement happens inside `dream-apply`, fail-loud.
- **Anchored ops without a new primitive**: `dream-apply` does read (db_query) → exactly-one-match
  splice → whole-field `profile_update` write. The anti-overwrite rule is encoded in the script's
  op schema, not in a new tool surface.
- **Config gate semantics**: `gather` reads `config_get('DREAMING_ENABLED')`; **absent row ⇒
  enabled** (config_get never sees env — verified), so default-on needs no seeded row. Gate =
  `enabled && hasActivity` in one `code-match` port node.
- **Sequencing**: engine primitive first (Phase 1, independently testable), seed mechanism second
  (Phase 2, toy fixtures), content third/fourth (Phases 3–4 through the now-existing mechanisms),
  prod cutover last (Phase 5).

## Quick Verification Reference

```bash
bun run tsc:check
bun run lint                 # NOT lint:fix — CI runs read-only lint
bun run test:root            # all root unit tests
bun run test:root -- src/tests/<file>.test.ts   # one file
bash scripts/check-db-boundary.sh
bun run check:dep-graph
cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b   # if apps/ui touched
```

---

## Phase 1: `foreach` executor + resume child→parent mapping + UI fallback

### Overview

Pure engine work, independently testable: a generic `foreach` executor with parent-owned join,
child→parent routing in every resume/recovery/retry path, and the dashboard fallback for synthetic
step ids. Deliverable: a workflow containing `foreach` runs end-to-end (fan-out → join → successor)
and `src/tests/workflow-foreach.test.ts` proves the landmine is defused.

### Changes Required:

#### 1. Foreach executor
**File**: `src/workflows/executors/foreach.ts` (new)
**Changes**: `BaseExecutor` subclass, `type: 'foreach'`. Config:
`{over: <interpolated array>, itemKey: <property name, e.g. "id">, body: {type: 'agent-task', config: {...}}}`.
`run()`:
- Validate: `over` resolves to an array; `body.type === 'agent-task'`; reject `concurrency` (v1);
  reject items whose `itemKey` value is missing/duplicated.
- **Empty array edge case**: return synchronous success with an empty aggregate
  `{results: [], okCount: 0, failedCount: 0}` — no waiting, no children.
- Per item: interpolate `body.config` with `{item, index}` merged into the interpolation ctx
  (`deepInterpolate` from `src/utils/template.ts` — foreach does its **own** pass, mirroring the
  swarm-script carve-out at `engine.ts:737-756`); create a `workflow_run_steps` row with
  `nodeId = '<parentNodeId>#<itemKey>'` (idempotent: skip materialization if a step with that
  synthetic nodeId already exists for the run — safe across re-walks); create the agent task the
  same way `agent-task.ts:53-127` does (`workflowRunStepId` = **child** step id, `outputSchema`
  from `body.config.outputSchema`, `source: 'workflow'`), reusing its
  `getTaskByWorkflowRunStepId` de-dupe.
- Return `{async: true, waitFor: 'task.completed', correlationId: <parent step id>}` so the engine
  parks the parent step `waiting` (`engine.ts:603-606`).

#### 2. Child→parent join module
**File**: `src/workflows/foreach-join.ts` (new)
**Changes**: `parseSyntheticNodeId(nodeId)` (split at first `#`), `resolveForeachParent(def, nodeId)`
(prefix must name a `foreach` node in the definition), and `joinForeach(runId, childStep, ...)`:
on any child reaching a terminal status, recount the parent's children; if any non-terminal → stay
waiting; if all terminal → build the aggregate output, `checkpointStep` the **parent**
(`ctx[parentNodeId] = aggregate`), and return `getSuccessors(def, parentNodeId)` for the caller to
walk. Child steps checkpoint their own row status but do **not** write `ctx` (only the parent
aggregate is downstream-visible — `checkpoint.ts:23` is a plain overwrite, and `inputs` sourcePaths
can't enumerate dynamic keys).

#### 3. Resume / recovery / retry branches
**Files**: `src/workflows/resume.ts`, `src/workflows/recovery.ts`
**Changes**: in each nodeId-keyed site, branch on `resolveForeachParent` before `getSuccessors`:
- `resumeFromTaskCompletion` (`resume.ts:138`) — synthetic id → mark child completed, `joinForeach`,
  walk parent successors when the join closes.
- `handleTaskFailure` (`resume.ts:211`) — with `onNodeFailure: 'continue'`, child checkpoints as
  completed carrying the existing `[FAILED: <reason>]` marker (`resume.ts:202-205`), then the same
  join path; with `'fail'`, existing `markRunFailed` behavior is fine (fail-fast kills the run).
- `retryFailedRun` (`resume.ts:249-278`) — resolve synthetic ids to the parent node instead of
  throwing `Node X not found`.
- `recoverWaitingRuns` (`recovery.ts:121-124`) — same branch for tasks that completed while the API
  was down.
- `validateDefinition` (`src/workflows/definition.ts`) — reject node ids containing `#`; validate
  foreach config shape (incl. the v1 `concurrency` rejection).

#### 4. Executor registration
**Files**: `src/workflows/executors/registry.ts:63-82` (one `register` line),
`src/tools/workflows/create-workflow.ts:22-40` (tool description text mentions `foreach` + config
shape + the synthetic-id/join semantics — subset-doc-at-every-authoring-surface rule),
`runbooks/workflows.md` (document `foreach`: config, aggregate output shape, `onNodeFailure`
interplay, no-concurrency-in-v1).

#### 5. UI fallback for synthetic step ids
**Files**: `apps/ui/src/lib/` (new `parseSyntheticStepId` helper),
`apps/ui/src/components/workflows/step-card.tsx:57-58` (resolve parent node for label/config; show
item key as sub-label, e.g. `reflect · <agent name or key>`),
`apps/ui/src/components/workflows/graph-utils.ts:40-58` (aggregate child statuses onto the parent
graph node: any running → running, any failed → failed, all completed → completed),
`apps/ui/src/components/workflows/workflow-graph.tsx:36-55` +
`apps/ui/src/pages/workflow-runs/[id]/page.tsx:33,65-78,101,108-115,248,272-282` (selection,
expand/scroll keyed through the parent-resolution helper).

#### 6. Tests
**File**: `src/tests/workflow-foreach.test.ts` (new)
**Changes**: isolated SQLite DB per LOCAL_TESTING conventions (`initDb()`/`closeDb()`, unique port,
clean up `.sqlite`/`-wal`/`-shm`). Scenarios:
- **Landmine acceptance**: foreach(3 items) → successor node; complete the 3 tasks via
  `completeTask`; assert the run is NOT completed until the successor ran, and
  `ctx[parent].results` has 3 entries in item order.
- Empty `over` array → parent completes synchronously, successor still runs.
- `onNodeFailure: 'continue'`: one child fails → aggregate has `failedCount: 1` with the
  `[FAILED:` marker; run completes.
- Idempotency: re-walk after partial completion does not duplicate child steps/tasks.
- Recovery: simulate task completed while listener down → `recoverWaitingRuns` closes the join.
- `retryFailedRun` on a failed synthetic child resolves the parent (no throw).
- `validateDefinition` rejects `#` in node ids and `concurrency` in foreach config.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] New suite passes: `bun run test:root -- src/tests/workflow-foreach.test.ts`
- [ ] Full root suite passes (no regressions in existing workflow tests): `bun run test:root`
- [ ] UI builds: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`
- [ ] Boundary checks: `bash scripts/check-db-boundary.sh && bun run check:dep-graph`

#### Automated QA:
- [ ] Wire-level walkthrough: clean DB (`rm -f agent-swarm-db.sqlite*`), `bun run start:http`,
      create a 3-item foreach workflow via the `create-workflow` MCP tool, trigger it, complete the
      three child tasks via `PATCH /api/tasks/:id`, then assert via
      `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/workflow-runs/<runId>`
      that the successor step ran and the run completed with the aggregate in context.
- [ ] Dashboard check with screenshots (merge-gate requires a qa-use session for `apps/ui`
      changes): workflow-run page shows child lanes labeled `reflect · <itemKey>`, parent graph
      node aggregates status, clicking the parent node expands its child steps.

#### Manual Verification:
- [ ] Taras eyeballs the run-detail waterfall + graph for a foreach run (visual judgment on the
      sub-label/aggregation presentation).

**Implementation Note**: After this phase, pause for manual confirmation. Commit as
`[phase 1] foreach executor + child→parent resume + UI fallback` after verification passes.

---

## Phase 2: Seeders — `workflowsSeeder`, `schedulesSeeder`, add-on manifest

### Overview

Two new seedable kinds plus the code-level add-on composition manifest, validated with toy fixtures
(the real dream content arrives in Phase 4). Deliverable: `runAllSeeders()` seeds a workflow and its
schedule on a fresh DB, and the disable-survives-reseed regression test passes.

### Changes Required:

#### 1. Workflow lookup by name
**File**: `src/be/db.ts`
**Changes**: add `getWorkflowByName(name)` (the `workflows.name` UNIQUE constraint exists but no
name-keyed lookup does — check first whether `listWorkflows` filters by name, `~db.ts:8862`, and
reuse if so).

#### 2. Add-on manifest (composition layer)
**File**: `src/be/seed/addons.ts` (new)
**Changes**: the concrete manifest types:

```ts
/** A workflow shipped by an add-on. The full definition is what gets content-hashed. */
export interface AddonWorkflowDef {
  name: string;                    // workflows.name (UNIQUE) — the seed key
  description: string;
  enabled: boolean;
  definition: WorkflowDefinition;  // z.infer of WorkflowDefinitionSchema (src/types.ts:~1512-1624);
                                   // run through validateDefinition() in apply()
}

interface AddonScheduleBase {
  name: string;                    // scheduled_tasks.name (UNIQUE) — the seed key
  description: string;
  cronExpression: string;          // validated with the same cron check create-schedule uses
  timezone: string;                // 'UTC' for dream
  enabled: boolean;                // INSIDE the content hash (disable must survive re-seed)
  // no modelTier/model — agent defaults
}

/** A schedule shipped by an add-on: workflow-target (references its workflow by NAME — never a
 *  generated id) or task-target (classic taskTemplate schedule). Mirrors the scheduled_tasks
 *  CHECK: workflowId required for 'workflow', taskTemplate required for 'agent-task'. */
export type AddonScheduleDef =
  | (AddonScheduleBase & {
      targetType: "workflow";
      workflowName: string;        // resolved → workflowId at apply(); hashed as the name
    })
  | (AddonScheduleBase & {
      targetType: "agent-task";
      taskTemplate: string;        // hashed; prompt text goes through the template registry rules
      taskType?: string;
      targetAgentId?: string;      // omit ⇒ pool
      tags?: string[];
    });

export interface Addon {
  name: string;                    // add-on slug, e.g. 'dreaming'
  description: string;
  docsPath: string;                // path to the docs page, e.g.
                                   // "docs-site/content/docs/(documentation)/addons/dreaming.mdx"
  workflows: AddonWorkflowDef[];
  schedules: AddonScheduleDef[];   // workflow-target schedules' workflowName must match a workflows[].name here
  skillNames: string[];            // must exist in BUILT_IN_SKILL_SOURCES — asserted at boot
  scriptNames: string[];           // must exist in SEED_SCRIPTS — asserted at boot
  configKeys: string[];            // configuration-catalog keys; provenance/docs only, not seeded rows
}

export const ADDONS: readonly Addon[] = [/* dreaming — content lands in Phase 4 */];
```

Pure grouping for provenance/logging/docs; **each entity keeps its own per-entity hash** (Taras:
code-level now; later a template primitive, eventually UI/skill-exposed). The workflow/schedule
seeders derive their `items()` from `ADDONS`; the boot-time assertions (skill/script names resolve,
`workflowName` cross-references) fail loud in `runAllSeeders`, not silently at dispatch time.

#### 3. workflowsSeeder
**File**: `src/be/seed/workflows-seeder.ts` (new)
**Changes**: `kind: 'workflow'`, `key = workflow.name`. `contentHash` = SHA-256
(`computeContentHash`, `src/be/db.ts:453-457`) over canonical JSON of
`{name, description, enabled, definition}`. `upstreamHash()` = same shape recomputed from the live
row via `getWorkflowByName` (null if absent) — hashing the **full definition** means any UI edit to
the DAG is preserved. `apply()` runs `validateDefinition` (`createWorkflow` doesn't re-validate —
`src/tools/workflows/create-workflow.ts:110-137`) then create/update by name. Register in
`src/be/seed/registry.ts` **after** `skillsSeeder`.

#### 4. schedulesSeeder
**File**: `src/be/seed/schedules-seeder.ts` (new)
**Changes**: `kind: 'schedule'`, `key = schedule.name`. Supports both `AddonScheduleDef` variants.
`contentHash` over `{name, cronExpression, timezone, enabled, targetType}` **plus the
target fields per variant** — `workflowName` for workflow-target (the workflow **name**, never the
generated `workflowId`, so the hash is stable across fresh DBs) or
`{taskTemplate, taskType, targetAgentId, tags}` for task-target. **`enabled` + cron are inside the
hash** (the brainstorm's ⚠️ trap: otherwise a later source edit re-enables a deliberately disabled
schedule). `upstreamHash()` recomputes the same shape from the live row, mapping `workflowId` →
name via `getWorkflow` for workflow-target rows. `apply()` resolves `workflowId` by name for the
workflow variant (workflowsSeeder ran first — registry order) and passes `taskTemplate` through for
the task variant, honoring the cross-field CHECK (`103_schedule_target_type.sql:12-53`: workflowId
required for 'workflow', taskTemplate for 'agent-task'). Register **after** `workflowsSeeder`.

#### 5. Regression tests
**Files**: `src/tests/seed-workflows.test.ts`, `src/tests/seed-schedules.test.ts` (new; mirror
`seed-scripts.test.ts:180-208`'s user-modified-preserved pattern with toy fixtures)
**Changes**:
- Fresh DB: seeders create workflow + schedule; re-run is a no-op (idempotent).
- **Disable-survives-reseed** (the brainstorm's required regression test): seed → flip
  `enabled = 0` directly in the DB → change the *source* cron/definition → re-run seeders → assert
  still disabled, `skippedUserModified === 1`.
- Retimed cron survives a source change the same way.
- Pristine schedule + changed source → updated.
- UI-edited workflow definition (mutate `definition` JSON) survives a source change.
- `contentHash` is identical across two fresh DBs (no `workflowId` leakage into the hash).
- Task-target variant: an `agent-task` schedule fixture seeds correctly (taskTemplate honored) and
  its disable equally survives a source change.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] New suites pass: `bun run test:root -- src/tests/seed-workflows.test.ts` and
      `bun run test:root -- src/tests/seed-schedules.test.ts`
- [ ] Existing seed suites still pass: `bun run test:root -- src/tests/seed.test.ts` and
      `bun run test:root -- src/tests/seed-scripts.test.ts`
- [ ] Full suite: `bun run test:root`

#### Automated QA:
- [ ] Fresh-DB boot walkthrough: `rm -f agent-swarm-db.sqlite*`, `bun run start:http`, then
      `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/workflows` and
      `.../api/schedules` show the toy-fixture entities seeded exactly once; restart the server and
      confirm no duplicates and no re-enable of a manually disabled row.

#### Manual Verification:
- [ ] None (fully automatable).

**Implementation Note**: After this phase, pause for manual confirmation. Commit as
`[phase 2] workflows/schedules seeders + add-on manifest` after verification passes.

---

## Phase 3: Delta schemas + `dream-*` catalog scripts

### Overview

The mechanical substrate of Dreaming: one shared schema module and the three catalog scripts
(`dream-agent-slice`, `dream-apply`, `dream-receipt`), each unit-tested. Deliverable: scripts seeded
into the catalog and invocable standalone via `script-run`.

### Changes Required:

#### 1. Shared delta schemas
**File**: `src/be/seed-scripts/dream-schemas.ts` (new)
**Changes**: exports `ReflectionDeltaSchema` and `ApprovedDeltaSetSchema` as JSON-schema objects
**restricted to the validator subset** (`type/required/properties/enum/const/items` — NO `oneOf`;
`src/workflows/json-schema-validator.ts`), plus TS validator functions enforcing the per-kind field
rules of the tagged union `{kind: 'profile-op' | 'memory' | 'skill' | 'hygiene', ...}` (profile-op:
`{agentId, file: 'SOUL'|'IDENTITY'|'CLAUDE'|'TOOLS'|'HEARTBEAT', op: 'append-under'|'replace-section'|'remove-section',
anchor, content?}`). Imported by the Phase-4 workflow builder; **bundled into `dream-apply`'s
source** at build time the way `task-failure-audit` bundles `catalog-report` (one source, no drift).
Include a unit-testable `assertSubsetSafe(schema)` that walks the schema and rejects unsupported
keywords, so drift into `oneOf`/`pattern` fails CI.

#### 2. dream-agent-slice
**File**: `src/be/seed-scripts/catalog/dream-agent-slice.ts` (new) + registration in
`src/be/seed-scripts/index.ts`
**Changes**: the missing per-agent gather (verified: `compound-insights` is swarm-wide, no
`agentId` arg). Args `{agentId, days = 1}`; via `ctx.swarm.db_query`: window's tasks with failure
reasons + retries, tool usage, memories written + usefulness readouts, cost/context totals, current
profile texts **with their H2 anchor inventory**, skills installed vs actually invoked. Output:
compressed JSON slice sized for a short reflection session.

#### 3. dream-apply
**File**: `src/be/seed-scripts/catalog/dream-apply.ts` (new) + registration
**Changes**: sole mutator. Args `{deltas: ApprovedDeltaSet}`; validates with the bundled per-kind
validators (fail-loud on schema violations), then switches on `kind`:
- `profile-op`: read current field text (`db_query`), require **exactly one** anchor match (0 or
  ≥2 → the op goes to `held`, never applied), splice
  (`append-under`/`replace-section`/`remove-section`), write back whole-field via
  `ctx.swarm.profile_update` (mind the ≥200-char soul/identity guard,
  `src/tools/update-profile.ts:107-129` — a splice shrinking below it goes to `held`).
- `memory`: memory write/delete via the SDK memory tools.
- `skill`: skill create/update via the SDK skill tools.
- `hygiene`: HEARTBEAT anchored ops (same splice machinery) + rotation-cursor advance in KV.
Returns `{applied: [...], held: [{delta, reason}], deferred: [...]}` — `held` is the receipt's
fail-loud surface. **Pre-check**: verify `memory_*`/`skill_*`/`kv_*` are in
`src/scripts-runtime/sdk-allowlist.ts`; any missing tool gets added to `SDK_TOOL_NAME_MAP` (CI:
`scripts/check-sdk-tool-registration.ts`).

#### 4. dream-receipt
**File**: `src/be/seed-scripts/catalog/dream-receipt.ts` (new) + registration
**Changes**: args = apply results + run metadata. Always writes the receipt as a memory entry
(`🌙 Dreaming — <date>`: APPLIED / HELD / DEFERRED, per-agent one-liners). Posts to Slack **only**
when `config_get('DREAMING_SLACK_CHANNEL')` returns a row (absent ⇒ silent) via
`ctx.swarm.slack_post`. No hardcoded channel.

#### 5. Script unit tests
**File**: `src/tests/dream-scripts.test.ts` (new)
**Changes**: anchored-op engine tests (exactly-one-match applies; zero matches → held; ambiguous
anchor → held; `remove-section` removes to next same-level heading; sub-200-char soul result →
held), `assertSubsetSafe` accepts both shipped schemas and rejects a `oneOf` fixture, tagged-union
validator rejects wrong-kind fields, receipt renders HELD lines.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check` (includes catalog scripts via seed-script typecheck)
- [ ] Lint passes: `bun run lint`
- [ ] New suite passes: `bun run test:root -- src/tests/dream-scripts.test.ts`
- [ ] Seed-script manifest sync tests pass: `bun run test:root -- src/tests/seed-scripts.test.ts`
- [ ] SDK tool registration check passes: `bun run check:sdk-tool-registration` (or the CI-invoked
      equivalent per `scripts/check-sdk-tool-registration.ts`)

#### Automated QA:
- [ ] Standalone walkthrough on a live server: seed a fresh DB, run `dream-agent-slice` via the
      `script-run` MCP tool against a real agent id and confirm the slice JSON shape; run
      `dream-apply` with a fixture delta set containing one valid profile-op and one
      ambiguous-anchor op against a scratch agent; assert the valid op landed in the profile and
      the ambiguous one came back in `held`.

#### Manual Verification:
- [ ] None (fully automatable).

**Implementation Note**: After this phase, pause for manual confirmation. Commit as
`[phase 3] dream delta schemas + dream-agent-slice/apply/receipt scripts` after verification passes.

---

## Phase 4: The `dream` workflow, `dreaming` skill, config catalog, docs

### Overview

The Dreaming add-on assembled: the seeded DAG wired through the Phase-2 seeders, the runtime-playbook
skill, the two config keys on Settings → Configuration, and the docs. Deliverable: a fresh install
boots with a live, enabled daily dream.

### Changes Required:

#### 1. The dream workflow definition
**File**: `src/be/seed-workflows/dream.ts` (new; imported by the add-on manifest)
**Changes**: definition builder (imports `dream-schemas`) producing the target DAG:
- `gather` (swarm-script): `compound-insights days=1` + live roster (agent ids/names + lead
  detection → `leadAgentId`) + `config_get('DREAMING_ENABLED')` (**absent row ⇒ enabled** — env is
  invisible to `config_get`, verified) + activity signal (zero completed tasks, failures, and
  memory writes in window ⇒ `hasActivity: false`) + absorbed blocker sweep (Q8 — the
  `daily-blocker-digest` prelude becomes part of gather's output).
- `proceed?` (code-match): `outputPorts: ['true','false']`, code returns
  `enabled && hasActivity`; `next: {true: [reflect, skills, hygiene…], false: done}` — quiet days
  cost one script execution.
- `reflect` (**foreach** over `{{gather.result.agents}}`, `itemKey: 'id'`): body agent-task —
  `agentId: "{{item.id}}"`, ~3-line template ("run the `dreaming` skill for yourself; your slice:
  dream-agent-slice output"; slice either embedded per-item by gather or fetched by the child via
  `script-run dream-agent-slice`), `outputSchema: ReflectionDeltaSchema`. **No modelTier/model** —
  agents' own defaults (Taras).
- `skills` lane (agent-task): skill-list + adoption check → SkillDelta (subset of
  ApprovedDeltaSet kinds).
- `hygiene` lane (swarm-script `gh-pr-snapshot` → agent-task): HEARTBEAT + rotation target →
  HygieneDelta; rotation cursor read from KV as an explicit input.
- `critique` (agent-task, `agentId: "{{gather.result.leadAgentId}}"`): inputs
  `{reflections: "reflect.results", skills: "skills.…", hygiene: "hygiene.…"}` — drift check,
  dedupe, arbitration; `outputSchema: ApprovedDeltaSetSchema`; instruction to quote anchors
  **verbatim from the profile text present in its inputs**.
- `apply` (swarm-script `dream-apply`) → `receipt` (swarm-script `dream-receipt`).
- Definition-level `onNodeFailure: 'continue'`.
Register the workflow + daily schedule (`cron '10 2 * * *'` UTC to match the template lineage,
`targetType: 'workflow'`, `enabled: true`) in the Dreaming `Addon` manifest entry.

#### 2. The dreaming skill
**Files**: `templates/skills/dreaming/{config.json,content.md}` (new) + two static text-imports and
one `BUILT_IN_SKILL_SOURCES` entry in `src/be/seed-skills/index.ts:115-125`
**Changes**: runtime playbook for a reflection lane — the ReflectionDelta contract, evidence rules
(what earns a profile op), anchor-quoting discipline, profile section conventions (stable H2
headings), and the mandatory up-front line: *"dreaming is also referred to as **compounding** — the
earlier name — which you'll still see in older memories, schedules, and Slack history."* Transplant
the durable knowledge already present in
`templates/schedules/daily-compounding-reflection/content.md` (v1.0.0) now; the prod-only delta
lands in Phase 5. Name is unique across `templates/skills/` and `plugin/skills/` (seeded/baked
collision rule). No `files/` planned; if any get added → `bun run build:seed-skill-files` + commit
the generated JSON.

#### 3. Config catalog entries
**Files**: `apps/ui/src/lib/configuration-catalog.ts`, `src/be/swarm-config-guard.ts`,
`docs-site/content/docs/(documentation)/ui/configuration.mdx`
**Changes**: `DREAMING_ENABLED` (group: new **Add-ons** group or Workflows; kind `boolean`;
`defaultValue: true`; description notes absent-means-enabled; `docsUrl` → Dreaming page) and
`DREAMING_SLACK_CHANNEL` (kind `string`, optional; **a channel id is config, not a secret**).
Boolean validator for `DREAMING_ENABLED` in `VALIDATED_KEYS`. Same-PR docs update per the
catalog rule.

#### 4. Docs
**Files**: `docs-site/content/docs/(documentation)/addons/index.mdx` + `addons/dreaming.mdx` (new)
**Changes**: Add-ons index ("what ships on by default, and how to turn any of it off") + Dreaming
page (architecture diagram, config keys, receipt format, HELD semantics, disable/retime guidance +
the seed-preservation guarantee, and the fka-compounding continuity note). Wire into the docs nav.

#### 5. Integration test
**File**: `src/tests/workflow-dream.test.ts` (new)
**Changes**: fresh-DB seed → assert workflow `dream` + schedule exist and are enabled → start a run
with a stubbed roster of 2 fake agents → complete reflection/skills/hygiene/critique tasks with
schema-valid fixtures via `completeTask` → assert `dream-apply` step received the approved set,
receipt step ran, run completed. Also: `DREAMING_ENABLED` row set to `false` → run short-circuits
at the gate with a single gather execution; zero-activity window short-circuits the same way.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] New suite passes: `bun run test:root -- src/tests/workflow-dream.test.ts`
- [ ] Skill-source checks pass: `bun run check:skill-sources && bun run check:seed-skill-files`
- [ ] UI builds (catalog touched): `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`
- [ ] Full suite: `bun run test:root`

#### Automated QA:
- [ ] Fresh-install walkthrough: `rm -f agent-swarm-db.sqlite*`, `bun run start:http`; confirm via
      `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/workflows` +
      `/api/schedules` that `dream` and its daily schedule are seeded enabled; confirm the
      `dreaming` skill appears in the skills API; flip `DREAMING_ENABLED` off via
      `PUT /api/config`, trigger the workflow, and assert the run ends at the gate node.
- [ ] Settings → Configuration screenshot session (qa-use; merge-gate for `apps/ui`): both keys
      visible with descriptions and docs links, toggling `DREAMING_ENABLED` persists.

#### Manual Verification:
- [ ] Taras reviews the `dreaming` skill playbook text and the critique prompt (judgment call on
      the evidence rules / what earns a profile op).
- [ ] Taras reviews the Add-ons + Dreaming docs pages.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as
`[phase 4] dream workflow + dreaming skill + config catalog + docs` after verification passes.

---

## Phase 5: Cutover — transplant prod knowledge, retire the monolith

### Overview

The only phase touching prod state. Deliverable: the monolith's institutional knowledge lives in the
`dreaming` skill, `cdfa3f00` and `daily-blocker-digest` are disabled by migration, and the first
real dream run has been observed on prod.

### Changes Required:

#### 1. Fetch + diff the live prompts (prod is ahead of the repo templates)
**Commands** (prod host per memory: ssh alias `swarm`):
```bash
ssh swarm "sqlite3 <db-volume-path>/agent-swarm-db.sqlite \
  \"SELECT name, taskTemplate FROM scheduled_tasks WHERE id='cdfa3f00-0e10-4bcd-8d69-9f10b30cb9a2' OR name='daily-blocker-digest';\"" \
  > /tmp/prod-monolith-prompts.txt
```
Diff against `templates/schedules/daily-compounding-reflection/content.md` (~1.6K words vs prod's
~4.5K) and extract the delta: rotation list, AgentMail-is-REST-not-MCP gotcha, RESOLVED-STALE
post-mortem rule, migrated-host list, and anything else accreted since v1.0.0.

#### 2. Transplant into the skill + lane inputs
**Files**: `templates/skills/dreaming/content.md`, `src/be/seed-workflows/dream.ts` (hygiene lane
inputs), possibly `dream-agent-slice`
**Changes**: fold every durable fact from the delta into the skill playbook or the hygiene lane's
gather inputs. **This lands and is reviewed BEFORE the retirement migration merges** (core
requirement 7 — the most likely way the cutover silently loses knowledge).

#### 3. Retirement migration
**File**: `src/be/migrations/1NN_retire_daily_evolution_monolith.sql` (next free number — 126 at
research time; **re-verify at implementation**, several parallel branches renumber migrations)
**Changes**:
```sql
-- Prod cutover: retire the daily-evolution monolith + blocker-digest schedules,
-- superseded by the Dreaming add-on's `dream` workflow (fka compounding).
-- No-op on installs that never had these rows. Do NOT re-enable; see runbooks/workflows.md + docs Add-ons/Dreaming.
UPDATE scheduled_tasks SET enabled = 0 WHERE id = 'cdfa3f00-0e10-4bcd-8d69-9f10b30cb9a2';
UPDATE scheduled_tasks SET enabled = 0 WHERE name = 'daily-blocker-digest';
```
Forward-only, tested against a fresh DB **and** a copy with the rows present (per migration rules).
Disable, not delete — history and post-mortem references stay queryable.

#### 4. Heartbeat references
**Files**: `src/heartbeat/templates.ts:31`, the `Heartbeat Audit` seed script (its
did-daily-blocker-digest-run-today check)
**Changes**: replace the digest-staleness check with a did-the-dream-run-complete check (the digest
is absorbed into `gather` — Q8), keeping the heartbeat rule numbering intact.

#### 5. Gallery supersession notes
**Files**: `templates/schedules/daily-compounding-reflection/content.md`,
`templates/schedules/daily-blocker-digest/content.md`
**Changes**: front-of-doc note: superseded by the **Dreaming add-on** (fka compounding) for swarm
installs; content remains as copy-paste prior art. (Gallery is `apps/templates-ui` filesystem
content — not seeded; verified.)

### Success Criteria:

#### Automated Verification:
- [ ] Migration applies on a fresh DB: `rm -f agent-swarm-db.sqlite* && bun run start:http`
      (boots clean, `_migrations` includes the new entry)
- [ ] Migration is a no-op-safe UPDATE on a DB copy containing the target rows (assert
      `enabled = 0` after; scripted in a small test or one-off check)
- [ ] Type check + lint + full suite: `bun run tsc:check && bun run lint && bun run test:root`

#### Automated QA:
- [ ] Diff report artifact: the extracted prod-prompt delta and where each fact landed
      (skill section / lane input), attached to the PR.

#### Manual Verification:
- [ ] Taras signs off the transplanted-knowledge diff (nothing durable dropped) **before** the
      migration merges.
- [ ] After deploy (merging `main` auto-deploys): observe the first scheduled dream run on prod —
      receipt posted (if `DREAMING_SLACK_CHANNEL` set), HELD list empty or plausible, profiles
      changed surgically, `cdfa3f00` + `daily-blocker-digest` show disabled.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as
`[phase 5] transplant monolith knowledge + retire cdfa3f00/daily-blocker-digest` after verification
passes.

---

## Manual E2E

Full local end-to-end against a real worker (commands per `LOCAL_TESTING.md`):

```bash
# 1. Clean DB + start API (seeders run at boot)
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &

# 2. Verify the add-on seeded
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/workflows | jq '.workflows[] | select(.name=="dream") | {name, enabled}'
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/schedules | jq '.schedules[] | select(.targetType=="workflow") | {name, cronExpression, enabled, workflowId}'

# 3. Build worker image + start lead & worker
bun run docker:build:worker:slim
SUFFIX=$(git branch --show-current | tr '/' '-')
docker run --rm -d --name e2e-lead-$SUFFIX --env-file .env.docker-lead \
  -e AGENT_ROLE=lead -e MAX_CONCURRENT_TASKS=1 -p 3201:3000 agent-swarm-worker:slim
docker run --rm -d --name e2e-worker-$SUFFIX --env-file .env.docker \
  -e MAX_CONCURRENT_TASKS=1 -p 3203:3000 agent-swarm-worker:slim

# 4. Verify registration (wait ~15s first)
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/agents \
  | jq '.agents[] | {name, isLead, status}'

# 5. Trigger the dream workflow now (don't wait for cron) — use the execute/trigger surface
#    (execute-workflow MCP tool or the workflows trigger route; confirm exact route at impl time)
#    then watch the run:
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/workflow-runs | jq '.runs[0] | {id, status}'

# 6. Observe in the dashboard (foreach lanes, critique, apply, receipt):
#    bun ui  →  workflow-runs page; child steps show `reflect · <agent>`, parent node aggregates.

# 7. Kill-switch check: flip DREAMING_ENABLED off in Settings → Configuration (or PUT /api/config),
#    re-trigger, assert the run ends at the gate with one gather execution.

# 8. Cleanup
docker stop e2e-lead-$SUFFIX e2e-worker-$SUFFIX
kill $(lsof -ti :3013)
```

Prod (after Phase 5 deploy): observe the first cron-fired run end-to-end; verify receipt, HELD
list, and that both retired schedules stay disabled across an API restart.

---

## Appendix

- **Follow-up plans** (v2 candidates, per Taras): add-on as a first-class template primitive
  (refactor of `templates/` + `src/workflows/templates.ts`), add-ons UI/API + "add an add-on"
  skill, peer critique, `foreach` `concurrency` when a large-N consumer exists, per-anchor
  cooldowns.
- **Derail notes**:
  - The resume landmine technically also exists on today's crash-recovery path
    (`recovery.ts:121-124`) but is unreachable because the engine always writes `nodeId = node.id`
    — worth a defensive comment when Phase 1 touches it.
  - `workflows.name` has a UNIQUE constraint but no name lookup helper existed until this plan —
    smells like other call sites re-derive it via list+filter; possible later cleanup.
  - The exact execute/trigger surface for manually firing a workflow (Manual E2E step 5) was not
    pinned during research — confirm tool/route at implementation time.
  - Scheduler's legacy `targetType='agent-task'` branch still consults
    `workflows.triggers[].scheduleId` bindings (`scheduler.ts:158-172`) — irrelevant to `dream`
    but easy to trip over when reading dispatch code.
- **References**:
  - Brainstorm: `thoughts/taras/brainstorms/2026-07-31-compounding-engine-workflow.md`
  - Runbooks: `runbooks/workflows.md`, `runbooks/seed-scripts.md`, `runbooks/skills.md`
  - Prior learnings applied: validator-subset-docs-at-every-surface (2026-05-05),
    zod-as-source-of-truth-for-enum-columns (2026-05-08)
  - Decisions taken during planning (Taras, 2026-08-03): add-on = code-level composition manifest,
    per-entity hashing; schemas = shared module bundled into the script; gallery entries get
    supersession notes; no model-tier pinning in the dream DAG.
