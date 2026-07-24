import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json";
import { initDb } from "./be/db";
import { startPricingRefreshLoop } from "./be/pricing-refresh";
import { ensureRbacSeedsSynced } from "./be/rbac-roles";
import { seedPricingFromModelsDev } from "./be/seed-pricing";
import { registerGithubTaskReactions } from "./github/task-reactions";
import { loadGlobalConfigsIntoEnv } from "./http/core";
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
import { registerDeletePageTool } from "./tools/delete-page";
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
import { resolveScriptsOnlyMode } from "./utils/scripts-only-mode";

// Every known capability, including the ones disabled by default. Exported for
// surfaces that must see the full tool registry regardless of deployment
// defaults (tests, drift checks).
export const ALL_CAPABILITIES = [
  "core",
  "task-pool",
  "scripts",
  "config",
  "prompt-templates",
  "mcp",
  "profiles",
  "services",
  "scheduling",
  "memory",
  "workflows",
  "pages",
  "metrics",
  "kv",
  "slack",
  "tracker",
  "skills",
  "messaging",
  "repo",
  "agentmail",
  "kapso",
  "swarm-x",
] as const;

type CAPABILITIES_T = (typeof ALL_CAPABILITIES)[number];

// Capability-based feature flags
const DEFAULT_CAPABILITIES: string = [
  "core",
  "task-pool",
  "scripts",
  "config",
  "mcp",
  "profiles",
  "scheduling",
  "memory",
  "workflows",
  "pages",
  "metrics",
  "kv",
  "slack",
  "tracker",
  "skills",
  "repo",
  //
  // Disabled by default
  //
  // "services",
  // "prompt-templates",
  // "messaging",
  // "swarm-x",
  // "agentmail",
  // "kapso",
].join(",");

// Note: unknown names are kept (they never match hasCapability); workers
// reuse this env var for free-form skill tags, so dropping them here would
// break agent capability declarations. Empty entries (trailing commas) are
// filtered so they can't leak into enabledCapabilities payloads.
const getCapabilities = (): Set<CAPABILITIES_T> =>
  new Set(
    (process.env.CAPABILITIES || DEFAULT_CAPABILITIES)
      .split(",")
      .map((s) => s.trim() as CAPABILITIES_T)
      .filter((s) => s.length > 0),
  );

export function hasCapability(cap: CAPABILITIES_T): boolean {
  return getCapabilities().has(cap);
}

export function getEnabledCapabilities(): CAPABILITIES_T[] {
  return Array.from(getCapabilities());
}

/**
 * Experimental "code-mode" surface: when SCRIPTS_ONLY_MCP=true, the externally
 * exposed MCP server registers ONLY the reusable-script tools. Agents perform
 * every other swarm operation (task lifecycle, messaging, memory, kv, …) from
 * inside scripts via the SDK bridge (src/http/mcp-bridge.ts), which builds its
 * own full-surface server instance and is NOT affected by this flag.
 */
export function isScriptsOnlyMcp(): boolean {
  return resolveScriptsOnlyMode({ env: process.env.SCRIPTS_ONLY_MCP });
}

export function createServer(opts: { scriptsOnly?: boolean; fullSurface?: boolean } = {}) {
  // Reload env
  loadGlobalConfigsIntoEnv(true);

  // Capability flags shape the externally exposed MCP tool list only. Internal
  // full-surface consumers (the scripts SDK bridge, drift-check tests) pass
  // fullSurface to register every tool group regardless of CAPABILITIES.
  // This shadows the module-level hasCapability for the registrations below.
  const hasCapability = (cap: CAPABILITIES_T): boolean =>
    opts.fullSurface === true || getCapabilities().has(cap);

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

  // Scripts-only surface (experimental code-mode): register just the script
  // catalog tools and stop. script-connections / script-apis stay out — they
  // are lead-only security admin and excluded from the scripts SDK too.
  if (opts.scriptsOnly ?? isScriptsOnlyMcp()) {
    registerScriptSearchTool(server);
    registerScriptRunTool(server);
    registerScriptUpsertTool(server);
    registerScriptDeleteTool(server);
    registerScriptQueryTypesTool(server);
    registerScriptRunsTools(server);

    return server;
  }

  // Start of default-enabled capabilities

  // Core capability - swarm membership, task flow, progress, user identity, and lead debug tools
  if (hasCapability("core")) {
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

    // User identity tools
    registerResolveUserTool(server);
    registerManageUserTool(server); // self-guards with lead check

    // Debug tools (self-guard with lead check)
    registerDbQueryTool(server);
    registerGetOauthAccessTokenTool(server);
  }

  // Task pool capability - task pool operations (create unassigned, claim, release, accept, reject)
  if (hasCapability("task-pool")) {
    registerTaskActionTool(server);
  }

  // Config capability - swarm config management and credential bindings
  if (hasCapability("config")) {
    registerSetConfigTool(server);
    registerGetConfigTool(server);
    registerListConfigTool(server);
    registerDeleteConfigTool(server);
    registerCredentialBindingsTool(server);
  }

  // Scripts capability - reusable script catalog (HTTP MCP only in v1)
  if (hasCapability("scripts")) {
    registerScriptSearchTool(server);
    registerScriptConnectionsTool(server);
    registerScriptApisTool(server);
    registerScriptRunTool(server);
    registerScriptUpsertTool(server);
    registerScriptDeleteTool(server);
    registerScriptQueryTypesTool(server);
    registerScriptRunsTools(server);
  }

  // MCP capability - managed MCP server registry (CRUD + install/uninstall)
  if (hasCapability("mcp")) {
    registerMcpServerCreateTool(server);
    registerMcpServerUpdateTool(server);
    registerMcpServerDeleteTool(server);
    registerMcpServerGetTool(server);
    registerMcpServerListTool(server);
    registerMcpServerInstallTool(server);
    registerMcpServerUninstallTool(server);
  }

  // Profiles capability - agent profile management
  if (hasCapability("profiles")) {
    registerUpdateProfileTool(server);
    registerContextHistoryTool(server);
    registerContextDiffTool(server);
  }

  // Repo capability - repository configuration management
  if (hasCapability("repo")) {
    registerGetReposTool(server);
    registerUpdateRepoTool(server);
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
  if (hasCapability("tracker")) {
    registerTrackerStatusTool(server);
    registerTrackerLinkTaskTool(server);
    registerTrackerUnlinkTool(server);
    registerTrackerSyncStatusTool(server);
    registerTrackerMapAgentTool(server);
  }

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

  // Skills capability - installable skill packages (create, search, install, publish)
  if (hasCapability("skills")) {
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
  }

  // Pages capability - DB-backed lightweight artifacts (HTML / JSON specs).
  if (hasCapability("pages")) {
    registerCreatePageTool(server);
    registerDeletePageTool(server);
  }

  // Metrics capability - time-series metrics (DB-backed, for dashboards).
  if (hasCapability("metrics")) {
    registerCreateMetricTool(server);
  }

  // KV capability — namespaced Redis-like key/value (see src/be/migrations/061_kv_store.sql).
  if (hasCapability("kv")) {
    registerKvGetTool(server);
    registerKvSetTool(server);
    registerKvDeleteTool(server);
    registerKvIncrTool(server);
    registerKvListTool(server);
  }

  // Slack capability - Slack integration tools (no-op if Slack is not configured)
  if (hasCapability("slack")) {
    registerSlackReplyTool(server);
    registerSlackReadTool(server);
    registerSlackPostTool(server);
    registerSlackStartThreadTool(server);
    registerSlackListChannelsTool(server);
    registerSlackUploadFileTool(server);
    registerSlackDownloadFileTool(server);
    registerSlackDeleteTool(server);
    registerSlackUpdateTool(server);
  }

  // End of default-enabled capabilities
  // ----------------------------
  // Start of default-disabled capabilities

  // Prompt-templates capability - prompt template management (list/get/set/delete/preview)
  if (hasCapability("prompt-templates")) {
    registerListPromptTemplatesTool(server);
    registerGetPromptTemplateTool(server);
    registerSetPromptTemplateTool(server);
    registerDeletePromptTemplateTool(server);
    registerPreviewPromptTemplateTool(server);
  }

  // Agentmail capability - AgentMail integration (self-service inbox mapping)
  if (hasCapability("agentmail")) {
    registerRegisterAgentmailInboxTool(server);
  }

  // Kapso capability - Kapso/WhatsApp integration (native inbound provisioning + outbound)
  if (hasCapability("kapso")) {
    registerRegisterKapsoNumberTool(server);
    registerUnregisterKapsoNumberTool(server);
    registerSendWhatsappMessageTool(server);
    registerReplyWhatsappMessageTool(server);
  }

  // Swarm-x capability - external command routes mirroring the `agent-swarm x ...` CLI surface
  if (hasCapability("swarm-x")) {
    registerSwarmXTool(server);
  }

  // Messaging capability - internal swarm chat (post/read messages, channel CRUD)
  if (hasCapability("messaging")) {
    registerPostMessageTool(server);
    registerReadMessagesTool(server);

    // Channel management (CRUD on channels)
    registerListChannelsTool(server);
    registerCreateChannelTool(server);
    registerDeleteChannelTool(server);
  }

  // Services capability - PM2/background service registry
  if (hasCapability("services")) {
    registerRegisterServiceTool(server);
    registerUnregisterServiceTool(server);
    registerListServicesTool(server);
    registerUpdateServiceStatusTool(server);
  }

  return server;
}
