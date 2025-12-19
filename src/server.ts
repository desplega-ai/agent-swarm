import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json";
import { initDb } from "./be/db";
import { registerCreateChannelTool } from "./tools/create-channel";
import { registerGetSwarmTool } from "./tools/get-swarm";
import { registerGetTaskDetailsTool } from "./tools/get-task-details";
import { registerGetTasksTool } from "./tools/get-tasks";
import { registerJoinSwarmTool } from "./tools/join-swarm";
// Messaging capability
import { registerListChannelsTool } from "./tools/list-channels";
import { registerMyAgentInfoTool } from "./tools/my-agent-info";
import { registerPollTaskTool } from "./tools/poll-task";
import { registerPostMessageTool } from "./tools/post-message";
import { registerReadMessagesTool } from "./tools/read-messages";
import { registerSendTaskTool } from "./tools/send-task";
import { registerStoreProgressTool } from "./tools/store-progress";
// Task pool capability
import { registerTaskActionTool } from "./tools/task-action";
// Profiles capability
import { registerUpdateProfileTool } from "./tools/update-profile";

// Capability-based feature flags
// Default: all capabilities enabled
const DEFAULT_CAPABILITIES = "core,task-pool,messaging,profiles";
const CAPABILITIES = new Set(
  (process.env.CAPABILITIES || DEFAULT_CAPABILITIES).split(",").map((s) => s.trim()),
);

export function hasCapability(cap: string): boolean {
  return CAPABILITIES.has(cap);
}

export function getEnabledCapabilities(): string[] {
  return Array.from(CAPABILITIES);
}

export function createServer() {
  // Initialize database with WAL mode
  initDb();

  const server = new McpServer(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  // Core tools - always registered
  registerJoinSwarmTool(server);
  registerPollTaskTool(server);
  registerGetSwarmTool(server);
  registerGetTasksTool(server);
  registerSendTaskTool(server);
  registerGetTaskDetailsTool(server);
  registerStoreProgressTool(server);
  registerMyAgentInfoTool(server);

  // Task pool capability - task pool operations (create unassigned, claim, release, accept, reject)
  if (hasCapability("task-pool")) {
    registerTaskActionTool(server);
  }

  // Messaging capability - channel-based communication
  if (hasCapability("messaging")) {
    registerListChannelsTool(server);
    registerCreateChannelTool(server);
    registerPostMessageTool(server);
    registerReadMessagesTool(server);
  }

  // Profiles capability - agent profile management
  if (hasCapability("profiles")) {
    registerUpdateProfileTool(server);
  }

  return server;
}
