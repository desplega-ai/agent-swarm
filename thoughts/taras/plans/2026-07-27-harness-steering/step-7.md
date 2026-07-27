---
id: step-7
name: devin + claude-managed delivery
depends_on: [step-3]
status: done
completed_at: 2026-07-27
---

# step-7: devin + claude-managed steering delivery

## Overview

The two remote-API providers, grouped because the work is nearly identical: both already hold session-scoped client handles and both already make the exact call shape steering needs. Devin's `sendMessage` is wired in production for the approval flow; claude-managed's `events.send` is the same call used to deliver the initial prompt.

## Changes Required:

#### 1. devin
**File**: `src/providers/devin-adapter.ts`
**Changes**: `DevinSession` already holds `this.orgId`, `this.devinApiKey`, and `this._sessionId` (`:113`) as private fields — no lifting needed.

```ts
async deliverSteering({ mode, text }: SteerDelivery): Promise<SteerDeliveryResult> {
  if (!this._sessionId) return { delivered: false, reason: "no devin session" };
  try {
    await sendMessage(this.orgId, this.devinApiKey, this._sessionId, text);
    return { delivered: true, mode };
  } catch (err) {
    return { delivered: false, reason: String(err) };
  }
}
```

`sendMessage(orgId, apiKey, sessionId, message): Promise<void>` is at `src/providers/devin-api.ts:150-155` (POSTs `{ message }` to `/v3/organizations/{orgId}/sessions/{sessionId}/messages`). The approval flow already calls it at `devin-adapter.ts:704`. **Do not change `devin-api.ts`'s signature** — reuse as-is.

**Open behavior to determine empirically** (research residual): the Devin docs specify message delivery for *active* sessions but don't define behavior while the sub-state is `working` vs `waiting_for_user` (sub-states at `:484-498`). Resolve during implementation:
- If delivery while `working` is accepted → advertise both modes (Devin's own semantics decide timing).
- If it errors or is ignored while `working` → advertise `queue` only, and return `{ delivered: false }` when `working` so the runner retries on the next poll or promotes.

Record whichever you find in the step's QA evidence — step-11 will document it.

#### 2. claude-managed
**File**: `src/providers/claude-managed-adapter.ts`
**Changes**: `client` and `_sessionId` are `private readonly` fields (`:235-236`, set at `:259-260`). The call shape is identical to the init send at `:629-638`:

```ts
async deliverSteering({ mode, text }: SteerDelivery): Promise<SteerDeliveryResult> {
  try {
    await this.client.beta.sessions.events.send(this._sessionId, {
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    });
    return { delivered: true, mode };
  } catch (err) {
    return { delivered: false, reason: String(err) };
  }
}
```

The Managed Agents docs guarantee events sent while a session is running or idle are **processed in order**, so both modes map to the same call — the ordering guarantee gives queue semantics natively. For `mode:"steer"`, optionally precede with a `user.interrupt` event (the exact event `abort()` already sends at `:325-328`); if you do, treat the aborted turn's lost work the same way step-5 does for opencode.

⚠️ `abort()` also archives the session (`:333-335`) — steering must **not** archive. Only send the event.

#### 3. Traits
**Changes**: Set `traits.steerModes` on both adapters to what you **empirically confirm**, and update `PROVIDER_STEER_CAPABILITIES` in step-1's map to match — in particular, narrow `devin` to `["queue"]` if delivery while `working` turns out to be unreliable. The map is what the API advertises as `supportedSteerModes` and what `onUnsupported:"fail"` gates on (decision 16); step-11 asserts the two agree. This is the one place a provider step is expected to touch step-1's map — coordinate if step-11 is already in flight.

### Success Criteria:

#### Automated Verification:
- [ ] Typecheck passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] Tests pass: `bun test src/tests/devin-adapter.test.ts src/tests/claude-managed-adapter.test.ts` (extend — assert devin calls `sendMessage` with the session-scoped triple; claude-managed sends a `user.message` event and **never** calls `archive`; both return `{delivered:false}` on a rejected call)
- [ ] Full suite green: `bun test`
- [ ] DB boundary holds: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [ ] Agent runs a devin-provider task (`-e HARNESS_PROVIDER=devin`), steers it while `in_progress`, and shows the message reached the Devin session and the row moved to `delivered`
- [ ] Agent documents the devin `working`-vs-`waiting_for_user` finding with concrete evidence (request/response or session status transcript)
- [ ] Agent runs a claude-managed task (`-e HARNESS_PROVIDER=claude-managed`, requires `ANTHROPIC_API_KEY`, `MANAGED_AGENT_ID`, `MANAGED_ENVIRONMENT_ID`, and an HTTPS-public `MCP_BASE_URL`), steers it, and shows the `user.message` event landed mid-stream and the session was **not** archived
- [ ] Agent shows the model called `accept-steer` on at least one of the two providers and the row reached `handled`

#### Manual Verification:
- [ ] Taras confirms the devin `working`-state finding and the mode advertisement chosen from it
- [ ] Claude-managed QA needs a publicly-reachable `MCP_BASE_URL`; if unavailable locally, Taras confirms whether to defer that half's live QA to step-11

**Implementation Note**: Vertical slice covering two structurally-identical providers. Do not edit `src/providers/types.ts` (step-3), other adapters, or `runbooks/harness-providers.md` (step-11). Commit `[step-7] devin + claude-managed steering delivery`.
