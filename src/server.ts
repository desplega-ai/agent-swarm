import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json";
import { initDb } from "./be/db";
import { registerCancelTaskTool } from "./tools/cancel-task";
import { registerContextDiffTool } from "./tools/context-diff";
import { registerContextHistoryTool } from "./tools/context-history";
import { registerCreateChannelTool } from "./tools/create-channel";
import { registerDbQueryTool } from "./tools/db-query";
import { registerDeleteChannelTool } from "./tools/delete-channel";
import { registerGetSwarmTool } from "./tools/get-swarm";
import { registerGetTaskDetailsTool } from "./tools/get-task-details";
import { registerGetTasksTool } from "./tools/get-tasks";
import { registerInjectLearningTool } from "./tools/inject-learning";
import { registerJoinSwarmTool } from "./tools/join-swarm";
// Messaging capability
import { registerListChannelsTool } from "./tools/list-channels";
import { registerListServicesTool } from "./tools/list-services";
import { registerManageUserTool } from "./tools/manage-user";
// MCP Servers capability
import {
  registerMcpServerCreateTool,
  registerMcpServerDeleteTool,
  registerMcpServerGetTool,
  registerMcpServerInstallTool,
  registerMcpServerListTool,
  registerMcpServerUninstallTool,
  registerMcpServerUpdateTool,
} from "./tools/mcp-servers";
// Memory capability
import { registerMemoryDeleteTool } from "./tools/memory-delete";
import { registerMemoryGetTool } from "./tools/memory-get";
import { registerMemorySearchTool } from "./tools/memory-search";
import { registerMyAgentInfoTool } from "./tools/my-agent-info";
import { registerPollTaskTool } from "./tools/poll-task";
import { registerPostMessageTool } from "./tools/post-message";
// Prompt template tools
import {
  registerDeletePromptTemplateTool,
  registerGetPromptTemplateTool,
  registerListPromptTemplatesTool,
  registerPreviewPromptTemplateTool,
  registerSetPromptTemplateTool,
} from "./tools/prompt-templates";
import { registerReadMessagesTool } from "./tools/read-messages";
import { registerRegisterAgentmailInboxTool } from "./tools/register-agentmail-inbox";
// Services capability
import { registerRegisterServiceTool } from "./tools/register-service";
// Repo management tools
import { registerGetReposTool, registerUpdateRepoTool } from "./tools/repos";
import { registerRequestHumanInputTool } from "./tools/request-human-input";
import { registerResolveUserTool } from "./tools/resolve-user";
// Scheduling capability
import {
  registerCreateScheduleTool,
  registerDeleteScheduleTool,
  registerListSchedulesTool,
  registerRunScheduleNowTool,
  registerUpdateScheduleTool,
} from "./tools/schedules";
import { registerSendTaskTool } from "./tools/send-task";
// Skills capability
import {
  registerSkillCreateTool,
  registerSkillDeleteTool,
  registerSkillGetTool,
  registerSkillInstallRemoteTool,
  registerSkillInstallTool,
  registerSkillListTool,
  registerSkillPublishTool,
  registerSkillSearchTool,
  registerSkillSyncRemoteTool,
  registerSkillUninstallTool,
  registerSkillUpdateTool,
} from "./tools/skills";
import { registerSlackDownloadFileTool } from "./tools/slack-download-file";
import { registerSlackListChannelsTool } from "./tools/slack-list-channels";
import { registerSlackPostTool } from "./tools/slack-post";
import { registerSlackReadTool } from "./tools/slack-read";
import { registerSlackReplyTool } from "./tools/slack-reply";
import { registerSlackUploadFileTool } from "./tools/slack-upload-file";
import { registerStoreProgressTool } from "./tools/store-progress";
// Swarm config tools
import {
  registerDeleteConfigTool,
  registerGetConfigTool,
  registerListConfigTool,
  registerSetConfigTool,
} from "./tools/swarm-config";
// Task pool capability
import { registerTaskActionTool } from "./tools/task-action";
// Tracker capability
import {
  registerTrackerLinkTaskTool,
  registerTrackerMapAgentTool,
  registerTrackerStatusTool,
  registerTrackerSyncStatusTool,
  registerTrackerUnlinkTool,
} from "./tools/tracker";
import { registerUnregisterServiceTool } from "./tools/unregister-service";
// Profiles capability
import { registerUpdateProfileTool } from "./tools/update-profile";
import { registerUpdateServiceStatusTool } from "./tools/update-service-status";
// Workflows capability
import {
  registerCancelWorkflowRunTool,
  registerCreateWorkflowTool,
  registerDeleteWorkflowTool,
  registerGetWorkflowRunTool,
  registerGetWorkflowTool,
  registerListWorkflowRunsTool,
  registerListWorkflowsTool,
  registerPatchWorkflowNodeTool,
  registerPatchWorkflowTool,
  registerRetryWorkflowRunTool,
  registerTriggerWorkflowTool,
  registerUpdateWorkflowTool,
} from "./tools/workflows";

// Capability-based feature flags
// Default: all capabilities enabled
const DEFAULT_CAPABILITIES =
  "core,task-pool,messaging,profiles,services,scheduling,memory,workflows";
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

  // User identity tools - always registered
  registerResolveUserTool(server);
  registerManageUserTool(server); // self-guards with lead check

  // Debug tools - always registered (self-guards with lead check)
  registerDbQueryTool(server);

  // Swarm config tools - always registered (config management is fundamental)
  registerSetConfigTool(server);
  registerGetConfigTool(server);
  registerListConfigTool(server);
  registerDeleteConfigTool(server);

  // Repo management tools - always registered (repo config is fundamental)
  registerGetReposTool(server);
  registerUpdateRepoTool(server);

  // Prompt template tools - always registered (prompt management is fundamental)
  registerListPromptTemplatesTool(server);
  registerGetPromptTemplateTool(server);
  registerSetPromptTemplateTool(server);
  registerDeletePromptTemplateTool(server);
  registerPreviewPromptTemplateTool(server);

  // Slack integration tools (always registered, will no-op if Slack not configured)
  registerSlackReplyTool(server);
  registerSlackReadTool(server);
  registerSlackPostTool(server);
  registerSlackListChannelsTool(server);
  registerSlackUploadFileTool(server);
  registerSlackDownloadFileTool(server);

  // AgentMail integration tool (always registered, self-service inbox mapping)
  registerRegisterAgentmailInboxTool(server);

  // Task pool capability - task pool operations (create unassigned, claim, release, accept, reject)
  if (hasCapability("task-pool")) {
    registerTaskActionTool(server);
  }

  // Messaging capability - channel-based communication
  if (hasCapability("messaging")) {
    registerListChannelsTool(server);
    registerCreateChannelTool(server);
    registerDeleteChannelTool(server);
    registerPostMessageTool(server);
    registerReadMessagesTool(server);
  }

  // Profiles capability - agent profile management
  if (hasCapability("profiles")) {
    registerUpdateProfileTool(server);
    registerContextHistoryTool(server);
    registerContextDiffTool(server);
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

  // Memory capability - persistent memory with vector search
  if (hasCapability("memory")) {
    registerMemorySearchTool(server);
    registerMemoryGetTool(server);
    registerMemoryDeleteTool(server);
    registerInjectLearningTool(server);
  }

  // Tracker capability - external issue tracker integration
  registerTrackerStatusTool(server);
  registerTrackerLinkTaskTool(server);
  registerTrackerUnlinkTool(server);
  registerTrackerSyncStatusTool(server);
  registerTrackerMapAgentTool(server);

  // Workflows capability - DAG-based automation workflows
  if (hasCapability("workflows")) {
    registerCreateWorkflowTool(server);
    registerListWorkflowsTool(server);
    registerGetWorkflowTool(server);
    registerUpdateWorkflowTool(server);
    registerPatchWorkflowTool(server);
    registerPatchWorkflowNodeTool(server);
    registerDeleteWorkflowTool(server);
    registerTriggerWorkflowTool(server);
    registerListWorkflowRunsTool(server);
    registerGetWorkflowRunTool(server);
    registerRetryWorkflowRunTool(server);
    registerCancelWorkflowRunTool(server);
    registerRequestHumanInputTool(server);
  }

  // Skills - always registered (skill management is available to all agents)
  registerSkillCreateTool(server);
  registerSkillUpdateTool(server);
  registerSkillDeleteTool(server);
  registerSkillGetTool(server);
  registerSkillListTool(server);
  registerSkillSearchTool(server);
  registerSkillInstallTool(server);
  registerSkillUninstallTool(server);
  registerSkillInstallRemoteTool(server);
  registerSkillSyncRemoteTool(server);
  registerSkillPublishTool(server);

  // MCP Servers - always registered
  registerMcpServerCreateTool(server);
  registerMcpServerUpdateTool(server);
  registerMcpServerDeleteTool(server);
  registerMcpServerGetTool(server);
  registerMcpServerListTool(server);
  registerMcpServerInstallTool(server);
  registerMcpServerUninstallTool(server);

  return server;
}
