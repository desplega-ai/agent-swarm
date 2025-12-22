import { type RunnerConfig, type RunnerOptions, runAgent } from "./runner.ts";

export type LeadOptions = RunnerOptions;

const leadConfig: RunnerConfig = {
  role: "lead",
  defaultPrompt: "/start-leader",
  yoloEnvVar: "LEAD_YOLO",
  logDirEnvVar: "LEAD_LOG_DIR",
  metadataType: "lead_metadata",
  systemPromptEnvVar: "LEAD_SYSTEM_PROMPT",
  systemPromptFileEnvVar: "LEAD_SYSTEM_PROMPT_FILE",
  swarmUrlEnvVar: "SWARM_URL",
};

export async function runLead(opts: LeadOptions) {
  return runAgent(leadConfig, opts);
}
