import type { ExecutorInput, ExecutorOutput, ScriptExecutorName } from "../executors/types";

export type ScriptJob = {
  id: string;
  kind: "inline";
  executor: ScriptExecutorName;
  input: Omit<ExecutorInput, "signal">;
};

export type ScriptRunnerHandle = {
  id: string;
  kind: "embedded" | "remote";
  run(job: ScriptJob, signal?: AbortSignal): Promise<ExecutorOutput>;
};
