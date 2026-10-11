---
id: step-2
name: Runtime token + central agent binding
depends_on: []
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-2: Runtime token + central agent binding

## Overview

A worker can run its whole life (entrypoint, register, poll, tasks, MCP, realtime) with a scoped **runtime token** instead of the swarm key. The token is an `aseph_` session token with no `taskId`, bound to `(agentId, runtimeId)`. Every route then enforces that `X-Agent-ID` (and `X-Runtime-Instance-ID` when sent) match the token, so a token cannot act as another agent. Revoking the token fences the runtime: every call returns 401. Done = an operator can mint a runtime token, start a stock worker with `API_KEY=<token>`, watch it complete a task, and see spoofing and post-revoke calls rejected.

Not in scope: who mints at provision time (step-5), controller tokens (step-10 adds the controller principal, reusing this migration's column).

## Changes Required:

#### 1. Migration `207_runtime_session_tokens.sql`
**File**: `src/be/migrations/207_runtime_session_tokens.sql` (new)
**Changes**: Rebuild `session_tokens` (SQLite cannot drop NOT NULL in place): copy rows into a new table where `taskId TEXT` is nullable, add `runtimeId TEXT`, `parentRuntimeId TEXT` (set on task-bound tokens a runtime mints for itself, so the runtime's revoke reaches them), `controllerId TEXT` (used by step-10), and a CHECK that exactly one binding shape holds: task-bound (`taskId NOT NULL AND runtimeId IS NULL`, `parentRuntimeId` optional), runtime-bound (`taskId IS NULL AND runtimeId NOT NULL`), or controller-bound (`controllerId NOT NULL AND taskId IS NULL AND runtimeId IS NULL`, `agentId` = the controller's synthetic id). Recreate `idx_session_tokens_agentId`, add `idx_session_tokens_runtimeId`. Keep existing ACP rows valid. Re-check the ordinal against `main` before merge.

#### 2. Token helpers
**File**: `src/be/users.ts:553-616`, `src/utils/request-auth-context.ts:5-15`, `src/http/auth.ts:63-68`
**Changes**:
- `mintRuntimeToken(agentId, runtimeId, ttlMs)`, `revokeRuntimeTokensForRuntime(runtimeId)` (revokes rows with `runtimeId` OR `parentRuntimeId` equal to it). Default TTL from `RUNTIME_TOKEN_TTL_HOURS` (default 168). Keep `mintSessionToken` for ACP.
- `resolveBySessionToken` returns `{agentId, taskId: string | null, runtimeId: string | null}`.
- `HttpRequestAuth` agent variant: `taskId: string | null`, add `runtimeId: string | null`.
- `POST /api/sessions/tokens` (`src/http/sessions.ts:78-213`): accept `{agentId, runtimeId, ttlMs}` without `taskId` for operators (runtime token). Also allow a **runtime-token** principal to mint a task-bound token for its own `agentId`, only for a task assigned to that agent, with `ttlMs` capped at its own remaining lifetime and `parentRuntimeId` set (keeps the ACP harness working under a runtime token).

#### 3. Central binding check
**File**: `src/http/core.ts:461-496` (after `setRequestAuth`), `src/http/mcp.ts:99-113`
**Changes**:
- For `auth.kind === "agent"`: if `X-Agent-ID` is present and differs from `auth.agentId` → 403 `{error:"X-Agent-ID does not match token"}`. If absent, treat the request as `auth.agentId` (set the header value used downstream, so `myAgentId` in `src/http/index.ts:332` resolves to the token's agent). Same rule for `X-Runtime-Instance-ID` vs `auth.runtimeId` when the token is runtime-bound.
- `mcp.ts` keeps the `X-Source-Task-Id` check only for task-bound tokens. Runtime-bound tokens pass for any task of that agent. The `X-Agent-ID` part of `validateAgentTokenIdentity` moves to the central check (do not duplicate).
- `POST /api/agents` (`src/http/agents.ts:626`): for an agent principal, ignore a body `isLead` that differs from the stored row (a token cannot promote itself to lead).
- Path-scoped agent routes: for an agent principal whose stored row is not a lead, any non-GET on `/api/agents/{id}/*`, and any GET with `resolveSecrets`/`includeSecrets`, where `{id}` differs from `auth.agentId` → 403. This closes `GET /api/agents/{id}/mcp-servers?resolveSecrets=true` (gates only user principals today, `src/http/mcp-servers.ts:207-210`) and `PUT /api/agents/{id}/profile` (no ownership check) for token principals. Swarm-key callers are unchanged.

#### 4. Self-scoped secret read
**File**: `src/http/config.ts:55-81`, `src/rbac/legacy-policy.ts:304`
**Changes**: `requestMayReadSecrets` allows a **runtime-bound** agent principal when the resolved scope is its own agent (`agentId` query param absent or equal to `auth.agentId`). Task-bound (ACP) tokens stay masked. This keeps the entrypoint's boot-time export (`docker-entrypoint.sh:538-560`, `/api/config/resolved?agentId=…&includeSecrets=true`) working. Add a short note to the RBAC docs if the rule is listed there.

#### 5. Realtime identity from token
**File**: `src/realtime/transport.ts:72-92`
**Changes**: `identityFromHttpAuth` maps `auth.kind === "agent"` to `{agentId: auth.agentId, sourceTaskId: auth.taskId, isOperator: false}`, so a token-authenticated worker gets an agent identity on `/api/realtime` (step-7 relies on `identity.agentId`). The upgrade path does not pass through `src/http/core.ts`, so apply the same `X-Agent-ID` match rule here. Fence open sockets: the 15 s keepalive tick (`transport.ts:413-425`, `checkSession`) re-resolves `aseph_` tokens and closes the socket (1008) when the token is revoked or expired. `revokeRuntimeTokensForRuntime` also closes matching sockets at once through a small in-process registry.

#### 6. Worker side
**File**: `docker-entrypoint.sh`, `src/commands/runner.ts`
**Changes**:
- Runtime id: `runner.ts:5649` uses `process.env.SWARM_RUNTIME_INSTANCE_ID` when set, else `crypto.randomUUID()` (today it always generates one). Required so a runtime-bound token matches the id the runner sends. Step-5 relies on it to adopt the pre-inserted `provisioning` row.
- No credential refactor: the token arrives as `API_KEY` / `AGENT_SWARM_API_KEY`, so `getApiKey()` and the entrypoint's raw `$API_KEY` both carry it. Verify with a real run (Automated QA) and fix any boot route that rejects the agent principal. Known candidates from research: `POST /api/sessions/tokens` (handled above), secret masking (handled above). Record any other rejection found and its fix in the step's commit message.

#### 7. Runbook note
**File**: `runbooks/local-development.md` (auth section)
**Changes**: Two sentences on runtime tokens: what they are, that they replace the swarm key only for supervisor-provisioned runtimes.

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun run test:root -- src/tests/session-tokens.test.ts src/tests/acp-session-token.test.ts src/tests/runtime-token-auth.test.ts src/tests/migration-207-runtime-session-tokens.test.ts src/tests/realtime-transport.test.ts`
- [x] `bun run test:root -- src/tests/runtime-token-auth.test.ts` cases cover: mint/resolve/revoke; mismatched `X-Agent-ID` → 403 on `/api/poll`, `/ping`, `/api/tasks/{id}/progress`, `/mcp`; missing header resolves to the token's agent; mismatched `X-Runtime-Instance-ID` → 403; revoked or expired token → 401; runtime token reads its own secrets unmasked, task-bound token masked, another agent's scope masked; runtime token mints a task-bound token only for its own agent's task, and revoking the runtime revokes the child token; `isLead` escalation ignored; non-lead token → 403 on `PUT /api/agents/{other}/profile` and `GET /api/agents/{other}/mcp-servers?resolveSecrets=true`; realtime socket with mismatched `X-Agent-ID` rejected; revoking the token closes its open realtime socket
- [x] `bun run test:root -- src/tests/migration-207-runtime-session-tokens.test.ts`: existing ACP rows survive the rebuild, the CHECK rejects a row with no binding
- [x] Existing ACP flow unchanged: `bun run test:root -- src/tests/acp-session-token.test.ts`
- [x] `bun run check:rbac-coverage && bun run check:openapi-response-coverage && bun run check:api-key-boundary` pass
- [x] `bash scripts/check-migration-conflicts.sh && bash scripts/check-async-db-seam.sh` pass
- [x] `bun run docs:openapi` run and committed (the sessions-token body changes), no diff afterwards
- [x] `bun run lint && bun run tsc:check:tsc` pass

#### Automated QA:
- [x] Boot the API on a temp DB. Mint a runtime token with the swarm key: `curl -X POST $API/api/sessions/tokens -H "Authorization: Bearer $KEY" -d '{"agentId":"<uuid>","runtimeId":"<uuid>","ttlMs":3600000}'`. Create a task pinned to that agent. Start `ghcr.io/desplega-ai/agent-swarm-worker:slim` with `API_KEY=<token>`, `AGENT_ID=<uuid>`, `SWARM_RUNTIME_INSTANCE_ID=<uuid>`, `MCP_BASE_URL=http://host.docker.internal:<port>` (the spike recipe in `scripts/spike-runtime-providers.ts`). The task reaches `completed`. Worker logs show no 401/403.
- [x] With the same token, `curl -H "X-Agent-ID: <other-uuid>" $API/api/poll` returns 403.
- [x] Revoke via `DELETE /api/sessions/tokens/{id}`. The next worker call returns 401 (visible in worker logs) and the worker cannot write progress.

#### Manual Verification:
- [ ] Taras confirms the self-scoped secret rule matches the intended trust model (runtime token sees the same resolved secrets a swarm-key worker sees for its agent, no more).

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. Commit after verification passes: `[step-2] runtime token + central agent binding`.
