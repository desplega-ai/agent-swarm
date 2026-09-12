---
date: 2026-09-10T17:15:06+02:00
author: Taras
topic: "Swarm extensions"
tags: [brainstorm, extensions, events, runtime, pi]
status: complete
exploration_type: idea
last_updated: 2026-09-12
last_updated_by: Claude
---

# Swarm extensions: Brainstorm

## Context

Taras wants an extension system inspired by [Pi extensions](https://pi.dev/docs/latest/extensions).
Extensions should extend or change swarm behavior without changes to core code for each customization.
The intended outcome is a scope that supports implementation in one session.
This session starts with interactive exploration before implementation.

The three primary questions concern exposed events, the `ctx` contract, and extension storage and loading.
Taras proposes single-file extensions stored in the database.
External packages could follow in version two.
Compatibility with existing Pi extensions is desirable.
Pi uses [jiti](https://github.com/unjs/jiti) to load TypeScript extensions.

### Motivating examples

1. Route Slack messages from channel X directly to agent Y instead of the lead.
2. Enforce communication style through stop hooks or hooks before tool execution.
3. Customize heartbeat heuristics.
4. Rewrite tasks using events or additional data.
5. Suppress features conditionally, including completion tasks for leads.

### Exploration framing

The request clearly describes an idea to develop.
The exploration will resolve scope decisions through one question at a time.
Code and documentation checks will answer factual questions without asking Taras.

## Exploration

### Pending decisions

- [x] Define who can activate extensions and what trust they require.
- [x] Select the required events for version one: 5 pre events, post mirror, no native harness hooks.
- [x] Define context access (typed facade, no DB), mutations (per-event modify payload), and persistent state (ctx.state KV namespace).
- [x] Define storage (dedicated tables), versioning (immutable version rows), and reload (dynamic import on write, load on boot), activation (REST + UI + MCP author-only).
- [x] Define handler ordering (priority chain, first block wins), failures (fail open, auto-disable after 5), and time limits (5 s).
- [x] Define Pi compatibility: swarm-level events for all harnesses, no Pi shim in v1.
- [x] Define external package scope: scripts allowlist (zod, stdlib) via existing shim writer; npm packages in v2.

### Completed evidence checks

- Inspect Pi event semantics, context, loading, and compatibility requirements.
- Inspect swarm routing, task mutations, and completion notifications.
- Inspect harness hooks and distinguish native tools from server-owned MCP tools.
- Inspect heartbeat decisions and reuse opportunities in the scripts runtime.
- Map the existing event bus, mutation boundaries, hot-reload precedent, and stored-code tables.

### Q: Should version one use trusted operator code or isolated code?

Taras selected trusted operator code.
Operators control activation, matching Pi and reducing the first implementation's runtime scope.

**Insights:** Host isolation is not a requirement for version one.
The remaining runtime decisions concern lifecycle, failure handling, and access through the supported API.
This answer does not select a process topology or permit direct database access.

### Verified facts: Pi and loading

Pi accepts a default factory that registers event handlers through its extension API.
Its context includes session state, model access, and UI capabilities.
Its tool events support interception before execution and result changes after execution.
Extensions execute with host permissions.
These facts come from the [Pi extension reference](https://pi.dev/docs/latest/extensions).

Jiti loads TypeScript and ESM modules at runtime.
It does not implement the APIs those modules expect.
Source: [jiti README](https://github.com/unjs/jiti).

The swarm lockfile resolves `@earendil-works/pi-coding-agent` to version `0.85.1`.
That package depends on jiti `2.7.0`.
Current Pi documentation may describe behavior beyond the locked version.
Compatibility requires checking the installed version and selected extension examples.

**Implication:** Loading existing Pi extensions and running them correctly are separate requirements.
Native execution within Pi workers differs from compatibility across other harnesses or within the swarm API server.

### Verified facts: Routing and task events

The [Slack handler](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/src/slack/handlers.ts#L579) resolves routing before task creation.
The [router](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/src/slack/router.ts#L27) supports explicit agents, broadcasts, thread reuse, and a lead fallback.
The channel identifier reaches the router only through optional thread context today.
A channel policy must also receive the channel for initial messages.
Slack assistant messages and buffered replies use additional task creation paths.
Coverage must include those paths if a policy applies to every Slack message.

The [workflow event bus](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/src/workflows/event-bus.ts#L3) exposes notifications without interception results.
The [task completion code](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/src/be/db.ts#L3148) emits its event through `afterCommit`.
An observer cannot use that event to prevent the completed transition.

**Implication:** The contract must distinguish decisions before an action from notifications after an action.
Suppressing a completion task for a lead also differs from suppressing a Slack completion message.
The former is Taras's requested example.

The [completion follow-up function](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/src/tasks/worker-follow-up.ts#L151) creates a task assigned to the lead.
It already skips workflow tasks, tasks with `followUpConfig.disabled`, and completions from a lead.
This function is the relevant decision boundary for conditional suppression.
Its callers execute after the original terminal transition commits.
Asynchronous completion notifications do not guarantee ordering relative to this decision.

Source references describe the local checkout examined on 2026-09-10.
GitHub links pin commit `f305240fecb02e1fc0561210ea43711173d71980`.

### Verified facts: Heartbeat, storage, and context

The [heartbeat sweep](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/src/heartbeat/heartbeat.ts#L296) combines health evaluation and automatic recovery.
No session and stale session conditions trigger recovery.
A fresh session with stale progress becomes a reported stall.
An extension heuristic must specify whether it changes classification, recovery actions, or the checklist given to a lead.

The existing `Heartbeat Audit` script supports the checklist given to a lead.
It does not replace the automatic recovery sweep.
Source: [heartbeat template](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/src/heartbeat/templates.ts#L28).

The [script catalog](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/src/be/scripts/db.ts#L174) stores single-file TypeScript with immutable version history.
The [script executor](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/src/scripts-runtime/executors/native.ts#L152) creates a new process for each invocation.
That process does not preserve registered handlers between events.
Storage reuse and runtime reuse therefore require separate decisions.

The [existing context](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/src/scripts-runtime/ctx.ts#L13) exposes Swarm operations, registered APIs, MCP connections, a standard library, and logging.
These are candidate building blocks for an extension context.
Their presence does not decide which operations an extension should receive before a mutation.

### Verified facts: Harness coverage

The [Pi adapter](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/src/providers/pi-mono-adapter.ts#L1195) already loads a swarm extension through `extensionFactories`.
Pi `0.85.1` declarations and runtime code support mutation of tool inputs before execution.
The existing swarm extension uses blocking without input mutation.
This gives native Pi extensions a concrete integration path.
Arbitrary extension compatibility still depends on available session resources and the worker's execution mode.

Current integrations expose different capabilities:

| Integration | Before native tool execution | Session completion |
| --- | --- | --- |
| Claude Code hooks | Existing hook can block. It does not rewrite inputs. | Existing Stop handler performs cleanup and summaries. |
| Pi extension | Native API can block and rewrite inputs. | Native extension observes session events and can control the session. |
| Codex App Server | Adapter translates tool notifications. | Legacy Stop hook is disabled for App Server sessions. |
| OpenCode plugin | Existing plugin can block by throwing. | Existing plugin observes `session.idle`. |
| ACP and cloud providers | Current adapters lack a universal native tool interception point. | Adapter-specific session completion and message delivery apply. |

These statements describe the current swarm integration, not every capability available from each upstream provider.
Sources: [Claude hook](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/src/hooks/hook.ts#L1310), [Codex hook](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/src/hooks/codex-hook.ts#L118), and [OpenCode plugin](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/plugin/opencode-plugins/agent-swarm.ts#L277).

The [server tool registrar](https://github.com/desplega-ai/agent-swarm/blob/f305240fecb02e1fc0561210ea43711173d71980/src/tools/utils.ts#L743) receives swarm MCP tool calls across harnesses.
That boundary does not receive native shell, edit, or browser calls from each harness.
Communication rules must identify the actual outbound action they need to intercept.

**Implication:** Swarm orchestration events can have a shared contract.
Worker events need explicit coverage requirements and capability reporting.
Observing completion, blocking completion, and requesting another turn are distinct operations.

### Q: What should support for existing Pi extensions mean in v1?

Taras selected a compatibility approach that works for every harness from the start.
He rejected a harness-only framing.
Extensions must operate at the swarm level, on the API server, with harness-specific behavior as a secondary layer.
Version one ships a first set of events and later versions add more.
He named `pre.task.created` as the kind of event he expects.
He asked for a check of the existing event architecture before the event list is defined.

**Insights:** The primary contract is a swarm-level event system, not a Pi shim.
Pi remains the shape inspiration: a default factory, `on(event, handler)` registration, and a `ctx` object.
Event names follow a `pre.<entity>.<action>` and `post.<entity>.<action>` convention.
`pre.*` events run before the mutation and can veto or rewrite.
`post.*` events run after commit and only observe.
Running unmodified Pi extensions is no longer a version-one goal.
Pi workers keep their native extension path through `extensionFactories` as a later, separate compatibility layer.
A background check of the existing event bus and mutation boundaries follows.

### Verified facts: Existing event architecture

The workflow event bus in `src/workflows/event-bus.ts` wraps a process-wide `EventEmitter`.
Event names are free-form strings such as `task.created` and `github.pull_request.opened`.
Delivery is synchronous and handlers return nothing.
The bus has no veto, no result aggregation, and no error handling of its own.
Every consumer wraps its own body in try/catch.
Consumers today: Linear outbound, Jira outbound, workflow triggers, and workflow resume.

Task lifecycle emits in `src/be/db.ts` run inside `getDbClient().afterCommit`.
Covered transitions: created, completed, failed, cancelled, superseded, progress.
Other emitters (Slack, webhooks, approvals, Kapso, AgentMail) emit directly outside any transaction.
`afterCommit` hooks run only after COMMIT and their rejections are logged, never awaited.

`createTaskExtended` in `src/be/db.ts:4950` is the single write point for every task.
REST, MCP `send-task`, Slack, schedules, workflows, webhooks, and follow-ups all reach it.
Its doc comment names it the single runtime enforcement point.
This is the natural home for a `pre.task.create` decision.

Other decision boundaries with their inputs:

| Boundary | Location | Inputs available | Transaction |
| --- | --- | --- | --- |
| Slack inbound | `src/slack/handlers.ts:428` | channel, user, text, thread, bot mention | none |
| Slack route | `src/slack/router.ts:27` | text, mention flag, thread context | none, pure function |
| Task claim | `src/http/poll.ts:256` | agent, candidate tasks | inside transaction |
| Terminal transition | `src/be/db.ts` complete/fail/cancel | task row, output | atomic UPDATE with WHERE guard |
| Lead follow-up | `src/tasks/worker-follow-up.ts:151` | completed task, worker, lead | separate write |
| Heartbeat classify | `src/heartbeat/heartbeat.ts:352` | stalled task, session, heartbeat age | none |
| Heartbeat remediate | `src/heartbeat/heartbeat.ts:427` | classification, task, options | own writes |
| MCP tool result | `src/tools/utils.ts:668` | tool name, result, request info | none |
| Prompt resolve | `src/prompts/resolver.ts:158` | event type, variables | none |

The MCP registrar has a fixed post-call middleware chain (scrub, nudge).
It has no pre-call hook before the tool callback runs.
The prompt registry supports DB overrides of header and body text only.
It does not compose new sections.

Hot reload precedent: global `swarm_config` writes call `scheduleIntegrationsReload` in `src/http/core.ts:207`.
The reload is debounced at 250 ms and re-initializes integration clients.
Workflow node executors register at boot only in `src/workflows/executors/registry.ts`.
Apps and scripts read fresh from the DB per request.

Storage precedent: `scripts` and `script_versions` tables from migration `064_scripts.sql`.
`upsertScriptByName` deduplicates by content hash and snapshots prior versions.
The runtime loads source text, not a version pointer.
No table stores extensions, plugins, hooks, or handlers today.

**Implication:** A new dispatcher is required for `pre.*` events.
The existing bus can feed `post.*` events with no change to its emit sites.
Communication-style enforcement can run at the MCP tool boundary because agents deliver output through swarm tools.
Native shell or edit calls on each harness stay outside the swarm-level contract.

### Q: Which events ship in v1?

Taras selected five `pre.*` decision events and a `post.*` mirror of the existing bus.

`pre.*` events (veto or rewrite):

| Event | Boundary | Motivating example |
| --- | --- | --- |
| `pre.task.create` | `createTaskExtended` | 4 rewrite tasks, 5 suppress by origin |
| `pre.task.followUp` | `createWorkerTaskFollowUp` | 5 suppress lead completion tasks |
| `pre.slack.route` | Slack message handler, channel known | 1 route channel X to agent Y |
| `pre.heartbeat.remediate` | stalled-task classification and action | 3 heartbeat heuristics |
| `pre.tool.call` | MCP registrar, new pre-call hook | 2 style rules on swarm tool output |

`post.*` events (observe only): `post.task.created`, `post.task.completed`, `post.task.failed`, `post.task.cancelled`, `post.task.superseded`, `post.task.progress`, `post.slack.message`, `post.tool.call`.

**Insights:** `post.*` events reuse the existing bus emits and stay after commit.
`pre.tool.call` requires a new hook in `createToolRegistrar` before the tool callback.
`pre.task.followUp` is separate from `pre.task.create` so a policy can suppress the follow-up before the task payload exists.
Native harness hooks (Claude Code hooks, Pi extensions, OpenCode plugin) are deferred.
Adding an event later means one new dispatch call at a boundary plus a payload type.

### Q: Where do extension handlers run?

Taras answered that the location depends on the event.
Some handlers belong in the API and some in workers.
The follow-up question confirmed that all five v1 `pre.*` events fire in the API process.
Taras selected API in-process execution for v1 with a worker loader deferred to v2.

**Insights:** Each extension declares a `runtime` of `api` or `worker`.
Each event has a fixed origin, so the contract can grow a worker event set without redesign.
Candidate v2 worker events: `pre.worker.toolCall`, `post.worker.sessionEnd`.
The v2 worker loader fetches extension source over HTTP because workers never touch the DB.
In-process execution means a handler is an awaited function call with no serialization.
A failed load disables that extension only.

### Q: What can a pre handler return?

Taras stated the three outcomes a hook must support: no-op, change, or block.

**Insights:** This defines the `pre.*` result contract:

| Return | Meaning |
| --- | --- |
| `undefined` or `{ action: "continue" }` | No-op, the flow proceeds unchanged. |
| `{ action: "modify", data }` | Replace or patch the event payload, for example a task object, a route target, or extra context. |
| `{ action: "block", reason }` | Stop the flow. The boundary maps `reason` to its own failure shape (tool error, skipped task, no route). |

`post.*` handlers return nothing.
The `modify` payload type is per event, so `pre.slack.route` modifies a route target and `pre.task.create` modifies task options.
The boundary code validates the modified payload with the same Zod schema it already uses, so an extension cannot write an invalid row.

### Q: How are ordering and conflicts resolved for one pre event?

Taras selected a sequential chain ordered by priority, where the first block wins.
An initial misclick selected the parallel option. Taras corrected it in the next message.

**Insights:** Handlers run in ascending `priority` (default 100, ties broken by extension name).
Each `modify` result feeds the next handler its modified payload.
The first `block` stops the chain and later handlers do not run.
This matches Claude Code hooks and Pi semantics and needs no merge logic.
`post.*` handlers also run in priority order but their results are ignored.

### Q: What happens when a pre handler throws or exceeds its time limit?

Taras selected fail-open with a 5 second cap, logging, and a failure counter.

**Insights:** A thrown error or a timeout counts as `continue`.
The flow proceeds with the payload as it was before that handler.
Each failure writes a run-log entry and increments a per-extension consecutive-failure counter.
After five consecutive failures the extension auto-disables and shows a visible status.
An operator re-enables it after a fix.
A successful run resets the counter.
Time limit is 5 seconds per handler invocation, enforced with `Promise.race` and an `AbortSignal` passed in `ctx`.
`post.*` handlers use the same cap and counter, but a `post.*` failure never affects the flow.

### Q: What does ctx expose to an extension handler?

Taras selected a typed swarm facade with no raw database access.

**Insights:** The `ctx` shape:

| Field | Content |
| --- | --- |
| `ctx.swarm` | The same tool surface scripts already receive: tasks, agents, kv, memory, slack, scripts. Calls run in-process through the MCP tool functions under a system identity. |
| `ctx.state` | A KV namespace scoped to the extension, for counters, cursors, and cached decisions. |
| `ctx.config` | Operator settings declared in the manifest and stored with the activation record. |
| `ctx.log` | Structured logger that writes to the extension run log and passes through `scrubSecrets`. |
| `ctx.signal` | `AbortSignal` that fires at the 5 second cap. |
| `ctx.event` | Event name, timestamp, and the extension's own id and version. |

The scripts ctx builder in `src/scripts-runtime/ctx.ts` and its generated SDK types are the reuse points.
Extensions never import `getDbClient` or `bun:sqlite`.
The system identity for `ctx.swarm` calls needs a fixed agent id or a service principal so RBAC and audit columns stay valid.
That identity choice is a fact check for the plan, not a new decision.

### Q: How are extensions stored and versioned?

Taras selected new `extensions` and `extension_versions` tables.

**Insights:** The schema mirrors `scripts` and `script_versions` from migration `064_scripts.sql`.
`extensions` holds: id, name (unique), description, source, contentHash, version, runtime, enabled, priority, configJson, status, consecutiveFailures, lastError, activeVersion, audit columns.
`extension_versions` holds immutable rows: extensionId, version, source, contentHash, changedBy, changedAt, changeReason.
Rollback means pointing `activeVersion` at an older row.
The script catalog, its embeddings, its seeder, and `script_run` stay untouched.
The migration ordinal must be checked against `main` and open PRs before the plan fixes it.
New tables need `created_by` and `updated_by` columns or a `.non-audit-tables` entry.

### Q: How is extension source loaded, and when does it reload?

Taras leaned to Bun dynamic import and asked whether a jiti variant for Bun exists.

**Answer:** Bun's runtime is the jiti equivalent.
Transpile-on-import is built into the runtime and jiti adds nothing on Bun.
`Bun.Transpiler` exists for programmatic transpilation if a preprocessing step is ever needed.

**Verified on 2026-09-11 with Bun 1.4.0:** a binary built with `bun build --compile` can `await import("/abs/path/ext.ts")` at runtime.
Type annotations are stripped and the default export runs.
A bare import such as `import { z } from "zod"` fails with `Cannot find package 'zod'` because the compiled binary ships no `node_modules`.
The API image runs the compiled binary `agent-swarm-api` and also ships the `bun` CLI for the script-workflow `ts` runtime.

**Decision (confirmed as option 1):**

- On activate: write source to `<tmpdir>/swarm-extensions/<name>-<contentHash>.ts` and `await import()` it.
- Call the default export with a registration API object. The extension registers handlers with `on(event, handler, { priority })`.
- The registration API is a factory argument, not an import, so no virtual module or plugin is required.
- On upsert, enable, disable, or priority change: dispose the old registration and import the new file at once. No debounce.
- On boot: load every enabled extension after migrations and before the HTTP server accepts requests.
- The content hash in the file name defeats Bun's module cache on reload.

### Q: What can an extension import in v1?

Taras selected the same import allowlist as scripts.

**Verified facts:** `src/scripts-runtime/import-allowlist.ts` allows `swarm-sdk`, `stdlib`, `zod`, and relative paths.
It rejects `node:`, `bun:`, `fs`, `child_process`, `crypto`, and `bun:sqlite` hints and scans the source with the TypeScript AST.
The API Dockerfile pre-bundles `zod.bundle.js`, `stdlib.bundle.js`, and `swarm-sdk.bundle.js` to real disk.
The native executor writes a bare-import shim into the run tmpdir with `writeBareImportShim`, so `import { z } from "zod"` resolves without `node_modules`.

**Insights:** The extension loader reuses the allowlist check and the shim writer.
Extension allowlist: `swarm-extension` (types and helpers), `zod`, `stdlib`, and relative paths within the extension's own tmpdir.
`swarm-sdk` is not needed because `ctx.swarm` carries the same surface.
Relative imports have nothing to resolve in a single-file extension, so the loader can reject them until multi-file packages arrive in v2.
The `swarm-extension` module resolves to a shim that re-exports the types and small helpers such as `block(reason)` and `modify(data)`.

### Q: Which surfaces manage extensions in v1, and who can author them?

Taras selected REST routes, a dashboard page, and MCP tools.
Agents can author extensions. Only operators activate them.

**Insights:** REST routes (all through the `route()` factory with RBAC and response schemas):
list, get, upsert, enable, disable, patch priority and config, list versions, activate a version, and read the run log.
MCP tools: `extension-upsert` and `extension-list`, registered in `SDK_TOOL_NAME_MAP` or excluded with a reason.
An upsert from an MCP tool always lands disabled, and a new version of an enabled extension does not auto-activate.
The enable route and the activate-version route require the operator key, never an agent key.
Dashboard: Settings, then Extensions, with a code editor, status badge, failure counter, version list, and a run-log tail.
New RBAC verbs: `extensions:write` for upsert, `extensions:activate` for enable, disable, and version activation.

### Q: Which MCP tool calls fire pre.tool.call and post.tool.call?

Taras selected agent-facing calls only.

**Insights:** The registrar already marks `ctx.swarm.*` calls from scripts as script-internal.
Extension `ctx.swarm.*` calls receive the same internal mark, so they bypass the tool hooks.
The same rule applies to `pre.task.create`: a task created by an extension carries `origin: "extension:<name>"`.
The dispatcher skips that extension's own handlers for events its actions produce.
No general depth counter is needed in v1.

### Verified facts: Open-question research (2026-09-11)

No system principal exists today.
The scripts bridge in `src/http/mcp-bridge.ts:103` forwards the real caller's agent id and marks the request in a `WeakSet`.
`getRequestInfo` in `src/tools/utils.ts:42` turns that mark into `callOrigin: "script-sdk" | "mcp"`.
`ctxControlMiddleware` at `src/tools/utils.ts:586` skips the wire limit when `callOrigin` is `script-sdk`.
`RequestInfo` (`sessionId`, `agentId`, `runtimeInstanceId`, `sourceTaskId`, `contextKey`, `callOrigin`) is computed before the tool callback runs in `createToolRegistrar`.
Audit resolution in `src/be/audit-user.ts:28` returns null when no trusted user resolves, so `created_by` may stay null.

`CreateTaskOptions` in `src/types.ts:662` has 46 fields.
`createTaskExtended` recomputes `status`, normalizes `key`, inherits Slack, AgentMail, mention, VCS, `dir`, `outputSchema`, `requestedByUserId`, `contextKey`, `followUpConfig`, and `routingAffinity` from the parent when unset, and never inherits `model`.
`createTaskWithSiblingAwareness` in `src/tasks/sibling-awareness.ts:139` needs `contextKey`, respects an explicit `parentTaskId`, and prepends a sibling block to the description.

Safe to rewrite in `pre.task.create`: `agentId`, `creatorAgentId`, `source`, `taskType`, `tags`, `priority`, `dependsOn`, `offeredTo`, `description`, VCS, AgentMail, and mention fields, `dir` when no parent, `model`, `modelTier`, `effort`, `outputSchema`, `followUpConfig`, `bypassTrackerContextDedup`.
Derived and therefore rejected on modify: `status`, `key`, Slack fields without `overrideSlackContext`, `routingAffinity`, `requestedByUserId`, `id`, timestamps, audit columns.

Heartbeat classification in `src/heartbeat/heartbeat.ts:352` uses comment-labeled cases A, B, and C with no enum.
Outcomes are `failTask`, `supersedeTask` plus `createResumeFollowUp`, or record-only.
No struct carries classification and proposed action per task. The plan introduces one.

Slack creates tasks at eight sites and only the message handler at `src/slack/handlers.ts:584` calls `routeMessage`.
The assistant API, modal actions, and thread-buffer flush never route.
All eight sites know the channel id.

Migrations: local and `origin/main` both end at `145_slack_render_v2_delegation.sql`.
Open PRs #1417 and #1235 both claim ordinal 146.
The extensions migration must take 147 or later and re-check at plan time.

`ScriptSourceEditor` in `apps/ui/src/components/scripts/script-source-editor.tsx:56` is a reusable Monaco component that accepts `typeDefs` as a prop.

`writeBareImportShim` in `src/scripts-runtime/executors/native.ts:93` writes `node_modules/<pkg>/package.json` and an `index.ts` re-export next to the script.
Bun resolves bare specifiers by walking `node_modules` upward from the importing file, so the same shim serves an in-process dynamic import when written before the import call.
The cwd-snapshot caveat in `src/scripts-runtime/eval-harness.ts:100` applies to a subprocess's own cwd only.

### Q: Which identity signs ctx.swarm calls made by an extension handler?

Taras selected one system agent per extension, created on enable.

**Insights:** Enable registers an agent row named `ext:<name>` with a system type that is never polled and never assigned tasks.
Its id travels in `x-agent-id`, `callOrigin` becomes `extension`, and `x-source-task-id` carries the event's task when one exists.
RBAC `can()` gets a real subject and audit columns record which extension acted.
Disable keeps the row but marks it inactive so history stays readable.
`callOrigin: "extension"` also skips the wire limit in `ctxControlMiddleware` and is the mark the tool hooks use to bypass `pre.tool.call`.

## Synthesis

### Contract sketch

```ts
// One file, default export, no side effects at import time.
import { z } from "zod";
import type { SwarmExtension } from "swarm-extension";

export const manifest = {
  name: "route-support-channel",
  description: "Send #support messages straight to the support agent.",
  runtime: "api",
  config: z.object({ channelId: z.string(), agentId: z.string() }),
} as const;

const ext: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.slack.route", async (event, ctx) => {
    if (event.channelId !== ctx.config.channelId) return;
    return { action: "modify", data: { target: { kind: "agent", agentId: ctx.config.agentId } } };
  }, { priority: 50 });

  api.on("pre.task.followUp", async (event, ctx) => {
    if (event.task.source === "slack") return { action: "block", reason: "Slack tasks report in-thread." };
  });

  api.on("post.task.completed", async (event, ctx) => {
    await ctx.state.incr(`completed:${event.task.agentId}`);
  });
};

export default ext;
```

`pre.*` handlers return `undefined`, `{ action: "continue" }`, `{ action: "modify", data }`, or `{ action: "block", reason }`.
`post.*` handlers return nothing.

### Types

The extension file is typechecked on upsert against a generated `swarm-extension.d.ts`, the same way scripts are checked against `swarm-sdk.d.ts`.
The `runtime` literal in the manifest selects the `ctx` type. Only the `api` variant exists in v1. The `worker` variant is reserved.

```ts
// swarm-extension.d.ts (generated, sketch)
export type Runtime = "api" | "worker";

export interface ExtensionManifest<C extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  runtime: Runtime;
  config?: C;
}

export interface ApiCtx<Config> {
  swarm: SwarmSdk;                 // same surface as scripts, in-process, signed by ext:<name>
  state: ExtensionState;           // get / set / incr / del, scoped to this extension
  config: Config;                  // z.infer of manifest.config
  log: ExtensionLogger;            // scrubbed, written to the run log
  signal: AbortSignal;             // fires at the 5 s cap
  event: { name: keyof SwarmEventMap; at: string; extension: { id: string; version: number } };
}

export interface WorkerCtx<Config> extends Omit<ApiCtx<Config>, "swarm"> {
  swarm: SwarmSdkOverHttp;         // v2, same shape, HTTP transport
  worker: { agentId: string; taskId: string; harness: string };
}

export type CtxFor<M extends ExtensionManifest> =
  M["runtime"] extends "api" ? ApiCtx<z.infer<NonNullable<M["config"]>>> : WorkerCtx<z.infer<NonNullable<M["config"]>>>;

export type PreResult<Modify> =
  | void
  | { action: "continue" }
  | { action: "modify"; data: Modify }
  | { action: "block"; reason: string };

export interface SwarmEventMap {
  "pre.task.create":        { event: TaskCreateEvent;        modify: TaskCreateModify;        result: PreResult<TaskCreateModify> };
  "pre.task.followUp":      { event: TaskFollowUpEvent;      modify: TaskFollowUpModify;      result: PreResult<TaskFollowUpModify> };
  "pre.slack.route":        { event: SlackRouteEvent;        modify: SlackRouteModify;        result: PreResult<SlackRouteModify> };
  "pre.heartbeat.remediate":{ event: HeartbeatRemediateEvent; modify: HeartbeatRemediateModify; result: PreResult<HeartbeatRemediateModify> };
  "pre.tool.call":          { event: ToolCallEvent;          modify: ToolCallModify;          result: PreResult<ToolCallModify> };
  "post.task.created":      { event: TaskEvent;              modify: never;                   result: void };
  // ... remaining post.* entries
}

export interface ExtensionApi<M extends ExtensionManifest> {
  on<E extends keyof SwarmEventMap>(
    event: E,
    handler: (event: SwarmEventMap[E]["event"], ctx: CtxFor<M>) => Promise<SwarmEventMap[E]["result"]> | SwarmEventMap[E]["result"],
    opts?: { priority?: number },
  ): void;
}

export type SwarmExtension<M extends ExtensionManifest> = (api: ExtensionApi<M>) => void;
```

So in the sketch above `ctx` is `ApiCtx<{ channelId: string; agentId: string }>`, inferred from `manifest.runtime` and `manifest.config`.
`event` and the allowed return type are inferred from the event name.
A handler that returns a `modify` with the wrong shape, or registers a `worker` event under `runtime: "api"`, fails typecheck on upsert.

### V1 events

| Event | Boundary | Event payload | Modify shape | Block effect |
| --- | --- | --- | --- | --- |
| `pre.task.create` | `createTaskWithSiblingAwareness`, `send-task`, `task-action`, before any transaction | `{ options: CreateTaskOptions, origin: "rest" \| "mcp" \| "slack" \| "schedule" \| "workflow" \| "followUp" \| "extension:<name>", requestInfo }` | Input-only subset of `CreateTaskOptions` | Task is not created. Caller gets a skipped result with the reason. |
| `pre.task.followUp` | `createWorkerTaskFollowUp` entry | `{ completedTask, workerAgentId, leadAgentId, summary }` | `{ description?, agentId?, priority?, followUpConfig? }` | No lead follow-up task is created. |
| `pre.slack.route` | Slack message handler, after dedup, before `routeMessage` | `{ channelId, userId, text, threadTs?, botMentioned, threadContext? }` | `{ target: { kind: "agent", agentId } \| { kind: "lead" } \| { kind: "broadcast" } }` | Message is ignored. No task, no reply. |
| `pre.heartbeat.remediate` | `detectAndRemediateStalledTasks`, per stalled task, before action | `{ task, session?, classification: "no-session" \| "stale-session" \| "fresh-stalled", proposedAction: "supersede-resume" \| "fail" \| "record", ages }` | `{ proposedAction }` | No remediation for that task this sweep. Finding is still recorded. |
| `pre.tool.call` | `createToolRegistrar`, agent-facing calls, before the callback | `{ tool, args, requestInfo }` | `{ args }` | Tool returns `toolErr(reason)`. Nothing runs. |
| `post.task.created` | existing bus, after commit | `{ task }` | none | none |
| `post.task.completed` | existing bus, after commit | `{ task, output }` | none | none |
| `post.task.failed` | existing bus, after commit | `{ task, failureReason }` | none | none |
| `post.task.cancelled` | existing bus, after commit | `{ task }` | none | none |
| `post.task.superseded` | existing bus, after commit | `{ task, supersededBy }` | none | none |
| `post.task.progress` | existing bus, after commit | `{ task, progress }` | none | none |
| `post.slack.message` | existing bus, after handling | `{ channelId, userId, text, threadTs?, taskId? }` | none | none |
| `post.tool.call` | `finalizeSwarmToolResult`, agent-facing calls | `{ tool, args, result, requestInfo, durationMs }` | none | none |

### Key Decisions

- V1 extensions are trusted operator code. Operators control activation. No host isolation.
- Extensions are swarm-level, not harness-level. Pi supplies the shape (default factory, `on`, `ctx`), not a compatibility target. Running unmodified Pi extensions is out of v1.
- V1 events: `pre.task.create`, `pre.task.followUp`, `pre.slack.route`, `pre.heartbeat.remediate`, `pre.tool.call`, plus `post.task.{created,completed,failed,cancelled,superseded,progress}`, `post.slack.message`, `post.tool.call`.
- `pre.*` runs before the mutation and can continue, modify, or block. `post.*` runs after commit and observes only.
- `pre.task.create` dispatches at the entry points, never inside `createTaskExtended`: in `createTaskWithSiblingAwareness` for REST, Slack, schedules, workflows, and follow-ups, and in the `send-task` and `task-action` tool handlers before their `getDbClient().transaction` opens. Dispatcher invariant: no `pre.*` handler runs while a transaction is active. The dispatcher checks the AsyncLocalStorage transaction context, logs a violation, and skips the handlers. A unit test covers each caller.
- Handlers run in-process in the API server. Each extension declares `runtime: "api" | "worker"`. The worker loader and worker events are v2. In v1 the upsert route rejects `runtime: "worker"` with a clear message.
- Handlers for one event run sequentially by ascending priority (default 100, ties by name). Each modify feeds the next handler. First block wins.
- Failures fail open: a throw or a 5 second timeout counts as continue, is logged, and increments a consecutive-failure counter. Five in a row auto-disable the extension until an operator re-enables it. Known limit: a timeout in an enforcement rule such as a `pre.tool.call` style check lets that call through. The run log is the audit trail.
- `ctx` exposes `swarm` (script tool surface, in-process, system identity), `state` (extension-scoped KV), `config`, `log` (scrubbed), `signal`, and `event`. No raw DB client.
- Storage: new `extensions` and `extension_versions` tables shaped like `scripts` and `script_versions`, with lifecycle columns. Rollback re-activates an older version row.
- Loading: write source to a hash-named temp file and `await import()` it. Bun's runtime transpiles TypeScript inside the compiled binary (verified). Reload at once on any write. Load all enabled extensions at boot.
- Imports: the scripts allowlist (`zod`, `stdlib`) plus `swarm-extension`, resolved through the existing bare-import shim writer. No relative imports in v1. npm packages are v2.
- Surfaces: REST routes, a Settings → Extensions dashboard page, and `extension-upsert` / `extension-list` MCP tools. Agents author, operators activate. MCP upserts land disabled.
- Activation on upsert: an operator REST upsert of an enabled extension activates the new version at once, because the operator holds the activate permission. An MCP upsert never changes `enabled` or `activeVersion`. A new version of a disabled extension stays disabled from either surface.
- Identity: enable creates a system agent `ext:<name>`. Its id signs every `ctx.swarm.*` call with `callOrigin: "extension"`. Disable marks it inactive.
- `pre.task.create` modify payload is the input-only subset of `CreateTaskOptions` listed in the research facts. The boundary drops derived fields from a modify result and logs each dropped field.
- `pre.heartbeat.remediate` payload is a new struct `{ task, classification: "no-session" | "stale-session" | "fresh-stalled", proposedAction: "supersede-resume" | "fail" | "record" }`. Modify may change `proposedAction`; block skips remediation for that task.
- `pre.slack.route` fires in the Slack message handler only. The assistant API, modal actions, and thread-buffer flush do not route today and stay out of v1.
- `pre.tool.call` and `post.tool.call` fire for agent-facing MCP calls only. Extension and script `ctx.swarm.*` calls bypass the hooks. Extension-created tasks skip the creating extension's own handlers.
- The loader assumes one API process, which matches production today. The `swarm_config` auto-reload shares that assumption. A 30 second poll of `max(extensions.updatedAt)` reloads changed extensions on any other replica, so a second replica is stale for at most 30 seconds.
- Deferred: seeded example extensions. Default to shipping the five motivating examples as test fixtures and docs snippets, not DB seeds, unless revisited.
- `pre.heartbeat.remediate` fires only for tasks the sweep already classified as stalled. It can change or block the remediation action. It cannot change stall thresholds or mark a healthy task as stalled.
- Deferred: `pre.heartbeat.classify` for threshold and classification overrides. Default to v2, with the limit above stated in the docs.
- Deferred: `pre.task.claim`, `pre.prompt.resolve`, `pre.slack.send`. Default to v2.
- Deferred: manifest `config` declared as a Zod schema in code (shown above). Operator values stored in `configJson` and validated on enable.

### Open Questions

All eight open questions were resolved on 2026-09-11. See the research facts above.
Remaining fact checks for the plan:

- Confirm the free migration ordinal at plan time. Two open PRs claim 146.
- Confirm that the `agents` table can hold a system-type agent that the poll loop and the heartbeat sweep ignore, or name the flag to add.

### Constraints Identified

- The API server owns the database. Workers access state over HTTP.
- Runtime DB access uses `getDbClient()`; post-commit work uses `afterCommit`.
- The compiled API binary ships no `node_modules`. Bare imports need on-disk bundles and shims.
- Existing bus emits are synchronous and cannot veto. `post.*` reuses them; `pre.*` needs a new awaited dispatcher at each boundary.
- Non-GET routes declare RBAC. 2xx responses declare schemas. New tables need audit columns.
- New MCP tools return `SwarmToolResult` and register in `SDK_TOOL_NAME_MAP` or the exclusion list.
- Logs pass through `scrubSecrets`. Prompt text goes through the prompt-template registry.
- Boundary code re-validates modified payloads with its existing Zod schemas.

### Core Requirements

1. An operator can store a single-file TypeScript extension, see typecheck and allowlist errors on save, and enable it without a restart.
2. An enabled extension receives the five v1 `pre.*` events and can continue, modify, or block each one, with the result applied by the boundary code.
3. An enabled extension receives the `post.*` events after commit.
4. Handlers run by priority, first block wins, and a broken handler never stalls task creation, Slack routing, heartbeat, or tool calls.
5. Five consecutive failures auto-disable the extension with a visible status and a readable run log.
6. `ctx.swarm` gives the same typed tool surface as scripts, plus extension-scoped state and config.
7. Every version is kept, and an operator can activate an older version.
8. A lead agent can draft an extension through MCP, and it stays disabled until an operator enables it.
9. All five motivating examples are expressible with the v1 events, and each has a test fixture proving it.

### Delivery shape

The first merge covers migration, dispatcher, five boundary integrations, REST routes, MCP tools, and fixtures for the five examples.
The dashboard page is its own phase and its own PR. It is optional for the first merge because REST and MCP already give full control.
The plan should be a DAG plan (`/desplega:v-plan`) so boundaries, routes, and tools can be built in parallel.

## Next Steps

Reviewed on 2026-09-11 and 2026-09-12 with two file-review passes. Handed off to `/desplega:v-plan` on 2026-09-12 with this file as input.
The plan carries the two remaining fact checks into its first phase.

## Review Errata

_Reviewed: 2026-09-11 by Claude (Critical mode). All items applied to Key Decisions and Delivery shape on 2026-09-11 at Taras's request._

### Critical

- [x] **`pre.task.create` inside `createTaskExtended` runs under an open write transaction.** Verified: `src/tools/send-task.ts:434` and `src/tools/task-action.ts:284` wrap `createTaskExtended` in `getDbClient().transaction`. A handler awaited there holds the `BEGIN IMMEDIATE` lock for up to 5 seconds and blocks every writer. Worse, `ctx.swarm.*` writes from the handler join that transaction through AsyncLocalStorage, so a handler can commit or roll back with the caller. Recommended action: dispatch `pre.task.create` before the transaction opens, at `createTaskWithSiblingAwareness` and the tool entry points, or add a dispatcher guard that refuses to run `pre.*` handlers while a transaction is active and audits every caller in the plan. Record the chosen placement as a plan invariant.

### Important

- [x] **Multi-replica reload gap.** In-process loading means an upsert on one API replica does not reload another. Production runs one container today, so state the single-process assumption explicitly, and note the `swarm_config` auto-reload has the same limit. A cheap v1 mitigation is a periodic version check against `extensions.updatedAt`.
- [x] **Heartbeat example is narrower than the motivating text.** `pre.heartbeat.remediate` fires only for tasks already classified as stalled. It cannot change stall thresholds or mark a healthy task as stalled. Say so in Key Decisions, or add `pre.heartbeat.classify` to the deferred list with that reason.
- [x] **Operator REST upsert activation rule is unstated.** The document fixes the MCP case (lands disabled, no auto-activate) but not whether an operator saving a new version of an enabled extension activates it at once. Recommended default: a REST upsert by an operator activates the new version immediately, since operators hold the activate permission; document it.
- [x] **Fail-open weakens enforcement rules.** A timeout in a `pre.tool.call` style rule lets the output through. This is the accepted trade-off, but it should appear under Key Decisions as a known limit, with the run log as the audit trail.
- [x] **One-shot scope is optimistic.** Migration, dispatcher, five boundary integrations, ten REST routes, two MCP tools, a dashboard page, and fixtures for five examples is more than one session. Recommended action: the plan splits the dashboard page into its own phase or PR and treats it as optional for the first merge.

### Resolved

- [x] `runtime: "worker"` was declared in the manifest with no v1 behavior. Added the rejection rule to Key Decisions.
- [x] Temp-file accumulation on reload is unaddressed. Noted here: the loader deletes the previous hash-named file after a successful import of the new one, and cleans the directory at boot. Left as a plan detail.
