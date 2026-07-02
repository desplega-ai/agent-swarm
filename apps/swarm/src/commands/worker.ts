import { getEnabledCapabilities } from "@/server.ts";
import { type RunnerConfig, type RunnerOptions, runAgent } from "./runner.ts";

export type WorkerOptions = RunnerOptions;

const workerConfig: RunnerConfig = {
  role: "worker",
  defaultPrompt: "/start-worker",
  metadataType: "worker_metadata",
  capabilities: getEnabledCapabilities(),
};

export async function runWorker(opts: WorkerOptions) {
  return runAgent(workerConfig, opts);
}
