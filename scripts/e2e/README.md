# Black-box E2E runner

`bun run e2e` boots the real API server on a free port with a fresh SQLite database, a mock
Slack workspace and a mock inference host, then runs deterministic scenarios against it over
HTTP and MCP. No Docker, no model, no access to `src/`. The runner sees exactly what an
operator sees: the API, the keys, and a read-only handle on the database file.

The suite is the reliability contract of the swarm. `--strict` fails when any route
operation, MCP tool or workflow node type the server exposes, or any command the CLI lists,
is neither covered by a scenario nor excluded with a reason in `coverage-manifest.json`.
CI runs strict.

```bash
bun run e2e                       # every scenario, coverage report, no gate
bun run e2e --strict              # the full contract, one process
bun run e2e --shard 2/6           # one fixed band, as each CI shard runs it
bun scripts/e2e/merge.ts --strict shard-1.json shard-2.json shard-3.json shard-4.json shard-5.json shard-6.json  # gate the union
bun run e2e --coverage            # also write lcov per API process to ./e2e-coverage/
bun scripts/e2e/diff-coverage.ts  # changed API lines (vs origin/main) no scenario runs
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
| `run.ts` | Entry point. Boots mocks + SUT, runs scenarios in `order`, reruns failures once on a fresh SUT, computes coverage, applies gates, writes reports. |
| `shard.ts`, `merge.ts` | `--shard i/6` bands (`SHARD_CUTS`) and the raw coverage observations a shard writes; `merge.ts` unions them and applies `--strict` and the minimums once. |
| `rerun.ts` | Rerun plan (`needs`, transitively) and how two attempts settle into one result (`flaky` or `fail`). |
| `quarantine.ts`, `quarantine.json` | Quarantined scenarios: they run and report but cannot fail the run. Ships empty. |
| `sut.ts` | Spawns `bun run src/http.ts` with every capability, `CHAT_SDK_ENABLED=true`, a 1 s Slack watcher tick (`SLACK_TASK_WATCHER_INTERVAL_MS=1000`, the server default is 10 s), and mock endpoints. External integrations remain disabled until a scenario configures a mock. |
| `slack.ts` | `@desplega.ai/slack-mock` lifecycle (Socket Mode, started before the SUT). |
| `slack-http.ts` | A second `SlackMock` in HTTP delivery mode (signed requests, no socket), `postSigned` for forged or replayed requests, and `recordDeliveries` for route coverage. `scenarios/slack-http-helpers.ts` flips the SUT onto the Chat SDK Slack adapter around it. With `--visuals`, the Chat SDK mock writes its own journal, so its threads render too. |
| `mocks/llm.ts` | Mock inference host: OpenAI chat + responses + embeddings, SystemOne decisions and extraction. |
| `agent-sim.ts` | Simulated agent: polls `/api/poll` and settles tasks over HTTP. |
| `http.ts` | `ctx.api` client, assertions (`expect`, `expectStatus`, `asRecord`, `asRecords`, `asString`), call recorder with latency. |
| `mcp.ts` | `ctx.connectMcp(agentId)` over Streamable HTTP, tool-call recorder. |
| `db.ts` | Owns `bun:sqlite`. Provides read-only assertions and prepares offline fixtures. |
| `coverage.ts` | Route, tool and node-type coverage, manifest exclusions, flows, latency, the strict contract. |
| `coverage-manifest.json` | Deliberate exclusions with reasons, pinned flows. |
| `report.ts` | CLI options, result JSON and Markdown summary. |
| `coverage-sut.ts` | `--coverage` only: the API entry under `bun test`, so Bun writes lcov when the process stops. |
| `cli.ts`, `coverage-cli.ts` | `runCli(args, options)`: the CLI as a child (`bun run src/cli.tsx`) with a temp HOME and working directory, and the command universe from `cli help`. Under `--coverage` the child is the CLI entry under `bun test`, like the API. |
| `diff-coverage.ts`, `coverage-exemptions.txt` | The changed-lines comment: lcov union against `git diff`, and the paths it skips, each with a reason. |
| `harness.ts` | Optional real-worker legs (`--harness`), credentials required. |
| `scope.ts` | `bun run check:local`'s E2E step: maps the changed files to the scenarios that reach them, or asks for the full run ([ci.md](../../runbooks/ci.md#the-local-check-loop)). |
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
3. **Seed through the API.** Use the read-only `ctx.db` for assertions. For state the API
   cannot create, prepare a separate database fixture before boot. For example, the metrics
   scenario gives `ctx.startFixtureSut` a fixture with historical task timestamps.
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
   message that says what never happened. An absence check ("this never posts") watches
   for `slackAbsenceWindowMs(ctx)` from `scenarios/slack-helpers.ts`: 3 watcher ticks,
   at least 10 s.
8. **Keep it fast.** The suite runs on every PR. Prefer one scenario that walks a resource's
   whole lifecycle over ten that each boot a fixture.
9. **Pass alone, or declare `needs`.** A failed scenario reruns once on a fresh API and
   database (see below). If it reads state an earlier scenario left (a config flag, a
   registered lead), list those scenarios in `needs: ["name"]`; they must have a lower
   `order`, and the registry throws otherwise. Check with `bun run e2e --only <name>`.

### Reruns, flaky and quarantine

After the main pass, each failed scenario reruns once, alone, on a fresh API process,
database, Slack mock and inference mock. Its `needs` replay first, in run order; if one
of them fails, the rerun decides nothing and the first failure stands.

- **Pass on rerun:** status `flaky`. The run stays green. The console prints `FLAKY`, the
  JSON row carries `attempts` and the first attempt's `error`, and the Markdown summary lists
  it under "Flaky (passed on rerun)".
- **Fail twice:** status `fail`, with the rerun's error.
- **Coverage:** one result row per scenario, whatever the attempt count. The prerequisite
  replay records no coverage. The rerun's own calls join the covered sets, which are unions,
  so nothing counts twice; node types and state values it produced are read from its
  database before it stops. The universe probe never changes.

`quarantine.json` holds `{ "scenario", "owner", "reason", "expires": "YYYY-MM-DD" }`
entries. A quarantined scenario runs, reruns and reports (`FAIL (quarantined)`), and its
failure fails neither the run nor its flows. The run fails when an entry is past its
`expires` date (UTC), names no scenario, or repeats one. There is no auto-quarantine:
adding an entry is a review decision with an owner. A quarantined failure still leaves the
routes only it would have reached uncovered, so the strict gate can still name them.

### Order bands

| Band | Domain |
|---|---|
| 10-199 | Pre-existing scenarios (health, auth, task lifecycle, Slack, extensions, runtime pools, realtime) |
| 200-299 | core-tasks: agents, tasks, poll, sessions, heartbeat, metrics, events, budgets, messaging |
| 300-399 | workflows: definitions, runs, every node type, schedules, approvals |
| 400-499 | scripts: scripts, script runs, connections, kv, db-query, internal script-run routes |
| 500-599 | knowledge: memory, skills, prompt templates, pages, assets, apps, rooms |
| 600-699 | platform: users, invites, keys, oauth, mcp servers, config, integrations, webhooks, repos, trackers, models, pricing, extensions, runtime, fs |
| 9000-9499 | storage-engine parity: upgrade from a base-commit database, divergence, trigger and stress scenarios |
| 9000+ | Reserved for ordering-sensitive tail scenarios |

### Shards

CI splits the run into six bands by `order`, cut at 130, 140, 190, 500 and 9006 (`SHARD_CUTS`
in `shard.ts`): shard 1 runs below 130, shard 2 runs 130 up to 140, shard 3 runs 140 up to
190, shard 4 runs 190 up to 500, shard 5 runs 500 up to 9006, shard 6 runs 9006 on. Each band
boots its own API process and database, so a band starts from a fresh server. The first two
cuts sit where the Slack renderer flags change for the rest of a process: `SLACK_RENDER_V2`
goes on at 130 and `SLACK_RENDER_V2_DELEGATION` at 140. The cuts at 190, 500 and 9006 balance
the bands by Postgres time. A band-entry scenario sits at each of them
(`slack-delegation-band-entry`, `-knowledge` and `-storage`) and sets both flags again, so
shards 4 to 6 run in the state they had inside shard 3. Two rules follow:

- A scenario's `needs` must sit in its own band. `--shard` refuses to start when one crosses
  a cut.
- A scenario at the start of a band must set the flag state it asserts itself. Placing a
  scenario that relied on an earlier band's leftovers just after a cut breaks it in CI only.
  Check with `bun run e2e --shard i/6 --only <name>` before you pick an order near a cut.

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
| `ctx.sutLog()` | The SUT's output so far. Take `.length` before a step and slice after it to read only what the step logged. |
| `ctx.restartSut({ env })` | Restart the API process, keeping db, port, key, mocks. For durability scenarios. `env` adds variables to that one process (a test-only crash point); the next restart drops them. |
| `ctx.startDataCopy({ env })` | A second API on a new SQLite file (`source`). `copy()` stops it, runs `agent-swarm db-copy` into a new Postgres database and boots an API on the copy (`target`). It also returns read-only `sourceDb` and `targetDb`, `restartTarget(env)` (a later start of the API on the copy, for example with `POSTGRES_MIGRATIONS_DIR` set to a later chain) and `targetLog()`. Needs `E2E_POSTGRES_URL` on both engines. See `data-copy` and `data-copy-later-release`. |
| `ctx.nonce` | Per-run random hex. Put it in every name. |
| `runCli(args, { env, cwd, stdin, timeoutMs, whileRunning })` (import from `../cli`) | Not on `ctx`: runs `bun run src/cli.tsx <args>` with a temp HOME and cwd and returns `{ exitCode, stdout, stderr, cwd, home }`. Check the exit code, the output and the files under `cwd`. A run counts its command covered unless it only asked for `--help`. `whileRunning` is for a command that serves until stopped (`api`): it runs alongside, then the child gets SIGTERM. |
| `ctx.log`, `ctx.markThread` | Console output; Slack visual thread marks. A scenario that proves a visible Slack change joins a visuals group (`groups: ["visuals-v2"]`, `"visuals-legacy"`) and marks each thread a reviewer must see: the Slack Visuals PR comment and the PR's `## Before / after` frames come from those marks. On the Chat SDK mock, use `flip.ctx.markThread` (that mock has its own journal). Mark the thread root, with a label that matches `^[a-z0-9-]+$`. |
| `ctx.slackJournal` | With `--visuals`, a journal file for a Slack mock that the scenario starts itself: `path` is the mock's `dataFile`, `file` is the fourth argument of `ctx.markThread`. Undefined otherwise. |

### Mocked edges

| Edge | How the SUT reaches the mock | What the mock does |
|---|---|---|
| OpenAI-compatible chat (`workflow-llm`, `raw-llm`, memory rater, session summaries) | `OPENROUTER_BASE_URL` + `OPENROUTER_API_KEY` | `/v1/chat/completions` and `/v1/responses`. Honors `response_format` / `text.format` JSON schemas (synthesizes a conforming object) and forced tool calls. Scenario can script the answer with `ctx.llm.setChatResponder`. |
| Embeddings (memory, script search) | `EMBEDDING_API_BASE_URL` + `EMBEDDING_API_KEY` | `/v1/embeddings`, deterministic unit vectors; equal text gives equal vectors. |
| Key probes | `OPENROUTER_BASE_URL` | `/v1/key`, `/v1/models` answer 200. |
| SystemOne decisions | Global config `LAYA_URL` = `ctx.llm.origin`, `LAYA_API_KEY` = any value, node `provider: "laya"` | `/v1/systemone` answers each question. Script responses with `ctx.llm.setSystemOneResponder`. |
| Cloudflare Clairic extraction | Deployment env `CLOUDFLARE_API_BASE_URL` = `ctx.llm.origin`, global config `CLOUDFLARE_ACCOUNT_ID`, secret `CLOUDFLARE_API_TOKEN`, node `provider: "cloudflare"` | The account path ends in `/ai/run/@cf/cloudflare/clairic`. The mock returns the Workers AI `{ success, errors, result }` envelope. Script responses with `ctx.llm.setSystemOneResponder`. |
| Slack | Socket Mode to `@desplega.ai/slack-mock` | Full Web API mock. |
| Chat SDK Slack | Built-in Slack off (`SLACK_DISABLE`), `CHAT_SDK_ADAPTERS.slack` in webhook mode, and the env `CHAT_SDK_API_URL_OVERRIDES.slack` port the scenario binds a second `SlackMock` to | The mock posts signed events, commands and `block_actions` to `/api/integrations/chat/slack/webhook`. `enableChatSdkSlack` flips and its `undo` restores Socket Mode. |
| Chat SDK Telegram | `CHAT_SDK_ENABLED=true`, deployment env `CHAT_SDK_API_URL_OVERRIDES`, and adapter config with fake credentials | `platform-chat-sdk` starts a loopback Telegram API. It checks tool discovery, permissions, channel mappings, messages, and thread history. |
| Chat SDK Rocket.Chat | `CHAT_SDK_API_URL_OVERRIDES.rocketchat` set at boot, adapter config with fake credentials | `platform-chat-sdk-rocketchat` starts a loopback Rocket.Chat REST API. It checks config validation, the webhook token, a mention becoming a chat task, the unmapped sender list, and a `chat-post` reply. |
| GitHub (provider flows) | `github-emulate-flows` starts `@emulators/github` (the `emulate` devDependency) and restarts the SUT with `GITHUB_API_URL` = its origin plus App credentials | A stateful GitHub: repos, issues, PRs, merges, App installation tokens, and HMAC-signed App webhooks sent to `/api/github/webhook`. No reactions, GraphQL, repository rules or combined commit status: those calls get 404. |
| Linear (provider flows) | `linear-emulate-flows` starts `@emulators/linear` and restarts the SUT with `LINEAR_URL` and `LINEAR_API_URL` = its origin (deployment env only, reserved in config) | A stateful Linear GraphQL API, OAuth (consent, token, refresh, revoke) and signed webhooks sent to `/api/trackers/linear/webhook`. `User.organization` is missing, so the OAuth callback's app-user capture fails. |
| GitHub, GitLab, Linear, Jira, AgentMail, Kapso | Disabled (`*_DISABLE=true`) | Their routes answer the disabled or bad-signature contract. Cover that contract and say so in the manifest only when a route cannot be reached at all. |

`CLOUDFLARE_API_BASE_URL` is reserved for tests and cannot be stored in config.
It accepts only a loopback HTTP origin when `NODE_ENV=test`.
All other values use the production Cloudflare origin.

Generate fake credentials separately from `ctx.nonce`.
The secret scrubber remembers credentials and can redact reused markers in later scenarios.

## Coverage and the strict contract

After the scenarios, `coverage.ts`:

1. Reads `GET /openapi.json` for the route universe and `GET /api/executor-types` for the
   node-type universe. The tool universe is `tools/list` for a worker registered before any
   scenario, so `--only` cannot shrink it. `CHAT_SDK_ENABLED=true` includes the six Chat SDK tools.
2. Matches every recorded HTTP call to its operation template and every MCP call to its
   tool. Node types come from `SELECT DISTINCT nodeType FROM workflow_run_steps`.
3. Applies `coverage-manifest.json`: excluded items leave the denominator. An exclusion
   that is covered anyway is **stale**; one that matches nothing is **dead**. Both fail strict.
4. Reads every `stateSurfaces` entry: one read-only `SELECT ... AS value` on the SUT database
   (task statuses, workflow run and step statuses, script run statuses, script step types,
   script scopes, fs modes, executors). A scenario can call `ctx.captureStateSurface(name)`
   to run the same query while a transient state is held. The report includes both reads.
   Every value in the declared universe must have been
   produced unless excluded with a reason; a value in the database that the universe does not
   list is a new engine state and fails strict until it is declared. A state exclusion marked
   `"transient": true` (a state the engine leaves within one heartbeat or poll) is never
   stale: a final read, or a scenario rerun on a fresh database, may catch it by chance.
5. Checks `flows`: each named scenario must exist and have passed, and every scenario in the
   registry must belong to at least one flow.
6. Runs `bun run src/cli.tsx help` for the CLI command universe and counts the commands
   scenarios ran through `runCli` (scenarios/cli.ts). A new command needs a scenario or a
   `cliCommands` exclusion; worker commands (`worker`, `lead`, `hook` and the like) are excluded
   because the nightly harness legs spawn them.
7. Rolls `engines` up: each named engine (script, workflow, task) sums its route groups, tool
   patterns, node types and state surfaces into one covered/total figure. Strict requires
   100% for every engine, so "how covered is the script engine?" has one answer in the report.

The result JSON carries `coverage.routes.uncovered`, `coverage.mcpTools.uncovered`,
`coverage.nodeTypes.uncovered`, `coverage.stateSurfaces[]` (uncovered and unexpected values per
surface), `coverage.scenariosWithoutFlow`, `coverage.flows`, `coverage.latency.byGroup`
(count, p50, p95, max in ms) and `gates.failures`. The Markdown summary renders the same.

Adding an exclusion is a review decision. Write the reason so a reviewer can verify it
("provider webhook, needs a Basic auth secret the mock does not issue", not "flaky").

### Changed lines (`--coverage`)

Route coverage says an operation was called; it does not say your new branch ran. On every PR
the E2E jobs also post a sticky comment (`<!-- e2e-coverage -->`) listing the changed API lines
no scenario runs. It is a comment only: nothing blocks.

1. `bun run e2e --coverage` starts each API process as
   `bun --config=<toml> test ./scripts/e2e/coverage-sut.ts` with lcov on, and keeps one
   `e2e-coverage/<process>/lcov.info` per process (boot, each restart, each rerun). The toml is
   its own: the repo `bunfig.toml` would preload the unit-test setup. If an API process does not
   boot under `bun test`, it boots plain and leaves a `.plain` marker, so coverage never fails
   the run.
2. `diff-coverage.ts` unions every lcov (a line is covered when any process hit it), then reads
   `git diff -U0 <base>...HEAD -- src/`. A changed line counts only when lcov lists it as
   executable. A file no process loaded counts its changed code lines in full, unless it holds
   types only; the comment marks it `(not loaded)`.
3. Scope: API and CLI files under `src/`. CLI children write lcov next to the API's, so
   `src/cli.tsx` and the operator commands (`onboard`, `setup`, `controller`, `codex-login`,
   `claude-managed-setup`, `worker-token`, `x`, `e2b`) count. Worker code (the rest of
   `src/commands/`, `src/providers/`, `src/hooks/`, `src/prompts/`, `src/claude.ts`), tests,
   `.d.ts` and the paths in `coverage-exemptions.txt` drop out. Nothing outside `src/` counts.

Locally: `bun run e2e --coverage`, then `bun scripts/e2e/diff-coverage.ts` (default base
`origin/main`, comment in `e2e-coverage-comment.md`). Use `--only <name>` to check the
scenario you wrote reaches the lines you changed.

An exemption needs a reason a reviewer can verify, like the code that runs in a subprocess the
runner does not instrument. Prefer a scenario.

### Results tracker

The E2E Tracker Report job reports each run to the swarm's results tracker with
`scripts/e2e/tracker-ingest.ts`: one `suite: "contract"` payload per shard (scenario, status
`pass`/`fail`/`flaky`/`skip`, duration, retries), and on the first one a `coverage` block (whole-run
lines, per-file lines, and on a PR the changed-lines result above). It uses the secrets
`ui-e2e.yml` uses (`UI_E2E_INGEST_URL`, `UI_E2E_INGEST_BEARER`) and never fails the gate: a missing
secret, a fork PR or a tracker outage logs a warning and the job goes on. It is a separate job
that reads the shard results as artifacts, so the secrets never reach a runner that ran PR code. A
merge group can hold a fork PR, so there it runs the script from the group's base (`main`). The
queue's runs report as `main`, which is what the coverage-on-main trend reads. Dry run, which writes the payloads and
posts nothing: `bun scripts/e2e/tracker-ingest.ts --dry-run --out /tmp/payloads` with the
`GITHUB_REPOSITORY`, `TRACKER_SHA` and `TRACKER_REF` variables set.

## Benchmarks

Latency is recorded on every `ctx.api` call. Compare two runs:

```bash
bun run e2e --json /tmp/e2e-before.json
# change something
bun run e2e --json /tmp/e2e-after.json
bun scripts/e2e/bench.ts /tmp/e2e-before.json /tmp/e2e-after.json
```

`bench.ts` prints per-group p50/p95 deltas and the scenario durations side by side.
CI uploads result JSON for local comparison.

### Commit budget

The budget guards the storage slow path on PostgreSQL. Each commit there waits for a WAL
flush, so code that commits once per row is fast on SQLite and slow on PostgreSQL. Durations
are no gate: they change with the runner. Commit counts do not.

`scripts/e2e/bench-budget.json` holds, per scenario, the most PostgreSQL commits and write
statements that one HTTP request (or MCP call) of the scenario may make. Every API process of
the run counts, also restarts and fixture APIs. A commit is a read-write transaction that
committed. Each write outside a transaction is one, because the write fence wraps it in a
transaction. A write statement is an `INSERT`, `UPDATE`, `DELETE` or `MERGE` of a transaction
that committed. A serialization retry runs the statements again, so a retried transaction
counts the statements of one attempt. Each budget value is the measured value plus 20
percent, at least plus 10.

The gate is per request, not per scenario. Scenario totals also count pollers, token
touches, timers and background loops, so they grow with the scenario's duration. Two runs of
the same commit differed by up to 2x. The count of one request stays the same. A request
counts until its handler returns. Work it leaves running, and work no request started, count
only in the totals. So the budget does not see a background loop that commits once per row.

```bash
bun run e2e:bench --check                        # all six bands, SQLite and Postgres
bun run e2e:bench --check --only knowledge-apps-large-model
bun run e2e:bench --write-budget                 # regenerate the whole budget
bun run e2e:bench --write-budget --only a,b      # update two entries, keep the rest
```

All need `E2E_POSTGRES_URL`. The check runs each Merge Gate band in its own process, as CI
does, so each scenario starts from the same state. Two bands run at a time (`--jobs N`): six
API processes that boot at once on a laptop can miss the boot timeout. `--only` runs one process, so a scenario
that reads the state of earlier scenarios can count differently. `--collect <dir> [--shard
i/6] [--no-sqlite]` runs the bands into `dir`, and `--results <dir>` (repeatable) checks or
writes from collected results instead of running the suite.

The runner flag behind it is `bun run e2e --engine postgres --write-stats <dir>`
(`STORAGE_WRITE_STATS_DIR`, test only, `src/be/write-stats.ts`). Each API process keeps its
counts in `<dir>/<pid>-<uuid>.json`. The runner writes the running scenario's name to
`<dir>/window`, and a request belongs to the scenario that ran when it started. The result
JSON has `storage` per scenario: the totals, and the request with the most commits and
the most write statements. Only a passing first attempt is checked.

A failure prints the scenarios over budget, with measured / budget per count and the
request. Find the change that added commits to that request: a loop that writes one row per
transaction is the usual cause. Put the loop in one `transaction()`. When the new count is
intended, regenerate the entry in the same PR with `--write-budget --only <scenario>` and say
why in the PR. The nightly workflow `nightly-commit-budget.yml` runs the check
(runbooks/e2e-blackbox.md, Commit budget).
