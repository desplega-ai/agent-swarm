export const SDK_TOOL_NAME_MAP = {
  // --- memory ---
  memory_search: "memory-search",
  memory_get: "memory-get",
  memory_rate: "memory_rate",
  // --- tasks ---
  task_list: "get-tasks",
  task_get: "get-task-details",
  task_storeProgress: "store-progress",
  task_poll: "poll-task",
  // --- kv ---
  kv_get: "kv-get",
  kv_set: "kv-set",
  kv_del: "kv-delete",
  kv_incr: "kv-incr",
  kv_list: "kv-list",
  // --- repos ---
  repo_list: "get-repos",
  // --- schedules ---
  schedule_list: "list-schedules",
  // --- scripts ---
  script_search: "script-search",
  script_run: "script-run",
  // --- swarm / agent ---
  swarm_get: "get-swarm",
  agent_info: "my-agent-info",
  metrics_get: "get-metrics",
  user_resolve: "resolve-user",
  db_query: "db-query",
  // --- config ---
  config_get: "get-config",
  config_list: "list-config",
  // --- slack ---
  slack_read: "slack-read",
  slack_listChannels: "slack-list-channels",
  // --- messaging ---
  message_read: "read-messages",
  // --- services ---
  service_list: "list-services",
  // --- context / profiles ---
  context_history: "context-history",
  context_diff: "context-diff",
  // --- workflows ---
  workflow_list: "list-workflows",
  workflow_get: "get-workflow",
  workflow_listRuns: "list-workflow-runs",
  workflow_getRun: "get-workflow-run",
  // --- prompt templates ---
  prompt_list: "list-prompt-templates",
  prompt_get: "get-prompt-template",
  // --- tracker ---
  tracker_status: "tracker-status",
} as const;

export const SDK_ALLOWLIST = Object.keys(SDK_TOOL_NAME_MAP) as Array<
  keyof typeof SDK_TOOL_NAME_MAP
>;

export function isSdkToolAllowed(name: string): boolean {
  return (SDK_ALLOWLIST as readonly string[]).includes(name);
}

export function mcpToolNameForSdkMethod(name: string): string {
  return SDK_TOOL_NAME_MAP[name as keyof typeof SDK_TOOL_NAME_MAP] ?? name;
}
