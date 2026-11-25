import type { ExecutorOutput } from "./executors/types";
import { runShellJob, type ShellExecutionData, type ShellJobConfig } from "./shell-job";

/** Keep shell results on the same transport as other script jobs. */
export async function executeShellJobOutput(
  config: ShellJobConfig,
  signal?: AbortSignal,
): Promise<ExecutorOutput> {
  const started = performance.now();
  let result: ShellExecutionData;
  try {
    result = await runShellJob(config, config.timeout ?? 30_000, signal);
  } catch (error) {
    result = {
      exitCode: -1,
      stdout: "",
      stderr: "",
      executionError: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    result,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    truncated: { stdout: false, stderr: false },
    durationMs: performance.now() - started,
  };
}
