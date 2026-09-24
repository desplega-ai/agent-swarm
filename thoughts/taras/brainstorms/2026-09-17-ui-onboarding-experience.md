---
date: 2026-09-17T00:00:00+02:00
author: Taras
topic: "First-run onboarding experience in apps/ui"
tags: [brainstorm, ui, onboarding, telemetry, integrations, codex-login]
status: complete
exploration_type: problem
last_updated: 2026-09-24
last_updated_by: Taras
---

# First-run onboarding experience in apps/ui: Brainstorm

## Context

Taras wants a guided first-run onboarding flow in `apps/ui/`. The first time an operator enters the dashboard, the app walks them through setup:

1. **Connection setup**: point the UI at the API server and authenticate.
2. **AI configuration**: Claude, Codex, OpenRouter, and others. For Codex, do the `codex login` from the UI directly, no terminal needed.
3. **Memory**: embeddings key. Default to OpenAI, accept other providers.
4. **Integrations**: Slack, GitHub / GitLab, Linear / Jira, and other blessed integrations.
5. Further steps to be discovered during exploration.

Goal: an easy and clear install, plus telemetry triggers so the team can track who onboards and how they progress through the steps.

Existing building blocks known before exploration:
- Dashboard **Settings → Configuration** page, catalog-driven (`apps/ui/src/lib/configuration-catalog.ts`), persists global `swarm_config` rows via PUT `/api/config`. Stored values win over deployment env, with server-side debounced reload.
- Settings → Integrations and Secrets pages exist. Secrets and reserved keys never go in the configuration catalog.
- Codex OAuth flow exists on the backend (see `runbooks/local-development.md`).
- Business-use instrumentation exists (`ensure()` events, flows `task` / `agent` / `api`).
- `HARNESS_PROVIDER` selects the worker harness. Model tiers (`smol` / `regular` / `smart` / `ultra`) are the portable model selection.

## Exploration

**Framing:** problem to solve. The pain is that self-hosted operators reach a running dashboard but do not know which credentials and integrations to configure, in what order, or whether each one worked. The wizard is one candidate answer. Telemetry is the second half of the problem: today we cannot see where people drop off.


### Q: Which deployment is the onboarding for first?
Self-hosted (this repo), and specifically the UI. The backend already supports the underlying operations.

**Insights (facts gathered from the codebase, 2026-09-17):**
- **Connection already has a first-run screen.** `ConfigGuard` (`apps/ui/src/components/layout/config-guard.tsx`) redirects every route to `/settings/connections` when no connection has an API key. `WelcomeCard` (`apps/ui/src/pages/config/components/welcome-card.tsx`) collects name + API URL + key, probes `GET /health`, and stores the connection in `localStorage`. Nothing after that is guided.
- **No wizard exists in the UI.** Only `WelcomeCard`. The CLI has an interactive `agent-swarm onboard` wizard (`src/commands/onboard/*`) that mints `API_KEY` and writes `.env`; it runs before the API is up, so it cannot be replaced by the UI flow. The UI flow starts once the API is reachable.
- **`GET /status` is the natural backbone.** `src/http/status.ts` reports per-component setup milestones (`unverified | configured | verified`) for harness, Slack, GitHub, Linear, Jira, workers, plus agent-fs configured and activity counts. The home page already polls it every 30s via `StatusProvider`.
- **All config writes go through `PUT /api/config`** (global `swarm_config` rows, `isSecret` for credentials). Global writes debounce-trigger an integrations reload, so Slack/GitHub/Linear/Jira/AgentMail and the embedding provider pick up new values without a restart. Reserved keys (`API_KEY`, `SECRETS_ENCRYPTION_KEY`, `CORS_ALLOW_ANY_ORIGIN`) can never be set from the UI.
- **Integrations catalog exists** (`apps/ui/src/lib/integrations-catalog.ts`): slack, kapso, github, gitlab, linear, jira, attio, sentry, agentmail, composio, serply, anthropic, openrouter, openai, bedrock, codex-oauth, claude-managed, gsc, agentfs, business-use. Status derivation lives in `integrations-status.ts`. Linear and Jira already have UI-initiated OAuth (`/api/trackers/{linear,jira}/authorize`). Slack and GitHub are token paste only.
- **Codex login today is CLI only.** `codex-oauth-section.tsx` shows a copyable `npx @desplega.ai/agent-swarm codex-login --api-url <url>` command. The flow (`src/providers/codex-oauth/flow.ts`) is browser-redirect PKCE against `auth.openai.com` with a loopback listener on `127.0.0.1:1455/auth/callback`, and a manual paste fallback for the code or redirected URL. Tokens are stored as `codex_oauth_<slot>` secret rows via `PUT /api/config`; workers materialize `~/.codex/auth.json` at boot and refresh per task through the locked refresh path. A UI-only login therefore needs either (a) a "paste the redirected URL" fallback plus a new API route that performs the code exchange, or (b) a device-code flow if OpenAI supports it for Codex. Fact to research.
- **Claude auth is env only.** `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). No OAuth flow exists. Values can be stored as secret `swarm_config` rows. Whether a running worker picks up a key set from the dashboard without a restart is unverified (Codex slots are fetched at container boot).
- **Embeddings are OpenAI-shaped only.** `src/be/memory/providers/openai-embedding.ts` reads `EMBEDDING_API_KEY ?? OPENAI_API_KEY`, `EMBEDDING_MODEL` (default `text-embedding-3-small`), `EMBEDDING_API_BASE_URL`. "Other providers" means any OpenAI-compatible endpoint via base URL, not a provider switch. Live on config reload since commit 766064881.
- **Telemetry exists server-side, not in the UI.** `src/telemetry.ts` sends anonymized events to `https://proxy.desplega.sh/v1/events`, keyed by `telemetry_installation_id` (persisted in `swarm_config`), opt-out via `ANONYMIZED_TELEMETRY=false`, payload is booleans/enums only (`has_embedding_key`, `has_slack_channel`, `install_method` in {onboard_interactive, onboard_noninteractive, e2b, manual}, and so on). The UI has no PostHog or similar; its only outbound channel is the feedback proxy (`proxy.desplega.sh/v1/feedback`), which already attaches the install id.
- **No first-run marker exists** beyond `telemetry_installed_at` (telemetry only, null for older installs) and the `/status` milestones.

### Q: What is the moment onboarding counts as "done"?
First task completed by a worker.

**Insights:** Step 5 is therefore "run a worker and send a hello task". `/status` already exposes workers alive in the last 5 minutes and tasks created in the last 24h, so the UI can detect both without new endpoints. The activation metric is time from first dashboard open to first completed task. Config-only completion is a partial state, not done.

### Q: What shape should the experience take?
Stepper first, checklist after. Full-page step flow on first run, each step skippable. After dismissal, a persistent setup card on the home page shows the same steps with live `/status` state until the first task completes.

**Insights:** Both surfaces must read the same step model and the same completion source. The stepper is a presentation of the checklist, not a second state machine. The existing `WelcomeCard` becomes step 1 of the stepper rather than a separate screen.

### Q: Where should onboarding progress live?
Server side, as one global `swarm_config` row (working name `onboarding_state`, JSON: per-step status, timestamps, dismissed flag).

**Insights:** Because the API owns the state, the API is the single emitter of onboarding telemetry. Each state transition emits an event with the existing `telemetry_installation_id`, honoring `ANONYMIZED_TELEMETRY`. The UI needs no analytics SDK. A dedicated route (for example `GET/PUT /api/onboarding`) that validates transitions and emits events is cleaner than letting the UI write the JSON blob through the generic `PUT /api/config`. Existing installs with activity (tasks or agents already present) must be auto-marked complete on first read so they never see the stepper.

### Q: AI configuration step: what makes it complete, and which providers appear inline?
Option 1: the step passes when at least one provider passes a live test call. Claude, Codex, and OpenRouter appear inline. Other LLM providers sit behind a "more providers" link to Settings. Taras also wants a real dashboard-driven Codex login, so the `npx ... codex-login` command becomes a fallback rather than the primary path.

**Insights (web research, 2026-09-24):**
- Codex CLI supports a **device-code flow** (`codex login --device-auth`, documented by OpenAI as "Device Code Authentication (beta)"). Shape: POST `auth.openai.com/api/accounts/deviceauth/usercode`, user visits `auth.openai.com/codex/device` and types the code, the client polls `auth.openai.com/api/accounts/deviceauth/token`, then exchanges at `auth.openai.com/oauth/token`. Code expires in 15 minutes. Endpoint details come from third-party writeups and need verification against the Codex source.
- Device-code login must be **enabled by the user**: ChatGPT Settings → Security → "Allow device code login" (personal), or a workspace admin toggle (workspace). The UI must explain this up front.
- This flow fits a remote API server exactly: the API creates the user code, the browser shows code + link, the API polls, and stores `codex_oauth_<slot>` through the existing storage path. No loopback listener, no redirect to the user's localhost.
- The current PKCE flow redirects to `http://localhost:1455/auth/callback`. From a dashboard talking to a remote API, nothing listens there. Peers (opencode, OpenClaw) solve it with manual paste of the redirected URL, or a public callback URL when one is configured. Both are viable fallbacks but clunkier.
- Third-party reuse of the Codex OAuth client is not explicitly blessed by OpenAI. Same posture as the existing CLI `codex-login`, so no new risk is introduced, but it is worth noting in the plan.

### Note: parallel research on branding and gamification
Taras pointed at `thoughts/taras/research/2026-09-16-swarm-branding-and-gamification.md` (reviewed 2026-09-24). Relevant to onboarding:
- Global branding keys already exist in the configuration catalog (`SWARM_ORG_NAME`, logo URL, brand color, dashboard URL) and are exposed through `/status` to the sidebar. A "name your swarm" moment is cheap.
- The Slack app manifest (`slack-manifest.json`) is static; its default app name moves to `Your Swarm`. "Generate a manifest from selected branding" was explicitly deferred to the onboarding work. The Slack integration step could offer a manifest download or a pre-filled `api.slack.com/apps?new_app=1&manifest_json=...` link with the chosen swarm name.
- Per-agent Slack avatars (emoji or image URL) are backend-first and separate. Not an onboarding step.
- Gamification (achievements, streaks) has no model today. Out of scope for onboarding, except the small celebration when the first task completes.

### Q: Codex login from the dashboard: which mechanism should be primary?
Taras asked whether the API server could host the OAuth callback on its own hostname instead. If that is not possible, option 1 (device code, with paste and npx fallbacks).

**Insights:** OAuth requires the `redirect_uri` to match what OpenAI registered for the Codex client, and that is `http://localhost:1455/auth/callback`. A public API hostname would be rejected by `auth.openai.com` as a redirect mismatch, unless OpenAI relaxes the check for this client. Verification in progress (see below). The device-code flow *is* the API-hosted variant: every network call happens from the API server, the browser only shows a code and a link, and no callback has to reach anyone. So "route on the API" and "device code" converge on the same design.

### Q: Should "name your swarm" be an onboarding step?
Yes. A short step right after connection: swarm name required (default `Your Swarm`), logo URL and brand color optional.

**Insights:** Writes the existing `SWARM_ORG_NAME` / logo / brand color catalog keys, so the sidebar updates immediately through `/status`. The name is reused in the Slack step to pre-fill the app manifest. Step order so far: 1 Connect, 2 Name your swarm, 3 AI provider, 4 Memory, 5 Integrations, 6 First worker + first task.

### Verification: can the API host the Codex OAuth callback?
No. Every project that tried a non-loopback `redirect_uri` for the Codex client (opencode web, clawrouter, OmniRoute) was rejected by `auth.openai.com` before any callback fired. The Codex CLI source hardcodes loopback ports 1455 and 1457 with no host override. opencode's `OPENCODE_PUBLIC_URL` does not change the Codex redirect. Decision: **device code is primary**, "paste the redirected URL" and the `npx ... codex-login` command are fallbacks. Both fallbacks reuse the existing PKCE code in `src/providers/codex-oauth/flow.ts`. Fact to verify in research: the exact device-auth endpoints and payloads against the Codex source (`codex-rs/login`), since public writeups disagree on details.

### Q: Memory step: how strict, and how do other providers work?
Optional, OpenAI default, verified by a live embedding call. Taras added: make it clear that any OpenAI-compatible endpoint works, and offer presets (Vercel AI Gateway, OpenRouter, and similar).

**Insights:** The step is a provider preset picker that fills `EMBEDDING_API_BASE_URL` + default `EMBEDDING_MODEL`, plus a key field that writes `EMBEDDING_API_KEY`. Presets: OpenAI (default, `text-embedding-3-small`), OpenRouter, Vercel AI Gateway, Custom (base URL + model). If the AI step already stored an OpenAI or OpenRouter key, offer "reuse that key". Fact to verify in research: OpenRouter and Vercel AI Gateway embeddings endpoint paths and recommended embedding model IDs. Skip leaves the item open on the checklist with a "memory is off" note.

### Q: Integrations step: which appear inline and what is complete?
Slack, GitHub, GitLab, Linear, Jira inline. All optional. Complete when at least one connects or the user explicitly skips. Others reachable through a "more integrations" link to Settings.

**Insights:** Linear and Jira reuse the existing `/api/trackers/{linear,jira}/authorize` OAuth buttons. Slack gets the manifest pre-filled with the swarm name from the branding step, then the three token fields. GitHub and GitLab are token paste. Each card reads its status from the same `integrations-status.ts` derivation the Settings page uses, so the stepper and Settings never disagree. Telemetry per card: which integration, connected or skipped, and whether OAuth or token was used.

### Q: Final step, first worker + first task: how does the dashboard get a worker running?
Detect a live worker first. If none, show a copyable `docker run` / compose snippet pre-filled with API URL, key, and the provider chosen in the AI step, then wait for the heartbeat. Once a worker is alive, a one-click canned hello task (no repo required) is created and watched to completion, followed by a small celebration.

**Insights:** `/status` already carries workers alive in the last 5 minutes. The hello task should be a fixed prompt that exercises the LLM key and the MCP round trip and nothing else. Watching it uses the existing task detail polling or SSE. Fact to check in research: which env vars the worker container needs per provider so the snippet is correct for Claude (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`), Codex (slot fetched from the API at boot, so only API URL + key), and OpenRouter (`OPENROUTER_API_KEY` + `HARNESS_PROVIDER`). Also whether a running worker picks up keys stored from the dashboard without a restart.

### Q: Telemetry: which funnel events, and where do they go?
Option 1: server-emitted funnel through the existing `src/telemetry.ts` path. Taras added a hard constraint: the onboarding UI must only appear against API servers that support it (the next version onward).

**Insights:** The dashboard already tolerates older servers (`fetchStatus()` returns null on 404). The same pattern applies here: the UI probes `GET /api/onboarding`; a 404 means "old server", so the UI falls back to today's `WelcomeCard` and shows no stepper or checklist. Every onboarding API call is versioned by presence of the route, not by a version string compare. Event set: `onboarding_started`, `step_viewed`, `step_completed` (step, method), `step_skipped`, `step_failed` (step, error class), `onboarding_dismissed`, `onboarding_completed`, `first_task_completed`, each with seconds since `telemetry_installed_at`. Payload stays booleans, enums, and durations. No keys, hostnames, or names.

### Q: Remaining defaults (route, skippability, re-entry, existing installs, phasing)
Accepted, with two additions from Taras: the stepper must be **minimizable** (collapse to the home checklist card at any point, resume where you left off), and it must be **full page**, like the current connection setup, which should also get a visual refresh. Taras also asked for a small spike showing different UI directions for the onboarding.

**Insights:** Minimizable means progress is per step, not per session: `onboarding_state` stores the current step and each step's status, and `/setup` reopens at the current step. The home checklist card is the minimized form. The connection `WelcomeCard` is redesigned as step 1 of the same full-page shell. The spike output lives under `mockups/onboarding/` as static HTML variants, screenshotted for review.

### Q: Mockup review round 1 (2026-09-24)
Taras picked **B (Focused Flow)** and asked for these changes:
- **Shell:** progress bar is linear and animates as steps verify, no dot marker on top. Add a compact persistent step overview. Wider column, denser layout. Consider a wider default for all dashboard pages.
- **Icons:** real logos for providers and integrations (Codex, Claude, GitHub, and so on), not letter tiles.
- **AI provider step:** Claude card recommends the setup token (subscription) with the API key as the alternative, plus a note that the swarm runs the official Claude Code harness, so subscription use is within Anthropic's current terms. Codex "other ways" shows only the CLI command. Replace the OpenRouter card with one card for the other harnesses (opencode, pi, DeepSeek) that opens to an OpenRouter key inside. Add a Devin card below.
- **Memory step:** base URL and model editable per preset. Key field label and placeholder follow the provider (correct prefix per provider).
- **Integrations step:** Slack manifest always copyable, with placeholders for every secret (`xoxb-...` and the like). Docs link per integration. Linear and Jira need their deeper config (client id, secret, webhook). Explore a split view: integration list on the left, the selected integration's config on the right.
- **First task step:** drop the "start a worker" snippet. Show the existing workers as a small list, wait for the lead to be up and ready, and link to the deploy-workers docs.
- **Minimized state:** surface it in the app header near the notifications icon (a setup progress pill that opens the checklist), not only as a home card.

**Insights:** several of these are facts to confirm before redrawing: which config fields Linear and Jira need beyond OAuth, what the Devin and opencode/pi harnesses need as credentials, key prefixes for OpenAI / OpenRouter / Vercel AI Gateway, whether the header already has a notifications icon, and how Anthropic's terms word subscription use through Claude Code.

### Facts gathered for round 2 (2026-09-24)
- **Harness providers** (`ProviderNameSchema`, `src/types.ts`): `claude, codex, pi, devin, claude-managed, opencode, acp, dsh`. pi and opencode accept any of `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (pi also `GOOGLE_API_KEY`). DeepSeek runs under `dsh` with `DEEPSEEK_API_KEY` or `OPENROUTER_API_KEY` as fallback. Devin needs `DEVIN_API_KEY` (bearer prefix `cog_`) plus `DEVIN_ORG_ID`. Gemini has no standalone provider; it is an `acp` target.
- **Catalog fields** (`apps/ui/src/lib/integrations-catalog.ts`): Slack `SLACK_MODE`, `SLACK_BOT_TOKEN` (`xoxb-`), `SLACK_APP_TOKEN` (`xapp-`), `SLACK_SIGNING_SECRET` (HTTP mode). GitHub `GITHUB_TOKEN` (`ghp_`), `GITHUB_WEBHOOK_SECRET`, `GITHUB_EMAIL`, `GITHUB_NAME`, optional App id + private key. GitLab `GITLAB_TOKEN` (`glpat-`), `GITLAB_WEBHOOK_SECRET`, `GITLAB_EMAIL`, `GITLAB_NAME`, `GITLAB_URL`. **Linear needs `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_SIGNING_SECRET` before the OAuth button works.** **Jira needs `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_WEBHOOK_TOKEN`, optional `JIRA_REDIRECT_URI`.** Each catalog entry already carries a `docsUrl` (`docs.agent-swarm.dev/docs/integrations/<id>`). Anthropic: `CLAUDE_CODE_OAUTH_TOKEN` (`sk-ant-oat01-`) takes precedence over `ANTHROPIC_API_KEY`. No Devin or DeepSeek catalog entry yet.
- **Slack manifest**: `slack-manifest.json` at repo root. No UI code copies or downloads it today.
- **Header**: `apps/ui/src/components/layout/app-header.tsx` already has a `/status`-driven health badge that links to `/#setup`, a `NotificationBell`, a GitHub link and the theme toggle. The Setup pill slots in next to the bell.
- **Logos**: `apps/ui/public/harness-logos/{claude-code,codex,devin,opencode,pi,claude-managed}.svg` and `apps/ui/public/provider-logos/{anthropic,openai,openrouter,deepseek,...}.svg`. Slack, GitHub, GitLab, Linear, Jira use lucide icons today, so brand marks for those are new assets.
- **Page width**: dashboard pages are already full width with padding, no `max-w` container. The "wider default" ask is therefore about individual pages that constrain themselves, not the shell.
- **Lead vs worker readiness**: `/status` `workers` milestone is `verified` only when `leads_alive > 0 && workers_alive > 0` (5-minute heartbeat window). `GET /api/agents` lists agents with `status` (`idle | busy | offline | waiting_for_credentials`) and `lastHeartbeatAt`. `docker-compose.example.yml` starts one lead and eleven templated workers by default, so "start a worker" was indeed the wrong step 6.
- **Docs pages**: `docs.agent-swarm.dev/docs/integrations/{slack,github,gitlab,linear,jira}`, `guides/harness-configuration`, `guides/harness-providers`, `guides/provider-auth/codex-oauth`, `guides/deployment`, `architecture/memory`. No Devin page; Devin is inside harness-providers.
- **Embeddings presets** (web): OpenAI `https://api.openai.com/v1`, `text-embedding-3-small`, keys `sk-proj-` (current). OpenRouter has `/api/v1/embeddings`, models like `openai/text-embedding-3-small`, keys `sk-or-v1-`. Vercel AI Gateway `https://ai-gateway.vercel.sh/v1`, `openai/text-embedding-3-small`, key prefix `vck_` unconfirmed. Ollama `http://localhost:11434/v1`, `nomic-embed-text`, no key.
- **Anthropic terms** (code.claude.com/docs/en/legal-and-compliance, fetched 2026-09-24): OAuth is "designed to support ordinary use of Claude Code and other native Anthropic applications"; third parties "may not ... route requests through Free, Pro, or Max plan credentials on behalf of their users" nor "collect, store, or intermediate Claude.ai credentials". `claude setup-token` is documented for CI and scripts. The swarm runs the unmodified CLI on the operator's own subscription, which is the documented case, but the swarm does store and distribute the token. The onboarding note must not claim "safe under the terms"; it states the documented use and tells operators not to share tokens across people or organizations. **Flag for Taras.**

### Mockup round 2 (B) delivered, 2026-09-24
Applied in place to `mockups/onboarding/option-b-focused-flow/index.html` (round 1 kept as `round-1.html`). Deep links: `?step=N`, `?step=3&provider=codex&codex=polling`, `?step=6&worker=1`, `?state=minimized&popover=1`, `?theme=dark`, dev panel on `d`.

Gotchas the mockup surfaced for the real build:
- CSS `mask-image` logos fail on `file://`, so the mockup uses `<img>` with an invert filter in dark mode. The real app can use masks for true `currentColor` tinting.
- Step 6 must poll `GET /api/agents` for lead readiness, not a timer.
- Slack, GitHub, GitLab, Linear, Jira need brand SVG assets in `apps/ui/public/` (only lucide icons exist today).
- The Linear and Jira Connect buttons stay disabled until client id and secret are saved; the callback URL is derived from the step-1 API URL and must match what the OAuth app registers.

### Review round: Taras asked to iron out the Open Questions with questions (2026-09-24)
Facts resolved by sub-agents first:
- **`POST /status/test-connection` is not a live probe.** It takes `{ provider }` (harness names only) and returns the rollup of worker-reported credential checks (`agents.cred_status`), `{ ok, error?, latency_ms }`. With no worker registered for that provider it returns `ok: false`. So "verify a provider from the dashboard" needs either a new API-side live probe or a worker report. Slack, GitHub, Linear, Jira have their own status routes under `src/http/trackers/*`. **No test-embedding endpoint exists**; `/status` only reports `isConfigured()` (presence) for embeddings.
- **Workers pick up dashboard-stored keys at the next task claim**, no restart: `runner.ts` fetches `GET /api/config/resolved?includeSecrets=true` per task and hands a fresh env to the adapter (claude, codex, pi, opencode, devin, dsh). Exception: `claude-managed` reads `ANTHROPIC_API_KEY` once at boot.
- **Linear/Jira OAuth ends on a static "authorized, close this tab" page.** The UI opens the authorize URL in a new tab and refetches status on window focus. The callback machinery already supports a `finalRedirect` (`buildAuthorizationUrl(config, { finalRedirect })` in `src/oauth/wrapper.ts`), the tracker flows just do not pass one. Onboarding can pass `/setup?step=5&oauth=success`.
- **Codex device flow** (search-indexed source, not line-verified): `POST auth.openai.com/api/accounts/deviceauth/usercode` with `{ client_id }`, user visits `auth.openai.com/codex/device`, poll `POST .../deviceauth/token`, exchange at `/oauth/token`, same client id as PKCE, same `auth.json` shape (`auth_mode`, `tokens.{access_token, refresh_token, id_token, account_id}`, `last_refresh`). RFC 8628 error codes. Line-exact confirmation against `codex-rs/login/src/device_code_auth.rs` is still owed to research.
- **Task creation**: `POST /api/tasks` with `{ task }` as the only required field; `source`, `requestedByUserId`, `modelTier` optional. UI observes tasks by react-query polling (10 s default, 5 s for session logs). No SSE. `CreateTaskDialog` on the Tasks page is reusable. `/sessions?seed=<prompt>` is a chat composer prefill gated on API >= 1.76.0.
- **First-run routing today**: `ConfigGuard` redirects to `/settings/connections` with `state.from`; `WelcomeCard` probes `/health`, calls `addConnection` + `switchConnection`, then navigates via `resolvePostConnectRedirect`. `useConfigProvider` consumes `?apiUrl=&apiKey=&email=&name=` once (replaceState), routes `aswt_` tokens to a tab-local embed connection, and ignores URL creds under a `VITE_API_URL` lock. A `/setup` route must keep all four contracts.

### Q: What should the canned hello task do?
Taras: make step 6 about the operator. Ensure the operator's **user is created**, show a few **example starter messages plus a free-form box**, create the task with `source = ui`, and **redirect to the session UI** for that task.

**Insights:** step 6 becomes "Send your first message" rather than a fixed hello prompt. The completion signal stays "that task reaches completed", observed from the session page (the checklist card and header pill keep polling `/status` and the task). Facts to confirm: how a user row is created today, which `source` values `AgentTaskSourceSchema` allows, and how the sessions composer creates a task and navigates.

### Q: How should steps 3 and 4 verify, given `/status/test-connection` is a worker rollup?
Taras: **rely on worker-reported checks** for providers. No new API-side provider probes. For memory, Taras accepted the one exception: the API embeds one string itself through a small probe route, because embeddings run in the API process and no worker can report on that key.

**Insights:** step 3 becomes "save key, then watch workers verify it". The card shows "Saved. Waiting for a worker to check this key" with the existing rollup (`/status/test-connection` per provider, `agents.cred_status`). This ties step 3 to running workers, which compose installs provide, and makes the agents list from step 6 useful on step 3 as well. Fact for research: how fast a worker in `waiting_for_credentials` re-checks after a key lands (the runner credential-wait loop cadence, `CRED_CHECK_DISABLE`).

### Facts: users, sessions, task source (2026-09-24)
- No user row is auto-created. `POST /api/users` via `IdentityModal` (`apps/ui/src/components/identity/identity-modal.tsx`) creates one; `?email=&name=` URL params only link to an existing user. `current-user-context.tsx` stores the choice per API URL in localStorage and forces the modal (non-dismissable) when the API is >= 1.76.0 and no user is picked.
- Sessions UI: `/sessions` (`NewSessionView`) and `/sessions/:rootTaskId`, gated on API >= 1.76.0. Composer creates the task with `api.createTask({ task, requestedByUserId, source: "ui" })` and navigates to `/sessions/<taskId>`. `?seed=` prefills the draft. A hardcoded `SUGGESTIONS` array of four starter prompts exists there.
- `AgentTaskSourceSchema` includes `ui`. `CreateTaskDialog` on the Tasks page leaves `source` unset (server default `api`).
- `requestedByUserId` in the body is accepted as a last resort when no trusted identity exists (`TRUST_BODY_REQUESTED_BY_USER_ID` default on), validated against the users table.

## Synthesis

### Key Decisions
- **Target:** self-hosted deployments of this repo, UI-first. The backend already exposes every operation. The CLI `agent-swarm onboard` wizard stays for the pre-API phase (`.env`, compose); the UI flow starts once the API is reachable.
- **Done state:** onboarding is complete when the first task completes on a worker. Activation metric = seconds from install to first completed task.
- **Shape:** full-page stepper on first run (direction **B, Focused Flow**: one step at a time, 800px column, animated linear progress bar with a compact step overview under it). **Minimizable** at any point: a Setup pill in the app header next to the notifications bell opens a checklist popover with Resume, and the home page shows a "Finish setting up your swarm" card with the same six steps. Progress is per step, so Resume reopens at the current step. Stepper, pill popover and home card are one model at three sizes.
- **Steps (order):** 1 Connect (redesigned `WelcomeCard`), 2 Name your swarm, 3 AI provider, 4 Memory, 5 Integrations, 6 First worker + first task.
- **Completion rule:** every step is verified by a real signal, never by "saved": health probe (1), name saved (2), a worker-reported credential check (3), one API-side embedding call (4), integration status route (5), first task completed (6).
- **Skippability:** every step except Connect can be skipped. Skipped items stay on the checklist.
- **Step 2 Name your swarm:** name required (default `Your Swarm`), logo URL and brand color optional. Writes existing `SWARM_ORG_NAME` / logo / color catalog keys. Name feeds the Slack manifest in step 5.
- **Step 3 AI provider:** four cards: Claude (setup token recommended, API key alternative, note on official CLI + own subscription), Codex (device code, CLI command as the only fallback shown), Open harnesses (opencode, pi, DeepSeek) driven by one OpenRouter key with direct keys collapsed, and Devin (`DEVIN_API_KEY` + `DEVIN_ORG_ID`). OpenAI, Bedrock, Claude Managed behind a "more providers" link. Complete when at least one provider passes `POST /status/test-connection`. Real logos everywhere.
- **Codex login:** **device-code flow is primary**, driven entirely by the API (create user code, show code + `auth.openai.com/codex/device` link, poll, store `codex_oauth_<slot>` through the existing storage path). The UI states the ChatGPT "Allow device code login" prerequisite. Fallbacks: paste the redirected `localhost:1455` URL into the dashboard (API exchanges the code), and the existing `npx @desplega.ai/agent-swarm codex-login` command. An API-hosted OAuth callback is not possible: OpenAI only accepts the loopback redirect for the Codex client.
- **Step 4 Memory:** optional. Presets (OpenAI default, OpenRouter, Vercel AI Gateway, Ollama local, Custom) pre-fill three always-editable fields: base URL, model, API key, written to `EMBEDDING_API_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_API_KEY`. Key label and placeholder follow the preset (`sk-proj-`, `sk-or-v1-`, `vck_`). Copy makes clear that any OpenAI-compatible endpoint works. "Reuse key from step 3" when applicable. Complete on one successful embedding call. Skip shows a "memory is off" note.
- **Step 5 Integrations:** split view, integration list left and the selected config right. Slack, GitHub, GitLab, Linear, Jira, all optional, plus a "more in Settings" row. Each pane links its docs page. Slack shows a copyable manifest pre-filled with the swarm name, then token fields with prefix placeholders. Linear and Jira collect client id, client secret and webhook secret before their existing OAuth Connect button, and show the callback URL. Complete when one connects or the user explicitly skips. Status comes from the same `integrations-status.ts` derivation as Settings.
- **Step 6 First message:** no worker snippet. Show the agents list from `GET /api/agents` (lead and workers, harness logo, status, last heartbeat) and wait for the lead to be ready (`/status` workers milestone), with a link to the deployment docs. Then **ensure the operator user exists** (inline reuse of the `IdentityModal` create form, `POST /api/users`), show starter suggestions plus a free-form composer (reuse `NewSessionView` pieces), create the task with `source: "ui"` and `requestedByUserId`, and **redirect to `/sessions/<taskId>`**. Completion = that task reaches completed, observed by the checklist card and header pill. Requires API >= 1.76.0 for sessions, which the version gate already implies.
- **State:** one global `swarm_config` row (working name `onboarding_state`, JSON) behind a dedicated `GET/PUT /api/onboarding` route that validates transitions. Not written through the generic config PUT. Existing installs with any agents or tasks are auto-marked complete on first read.
- **Verification plumbing:** providers verify through the existing worker rollup (`/status/test-connection` + `agents.cred_status`), no new provider probes. Memory verifies through one new API-side probe route that embeds a single string. Linear/Jira authorize URLs get a `finalRedirect` back to `/setup?step=5&oauth=success` (mechanism exists in `src/oauth/wrapper.ts`, tracker flows just do not pass it). Workers pick up dashboard-stored keys at the next task claim, so no restart messaging is needed (except `claude-managed`, which is not in the stepper).
- **Telemetry:** emitted by the API on state transitions through the existing `src/telemetry.ts` path, same install id, same `ANONYMIZED_TELEMETRY` opt-out, no UI analytics SDK. Events: `onboarding_started`, `step_viewed`, `step_completed` (step, method), `step_skipped`, `step_failed` (step, error class), `onboarding_dismissed`, `onboarding_completed`, `first_task_completed`, each with seconds since `telemetry_installed_at`. Payload stays booleans, enums, durations.
- **Version gate:** the UI shows the new flow only when `GET /api/onboarding` exists. A 404 means an older API, so the UI falls back to today's `WelcomeCard` with no stepper and no checklist.
- **Routing:** stepper lives at `/setup`; `ConfigGuard` sends new installs there; Settings gets a "Run setup again" entry.
- **Delivery slices:** (1) stepper shell + state + telemetry + all steps using today's flows (Codex via npx snippet), (2) Codex device-code login, (3) Slack manifest pre-fill. Each slice ships on its own.
- **Visual direction (spike built 2026-09-24):** three full-page mockups in `mockups/onboarding/`, gallery at `mockups/index.html`, shared spec in `mockups/onboarding/SPEC.md`.
  - **A. Rail + Stage** (`option-a-rail-stage/`): left rail with all six steps and live status, one step on stage. Overview always visible. Deep links: `?step=N`, `?state=minimized`, `?worker=1`, `?fresh=1`, dev panel on `d`.
  - **B. Focused Flow** (`option-b-focused-flow/`): one step at a time, 640px column, six-segment progress bar (amber verified, hatched skipped). Deep links: `?step=N`, `?provider=codex&codex=polling` for the device-code view, `?worker=1`, `?state=minimized`, dev panel on `d`, arrow keys.
  - **C. Launchpad** (`option-c-launchpad/`): the page is the checklist. Progress ring, "next" nudge, six cards, one expands in place with the others dimmed. Deep links: `?step=N` opens that card, `?state=minimized`.
  - My recommendation was A. **Taras picked B (Focused Flow)** on 2026-09-24 and **locked B round 2** after review. `option-b-focused-flow/index.html` is the visual reference for the plan. A and C stay as explorations.
- **Follow-up outside onboarding:** Taras asked whether dashboard pages should default wider. The shell is already full width; the constraint sits in individual pages. Track separately.
- **Deferred: gamification.** Out of scope except the first-task celebration. Per-agent Slack avatars are a separate backend-first track.

### Open Questions
- Line-exact confirmation of the Codex device-code flow against `codex-rs/login/src/device_code_auth.rs` (request/response fields, polling interval, error codes, `auth.json` write path), since only search-indexed snippets were available.
- How quickly a worker in `waiting_for_credentials` re-checks after a key lands in `swarm_config` (runner credential-wait loop cadence), and what the rollup exposes per provider so step 3 can show "N workers verified".
- Whether the Vercel AI Gateway key prefix is `vck_` (unconfirmed), for the placeholder.
- Exact fields the `onboarding_state` JSON needs so the header pill, home card and `/setup` render from one read, and how `/status` should surface it (embed vs separate route).
- Which telemetry helper in `src/telemetry.ts` to extend for the funnel events, and whether `step_completed.method` needs a new enum in the payload schema.

### Constraints Identified
- The dashboard may talk to older API servers; every new capability must be feature-detected by route presence.
- Reserved keys (`API_KEY`, `SECRETS_ENCRYPTION_KEY`, `CORS_ALLOW_ANY_ORIGIN`) can never be set from the UI. Connection (step 1) is browser-local by necessity.
- Telemetry payload must contain no secrets, hostnames, names or PII, and must honor `ANONYMIZED_TELEMETRY=false`.
- Codex OAuth client reuse is not explicitly blessed by OpenAI. Same posture as the existing CLI flow; no new exposure, but note it.
- Embeddings backend is OpenAI-shaped only; "other providers" means OpenAI-compatible base URL.
- UI must follow `apps/ui/DESIGN.md` (one amber accent, flat depth, 36px controls); shimmer only while waiting for a worker or a running task.
- Frontend PRs need agent-browser screenshots plus a recording for the multi-step flow, uploaded to agent-fs.
- `apps/ui` has no unit-test infra by choice; verification is manual QA plus the Playwright UI suite.

### Core Requirements
- R1. First run on a supporting API lands on a full-page `/setup` stepper with six steps and live status.
- R2. Each step verifies with a real signal (worker credential reports for providers, one API-side embedding call for memory) and records `done | skipped | failed` server-side.
- R3. Minimize collapses to a home checklist card; Resume reopens at the current step; Settings offers "Run setup again".
- R4. Codex login completes from the dashboard via device code, with paste and npx fallbacks.
- R5. Memory step offers presets and a custom OpenAI-compatible endpoint, verified by an embedding call.
- R6. Integrations step connects Slack, GitHub, GitLab, Linear, Jira with existing mechanisms; Slack manifest is pre-filled with the swarm name.
- R7. Step 6 waits for the lead, ensures the operator user exists, and sends the first message from a composer with suggestions, landing on the session page.
- R8. The API emits the onboarding funnel through existing telemetry with the install id and opt-out.
- R9. Older APIs get today's behavior unchanged. Existing installs never see the stepper.

## Next Steps

- Handoff: **research** (`/desplega:research` with this file as input). Answer the Open Questions and map the touched UI/API files: `config-guard.tsx`, `use-config.ts`, `welcome-card.tsx`, `app-header.tsx`, `integrations-catalog.ts`, `integrations-status.ts`, `new-session-view.tsx`, `identity-modal.tsx`, `src/http/status.ts`, `src/http/config.ts`, `src/telemetry.ts`, `src/providers/codex-oauth/*`, `src/oauth/wrapper.ts`, `src/http/trackers/{linear,jira}.ts`.
- Mockup round 3 (during planning): align `option-b-focused-flow/index.html` step 3 with worker-reported verification ("Saved. Waiting for a worker to check this key") and step 6 with the user-creation + composer + redirect flow.
- Visual reference stays `mockups/onboarding/option-b-focused-flow/index.html` (round 2, locked).
- Delivery slices for the plan: (1) `/setup` shell + `onboarding_state` + telemetry + steps 1, 2, 3 (save + worker rollup), 4 (embed probe), 5 (split view, finalRedirect), 6 (agents list, user, composer, redirect), header pill + home card, version gate; (2) Codex device-code login; (3) Slack manifest pre-fill and brand SVG assets.
