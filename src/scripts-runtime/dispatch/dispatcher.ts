import type { ExecutorOutput } from "../executors/types";
import { embeddedScriptRunner } from "./embedded-runner";
import type { ScriptJob } from "./types";

export function dispatchScriptJob(
  job: ScriptJob,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ExecutorOutput> {
  return embeddedScriptRunner.run(job, signal);
}
