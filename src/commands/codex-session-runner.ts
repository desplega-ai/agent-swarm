/**
 * Codex session subprocess runner.
 *
 * Entry point for the `codex-session-runner` CLI subcommand. Reads a
 * `CodexSubprocessInput` payload from stdin, drives a fresh in-process
 * `CodexSession`, and pipes the session's `ProviderEvent` stream + final
 * `ProviderResult` back to its parent over stdout as line-delimited JSON.
 *
 * Why this exists: the previous architecture ran every codex session
 * directly inside the long-lived worker runner. The `@openai/codex-sdk`
 * leaks SDK state (parsers, transcript buffers, JSON-RPC plumbing) into
 * the runner's heap, and after ~1,500 task completions on a hot worker
 * (Picateclas, 2026-05-28) the runner's VSZ ballooned to 74 GB / RSS to
 * 7.5 GB, causing every subsequent `fork()` to fail ENOMEM regardless of
 * current RSS (the kernel reserves CoW for the full VSZ at fork time).
 *
 * Moving each session into its own subprocess means the SDK state dies
 * with the subprocess. The runner stays at the ~234 MB baseline observed
 * on Reviewer (the cohort partner that did 481 task completions without
 * the OOM symptom). See task `fa0c0681` for the byte-by-byte breakdown.
 *
 * Wire protocol over stdout (one JSON object per line):
 *   {"kind":"event", "event": <ProviderEvent>}
 *   {"kind":"result", "result": <ProviderResult>}
 *   {"kind":"error", "message": "..."}
 */

import { createInProcessCodexSession } from "../providers/codex-adapter";
import type { ProviderEvent, ProviderResult, ProviderSessionConfig } from "../providers/types";

interface CodexSubprocessInput {
  config: ProviderSessionConfig;
  skillsDir?: string;
  parentOtelEnv?: Record<string, string>;
}

async function readAllStdin(): Promise<string> {
  // Bun.stdin is a BunFile in some versions, Web stream in others.
  // The safest path is to read the readable stream directly.
  const decoder = new TextDecoder();
  let out = "";
  const stream = (Bun.stdin as unknown as { stream?: () => ReadableStream<Uint8Array> }).stream
    ? (Bun.stdin as unknown as { stream: () => ReadableStream<Uint8Array> }).stream()
    : null;
  if (stream) {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  }
  // Fallback: read via Bun.file (file-like access works for piped stdin too)
  return await Bun.file("/dev/stdin").text();
}

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

export async function runCodexSessionRunner(): Promise<void> {
  try {
    await runCodexSessionRunnerInner();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(`[codex-session-runner] top-level crash: ${message}`);
    if (stack) console.error(stack);
    writeLine({ kind: "error", message: `codex-session-runner: unexpected crash: ${message}` });
    process.exit(1);
  }
}

async function runCodexSessionRunnerInner(): Promise<void> {
  let input: CodexSubprocessInput;
  try {
    const raw = await readAllStdin();
    input = JSON.parse(raw) as CodexSubprocessInput;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[codex-session-runner] stdin parse failed: ${message}`);
    writeLine({
      kind: "error",
      message: `codex-session-runner: failed to parse stdin: ${message}`,
    });
    process.exit(1);
  }

  // Forward the parent's captured OTel TRACEPARENT (and friends) into the
  // session config's env so the spawned Codex CLI nests its spans under our
  // worker.session trace. We deliberately do NOT call
  // `buildOtelTraceparentEnv` from inside this subprocess — its tracer has
  // no active span, so it would emit nothing.
  if (input.parentOtelEnv && Object.keys(input.parentOtelEnv).length > 0) {
    input.config.env = { ...(input.config.env ?? {}), ...input.parentOtelEnv };
  }

  let session: Awaited<ReturnType<typeof createInProcessCodexSession>>;
  try {
    session = await createInProcessCodexSession(input.config, {
      skillsDir: input.skillsDir,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[codex-session-runner] createSession failed: ${message}`);
    writeLine({ kind: "error", message: `codex-session-runner: createSession failed: ${message}` });
    process.exit(1);
  }

  // Forward SIGTERM / SIGINT to the in-process session so the runner can
  // gracefully cancel us. The parent `CodexSubprocessSession.abort()` sends
  // SIGTERM here; the session's AbortController catches it and the codex
  // CLI subprocess (a grandchild) gets cleaned up.
  const onSignal = (signal: NodeJS.Signals) => {
    void session.abort().finally(() => {
      // give the session a beat to emit its cancellation result, then exit
      setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 250);
    });
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  session.onEvent((event: ProviderEvent) => {
    writeLine({ kind: "event", event });
  });

  const result: ProviderResult = await session.waitForCompletion();
  writeLine({ kind: "result", result });
  process.exit(result.exitCode ?? 0);
}
