---
id: step-4
name: pi-mono delivery (both modes native)
depends_on: [step-3]
status: done
completed_at: 2026-07-27
---

# step-4: pi-mono steering delivery

## Overview

The reference implementation — pi-mono is the only provider with first-class, native support for **both** modes, and the session handle is already a field. Implements `deliverSteering()` on `PiMonoSession` mapping `mode:"steer"` → `agentSession.steer()` and `mode:"queue"` → `agentSession.followUp()`.

Smallest lift of the four provider steps; do this one first if fanning out serially.

## Changes Required:

#### 1. Implement `deliverSteering`
**File**: `src/providers/pi-mono-adapter.ts`
**Changes**: The live `AgentSession` is already assigned to `this.agentSession` in the constructor (`:691`, from param at `:686`) — **no closure-lifting needed**, unlike opencode. `abort()` (`:1018-1020`) already uses it.

```ts
async deliverSteering({ mode, text }: SteerDelivery): Promise<SteerDeliveryResult> {
  try {
    if (mode === "steer") await this.agentSession.steer(text);
    else await this.agentSession.followUp(text);
    return { delivered: true, mode };
  } catch (err) {
    return { delivered: false, reason: String(err) };
  }
}
```

Both methods are confirmed present on the SDK's `AgentSession` interface — `steer(text: string): Promise<void>` and `followUp(text: string): Promise<void>` (`node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:76-77`).

**Semantics** (`sdk.md:220,227-234`):
- `steer` interrupts after the current tool completes and skips queued tools.
- `followUp` lands after the current assistant turn, before the next LLM call.
- Do **not** call `session.prompt()` without `streamingBehavior` during active streaming — it throws. Use `steer()`/`followUp()` directly.
- Both expand file-based prompt templates but **error on extension commands** (extension commands can't be queued). Catch and return `{ delivered: false }` so the runner promotes rather than losing the message.

#### 2. Traits
**File**: `src/providers/pi-mono-adapter.ts`
**Changes**: Set `traits.steerModes` (added in step-3) to `["steer", "queue"]`. It **must** match `PROVIDER_STEER_CAPABILITIES["pi"]` from step-1 — that map is what the API advertises as `supportedSteerModes` and what `onUnsupported:"fail"` gates on (decision 16). step-11 asserts the two agree.

#### 3. Guard against a not-yet-streaming session
**Changes**: If steering arrives before the session has started streaming (race at task start), either await readiness or return `{ delivered: false, reason: "session not ready" }` — the runner will retry on its next ~5s poll since the row stays `pending` until a successful delivery report.

### Success Criteria:

#### Automated Verification:
- [ ] Typecheck passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] Tests pass: `bun test src/tests/pi-mono-adapter.test.ts` (extend — assert `steer` maps to `agentSession.steer`, `queue` maps to `followUp`, a throwing SDK call returns `{delivered:false}`, and the traits advertise both modes)
- [ ] Full suite green: `bun test`
- [ ] DB boundary holds: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [ ] Agent brings up a local swarm with a pi worker (`-e HARNESS_PROVIDER=pi`), starts a long-running task ("Count slowly from 1 to 40…"), waits for `in_progress`, then `POST /api/tasks/{id}/steer` with `{"mode":"queue"}` and shows: response `outcome:"queued"`, row `status:"delivered"` with `deliveredMode:"queue"`, and the steering text present in the session transcript **after** the in-flight turn completed
- [ ] Agent repeats with `{"mode":"steer"}` and shows `deliveredMode:"steer"` and evidence the in-flight turn was cut short (transcript shows the interrupt, not a clean turn boundary)
- [ ] Agent shows the model called `accept-steer` and the row reached `handled`

#### Manual Verification:
- [ ] Taras spot-checks one transcript to confirm steer-vs-queue timing genuinely differs

**Implementation Note**: Vertical slice — one provider, fully QA-able. Do not edit any other adapter or `src/providers/types.ts` (step-3 owns it), and do not edit `runbooks/harness-providers.md` (step-11 owns it). Commit `[step-4] pi-mono steering delivery (steer + followUp)`.
