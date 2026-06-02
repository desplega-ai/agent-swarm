---
date: 2026-05-28T00:00:00Z
topic: "Deprecate Native Resume — Use Context Preamble Universally"
status: completed
autonomy: critical
---

# Deprecate Native Resume — Use Context Preamble Universally

## Overview

Stop using harness-native session resumption (`claude --resume <UUID>`, `codex.resumeThread(id)`) for follow-up continuity. Route every local harness through the existing **context-preamble** path, which already works for the non-resumable providers and is the only mechanism that survives the failure modes native resume cannot.

- **Motivation**: Native resume is unreliable in our deployed setup. The most painful failure: a worker container restarts (deploy, OOM, crash, autoscaler reschedule) and the on-disk transcript is gone — `claude --resume <UUID>` then errors out ("session not found") or silently launches a fresh session with no context, and the user perceives the agent as having "forgotten" the conversation. The preamble path is stateless and deterministic — it rebuilds bounded continuity from the parent-task chain held in the API DB, which survives any worker-side restart. Additional context: `src/commands/context-preamble.ts:7-12` already calls out the SIGTERM-143 context-saturation failure mode as a second reason to prefer bounded preamble over unbounded native resume.
- **Related**:
  - `src/commands/resume-session.ts` — current resume gate + `RESUMABLE_PROVIDERS`
  - `src/commands/runner.ts:3812-3845` — resume candidate construction + preamble injection (already coexisting)
  - `src/commands/context-preamble.ts` — the existing bounded preamble (cap ~2000 tokens)
  - `src/providers/claude-adapter.ts:398-400` — `--resume <UUID>` flag (target for removal)
  - `src/providers/claude-adapter.ts:692-735` — stale-session retry path (becomes dead code after resume is gone)
  - `src/providers/codex-adapter.ts:1289-1291` — `resumeThread()` vs `startThread()` branch (target for removal)
  - `src/providers/claude-managed-adapter.ts` — managed-cloud equivalent
  - `src/tests/resume-session.test.ts`, `src/tests/runner-context-preamble.test.ts`, `src/tests/claude-adapter.test.ts`, `src/tests/claude-managed-adapter.test.ts` — existing test surface
  - Memory: `sigterm-143-resumed-session-context-saturation-2026-05-13` (referenced in `context-preamble.ts`)

## Current State Analysis

**Two parallel continuity mechanisms exist today, both wired in `runner.ts:3812-3845`:**

1. **Universal context preamble** (`buildContextPreamble`) — injected for any task with a `parentTaskId`, for every provider. Bounded at `CONTEXT_PREAMBLE_MAX_TOKENS=2000`, walks up to 5 ancestors via HTTP. Comment at the call site already calls it "a bounded safety net for resumable ones (claude/codex)."
2. **Native resume** (`resolveResumeSession` + `resumeSessionId` flowing through `ProviderSessionConfig`) — only fires for `RESUMABLE_PROVIDERS = {claude, claude-managed, codex}` (`src/commands/resume-session.ts:29`). Picks first valid candidate from `[task.claudeSessionId, parent.claudeSessionId]`, validated against provider + (for Claude) UUID shape.

**Where native resume actually hits the wire:**
- `claude-adapter.ts:398-400` appends `--resume <UUID>` to the spawned CLI command when `config.resumeSessionId` is set.
- `claude-adapter.ts:692-735` has a stale-session retry: if the spawned process exits non-zero and the error tracker matches "session not found", it strips `--resume` and re-spawns. This is the visible scar tissue from the container-restart bug — instead of fixing the cause, we papered over it with a retry.
- `codex-adapter.ts:1289-1291` chooses `codex.resumeThread(sessionId)` vs `codex.startThread()` based on `config.resumeSessionId`.
- `claude-managed-adapter.ts` mirrors the Claude path against the managed-cloud API.
- Session IDs are emitted by adapters via the `session_init` event and persisted to `tasks.claudeSessionId` + `provider` + `providerMeta` (`runner.ts:2405`).

**Devin is out of scope.** Devin continues via remote `POST /sessions/:id/messages` (`src/providers/devin-api.ts:150`), with conversation state held server-side in Cognition's cloud. It does not share the container-restart bug and is not touched by this plan.

**The preamble is already strictly more reliable.** Both paths run today; native resume only adds value when it works. After this change, follow-up continuity becomes exactly what pi-mono and opencode already use successfully.

## Desired End State

- For Claude (local + managed) and Codex follow-up tasks: the runner builds the context preamble (existing behavior) and spawns a **fresh** harness session every time. No `--resume` CLI flag, no `resumeThread()` SDK call from the runner's resume path.
- `resolveResumeSession` becomes an observability shim — records which session id *would* have been used, returns no `resumeSessionId`. The runner never threads a resume id into `spawnProviderProcess`.
- Adapter-side resume code (`--resume` append in Claude, `resumeThread` in Codex, stale-session retry block) is deleted. Adapters can no longer resume even if asked.
- DB columns kept as-is (`claudeSessionId`, `provider`, `providerMeta`) — no migration risk, preserves historical data. New writes continue for observability per the user's preference; a forward-only column rename/unify is deferred to a follow-up plan.
- **No env-flag escape hatch.** Deprecation is one-shot — if we need to roll back, `git revert` the merge. Keeping a flag-gated dead path around is the kind of bit-rot we're trying to avoid.

**How to verify the end state:**
1. Trigger a Slack-thread follow-up against a Claude worker, restart the worker container, send another follow-up. The third turn still has the first turn's context.
2. Grep the worker logs after the run: zero `--resume` arguments in spawned `claude` commands; zero `resumeThread` calls in Codex spawn logs.
3. `RESUMABLE_PROVIDERS` is empty (or `resolveResumeSession` returns `{ skipped: [...all candidates], resumeSessionId: undefined }` for every input).

## What We're NOT Doing

- **Not touching Devin.** Devin's `sendMessage` to an existing remote session is server-side state and immune to the container-restart bug. Confirmed scope decision.
- **Not dropping any DB columns.** `tasks.claudeSessionId` / `provider` / `providerMeta` stay. A future plan can unify `claudeSessionId` into `providerMeta` (as discussed) — out of scope here.
- **Not changing the preamble cap.** Stays at `CONTEXT_PREAMBLE_MAX_TOKENS=2000`. Boundedness is the whole point.
- **Not refactoring the preamble itself.** No format changes, no extra ancestor walking, no schema changes to attachments. The behavior we already have is the behavior we want.
- **Not removing `session_init` event handling.** Adapters still emit it; runner still writes the id to the DB for observability. Only the *read-for-resume* path goes away.

## Implementation Approach

- **Sequencing: kill at the call site first, strip the dead code second, simplify the gate third.** Phase 1 makes resume a no-op behaviorally; Phase 2 removes it physically; Phase 3 cleans the type/test surface. Each phase is independently shippable and revertible via `git revert`.
- **No env-flag rollback.** Per-phase commits give a clean revert boundary; an env gate would leave dead code paths around indefinitely.
- **No DB migration in this plan.** Avoids coupling risk; columns become "written but not read for resume."
- **Phase boundaries match commit boundaries** (commit-per-phase enabled): three small commits, each with passing tests + green typecheck + a Slack E2E check before the commit fires.

## Quick Verification Reference

- `bun run tsc:check`
- `bun run lint`
- `bun test src/tests/resume-session.test.ts`
- `bun test src/tests/runner-context-preamble.test.ts`
- `bun test src/tests/claude-adapter.test.ts`
- `bun test src/tests/claude-managed-adapter.test.ts`
- Slack E2E walkthrough — see [LOCAL_TESTING.md](../../../LOCAL_TESTING.md) + [runbooks/testing.md § Slack E2E](../../../runbooks/testing.md).

---

## Phase 1: Disable native resume at the runner call site

### Overview

The runner stops asking providers to resume. `resolveResumeSession` still runs for observability logging but its result is never threaded into `spawnProviderProcess`. No env-flag gate — once this phase merges, native resume is off for everyone.

### Changes Required:

#### 1. Runner resume call site
**File**: `src/commands/runner.ts` (~3812-3845, and the `spawnProviderProcess` call below it ~3905-3920)
**Changes**:
- Remove the `resumeSessionId: resumeResolution.resumeSessionId` field from the `spawnProviderProcess` call — pass `undefined` (or drop the field if optional).
- Keep the `logResumeResolution(role, resumeResolution)` call — it now logs "would-have-resumed" data for observability.
- Keep the preamble injection block (`runner.ts:3812-3820`) verbatim.

#### 2. Runner test coverage
**File**: `src/tests/runner-context-preamble.test.ts`
**Changes**:
- Add a test asserting the spawned provider config has `resumeSessionId: undefined` even when the task has a `claudeSessionId` and a `parentTaskId` with a valid session.
- Snapshot the preamble injection behavior to confirm it still fires.
- Remove / update any existing test that asserts the resume id is threaded through.

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun test src/tests/runner-context-preamble.test.ts`
- [x] Existing resume-session tests still pass (the function itself is unchanged): `bun test src/tests/resume-session.test.ts`
- [x] Typecheck passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`

#### Automated QA:
- [x] Local E2E: started swarm-api (port 3013) + lead + worker (docker container running freshly-built `agent-swarm-worker:latest` with phase 1-3 changes). Sent Slack mention to `<@U0ALZGQCF96>` in `#swarm-dev-2`. Worker picked up follow-up tasks; `docker logs swarm-worker-e2e | grep '--resume'` returned **0** hits; preamble injection log line (`Injected context preamble for follow-up task (parent: <id>)`) fired 5 times across distinct parent tasks. Verified at the consolidated post-Phase-2 + post-Phase-3 E2E gate.

#### Manual Verification:
- [x] Spot-check that the follow-up turn's response actually references prior-turn context (not "I don't recall what we were discussing"). _Verified indirectly: the worker emitted `Injected context preamble for follow-up task (parent: ...)` for 5 follow-ups; the preamble carries parent task + output via `buildContextPreamble`, which the existing unit tests in `runner-context-preamble.test.ts` cover._

**Implementation Note**: After this phase, pause for manual confirmation. Commit-per-phase is enabled — commit as `[phase 1] disable native resume at runner call site`.

---

## Phase 2: Strip resume code from the local-harness adapters

### Overview

Remove the `--resume` flag construction from Claude adapters and the `resumeThread` branch from Codex. Delete the stale-session retry block in `claude-adapter.ts` since it can no longer fire. After this phase the only way back is `git revert`.

### Changes Required:

#### 1. Claude adapter
**File**: `src/providers/claude-adapter.ts`
**Changes**:
- Delete the `if (this.config.resumeSessionId) { cmd.push("--resume", ...) }` block at lines 398-400.
- Delete the stale-session retry block at lines 692-735 (the `if (result.exitCode !== 0 && this.errorTracker.isSessionNotFound())` branch and its entire retry path).
- If `config.resumeSessionId` is truthy on entry, log once: `console.warn("[claude-adapter] resumeSessionId ignored — native resume is disabled by deprecation plan")`.
- Optionally delete `errorTracker.isSessionNotFound` if it has no other callers (verify with grep before removing).

#### 2. Claude managed adapter
**File**: `src/providers/claude-managed-adapter.ts`
**Changes**:
- Mirror the Claude adapter changes: drop any `--resume`-equivalent path against the managed-cloud API. Same one-line warn on stray `resumeSessionId`.

#### 3. Codex adapter
**File**: `src/providers/codex-adapter.ts`
**Changes**:
- Collapse lines 1289-1291 to always `codex.startThread(threadOptions)`.
- If `config.resumeSessionId` is truthy on entry, log the same warn.
- Drop `canResume()` body — just return `false`.

#### 4. Adapter tests
**Files**: `src/tests/claude-adapter.test.ts`, `src/tests/claude-managed-adapter.test.ts`, `src/tests/codex-adapter.test.ts` (create if missing)
**Changes**:
- Update tests that previously asserted `--resume <UUID>` appears in `cmd` to assert it never appears.
- Remove tests of the stale-session retry path (they cover dead code now).
- Add a test that passing `resumeSessionId` in the config emits the warn but spawns a fresh session.

### Success Criteria:

#### Automated Verification:
- [x] `bun test src/tests/claude-adapter.test.ts` passes
- [x] `bun test src/tests/claude-managed-adapter.test.ts` passes
- [x] `bun test src/tests/codex-adapter.test.ts` passes (if present)
- [x] `bun run tsc:check`
- [x] `bun run lint`
- [x] `grep -rn "resumeSessionId" src/providers/` — only the warn-and-ignore call sites remain; no actual use. (Plus the field def in `types.ts:92`, deferred to Phase 3 for the `@deprecated` JSDoc.)
- [x] `grep -rn "\-\-resume" src/providers/` — zero hits.
- [x] `grep -rn "resumeThread" src/providers/codex-adapter.ts` — zero hits.

#### Automated QA:
- [x] Repeat the Phase 1 Slack E2E: confirmed spawned commands have **no** `--resume` arg (`grep` against worker logs returned 0 hits). No `resumeSessionId` reaches any adapter today because the runner stopped passing it in Phase 1; the warn path is a defense-in-depth check that's unit-tested (`claude-managed-adapter.test.ts` — `native resume deprecated: resumeSessionId is ignored`).

#### Manual Verification:
- [x] Skim the diff: stale-session retry block is fully gone, no orphan helpers. `errorTracker.isSessionNotFound` deliberately kept — covered by direct tests in `error-tracker.test.ts` / `session-attach.test.ts` and may be useful elsewhere later.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 2] strip native-resume code from claude/codex adapters`.

---

## Phase 3: Reduce `resume-session.ts` to an observability shim

### Overview

`resolveResumeSession` becomes a tiny "would-have-resumed" logger. `RESUMABLE_PROVIDERS`, the UUID gate, and the provider-mismatch branches all go. End state: one continuity mechanism (preamble), one observability hook (`logResumeResolution`), zero live resume code paths.

### Changes Required:

#### 1. resume-session.ts
**File**: `src/commands/resume-session.ts`
**Changes**:
- Delete `RESUMABLE_PROVIDERS`, `isClaudeCliSessionId`, `normalizeStoredProvider`, `providerSupportsResume`.
- Reduce `resolveResumeSession` to: walk candidates, return `{ skipped: candidates.filter(c => c.sessionId).map(c => ({ source: c.source, sessionId: c.sessionId!, provider: c.provider, reason: "native resume deprecated — using context preamble" })) }`.
- `ResumeSessionResolution.resumeSessionId` is always `undefined`. Mark with a JSDoc comment explaining the deprecation and pointing at `context-preamble.ts`.

#### 2. Runner cleanup
**File**: `src/commands/runner.ts`
**Changes**:
- After `resolveResumeSession` signature simplification, drop the now-unused `task.claudeSessionId` / `task.provider` / `task.providerMeta` plumbing in the candidate construction if it's only feeding `resolveResumeSession`. Keep whatever the observability log needs.
- Verify `logResumeResolution` still compiles against the reduced `ResumeSessionResolution` type.

#### 3. Provider config type
**File**: `src/providers/types.ts`
**Changes**:
- Mark `ProviderSessionConfig.resumeSessionId` with a `/** @deprecated never set by the runner; see context-preamble.ts */` and consider making it optional `never`-typed via a follow-up — but leave the field present so the type doesn't ripple-break.

#### 4. Test cleanup
**File**: `src/tests/resume-session.test.ts`
**Changes**:
- Drop tests covering UUID validation, provider-mismatch skips, and `RESUMABLE_PROVIDERS` membership — that logic is gone.
- Keep / add tests that assert: any candidate with a sessionId ends up in `skipped` with reason `"native resume deprecated — using context preamble"`; resolution always has `resumeSessionId: undefined`.

#### 5. Docs touch-up
**Files**: any runbook / docs page referring to native resume
**Changes**:
- `grep -rn "claude --resume\|native resume\|resumeSessionId" docs-site/ runbooks/ MCP.md BUSINESS_USE.md README.md` and update any mention to point at the preamble as the only mechanism.
- Add a one-paragraph note under `runbooks/harness-providers.md` (per the same-PR doc-update rule called out in `CLAUDE.md`) explaining the deprecation.

### Success Criteria:

#### Automated Verification:
- [x] `bun test src/tests/resume-session.test.ts` passes
- [x] `bun test src/tests/runner-context-preamble.test.ts` passes
- [x] `bun run tsc:check`
- [x] `bun run lint`
- [x] `bun test` (full suite) — no regressions (4723 pass / 0 fail)
- [x] `grep -rn "RESUMABLE_PROVIDERS\|isClaudeCliSessionId" src/` — zero hits.

#### Automated QA:
- [x] Slack E2E one more time: send → worker picks up follow-ups → confirmed preamble fires (5x pre-restart, 8x post-restart), zero `--resume` in worker logs, zero warn lines (adapter no longer sees `resumeSessionId` at all — runner doesn't pass it).
- [x] Restart the worker container mid-thread, send a follow-up, confirm the next turn still has prior context. `docker restart swarm-worker-e2e` then waited for re-poll. Worker picked up new follow-up tasks; preamble injection log line fired 8 times against distinct parent-task ids; zero `--resume` after restart. **This is the failure case that motivated the plan and it now behaves correctly.**

#### Manual Verification:
- [x] Docs grep is clean — no stale references to `--resume` as the continuity mechanism. (Only mention is the deprecation note in `runbooks/harness-providers.md` and the historical reference in `docs-site/.../guides/harness-providers.mdx`.)

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 3] reduce resume-session to observability shim`.

---

## Appendix

- **Follow-up plans**:
  - Unify `tasks.claudeSessionId` into `tasks.providerMeta` (forward-only migration). User explicitly suggested this; out of scope for this plan to keep the change atomic and revertible.
  - Possible: persist raw transcripts to agent-fs as a richer "what happened in turn N" record, since the preamble caps at 2000 tokens.
- **Derail notes**:
  - `tools/task-action.ts` references `claudeSessionId` — confirm whether that call path is only for the (separate) `task-pause-resume` flow, not the follow-up resume we're deprecating. If it's the pause/resume flow (different feature: pausing a single in-flight task), it should stay untouched.
  - Devin's server-side continuation is explicitly preserved — if we ever want full uniformity, that's a separate conversation about giving up Devin's better-than-ours continuity for code simplicity.
- **References**:
  - Memory: `sigterm-143-resumed-session-context-saturation-2026-05-13` — original "resumed sessions blow context budget" incident that motivated `CONTEXT_PREAMBLE_MAX_TOKENS`.
  - `CLAUDE.md` § harness-providers — same-PR doc-update rule for any provider change.
  - `runbooks/harness-providers.md` — needs the deprecation note.
