import { z } from "zod";
import { MAX_SCRIPT_WALL_CLOCK_MS } from "../../scripts-runtime/executors/types";
import type { ExecutorMeta } from "../../types";
import {
  buildSandboxedCommand,
  createCappedStreamState,
  readStreamCapped,
  sandboxSpawnEnv,
  snapshotCapped,
} from "../../utils/sandboxed-process";
import { BaseExecutor, type ExecutorResult } from "./base";

/** Matches the inline scripts-runtime cap (src/scripts-runtime/executors/types.ts). */
const MAX_OUTPUT_BYTES = 1_048_576;

/**
 * How long to keep draining stdout/stderr AFTER the child has exited. Normally
 * both streams close immediately; the grace only matters when a killed script
 * leaked a grandchild that still holds the pipe write end, which must not hang
 * the workflow step forever.
 */
const STREAM_DRAIN_GRACE_MS = 5_000;

function unrefTimer(id: ReturnType<typeof globalThis.setTimeout>): void {
  if (typeof id === "object" && "unref" in id) (id as NodeJS.Timeout).unref();
}

/** Resolve `promise`, or fall back to `onDeadline()` if it takes longer than `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number, onDeadline: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const id = globalThis.setTimeout(() => resolve(onDeadline()), ms);
    unrefTimer(id);
    promise.then(
      (value) => {
        globalThis.clearTimeout(id);
        resolve(value);
      },
      () => {
        globalThis.clearTimeout(id);
        resolve(onDeadline());
      },
    );
  });
}

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
      // The timeout lives INSIDE runScript so it can actually SIGKILL the child.
      // Racing the timeout against the spawn promise out here (the previous
      // shape) only abandoned the promise: a sleeping script kept running past
      // the deadline — the CPU ulimit does not bound sleep — and its scoped
      // tmpdir was deleted out from under a live process.
      const result = await this.runScript(config, timeoutMs);

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

  private async runScript(
    config: z.infer<typeof ScriptConfigSchema>,
    timeoutMs: number,
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    const { runtime, script, args = [], cwd } = config;
    let cmd: string[];

    switch (runtime) {
      case "bash":
        // bash stops option parsing after the `-c script` pair — the next
        // argument always binds positionally to $0 (confirmed empirically:
        // `bash -c '...' --eval=x` never executes `x`), so no `--` is needed
        // here and adding one would shift $0 into args[0], breaking existing
        // workflows that rely on that binding.
        cmd = ["bash", "-c", script, ...args];
        break;
      case "ts":
        // `bun -e` keeps parsing recognized flags (e.g. `--eval=`, `--preload=`)
        // out of trailing argv and RUNS them — confirmed empirically that an
        // interpolated arg literally named `--eval=<code>` executes as a second
        // script. `--` forces Bun to stop flag parsing and treat everything
        // after it as positional data, with no change to `Bun.argv` indexing
        // (verified: `Bun.argv` is identical with and without `--`).
        cmd = ["bun", "-e", script, "--", ...args];
        break;
      case "python":
        // python3 also stops option parsing after `-c script` (confirmed
        // empirically: trailing args, including another `-c`, land verbatim
        // in sys.argv and are never executed), so no `--` is needed.
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
        // On POSIX, Bun.spawn only needs PATH to locate `sh` for argv[0] —
        // the sandboxed command's `env -i` prelude scrubs the child down to
        // `env` above, so the server's secrets never reach it either way. On
        // win32 there is no such prelude, so `sandboxSpawnEnv` passes `env`
        // through directly instead — see `buildSandboxedCommand`'s win32 doc
        // comment.
        env: sandboxSpawnEnv(env),
      });

      // Drain both pipes concurrently with the wait — a script producing more
      // than a pipe buffer of output would otherwise block forever on write.
      // Each gets its own progress state so the STREAM_DRAIN_GRACE_MS
      // deadline below can snapshot whatever was captured so far instead of
      // discarding it — see withDeadline usage.
      const stdoutState = createCappedStreamState();
      const stderrState = createCappedStreamState();
      const stdoutPromise = readStreamCapped(proc.stdout, MAX_OUTPUT_BYTES, stdoutState);
      const stderrPromise = readStreamCapped(proc.stderr, MAX_OUTPUT_BYTES, stderrState);

      let timedOut = false;
      const killTimer = globalThis.setTimeout(() => {
        timedOut = true;
        // SIGKILL, not SIGTERM: a shell script can trap and ignore SIGTERM.
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already reaped — nothing to kill.
        }
      }, timeoutMs);
      unrefTimer(killTimer);

      let exitCode: number;
      try {
        exitCode = await proc.exited;
      } finally {
        globalThis.clearTimeout(killTimer);
      }

      if (timedOut) {
        // The child is dead and its output is discarded on timeout, so don't
        // block on pipes a leaked grandchild may still hold open.
        stdoutPromise.catch(() => {});
        stderrPromise.catch(() => {});
        throw new Error(`Script timed out after ${timeoutMs}ms`);
      }

      // The child exited on its own; bound the remaining drain so a leaked
      // grandchild holding the pipe write end can't stall the step forever.
      // On deadline, snapshot whatever each stream captured before giving up
      // — the read promise may still be pending (a leaked descendant can
      // hold the pipe open indefinitely), but the bytes already read are
      // real output and must not be thrown away.
      const [stdout, stderr] = await Promise.all([
        withDeadline(stdoutPromise, STREAM_DRAIN_GRACE_MS, () => snapshotCapped(stdoutState)),
        withDeadline(stderrPromise, STREAM_DRAIN_GRACE_MS, () => snapshotCapped(stderrState)),
      ]);

      // A `truncated` stream (whether from hitting MAX_OUTPUT_BYTES or from
      // the drain deadline above) gets an explicit marker rather than being
      // presented as complete — silently truncating a script's real stdout
      // (e.g. mid-JSON) would otherwise look like a clean, complete result to
      // downstream workflow nodes.
      return {
        exitCode,
        stdout: (stdout.truncated ? `${stdout.text}\n…[stdout truncated]` : stdout.text).trimEnd(),
        stderr: (stderr.truncated ? `${stderr.text}\n…[stderr truncated]` : stderr.text).trimEnd(),
      };
    } finally {
      // Reached only after `await proc.exited` above, so the scoped dir is never
      // deleted while a live child is still using it as its cwd/TMPDIR.
      if (scopedTmpdir) await Bun.$`rm -rf ${scopedTmpdir}`.catch(() => {});
    }
  }
}
