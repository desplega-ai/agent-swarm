import { type RunnerConfig, type RunnerOptions, runAgent } from "./runner.ts";

export type LeadOptions = RunnerOptions;

const leadConfig: RunnerConfig = {
  role: "lead",
  defaultPrompt: "/setup-leader Setup the agent swarm and begin coordinating workers!",
  yoloEnvVar: "LEAD_YOLO",
  logDirEnvVar: "LEAD_LOG_DIR",
  metadataType: "lead_metadata",
  systemPromptEnvVar: "LEAD_SYSTEM_PROMPT",
  systemPromptFileEnvVar: "LEAD_SYSTEM_PROMPT_FILE",
};

export async function runLead(opts: LeadOptions) {
  return runAgent(leadConfig, opts);
}
