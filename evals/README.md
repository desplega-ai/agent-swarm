# Swarm Evals

Evaluation harness for agent-swarm: runs a **scenario × harness-config matrix** against real swarm stacks deployed in **E2B sandboxes**, grades outcomes with **deterministic checks + LLM/agentic judges** (OpenRouter via the AI SDK), and stores results in **libsql** (local file by default, Turso-pluggable).

## How it works

Each attempt (one cell of the matrix, possibly repeated for best@n):

1. **Boot** a fresh stack — one E2B sandbox for the swarm API (`agent-swarm-api-latest` template) + one for the worker (`agent-swarm-worker-latest`), worker configured with the cell's `HARNESS_PROVIDER` / `MODEL_OVERRIDE` and only the credentials that provider needs. Reuses `src/e2b/dispatch.ts` primitives from the repo root.
2. **Seed** (optional) — shell commands in the worker sandbox (`scenario.seed.exec`).
3. **Run** — create the scenario's task(s) directly assigned to the worker agent, poll until terminal status or timeout.
4. **Grade** — deterministic checks (implicit `tasks-completed` + scenario checks), an optional **LLM judge** over the flattened transcript, and an optional **agentic judge**: an AI SDK tool-loop with live sandbox/API access (`run_command` / `read_file` / `api_get` / `submit_verdict`) that verifies the rubric itself instead of trusting the transcript (falls back to the LLM judge if it never submits a verdict).
5. **Persist artifacts** (secret-redacted): flattened transcript, **raw swarm session-log events** (`session-logs.jsonl`), the **harness's own raw session files** pulled from the worker filesystem (e.g. Claude Code's `~/.claude/projects/**/*.jsonl`, codex `~/.codex/sessions`, pi `~/.pi`, opencode `~/.local/share/opencode` — files touched during the attempt, capped 10 × 1.5 MB), task records, seed command outputs (`seed-output.json`), raw session-cost rows (`session-costs.json`), the full session-file listing with sizes/mtimes (`session-files.json`), and the worker + API entrypoint log tails. Per-attempt sandbox info (both sandbox ids, templates, apiUrl, swarm key, TTL) is stored at boot, and per-phase wall-clock timings on finish.
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
bun src/cli.ts run                            # default: hello-file × 3 configs
bun src/cli.ts run --scenarios hello-file,quick-reasoning --configs claude-haiku,pi-deepseek-flash --attempts 2 --judge-model anthropic/claude-sonnet-4.5
bun src/cli.ts resume <runId>                 # continue an interrupted run
bun src/cli.ts show <runId>                   # terminal result matrix
bun src/cli.ts serve                          # UI on http://localhost:4801
```

### UI (`serve`)

Local-first dashboard + API; **runs can be triggered, resumed, and cancelled from the UI** and execute inside the serve process:

- `#/runs` — run list + matrix, live in-flight attempts with elapsed time, cancel/resume.
- `#/runs/:id/attempts/:attemptId` — per-attempt judgments (incl. agentic-judge tool inputs AND outputs in `raw`), phase timings, sandbox info, assets, and a chat-style transcript viewer parsed from the raw session logs (legacy `#/runs/:id/cells/:scenario/:config` URLs redirect).
- `#/scenarios` — searchable scenario registry; `#/scenarios/:id` shows what the scenario will do (tasks, seeding, checks, judges, rubric) + recent attempts across runs.
- Light/dark theme (persisted, follows `prefers-color-scheme`).

Key endpoints: `GET/POST /api/runs`, `POST /api/runs/:id/{resume,cancel}`, `GET /api/runs/:id`, `GET /api/attempts/:id{,/transcript}`, `GET /api/scenarios{,/:id}`, `GET /api/configs`, `GET /api/artifacts/:id`.

## Defining scenarios and configs

- Scenarios live in `scenarios/*.ts` (`Scenario` type): description, optional seeding, initial task(s), and an `outcome` (deterministic `checks`, `llmJudge` and/or `agenticJudge` rubrics, `passThreshold`). Register in `scenarios/index.ts`.
- Harness configs live in `configs/index.ts` (`HarnessConfig`): provider (`claude` / `pi` / `codex` / `opencode`), concrete `model` (worker `MODEL_OVERRIDE`) or `modelTier`, plus extra env.

Judge model precedence: `scenario.judge.model` > run `--judge-model` > `EVAL_JUDGE_MODEL` > `deepseek/deepseek-v4-pro`.

Scoring per cell: **best@n** (any attempt passed), pass@1, best/avg judge score, total cost, avg duration. Cost is **always tracked** via a fallback chain: harness-reported session-cost rows (`costSource: "harness"`) → recomputed from per-message token usage × the models.dev pricing snapshot (`"recomputed"`) → tagged `"unpriced"` with any extracted tokens still stored.

## Env

| Var | Purpose |
|---|---|
| `E2B_API_KEY` | sandbox creation (required) |
| `OPENROUTER_API_KEY` | judges + pi/opencode workers |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | claude workers |
| `OPENAI_API_KEY` | codex workers |
| `EVAL_JUDGE_MODEL` | default judge model |
| `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | remote DB instead of local `evals.db` |
| `EVALS_DB_PATH`, `EVALS_PORT` | local overrides |
| `EVALS_E2B_TEMPLATE_API` / `EVALS_E2B_TEMPLATE_WORKER` | template overrides (default `agent-swarm-{api,worker}-latest`) |

## Notes

- Deploying the dashboard+runner somewhere persistent is deliberately deferred — it is local-first; a small custom Docker image (bun + this dir + a volume for `evals.db`) is the likely shape.
- Stray sandboxes carry `metadata.launcher=agent-swarm-e2b`; sweep everything with `bun run src/cli.tsx e2b kill --all` from the repo root (per-run sweeps happen automatically on resume).
- Worker parked in `waiting_for_credentials` fails the attempt fast with the credential detail — usually a missing provider key for that config.
- Claude subscription (OAuth) sessions produce no priced cost rows — their cost is recomputed from token usage × models.dev pricing (`costSource: "recomputed"`); pi/codex report cost directly (`"harness"`).
- Known harness finding: opencode workers on E2B intermittently fail with `Spawn failed: Timeout waiting for server to start after 5000ms` (opencode-internal server boot timeout, surfaced via runner.ts "Spawn failed").
