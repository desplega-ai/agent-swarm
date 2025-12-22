import { type RunnerConfig, type RunnerOptions, runAgent } from "./runner.ts";

export type WorkerOptions = RunnerOptions;

const workerConfig: RunnerConfig = {
  role: "worker",
  defaultPrompt: "/start-worker",
  yoloEnvVar: "WORKER_YOLO",
  logDirEnvVar: "WORKER_LOG_DIR",
  metadataType: "worker_metadata",
  systemPromptEnvVar: "WORKER_SYSTEM_PROMPT",
  systemPromptFileEnvVar: "WORKER_SYSTEM_PROMPT_FILE",
  swarmUrlEnvVar: "SWARM_URL",
};

export async function runWorker(opts: WorkerOptions) {
  return runAgent(workerConfig, opts);
}
