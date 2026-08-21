---
date: 2026-08-21
topic: System prompt v2, delegation-probe eval before and after (PR #1217)
status: complete
---

# Prompt v2 vs v1 on the delegation probe

Scenario `delegation-probe` (1 lead + 2 workers, deterministic rubric, no judge), 3 attempts per cell, concurrency 12, one config per harness. Baseline ran on the released `agent-swarm-{api,worker}-latest` E2B templates. The v2 runs used templates built from this branch (`--source image`, worker-slim) named `agent-swarm-{api,worker}-prompt-v2`.

| Config | v1 baseline (latest) | v2 @2ee5b719 | v2 @c788dc07 (lead tweak) |
|---|---|---|---|
| claude-opus-4.8 | 0.77 ±0.34, 2/3 | 0.77 ±0.34, 2/3 | 0.88 ±0.18, 2/3 |
| codex-5.6-terra | 1.00, 3/3 | 1.00, 3/3 | 1.00, 3/3 |
| pi-deepseek-flash | 1.00, 3/3 | 0.70 ±0.45, 2/3 | 0.76 ±0.36, 2/3 |
| opencode-deepseek-flash | 0.76 ±0.36, 2/3 | 0.19 ±0.14, 0/3 | 0.37 ±0.41, 1/3 |
| cost | $3.51 | $4.18 | $3.34 |

Runs: `run-202608202349-e6fbdb` (baseline), `run-202608202344-43c1e5`, `run-202608210002-17ff83` in `apps/evals/evals.db` (local file).

## What the transcripts show

Two lead failure modes appear on both v1 and v2:

1. The lead delegates, then ends its turn with "waiting on their completions" and no report. v1: claude #2. v2 @2ee5b719: claude #0, opencode #1. v1 always carried the `wait-for-task` hint in the prompt; v2 had moved it to the `swarm-scripts` skill, which the leads did not open. Commit c788dc07 adds one sentence to the lead block (wait for the children with `wait-for-task`, then merge and complete). In the c788dc07 run this mode did not appear (0/12).
2. The lead gathers the audit data itself (`get-tasks` with a status filter over the seeded tasks, `db-query`). The rubric zeroes or halves the delegation dimension (N1, N2). v1: opencode #2. v2: pi #2 (db-query x8), opencode #0, claude #2 @c788dc07 (db-query x3). c788dc07 adds "Data gathering, even a quick query, goes to a worker."

Correctness saturates at 1.0 whenever a report exists, on every harness and prompt version. Codex is 9/9 across all runs.

## Reading

At n=3 the cells are noisy (half-CI up to ±0.45). claude and codex are at parity or better on v2. pi and opencode (deepseek-v4-flash) lose some attempts on v2 to the self-research penalty and, for opencode, to duplicate dispatches (`send-task` x6 per run) and `get-tasks` scans. The v1 lead block named `send-task`, `get-tasks`, `get-task-details` with one-line descriptions; the v2 block names `get-swarm`, `manage-user`, `update-profile`, and the skills. A weak model may benefit from the explicit tool names. Candidate follow-up, not applied: one line in the lead block, "Delegate with `send-task`; read a child's result with `get-task-details`."

## Reproduce

```bash
# templates from a branch: build amd64 images on the remote buildx builder, push, then
bun run src/cli.tsx e2b build-template --role api --source image --template agent-swarm-api-prompt-v2 --image ghcr.io/desplega-ai/agent-swarm:prompt-v2-<sha>
bun run src/cli.tsx e2b build-template --role worker --source image --template agent-swarm-worker-prompt-v2 --image ghcr.io/desplega-ai/agent-swarm-worker:prompt-v2-<sha>-slim
cd apps/evals
EVALS_E2B_TEMPLATE_API=agent-swarm-api-prompt-v2 EVALS_E2B_TEMPLATE_WORKER=agent-swarm-worker-prompt-v2 \
EVALS_DB_PATH=$PWD/evals.db bun --env-file=../../.env src/cli.ts run --name <name> \
  --scenarios delegation-probe --configs claude-opus-4.8,codex-5.6-terra,pi-deepseek-flash,opencode-deepseek-flash \
  --attempts 3 --concurrency 12
```

The local-checkout template path (`e2b build-template` without `--source image`) is still broken: e2b CLI 2.10.2 rejects multi-stage Dockerfiles.
