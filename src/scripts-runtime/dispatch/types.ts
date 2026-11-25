import type {
  ScriptExecutionHandle,
  StartScriptExecutionInput,
} from "../../script-workflows/executor";
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
  startHeld(input: StartScriptExecutionInput): Promise<ScriptExecutionHandle>;
  run(job: ScriptJob, signal?: AbortSignal): Promise<ExecutorOutput>;
};
