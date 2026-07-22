---
date: 2026-07-21T00:00:00+02:00
author: Taras
topic: "Task-lifecycle edges & routing handlers v1 — extension-system Layer 2"
tags: [plan, extension-system, routing, before-assign, hooks, rbac, lifecycle-ui]
status: parked # reviewed 2026-07-22, all file-review comments addressed; resume with /desplega:implement-plan in a fresh session
autonomy: verbose
brainstorm: thoughts/taras/brainstorms/2026-07-21-swarm-extensibility-routing.md
last_updated: 2026-07-22
last_updated_by: Claude
---

# Task-Lifecycle Edges & Routing Handlers v1 Implementation Plan

## Overview

Build the extension system's event + hook spine and its first real consumer: rebuild Layer 1 (durable event bus + subscriptions — PR #980 is being closed, relevant pieces rebuilt from scratch), then ship the first two intercepting edges — `task.before_assign` (all five assignment vias) and `prompt.compose` (soft Lead directives) — with typed, sandboxed script handlers, full observability (per-task trace, `routing.*` bus events, per-rule stats, dry-run), and the task-lifecycle graph UI.

- **Motivation**: Catches (Daniel) routing/delegation pain — opaque 6-branch poll waterfall, continuity pin without intent check, no channel→agent rules. Routing becomes the proving use case for extension-system Layer 2.
- **Related**: `thoughts/taras/brainstorms/2026-07-21-swarm-extensibility-routing.md`, PR #980 (spike/extension-system — being closed; salvage inventory in research)

### Scope decisions (confirmed with Taras, 2026-07-21)

- Commit per phase after manual verification passes (`[phase N] <description>`).
- One plan covers backend v1 **and** the lifecycle-graph UI.
- PR #980 will be **closed**; this plan takes what's relevant but rebuilds from scratch on `main` — including a Layer 1 rebuild (event bus + subscriptions), since routing observability and matcher-gating depend on it.
- Both edges in v1: `task.before_assign` + `prompt.compose` (soft rules need a delivery mechanism).

## Current State Analysis

### PR #980 salvage inventory (branch `spike/extension-system`, e1964e4a — 41 files, +2909/−195)

Verdict: almost everything is **cleanly liftable** — "rebuild from scratch" in practice means re-landing the good parts on a fresh branch off main, with review. Key components:

- **Migrations**: `117_swarm_events_subscriptions.sql` (`swarm_events` journal; `subscriptions` with eventPattern+filter+targetType script|workflow; `subscription_deliveries` with UNIQUE(subscriptionId,eventId) dedupe) and `118_script_tools.sql`. **Note: migration numbers must be re-checked against main at re-land time** (117/118 may be taken).
- **Glob matcher**: `src/subscriptions/matcher.ts` (dot-segment, `*` one segment, `**` trailing only). Liftable.
- **Payload-filter language: nothing new to build** — #980 reuses `matchesFilter` from `src/workflows/wait-filter.ts`, which already exists on main (object deep-match form + sandboxed arrow-function string form, 50ms cap). Handler matcher-gating imports it directly.
- **Outbox dispatcher**: `src/subscriptions/dispatcher.ts` + `src/be/subscriptions-db.ts` — `onAny` bus tap → capture (glob+filter) → durable delivery rows → 2s-interval poller, atomic single-statement claim, MAX_ATTEMPTS=3, journal pruning. Liftable; single-process only (multi-replica lease out of scope).
- **Event-bus `onAny`/`offAny` tap**: `src/workflows/event-bus.ts` (+23) — per-handler try/catch so a failing tap never breaks emit. Liftable; the emit-API piece routing wants.
- **Emitters**: Linear/Jira webhook one-liners (`linear.<type>.<action>`, `jira.<event>`); Slack `slack.message` already wired on main.
- **MCP tools + RBAC**: `create/list/patch/delete-subscription` (`subscription.write` create-only + `subscription.mutate.any` leadOrResourceOwner ownership split — keep this pattern), `tool.publish` leadOnly. SDK exposure (`subscription_*`) mechanical.
- **`runGlobalScriptByName`** (`src/be/scripts/run-global.ts`, 44 lines): the key reusable primitive — global script lookup + credential/API/MCP bindings + `runScript()` + throw on non-zero exit. Used by dispatcher and dynamic tools; scheduler still has an older duplicate (follow-up, not this plan).
- **Layer 3** (`script_tools` table, `script-tools.ts` publish flow with `ALL_TOOLS.has()` collision guard, `dynamic-script-tools.ts` per-session registration — next-session-only freshness): liftable; not required by routing.
- **Tests**: `subscriptions.test.ts` (327 lines) + `script-tools.test.ts` (178 lines) — self-contained, cover exactly the seams to protect.
- **Discard**: spawn-latency spike script (keep the numbers: p50 179ms / p95 215ms); regenerate `MCP.md` fresh; salvage the `runbooks/workflows.md` emitter-list factual fix.

### Scripts runtime, prompt registry, RBAC, events — machinery to build on

- **Server-side script execution already exists**: `runScript()` (`src/scripts-runtime/loader.ts:59-107`) is the reusable "run catalog/inline script with args, get structured `{result, stdout, stderr, exitCode, error, durationMs}`" function; three callers today (`src/http/scripts.ts:496-623`, `src/http/x.ts:199-247`, workflow `swarm-script` executor `src/workflows/executors/swarm-script.ts:75-115`). Sandbox: per-run tmpdir, ulimit wrapper, stdin `SwarmConfigPayload`, 30s `AbortController`, 1MB stdout cap (`src/scripts-runtime/executors/native.ts:138-251`). Script result = default-export return value, JSON via result file.
- **No `kind` column on `scripts`** (`064_scripts.sql`; `ScriptRecordSchema` `src/types.ts:2138-2157`) — handler/edge declaration needs either a new column or a separate registration table. `script_runs.kind` (`'workflow'|'inline'`, migration 085) is a runtime-provenance tag, not authoring-time type.
- **Typecheck/upsert**: `POST /api/scripts/upsert` runs `tsc --noEmit` against generated `.d.ts` + extracts Zod `argsSchema` → `argsJsonSchema` (`src/http/scripts.ts:421-494`, `src/scripts-runtime/extract-args-schema.ts`). Global writes gated by `script.global.write`.
- **SDK typing**: hand-written `SCRIPT_SDK_TYPES` (`src/be/scripts/typecheck.ts:29+`) + `SDK_TOOL_NAME_MAP` allowlist (`src/scripts-runtime/sdk-allowlist.ts`) + generator `scripts/bundle-script-types.ts` → `swarm-sdk.d.ts`. New ctx surface (RoutingCtx) = extend `RuntimeCtx` + `buildCtx()` (`src/scripts-runtime/ctx.ts:13-43`), add types to `SCRIPT_SDK_TYPES`, regenerate.
- **Prompt registry**: `registerTemplate()` (`src/prompts/registry.ts:33-35`); resolution `agent → repo → global` two-pass with wildcards (`src/be/db.ts:9588-9639`); worker/HTTP resolver split via `configureDbResolver`/`configureHttpResolver` (`src/prompts/resolver.ts:91-129`). **Precedent for runtime-decided directives**: `getBasePrompt()` conditional-append pattern (`src/prompts/base-prompt.ts:96-343`) — register a template with `{{var}}` placeholders, resolve with route-time vars, append. Lead session composite: `system.session.lead` (`src/prompts/session-templates.ts:720-833`).
- **RBAC**: verbs in `PERMISSIONS` (`src/rbac/permissions.ts:19-224`) + evaluator map in `src/rbac/legacy-policy.ts:189-195`; `can()` is pure/sync (`src/rbac/can.ts:29-44`); route `rbac:` field is metadata for CI coverage only — handlers gate explicitly.
- **Internal LLM helper for `ctx.classify()`**: `completeStructured<TZod>()` (`src/utils/internal-ai/complete-structured.ts:176-309`) already exists — Zod schema in, validated object or null out, credential resolution + claude-cli/pi-ai branches, 30s timeout, 3 retries, worker-safe. This satisfies the internal-AI-abstraction rule; classify wraps it.
- **swarm_config**: generic scoped KV (`001_initial.sql:246-258`) with full HTTP+RBAC plumbing (`src/http/config.ts:110-413`); usable for handler config. Note: `RunScriptInput.userConfig` → `ctx.swarm.config` plumbing exists end-to-end but is unwired at all three call sites today.
- **Events**: internal `events` table (`021_events.sql`) + `createEvent()`/`createEventsBatch()` (`src/be/events.ts:119-177`) — synchronous DB audit log, separate from Business Use. Only in-process pub/sub is the workflow-scoped `InProcessEventBus` (`src/workflows/event-bus.ts:1-30`); **no swarm-wide durable bus on main** (confirms L1 rebuild need).
- **Dry-run precedents**: `ExecutorMetaSchema.dryRun` exists but is dead (engine hardcodes false, `src/workflows/engine.ts:521-524`); the working pattern is `src/e2b/dispatch.ts` ("return the would-be call, short-circuit before execution").

### Assignment sites on main (the five `ctx.via` values)

All assignee writes are **server-side** (API process, direct `src/be/db` access — the hook engine can live server-side without violating the DB boundary). Two choke points dominate: `createTaskExtended` (`src/be/db.ts:3880`, INSERT at 4119-4181, `agentId` bound at 4135) for every new task, and `claimTask` (`src/be/db.ts:4224`) + `assignUnassignedTaskPending` (`src/be/db.ts:1432`) for reassignment UPDATEs.

1. **creation** — every ingress (Slack `src/slack/handlers.ts:616-712`, GitHub/GitLab/Linear/Jira handlers, `send-task` at `src/tools/send-task.ts:418/486/522`, `task-action` create `src/tools/task-action.ts:282-296`, workflow executor `src/workflows/executors/agent-task.ts:94-116`, scheduler `src/scheduler/scheduler.ts:53-66`, heartbeat/system tasks) funnels into `createTaskExtended`. **Hook site: immediately before the INSERT at `db.ts:4119`**, after parent-inheritance (3892-4029) and Slack normalization finalize `options` — the one place all five categories' options are settled. Full `CreateTaskOptions` (`db.ts:3768-3842`) in scope: source, slack channel/thread/user, vcs provider/repo/event, parentTaskId, modelTier, contextKey, routingAffinity, …
2. **delegation** — `sendTaskHandler` (`src/tools/send-task.ts:186`); continuity pin at lines 316-322 (`effectiveAgentId = parent.agentId` when parentTaskId set and no explicit agentId — **no intent check**, Daniel's failure). Hook site: after line 322, before dup-detection (340) and the create calls. Not a separate write path — a specific way `options.agentId` is populated before choke point 1.
3. **claim** — poll waterfall `src/http/poll.ts:137-434` (6 branches; only branch 5, pool auto-claim at 340-429, writes a new agentId via `claimTask`). `claimTask` (`db.ts:4224-4257`): eligibility pre-check (`isAgentEligibleForTask` `db.ts:1052`, gated by `POOL_AFFINITY_ENFORCEMENT`) then atomic UPDATE (4254). Explicit claim converges here too (`src/tools/task-action.ts:304-376`). Symmetric server-initiated site: `assignUnassignedTaskPending` (`db.ts:1432-1478`, heartbeat `autoAssignPoolTasks`). **Hook site: inside `claimTask` between eligibility check and UPDATE** (+ same in `assignUnassignedTaskPending`).
4. **resume** — `createResumeFollowUp` (`src/tasks/worker-follow-up.ts:248-389`): pin decision at 286-312 (`HEARTBEAT_PIN_CRASH_RESUME`, `HEARTBEAT_PIN_GRACEFUL_RESUME`, `WORKER_LIVENESS_WINDOW_SECONDS`), affinity snapshot via `buildRoutingAffinityFromAgent` (`db.ts:1030`), then `createTaskExtended`. Reboot-sweep retry pin: `src/heartbeat/heartbeat.ts:575-629`. Hook site: after `preferredAgentId` finalized (line 312 / heartbeat 604).
5. **completion** — `createWorkerTaskFollowUp` (`src/tasks/worker-follow-up.ts:119-197`): unconditionally `agentId: leadAgent.id` (line 188-196); guards: skips workflow tasks, `followUpConfig.disabled`, lead-run tasks. Hook site: before line 188, single-candidate `[leadAgent]`.

**Escalation fallback**: two reroute-decision creators, both Lead-owned `taskType: "reroute-decision"` via `createTaskExtended` — unreclaimed pins (`worker-follow-up.ts:425-482`, reaper `heartbeat.ts:765`, `HEARTBEAT_RESUME_PIN_GRACE_MIN`) and pool starvation (`worker-follow-up.ts:504-541`, `heartbeat.ts:874`, `POOL_AFFINITY_ESCALATION_MIN`). Idempotent via `hasNonTerminalRerouteDecisionChild`.

**Confirmed**: `task.source`, `vcsRepo`, `slackChannelId`, `contextKey` are stamped but never read by any eligibility/routing code — `isAgentEligibleForTask` (`db.ts:1052-1073`) reads only `routingAffinity` (`sourceAgentId`/`role`/`capabilities`) vs `agent.{id, role, capabilities}`. `routingAffinity` writers: `buildRoutingAffinityFromAgent`, `send-task.ts:442-444` (requiredCapabilities), `task-action.ts:293-295`, parent inheritance (`db.ts:4026-4028`).

### UI (apps/ui) — surfaces the lifecycle graph & routing trace build on

- **React Flow already present**: `@xyflow/react` ^12.10.1 + `dagre` (`apps/ui/package.json:27,34,51`). Read-only workflow DAG exists: `WorkflowGraph` (`apps/ui/src/components/workflows/workflow-graph.tsx:26-81`) + `toReactFlowGraph`/`applyDagreLayout`/stair layout (`apps/ui/src/components/workflows/graph-utils.ts:36-282`), custom node types on the shared `WorkflowNodeShell` primitive. No task-lifecycle or routing graph exists yet.
- **Task detail page**: `apps/ui/src/pages/tasks/[id]/page.tsx` (route `tasks/:id`, `router.tsx:100`). Bespoke 3-column layout; mobile tabs `details|outcome|logs` (line 91) — natural slot for a "routing" tab + desktop inline section. Timeline precedents: `LogTimeline` (line 162-187), `TaskCostSection`/`TaskContextSection` stat blocks (line 260-490) with `MetaRow` primitive.
- **Data fetching**: hand-written `ApiClient` singleton (`apps/ui/src/api/client.ts`, Bearer auth line 176-193) + react-query hooks per domain (`apps/ui/src/api/hooks/use-tasks.ts`). New routing-trace endpoint mirrors `useTaskContext` (`client.ts:405-410`, `use-tasks.ts:72-79`).
- **New page registration**: lazy route in `apps/ui/src/app/router.tsx:89-162` + `NavItem` in `navGroups` (`app-sidebar.tsx:86-125`, likely SWARM group), optional `gate: {minVersion}` version gating.
- **Stats precedents**: `StatsBar` (`shared/stats-bar.tsx:78-136`), Nivo wrappers (`shared/charts/nivo-charts.tsx`), usage/metrics pages; `DataGrid` mandated for tabular rule-stats lists. Tailwind v4 with token lint gate (`bun run check:tokens`).
- **Config-admin precedent**: integrations detail page (`apps/ui/src/pages/integrations/[id]/page.tsx:135-191`) — catalog + `useConfigs` + batched dirty-state save + `DetailPageBody`/`DetailPageRail` canonical layout.

## Desired End State

1. **Durable event bus + subscriptions (Layer 1)** live on main: `swarm_events` journal, `subscriptions` (script/workflow targets, glob + payload filter), at-least-once outbox delivery, MCP tools, `subscription.write`/`subscription.mutate.any` RBAC.
2. **`task.before_assign` edge** fires at all five assignment sites (`ctx.via ∈ {creation, delegation, claim, resume, completion}`), consuming N registered script handlers with declarative matcher filters (matcher-gating: zero sandbox spawns when no handler matches), priority + first-decisive resolution, guards before routes, `route`-flavor fail-open / `guard`-flavor fail-closed.
3. **Typed handler contract**: `RoutingCtx` (task + origin envelope, candidate agents + live load, continuity chain, `ctx.classify()` over `completeStructured` with ~3s budget) and typed result (`continue` / `{assignTo}` / prompt injection / task mutation / `{block, reason}`) — generated into `swarm-sdk.d.ts`, tsc-enforced at upsert.
4. **`prompt.compose` companion edge**: soft-rule directives injected into the Lead session prompt through the prompt-template registry.
5. **Soft/hard posture**: soft rules advise the Lead (task still flows through it); `hard` is per-rule opt-in bypass at the assignment site.
6. **Observability**: per-task routing trace (task detail page), `routing.matched/applied/lead_deviated/handler_failed` bus events, per-handler hit/deviation/error stats, dry-run endpoint + SDK method (doubles as authoring readback).
7. **Continuity-pin default handler** replaces the blind `parentTaskId` pin as a visible, overridable pre-installed handler — Daniel's failure case fixed by editing a handler, not an env knob.
8. **Lifecycle-graph UI**: read-only React-Flow page (reusing `WorkflowGraph` machinery) showing the task lifecycle with handlers annotated per edge, plus a routing tab/section on the task detail page.
9. **Catches pilot runnable**: "#gtm channel → GTM agent" authored conversationally by the Lead via the routing-rules skill (scripts SDK), dry-run verified, running soft, promotable to hard on deviation stats.

Verified by: full test suite + new edge/dispatcher/handler tests green, RBAC coverage check green, Manual E2E section executed against a local swarm.

## What We're NOT Doing

- **Layer 4 (swarm-pack manifest/installer)** — untouched.
- **Airbag riding the edges** — guard-handler result type is designed to fit Airbag's contract (subject, action, resource, allow/deny + reason), but no Airbag integration; decision gated on the next Airbag increment.
- **Declarative rule sugar** — rules are scripts only; any declarative layer later compiles to scripts.
- **Warm sandbox pool** — matcher-gating only; warm pool deferred until stats prove need.
- **Ingestion-time intent stamping / classify caching** — `ctx.classify()` runs inline under budget; stamping is a later optimization, not a contract change.
- **Migrating all built-in routing policies to default handlers** — end state committed, but v1 converts only the continuity pin (Daniel's failure fix); poll-waterfall/affinity/fallback conversion is edge-by-edge follow-up work.
- **Removing env knobs** — default handlers read existing knobs as initial config; knobs deprecated in docs only.
- **Rule-builder UI** — authoring is agent-assisted (conversational via Lead + routing-rules skill over the scripts SDK); the UI is a read view (graph + trace + stats).
- **Editable graph** — lifecycle graph is read-only in v1 (same posture as `WorkflowGraph`).

## Implementation Approach

- **Re-land, don't rewrite, Layer 1**: #980's L1 components are cleanly liftable; Phase 1 cherry-picks/re-lands them on a fresh branch with migration renumbering and review — the payload-filter language already exists on main (`wait-filter.ts`).
- **Handler registration is a new table referencing catalog scripts by name** (like `script_tools`), not a new column on `scripts` — scripts stay generic; edge binding, flavor (`route`/`guard`), soft/hard, priority, and matcher filter live on the registration row.
- **The hook engine is one server-side module** (`src/routing/` or `src/edges/`) called from the five assignment choke points; it owns matcher-gating, ordering, resolution, timeouts, failure semantics, and trace recording. Sites pass a site-specific ctx fragment; the engine builds the full `RoutingCtx` and applies decisive results back through site-provided applicators.
- **Sequencing: spine first, vias incrementally** — engine + `creation`/`delegation` vias (Daniel's cases) before `claim`/`resume`/`completion`; observability lands with the engine (trace is not a bolt-on); UI last.
- **Prompt injection flows through the template registry** using the `getBasePrompt()` conditional-append precedent; `ctx.classify()` wraps the existing `completeStructured()` helper.
- **Trace storage**: dedicated `routing_trace` rows keyed by taskId (queryable per task, feeds stats), with `routing.*` events additionally emitted on the bus for subscriptions.

## Quick Verification Reference

- `bun run tsc:check`
- `bun run lint`
- `bun test`
- `bash scripts/check-db-boundary.sh`
- `bun run check:rbac-coverage`

---

## Phase 1: Re-land Layer 1 — event bus tap, subscriptions, dispatcher

### Overview

The durable event spine exists on main: `swarm_events` journal + `subscriptions` + `subscription_deliveries` tables, `onAny` bus tap, outbox dispatcher, subscription MCP tools, RBAC verbs, and `runGlobalScriptByName`. This is a reviewed re-land of #980's Layer 1 (NOT Layer 3 — `script_tools`/`tool.publish`/dynamic registration stay out).

### Changes Required:

#### 1. Migration
**File**: `src/be/migrations/117_swarm_events_subscriptions.sql` (117/118 currently free after 116; **re-check numbering at implementation time**)
**Changes**: Lift from `git show spike/extension-system:src/be/migrations/117_swarm_events_subscriptions.sql` — `swarm_events`, `subscriptions`, `subscription_deliveries` (UNIQUE(subscriptionId,eventId) dedupe). Drop the `script_tools` parts (they were migration 118 on the branch — excluded). Test against fresh AND existing DB.

#### 2. Bus + capture + delivery
**Files**: `src/workflows/event-bus.ts` (add `onAny`/`offAny`, per-handler try/catch in `emit`), `src/subscriptions/matcher.ts` (glob matcher, new), `src/subscriptions/dispatcher.ts` (capture + 2s poller + atomic claim + MAX_ATTEMPTS=3 + pruning, new), `src/be/subscriptions-db.ts` (new)
**Changes**: Lift from branch. Payload filter imports `matchesFilter` from `src/workflows/wait-filter.ts` (already on main). Keep the single-process claim comment.

#### 3. Emitters
**Files**: `src/linear/webhook.ts`, `src/jira/webhook.ts`
**Changes**: Lift the one-line `workflowEventBus.emit()` additions (`linear.<type>.<action>`, `jira.<event>`). Verify at implementation which `task.*` events main already emits on the bus; if `task.created` is not emitted, add it at `createTaskExtended` success (needed later for reactive routing; small, safe emit).

#### 4. MCP tools + RBAC + SDK
**Files**: `src/tools/subscriptions/{create,list,patch,delete}-subscription.ts` + `index.ts` (new), `src/server.ts` (register), `src/rbac/permissions.ts` (+`subscription.write`, `subscription.mutate.any` — NOT `tool.publish`), `src/rbac/legacy-policy.ts` (anyAuthenticated / leadOrResourceOwner), `src/scripts-runtime/sdk-allowlist.ts` (+`subscription_*`), `src/be/scripts/typecheck.ts` (SwarmSdk methods), regenerate `swarm-sdk.d.ts` via `bun run scripts/bundle-script-types.ts`
**Changes**: Lift, keeping the create-vs-mutate ownership split from the branch's final fix commit.

#### 5. Server-side script runner + boot wiring + housekeeping
**Files**: `src/be/scripts/run-global.ts` (new — `runGlobalScriptByName`), `src/http/index.ts` (start dispatcher, `SUBSCRIPTIONS_DISABLE`/`SUBSCRIPTIONS_INTERVAL_MS`), `.non-audit-tables` (+`subscription_deliveries`, `swarm_events`), `scripts/check-rbac-coverage.ts` allowlist (list-subscriptions), `src/tests/tool-annotations.test.ts` count bump, `runbooks/workflows.md` (emitter-list factual fix + subscriptions section), `src/tests/subscriptions.test.ts` (lift 327-line test file)

### Success Criteria:

#### Automated Verification:
- [ ] Subscription tests pass: `bun test src/tests/subscriptions.test.ts`
- [ ] Full suite green: `bun test`
- [ ] Types + lint: `bun run tsc:check && bun run lint`
- [ ] Boundaries: `bash scripts/check-db-boundary.sh && bun run check:dep-graph`
- [ ] RBAC coverage: `bun run check:rbac-coverage`
- [ ] SDK registration: `bun run scripts/check-sdk-tool-registration.ts`
- [ ] Fresh-DB migration boots: `rm -f /tmp/routing-e2e.sqlite && DB_PATH=/tmp/routing-e2e.sqlite bun run start:http` (starts clean, then Ctrl-C)

#### Automated QA:
- [ ] Via MCP curl handshake (LOCAL_TESTING.md sequence): `create-subscription` binding `task.*` → a scratch global script; create a task via `send-task`; verify a `subscription_deliveries` row reaches `succeeded` and `list-subscriptions` with `includeDeliveries` shows it.

#### Manual Verification:
- [ ] Review the re-landed diff vs `git diff main...spike/extension-system` — confirm nothing Layer-3 leaked in.

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 1] re-land Layer 1 event bus + subscriptions`.

---

## Phase 2: Handler registration substrate

### Overview

An `edge_handlers` table + REST/scripts-SDK CRUD + `routing.write` RBAC verb + a seeded authoring skill exist: a catalog script can be registered as a handler on a named edge with flavor (`route`/`guard`), mode (`soft`/`hard`), priority, and a declarative matcher filter. No new MCP tools (SDK-only, per review). No engine yet — registration CRUD only.

### Changes Required:

#### 1. Migration + DB layer
**File**: `src/be/migrations/118_edge_handlers.sql` (new), `src/be/edge-handlers-db.ts` (new)
**Changes**: `edge_handlers(id, name UNIQUE, edge TEXT CHECK IN('task.before_assign','prompt.compose'), scriptName, description, flavor TEXT CHECK IN('route','guard'), mode TEXT CHECK IN('soft','hard'), priority INTEGER NOT NULL DEFAULT 100, matcher TEXT /*JSON: {via?, source?, slackChannelId?, vcsRepo?, agentId?, taskType?, filter?}*/, timeoutMs INTEGER, enabled INTEGER DEFAULT 1, createdByAgentId, created_by, updated_by, createdAt, updatedAt)`. CRUD + `listEnabledHandlersForEdge(edge)`. Zod schemas in `src/types.ts`.

#### 2. REST routes + scripts-SDK surface + RBAC (NO new MCP tools — decided in review)
**Files**: `src/http/routing.ts` (new: `POST/GET/PATCH/DELETE /api/routing/handlers[/:id]` via `route()`, non-GET with `rbac: {permission: ...}`), `src/http/all-routes.ts`, `src/rbac/permissions.ts` (+`routing.write` leadOnly, `routing.mutate.any` leadOrResourceOwner — mirrors subscription split but stricter on create), `src/rbac/legacy-policy.ts`, `src/tests/rbac-engine.test.ts` fixtures, `src/scripts-runtime/swarm-sdk.ts` (`bridgeRequestFor` shortcuts), `src/be/scripts/typecheck.ts` (SDK methods `swarm.routing_handler_register/list/patch/delete` in `SCRIPT_SDK_TYPES`), regenerate d.ts
**Changes**: Handler CRUD is **SDK-only for agents** — no `create-edge-handler`-style MCP tools; the Lead authors and registers rules by writing/running scripts. REST create validates: edge name known, global script exists (`getScript`), flavor/mode/priority sane, matcher shape valid (via ∈ the five values; `filter` validated with the `wait-filter.ts` string-form validator). `bun run docs:openapi` + commit.

#### 3. Default authoring skill + template prompting
**Files**: `plugin/commands/routing-rules.md` (new; regenerate via `bun run build:pi-skills`), new registered prompt template (e.g. `system.agent.routing_authoring`, appended for Leads in `getBasePrompt()` when routing is enabled)
**Changes**: a seeded "routing-rules" skill + Lead prompt section teaching the flow: write routing script (typed `RoutingCtx`/`RoutingResult`) → `script_upsert` → register via `swarm.routing_handler_register` (inline `script_run`) → `swarm.routing_dry_run` readback → report plain-language summary to the human. This replaces MCP-tool discoverability as the authoring UX.

### Success Criteria:

#### Automated Verification:
- [ ] New tests pass: `bun test src/tests/edge-handlers.test.ts` (CRUD, validation rejections, RBAC create-vs-mutate)
- [ ] `bun test && bun run tsc:check && bun run lint`
- [ ] `bun run check:rbac-coverage && bun run scripts/check-sdk-tool-registration.ts`
- [ ] OpenAPI fresh: `bun run docs:openapi && git diff --exit-code openapi.json`

#### Automated QA:
- [ ] REST: `POST /api/routing/handlers` referencing a real global script on `task.before_assign` with matcher `{via:"delegation"}` succeeds (curl + Bearer 123123); nonexistent script and bad edge name rejected with clear errors; `GET /api/routing/handlers` returns the row.
- [ ] SDK: an inline `script_run` calling `swarm.routing_handler_list()` returns the registered handler (proves the bridge shortcut + typing).

#### Manual Verification:
- [ ] Table/field naming review — this is the long-lived public registration surface.

**Implementation Note**: Pause + commit `[phase 2] edge_handlers registration substrate`.

---

## Phase 3: Typed contract — RoutingCtx, RoutingResult, classify()

### Overview

The handler authoring contract exists and is tsc-enforced: routing scripts receive a typed `RoutingCtx` as args and return a typed `RoutingResult`; `classify()` is available to scripts as an SDK method backed by a new server endpoint wrapping `completeStructured()`.

### Changes Required:

#### 1. Contract types + ctx builder
**Files**: `src/routing/types.ts` (new), `src/routing/ctx.ts` (new)
**Changes**:
- `RoutingCtx`: `{ via, task: {id?, description, source, taskType, tags, parentTaskId, modelTier, priority, routingAffinity, slackChannelId, slackThreadTs, vcsProvider, vcsRepo, contextKey}, proposedAgentId, candidates: [{id, name, role, capabilities, status, isLead, activeTaskCount, maxTasks}], continuity: {parent: {id, agentId, agentRole, description, status} | null, chainDepth} }`.
- `RoutingResult` (Zod): `{ assignTo?: string, block?: {reason: string}, mutate?: {tags?, routingAffinity?, modelTier?, priority?}, promptDirectives?: string[], note?: string }` — empty object = continue. Decisive = `assignTo` or `block`.
- `buildRoutingCtx(via, effectiveOptions | taskRow, candidates)` — server-side; candidates from registered agents + live in-progress counts; continuity from `getTaskById(parentTaskId)`.
- **Refactor**: extract `createTaskExtended`'s parent-inheritance block (`src/be/db.ts:3892-4029`) into `resolveEffectiveTaskOptions(options)` so the ctx can be built from settled options *before* any transaction (the engine cannot run inside sync SQLite transactions).

#### 2. classify endpoint + SDK
**Files**: `src/http/classify.ts` (new route via `route()` factory, `POST /api/internal-ai/classify`, `rbac: {permission: "script.search"}`-tier or new ungated-with-reason — decide at impl; agent-authenticated), `src/http/all-routes.ts` (import), `src/utils/internal-ai/` (thin `classify(input, labels/schema)` wrapper over `completeStructured`), `src/scripts-runtime/sdk-allowlist.ts` or `bridgeRequestFor` shortcut, `src/be/scripts/typecheck.ts` (`swarm.classify()` + `RoutingCtx`/`RoutingResult` type declarations in `SCRIPT_SDK_TYPES`), regenerate d.ts
**Changes**: 3s default timeout on the endpoint (routing budget); returns `null` on timeout/failure (callers fail open). `bun run docs:openapi` + commit `openapi.json`.

### Success Criteria:

#### Automated Verification:
- [ ] `bun test src/tests/routing-ctx.test.ts` (ctx builder: envelope fields, candidates+load, continuity; `resolveEffectiveTaskOptions` parity with previous inheritance behavior)
- [ ] `bun test && bun run tsc:check && bun run lint && bash scripts/check-db-boundary.sh`
- [ ] OpenAPI fresh: `bun run docs:openapi && git diff --exit-code openapi.json`
- [ ] A fixture routing script using `RoutingCtx`/`RoutingResult` types passes `script_upsert` typecheck; one with a wrong result shape is rejected (test asserts both)

#### Automated QA:
- [ ] `curl -s -X POST http://localhost:3013/api/internal-ai/classify -H "Authorization: Bearer 123123" ...` returns a schema-valid classification for a sample task description (requires a configured internal-AI credential; skip gracefully if absent and note it).

#### Manual Verification:
- [ ] Review `RoutingCtx`/`RoutingResult` shapes — public authoring contract; matches the guard/Airbag forward-compat intent (block carries reason; subject/action/resource derivable).

**Implementation Note**: Pause + commit `[phase 3] routing contract types + classify`.

---

## Phase 4: Hook engine + `creation` and `delegation` vias

### Overview

`src/routing/engine.ts` runs registered handlers for `task.before_assign` with matcher-gating, guards-before-routes priority ordering, first-decisive resolution, per-flavor failure semantics, and full trace recording — wired at the creation and delegation sites (Daniel's failure paths).

### Changes Required:

#### 1. Engine + trace
**Files**: `src/routing/engine.ts` (new), `src/be/migrations/119_routing_trace.sql` (new), `src/be/routing-trace-db.ts` (new)

Migration 119 (exact shape):

```sql
CREATE TABLE routing_trace (
  id          TEXT PRIMARY KEY,
  routingRunId TEXT NOT NULL,             -- groups one engine invocation's chain
  taskId      TEXT,                       -- backfilled post-INSERT for via=creation
  edge        TEXT NOT NULL CHECK (edge IN ('task.before_assign','prompt.compose')),
  via         TEXT NOT NULL CHECK (via IN ('creation','delegation','claim','resume','completion','prompt')),
  handlerId   TEXT NOT NULL,
  handlerName TEXT NOT NULL,
  flavor      TEXT NOT NULL CHECK (flavor IN ('route','guard')),
  mode        TEXT NOT NULL CHECK (mode IN ('soft','hard')),
  matched     INTEGER NOT NULL DEFAULT 1, -- declarative filter hit (unmatched handlers get no row)
  resultJson  TEXT,                       -- validated RoutingResult as returned
  decisive    INTEGER NOT NULL DEFAULT 0, -- this handler's assignTo/block ended the chain (hard only)
  suggestion  TEXT,                       -- soft-mode would-be assignTo
  deviated    INTEGER,                    -- set later on delegation when Lead ignored suggestion
  dryRun      INTEGER NOT NULL DEFAULT 0,
  error       TEXT,                       -- handler error/timeout (fail-open/closed per flavor)
  durationMs  INTEGER,
  createdAt   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_routing_trace_task ON routing_trace(taskId);
CREATE INDEX idx_routing_trace_handler ON routing_trace(handlerName, createdAt);
CREATE INDEX idx_routing_trace_run ON routing_trace(routingRunId);
```

Engine flow sketch:

```ts
// src/routing/engine.ts
export async function runBeforeAssign(ctx: RoutingCtx): Promise<RoutingDecision> {
  const handlers = listEnabledHandlersForEdge("task.before_assign")
    .filter((h) => matchesDeclarativeFilter(h.matcher, ctx))   // via/source/channel/... + matchesFilter — no spawn
    .sort(byGuardsFirstThenPriority);

  const decision: RoutingDecision = { mutations: [], promptDirectives: [], suggestions: [], trace: [] };
  for (const h of handlers) {
    const t0 = performance.now();
    try {
      const raw = await runGlobalScriptByName({
        scriptName: h.scriptName, args: ctx, agentId: SYSTEM_AGENT_ID,
        timeoutMs: h.timeoutMs ?? 5_000,
      });
      const result = RoutingResultSchema.parse(raw.result ?? {});
      composeInto(decision, h, result);                        // mutate/promptDirectives always compose
      if (isDecisive(result)) {                                // assignTo | block
        if (h.mode === "hard") { decision.final = result; recordTrace(...); break; }
        decision.suggestions.push({ handler: h.name, assignTo: result.assignTo }); // soft → suggestion only
      }
      recordTrace(decision, h, result, performance.now() - t0);
    } catch (err) {
      emitRoutingEvent("routing.handler_failed", { handler: h.name, err });
      if (h.flavor === "guard") { decision.final = { block: { reason: `guard ${h.name} failed` } }; break; } // fail closed
      recordTrace(decision, h, null, performance.now() - t0, err);                  // route: fail open, continue
    }
  }
  return decision;
}
```

Example handler script (what an author writes — full typed surface in Phase 3):

```ts
import type { RoutingCtx, RoutingResult } from "swarm-sdk";

export default async function route(ctx: RoutingCtx): Promise<RoutingResult> {
  if (ctx.task.slackChannelId === "C0GTMCHANNEL") {
    const gtm = ctx.candidates.find((a) => a.role === "gtm");
    if (gtm) return { assignTo: gtm.id, promptDirectives: ["Non-technical audience — GTM voice"] };
  }
  return {}; // continue
}
```

**Changes**:
- `runBeforeAssign(ctx: RoutingCtx): Promise<RoutingDecision>` — load enabled handlers for edge; cheap declarative matcher first (via/source/channel/repo/taskType + `matchesFilter` payload filter) so zero-match tasks spawn zero sandboxes; order: guards (priority asc) then routes (priority asc); execute via `runGlobalScriptByName` with per-handler `timeoutMs` (default 5000); parse/validate result with `RoutingResultSchema`; compose `mutate`/`promptDirectives` across handlers in order; first `assignTo`/`block` stops the chain. `route` flavor error/timeout/garbage → skip + `routing.handler_failed` (fail open); `guard` flavor error → decision `block` (fail closed). **Soft-mode handlers never produce decisive application** — their `assignTo` is recorded as a *suggestion* (consumed in Phase 6).
- `routing_trace(id, taskId, edge, via, handlerId, handlerName, mode, flavor, matched, resultJson, decisive, suggestion, error, durationMs, createdAt)` — one row per matched handler + written before the task INSERT completes (taskId backfilled for creation via post-insert or trace keyed by a routingRunId stamped on the task).
- Events: `createEvent` (telemetry) + `workflowEventBus.emit` for `routing.matched`, `routing.applied`, `routing.blocked`, `routing.handler_failed`.

#### 2. Creation via
**Files**: `src/be/db.ts` / new wrapper `src/tasks/create-task-routed.ts`
**Changes**: async wrapper `createTaskRouted(description, options)`: `resolveEffectiveTaskOptions` → `buildRoutingCtx("creation", ...)` → engine → apply (hard `assignTo` overrides `options.agentId`; `mutate` merged; `block` → create reroute-decision task via the `createRerouteDecisionTask` pattern instead of the original) → `createTaskExtended`. Migrate creation ingresses that need routing (Slack handlers first — the pilot path; others mechanically). `createTaskExtended` itself stays sync and unhooked; callers not yet migrated keep exact current behavior.

#### 3. Delegation via
**File**: `src/tools/send-task.ts`
**Changes**: after `effectiveAgentId` resolution (line ~322), run engine with `via: "delegation"` (parent + candidates in ctx); apply hard results; `block` → reroute-decision + informative tool response to the Lead; stamp options so the downstream create does not double-fire creation via.

### Success Criteria:

#### Automated Verification:
- [ ] `bun test src/tests/routing-engine.test.ts` — matcher gating (zero-spawn on no match), guard-before-route ordering, first-decisive, compose semantics, route fail-open, guard fail-closed, timeout path, trace rows written
- [ ] `bun test src/tests/routing-vias.test.ts` — creation hard-assign via Slack-shaped options; delegation continuity + hard override; block → reroute-decision task
- [ ] `bun test && bun run tsc:check && bun run lint && bash scripts/check-db-boundary.sh && bun run check:rbac-coverage`

#### Automated QA:
- [ ] Local server, fresh DB: register a hard handler `{via:"creation", slackChannelId:"C0AR967K0KZ"}` → script returns `{assignTo: <worker-id>}`; create a task with that channel via `send-task`; `GET /api/agents`/task shows assignment to the worker, `routing_trace` row `decisive=1`, `routing.applied` event exists.

#### Manual Verification:
- [ ] Latency sanity on the creation path with one matching handler (~180ms spawn + script) — acceptable for Slack ingestion.

**Implementation Note**: Pause + commit `[phase 4] before_assign engine + creation/delegation vias`.

---

## Phase 5: Remaining vias — claim, resume, completion

### Overview

`task.before_assign` fires at the three remaining assignment sites; every place an assignee is written is now hook-covered.

### Changes Required:

> **Process boundary (applies to every via)**: the engine runs **exclusively in the API node**. All five wiring sites are API-process code (`src/http/poll.ts`, `src/tools/task-action.ts` handlers execute server-side, `src/heartbeat/*`, `src/tasks/worker-follow-up.ts`, `src/be/db.ts`) — workers never invoke the engine, never import it, and only observe outcomes over HTTP. `bash scripts/check-db-boundary.sh` enforces this since `src/routing/` will import `src/be/*`.

#### 1. Claim via
**Files**: `src/http/poll.ts` (branch 5), `src/tools/task-action.ts` (claim case), `src/heartbeat/heartbeat.ts` (`autoAssignPoolTasks`)
**Changes**: engine runs **before** entering the claim transaction on the candidate task (`via:"claim"`, proposedAgentId = polling agent); `assignTo` other-agent result → skip candidate (leave pooled for the designated agent's eligibility path) or block → reroute-decision; the atomic `claimTask` UPDATE re-check keeps races safe. Same pre-pass for `assignUnassignedTaskPending`.

#### 2. Resume via
**Files**: `src/tasks/worker-follow-up.ts` (`createResumeFollowUp` after pin decision ~line 312), `src/heartbeat/heartbeat.ts` (reboot sweep ~line 604)
**Changes**: engine with `via:"resume"`, proposedAgentId = pin candidate; switch both sites to `createTaskRouted`.

#### 3. Completion via
**File**: `src/tasks/worker-follow-up.ts` (`createWorkerTaskFollowUp` before line 188)
**Changes**: engine with `via:"completion"`, candidates `[lead]` + registered agents; hard `assignTo` redirects the follow-up (e.g. GTM reviewer instead of Lead).

### Success Criteria:

#### Automated Verification:
- [ ] `bun test src/tests/routing-vias.test.ts` extended: claim skip/redirect, resume pin override, completion redirect
- [ ] Heartbeat suite still green: `bun test src/tests/heartbeat*.test.ts`
- [ ] `bun test && bun run tsc:check && bun run lint`

#### Automated QA:
- [ ] Fresh-DB scenario: handler `{via:"completion", filter: tags contains "gtm"}` → `{assignTo: <reviewer-id>}`; run a task to completion (scripted via task-action); follow-up task lands on reviewer, trace + events recorded.

#### Manual Verification:
- [ ] `runbooks/heartbeat-crash-recovery.md` updated in this phase (same-PR rule) — diagrams/pseudocode reflect the hook points.

**Implementation Note**: Pause + commit `[phase 5] claim/resume/completion vias`.

---

## Phase 6: `prompt.compose` edge — soft directives to the Lead + deviation detection

### Overview

Soft rules become real: suggestions and `promptDirectives` from soft handlers are stored on the task, injected into the Lead's prompt through the template registry, and Lead deviation from suggestions is detected and emitted.

### Changes Required:

#### 1. Directive storage + injection
**Files**: `src/be/migrations/120_task_routing_directives.sql` (nullable `routingDirectives` JSON column on `agent_tasks`), `src/prompts/session-templates.ts` or new `src/prompts/routing-templates.ts` (register `system.task.routing_directives` with `{{directives}}`/`{{suggestion}}` vars), the Lead task-prompt composition site (follow `getBasePrompt()` conditional-append precedent)
**Changes**: engine (Phase 4) writes soft suggestions + composed `promptDirectives` to the column; when the Lead receives the task, the template resolves with those vars and appends — no string concat outside the registry. `prompt.compose`-registered handlers (same `edge_handlers` table) run at this composition point and may add directives (route flavor only, fail-open, same trace).

#### 2. Deviation detection
**Files**: `src/routing/engine.ts`, `src/tools/send-task.ts`
**Changes**: on delegation via, if parent task carried a soft suggestion and the Lead's chosen agent differs → emit `routing.lead_deviated` (bus + events) + trace row flag.

### Success Criteria:

#### Automated Verification:
- [ ] `bun test src/tests/routing-prompt-compose.test.ts` — directive storage, template resolution (agent/repo/global precedence respected), deviation event on mismatch, no event on match
- [ ] `bun test && bun run tsc:check && bun run lint`
- [ ] Migration boots on fresh DB: `rm -f /tmp/routing-e2e.sqlite && DB_PATH=/tmp/routing-e2e.sqlite bun run start:http` — and on the existing dev DB: `bun run start:http` (column added, data retained)

#### Automated QA:
- [ ] Fresh-DB: soft handler suggests agent A with a "non-technical audience" directive; inspect the Lead's composed prompt (session log / prompt render endpoint) contains the directive block; delegate to agent B via send-task → `routing.lead_deviated` event exists.

#### Manual Verification:
- [ ] Read the rendered Lead prompt — directive block reads naturally, doesn't fight the session template.

**Implementation Note**: Pause + commit `[phase 6] prompt.compose + soft directives + deviation`.

---

## Phase 7: Continuity-pin default handler, dry-run, stats

### Overview

The first built-in becomes a visible handler: a pre-installed `default-continuity-pin` routing script replaces the blind `parentTaskId` pin with an intent-aware version (Daniel's fix). Authors get `routing-dry-run` and per-handler stats.

### Changes Required:

#### 1. Default handler (seed)
**Files**: seed mechanism per `runbooks/seed-scripts.md` (new seed script `default-continuity-pin`), `src/tools/send-task.ts`
**Changes**: seeded global script registered on `task.before_assign` `{via:"delegation"}`, mode `soft`, low priority; behavior: if parent worker exists and intent matches worker role (via `swarm.classify()` with 3s budget; on null → preserve pin = today's behavior), suggest pin; on intent mismatch, suggest pool + directive explaining why. The hardcoded pin at `send-task.ts:316-322` remains as final fallback when no handler decided (zero behavior change if handler disabled/erroring).

#### 2. Dry-run
**Files**: `src/http/routing.ts` (`POST /api/routing/dry-run` via `route()`, `rbac: {permission: "routing.write"}`), SDK method `swarm.routing_dry_run` (bridge shortcut + `SCRIPT_SDK_TYPES` — no MCP tool, per the Phase 2 decision)
**Changes**: accepts a synthetic task envelope (or `taskId` to replay) + edge; runs the engine with application disabled (e2b `dryRun` pattern: return would-be decisions); returns full chain (matched handlers, results, would-be decisive). `bun run docs:openapi`.

#### 3. Stats
**Files**: `src/http/routing.ts` (`GET /api/routing/handlers`, `GET /api/routing/stats`), `src/be/routing-trace-db.ts` (aggregation: hits, decisive, errors, deviations per handler, windowed)
**Changes**: REST for UI + `swarm.routing_handler_list()` SDK output enriched with stats. GET routes need no rbac declaration.

### Success Criteria:

#### Automated Verification:
- [ ] `bun test src/tests/routing-dryrun-stats.test.ts` — dry-run applies nothing (no task/trace mutation beyond flagged rows), stats aggregation correctness, continuity handler suggest-pin/suggest-pool branches (classify mocked)
- [ ] `bun test && bun run tsc:check && bun run lint && bun run check:rbac-coverage`
- [ ] `bun run docs:openapi && git diff --exit-code openapi.json`

#### Automated QA:
- [ ] `curl -s -X POST http://localhost:3013/api/routing/dry-run -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d '{"edge":"task.before_assign","envelope":{"via":"creation","task":{"description":"test","source":"slack","slackChannelId":"C0AR967K0KZ"}}}' | jq` returns the chain with would-be decision; `GET /api/routing/stats | jq` shows hit counts after Phase 4/5 QA runs.

#### Manual Verification:
- [ ] Reproduce Daniel's scenario locally: research-parent task → follow-up with different intent (Notion-write-shaped) → default handler suggests breaking continuity; confirm the suggestion text is actionable for a Lead.

**Implementation Note**: Pause + commit `[phase 7] continuity default handler + dry-run + stats`.

---

## Phase 8: UI — routing trace on task detail

### Overview

The task detail page answers "why did this task land here?": a routing section/tab renders the per-task trace chain, soft suggestions, deviations, and errors.

Visual sketch (desktop center-column section; mobile = same content under a `routing` tab):

```
┌─ Routing ────────────────────────────────────────────── [collapse] ─┐
│ via: creation → delegation          edge: task.before_assign        │
│                                                                     │
│  ●  guard  budget-guard          matched   continue         12ms    │
│  ●  route  gtm-channel-rule      matched   SOFT suggest →   204ms   │
│  │         GTM Agent  +1 directive ("Non-technical audience…")      │
│  ●  route  default-continuity-pin matched  continue         180ms   │
│  ◐  route  notion-tier-rule      no match  (filter: via=delegation) │
│                                                                     │
│  ⚠ Lead deviated: suggested GTM Agent → delegated to Coder          │
│     routing.lead_deviated · 2026-07-21 14:32                        │
│                                                                     │
│  Final: assigned to Coder (Lead decision) · [Dry-run replay]        │
└─────────────────────────────────────────────────────────────────────┘
```

Row anatomy: status dot (decisive=filled/error=red/no-match=hollow) · flavor+mode badges · handler name (links to script) · result summary · duration. Follows `LogTimeline`'s dotted-rail visual language.

### Changes Required:

#### 1. API client + hook
**Files**: `apps/ui/src/api/client.ts` (`fetchTaskRouting(taskId)` → `GET /api/tasks/{id}/routing-trace` — add this route server-side in `src/http/routing.ts`), `apps/ui/src/api/types.ts`, `apps/ui/src/api/hooks/use-tasks.ts` (`useTaskRouting`, mirror `useTaskContext` at `use-tasks.ts:72-79`)

#### 2. Trace section
**File**: `apps/ui/src/pages/tasks/[id]/page.tsx`
**Changes**: add `routing` to `TASK_DETAIL_TABS` (line 91) + mobile `TabsTrigger`/`TabsContent`; desktop: collapsible section in the center column (follow `CollapsibleSection` precedent, line 819-832). Chain rendering follows `LogTimeline` visual language (line 162-187): per-handler row (name, flavor/mode badges, matched, result summary, duration), decisive row highlighted, `lead_deviated` badge, handler errors surfaced. Semantic tokens only (`bun run check:tokens`).

### Success Criteria:

#### Automated Verification:
- [ ] `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`
- [ ] Server route in openapi: `bun run docs:openapi && git diff --exit-code openapi.json`

#### Automated QA:
- [ ] agent-browser session against local UI (`bun run pm2-start`, UI :5274): open a task routed in Phase 4/5 QA, screenshot the routing section showing the chain + decisive highlight; open an un-routed task, section shows a sane empty state.

#### Manual Verification:
- [ ] Taras visual pass on the trace section (desktop + mobile tab).

**Implementation Note**: Pause + commit `[phase 8] task routing trace UI`.

---

## Phase 9: UI — task-lifecycle graph page

### Overview

A read-only `/routing` page renders the task lifecycle as a React-Flow graph — ingestion → creation → lead → delegation/pool → claim → worker → completion → follow-up — with each hookable edge showing its registered handlers and stats; clicking an edge opens a handler panel.

### Changes Required:

#### 1. Page + graph
**Files**: `apps/ui/src/pages/routing/page.tsx` (new), `apps/ui/src/components/routing/lifecycle-graph.tsx` (new), `apps/ui/src/app/router.tsx` (lazy route), `apps/ui/src/components/layout/app-sidebar.tsx` (NavItem in SWARM group, `gate: {minVersion}` at the release version)
**Changes**: static lifecycle definition (nodes = stages, edges = the five vias + prompt.compose + task.created) rendered with `@xyflow/react` reusing `WorkflowNodeShell` + the `graph-utils.ts` layout approach (read-only flags like `WorkflowGraph`). Edge badges: handler count + error indicator from `GET /api/routing/handlers` + `/stats` (`useRoutingHandlers`/`useRoutingStats` hooks, new `use-routing.ts`).

#### 2. Edge panel
**File**: `apps/ui/src/components/routing/edge-panel.tsx` (new)
**Changes**: side panel on edge click: handlers in priority order (flavor/mode/matcher summary, enabled state, hit/decisive/deviation/error stats), link to the backing script page. `DataGrid` for the handler list per repo rule.

### Success Criteria:

#### Automated Verification:
- [ ] `cd apps/ui && bun run lint && bunx tsc -b`
- [ ] `bun run check:tokens` (if separate from lint)

#### Automated QA:
- [ ] agent-browser: load `/routing` with the Phase 4-7 handlers registered — screenshot graph with edge badges; click `task.before_assign` edge → panel lists handlers with stats; empty-state screenshot with no handlers (fresh DB).

#### Manual Verification:
- [ ] Taras visual pass: graph legibility (this page is the product surface for "routing policy becomes legible") — layout, edge labels, non-tech readability.

**Implementation Note**: Pause + commit `[phase 9] lifecycle graph UI`. Frontend merge-gate note: repo rule requires a qa-use session with screenshots for `apps/ui/` PRs — produce it here (or per Taras's standing preference, agent-browser screenshots + his manual QA; confirm at implementation).

---

## Manual E2E — Catches pilot ("#gtm → GTM agent")

Run against a local swarm (fresh DB). Commands follow LOCAL_TESTING.md recipes; MCP tool calls use the handshake sequence (LOCAL_TESTING.md § MCP curl):

```bash
# 0. Fresh server
rm -f agent-swarm-db.sqlite && bun run start:http   # or bun run pm2-start for UI too

# 1. Agents present (lead + one worker acting as "GTM agent")
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/agents \
  | jq '.agents[] | {id, name, isLead, status}'
# note the GTM worker's <GTM_AGENT_ID>

# 2. Author the routing script (as the Lead would, via script upsert).
#    Write real source to a file, then JSON-encode it with jq — no inline escaping.
cat > /tmp/route-gtm-channel.ts <<'EOF'
import type { RoutingCtx, RoutingResult } from "swarm-sdk";

export default async function route(ctx: RoutingCtx): Promise<RoutingResult> {
  if (ctx.task.slackChannelId === "GTM_CHANNEL_ID") {   // replace before running
    return {
      assignTo: "GTM_AGENT_ID",                          // replace before running
      promptDirectives: ["Non-technical audience — GTM voice"],
    };
  }
  return {};
}
EOF
curl -s -X POST http://localhost:3013/api/scripts/upsert \
  -H "Authorization: Bearer 123123" -H "X-Agent-ID: <LEAD_UUID>" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile src /tmp/route-gtm-channel.ts \
        '{name:"route-gtm-channel", scope:"global", source:$src}')"

# 3. Register it SOFT on the edge (REST; the Lead would do this via swarm.routing_handler_register)
curl -s -X POST http://localhost:3013/api/routing/handlers \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"name":"gtm-channel-rule","edge":"task.before_assign","scriptName":"route-gtm-channel",
       "flavor":"route","mode":"soft","priority":50,"matcher":{"via":"creation","source":"slack"}}'

# 4. Dry-run readback
curl -s -X POST http://localhost:3013/api/routing/dry-run \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"edge":"task.before_assign","envelope":{"via":"creation","task":{"description":"draft launch email","source":"slack","slackChannelId":"<GTM_CHANNEL_ID>"}}}' | jq
# EXPECT: chain shows gtm-channel-rule matched, would-suggest GTM agent (soft)

# 5. Soft path: send a GTM-channel task; Lead still routes, prompt carries suggestion+directive
#    (send-task via MCP with slackChannelId=<GTM_CHANNEL_ID>) → task detail UI: routing section
#    shows suggestion; if Lead delegates elsewhere → routing.lead_deviated in events:
curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/routing/stats" | jq

# 6. Promote to hard (PATCH /api/routing/handlers/<HANDLER_ID> {"mode":"hard"}), send another GTM-channel task
# EXPECT: task assigned directly to <GTM_AGENT_ID> (no Lead hop), trace decisive=true
curl -s -H "Authorization: Bearer 123123" \
  "http://localhost:3013/api/tasks/<TASK_ID>/routing-trace" | jq

# 7. Daniel's continuity fix: create research task on worker A, complete it, send follow-up
#    with different intent ("write this to Notion") via parentTaskId → default-continuity-pin
#    suggests breaking continuity; verify suggestion in Lead prompt + trace.

# 8. Fail-open check: break the script (upsert a throwing version) → send GTM task
# EXPECT: task routes via default flow, routing.handler_failed event emitted, no availability impact

# 9. UI: open http://localhost:5274/routing — graph shows the rule on task.before_assign
#    with hit stats; task detail shows traces from steps 5-7.
```

Slack-native variant (optional, dev Slack): `slack_send_message(channel_id: "C0AR967K0KZ", message: "<@U0ALZGQCF96> draft launch email")` with a handler matching `slackChannelId:"C0AR967K0KZ"` — verifies the real ingestion path end-to-end.

## Appendix

- **Follow-up plans** (not this plan):
  - Layer 3 re-land (`script_tools` + `tool.publish` + dynamic registration) — small standalone PR, cleanly liftable from #980.
  - Built-ins → default handlers migration, edge by edge (affinity gate, pool fallback, poll-waterfall knobs → handler config).
  - Multi-replica dispatcher lease semantics (single-process claim is a stated v1 limit).
  - Airbag guard verbs / ride-the-edges decision (contract already fits; gated on next Airbag increment).
  - Warm sandbox pool (only if stats show matcher-gating isn't enough).
- **Derail notes**:
  - Scheduler (`src/scheduler/scheduler.ts`) has an older duplicate of the run-global-script pattern — fold onto `runGlobalScriptByName` opportunistically.
  - `RunScriptInput.userConfig` → `ctx.swarm.config` plumbing exists but is unwired at all three call sites — natural vehicle for handler config later.
  - `ExecutorMetaSchema.dryRun` is dead code (engine hardcodes false) — routing dry-run uses the e2b return-would-be-call pattern instead; consider unifying someday.
  - Migration numbers 117-120 assumed free after 116 — re-verify at each phase.
- **References**:
  - Brainstorm: `thoughts/taras/brainstorms/2026-07-21-swarm-extensibility-routing.md`
  - Extension-system research: `thoughts/taras/research/2026-07-18-swarm-extension-system.md`, `2026-07-18-extension-system-spike.md` (on the #980 branch — keep even after PR closes)
  - PR #980 (closed source of salvage): branch `spike/extension-system` @ e1964e4a — do not delete the branch until re-land completes
  - Runbooks: `runbooks/heartbeat-crash-recovery.md` (must be updated in Phase 5), `runbooks/seed-scripts.md`, `runbooks/workflows.md`
