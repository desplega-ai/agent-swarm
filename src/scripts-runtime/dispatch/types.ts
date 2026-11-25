import type {
  ScriptExecutionHandle,
  StartScriptExecutionInput,
} from "../../script-workflows/executor";
import type { ExecutorInput, ExecutorOutput, ScriptExecutorName } from "../executors/types";
import type { ShellJobConfig, ShellRuntime } from "../shell-job";

export type InlineScriptJob = {
  id: string;
  kind: "inline" | "step-script";
  executor: ScriptExecutorName;
  input: Omit<ExecutorInput, "signal">;
};

export type ShellScriptJob = {
  id: string;
  kind: "step-shell";
  executor: "native";
  input: ShellJobConfig;
};
export type ScriptJob = InlineScriptJob | ShellScriptJob;

export type ScriptRunnerHandle = {
  executors?: readonly ScriptExecutorName[];
  runtimes?: readonly ShellRuntime[];
  id: string;
  ownerId?: string;
  kind: "embedded" | "remote";
  startHeld(input: StartScriptExecutionInput): Promise<ScriptExecutionHandle>;
  run(job: ScriptJob, signal?: AbortSignal): Promise<ExecutorOutput>;
};
