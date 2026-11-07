---
date: 2026-10-25
author: Claude (with Taras)
status: implemented (PR #2422)
branch: fix/credential-validation
worktree: ~/worktrees/agent-swarm/2026-10-25-credential-validation
related:
  - /tmp/2026-10-25-0051-onboarding-round2.md (F21, F23, D13)
  - thoughts/taras/research/2026-09-25-cliproxyapi-learnings-usage-page.md
---

# PR 2: provider key validation (pools, re-test on change, real OAuth check)

## Why

Taras's demo feedback (F21): provider validation is slow and not accurate. Facts from the code on `origin/main` (ef71532ed):

1. **A pool is tested as one key after a restart.** The entrypoint exports the raw `swarm_config` value (`docker-entrypoint.sh` `swarm_config_env_lines`). The credential wait sees the key as present and returns at once. The boot snapshot then sends `"k1,k2"` as one key (`buildCredStatusReport(process.env)`, `runner.ts:6383`), and the provider answers 401.
2. **The wait path tests one random key.** `fetchResolvedEnv` picks one pool member (`resolveCredentialPools` sets `env[var] = selected`, `credentials.ts:558`). `applyEnvUpdates` writes that member into `process.env`. The other keys are never tested.
3. **A running worker never tests a key again.** `refreshCredentialStatus` runs only on a provider change, or when `ready !== true` (`credential-refresh.ts:33-38`). Credential vars are not in `RELOADABLE_ENV_KEYS`, so `process.env` keeps the boot value. A fixed key keeps its old failure until a restart. The setup card then shows "Waiting for a worker to check this key" for ever.
4. **The Claude subscription check always passes.** `claudeSubscriptionProvider.validate` returns `{ status: "verified" }` with no request (`packages/model-routing/src/providers/claude-subscription.ts`).
5. **Slow:** the wait loop backs off to 30 s (`BOOT_MAX_BACKOFF_MS` default), so a new key takes 15 to 45 s to show a result.

## Decisions (Taras, 2026-10-25)

- **Scope:** split pools, test each key, re-test on change. No instant API check in this PR (that is PR 3).
- **OAuth:** a real check. `GET https://api.anthropic.com/api/oauth/profile` with `Authorization: Bearer <token>`. 401 means rejected. 2xx, or 403 `permission_error` (a setup token has no `user:profile` scope), means the token authenticates. Evidence: a fake token gets 401 "OAuth access token is invalid." (probe 2026-10-25). A real setup token gets 403 "OAuth token does not meet scope requirement" (probe 2026-09-25). CLIProxyAPI reads a 403 scope error the same way (`claude_executor_auth.go:58-72`, `isClaudeOAuthScope403`).
- **One bad key in a pool does not break the flow.** The check passes when at least one key works. Workers stop using the rejected key, and the UI shows a warning that names it. The check fails only when every key fails.

## Out of scope

- An API route that tests a typed key before a worker sees it, and the multi-key UI (both PR 3, see below).
- The lead credential dialog "Re-check" button (it reads reports only). No change.
- A live test of Codex OAuth slots (`codex_oauth_<n>`) in Phase 1: they already have the auth-failure bench. PR 3 lists and removes them.

## Phase 1: test each pool key (worker)

Files: `src/commands/provider-credentials.ts`, `src/types.ts`, `apps/ui/src/api/types.ts`, `packages/model-routing/src/types.ts` (only if Phase 1 needs `httpStatus` on `RouteValidation`).

- Add `checkEachKey(keyType, value, check)` in `provider-credentials.ts`:
  - Split with `splitCredentialPool` (`src/utils/credentials.ts`). A JSON blob stays one credential.
  - Run `check(member)` for all members with `Promise.all`.
  - Each result: `{ keyType, index, suffix (last 5 chars), ok, error?, httpStatus?, latency_ms }`.
  - Overall `ok` is true when one key or more passes. `latency_ms` is the maximum.
  - Some keys fail: `warning: "1 of 3 keys failed: key ending abcde (HTTP 401)."`
  - All keys fail: `ok: false`, and the error names the key when the pool has more than one key.
  - One key: the same output as today, plus one `keys` entry.
- Wrap every live-check call site: the claude route (the route's `secretKey`, or `CLAUDE_CODE_OAUTH_TOKEN` for the subscription route, through `validateRoute` with that one key in the env), claude-managed, codex `OPENAI_API_KEY`, pi and opencode (OpenRouter, Anthropic, OpenAI and registry keys), devin, cursor, grok, amp (env with one key).
- The fetch helpers return the HTTP status, so Phase 3 can tell an auth failure (401, 403) from a timeout or a 5xx.
- `AgentCredStatusLiveTestSchema` gets optional `warning: string` and `keys: LiveKeyResult[]` (max 50). `buildCredStatusReport` copies them. UI types mirror them.

### Verification

```bash
bun run test:root -- src/tests/credential-check.test.ts src/tests/claude-default-route.test.ts src/tests/provider-registration.test.ts
bun run tsc:check
```

New tests: `checkEachKey` with an injected check (2 pass, 1 of 3 fails, all fail, one key, JSON blob). One fake `Bun.serve({ port: 0 })` registry provider through `<ID>_BASE_URL` with a pool of a good and a bad key.

## Phase 2: real Claude subscription check

Files: `packages/model-routing/src/providers/claude-subscription.ts`, its tests.

- `validate` calls `GET /api/oauth/profile` through `ctx.fetch` (scoped to the route base URL) with `Authorization: Bearer <token>`. No inference.
- 2xx: verified. 403 with `permission_error`: verified. 401: failed, "Anthropic rejected the Claude subscription token (HTTP 401). Make a new one with `claude setup-token`." Other status: failed with the status.
- Update the comment: Claude Code cannot refresh a token that comes from the env (there is no refresh token), so a 401 is a real failure.

### Verification

```bash
bun run test:root -- packages/model-routing
bun run tsc:check
```

Tests with an injected fetch: 200, 403 `permission_error`, 403 other, 401, timeout.

## Phase 3: re-test on change, skip rejected keys

### 3a. Worker

Files: `src/commands/runner.ts`, `src/commands/credential-refresh.ts`, `src/commands/credential-wait.ts`.

- `fetchResolvedEnv` also returns `credentialEnv`: a copy of the env before `resolveCredentialPools`, so pools stay whole. In process only, never logged.
- The runner keeps the `credentialEnv` of the latest 10 s reconcile and passes it to `refreshCredentialStatus` (fallback `process.env`).
- `CredentialRefreshState` gets `fingerprint` (sha256 of the credential var values) and `rejectedKeys` (count from the last report).
- Re-test when one of these is true:
  - the provider changed (as today);
  - the fingerprint changed (new: a saved, removed or edited key, tested within about 10 s);
  - `ready !== true` and 30 s passed (as today);
  - the last report had rejected keys and 10 min passed (new, `KEY_RECHECK_INTERVAL_MS`). A key that works again comes back.
- The boot snapshot sets the fingerprint from `process.env`. When the wait path tested only one member, the fingerprint of the full pool differs, so the full pool is tested on the next reconcile.
- After a report, the worker posts the per-key results to the API (3b). Best effort, 5 s timeout, never throws.
- `BOOT_MAX_BACKOFF_MS` default: 30000 to 10000.

### 3b. API

Files: `src/be/migrations/244_api_key_validation.sql`, `src/be/db.ts`, `src/http/api-keys.ts`, `openapi.json`.

- Migration 244 (main ends at 242, open PR #2219 adds 243): `ALTER TABLE api_key_status ADD COLUMN lastValidationError TEXT;` and `ADD COLUMN lastValidationFailedAt TEXT;`.
- New route `POST /api/keys/report-validation` (`route()` factory, `rbac: { ungated: "worker credential telemetry, same posture as POST /api/keys/report-rate-limit" }`, response schema). Body: `keyType`, `keys: [{ keyIndex, keySuffix, ok, httpStatus?, error? }]`.
- In one transaction, scope global:
  - A failure with HTTP 401 or 403 sets the two columns (upsert on `keyType, keySuffix, scope, scopeId`). Other failures change nothing.
  - A pass clears them.
  - Rows of that key type whose suffix is not in the report are cleared, so a removed key cannot block a new key at the same index.
- `getAvailableKeyIndices` leaves out rows with `lastValidationFailedAt` set and returns them as `rejectedIndices`. When every key is left out, the selector picks a random key, as today.
- The API key status schema gets the two fields.
- Docs: `docs-site/.../guides/harness-configuration.mdx` section "Multi-Credential Pools": each key is tested, a rejected key is skipped and shown, keys are tested again on change and every 10 min.

### Verification

```bash
bun run test:root -- src/tests/credential-refresh.test.ts src/tests/credential-check.test.ts src/tests/api-keys*.test.ts
bash scripts/check-migration-conflicts.sh
bun run check:rbac-coverage && bun run check:openapi-response-coverage
bun run docs:openapi
bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts
bash scripts/check-db-boundary.sh
```

New tests: fingerprint change triggers a re-test, an unchanged fingerprint does not, the 10 min recheck with rejected keys; the report route marks, clears and drops absent suffixes; `getAvailableKeyIndices` leaves out a rejected index; a 5xx does not mark a key.

## Phase 4: UI

Files: `src/http/onboarding.ts`, `src/be/onboarding.ts`, `apps/ui/src/pages/setup/steps/ai/{model.ts,waiting.tsx}`, `apps/ui/src/pages/api-keys/page.tsx`, `apps/ui/src/pages/agents/[id]/credentials-panel.tsx`.

- Onboarding signals: each provider gets `error` (the latest failed live test, when not verified) and `warning` (the pool warning of the latest pass). Both nullable.
- Setup card (`WaitingPanel`):
  - Verified: "Verified by N agents" (no change).
  - Verified with a warning: the same line, then "1 of 3 keys failed and is skipped: key ending abcde (HTTP 401)."
  - Failed: error tone, "Key rejected: HTTP 401. Fix the key. Agents check it again within about 10 seconds."
  - No report yet: no change, but the tip says "about 10 seconds".
- Provider keys page: a "Rejected" state with the error and the check time, and a filter option.
- Agent credentials panel: the per-key results when the pool has more than one key.

### Verification

```bash
cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b
bun run test:root -- src/tests/onboarding*.test.ts src/tests/status.test.ts
```

agent-browser at 1440 px and 390 px: the setup AI step (verified, verified with warning, failed, waiting) and the Provider keys page. Screenshots and one recording for the PR.

## PR 3 (stacked on PR 2): multi-key UI (Taras review comment, 2026-10-25)

Facts today:
- **Comma pools** (`CREDENTIAL_POOL_VARS`: Claude token, Anthropic, OpenRouter, OpenAI, DeepSeek, Devin, Cursor, Amp, xAI, registry keys) have one masked field in setup and on the Integrations page. Secrets are write-only, so to add one key you must paste the whole pool again. There is no list of saved keys and no way to remove one key.
- **Codex** already has "Add another ChatGPT account" in setup (the device flow takes the first free `codex_oauth_<n>` slot, `src/http/codex-oauth-device.ts:199`). There is no list of the accounts and no way to remove one. The Integrations Codex section clears only the legacy `codex_oauth` row.

PR 2 left one more item for PR 3 (see Out of scope): an API check of a typed key before any worker sees it. PR 3 does that check inside the add route.

### Frozen API contract (2026-10-25, branch `feat/pool-keys-ui`, worktree `~/worktrees/agent-swarm/pool-keys-ui`)

New handler file `src/http/pool-keys.ts` (pool routes) and new routes in `src/http/codex-oauth-device.ts` or a new `src/http/codex-oauth-accounts.ts` (Codex routes). Register them in `src/http/all-routes.ts` and in the handler chain in `src/http/index.ts`. `route()` factory, typed responses (`.respond`).

Shared types (zod in the route file, exported as TS types too):

```ts
type PoolKeyStatus = "ok" | "rejected" | "rate_limited" | "unchecked";
interface PoolKey {
  index: number;            // position in the stored pool, 0-based
  suffix: string;           // last 5 characters, same as api_key_status.keySuffix
  status: PoolKeyStatus;
  error: string | null;     // lastValidationError when rejected, else null
  checkedAt: string | null; // lastValidationFailedAt when rejected, else updatedAt of the row, else null
  rateLimitedUntil: string | null;
}
interface PoolKeysResponse {
  key: string;                         // the env var name
  source: "stored" | "env" | "none";   // stored = a global swarm_config row; env = process.env only
  readOnly: boolean;                   // true when source === "env"
  keys: PoolKey[];
}
type PoolKeyCheckResult = "verified" | "rejected" | "not_tested";
interface PoolKeyCheck {
  suffix: string;
  result: PoolKeyCheckResult;
  httpStatus: number | null;
  error: string | null;  // short, scrubbed (scrubSecrets), never contains the key
}
```

Status of one key, from the global `api_key_status` row with the same `keyType` (the var name) and `keySuffix`:
- `rejected`: `lastValidationFailedAt` is set.
- `rate_limited`: `status = 'rate_limited'` and `rateLimitedUntil` is in the future.
- `ok`: a row exists and neither of the above is true.
- `unchecked`: no row.

Routes:
1. `GET /api/config/pool-keys?key=<VAR>`, 200 `PoolKeysResponse`.
   - `VAR` must be in `CREDENTIAL_POOL_VARS` and must not be `CODEX_OAUTH`, else 400.
   - Value: the global `swarm_config` row (decrypted on the server), else `process.env[VAR]`, else none. Split with `splitCredentialPool`.
   - Auth: the caller must be allowed to read all secrets (the same decision `resolveSecretsRead` makes for `GET /api/config?includeSecrets=true`, result `all`). Else 403. Only suffixes leave the server.
2. `POST /api/config/pool-keys`, body `{ key: string, value: string }`. `rbac: { permission: "config.write.any" }` and `ensureConfigAdmin(req, res, "config.write.any")`.
   - Split `value` on commas, trim each part, drop empty parts. No parts: 400 "Enter a key.".
   - A part with an inner space, tab or line break: 400 "A key cannot contain spaces or line breaks.".
   - A part that is already in the pool, or that is twice in the input: 409 "The key ending abcde is already in the pool." (suffix only).
   - `source === "env"`: 409 "These keys come from the deployment env. Change them there.".
   - Instant check, outside any DB transaction: test each new part with the same per-key probe the worker uses in `src/commands/provider-credentials.ts` (`checkAnthropicApiKey`, the Claude OAuth check, `checkOpenRouter`, `checkOpenAiApiKey`, `checkDeepSeekApiKey`, `checkXaiApiKey`, `checkOpenAICompatibleProvider`). A var with no probe (Devin, Amp, Cursor) gives `not_tested`. Result mapping: probe ok gives `verified`; HTTP 401 gives `rejected` (the same rule as `recordKeyValidation`); any other failure (403, 429, 5xx, timeout, network) gives `not_tested` with the error.
   - Any `rejected` part: 422 `{ error: "The key ending abcde was rejected (HTTP 401). Nothing was saved.", checks: PoolKeyCheck[] }`. Nothing is written.
   - Else, in one `getDbClient().transaction`: read the row again, check duplicates again, append the new parts at the end, write the joined pool (`","` join) through the same path as `PUT /api/config` (`validateConfigEntry`, `upsertSwarmConfigWithPolicyMirror`, `isSecret: true`, scope global). Keep the `description` and `exportToEnv` of an existing row. After the commit: `runConfigWriteSideEffects("global", key, value)`.
   - Record each `verified` part as a pass in `api_key_status` (scope global, its new index), without the step that retires absent suffixes. Add an option to `recordKeyValidation` for that (for example `{ retireAbsent: false }`), default unchanged.
   - 200 `{ ...PoolKeysResponse, checks: PoolKeyCheck[] }` (the new list, read after the write).
   - If a probe would call a base URL from config (not the provider default), the URL must pass `assertUrlSafe(url, publicEndpointSsrfOptions())` and use `redirect: "manual"`. Else the part is `not_tested`.
3. `DELETE /api/config/pool-keys?key=<VAR>&index=<n>&suffix=<abcde>`, 200 `PoolKeysResponse`. `rbac: { permission: "config.delete.any" }` and `ensureConfigAdmin(req, res, "config.delete.any")`.
   - The member at `index` must have that `suffix`, else 409 "The key list changed. Reload it and try again.".
   - `source === "env"`: 409 (same text as POST).
   - Remove the member and write the pool in one transaction. Removing the last member deletes the row (`deleteSwarmConfigByKey`). Then `runConfigWriteSideEffects`.
4. `GET /api/codex-oauth/accounts`, 200 `{ accounts: CodexAccount[] }`, sorted by slot. Same auth as route 1.
   ```ts
   interface CodexAccount {
     slot: number;            // 0 for the legacy codex_oauth row when no codex_oauth_0 exists
     configKey: string;       // "codex_oauth_<n>" or "codex_oauth"
     legacy: boolean;
     suffix: string | null;   // deriveCodexKeySuffix(access, accountId)
     plan: string | null;     // extractChatgptPlanType(access), no network call
     email: string | null;    // from the access-token profile claim when present, else null
     status: "ok" | "needs_login" | "unchecked"; // needs_login when the auth bench is active for the suffix
   }
   ```
   A row whose JSON cannot be parsed is listed with `suffix`, `plan` and `email` null and status `needs_login`.
5. `DELETE /api/codex-oauth/accounts/{slot}`, 200 `{ accounts: CodexAccount[] }`, 404 when the slot does not exist. `rbac: { permission: "config.delete.any" }` and `ensureConfigAdmin`. Deletes the slot row (the legacy row for a legacy slot 0). Then `runConfigWriteSideEffects`.

Secret rules: no full key in any response, log line or error. Errors go through `scrubSecrets`. Tests use fake keys and a mocked `fetch`.

### UI design

- One `PoolKeysList` component (`apps/ui/src/components/onboarding/pool-keys-list.tsx`). Rows: "Key ending abcde" (mono), a status pill, Remove with an `AlertDialog`. Below: a masked "Add a key" input and an "Add key" button. After an add, a line per new key: verified, not tested (with the reason), or rejected (nothing saved). An env-only pool shows its rows with no Remove and no Add, plus one help line.
- It replaces the comma field for pool vars in the setup cards (Claude token, Anthropic key, OpenRouter, DeepSeek, registry keys) and for `credentialPool: true` fields on the Integrations page. Those fields leave the page-level Save and Clear.
- `CodexAccountsList`: the ChatGPT accounts with plan, email (when known), status pill and Remove. In the setup Codex card and in the Integrations Codex section (it replaces "Clear stored OAuth"). The Codex card shows "Add another ChatGPT account" again after a sign-in.
- Backward compatible: the stored value stays a comma pool, so workers, the entrypoint and the runner do not change. `PUT /api/config` still accepts a whole pool.

### Verification

```bash
bun run test:root -- src/tests/config-pool-keys.test.ts src/tests/codex-oauth-accounts.test.ts
bun run check:rbac-coverage && bun run check:openapi-response-coverage && bun run docs:openapi
cd apps/ui && bun run lint && bunx tsc -b
```

agent-browser: add 2 keys, remove 1, add a duplicate (409 text), add a key with a space (error text), list and remove a ChatGPT account. 1440 px and 390 px, with one recording.

## Gates before the PR

The merge-gate mirror from `CLAUDE.md`:

```bash
bun run check:local
bun run lint
bun run lint:slop
bun run tsc:check:tsc
bun run test:root -- --parallel=4
bun run e2e
bun run e2e:ui
bun run check:bun-version
bash scripts/check-db-boundary.sh
bash scripts/check-test-spawn-sync.sh
bash scripts/check-audit-columns.sh
bun run check:dep-graph
```

PR: risk `high` (migration, and a change in key selection for every pooled worker). Urgency: copied from Taras.

## Manual E2E

Local stack, host worker, no Docker. Taras gives one real setup token and one real Anthropic API key. I never print them, and they go into `swarm_config` only through the API.

```bash
# 1. API with a throwaway DB, from the worktree
mkdir -p /tmp/pr2-cv/home /tmp/pr2-cv/ws && git -C /tmp/pr2-cv/ws init -q
cd ~/worktrees/agent-swarm/2026-10-25-credential-validation
DATABASE_PATH=/tmp/pr2-cv/db.sqlite PORT=3913 MCP_BASE_URL=http://localhost:3913 APP_URL=http://localhost:5974 \
  AGENT_SWARM_API_KEY=pr2-local DESPLEGA_TELEMETRY_ENV=test SLACK_DISABLE=true GITHUB_DISABLE=true \
  JIRA_DISABLE=true LINEAR_DISABLE=true MULTI_RUNTIME_ENABLED=false NODE_ENV=development bun src/http.ts

# 2. UI
cd apps/ui && VITE_API_URL=http://localhost:3913 VITE_API_KEY=pr2-local bunx vite --port 5974 --strictPort

# 3. A pool of a real key and a fake key (inner value from a file, never echoed)
bun -e 'const v=(await Bun.file("/tmp/pr2-cv/anthropic-key").text()).trim()+",sk-ant-api03-"+"x".repeat(93);
await fetch("http://localhost:3913/api/config",{method:"PUT",headers:{Authorization:"Bearer pr2-local","Content-Type":"application/json"},
body:JSON.stringify({scope:"global",key:"ANTHROPIC_API_KEY",value:v,isSecret:true})}).then(r=>console.log(r.status))'

# 4. Host worker with a clean env (no CLIProxy ANTHROPIC_* vars) and a temp HOME
env -i PATH="$PATH" HOME=/tmp/pr2-cv/home MCP_BASE_URL=http://localhost:3913 AGENT_SWARM_API_KEY=pr2-local \
  AGENT_ID=$(uuidgen) AGENT_NAME=pr2-worker HARNESS_PROVIDER=claude \
  bun run ~/worktrees/agent-swarm/2026-10-25-credential-validation/src/cli.tsx worker --yolo

# 5. Check the report: ok true, a warning that names the fake key, and the fake key rejected
curl -s -H "Authorization: Bearer pr2-local" http://localhost:3913/api/agents | jq '.agents[] | {name, live: .credStatus.liveTest | {ok, warning, keys: [.keys[]? | {index, suffix, ok, httpStatus}]}}'
curl -s -H "Authorization: Bearer pr2-local" http://localhost:3913/api/keys/status | jq '.keys[] | {keyType, keyIndex, keySuffix, lastValidationError}'

# 6. Remove the fake key (PUT the real key alone). Within about 10 s: no warning, the rejected row is cleared.
# 7. PUT a fake subscription token as CLAUDE_CODE_OAUTH_TOKEN: the check fails with HTTP 401.
#    PUT Taras's real setup token: the check passes (403 permission_error path).
# 8. agent-browser walk of http://localhost:5974/setup (step AI) and /api-keys for each state.

# 9. Clean up
kill $(lsof -ti :3913 -sTCP:LISTEN) $(lsof -ti :5974 -sTCP:LISTEN); rm -rf /tmp/pr2-cv
```

## Executors

- Phases 1 to 3: Codex `gpt-6.1-sol` (`high`) in the worktree, one phase at a time. Claude reviews each diff and commits `[Phase N] <name>`.
- Phase 4 (UI) and the agent-browser QA: Claude (Opus).
- Final review: two-axis `desplega:code-reviewing`, then the gates, then the PR.
