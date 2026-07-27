---
id: step-6
name: claude stdin stream-json (queue-only)
depends_on: [step-3]
status: done
completed_at: 2026-07-27
---

# step-6: claude provider — stdin stream-json rework (queue-only)

## Overview

The highest-risk provider step. Today the claude adapter passes the prompt as an **argv element** and never opens stdin. This step switches the spawn to `--input-format stream-json` with a piped, **persistently open** stdin, moves the initial prompt onto stdin as a user message, and implements `deliverSteering()` by writing further stream-json user-message lines.

**Queue-only by design** (decision 13). `mode:"steer"` returns `{ delivered: true, mode: "queue" }` — an honest degradation the caller sees as `outcome:"queued"`. Interrupt on Claude Code is SDK-only (research §2.1) and adopting `@anthropic-ai/claude-agent-sdk` is explicitly out of scope.

## Changes Required:

#### 1. Spawn with piped stdin
**File**: `src/providers/claude-adapter.ts`
**Changes**: The `Bun.spawn` options object (`:546-571`) has `cwd`, `env`, `stdout: "pipe"`, `stderr: "pipe"` and **no `stdin` key** — it defaults to inherited/ignored. Add `stdin: "pipe"`.

In `buildCommand()` (`:576-612`), add `--input-format`, `"stream-json"` alongside the existing `--output-format stream-json` (`:582-583`), and **remove the `-p <prompt>` argv pair** (`:584-589`) in favour of writing the prompt to stdin.

#### 2. Hold the stdin writer open
**File**: `src/providers/claude-adapter.ts`
**Changes**: Capture the writer as an instance field right after spawn (`:546`), mirroring the existing pattern in `codex-adapter.ts:1606`:

```ts
this.stdinWriter = this.proc.stdin as { write(s: string): void; end(): void };
```

Then write the initial user message:

```jsonc
{"type":"user","message":{"role":"user","content":"<prompt>"},"parent_tool_use_id":null}
```

⚠️ **Critical difference from codex**: codex writes its config then calls `stdin.end()` in the same tick (`codex-adapter.ts:1607-1608`), which is exactly why it has no injection path. **Do not call `.end()` here.** Keep the pipe open for the session lifetime; close it in `abort()` / on completion.

#### 3. Implement `deliverSteering` (queue-only)
**File**: `src/providers/claude-adapter.ts`
**Changes**:

```ts
async deliverSteering({ mode, text }: SteerDelivery): Promise<SteerDeliveryResult> {
  if (!this.stdinWriter) return { delivered: false, reason: "stdin not piped" };
  try {
    this.stdinWriter.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null })}\n`
    );
    // Interrupt is SDK-only; raw CLI stream-json queues. Always report queue.
    return { delivered: true, mode: "queue" };
  } catch (err) {
    return { delivered: false, reason: String(err) };
  }
}
```

Log the degradation when `mode === "steer"` so it's visible in worker logs.

#### 4. Traits + version guard
**Changes**: Advertise `steerModes: ["queue"]`. Queued mid-turn stdin messages require Claude Code **≥ 2.1.205** — earlier versions silently **discard** them. Add a startup version check: if the CLI is older, log a clear warning and leave `deliverSteering` undefined so the runner promotes to a follow-up task instead of silently dropping messages.

#### 5. Confirm the read path is undisturbed
**Changes**: `processStreams()` (`:624-733`) iterates `this.proc.stdout` as NDJSON via `processJsonLine()` (`:735-885`) and `this.proc.stderr` (`:668-683`); `this.proc.exited` is awaited at `:687`. None of it touches stdin, so this change is additive on the write side — but **verify empirically**, since moving the prompt from argv to stdin changes how the CLI starts its first turn.

`abort()` (`:904-906`) currently does `this.proc.kill("SIGTERM")` — extend it to close stdin first.

### Success Criteria:

#### Automated Verification:
- [ ] Typecheck passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] Tests pass: `bun test src/tests/claude-adapter.test.ts` (extend — assert argv contains `--input-format stream-json` and **no** `-p`, stdin is `"pipe"`, the initial user message is written as one NDJSON line, `.end()` is not called at spawn time, `mode:"steer"` returns `{delivered:true, mode:"queue"}`, and a pre-2.1.205 CLI leaves `deliverSteering` undefined)
- [ ] Full suite green: `bun test`
- [ ] DB boundary holds: `bash scripts/check-db-boundary.sh`
- [ ] Worker image builds: `docker build -f Dockerfile.worker .`
- [ ] Bundled CLI is new enough: `docker run --rm agent-swarm-worker:latest claude --version` reports ≥ 2.1.205

#### Automated QA:
- [ ] **Regression first**: agent runs a normal (unsteered) task end-to-end on the claude provider and shows it completes with correct output, cost, and context accounting — proving the argv→stdin prompt move didn't break the primary path
- [ ] Agent starts a long-running claude task, waits for `in_progress`, steers with `{"mode":"queue"}`, and shows the message ran as its own turn after the in-flight turn ended, with the row at `deliveredMode:"queue"`
- [ ] Agent steers with `{"mode":"steer"}` and shows the response reports `outcome:"queued"` (honest degradation) with a log line naming the downgrade
- [ ] Agent shows the model called `accept-steer` and the row reached `handled`
- [ ] Agent shows session logs, cost, and context-usage rows are still produced normally for a steered task

#### Manual Verification:
- [ ] Taras reviews the argv→stdin change specifically for regressions in the primary (unsteered) claude path — this is the fleet's most-used provider

**Implementation Note**: Vertical slice, but the riskiest one — the regression check matters more than the feature check. Do not edit any other adapter, `src/providers/types.ts` (step-3), or `runbooks/harness-providers.md` (step-11). Commit `[step-6] claude stdin stream-json rework with queue-mode steering`.
