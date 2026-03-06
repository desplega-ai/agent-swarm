---
date: 2026-03-05
planner: OpenCode (gpt-5.3-codex)
branch: main
repository: agent-swarm
topic: "HARNESS_PROVIDER runtime adapters (claude + pi-mono)"
tags: [plan, provider, runner, pi-mono, hooks, session-lifecycle, compatibility]
status: in_progress
autonomy: autopilot
research: thoughts/taras/research/2026-03-05-pi-mono-provider-research.md
last_updated: 2026-03-05
last_updated_by: OpenCode (gpt-5.3-codex)
---

# HARNESS_PROVIDER Runtime Adapter Implementation Plan

## Overview

Add a provider adapter architecture to `runAgent()` so runtime execution can be selected by `HARNESS_PROVIDER=claude|pi` (default `claude`) without breaking existing behavior. The Claude path must remain functionally identical, while a new pi-mono adapter is introduced with parity for hooks, skills, session lifecycle, cancellation, logs, costs, and parent/child continuity.

## Current State Analysis

### Runtime is currently Claude-coupled
- Claude invocation is hardcoded in both execution paths:
  - `runClaudeIteration()` command construction (`src/commands/runner.ts:1090`)
  - `spawnClaudeProcess()` command construction (`src/commands/runner.ts:1272`)
  - hardcoded `--output-format stream-json` (`src/commands/runner.ts:1096`)
- Claude stream parsing drives session and telemetry:
  - session init detection (`src/commands/runner.ts:1159`, `src/commands/runner.ts:1359`)
  - cost extraction from `result` events (`src/commands/runner.ts:1369`)
  - stale resume retry logic (`src/commands/runner.ts:1550`)

### Lifecycle orchestration is reusable across providers
- Shared runner orchestration already exists in:
  - `runAgent()` (`src/commands/runner.ts:1656`)
  - completion/finalization in `checkCompletedProcesses()` + `ensureTaskFinished()` (`src/commands/runner.ts:1593`, `src/commands/runner.ts:240`)
  - cancellation scan in polling loop (`src/commands/runner.ts:2066`)
- Shared persistence APIs are backend-agnostic:
  - logs: `POST /api/session-logs` (`src/http/session-data.ts:24`)
  - costs: `POST /api/session-costs` (`src/http/session-data.ts:88`)
  - finish: `POST /api/tasks/:id/finish` (`src/http/tasks.ts:188`)

### Session continuity is Claude-shaped but adaptable
- Task stores `claudeSessionId` (`src/types.ts:125`, `src/be/migrations/001_initial.sql:98`).
- Resume behavior uses `--resume` with own session first, then parent session (`src/commands/runner.ts:1980`, `src/commands/runner.ts:2136`).
- Session persistence endpoint is Claude-specific by name (`PUT /api/tasks/:id/claude-session`, `src/http/tasks.ts:93`).

### Hook parity constraints to preserve
- Hooks rely on `TASK_FILE` + cancellation checks against `/cancelled-tasks` (`src/hooks/hook.ts:96`, `src/hooks/hook.ts:507`).
- Pre/post tool semantics are implemented in `src/hooks/hook.ts` and must still trigger at equivalent lifecycle moments for pi-backed runs.

## Desired End State

1. `HARNESS_PROVIDER` resolves provider at runtime with this policy:
   - `claude` when unset
   - `claude` with warning when unknown
   - `pi` only when explicitly configured
2. Runner executes via provider adapter interface (`ClaudeAdapter`, `PiMonoAdapter`).
3. Both adapters emit normalized runtime events consumed by a single persistence/finalization path.
4. Claude behavior remains unchanged for existing deployments.
5. Pi mode fails fast on missing required auth for selected provider family (no silent fallback).
6. Parent/child continuity, pause/resume, cancellation, logs, and costs work with parity-level behavior.

## Quick Verification Reference

Common commands:
- `bun run lint:fix`
- `bun run tsc:check`
- `bun test`
- `bun test src/tests/runner*.test.ts`
- `bun test src/tests/task-cancellation.test.ts`
- `bun test src/tests/task-pause-resume.test.ts`
- `bun test src/tests/session-attach.test.ts`
- `bun test src/tests/session-logs.test.ts`
- `bun test src/tests/session-costs.test.ts`

Key files:
- `src/commands/runner.ts`
- `src/commands/providers/claude-adapter.ts` (new)
- `src/commands/providers/pi-mono-adapter.ts` (new)
- `src/commands/providers/types.ts` (new)
- `src/http/tasks.ts`
- `src/http/session-data.ts`
- `src/be/db.ts`
- `src/types.ts`
- `src/tests/runner*.test.ts` and new provider-focused tests

## What We're NOT Doing

- Replacing direct `agent-swarm claude` command UX.
- Redesigning UI to choose providers.
- Changing existing external API shapes for session logs/costs.
- Shipping advanced pi-native enhancements (beyond parity-safe lifecycle mapping) in v1.

## Implementation Approach

Use a compatibility-first extraction:
- First isolate existing Claude logic behind an adapter with no behavior changes.
- Then introduce normalized runtime events and shared telemetry persistence.
- Add pi adapter behind `HARNESS_PROVIDER=pi`.
- Add targeted parity tests and explicit env failure behavior.

---

## Phase 1: Provider Selection Contract + Adapter Interfaces

### Overview
Define provider selection and adapter contracts without altering behavior.

### Changes Required

#### 1. Add provider selection resolver
**File**: `src/commands/runner.ts`
**Changes**:
- Add `resolveHarnessProvider(freshEnv): "claude" | "pi"` near env resolution helpers.
- Resolve from `HARNESS_PROVIDER` after `fetchResolvedEnv()` (so config precedence works).
- Unknown value policy: log warning and return `claude`.

#### 2. Introduce adapter contracts
**File**: `src/commands/providers/types.ts` (new)
**Changes**:
- Define `ProviderAdapter` interface with methods:
  - `startRun(context): Promise<ProviderRunHandle>`
  - `cancel(runHandle): Promise<void>`
  - `buildResumeContext(task, parentTask): ProviderResumeContext`
- Define normalized runtime event union (minimum):
  - `session_init`
  - `stream_line`
  - `result`
  - `stderr`
  - `provider_error`
  - `process_exit`

#### 3. Add provider-aware task runtime metadata (compat-safe)
**File**: `src/types.ts`
**Changes**:
- Add optional runtime metadata type for provider/session without removing `claudeSessionId`.
- Keep `claudeSessionId` unchanged for backward compatibility.

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes: `bun run tsc:check`
- [x] Lint/format passes: `bun run lint:fix`
- [x] Existing runner tests pass unchanged: `bun test src/tests/runner*.test.ts`

#### Manual Verification:
- [ ] With no `HARNESS_PROVIDER`, runtime resolves to `claude`.
- [ ] With invalid `HARNESS_PROVIDER=foo`, runtime warns and still uses `claude`.

**Implementation Note**: This phase must be behavior-preserving; no runtime flow changes beyond selection scaffolding.

---

## Phase 2: Extract ClaudeAdapter with Zero Functional Delta

### Overview
Move Claude-specific process and stream-json parsing logic out of `runner.ts` into a dedicated adapter.

### Changes Required

#### 1. Move command construction and subprocess handling
**File**: `src/commands/providers/claude-adapter.ts` (new)
**Changes**:
- Lift logic currently in:
  - `runClaudeIteration()` (`src/commands/runner.ts:1079`)
  - `spawnClaudeProcess()` (`src/commands/runner.ts:1257`)
- Preserve exact command args:
  - `claude --model ... --verbose --output-format stream-json ...`
- Preserve `TASK_FILE` semantics.

#### 2. Move Claude event parsing into adapter event emission
**File**: `src/commands/providers/claude-adapter.ts` (new)
**Changes**:
- Parse per-line JSON exactly as current implementation does.
- Emit normalized events for:
  - session init and id extraction
  - result/cost payload
  - stderr and JSON parse failures

#### 3. Keep runner orchestration unchanged
**File**: `src/commands/runner.ts`
**Changes**:
- Replace direct Claude subprocess calls with adapter invocation.
- Keep existing `checkCompletedProcesses()` flow and finish semantics.

### Success Criteria:

#### Automated Verification:
- [x] Runner lifecycle tests pass: `bun test src/tests/runner*.test.ts`
- [x] Cancellation tests pass: `bun test src/tests/task-cancellation.test.ts`
- [x] Typecheck passes: `bun run tsc:check`

#### Manual Verification:
- [ ] Diff inspection confirms no changes to Claude command flags.
- [ ] Default runtime still creates session logs and costs in same format.

**Implementation Note**: Stop after this phase and verify Claude parity before introducing pi execution.

---

## Phase 3: Shared Normalization + Persistence Pipeline

### Overview
Centralize how provider events are converted into session-id updates, logs, costs, and final status.

### Changes Required

#### 1. Introduce event-to-persistence mapper
**File**: `src/commands/runner.ts` (or `src/commands/providers/runtime-normalizer.ts` new)
**Changes**:
- Build one handler that consumes normalized events and triggers:
  - `saveClaudeSessionId()` (compat path for now)
  - `flushLogBuffer()`
  - `saveCostData()`
  - failure reason enrichment via `SessionErrorTracker`

#### 2. Preserve existing API contracts
**File**: `src/http/session-data.ts` (validate only)
**Changes**:
- No schema changes required; ensure adapter pipeline supplies existing fields.
- Continue sending `cli` label (`"claude"` for current adapter; `"pi"` for new one).

#### 3. Add dedicated normalization tests
**File**: `src/tests/runner-provider-normalization.test.ts` (new)
**Changes**:
- Verify normalized `session_init` stores session id.
- Verify normalized `result` stores cost data mapping.
- Verify line buffering behavior remains consistent.

### Success Criteria:

#### Automated Verification:
- [x] Session logs tests pass: `bun test src/tests/session-logs.test.ts`
- [x] Session costs tests pass: `bun test src/tests/session-costs.test.ts`
- [x] New normalization tests pass: `bun test src/tests/runner-provider-normalization.test.ts`

#### Manual Verification:
- [ ] `session_logs` rows still include expected line ordering and `cli` value.
- [ ] `session_costs` rows still persist token defaults and totals correctly.

**Implementation Note**: Do not change HTTP payload contracts in this phase.

---

## Phase 4: PiMonoAdapter + Auth/Model Resolution

### Overview
Implement pi execution path behind `HARNESS_PROVIDER=pi` with explicit auth resolution and deterministic failures.

### Changes Required

#### 1. Add pi dependencies and adapter
**File**: `package.json`
**Changes**:
- Add required pi packages used by adapter (pin exact versions during implementation).

**File**: `src/commands/providers/pi-mono-adapter.ts` (new)
**Changes**:
- Create session via pi API (embedded mode).
- Subscribe to lifecycle/tool/message events.
- Emit normalized runtime events consumed by Phase 3 pipeline.

#### 2. Add auth/provider family resolver for pi mode
**File**: `src/commands/providers/pi-config.ts` (new)
**Changes**:
- Resolve provider family from selected model/config.
- Required env matrix:
  - Anthropic: `ANTHROPIC_API_KEY`
  - OpenRouter: `OPENROUTER_API_KEY`
  - OpenAI-compatible: `OPENAI_API_KEY`
  - Ollama/local: provider-specific base URL as needed
- Throw clear error on missing required keys.

#### 3. Wire adapter selection in runner
**File**: `src/commands/runner.ts`
**Changes**:
- Instantiate `ClaudeAdapter` or `PiMonoAdapter` from provider resolver.
- Keep model precedence unchanged (`task.model` -> `MODEL_OVERRIDE` -> default).

### Success Criteria:

#### Automated Verification:
- [x] Dependencies install cleanly: `bun install`
- [x] Typecheck passes: `bun run tsc:check`
- [x] Pi adapter tests pass: `bun test src/tests/pi-provider*.test.ts`

#### Manual Verification:
- [ ] `HARNESS_PROVIDER=pi` with missing auth fails with explicit missing key message.
- [ ] `HARNESS_PROVIDER=pi` with valid auth starts and emits session/init/result events.

**Implementation Note**: No silent fallback to Claude for pi auth errors.

---

## Phase 5: Resume, Parent/Child Continuity, and Cancellation Parity

### Overview
Recreate current continuation behavior for pi while preserving existing Claude logic.

### Changes Required

#### 1. Provider-aware resume strategy
**File**: `src/commands/runner.ts`
**Changes**:
- Keep current parent-first flow points:
  - paused task resume path (`src/commands/runner.ts:1980`)
  - child task path (`src/commands/runner.ts:2136`)
- Add provider-specific resume context handling:
  - Claude: existing `--resume`
  - Pi: session restore/rehydrate API (or fallback context bootstrap)

#### 2. Session id compatibility mapping
**File**: `src/http/tasks.ts`
**Changes**:
- Keep existing `PUT /api/tasks/:id/claude-session` for compatibility.
- Optionally add generic alias route (if needed) that writes same field + provider metadata.

**File**: `src/be/db.ts`
**Changes**:
- If generic metadata is needed, add non-breaking column via migration (JSON text metadata).

#### 3. Cancellation parity
**File**: `src/commands/providers/pi-mono-adapter.ts`
**Changes**:
- Implement `cancel()` path to abort pi session.

**File**: `src/commands/runner.ts`
**Changes**:
- Reuse existing cancellation detection loop; call provider cancel for pi instead of process kill semantics where applicable.

### Success Criteria:

#### Automated Verification:
- [x] Pause/resume tests pass: `bun test src/tests/task-pause-resume.test.ts`
- [x] Session attach/continuity tests pass: `bun test src/tests/session-attach.test.ts`
- [x] Cancellation tests pass: `bun test src/tests/task-cancellation.test.ts`

#### Manual Verification:
- [ ] Parent/child task in pi mode continues with expected context behavior.
- [ ] Cancelling an in-progress pi task prevents further tool execution and finishes as cancelled.

**Implementation Note**: Parity target is behavioral, not byte-for-byte identical internal mechanics.

---

## Phase 6: Hook Lifecycle Bridging for Provider-Neutral Semantics

### Overview
Ensure hook behavior remains equivalent when tool and lifecycle events originate from pi runtime instead of Claude stream output.

### Changes Required

#### 1. Map provider events to hook lifecycle triggers
**File**: `src/commands/providers/runtime-hook-bridge.ts` (new)
**Changes**:
- Map normalized events to existing hook semantics:
  - session start -> `SessionStart`
  - before tool call -> `PreToolUse`
  - after tool call -> `PostToolUse`
  - session end -> `Stop`

#### 2. Keep cancellation guards untouched
**File**: `src/hooks/hook.ts`
**Changes**:
- Avoid changing cancellation source of truth (`/cancelled-tasks`).
- Ensure pi-triggered tool lifecycle still passes through guardrails.

### Success Criteria:

#### Automated Verification:
- [ ] Hook-related tests pass: `bun test src/tests/hook*.test.ts`
- [x] Runner regression tests pass: `bun test src/tests/runner*.test.ts`

#### Manual Verification:
- [ ] PreToolUse blocking behavior still triggers when task is cancelled.
- [ ] PostToolUse reminders/heartbeats still fire in pi mode.

**Implementation Note**: If event naming mismatch exists in pi SDK, adapt at bridge layer only.

---

## Phase 7: Documentation + Rollout Safety Matrix

### Overview
Document operational behavior and freeze rollout checks for safe adoption.

### Changes Required

#### 1. Docs update
**File**: `CLAUDE.md`
**Changes**:
- Add `HARNESS_PROVIDER` usage and default behavior.
- Add required env keys for pi provider families.

**File**: `CONTRIBUTING.md` and/or `MCP.md`
**Changes**:
- Add troubleshooting section for provider selection and auth errors.

#### 2. Add explicit parity matrix test doc
**File**: `thoughts/taras/plans/2026-03-05-pi-mono-provider-implementation-plan.md` (this file)
**Changes**:
- Check off matrix only after both providers satisfy each lifecycle criterion.

### Success Criteria:

#### Automated Verification:
- [x] Lint/format passes: `bun run lint:fix`
- [x] Typecheck passes: `bun run tsc:check`
- [x] Full tests pass: `bun test`

#### Manual Verification:
- [ ] New developer can run Claude mode and pi mode locally from docs alone.
- [ ] Existing Claude-only deployment works with no config changes.

**Implementation Note**: Final human review required before merge/PR.

---

## Testing Strategy

### New tests to add (explicit)
- `src/tests/provider-selection.test.ts`
  - unset provider defaults to `claude`
  - unknown provider warns + uses `claude`
  - explicit `pi` selected when valid
- `src/tests/runner-provider-normalization.test.ts`
  - normalized session_init updates task session id
  - normalized result persists cost mapping
  - stream/stderr events persist to session logs
- `src/tests/pi-provider-auth-validation.test.ts`
  - missing required env key errors are deterministic
  - no fallback to Claude on pi auth failure

### Existing tests to keep green (parity gates)
- `src/tests/runner*.test.ts`
- `src/tests/task-cancellation.test.ts`
- `src/tests/task-pause-resume.test.ts`
- `src/tests/session-attach.test.ts`
- `src/tests/session-logs.test.ts`
- `src/tests/session-costs.test.ts`

## Manual E2E Verification (Required)

```bash
# 1) Start API
bun run start:http

# 2) Start worker in default mode (Claude)
HARNESS_PROVIDER=claude bun run start:worker

# 3) Create Claude smoke task
curl -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -X POST http://localhost:3013/api/tasks \
  -d '{"task":"Say hi","taskType":"test"}'

# 4) Verify logs and costs exist
curl -H "Authorization: Bearer 123123" http://localhost:3013/api/session-logs?limit=20
curl -H "Authorization: Bearer 123123" http://localhost:3013/api/session-costs?limit=20

# 5) Restart worker in pi mode using OpenRouter + explicit model
HARNESS_PROVIDER=pi OPENROUTER_API_KEY=<key> \
MODEL_OVERRIDE=openrouter/openai/gpt-oss-120b bun run start:worker

# 6) Create pi smoke task
curl -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -X POST http://localhost:3013/api/tasks \
  -d '{"task":"Say hi from pi","taskType":"test"}'

# 7) Pi hook smoke test (exercise tool lifecycle)
curl -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -X POST http://localhost:3013/api/tasks \
  -d '{"task":"Create /tmp/pi-hook-check.txt with content hook-ok, then read it back and report it","taskType":"test"}'

# 8) Pi cancellation + hook guard test
# create a long-running task, cancel it via API/MCP, verify final state is "cancelled"
# and verify no additional tool-use events continue after cancellation
```

```bash
# 9) Docker E2E setup for pi mode (full worker container path)
lsof -i :3013
PORT=3014 bun run start:http &
bun run docker:build:worker
docker run --rm -d \
  --name e2e-test-worker \
  --env-file .env.docker \
  -e MCP_BASE_URL=http://host.docker.internal:3014 \
  -e HARNESS_PROVIDER=pi \
  -e OPENROUTER_API_KEY=<key> \
  -e MODEL_OVERRIDE=openrouter/openai/gpt-oss-120b \
  -p 3203:3000 \
  agent-swarm-worker:latest

# 10) Docker pi smoke task
curl -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -X POST http://localhost:3014/api/tasks \
  -d '{"task":"Say hi from pi docker","taskType":"test"}'

# 11) Docker pi hook verification task + logs
curl -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -X POST http://localhost:3014/api/tasks \
  -d '{"task":"Write /workspace/personal/memory/pi-hook-test.md and then read it back","taskType":"test"}'
docker logs e2e-test-worker

# 12) Cleanup
docker stop e2e-test-worker
```

## Parity Checklist

- [ ] Provider selection (`HARNESS_PROVIDER`) behaves as specified
- [ ] Claude default path unchanged
- [ ] Pi auth errors are explicit and deterministic
- [ ] Session id persistence works in both providers
- [ ] Logs and costs persist through existing endpoints in both providers
- [ ] Parent/child continuity works in both providers
- [ ] Cancellation behavior works in both providers
- [ ] Hook guardrails still enforce pre/post tool semantics

## References
- Primary research: `thoughts/taras/research/2026-03-05-pi-mono-provider-research.md`
- Related architecture: `thoughts/shared/research/2025-12-22-runner-loop-architecture.md`
- Related comparison: `thoughts/swarm-researcher/research/2026-02-23-openclaw-vs-agent-swarm-comparison.md`
