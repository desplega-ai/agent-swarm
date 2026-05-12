---
date: 2026-05-06T00:00:00Z
planner: Claude
branch: main
repository: agent-swarm
topic: "Worker Credential Safe-Loop (TS-level wait, no entrypoint crash)"
tags: [plan, worker, harness, credentials, docker-entrypoint, providers]
status: completed
autonomy: critical
last_updated: 2026-05-06
last_updated_by: Claude (orchestrator)
---

# Worker Credential Safe-Loop Implementation Plan

## Overview

Replace the bash-level fail-fast credential validation in `docker-entrypoint.sh` with a TS-level wait loop in the worker. The container should always start, the worker process should register with the API, and only **session spawning** should block when harness credentials are missing — refreshing from `swarm_config` with exponential backoff (capped at 30s) until creds appear.

- **Motivation**: Today, missing harness credentials cause `exit 1` in the entrypoint (e.g. docker-entrypoint.sh:152), looping the container under `restart: unless-stopped`. Setting credentials via `swarm_config` after the fact requires a full container restart, and the worker is invisible from the dashboard while crashing. Workers should self-heal once creds become available — `fetchResolvedEnv` at runner.ts:1634 already refreshes per task, but the entrypoint kills the process before that code ever runs.
- **Related**:
  - `docker-entrypoint.sh` (lines 1–161 — the validation block to gut)
  - `src/commands/runner.ts:208` (`fetchResolvedEnv` — already does the swarm_config refresh)
  - `src/providers/{claude,claude-managed,codex,pi-mono,opencode,devin}-adapter.ts` (need new `checkCredentials` export)
  - `src/be/swarm-config-guard.ts` (RESERVED_KEYS = `API_KEY`, `SECRETS_ENCRYPTION_KEY`)
  - `src/http/config.ts:55` (`POST /api/config/reload` — exists but no worker subscriber today)

## Current State Analysis

### Bash-level validation (the source of crash loops)

`docker-entrypoint.sh` runs **before** the worker process starts. It performs per-provider validation and exits hard on missing creds:

| Provider | Lines | Failure mode |
|---|---|---|
| `claude` (default) | 152–155 | OR-check: needs `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` |
| `claude-managed` | 53–65 | AND-check: needs all of `ANTHROPIC_API_KEY`, `MANAGED_AGENT_ID`, `MANAGED_ENVIRONMENT_ID`, `MCP_BASE_URL`. Lines 33–51 already pre-fetch from `swarm_config` (non-fatal). |
| `pi` | 9–12 | OR-check: `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `~/.pi/agent/auth.json`. **Adapter is model-conditional** (pi-mono-adapter.ts:69-109 maps `MODEL_OVERRIDE` → provider). |
| `opencode` | 13–19 | OR-check: `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `~/.local/share/opencode/auth.json`. Same model-conditional concern. |
| `devin` | 66–75 | AND-check: `DEVIN_API_KEY`, `DEVIN_ORG_ID`. |
| `codex` | 144–148 | 3-way OR with side effects: existing `~/.codex/auth.json`, `codex_oauth` in swarm_config (restored to disk lines 92–130), or `OPENAI_API_KEY` (triggers `codex login --with-api-key` lines 134–142). |

After the per-provider block, line 158–161 also exits if `API_KEY` is missing — this is the only *truly required* env for a worker to talk to the API.

### What exists that we can reuse

- **`fetchResolvedEnv()`** at `src/commands/runner.ts:208` — already issues `GET /api/config/resolved?agentId=...&includeSecrets=true` and merges into a fresh env object. Called from `runner.ts:1634` per task spawn and `runner.ts:2060` on reload. We extend usage but don't reinvent.
- **`/api/config/resolved`** at `src/http/config.ts:21` — agent-scoped resolution, decrypts `isSecret` rows.
- **`POST /api/config/reload`** at `src/http/config.ts:55` — server-side env refresh + integration re-init. No worker subscriber today; workers refetch on their own.
- **Reserved-key guard** at `src/be/swarm-config-guard.ts` — blocks `API_KEY` / `SECRETS_ENCRYPTION_KEY` from being stored in `swarm_config`.
- **Codex / claude-managed pre-fetch blocks** in entrypoint — already non-fatal in spirit (they do `2>/dev/null || true`), but the surrounding `set -e` and post-restore validation `exit 1`s make them effectively mandatory today.

### What's missing

- No per-adapter `checkCredentials()` predicate. Provider-specific cred logic is duplicated in bash and implicit in adapter code.
- No "agent is waiting for creds" status surface. The `agents` table has a `status` column but nothing represents this case (need to confirm shape during Phase 3).
- No readiness gate in the runner's task-claim loop — workers will poll/claim even when they can't run.
- Healthcheck (`/health`) returns 200 unconditionally as long as the process is up — fine for liveness, but doesn't distinguish "ready to claim work" from "just booted but idle waiting".

## Desired End State

A worker starts even with zero harness credentials configured. It:

1. Boots, registers (`join-swarm`), and reports `status = waiting_for_credentials` with a list of which env vars (or files) it's waiting on.
2. Loops on `fetchResolvedEnv()` + `checkCredentials()` with exponential backoff (2s → 30s, cap 30s).
3. While blocked, **does not claim tasks** — the lead/dispatcher routes around it via `agentWithCapacity`.
4. The dashboard surfaces the blocked state via a `GET /api/agents/{id}/credential-status` endpoint.
5. Once creds appear (set via `PUT /api/config` → next polling tick picks them up), the worker transitions to `ready` and begins polling tasks.
6. `/health` keeps returning 200 (liveness intact). New `/ready` endpoint returns 503 when blocked (readiness for orchestrators that want strict gating).

Verification: start a fresh compose stack with no harness creds, observe worker registers and shows "waiting" in dashboard. `PUT /api/config` to set the cred. Within ≤30s, worker transitions to ready and starts polling tasks — no container restart required.

## What We're NOT Doing

- **Not** removing the entrypoint side-effect file prep (codex login, codex_oauth → auth.json, claude-managed restore). Those become *non-fatal best-effort* but stay in bash because they need root → worker user privilege drop via `gosu`. Re-running them is idempotent; the TS loop kicks them off again on the next tick if creds appear later.
- **Not** moving `API_KEY`, `SECRETS_ENCRYPTION_KEY`, `AGENT_ID`, or `MCP_BASE_URL` to swarm_config. These are bootstrap-required.
- **Not** implementing SSE / WebSocket push from `/api/config/reload` to workers — polling is sufficient for v1. Follow-up plan if needed.
- **Not** auto-detecting model-provider mappings for pi/opencode beyond what the adapter already does. The new predicate inspects `MODEL_OVERRIDE` and reuses the adapter's resolution logic.
- **Not** changing `API_KEY` validation — entrypoint still hard-exits if missing (it's a bootstrap requirement, no recovery path).

## Implementation Approach

- **Per-adapter `checkCredentials(env): CredStatus`** — co-located with each adapter so the predicate evolves alongside the consumer. Returns `{ ready, missing[], hint, satisfiedBy: 'env' | 'file' | 'side-effect' }`.
- **Single boot loop in the worker process** — calls `checkCredentials` → if blocked, calls `fetchResolvedEnv` → re-checks → backs off. Lives in a new `src/commands/credential-wait.ts` module, called from the worker startup path before the task-claim loop begins.
- **Status flag on agents** — extend the `agents` table with a `credentialStatus` column (`ready | waiting | error`) and have `agentWithCapacity` filter on it. Heartbeat / status-report API already exists; piggyback there.
- **Readiness endpoint split** — keep `/health` as liveness (always 200 if up); add `/ready` for orchestrators that need stricter gating. Worker side: extend its own status server to include the same readiness state.
- **Bash entrypoint becomes best-effort** — convert all `exit 1` blocks except `API_KEY` to warnings; keep side-effect blocks but don't fail when they no-op due to missing inputs.

## Quick Verification Reference

- `bun run lint` — Biome check
- `bun run tsc:check` — type check
- `bun test src/tests/credential-check.test.ts` — Phase 1 predicate tests
- `bun test src/tests/credential-wait.test.ts` — Phase 2 loop tests
- `bun test src/tests/credential-status-routing.test.ts` — Phase 3 dispatcher routing tests
- `bun test src/tests/credential-status-api.test.ts` — Phase 4 endpoint tests
- Manual E2E: `docker compose -f docker-compose.local.yml up --build` with `.env.docker` missing `CLAUDE_CODE_OAUTH_TOKEN`. Observe worker boots, reports waiting, then heals after `PUT /api/config`.

---

## Phase 1: Predicate functions per adapter

### Overview

Each provider adapter exports a `checkCredentials(env, opts?): CredStatus` function. No worker behavior changes yet — this phase is pure addition + unit tests. Deliverable: 6 predicate functions + a shared `CredStatus` type, all green under `bun test`.

### Changes Required:

#### 1. Shared types
**File**: `src/providers/types.ts`
**Changes**: Add `CredStatus`, `CredCheckOptions`, and a `checkCredentials` field on the `ProviderAdapter` interface (or a separate registry — TBD during implementation).

```ts
export interface CredStatus {
  ready: boolean;
  missing: string[];           // env var names (or file paths) still needed
  satisfiedBy?: 'env' | 'file' | 'side-effect-pending';
  hint?: string;               // human-readable, surfaced in dashboard + logs
}

export interface CredCheckOptions {
  homeDir?: string;            // for file checks (defaults to process.env.HOME)
  fs?: { existsSync(p: string): boolean }; // injectable for tests
}
```

#### 2. claude adapter
**File**: `src/providers/claude-adapter.ts`
**Changes**: Export `checkCredentials(env)` — ready when `CLAUDE_CODE_OAUTH_TOKEN || ANTHROPIC_API_KEY` is set; `missing` lists both with "either one" hint.

#### 3. claude-managed adapter
**File**: `src/providers/claude-managed-adapter.ts`
**Changes**: Export `checkCredentials(env)` — AND of `ANTHROPIC_API_KEY`, `MANAGED_AGENT_ID`, `MANAGED_ENVIRONMENT_ID`, `MCP_BASE_URL`. Hint references the `claude-managed-setup` CLI.

#### 4. devin adapter
**File**: `src/providers/devin-adapter.ts`
**Changes**: Export `checkCredentials(env)` — AND of `DEVIN_API_KEY`, `DEVIN_ORG_ID`.

#### 5. codex adapter
**File**: `src/providers/codex-adapter.ts`
**Changes**: Export `checkCredentials(env, opts)` — ready if `<homeDir>/.codex/auth.json` exists OR `OPENAI_API_KEY` is set (`satisfiedBy: 'side-effect-pending'` since the login dance still needs to run). The `codex_oauth` swarm_config path is satisfied indirectly: once swarm_config ships the value into env (via the entrypoint pre-fetch *or* via `fetchResolvedEnv` later), the file-write side-effect re-runs.

#### 6. pi-mono adapter
**File**: `src/providers/pi-mono-adapter.ts`
**Changes**: Export `checkCredentials(env, opts)` — ready if `~/.pi/agent/auth.json` exists. Otherwise consult `MODEL_OVERRIDE`:

  - Set + resolves to anthropic → require `ANTHROPIC_API_KEY`
  - Set + resolves to openrouter → require `OPENROUTER_API_KEY`
  - Set + resolves to openai → require `OPENAI_API_KEY`
  - Unset → permissive: any one of the three keys is enough

Reuse `resolveModel` from pi-mono-adapter.ts:69 for the mapping (extract a small `modelToCredKey` helper if needed).

#### 7. opencode adapter
**File**: `src/providers/opencode-adapter.ts`
**Changes**: Same shape as pi. `~/.local/share/opencode/auth.json` file check + model-conditional env. Determine model→provider routing from the adapter's existing logic.

#### 8. Provider registry / dispatcher
**File**: `src/providers/index.ts` (or new `src/providers/credentials.ts`)
**Changes**: Export `checkProviderCredentials(provider: string, env, opts): CredStatus` that dispatches to the right adapter. Also export a `REQUIRED_CRED_VARS_BY_PROVIDER` map for documentation/UI hints.

#### 9. Unit tests
**File**: `src/tests/credential-check.test.ts` (new)
**Changes**: Per-provider matrix tests covering each ready/not-ready branch, including model-conditional pi/opencode cases and codex's file-vs-env paths. Use injectable `fs` for file presence.

### Success Criteria:

#### Automated Verification:
- [x] Linting passes: `bun run lint`
- [x] Type check passes: `bun run tsc:check`
- [x] New test file passes: `bun test src/tests/credential-check.test.ts`
- [x] All existing tests pass: `bun test`

#### Automated QA:
- [x] Snapshot test: for each provider, given a "fully unset env", `checkCredentials({})` returns `ready: false` with a non-empty `missing` array and a `hint` string.
- [x] Snapshot test: for each provider, given a "minimum sufficient env", `checkCredentials(...)` returns `ready: true`.

#### Manual Verification:
- [x] None — pure-function phase.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 2: Boot wait loop + non-blocking entrypoint

### Overview

Make the worker boot wait for credentials *in TS* with exponential backoff, and convert `docker-entrypoint.sh` from fail-fast to best-effort. Deliverable: a worker container with no harness creds boots successfully, registers, and logs `[boot] waiting for ...` until creds arrive (or forever, with a `BOOT_MAX_WAIT_SECONDS` ceiling).

### Changes Required:

#### 1. New module: `src/commands/credential-wait.ts`
**File**: `src/commands/credential-wait.ts` (new)
**Changes**: Implement `awaitCredentials({apiUrl, apiKey, agentId, provider, maxWaitSeconds, onTick}): Promise<CredStatus>`. Loop:

  1. Call `checkProviderCredentials(provider, process.env, opts)` — if ready, return.
  2. Otherwise call `fetchResolvedEnv(apiUrl, apiKey, agentId)` and merge into `process.env`.
  3. Re-check; if ready, return.
  4. Emit a structured log line via existing logger (or `console.log` consistent with `[env-reload]` style).
  5. Call `onTick(status)` for status reporting.
  6. Sleep with backoff: starts at `BOOT_INITIAL_BACKOFF_MS` (default 2000), doubles each iteration, capped at `BOOT_MAX_BACKOFF_MS` (default 30000). All three constants resolved from env at function entry, not hardcoded.
  7. If `BOOT_MAX_WAIT_SECONDS > 0` and elapsed exceeds it, throw — exits the worker with a clear exit code so docker can surface the failure. Default `0` means loop forever.

#### 2. Worker startup integration
**File**: `src/commands/runner.ts` (or wherever the worker's main loop lives — confirm via `codebase-locator`)
**Changes**: Call `awaitCredentials(...)` once at startup, *after* `join-swarm` registration succeeds (so the agent row exists for status reports). On each loop iteration, the `onTick` callback updates the agent's `credentialStatus` field via the existing status-report endpoint.

#### 3. Bash entrypoint cleanup
**File**: `docker-entrypoint.sh`
**Changes**:

  - Lines 7–155: convert each `exit 1` to `echo "Warning: ..."`. Keep the file-prep side effects (codex login, codex_oauth restore, claude-managed pre-fetch) but wrap each in `|| true` and ensure they no-op cleanly when inputs are missing.
  - Lines 158–161 (`API_KEY` check): keep the hard exit.
  - Add a top-of-file comment block explaining the new boot model: "Validation moved to TS; this script does best-effort prep only."

#### 4. Backoff config
**File**: `src/commands/credential-wait.ts` + docs
**Changes**: Read `BOOT_MAX_WAIT_SECONDS` from env (default `0` = forever). Initial backoff `BOOT_INITIAL_BACKOFF_MS` (default 2000), max `BOOT_MAX_BACKOFF_MS` (default 30000). All overridable for tests.

#### 5. Unit tests
**File**: `src/tests/credential-wait.test.ts` (new)
**Changes**: Test the loop with a stub `fetchResolvedEnv` and a stub `checkCredentials` that flips ready after N ticks. Verify: backoff sequence, `onTick` invocation, `BOOT_MAX_WAIT_SECONDS` enforcement, immediate-return when already ready.

### Success Criteria:

#### Automated Verification:
- [x] Linting passes: `bun run lint`
- [x] Type check passes: `bun run tsc:check`
- [x] New test file passes: `bun test src/tests/credential-wait.test.ts`
- [x] All existing tests pass: `bun test`
- [x] DB boundary still clean: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [x] Build the worker image: `bun run docker:build:worker` — succeeds.
- [ ] Spin up local compose with `CLAUDE_CODE_OAUTH_TOKEN` empty. Worker container exits with code 0 on `docker compose down` (not crash-restarted). Container logs show `[boot] waiting for CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY (retry N in Ms)` lines, not "exiting".
- [ ] Set `CLAUDE_CODE_OAUTH_TOKEN` via `PUT /api/config` (scope=agent, the worker's agentId). Within 30s, worker logs `[boot] credentials ready`. (Scripted via curl in the test.)

#### Manual Verification:
- [ ] Confirm `docker compose logs worker-1` after a 60s wait shows clean polling output, not error spam.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

### QA Spec (optional):

End-to-end credential-recovery scenario across all 6 providers warrants a separate QA doc — see Appendix.

---

## Phase 3: Block task claiming while waiting + dispatcher routing

### Overview

Add a `credentialStatus` column to the `agents` table, surface it in the polling/claim path, and have the dispatcher route around blocked workers. Deliverable: with two workers (one ready, one waiting), tasks always go to the ready one — verifiable via integration test.

### Changes Required:

#### 1. Migration

**File**: `src/be/migrations/NNN_agent_waiting_for_credentials_status.sql` (new — pick next available number)

**Decision (resolved from review)**: Extend the existing `agents.status` enum rather than adding a parallel `credentialStatus` column. The current enum is `idle | busy | offline` (src/types.ts:236, src/be/migrations/001_initial.sql:14) — these describe an agent's *runtime availability* on a single axis. "Waiting for credentials" fits that axis as a 4th value: an agent in this state is reachable (not `offline`) but unable to take work (not `idle`/`busy`). Reuse keeps the dispatcher predicate trivial (filter `status === 'idle'`), avoids a JOIN-or-AND-condition in every capacity check, and matches how downstream code already thinks about agent availability. The `missing[]` data still needs its own column since the enum can't carry payload.

**Changes**:
1. Drop the old `CHECK(status IN ('idle', 'busy', 'offline'))` constraint and re-create with `'waiting_for_credentials'` added. (SQLite ALTER doesn't support modifying CHECK in place — table-rebuild idiom: `CREATE new → INSERT SELECT → DROP old → RENAME`. Follow the existing migration patterns in `src/be/migrations/` for examples.)
2. Add `ALTER TABLE agents ADD COLUMN credentialMissing TEXT` (nullable JSON array of env-var names; populated only when status is `waiting_for_credentials`).
3. No data backfill needed — existing rows keep their current status, and `credentialMissing` defaults NULL.

#### 2. DB helpers
**File**: `src/be/db.ts`
**Changes**: Extend agent status helpers to accept the new enum value. Add `updateAgentCredentialState(agentId, ready: boolean, missing: string[] | null): void` — when `ready=true`, sets `status='idle'` and clears `credentialMissing`; when `ready=false`, sets `status='waiting_for_credentials'` and stores `JSON.stringify(missing)`.

#### 3. Heartbeat / status-report endpoint
**File**: `src/http/agents.ts` (locate via codebase-locator)
**Changes**: Existing status-report endpoint accepts the new `'waiting_for_credentials'` status value plus an optional `credentialMissing: string[]` field; the worker's `onTick` callback calls it.

#### 4. Capacity predicate
**File**: `src/http/utils.ts` (`agentWithCapacity` function)
**Changes**: Verify the predicate already filters by `status === 'idle'` — if so, no code change needed; the new enum value is implicitly excluded. If the predicate is broader (`status !== 'offline'`), tighten it to explicitly exclude `'waiting_for_credentials'`.

#### 5. Worker poll gate
**File**: `src/commands/runner.ts` (worker poll loop)
**Changes**: Skip task polling entirely while waiting on creds. Re-check creds on the backoff schedule from Phase 2; once ready, transition the agent's status from `waiting_for_credentials` to `idle` and resume polling.

#### 6. Schema sync
**File**: `src/types.ts`
**Changes**: Update `AgentStatusSchema` to `z.enum(["idle", "busy", "offline", "waiting_for_credentials"])`. Add `credentialMissing?: string[] | null` to the `Agent` schema. Keep in sync with the new SQL CHECK constraint per CLAUDE.md migration rules.

#### 7. Tests
**File**: `src/tests/credential-status-routing.test.ts` (new)
**Changes**: Spin up two agents, set one to `'waiting_for_credentials'`, dispatch tasks, assert all go to the `'idle'` agent. Test the migration applies cleanly to a fresh DB and an existing one (per CLAUDE.md migration rules). Test that transitioning `waiting_for_credentials → idle` resumes polling.

### Success Criteria:

#### Automated Verification:
- [x] Linting passes: `bun run lint`
- [x] Type check passes: `bun run tsc:check`
- [x] New test file passes: `bun test src/tests/credential-status-routing.test.ts`
- [x] All existing tests pass: `bun test`
- [x] Migration applies on fresh DB: `rm test.sqlite && DATABASE_PATH=test.sqlite bun run start:http` (process exits with migrations applied)
- [x] Migration applies on existing DB: copied a recent prod-shape sqlite, started server, verified `credentialMissing` column added and CHECK enum extended.

#### Automated QA:
- [x] Integration: ready vs blocked agent — `getIdleWorkersWithCapacity` excludes the blocked one (`credential-status-routing.test.ts`).
- [x] Integration: blocked → idle transition resumes dispatch (`credential-status-routing.test.ts`).

#### Manual Verification:
- [ ] Inspect `agents` table after running: `sqlite3 agent-swarm-db.sqlite "SELECT id, status, credentialMissing FROM agents"` — values populated.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 4: Dashboard surface + readiness endpoint

### Overview

Expose `credentialStatus` to the dashboard and add a `/ready` endpoint. Deliverable: dashboard shows "waiting on CLAUDE_CODE_OAUTH_TOKEN" badges; ops orchestrators can use `/ready` for strict gating.

### Changes Required:

#### 1. New API endpoints
**File**: `src/http/agents.ts` (or wherever agent routes live)
**Changes**: Add two endpoints, both via the `route()` factory + imported in `scripts/generate-openapi.ts`:

  - `GET /api/agents/{id}/credential-status` — single agent. Returns `{ agentId, status, missing[], hint, lastCheckedAt }`.
  - `GET /api/agents/credential-status` — bulk. Returns `{ agents: [{ agentId, status, missing[], hint, lastCheckedAt }, ...] }`. Powers the dashboard's all-agents view without requiring N round-trips. Optional `?status=waiting_for_credentials` query param to filter to just blocked agents.

Both endpoints derive their payload from the `agents` table directly (`status`, `credentialMissing` columns from Phase 3), not by re-running `checkCredentials` server-side — the worker's reported state is the source of truth.

#### 2. Worker readiness endpoint
**File**: Worker's status server (locate via codebase-locator — likely in `src/commands/runner.ts` or a sibling)
**Changes**: Add `GET /ready` returning 200 when local cred state is satisfied, 503 with `{missing[]}` body otherwise. Keep `/health` as liveness (always 200 if process is up).

#### 3. Dashboard wiring
**File**: `new-ui/...` (locate the agent-detail / agent-list page via Explore)
**Changes**: Display a "Waiting for credentials" badge with the missing list; refresh polling for that field.

#### 4. OpenAPI regeneration
**Changes**: After endpoint added, run `bun run docs:openapi` and commit the diff.

#### 5. Tests
**File**: `src/tests/credential-status-api.test.ts` (new)
**Changes**: Cover both endpoints — `GET /api/agents/{id}/credential-status` for a single waiting agent, and `GET /api/agents/credential-status` returning the full list (with and without `?status=waiting_for_credentials` filter). Assert response shape, and that mixing ready/waiting agents in the DB produces the expected aggregate.

### Success Criteria:

#### Automated Verification:
- [x] Linting passes: `bun run lint`
- [x] Type check passes: `bun run tsc:check`
- [x] New test passes: `bun test src/tests/credential-status-api.test.ts`
- [x] All existing tests pass: `bun test`
- [x] OpenAPI fresh: `bun run docs:openapi` produces no diff after commit
- [x] new-ui type check: `cd new-ui && pnpm exec tsc -b`

#### Automated QA:
- [ ] qa-use session: navigate dashboard → agents page, observe "Waiting for credentials" badge with missing var name. After `PUT /api/config`, badge disappears within polling interval. (Per CLAUDE.md, frontend PRs require qa-use with screenshots.)
- [ ] ~~curl `GET /ready` against a waiting worker returns 503~~ — **Skipped**: workers don't have an HTTP server today, only the API does. The dashboard already gets the same info from `GET /api/agents/{id}/credential-status`. Promoted to follow-up plan along with worker-side health/readiness server.
- [x] curl `GET /api/agents/credential-status` returns the full agent list with status/missing per agent; same with `?status=waiting_for_credentials` returns just the blocked subset (covered by `credential-status-api.test.ts`).

#### Manual Verification:
- [ ] Dashboard visual check: badge styling matches existing status indicators.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

### QA Spec (optional):

Worth promoting to a separate QA doc if the dashboard work expands — see Appendix.

---

## Manual E2E

Run against the local compose stack:

```bash
# 1. Start with a deliberately-broken env (no harness creds for one worker).
cp .env.docker.example .env.docker
# Fill API_KEY, GITHUB_*, etc. but LEAVE CLAUDE_CODE_OAUTH_TOKEN blank.
docker compose -f docker-compose.local.yml up --build -d

# 2. Verify worker is up but waiting.
docker compose logs worker-1 --tail 20    # expect [boot] waiting lines
curl -s http://localhost:3013/api/agents | jq '.[] | {id,credentialStatus,credentialMissing}'
curl -i http://localhost:3021/ready       # expect HTTP 503

# 3. Send a task — should NOT land on worker-1.
curl -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{...}'
# Verify task assignment via dashboard or DB.

# 4. Set the cred via swarm_config.
curl -X PUT http://localhost:3013/api/config \
  -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
  -d '{"scope":"agent","scopeId":"<worker-1-agent-id>","key":"CLAUDE_CODE_OAUTH_TOKEN","value":"<token>","isSecret":true}'

# 5. Within 30s, worker transitions to ready.
docker compose logs worker-1 --tail 5     # expect [boot] credentials ready
curl -i http://localhost:3021/ready       # expect HTTP 200
curl -s http://localhost:3013/api/agents | jq '.[] | select(.id=="<worker-1-agent-id>")'
```

Repeat for each provider where applicable: claude-managed (`MANAGED_*` keys), pi (`MODEL_OVERRIDE=openrouter/...` + `OPENROUTER_API_KEY`), codex (`OPENAI_API_KEY` + observe entrypoint side-effect re-runs on next tick — note: side-effect re-run requires a worker process restart since `codex login` is in entrypoint; document this caveat).

---

## Appendix

- **Follow-up plans**:
  - SSE / WebSocket push from `/api/config/reload` to workers — would replace polling and reduce latency from ≤30s to ~instant.
  - Move codex login + codex_oauth file restore from entrypoint into the TS worker process (allows live recovery without container restart for the codex side-effect path).
- **Derail notes**:
  - `claude-managed-setup` UX could surface the credential-status endpoint to validate the setup before declaring "done".
  - The `MODEL_OVERRIDE`-conditional check for pi/opencode might benefit from caching the resolution — call it once at boot and store the resolved provider rather than re-resolving every tick.
  - When `BOOT_MAX_WAIT_SECONDS` triggers, the exit code should be distinct (e.g. 78 = `EX_CONFIG`) so monitoring can distinguish "config never arrived" from generic failures.
- **Open questions resolved during planning** (autonomous decisions per Auto mode):
  - Worker registers via `join-swarm` *before* creds resolve so it's visible in the dashboard while waiting.
  - `MODEL_OVERRIDE` unset → permissive check (any one supported env key satisfies). `MODEL_OVERRIDE` set → strict (the model's specific provider is required).
  - Polling-only for v1 — no SSE subscription on `/api/config/reload`. Workers refresh on their own backoff.
  - `BOOT_MAX_WAIT_SECONDS` default `0` (forever). Ops can set a ceiling per-worker.
  - `/health` stays 200 (liveness only). New `/ready` returns 503 when waiting (readiness, k8s-style split).
- **References**:
  - Research base: this conversation transcript (no separate research doc).
  - Reserved-key invariant: `src/be/swarm-config-guard.ts:14`
  - Existing config refresh: `src/commands/runner.ts:208` (`fetchResolvedEnv`), `src/http/config.ts:55` (`/api/config/reload`)
  - Entrypoint validation locations: `docker-entrypoint.sh:7-156`
  - Per-task fresh-env fetch: `src/commands/runner.ts:1634`
