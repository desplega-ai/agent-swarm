---
id: step-3
name: Worker transport spine + codex fallback + ack
depends_on: [step-1]
status: done
completed_at: 2026-07-27
---

# step-3: Worker transport spine + codex fallback + explicit ack

## Overview

The worker-side half of the channel. Extends `ProviderSession` with an optional `deliverSteering()`, adds the runner poll that fetches pending steering per active task and hands it to the live session handle, reports the real outcome back to the API, and adds the `accept-steer` tool the agent uses to explicitly acknowledge handling (decision 11).

Ships with **codex as the null implementation** — a provider with no `deliverSteering` degrades to a promoted follow-up task, which exercises the entire path end-to-end without any provider work. Steps 4–7 then fill in real delivery.

**This step owns `src/commands/runner.ts`, `src/providers/types.ts`, `src/tools/accept-steer.ts`, and the steering prompt template.** Provider adapters are owned by steps 4–7.

⚠️ **Architecture invariant**: everything here is worker-side. No `src/be/db` or `bun:sqlite` imports in `src/commands/`, `src/providers/`, `src/prompts/`. Enforced by `scripts/check-db-boundary.sh:18-28`. The API key must come from `getApiKey()` (`src/utils/api-key.ts`), never `process.env.API_KEY` — `scripts/check-api-key-boundary.sh`.

## Changes Required:

#### 1. `ProviderSession.deliverSteering`
**File**: `src/providers/types.ts`
**Changes**: `ProviderSession` (`:128-133`) currently has exactly 4 required members. Add a **fifth, optional** one so all 6 existing implementers keep compiling unchanged:

```ts
export type SteerDelivery = { mode: "steer" | "queue"; text: string };
export type SteerDeliveryResult =
  | { delivered: true; mode: "steer" | "queue" }   // mode = what ACTUALLY happened
  | { delivered: false; reason: string };

export interface ProviderSession {
  // ...existing 4 members...
  /** Optional. Absent ⇒ provider cannot accept mid-run input; runner promotes to a follow-up task. */
  deliverSteering?(delivery: SteerDelivery): Promise<SteerDeliveryResult>;
}
```

Also add a `steerModes: SteerMode[]` entry to `ProviderTraits` (`:169-174`) so prompt assembly can gate the agent-facing instructions. Prefer the `traits` object-literal pattern over a `canResume()`-style method — `canResume()` exists on all 6 adapters but has **zero production call sites** (tests only), and this must not repeat that.

⚠️ **Decision 16 sync obligation**: `traits.steerModes` on each adapter must match `PROVIDER_STEER_CAPABILITIES` in step-1, which is what the server advertises as `supportedSteerModes` and what `onUnsupported:"fail"` gates on. Drift here means the API promises a mode the adapter can't deliver. step-11 adds the test that asserts the two agree; keep them aligned as steps 4–7 land.

#### 2. Runner delivery poll
**File**: `src/commands/runner.ts`
**Changes**: Add a steering block immediately after the cancellation block (`:5230-5260`), inside `runAgent` (`:4062`). Same shape:

- Gate on `state.activeTasks.size > 0`; iterate `for (const [taskId, task] of state.activeTasks)` (`RunningTask` at `:1753-1794`, `state.activeTasks` at `:1797-1798`).
- `fetch(`${apiUrl}/api/steering-messages?taskId=${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${apiKey}`, "X-Agent-ID": agentId } })` — the header shape used at `:5238-5241`. There is **no shared HTTP helper in `runner.ts`**; every call site builds headers inline off `ApiConfig` (`:468-472`). Follow that.
- For each pending message: if `task.session.deliverSteering` exists, call it; otherwise treat as `{ delivered: false }`.
- Report back with `POST /api/steering-messages/{id}/delivered` carrying the **actual** mode, or `POST .../undeliverable` which triggers promotion (step-1's service owns the promotion).
- Track already-dispatched ids in a `Set` to avoid double-delivery, mirroring `cancelledSignaled` (`:5233,5253`).

Cadence is inherited: `effectiveTimeout` drops to 5000ms while tasks are active (`:5279`), so steering lands within ~5s.

#### 3. Faster adapter-level check (optional but preferred)
**File**: `src/providers/swarm-events-shared.ts`
**Changes**: Add a `checkSteering` sibling to `checkCancelled` (`:107-142`) using the existing `apiHeaders(opts)` (`:75-81`) and `shouldRun(key, throttleMs)` throttle (`:100-105`), with its own constant (e.g. `STEERING_THROTTLE_MS = 1000`) next to `CANCELLATION_THROTTLE_MS = 500` (`:47`). Fire on `tool_start` from the providers that already wire the shared handler.

Keep this **additive** — the runner poll in §2 is the guaranteed path; this is latency reduction. If it complicates the delivery-dedup logic, ship §2 only and note it.

#### 4. `accept-steer` ack tool
**File**: `src/tools/accept-steer.ts` (new)
**Changes**: Agent-side MCP tool the model calls after acting on a steering message. Follow `src/tools/cancel-task.ts` anatomy: flat Zod input (`steeringMessageId: z.uuid()`, optional `note: z.string()`), output schema, `async function acceptSteerHandler(ctx: ToolCtx, args): Promise<CallToolResult>`, ownership via `assertOwnsTask` (`src/tools/task-tool-ctx.ts:28-59`), two-item `content` array + `structuredContent` return (`cancel-task.ts:160-169`), and a `registerAcceptSteerTool` using `createToolRegistrar` (`:172-185`). Flips the row to `handled` via step-1's `markSteeringHandled`.

Register in the **`task-pool`** capability block (`src/server.ts:341-343`).

**Registration bookkeeping this step owns** (see root.md's shared-file warning):
- Add `"accept-steer"` to `ALL_TOOLS` in `src/tools/tool-config.ts`.
- Add `"accept-steer"` to **`EXCLUDED_TOOLS`** in `src/scripts-runtime/sdk-allowlist.ts` with the reason *"agent-only acknowledgement of a steering message delivered into a live session; scripts never run inside a steered session."* Without this, `scripts/check-sdk-tool-registration.ts` fails. Do **not** touch `SDK_TOOL_NAME_MAP` — step-8 owns that region.

#### 5. Agent-facing prompt section
**Files**: `src/prompts/session-templates.ts`, `src/prompts/base-prompt.ts`
**Changes**: Prompt text must go through the registry — no string concatenation in runners/hooks/providers (project invariant). Register a template (`registerTemplate({ eventType: "system.agent.steering", ... })`, modelled on `"system.agent.messaging"` at `session-templates.ts:186-197`) telling the agent it may receive steering messages mid-run and **must** call `accept-steer` when it acts on one.

Gate its injection in `base-prompt.ts` exactly as the messaging block does (`:181-188`):

```ts
if (hasMcp && !scriptsOnlyMode && serverHasCapability("task-pool", true)) {
  const steeringResult = await resolveTemplateAsync("system.agent.steering", {});
  prompt += steeringResult.text;
}
```

#### 6. Secret scrubbing at egress
**File**: wherever steering bodies are logged worker-side
**Changes**: Any path emitting a steering body to stdout/stderr, `session_logs`, or `/workspace/logs/*.jsonl` goes through `scrubSecrets` (`src/utils/secret-scrubber.ts`) at the **egress** point.

### Success Criteria:

#### Automated Verification:
- [ ] Typecheck passes: `bun run tsc:check` (proves the optional interface member didn't break the other 5 adapters)
- [ ] Lint passes: `bun run lint`
- [ ] Tests pass: `bun test src/tests/steering-transport.test.ts` (new — cover: poll fetches only `pending`, dedup prevents double-delivery, missing `deliverSteering` → undeliverable → promotion, `accept-steer` flips to `handled`, secret scrubbing of bodies)
- [ ] Full suite green: `bun test`
- [ ] DB boundary holds: `bash scripts/check-db-boundary.sh`
- [ ] API key boundary holds: `bash scripts/check-api-key-boundary.sh`
- [ ] SDK tool registration passes with the `EXCLUDED_TOOLS` entry: `bun run scripts/check-sdk-tool-registration.ts`
- [ ] RBAC coverage passes for the new tool file: `bun run check:rbac-coverage`

#### Automated QA:
- [ ] Agent brings up the local swarm per LOCAL_TESTING.md § "Minimal smoke-test", starts a **codex** worker (`-e HARNESS_PROVIDER=codex`), creates a long task, steers it, and shows the response/row ends at `outcome:"promoted"` with a real follow-up task — proving the full spine without any provider implementation
- [ ] Agent shows the runner picked up the pending row within ~5s: `docker logs e2e-worker-$SUFFIX 2>&1 | grep -i steer`
- [ ] Agent calls `accept-steer` over MCP (handshake per LOCAL_TESTING.md § "MCP tool testing over HTTP") and shows the row moves to `handled` with `handledAt` set
- [ ] Agent shows the registered prompt template appears in a dispatched system prompt when `task-pool` is enabled, and is absent when `CAPABILITIES` excludes it

#### Manual Verification:
- [ ] Taras confirms the `SteerDeliveryResult` shape before steps 4–7 implement against it

**Implementation Note**: Vertical slice — provable end-to-end via the codex fallback. This is the interface contract for four parallel provider steps, so get the shape right before signing off. Commit `[step-3] worker steering transport, codex fallback, accept-steer ack`.
