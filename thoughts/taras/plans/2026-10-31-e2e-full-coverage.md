---
date: 2026-10-31T01:10:00Z
topic: "Black-box E2E: full coverage of API, MCP, workflow engine, script engine"
status: done
branch: t3/267aec54
---

# Black-box E2E: full coverage of API, MCP, workflow engine, script engine

Goal set by Taras via /goal on 2026-10-31.

## Why

Taras wants to assure the swarm's reliability with only the API, the keys and the DB in hand,
as if the server were closed source. Then most unit tests can go, and the same suite doubles
as a performance benchmark base.

## Baseline (before this work)

| Surface | Covered | Total |
|---|---:|---:|
| Route operations (openapi.json) | 54 | 467 |
| MCP tools (tools/list) | 9 | 148 |
| Workflow node types | 1 (script) | 15 |
| Suite wall clock | 198 s | |

## Architecture decisions

1. Keep the `scripts/e2e` runner. Extend it, do not fork it. The black-box boundary
   (`scripts/check-e2e-boundary.sh`) stays: scenarios use HTTP, MCP, Bun, node builtins and
   the read-only `ctx.db` handle only.
2. External inference is mocked at the HTTP edge, not inside the server:
   - `scripts/e2e/mocks/llm.ts` serves an OpenAI-compatible API (`/chat/completions`,
     `/embeddings`, `/models`, `/key`) plus a SystemOne `/v1/systemone` host. The SUT reaches
     it through `OPENROUTER_BASE_URL` + `OPENROUTER_API_KEY`, `EMBEDDING_API_BASE_URL` +
     `EMBEDDING_API_KEY`, and the `LAYA_URL` + `LAYA_API_KEY` global config rows.
   - Slack stays on `@desplega.ai/slack-mock`.
   - GitHub, Linear, Jira, AgentMail stay disabled. Their routes are covered on the
     "disabled" or "bad signature" contract and the reason is recorded in the manifest.
3. Agents are simulated over the API (`scripts/e2e/agent-sim.ts`): register, poll
   `/api/poll`, act on triggers, finish over HTTP or MCP. No harness process, no LLM.
4. The SUT boots with every `CAPABILITIES` group and `CHAT_SDK_ENABLED=true`.
   The initial worker `tools/list` probe includes all six Chat SDK tools.
5. Coverage is a hard gate, not a percentage:
   - `scripts/e2e/coverage-manifest.json` lists every deliberate exclusion with a reason.
   - `--strict` (CI) fails when any route operation, MCP tool, or workflow node type is
     neither covered nor excluded. It also fails when an excluded item IS covered (stale
     exclusion) or when a manifest entry no longer exists (dead exclusion).
   - `flows` in the manifest name scenarios that must exist and pass. That is the
     deterministic "all flows checked" contract for the script and workflow engines.
6. Every HTTP call records its latency. The result JSON carries p50/p95/max per route group,
   so a benchmark can diff two result files without new tooling.

## Phases

- [x] Phase 0: inventory + baseline
- [x] Phase 1: infra (mock LLM, agent-sim, strict coverage, latency, manifest, CI flag) — commit 6fd79d125
- [x] Phase 2: scenarios, six domains, 91 scenarios, commits 998c605dc..cf647701e (authors: Sonnet 5.5, resumed after the weekly limit reset at 08:00 BCN)
- [x] Phase 3: docs (scripts/e2e/README.md, runbooks/e2e-blackbox.md, LOCAL_TESTING.md,
  runbooks/testing.md, runbooks/ci.md, CLAUDE.md pointer) — commit d859b19db
- [x] Phase 4: full strict run green (91 pass, 467/467, 164/164, 15/15, 49 flows, 250 s), lint + tsc clean, PR #2605 opened 2026-10-31 12:10 BCN

## Scenario domains (Phase 2)

| Domain | Route groups | MCP tools | Order band |
|---|---|---|---|
| core-tasks | agents, tasks, poll, heartbeat, sessions*, active-sessions, steering-messages, paused-tasks, task-templates, favorites, session-costs/logs/tree/triage/moves, status, stats, metrics, ranking, events, used-by, fleet-benchmark, budgets, channel-activity, inbox-state, concurrent-context, attribution, logs | core, task-pool, metrics, profiles, messaging | 200-299 |
| workflows | workflows, workflow-runs, workflow-events, executor-types, approval-requests, schedules, scheduled-tasks | workflows, scheduling | 300-399 |
| scripts | scripts, script-runs, script-connections, internal, kv, db-query | scripts, kv | 400-499 |
| knowledge | memory, skills, prompt-templates, pages, p, share, site, assets, apps, rooms, realtime, comb | memory, skills, pages, apps, rooms | 500-599 |
| platform | users, invites, keys, rbac, whoami, oauth*, mcp-oauth, mcp-servers, mcp-bridge, codex-oauth, config, onboarding, telemetry, integrations*, connector, webhooks, repos, trackers, model-profiles, models-catalog, pricing, extensions, runtime-*, controllers, credential-bindings, fs, agentfs, @swarm, x, close, ping | config, mcp, repo, tracker, slack, swarm-x, agentmail, kapso, chat-sdk | 600-699 |

Orders 10-180 belong to the pre-existing scenarios.

## Verification

```bash
bun run e2e:tsc
bash scripts/check-e2e-boundary.sh
bun run e2e --strict --json /tmp/e2e-full.json --summary-md /tmp/e2e-full.md
bun run e2e --only <scenario>            # one scenario while authoring
bun run lint && bun run lint:slop
```

## Manual E2E

```bash
bun run e2e --strict --keep              # inspect KEEP db/log paths on failure
bun run e2e --list | wc -l               # scenario count
bun scripts/e2e/bench.ts /tmp/e2e-a.json /tmp/e2e-b.json   # latency diff
```

## Second pass (same PR): fix the findings instead of pinning them

34 findings came back from the authors. Each got one decision (/tmp/e2e-fix/<domain>.md while
it existed), six Sonnet fixers implemented them in parallel with file fences, six Sonnet
reviewers checked standards and spec, zero blockers. Outcome:

- Fixed in the product and the scenario now asserts the documented contract: profile PUT 404,
  supersede status recompute, create-channel await, unread_mentions count, nodes PATCH 404,
  approval `required` default + optional-answer validation, schedules 400, run retry 404,
  prompt-template checkout 404, page foreign-cookie 403, defaulted args optional, script_runs
  startedAt ISO, users duplicate 409, recentEvents=0, identities + mcp-server duplicate 409
  with clean text, agentmail inbox ownership guard, model shortname harness check, tracker
  unlink unknown id.
- Documented instead of changed (behaviour kept on purpose): repo hooks default on, models
  catalog provider list, steps journal write-once, mcp-oauth metadata 502, mcp-oauth DELETE
  idempotent, config scopeId without existence check, config write restarts Slack, Jira 503
  before 400.
- Mock gaps closed: Cloudflare extraction uses a loopback Workers AI mock through
  the test-only `CLOUDFLARE_API_BASE_URL`. Taras requested removal of the new Laya
  extraction support during PR review. `MCP_OAUTH_ALLOW_PRIVATE_HOSTS=true` in the SUT
  with a loopback authorization server in platform-mcp; `CODEX_OAUTH_DEVICE_BASE_URL` for the
  Codex device login; skills sync-filesystem 200 path now safe under the per-run HOME.

## Third pass (same PR): close the deferred items

- `DESPLEGA_TELEMETRY_ENDPOINT` overrides the telemetry sink; the mock journals
  `/telemetry/v1/events`, and `platform-telemetry` asserts `POST /api/telemetry/enable` 200 and
  the relayed event payload end to end.
- Approval timeouts route deterministically: `workflow-approvals` drives the existing
  `POST /api/heartbeat/sweep` and asserts the run leaves on its `timeout` port. No change to
  `HEARTBEAT_INTERVAL_MS`.
- `src/be/scripts/boot-args-schema.ts` normalizes stored schema JSON without executing source.
  It removes defaulted fields from `required` and preserves versions and timestamps.
  A second boot performs no writes.
- CI: the E2E Contract job benchmarks each PR against main's last green run
  (`bun run e2e:bench`) in the job summary. The runbook explains how to read it and how to retire
  unit tests the suite already proves.
- Local unit failures verified as environment: under the pinned Bun 1.4.4 (via `bunx bun@1.4.4`)
  the doubled-`changes` tests pass; only `codex-gateway-route` still fails locally, and it fails
  on clean main too.

## Fourth pass (same PR): engine state surfaces and flow completeness

- `coverage-manifest.json` gained `stateSurfaces`: nine read-only SELECTs over the SUT database
  (task statuses, workflow run and step statuses, script run statuses, script step types,
  scopes, fs modes, executors) with a declared universe and reasoned exclusions for transient
  states. Strict fails on a declared value never produced and on a database value outside the
  universe. Scenarios now park one row in each reachable terminal-ish state (offered, paused,
  backlog tasks; a waiting workflow run; aborted_limit and paused script runs).
- Every scenario must belong to a flow. The manifest pins 68 flows covering all 93 scenarios.

## Fifth pass (same PR): per-engine roll-ups, retirement report, hermetic codex test

- `engines` in the manifest roll route groups, tool patterns, node types and state surfaces into
  one figure per engine (script, workflow, task); strict requires 100% for each.
- `bun scripts/e2e/unit-overlap.ts` lists wire-level unit tests with a candidate/review/keep
  verdict; the runbook points at it. Deleting tests stays a per-domain decision for Taras.
- `codex-gateway-route.test.ts` isolates HOME: the local failure was the developer's real
  `~/.codex/auth.json` making OAuth win over `OPENAI_API_KEY` inside the test.

## Security scan findings (Superagent, same PR)

- P1: `CODEX_OAUTH_DEVICE_BASE_URL` was config-writable and unvalidated. Now an env-only reserved
  key (with `DESPLEGA_TELEMETRY_ENDPOINT`), loopback-only; the runner fixes the stub port at
  boot and exposes it as `ctx.sutEnv`.
- P2: the benchmark step ran PR code with `GH_TOKEN`. Now a token-only download step and a
  token-free bench step; the artifact is size-capped and shape-checked before use.
- Also hardened: the args-schema extractor runs under `buildSandboxedCommand`.

## Follow-ups (not in this PR)

- Retire the first batch of redundant unit tests (list in runbooks/e2e-blackbox.md), one domain
  per PR, after the strict suite has been green on main.
