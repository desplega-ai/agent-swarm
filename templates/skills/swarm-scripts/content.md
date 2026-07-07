# Swarm Scripts

Use swarm scripts when direct tool calls would create repetitive work, flood the context window, or require deterministic data processing across many records. Scripts run out-of-process with a typed Swarm SDK and return only the final result to your context.

## Decision Rubric

The canonical decision rubric lives in the prompt-template registry as `system.agent.script_rubric` and is injected into agent session prompts. Do not maintain a second script-vs-tool table in this skill; keeping one source of truth prevents drift between the session prompt and this reference.

Operationally, follow the prompt rubric: direct tool call below the ~10-call threshold; inline `script-run` for genuine one-offs; named script only when the logic will be invoked ≥2 times by you, another agent, or a workflow.

## Loading Script Tools

The script tools are deferred. Before authoring or running a script, load the relevant tools with ToolSearch:

```text
script-query-types
script-upsert
script-run
script-search
script-delete
```

Use `script-query-types` before non-trivial work so the script matches the live `swarm-sdk.d.ts` and stdlib signatures.

## Inline Script Pattern

Use `script-run` with inline source for one-off work:

```typescript
export default async function main(args: any, ctx: any) {
  const { swarm, logger } = ctx;
  // All SDK methods return Promise<unknown> — unwrap defensively.
  const res: any = await swarm.task_list({ status: args?.status, limit: args?.limit ?? 50 });
  const tasks: any[] = res?.data?.tasks ?? res?.tasks ?? [];
  logger.info(`Fetched ${tasks.length} tasks`);
  return {
    total: tasks.length,
    tasks: tasks.map((task: any) => ({
      id: task.id,
      status: task.status,
      title: task.task?.slice(0, 120),
    })),
  };
}
```

Keep logs useful but compact. The value returned from `main` is what comes back to your context.

## Named Script Pattern

Use `script-upsert` when the same logic is likely to be reused at least twice by another task, agent, or workflow. Give the script a searchable name, a concrete description, and an intent that explains when to choose it.

Good named scripts:

- Aggregate failures by agent, schedule, or error family.
- Fetch and normalize a third-party API response.
- Fan out over many swarm tasks, memories, repos, or schedules.
- Convert noisy JSON or HTML into a compact summary.

## Using `db_query` For Aggregation

For scripts that aggregate over tasks, sessions, or memory, `ctx.swarm.db_query` with direct SQL is far more efficient than fetching lists client-side.

**The parameter is `sql`:**

```typescript
// CORRECT
const res = await ctx.swarm.db_query({ sql: "SELECT status, count(*) as cnt FROM agent_tasks GROUP BY status" });

// Legacy scripts may still run with `query`, but new code should not use it.
```

**`db_query` returns positional rows, not objects.** The response shape is `{ rows: unknown[][], columns: string[] }`. Zip them into objects:

```typescript
function rowsToObjects(res: any): any[] {
  const p = res?.data ?? res;
  const cols: string[] = p?.columns ?? [];
  return (p?.rows ?? []).map((r: any) =>
    Array.isArray(r) ? Object.fromEntries(cols.map((c, i) => [c, r[i]])) : r,
  );
}

const rows = rowsToObjects(await ctx.swarm.db_query({
  sql: `SELECT status, count(*) as cnt FROM agent_tasks WHERE createdAt > datetime('now','-3 days') GROUP BY status`,
}));
// rows = [{ status: "completed", cnt: 42 }, ...]
```

**Common tables:** `agent_tasks` (tasks), `session_logs` (tool call logs), `agent_memory` (memories), `scheduled_tasks` (schedules), `agents` (agent registry).

**`session_logs` has no `tool_name` column.** Tool names are embedded in the `content` JSON column. Extract them SQL-side with `instr`/`substr` or parse JSON in JS after fetching.

## SDK And Context Gotchas

- **`args` can be undefined.** When a script is called without arguments, `args` is `undefined`. Always guard: `argsSchema.safeParse(args || {})` or use optional chaining (`args?.field`).
- **All SDK methods return `Promise<unknown>`.** Never assume a specific return shape without defensive unwrapping (`res?.data?.tasks ?? res?.tasks ?? []`). Run `script-query-types` to see live type signatures — return types are `unknown` and actual shapes vary by endpoint.
- `agentId` is propagated to scripts via the `X-Agent-ID` header, so SDK calls run as the invoking agent.
- `taskId` is not ambient. If a script needs to call `ctx.swarm.task_storeProgress`, pass `taskId` explicitly in `args`.
- Scripts invoked from a workflow script node may run with a workflow identity rather than a human or worker agent identity.
- Return compact structured data. Do not return raw logs, full HTML, huge JSON arrays, or large file contents.
- For a single large web fetch, prefer context-mode `ctx_fetch_and_index`; for repeated fetch/parse/aggregate work, prefer a script.

## Progress Updates From Scripts

Thread task identity explicitly:

```typescript
export default async function main(args: { taskId: string; items: string[] }, ctx: any) {
  const { swarm } = ctx;
  await swarm.task_storeProgress({
    taskId: args.taskId,
    progress: `Processing ${args.items.length} items with a script`,
  });
  return { processed: args.items.length };
}
```

Do not assume the runtime can infer the current task.

## Exposing Scripts as External APIs

Named scripts can be exposed as public HTTP endpoints — `POST /api/x/script/<id>` — for callers outside the swarm. Manage endpoints from the script's **API** tab in the dashboard, or programmatically with the `script-apis` tool (`list`/`create`/`update`/`rotate`/`delete`). `list` masks bearer tokens by default; pass `includeSecrets: true` to reveal them. `create`/`rotate` always return the fresh plaintext token once.
