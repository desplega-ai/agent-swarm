# Swarm Evals

Evaluation harness for agent-swarm: runs a **scenario × harness-config matrix** against real swarm stacks deployed in **E2B sandboxes**, grades outcomes with **deterministic checks + LLM/agentic judges** (OpenRouter via the AI SDK), and stores results in **Turso** (libsql embedded replica — local WAL file synced with the remote primary; see [Database](#database)).

> **Authoring scenarios, rubrics, or fixtures? → see [SCENARIO-AUTHORING.md](./SCENARIO-AUTHORING.md)** — the durable rulebook (OutcomeSpec v2, deterministic-check patterns, the hard-won rubric-design rules, the de-risk pilot pattern, and how the deployed swarm should propose changes).

## How it works

Each attempt (one cell of the matrix, run `n` times per cell):

1. **Boot** a fresh stack — one E2B sandbox for the swarm API (`agent-swarm-api-latest` template) + one per roster member (`agent-swarm-worker-latest`). Each member runs its **effective** config's `HARNESS_PROVIDER` / `MODEL_OVERRIDE` (the matrix cell's config unless the scenario overrides that member — see worker configuration below) and receives only the credentials its provider needs, so heterogeneous rosters get per-sandbox credential isolation for free. Reuses `src/e2b/dispatch.ts` primitives from the repo root.
2. **Seed** (optional) — shell commands in the worker sandbox (`scenario.seed.exec`).
3. **Run** — create the scenario's task(s) directly assigned to the worker agent, poll until terminal status or timeout.
4. **Grade** — deterministic checks (implicit `tasks-completed` + scenario checks), an optional **LLM judge** over the flattened transcript, and an optional **agentic judge**: an AI SDK tool-loop with live sandbox/API access (`run_command` / `read_file` / `api_get` / `submit_verdict`) that verifies the rubric itself instead of trusting the transcript (falls back to the LLM judge if it never submits a verdict).
5. **Persist artifacts** (secret-redacted): flattened transcript, **raw swarm session-log events** (`session-logs.jsonl`), the **harness's own raw session files** pulled from the worker filesystem (e.g. Claude Code's `~/.claude/projects/**/*.jsonl`, codex `~/.codex/sessions`, pi `~/.pi`, opencode `~/.local/share/opencode` — files touched during the attempt, capped 10 × 1.5 MB), task records, seed command outputs (`seed-output.json`), raw session-cost rows (`session-costs.json`), the roster snapshot with per-member cost/tokens (`roster.json`), the full session-file listing with sizes/mtimes (`session-files.json`), and the worker + API entrypoint log tails. Per-attempt sandbox info (both sandbox ids, templates, apiUrl, swarm key, TTL, API + worker build versions) is stored at boot, and per-phase wall-clock timings on finish.
6. **Teardown** — both sandboxes killed, even on failure.

### Fail-safety

- Attempts are idempotent rows keyed by `(run, scenario, config, index)`; `resume <runId>` re-runs anything unfinished and resets errored attempts. Re-run attempts first clear their stale judgments/artifacts.
- Every execution starts by **sweeping leaked sandboxes** of that run (matched via `metadata.swarm`), so a SIGKILL'd run never leaves orphans past one resume.
- Ctrl-C (CLI) and server shutdown abort gracefully: stop starting attempts, tear down live sandboxes, leave interrupted attempts resumable.
- Infra failures retry with fresh sandboxes (`--max-retries`); harness-level task failures are *results*, not retried.

## Usage

```bash
cd evals
bun install

# one-off: copy E2B_API_KEY / OPENROUTER_API_KEY / CLAUDE_CODE_OAUTH_TOKEN /
# ANTHROPIC_API_KEY / OPENAI_API_KEY from the repo-root .env into evals/.env

bun src/cli.ts registry                       # available scenarios + configs
bun src/cli.ts run                            # default: memory-seeded-recall × 3 configs
bun src/cli.ts run --scenarios memory-seeded-recall,build-verify-fix --configs claude-haiku,pi-deepseek-flash --attempts 2 --judge-model anthropic/claude-sonnet-4.5
bun src/cli.ts resume <runId>                 # continue an interrupted run
bun src/cli.ts show <runId>                   # terminal result matrix
bun src/cli.ts serve                          # UI on http://localhost:4801
```

### Smoke scenario

`memory-seeded-recall` is the **designated smoke scenario** — the cheapest meaningful end-to-end verification (1 worker, 1 task, deterministic-only: zero judge LLM spend) that still proves a real swarm capability (seeded-memory embed + retrieval). Run it first after any harness change:

```bash
bun src/cli.ts run --scenarios memory-seeded-recall --configs claude-haiku
```

It requires `EMBEDDING_API_KEY` in `evals/.env` (the API sandbox embeds the seeded memory server-side; the `OPENAI_API_KEY` fallback is no longer injected); without it the attempt fails loudly at seed time. The former `hello-file` / `quick-reasoning` dummies were removed from the registry — historical runs referencing them still render everywhere (the scenario detail page falls back to an "unregistered scenario" view).

### UI (`serve`)

Local-first dashboard + API; **runs can be triggered, resumed, and cancelled from the UI** and execute inside the serve process:

- `#/runs` — run list + matrix, live in-flight attempts with elapsed time, cancel/resume.
- `#/runs/:id/attempts/:attemptId` — per-attempt judgments (incl. agentic-judge tool inputs AND outputs in `raw`), phase timings, sandbox info, assets, and a chat-style transcript viewer parsed from the raw session logs (legacy `#/runs/:id/cells/:scenario/:config` URLs redirect).
- `#/scenarios` — searchable scenario registry; `#/scenarios/:id` shows what the scenario will do (tasks, seeding, checks, judges, rubric) + recent attempts across runs.
- Light/dark theme (persisted, follows `prefers-color-scheme`).

Key endpoints: `GET/POST /api/runs`, `POST /api/runs/:id/{resume,cancel}`, `GET /api/runs/:id`, `GET /api/attempts/:id{,/transcript}`, `GET /api/scenarios{,/:id}`, `GET /api/configs`, `GET /api/artifacts/:id`.

## Defining scenarios and configs

- Scenarios live in `scenarios/*.ts` (`Scenario` type): description, optional seeding, initial task(s), and an `outcome` (deterministic `checks`, `llmJudge` and/or `agenticJudge` rubrics, `passThreshold`). Register in `scenarios/index.ts` — every scenario is shape-validated at registry load (`validateScenario`; bad definitions fail CLI/server startup with the full violation list).
- Harness configs live in `configs/index.ts` (`HarnessConfig`): provider (`claude` / `pi` / `codex` / `opencode` / `ai-sdk-agent`), concrete `model` (worker `MODEL_OVERRIDE`) or `modelTier`, plus extra env.

### Seeding (`scenario.seed`)

Seeding runs before the first task is created, in this order:

- `sqlDump` — bare filename of a **full SQLite text dump** (`sqlite3 <db> .dump`) under `scenarios/fixtures/`, imported into the API sandbox's DB **before** the API server first boots (migrations forward-apply on top). The runner validates the fixture host-side before any sandbox exists: it must carry the `_migrations` table with applied rows and stay under 5 MB. Seed reference data only — no `agents` rows, no in-flight tasks, no sessions/locks, and no hand-seeded `agent_memory` rows (use `memories` instead). Conventions + regeneration recipe: [scenarios/fixtures/README.md](./scenarios/fixtures/README.md).
- `memories` — strings (max 16) indexed as **swarm-scope memories** via the memory API after boot; embeddings are computed server-side, and the runner blocks until every seeded memory is searchable (90 s gate). Requires `EMBEDDING_API_KEY` in `evals/.env` (the `OPENAI_API_KEY` fallback is no longer injected) — without it the attempt fails loudly at seed time instead of mysteriously at judging time.
- `exec` — shell commands run in **worker 0's** sandbox after the stack is healthy (and after memories), e.g. to plant workspace files.

### Worker configuration, rosters + task routing

- `workers: N` (default 1, max 3) boots N **homogeneous** workers on the cell's config (back-compat shape).
- `workers: WorkerSpec[]` (1–3 entries) configures each member individually:
  - `template` → `TEMPLATE_ID` (template-registry slug, e.g. `coder` / `researcher`; the worker fetches it from `TEMPLATE_REGISTRY_URL` and applies its `agentDefaults` — role, capabilities, maxTasks — plus identity files; a fetch failure is non-fatal),
  - `name` → `AGENT_NAME`, `systemPrompt` → `SYSTEM_PROMPT`,
  - `configId` / `model` → **per-member config override** (heterogeneous rosters): the member runs `catalog[configId]` (or the cell config) with `model` applied on top — provider and credentials follow the *effective* config. The cell config stays the matrix axis; overridden members are labeled as overrides in the UI and their cost/tokens attribute to the model they actually ran.
  - `env` → extra member env, merged last (reserved boot-path keys are rejected at registry load).
- **Default identity** (v7.5): members without a `name` boot with `AGENT_NAME` defaults — workers as `Worker <i>` (0-based member index), the lead as `Lead` — so agents no longer register under the entrypoint's `worker-<hash>` fallback. The lead additionally defaults `TEMPLATE_ID` to `official/lead` (the profile production leads run; its `agentDefaults` are no-ops vs the pinned boot env, and the registry fetch failing stays non-fatal). Plain workers get **no** template default on purpose: a fetched template back-fills soul/identity/tools/claude markdown into the eval subject's system prompt and executes its setup script, which would silently change scores across rounds. Persisted roster fields (`name`/`agentTemplate` in `workers_json`) keep meaning what the scenario *authored* (null for defaults); runtime names surface via the roster snapshot.
- `lead: WorkerSpec` boots one **extra** member with `AGENT_ROLE=lead` (registers `isLead`, default 2 concurrent tasks; does not count toward the 3-worker cap). Tasks with `worker: "lead"` are created **without** an `agentId` — the swarm API routes unassigned tasks to the lead, which is the lead-orchestration entry point.
- Each task routes to one worker via `worker: i` (default 0) or to the lead via `worker: "lead"`. Tasks are still awaited sequentially in index order — rosters prove routing/isolation/attribution, not concurrency.
- Grade per-member side effects with `fileContainsOnWorker(i, path, re)` / `fileAbsentOnWorker(i, path)` (the lead is member index N = the worker count); plain `ctx.exec` / `ctx.readFile` (and the agentic judge's tools) stay bound to worker 0.
- Per-attempt the runner snapshots the **roster** (GET `/api/agents` of the attempt's stack) with per-member cost/token attribution (each member's tasks' session-cost rows) into `attempts.workers_json` + a `roster.json` artifact.

### Task dependencies (`dependsOn`)

`dependsOn: [indices]` on a task uses **native swarm-API dependencies** (entries must reference strictly earlier tasks — that rule is the cycle check). When any task declares deps, the runner creates ALL tasks upfront and the server holds dependents `pending` until their dependencies complete. A failed / cancelled / timed-out dependency cascade-fails its dependents server-side; the runner classifies those as `skipped` in `tasks.json`, and the attempt grades as a normal model failure (never an infra `error`). Cost/log waits skip skipped tasks.

### Bundled scenarios

| id | proves | workers | needs embedding key |
|---|---|---|---|
| `sql-seeded-history` | `seed.sqlDump` import + agent consuming seeded API history | 1 | – |
| `memory-seeded-recall` | **designated smoke**: `seed.memories` → embed → retrieval (the F2 E2E gate) | 1 | yes |
| `memory-pipeline` | cross-task knowledge flow via memory + `dependsOn` DAG mode | 1 | yes |
| `two-workers` | multi-worker routing + sandbox isolation | 2 | – |
| `relay-handoff` | cross-worker handoff through swarm memory (`dependsOn` × `workers`) | 2 | yes |
| `build-verify-fix` | build → verify/fix dependency chain, deterministic compile-grade check | 1 | – |
| `roster-demo` | heterogeneous roster: worker specs/templates, per-member config overrides, lead boot + agentId-less routing, per-member attribution | 2 + lead | – |

### Scenario backlog + tier-ladder recipe

Designs validated but not built (round-6 spec §13.2): `sql-audit-history` (richer sqlDump fixture, count failed deploy tasks via the API), `memory-distractor` (seeded truth vs an in-prompt wrong default; judge grades "retrieved, not guessed"), `cross-worker-invent` (blocked on the agentic judge's `workers[]` toolset — it is worker-0-bound in v1), `chain-depth-3` (plan → implement → review; marginal signal over `build-verify-fix` until judge spend drops).

**Tier ladder** (a run recipe, not a scenario): run the same deterministic chain across price tiers, then read the cost-vs-pass scatter on the analytics page:

```bash
bun src/cli.ts run --scenarios build-verify-fix \
  --configs claude-haiku,claude-sonnet,opencode-deepseek-flash,opencode-deepseek-pro,pi-glm-flash,pi-kimi-k2.5 \
  --attempts 3
```

Judge model precedence: `scenario.judge.model` > run `--judge-model` > `EVAL_JUDGE_MODEL` > `deepseek/deepseek-v4-pro`.

Scoring per cell: the headline is a convergent **mean dimension-score ± bootstrap CI** with a **Wilson pass-rate** companion (the CI tightens ~1/√n, so `n` is a confidence dial, not a luck dial), surfaced in `show`/serve as a ✓/~/✗ threshold-vs-CI indicator; `passedAny`/pass@1/`bestScore` remain as drill-down fields. Plus total cost and avg duration. Cost is **always tracked** via a fallback chain: harness-reported session-cost rows (`costSource: "harness"`) → recomputed from per-message token usage × the models.dev pricing snapshot (`"recomputed"`) → tagged `"unpriced"` with any extracted tokens still stored. **Token usage is tracked universally**: when harness-priced rows carry no token columns, the recompute extractor still runs (tokens only — cost/source untouched), so every attempt with parseable harness output stores `tokens_json`. On heterogeneous rosters the extractor runs per member (each member's provider/model/session files) and results merge.

## Database

The DB of record is the Turso database `swarm-evals-local`, accessed through a **libsql embedded replica**: a local WAL file at `evals/evals-replica.db` (gitignored, disposable — rebuilt by sync) whose writes forward synchronously to the remote primary. `initDb()` syncs on boot, pulls in the background every 60 s, and asserts the replica is in WAL mode. Configuration is explicit — with no env set, `bun src/cli.ts serve` fails with a clear error instead of silently creating an empty DB:

- `EVALS_DB_SYNC_URL` + `EVALS_DB_AUTH_TOKEN` (both in `evals/.env`) → embedded replica against Turso (the normal mode).
- `EVALS_DB_PATH` → plain local libsql file, no sync (offline/dev escape hatch).

The old `evals/evals.db` (+ `-wal`/`-shm`) is a **frozen backup** of the pre-Turso data — never delete or write to it; new code can no longer open it because the implicit `file:evals.db` default was removed.

## Env

| Var | Purpose |
|---|---|
| `E2B_API_KEY` | sandbox creation (required) |
| `OPENROUTER_API_KEY` | judges + pi/opencode workers |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | claude workers |
| `OPENAI_API_KEY` | codex + ai-sdk-agent workers |
| `EMBEDDING_API_KEY` | API-sandbox memory embeddings — **required for memory seeding**; the `OPENAI_API_KEY` fallback is no longer injected (`EMBEDDING_MODEL` / `EMBEDDING_API_BASE_URL` pass through when set) |
| `EVAL_JUDGE_MODEL` | default judge model |
| `EVALS_DB_SYNC_URL` + `EVALS_DB_AUTH_TOKEN` | Turso embedded replica (DB of record — see [Database](#database)) |
| `EVALS_DB_PATH` | plain local DB file instead (offline/dev escape hatch) |
| `EVALS_PORT` | serve port override |
| `EVALS_E2B_TEMPLATE_API` / `EVALS_E2B_TEMPLATE_WORKER` | template overrides (default `agent-swarm-{api,worker}-latest`) |

## Notes

- Deploying the dashboard+runner somewhere persistent is deliberately deferred — it is local-first; data already lives in Turso, so a small custom Docker image (bun + this dir + the `EVALS_DB_*` env) is the likely shape.
- Stray sandboxes carry `metadata.launcher=agent-swarm-e2b`; sweep everything with `bun run src/cli.tsx e2b kill --all` from the repo root (per-run sweeps happen automatically on resume).
- Worker parked in `waiting_for_credentials` fails the attempt fast with the credential detail — usually a missing provider key for that config.
- The API sandbox runs with `NODE_ENV=production` and gets `EMBEDDING_API_KEY` (+ `EMBEDDING_MODEL` / `EMBEDDING_API_BASE_URL` when set in the evals env) so server-side memory embeddings work; workers still only receive the credentials their harness needs. Attempts recorded before version capture render the version fields as not captured.
- Claude subscription (OAuth) sessions produce no priced cost rows — their cost is recomputed from token usage × models.dev pricing (`costSource: "recomputed"`); pi/codex report cost directly (`"harness"`).
- Known harness finding: opencode workers on E2B intermittently fail with `Spawn failed: Timeout waiting for server to start after 5000ms` (opencode-internal server boot timeout, surfaced via runner.ts "Spawn failed").
