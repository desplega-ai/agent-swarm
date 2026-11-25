import type { WorkflowStepJob } from "@desplega/storage";
import type { ScriptJob } from "../scripts-runtime/dispatch/types";
import type { ExecutorOutput } from "../scripts-runtime/executors/types";
import type { ExecutorMeta, WorkflowNode } from "../types";
import type { ExecutorResult } from "./executors/base";

export type PreparedStepJob = {
  job: ScriptJob;
  finish(output: ExecutorOutput): Promise<ExecutorResult>;
  release(): Promise<void>;
};
export type StepJobBuildInput = {
  job: WorkflowStepJob;
  node: WorkflowNode;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  meta: ExecutorMeta;
};
export interface StepJobKindHandler {
  eligible?(runner: {executors: readonly string[]; runtimes?:readonly string[]}): boolean;
  build(input: StepJobBuildInput): Promise<PreparedStepJob>;
}

const handlers = new Map<string, StepJobKindHandler>();
export function registerStepJobKind(kind: string, handler: StepJobKindHandler): void {
  if (handlers.has(kind)) throw new Error(`Step job kind already registered: ${kind}`);
  handlers.set(kind, handler);
}
export function getStepJobKind(kind: string): StepJobKindHandler {
  const handler = handlers.get(kind);
  if (!handler) throw new Error(`Unknown step job kind: ${kind}`);
  return handler;
}
