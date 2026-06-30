---
name: swarm-scripts
description: Use swarm scripts for bulk SDK calls, repetitive fan-out, and context-efficient data processing.
---

# Swarm Scripts

Use swarm scripts when direct tool calls would create repetitive work, flood the context window, or require deterministic data processing across many records. Scripts run out-of-process with a typed Swarm SDK and return only the final result to your context.

## Decision Rubric

| Situation | Use |
|---|---|
| 1-10 SDK calls, result fits in context | Direct tool call |
| 10+ items or bulk fan-out SDK operations | Script |
| Heavy fetch, parse, transform, or aggregation | Script or context-mode |
| Single expensive web fetch | `ctx_fetch_and_index` |
| Multi-agent parallel work | Workflow |
| Logic needed across sessions or agents | Named script |

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
export default async function main(args: { status: string; limit: number }, ctx) {
  const { swarm, logger } = ctx;
  const result = await swarm.task_list({ status: args.status, limit: args.limit });
  logger.info(`Fetched ${result.tasks.length} tasks`);
  return {
    total: result.tasks.length,
    tasks: result.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      title: task.task.slice(0, 120),
    })),
  };
}
```

Keep logs useful but compact. The value returned from `main` is what comes back to your context.

## Named Script Pattern

Use `script-upsert` when the same logic is likely to be reused by another task or agent. Give the script a searchable name, a concrete description, and an intent that explains when to choose it.

Good named scripts:

- Aggregate failures by agent, schedule, or error family.
- Fetch and normalize a third-party API response.
- Fan out over many swarm tasks, memories, repos, or schedules.
- Convert noisy JSON or HTML into a compact summary.

## SDK And Context Gotchas

- `agentId` is propagated to scripts via the `X-Agent-ID` header, so SDK calls run as the invoking agent.
- `taskId` is not ambient. If a script needs to call `ctx.swarm.task_storeProgress`, pass `taskId` explicitly in `args`.
- Scripts invoked from a workflow script node may run with a workflow identity rather than a human or worker agent identity.
- Return compact structured data. Do not return raw logs, full HTML, huge JSON arrays, or large file contents.
- For a single large web fetch, prefer context-mode `ctx_fetch_and_index`; for repeated fetch/parse/aggregate work, prefer a script.

## Progress Updates From Scripts

Thread task identity explicitly:

```typescript
export default async function main(args: { taskId: string; items: string[] }, ctx) {
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
