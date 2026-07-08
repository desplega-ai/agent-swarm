import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json";
import { initDb } from "./be/db";
import { startPricingRefreshLoop } from "./be/pricing-refresh";
import { ensureRbacSeedsSynced } from "./be/rbac-roles";
import { seedPricingFromModelsDev } from "./be/seed-pricing";
import { registerGithubTaskReactions } from "./github/task-reactions";
import { isRbacEnabled } from "./rbac";
import { registerCancelTaskTool } from "./tools/cancel-task";
import { registerContextDiffTool } from "./tools/context-diff";
import { registerContextHistoryTool } from "./tools/context-history";
import { registerCreateChannelTool } from "./tools/create-channel";
import { registerCreateMetricTool } from "./tools/create-metric";
import { registerCreatePageTool } from "./tools/create-page";
import { registerCredentialBindingsTool } from "./tools/credential-bindings";
import { registerDbQueryTool } from "./tools/db-query";
import { registerDeleteChannelTool } from "./tools/delete-channel";
import { registerGetMetricsTool } from "./tools/get-metrics";
import { registerGetSwarmTool } from "./tools/get-swarm";
import { registerGetTaskDetailsTool } from "./tools/get-task-details";
import { registerGetTasksTool } from "./tools/get-tasks";
import { registerInjectLearningTool } from "./tools/inject-learning";
import { registerJoinSwarmTool } from "./tools/join-swarm";
// KV capability
import {
  registerKvDeleteTool,
  registerKvGetTool,
  registerKvIncrTool,
  registerKvListTool,
  registerKvSetTool,
} from "./tools/kv";
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
import { registerMemoryEditTool } from "./tools/memory-edit";
import { registerMemoryGetTool } from "./tools/memory-get";
import { registerMemoryRateTool } from "./tools/memory-rate";
import { registerMemorySearchTool } from "./tools/memory-search";
import { registerMyAgentInfoTool } from "./tools/my-agent-info";
import { registerGetOauthAccessTokenTool } from "./tools/oauth-access-token";
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
import {
  registerRegisterKapsoNumberTool,
  registerUnregisterKapsoNumberTool,
} from "./tools/register-kapso-number";
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
  registerPatchScheduleTool,
  registerRunScheduleNowTool,
  registerUpdateScheduleTool,
} from "./tools/schedules";
import { registerScriptApisTool } from "./tools/script-apis";
import { registerScriptConnectionsTool } from "./tools/script-connections";
import { registerScriptDeleteTool } from "./tools/script-delete";
import { registerScriptQueryTypesTool } from "./tools/script-query-types";
import { registerScriptRunTool } from "./tools/script-run";
import { registerScriptRunsTools } from "./tools/script-runs";
import { registerScriptSearchTool } from "./tools/script-search";
import { registerScriptUpsertTool } from "./tools/script-upsert";
import { registerSendTaskTool } from "./tools/send-task";
// Skills capability
import {
  registerSkillCreateTool,
  registerSkillDeleteTool,
  registerSkillGetFileTool,
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
import { registerSlackDeleteTool } from "./tools/slack-delete";
import { registerSlackDownloadFileTool } from "./tools/slack-download-file";
import { registerSlackListChannelsTool } from "./tools/slack-list-channels";
import { registerSlackPostTool } from "./tools/slack-post";
import { registerSlackReadTool } from "./tools/slack-read";
import { registerSlackReplyTool } from "./tools/slack-reply";
import { registerSlackStartThreadTool } from "./tools/slack-start-thread";
import { registerSlackUpdateTool } from "./tools/slack-update";
import { registerSlackUploadFileTool } from "./tools/slack-upload-file";
import { registerStoreProgressTool } from "./tools/store-progress";
// Swarm config tools
import {
  registerDeleteConfigTool,
  registerGetConfigTool,
  registerListConfigTool,
  registerSetConfigTool,
} from "./tools/swarm-config";
import { registerSwarmXTool } from "./tools/swarm-x";
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
import {
  registerReplyWhatsappMessageTool,
  registerSendWhatsappMessageTool,
} from "./tools/whatsapp-message";
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
  "core,task-pool,profiles,services,scheduling,memory,workflows,pages,metrics,kv";
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
  // Phase 2: project the vendored models.dev snapshot into the pricing table.
  // Idempotent (INSERT OR IGNORE keyed on PK with effective_from=0); safe to
  // call on every boot. See src/be/seed-pricing.ts for the projection logic
  // and the manual-override constants for runtime-fee / ACU pricing.
  seedPricingFromModelsDev();
  startPricingRefreshLoop();
  try {
    ensureRbacSeedsSynced();
  } catch (err) {
    console.error("[startup] Failed to sync RBAC seed rows:", err);
    // RBAC flag-on must fail closed; flag-off deployments should not be bricked
    // by role-catalog drift for a disabled security feature.
    if (isRbacEnabled()) throw err;
  }

  // Subscribe API-side integrations to task-lifecycle events. Idempotent.
  // (Inverts the old be/db → github/task-reactions import; see cycle-break #4.)
  registerGithubTaskReactions();

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
  registerGetMetricsTool(server);
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
  registerGetOauthAccessTokenTool(server);

  // Swarm config tools - always registered (config management is fundamental)
  registerSetConfigTool(server);
  registerGetConfigTool(server);
  registerListConfigTool(server);
  registerDeleteConfigTool(server);
  registerCredentialBindingsTool(server);

  // Repo management tools - always registered (repo config is fundamental)
  registerGetReposTool(server);
  registerUpdateRepoTool(server);

  // Prompt template tools - always registered (prompt management is fundamental)
  registerListPromptTemplatesTool(server);
  registerGetPromptTemplateTool(server);
  registerSetPromptTemplateTool(server);
  registerDeletePromptTemplateTool(server);
  registerPreviewPromptTemplateTool(server);

  // Reusable script catalog tools - always registered (HTTP MCP only in v1).
  registerScriptSearchTool(server);
  registerScriptConnectionsTool(server);
  registerScriptApisTool(server);
  registerScriptRunTool(server);
  registerScriptUpsertTool(server);
  registerScriptDeleteTool(server);
  registerScriptQueryTypesTool(server);
  registerScriptRunsTools(server);

  // External command routes - mirrors the `agent-swarm x ...` CLI surface.
  registerSwarmXTool(server);

  // Slack integration tools (always registered, will no-op if Slack not configured)
  registerSlackReplyTool(server);
  registerSlackReadTool(server);
  registerSlackPostTool(server);
  registerSlackStartThreadTool(server);
  registerSlackListChannelsTool(server);
  registerSlackUploadFileTool(server);
  registerSlackDownloadFileTool(server);
  registerSlackDeleteTool(server);
  registerSlackUpdateTool(server);

  // AgentMail integration tool (always registered, self-service inbox mapping)
  registerRegisterAgentmailInboxTool(server);

  // Kapso/WhatsApp integration tools (native inbound provisioning + outbound)
  registerRegisterKapsoNumberTool(server);
  registerUnregisterKapsoNumberTool(server);
  registerSendWhatsappMessageTool(server);
  registerReplyWhatsappMessageTool(server);

  // Task pool capability - task pool operations (create unassigned, claim, release, accept, reject)
  if (hasCapability("task-pool")) {
    registerTaskActionTool(server);
  }

  // Core messaging tools - always registered (post/read are CORE_TOOLS)
  registerPostMessageTool(server);
  registerReadMessagesTool(server);

  // Messaging capability - channel management (CRUD on channels)
  if (hasCapability("messaging")) {
    registerListChannelsTool(server);
    registerCreateChannelTool(server);
    registerDeleteChannelTool(server);
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
    registerPatchScheduleTool(server);
    registerDeleteScheduleTool(server);
    registerRunScheduleNowTool(server);
  }

  // Memory capability - persistent memory with vector search
  if (hasCapability("memory")) {
    registerMemorySearchTool(server);
    registerMemoryGetTool(server);
    registerMemoryEditTool(server);
    registerMemoryDeleteTool(server);
    registerMemoryRateTool(server);
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
  registerSkillGetFileTool(server);
  registerSkillListTool(server);
  registerSkillSearchTool(server);
  registerSkillInstallTool(server);
  registerSkillUninstallTool(server);
  registerSkillInstallRemoteTool(server);
  registerSkillSyncRemoteTool(server);
  registerSkillPublishTool(server);

  // Pages capability - DB-backed lightweight artifacts (HTML / JSON specs).
  // Enabled by default (added to DEFAULT_CAPABILITIES in step-9 of the
  // db-backed-pages plan). Operators can disable via explicit
  // `CAPABILITIES=...` env without `pages`.
  if (hasCapability("pages")) {
    registerCreatePageTool(server);
  }

  if (hasCapability("metrics")) {
    registerCreateMetricTool(server);
  }

  // KV capability — namespaced Redis-like key/value (see src/be/migrations/061_kv_store.sql).
  // Enabled by default; opt out via `CAPABILITIES=...` without `kv`.
  if (hasCapability("kv")) {
    registerKvGetTool(server);
    registerKvSetTool(server);
    registerKvDeleteTool(server);
    registerKvIncrTool(server);
    registerKvListTool(server);
  }

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
