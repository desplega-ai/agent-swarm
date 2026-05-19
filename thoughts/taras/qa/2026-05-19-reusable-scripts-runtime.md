---
date: 2026-05-19
author: Codex
topic: "Reusable scripts runtime"
tags: [qa, reusable-scripts, scripts-runtime, workflow, mcp]
status: pass
source_plan: thoughts/taras/plans/2026-05-16-reusable-scripts-runtime.md
environment: local
last_updated: 2026-05-19
last_updated_by: Codex
---

# Reusable Scripts Runtime — QA Report

## Context

Validated the reusable scripts runtime v1 foundation from
`thoughts/taras/plans/2026-05-16-reusable-scripts-runtime.md`: script storage,
sandboxed runtime, HTTP API, MCP tool proxies, semantic search, and the
`swarm-script` workflow executor.

## Scope

### In Scope

- Script DB lifecycle, versioning, content deduplication, and cascade delete.
- Runtime execution, timeout/abort behavior, stdout cap, env stripping, secret
  egress scrubbing, import allowlist, and `workspace-rw` rejection.
- HTTP routes for upsert, search, run, delete, type query, lead-only global
  writes, scratch auto-save, and typecheck diagnostics.
- MCP `script_*` proxy tools and stdio listing smoke.
- Script embeddings and hybrid search ranking.
- `swarm-script` workflow execution, pinHash, input mapping, failure surfacing,
  and interleave with `agent-task`.
- Live local API smoke against `bun run start:http`.
- Docker lead-container E2E with real Claude worker image, task assignment,
  `script_run` tool invocation, scratch auto-save, and `store-progress`.
- OpenAPI and MCP docs regeneration idempotence.

### Out of Scope

- Real Claude Code worker session calling `script_search` from tool-call logs.
- Workflow UI palette/manual creation check.
- Manual semantic relevance tuning with five real-world scripts.
- Manual workflow UI palette/run check.

## Test Cases

### TC-1: Focused reusable-scripts feature suite

**Steps:**
1. Run:
   `bun test src/tests/scripts-db.test.ts src/tests/scripts-runtime.test.ts src/tests/scripts-runtime-secret-egress.test.ts src/tests/scripts-import-allowlist.test.ts src/tests/scripts-extract-signature.test.ts src/tests/scripts-http.test.ts src/tests/scripts-embeddings.test.ts src/tests/scripts-mcp-e2e.test.ts src/tests/workflow-swarm-script.test.ts src/tests/workflow-e2e.test.ts`

**Expected Result:** All focused storage, runtime, API, MCP, embedding, and workflow tests pass.
**Actual Result:** PASS — 57 tests passed, 0 failed, 191 assertions.
**Status:** pass

### TC-2: Live HTTP API smoke

**Steps:**
1. Run: `bash scripts/scripts-api-smoke.sh`

**Expected Result:** Script smoke starts/uses local API, registers an agent,
upserts `scripts-smoke-double`, searches it, runs it with `{ value: 21 }`,
observes result `42`, deletes it, and exits 0.
**Actual Result:** PASS — `scripts API smoke passed`.
**Status:** pass

### TC-3: TypeScript, lint, and boundary checks

**Steps:**
1. Run: `bun run tsc:check`
2. Run: `bun run lint`
3. Run: `bash scripts/check-db-boundary.sh`
4. Run: `bash scripts/check-api-key-boundary.sh`

**Expected Result:** Typecheck and boundary scripts pass; lint has no blocking errors.
**Actual Result:** PASS — typecheck clean; DB/API-key boundary checks passed.
`bun run lint` exited 0 with 21 warnings in unrelated pre-existing files
(`src/be/memory/raters/llm-client.ts`, `src/tests/internal-ai/*`,
`src/tests/pages-public-json-redirect.test.ts`, `src/tests/slack-watcher.test.ts`).
**Status:** pass

### TC-3b: Full CI-style unit suite

**Steps:**
1. Run: `bun install --frozen-lockfile`
2. Run: `bun test`

**Expected Result:** Lockfile install succeeds without changes and the full test
suite passes.
**Actual Result:** PASS — install reported no changes; full suite passed with
4,125 tests, 0 failures, 11,756 assertions across 269 files.
**Status:** pass

### TC-4: Generated docs freshness

**Steps:**
1. Run: `bun run docs:openapi`
2. Run: `bun run docs:mcp`
3. Run: `git status --short`

**Expected Result:** Generators succeed and leave no uncommitted drift.
**Actual Result:** PASS — OpenAPI regenerated 214 operations / 35 tag pages;
MCP docs parsed 101 tools; `git status --short` stayed clean.
**Status:** pass

### TC-5: MCP stdio tool listing smoke

**Steps:**
1. Run: `bun run scripts/scripts-mcp-stdio-smoke.ts`

**Expected Result:** Stdio MCP server lists all five script tools with expected
descriptions, while runtime invocation remains HTTP-MCP-only when agent identity
is required.
**Actual Result:** PASS — `PASS script MCP stdio smoke: found 5 script tools`.
**Status:** pass

### TC-6: Docker lead task executes `script_run`

**Steps:**
1. Start API on a temp DB:
   `PORT=3372 MCP_BASE_URL=http://localhost:3372 AGENT_SWARM_API_KEY=123123 API_KEY=123123 DATABASE_PATH=/tmp/agent-swarm-reusable-scripts-e2e.sqlite GITHUB_DISABLE=true SLACK_DISABLE=true JIRA_DISABLE=true LINEAR_DISABLE=true bun run start:http`
2. Build worker image: `bun run docker:build:worker`
3. Start lead container:
   `docker run --rm -d --name e2e-lead-reusable-scripts --env-file .env.docker-lead -e AGENT_ROLE=lead -e MAX_CONCURRENT_TASKS=1 -e MCP_BASE_URL=http://host.docker.internal:3372 -p 3211:3000 agent-swarm-worker:latest`
4. Start worker container:
   `docker run --rm -d --name e2e-worker-reusable-scripts --env-file .env.docker -e MAX_CONCURRENT_TASKS=1 -e MCP_BASE_URL=http://host.docker.internal:3372 -p 3213:3000 agent-swarm-worker:latest`
5. Create lead-assigned task `a5f95d6a-48f9-496a-9c6b-9198f849000e` asking the lead to call `mcp__agent-swarm__script_run` with an inline script that doubles `21`, then `store-progress` completed with `SCRIPT_RESULT_42`.
6. Poll task status from `/tmp/agent-swarm-reusable-scripts-e2e.sqlite`.

**Expected Result:** Lead container picks up the task, calls `script_run`, auto-saves a scratch script, and completes the task with output `SCRIPT_RESULT_42`.
**Actual Result:** PASS — task `a5f95d6a-48f9-496a-9c6b-9198f849000e` completed with output `SCRIPT_RESULT_42`; session logs contained `script_run`; scripts table contained scratch row `scratch-double-21-to-verify-script-run-expect-result-42-4515e067`.
**Status:** pass

### TC-7: Rich script fixture smoke

**Steps:**
1. Run:
   `PORT=3399 DATABASE_PATH=/tmp/agent-swarm-rich-smoke.sqlite AGENT_SWARM_API_KEY=scripts-rich-smoke-secret-1234567890 API_KEY=scripts-rich-smoke-secret-1234567890 GITHUB_DISABLE=true SLACK_DISABLE=true JIRA_DISABLE=true LINEAR_DISABLE=true HEARTBEAT_DISABLE=true bun run scripts/scripts-api-rich-smoke.ts`

**Expected Result:** Fixture runner starts a temp API, registers an agent,
upserts all `scripts/script-smoke-cases/*.ts` fixtures, runs each named script,
validates expected output, and cleans up scripts. Cases cover async
`ctx.stdlib.fetch`, `ctx.swarm.script_search`, `ctx.swarm.config` redaction,
stdout/stderr secret scrubbing, thrown-error scrubbing, nested `script_run`,
stringified args, unsupported SDK method clarity, fetch variants, serialization
edge cases, large output/result behavior, redacted wrapper abuse, import-bypass
probes, and temp FS isolation.
**Actual Result:** PASS — all 12 fixtures passed.
**Status:** pass

## Edge Cases & Exploratory Testing

- Runtime tests cover timeout kill, AbortSignal abort, stdout truncation, env
  stripping to the explicit allowlist, and `workspace-rw` rejection.
- Rich fixture smoke covers combined runtime behavior with real HTTP API
  execution: async fetch via `ctx.stdlib`, script SDK calls through
  `ctx.swarm`, and redaction on wrapped config values, unwrapped secrets,
  stdout, and thrown errors.
- Parallel edge-case workers expanded coverage for nested `ctx.swarm.script_run`,
  stringified args, every `ctx.swarm` allowlist method, result serialization
  (`undefined`, `null`, `Date`, `BigInt`, circular, `Map`, `Set`, classes),
  fetch JSON/text/retry/timeout/refused variants, large stdout/stderr/result,
  redacted wrapper abuse, temp FS isolation, import bypass probes, concurrent
  runs, and agent/global scope precedence.
- HTTP tests cover failed typecheck without row writes, unknown `ctx.swarm`
  tool rejection, lead-only global upsert, promotion audit events, scratch
  save-on-success only, and `workspace-rw` named scripts returning 501.
- Workflow tests cover historic `pinHash` resolution, predecessor input mapping,
  script-thrown errors surfacing as workflow node failures, and
  `swarm-script -> agent-task -> swarm-script` interleave.
- Embedding tests cover explicit upsert embeddings, scratch skip, re-embed
  triggers, backfill, hybrid ranking, semantic recall, and cascade delete.
- Docker E2E exposed two local-environment gotchas:
  - Starting the API without overriding `MCP_BASE_URL` let Bun auto-load the
    worktree `.env` ngrok URL, so `script_run` proxied to stale
    `localhost:3013` and failed with `ERR_NGROK_8012`. Restarting API with
    `MCP_BASE_URL=http://localhost:3372` fixed the MCP proxy path.
  - Restarting the API created an auto boot-triage task on the lead; cancelling
    that QA-only boot-triage task let the lead pick up the script E2E task.
- Agent-authored `script_run` calls are sensitive to whether the model passes
  `args` as a native JSON object or a JSON string. Direct HTTP with object args
  returned `{ result: 42 }`; one Claude task still passed `"args":"{\"value\": 21}"`
  and got `{ result: null, receivedType: "string" }`. The completed Docker E2E
  used a defensive inline script that accepts either shape.

## Evidence

### Logs & Output

```text
bun test ...scripts/workflow...
57 pass
0 fail
191 expect() calls
Ran 57 tests across 10 files. [3.20s]
```

```text
bash scripts/scripts-api-smoke.sh
scripts API smoke passed
```

```text
bun run tsc:check
$ bun tsc --noEmit
```

```text
bash scripts/check-db-boundary.sh
Worker/API DB boundary check passed.

bash scripts/check-api-key-boundary.sh
API_KEY boundary check passed.
```

```text
bun run docs:openapi
Generated openapi.json (327.6KB)
Generated API reference: 35 tag pages + index (214 operations, v1.80.0)

bun run docs:mcp
Parsed 101 tools
Generated .../MCP.md
```

```text
bun run scripts/scripts-mcp-stdio-smoke.ts
PASS script MCP stdio smoke: found 5 script tools
```

```text
Docker lead E2E:
task a5f95d6a-48f9-496a-9c6b-9198f849000e
status: completed
output: SCRIPT_RESULT_42
session logs: 19 rows, script_run present
scratch script: scratch-double-21-to-verify-script-run-expect-result-42-4515e067
```

```text
PORT=3399 ... bun run scripts/scripts-api-rich-smoke.ts
PASS scripts-smoke-ctx-fetch-redaction
PASS scripts-smoke-ctx-swarm-allowlist
PASS scripts-smoke-ctx-swarm-script-search
PASS scripts-smoke-fetch-variants
PASS scripts-smoke-import-bypass
PASS scripts-smoke-large-output
PASS scripts-smoke-nested-script-run
PASS scripts-smoke-redacted-abuse
PASS scripts-smoke-secret-failure-scrub
PASS scripts-smoke-serialization-edge-cases
PASS scripts-smoke-stringified-args
PASS scripts-smoke-temp-fs-isolation
scripts API rich smoke passed (12 cases)
```

```text
Concurrency/scope exploratory helper:
10/10 concurrent named script runs succeeded.
Default scope prefers caller agent script, falls back to global when no agent script exists.
Explicit agent scope is caller-local; explicit global scope resolves global.
Worker global upsert returns 403; lead global upsert succeeds.
```

## Issues Found

- [ ] Lint reports 21 warning-only diagnostics in unrelated pre-existing files
  while exiting 0 — severity: minor.
- [ ] `script_run` MCP UX can lead Claude to pass object-shaped `args` as a JSON
  string, even when instructed otherwise. Direct HTTP object args work; consider
  tightening the MCP schema/description or normalizing stringified JSON args in
  the tool/API path — severity: minor-to-major depending on expected agent usage.
- [ ] Full filesystem hardening remains incomplete for v1. Static import
  bypasses via `new Function(...)` and `eval(...)` are now rejected, but the
  Bun runtime global remains available inside the per-run tmpdir model. The
  current smoke documents that `Bun.file` can read the runtime source file;
  true filesystem isolation would require a stronger sandbox/chroot/container
  boundary — severity: major if untrusted third-party scripts are allowed.
  Follow-up ticket: DES-457
  (https://linear.app/desplega-labs/issue/DES-457/harden-reusable-scripts-runtime-filesystem-sandbox).
- [ ] Docker lead task progress/capacity can remain stuck after the task is
  terminal in the API when Claude Stop-hook/session-summary cleanup shells out
  to nested `claude -p` calls. In this run, task
  `8d35367e-d27c-4b75-9ad8-8d0095e0b6a3` completed at
  `2026-05-18T22:35:44.639Z`, but the runner kept logging
  `At capacity (1/1)` and the lead container accumulated hundreds of hook /
  Haiku subprocesses. Stopped `e2e-lead-reusable-scripts` and deleted stale
  `active_sessions` rows to restore API/UI idle state — severity: major for
  local Docker E2E/runner UX.
- [x] Rich fixture smoke initially exposed that `ctx.swarm.script_search` routed
  through a non-existent `/api/mcp/tools/:name/call` endpoint. Fixed
  `src/scripts-runtime/swarm-sdk.ts` so script SDK calls for `script_search`
  and `script_run` bridge directly to `/api/scripts/search` and
  `/api/scripts/run`.
- [x] `ctx.swarm` SDK allowlist smoke exposed that non-script methods all
  routed to the same non-existent `/api/mcp/tools/:name/call` endpoint. Updated
  the runtime to fail those methods with an explicit "declared but not available
  from the scripts HTTP bridge yet" error instead of a misleading 404.
- [x] Import-bypass smoke exposed that `new Function("return import('node:fs')")`
  could evade literal dynamic import detection. Added validator coverage for
  `Function` constructor and `eval` dynamic-code bypasses.

## Manual Follow-Up For Taras

1. In a real Claude Code session against a local swarm worker, call
   `script_search` from the MCP tool surface and confirm the tool-call logs show
   the agent can discover scripts.
2. Open the workflow UI on port 5274, confirm `swarm-script` appears as a node
   type, create a one-node workflow referencing a real script, run it, and
   eyeball the output.
3. Optionally upsert around five real-looking reusable scripts and run vague
   `script_search` queries to judge whether semantic ranking feels useful.

## PR Comment Draft

QA performed locally for reusable scripts runtime:

- `bun test src/tests/scripts-db.test.ts src/tests/scripts-runtime.test.ts src/tests/scripts-runtime-secret-egress.test.ts src/tests/scripts-import-allowlist.test.ts src/tests/scripts-extract-signature.test.ts src/tests/scripts-http.test.ts src/tests/scripts-embeddings.test.ts src/tests/scripts-mcp-e2e.test.ts src/tests/workflow-swarm-script.test.ts src/tests/workflow-e2e.test.ts` — 57 pass, 0 fail.
- `bash scripts/scripts-api-smoke.sh` — live local API smoke passed (`upsert -> search -> run -> delete`, result 42).
- `bun run tsc:check`, `bash scripts/check-db-boundary.sh`, `bash scripts/check-api-key-boundary.sh` — passed.
- `bun install --frozen-lockfile` — no changes.
- `bun test` — 4,125 pass, 0 fail, 11,756 assertions across 269 files.
- `bun run docs:openapi`, `bun run docs:mcp` — regenerated cleanly, no git drift.
- `bun run scripts/scripts-mcp-stdio-smoke.ts` — found all 5 `script_*` tools.
- Docker lead E2E — built `agent-swarm-worker:latest`, started lead/worker
  containers against API `http://localhost:3372`, and completed task
  `a5f95d6a-48f9-496a-9c6b-9198f849000e` with `SCRIPT_RESULT_42` after
  `script_run` auto-saved a scratch script.
- `bun run scripts/scripts-api-rich-smoke.ts` on a temp API with a real-length
  key — passed 12 fixture cases covering `ctx.stdlib.fetch`,
  `ctx.swarm.script_search`, nested `ctx.swarm.script_run`, stringified args,
  unsupported SDK method clarity, fetch variants, serialization edge cases,
  large output/result, config redaction, redacted wrapper abuse, stdout/stderr
  scrubbing, thrown-error scrubbing, import-bypass probes, and temp FS
  isolation.
- Parallel exploratory checks also verified 10/10 concurrent named script runs
  and agent/global scope precedence behavior.
- `bun run lint` exited 0 with 21 warning-only diagnostics in unrelated pre-existing files.
- During a follow-up UI/progress check, task
  `8d35367e-d27c-4b75-9ad8-8d0095e0b6a3` completed successfully but the lead
  runner stayed at capacity while Stop-hook/session-summary cleanup spawned
  hundreds of nested hook/Haiku subprocesses. Cleaned up the local E2E state by
  stopping `e2e-lead-reusable-scripts` and clearing stale active-session rows;
  API now reports both agents idle. This looks like a separate runner/hook
  cleanup issue, not a reusable-scripts runtime failure.

Manual follow-up suggested: workflow UI palette/run smoke and qualitative
semantic-search ranking with several real scripts. Note: Docker E2E and rich
smoke both confirmed JSON-string args are preserved as strings; agent-authored
MCP calls may need schema/normalization hardening if scripts should receive
objects consistently. Filesystem sandbox hardening follow-up filed as DES-457:
https://linear.app/desplega-labs/issue/DES-457/harden-reusable-scripts-runtime-filesystem-sandbox

## Verdict

**Status**: PASS
**Summary**: Reusable scripts runtime passed focused automated coverage, a live
local HTTP smoke, a richer fixture-based API smoke, and a Docker lead-container
E2E that completed via `script_run`. Remaining checks are manual workflow
UI/semantic-ranking confirmation plus a follow-up on MCP `args`
object-vs-string ergonomics.

## Appendix

- **Plan**: `thoughts/taras/plans/2026-05-16-reusable-scripts-runtime.md`
- **Smoke helper**: `scripts/scripts-api-smoke.sh`
- **Rich smoke helper**: `scripts/scripts-api-rich-smoke.ts`
- **MCP stdio smoke**: `scripts/scripts-mcp-stdio-smoke.ts`
