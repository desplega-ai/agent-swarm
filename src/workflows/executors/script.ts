import { z } from "zod";
import { MAX_SCRIPT_WALL_CLOCK_MS } from "../../scripts-runtime/executors/types";
import type { ExecutorMeta } from "../../types";
import { buildSandboxedCommand, readStreamCapped } from "../../utils/sandboxed-process";
import { BaseExecutor, type ExecutorResult } from "./base";

/** Matches the inline scripts-runtime cap (src/scripts-runtime/executors/types.ts). */
const MAX_OUTPUT_BYTES = 1_048_576;

// ─── Schemas ────────────────────────────────────────────────

export const ScriptConfigSchema = z.object({
  runtime: z.enum(["bash", "ts", "python"]),
  script: z.string(),
  args: z.array(z.string()).optional(),
  timeout: z.number().int().min(1000).max(MAX_SCRIPT_WALL_CLOCK_MS).default(30_000),
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

      // Non-zero exit code is a hard failure — mark the step failed so the
      // workflow engine stops the branch and operators can see what went wrong.
      if (result.exitCode !== 0) {
        return {
          status: "failed",
          error: result.stderr || `Script exited with code ${result.exitCode}`,
          output: result as unknown as z.infer<typeof ScriptOutputSchema>,
        };
      }

      // If stdout is valid JSON object, merge parsed fields into output
      // so downstream nodes can access them via {{myScript.field}} interpolation
      // (mirrors how agent-task nodes parse JSON in resume.ts)
      let output: Record<string, unknown> = result;
      if (result.stdout) {
        try {
          const parsed = JSON.parse(result.stdout);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            output = { ...result, ...parsed };
          }
        } catch {
          // Not valid JSON — keep raw {exitCode, stdout, stderr}
        }
      }

      return {
        status: "success",
        output: output as z.infer<typeof ScriptOutputSchema>,
        nextPort: "success",
      };
    } catch (err) {
      // Populate a structured output payload so the failure surfaces in
      // get-workflow-run instead of leaving `output: null` and forcing operators
      // to dig through logs. Mirrors the non-zero-exit path above and the
      // litmus-gate `mustPass: false` mirror-into-output convention.
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.startsWith("Script timed out after");
      return {
        status: "failed",
        error: `Script execution error: ${message}`,
        output: {
          exitCode: -1,
          stdout: "",
          stderr: isTimeout ? message : `Script execution error: ${message}`,
        } as z.infer<typeof ScriptOutputSchema>,
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

    // Workflow-authored scripts run with attacker-influenceable data available
    // via {{...}} interpolation into `args` (trigger/webhook payloads etc — the
    // `script` string itself is never interpolated, see engine.ts
    // interpolateNodeConfig). Sandbox the same way as every other
    // spawn-user-code path: ulimits + a clean minimal env (never the server's
    // full process.env, which carries operator secrets) + a scoped tmpdir
    // when the workflow author didn't pin an explicit `cwd`.
    const scopedTmpdir = cwd
      ? undefined
      : `${process.env.TMPDIR ?? "/tmp"}/workflow-script-${crypto.randomUUID()}`;
    if (scopedTmpdir) await Bun.$`mkdir -p ${scopedTmpdir}`;
    const workdir = cwd ?? scopedTmpdir;

    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      TMPDIR: workdir ?? process.env.TMPDIR ?? "/tmp",
    };

    try {
      const proc = Bun.spawn(buildSandboxedCommand(cmd, env), {
        stdout: "pipe",
        stderr: "pipe",
        cwd: workdir,
        // Bun.spawn still needs PATH to locate `sh` for argv[0] — the
        // sandboxed command's `env -i` prelude scrubs the child down to
        // `env` above, so the server's secrets never reach it either way.
        env: { PATH: env.PATH },
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        readStreamCapped(proc.stdout, MAX_OUTPUT_BYTES),
        readStreamCapped(proc.stderr, MAX_OUTPUT_BYTES),
        proc.exited,
      ]);

      return {
        exitCode,
        stdout: stdout.text.trimEnd(),
        stderr: (stderr.truncated ? `${stderr.text}\n…[stderr truncated]` : stderr.text).trimEnd(),
      };
    } finally {
      if (scopedTmpdir) await Bun.$`rm -rf ${scopedTmpdir}`.catch(() => {});
    }
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
