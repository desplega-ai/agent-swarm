import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json";
import { initDb } from "./be/db";
import { registerCancelTaskTool } from "./tools/cancel-task";
import { registerCreateChannelTool } from "./tools/create-channel";
// Epics capability
import {
  registerAssignTaskToEpicTool,
  registerCreateEpicTool,
  registerDeleteEpicTool,
  registerGetEpicDetailsTool,
  registerListEpicsTool,
  registerUnassignTaskFromEpicTool,
  registerUpdateEpicTool,
} from "./tools/epics";
// Lead inbox tools
import { registerGetInboxMessageTool } from "./tools/get-inbox-message";
import { registerGetSwarmTool } from "./tools/get-swarm";
import { registerGetTaskDetailsTool } from "./tools/get-task-details";
import { registerGetTasksTool } from "./tools/get-tasks";
import { registerInboxDelegateTool } from "./tools/inbox-delegate";
import { registerJoinSwarmTool } from "./tools/join-swarm";
// Messaging capability
import { registerListChannelsTool } from "./tools/list-channels";
import { registerListServicesTool } from "./tools/list-services";
import { registerMyAgentInfoTool } from "./tools/my-agent-info";
import { registerPollTaskTool } from "./tools/poll-task";
import { registerPostMessageTool } from "./tools/post-message";
import { registerReadMessagesTool } from "./tools/read-messages";
// Services capability
import { registerRegisterServiceTool } from "./tools/register-service";
// Scheduling capability
import {
  registerCreateScheduleTool,
  registerDeleteScheduleTool,
  registerListSchedulesTool,
  registerRunScheduleNowTool,
  registerUpdateScheduleTool,
} from "./tools/schedules";
import { registerSendTaskTool } from "./tools/send-task";
import { registerSlackListChannelsTool } from "./tools/slack-list-channels";
import { registerSlackPostTool } from "./tools/slack-post";
import { registerSlackReadTool } from "./tools/slack-read";
import { registerSlackReplyTool } from "./tools/slack-reply";
import { registerStoreProgressTool } from "./tools/store-progress";
// Task pool capability
import { registerTaskActionTool } from "./tools/task-action";
import { registerUnregisterServiceTool } from "./tools/unregister-service";
// Profiles capability
import { registerUpdateProfileTool } from "./tools/update-profile";
import { registerUpdateServiceStatusTool } from "./tools/update-service-status";

// Capability-based feature flags
// Default: all capabilities enabled
const DEFAULT_CAPABILITIES = "core,task-pool,messaging,profiles,services,scheduling,epics";
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
  // Uses DATABASE_PATH env var for Docker volume compatibility (WAL needs .sqlite, .sqlite-wal, .sqlite-shm on same filesystem)
  initDb(process.env.DATABASE_PATH);

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
  registerCancelTaskTool(server);

  // Slack integration tools (always registered, will no-op if Slack not configured)
  registerSlackReplyTool(server);
  registerSlackReadTool(server);
  registerSlackPostTool(server);
  registerSlackListChannelsTool(server);
  registerInboxDelegateTool(server);
  registerGetInboxMessageTool(server);

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

  // Services capability - PM2/background service registry
  if (hasCapability("services")) {
    registerRegisterServiceTool(server);
    registerUnregisterServiceTool(server);
    registerListServicesTool(server);
    registerUpdateServiceStatusTool(server);
  }

  // Scheduling capability - scheduled task management
  if (hasCapability("scheduling")) {
    registerListSchedulesTool(server);
    registerCreateScheduleTool(server);
    registerUpdateScheduleTool(server);
    registerDeleteScheduleTool(server);
    registerRunScheduleNowTool(server);
  }

  // Epics capability - epic/project management
  if (hasCapability("epics")) {
    registerCreateEpicTool(server);
    registerListEpicsTool(server);
    registerGetEpicDetailsTool(server);
    registerUpdateEpicTool(server);
    registerDeleteEpicTool(server);
    registerAssignTaskToEpicTool(server);
    registerUnassignTaskFromEpicTool(server);
  }

  return server;
}
