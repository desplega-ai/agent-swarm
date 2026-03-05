import {
  parseStderrForErrors,
  SessionErrorTracker,
  trackErrorFromJson,
} from "../../utils/error-tracker.ts";
import type {
  ProviderAdapter,
  ProviderRunHandle,
  ProviderSessionTask,
  ProviderStartContext,
} from "./types.ts";

function getResumeArgs(additionalArgs: string[] | undefined, resumeSessionId?: string): string[] {
  const args = [...(additionalArgs || [])];
  if (!resumeSessionId || args.includes("--resume")) return args;
  args.push("--resume", resumeSessionId);
  return args;
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;

  buildResumeContext(task: ProviderSessionTask, parentTask?: ProviderSessionTask) {
    const sessionId = task.claudeSessionId || parentTask?.claudeSessionId;
    return {
      sessionId,
      additionalArgs: sessionId ? ["--resume", sessionId] : [],
    };
  }

  async cancel(runHandle: ProviderRunHandle): Promise<void> {
    if (runHandle.process) {
      runHandle.process.kill("SIGTERM");
    }
  }

  async startRun(context: ProviderStartContext): Promise<ProviderRunHandle> {
    const cmd = [
      "claude",
      "--model",
      context.model,
      "--verbose",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--allow-dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      "-p",
      context.prompt,
    ];

    cmd.push(...getResumeArgs(context.additionalArgs, context.resumeSessionId));

    if (context.systemPrompt) {
      cmd.push("--append-system-prompt", context.systemPrompt);
    }

    const writer = Bun.file(context.logFile).writer();
    const errorTracker = new SessionErrorTracker();

    const env = context.taskFilePath
      ? {
          ...context.env,
          TASK_FILE: context.taskFilePath,
        }
      : context.env;

    const proc = Bun.spawn(cmd, {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const promise = (async () => {
      let stdoutChunks = 0;
      let stderrChunks = 0;
      let stderrOutput = "";
      let partialLine = "";

      const stdoutPromise = (async () => {
        if (!proc.stdout) return;

        for await (const chunk of proc.stdout) {
          stdoutChunks++;
          const text = new TextDecoder().decode(chunk);
          writer.write(text);

          const combined = partialLine + text;
          const parts = combined.split("\n");
          partialLine = parts.pop() || "";

          for (const line of parts) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            await context.onEvent({
              type: "stream_line",
              provider: "claude",
              line: trimmed,
            });

            try {
              const json = JSON.parse(trimmed) as Record<string, unknown>;
              if (
                json.type === "system" &&
                json.subtype === "init" &&
                typeof json.session_id === "string"
              ) {
                await context.onEvent({
                  type: "session_init",
                  provider: "claude",
                  sessionId: json.session_id,
                });
              }

              if (json.type === "result") {
                const usage = (json.usage ?? {}) as {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                };

                await context.onEvent({
                  type: "result",
                  provider: "claude",
                  totalCostUsd:
                    typeof json.total_cost_usd === "number" ? json.total_cost_usd : undefined,
                  usage: {
                    inputTokens: usage.input_tokens,
                    outputTokens: usage.output_tokens,
                    cacheReadTokens: usage.cache_read_input_tokens,
                    cacheWriteTokens: usage.cache_creation_input_tokens,
                  },
                  durationMs: typeof json.duration_ms === "number" ? json.duration_ms : undefined,
                  numTurns: typeof json.num_turns === "number" ? json.num_turns : undefined,
                  isError: typeof json.is_error === "boolean" ? json.is_error : undefined,
                  raw: json,
                });
              }

              trackErrorFromJson(json, errorTracker);
            } catch {
              // Ignore non-JSON lines from provider output.
            }
          }
        }

        if (partialLine.trim()) {
          const trimmed = partialLine.trim();
          await context.onEvent({
            type: "stream_line",
            provider: "claude",
            line: trimmed,
          });
          try {
            const json = JSON.parse(trimmed) as Record<string, unknown>;
            trackErrorFromJson(json, errorTracker);
          } catch {
            // Ignore non-JSON lines from provider output.
          }
        }
      })();

      const stderrPromise = (async () => {
        if (!proc.stderr) return;

        for await (const chunk of proc.stderr) {
          stderrChunks++;
          const text = new TextDecoder().decode(chunk);
          stderrOutput += text;
          parseStderrForErrors(text, errorTracker);
          await context.onEvent({
            type: "stderr",
            provider: "claude",
            content: text,
          });
          writer.write(
            `${JSON.stringify({ type: "stderr", content: text, timestamp: new Date().toISOString() })}\n`,
          );
        }
      })();

      await Promise.all([stdoutPromise, stderrPromise]);
      await writer.end();

      const exitCode = (await proc.exited) ?? 1;

      if (exitCode !== 0 && stderrOutput) {
        await context.onEvent({
          type: "provider_error",
          provider: "claude",
          error: stderrOutput,
        });
      }

      if (stdoutChunks === 0 && stderrChunks === 0) {
        await context.onEvent({
          type: "provider_error",
          provider: "claude",
          error: "No output from Claude - check auth/startup",
        });
      }

      await context.onEvent({
        type: "process_exit",
        provider: "claude",
        exitCode,
      });

      return {
        exitCode,
        errorTracker,
      };
    })();

    return {
      taskId: context.taskId || crypto.randomUUID(),
      provider: "claude",
      process: proc,
      promise,
      cancel: async () => {
        proc.kill("SIGTERM");
      },
    };
  }
}
