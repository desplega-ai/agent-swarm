---
id: step-5
name: opencode delivery (promptAsync / abort+prompt)
depends_on: [step-3]
status: done
completed_at: 2026-07-27
---

# step-5: opencode steering delivery

## Overview

Implements `deliverSteering()` on `OpencodeSession`. Queue-mode uses the native, verified queueing path (`session.promptAsync`); steer-mode is a composition (`session.abort` then prompt) because opencode has no true mid-turn interrupt-and-inject. The main structural work is lifting the `client` handle out of the `createSession()` closure.

## Changes Required:

#### 1. Lift `client` to session scope
**File**: `src/providers/opencode-adapter.ts`
**Changes**: `client` is created as a local `let` inside `createSession()` (`:798-801`, `{ client, server } = await createOpencode(...)`) and the `OpencodeSession` constructor (`:290-300`) takes `sessionId, server, model, agentId, taskId, agentFilePath, configFilePath, dataHomePath, retryAfterModelRefresh?, appliedReasoningEffort` — **no `client` param**. It reaches only the `sendPrompt` closure (`:836-850`).

Add `client` as a constructor parameter and private field, exactly parallel to how `server` is already stored (`:261, :303`). `sessionId` is already available as `this._sessionId` (`:248, :291`).

Update the construction call site (`:863-874`) to pass it.

#### 2. Implement `deliverSteering`
**File**: `src/providers/opencode-adapter.ts`
**Changes**:

```ts
async deliverSteering({ mode, text }: SteerDelivery): Promise<SteerDeliveryResult> {
  try {
    if (mode === "steer") {
      await this.client.session.abort({ path: { id: this._sessionId } });
    }
    await this.client.session.promptAsync({
      path: { id: this._sessionId },
      body: { parts: [{ type: "text", text }] },
    });
    return { delivered: true, mode };
  } catch (err) {
    return { delivered: false, reason: String(err) };
  }
}
```

Both SDK methods are confirmed present in the pinned `@opencode-ai/sdk@^1.18.4`: `session.abort` (`node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts:150`, `SessionAbortData = { path: {id}, query?: {directory?} }` at `types.gen.d.ts:2059-2068`) and `session.promptAsync` (`sdk.gen.d.ts:182`, `SessionPromptAsyncData` body `{ messageID?, model?, agent?, noReply?, system?, tools?, parts: Array<TextPartInput|...> }` at `types.gen.d.ts:2329-2343`).

**Why `promptAsync` and not `prompt`** (research §2.2, verified against opencode source at `v1.18.4` + an empirical spike): a blocking `prompt` issued while the session is busy resolves with the response of the **final** turn of the whole run (shared `Deferred`), not its own turn — code expecting "my prompt's reply" is misled. `promptAsync` returns `204` immediately with identical queueing underneath; results arrive on the SSE stream the adapter already consumes (`:842-856`).

**Steer-mode caveat**: `abort` (`promptSvc.cancel` → `Fiber.interrupt`) discards the in-flight turn's remaining work. That's the documented cost of interrupt on this provider — queue is the zero-loss path. Note it in the delivery result / logs so the operator can see it.

Do **not** use `session.shell` — it 409s (`Session.BusyError`) on a busy session; only `prompt`/`command` queue.

#### 3. Traits
**Changes**: Advertise both modes, flagging steer as lossy.

### Success Criteria:

#### Automated Verification:
- [ ] Typecheck passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] Tests pass: `bun test src/tests/opencode-adapter.test.ts` (extend — assert `client` reaches the session instance, `queue` calls `promptAsync` **without** `abort`, `steer` calls `abort` then `promptAsync`, a rejected SDK call returns `{delivered:false}`)
- [ ] Full suite green: `bun test`
- [ ] DB boundary holds: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [ ] Agent brings up a local swarm with an opencode worker using the repo's standard cross-provider test model — `-e HARNESS_PROVIDER=opencode -e MODEL=openrouter/deepseek/deepseek-v4-flash` — starts a long-running task, waits for `in_progress`, steers with `{"mode":"queue"}`, and shows the transcript is strictly sequential (turn 1 finishes, *then* the steered message runs as its own turn) with the row at `deliveredMode:"queue"`
- [ ] Agent repeats with `{"mode":"steer"}` and shows the in-flight turn was aborted before the new prompt ran
- [ ] Agent confirms no HTTP 409 / `Session.BusyError` appears in worker logs: `docker logs e2e-worker-$SUFFIX 2>&1 | grep -i "busy\|409"`
- [ ] Agent shows the model called `accept-steer` and the row reached `handled`

#### Manual Verification:
- [ ] Taras confirms the lossy-steer behavior (aborted turn) is acceptable as shipped

**Implementation Note**: Vertical slice — one provider, fully QA-able. Do not edit any other adapter, `src/providers/types.ts` (step-3), or `runbooks/harness-providers.md` (step-11). Commit `[step-5] opencode steering delivery via promptAsync`.
