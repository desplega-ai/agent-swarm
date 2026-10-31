---
date: 2026-10-31T01:10:00Z
topic: "Black-box E2E: full coverage of API, MCP, workflow engine, script engine"
status: in-progress
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
4. The SUT boots with `CAPABILITIES` set to every known capability so every tool group
   registers. The tool universe is the union of lead and worker `tools/list`.
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
- [ ] Phase 4: full strict run green, lint, tsc, PR (in progress 2026-10-31 11:40 BCN)

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

## Follow-ups (not in this PR)

Runner / mock gaps the authors asked for, deferred because each needs a `src/` change or
changes behaviour an existing scenario already pins:

- `MCP_OAUTH_ALLOW_PRIVATE_HOSTS=true` in the SUT env would let a loopback stand-in play the
  MCP authorization server (discovery, DCR, token exchange, refresh 500). platform-mcp-servers
  currently pins the private-host refusal, so flip both together.
- A telemetry sink override (`TELEMETRY_ENDPOINT` in `src/telemetry.ts`) so
  `POST /api/telemetry/enable` 200 and relayed ui events can be asserted against a mock.
- A base-URL override for the Codex device login so start/poll outcomes can be asserted.
- A mockable host for `system-one-extraction` (typesafe and Cloudflare URLs are hard-coded,
  laya has no extract service): today only the node's config-validation failure path runs.
- `HEARTBEAT_INTERVAL_MS` of a few seconds in the SUT so workflow approval-card timeouts route
  inside a scenario instead of the 90 s sweep (check it does not reap simulated agents' tasks).
- `slack-helpers.claim()` polls once as the assignee; a pending lead task from an earlier
  scenario makes it time out. extensions now cancels its leftover task; keep that pattern.

Product findings the suite surfaced (asserted as observed with `// FINDING` comments):
see `/tmp/e2e-brief/findings-accumulated.md` while it exists, and the PR description.
