# Black-box E2E: the reliability contract

`bun run e2e --strict` is the proof that the swarm works when all you hold is the API, the
keys and the database file. It boots the real server, mocks every external edge, drives the
whole surface over HTTP and MCP, and fails when anything the server exposes went untested.

This runbook is for operators and reviewers. Authors read
[scripts/e2e/README.md](../scripts/e2e/README.md).

## What a strict run guarantees

| Surface | Universe | Covered when | Gate |
|---|---|---|---|
| Route operations | every `METHOD /template` in `GET /openapi.json` | a recorded request matched the template | uncovered and not excluded → fail |
| MCP tools | `tools/list` for a worker registered before any scenario, every capability on | a scenario called the tool over `/mcp` | uncovered and not excluded → fail |
| Workflow node types | `GET /api/executor-types` | a run executed the node (`workflow_run_steps.nodeType`) | uncovered and not excluded → fail |
| Flows | `flows` in `coverage-manifest.json` | every named scenario ran and passed | missing or failing → fail |
| Manifest hygiene | the manifest itself | | stale (excluded but covered) or dead (matches nothing) → fail |

Exclusions live in `scripts/e2e/coverage-manifest.json` with a reason each. Adding one is a
review decision: the reason must be verifiable ("provider webhook, needs a Basic auth secret
the mock cannot issue"), never "flaky" or "later".

## Mocked edges

| Edge | Mock | SUT configuration |
|---|---|---|
| Chat completions, structured output (`workflow-llm`, `raw-llm`, memory rater, session summaries) | `scripts/e2e/mocks/llm.ts`, OpenAI chat + Responses API | `OPENROUTER_BASE_URL`, `OPENROUTER_API_KEY` |
| Embeddings (memory, script search) | same mock, deterministic vectors | `EMBEDDING_API_BASE_URL`, `EMBEDDING_API_KEY` |
| SystemOne decisions and extraction | same mock, `/v1/systemone` | global config `LAYA_URL`, `LAYA_API_KEY`, node `provider: "laya"` |
| Slack | `@desplega.ai/slack-mock` over Socket Mode | `SLACK_*` from the mock |
| GitHub, GitLab, Linear, Jira, AgentMail, Kapso | none, disabled | `*_DISABLE=true` |
| Harness workers | none in the contract run; `--harness` legs spawn real workers with real credentials | |

Every request the mocks receive is journaled. Scenarios assert on the journal
(`ctx.llm.requests`, `ctx.slack.apiCalls(...)`) so a silent "the server never called the
model" is a failure, not a pass.

## Running

```bash
bun run e2e --strict                               # the CI contract (merge-gate "E2E Contract")
bun run e2e                                        # same scenarios, report only, no gate
bun run e2e --only <name>,<name>                   # a subset while debugging
bun run e2e --strict --json out.json --summary-md out.md
bun run e2e --keep                                 # keep db, logs, temp dirs (paths printed as KEEP ...)
```

Wall clock for the full suite is a few minutes on a laptop. The Slack scenarios dominate.

## Reading a failure

1. The console prints `FAIL <scenario>: <message>` per scenario, then the last 40 lines of the
   API log, then the coverage lines, then one `Strict coverage gate failed: ...` block per
   contract breach with the exact uncovered items.
2. `e2e-results.json` has the same data: `scenarios[]`, `coverage.routes.uncovered`,
   `coverage.mcpTools.uncovered`, `coverage.nodeTypes.uncovered`, `coverage.flows`,
   `gates.failures`.
3. A new route or tool without a scenario fails strict with its name. Either write the
   scenario (preferred) or add a manifest exclusion with a reviewable reason.
4. A scenario that starts failing after a server change is a contract change. Decide whether
   the server or the scenario is wrong before touching either.

## Benchmarks

Every `ctx.api` call records its latency. The result JSON carries p50, p95, max and count
per route group and overall. Diff two runs:

```bash
bun run e2e --json /tmp/before.json
bun run e2e --json /tmp/after.json
bun run e2e:bench /tmp/before.json /tmp/after.json
```

The suite runs with a fresh database and loopback networking, so the numbers are a
regression signal for server work per request, not a capacity figure. Run both sides on the
same machine, back to back.

## CI

`.github/workflows/merge-gate.yml` job **E2E Contract** runs `check-e2e-boundary.sh`,
`e2e:tsc`, then `bun run e2e --strict` and uploads `e2e-results.json`. The job is required by
the merge gate. The nightly workflow runs the same scenarios plus real harness legs.

## Relation to unit tests

The strict suite is the outer contract. Unit tests remain for logic that the black box cannot
reach with a deterministic input (parsers, scrubbers, scheduling math, migrations against
fixtures). When a unit test only re-checks what a scenario already proves end to end, it is a
candidate for deletion.
