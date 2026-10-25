# Swarm Scripts

A swarm script is TypeScript that runs out of process with a typed Swarm SDK. Only its return value enters your context. Use one when direct tool calls would repeat, flood your context, or need deterministic processing over many records.

## When to script

| Situation | Approach |
|---|---|
| 1 to 9 SDK calls, result fits in context | Direct tool calls. |
| 10 or more similar calls, bulk or fan-out | Script. Inline `script-run` for a one-off, a named script for reuse. |
| Fetch, parse, and transform heavy data | Script, or `ctx_*` (context-mode) when your harness has it. |
| One large web fetch | `ctx_fetch_and_index` (context-mode). |
| A schedule, workflow, or API script that reads or writes drive files | Script with `ctx.fs` and `ctx.sh`. |
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
| `delegate` | `{ agentName, task, routingReason, routingNote, parentTaskId? }` | a subtask for an agent by name, returns `{ taskId }` |
| `wait-for-task` | `{ taskId }` | waits up to about 25 s for a terminal state, returns `{ done, status, output }`; call again while `done` is false |
| `get-child-outputs` | `{ parentTaskId }` | every child with status and output |
| `complete-task` | `{ taskId, output }` | finish a task from inside a script |
| `report-progress` | `{ taskId, note }` | a progress note from inside a script |
| `swarm-overview` | `{}` | agents and task counts |
| `schedule-health`, `task-failure-audit`, `boot-triage` | see `heartbeat-runbook` | the lead's heartbeat data gathering |

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
- Both `zod` and `zod/mini` imports work. Use `import * as z from "zod/mini"` for smaller QuickJS bundles. Mini uses functional forms: `z.optional(z.string())`, `z._default(z.number(), 10)`, and `z.string().check(z.minLength(1))`; its schemas still have `.parse()` and `.safeParse()`.
- Inline source through `script-run` runs without a typecheck. `script-upsert` typechecks before it saves. Import `ScriptContext` from `"swarm-sdk"` in inline code too, so promotion to a named script works.
- SDK methods return `Promise<unknown>`. Responses are usually wrapped: read `res?.data ?? res`. Exception: `app_query` with a literal `appId` and `query` returns rows typed from the app's columns.
- `agentId` is propagated through the `X-Agent-ID` header, so SDK calls run as you. `taskId` is not ambient: pass it in `args` when the script calls `task_storeProgress`.
- A script invoked from a workflow node may run under a workflow identity.
- Return compact structured data. Raw logs, full HTML, big JSON arrays, and file contents stay inside the script.
- Limits: about 30 s wall clock (up to 5 minutes where the tool exposes it), 1 MB stdout. Never sleep or loop past about 25 s. Chain `wait-for-task` calls instead. The cap also applies to a script called through `ctx.step.swarmScript`; the step's `timeoutMs` does not extend it. A long LLM call, such as a 2,000-word draft, goes in a `ctx.step.rawLlm` step inside `launch-script-run`, never in a called script. A `targetType: "script"` schedule gets 60 s; a manual `script-run` gets 30 s, so a candidate that finishes well under 30 s by hand has margin on the schedule. A nested `ctx.swarm.script_run` gets its own 30 s but runs inside its caller's remaining time: run slow children as sibling calls from the outer script, not deeper in the chain.

### What `ctx` holds

- `ctx.swarm.*`: the swarm SDK. `task_get`, `task_send`, `task_storeProgress`, `task_action`, `task_list`, `slack_reply`, `memory_search`, `memory_store`, `kv_get`, `kv_getOrNull`, `kv_set`, `kv_delete`, `kv_incr`, `kv_list`, `swarm_get`, `agent_info`, `db_query`, and more. `kv_getOrNull` returns the entry, `null` on a missing key, and throws on other errors.
- `ctx.swarm.task_send` requires `routingReason` and `routingNote` whenever `agentId` is present. The note must explain the worker choice in at least 10 characters after trimming whitespace (maximum 200 characters). Use `human_pinned` for an explicit/configured choice, `skill` for a role or specialization match, `continuity` for the same worker/session, `reroute_fault` for a fault handoff, or `overflow` for capacity/pool escalation. Omit both `agentId` and routing fields for the pool.
- `ctx.swarm.config`: `apiKey`, `agentId`, `mcpBaseUrl`, and `ctx.swarm.config.get("KEY")` for swarm config values, resolved for the agent running the script (agent scope over global, the same rows `get-config` returns for that agent). A key that is not set returns `undefined`, so `config.get("KEY") ?? fallback` works. All are `Redacted` wrappers that stringify to `<redacted>`. Never unwrap one into a return value, a log line, or a request body you build by hand.
- `ctx.api.<slug>` and `ctx.mcp.<slug>`: typed clients for registered connections. They exist only for registered connections. Introspect with `Object.keys(ctx.api ?? {})` and `Object.keys(ctx.mcp ?? {})`.
- `ctx.fs` and `ctx.sh`: files and bash. See "Files and shell" below.
- `ctx.stdlib`: `fetch`, `fetchJson` (retries, 30 s timeout), `grep`, `glob`, `table`, `Redacted`.
- `ctx.logger`: `log`, `warn`, `error`. Keep logs short.

### Files and shell

```ts
await ctx.fs.writeFile("/afs/reports/today.md", "# Today\n");      // your agent-fs drive
await ctx.sh("echo '- shipped' >> reports/today.md");              // cwd is /afs
const { stdout, exitCode } = await ctx.sh("grep -rn TODO /afs/notes | sort | head -20");
```

- `/afs/...` is your default agent-fs drive, with your own permissions. It persists. Every other path (`/tmp`, `/work`) is memory that ends with the run. Relative paths resolve against `/afs`.
- `ctx.fs`: `readFile`, `writeFile`, `appendFile`, `readdir`, `stat`, `exists`, `mkdir`, `rm`, `cp`, `mv`. UTF-8 text only.
- `ctx.sh(command, { cwd, env, stdin })` returns `{ stdout, stderr, exitCode }` and does not throw on a failed command. Check `exitCode`.
- `ctx.sh` is just-bash, a bash interpreter in TypeScript: pipes, globs, `grep`, `sed`, `awk`, `jq`, `sort`, `wc`, `find`, `xargs`. No `git`, `curl`, `node`, `python`, or network. Files stay across calls in one run; `cd`, `env`, and variables do not.
- Limits per run: 64 MiB of scratch files, about 30,000 scratch entries (8 MiB of names and entries), 64 MiB per command, and 64 MiB per `/afs` file read (`EFBIG`). Scratch names have at most 255 characters.
- Without agent-fs for your agent, an `/afs` path fails with `agent-fs is not configured for this agent`, in `ctx.fs` and in shell redirects. Scratch and `ctx.sh` still work.
- Use `/afs` paths directly. A scratch symlink into `/afs` fails (`EXDEV` when the drive is mounted).
- A change that another agent makes to the drive can take up to 5 seconds to show in `ls` or `stat` during a run. Your own writes show at once.

### Durable workflow scripts

`launch-script-run` runs a script as a durable, journaled run with a different `ctx`: `ctx.run` (`id`, `agentId`, `args`) and `ctx.step.rawLlm(label, config)`, `ctx.step.agentTask(label, config)`, `ctx.step.swarmScript(label, config)`, plus `ctx.swarm.*`, `ctx.stdlib`, `ctx.logger`. Durable runs have no `ctx.api`, no `ctx.mcp`, no `ctx.fs`, no `ctx.sh`, and no `ctx.swarm.config`. A configured `ctx.step.agentTask` `agentId` records `human_pinned` unless `routingReason` is supplied. Call a connection or the drive from an inner script through `ctx.step.swarmScript`. See the `script-workflows` skill.

- Each `ctx.step.agentTask` step is a normal worker task (`taskType: "script-run-step"`). When it finishes, the lead gets the usual "Worker task completed — review needed" follow-up, even while the run is still awaiting that step. The step config has no `followUpConfig` field, so a value passed there is dropped. Let the script's own judge step be the gate and close those follow-ups with a one-line accept.
- When a crash supersedes an in-flight step and resumes it as a new task, the run does not follow the new task id: it can stay `failed` (for example `write EPIPE`) while the resumed task completes. Check the resumed task's output before you re-launch the run.

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

A config row reaches your shell env only when its `exportToEnv` flag is on. If `$KEY` is empty in your shell but `get-config` or `list-config` shows the row marked `not in agent env`, the row stays server-side on purpose: do not copy the value into a file, an env var, or a command. Use it from a script instead, through one of the paths below. Harness, git, and agent-fs credentials stay exported. Keys only the API server reads (Slack app token and signing secret, GitHub App private key, webhook and OAuth client secrets) can never be exported. If a recipe genuinely needs the variable in a shell, ask the lead to turn `exportToEnv` on for that row (`set-config` with `exportToEnv: true`); it applies to your next task.

Order of preference:

1. A registered connection: `ctx.api.<slug>.<operationId>({ path, query, header, body })` (OpenAPI), `ctx.api.<slug>.graphql(query, variables)` (GraphQL), `ctx.mcp.<slug>.<toolName>(args)` (MCP, proxied server-side, returns the raw MCP envelope: read `res.structuredContent ?? res.content?.[0]?.text`). Credentials attach at egress. The script never sees them. OAuth tokens refresh on their own.
2. A credential binding placeholder in a hand-written request: `Authorization: Bearer [REDACTED:GITHUB_TOKEN]`. The runtime substitutes the value at egress, only for the binding's allowed hosts.
3. `ctx.swarm.config.get("KEY")` for a config value you pass to `ctx.stdlib.fetch` as a header value. Unwrap it with `ctx.stdlib.Redacted.value(...)` inside the header itself (a wrapped value sends the literal `<redacted>`), and never log it. Secret values are scrubbed from run output. Not available in `launch-script-run` (durable runs have no `ctx.swarm.config`): collect there without secrets, then pass the run's output to a short `script-run` that makes the authenticated calls.

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

### Response traps

- Every `ctx.swarm.*` response passes the secret scrubber. Text shaped like a secret-looking `key=value` assignment comes back as `[REDACTED:<key>]`, so code, HTML or profile text read through `kv_get`, `db_query` or a page read can differ from the stored bytes. Never write such a read back verbatim. Read stored text as `hex(...)` through `db_query`, decode it in the script, and refuse to publish or write when the result contains `[REDACTED:`.
- `db_query` rejects any SQL containing `;`, even inside a string literal. Pass such literals through `params`.
- `db_query` caps rows without an error (1000 in scripts). Aggregate in SQL and confirm totals with `COUNT(*)`.
- `kv_get` returns the entry at `data`: read `res.data.value`. The MCP tool shape `entry.value` reads `undefined` in a script.
- `script_run` returns an envelope (`result`, `truncated`, `durationMs`, `stdout`, `stderr`, `exitCode`). The callee payload is at `.result`. Take key names from a real response: a guessed key that is absent reads as a false zero.
- An `argsSchema` validation error fires before the body runs and repeats on every retry. Fix the args instead of retrying.
- The skill methods disagree on the id field: `skill_get({ id })`, but `skill_update({ skillId, content })`. `skill_update({ id, content })` returns outer `success: true` with inner `data.success: false` ("skillId is required.") and writes nothing. Gate a write on `res.data.success`, then re-read: the version must increase and the content must match the draft.
- Write a dedup or idempotency marker only after the step succeeds. A marker written after a failure blocks the next real attempt.
- `kv_set` returns `success: false` instead of throwing when a key has a character outside `[a-zA-Z0-9._:/-]` (for example `#` or `|` from a git ref). Check `success` after every write.
- `script_run` without `scope` runs an agent-scoped row of the same name before the global one, so a stale private copy silently wins. Pass `scope: "global"` for a shared script.
- A nested `script_run` does not overlap with the caller's own `ctx.stdlib.fetch` calls: started alongside them it added about 8 s to one measured run. Start it after the caller's own queries.

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
