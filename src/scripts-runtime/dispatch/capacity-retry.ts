import { executeShellJobOutput } from "../shell-job-output";
import { getScriptExecutor } from "../executors/registry";
import type { ExecutorOutput } from "../executors/types";
import type { ScriptJob } from "./types";

// The native executor checks the harness's startedFile before classifying an abort.
// Only an abort before user code starts can produce this retryable error.
const CAPACITY_EXCEEDED_RETRY_DELAYS_MS = [200, 750];

export async function runWithCapacityRetry(
  job: ScriptJob,
  signal?: AbortSignal,
): Promise<ExecutorOutput> {
  if (job.kind === "step-shell") return executeShellJobOutput(job.input, signal);
  const input = { ...job.input, signal };
  let output = await getScriptExecutor(job.executor).run(input);
  for (const delayMs of CAPACITY_EXCEEDED_RETRY_DELAYS_MS) {
    if (output.error !== "capacity_exceeded" || signal?.aborted) break;
    await Bun.sleep(delayMs);
    output = await getScriptExecutor(job.executor).run(input);
  }
  return output;
}
