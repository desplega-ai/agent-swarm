# @desplega.ai/agent-swarm-sdk

Typed client for the [Agent Swarm](https://agent-swarm.dev) API. One call sends a task and waits for its result.

```ts
import { createSwarm } from "@desplega.ai/agent-swarm-sdk";

const swarm = createSwarm(); // reads AGENT_SWARM_API_KEY and AGENT_SWARM_URL

const task = await swarm.tasks.run("Summarize yesterday's merged PRs");
console.log(task.output);
```

```bash
npm i @desplega.ai/agent-swarm-sdk
```

No runtime dependencies. It uses the global `fetch`, so it runs in Node 18+, Bun, Deno, and browsers.

## Setup

`createSwarm(options?)` takes:

| Option | Default | |
|---|---|---|
| `apiKey` | `AGENT_SWARM_API_KEY`, then `API_KEY` | Sent as `Authorization: Bearer` |
| `baseUrl` | `AGENT_SWARM_URL`, then `MCP_BASE_URL`, then `http://localhost:3013` | |
| `agentId` | `AGENT_ID` | Sent as `X-Agent-ID`. `scripts.run` needs it |
| `headers` | | Extra headers on every request |
| `fetch` | global `fetch` | For tests or a custom transport |

With no key it throws a `missing_api_key` error at once, not on the first request.

## Methods

```ts
await swarm.tasks.send("Fix the flaky login test");          // Task (string or the full POST /api/tasks body)
await swarm.tasks.send({ task: "...", agentId, tags: ["ci"] }, { idempotencyKey: "build-123" });
await swarm.tasks.get(id);                                    // TaskDetails, with logs and attachments
await swarm.tasks.wait(id, { timeoutMs: 600_000, signal });   // resolves on any terminal status
await swarm.tasks.run("...", { timeoutMs: 600_000 });         // send + wait, throws unless completed

await swarm.agents.list({ q: "coder" });                      // Agent[]
await swarm.memory.search("deploy runbook", { limit: 5 });    // MemoryResult[]
await swarm.scripts.run("pr-triage-leads", { pr: 12 });       // ScriptRun (needs agentId)
```

`wait` polls every 2 s (`intervalMs`), retries network and 5xx errors, and gives up after 30 minutes by default.

## Errors

Every failure is a `SwarmError`. Branch on `code`:

```ts
import { SwarmError } from "@desplega.ai/agent-swarm-sdk";

try {
  await swarm.tasks.run("Ship the release notes");
} catch (error) {
  if (error instanceof SwarmError && error.code === "task_failed") {
    console.log(error.task?.failureReason);
  } else throw error;
}
```

| Code | When |
|---|---|
| `missing_api_key` | No key in options or env |
| `network_error` | No response (server down, DNS, CORS) |
| `bad_request` `unauthorized` `forbidden` `not_found` `conflict` `rate_limited` `server_error` `http_error` | Non-2xx response. `status`, `body`, and `retryAfter` (429) are set |
| `timeout` | `wait` ran out of time. `task` holds the last state seen |
| `aborted` | The `signal` fired |
| `task_failed` | `run` ended with a status other than `completed`. `task` is set |
| `script_failed` | `scripts.run` errored or exited non-zero. `run` holds stdout, stderr, and the error |

`hint` says how to fix the error when there is a known fix.

## Types

Request and response types are generated from the server's `openapi.json`. Only the operations above are included, so the package stays small. `Task`, `TaskDetails`, `Agent`, `MemoryResult`, `ScriptRun`, and the raw `paths` and `components` are exported.

Regenerate after an API change. `bun run docs:openapi` at the repo root does this for you:

```bash
bun run --cwd packages/agent-swarm-sdk gen:types
```

To call a new operation, add it to `OPERATIONS` in `scripts/gen-types.ts`, then regenerate.

## Develop

```bash
cd packages/agent-swarm-sdk
bun test         # unit tests, mocked fetch
bun run tsc      # type check
bun run build    # dist/index.js + .d.ts
```
