export const SDK_TOOL_NAME_MAP = {
  memory_search: "memory-search",
  memory_get: "memory-get",
  memory_rate: "memory_rate",
  task_list: "get-tasks",
  task_get: "get-task-details",
  task_storeProgress: "store-progress",
  kv_get: "kv-get",
  kv_set: "kv-set",
  kv_del: "kv-delete",
  kv_incr: "kv-incr",
  kv_list: "kv-list",
  repo_list: "get-repos",
  schedule_list: "list-schedules",
  script_search: "script-search",
  script_run: "script-run",
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
