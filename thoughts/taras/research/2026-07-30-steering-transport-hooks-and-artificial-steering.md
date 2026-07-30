---
date: 2026-07-30T15:01:11+0200
researcher: Claude (Fable 5)
git_commit: 0c15fc28f553dcf77e291b49bcdfa3d8c533f177
branch: worktree-research-harness-steering (from main)
repository: agent-swarm
topic: "Steering transport per harness, hook involvement, and possibilities for artificial steering (codex) + pending-steer notices"
tags: [research, steering, harness-providers, hooks, codex, mcp-tools, prompts]
status: complete
autonomy: verbose
last_updated: 2026-07-30
last_updated_by: Claude (Fable 5)
---

# Research: Steering Transport, Hooks, and "Artificial Steering" Possibilities

**Date**: 2026-07-30 15:01 CEST
**Researcher**: Claude (Fable 5)
**Git Commit**: `0c15fc28` (main + brainstorm commit)
**Branch**: `worktree-research-harness-steering`

## Research Question

Three questions from Taras:

1. Codex does not support steering natively, right?
2. How much are we using each harness's hooks to "remind" the agent to handle steers? Could codex get an "artificial" steering via hooks?
3. For the other harnesses, could we proactively tell the agent "FYI, you have a steer pending that you'll receive soon"?

Scope: the shipped PR #1014 implementation (`STEERING_ENABLED`, pre-start queueing, `handledNote`), `src/providers/*`, the three hook surfaces, `docker-entrypoint.sh`. The "possibilities" section was explicitly requested.

## Summary

**Q1 — correct.** Codex has literally zero steering path: `CodexAdapter` implements no `deliverSteering` method at all, `traits.steerModes` is `[]` (`src/providers/codex-adapter.ts:1742`, comment: "Decision 4: Codex never accepts live steering"), and the server mirrors that in `PROVIDER_STEER_CAPABILITIES.codex = []` (`src/types.ts:403`). Consequence: `requestSteering()` promotes a codex steer to a follow-up task **synchronously inside the same request** (`src/be/steering.ts:231-243`) — the row is born `promoted`, never becomes `pending`, and the worker's dispatch poll never sees it. The running codex process is completely unaware anything happened; "steering codex" today is functionally "create a child task."

**Q2 — hooks are used exactly zero for steering.** `grep -i steer` across all three hook surfaces (`src/hooks/hook.ts`, `src/providers/pi-mono-extension.ts`, `plugin/opencode-plugins/agent-swarm.ts`) returns nothing. Steering delivery is a completely separate transport: the worker's main loop polls `GET /api/steering-messages?taskId=` once per loop iteration per active task (`src/commands/runner.ts:5413-5427`) and calls the provider adapter's `deliverSteering()` directly on the live session object. The "remind the agent" work is done prompt-side instead: (a) the `system.agent.steering` section in the base system prompt, gated on `STEERING_ENABLED` + `traits.steerModes` non-empty + `serverCapabilities` including `core` (`src/prompts/base-prompt.ts:195-203`; pinned by `steering-transport.test.ts:326-352`); (b) the delivery envelope itself (`system.agent.steering.delivery` template, `src/prompts/session-templates.ts:217-228`), which embeds the message ID and the instruction to call `accept-steer` after acting on it; (c) the resume context preamble, which lists undelivered `pending`/`promoted` steers when building a resume task's prompt (`src/commands/context-preamble.ts:372-483`).

**Q3 — feasible, and the plumbing half-exists.** There are three realistic notice/injection channels that don't require any harness to gain new native capability: the central `NUDGES` map on MCP tool results (harness-agnostic, reaches codex too), harness-native hook injection (claude/pi/opencode have blocking or context-injecting hook points already wired; codex's own hook system is enabled in our config but unused by swarm code), and the existing dispatch-poll loop. The main design caveat: for queue-capable harnesses a "you'll receive a steer soon" pre-notice is mostly redundant (the steer text itself arrives at the same turn boundary the notice would); the notice idea only pays off where delivery is impossible (codex, gate-failed claude sessions) — and in those channels, if we can deliver a notice we can usually deliver the steer text itself, making the notice channel the transport. Details in "Possibilities" below.

**Post-review addendum**: follow-up research (review round 1) resolved the codex unknown — Codex CLI 0.146.0 (our exact pin) has a stable 9-event hook system with working `additionalContext` injection (proven locally by the context-mode plugin), a `Stop` hook that can block-and-continue the model, and — the headline — a native **`turn/steer`** mid-turn input-injection method in its app-server JSON-RPC protocol, currently unexposed by the `@openai/codex-sdk` we wrap. "Artificial steering for codex" is therefore not just feasible; a *native* path exists one layer below our SDK. See §4a.

## Detailed Findings

### 1. Core lifecycle (PR #1014, shipped, default-off)

Single write path `requestSteering()` (`src/be/steering.ts:163-251`), used by all five surfaces: agent-MCP `steer-task` (`src/tools/steer-task.ts:56-121`), user-MCP variant (`src/server-user.ts:167-181`), HTTP `POST /api/tasks/{id}/steer` (`src/http/tasks.ts:776-828`), Script SDK `task_steer`, and Slack thread steering (`src/slack/steering.ts:34-54`, gated by `SLACK_THREAD_STEERING=lead|all` + `SLACK_THREAD_STEERING_MODE`).

- **Table**: `task_steering_messages` (migration 121), status `pending → delivered → handled`, with `promoted`/`cancelled` branches; `handled_note` added by migration 122. Zod: `SteeringMessageSchema` (`src/types.ts:350-367`).
- **Flag**: `STEERING_ENABLED`, default **false** (`src/utils/steering-enabled.ts:10-12`, placed outside `src/be` so worker code can read it without crossing the DB boundary). Gates: request path (403 before any row, `steering.ts:164-169`), MCP tool registration on both servers, Slack path, worker polling, resume-preamble section. Deliberately NOT gated: history reads and worker drain callbacks (`/delivered`, `/handled`, `/undeliverable`) so in-flight messages reach terminal state after a kill-switch flip (`src/http/tasks.ts:831-955` comments). It's also one of the live-reconciled env keys the runner re-reads per poll without restart (`runner.ts:786-805`).
- **Pre-start queueing**: tasks in `unassigned`/`offered`/`pending` accept queued steers; the row stays `pending` until the session goes live. `steer` mode on a pre-start task degrades to `queue` ("nothing to interrupt yet", `steering.ts:199-219`). Paused tasks auto-resume first (`steering.ts:193-196`).
- **Degradation**: `onUnsupported: "degrade"` (default) silently downgrades `steer → queue`; `"fail"` returns 422 with **no row created**. The persisted row records the *requested* mode; `delivered_mode` records what actually happened.
- **Promotion** (steer → follow-up task) happens on three paths: (a) synchronously at request time when the provider can never reach a live session (codex); (b) worker reports `/undeliverable` (adapter missing/failed); (c) terminal sweep — `completeTask`/`failTask`/`cancelTask` (`src/be/db.ts:2516/2577/2645`) and heartbeat crash-recovery supersede (`src/heartbeat/heartbeat.ts:481`) promote all still-pending steers, bypassing `followUpConfig.disabled`.
- **Heartbeat interplay**: a fresh pending steer (younger than `HEARTBEAT_STEERING_GRACE_MIN`, default 5 min) defers stall remediation for the task (`heartbeat.ts:314-338`).
- **`handledNote`**: the assigned agent acknowledges via `accept-steer` (`src/tools/accept-steer.ts:62-125`; explicit assignment check, not RBAC; idempotent) with optional `note` (max 500 chars, scrubbed). Only `delivered → handled` transitions are allowed. Surfaces in the UI steering chips' tooltip in italics (`apps/ui/src/components/steering/steering-message-chips.tsx:93-119`), on the 5s REST poll (no websocket).

### 2. Per-harness transport matrix

Contract: `ProviderSession.deliverSteering?` is optional; absence = "cannot accept mid-run input" (`src/providers/types.ts:127-141`). Server-side mirror `PROVIDER_STEER_CAPABILITIES` (`src/types.ts:390-404`) must stay in sync with each adapter's `traits.steerModes` — enforced by `src/tests/provider-steering-capabilities.test.ts`, not convention.

| Harness | Declared modes | Transport | True mid-turn interrupt? | Notes |
|---|---|---|---|---|
| **pi** | `["steer","queue"]` | Native SDK: `agentSession.steer(text)` / `followUp(text)` (`pi-mono-adapter.ts:1045-1058`) | **Yes** (only local harness with it) | Fails closed if session ended |
| **claude-managed** | `["steer","queue"]` | Anthropic SDK `sessions.events.send` with `user.message` events (`claude-managed-adapter.ts:341-351`) | Yes (ordered event stream into cloud session) | Reports back the requested mode |
| **claude** | `["queue"]` | JSON `user` message written to child stdin (`stream-json`) (`claude-adapter.ts:662-689`) | No — queued at next turn boundary | **Per-session gate**: CLI ≥ 2.1.205, not tmux/bridge-wrapped, `CLAUDE_QUEUE_STEERING` override (`claude-adapter.ts:91-125, 1212-1257`). Gate fails → no `deliverSteering` → promoted |
| **opencode** | `["queue"]` | `client.session.promptAsync` regardless of requested mode (`opencode-adapter.ts:637-660`) | No | abort+re-prompt "steer" was lossy in E2E, abandoned |
| **devin** | `["queue"]` | REST `sendMessage` to Cognition API (`devin-adapter.ts:217-230`) | No — accepts message during `working`, no interrupt guarantee | `mode` param not even destructured |
| **codex** | `[]` | **None** — no `deliverSteering` exists | No | Promoted synchronously server-side at request time; worker poll never involved (`steering-transport.test.ts:207-231`) |

Worker dispatch: `pollAndDispatchSteering` (`runner.ts:513-586`) per active task per main-loop tick; per-boot `dispatchedIds` set prevents double-delivery; adapter errors are secret-scrubbed before being reported `/undeliverable`; the reported mode is the adapter's **actual** delivery mode, not the requested one. Missing `deliverSteering` on a live session synthesizes "Provider session does not support live steering" → promotion (this is the path a gate-failed claude session takes).

### 3. Hooks: what exists per harness, and their (non-)role in steering

Three behaviorally-mirrored lifecycle-hook implementations exist — **none mentions steering**:

- **claude** — `src/hooks/hook.ts`, one script for 6 events. `SessionStart` (CLAUDE.md write, lead concurrent-session awareness), `PreCompact` (goal reminder), `PreToolUse` (**blocks** with `{"decision":"block","reason":...}` on task cancellation / tool loops / poll-limit — reason text reaches the model), `PostToolUse` (heartbeat, identity/memory sync, lead post-`send-task` reminder), `UserPromptSubmit` (cancellation re-check), `Stop` (sync, session summary, `/close`).
- **pi** — `src/providers/pi-mono-extension.ts` (`createSwarmHooksExtension`), 1:1 parity by design: `session_start`/`tool_call` (can return `{block:true,reason}`)/`tool_result`/`context`/`input`/`session_shutdown`.
- **opencode** — `plugin/opencode-plugins/agent-swarm.ts` in-process plugin: `tool.execute.before` (blocks by **throwing**), `tool.execute.after`, `event` (file.edited / session.idle), `experimental.chat.system.transform` (injects into system prompt), `experimental.session.compacting` (goal reminder into context).
- **codex** — no swarm hook at all. Swarm behavior rides an in-process `ProviderEvent` listener (`src/providers/codex-swarm-events.ts` + `src/providers/swarm-events-shared.ts:237-278`): `tool_start` → throttled cancellation poll + tool-loop check, but can only **abort the whole turn via AbortController** — "Codex's SDK lacks a preToolUse blocking hook" (`codex-swarm-events.ts:17-21`). No goal-reminder, no session-start injection. Notably, `~/.codex/config.toml` **does** bake `features: { hooks: true, plugin_hooks: true }` (`codex-adapter.ts:475-493`) — enabled for the context-mode plugin ("routing injection, PreToolUse safety blocks") — i.e. codex's *own* hook system is on, we just don't use it for swarm behaviors.
- **docker-entrypoint.sh** — provider branches only do credentials/config seeding; zero steering content. `STEERING_ENABLED` is deliberately not baked at boot: it's in the runner's live-reconciled key list.

Where the "remind about steers" work actually lives today (all prompt-side, not hooks):

1. **Base system prompt** — `getBasePrompt()` resolves the `system.agent.steering` template (`session-templates.ts:199-209`) programmatically at `src/prompts/base-prompt.ts:202`, only when `isSteeringEnabled()` AND `traits.steerModes` is non-empty AND `serverCapabilities` includes `core` (`base-prompt.ts:195-203`; pinned by `steering-transport.test.ts:326-352`). So the static "you may receive steering messages… act, then `accept-steer`" block is env-gated exactly as intended. Codex never gets it (empty modes).
2. **Delivery envelope** — `system.agent.steering.delivery` (`session-templates.ts:217-228`): `[steering <id>] <body>` + "Once you have acted on this, call accept-steer…". Rendered by `renderSteeringDelivery` (`runner.ts:498-511`); falls back to the bare body on template failure ("delivering an un-acknowledgeable message beats not delivering one at all").
3. **Resume preamble** — "Undelivered Steering Messages" section when building resume-task prompts (`context-preamble.ts:372-483`), gated on the flag.
4. Note: `system.agent.steering` is not referenced via `{{@template[...]}}` from any `system.session.*` composite — inclusion happens only through the programmatic base-prompt resolution in (1). (An earlier draft of this doc mis-read that as "dormant"; corrected in review round 1.)

### 4. Possibilities (explicitly requested)

#### 4a. "Artificial" steering for codex

**Updated after review-round-1 research (web + local plugin inspection). We ship Codex CLI 0.146.0 everywhere** (`Dockerfile.worker:134` ARG, `@openai/codex-sdk ^0.146.0` in `package.json:156`, host CLI 0.146.0; pin sync enforced by `scripts/check-codex-default-model.sh` + CI). Hooks went **stable upstream in v0.124.0** — we are well past it. Ranked options:

1. **`turn/steer` — codex's own native mid-turn steering (the real prize).** The Codex app-server JSON-RPC protocol (which `@openai/codex-sdk` drives via a child process — `codex-adapter.ts:4-5`) has a first-class `turn/steer` method: "appends user input to the active in-flight turn" (plus `turn/interrupt`). Sources: [codex-rs/app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), [developers.openai.com/codex/app-server](https://developers.openai.com/codex/app-server). That's semantically *stronger* than claude's queue-only stdin. **Blocker**: the TS SDK doesn't expose it — `Thread` only has `run()`/`runStreamed()` ([openai/codex#12329](https://github.com/openai/codex/issues/12329), open). Paths: upstream PR to the SDK, or a thin vendored extension speaking the JSON-RPC method to the SDK's child process. If wired, codex flips to `["steer","queue"]`-class support and the "Decision 4" promotion disappears.
2. **Codex-native hooks (proven locally, protocol verified in working code).** Codex 0.146.0 supports 9 hook events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, PostCompact, SubagentStart, SubagentStop, Stop; JSON on stdin → JSON on stdout; exit 2 = hard block with stderr fed to the model). The **context-mode codex plugin on this machine demonstrates injection working**: its SessionStart hook returns `{hookSpecificOutput: {hookEventName, additionalContext}}` with a routing block + session directives (`~/.codex/plugins/cache/context-mode/context-mode/1.0.169/hooks/codex/sessionstart.mjs:39-93`), and its PreToolUse formatter emits an `additionalContext` shape via a `context` action (`hooks/core/formatters.mjs:65-69`). Per upstream docs/issues: `UserPromptSubmit` + `SessionStart` `additionalContext` confirmed; `PostToolUse` `additionalContext` reported supported; `PreToolUse` `additionalContext` is contested upstream ([#19385](https://github.com/openai/codex/issues/19385) says rejected, fix PR [#20692](https://github.com/openai/codex/pull/20692)) — but PreToolUse block-with-reason definitely reaches the model. A swarm `hooks.json` (we bake `features = {hooks, plugin_hooks}` already but install **no swarm hooks for codex today**) could poll `GET /api/steering-messages?taskId=` on PostToolUse and deliver the steer body as `additionalContext` → effective `["queue"]` for codex, using the exact endpoint + envelope the runner already uses. Needs a small hands-on spike to confirm which events honor `additionalContext` at exactly 0.146.0.
3. **Codex Stop-hook gate** — Codex's `Stop` hook, when it blocks, "feeds your reason back to the model and asks it to continue": the "don't finish while a pending steer exists" gate (see 4b) is available *natively on codex*, independent of options 1-2.
4. **MCP tool-result nudge** (cheapest, universal — see 4b). Reaches codex with zero codex-specific work, but only fires when the agent happens to call a swarm MCP tool.
5. **The in-process event listener** (`swarm-events-shared.ts`) is *not* a viable injection channel — it observes and aborts; it has no path to put text into codex's conversation.

Server-side consequence of any of these: flipping `PROVIDER_STEER_CAPABILITIES.codex` to non-empty + adding `deliverSteering` (or a hook-based delivery seam) changes `canReachLiveSession` and stops the synchronous promotion — the existing degrade/promote ladder then handles failures for free (undeliverable → promoted is already idempotent and tested).

#### 4a-bis. Hands-on spike results (2026-07-30, codex-cli 0.146.0, isolated `CODEX_HOME=/tmp/codex-spike-home`, Taras-approved trust bypass)

Probe: a single hook script registered for 5 events, each logging its stdin payload and emitting `additionalContext: "MAGIC-<event>-<n>"` (Stop: one-time `{"decision":"block","reason":"MAGIC-STOP-13: …"}`). Prompt asked the model to run one command and report every `MAGIC-*` string visible in its context. **Empirical matrix:**

| Event | `additionalContext` reaches model? | Payload fields received |
|---|---|---|
| SessionStart | **YES** | cwd, session_id, source, model, transcript_path |
| UserPromptSubmit | **YES** | + prompt, turn_id |
| **PostToolUse** | **YES** ← the steering delivery channel | + tool_name, tool_input, tool_response, tool_use_id, turn_id |
| PreToolUse | **NO** (hook fires, context silently dropped — confirms [#19385](https://github.com/openai/codex/issues/19385)) | + tool_name, tool_input, tool_use_id, turn_id |
| Stop (block) | **YES** — model was blocked, continued, and complied with the reason text | + last_assistant_message, stop_hook_active, turn_id |

Two operational findings:

- **Hook trust gate**: hooks are **silently skipped** unless each hook has a `trusted_hash` entry under `[hooks.state]` in `config.toml` (hash format unidentified; not sha256 of the bare command string). `codex exec --dangerously-bypass-hook-trust` (documented "intended only for automation that already vets hook sources") makes them run; the bypass is per-invocation, nothing is auto-persisted. Worker-image consequence: either seed correct `trusted_hash` entries at build time (format TBD from codex-rs source) or inject the flag — note `@openai/codex-sdk` builds its own fixed argv, so the flag would go in via an executable shim (`codexPathOverride`-style), not SDK options.
- **`turn/steer` is NOT reachable through our SDK** — despite `codex-adapter.ts:4-5`'s comment saying the SDK "drives the codex app-server", `@openai/codex-sdk@0.146.0` actually spawns **`codex exec --experimental-json`**, writes the prompt to stdin and immediately closes it (`dist/index.js:174,262-263`), reading JSONL from stdout. No JSON-RPC channel, no open stdin, no `steer` in the SDK's type surface (grep: zero hits). Using `turn/steer` would mean replacing the transport with our own `codex app-server` JSON-RPC client — a much bigger lift than hooks.

**Conclusion**: the pragmatic codex fix is **hook-based queue delivery on PostToolUse** (+ optional Stop-gate), with `turn/steer` as a future upgrade if/when the SDK exposes it ([#12329](https://github.com/openai/codex/issues/12329)).

Caveat on sourcing for the upstream-docs claims in §4a: search snippets + GitHub issues (WebFetch was unavailable during web research) — but the load-bearing rows of the matrix above are now verified empirically at our exact pinned version.

#### 4b. Proactive "you have a steer pending" notice

- **Central `NUDGES` map on MCP tool results** (`src/tools/utils.ts`; the registrar composes conditional one-sentence steers onto results already). A registrar-level check — "does the calling agent's active task have a pending steering row?" — could append "FYI: a steering message is pending for task X" to any tool result. Harness-agnostic: works for codex, gate-failed claude, everything. Cost: one DB lookup per tool call (cheap: partial index `idx_task_steering_messages_pending` exists precisely for `(task_id, status='pending')`); frequency: only as often as the agent calls swarm tools.
- **Hook-side notice** for claude/pi/opencode: `PostToolUse`/`tool_result`/`tool.execute.after` already do fire-and-forget HTTP per tool call — adding a pending-steer check there is mechanically trivial and the claude/pi block channels can even carry the notice text.
- **Honest assessment of value**: for queue-capable harnesses the notice is largely redundant — the dispatch poll delivers the actual steer text at the same cadence (per main-loop tick) that any notice would arrive, and it lands at the same turn boundary. The notice only adds value where **delivery is impossible** (codex today, gate-failed claude) — and in exactly those channels, if the notice text can reach the model, the steer body itself can, making "notify" collapse into "deliver" (option 4a). The one genuinely distinct use for a pre-notice: pi's true `steer` mode aside, an agent about to conclude a long turn could be told "check/wait for pending steering before finishing" — i.e. a *Stop-hook* gate ("don't stop while a pending steer exists") is the variant that does something the current transport can't. No such Stop-hook check exists today.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/be/steering.ts` | 163-251 | `requestSteering` — sole write path; degrade ladder, pre-start queueing, sync promotion for codex |
| `src/types.ts` | 390-404 | `PROVIDER_STEER_CAPABILITIES` (codex `[]`); sync with adapter traits enforced by test |
| `src/providers/types.ts` | 127-141 | `deliverSteering?` optional contract; absence = no mid-run input |
| `src/providers/codex-adapter.ts` | 1742 | `steerModes: []`, "Decision 4" comment; no `deliverSteering` anywhere in the class |
| `src/providers/codex-adapter.ts` | 475-493 | `features: { hooks: true, plugin_hooks: true }` in baked codex config (unused by swarm code) |
| `src/providers/claude-adapter.ts` | 91-125, 1212-1257, 662-689 | Queue-steering version/wrapper gate + stdin `stream-json` delivery |
| `src/providers/pi-mono-adapter.ts` | 1045-1058 | Native `steer()`/`followUp()` |
| `src/providers/opencode-adapter.ts` | 637-660 | `promptAsync` always-queue delivery |
| `src/providers/devin-adapter.ts` | 217-230 | REST `sendMessage`, mode ignored |
| `src/providers/claude-managed-adapter.ts` | 341-351 | `sessions.events.send` user.message delivery |
| `src/commands/runner.ts` | 477-586, 5413-5427 | Dispatch state, envelope rendering, per-tick poll-and-deliver loop |
| `src/providers/codex-swarm-events.ts` | 17-21 | "Codex's SDK lacks a preToolUse blocking hook" — abort-only channel |
| `src/hooks/hook.ts` | 919-1239 | All 6 claude hook events — zero steering mentions |
| `src/providers/pi-mono-extension.ts` | 405-655 | Pi extension events (blockable `tool_call`) — zero steering mentions |
| `plugin/opencode-plugins/agent-swarm.ts` | 226-343 | Opencode plugin hooks — zero steering mentions |
| `src/prompts/session-templates.ts` | 199-228 | `system.agent.steering` (registered, unreferenced) + delivery envelope template |
| `src/commands/context-preamble.ts` | 372-483 | Resume preamble "Undelivered Steering Messages" section |
| `src/tools/accept-steer.ts` | 62-125 | Acknowledgement + `handledNote` (≤500 chars, scrubbed, idempotent) |
| `src/tools/utils.ts` | — | Central `NUDGES` map (candidate channel for pending-steer notice) |
| `src/be/migrations/121_task_steering_messages.sql` | 5-24 | Table + partial pending index |
| `src/heartbeat/heartbeat.ts` | 314-338, 481 | Steering stall-grace window; crash-recovery promotion sweep |
| `src/tests/steering-transport.test.ts` | 97-352 | Transport pins: once-only delivery, actual-mode reporting, codex pre-poll promotion, prompt gating |
| `runbooks/harness-providers.md` | 43-71 | Per-provider delivery table + claude gate + capability-sync test doc |
| `docs-site/.../guides/task-steering.mdx` | 8-141 | User-facing modes, fallback ladder, lifecycle state machine |

## Open Questions

- ~~Does the codex CLI hook API support context injection?~~ — **ANSWERED (review round 1)**: yes, with per-event nuance — see the rewritten §4a. Codex 0.146.0 (our pin) has stable hooks with `additionalContext` injection (SessionStart/UserPromptSubmit confirmed; PostToolUse reported; PreToolUse contested upstream, block-with-reason always works), demonstrated working locally by the context-mode codex plugin. Bigger discovery: the app-server protocol has a native **`turn/steer`** mid-turn injection method, unexposed by the TS SDK ([#12329](https://github.com/openai/codex/issues/12329)). Spike completed same day (see §4a-bis): PostToolUse/UserPromptSubmit/SessionStart inject; PreToolUse does not; Stop-block works; hooks need trust seeding or the bypass flag; `turn/steer` unreachable through the SDK (it runs `codex exec`, not app-server). Decision: hook-based queue delivery.
- ~~Whether `system.agent.steering` is dormant~~ — **RESOLVED (review round 1)**: the template is NOT dormant. `getBasePrompt()` resolves it programmatically via `resolveTemplateAsync("system.agent.steering", {})` at `src/prompts/base-prompt.ts:202`, gated on `isSteeringEnabled() && steerModes.length > 0 && serverCapabilities.includes("core")` (`base-prompt.ts:195-203`) — i.e. it already IS included based on env, exactly as intended. The earlier "unreferenced" claim came from only checking `{{@template[...]}}` references inside `session-templates.ts` composites, missing the programmatic resolution.
- ~~Nudge frequency/dedup semantics~~ — **DECIDED (Taras, review round 1)**: if the `NUDGES` pending-steer notice is built, it must be **one-shot per steering message** — no repeating it on every tool call until handled ("no polluting").

## Appendix

- **Architecture notes**: capability declaration lives in adapter `traits.steerModes`, mirrored server-side and drift-guarded by test; enforcement is entirely server-side in `requestSteering`; delivery is worker-side via the main poll loop, entirely bypassing the hook systems; every failure path funnels into idempotent promotion-to-follow-up.
- **Historical context (from thoughts/)**: `thoughts/taras/research/2026-07-24-harness-steering.md` — the pre-implementation research that produced PR #1014's design (Decision 4 = codex promotes; identified cancellation-block as the one proven live-injection channel and pi's `steer()` as the richest primitive). Its "codex has no upstream primitive" claim predates `features.hooks` being enabled in our codex config.
- **Related research**: `thoughts/taras/plans/` PR #1014 planning docs; memory note `project_harness_steering`.
