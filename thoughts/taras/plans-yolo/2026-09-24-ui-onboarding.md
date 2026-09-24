---
date: 2026-09-24T21:30:00Z
topic: "First-run UI onboarding (/setup stepper, onboarding_state, Codex device login, Slack manifest)"
status: in-progress
---

# First-run UI onboarding

Sources: `thoughts/taras/research/2026-09-24-ui-onboarding-experience.md` (R1-R7, delivery slices),
`thoughts/taras/brainstorms/2026-09-17-ui-onboarding-experience.md` (Synthesis), visual reference
`mockups/onboarding/option-b-focused-flow/index.html` + `mockups/onboarding/SPEC.md` (round 2).
Scope exception to the one-shot gate granted by Taras (2026-09-24): all 3 slices in one run.

## Goal

A first run against a supporting API lands on a full-page `/setup` stepper (6 steps: connect, name,
ai, memory, integrations, first_task). Progress lives server-side in an internal `onboarding_state`
`swarm_config` row behind `GET/PUT /api/onboarding`. The API emits the funnel telemetry. Minimize
collapses to a header Setup pill and a home card. Codex signs in from the dashboard via device code.
The Slack step shows a manifest pre-filled with the swarm name. Older APIs (404 on
`/api/onboarding`) keep today's behavior. Existing installs never see the stepper.

## Decisions

- Scope: one-shot with an explicit exception, ~8 phases, commit per phase (asked).
- `GET /api/onboarding` derives `connect`, `ai`, `integrations`, `first_task` from live signals on
  every read and persists changes. UI `PUT complete` records the precise method first when the UI
  sees the signal. First writer wins. (assumed: keeps the pill and home card truthful while
  minimized)
- Memory: one route `POST /api/onboarding/memory` = test candidate values, then on success write
  `EMBEDDING_*` rows + schedule reload + mark the step. Handles "reuse key" server-side, so the UI
  never needs a secret value. (assumed)
- Codex device flow: routes under `/api/codex-oauth/device` (reusable by Settings). Poll is a
  `POST .../{flowId}/poll` (it has side effects). Flow state in KV namespace `codex-oauth-device`,
  15 min TTL, value encrypted with the swarm secrets key (KV is readable by agents; the
  `device_auth_id` + `user_code` pair can mint a token). (R4, R5)
- Linear/Jira `finalRedirect`: `/api/trackers/{p}/authorize?redirect=<url>` accepted only when the
  URL origin passes `isOriginAllowedForCredentials`. Otherwise ignored (static "close this tab"
  page, today's behavior). Onboarding navigates in the same tab. (assumed: closes the open-redirect)
- Step 6 minimizes onboarding before it opens the session page, so a reload there does not bounce to `/setup`. (assumed)
- `OnboardingRedirect` is a landing rule: `/setup` marks itself visited, so in-app links out of setup do not bounce. (shell agent)
- `BrandLogo` is decorative (`aria-hidden`); every call site shows the name as text. (assumed)
- UI `ProviderName` gains `dsh`; `Agent` gains `lastActivityAt`. (contract gap found by agents)
- Pre-existing `check:tokens` failure on main (`configuration-row.tsx` `#000000`, from #1587) fixed in its own commit so the PR's ui-lint passes. (assumed)
- Slack manifest: API route builds it from the root `slack-manifest.json` (single source), injects
  the name, drops the dead `oauth_config.redirect_urls`. (assumed)
- `IdentityGate` moves from `Providers` into the `RootLayout` shell, so it never pops on `/setup`
  (step 6 handles the user inline). (assumed)
- `OrganizationNameDialog` + the org-name nudge are suppressed while onboarding is open. (assumed)
- Step 2 default name `Your Swarm` when `SWARM_ORG_NAME` is unset (spec wins over catalog default
  `Swarm`). (assumed)
- RBAC: every non-GET onboarding/device route uses `config.write.any` via the exported
  `ensureConfigAdmin` from `src/http/config.ts`. (research Q4)

## API contract (source of truth for API + UI)

### Internal config keys (R3)

`INTERNAL_CONFIG_KEYS = new Set(["onboarding_state"])` + `isInternalConfigKey(key)` in
`src/be/swarm-config-guard.ts`. Effects:
1. `getInjectableGlobalConfigs` (`src/be/db.ts`) excludes them (API `process.env`).
2. `stripApiOnlyKeys` in `src/http/config.ts` also strips them: covers `GET /api/config` (Secrets
   grid) and `GET /api/config/resolved` (worker env).
3. `PUT /api/config` rejects them with 400 ("managed by /api/onboarding").
Writes go through `upsertSwarmConfig` directly, so no integrations reload runs.

### State row `onboarding_state` (global, not secret, JSON)

```ts
type StepId = "connect" | "name" | "ai" | "memory" | "integrations" | "first_task";
type StepStatus = "todo" | "done" | "skipped" | "failed";
type ErrorClass = "auth" | "network" | "timeout" | "dimension" | "model" | "not_enabled" | "expired" | "unknown";
interface StepState { status: StepStatus; at: string | null; method: string | null; errorClass: ErrorClass | null }
interface OnboardingState {
  version: 1;
  startedAt: string;            // ISO, when the row was created
  currentStep: StepId;          // default "connect"
  minimizedAt: string | null;
  dismissedAt: string | null;
  completedAt: string | null;   // set when first_task becomes done
  autoCompleted: boolean;       // R1 existing install
  firstTaskId: string | null;
  steps: Record<StepId, StepState>;
}
```

Method enums (closed, validated on write):
- connect: `api_key`
- name: `custom_name | default_name`
- ai: `claude_setup_token | claude_api_key | codex_device | codex_cli | openrouter | openai_gateway | deepseek | devin`
- memory: `openai | openrouter | vercel | custom | existing`
- integrations: `slack | github | gitlab | linear_oauth | jira_oauth`
- first_task: `suggestion | free_form`

Row creation (first `GET`), inside one `getDbClient().transaction`: read row; if absent, compute
R1 `existing` = any user row, OR any task with `requestedByUserId IS NOT NULL`, OR any
`status = 'completed'` task whose `taskType` is not `boot-triage` / `heartbeat-checklist`
(NULL taskType counts as real work). Existing install: `autoCompleted: true`, `completedAt: now`,
all steps `todo`. Emit `onboarding.started { existing_install }` via `afterCommit`.
A row that fails to parse or has the wrong version is replaced by a fresh row (no R1 re-check,
`autoCompleted: false`).

### `GET /api/onboarding` → 200 `{ state, signals }`

```ts
interface OnboardingSignals {
  providers: Array<{ provider: ProviderName; state: "unverified" | "configured" | "verified"; workers: number; verifiedWorkers: number }>;
  embeddings: { configured: boolean; dimensions: number };   // getEmbeddingProvider().isConfigured(), EMBEDDING_DIMENSIONS
  integrations: { slack: boolean; github: boolean; gitlab: boolean; linear: boolean; jira: boolean };
  agents: { leadsOnline: number; workersOnline: number };    // getLiveAgentCounts(5)
  firstTask: { id: string; status: string } | null;          // only when firstTaskId is set and the task exists
}
```
- providers: one entry per provider from `getAgentHarnessProviders()` (valid `ProviderName` only),
  from `rollupCredStatusForProvider` (export it from `status.ts`, add `verifiedWorkers` = count of
  reports with a fresh passing live test).
- integrations: slack = `getAutomationSetupStates().slack === "configured"`; github =
  `GITHUB_TOKEN` present OR automation github `verified`; gitlab = `GITLAB_TOKEN` present;
  linear = automation linear `verified`; jira = automation jira `verified`.

Derivation on every GET (skip entirely when `autoCompleted`). For each rule whose step is not
`done`: set `done`, `at: now`, keep an existing method or infer one, emit
`onboarding.step_completed { step, method, derived: true }`:
- connect: always (the authenticated GET proves the connection). method `api_key`.
- ai: some provider `state === "verified"`. Inferred method by the first verified provider:
  claude → `claude_setup_token` if `CLAUDE_CODE_OAUTH_TOKEN` present else `claude_api_key`;
  codex → `codex_cli`; pi/opencode → `openai_gateway` if `OPENROUTER_BASE_URL` present else
  `openrouter`; dsh → `deepseek` if `DEEPSEEK_API_KEY` present else `openrouter`; devin → `devin`;
  anything else → null.
- integrations: some integration true. method = first true in order slack, github, gitlab,
  linear (`linear_oauth`), jira (`jira_oauth`).
- first_task: `signals.firstTask?.status === "completed"`. Also sets `completedAt` and emits
  `onboarding.first_task_completed` + `onboarding.completed`.
Persist only when something changed. Telemetry via `afterCommit` (or after the write when no
transaction).

### `PUT /api/onboarding` (rbac `config.write.any`) → 200 `{ state, signals }`

Body, discriminated on `action`:
- `{ action: "view", step }` → `currentStep = step`; emit `onboarding.step_viewed { step }` only when it changed.
- `{ action: "complete", step: "connect"|"name"|"ai"|"integrations", method }` → done (method validated per step, 400 otherwise). Emit `step_completed { step, method, derived: false }`. No-op (no event) when already done with the same method; a different method overwrites the method only.
- `{ action: "skip", step: not "connect" }` → skipped. Emit `step_skipped { step }`. Ignored when already `done`.
- `{ action: "fail", step, errorClass }` → failed. Emit `step_failed { step, error_class }`. Ignored when already `done`.
- `{ action: "first_task", taskId, method: "suggestion"|"free_form" }` → `firstTaskId = taskId`, `steps.first_task.method = method` (status unchanged until the task completes). 404 when the task does not exist.
- `{ action: "minimize" }` → `minimizedAt = now`.
- `{ action: "resume" }` → `minimizedAt = null`, `dismissedAt = null`.
- `{ action: "dismiss" }` → `dismissedAt = now`; emit `onboarding.dismissed`.
The PUT runs the same ensure-row + derivation as GET before applying the action.

### `POST /api/onboarding/memory` (rbac `config.write.any`)

Body `{ preset: "openai"|"openrouter"|"vercel"|"custom"|"existing", baseUrl?: string (http/https URL), model?: string, apiKey?: string, reuseKey?: "OPENAI_API_KEY"|"OPENROUTER_API_KEY" }`.
- Key resolution: `apiKey` → else `process.env[reuseKey]` → else current `EMBEDDING_API_KEY ?? OPENAI_API_KEY`. None → 200 `{ ok: false, errorClass: "auth", error: "No API key" }`.
- `preset: "existing"` tests the current env config (`EMBEDDING_API_BASE_URL`, `EMBEDDING_MODEL ?? "text-embedding-3-small"`) and writes nothing.
- Probe: `new OpenAI({ baseURL, apiKey, timeout: 15_000, maxRetries: 0 })`, `embeddings.create({ model, input: "agent-swarm onboarding probe", dimensions: EMBEDDING_DIMENSIONS })`. Vector length must equal `EMBEDDING_DIMENSIONS`, else `errorClass: "dimension"`. Error classes: 401/403 → auth, 404 → model, timeout → timeout, fetch/connection error → network, else unknown. `error` message passes `scrubSecrets`, max 300 chars.
- Response 200: `{ ok: boolean, dimensions?: number, latencyMs: number, error?: string, errorClass?: ErrorClass }`.
- On success (not `existing`): `upsertSwarmConfig` global rows `EMBEDDING_API_BASE_URL`, `EMBEDDING_MODEL`, and `EMBEDDING_API_KEY` (isSecret) only when `apiKey` or `reuseKey` supplied the key; then `scheduleIntegrationsReload()` (resets the embedding provider). Mark `steps.memory` done with method = preset. On failure mark `failed` with errorClass. Emit the matching telemetry.

### Codex device login (slice 2, R4 + R5)

`src/providers/codex-oauth/device.ts` (no DB imports, uses the `_fetchHolder` test seam pattern of `flow.ts`):
- `requestDeviceCode()` → `POST https://auth.openai.com/api/accounts/deviceauth/usercode`, JSON `{ client_id: CLIENT_ID }`, headers `originator: agent-swarm`, `User-Agent: agent-swarm`. Response `device_auth_id`, `user_code` (alias `usercode`), `interval` (string or number, trimmed + parsed, absent → 5). 404 → throw `DeviceCodeNotEnabledError`.
- `pollDeviceToken(deviceAuthId, userCode)` → `POST .../deviceauth/token`, JSON `{ device_auth_id, user_code }`. 2xx → `{ type: "success", authorizationCode, codeVerifier }` from `authorization_code`, `code_verifier`. 403/404 → `{ type: "pending" }`. Other → `{ type: "failed", status }`.
- Exchange: reuse `exchangeAuthorizationCode(code, verifier, "https://auth.openai.com/deviceauth/callback")`; `accountId = getAccountId(access)`.
- Verification URL: `https://auth.openai.com/codex/device`.

`src/http/codex-oauth-device.ts`:
- `POST /api/codex-oauth/device` (rbac `config.write.any`) → 200 `{ flowId, userCode, verificationUrl, intervalSeconds, expiresAt }`; 409 `{ error }` when device login is not enabled (step A 404); 502 on other upstream failure. KV namespace `codex-oauth-device`, key = flowId (uuid), value = `encryptSecret(JSON.stringify({ deviceAuthId, userCode, intervalSeconds, expiresAt, lastPolledAt, status, slot, error }))`, `expiresAt` 15 min.
- `POST /api/codex-oauth/device/{flowId}/poll` (rbac `config.write.any`) → 200 `{ status: "pending"|"complete"|"failed"|"expired", slot?: number, error?: string }`. Missing/expired KV row → `expired`. Terminal statuses are sticky. Calls upstream at most once per `intervalSeconds` (else returns `pending` without calling). On success: exchange, pick the first free slot 0..100 among existing `codex_oauth_<N>` global rows (legacy `codex_oauth` counts as slot 0), `upsertSwarmConfig` `codex_oauth_<slot>` (isSecret, JSON `CodexOAuthCredentials`, description "Codex ChatGPT OAuth credentials slot N (stored by dashboard device login)"), mark onboarding ai done with method `codex_device` (only when the onboarding row exists and ai is not done), store `status: complete, slot`.
- Upstream failures and timeouts → `failed` with a short error; onboarding ai marked failed (`not_enabled` / `expired` / `unknown`).

### Slack manifest (slice 3)

`GET /api/integrations/slack/manifest?name=<swarm name>` → 200 JSON manifest built by `buildSlackManifest(name)` in `src/slack/manifest.ts` from the root `slack-manifest.json` (static JSON import): sets `display_information.name` and `features.bot_user.display_name` to the trimmed name (max 35 chars, Slack limit; fallback `SWARM_ORG_NAME` then `Your Swarm`), drops `oauth_config.redirect_urls`.

### Linear / Jira `finalRedirect`

`GET /api/trackers/{linear,jira}/authorize?redirect=<abs url>`: pass `finalRedirect` to
`buildAuthorizationUrl` only when `isOriginAllowedForCredentials(new URL(redirect).origin)`.
`getLinearAuthorizationUrl` / `getJiraAuthorizationUrl` take an optional `finalRedirect`.

### Telemetry

`telemetry.onboarding(event, props)` in `src/telemetry.ts` → `track({ event: "onboarding.<event>", properties })`,
adds `seconds_since_install` when `installedAt` is known. Callers add `seconds_since_start`
(from `state.startedAt`). Events: `started`, `step_viewed`, `step_completed`, `step_skipped`,
`step_failed`, `dismissed`, `completed`, `first_task_completed`. Properties are enums, booleans,
and integers only. Rows in `docs-site/content/docs/(documentation)/reference/telemetry.mdx`.

## UI contract

- Types in `apps/ui/src/api/types.ts` (Onboarding*), client methods in `apps/ui/src/api/client.ts`
  (`fetchOnboarding` 404 → null, `updateOnboarding`, `testOnboardingMemory`, `startCodexDevice`,
  `pollCodexDevice`, `setAgentHarnessProvider`, `fetchSlackManifest`), hooks in
  `apps/ui/src/api/hooks/use-onboarding.ts`.
- `/setup` is a top-level route outside `RootLayout`. Shell `apps/ui/src/pages/setup/page.tsx`,
  step components in `apps/ui/src/pages/setup/steps/*.tsx`, shared step props in
  `apps/ui/src/pages/setup/step-contract.ts`.
- Routing: unconfigured → `/setup` (step 1 only). After connect: `fetchOnboarding` null or
  finished → `from`/`/`; else continue. Configured shell: open onboarding (not finished,
  not minimized, not dismissed) → redirect to `/setup`. Finished = `completedAt || autoCompleted`.
- Pill (header, before the bell) + home card (`id="setup"`): visible when onboarding exists and is
  not finished and not dismissed. Settings nav: "Setup" → `/setup` (resume on mount).

## Todo

- [x] Phase 0: contract (this file) + shared UI contract files (types, client, hooks, step contract, route entry)
- [ ] Phase 1 (Codex): API slice 1: internal keys, onboarding state + routes + derivation + telemetry, memory probe, tracker finalRedirect, openapi, docs, tests
- [ ] Phase 2 (Codex): API slices 2+3: Codex device flow + Slack manifest route, docs, tests
- [x] Phase 3 (Opus): UI shell, routing, pill, home card, settings entry, steps 1 + 2
- [x] Phase 4 (Opus): UI step 3 (Claude, Codex device, open harnesses + gateway R7, Devin, per-worker switch R2)
- [x] Phase 5 (Opus): UI steps 4, 5 (split view, Slack manifest, Linear/Jira, brand SVGs), 6
- [ ] API follow-ups from the UI spec review: `verifiedWorkers` counts leads too (label "agents"); derivation also runs when `autoCompleted` but emits no telemetry (so "Run setup again" shows the true state)
- [x] UI fix round 1 (18 review items) delegated
- [ ] Phase 6: integration pass, gates, code review, commit, push to #1604, PR body
- [ ] Phase 7: local QA + design feedback loop with Taras

## Verification

- `bun run tsc:check`
- `bun run lint` (local Biome may abort on this Mac, see memory; fall back to `bunx biome check <files>`)
- `bun run test:root -- src/tests/onboarding.test.ts src/tests/codex-oauth-device.test.ts src/tests/config-internal-keys.test.ts src/tests/status.test.ts src/tests/codex-oauth.test.ts`
- `bun run check:rbac-coverage && bun run check:openapi-response-coverage`
- `bun run docs:openapi` (commit `openapi.json` + api-reference)
- `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh`
- `bun run check:dep-graph`
- `cd apps/ui && bun run lint && bunx tsc -b && bun run build`
- `bun run e2e` (black-box contract suite)
