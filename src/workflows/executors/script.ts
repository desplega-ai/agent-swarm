import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import { BaseExecutor, type ExecutorResult } from "./base";

// ─── Schemas ────────────────────────────────────────────────

export const ScriptConfigSchema = z.object({
  runtime: z.enum(["bash", "ts", "python"]),
  script: z.string(),
  args: z.array(z.string()).optional(),
  timeout: z.number().int().min(1000).default(30_000),
  cwd: z.string().optional(),
});

export const ScriptOutputSchema = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});

// ─── Executor ───────────────────────────────────────────────

const DEFAULT_TIMEOUT = 30_000;

export class ScriptExecutor extends BaseExecutor<
  typeof ScriptConfigSchema,
  typeof ScriptOutputSchema
> {
  readonly type = "script";
  readonly mode = "instant" as const;
  readonly configSchema = ScriptConfigSchema;
  readonly outputSchema = ScriptOutputSchema;

  protected async execute(
    config: z.infer<typeof ScriptConfigSchema>,
    _context: Readonly<Record<string, unknown>>,
    _meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof ScriptOutputSchema>>> {
    const timeoutMs = config.timeout ?? DEFAULT_TIMEOUT;

    try {
      const result = await Promise.race([this.runScript(config), this.timeoutPromise(timeoutMs)]);

      return {
        status: "success",
        output: result,
        nextPort: result.exitCode === 0 ? "success" : "failure",
      };
    } catch (err) {
      return {
        status: "failed",
        error: `Script execution error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async runScript(config: z.infer<typeof ScriptConfigSchema>): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    const { runtime, script, args = [], cwd } = config;
    let cmd: string[];

    switch (runtime) {
      case "bash":
        cmd = ["bash", "-c", script, ...args];
        break;
      case "ts":
        cmd = ["bun", "-e", script, ...args];
        break;
      case "python":
        cmd = ["python3", "-c", script, ...args];
        break;
    }

    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: cwd ?? undefined,
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
  }

  private timeoutPromise(ms: number): Promise<never> {
    return new Promise((_resolve, reject) => {
      const id = globalThis.setTimeout(() => {
        reject(new Error(`Script timed out after ${ms}ms`));
      }, ms);
      // Ensure the timer doesn't keep the process alive
      if (typeof id === "object" && "unref" in id) {
        (id as NodeJS.Timeout).unref();
      }
    });
  }
}
