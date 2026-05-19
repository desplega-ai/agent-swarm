/* script-smoke
{
  "name": "scripts-smoke-ctx-swarm-allowlist",
  "description": "Verify every ctx.swarm SDK allowlist method exposed to reusable scripts",
  "intent": "rich scripts api smoke ctx swarm allowlist",
  "args": {},
  "expect": {
    "exitCode": 0,
    "result": {
      "memory_search": "ok",
      "memory_get": "ok",
      "memory_rate": "ok",
      "task_list": "ok",
      "task_get": "ok",
      "task_storeProgress": "ok",
      "kv_get": "ok",
      "kv_set": "ok",
      "kv_del": "ok",
      "kv_incr": "ok",
      "kv_list": "ok",
      "repo_list": "ok",
      "schedule_list": "ok",
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
