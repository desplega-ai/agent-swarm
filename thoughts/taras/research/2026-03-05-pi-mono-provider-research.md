---
date: 2026-03-05T00:00:00Z
researcher: OpenCode (gpt-5.3-codex)
git_commit: b952d7e6ff15673b21c6d529ed45a0970a04b8ef
branch: main
repository: agent-swarm
topic: "Add pi-mono as a selectable provider backend with HARNESS_PROVIDER"
tags: [research, codebase, provider, claude-cli, pi-mono, pi-agent-core, openclaw]
status: complete
autonomy: autopilot
last_updated: 2026-03-05
last_updated_by: OpenCode (gpt-5.3-codex)
---

# Research: Add pi-mono as a selectable provider backend with HARNESS_PROVIDER

**Date**: 2026-03-05T00:00:00Z
**Researcher**: OpenCode (gpt-5.3-codex)
**Git Commit**: b952d7e6ff15673b21c6d529ed45a0970a04b8ef
**Branch**: main

## Research Question
Research how to add support for `https://github.com/badlogic/pi-mono` as an alternative provider backend (alongside current Claude CLI flow), selected via `HARNESS_PROVIDER` and backward compatible. Use OpenClaw's pi integration as a reference and ensure capability parity for key behaviors (hooks, skills, task/session lifecycle).

## Summary
The current `agent-swarm` execution path is tightly coupled to Claude CLI process invocation and Claude `stream-json` event parsing, but orchestration layers (polling, task transitions, cancellation contracts, logs/cost persistence APIs) are mostly backend-agnostic. The practical integration seam for `HARNESS_PROVIDER` is in `src/commands/runner.ts`, where provider command construction, event parsing, and session-id persistence are currently hardcoded for Claude.

OpenClaw's integration with pi-mono uses an embedded runtime pattern rather than shelling out: it resolves model/provider/auth, creates an SDK session via `createAgentSession`, subscribes to lifecycle/tool events, and runs policy/hook/skill wiring around that session. This is the most relevant reference pattern if the goal is deeper control of execution flow and capability parity (hooks/skills/lifecycle) instead of a minimal CLI swap.

## Detailed Findings

### Current provider/backend coupling points in `agent-swarm`
- Claude executable and output protocol are hardcoded in runner iteration spawn paths (`src/commands/runner.ts:1091`, `src/commands/runner.ts:1096`, `src/commands/runner.ts:1273`).
- Model selection is already abstract enough to survive backend selection (task-level model -> `MODEL_OVERRIDE` -> default) (`src/commands/runner.ts:1088`).
- Stream parsing assumes Claude event shapes (`type=system/subtype=init`, `type=result`) for session ID and usage/cost capture (`src/commands/runner.ts:1159`, `src/commands/runner.ts:1161`, `src/commands/runner.ts:1369`).
- Session continuity and resume are Claude-specific (`claudeSessionId`, `--resume`) (`src/types.ts:125`, `src/commands/runner.ts:2146`, `src/http/tasks.ts:94`).
- CLI surface remains Claude-branded on direct command path (`src/cli.tsx:567`, `src/claude.ts:10`).

### Existing capability surfaces that are largely backend-agnostic
- Trigger polling and task orchestration through `/api/poll` and runner state are independent of LLM backend (`src/http/poll.ts:25`, `src/commands/runner.ts:2107`).
- Cancellation semantics (API state + runner subprocess kill + hook cancellation checks) already exist as shared lifecycle controls (`src/http/tasks.ts:121`, `src/commands/runner.ts:2088`, `src/hooks/hook.ts:507`).
- Session logs and cost ingest endpoints can accept backend-specific payload adaptation while preserving storage contracts (`src/http/session-data.ts:24`, `src/http/session-data.ts:88`, `src/be/db.ts:177`, `src/be/db.ts:190`).
- Skill guidance is injected through prompt assembly, not provider-specific API contracts (`src/prompts/base-prompt.ts:373`, `src/prompts/base-prompt.ts:75`).

### OpenClaw pi-mono reference architecture
- OpenClaw embeds pi runtime components (`@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`) and creates sessions via SDK (`createAgentSession`) instead of shelling out to a model CLI (OpenClaw `package.json`; pi-mono exports in `packages/coding-agent/src/index.ts`).
- Runtime flow pattern: resolve model/provider/auth -> create `AgentSession` -> subscribe to session/tool/lifecycle events -> enforce app policies -> run prompt attempts with retries/failover (`src/agents/pi-embedded-runner/run.ts`, `src/agents/pi-embedded-runner/run/attempt.ts` in OpenClaw).
- Provider/auth handling is separated from run loop via model registry and env/profile mapping (`src/agents/pi-embedded-runner/model.ts`, `src/agents/model-auth.ts`, `src/agents/models-config*.ts` in OpenClaw).
- Hook-equivalent lifecycle coverage exists through structured plugin events (`before_tool_call`, `after_tool_call`, `session_start`, `session_end`, etc.) and skill prompt assembly (`src/plugins/hook-runner-global.ts`, `src/plugins/types.ts`, `src/agents/skills.ts` in OpenClaw).

### Compatibility implications for `HARNESS_PROVIDER`
- Backward compatibility can be preserved by defaulting `HARNESS_PROVIDER` to current Claude flow, keeping current task schema and lifecycle API unchanged.
- A pi-mono backend would need adapters for:
  - session identity mapping to existing `claudeSessionId` storage field (or a generalized session-id field with compatibility aliasing),
  - usage/cost normalization into existing `/api/session-costs` shape,
  - event/log normalization into existing `/api/session-logs` pipeline,
  - resume semantics equivalent to current parent-task continuity behavior.
- Hook and skill parity is feasible if backend-agnostic lifecycle callbacks are defined in runner and then fed by either Claude stream events or pi SDK events.

### Detailed execution mapping: current Claude steps -> pi-mono steps

This section maps the current end-to-end Claude runtime path to a pi-mono equivalent, with explicit integration seams that are concrete enough to convert into an implementation plan.

#### Phase-by-phase mapping

| Phase | Current Claude implementation | pi-mono target mapping | Notes for planning |
|------|------|------|------|
| Backend selection | Implicit Claude default in runner; no provider switch (`src/commands/runner.ts:1091`) | Add `HARNESS_PROVIDER` resolution early in `runAgent`/iteration setup; default to `claude` when unset | Keep old behavior as default for backward compatibility |
| Model selection | `task.model -> MODEL_OVERRIDE -> opus` (`src/commands/runner.ts:1088`) | Reuse same model-resolution chain; convert selected model into pi model/provider reference for `ModelRegistry` | No behavior change required for existing tasks/schedules |
| Prompt assembly | Existing prompt + system prompt via `--append-system-prompt` (`src/commands/runner.ts:1110`, `src/prompts/base-prompt.ts:373`) | Reuse same prompt builder; pass resulting text into pi session message input instead of CLI arg | Skills/harness instructions remain centralized in prompt builder |
| Session bootstrapping | Spawn Claude process with args (`src/commands/runner.ts:1091`, `src/commands/runner.ts:1273`) | Create embedded pi session (`createAgentSession`) with resolved cwd, auth, model registry, tools | Main architectural difference: process-based vs embedded runtime |
| Tool wiring | Claude executes tools via MCP server + hooks; loop/cancellation checks in hook (`src/hooks/hook.ts:763`) | Register tool adapters in pi session and route tool call lifecycle through same policy callbacks used by hooks | Introduce provider-agnostic lifecycle callback interface |
| Stream/event intake | Parse line-delimited Claude `stream-json` events (`src/commands/runner.ts:1158`) | Subscribe to pi SDK lifecycle/message events and normalize to internal event DTOs | Event-normalization layer is critical abstraction boundary |
| Session identity capture | Extract `session_id` from Claude init event (`src/commands/runner.ts:1161`) | Capture pi session id and store through existing task session update endpoint | Can keep `claudeSessionId` field as compatibility alias initially |
| Resume continuity | Add `--resume <sessionId>` for paused/child tasks (`src/commands/runner.ts:2146`) | Restore or recreate pi session using stored session id/serialized context before continuing task | Need explicit pi resume strategy decision in implementation plan |
| Cost/usage capture | Parse Claude result payload usage and POST `/api/session-costs` (`src/commands/runner.ts:1369`, `src/http/session-data.ts:88`) | Map pi usage metrics to existing `SessionCost` schema and reuse same ingestion endpoint | Define mapping table for token/cache fields and missing fields policy |
| Log persistence | Flush buffered raw events to `/api/session-logs` (`src/commands/runner.ts:585`, `src/http/session-data.ts:24`) | Emit normalized pi events/messages into same session-log API, optionally with provider marker in payload metadata | Avoid schema churn by normalizing before persistence |
| Cancellation handling | API marks task cancelled; runner kills subprocess; hook blocks tool use (`src/commands/runner.ts:2088`, `src/hooks/hook.ts:507`) | Keep API checks identical; on pi backend call session abort/cancel method and route cancel state through same task finish flow | Preserve task-state semantics and stop reasons |
| Completion/failure | Determine success/failure from Claude exit/result and call `/api/tasks/:id/finish` (`src/commands/runner.ts:1651`) | Determine success/failure from pi run result/events and call same finish endpoint | Keep finish contract unchanged to reduce migration risk |

#### Claude-to-pi control-flow translation

1. **Poll and pick work (unchanged orchestration):** keep `/api/poll` trigger flow and task routing unchanged.
2. **Resolve backend:** read `HARNESS_PROVIDER`; if unset/unknown, route to Claude branch to preserve current behavior.
3. **Resolve model/auth/env:** keep current model precedence; add pi auth/provider resolution layer similar to OpenClaw's model/auth split.
4. **Build execution context:** reuse existing prompt + system prompt + task metadata assembly.
5. **Run provider adapter:**
   - Claude branch: existing `Bun.spawn("claude", ...)` + stream parser.
   - pi branch: `createAgentSession(...)` + event subscribers + run loop.
6. **Normalize provider events:** convert both Claude and pi events into one internal runtime event shape (`session_init`, `message`, `tool_start`, `tool_end`, `result`, `error`).
7. **Persist through existing APIs:** session id, logs, costs, and final task status continue to use current HTTP endpoints.
8. **Handle cancellation/resume:** keep existing task cancellation checks and resume lookup logic, with backend-specific execution for cancel/resume operations.

#### Concrete auth/env contract for pi mode

To make implementation plan-ready, pi mode should define explicit auth and env contracts instead of generic "resolve auth" language.

**Resolution precedence (recommended):**
1. Task- or run-specific overrides (future extension).
2. Swarm config resolved env (repo > agent > global) loaded by API/runtime.
3. Process env (`.env`, container env).
4. Provider defaults (only for non-secret values like base URLs).

| Provider path | Required env vars | Optional env vars | Implementation note |
|------|------|------|------|
| pi + Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | Closest behavioral parity with current Claude auth style |
| pi + OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | Good fit for provider/model switching behind one backend |
| pi + OpenAI-compatible (Codex-style) | `OPENAI_API_KEY` | `OPENAI_BASE_URL`, `OPENAI_ORG_ID` | Supports Codex/OpenAI auth flow through pi provider config |
| pi + local/Ollama | none or provider token | `OLLAMA_BASE_URL` | Enables local runs with minimal secret requirements |

**Backend selector envs:**
- `HARNESS_PROVIDER=claude|pi` (default to `claude`)
- Existing model controls remain unchanged (`task.model`, `MODEL_OVERRIDE`)
- Provider-specific envs from the table above are only required when `HARNESS_PROVIDER=pi`

**Concrete bootstrap flow for auth in pi branch:**
1. Resolve `HARNESS_PROVIDER`; branch to pi adapter only when set to `pi`.
2. Resolve target model and infer provider family.
3. Compute required env key set for that provider family.
4. Validate required keys before creating session; fail fast with explicit missing keys.
5. Build pi auth/model registry context with resolved env values.
6. Create `AgentSession` and continue shared execution pipeline.

**Failure policy (important for day-1 usability):**
- Missing required auth env in pi mode should fail deterministically with actionable error output.
- Do not silently fallback from pi to Claude on auth errors; fallback should only happen for unknown provider selection policy, not credential failures.

#### Capability parity checklist (Claude behavior -> pi expectation)

| Capability | Current behavior in codebase | pi parity target |
|------|------|------|
| Auth resolution | Claude auth from existing env/config path used by runner and credential pool helpers (`src/utils/credentials.ts`, `src/http/core.ts:158`) | Keep identical precedence semantics and add pi provider key mapping (`HARNESS_PROVIDER` + provider-specific keys) before session creation |
| Configuration | Runtime model/config values resolved from DB/env scopes and loaded into process env (`src/tools/swarm-config/get-config.ts`, `src/http/core.ts:151`) | Reuse same config source; introduce provider-specific config keys without breaking existing ones (`MODEL_OVERRIDE`, task/schedule model) |
| Hooks | Lifecycle checks + guardrails in hook command path (`src/hooks/hook.ts:660`) | Provider-agnostic lifecycle callbacks invoked from pi events at equivalent points, preserving block/allow decisions and reminder injections |
| Skills | Skill instructions included via base/system prompt (`src/prompts/base-prompt.ts:75`) | Keep same prompt path so skills remain backend-independent |
| Parent/child continuity | Parent task session reuse via stored session id (`src/commands/runner.ts:1988`) | Preserve same parent-task lookup logic; adapt backend-specific restore method |
| Session logging | Raw provider output buffered and persisted (`src/commands/runner.ts:585`) | Normalize pi events and persist with same API contract |
| Cost accounting | Extract usage/cost from result event (`src/commands/runner.ts:1369`) | Provide deterministic metric mapping from pi usage object to existing schema |
| Cancellation | Process kill + hook-time guard (`src/commands/runner.ts:2088`, `src/hooks/hook.ts:507`) | Session abort + same guard semantics at lifecycle callback layer |

#### Concrete hook mapping (Claude hook semantics -> pi event semantics)

| Current hook behavior | Claude path today | pi-mono mapping target |
|------|------|------|
| `SessionStart` setup and status context | Claude hook event `SessionStart` handled in `src/hooks/hook.ts` | Trigger same callback on pi `session_start`/first-run lifecycle event and emit same status text/context |
| `PreToolUse` guardrails and cancellation blocking | Hook evaluates cancellation + loop checks and can return `decision: "block"` (`src/hooks/hook.ts:763`) | On pi `before_tool_call`, run same guard function and return a blocked tool result/interrupt so behavior matches Claude blocking semantics |
| `PostToolUse` reminders/heartbeat | Hook emits reminders and liveness updates on `PostToolUse` (`src/hooks/hook.ts:811`) | On pi `after_tool_call`, call same reminder + heartbeat pipeline |
| `PreCompact` guidance injection | Hook provides compaction reminder path (`src/hooks/hook.ts:738`) | Map to pi auto-compaction lifecycle event and inject equivalent context before compaction |
| `Stop` cleanup/sync | Hook performs sync/offline handling on `Stop` (`src/hooks/hook.ts:921`) | Map to pi session-end/agent-end event and run same cleanup routines |

#### pi-native capabilities to preserve as optional extensions

These are capabilities pi can expose more directly than current Claude stream parsing. They are not required to change v1 behavior, but they should be modeled in the adapter interface so they can be enabled without architectural rework.

- Rich typed lifecycle events (session/tool/message) without stdout parsing.
- Potentially finer-grained tool-call interception for policy decisions before execution.
- Explicit SDK-managed session object with stronger control over abort/resume semantics.
- Provider/model registry abstractions that can reduce backend-specific branching once stabilized.

#### Suggested implementation decomposition (plan-ready)

1. **Introduce provider switch contract**
   - Add a small resolver (`HARNESS_PROVIDER`, default `claude`) and route runner iteration to backend adapters.
   - Keep Claude adapter as-is initially (no behavior change).

2. **Define internal normalized runtime event model**
   - Create provider-neutral event types consumed by logging, cost capture, session-id persistence, and cancellation checks.
   - Add translation functions: Claude event -> normalized event; pi event -> normalized event.

3. **Extract Claude-specific logic into `ClaudeAdapter`**
   - Move spawn, stream parsing, resume arg construction, and result extraction behind an adapter interface.
   - Confirm no functional changes by keeping old command construction.

4. **Implement `PiMonoAdapter`**
   - Initialize `createAgentSession` with model/auth/tools context.
   - Subscribe to lifecycle/tool/message events and emit normalized events.
   - Implement cancel/resume hooks for task lifecycle parity.

5. **Wire shared persistence pipeline once**
   - Keep current HTTP API calls for `/api/session-logs`, `/api/session-costs`, task session-id update, and `/api/tasks/:id/finish`.
   - Ensure both adapters feed identical persistence entry points.
   - Session persistence for pi resume should use a two-level strategy:
     - **DB level (required):** persist session identifier on task (compat field + provider-aware metadata) for parent/child and pause/resume continuity.
     - **Disk level (optional but recommended):** persist provider session snapshots/checkpoints under agent-local storage for fast restoration if pi SDK requires serialized local state.
   - Recovery rule: if disk snapshot is unavailable but DB session id exists, fall back to provider-level rehydrate or start-new-session-with-context path, then continue task safely.

6. **Add compatibility guardrails**
   - Unknown provider falls back to Claude with warning log.
   - Existing envs (`MODEL_OVERRIDE`, credential pooling vars) continue to work unchanged.

7. **Verification gates for migration safety**
   - Run current Claude-path tests unchanged to confirm backward compatibility.
   - Add adapter-level tests asserting event normalization equivalence for logs/cost/session-id/finish semantics.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/commands/runner.ts` | 1088 | Current model resolution chain (task -> env override -> default). |
| `src/commands/runner.ts` | 1091 | Claude executable hardcoded for iteration execution. |
| `src/commands/runner.ts` | 1096 | Claude output protocol hardcoded (`stream-json`). |
| `src/commands/runner.ts` | 1159 | Claude init event detection branch. |
| `src/commands/runner.ts` | 1161 | Session ID extraction and persistence trigger. |
| `src/commands/runner.ts` | 1369 | Claude result event usage/cost extraction path. |
| `src/commands/runner.ts` | 2146 | Claude `--resume` argument injection for continuity. |
| `src/http/tasks.ts` | 94 | API update path for stored Claude session ID. |
| `src/http/session-data.ts` | 24 | Session log ingestion API used by runner. |
| `src/http/session-data.ts` | 88 | Session cost ingestion API used by runner. |
| `src/hooks/hook.ts` | 507 | Hook-side cancellation check used during task execution. |
| `src/prompts/base-prompt.ts` | 373 | System prompt assembly entrypoint (skills/harness guidance surface). |
| `src/cli.tsx` | 567 | CLI command entrypoint for direct Claude command mode. |

## Architecture Documentation
- Current runtime architecture uses one orchestrator (`runAgent`) with backend-specific execution logic embedded in runner iteration helpers.
- Task distribution, trigger polling, cancellation state, logs/cost persistence, and active-session tracking are API-driven and reusable across backends.
- The strongest backend abstraction boundary candidate is: `provider runner adapter` (spawn/stream or embedded session), with normalized outputs into existing task/session APIs.
- OpenClaw demonstrates this adapter boundary by placing provider/model/auth/session decisions ahead of run attempts and treating hooks/skills/lifecycle as policy layers around the embedded session.

## Historical Context (from thoughts/)
- `thoughts/swarm-researcher/research/2026-02-23-openclaw-vs-agent-swarm-comparison.md` documents prior OpenClaw vs agent-swarm lifecycle comparisons, including session continuity and cancellation behavior differences.
- `thoughts/shared/research/2025-12-22-runner-loop-architecture.md` documents runner-level orchestration and where execution responsibilities live today, which aligns with introducing a backend selector at runner boundaries.

## Related Research
- `thoughts/swarm-researcher/research/2026-02-23-openclaw-vs-agent-swarm-comparison.md` - broader lifecycle and architecture comparison between OpenClaw and agent-swarm.
- `thoughts/shared/research/2025-12-22-runner-loop-architecture.md` - runner loop and trigger architecture baseline.

## Open Questions
- Keep `claudeSessionId` for backward compatibility and add provider-aware session metadata for new backends.
- Keep direct CLI command (`agent-swarm claude`) specialized for Claude; make worker/lead runtime backend-selectable via `HARNESS_PROVIDER`.
- Require full compatibility in v1 for pi-mono mode (hooks semantics, skills behavior, resume continuity, logging, costs, cancellation) so it is production-usable from day 1.
