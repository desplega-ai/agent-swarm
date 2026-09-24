---
date: 2026-09-24T20:11:20+02:00
researcher: Claude
git_commit: f55caf6d07fe7863f6af3385425ccadd42dd4c6f
branch: main
repository: desplega-ai/agent-swarm
topic: "First-run onboarding experience in apps/ui: open questions and file map"
tags: [research, ui, onboarding, codex-oauth, device-code, credentials, telemetry, status, memory, integrations]
status: complete
autonomy: critical
last_updated: 2026-09-24
last_updated_by: Claude
---

# Research: First-run onboarding experience in apps/ui

**Date**: 2026-09-24T20:11:20+02:00
**Researcher**: Claude
**Git Commit**: `f55caf6d0` (on `origin/main`)
**Branch**: main
**Spec**: `thoughts/taras/brainstorms/2026-09-17-ui-onboarding-experience.md` (decisions locked)
**Visual reference**: `mockups/onboarding/option-b-focused-flow/index.html` (round 2, locked), `mockups/onboarding/SPEC.md`

Permalink base for code references: `https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/<path>#L<n>`.

## Research Question

Answer the five Open Questions in the brainstorm, and map the UI and API files that a plan will touch:

1. Codex device-code flow, line-exact against `openai/codex` `codex-rs/login/src/device_code_auth.rs`, and how it maps onto `src/providers/codex-oauth/{flow,storage}.ts`.
2. How fast a worker re-checks credentials after a key lands in `swarm_config`, and what `POST /status/test-connection` exposes per provider.
3. The Vercel AI Gateway API key prefix.
4. The shape of `onboarding_state`, and whether it rides on `GET /status` or a separate `GET /api/onboarding`.
5. Which `src/telemetry.ts` helper to extend for the funnel, and whether `step_completed.method` needs a schema change.

Constraints from the spec: worker-reported verification for providers (no new API-side provider probes), one API-side embedding probe for memory, Codex device code primary with the npx CLI command as the only fallback, step 6 = agents list + wait for lead + ensure user + composer with `source: "ui"` + redirect to `/sessions/<taskId>`.

## Summary

All five questions have a factual answer. The Codex device-code flow is three POSTs against `https://auth.openai.com` with the same client id this repo already uses. The token exchange differs from the existing PKCE exchange in two values only: a fixed `redirect_uri` of `https://auth.openai.com/deviceauth/callback`, and a `code_verifier` that the server returns. `exchangeAuthorizationCode()` in `flow.ts` already takes `redirectUri` as a parameter, and `storeCodexOAuth()` already writes the slot record, so the device flow reuses both. Workers pick up a new slot on the next task, and a waiting worker picks it up within one backoff tick.

A worker in `waiting_for_credentials` re-reads `swarm_config` on an exponential backoff of 2 s to 30 s. The worst case from "key saved" to "rollup verified" is about 35 s. An idle worker that is already ready never re-checks a rotated key for the same provider. `POST /status/test-connection` is a read of worker reports, not a live probe. It returns `{ ok, error?, latency_ms }` only. `GET /api/agents` carries each agent's full `credStatus`, so the UI can count "N workers verified" itself. The Vercel AI Gateway key prefix is `vck_` (confirmed in an official Vercel doc code sample).

For state, a dedicated `GET/PUT /api/onboarding` fits the facts better than a `/status` field. The 404 feature-detect only works per route, `/status` has a closed milestone enum, and `StatusProvider` only mounts inside the app shell. Two facts need attention in the plan. A global `swarm_config` row is injected into the API `process.env`, into every worker env, and into the Secrets grid, with no filter. The locked rule "existing installs with any agents or tasks are auto-complete" also matches a fresh Compose install within about 90 s (see Flags). For telemetry, `track()` and the `telemetry.<namespace>()` wrappers accept any event name and any properties. Neither the client nor the receiving proxy validates them, so no schema change is needed. A closed enum for `method` is a local convention to add, following `install_method`.

## Answers to the Open Questions

### Q1. Codex device-code flow (line-exact)

**Pinned version.** This repo pins `@openai/codex@0.156.1` (`Dockerfile.worker:146,149`, `package.json:198`). All upstream line numbers below are at tag `rust-v0.156.1`. The flow at `main` (`a33fb975`) is the same. Only the HTTP client construction moved (per-endpoint proxy routing).

Upstream base: `https://github.com/openai/codex/blob/rust-v0.156.1/`.

| Item | Value | Upstream reference |
|---|---|---|
| Issuer | `https://auth.openai.com` (`DEFAULT_ISSUER`) | `codex-rs/login/src/server.rs:76` |
| Client id | `app_EMoamEEZ73f0CkXaXp7hrann` (`CLIENT_ID`) | `codex-rs/login/src/auth/manager.rs:1698` |
| Step A: create user code | `POST {issuer}/api/accounts/deviceauth/usercode`, JSON body `{ "client_id" }` | `device_code_auth.rs:36-39`, `:63-97` |
| Step A response | `device_auth_id`, `user_code` (alias `usercode`), `interval` | `device_code_auth.rs:27-34` |
| `interval` type | Sent as a string, trimmed and parsed to `u64`. Absent means `0`. | `device_code_auth.rs:32-53` |
| Step A 404 | Error "device code login is not enabled for this Codex server. Use the browser login or verify the server URL." | `device_code_auth.rs:81-93` |
| Verification URL | `{issuer}/codex/device` | `device_code_auth.rs:173-178` |
| Prompt text | "Enter this one-time code (expires in 15 minutes)" plus an anti-phishing line | `device_code_auth.rs:149-163` |
| Step B: poll | `POST {issuer}/api/accounts/deviceauth/token`, JSON body `{ "device_auth_id", "user_code" }` | `device_code_auth.rs:41-45`, `:99-147` |
| Poll cadence | Sleep `interval` seconds between polls, capped by remaining time | `device_code_auth.rs:137` |
| Poll timeout | 15 minutes (`15 * 60`), error "device auth timed out after 15 minutes" | `device_code_auth.rs:108`, `:132-136` |
| Poll status codes | 2xx = success. 403 or 404 = still pending. Any other status = fatal "device auth failed with status {status}". | `device_code_auth.rs:127-145` |
| Poll success body | `authorization_code`, `code_challenge`, `code_verifier` (server-issued PKCE pair) | `device_code_auth.rs:55-60` |
| Step C: exchange | `POST {issuer}/oauth/token`, form-encoded authorization-code grant, PKCE verifier from step B | `device_code_auth.rs:198-212`, `server.rs:709-828` |
| Exchange `redirect_uri` | `{issuer}/deviceauth/callback` | `device_code_auth.rs:202` |
| Exchange response | `id_token`, `access_token`, `refresh_token` | `server.rs:696-701` |
| Workspace gate | Optional `forced_chatgpt_workspace_id` check on the `chatgpt_account_id` claim | `device_code_auth.rs:215-220`, `server.rs:876-912` |
| Persistence | `persist_tokens_async` builds `AuthDotJson { auth_mode: Chatgpt, OPENAI_API_KEY: None, tokens, last_refresh: now }`. No API-key exchange. | `server.rs:830-874` |
| `account_id` | From the `id_token` claim `chatgpt_account_id` | `server.rs:849-854` |
| File path | `$CODEX_HOME/auth.json`, default `~/.codex/auth.json` | `auth/storage.rs:154-156`, `codex-rs/utils/home-dir/src/lib.rs:13-61` |
| `auth.json` shape | `auth_mode`, `OPENAI_API_KEY`, `tokens.{id_token, access_token, refresh_token, account_id}`, `last_refresh` | `auth/storage.rs:39-65`, `token_data.rs:10-42` |
| Default headers | `originator` (default `codex_cli_rs`) and `User-Agent` | `auth/default_client.rs:40`, `:339-349` |
| CLI entry | `codex login --device-auth` calls `run_login_with_device_code` (no browser fallback) | `cli/src/main.rs:531-532`, `:1731-1737`, `cli/src/login.rs:319-364` |
| Fallback variant | `run_login_with_device_code_fallback_to_browser` prints "Device code login is not enabled; falling back to browser login." on the step-A 404. It is not wired to `--device-auth`. | `cli/src/login.rs:370-441` |

Notes:
- The code has no specific message for the ChatGPT "Allow device code login" setting. The only coded gates are the step-A 404 and `CHATGPT_LOGIN_DISABLED_MESSAGE` ("ChatGPT login is disabled. Use API key login instead.", `cli/src/login.rs:40`). Inference: when the user's account does not allow device login, the block shows on the `auth.openai.com/codex/device` page, and the poll stays pending until the 15-minute timeout.
- With an absent `interval`, the upstream loop sleeps 0 s between polls (`device_code_auth.rs:137`).

**Mapping onto `src/providers/codex-oauth/*`.**

| Upstream step | Existing code in this repo | Fit |
|---|---|---|
| Client id | `CLIENT_ID` = same value, `flow.ts:27` | Same |
| Token endpoint | `TOKEN_URL` = `https://auth.openai.com/oauth/token`, `flow.ts:29` | Same |
| Step C exchange | `exchangeAuthorizationCode(code, verifier, redirectUri = REDIRECT_URI)`, `flow.ts:100-135`. Form body `grant_type=authorization_code, client_id, code, code_verifier, redirect_uri`. | Reusable. Pass `redirectUri = "https://auth.openai.com/deviceauth/callback"` and the server-issued `code_verifier`. |
| Result shape | `TokenResult { type, access, refresh, expires }`, `types.ts:33-37` | `id_token` from the response is dropped |
| `account_id` | `getAccountId(access)` reads `["https://api.openai.com/auth"].chatgpt_account_id` from the **access** token, `flow.ts:173-178` | Upstream reads it from the **id_token**. Same claim name, different token. |
| Steps A and B | Not present. No file matches `*device*` under `src/providers/codex-oauth/`, `src/http/`, or `apps/ui/`. | New functions |
| Slot record | `CodexOAuthCredentials { access, refresh, expires, accountId }`, `types.ts:5-10` | Device result converts to this shape |
| Store | `storeCodexOAuth(apiUrl, apiKey, creds, slot)` does `PUT /api/config` with `{ scope: "global", key: codex_oauth_<slot>, value: JSON, isSecret: true }`, `storage.ts:233-259` | Reusable. From API code, a direct `upsertSwarmConfig` call is also possible (see Q4 on the reload side effect). |
| Slot choice | CLI picks `--slot` or the first free index `0..100` via `loadAllCodexOAuthSlots`, `codex-login.ts:201-291`, `storage.ts:187-231` | Same logic applies |
| `auth.json` write | Never on the API. Workers write it per task: `resolveCodexOAuthCredentialInfo` → `materializeCodexAuthJson(..., { includeRefreshToken: false })`, `runner.ts:1731-1832`, `:1776`, called per spawn at `runner.ts:3539`. Boot seed in `docker-entrypoint.sh:157-293`. | No change needed |
| `auth.json` shape written | `{ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }`, `types.ts:21-31`, `auth-json.ts:82-98`. `id_token` is set to the access token. | Matches upstream shape |
| Refresh | `getValidCodexOAuth` with the cross-process lock `POST/DELETE /api/oauth/refresh-locks/{key}`, `storage.ts:377-470`, `src/http/oauth-locks.ts:33-93` | Unchanged |

Boundary facts: API code may import `src/providers/codex-oauth/*`. It already does (`src/http/codex-oauth-keep-warm.ts:28-29`, `src/http/oauth-locks.ts`). No rule in `scripts/check-db-boundary.sh:19-27` or `.dependency-cruiser.cjs:14-30` forbids that direction. `flow.ts` and `storage.ts` read no env and do not call `getApiKey()`. `auth-json-fs.ts` writes the local `~/.codex`, so it is worker-only by intent.

Discrepancy to check in the plan: `auth-json.ts:18-22` says the token endpoint never returns a real `id_token`. Upstream `ExchangedTokens` requires `id_token` on the authorization-code exchange (`server.rs:696-701`).

UI today: `codex-oauth-section.tsx` renders the npx command (`:42`, API URL from `resolveApiUrl()` at `:31-38`). Its status reads only the legacy `codex_oauth` key (`:29`, `:50`), not `codex_oauth_<N>` slots.

### Q2. Worker credential re-check cadence and the rollup

**Presence check vs live test.** Every `check*Credentials` predicate is presence-only (`claude-adapter.ts:47-56`, `codex-adapter.ts:195-228`, `devin-adapter.ts:42-53`, `dsh-adapter.ts:26-34`, `opencode-adapter.ts:68-98`, `claude-managed-adapter.ts:91-107`, dispatcher `provider-credentials.ts:119-131`). A second layer, `validateProviderCredentials` (`provider-credentials.ts:323-443`), runs one live GET when presence passes:

| Credential | Live test |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic `/v1/models` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Presence only (`presenceCheckOk()` = `{ ok: true, latency_ms: 0 }`, `provider-credentials.ts:242-244`) |
| Codex `auth.json` or `CODEX_OAUTH` | Presence only (`provider-credentials.ts:351-372`) |
| Codex `OPENAI_API_KEY` | OpenAI `/v1/models` |
| OpenRouter key (pi, opencode, dsh) | OpenRouter `/models` |
| Devin | Devin `/v3/self` |

The live test has a 5 s timeout (`LIVE_TEST_TIMEOUT_MS`). The report written to `agents.cred_status` (migration `055_agent_cred_status.sql:15`) is `{ ready, missing[], satisfiedBy, hint, liveTest: { ok, error, latency_ms, testedAt } | null, latestModel, reportedAt, reportKind: "boot" | "post_task", bedrock, acp }` (`buildCredStatusReport`, `provider-credentials.ts:469-510`).

**Wait loop.** A worker registers, then enters `awaitCredentials` (`runner.ts:5206-5217`, `credential-wait.ts:123-211`) unless `CRED_CHECK_DISABLE=1`. Each tick:
1. Reports `{ ready: false, missing }` via `PUT /api/agents/:id/credential-status`. This sets `agents.status = waiting_for_credentials` (`src/be/db/agents.ts:133-151`).
2. Sleeps. Backoff starts at `BOOT_INITIAL_BACKOFF_MS` = 2000, doubles, caps at `BOOT_MAX_BACKOFF_MS` = 30000. `BOOT_MAX_WAIT_SECONDS` = 0 means wait forever (`credential-wait.ts:88-104`).
3. Re-fetches `GET /api/config/resolved?agentId=…&includeSecrets=true` (`runner.ts:775`, `:792`), applies the env, re-reads `HARNESS_PROVIDER`, re-runs the presence check.

On ready, the runner builds a `kind: "boot"` report with the live test and sends `ready: true`. That write sets `status = idle` (`runner.ts:5290-5344`).

**Idle workers.** `refreshCredentialStatus` runs from the poll loop (`PollIntervalMs = 2000`, `runner.ts:4937`). It re-checks only when the provider changed, or when `ready !== true` and 30 s passed (`CREDENTIAL_RETRY_INTERVAL_MS`, `credential-refresh.ts:9`), or for pi Bedrock every 5 min (`:10`). A ready worker never re-checks a same-provider key rotation. `HARNESS_PROVIDER` reconciliation re-fetches `swarm_config` every 10 s (`HARNESS_RECONCILE_INTERVAL_MS`, `runner.ts:5003`, loop at `:5883`).

**`CRED_CHECK_DISABLE`.** Read by `isCredCheckDisabled` (`provider-credentials.ts:456-458`, value `"1"`). It skips the boot wait (`runner.ts:5214`) and all post-task reports (`credential-refresh.ts:32`). `cred_status` then stays `NULL`.

**Worst case, key saved to rollup `verified`:**

| Case | Worst case | Dominant constant |
|---|---|---|
| `ANTHROPIC_API_KEY`, worker waiting | about 35 s | 30 s backoff cap + 5 s live-test timeout |
| New `codex_oauth_<N>` slot, worker waiting | about 30 s | 30 s backoff cap (presence-only test) |
| Same-provider key rotated, worker already ready | Never re-verified | No trigger exists |

The codex slot arrives as a flattened `codex_oauth_<N>` env key through the same resolved-config fetch (`codex-adapter.ts:195-228`). `claude-managed` uses the same checker path as the other providers (`claude-managed-adapter.ts:91-107`). The brainstorm note that it reads `ANTHROPIC_API_KEY` once at boot refers to the adapter session, not the credential check.

**`POST /status/test-connection`.** Request `{ provider: ProviderName }` (`status.ts:176-178`). Response `{ ok, error?, latency_ms }` (`status.ts:180-184`). The handler (`status.ts:752-784`) reads `rollupCredStatusForProvider(provider)` and returns its freshest passing live test. It makes no upstream call. The route description at `status.ts:721-723` still says "Issues a real upstream call" (stale). The route sits in `ROUTE_RBAC_BACKLOG` (`scripts/check-rbac-coverage.ts:344`).

**Rollup** (`status.ts:228-276`):
- Input: all agents with `harness_provider = provider` (`listAgentsWithCredStatusByProvider`, `src/be/db/agents.ts:385-391`). No liveness filter.
- `verified`: at least one report with `liveTest.ok === true` and `testedAt` younger than `SWARM_VERIFY_TTL_MS` (default 1 h, `status.ts:211-217`).
- `configured`: at least one `ready: true` report without a fresh passing test.
- `unverified`: no reports, or none ready.
- Exposed counts: `workers` (all agents on that provider) and `reports` (agents with a report). There is no "verified count". The `/status` hint string reads like "2 workers · live test ok" (`describeRoll`, `status.ts:303-314`).

**For "N workers verified" on step 3:** `GET /api/agents` returns per agent `status` (`idle | busy | offline | waiting_for_credentials`, `types.ts:1056`), `isLead`, `provider`, `harnessProvider` (the rollup join key), `credentialMissing`, `credStatus` (full report), `lastActivityAt`, `lastUpdatedAt` (`types.ts:1077-1152`). There is no `lastHeartbeatAt` on `Agent`. The UI can count agents with `harnessProvider === p` and `credStatus.liveTest.ok`. "Alive" in `/status` means `lastActivityAt` in the last 5 min and `status != 'offline'` (`getLiveAgentCounts`, `src/be/db.ts:12624-12640`).

**Harness selection matters for step 3.** The rollup keys on the worker's `harness_provider`. `docker-compose.example.yml` sets `HARNESS_PROVIDER=${HARNESS_PROVIDER:-claude}` on every agent (`:288`, `:348`, …). A Codex, Devin, or OpenRouter key therefore verifies only when some worker runs that harness. A global `HARNESS_PROVIDER` row in `swarm_config` overlays the container env and swaps the adapter on the next 10 s reconcile (`runner.ts:4716-4726`, `:5883-5900`). `ProviderNameSchema` has no `openrouter` value, so the "Open harnesses" card verifies through the `pi`, `opencode`, or `dsh` rollups.

### Q3. Vercel AI Gateway key prefix

The prefix is `vck_`. The official page `vercel.com/docs/ai-gateway/authentication-and-byok/api-keys` shows the sample `'{ "secret": { "api_key": "vck_..." } }'` (fetched 2026-09-24). A secret-detector package encodes the same prefix (`pkg.go.dev/github.com/plenoai/pleno-dlp/pkg/detectors/vercelaigateway`). AI Gateway also accepts Vercel OIDC tokens and Vercel access tokens, which do not use `vck_`.

Related preset facts (web, 2026-09-24):

| Preset | Base URL | Model | Key prefix | Dims |
|---|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` | `sk-proj-` (also `sk-svcacct-`, legacy `sk-`) | 1536 native |
| OpenRouter | `https://openrouter.ai/api/v1` (`/embeddings`) | `openai/text-embedding-3-small` | `sk-or-v1-` | Same model |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` (`/embeddings`) | `openai/text-embedding-3-small` | `vck_` | Same model |
| Ollama (dropped, see R6) | `http://localhost:11434/v1` (`/embeddings`) | `nomic-embed-text` | none | 768 native |

OpenRouter embeddings GA vs beta status is unconfirmed (only the TypeScript SDK docs say "beta").

### Q4. `onboarding_state` shape and the read path

**Facts about the storage.**
- `swarm_config` (`001_initial.sql:246-259`, plus `encrypted` in `038`, audit columns in `082`) stores `value` as `TEXT`. The async helpers live in `src/be/db.ts`: `getSwarmConfigs` (`:6241-6267`), `upsertSwarmConfig` (`:6324-6416`), `deleteSwarmConfigByKey` (`:6452-6470`).
- `PUT /api/config` (`src/http/config.ts:228-249`, `rbac: config.write.any`) triggers `scheduleIntegrationsReload()` on every global write, with no key filter (`config.ts:422-428`). The debounce is 250 ms (`AUTO_RELOAD_DEBOUNCE_MS`, `src/http/core.ts:234`). The reload tears down and restarts Slack, GitHub, GitLab, Linear, Jira, AgentMail, and the embedding provider (`core.ts:143-220`).
- A direct `upsertSwarmConfig()` call from API code skips the reload. API telemetry init already does this for `telemetry_installation_id` (`src/http/index.ts:676-683`).
- **Env injection, no filter.** `loadGlobalConfigsIntoEnv()` copies every global row except the four reserved keys into the API `process.env` (`core.ts:65-113`, `getInjectableGlobalConfigs` at `db.ts:6274-6282`). Workers copy every resolved row into the task env (`runner.ts:839`). `stripApiOnlyKeys` removes only `API_AGENT_FS_API_KEY` and `SLACK_SIGNING_SECRET` from resolved config (`config.ts:40-44`).
- **UI visibility.** Settings → Configuration shows catalog keys only (`configuration-page.tsx:16-19`). Settings → Secrets renders every row with no key filter (`swarm-config-section.tsx`, `use-swarm-config.ts:178-197`). `telemetry_*` rows already show there today.
- No zod-validated JSON row exists. The one JSON precedent is `codex_oauth_<slot>`, parsed with a bare cast in a try/catch (`storage.ts:213-216`).

**Facts about `/status`.**
- `GET /status` (`status.ts:702-715`) requires the API key. It has no RBAC check, so any principal (operator, agent, user) can read it.
- `SetupMilestoneIdSchema` is a closed enum: `harness, embeddings, slack, github, linear, jira, gsc, agentmail, agentfs, workers, first_task` (`status.ts:48-60`). GitLab is absent.
- `StatusProvider` polls every 30 s and pauses on hidden tabs (`status-context.tsx:31-39`, `use-status.ts:17-51`). It mounts only inside the configured shell in `RootLayout` (`root-layout.tsx:40`).
- `api.fetchStatus()` maps 404 to `null` (`apps/ui/src/api/client.ts:622-630`). `fetchMetrics()` (`:606-613`) and `getAgentRuntime` (`:309-310`) follow the same pattern. The UI has no typed API error class for generic calls.
- The UI never renders `status.setup`. The header health badge navigates to `/#setup` (`app-header.tsx:69`), and no `#setup` anchor exists anywhere. The only `status.setup` consumer is `detectedFromStatus()` in `template-recommendations.ts:78-87`.

**Answer: a separate route.** Facts that point to `GET /api/onboarding` rather than a `/status` field:
1. The version gate is "route presence". A new `/status` field is field presence, and old APIs already serve `/status`.
2. `/setup` renders full page, outside `RootLayout`, where `StatusProvider` does not mount.
3. The milestone enum is closed, and `/status` is readable by agent principals.
4. The existing milestone builders are plain functions in `status.ts` (`rollupCredStatusForProvider`, `embeddingsMilestone`, `slackMilestone`, `githubMilestone`, `workersMilestone`, `firstTaskMilestone`, `buildSetup` at `:597-614`). A new route can call them and return stored state and live signals in one payload.

**Proposed shape (for the plan).** Stored row, key `onboarding_state`:

```jsonc
{
  "version": 1,
  "startedAt": "2026-09-24T18:00:00.000Z",   // first GET that created the row
  "currentStep": "ai",                        // connect | name | ai | memory | integrations | first_task
  "minimizedAt": null,                        // set by Minimize, cleared by Resume
  "dismissedAt": null,                        // "onboarding_dismissed"
  "completedAt": null,                        // "onboarding_completed"
  "autoCompleted": false,                     // true when marked complete for an existing install
  "firstTaskId": null,                        // task created by the step 6 composer
  "steps": {
    "connect":      { "status": "done",    "at": "…", "method": "api_key" },
    "name":         { "status": "done",    "at": "…", "method": "custom_name" },
    "ai":           { "status": "todo",    "at": null, "method": null },
    "memory":       { "status": "skipped", "at": "…", "method": null },
    "integrations": { "status": "todo",    "at": null, "method": null },
    "first_task":   { "status": "todo",    "at": null, "method": null }
  }
}
```

- Step `status`: `todo | done | skipped | failed` (from `SPEC.md`). `failed` also carries `errorClass` (enum).
- `method` values (closed enums): ai `claude_setup_token | claude_api_key | codex_device | codex_cli | openrouter | deepseek | devin`, memory `openai | openrouter | vercel | ollama | custom`, integrations `slack | github | gitlab | linear_oauth | jira_oauth`, first_task `suggestion | free_form`.

`GET /api/onboarding` response = `{ state, signals }`. `signals` is derived on every read, never stored:

```jsonc
{
  "providers": [ { "provider": "claude", "state": "verified", "workers": 3, "verifiedWorkers": 2 } ],
  "embeddings": { "configured": true },               // presence; the probe result is written into steps.memory
  "integrations": { "slack": "configured", "github": "unverified", "gitlab": false,
                    "linear": "verified", "jira": "unverified" },
  "agents": { "leadsOnline": 1, "workersOnline": 2 },
  "firstTask": { "id": "…", "status": "in_progress" } // only when firstTaskId is set
}
```

The header pill needs `done+skipped` over 6 and `currentStep`. The home card needs the six step statuses. `/setup` needs everything. All three render from this one read. `PUT /api/onboarding` takes a transition (`{ step, action: "view" | "complete" | "skip" | "fail", method?, errorClass? }` or `{ action: "minimize" | "resume" | "dismiss" }`), validates it, writes via `upsertSwarmConfig` (no reload), and emits telemetry.

Plan inputs from these facts:
- Keep `onboarding_state` out of env and out of the Secrets grid. The existing lever is the strip list pattern (`API_ONLY_CONFIG_KEYS`, `config.ts:40`) plus `getInjectableGlobalConfigs`. No general "internal key" mechanism exists. Resolved as R3: one shared internal-keys set.
- RBAC: no `onboarding.*` verb exists. `config.write.any` (`permissions.ts:144-147`, `leadOnly` for agents in `legacy-policy.ts:230`) is the nearest fit. GET routes need no `rbac`.
- Register in both `src/http/all-routes.ts` (side-effect import) and the dispatcher array in `src/http/index.ts:322-349`. Then run `bun run docs:openapi`.

### Q5. Telemetry helper and payload schema

**Helper to extend.** `track({ event, properties?, metadata? })` (`src/telemetry.ts:392-396`, `:435-497`) is the generic sender. The `telemetry` object (`:526-583`) holds thin wrappers (`taskEvent`, `server`, `session`, `schedule`, `workflow`, `agent`, `integration`, `compaction`). Each wrapper calls `track({ event: "<namespace>.<event>", properties })`. No `onboarding` namespace exists. The fit is a new `telemetry.onboarding(event, props)` wrapper, which yields `onboarding.started`, `onboarding.step_completed`, and so on.

**Schema change for `step_completed.method`: not required.**
- Client: `event` is a plain `string` (`:393`) and `properties` is `Record<string, unknown>`. Only `telemetry.integration()` enforces enums (`KNOWN_INTEGRATION_TYPES` `:146-152`, `INTEGRATION_PROVIDERS` `:154-200`).
- Receiver: the proxy repo (`/Users/taras/Documents/code/proxy`, `apps/telemetry-ingest/internal/httpapi/handler.go:97`, `validatePayload` at `:181-259`) checks only presence and `actor_mode`. The OpenAPI contract has `event: { type: string, minLength: 1 }` and `additionalProperties: true` for properties and metadata.
- A closed enum is a local convention. The precedent is `KNOWN_INSTALL_METHODS` + `_resolveInstallMethod` (`telemetry.ts:90`, `:105-110`). The same pattern fits `step` and `method`.

**Other facts the funnel needs.**
- Opt-out: `isEnabled()` = `isEnvFlagEnabled("ANONYMIZED_TELEMETRY", true)`, checked on every call (`:29-31`). No NODE_ENV or CI gate.
- Delivery: one fire-and-forget `fetch` per event, 5 s timeout, all errors swallowed, no batching (`:16`, `:488-493`).
- Payload: `{ product, event, occurred_at, source, actor_mode: "anonymous", actor_anonymous_id: installationId, properties, metadata }`. Caller properties spread first, so fixed cohort keys win. In `metadata`, caller keys spread **last**, so they can override fixed keys (`:476-486`).
- "Seconds since install": no code computes it. Every event already carries `metadata.install_created_at` when `installedAt` is set (`:484`), next to `occurred_at`. `installedAt` is minted only with a new installation id, so older installs have none (`:333-352`, `:380-390`). The docs point to `min(occurred_at)` per installation in ClickHouse (`telemetry.mdx:47`, `:66`). `installedAt` is module state with only a test getter (`_getInstalledAtForTests`, `:517-524`).
- API routes already emit telemetry inline (`src/http/agents.ts:689`, `src/http/poll.ts:434`, `:568`). No boundary script restricts importing `src/telemetry.ts`.
- Docs: new events need rows in `docs-site/content/docs/(documentation)/reference/telemetry.mdx:12-33`.
- Business-use has no onboarding flow. It is a separate system from `src/telemetry.ts`.

## Detailed Findings: file map by step

### Shell, routing, and version gate

| File | What exists | Relevance |
|---|---|---|
| `apps/ui/src/app/router.tsx:113-196` | One top-level route `/` with `RootLayout`. All pages are children. Lazy pages `:8-63`. `REDIRECTS` `:89-100`. Settings children `:153-171`. | A full-page `/setup` is a new top-level sibling entry. It needs its own `Suspense`. |
| `apps/ui/src/components/layout/root-layout.tsx:20-72` | `!isConfigured` renders a bare `WelcomeCard` (`:30-36`). Else the shell: `StatusProvider` (`:40`), `ConfigGuard`, header, sidebar. Mounts `NameConnectionModal`, `OrganizationNameDialog`, `LeadCredentialDialog`, `FeedbackDialog` (`:65-68`). | Step 1 takeover lives here today |
| `apps/ui/src/components/layout/config-guard.tsx:8-31` | Exempts `/settings/connections`. Redirects to it with `state.from` = path+search+hash. | Redirect target changes to `/setup` for new installs |
| `apps/ui/src/hooks/use-config.ts:71-164`, `:246-247` | One-shot `?apiUrl&apiKey&email&name` read with `replaceState`. `aswt_` tokens go to a tab-local embed connection. `VITE_API_URL` lock ignores URL creds. | Four contracts `/setup` must keep |
| `apps/ui/src/lib/config.ts:4-259` | `Connection { id, name, apiUrl, apiKey }`. Keys `agent-swarm-connections`, embed `agent-swarm-embed-connection` in sessionStorage. Mutations throw when deployment-locked (`:49-53`). | Step 1 storage |
| `apps/ui/src/pages/config/components/welcome-card.tsx:12-186` | Name, URL, key. Probes `/health` with bearer. `resolvePostConnectRedirect` (`:12-24`). | Redesigned as step 1 |
| `apps/ui/src/pages/settings/connections-page.tsx:14-49` | Safety-net `WelcomeCard` when unconfigured | Keep in sync |
| `apps/ui/src/app/providers.tsx:36-54` | `IdentityGate` pops the non-dismissable `IdentityModal` when API ≥ 1.76.0, not locked, and `needs-pick`. `Providers` wraps the whole router (`App.tsx:9-22`). | Pops on `/setup` too, before step 6 |
| `apps/ui/src/api/hooks/use-feature-gate.ts:28-43` | `useFeatureGate(min)`, version from `GET /health` via `useApiVersion()` (`use-stats.ts:29-39`) | Sessions and users need ≥ 1.76.0 |
| `apps/ui/src/api/client.ts:255-273`, `:622-630` | Class `ApiClient`, inline `fetch` per method, 404 → `null` pattern | Add `fetchOnboarding()` |
| `apps/ui/src/app/providers.tsx:13-22` | Global react-query `refetchInterval: 10000` | Default poll for step 3 and step 6 |

### Header pill, home card, Settings entry

| File | What exists | Relevance |
|---|---|---|
| `apps/ui/src/components/layout/app-header.tsx:31-169` | Right group: health badge (`/#setup` link, `:64-87`), `NotificationBell` (`:121`), GitHub link, theme toggle | Setup pill slots before the bell. The `/#setup` link is dangling today. |
| `apps/ui/src/components/ui/popover.tsx:7-39` | Radix popover wrapper, `w-72` default | Pill checklist popover |
| `apps/ui/src/pages/home/unified-home.tsx:40` | `DashboardNudges` above the timeline. No setup section. | Home card mount point, with `id="setup"` |
| `apps/ui/src/components/dashboard/dashboard-nudges.tsx:26-94` | Admin-only nudges, including "Make this dashboard yours" (`SWARM_ORG_NAME`, `:78-94`) | Overlaps step 2 |
| `apps/ui/src/components/shared/organization-name-dialog.tsx:20-109` | Auto-pops when `SWARM_ORG_NAME` is missing, dismissible | Overlaps step 2 |
| `apps/ui/src/pages/settings/settings-layout.tsx:36-46` | `SETTINGS_NAV` array | "Run setup again" entry |
| `apps/ui/src/components/ui/progress.tsx:1-26` | Radix linear progress, one usage | No stepper or checklist component exists |

### Step 2: Name your swarm

- Keys (`configuration-catalog.ts:954-1002`): `SWARM_ORG_NAME` (string, catalog default `"Swarm"`), `SWARM_BRAND_COLOR` (color), `SWARM_ORG_LOGO_URL` (string), `DASHBOARD_URL`, `SWARM_HIDE_CLOUD_PROMO`.
- The sidebar reads `status.identity` (`app-sidebar.tsx:357`, `:397-399`). `buildIdentity()` reads `process.env` (`status.ts:284-290`), so a saved name shows after the 250 ms reload and the next 30 s status poll.

### Step 3: AI provider

| File | What exists |
|---|---|
| `apps/ui/src/lib/integrations-catalog.ts:769-848` | `anthropic` holds both `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` (`credentialPool: true`). `openrouter` and `openai` hold one key each. |
| `apps/ui/src/lib/integrations-catalog.ts:1063-1074` | `codex-oauth` has `specialFlow: "codex-cli"`, `fields: []` |
| (absent) | No `devin` or `deepseek` catalog entries |
| `apps/ui/src/api/hooks/use-config-api.ts:100-156` | `useUpsertConfigsBatch()`: sequential PUTs, one toast, client-side reserved-key filter |
| `apps/ui/src/pages/integrations/[id]/page.tsx:241-328` | Dirty diffing and save, then `POST /api/config/reload` |
| `apps/ui/src/components/integrations/field-renderer.tsx:23-299` | Secret mask/replace UX, source chips, format warnings |
| `apps/ui/src/api/hooks/use-status.ts:53-58` | `useTestConnection` → `POST /status/test-connection`. Only other caller: `lead-credential-dialog.tsx:33-40`. |
| `apps/ui/src/components/integrations/codex-oauth-section.tsx:29-59` | npx snippet and legacy-key status |
| `apps/ui/src/components/shared/harness-icon.tsx:117-136` | Inline SVG per harness (`claude, claude-managed, codex, pi, opencode, devin, acp`) |
| `apps/ui/public/harness-logos/*`, `apps/ui/public/provider-logos/*` | 6 + 10 SVGs. Only `attio.svg` is referenced by code (`integrations-catalog.ts:569`). |

### Step 4: Memory (one API-side probe)

- `getEmbeddingProvider()` memoizes one `OpenAIEmbeddingProvider` (`src/be/memory/index.ts:6-13`). `resetEmbeddingProvider()` (`:23-25`) runs on config reload (`core.ts:168`). An off-to-on transition starts a re-embed backfill (`core.ts:181-186`).
- The constructor reads `EMBEDDING_API_KEY ?? OPENAI_API_KEY`, `EMBEDDING_MODEL ?? "text-embedding-3-small"`, `EMBEDDING_API_BASE_URL` (`openai-embedding.ts:19-43`). The `openai` SDK appends `/embeddings`.
- `embed(text)` returns `Float32Array | null`. It never throws. Errors go to the server log only (`openai-embedding.ts:45-74`). No timeout is set, so the SDK default of 600 000 ms applies.
- Dimensions are fixed at module load: `EMBEDDING_DIMENSIONS` default **512** (`constants.ts:81`). The value is not part of the reload. `memory_vec` bakes it into its DDL (`sqlite-store.ts:242-285`). A length mismatch makes `embed()` return `null` (`openai-embedding.ts:62-67`) and storage skip the row (`sqlite-store.ts:365`, `:377`, `:1060`).
- Closest one-string pattern: `POST /api/memory/search` calls `provider.embed(query)` (`src/http/memory.ts:672-674`). `GET /api/memory/health` (`:284-294`) is structural only.
- `/status` reports embeddings by `isConfigured()` only (`status.ts:390-409`), so the milestone never reaches `verified`.

### Step 5: Integrations

| Item | Fact |
|---|---|
| `finalRedirect` | `buildAuthorizationUrl(config, { finalRedirect })` stores it on the `oauth_pending` row (`src/oauth/wrapper.ts:61-99`). The callback appends `oauth=success` or `oauth=error&error…` (`src/http/oauth-callback.ts:165-311`). |
| Redirect guard | `redirectWith()` accepts any `http`/`https` URL (`oauth-callback.ts:104-126`). No origin allowlist. `DASHBOARD_URL` and CORS are not consulted. |
| Tracker callers | `getLinearAuthorizationUrl()` (`src/linear/oauth.ts:19-27`) and `getJiraAuthorizationUrl()` (`src/jira/oauth.ts:22-30`) pass `{ flow: "tracker", label: "default" }` only. Today's only `finalRedirect` caller is `POST /api/oauth-apps/{id}/authorize-url` (`script-connections.ts:2377-2384`). |
| Tracker routes | `GET /api/trackers/{linear,jira}/authorize` are unauthenticated 302s. They return 503 when `*_CLIENT_ID` is missing (`trackers/linear.ts:41-53`, `trackers/jira.ts:79-91`). Status schemas: `linear.ts:20-27`, `jira.ts:31-45`. |
| Callback URL | `{LINEAR,JIRA}_REDIRECT_URI ?? getPublicMcpBaseUrl() + "/api/trackers/{p}/callback"` (`src/linear/app.ts:42-44`, `src/jira/app.ts:45-46`, `src/utils/constants.ts:66-71`) |
| Hot reload | A saved `LINEAR_CLIENT_ID` takes effect after the 250 ms reload (`core.ts:207-211`) |
| UI OAuth | `window.open(authorizeUrl, "_blank")` plus `refetchOnWindowFocus` (`linear-oauth-section.tsx:54-56`, `use-linear-status.ts:88-101`, `use-jira-status.ts:111`) |
| Status sources | `getAutomationSetupStates()` (`src/be/automation-preflight.ts:264-311`). Slack is `configured` at most, never `verified` (`status.ts:411-445`). GitHub is `verified` when webhook secret, App id, and private key exist (`status.ts:447-463`). No GitLab milestone. `isGitLabEnabled()` = `GITLAB_WEBHOOK_SECRET` present (`src/gitlab/auth.ts:15-17`). No test route for Slack, GitHub, or GitLab. |
| UI status | `integrations-status.ts:67-167` derives `configured | partial | disabled | none` from config rows and env presence |
| Slack manifest | `slack-manifest.json` (110 lines): name `agent-swarm`, bot `Agent Swarm`, socket mode on, two slash commands. `redirect_urls` point to `/api/integrations/slack/callback`, which no route serves. Only E2E scripts read the file. |
| Docs | `docs-site/content/docs/(documentation)/integrations/{slack,github,gitlab,linear,jira}.mdx` |

### Step 6: First message

| Item | Fact |
|---|---|
| Agents list | `apps/ui/src/pages/agents/page.tsx:28-228` (`useAgents()` → `GET /api/agents`), `HarnessCell` + `HarnessIcon`, `StatusBadge` |
| Lead readiness | `/status` `workers` milestone and `activity.leads_online` (`getLiveAgentCounts`, 5 min, `status != offline`) |
| User create | `IdentityModal` create form: name (required) + email (`identity-modal.tsx:73-88`, `:164-183`) → `POST /api/users` (`client.ts:2504-2515`). Route body `name` required, rest optional (`src/http/users.ts:191-221`). In `ROUTE_RBAC_BACKLOG` (`check-rbac-coverage.ts:330`). No lookup-by-email route. |
| Current user | Stored per API URL as `swarm:v1:${apiUrl}:current-user` (`current-user-context.tsx:16`, `:55`, `:86`). `useCurrentUser()` at `:231-237`. |
| Composer | `NewSessionView` (`new-session-view.tsx:28-183`). `SUGGESTIONS` (`:21-26`) is not exported. `api.createTask({ task, requestedByUserId, source: "ui", draft })` (`:76-81`), then `navigate("/sessions/" + id)` (`:104`). `ComposerDock` is exported (`composer-dock.tsx:118-137`). The ≥ 1.76.0 gate lives in `pages/sessions/page.tsx:16-32`. |
| Task create | `POST /api/tasks` (`src/http/tasks.ts:216-272`, handler `:792-918`). Default `source` is `"api"` (`:874`). With no `agentId`, the task goes to the lead as `pending` (`:817-827`, `db.ts:2276-2285`), or to the pool as `unassigned` when no lead exists. Response 201 is the task object (`:904`). |
| `requestedByUserId` | Trusted identity first. Body value accepted when `TRUST_BODY_REQUESTED_BY_USER_ID !== "false"` and the user exists (`tasks.ts:801-815`). |
| Completion | `TERMINAL_TASK_STATUSES` (`types.ts:286-291`). The session page polls every 10 s (global default) and uses `TERMINAL_STATUSES` (`session-timeline.tsx:32`). |
| First completed task | `hasFirstCompletedTask()` is a `LIMIT 1` probe on any completed task (`db.ts:12722-12731`). `completeTask()` emits `task.completed` on the workflow event bus in `afterCommit` (`src/be/db/tasks/write.ts:405-422`). |

## Flags found during research

These are factual conflicts or gaps between the spec and the code. They do not reopen decisions. They are inputs for the plan.

1. **(Resolved: R1.) The "existing install" auto-complete rule matches fresh Compose installs.** Agents register before credentials exist (`runner.ts:5206-5217`), and Compose starts one lead and workers at boot. The heartbeat also creates a `boot-triage` task for the lead 90 s after API boot (`src/heartbeat/heartbeat.ts:1690`, `:1635-1672`) unless `HEARTBEAT_CHECKLIST_DISABLE` is set. So "any agents or tasks" is true on a new install before the first dashboard visit. R1 defines the replacement signal.
2. **`first_task` can complete without the operator.** The lead completes `boot-triage` once credentials land, and `hasFirstCompletedTask()` then returns true. Step 6 completion should key on the stored `firstTaskId` from the composer, not on the global milestone.
3. **(Resolved: R3.) `onboarding_state` in `swarm_config` leaks.** It lands in the API `process.env`, every worker task env, and the Secrets grid (Q4).
4. **(Resolved: R2.) Step 3 verification depends on the worker harness.** A Codex, Devin, or OpenRouter key verifies only when a worker runs that harness. Compose defaults every agent to `claude` (Q2).
5. **Some "verified" states are presence-only.** The Claude setup token and Codex `auth.json` pass with `latency_ms: 0` and no upstream call (Q2).
6. **A rotated key on a ready worker is never re-verified** until a provider change or restart (Q2).
7. **(Partly resolved: R6.) Embedding probe pitfalls.** `embed()` returns `null` instead of throwing, has no timeout (600 s SDK default), and requires the stored dimension (default 512). The mockup copy "1536 dims" does not match the default. Ollama `nomic-embed-text` is natively 768 dims. `EMBEDDING_DIMENSIONS` changes need a restart and a matching `memory_vec` table.
8. **Name default mismatch.** The spec default is `Your Swarm`. The catalog default for `SWARM_ORG_NAME` is `"Swarm"`. `OrganizationNameDialog` and the org-name nudge also prompt for this key.
9. **Doc drift.** `/status/test-connection` description (`status.ts:721-723`) says it makes an upstream call. `codex-oauth.mdx:51-55`, `:137` cite the log line "Restored codex OAuth credentials", while the entrypoint logs "[entrypoint] Seeded codex OAuth credentials (slot 0)" (`docker-entrypoint.sh:273`).
10. **`codex-oauth-section.tsx` status reads only the legacy `codex_oauth` key**, not `codex_oauth_<N>` slots.
11. **`id_token` discrepancy** between `auth-json.ts:18-22` and upstream `ExchangedTokens` (Q1).
12. **`slack-manifest.json` redirect URLs** point to a route that does not exist.

## Delivery slices (from the brainstorm Next Steps) mapped to files

| Slice | Scope | Files |
|---|---|---|
| 1 | `/setup` shell, `onboarding_state`, telemetry, steps 1 to 6 on today's flows (Codex via npx), header pill, home card, version gate | UI: `router.tsx`, `root-layout.tsx`, `config-guard.tsx`, `use-config.ts`, `welcome-card.tsx`, `connections-page.tsx`, `app-header.tsx`, `unified-home.tsx`, `dashboard-nudges.tsx`, `organization-name-dialog.tsx`, `settings-layout.tsx`, `providers.tsx`, `client.ts`, new `use-onboarding` hook, `integrations-catalog.ts`, `integrations-status.ts`, `use-config-api.ts`, `field-renderer.tsx`, `linear-oauth-section.tsx`, `jira-oauth-section.tsx`, `codex-oauth-section.tsx`, `new-session-view.tsx`, `composer-dock.tsx`, `identity-modal.tsx`, `current-user-context.tsx`, `agents/page.tsx`, `harness-icon.tsx`, `popover.tsx`, `progress.tsx`. API: new `src/http/onboarding.ts`, new embed-probe route, `all-routes.ts`, `index.ts`, `status.ts` (reuse builders), `config.ts` (strip list), `core.ts`, `db.ts`, `memory/index.ts`, `openai-embedding.ts`, `oauth/wrapper.ts`, `linear/oauth.ts`, `jira/oauth.ts`, `trackers/{linear,jira}.ts`, `telemetry.ts`, `rbac/permissions.ts` (if a new verb), `openapi.json`, `telemetry.mdx`. |
| 2 | Codex device-code login | `src/providers/codex-oauth/flow.ts` (steps A and B), `types.ts`, `storage.ts`, new API route(s) for start and poll, `codex-oauth-section.tsx`, `codex-oauth.mdx`, tests next to `src/tests/codex-oauth*.test.ts` |
| 3 | Slack manifest pre-fill and brand SVGs | `slack-manifest.json`, a manifest builder that injects the swarm name, new SVGs under `apps/ui/public/` (Slack, GitHub, GitLab, Linear, Jira, Vercel) |

## Code References

| File | Line | Description |
|---|---|---|
| [`src/providers/codex-oauth/flow.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/providers/codex-oauth/flow.ts#L100-L135) | 100-135 | `exchangeAuthorizationCode` with `redirectUri` parameter |
| [`src/providers/codex-oauth/storage.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/providers/codex-oauth/storage.ts#L233-L259) | 233-259 | `storeCodexOAuth` slot write |
| [`src/commands/runner.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/commands/runner.ts#L1731-L1832) | 1731-1832 | Per-task codex slot pick and `auth.json` write |
| [`src/commands/credential-wait.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/commands/credential-wait.ts#L88-L104) | 88-104 | Boot backoff constants |
| [`src/commands/credential-refresh.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/commands/credential-refresh.ts#L9-L70) | 9-70 | Steady-state re-check gate |
| [`src/commands/provider-credentials.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/commands/provider-credentials.ts#L323-L443) | 323-443 | Live tests per provider |
| [`src/http/status.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/http/status.ts#L228-L276) | 228-276 | `rollupCredStatusForProvider` |
| [`src/http/status.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/http/status.ts#L752-L784) | 752-784 | `test-connection` handler (read-only rollup) |
| [`src/http/status.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/http/status.ts#L597-L614) | 597-614 | `buildSetup` milestone builders |
| [`src/http/config.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/http/config.ts#L422-L428) | 422-428 | Unconditional reload on global writes |
| [`src/http/config.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/http/config.ts#L40-L44) | 40-44 | `API_ONLY_CONFIG_KEYS` strip list |
| [`src/http/core.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/http/core.ts#L65-L113) | 65-113 | `loadGlobalConfigsIntoEnv` |
| [`src/be/db.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/be/db.ts#L12722-L12731) | 12722-12731 | `hasFirstCompletedTask` |
| [`src/heartbeat/heartbeat.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/heartbeat/heartbeat.ts#L1635-L1690) | 1635-1690 | Boot-triage task at T+90 s |
| [`src/be/memory/providers/openai-embedding.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/be/memory/providers/openai-embedding.ts#L45-L74) | 45-74 | `embed()` null-on-error |
| [`src/be/memory/constants.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/be/memory/constants.ts#L81) | 81 | `EMBEDDING_DIMENSIONS` default 512 |
| [`src/oauth/wrapper.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/oauth/wrapper.ts#L77-L99) | 77-99 | `buildAuthorizationUrl` with `finalRedirect` |
| [`src/http/oauth-callback.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/http/oauth-callback.ts#L104-L126) | 104-126 | `redirectWith` scheme guard |
| [`src/http/tasks.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/http/tasks.ts#L801-L827) | 801-827 | `requestedByUserId` trust and lead default |
| [`src/telemetry.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/telemetry.ts#L435-L497) | 435-497 | `track()` generic sender |
| [`src/telemetry.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/src/telemetry.ts#L526-L583) | 526-583 | `telemetry.<namespace>` wrappers |
| [`apps/ui/src/api/client.ts`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/apps/ui/src/api/client.ts#L622-L630) | 622-630 | `fetchStatus` 404 → `null` |
| [`apps/ui/src/components/layout/root-layout.tsx`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/apps/ui/src/components/layout/root-layout.tsx#L30-L68) | 30-68 | Unconfigured takeover and shell |
| [`apps/ui/src/components/layout/app-header.tsx`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/apps/ui/src/components/layout/app-header.tsx#L64-L121) | 64-121 | Health badge and bell |
| [`apps/ui/src/components/sessions/new-session-view.tsx`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/apps/ui/src/components/sessions/new-session-view.tsx#L63-L106) | 63-106 | Composer task create and redirect |
| [`apps/ui/src/app/providers.tsx`](https://github.com/desplega-ai/agent-swarm/blob/f55caf6d07fe7863f6af3385425ccadd42dd4c6f/apps/ui/src/app/providers.tsx#L36-L54) | 36-54 | `IdentityGate` auto-pop |

Upstream Codex: [`device_code_auth.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/login/src/device_code_auth.rs), [`server.rs#L695-L874`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/login/src/server.rs#L695-L874), [`auth/manager.rs#L1697-L1705`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/login/src/auth/manager.rs#L1697-L1705), [`auth/storage.rs#L39-L65`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/login/src/auth/storage.rs#L39-L65), [`auth/default_client.rs#L339-L349`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/login/src/auth/default_client.rs#L339-L349).

## Resolved in review (Taras, 2026-09-24)

| # | Question | Decision | Facts the plan uses |
|---|---|---|---|
| R1 | Existing-install signal (Flag 1) | An install is existing when real work exists: a completed task whose `taskType` is not `boot-triage` or `heartbeat-checklist`, OR a task with `requestedByUserId` set, OR any user row. Check once, when the `onboarding_state` row is first created. | Heartbeat tasks get the default `source: "mcp"` (`db.ts:2639`, `:2729`), so `source` cannot filter them. `taskType` can (`heartbeat.ts:1445`, `:1667`). `agent_tasks.requestedByUserId` has a partial index (`031_user_registry.sql:27-28`). No boot path creates users. |
| R2 | Harness choice in step 3 (Flag 4) | Confirmed switch, **per worker, never global**. When no worker runs the chosen harness, the card says so and offers a switch for selected workers. | `PATCH /api/agents/{id}/harness-provider` exists (`src/http/agents.ts:167-184`). It writes an agent-scoped `HARNESS_PROVIDER` row, and the worker swaps within about 10 s. No UI calls it today. |
| R3 | Keep `onboarding_state` internal (Flag 3) | One shared internal-keys set. Env injection skips it (API and workers), `/api/config/resolved` strips it, and the Secrets grid hides it. Writes go through `upsertSwarmConfig`, so no reload runs. | Levers: `getInjectableGlobalConfigs` (`db.ts:6274-6282`), `stripApiOnlyKeys` (`config.ts:40-44`), `useSwarmConfigTable` (`use-swarm-config.ts:178-197`). |
| R4 | Device flow state location | Swarm KV with a 15-min TTL. The state survives API restarts and deploys. | `device_auth_id` and `user_code` stay server-side. The browser gets a flow id only. |
| R5 | Device flow `originator` | Send `agent-swarm`, the same as the PKCE flow. The manual E2E checks that OpenAI accepts it. | Upstream default is `codex_cli_rs` (`auth/default_client.rs:40`). |
| R6 | Memory presets vs dimensions (Flag 7) | Drop the Ollama preset. Ship OpenAI, OpenRouter, Vercel AI Gateway, and Custom. | Storage dimension is fixed at `EMBEDDING_DIMENSIONS` (default 512). The mockup copy "1536 dims" must show the stored dimension. Brand SVGs for slice 3 no longer need Ollama. |
| R7 | Custom OpenAI-compatible endpoint in the "Open harnesses" card | Support it. The card gets an "OpenAI-compatible gateway" option: base URL + key, written to `OPENROUTER_BASE_URL` + `OPENROUTER_API_KEY`. This is the existing gateway mechanism (the cloud offering already uses it). | See "Custom OpenAI-compatible gateway" below. |

### Custom OpenAI-compatible gateway (facts for R7)

- **Mechanism.** `OPENROUTER_BASE_URL` reroutes every OpenRouter consumer. It is not a generic OpenAI base-URL switch: the key must be named `OPENROUTER_API_KEY`, and the target must accept OpenRouter-shaped requests. Resolver: `getOpenRouterBaseUrl()`, default `https://openrouter.ai/api/v1` (`src/utils/openrouter-base-url.ts:15`, `:22-28`). Validator: http(s), no query or fragment, blank reverts (`src/be/swarm-config-guard.ts:198-219`).
- **Harnesses.** opencode writes `provider.openrouter.options.baseURL` into the per-task config (`opencode-adapter.ts:180-196`, env mirror `:867-883`). pi writes `providers.openrouter.baseUrl` into `models.json` with a revert marker (`pi-mono-adapter.ts:442`, called at `:1200`). dsh uses it only for `openrouter/<model>` models (`dsh-adapter.ts:171-218`). claude, claude-managed, codex, devin, and acp do not use it.
- **API-side consumers too.** The same resolver feeds `src/utils/internal-ai/complete-structured.ts`, `src/workflows/executors/workflow-llm.ts`, and `src/be/memory/raters/llm-summarizer.ts`. Setting it globally reroutes those API-side LLM calls as well.
- **Model id.** Gateway models are selected with `MODEL_OVERRIDE=openrouter/<gateway-model-id>` (`docs-site/content/docs/(documentation)/guides/provider-auth/model-gateways.mdx:32-193`).
- **Verification.** The pi and opencode live test calls `${getOpenRouterBaseUrl()}/models` (`provider-credentials.ts:259-270`, dispatch `:389`), so step 3 verifies the custom endpoint. dsh is presence-only (`:423-430`). A key under any other name fails the presence check (`provider-credentials.ts:96-107`).
- **UI today.** `OPENROUTER_BASE_URL` is on Settings → Configuration as "OpenAI-compatible model gateway" (`configuration-catalog.ts:359-368`). The `openrouter` integration card has only the key (`integrations-catalog.ts:805-825`).
- **History.** PR #1010 (`cb6c4556a`, gateway routing), PR #1383 (`0e5c28f8e`, docs + Settings control), PR #1570 (`20f02bdbf`, dsh wiring).
- **Cloud mismatch.** `agent-swarm-internal` pushes `OPENROUTER_BASE_URL` + `OPENROUTER_API_KEY` in gateway mode (`packages/backend/convex/wallet/openrouterEnvPlan.ts:49-86`). Its pi "OpenAI-compatible" onboarding option also sends `PI_API_KEY`, `PI_BASE_URL`, `PI_MODEL` (`buildDeployConfig.ts:15-22`). No code in agent-swarm reads those three names.

## Open Questions

- Do OpenRouter and Vercel AI Gateway honor the `dimensions` parameter at 512 for `openai/text-embedding-3-small`? The step-4 probe detects a mismatch (`embed()` returns `null`), so the manual E2E settles it.
- Is OpenRouter embeddings GA or beta? Only the TypeScript SDK docs say "beta".
- R7 gateway option: `OPENROUTER_BASE_URL` is global and also reroutes API-side LLM calls. Should the card also collect a gateway model id and write `MODEL_OVERRIDE`, and at which scope (global or per worker, like R2)?
- The cloud repo's `PI_API_KEY` / `PI_BASE_URL` / `PI_MODEL` path has no reader in agent-swarm. Is it dead code or an unshipped feature?

## Appendix

- **Architecture notes**: The API server owns the DB. Workers read config over HTTP (`GET /api/config/resolved`). New non-GET routes must declare `rbac`. New handler files register in `src/http/all-routes.ts` and the `src/http/index.ts` dispatcher, then `bun run docs:openapi`. Post-commit hooks use `getDbClient().afterCommit`.
- **Method**: 11 research agents plus 10 adversarial verifiers (21 total). Verifiers confirmed 112 claims and corrected 2 (both in telemetry, applied above). The Vercel prefix, the Codex headers, the rollup code, `HARNESS_PROVIDER` reconciliation, the `IdentityGate`, and the boot-triage task were re-checked directly.
- **Historical context (from thoughts/)**:
  - `thoughts/taras/plans/2026-04-10-codex-oauth-support.md`: original PKCE `codex-login` plan (constants, `auth.json`, storage).
  - `thoughts/taras/plans/2026-05-06-worker-credential-safe-loop.md` and `thoughts/taras/qa/2026-05-06-worker-credential-safe-loop.md`: credential predicates, 2 s to 30 s boot wait, `waiting_for_credentials`.
  - `thoughts/taras/plans/2026-04-21-integrations-ui.md`: catalog-driven Integrations page and status derivation.
  - `thoughts/taras/plans/2026-03-20-setup-cli-onboarding.md` and `thoughts/taras/brainstorms/2026-03-20-setup-cli-onboarding.md`: CLI `agent-swarm onboard` wizard.
  - `thoughts/shared/research/2025-12-22-setup-experience-improvements.md`: early first-run barriers research.
  - `thoughts/taras/plans/2026-07-21-connections-redesign/`: `oauth_apps`, `oauth_pending`, static callback, `finalRedirect` origin.
- **Related research**:
  - `thoughts/taras/research/2026-09-16-swarm-branding-and-gamification.md`: branding keys and the Slack manifest deferral.
