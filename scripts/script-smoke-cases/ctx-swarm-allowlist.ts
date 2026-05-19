/* script-smoke
{
  "name": "scripts-smoke-ctx-swarm-allowlist",
  "description": "Verify every ctx.swarm SDK allowlist method exposed to reusable scripts",
  "intent": "rich scripts api smoke ctx swarm allowlist",
  "args": {},
  "expect": {
    "exitCode": 0,
    "result": {
      "memory_search": "error:Tool 'memory_search' is declared in the script SDK types but is not available from the scripts HTTP bridge yet",
      "memory_get": "error:Tool 'memory_get' is declared in the script SDK types but is not available from the scripts HTTP bridge yet",
      "memory_rate": "error:Tool 'memory_rate' is declared in the script SDK types but is not available from the scripts HTTP bridge yet",
      "task_list": "error:Tool 'task_list' is declared in the script SDK types but is not available from the scripts HTTP bridge yet",
      "task_get": "error:Tool 'task_get' is declared in the script SDK types but is not available from the scripts HTTP bridge yet",
      "task_storeProgress": "error:Tool 'task_storeProgress' is declared in the script SDK types but is not available from the scripts HTTP bridge yet",
      "kv_get": "error:Tool 'kv_get' is declared in the script SDK types but is not available from the scripts HTTP bridge yet",
      "kv_set": "error:Tool 'kv_set' is declared in the script SDK types but is not available from the scripts HTTP bridge yet",
      "kv_del": "error:Tool 'kv_del' is declared in the script SDK types but is not available from the scripts HTTP bridge yet",
      "kv_incr": "error:Tool 'kv_incr' is declared in the script SDK types but is not available from the scripts HTTP bridge yet",
      "kv_list": "error:Tool 'kv_list' is declared in the script SDK types but is not available from the scripts HTTP bridge yet",
      "repo_list": "error:Tool 'repo_list' is declared in the script SDK types but is not available from the scripts HTTP bridge yet",
      "schedule_list": "error:Tool 'schedule_list' is declared in the script SDK types but is not available from the scripts HTTP bridge yet",
      "script_search": "ok",
      "script_run": "ok"
    }
  }
}
*/

const missingUuid = "00000000-0000-4000-8000-000000000000";

const calls: Array<[string, unknown]> = [
  ["memory_search", { query: "allowlist smoke", limit: 1 }],
  ["memory_get", { memoryId: missingUuid }],
  ["memory_rate", { id: missingUuid, useful: true, note: "allowlist smoke" }],
  ["task_list", { limit: 1 }],
  ["task_get", { taskId: missingUuid }],
  ["task_storeProgress", { taskId: missingUuid, progress: "allowlist smoke" }],
  ["kv_get", { key: "allowlist-smoke" }],
  ["kv_set", { key: "allowlist-smoke", value: { ok: true } }],
  ["kv_del", { key: "allowlist-smoke" }],
  ["kv_incr", { key: "allowlist-smoke-counter", by: 1 }],
  ["kv_list", { prefix: "allowlist-smoke", limit: 1 }],
  ["repo_list", {}],
  ["schedule_list", { hideCompleted: true }],
  ["script_search", { query: "allowlist", limit: 1 }],
  [
    "script_run",
    {
      source: "export default async () => ({ nested: true });",
      args: {},
      intent: "allowlist nested inline script smoke",
    },
  ],
];

export default async (_args: unknown, ctx: any) => {
  const results: Record<string, string> = {};

  for (const [name, payload] of calls) {
    try {
      await ctx.swarm[name](payload);
      results[name] = "ok";
    } catch (error) {
      results[name] = `error:${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return results;
};
