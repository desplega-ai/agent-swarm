/**
 * Async child-process helper shared by every test that spawns a subprocess.
 *
 * `Bun.spawnSync` blocks this process's event loop for the child's entire
 * run. A hung child can then only be reaped by the test's own timeout, with
 * no diagnostic, and the child can still be alive afterward. `runChild` uses
 * async `Bun.spawn` with a hard per-child timeout: a hang becomes a clean
 * `SIGKILL` plus a message, and a cold `bun` boot under `--parallel=4` still
 * gets room to finish.
 *
 * Env handling: `opts.env`, when given, goes to `Bun.spawn` verbatim — this
 * helper does NOT merge `process.env` on top of it. Build the full env
 * yourself (spread `process.env` and/or delete keys off a copy), the same
 * way the call sites this helper replaces already do. Merging here would
 * silently undo a caller's `delete env.NODE_ENV`.
 */

/** Hard ceiling for a single spawned child. */
export const CHILD_PROCESS_TIMEOUT_MS = 30_000;
/** What call sites pass as a test's own timeout argument, so the test runner never gives up before the child's SIGKILL fires. */
export const CHILD_PROCESS_TEST_BUDGET_MS = CHILD_PROCESS_TIMEOUT_MS + 5_000;

export interface ChildResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signalCode: string | null;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Spawn `cmd`, wait for it to exit (or be killed at the deadline), and
 * collect its output. Does not throw on a non-zero exit — some tests assert
 * on a failing exit status; use `expectChildOk` when only success is wanted.
 */
export async function runChild(
  cmd: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: string | Uint8Array;
    timeoutMs?: number;
  } = {},
): Promise<ChildResult> {
  const timeoutMs = opts.timeoutMs ?? CHILD_PROCESS_TIMEOUT_MS;
  const hasStdin = opts.stdin !== undefined;
  const start = performance.now();
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: hasStdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (hasStdin) {
    proc.stdin?.write(opts.stdin as string | Uint8Array);
    await proc.stdin?.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const durationMs = performance.now() - start;
  // Bun's `timeout` option kills the child with `killSignal` once the
  // deadline passes. A signal exit that took at least `timeoutMs` wall time
  // is that path; a caller- or process-triggered signal before the deadline
  // would not reach it.
  const timedOut = proc.signalCode !== null && durationMs >= timeoutMs;
  return { stdout, stderr, exitCode, signalCode: proc.signalCode, durationMs, timedOut };
}

/** Throw with a clear diagnostic when `result` did not exit 0; otherwise pass it through. */
export function expectChildOk(result: ChildResult, label: string): ChildResult {
  if (result.exitCode !== 0) {
    const timeoutNote = result.timedOut
      ? ` (timed out after ${Math.round(result.durationMs)} ms)`
      : "";
    const stderrTail = result.stderr.slice(-2000);
    throw new Error(`${label} failed: exit ${result.exitCode}${timeoutNote}\n${stderrTail}`);
  }
  return result;
}
