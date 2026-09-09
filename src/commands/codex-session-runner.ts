/**
 * Codex session subprocess runner.
 *
 * The first stdin line contains the session configuration. Subsequent lines
 * carry steering and cancellation commands. Each session owns one fresh
 * app-server process and emits provider events and its final result.
 *
 * Per-task process isolation bounds the worker heap across task completions.
 * The app-server migration preserves the isolation introduced after the
 * Picateclas memory exhaustion incident on 2026-05-28.
 *
 * Wire protocol over stdout (one JSON object per line):
 *   {"kind":"event", "event": <ProviderEvent>}
 *   {"kind":"result", "result": <ProviderResult>}
 *   {"kind":"error", "message": "..."}
 *   {"kind":"steering-result", "id": <requestId>, "delivery": <SteerDeliveryResult>}
 */

import { createInProcessCodexSession } from "../providers/codex-adapter";
import type {
  ProviderEvent,
  ProviderResult,
  ProviderSessionConfig,
  SteerDelivery,
  SteerDeliveryResult,
} from "../providers/types";
import { scrubSecrets } from "../utils/secret-scrubber";

interface CodexSubprocessInput {
  config: ProviderSessionConfig;
  skillsDir?: string;
  parentOtelEnv?: Record<string, string>;
}

async function* readStdinLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let partial = "";
  for await (const chunk of Bun.stdin.stream()) {
    partial += decoder.decode(chunk, { stream: true });
    let newline = partial.indexOf("\n");
    while (newline !== -1) {
      const line = partial.slice(0, newline);
      partial = partial.slice(newline + 1);
      if (line.trim()) yield line;
      newline = partial.indexOf("\n");
    }
  }
  partial += decoder.decode();
  if (partial.trim()) yield partial;
}

function writeLine(obj: unknown): void {
  process.stdout.write(`${scrubSecrets(JSON.stringify(obj))}\n`);
}

export async function runCodexSessionRunner(): Promise<void> {
  try {
    await runCodexSessionRunnerInner();
  } catch (err) {
    const message = scrubSecrets(err instanceof Error ? err.message : String(err));
    const stack = err instanceof Error && err.stack ? scrubSecrets(err.stack) : undefined;
    console.error(`[codex-session-runner] top-level crash: ${message}`);
    if (stack) console.error(stack);
    writeLine({ kind: "error", message: `codex-session-runner: unexpected crash: ${message}` });
    process.exit(1);
  }
}

async function runCodexSessionRunnerInner(): Promise<void> {
  const lines = readStdinLines();
  let input: CodexSubprocessInput;
  try {
    const { value: raw } = await lines.next();
    if (!raw) throw new Error("Missing Codex session configuration");
    input = JSON.parse(raw) as CodexSubprocessInput;
  } catch (err) {
    const message = scrubSecrets(err instanceof Error ? err.message : String(err));
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
    const message = scrubSecrets(err instanceof Error ? err.message : String(err));
    console.error(`[codex-session-runner] createSession failed: ${message}`);
    writeLine({ kind: "error", message: `codex-session-runner: createSession failed: ${message}` });
    process.exit(1);
  }

  // Signals remain the fallback if the parent cannot send a control message.
  const onSignal = (signal: NodeJS.Signals) => {
    void session.abort().finally(() => {
      // give the session a beat to emit its cancellation result, then exit
      setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 2_000).unref();
    });
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  session.onEvent((event: ProviderEvent) => {
    writeLine({ kind: "event", event });
  });

  // Keep stdin open for native steering and interruption during the turn.
  void (async () => {
    try {
      for await (const line of lines) {
        const command = JSON.parse(line) as
          | { kind: "abort"; reason?: string }
          | { kind: "steer"; id: number; delivery: SteerDelivery };
        if (command.kind === "abort") {
          await session.abort(command.reason);
        } else if (command.kind === "steer") {
          // Queue acknowledgements wait for a later turn. Keep reading controls
          // so cancellation and active-turn steering can proceed during that wait.
          const respond = (delivery: SteerDeliveryResult) =>
            writeLine({ kind: "steering-result", id: command.id, delivery });
          void session
            .deliverSteering(command.delivery)
            .then(respond, (error) =>
              respond({ delivered: false, reason: scrubSecrets(String(error)) }),
            );
        }
      }
      await session.abort("Codex parent closed its control channel");
    } catch (error) {
      console.error(scrubSecrets(`[codex-session-runner] control channel failed: ${error}`));
      await session.abort("Codex control channel failed");
    }
  })();

  const result: ProviderResult = await session.waitForCompletion();
  writeLine({ kind: "result", result });
  process.exit(result.exitCode ?? 0);
}
