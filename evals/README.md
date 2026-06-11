# Swarm Evals

Evaluation harness for agent-swarm: runs a **scenario × harness-config matrix** against real swarm stacks deployed in **E2B sandboxes**, grades outcomes with **deterministic checks + LLM-as-judge** (OpenRouter via the AI SDK), and stores results in **libsql** (local file by default, Turso-pluggable).

## How it works

Each attempt (one cell of the matrix, possibly repeated for best@n):

1. **Boot** a fresh stack — one E2B sandbox for the swarm API (`agent-swarm-api-latest` template) + one for the worker (`agent-swarm-worker-latest`), worker configured with the cell's `HARNESS_PROVIDER` / `MODEL_OVERRIDE` and only the credentials that provider needs. Reuses `src/e2b/dispatch.ts` primitives from the repo root.
2. **Seed** (optional) — shell commands in the worker sandbox (`scenario.seed.exec`).
3. **Run** — create the scenario's task(s) directly assigned to the worker agent, poll until terminal status or timeout.
4. **Grade** — deterministic checks (implicit `tasks-completed` + scenario checks, with sandbox `exec`/`readFile` and swarm-API access) and an LLM judge over the flattened session-log transcript. Verdicts + artifacts (transcript, task JSON, worker log — all secret-redacted) persist to the DB.
5. **Teardown** — both sandboxes killed, even on failure.

Attempts are idempotent rows keyed by `(run, scenario, config, index)`: a crashed or Ctrl-C'd run continues with `resume`, and infra failures retry with fresh sandboxes (`--max-retries`).

## Usage

```bash
cd evals
bun install

# one-off: copy E2B_API_KEY / OPENROUTER_API_KEY / CLAUDE_CODE_OAUTH_TOKEN /
# ANTHROPIC_API_KEY / OPENAI_API_KEY from the repo-root .env into evals/.env

bun src/cli.ts registry                       # available scenarios + configs
bun src/cli.ts run                            # default: hello-file × 3 configs
bun src/cli.ts run --scenarios hello-file,quick-reasoning --configs claude-haiku,pi-deepseek-flash,opencode-gemini-flash --attempts 2
bun src/cli.ts resume <runId>                 # continue an interrupted run
bun src/cli.ts show <runId>                   # terminal result matrix
bun src/cli.ts serve                          # UI on http://localhost:4801
```

## Defining scenarios and configs

- Scenarios live in `scenarios/*.ts` (`Scenario` type): swarm setup, optional seeding, initial task(s), and an `outcome` (deterministic `checks` + `llmJudge` rubric + `passThreshold`). Register in `scenarios/index.ts`.
- Harness configs live in `configs/index.ts` (`HarnessConfig`): provider (`claude` / `pi` / `codex` / `opencode`), concrete `model` (worker `MODEL_OVERRIDE`) or `modelTier`, plus extra env.

Scoring per cell: **best@n** (any attempt passed), pass@1, best/avg LLM score, total cost (from swarm session-costs), avg duration.

## Env

| Var | Purpose |
|---|---|
| `E2B_API_KEY` | sandbox creation (required) |
| `OPENROUTER_API_KEY` | LLM judge + pi/opencode workers |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | claude workers |
| `OPENAI_API_KEY` | codex workers |
| `EVAL_JUDGE_MODEL` | judge model (default `google/gemini-3-flash-preview`) |
| `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | remote DB instead of local `evals.db` |
| `EVALS_DB_PATH`, `EVALS_PORT` | local overrides |
| `EVALS_E2B_TEMPLATE_API` / `EVALS_E2B_TEMPLATE_WORKER` | template overrides (default `agent-swarm-{api,worker}-latest`) |

## Notes

- Stray sandboxes (e.g. after a SIGKILL mid-boot) carry `metadata.launcher=agent-swarm-e2b` — sweep with `bun run src/cli.tsx e2b kill --all` from the repo root.
- Worker parked in `waiting_for_credentials` fails the attempt fast with the credential detail — usually a missing provider key for that config.
- Keep eval task descriptions explicit about calling `store-progress` with status `completed`; that is the swarm's completion mechanism.
