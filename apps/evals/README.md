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
- **Attempt hygiene.** A crash of the harness or its provider is not a model failure. Task failures that match `src/runner/harness-crash.ts` (context overflow, a dead provider stream) and tasks that time out with no session-log row end the attempt as `error` with `attempts.exclusion = 'harness-error'`; no score, pass rate or analytics aggregate counts them. Provider errors and no-output timeouts retry once on a fresh sandbox; a context overflow does not. Model-caused failures (tool loops, bad answers) stay `failed`.
- **Dead runs leave nothing in flight.** On boot the server marks every run still `running` as `failed` (as before) and closes out every attempt still `pending`/`running`/`judging` as `error` + `exclusion = 'cancelled'`. Cancelling a run does the same to its unfinished attempts. Cancelled attempts are not attempts: analytics drops them, and `resume` resets them to `pending`. The status column stays inside its existing CHECK constraint (`pending, running, judging, passed, failed, error`), so `exclusion` carries the reason.
- **Hard cost cap.** `--max-metered-usd <n>` (or a preset's) caps a run's metered spend: agent cost of configs billed per token, plus the judge, plus an E2B estimate (published per-second rates x the two sandbox shapes, about $0.13/h for the API sandbox and $0.33/h per worker; `EVALS_E2B_USD_PER_SANDBOX_HOUR` replaces it with one flat rate per sandbox). Once finished attempts reach the cap the runner starts nothing new and cancels the rest (`exclusion = 'cancelled'`). Attempts already running finish, so the total can pass the cap by up to `--concurrency` attempts. Billing follows the credential the sandbox gets: claude with an OAuth token is a subscription, claude with an API key is metered, codex on the swarm's ChatGPT credential is a subscription and codex on `OPENAI_API_KEY` is metered, pi/opencode are metered (`src/cost/billing.ts`). Each attempt records the billing of what its members actually booted with, and the cap reads that record.
- **Per-config concurrency.** A subscription-billed config runs at most 3 attempts at once whatever `--concurrency` says (`EVALS_SUBSCRIPTION_CONFIG_CONCURRENCY`), so one run cannot drain a subscription's rate window.

## Usage

```bash
cd apps/evals
bun install

# There is no apps/evals/.env since the monorepo move. Load the repo-root .env
# (E2B_API_KEY / OPENROUTER_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY /
# OPENAI_API_KEY / EMBEDDING_API_KEY) with --env-file, and pick a DB with
# EVALS_DB_PATH (local file) or EVALS_DB_SYNC_URL + EVALS_DB_AUTH_TOKEN (Turso).

bun --env-file=../../.env src/cli.ts registry                       # available scenarios + configs
EVALS_DB_PATH=$PWD/evals.db bun --env-file=../../.env src/cli.ts run  # default: memory-seeded-recall × 3 configs
EVALS_DB_PATH=$PWD/evals.db bun --env-file=../../.env src/cli.ts run --scenarios memory-seeded-recall,build-verify-fix --configs claude-haiku,pi-deepseek-flash --attempts 2 --judge-model anthropic/claude-sonnet-4.5
EVALS_DB_PATH=$PWD/evals.db bun --env-file=../../.env src/cli.ts resume <runId>   # continue an interrupted run
EVALS_DB_PATH=$PWD/evals.db bun --env-file=../../.env src/cli.ts show <runId>     # terminal result matrix
EVALS_DB_PATH=$PWD/evals.db bun --env-file=../../.env src/cli.ts serve            # UI on http://localhost:4801
EVALS_DB_PATH=$PWD/evals.db bun --env-file=../../.env src/cli.ts publish --suite 1.0 --run <runId>  # freeze a matrix run for /benchmark
```

`publish` writes a frozen snapshot plus a disclosure bundle to `benchmark/<suite>/`, which the server serves without auth at `/benchmark`. It refuses a run that is not finished, misses a public scenario × config cell, has any cell under 5 graded attempts, or fails grader validation. Held-out scenarios (`HELD_OUT_SCENARIO_IDS` in `scenarios/suite.ts`) never enter the snapshot. Commit the written directory in its own PR: merging it is what makes the numbers public. Methodology: [docs/methodology.md](docs/methodology.md). For local UI work, `bun scripts/benchmark-fixture.ts /tmp/bm` writes a synthetic snapshot; serve it with `EVALS_BENCHMARK_DIR=/tmp/bm`.

Scheduled-tier presets (`--preset nightly-canary`, `--preset weekly-matrix`) also carry a run plan (repeats and metered cap) that explicit flags override; `--scenarios suite` expands to every scenario of the current suite version. `POST /api/runs` takes the same via `preset` and `maxMeteredUsd`; a `preset` with no `scenarioIds` runs the whole suite. No schedule is switched on: these only name what a run contains.

### Evaluating a branch

The `agent-swarm-{api,worker}-latest` E2B templates track the last release. To evaluate a branch, build both images from the branch (the API renders the prompt templates over HTTP, so the API image matters as much as the worker image), push them, and build E2B templates from the pushed images:

```bash
# from the repo root, on the branch under test
SHA=$(git rev-parse --short HEAD)
# amd64 images on the remote buildx builder (native amd64; the GHCR packages are public)
docker buildx build --builder kamal-remote-ssh---root-168-119-139-170 --platform linux/amd64 \
  -f Dockerfile -t ghcr.io/desplega-ai/agent-swarm:<branch>-$SHA --push .
docker buildx build --builder kamal-remote-ssh---root-168-119-139-170 --platform linux/amd64 \
  -f Dockerfile.worker --target worker-slim -t ghcr.io/desplega-ai/agent-swarm-worker:<branch>-$SHA-slim --push .

bun run src/cli.tsx e2b build-template --role api --source image \
  --template agent-swarm-api-<branch> --image ghcr.io/desplega-ai/agent-swarm:<branch>-$SHA
bun run src/cli.tsx e2b build-template --role worker --source image \
  --template agent-swarm-worker-<branch> --image ghcr.io/desplega-ai/agent-swarm-worker:<branch>-$SHA-slim

cd apps/evals
EVALS_E2B_TEMPLATE_API=agent-swarm-api-<branch> EVALS_E2B_TEMPLATE_WORKER=agent-swarm-worker-<branch> \
EVALS_DB_PATH=$PWD/evals.db bun --env-file=../../.env src/cli.ts run --name <name> \
  --scenarios delegation-probe --configs claude-opus-4.8,codex-5.6-terra,pi-deepseek-flash,opencode-deepseek-flash \
  --attempts 3 --concurrency 12
```

Rebuild both templates after every push to the branch; a template is a snapshot of one image. The local-checkout template path (`e2b build-template` without `--source image`) does not work with e2b CLI 2.10.2: it rejects multi-stage Dockerfiles.

### Smoke scenario

`memory-seeded-recall` is the **designated smoke scenario** — the cheapest meaningful end-to-end verification (1 worker, 1 task, deterministic-only: zero judge LLM spend) that still proves a real swarm capability (seeded-memory embed + retrieval). Run it first after any harness change:

```bash
bun src/cli.ts run --scenarios memory-seeded-recall --configs claude-haiku
```

It requires `EMBEDDING_API_KEY` in the repo-root `.env` (the API sandbox embeds the seeded memory server-side; the `OPENAI_API_KEY` fallback is no longer injected); without it the attempt fails loudly at seed time. The former `hello-file` / `quick-reasoning` dummies were removed from the registry — historical runs referencing them still render everywhere (the scenario detail page falls back to an "unregistered scenario" view).

### UI (`serve`)

Local-first dashboard + API; **runs can be triggered, resumed, and cancelled from the UI** and execute inside the serve process:

- `#/leaderboard` (home) — the best setups for one suite version: a Pareto chart (score vs $/attempt or agent time, log x axis, 95% CI whiskers, colour = harness, shape = reasoning effort, dashed line = frontier, hollow marker = partial coverage or under 3 attempts on some scenario) and the ranking table (rank with its range, score ± CI, pass@1, pass^k, $/attempt, p50 time, tokens, attempts). A suite selector and a fixed-harness / best-harness-per-model track toggle; a row click opens that config's runs. With no config that ran the whole suite it draws no frontier and says why. View state lives in the hash (`#/leaderboard?suite=1.0&x=time&track=free&harness=claude`). `#/leaderboard/heatmap` is the scenario x config pass-rate grid (an all-red column is broken or too hard, an all-green one has stopped separating setups; a cell opens its attempts). `#/leaderboard/reliability` shows pass@1 against pass^k per config and each config's run-to-run score with a 95% band. `#/leaderboard/analytics` is the earlier Analytics page (trends, cost matrix, models, rollups); `#/analytics` redirects there.
- `#/scenarios` — one card per scenario (what it tests, what the agent does, how it is scored, tags, version, suite membership, changelog), from `scenarios/cards.ts`; the table view and the full definition sit behind it.
- `#/runs` — run list + matrix, live in-flight attempts with elapsed time, cancel/resume. `#/runs?config=<id>` opens it narrowed to one config.
- `#/runs/:id/attempts/:attemptId` — an Outcome panel first (verdict, gates, then each dimension with a one-line reason; an `error` attempt is shown apart from a `failed` one), then per-attempt judgments (incl. agentic-judge tool inputs AND outputs in `raw`), phase timings, sandbox info, assets, and a chat-style transcript viewer parsed from the raw session logs (legacy `#/runs/:id/cells/:scenario/:config` URLs redirect).
- `#/scenarios` — searchable scenario registry; `#/scenarios/:id` shows what the scenario will do (tasks, seeding, checks, judges, rubric) + recent attempts across runs.
- Light/dark theme (persisted, follows `prefers-color-scheme`).

Key endpoints: `GET/POST /api/runs`, `POST /api/runs/:id/{resume,cancel}`, `GET /api/runs/:id`, `GET /api/runs/:id/regression`, `GET /api/attempts/:id{,/transcript}`, `GET /api/scenarios{,/:id}`, `GET/POST /api/configs`, `PATCH /api/configs/:id`, `GET /api/models`, `POST /api/models/refresh`, `GET /api/analytics`, `GET /api/analytics/{suites,frontier,leaderboard,heatmap,reliability,compare,cell}`, `GET /api/artifacts/:id`.

`GET /api/models` feeds every model name and price in the UI: `models` is the judge picker list (openrouter only), `harnessModels` holds the claude (anthropic) and codex (openai) entries used only to name and price ids, `aliases` maps bare claude shortnames, and `catalog` says whether the data is `live`, `db` (last persisted fetch) or the committed `snapshot`, and when it was fetched. `GET /api/configs` rows carry `resolvedModel`: what a `modelAlias` resolves to today. The Configs page shows the catalog badge and a refresh button (`POST /api/models/refresh`).

When `EVALS_API_KEY` is set, every `/api/*` endpoint requires `Authorization: Bearer <key>`.
Static UI assets and `/health` stay public. Browser users open the URL, paste the same key once,
and the UI stores it in `localStorage`; a 401 clears the stored key and shows the prompt again.
When `EVALS_API_KEY` is unset, the server logs a warning and leaves `/api/*` open for local dev
and tests.

`POST /api/runs` and `POST /api/runs/:id/resume` are also guarded by
`EVALS_MAX_CONCURRENT_RUNS` (default `1`). The cap counts runs actively executing inside the
serve process; when the cap is reached, the API returns HTTP 429.

### Scheduled runs (nightly canary and weekly matrix)

The trigger lives in our deployed swarm, not in this repo: a scheduled swarm workflow `evals-nightly` starts the run with `POST /api/runs {"preset": "nightly-canary"}` (or `weekly-matrix`), retrying 5xx. Two schedules fire it in Europe/Madrid time: the canary Monday to Saturday at 03:00, the matrix Sunday at 03:00 (the matrix already covers the canary configs, and the service runs one eval run at a time). The service key reaches the request through a swarm credential binding for this host, so no CI secret holds it. After a fixed wait (3 h canary, 5.5 h matrix) the workflow reads `GET /api/runs/:id/regression` and posts to Slack itself only when the service did not: the run never started, it is not final, or no summary went out. Trigger the workflow by hand with `{"tier": "canary"}`; `{"dryRun": true}` only reads `GET /api/runs?limit=1` and posts nothing. The service does the rest for a run started from a scheduled preset (`SCHEDULED_PRESET_IDS` in `configs/presets.ts`: `nightly-canary`, `weekly-matrix`):

- **Scenarios.** `nightly-canary` runs the 9 public single-run scenarios (`canarySuiteScenarioIds()`: no held-out, no `-solo`); `weekly-matrix` runs the whole suite, held-out and solo baselines included. Repeats and the metered $ cap come from the preset (3 x $4.50, 5 x $37).
- **Regression check.** When the run finishes, `src/regression.ts` compares each config x scenario cell with the same preset's last 14 finished runs (same `resolved_model`, same scenario version; under 9 graded baseline attempts, nothing is judged). By the cell's baseline pass rate:
  - 95% or more (the paging tier): with 3 repeats, 1 failure is noise, 2 flag and start 6 automatic reruns, 3 page at once. A flagged cell pages only when its current + rerun attempts differ from the baseline by Fisher's exact test at p < 0.01 after Holm correction across the run's flagged cells; otherwise it is `cleared`. Separately, a drop in the mean score of the passing attempts flags (never pages) when its 95% bootstrap CI is below 0 and the drop exceeds the minimum detectable effect from the baseline's variance (at least 5 points).
  - 50% to 95%: `quarantine`, reported and never flagged. Under 50%: `broken`, not flaky.
  - A config whose `resolved_model` changed starts a new baseline and reports `model-changed` instead of flagging.
  - Run cost (metered or notional) over 1.5x the config's baseline median is flagged.

  The reruns are one extra run (`rerun_of` set, $2 cap). Not built: quarantine owners and 14-day expiry, which need a store; the summary lists quarantined cells so someone can take them.
- **One Slack summary.** Posted to `EVALS_SLACK_WEBHOOK_URL` once nothing is left to wait for (`summary_posted_at` dedupes resumes): pass rate per scenario and config, pages, flags, cost drift, model changes, infra errors (with a rate-limit count), metered cost against the cap, and a link to the run (`EVALS_PUBLIC_URL`, default `https://evals.agent-swarm.dev`). A run that ends `failed` or `cancelled` posts a short notice instead. A run the cost cap stopped still ends `done` and posts the normal summary, with the cancelled attempts counted under Infra. With `EVALS_SLACK_WEBHOOK_URL` unset the service only logs the summary, `summary_posted_at` stays null, and the workflow's fallback posts instead.
- **`GET /api/runs/:id/regression`.** The report and the Slack text for a scheduled run, computed from the database now; `final` is false while a rerun is pending. Only runs started with a scheduled `preset` (`POST /api/runs {"preset": "nightly-canary"}`) have one.

### Suite analytics API

Answers "which setup is best" for one suite version. `GET /api/analytics/{frontier,leaderboard,heatmap,reliability,compare}` all take `suite` (default: the current suite in `scenarios/suite.ts`) and the same `harnesses`, `configs` and `efforts` CSV filters as `GET /api/analytics`. `GET /api/analytics/suites` lists the suites that have attempts. Only attempts stamped with that `suite_version` count; off-suite and `cancelled` attempts are ignored, and `error` attempts are counted but never scored.

- **Score.** The mean of per-scenario means, so a scenario with extra attempts does not dominate. The 95% CI is a seeded stratified bootstrap over the attempts inside each scenario (the suite's scenarios are fixed). $/attempt is aggregated the same way; agent time is a pooled median of `timings.tasksMs`.
- **Full suite.** A config is ranked, and counts toward the pooled frontier, only when every scenario of the suite has a graded attempt. Others are listed with `rank: null`.
- **`lowN`.** A cell under 3 graded attempts. A `lowN` config never sits on the pooled frontier, so a thin run returns `status: "low-n"` and empty frontiers, not a misleading one. `frontier.status` is `ok`, `low-n`, `no-full-coverage` or `empty`.
- **`frontier`.** Pooled non-dominated sets for score vs $/attempt and score vs agent time, plus a per-scenario frontier that accepts partial coverage. A config with unpriced attempts (`costComplete: false`) stays off the cost frontier.
- **`leaderboard`.** Two tracks: `fixedHarness` (one group per harness, every model ranked within it) and `bestHarnessPerModel`. Each row has `rank`, a bootstrap `rankSpread`, `passAt1`, `passPowK` (`?k=`, default 3; the unbiased chance that k attempts on a scenario all pass, averaged over scenarios with at least k graded attempts), $/attempt, p50 agent time, tokens, `resolvedModel`, `efforts` and `suiteVersion`.
- **`heatmap`.** Scenario x config pass fractions, plus an `anyConfig` row per scenario (`configsPassing: 0` means no config ever passes it).
- **`reliability`.** Per config, a pass^k and pass@k curve for k = 1..`maxK` (default 5) and a per-run score trend with CI bands (last 60 runs).
- **`cell?scenario=&config=`.** The attempts behind one heatmap cell, newest run first (`suite` as above; up to 100, `truncated` says if there were more), so a reader can open one and read its transcript. `cancelled` and off-suite attempts are left out, `error` ones are listed and counted apart.
- **`compare?a=&b=`.** Per-scenario means for both configs and a paired bootstrap of the difference that resamples scenarios, not attempts. It reports a CI only with at least 5 shared scenarios.

## Deploying the eval service

Build the standalone service image from the repo root so the Dockerfile can copy both `evals/`
and the small root helpers it imports:

```bash
docker build -f apps/evals/Dockerfile .
```

The container runs `bun src/cli.ts serve`, serves the built SPA and `/api/*` on one origin, and
listens on `EVALS_PORT` (default `4801`). Caddy, HTTPS, and the public domain are Taras's layer on
top. A human opens the deployed URL and pastes `EVALS_API_KEY` once; swarm/CLI callers send the
same key as `Authorization: Bearer <key>`.

Required Dokploy env/secrets:

| Var | Required | Purpose |
|---|---:|---|
| `EVALS_API_KEY` | yes | Static master key for every `/api/*` route. Leave unset only for local dev/tests. |
| `EVALS_PORT` | no | Serve port; defaults to `4801`. |
| `EVALS_MAX_CONCURRENT_RUNS` | no | Max active runs in the service process; defaults to `1`. |
| `EVALS_DB_SYNC_URL` | yes | Turso remote primary sync URL for the embedded replica. |
| `EVALS_DB_AUTH_TOKEN` | yes | Turso auth token for `EVALS_DB_SYNC_URL`. |
| `E2B_API_KEY` | yes | E2B sandbox creation. |
| `OPENROUTER_API_KEY` | yes | Judges and pi/opencode workers. |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes for claude configs | Claude Code OAuth workers. |
| `ANTHROPIC_API_KEY` | yes for Anthropic API configs | Anthropic-backed claude workers when used. |
| `EVALS_SWARM_API_URL` + `EVALS_SWARM_API_KEY` | for codex on subscription | The swarm whose `codex_oauth_<slot>` ChatGPT credential codex members boot with. The sandbox gets the access token only (blank refresh token); refresh happens host-side through the swarm's locked refresher, so no sandbox rotates the shared token. When set, `OPENAI_API_KEY` is never forwarded and a credential failure fails the boot (`src/swarm/codex-auth.ts`). |
| `EVALS_CODEX_OAUTH_SLOT` | no | Slot to borrow (default `0`). Point it at a slot reserved for evals to keep eval usage off the swarm workers' rate window. |
| `OPENAI_API_KEY` | yes for codex without the two vars above | Codex workers, metered. |
| `EMBEDDING_API_KEY` | yes for memory-seeded scenarios | API-sandbox memory embeddings; `OPENAI_API_KEY` is not a fallback. |
| `EMBEDDING_MODEL` | no | Optional embedding model override passed to the API sandbox. |
| `EMBEDDING_API_BASE_URL` | no | Optional embedding API base URL passed to the API sandbox. |
| `EVAL_JUDGE_MODEL` | no | Default judge model override. |
| `EVALS_E2B_TEMPLATE_API` | no | API sandbox template override. |
| `EVALS_E2B_TEMPLATE_WORKER` | no | Worker sandbox template override. |
| `EVALS_MODEL_CATALOG_REFRESH` | no | `off` disables the models.dev refresh loop; the committed snapshot serves. |
| `EVALS_SLACK_WEBHOOK_URL` | for scheduled runs | Slack incoming webhook for the one summary a scheduled run posts. Unset: the summary is only logged. |
| `EVALS_PUBLIC_URL` | no | Base URL for run links in that summary; defaults to `https://evals.agent-swarm.dev`. |

Do not use `EVALS_DB_PATH` for Dokploy unless intentionally running an offline disposable DB; the
container filesystem can be replaced on redeploy, so persisted history should use the Turso
remote primary via `EVALS_DB_SYNC_URL` + `EVALS_DB_AUTH_TOKEN`.

## Defining scenarios and configs

- Scenarios live in `scenarios/*.ts` (`Scenario` type): description, optional seeding, initial task(s), and an `outcome` (deterministic `checks`, `llmJudge` and/or `agenticJudge` rubrics, `passThreshold`). Register in `scenarios/index.ts` — every scenario is shape-validated at registry load (`validateScenario`; bad definitions fail CLI/server startup with the full violation list).
- Harness configs live in `configs/index.ts` (`HarnessConfig`): provider (`claude` / `pi` / `codex` / `opencode`), then either a concrete `model` (worker `MODEL_OVERRIDE`) or a moving `modelAlias` (see [Model catalog and `latest:` aliases](#model-catalog-and-latest-aliases)), plus extra env. The two are mutually exclusive. The seed catalog leaves `modelTier` unset: a tier resolved at claim time would grade a moving target.

### Model catalog and `latest:` aliases

Prices, display names and alias resolution come from models.dev. `src/cost/catalog.ts` serves the newest payload it holds: a live fetch, else the last one persisted in `model_catalog_cache`, else the committed `src/be/modelsdev-cache.json` snapshot. `serve` loads the persisted payload at boot, then revalidates every 6h with `If-None-Match`; a failed fetch keeps the previous payload. `POST /api/models/refresh` (or the refresh button on the Configs page) forces a fetch now. The snapshot is the reviewed allowlist of model ids: a live fetch updates pricing and metadata such as `release_date` but never adds a model to the judge picker or to alias resolution.

A config may set `modelAlias` instead of `model`:

- `latest:anthropic/<family>` (provider `claude`): the newest undated `claude-*` id of that family (`latest:anthropic/opus`).
- `latest:openrouter/<glob>` (provider `pi` / `opencode`): the newest openrouter id matching the glob (`*` = any run of characters), returned with the `openrouter/` prefix (`latest:openrouter/deepseek/deepseek-v4*-flash`). Dated, `-latest`, `:free` and preview ids are skipped unless the glob names them.
- Newest means the greatest `release_date`, ties broken by the greatest id.
- Evals accepts only that grammar. It rejects the `@stable` / `@any` channel suffix and `latest:openai/*`, which the swarm's shared resolver (`packages/model-catalog`) understands, so eval configs keep resolving exactly as before.

An alias resolves once, when a run is created, and the concrete id is pinned in `eval_run_configs`. Attempts and resumes read the pin, never the live catalog, so one run grades one model. `GET /api/configs` shows what each alias resolves to today (`resolvedModel`), and `POST` / `PATCH /api/configs` reject an alias that matches nothing.

Two deliberate differences from the swarm's own catalog:

- **Alias rule.** The evals rule is frozen for reproducibility (v7 spec §8): a model without a `release_date` ranks oldest in its family. The swarm's `buildClaudeShortnameMap` ranks an undated model newest, because only just-launched models lack a date there. The two can pick different ids for the same shortname. On the committed snapshot alone, `latest:anthropic/opus` resolves to `claude-opus-5` here, while the swarm resolves `opus` to `claude-opus-5-5`, which the snapshot lists without a `release_date`; once a live models.dev fetch supplies that date, both pick `claude-opus-5-5`. Evals keeps its rule so historical alias rows and analytics grouping do not shift.
- **No swarm DB.** Evals does not read the swarm's `model_catalog` (`GET /api/models-catalog`). It is a separate service with its own libsql database and no swarm API URL or key. Attempts run in ephemeral E2B swarm stacks, and configs pin exact ids. The swarm's overlay rows and `harness_model_support` describe the production CLIs, not what an eval worker image runs, and its catalog projection omits `tool_call`, which the model cards here show.

`EVALS_MODEL_CATALOG_REFRESH=off` turns the boot load and the 6h refresh off, so the committed snapshot serves (the loop is also off under `NODE_ENV=test`). The manual refresh endpoint still works.

### Reasoning effort

A config may set `reasoningEffort`, and a run may override it per config: the New Run dialog, `--effort <configId>=<level>` on `run` (`default` = harness default), or `efforts` on `POST /api/runs`. Which levels a harness + model pair takes comes from the shared rule in `packages/model-catalog` (`reasoningLevelsForModel`, the one the swarm API validates with), read against the same catalog aliases resolve against. `GET /api/effort-levels?provider=&model=` (or `&modelAlias=`) returns them for the config form and the dialog. Creating a run or saving a config with a level the pair does not take is rejected.

The effective effort of each config is snapshotted in `eval_runs.efforts_json` when the run is created, and attempts read only that snapshot, never the live config, so a resumed run grades the same effort. It reaches the worker as `REASONING_EFFORT_OVERRIDE`, next to `MODEL_OVERRIDE`. Each attempt records the level it launched with (`attempts.reasoning_effort`) and the level its harness reported applying (`attempts.applied_reasoning_effort`, from the agent's `latestModel`); a mismatch is logged. Rows from before efforts existed read as the harness default.

The Runs and Configs pages have an Effort filter, the matrix and config tables show a chip beside the model, and Analytics filters by effort and has a By Effort rollup. Runs at different efforts of one model stay in one model row; the row lists its efforts.

### Seeding (`scenario.seed`)

Seeding runs before the first task is created, in this order:

- `sqlDump` — bare filename of a **full SQLite text dump** (`sqlite3 <db> .dump`) under `scenarios/fixtures/`, imported into the API sandbox's DB **before** the API server first boots (migrations forward-apply on top). The runner validates the fixture host-side before any sandbox exists: it must carry the `_migrations` table with applied rows and stay under 5 MB. Seed reference data only — no `agents` rows, no in-flight tasks, no sessions/locks, and no hand-seeded `agent_memory` rows (use `memories` instead). Conventions + regeneration recipe: [scenarios/fixtures/README.md](./scenarios/fixtures/README.md).
- `memories` — strings (max 16) indexed as **swarm-scope memories** via the memory API after boot; embeddings are computed server-side, and the runner blocks until every seeded memory is searchable (90 s gate). Requires `EMBEDDING_API_KEY` in the repo-root `.env` (the `OPENAI_API_KEY` fallback is no longer injected) — without it the attempt fails loudly at seed time instead of mysteriously at judging time.
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

## Suite versions and grader validation

Scenarios carry an integer `version`, and `scenarios/suite.ts` lists the versions that make up `swarm-evals@1.0`. Every attempt records `scenario_version`, and `suite_version` when its scenario at that version is in the manifest (NULL otherwise, so off-suite runs never mix into a suite chart). `scenarios/scenario-hashes.ts` pins a content hash per version (prompt, fixtures and check source); `bun test scenarios/versioning.test.ts` fails when content changes without a bump. `scenarios/CHANGELOG.md` has the bump rules.

`scenarios/grader-validation.test.ts` grades every registered scenario offline: a null agent (tasks completed, nothing done) must score below 0.75 and fail a scenario gate even under a judge that gives full marks, and a reference solution (`scenarios/grader-fixtures/<id>.ts`) must pass every gate. A new scenario fails the suite until it has a fixture.

The DB gained additive columns (`attempts.scenario_version`, `suite_version`, `exclusion`; `eval_runs.max_metered_usd`) via the usual boot-time `ALTER TABLE`; agent time (`agentMs`, from `timings_json.tasksMs`, sandbox boot and seeding excluded) is derived at query time.

## Database

The DB of record is the Turso database `swarm-evals-local`, accessed through a **libsql embedded replica**: a local WAL file at `evals/evals-replica.db` (gitignored, disposable — rebuilt by sync) whose writes forward synchronously to the remote primary. `initDb()` syncs on boot, pulls in the background every 60 s, and asserts the replica is in WAL mode. Configuration is explicit — with no env set, `bun src/cli.ts serve` fails with a clear error instead of silently creating an empty DB:

- `EVALS_DB_SYNC_URL` + `EVALS_DB_AUTH_TOKEN` (in the repo-root `.env`, loaded with `bun --env-file=../../.env`) → embedded replica against Turso (the normal mode for the deployed service).
- `EVALS_DB_PATH` → plain local libsql file, no sync. Local CLI runs use `EVALS_DB_PATH=$PWD/evals.db`; the implicit `file:evals.db` default was removed, so the path must be explicit.

`apps/evals/evals.db` (+ `-wal`/`-shm`) is gitignored and holds the local run history (the pre-Turso data plus every local `EVALS_DB_PATH` run since). Do not delete it.

## Env

| Var | Purpose |
|---|---|
| `E2B_API_KEY` | sandbox creation (required) |
| `OPENROUTER_API_KEY` | judges + pi/opencode workers |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | claude workers |
| `OPENAI_API_KEY` | codex workers |
| `EMBEDDING_API_KEY` | API-sandbox memory embeddings — **required for memory seeding**; the `OPENAI_API_KEY` fallback is no longer injected (`EMBEDDING_MODEL` / `EMBEDDING_API_BASE_URL` pass through when set) |
| `EVAL_JUDGE_MODEL` | default judge model |
| `EVALS_DB_SYNC_URL` + `EVALS_DB_AUTH_TOKEN` | Turso embedded replica (DB of record — see [Database](#database)) |
| `EVALS_DB_PATH` | plain local DB file instead (offline/dev escape hatch) |
| `EVALS_API_KEY` | static master key for deployed `/api/*`; when unset the API is open for local dev/tests |
| `EVALS_MAX_CONCURRENT_RUNS` | max active runs accepted by `serve` (default `1`; over-cap creates/resumes return 429) |
| `EVALS_PORT` | serve port override |
| `EVALS_CODEX_BILLING` | `subscription` if the `OPENAI_API_KEY` given to codex workers fronts a flat plan; default metered (counts toward the run's cost cap) |
| `EVALS_SUBSCRIPTION_CONFIG_CONCURRENCY` | max concurrent attempts per subscription-billed config (default `3`) |
| `EVALS_E2B_USD_PER_SANDBOX_HOUR` | flat per-sandbox E2B price for the cost cap's sandbox estimate; unset = E2B's published rates for the API (2 vCPU / 2 GiB) and worker (4 vCPU / 8 GiB) templates, see `src/cost/billing.ts` |
| `EVALS_SLACK_WEBHOOK_URL` / `EVALS_PUBLIC_URL` | Slack webhook and link base for a scheduled run's summary (see [Scheduled runs](#scheduled-runs-nightly-canary-and-weekly-matrix)) |
| `EVALS_MODEL_CATALOG_REFRESH` | set to `off` to skip the models.dev boot load and 6h refresh and serve the committed snapshot (see [Model catalog](#model-catalog-and-latest-aliases)) |
| `EVALS_E2B_TEMPLATE_API` / `EVALS_E2B_TEMPLATE_WORKER` | template overrides (default `agent-swarm-{api,worker}-latest`; see [Evaluating a branch](#evaluating-a-branch)) |

## Notes

- The dashboard+runner deploys via `apps/evals/Dockerfile` (see "Deploying the eval service" above). Since the monorepo migration, evals is a Bun workspace member: the image installs at the **workspace root** (root `package.json` + `bun.lock` + `bunfig.toml` + all member manifests) — there is no evals-local lockfile anymore.
- Stray sandboxes carry `metadata.launcher=agent-swarm-e2b`; sweep everything with `bun run src/cli.tsx e2b kill --all` from the repo root (per-run sweeps happen automatically on resume).
- Worker parked in `waiting_for_credentials` fails the attempt fast with the credential detail — usually a missing provider key for that config.
- The API sandbox runs with `NODE_ENV=production` and gets `EMBEDDING_API_KEY` (+ `EMBEDDING_MODEL` / `EMBEDDING_API_BASE_URL` when set in the evals env) so server-side memory embeddings work; workers still only receive the credentials their harness needs. Both API and worker sandboxes pin `DESPLEGA_TELEMETRY_ENV=test`, keeping eval activity out of production telemetry cohorts without changing runtime behavior. Attempts recorded before version capture render the version fields as not captured.
- Claude subscription (OAuth) sessions produce no priced cost rows — their cost is recomputed from token usage × models.dev pricing (`costSource: "recomputed"`); pi/codex report cost directly (`"harness"`).
- Known harness finding: opencode workers on E2B intermittently fail with `Spawn failed: Timeout waiting for server to start after 5000ms` (opencode-internal server boot timeout, surfaced via runner.ts "Spawn failed").
