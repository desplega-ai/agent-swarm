---
date: 2026-06-11T14:30:00Z
topic: "Handoff: evals/ sub-project (PR #737)"
status: handoff
branch: feat/evals-subproject
pr: 737
---

# Handoff: evals/ sub-project (PR #737)

**Date:** 2026-06-11 · **Branch:** `feat/evals-subproject` · **PR:** https://github.com/desplega-ai/agent-swarm/pull/737 (draft, all CI green) · **Status:** feature-complete for v1, verified E2E on real E2B runs.

## What exists

`evals/` is a self-contained Bun package (own `package.json`/`bun.lock`/tsconfig) that evaluates the swarm across a **scenario × harness-config matrix** on E2B. Full docs in `evals/README.md` — accurate and current.

Per attempt: boot API+worker sandboxes (`agent-swarm-{api,worker}-latest` public templates, via `src/e2b/dispatch.ts` imports) → optional `seed.exec` → create task(s) assigned to the worker agent → poll terminal → grade (deterministic checks + LLM judge + **agentic judge** = AI SDK tool-loop with run_command/read_file/api_get/submit_verdict in the live sandbox) → persist artifacts → kill sandboxes.

Key files:
- `evals/src/swarm/sandbox.ts` — bootStack, credentialsForConfig (never leak claude creds to pi/opencode), sweepRunSandboxes, collectHarnessSessionFiles (marker + `find -newer`)
- `evals/src/swarm/client.ts` — SwarmClient (task unwrap gotcha: flat response's `.task` is TEXT), getStableSessionLogs (logs lag ~5s), parseTranscriptEvents
- `evals/src/runner/index.ts` — executeRun (signal/cancel support, per-run stack registry, clearAttemptResults on re-run), best@n attempt rows keyed `(run,scenario,config,index)`
- `evals/src/judge/{llm,agentic,deterministic}.ts` — judge model precedence: scenario > run.judgeModel > EVAL_JUDGE_MODEL > gemini-3-flash-preview
- `evals/src/api/server.ts` — Bun.serve; POST /api/runs executes in-process (activeRuns map), resume/cancel endpoints, /api/attempts/:id/transcript, /api/scenarios
- `evals/ui/index.html` — single-file hash-routed SPA (runs/cells/scenarios pages, light/dark, transcript viewer, new-run dialog); a11y pass applied
- `evals/.env` — seeded from root .env (E2B_API_KEY, OPENROUTER_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY); gitignored
- DB: `evals/evals.db` (libsql; Turso via TURSO_DATABASE_URL). Local DB has 6 runs of real results.

CI: root `lint` = `biome check src evals`; merge-gate has evals install+tsc steps; lint filter includes `evals/`; root tsconfig excludes `evals`; `.dockerignore` has `evals/`.

## Verified results (real money, real sandboxes)

- 2 scenarios × {claude-haiku, pi-deepseek-flash, opencode-gemini-flash}: ran twice + best@2 + UI-triggered run. ~$0.15/matrix.
- pi-deepseek-flash 4/4 reliable; claude-haiku variance (one mid-task timeout); **opencode flakes ~50% on E2B**: `Spawn failed: Timeout waiting for server to start after 5000ms` (opencode-internal timeout, surfaced via runner.ts:4479 "Spawn failed") — worth filing/fixing in the opencode adapter.
- Claude OAuth (subscription) sessions produce no priced session-cost rows → claude cells show no cost.
- Agentic judge verified: probed sandbox with ls/cat/od/python repr before verdict (toolLog stored in judgment.raw).

## Open / next steps

1. **Merge path**: PR is draft; Taras reviews. Nothing known broken.
2. **Deployment** (deferred by Taras: "local first, then custom docker"): likely small Dockerfile (bun + evals/ + volume for evals.db) + env.
3. **Seeding v2**: memories / agentic-search seeding (only `seed.exec` exists).
4. **codex configs untested** (OPENAI_API_KEY validity unknown).
5. Possible refinements: filter harness-session capture to task.claudeSessionId; elapsed-time display freezes between poll payload changes (cosmetic, by design of rebuild guard).
6. Eval serve may still be running locally on :4801 (`kill $(lsof -ti :4801)`).

## Gotchas already encoded in memory

See memory `project-swarm-evals` + `evals/README.md` Notes. Biggest: task-create response unwrap, session-log lag before judging, judge must treat task records as authoritative, never pass CLAUDE_CODE_OAUTH_TOKEN to pi/opencode workers, POST /api/tasks without agentId routes to lead (always pass agentId).
