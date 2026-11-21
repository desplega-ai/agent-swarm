import { agentsContract } from "./agents";
import { chatContract } from "./chat";
import { configContract } from "./config";
import type { ContractEngine } from "./env";
import { eventsContract } from "./events";
import { extensionsContract } from "./extensions";
import { mcpServersContract } from "./mcp-servers";
import { modelsContract } from "./models";
import { oauthContract } from "./oauth";
import { runtimePoolsContract } from "./runtime-pools";
import { slackContract } from "./slack";
import { trackersContract } from "./trackers";

export type { ContractEngine } from "./env";

/** The repository contract suite. Every engine runs all of it. */
export function runStorageContract(engine: ContractEngine): void {
  extensionsContract(engine);
  modelsContract(engine);
  runtimePoolsContract(engine);
  configContract(engine);
  agentsContract(engine);
  mcpServersContract(engine);
  trackersContract(engine);
  eventsContract(engine);
  chatContract(engine);
  oauthContract(engine);
  slackContract(engine);
}
