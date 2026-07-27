---
date: 2026-07-24
researcher: Claude (Fable 5)
git_commit: ae51f4ff
branch: feat/script-types-freshness
repository: agent-swarm
topic: "Steering for agent harnesses — current state, harness capabilities, exposure surfaces"
tags: [research, steering, harness-providers, mcp-tools, script-sdk, ui, slack]
status: complete
last_updated: 2026-07-27
---

# Steering for Agent Harnesses — Research

## Research Question

Implement "steering" — delivering an additional user/lead message to an agent that is already working on a task — across the harness providers. Research: (1) how the harnesses work in code today, (2) what the harnesses' official docs say about steering / interactive input, (3) how steering could be exposed to the swarm and users via an MCP tool, the script SDK, the UI (task details + sessions), and Slack (config-gated, lead-only steering in thread).

## TL;DR

- **No steering exists anywhere in the codebase today** (zero hits for `steer`/`interrupt` in `src/`). All "give the agent more input" flows are asynchronous **new-task creation** consumed only by idle agents via `/api/poll`.
- **One proven live-injection channel exists**: the cancellation path. Worker hooks (`PreToolUse` / `UserPromptSubmit`) poll `GET /cancelled-tasks` on every tool call and emit `{"decision":"block","reason":...}` — text that actually reaches the running model. It carries a single boolean today, but the transport pattern (poll-per-tool-call + hook injection) generalizes to a payload-carrying control channel.
- **Provider readiness is wildly uneven**: pi-mono's SDK has first-class `steer()`/`followUp()` we already hold a live handle to (unwired); devin already calls a mid-session `sendMessage` API in production (approval flow); claude-managed's `events.send` is proven to work concurrently with an active stream; opencode's local HTTP server accepts a second `session.prompt` (semantics unverified); claude passes the prompt as argv with stdin never piped (needs a stream-json stdin rework, or hook-based delivery); codex has **no upstream primitive at all** (open feature request upstream).
- **Every exposure surface has a well-worn extension pattern**: MCP tool (agent + user servers, capability gating, RBAC verb), script SDK (`SDK_TOOL_NAME_MAP` + hand-written `SCRIPT_SDK_TYPES` + `build:script-types`), HTTP route (`route()` factory + `rbac` + `all-routes.ts` + `docs:openapi`), UI (REST polling, no websockets; task-detail page has zero input affordances today; `SessionComposer` on the sessions page creates chained tasks), Slack (thread↔task mapping on `agent_tasks` columns; busy-worker thread replies today become queued `pending` tasks or `ADDITIVE_SLACK` buffered follow-ups).

---

## Part 1 — Current state in the codebase

### 1.1 There is no steering; the adjacent mechanisms are all "new task rows"

- **Follow-up flow** (`src/tasks/worker-follow-up.ts`): `createWorkerTaskFollowUp` (`:119-197`) creates a brand-new Lead-assigned `taskType:"follow-up"` task when a worker task completes/fails. `createResumeFollowUp` (`:248-389`) creates a `taskType:"resume"` child for interrupted tasks. Continuity is prompt-side only: `src/commands/context-preamble.ts` prepends prior context at dispatch time (2000-token default, 4000 for resumes; injection sites `src/commands/runner.ts:4951-4986`, `:5373-5415`).
- **Native provider resume is deprecated fleet-wide** (2026-05-28, `runbooks/harness-providers.md:137-149`): `claude-adapter.ts:914-921` logs and ignores `resumeSessionId`; codex/opencode `canResume()` return `false`. Devin is the documented exception (its `canResume()` genuinely checks session status, `devin-adapter.ts:901-918`).
- **No task-message/comment table exists.** `agent_tasks` (`src/be/migrations/001_initial.sql:70-111`) has no messages sub-table; `session_logs` (`:168-177`) is append-only worker→server telemetry. Instructions are only representable as a new task row (`parentTaskId`) or creation-time `followUpConfig` JSON.
- **Status enum** (`src/types.ts:220-232`): `backlog | unassigned | offered | reviewing | pending | in_progress | paused | completed | failed | cancelled | superseded`. No `waiting` status. `paused` is container-restart bookkeeping (`db.ts:2690-2759`, migration 024), not a live interrupt.
- **`/api/poll` is the only worker input channel** (`src/http/poll.ts:73-543`) and **only idle agents poll** (`poll.ts:320-321`). Nothing delivered via poll can reach an `in_progress` task.
- **`request-human-input`** (`src/tools/request-human-input.ts:33-120`) creates an `approval_requests` row and returns immediately — outbound "ask", nothing resumes the agent on answer. The workflow analog is `src/workflows/executors/human-in-the-loop.ts` + `wait_states` (migration 049).

### 1.2 The one existing live-injection channel: cancellation

Two layers, both polling `GET /cancelled-tasks` (`src/http/core.ts:351-403`):

1. **Runner layer** (`src/commands/runner.ts:5230-5260`): once per poll cycle (≤5s while tasks active), per active task; on hit → `task.session.abort("cancelled")`.
2. **Adapter layer, faster** (`src/providers/swarm-events-shared.ts:107-142`, `checkCancelled`): fired on every `tool_start` (throttled 500ms) from `codex-swarm-events.ts` and `claude-managed-swarm-events.ts` → `abortRef.current?.abort("cancelled")` + provider-specific `onCancel`.
3. **Hook layer (claude provider)** (`src/hooks/hook.ts`): `checkAndBlockIfCancelled` (`hook.ts:794-828`) runs from `PreToolUse` (`:1046-1053`) and `UserPromptSubmit` (`:1233-1241`), and on hit prints `{"decision":"block","reason":"..."}` (`outputBlockResponse`, `:780-786`) — **this text is fed back into the running model by Claude Code's hook protocol**. Non-blocking siblings: `SessionStart` and `PreCompact` (`:1021-1044`) `console.log` goal-reminder context blocks.

This channel carries no payload (boolean per taskId). But it is the proven skeleton for a control channel: **server-side state → per-tool-call poll → in-context injection**.

### 1.3 Provider-by-provider execution + steering readiness

All providers implement `ProviderAdapter`/`ProviderSession` (`src/providers/types.ts:177-183`) exposing `onEvent` / `waitForCompletion` / `abort`. One session per task, prompt sent once at creation (`spawnProviderProcess`, `src/commands/runner.ts:2892`).

| Provider | Invocation | stdin open? | Mid-run channel in our code | Mid-run channel available upstream |
|---|---|---|---|---|
| **claude** | `Bun.spawn` `claude -p <prompt> --output-format stream-json` (`claude-adapter.ts:546-612`) | **No** — stdin never configured/held | None (abort → SIGTERM, `:904-906`) | Yes: `--input-format stream-json` stdin queue (v2.1.205+); hooks injection (already used for cancel) |
| **codex** | Subprocess `codex-session-runner`; stdin gets one JSON config then **`stdin.end()`** (`codex-adapter.ts:1596-1605`); inner path `thread.runStreamed(prompt,{signal})` once (`:1101-1103`) | No (closed after config) | None (AbortController) | **No** — SDK `Thread` is strictly turn-sequential; no interrupt-and-inject primitive; upstream FR open (openai/codex#11415) |
| **opencode** | `createOpencode()` spawns a **local HTTP server**; `client.session.create` + `client.session.prompt` (`opencode-adapter.ts:761-810`); SSE events (`:842-856`) | n/a (HTTP) | None exposed (client/sessionId trapped in closures; only reuse is a model-not-found retry, `:811-821`) | Structurally yes: second `session.prompt` while running; **mid-turn semantics undocumented**; `POST /session/{id}/interrupt` exists |
| **pi-mono** | **In-process** `createAgentSession()` from `@earendil-works/pi-coding-agent`; `agentSession.prompt(prompt,{source:"rpc"})` once (`pi-mono-adapter.ts:717-719`) | n/a (in-process) | None wired — but we hold the live `AgentSession` object for the task lifetime | **Yes, first-class**: `steer(text)` / `followUp(text)` / `prompt(text,{streamingBehavior})` (`node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:71-77,180-234`). Zero uses in `src/` |
| **devin** | Remote REST `/v3/.../sessions` (`devin-api.ts`); status polling every 15s (`devin-adapter.ts:259-265`) | n/a (API) | **Yes, wired in prod**: `sendMessage(...)` (`devin-api.ts:150-162`) relays human approval responses into the running session (`devin-adapter.ts:650-723`, gated on `waiting_for_approval` `:484-498`) | Yes: `POST /sessions/{id}/message` documented for active sessions |
| **claude-managed** | `client.beta.sessions.create` + SSE stream; initial message via `events.send(..., [{type:"user.message"}])` (`claude-managed-adapter.ts:616-638`) | n/a (API) | Partially: `abort()` sends `user.interrupt` **while the stream is draining** (`:319-336` vs `:652-677`) — same call shape as a `user.message` send | **Yes, documented**: "send events while the session is running or idle; processed in order" |

Notes:
- **Gemini**: there is no standalone gemini adapter in `src/providers/`; Gemini models run through opencode/OpenRouter (default `google/gemini-3-flash-preview`). Gemini CLI itself (per docs below) has no headless steering anyway.
- `src/claude.ts:1-81` (`runClaude`) is a separate one-shot helper, same argv-prompt pattern, not used by the adapter.
- `docker-entrypoint.sh` provider branches are credential/MCP-discovery only; no channel relevant to steering.

---

## Part 2 — Harness-native steering capabilities (official docs)

| Harness | In-flight injection | Resume finished session | Mechanism |
|---|---|---|---|
| Claude Code CLI | **Yes (queued)** — v2.1.205+; earlier versions **discarded** mid-turn stdin messages. Interrupt-via-stdin-control-protocol: **see §2.1 follow-up below** | Yes (`--resume <id> "prompt"`, `--continue`, `--fork-session`) | `--input-format stream-json`; stdin lines `{"type":"user","message":{"role":"user","content":"..."},"parent_tool_use_id":null}`; queued message runs as its own turn when current turn ends; `shouldQuery:false` appends context without triggering a turn |
| Claude Agent SDK (TS) | **Yes** | Yes (`resume` option) | `query()` with `AsyncIterable<SDKUserMessage>` unlocks `streamInput()`, `interrupt()` (returns `still_queued` UUIDs on v2.1.205+), `setModel()`, `setPermissionMode()`, `applyFlagSettings()` |
| Codex CLI | **No** (documented; `turn/interrupt` only stops; `codex inject` is an open FR, openai/codex#11415) | Yes (`codex exec resume [--last|<id>] "prompt"`; app-server `turn/start` on existing thread; MCP `codex-reply` w/ threadId) | app-server JSON-RPC: start → (interrupt) → completed → next turn |
| opencode | **Yes (queued) — VERIFIED** (source + empirical spike, §2.2): second `session.prompt` on a busy session persists immediately and runs as the next turn after the in-flight turn completes naturally; never rejected, never interleaved, never interrupts. `POST /session/{id}/abort` is the only interrupt | Yes (`run --continue` / `--session <id>`; session fork endpoints) | `opencode serve` HTTP + OpenAPI at `/doc`; `run --attach <url>`; `promptAsync` (204, non-blocking) for fire-and-forget sends |
| Devin API | **Yes/partial** — documented for active sessions; behavior while actively `working` (vs `waiting_for_user`) unspecified | Sessions are long-lived; the message endpoint is the resume verb | `POST /v1/sessions/{id}/message` `{"message":"..."}`; sub-states `working|waiting_for_user|waiting_for_approval|finished` under `running` |
| Anthropic Managed Agents | **Yes, explicit** — "send events while the session is running or idle; they're processed in order" | Yes — same event mechanism on idle session | `/v1/sessions` events API; `user.message` events; `session.status_idle` |
| pi (coding agent) | **Yes, richest semantics** | Session files persist (exact resume verb not captured this pass) | RPC/SDK `sendMessage()` with delivery modes: `steer` (interrupt after current tool, skip queued tools), `followUp` (after current assistant turn, before next LLM call), `nextTurn` |

Source URLs are in the appendix at the bottom.

Notes from review (2026-07-24):
- **Gemini CLI row removed** — not a supported provider in agent-swarm (no adapter; Gemini models run through opencode/OpenRouter). Disregard for steering.

### §2.1 Follow-up: Claude Code interrupt-via-stdin — RESOLVED

Taras: queue-only isn't enough — we want **both** a "steer" (interrupt-style) and a "queue" mechanism as distinct actions (separate options on the tools/UI; a choose-one config for Slack).

**Finding: interrupt is SDK-only; raw CLI stream-json is queue-only (documented).**

- The control protocol envelope exists (`{"type":"control_request","request_id":...,"request":{...}}` appears in the SDK docs for permission requests), but the **interrupt request payload is not published** and the CLI headless/CLI-reference docs list `--input-format stream-json` for user messages only. Sending interrupts over raw stdin is undocumented/unsupported territory.
- The **officially supported interrupt path is the Agent SDK**: `query()` in streaming-input mode exposes `interrupt()` (v2.1.205+ returns `SDKControlInterruptResponse { still_queued: string[] }` — UUIDs of queued messages that survive and each run as their own turn; feature-detect via the `interrupt_receipt_v1` capability in `SDKSystemMessage.capabilities`), plus `streamInput()`, `setModel()`, `setPermissionMode()`. Steer recipe: `interrupt()` then push the new user message (with a `uuid` for tracking) into the input stream.
- Version ladder: <2.1.199 no interrupt; 2.1.199–2.1.204 `interrupt()` resolves `undefined`; ≥2.1.205 full receipt.

**Implication for the claude adapter decision (§4.2):** the approved stream-json stdin rework yields **queue-mode only** if we keep spawning the raw CLI. To get steer-mode (interrupt) on claude with official support, the adapter would need to drive Claude Code via `@anthropic-ai/claude-agent-sdk` (in-process `query()` — analogous to how pi-mono is embedded) instead of raw `Bun.spawn` of the CLI. Alternatives: (a) raw CLI + queue-only for claude (steer degrades to queue), (b) reverse-engineer the undocumented interrupt control_request (unsupported, brittle), (c) SDK adoption (both modes, officially supported).

**RESOLVED (Taras, 2026-07-27): option (a) — raw CLI, queue-only.** Keep `Bun.spawn`, add `--input-format stream-json` + piped stdin, keep the existing event pipeline. `mode: "steer"` on a claude task degrades to queue delivery. SDK adoption is explicitly **not** in scope for this plan.

### §2.2 Follow-up: opencode mid-run `session.prompt` semantics — RESOLVED (queued, supported)

Verified two ways: source reading of anomalyco/opencode at tag `v1.18.4` (matches our `@opencode-ai/sdk@^1.18.4` pin, `package.json:155`) and an empirical spike (`/tmp/opencode-spike.mjs`, opencode binary 1.14.30, `openrouter/deepseek/deepseek-v4-flash`, both HTTP calls 200). Queueing logic is identical across 1.14.30 and 1.18.4.

**Semantics — queue, intentional and supported:**
- `prompt()` (`packages/opencode/src/session/prompt.ts` ~L1052-1071) always persists the incoming user message first, then calls the run loop. `Runner.ensureRunning()` (`packages/opencode/src/effect/runner.ts` L115-138): if `Idle` → fork the loop fiber; if `Running` → **do not** start a second fiber, just attach the caller to the in-flight `Deferred`. The `while(true)` run loop re-reads messages each iteration and only exits when nothing newer is pending — so the queued message runs as the next turn after the current turn completes naturally.
- Empirical confirmation: prompt #2 sent ~3s into prompt #1's turn; final transcript strictly sequential (user1 → assistant1 `finish=stop` → user2 → assistant2 "DONE"); both HTTP promises settled at the same instant when the whole chain went idle.
- **Not steering/interrupting**: a second prompt never cuts off the in-flight turn. `POST /session/{id}/abort` (`promptSvc.cancel` → `Fiber.interrupt`) is the only interrupt.

**Adapter gotchas for the plan:**
- **Blocking-response caveat**: a `prompt` call issued while busy resolves with the response of the **final** turn of the whole run (shared `Deferred`), not necessarily its own turn. Code expecting "my prompt's own reply" in the return value will be misled. Use **`session.promptAsync`** (`POST /session/{id}/prompt_async`, returns `204` immediately, same queueing underneath) for steering writes and read results off the SSE event stream the adapter already consumes.
- `shell` is the exception: it 409s (`Session.BusyError` via `SessionError.mapBusy`) on a busy session; only `prompt`/`command` queue.
- Steer-mode (interrupt-style) on opencode would be a composition: `abort` then `prompt` — cuts the in-flight turn, loses its remaining work; queue-mode is the native, zero-loss path.

---

## Part 3 — Exposure surfaces as they exist today

### 3.1 MCP tool pattern

- Tools are plain `xHandler(ctx: ToolCtx, args)` functions with Zod schemas, registered via `createToolRegistrar` (`src/tools/utils.ts:141-193`), which injects `RequestInfo` from `X-Agent-ID`/`X-Source-Task-Id`/`X-Context-Key` headers and wraps in OTel spans. Handlers call `@/be/db` **directly** (the MCP server runs inside the API process — no HTTP hop).
- **Agent surface** (`/mcp`, `src/http/mcp.ts` → `createServer()` in `src/server.ts`): full capability-gated registry. Registration wrapped in `if (hasCapability("<group>"))` blocks (`src/server.ts:319-533`); `ALL_CAPABILITIES` (`:167-190`), `DEFAULT_CAPABILITIES` (`:195-221`), env `CAPABILITIES` override (`:227-233`). `fullSurface: true` (used by the scripts bridge and CI generators) bypasses gating (`:262-263`).
- **User surface** (`/mcp-user`, `src/http/mcp-user.ts` → `createUserServer()` in `src/server-user.ts:89-178`): hand-curated subset (`send-task`, `get-tasks`, `get-task-details`, `cancel-task`, `task-action`) re-registering the **same handlers** with `userCtx` + narrower schemas + `rbac: permission(...)` enforced by `maybeDenyUserToolAdmission` (`:59-87`) → `decideToolAdmission` (`src/rbac/admission.ts`) when `isRbacEnabled()`.
- **Prompt gating**: `enabledCapabilities` returned on agent register (`src/http/agents.ts:371-376`) → `serverCapabilities` in `base-prompt.ts:53-151` (`serverHasCapability(cap, whenUnknown)`); runner rebuilds prompt on capability drift (`runner.ts:4191-4535`).
- Reference wirings: `task-action` (`src/tools/task-action.ts:42-616`, agent reg `server.ts:341-343`, user reg `server-user.ts:164-175`) and `send-task` (`src/tools/send-task.ts:32-585`, user variant `server-user.ts:105-122`).

### 3.2 Script SDK pattern

- `SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts:1-147`) maps SDK method names (`task_send`) → MCP tool names (`"send-task"`). Runtime: `swarm-sdk.ts` `callTool` (`:465-477`) checks the allowlist then hits `POST /api/mcp-bridge` (`src/http/mcp-bridge.ts:49-121`), which re-checks `isMcpToolAllowedForScripts`, and invokes the tool handler on a lazily-built `createServer({ fullSurface: true })` singleton via `_registeredTools`.
- Typed SDK: `SCRIPT_SDK_TYPES` in `src/be/scripts/typecheck.ts:29-230` is **hand-authored** (one signature per SDK method), concatenated with mechanically generated connection types. `scripts/bundle-script-types.ts` verifies every allowlist entry exists in the registry and writes `src/scripts-runtime/types/*.d.ts` (`bun run build:script-types`).
- CI: `scripts/check-sdk-tool-registration.ts` — every tool in `ALL_TOOLS` (`src/tools/tool-config.ts:198`) must be in `SDK_TOOL_NAME_MAP` or `EXCLUDED_TOOLS`-with-reason.

### 3.3 HTTP route pattern

- `route()` factory (`src/http/route-def.ts:157-215`) → `routeRegistry` → OpenAPI. Every non-GET route declares `rbac: { permission } | { ungated: reason }` (CI: `check:rbac-coverage`). New handler files must be imported in `src/http/all-routes.ts`; then `bun run docs:openapi`.
- RBAC: 52 verbs in `PERMISSIONS` (`src/rbac/permissions.ts:19-228`), `.own`/`.any` convention; `can()` (`src/rbac/can.ts:29-44`) evaluates `LEGACY_POLICY` (`src/rbac/legacy-policy.ts:145-198`, exhaustive `satisfies` map) with reusable predicates (`leadOnly`, `leadOrTaskCreator`, `requesterOwnsTask`, …). Same engine used by HTTP handlers, agent-tool ownership checks (`assertOwnsTask`, `src/tools/task-tool-ctx.ts:28-59`), and user-MCP admission.
- Existing task-scoped mutations to model on: `POST /api/tasks/:id/cancel|pause|resume`.

### 3.4 UI (apps/ui)

- React 19 + Vite + react-router v7 + TanStack Query. **REST polling only, no websockets/SSE**: global 10s `refetchInterval` (`apps/ui/src/app/providers.tsx:12-21`); `useTaskSessionLogs` 5s (`api/hooks/use-tasks.ts:63-70`). Auth = `Authorization: Bearer <apiKey>` (`api/client.ts:180-189`); user identity via `CurrentUserContext` (`requestedByUserId`), gated `useFeatureGate("1.76.0")`.
- **Task details** (`pages/tasks/[id]/page.tsx`): status buttons only — Cancel (`POST /api/tasks/:id/cancel`, `page.tsx:993-1021`), Pause (`:971-981`), Resume (`:982-992`), all with optimistic cache patching. **No free-text input box exists on this page.** Read-only: activity timeline, structured output, attachments, `SessionLogViewer` (pure rendering of 5s-polled logs, `components/shared/session-log-viewer.tsx`).
- **Sessions** (`pages/sessions/[rootTaskId]/page.tsx`): a "session" = root task + follow-up chain (`useSession` → `{root, chain}`). **`SessionComposer`** (`components/sessions/session-composer.tsx`) is the only send-message UI in the app: `api.createTask({ parentTaskId: latestLeafTaskId ?? rootTaskId, source: "ui" })` → **new chained task** auto-routed to the Lead. Disabled until a userId is picked.
- **No client-side RBAC**; only version gating via `useFeatureGate(minVersion)` against `/health` version.
- Approval requests (`pages/approval-requests/[id]/page.tsx`) answer pre-defined workflow HITL questions — separate feature area.

### 3.5 Slack

- Socket Mode Bolt app (`src/slack/app.ts:34-54`), started via `startSlackApp()` from config reload (`src/http/core.ts:89-91`). `SLACK_DISABLE` short-circuit.
- **Thread↔task mapping lives on `agent_tasks`** (`slackChannelId`/`slackThreadTs`/`slackUserId`, `src/types.ts:401-406`; migrations 093/034/040). Lookups: `getAgentWorkingOnThread` (`db.ts:2278-2293`, most recent `source='slack'` task, **no status filter**), `getMostRecentTaskInThread` (`:2320-2331`), `getLatestActiveTaskInThread` (`:2299-2313`).
- **Routing** (`src/slack/router.ts:26-97`): `swarm#<uuid>` → `swarm#all` → thread follow-up (agent working the thread) → lead fallback on @mention. `SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION` (default false) is the mention gate (`router.ts:33-34,62`; `HEURISTICS.md:20,97`).
- **Reply into a busy worker's thread today**: a **new separate `pending` task** is created for that worker (labeled "queued" in the summary UI, `handlers.ts:714-724`; no `dependsOn` in this branch), OR — with `ADDITIVE_SLACK=true` — buffered/debounced into a dependent follow-up (`thread-buffer.ts`, `dependsOn` wired at `:165-177`; `!now` bypass), OR silently dropped if mention-gated. **Nothing reaches the in-flight run.**
- Lead/worker: lead is default mention target; delegation via standard `send-task` with `checkSlackRoutingCoherence` (`src/tasks/slack-routing.ts:71-147`); `createTaskExtended` auto-propagates Slack fields parent→child (`db.ts:3926-4004`); worker completion → lead-owned follow-up inheriting the thread (`worker-follow-up.ts:193-195`).
- Outbound: watcher polling loop (3s, `src/slack/watcher.ts:466-769`) updates one evolving tree message; agent tools `slack-reply`/`slack-post`/etc.
- Config is env-only (no per-channel DB config), but Slack creds hot-reload from the `swarm_config` table via `POST /api/config/reload`.

---

## Part 4 — How steering could be exposed (synthesis / options)

*(Requested explicitly; this section is options, not a plan.)*

### 4.1 Core primitive: a payload-carrying control channel

The cancellation channel is the template. A minimal generic version:

- **Storage**: a `task_steering_messages` table (taskId, body, createdBy {user|agent}, source {ui|mcp|script|slack}, status {pending|delivered|expired}, deliveredAt) — forward-only migration; steering messages are conversation data and belong in the transcript/session views, which the current boolean channel can't represent.
- **Write side**: one handler function (à la `sendTaskHandler`) exposed via all four surfaces (below). Guard: target task must be `in_progress` (or `pending`?); otherwise fall back to the existing follow-up-task path.
- **Read/delivery side**, layered like cancellation:
  - Runner poll (≤5s, `runner.ts:5230-5260` region): fetch pending steering per active task → hand to the session.
  - Adapter-level fast check (500ms on `tool_start`, `swarm-events-shared.ts`): same fetch, lower latency.
  - Extend `ProviderSession` with an optional `deliverSteering(text): Promise<boolean>` — returns false if unsupported → runner falls back to queuing a follow-up task (today's semantics), so the feature degrades gracefully per provider.

### 4.2 Per-provider delivery

| Provider | Delivery option | Effort/notes |
|---|---|---|
| pi-mono | `agentSession.steer(text)` or `followUp(text)` on the live in-process handle | Smallest lift; richest semantics (interrupt vs turn-boundary) |
| devin | `sendMessage()` — already wired for approvals | Trivial extension |
| claude-managed | `events.send(..., [{type:"user.message",content}])` mid-stream | Same call shape as init send; docs guarantee in-order processing |
| opencode | **VERIFIED queue-mode**: `session.promptAsync` for steering writes (non-blocking; blocking `prompt` returns the whole-run's final response — see §2.2 caveat); needs client/sessionId lifted out of closures. Steer-mode = `abort` + `prompt` composition (loses in-flight turn work) | Queue semantics confirmed at our pinned version (§2.2) |
| claude | **DECIDED (final): stdin rework, queue-only** — spawn with `--input-format stream-json` + piped stdin, write `{"type":"user",...}` lines. Requires CLI ≥ 2.1.205. **No interrupt-mode**: `mode:"steer"` degrades to queue on claude. Agent-SDK adoption rejected for this plan (§2.1). | Taras approved; keeps the existing spawn/event pipeline |
| codex | **DECIDED: fallback-only** — steering becomes a queued follow-up task; **no abort-and-rerun** (loses in-flight work) | Watch openai/codex#11415 for native injection |

### 4.3 Surfaces

- **MCP tool** `steer-task` (or extend `task-action` with a `steer` action + `message` payload): agent surface under `core`/`task-pool` capability (lead steering its workers — creator/lead check via `leadOrTaskCreator`); user surface in `server-user.ts` with new RBAC verbs, e.g. `task.steer.own` (+ `task.steer.any` lead/operator). Register in `PERMISSIONS` + `LEGACY_POLICY`.
- **Script SDK**: `task_steer` in `SDK_TOOL_NAME_MAP`, hand-written signature in `SCRIPT_SDK_TYPES`, `ALL_TOOLS` entry, `bun run build:script-types`. (Or `EXCLUDED_TOOLS` with a reason if scripts shouldn't steer.)
- **HTTP route**: `POST /api/tasks/:id/steer` via `route()` (body `{message, requestedByUserId?}`), `rbac: { permission: "task.steer.own" }`, import in `all-routes.ts`, `docs:openapi`. The UI calls this.
- **UI**:
  - Task details: add the first input affordance on that page — a steer composer visible when `status === "in_progress"` (pattern: the cancel/pause mutation wiring in `use-tasks.ts:278-396` plus a textarea). Delivered/pending steering messages surface in the activity timeline (`task.logs`) or a new steering section; 5s log poll already gives quasi-live feedback.
  - Sessions: `SessionComposer` currently always creates a new chained task. **RESOLVED**: when the latest lead task is `in_progress`, show an **explicit** segmented toggle (Queue / Interrupt, **default Queue**) next to send; otherwise fall back to creating the chained follow-up task. Gate with `useFeatureGate("<next-version>")`.
- **Slack (lead-only, config-gated)**: intercept the existing thread-reply path — where today a busy worker gets a queued `pending` task (`handlers.ts:714-724`) or an additive-buffer entry, a new config flag (e.g. `SLACK_THREAD_STEERING=off|lead|all`, env + `swarm_config` hot-reload like other Slack settings) routes the reply as a steering message into the thread's `in_progress` task instead. **RESOLVED**: mention gate (`SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION`) applies **unchanged**, and qualifying replies **still flow through the `ADDITIVE_SLACK` debounce buffer** — the buffer flush emits **one** steering message instead of one dependent follow-up task. Still to design in-plan: the `:eyes:` reaction/ack UX and a "steered" marker on the watcher's tree message.

### 4.4 Cross-cutting integration points

- **Heartbeat**: steering delivery should refresh liveness assumptions — a task being actively steered must not trip the stalled-task classifier mid-delivery (`runbooks/heartbeat-crash-recovery.md` same-PR update rule applies).
- **Prompt templates**: any new agent-facing instruction text ("you may receive steering messages…") must go through `src/prompts/` registry, gated via `serverHasCapability`.
- **Secret scrubbing**: steering bodies flow into logs/session_logs → `scrubSecrets` at egress.
- **Session/transcript**: steering messages should appear in the session timeline (UI) — implies persisting them somewhere the sessions API reads.

---

## Code reference index

| Area | Files |
|---|---|
| Provider adapters | `src/providers/{claude,codex,opencode,pi-mono,devin,claude-managed}-adapter.ts`, `src/providers/types.ts:177-183`, `src/providers/devin-api.ts:150-162`, `src/providers/swarm-events-shared.ts:107-142` |
| Runner | `src/commands/runner.ts` (spawn `:2892`, cancel poll `:5230-5260`, trigger poll `:5281`, preamble injection `:4951-4986`, `:5373-5415`), `src/commands/context-preamble.ts` |
| Hooks (injection channel) | `src/hooks/hook.ts:780-828,1046-1053,1233-1241,1021-1044` |
| Follow-up/resume | `src/tasks/worker-follow-up.ts:119-197,248-389,425-546` |
| Cancellation | `src/tools/cancel-task.ts:31-185`, `src/be/db.ts:2514-2571`, `src/http/core.ts:351-403` |
| Poll/claim | `src/http/poll.ts:73-543` (idle-only note `:320-321`) |
| HITL | `src/tools/request-human-input.ts:33-120`, `src/workflows/executors/human-in-the-loop.ts`, migrations 020/049 |
| MCP registration | `src/tools/utils.ts:141-193`, `src/server.ts:167-533`, `src/server-user.ts:39-178`, `src/http/mcp.ts`, `src/http/mcp-user.ts`, `src/http/mcp-bridge.ts:11-121` |
| Script SDK | `src/scripts-runtime/sdk-allowlist.ts`, `src/scripts-runtime/swarm-sdk.ts:400-477`, `src/be/scripts/typecheck.ts:29-306`, `scripts/bundle-script-types.ts`, `scripts/check-sdk-tool-registration.ts` |
| HTTP/RBAC | `src/http/route-def.ts:157-215`, `src/http/all-routes.ts`, `src/rbac/permissions.ts:19-234`, `src/rbac/legacy-policy.ts:27-198`, `src/rbac/can.ts:29-44`, `src/tools/task-tool-ctx.ts:6-59` |
| UI | `apps/ui/src/pages/tasks/[id]/page.tsx` (actions `:971-1021`), `apps/ui/src/pages/sessions/[rootTaskId]/page.tsx`, `apps/ui/src/components/sessions/session-composer.tsx`, `apps/ui/src/api/hooks/use-tasks.ts:49-396`, `apps/ui/src/api/client.ts:180-197,328-399`, `apps/ui/src/api/hooks/use-feature-gate.ts` |
| Slack | `src/slack/{app,handlers,router,assistant,thread-buffer,watcher,responses}.ts`, `src/slack/HEURISTICS.md`, `src/tasks/{slack-routing,sibling-awareness,context-key}.ts`, `src/be/db.ts:2278-2331,3926-4004`, migrations 093/034/040 |

## Harness doc sources

- Claude Code: code.claude.com/docs/en/{headless,cli-reference,sessions,agent-sdk/typescript}.md; anthropics/claude-code#24594 (stream-json underdocumented), #3976 (headless resume bugs). Key version: **v2.1.205** (queued-not-discarded mid-turn stdin; interrupt receipts).
- Codex: developers.openai.com/codex/{cli/reference,app-server,mcp}; codex-rs/app-server README; openai/codex#11415 (`codex inject` FR — not implemented).
- Gemini CLI: geminicli.com/docs/cli/{headless,session-management}; google-gemini/gemini-cli#14180 (resume+stdin bug).
- opencode: opencode.ai/docs/{cli,server}; v2.opencode.ai/api-reference/session/interrupt-session-execution.
- Devin: docs.devin.ai/api-reference/v1/sessions/send-a-message-to-an-existing-devin-session; v3 get-session (status model).
- Managed Agents: platform.claude.com/docs/en/managed-agents/quickstart; anthropics/skills managed-agents-core.md ("send events while the session is running or idle").
- pi: github.com/badlogic/pi-mono packages/coding-agent/docs/{rpc,extensions}.md (repo moving to earendil-works/pi); local authoritative copy: `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:71-77,180-234`.

---

## Decisions (Taras review, 2026-07-24)

1. **Steering semantics — support BOTH modes.** Two distinct delivery mechanisms: **steer** (interrupt-style — pi `steer`, SDK `interrupt()`+message) and **queue** (turn-boundary — pi `followUp`, Claude stdin queue). Both exposed as separate options on the MCP tool and the UIs; for Slack it's a choose-one config. Providers that can't do interrupt degrade to queue; providers that can't do queue degrade to follow-up-task fallback.

2. **Persistence — separate table, with promotion.** Steering messages get their own storage (e.g. `task_steering_messages`), NOT `agent_tasks` rows. If the parent task finishes (or dies) before delivery, the undelivered steer is **promoted** into a follow-up task. *(Claude's take on the "wdyt?": agreed — promotion on terminal status is the right escape hatch. It gives exactly-once semantics a clean home: `pending → delivered | promoted | cancelled`, the delivery poll only sees `pending`, and the promotion path reuses `createWorkerTaskFollowUp`-style plumbing. It also answers the crash case from decision 10: promotion into the resume follow-up's context preamble.)*

3. **Claude adapter — go straight to the stdin `--input-format stream-json` rework** (no interim hook-based delivery). Requires CLI ≥ 2.1.205 fleet-wide; prompt moves from argv to a piped-stdin user message; stdin stays open for steering writes.

4. **Codex — fallback-only, no abort.** Steering a codex task becomes a queued follow-up task (promotion path from decision 2). Revisit if/when openai/codex#11415 (`codex inject`) ships.

5. **Slack — steer only the lead's latest task.** A thread reply is delivered as a steer only when the thread's **lead task (the last/latest one) is `in_progress`**. Otherwise → new task (today's behavior). Child/worker tasks are **excluded** from thread-steering entirely. Config chooses steer-vs-queue mode per decision 1.

6. **UI composer — same policy as Slack.** `SessionComposer` steers when the session's latest lead task is `in_progress`, otherwise creates the chained follow-up task (current behavior). Same steer/queue mode exposure as the tools.

7. **RBAC — as proposed.** `task.steer.own` (requester/creator) + `task.steer.any` (lead/operator). Agent-side steering follows the same lead/creator gating (`leadOrTaskCreator`-shaped rule).

8. **Script SDK — expose it in v1.** `task_steer` goes into `SDK_TOOL_NAME_MAP` + `SCRIPT_SDK_TYPES` (not `EXCLUDED_TOOLS`).

9. **Paused tasks — auto-start.** Steering a `paused` task auto-resumes/starts it and delivers the message (no rejection, no silent store-only).

10. **Heartbeat/crash — yes to both.** Pending steering extends/resets stall thresholds for the target task, and undelivered steers transfer into the resume follow-up (context-preamble inclusion). `runbooks/heartbeat-crash-recovery.md` must be updated in the same PR.

11. **Delivery status must be explicit + acknowledged.** The steer row carries a clear lifecycle status, and the *agent explicitly acknowledges* handling — e.g. an `accept-steer` tool (or ack parameter on an existing call) that flips the row to `handled`, rather than inferring delivery from transport success. Caller surfaces (UI poll, Slack emoji reaction) render that status.

12. **opencode — spike approved and in flight** (§2.2): empirically determine `session.prompt`-while-running semantics before assigning opencode its tier.

### Decisions (Taras review, 2026-07-27) — plan-time open questions closed

13. **Claude adapter — raw CLI, queue-only** (§2.1). Keep `Bun.spawn`; add `--input-format stream-json` + piped stdin. `mode:"steer"` degrades to queue on the claude provider. Adopting `@anthropic-ai/claude-agent-sdk` in-process is **out of scope** for this plan (not deferred-as-a-step; simply not planned).

14. **Mode selection — explicit, default `queue`.** Every caller surface (MCP tool, script SDK, HTTP route, UI composer, Slack config) carries an explicit `mode: "steer" | "queue"` that **defaults to `queue`** (zero-loss). No server-side auto-detection heuristic. UI renders a segmented Queue/Interrupt control with Queue preselected. Per-provider degradation (steer→queue→follow-up-task) is the only implicit behavior, and it must be reported back to the caller in the response + row status.

15. **Slack — steer respects the `ADDITIVE_SLACK` buffer; mention gate unchanged.** A qualifying thread reply goes through the existing debounce window, and the flush emits **one** steering message (instead of today's one dependent follow-up task). `SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION` semantics are untouched — mention-gated replies that don't qualify today still don't steer.

16. **Unsupported modes are advertised, and failing is opt-in.** Refines decision 1. Silent degradation is a trust problem — Interrupt and Queue differ in a way that matters when an agent is mid-destructive-action. Three parts: (a) a static server-side `PROVIDER_STEER_CAPABILITIES` map is surfaced as **`supportedSteerModes`** on task read responses, so the UI disables Interrupt on `claude` and hides the toggle entirely on `codex` **before** the user picks it, and the MCP tool description states per-provider support; (b) the steer API takes **`onUnsupported: "degrade" | "fail"`, default `"degrade"`** — callers needing true interrupt semantics get a `422` with no row created; (c) the static map must stay in sync with each adapter's `traits.steerModes`, enforced by a test. Default stays `degrade` so messages are never dropped (claude would otherwise fail every Interrupt; codex would lose steering entirely instead of falling back to a follow-up task). Slack always uses `degrade` — it has no good way to surface a 422 mid-thread — but reflects the downgrade in its ack.

### Follow-ups — all resolved

- **§2.1** Claude Code: interrupt is **SDK-only**; raw CLI stream-json is queue-only. → closed by decision 13 (raw-CLI queue-only).
- **§2.2** opencode: mid-run `session.prompt` **queues** (verified, supported); use `promptAsync` for steering writes; steer-mode = `abort`+`prompt` composition.
- Residual, non-blocking (resolve during implementation, not planning): devin behavior while actively `working` vs `waiting_for_user`; pi's exact session-resume verb; Slack `:eyes:` ack/reaction UX and the watcher "steered" marker.
