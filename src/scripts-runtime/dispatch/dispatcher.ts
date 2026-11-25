import { getApiKey } from "../../utils/api-key";
import type { ExecutorOutput } from "../executors/types";
import { assertSerializableJob, embeddedScriptRunner } from "./embedded-runner";
import type { ScriptJob, ScriptRunnerHandle } from "./types";

let pickRemote: ((job: ScriptJob) => ScriptRunnerHandle | undefined) | undefined;
export function setRemoteScriptRunnerPicker(picker: typeof pickRemote) {
  pickRemote = picker;
}

export function dispatchScriptJob(
  job: ScriptJob,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ExecutorOutput> {
  const remote = pickRemote?.(job);
  if (remote) {
    assertSerializableJob(job);
    if (job.input.configPayload.system.apiKey.value === getApiKey()) {
      return Promise.reject(new Error("Script job cannot send the operator key to a runner"));
    }
    return remote.run(job, signal);
  }
  return embeddedScriptRunner.run(job, signal);
}
