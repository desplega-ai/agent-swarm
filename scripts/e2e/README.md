# Black-box E2E runner

`bun run e2e` boots the real API server on a free port with a fresh SQLite database, a mock
Slack workspace and a mock inference host, then runs deterministic scenarios against it over
HTTP and MCP. No Docker, no model, no access to `src/`. The runner sees exactly what an
operator sees: the API, the keys, and a read-only handle on the database file.

The suite is the reliability contract of the swarm. `--strict` fails when any route
operation, MCP tool or workflow node type the server exposes is neither covered by a
scenario nor excluded with a reason in `coverage-manifest.json`. CI runs strict.

```bash
bun run e2e                       # every scenario, coverage report, no gate
bun run e2e --strict              # the CI contract
bun run e2e --only <name>,<name>  # while authoring
bun run e2e --list                # scenario names in run order
bun run e2e --keep                # keep the db, logs and temp dirs after the run
bun run e2e:tsc                   # type check the runner (scripts/e2e/tsconfig.json)
bash scripts/check-e2e-boundary.sh
```

Operator docs live in [runbooks/e2e-blackbox.md](../../runbooks/e2e-blackbox.md) and
[LOCAL_TESTING.md § Black-box E2E](../../LOCAL_TESTING.md#black-box-e2e-bun-run-e2e).
This file is the authoring guide.

## Layout

| Path | Role |
|---|---|
| `run.ts` | Entry point. Boots mocks + SUT, runs scenarios in `order`, computes coverage, applies gates, writes reports. |
| `sut.ts` | Spawns `bun run src/http.ts` with the test environment (`CAPABILITIES` = every group, integrations disabled, mocks wired). |
| `slack.ts` | `@desplega.ai/slack-mock` lifecycle. |
| `mocks/llm.ts` | Mock inference host: OpenAI chat + responses + embeddings, SystemOne decisions and extraction. |
| `agent-sim.ts` | Simulated agent: polls `/api/poll` and settles tasks over HTTP. |
| `http.ts` | `ctx.api` client, assertions (`expect`, `expectStatus`, `asRecord`, `asRecords`, `asString`), call recorder with latency. |
| `mcp.ts` | `ctx.connectMcp(agentId)` over Streamable HTTP, tool-call recorder. |
| `db.ts` | The only file allowed to import `bun:sqlite`. Read-only. |
| `coverage.ts` | Route, tool and node-type coverage, manifest exclusions, flows, latency, the strict contract. |
| `coverage-manifest.json` | Deliberate exclusions with reasons, pinned flows. |
| `report.ts` | CLI options, result JSON and Markdown summary. |
| `harness.ts` | Optional real-worker legs (`--harness`), credentials required. |
| `scenarios/` | One file per scenario (or per tight family). `registry.ts` discovers them. |

## Writing a scenario

```ts
import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

export const memoryLifecycle: Scenario = {
  name: "memory-lifecycle",
  order: 510,
  async run(ctx) {
    const agentId = /* register over POST /api/agents */ "";
    const stored = await ctx.api("POST", "/api/memory", { agentId, body: { content: `fact ${ctx.nonce}` } });
    expectStatus(stored, [201], "store memory");
    const id = asRecord(stored.json).id;
    expect(typeof id === "string", "memory id");
    const row = ctx.db.get<{ id: string }>("SELECT id FROM agent_memory WHERE id = ?", [String(id)]);
    expect(row?.id === id, "memory row persisted");
  },
};
```

Rules, enforced by the registry, the boundary check, or review:

1. **One exported `Scenario` per concern.** `name` is unique kebab-case. `order` is unique;
   pick a free number in your domain band (below) and leave gaps. A helper module that
   exports no scenario goes in `NON_SCENARIO_FILES` in `scenarios/registry.ts`.
2. **Black box only.** Import from `../http`, `../mcp`, `../run`, `../report`, Bun and node
   builtins. Never from `src/`, `apps/`, `packages/`. `bun:sqlite` belongs to `db.ts`.
3. **Seed through the API.** `ctx.db` is read-only and exists for assertions
   (`SELECT ... FROM ...`). A write throws.
4. **Assert the documented contract.** Check the status code `openapi.json` declares, the
   response shape, and the persisted effect. A `2xx` with no shape check is a smoke test,
   not coverage. Negative paths (401, 403, 404, 400 on bad input) are part of the contract.
5. **Isolate with `ctx.nonce`.** Names, markers and emails carry it. Scenarios share one
   database, so never assume a list is empty or that your item is the only one.
6. **Clean up what blocks others.** Stop simulated agents you no longer need (the runner
   stops the rest at scenario end). Disable extensions you enabled. Delete global config
   you set. A lead agent changes routing for everything after it: register one only when
   the flow needs it, and prefer `isLead: true` on a dedicated agent.
7. **Deterministic.** No sleeps for luck; use `pollUntil` with a bounded timeout and a
   message that says what never happened.
8. **Keep it fast.** The suite runs on every PR. Prefer one scenario that walks a resource's
   whole lifecycle over ten that each boot a fixture.

### Order bands

| Band | Domain |
|---|---|
| 10-199 | Pre-existing scenarios (health, auth, task lifecycle, Slack, extensions, runtime pools, realtime) |
| 200-299 | core-tasks: agents, tasks, poll, sessions, heartbeat, metrics, events, budgets, messaging |
| 300-399 | workflows: definitions, runs, every node type, schedules, approvals |
| 400-499 | scripts: scripts, script runs, connections, kv, db-query, internal script-run routes |
| 500-599 | knowledge: memory, skills, prompt templates, pages, assets, apps, rooms |
| 600-699 | platform: users, invites, keys, oauth, mcp servers, config, integrations, webhooks, repos, trackers, models, pricing, extensions, runtime, fs |
| 9000+ | Reserved for ordering-sensitive tail scenarios |

## The scenario context

| Field | What it gives you |
|---|---|
| `ctx.api(method, path, { body, agentId, apiKey, headers, rawBody, redirect })` | JSON client with the run's operator key. `apiKey: null` sends no Authorization. `agentId` sets `X-Agent-ID`. Every call is recorded for coverage and latency. Returns `{ status, json, text, headers }`. |
| `ctx.connectMcp(agentId)` | MCP client on `/mcp` as that agent. `listTools()`, `callTool(name, args)`, `close()`. Tool calls count toward tool coverage. |
| `ctx.db.query / ctx.db.get` | Read-only SQL on the SUT database. |
| `ctx.slack` | The `SlackMock` instance: `postMessage`, `messages`, `apiCalls`, `waitFor...`. See the slack-* scenarios. |
| `ctx.llm` | Mock inference host. `requests` journal, `requestsTo("/chat/completions")`, `setChatResponder(fn)`, `setSystemOneResponder(fn)`. Responders are reset after every scenario. |
| `ctx.startAgent({ name, role, onTask, onTrigger, progress })` | A simulated agent polling `/api/poll`. Default completes each task with `done <taskId>`. `waitForTask(id)`, `waitForTasks(n)`, `handled`, `stop()`. Stopped automatically at scenario end. |
| `ctx.recordHttpCall(method, path, status)` | Count a raw `fetch`, WebSocket upgrade or SSE request toward route coverage. |
| `ctx.restartSut()` | Restart the API process, keeping db, port, key, mocks. For durability scenarios. |
| `ctx.nonce` | Per-run random hex. Put it in every name. |
| `ctx.log`, `ctx.markThread` | Console output; Slack visual thread marks. |

### Mocked edges

| Edge | How the SUT reaches the mock | What the mock does |
|---|---|---|
| OpenAI-compatible chat (`workflow-llm`, `raw-llm`, memory rater, session summaries) | `OPENROUTER_BASE_URL` + `OPENROUTER_API_KEY` | `/v1/chat/completions` and `/v1/responses`. Honors `response_format` / `text.format` JSON schemas (synthesizes a conforming object) and forced tool calls. Scenario can script the answer with `ctx.llm.setChatResponder`. |
| Embeddings (memory, script search) | `EMBEDDING_API_BASE_URL` + `EMBEDDING_API_KEY` | `/v1/embeddings`, deterministic unit vectors; equal text gives equal vectors. |
| Key probes | `OPENROUTER_BASE_URL` | `/v1/key`, `/v1/models` answer 200. |
| SystemOne decisions and extraction | Global config `LAYA_URL` = `ctx.llm.origin`, `LAYA_API_KEY` = any value, node `provider: "laya"` | `/v1/systemone` (decisions) and `/v1/clairic` (extraction) answer every question or field with a confident default. Script both with `ctx.llm.setSystemOneResponder`. |
| Slack | Socket Mode to `@desplega.ai/slack-mock` | Full Web API mock. |
| GitHub, GitLab, Linear, Jira, AgentMail, Kapso | Disabled (`*_DISABLE=true`) | Their routes answer the disabled or bad-signature contract. Cover that contract and say so in the manifest only when a route cannot be reached at all. |

## Coverage and the strict contract

After the scenarios, `coverage.ts`:

1. Reads `GET /openapi.json` for the route universe and `GET /api/executor-types` for the
   node-type universe. The tool universe is `tools/list` for a worker registered before any
   scenario, so `--only` cannot shrink it.
2. Matches every recorded HTTP call to its operation template and every MCP call to its
   tool. Node types come from `SELECT DISTINCT nodeType FROM workflow_run_steps`.
3. Applies `coverage-manifest.json`: excluded items leave the denominator. An exclusion
   that is covered anyway is **stale**; one that matches nothing is **dead**. Both fail strict.
4. Checks `flows`: each named scenario must exist and have passed.

The result JSON carries `coverage.routes.uncovered`, `coverage.mcpTools.uncovered`,
`coverage.nodeTypes.uncovered`, `coverage.flows`, `coverage.latency.byGroup`
(count, p50, p95, max in ms) and `gates.failures`. The Markdown summary renders the same.

Adding an exclusion is a review decision. Write the reason so a reviewer can verify it
("provider webhook, needs a Basic auth secret the mock does not issue", not "flaky").

## Benchmarks

Latency is recorded on every `ctx.api` call. Compare two runs:

```bash
bun run e2e --json /tmp/e2e-before.json
# change something
bun run e2e --json /tmp/e2e-after.json
bun scripts/e2e/bench.ts /tmp/e2e-before.json /tmp/e2e-after.json
```

`bench.ts` prints per-group p50/p95 deltas and the scenario durations side by side.
