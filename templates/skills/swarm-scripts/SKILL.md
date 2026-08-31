---
name: swarm-scripts
description: "Bulk, repeat, fan-out, or data-heavy work: write and run swarm scripts (inline `script-run`, named `script-upsert`, durable `launch-script-run`). Covers the script-vs-tool rubric, the authoring contract (`args` first, `ctx` second), the seed catalog, connections and secrets, `db_query`, and exposing a script as an API."
---

# Swarm Scripts

A swarm script is TypeScript that runs out of process with a typed Swarm SDK. Only its return value enters your context. Use one when direct tool calls would repeat, flood your context, or need deterministic processing over many records.

## When to script

| Situation | Approach |
|---|---|
| 1 to 9 SDK calls, result fits in context | Direct tool calls. |
| 10 or more similar calls, bulk or fan-out | Script. Inline `script-run` for a one-off, a named script for reuse. |
| Fetch, parse, and transform heavy data | Script, or `ctx_*` (context-mode) when your harness has it. |
| One large web fetch | `ctx_fetch_and_index` (context-mode). |
| Multi-agent fan-out, parallel work, deterministic pipeline | Workflow. See `workflow-iterate`. |
| Work that repeats on a clock | Schedule. See `scheduling`. |

Named script only when the logic will run two or more times, by you, another agent, a schedule, or a workflow. A one-off goes inline, so the catalog does not fill with scratch saves.

Reference point: a workflow triage that took about 26 tool calls returns as one result of about 4k tokens in about 13 seconds.

## Loading the tools

The script tools are deferred. Load them with your harness tool search before the first call: `script-search`, `script-run`, `script-upsert`, `script-query-types`, `script-delete`, and for durable runs `launch-script-run`, `get-script-run`, `list-script-runs`.

Run `script-query-types` before non-trivial work. It returns the live `swarm-sdk.d.ts` and stdlib declarations, including generated per-app types.

## Seed catalog

The swarm ships named scripts at global scope. Each one replaces a multi-step tool chain. `script-search` with a plain-language description finds them. Call one with `script-run` and `name` plus `args`.

| Script | Args | Use |
|---|---|---|
| `task-context-gathering` | `{ taskId, queries: [...] }` | the task plus a deduplicated multi-query memory recall |
| `smart-recall` | `{ queries: [...] }` | multi-query memory recall without the task |
| `memory-dedup-check` | `{ text, threshold? }` | near-duplicates before you store a memory |
| `delegate` | `{ agentName, task, parentTaskId? }` | a subtask for an agent by name, returns `{ taskId }` |
| `wait-for-task` | `{ taskId }` | waits up to about 25 s for a terminal state, returns `{ done, status, output }`; call again while `done` is false |
| `get-child-outputs` | `{ parentTaskId }` | every child with status and output |
| `complete-task` | `{ taskId, output }` | finish a task from inside a script |
| `report-progress` | `{ taskId, note }` | a progress note from inside a script |
| `swarm-overview` | `{}` | agents and task counts |
| `Heartbeat Audit`, `boot-triage` | see `heartbeat-runbook` | the lead's heartbeat data gathering |

## Authoring contract

The entry point takes `args` first and `ctx` second. A one-parameter `function (ctx)` receives `args` at runtime, so every `ctx.*` access throws. This is the most common cause of a failed run.

```ts
import type { ScriptContext } from "swarm-sdk";
import * as z from "zod";

export const argsSchema = z.object({ taskId: z.string(), limit: z.number().optional() });

export default async function (args: z.infer<typeof argsSchema>, ctx: ScriptContext) {
  const res = await ctx.swarm.task_get({ taskId: args.taskId });
  const task = ((res as { data?: unknown }).data ?? res) as { title?: string };
  return { title: task?.title };
}
```

- `args` can be `undefined` when a caller passes none. Guard with `argsSchema.safeParse(args ?? {})` or optional chaining.
- Export a Zod `argsSchema` from every named script. `script-upsert` converts it to JSON Schema, so callers, schedules, and workflows see the input contract.
- Inline source through `script-run` runs without a typecheck. `script-upsert` typechecks before it saves. Import `ScriptContext` from `"swarm-sdk"` in inline code too, so promotion to a named script works.
- SDK methods return `Promise<unknown>`. Responses are usually wrapped: read `res?.data ?? res`. Exception: `app_query` with a literal `appId` and `query` returns rows typed from the app's columns.
- `agentId` is propagated through the `X-Agent-ID` header, so SDK calls run as you. `taskId` is not ambient: pass it in `args` when the script calls `task_storeProgress`.
- A script invoked from a workflow node may run under a workflow identity.
- Return compact structured data. Raw logs, full HTML, big JSON arrays, and file contents stay inside the script.
- Limits: about 30 s wall clock (up to 5 minutes where the tool exposes it), 1 MB stdout. Never sleep or loop past about 25 s. Chain `wait-for-task` calls instead.

### What `ctx` holds

- `ctx.swarm.*`: the swarm SDK. `task_get`, `task_send`, `task_storeProgress`, `task_action`, `task_list`, `slack_reply`, `memory_search`, `memory_store`, `kv_get`, `kv_getOrNull`, `kv_set`, `kv_delete`, `kv_incr`, `kv_list`, `swarm_get`, `agent_info`, `db_query`, and more. `kv_getOrNull` returns the entry, `null` on a missing key, and throws on other errors.
- `ctx.swarm.config`: `apiKey`, `agentId`, `mcpBaseUrl`, and `ctx.swarm.config.get("KEY")` for user config values. All are `Redacted` wrappers that stringify to `<redacted>`. Never unwrap one into a return value, a log line, or a request body you build by hand.
- `ctx.api.<slug>` and `ctx.mcp.<slug>`: typed clients for registered connections. They exist only for registered connections. Introspect with `Object.keys(ctx.api ?? {})` and `Object.keys(ctx.mcp ?? {})`.
- `ctx.stdlib`: `fetch`, `fetchJson` (retries, 30 s timeout), `grep`, `glob`, `table`, `Redacted`.
- `ctx.logger`: `log`, `warn`, `error`. Keep logs short.

### Durable workflow scripts

`launch-script-run` runs a script as a durable, journaled run with a different `ctx`: `ctx.run` (`id`, `agentId`, `args`) and `ctx.step.rawLlm(label, config)`, `ctx.step.agentTask(label, config)`, `ctx.step.swarmScript(label, config)`, plus `ctx.swarm.*`, `ctx.stdlib`, `ctx.logger`. Durable runs have no `ctx.api`, no `ctx.mcp`, and no `ctx.swarm.config`. Call a connection from an inner script through `ctx.step.swarmScript`. See the `script-workflows` skill.

## Inline script pattern

```typescript
import type { ScriptContext } from "swarm-sdk";

export default async function main(args: { status?: string; limit?: number } | undefined, ctx: ScriptContext) {
  const res: any = await ctx.swarm.task_list({ status: args?.status, limit: args?.limit ?? 50 });
  const tasks: any[] = res?.data?.tasks ?? res?.tasks ?? [];
  ctx.logger.log(`Fetched ${tasks.length} tasks`);
  return {
    total: tasks.length,
    tasks: tasks.map((task: any) => ({ id: task.id, status: task.status, title: task.task?.slice(0, 120) })),
  };
}
```

## Named script pattern

`script-upsert` with a searchable name, a concrete description, and an intent that says when to choose it. Good named scripts: aggregate failures by agent, schedule, or error family; fetch and normalize a third-party API response; fan out over tasks, memories, repos, or schedules; turn noisy JSON or HTML into a compact summary.

## Secrets

Order of preference:

1. A registered connection: `ctx.api.<slug>.<operationId>({ path, query, header, body })` (OpenAPI), `ctx.api.<slug>.graphql(query, variables)` (GraphQL), `ctx.mcp.<slug>.<toolName>(args)` (MCP, proxied server-side, returns the raw MCP envelope: read `res.structuredContent ?? res.content?.[0]?.text`). Credentials attach at egress. The script never sees them. OAuth tokens refresh on their own.
2. A credential binding placeholder in a hand-written request: `Authorization: Bearer [REDACTED:GITHUB_TOKEN]`. The runtime substitutes the value at egress, only for the binding's allowed hosts.
3. `ctx.swarm.config.get("KEY")` for a config value you pass to `ctx.stdlib.fetch` as a header value. Still `Redacted`; never log it.

A raw secret, or the output of `get-config` with `includeSecrets: true`, must not appear in script source, script `args`, a schedule's `taskTemplate` or `scriptArgs`, or a task description. Those are stored as plain text and replayed on every run.

Registration is lead-only: `script-connections` and `credential-bindings`. A worker that needs a missing connection puts the request in its task output: `slug`, `baseUrl` or spec URL, `allowedHosts`, and the auth (config key or OAuth provider). Leads: `upsert-openapi` with a spec URL keeps operations refreshable; `credential-bindings` `oauth-app-upsert` then `oauth-authorize-url` sets up an OAuth provider (`tokenAuthStyle` and `tokenBodyFormat` cover Notion-style token endpoints).

Full reference: the "Script connections" guide on the docs site.

## `db_query` for aggregation

Direct SQL beats fetching lists into the script. The parameter is `sql`:

```typescript
const res = await ctx.swarm.db_query({ sql: "SELECT status, count(*) AS cnt FROM agent_tasks GROUP BY status" });
```

`db_query` returns positional rows: `{ rows: unknown[][], columns: string[] }`. Zip them:

```typescript
function rowsToObjects(res: any): any[] {
  const p = res?.data ?? res;
  const cols: string[] = p?.columns ?? [];
  return (p?.rows ?? []).map((r: any) =>
    Array.isArray(r) ? Object.fromEntries(cols.map((c, i) => [c, r[i]])) : r,
  );
}
```

### Concurrency limit

`ctx.swarm.db_query` throttles at about three concurrent calls. A wider `Promise.all` fan-out can return 429 responses with no `rows` key, so `res?.data?.rows ?? []` misreads throttling as a clean zero. Check the response status and `data.error` before reading `rows`. Serialize queries or cap concurrency at three.

Common tables: `agent_tasks`, `session_logs`, `agent_memory`, `scheduled_tasks`, `agents`. `session_logs` has no `tool_name` column. Tool names sit inside the `content` JSON column. Extract them with `instr` and `substr` in SQL, or parse the JSON in the script.

## Progress from a script

```typescript
export default async function main(args: { taskId: string; items: string[] }, ctx: ScriptContext) {
  await ctx.swarm.task_storeProgress({ taskId: args.taskId, progress: `Processing ${args.items.length} items` });
  return { processed: args.items.length };
}
```

## Exposing a script as an API

A named script can serve `POST /api/x/script/<id>` for callers outside the swarm. Manage endpoints from the script's API tab in the dashboard, or with the `script-apis` tool (`list`, `create`, `update`, `rotate`, `delete`). `list` masks bearer tokens; `includeSecrets: true` reveals them. `create` and `rotate` return the plaintext token once.
