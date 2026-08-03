---
date: 2026-07-30T00:00:00+02:00
author: Taras
topic: "Harness-agnostic E2E / API tests for the swarm in CI"
tags: [brainstorm, e2e, ci, api-tests, black-box]
status: parked
exploration_type: idea
last_updated: 2026-07-30
last_updated_by: Taras
---

# Harness-agnostic E2E / API tests for the swarm in CI — Brainstorm

## Context

Taras wants some form of E2E testing for agent-swarm that runs in CI and verifies the system "works normally" for a set of core cases — framed as API tests.

The defining constraint: **the tests should be black-box enough to survive a full rewrite of the system (e.g. in Rust)**. That means they should exercise the system through its stable public contracts (HTTP API, MCP surface, observable side effects), not through internal modules, `bun test` unit seams, or implementation details.

What exists today (for contrast):
- Unit/integration tests via `bun test` (tied to the TS implementation)
- `swarm-local-e2e` skill — manual/local E2E recipe with API server + Docker lead/worker containers
- Merge gate CI: lint, tsc, unit tests, boundary scripts, Docker builds, OpenAPI freshness — but no true E2E of the running system
- `apps/evals` — E2B-based eval harness (costly, judge-based, not a CI gate)
- An `openapi.json` spec generated from the route registry

## Exploration

### Q: What kind of exploration is this?
Idea to develop — shape the black-box E2E suite: what it covers, how it runs in CI, what contracts it pins.

### Q: Is the "survive a Rust rewrite" framing a real rewrite plan or just a design constraint?
Forcing function only. No rewrite planned — the Rust framing is a discipline device to keep tests decoupled from TS internals. The deliverable is a pure black-box regression gate for PRs.

**Insights:** This lowers the bar helpfully: we don't need exhaustive contract coverage or an executable spec. We need a suite that catches "the system stopped working normally" regressions, talking only over public surfaces (HTTP API / MCP). Implementation language of the *tests* is free to be anything convenient, as long as they only touch the API.

### Q: Does the CI suite exercise real LLM-backed agents, or stop at a scripted fake worker?
Real agents with a cheap model — **and for each harness**. Tasks should be trivial and deterministic-ish: e.g. `ping`, "run script X and return the outcome". On top of that, separate **API tests and MCP tests** (those are easy to do).

**Insights:** The suite has (at least) two layers:
1. **Contract layer** — black-box HTTP API tests + MCP tool tests against a running server. Cheap, deterministic, no LLM.
2. **Harness matrix layer** — real Docker workers, one per harness, given trivial tasks whose outcomes are objectively checkable (task reaches `completed`, output contains expected marker). Cheap model (per prior decision: `openrouter/deepseek/deepseek-v4-flash` for pi/opencode-style harnesses).

Trivial tasks are the key trick: they make real-LLM runs near-deterministic (any functioning model can "reply pong" or "run this script"), so the flake surface is mostly infra (boot, poll, claim, report), which is exactly what we want to test.

### Q: Which harnesses does the CI matrix cover?
**claude, codex, pi/opencode.** Excluded: gemini (not worth a key/flake for now), devin and claude-managed (external cloud infra, not sandboxable in CI).

**Insights:** All three run in the existing Docker worker image (slim target exists for CI/E2E). Requires CI secrets: Anthropic key, OpenAI key, OpenRouter key. pi/opencode is the cheapest leg (deepseek-v4-flash).

### Q: Where in CI does each layer run — do both gate PRs?
**Contract layer on every PR (joins the merge gate); harness matrix nightly + manual dispatch.**

**Insights:** This split matches the layers' profiles: the contract layer is fast, deterministic, and secret-free (safe for fork PRs), so it can block merges. The harness matrix needs three provider API keys and tolerates occasional infra flake, so it runs on a schedule against main — regressions in harness plumbing are caught within a day instead of blocking PRs. Nightly failures should page/notify (Slack) rather than silently accumulate.

### Q: How is the system-under-test stood up in CI?
**Workers from the `worker-slim` Docker images; the API/MCP server can run "plain" (bare `bun run start:http` on the runner) rather than containerized.** Also: document exactly which things need mocking / which envs are needed so it "just works".

**Insights:** Env inventory for a minimal, integration-free CI boot (from `.env.example` + local-development runbook):

*API server (plain boot):*
- `API_KEY` — default `123123` is fine for CI; tests read it as `AGENT_SWARM_API_KEY`.
- `MCP_BASE_URL` — must be reachable from inside worker containers (`http://host.docker.internal:3013` or run compose network with the API on the host network).
- Kill switches so nothing external is touched: `SLACK_DISABLE=true`, `GITHUB_DISABLE=true`, `LINEAR_DISABLE=true`, `JIRA_DISABLE=true`, `AGENTMAIL_DISABLE=true`, `ANONYMIZED_TELEMETRY=false`.
- Gracefully-degrading externals need **no mock** — they no-op when unset: `BUSINESS_USE_API_KEY` (BU SDK no-ops), `OPENAI_API_KEY` on the API side (memory search degrades to recency), `OPENROUTER_API_KEY` (memory rater / session-summary indexing no-op), Sentry.
- `SECRETS_ENCRYPTION_KEY` — not needed; fresh DB auto-generates a key file.
- Fresh SQLite per run (`rm` the DB); migrations auto-apply on boot — no seed step needed.
- If contract tests register localhost script-connections: SSRF guard fails closed unless `NODE_ENV=development|test` or `ALLOW_PRIVATE_NETWORK_URLS=true` (`start:http` already sets `NODE_ENV=development`).

*Workers (`worker-slim` containers), per matrix leg:*
- `HARNESS_PROVIDER=claude|codex|pi` + the leg's real key: Anthropic (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`), OpenAI key for codex, `OPENROUTER_API_KEY` for pi (deepseek-v4-flash).
- `AGENT_ID` — **must be a valid UUID** (slug IDs break MCP output schemas — known gotcha).
- `MCP_BASE_URL`, `API_KEY`, `MODEL_OVERRIDE` (cheap model per leg), `MAX_CONCURRENT_TASKS=1`.
- `CONTEXT_MODE_DISABLED=true` probably, for determinism and fewer moving parts.

Net: **nothing needs an actual mock** — integrations all have kill switches or no-op-when-unset behavior. The only real external dependencies are the three LLM provider APIs in the nightly matrix layer.

### Q: What are the tests written in?
**A small standalone app with custom functions — explicitly NOT `bun test`.**

**Insights:** A purpose-built scenario runner (its own entry point, e.g. `apps/e2e/` or `e2e/`) rather than a unit-test framework. This fits the black-box framing: the runner is a client application that happens to assert, with custom helpers for the things unit frameworks are bad at — poll-until-status-with-timeout, MCP client sessions, spinning up/tearing down worker containers, structured pass/fail reporting, exit-code-driven CI. No `bun test` semantics (mock.module leak gotchas, test-runner coupling) and no temptation to import `src/` seams. Implementation language can still be TS/Bun for convenience — the discipline is that it only ever speaks HTTP/MCP to the SUT.

### Q: What does the PR-gating contract layer cover in v1?
**Task lifecycle + pool, MCP tool surface, workflows + schedules, auth. Roles (RBAC) at some point later. Also: read-queries over pre-seeded data. Everything must be deterministic.** Taras asked for more proposals (see next Q).

**Insights:**
- The heart is a **simulated agent**: the runner registers an agent over HTTP, polls, claims, reports progress, completes — no LLM anywhere. This exercises the exact claim/report path real workers use.
- MCP layer connects a real MCP client to `/mcp` and asserts `SwarmToolResult` shape + both-channel consistency (this pins the contract PR #1023 just established).
- Workflows: small DAG with `script` nodes only (no agent nodes) → fully deterministic node execution + cross-node data flow.
- "Queries over existing data": seed a known dataset via the API itself (tasks, progress, memories), then assert list/filter/detail endpoints return exactly the expected rows. Determinism rule: all seed data created through the public API in the same run — no DB fixtures (that would break the black-box constraint).

### Q: Should the suite push outcome data somewhere, like the Docker image sizes do?
**Yes — push info / store outcome data, following the existing docker-image-sizes pattern.**

**Insights:** CI already has a ci-metrics pipeline: merge-gate POSTs image sizes to a swarm script endpoint (`/api/x/script/...` on the prod swarm, `SWARM_CI_METRICS_TOKEN`), which merges same-sha metrics into one sticky PR comment + step summary. The E2E suite should emit through the same channel. Candidate metrics:
- Contract layer (per PR): suite wall-clock, scenario count, pass/fail, per-scenario duration (catches perf regressions in claim/poll paths).
- Harness matrix (nightly): per-harness wall-clock to task completion, tokens/cost (the API's own cost tracking gives this for free — nice dogfooding), success/failure per leg, trend over time.
This also means the custom runner needs structured JSON output as a first-class feature — another reason `bun test` was the wrong shape.

### Q: Which of the proposed extra surfaces make v1?
**Scripts runtime, and config + secret scrubbing.** Deferred: steering queue, memory CRUD/search (both deterministic and good v2 candidates; steering pins a brand-new surface, memory's recency fallback is assertable).

**Insights:**
- Scripts runtime: `script_upsert` typecheck accept/reject + `script_run` of a deterministic script, asserting sandbox limits/timeouts purely over the API — covers the highest-risk surface without touching internals.
- Config: PUT `/api/config` global rows + precedence semantics (env wins at boot, stored wins after reload).
- Secret scrubbing as a black-box property: store a secret via the API, then assert no API response / session-log endpoint ever returns the raw value. This is a genuinely contract-level security invariant — survives any rewrite.

### Q: What does each nightly matrix leg assert, and what's the flake policy?
**Marker task + one automatic retry; on double failure, report to a swarm script API endpoint (same pattern as the docker-image-sizes ci-metrics script) — the script decides about notifications, not the CI job.**

**Insights:** Each leg: worker boots from `worker-slim`, claims a trivial "reply with marker X / run script Y" task, and the assertion is objective — task reaches `completed` with the marker in output within a timeout. Routing failure handling through a swarm script keeps CI dumb (POST results, done) and centralizes alerting policy server-side where it can evolve without touching workflows. It also means success AND failure both push structured results — the metrics story and the alerting story are the same endpoint. Nice property: the swarm monitors itself.

### Q: Explicit non-goals?
**Confirmed, all five:** (a) not a model/harness *quality* eval — that's `apps/evals`; (b) no UI testing — Taras manual-QAs the SPA; (c) no load/perf benchmarking beyond recording durations as metrics; (d) devin / claude-managed / gemini stay out of the matrix; (e) the existing `bun test` suite stays untouched — this suite is additive.

## Synthesis

### Key Decisions
- **Two-layer suite:** (1) deterministic black-box **contract layer** (HTTP + MCP, no LLM) gating every PR in the merge gate; (2) **harness matrix layer** (real claude/codex/pi workers, cheap models, trivial marker tasks) running nightly + manual dispatch.
- **Black-box discipline:** tests only speak HTTP/MCP to the SUT — zero imports from `src/`, no DB fixtures; all seed data created through the public API. The "survive a Rust rewrite" framing is a design constraint, not a rewrite plan.
- **SUT topology:** API server runs plain (`bun run start:http`, fresh SQLite, migrations auto-apply); workers run from the `worker-slim` Docker images. Nothing needs mocking — integrations have kill switches (`SLACK_DISABLE` etc.) or no-op when unset (BU, embeddings, rater, Sentry).
- **Runner:** a small standalone app with custom functions (poll-until, MCP client, container orchestration, structured JSON results) — explicitly **not** `bun test`.
- **Contract scope v1:** task lifecycle + pool via a simulated HTTP agent; MCP tool surface (`SwarmToolResult` shape + both-channel consistency); workflows + schedules (script-node DAGs); auth; deterministic read-queries over API-seeded data; scripts runtime (upsert typecheck + run + sandbox/timeout); config precedence; secret scrubbing as a black-box never-leaks invariant. RBAC/roles later.
- **Outcomes as data:** suite pushes structured results/metrics to a swarm script API endpoint (same ci-metrics pattern as Docker image sizes — sticky PR comment, trends). The script owns alerting policy for nightly failures; CI just POSTs.
- **Flake policy:** one automatic retry per matrix leg; double failure reported to the script endpoint.

### Resolved Open Questions
- **Placement:** `apps/e2e/` as a new Bun workspace member (workspaces are `apps/*` + `packages/*`). Black-box rule enforced by a boundary check script (same family as `check-db-boundary.sh`) forbidding imports from `src/` and other workspace members.
- **Leg models:** decided at plan time; rule = *cheapest working tier per harness*. pi stays `openrouter/deepseek/deepseek-v4-flash`. CI secrets needed: Anthropic, OpenAI, OpenRouter keys (`SWARM_CI_METRICS_TOKEN` pattern already exists for the results token).
- **Schedules determinism:** no waiting on cron — schedules have a manual trigger-run endpoint (`src/http/schedules.ts`, "Schedule run triggered"), and workflows have `POST /api/workflows/{id}/trigger`. Both layers testable synchronously.
- **Worker→host networking in GH Actions:** Linux runners, so `--add-host=host.docker.internal:host-gateway` on the worker containers (or `--network host`) reaches the plain-boot API on `localhost:3013`. Verify choice at plan time; no real spike needed.
- **Results sink:** a **new dedicated swarm script** endpoint. v1 just defines/stubs the payload data type, assuming the same auth + method as ci-metrics (Bearer token, `POST /api/x/script/<id>`); Taras fills the env values (token + script id) later. Alerting logic lives server-side in that script.
- **Heartbeat/stall-recovery path:** deferred to v2 (v1 = happy paths only).

### Open Questions (plan-time details)
- Exact cheap model IDs for the claude/codex legs.
- Results payload schema (scenarios, durations, legs, pass/fail) — stub in v1.

### Constraints Identified
- Tests must survive a full system rewrite → public contracts only (HTTP API, MCP, observable side effects).
- PR gate must stay fast and secret-free (fork-safe) → LLM legs can't gate PRs.
- Agent IDs must be valid UUIDs (slug IDs break MCP output validation).
- SSRF guard fails closed on localhost connections unless `NODE_ENV=development|test`.
- Nightly matrix needs three provider keys as CI secrets; cost bounded by trivial tasks + cheap models.

### Core Requirements
1. Contract-layer job in `merge-gate.yml`: boot plain API (fresh DB, integrations disabled), run the scenario app, exit-code gates the PR.
2. Simulated-agent scenarios covering register → poll → claim → progress → complete, plus MCP, workflows/schedules, auth, scripts runtime, config, secret scrubbing, seeded read-queries — all deterministic.
3. Nightly workflow: build/pull `worker-slim`, run three harness legs (claude/codex/pi) with marker tasks, 1 retry, timeout-bounded.
4. Structured JSON results from the runner; POST to a swarm script endpoint for PR comments, trend storage, and nightly alerting.
5. A boundary/enforcement mechanism keeping the suite import-free from `src/`.

## Next Steps

- **Parked** (2026-07-30). When picking this up: go straight to `/desplega:create-plan` with this doc as input — open questions are resolved, only plan-time details remain (exact leg model IDs, results payload schema stub).
