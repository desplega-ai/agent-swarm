import { agentFsWebhooksContract } from "./agent-fs-webhooks";
import { agentsContract } from "./agents";
import { assetsContract } from "./assets";
import { chatContract } from "./chat";
import { configContract } from "./config";
import type { ContractEngine } from "./env";
import { eventsContract } from "./events";
import { extensionsContract } from "./extensions";
import { improvementsContract } from "./improvements";
import { kvContract } from "./kv";
import { maintenanceContract } from "./maintenance";
import { mcpServersContract } from "./mcp-servers";
import { memoryContract } from "./memory";
import { modelsContract } from "./models";
import { oauthContract } from "./oauth";
import { pagesContract } from "./pages";
import { rbacContract } from "./rbac";
import { runtimePoolsContract } from "./runtime-pools";
import { schedulesContract } from "./schedules";
import { scriptsContract } from "./scripts";
import { skillsContract } from "./skills";
import { slackContract } from "./slack";
import { tasksContract } from "./tasks";
import { trackersContract } from "./trackers";
import { usersContract } from "./users";
import { workflowsContract } from "./workflows";

export type { ContractEngine } from "./env";

/** The repository contract suite. Every engine runs all of it. */
export function runStorageContract(engine: ContractEngine): void {
  extensionsContract(engine);
  modelsContract(engine);
  runtimePoolsContract(engine);
  configContract(engine);
  agentsContract(engine);
  maintenanceContract(engine);
  assetsContract(engine);
  usersContract(engine);
  rbacContract(engine);
  mcpServersContract(engine);
  trackersContract(engine);
  eventsContract(engine);
  chatContract(engine);
  oauthContract(engine);
  slackContract(engine);
  workflowsContract(engine);
  scriptsContract(engine);
  pagesContract(engine);
  skillsContract(engine);
  kvContract(engine);
  tasksContract(engine);
  memoryContract(engine);
  schedulesContract(engine);
  agentFsWebhooksContract(engine);
  improvementsContract(engine);
}
