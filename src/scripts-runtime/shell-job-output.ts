import type { ExecutorOutput } from "./executors/types";
import { executeShellJob, type ShellJobConfig } from "./shell-job";

/** Keep shell results on the same transport as other script jobs. */
export async function executeShellJobOutput(
  config: ShellJobConfig,
  signal?: AbortSignal,
): Promise<ExecutorOutput> {
  const started = performance.now();
  const result = await executeShellJob(config, signal);
  return {
    result,
    stdout: result.output.stdout,
    stderr: result.output.stderr,
    exitCode: result.output.exitCode,
    truncated: { stdout: false, stderr: false },
    durationMs: performance.now() - started,
  };
}
