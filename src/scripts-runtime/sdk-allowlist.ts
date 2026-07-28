export const SDK_TOOL_NAME_MAP = {
  // ── memory ──
  memory_search: "memory-search",
  memory_get: "memory-get",
  memory_edit: "memory-edit",
  memory_rate: "memory_rate",
  memory_delete: "memory-delete", // destructive
  inject_learning: "inject-learning",

  // ── tasks ──
  task_list: "get-tasks",
  task_get: "get-task-details",
  task_storeProgress: "store-progress",
  task_poll: "poll-task",
  task_send: "send-task",
  task_cancel: "cancel-task", // destructive
  task_action: "task-action",

  // ── kv ──
  kv_get: "kv-get",
  kv_set: "kv-set",
  kv_del: "kv-delete",
  kv_incr: "kv-incr",
  kv_list: "kv-list",

  // ── repos ──
  repo_list: "get-repos",
  repo_update: "update-repo",

  // ── subscriptions ──
  subscription_create: "create-subscription",
  subscription_list: "list-subscriptions",
  subscription_patch: "patch-subscription",
  subscription_delete: "delete-subscription", // destructive

  // ── schedules ──
  schedule_list: "list-schedules",
  schedule_create: "create-schedule",
  schedule_update: "update-schedule",
  schedule_patch: "patch-schedule",
  schedule_delete: "delete-schedule", // destructive
  schedule_runNow: "run-schedule-now",

  // ── scripts ──
  script_search: "script-search",
  script_run: "script-run",
  script_upsert: "script-upsert",
  script_delete: "script-delete", // destructive
  script_queryTypes: "script-query-types",
  script_launchRun: "launch-script-run",
  script_getRun: "get-script-run",
  script_listRuns: "list-script-runs",

  // ── swarm / agent ──
  swarm_get: "get-swarm",
  agent_info: "my-agent-info",
  agent_join: "join-swarm",
  metrics_get: "get-metrics",
  user_resolve: "resolve-user",
  user_manage: "manage-user",
  db_query: "db-query",

  // ── config ──
  config_get: "get-config",
  config_list: "list-config",
  config_set: "set-config",
  config_delete: "delete-config", // destructive

  // ── slack ──
  slack_read: "slack-read",
  slack_listChannels: "slack-list-channels",
  slack_post: "slack-post", // external: sends to Slack
  slack_reply: "slack-reply", // external: sends to Slack
  slack_startThread: "slack-start-thread", // external: sends to Slack
  slack_uploadFile: "slack-upload-file", // external: sends to Slack
  slack_downloadFile: "slack-download-file",
  slack_delete: "slack-delete", // external: mutates Slack, destructive
  slack_update: "slack-update", // external: mutates Slack

  // ── messaging (internal) ──
  message_read: "read-messages",
  message_post: "post-message",

  // ── profiles ──
  profile_update: "update-profile",

  // ── context / profiles ──
  context_history: "context-history",
  context_diff: "context-diff",

  // ── services ──
  service_list: "list-services",
  service_register: "register-service",
  service_unregister: "unregister-service", // destructive
  service_updateStatus: "update-service-status",

  // ── workflows ──
  workflow_list: "list-workflows",
  workflow_get: "get-workflow",
  workflow_create: "create-workflow",
  workflow_update: "update-workflow",
  workflow_patch: "patch-workflow",
  workflow_patchNode: "patch-workflow-node",
  workflow_delete: "delete-workflow", // destructive
  workflow_trigger: "trigger-workflow",
  workflow_listRuns: "list-workflow-runs",
  workflow_getRun: "get-workflow-run",
  workflow_retryRun: "retry-workflow-run",
  workflow_cancelRun: "cancel-workflow-run", // destructive

  // ── prompt templates ──
  prompt_list: "list-prompt-templates",
  prompt_get: "get-prompt-template",
  prompt_set: "set-prompt-template",
  prompt_delete: "delete-prompt-template", // destructive
  prompt_preview: "preview-prompt-template",

  // ── tracker ──
  tracker_status: "tracker-status",
  tracker_syncStatus: "tracker-sync-status",
  tracker_linkTask: "tracker-link-task",
  tracker_unlink: "tracker-unlink", // destructive
  tracker_mapAgent: "tracker-map-agent",

  // ── skills ──
  skill_list: "skill-list",
  skill_get: "skill-get",
  skill_getFile: "skill-get-file",
  skill_search: "skill-search",
  skill_create: "skill-create",
  skill_update: "skill-update",
  skill_delete: "skill-delete", // destructive
  skill_install: "skill-install",
  skill_uninstall: "skill-uninstall", // destructive
  skill_publish: "skill-publish",

  // ── mcp servers ──
  mcpServer_list: "mcp-server-list",
  mcpServer_get: "mcp-server-get",
  mcpServer_create: "mcp-server-create",
  mcpServer_update: "mcp-server-update",
  mcpServer_delete: "mcp-server-delete", // destructive
  mcpServer_install: "mcp-server-install",
  mcpServer_uninstall: "mcp-server-uninstall", // destructive

  // ── pages & metrics ──
  page_create: "create_page",
  page_delete: "delete-page", // destructive
  metric_create: "create_metric",

  // ── human input ──
  request_humanInput: "request-human-input",
} as const;

export const SDK_ALLOWLIST = Object.keys(SDK_TOOL_NAME_MAP) as Array<
  keyof typeof SDK_TOOL_NAME_MAP
>;

/**
 * Script SDK methods served by first-party REST routes rather than MCP tools.
 * Keep these separate from SDK_TOOL_NAME_MAP: generated script types validate
 * every map entry against the MCP registry, and routing handler CRUD is
 * intentionally REST-only.
 */
export const SDK_REST_BRIDGE_METHODS = [
  "classify",
  "routing_handler_register",
  "routing_handler_list",
  "routing_handler_patch",
  "routing_handler_delete",
  "routing_dry_run",
] as const;

/**
 * SDK methods a script may call when it is running in READ-ONLY mode
 * (currently: routing handlers invoked from `POST /api/routing/dry-run`).
 *
 * Deliberately an explicit ALLOWLIST rather than a "deny the destructive ones"
 * list: this is a security control, so a newly added SDK method must default
 * to denied instead of silently becoming callable from a dry run.
 *
 * Excluded on purpose despite looking read-ish:
 * - `task_poll` — advertises `readOnlyHint` but actually CLAIMS a task.
 * - `script_run` / `script_launchRun` — execute arbitrary user code, which
 *   would trivially defeat the whole restriction.
 * - `routing_dry_run` — would let a dry run recursively spawn dry runs.
 * - `request_humanInput` — externally visible side effect.
 */
export const SDK_READ_ONLY_METHODS: ReadonlySet<string> = new Set<string>([
  // memory
  "memory_search",
  "memory_get",
  // tasks
  "task_list",
  "task_get",
  // kv
  "kv_get",
  "kv_list",
  // repos
  "repo_list",
  // subscriptions / schedules
  "subscription_list",
  "schedule_list",
  // scripts (metadata only — never execution)
  "script_search",
  "script_queryTypes",
  "script_getRun",
  "script_listRuns",
  // swarm / agent
  "swarm_get",
  "agent_info",
  "metrics_get",
  "user_resolve",
  "db_query", // executeReadOnlyQuery — writes are rejected server-side
  // NOTE: config_get / config_list are deliberately NOT here. They accept
  // `includeSecrets: true` and the config routes return unmasked values to an
  // authenticated agent; since the sandbox keeps open network egress, a
  // dry-run handler could read an arbitrary secret and post it elsewhere.
  // slack (read paths only — no post/reply/update/delete)
  "slack_read",
  "slack_listChannels",
  "slack_downloadFile",
  // messaging
  "message_read",
  // context
  "context_history",
  "context_diff",
  // services
  "service_list",
  // workflows (inspection only — no trigger/retry/cancel)
  "workflow_list",
  "workflow_get",
  "workflow_listRuns",
  "workflow_getRun",
  // prompt templates
  "prompt_list",
  "prompt_get",
  "prompt_preview",
  // tracker
  "tracker_status",
  "tracker_syncStatus",
  // skills
  "skill_list",
  "skill_get",
  "skill_getFile",
  "skill_search",
  // mcp servers
  "mcpServer_list",
  "mcpServer_get",
  // REST bridge
  "classify", // pure LLM call; the seeded continuity-pin policy needs it
  "routing_handler_list",
]);

export function isSdkMethodReadOnly(name: string): boolean {
  return SDK_READ_ONLY_METHODS.has(name);
}

/** Set of MCP tool names (values of SDK_TOOL_NAME_MAP) that scripts may call via the bridge. */
const MCP_TOOL_NAMES: ReadonlySet<string> = new Set<string>(Object.values(SDK_TOOL_NAME_MAP));

export function isSdkToolAllowed(name: string): boolean {
  return (
    (SDK_ALLOWLIST as readonly string[]).includes(name) ||
    (SDK_REST_BRIDGE_METHODS as readonly string[]).includes(name)
  );
}

/** True if `mcpToolName` (e.g. "trigger-workflow") corresponds to an allowlisted SDK method. */
export function isMcpToolAllowedForScripts(mcpToolName: string): boolean {
  return MCP_TOOL_NAMES.has(mcpToolName);
}

export function mcpToolNameForSdkMethod(name: string): string {
  return SDK_TOOL_NAME_MAP[name as keyof typeof SDK_TOOL_NAME_MAP] ?? name;
}
