---
date: 2026-09-25T20:22:08+02:00
researcher: Claude
git_commit: 06e9e810630df0ca4f8b86c41eee6e42e5ef2066
branch: local research worktree
repository: desplega-ai/agent-swarm
topic: "Assess Maya's feedback (review session, 2026-09-25) on the /setup onboarding flow shipped in PR #1604"
tags: [research, onboarding, setup, apps-ui, feedback, slack, memory, telemetry]
status: complete
autonomy: verbose
last_updated: 2026-09-25
last_updated_by: Claude (after Taras file-review, 7 comments)
---

# Research: Maya's feedback on the /setup onboarding flow

**Date**: 2026-09-25 20:22 CEST
**Researcher**: Claude
**Git Commit**: `06e9e8106` (origin/main, includes PR #1604 `866917d47`)
**Branch**: local research worktree

## Research Question

Read the recorded review session with Maya (2026-09-25). Assess Maya's feedback against the onboarding flow that PR #1604 shipped on 2026-09-24/25.

Scope (Taras, 2026-09-25): onboarding only. Format: one verdict per point, with current state, verdict, and effort.

## Source caveats

- The source is a 74-minute recorded review session. The onboarding walkthrough takes about half of it.
- The recording has no speaker split between Taras and Maya. I attribute the critique to Maya from context.
- The transcript is Catalan and Spanish with heavy speech-recognition noise.
- The auto-generated meeting summary is lossy. It merges some points and misses others (for example, the secret-input and skip-warning points). This document uses the raw transcript as the primary source.

## Summary

Maya's core message: the flow asks for setup before it shows value, and it leads with steps that are not core. Maya wants a value-first opening, AI setup driven by "what do you already pay for", and Slack framed as the place where the swarm lives. Branding should come after Slack, with a Slack preview as its payoff.

Most points are valid and cheap. The strongest ones: move Identity later, add a Slack preview, ask about existing subscriptions, and warn on skipping Slack.

My original pushback, and how the review resolved it:

- Sign-in as a sales engine (J2): I called a fake SSO button a dark pattern. Taras chose Maya's version. The approach below keeps it honest with one condition: the screen says that the email goes to Desplega.
- Slack mandatory (J15): I still recommend "strongly recommended with a skip warning", because the swarm works from the dashboard alone.
- Embeddings (J10, F2): out of scope here. A parallel research covers them.

## Decisions (Taras review, 2026-09-25)

| Topic | Decision |
|---|---|
| J2 sign-in funnel | Follow Maya's feedback: sign-in screen with Google / GitHub / work email / SSO, email goes to Desplega, "continue without an account" escape. |
| J5 subscription question | Reorder the AI cards by the answer. Do not hide any card. |
| J15 Teams waitlist | Email or vote event: decide during implementation. |
| J17 first task in Slack | Unsure. Out of scope for now. |
| J10, F2 embeddings | Out of scope. Parallel research. |

## Verdict table

Effort scale: **S** = under half a day, **M** = 1 to 2 days, **L** = multi-day or a new subsystem.

| # | Maya's point | What /setup does today | Verdict | Effort |
|---|---|---|---|---|
| J1 | "Connect your swarm" reads as a login. Self-host has no account concept, but an enterprise buyer expects one. | Step 1 is an API URL + API key form, then a "Who are you?" user picker (`step-connect.tsx:189-192`). It cannot be skipped. | **Agree, merged with J2.** The API connection stays first. "Who are you?" becomes the sign-in screen. | see J2 |
| J2 | Add Google/GitHub/email sign-in (fake SSO is fine) as a sales engine. Email alerts Desplega in Slack, with thumbs-up/down triage. Offer "use without a user" with `.env` user + password auto-login. | No accounts, SSO, or email capture. Telemetry is anonymous. No new-install alert. The existing "Who are you?" form already asks Name + optional Email. | **Decided: follow Maya** (Taras review). Condition: the screen says the email goes to Desplega. Real self-host auth stays on the RBAC track. | M + Desplega-side receiver |
| J3 | Identity is not core. Move it later. Start with AI providers. | Identity is step 2 (`use-onboarding.ts:20`). | **Agree.** Its only dependency is the Slack manifest name. Place it after Slack (see J9, F1). | S |
| J4 | AI Providers wording is unclear: subscription or API? Warn "this uses your subscription credits". "Open harnesses via OpenRouter" mixes harness and model. | Claude card: setup token "Recommended", API key as the alternative. Codex: device login only. Third card: "Open harnesses: opencode, pi, DeepSeek", "One OpenRouter key runs all three." No billing chip on any card. | **Agree.** Maya got confused live. Add a billing chip per option ("Your subscription" / "Billed per token"). Split harness names from the key they use. | S |
| J5 | Ask "what subscriptions do you pay for?" and "which harnesses do you use?" Then show "our recommended setup". Warn on mismatches (pi cannot use a Claude or Codex subscription). Push OpenRouter for flexibility. | No survey. "Recommended" chips are static. `HarnessSwitch` offers to switch agents when a key has no matching worker (`harness-switch.tsx:124-179`). | **Agree** on the subscription question and mismatch warnings. **Decided: reorder cards, never hide them.** **Partial** on harness-first: a harness is a per-agent runtime setting here, so "pick harnesses" means switching existing agents. | M |
| J6 | Open with the end state: show the team you get (lead, coder, ...). In cloud, show extra agents as "cloud only". | The Agents step lists live agents only (`agent-models.tsx:205-212`). With none online it says "No agents online yet". No end-state picture. | **Agree** on a value-first intro panel. **Defer** the cloud-only upsell: no cloud-only agent catalog exists. | S (intro), L (upsell) |
| J7 | Dial: explain Optimal (Pareto frontier). "Max" is not "latest model for everything". Frame it as "our recommendation, we tested this". | Levels Cheap / Optimal / Max. Optimal is "Recommended" and the default. Max is the strongest preset per harness, not "latest" (`model-dial.ts:42-78`). | **Agree** on the "we tested this" copy. The Pareto chart needs real eval data. Park it. | S (copy), M (chart) |
| J8 | Each step needs a payoff. Memory needs a value pitch (file system + retrieval). | Memory copy: "Embeddings let agents recall earlier work." | **Agree.** Use it as a design rule for every step. | S |
| J9 | Identity payoff = a Slack preview of how the swarm looks. Logo from website URL (fetch or generate). Brand colors from the website. Default name from the company, not "Your Swarm". Logo upload. | Emoji or image URL only. Preview = dashboard sidebar (`step-name.tsx:320-369`). Default "Your Swarm" (`swarm-name.ts:2`). | **Agree** on the Slack preview (see F1 for what Slack really shows). **Partial** on the rest: favicon fetch is M with an SSRF guard. Generated icons cost tokens. Upload needs storage. | S (preview), M (favicon), L (generated icon) |
| J10 | Default to OpenAI `text-embedding-3-large` if the user has OpenAI. Warn before a model switch, because small-to-large later is hard. | `text-embedding-3-small` is "Recommended". Large has the note "6.5x the price". Stored at 512 dims (`constants.ts:81`). No switch warning. | **Out of scope here.** A parallel research covers embeddings (Taras review). | n/a |
| J11 | Secret inputs: after entry, show the first 3-4 characters so the user sees the paste worked. Mask the rest. | Password field with an eye toggle (`secret-input.tsx:29-72`). After save: a fixed 12-dot string, "Replace" button (`autosave-secret-field.tsx:218-243`). | **Agree.** Before save it is client-only. After save, the API must return a masked hint, because it never returns secrets. | S (client), M (server hint) |
| J12 | Slack: likes Copy manifest + Copy prompt for my agent. Add "install via api.slack.com or Slack CLI". Test that it works. | Copy manifest, Copy setup prompt, and a link to api.slack.com/apps all exist (`slack-pane.tsx`). "Connected" = token presence only (`automation-preflight.ts:284-291`). | **Already done**, except the live test. Add a live check (auth test or test post). | M |
| J13 | Telemetry: opt-out by default. Enterprise self-host can turn it off. Know who installs (CTO of a 50-person company = interesting). | `ANONYMIZED_TELEMETRY` defaults to on (`telemetry.ts:29-31`). No toggle or notice in /setup. The org name is sent (see F3). | **Already matches** on the default. Gap: /setup does not disclose telemetry. "Who installs" depends on J2. | S |
| J14 | Skipping Slack needs a warning: "Are you sure? We really recommend Slack." | Skip has no confirmation on any step. Only Memory has a skip tooltip (`page.tsx:78-80`). | **Agree.** | S |
| J15 | Swarm is multiplayer, and multiplayer happens in Slack. Ask "where does your team talk?": Slack, Teams (waitlist + email), WhatsApp (coming soon). Comms + repo are mandatory. | Integrations: "All optional." One group "Chat and code" (Slack, GitHub, GitLab, Linear, Jira). Teams appears only in the Microsoft 365 description. WhatsApp exists as Kapso in Settings only (`integrations-catalog.ts:249-286`). | **Agree** on a separate "team chat" step with the multiplayer pitch. **Disagree** on mandatory: the swarm works from the dashboard alone. Use J14's warning. WhatsApp is not "coming soon": Kapso exists. | M |
| J16 | Code: "GitHub or GitLab?" plus an "Other" field. Then "companies also connect Jira, Linear, Gmail". Figma/Stripe = "private beta, email sign-up". Skip. | GitHub/GitLab/Linear/Jira sit next to Slack. Figma, Stripe, Salesforce, Shopify, Granola show "Soon" plus "Connect from Connections for now" (`business-panes.tsx:77-97`). | **Partial.** The core-then-optional order is right. Keep "Soon": those tools already work through generic Connections. "Private beta" would understate them. | S |
| J17 | First task: maybe force a hello world that appears in Slack. | The first task goes from a UI composer to the lead, then opens the session (`first-message-card.tsx:58-85`). | **Unclear, out of scope.** The transcript is too noisy here, and Taras is unsure too. | n/a |

## Proposed step order

This order follows Maya's sequence and keeps the technical dependencies.

| # | Step |
|---|---|---|
| 0 | Intro: "what you get" (dashboard + agent team) | New, static (J6) |
| 1 | Connect (API URL + key), then Sign in | "Who are you?" becomes the sign-in screen (J1, J2) |
| 2 | AI: "what do you already pay for?" then provider cards | Survey reorders cards + billing chips + mismatch warnings (J4, J5) |
| 3 | Agents (dial) | "We tested this" copy (J7) |
| 4 | Memory | Value pitch (J8). Embedding changes: parallel research |
| 5 | Team chat (Slack, Teams waitlist, WhatsApp via Kapso) | Split out of Integrations, skip warning (J14, J15) |
| 6 | Identity, with a Slack preview | Moved from step 2 (J3, J9) |
| 7 | Code + tools (GitHub/GitLab, then optional tools) | Remainder of Integrations (J16) |
| 8 | First task | No change |

Dependency note: the swarm name pre-fills the Slack manifest (`slack-pane.tsx`, `src/slack/manifest.ts`). With Identity after Slack, the Slack pane needs its own inline name field. Otherwise the app is created as "Your Swarm".

## Proposed approach

Three PRs, ordered by value per effort. Each PR ships alone and keeps /setup working.

### PR 1: reorder + copy (about 1 day, mostly UI)

1. Move Identity after Integrations. Change both order arrays: `apps/ui/src/api/hooks/use-onboarding.ts:18-26` and `src/be/onboarding.ts:9-17`. Step ids stay the same, so saved progress and telemetry keep working.
2. Add an inline swarm-name field to the Slack pane, because the manifest needs the name before Identity runs.
3. Fix the Identity description (F1): Slack shows the swarm name only. Logo and color stay in the dashboard.
4. AI cards (J4): add a billing chip per option ("Your subscription" / "Billed per token"). Rename the open-harness card so harness names and the OpenRouter key read as two things.
5. Dial copy (J7): "We tested these per harness. Optimal is our pick."
6. One payoff line per step (J8), with memory first.
7. Slack skip warning (J14): a `SKIP_HINT` entry plus a confirm when Slack is not connected.
8. Secret inputs (J11, client part): show the first 4 characters plus the length before save.
9. One telemetry disclosure line in /setup (J13).

Risk: `?step=N` links are index-based and change meaning. The persisted react-query cache already fills missing steps, and a reorder does not add steps.

### PR 2: structure (about 2 to 3 days, UI + small API)

1. Split Integrations into "Team chat" and "Code + tools" (J15, J16). This is a new step id, so it needs the API enum, `deriveState()` signals, the telemetry step enum, and the home checklist.
2. Team chat: multiplayer pitch, Slack, Teams waitlist (email or vote, decide here), WhatsApp through the existing Kapso integration.
3. Identity Slack preview (J9): a static Slack message mock with agent personas (name + emoji) and the app name (see F1).
4. Subscription question at the top of the AI step (J5): reorder the cards by the answer. Add mismatch warnings, for example pi with a Claude-only subscription.
5. "What you get" intro panel (J6).
6. Slack live check (J12): call Slack `auth.test` with the saved token. Today "Connected" means only that the tokens exist.

PR 2 has independent slices (1+2, 3, 4, 5, 6). It fits `/v-plan` better than a linear plan.

### PR 3: sign-in funnel (about 2 days here, plus Desplega-side work)

1. Replace "Who are you?" with a sign-in screen: Google, GitHub, work email, SSO. Each button asks for name + email and creates or binds the local user through the existing `IdentityForm` path (`POST /api/users`). No real OAuth.
2. The screen states that the email goes to Desplega. This is the condition that keeps the pattern honest.
3. New API call that sends name + email to Desplega on that explicit action only. It is separate from the anonymous telemetry stream.
4. Desplega side (outside this repo): a receiver on `proxy.desplega.sh`, a Slack alert with company lookup, and thumbs-up/down triage.
5. "Continue without an account": a small link that shows a `.env` recipe. There is no password auth, so the practical form is an operator identity in `.env` that the UI binds automatically. The existing `?email=&name=` auto-bind (`current-user-context.tsx:150-186`) is the closest hook.

Parked: cloud-only agents upsell (J6), Pareto chart (J7), favicon fetch, generated logo, and logo upload (J9), "Other" code-host field (J16), first task in Slack (J17), server-side masked secret hint (J11), all embedding work (parallel research).

## Detailed Findings

### F1. The Identity step claims logo and color reach Slack. Only the name does.

- Step copy: "The name, mark, and color your team sees in the sidebar, in Slack, and on pages." (`apps/ui/src/pages/setup/page.tsx:53`)
- Slack messages use per-agent persona overrides: `username: getAgentDisplayName(agent)` and `icon_emoji: getAgentEmoji(agent)` (`src/slack/responses.ts:100-101`, `:174-175`, `src/slack/actions.ts:121`). `getAgentDisplayName` returns the agent name (`src/slack/responses.ts:52-54`).
- The swarm name reaches Slack only through the manifest `display_information.name` and `bot_user.display_name`, at app creation time (`src/slack/manifest.ts:9-16`).
- The manifest has `chat:write.customize` (`slack-manifest.json:71`), which the persona overrides need.
- Result: a Slack preview in Identity (J9) must show agent personas plus the app name. `SWARM_ORG_LOGO_URL` and `SWARM_BRAND_COLOR` do not appear in Slack. The Slack app icon needs a manual upload in the Slack app settings.

### F2. An embedding model switch silently mixes vector spaces (out of scope, input for the parallel research)

- Each memory row stores its model in `agent_memory.embeddingModel` (`src/be/migrations/036_memory_ttl_staleness.sql:4`, written at `src/be/memory/providers/sqlite-store.ts:394`, `:1050`).
- Nothing reads that column to filter search or to trigger a re-embed.
- The boot backfill re-embeds only rows with a NULL embedding or a wrong byte length: `embedding IS NULL OR length(embedding) != ${VECTOR_BYTES}` (`src/be/memory/boot-reembed.ts:21`).
- `text-embedding-3-small` and `-large` both store at 512 dims (`src/be/memory/constants.ts:81`). A switch between them passes the length check.
- Result: after a switch, new queries use the new model and old rows keep old-model vectors. Retrieval quality drops with no error. This confirms Maya's J10 concern and extends it beyond onboarding: the same path applies to any config change.

### F3. Telemetry sends the swarm name, which the brainstorm said it would not

- `getOrgIdentity()` adds `organization_name` from `SWARM_ORG_NAME` to every event's metadata when set (`src/telemetry.ts:405-412`, spread at `:481`).
- The Identity step writes `SWARM_ORG_NAME`.
- The brainstorm states the funnel payload has "No keys, hostnames, or names" (`thoughts/taras/brainstorms/2026-09-17-ui-onboarding-experience.md:116`, `:198`).
- Doc says X, code does Y. The onboarding events themselves are enum-only (`src/be/onboarding.ts:251-259`). The name arrives through the shared metadata.
- Relevance to J2/J13: Desplega already receives a weak "who installed" signal when an operator names the swarm. No alert uses it.

### Connect step (J1, J2)

- Unconfigured: `ConnectForm` with Connection name, API URL (default `http://localhost:3013`), and API key via `SecretInput` (`apps/ui/src/pages/setup/steps/step-connect.tsx:223-377`). Submit checks `GET /health`, then an authenticated `GET /api/onboarding`.
- Configured: `ConnectedSummary` + `WhoAreYou` ("Who are you?", "The swarm attributes your tasks to this user.", `step-connect.tsx:189-192`). It uses `IdentityForm`: pick a user or create one with Name + optional Email (`apps/ui/src/components/identity/identity-form.tsx:154-173`). Gated on API >= 1.76.0 (`apps/ui/src/contexts/current-user-context.tsx:85`).
- The `users` table exists for task attribution only (`src/be/migrations/031_user_registry.sql`, `067_users_first_class.sql`). There is no password, session, SSO, or email verification.
- Many operators skip the form: `?apiUrl=&apiKey=` is parsed at boot (`apps/ui/src/hooks/use-config.ts:71-140`).
- `connect` is the only step the API refuses to skip (`src/be/onboarding.ts:193-197`).

### AI Providers step (J4, J5)

- Four cards (`apps/ui/src/pages/setup/steps/ai/model.ts:16-21`): Claude, Codex, Open harnesses, Devin.
- Claude: "Setup token" tab (`CLAUDE_CODE_OAUTH_TOKEN`, "Recommended") and "API key" tab (`ANTHROPIC_API_KEY`, "Billed per token through console.anthropic.com.") (`ai/claude-card.tsx:46-83`). This is the only billing framing in the step.
- Codex: device-code login only, "Device code login. No terminal needed." No API-key option (`ai/codex-card.tsx:124-131`).
- Open harnesses: "Open harnesses: opencode, pi, DeepSeek", "Model-agnostic harnesses. One OpenRouter key runs all three." Tabs: OpenRouter, OpenAI-compatible gateway. "Direct keys instead" exposes `DEEPSEEK_API_KEY` (`ai/open-harness-card.tsx:71-133`).
- Devin: `DEVIN_API_KEY` + `DEVIN_ORG_ID` (`ai/devin-card.tsx:18-52`).
- No step asks what the user already pays for. "Recommended" chips are static.
- Design history: the brainstorm framed step 3 by harness from the start (`brainstorms/2026-09-17-ui-onboarding-experience.md:191`). No alternative order (value-first, harness-first, models-first) was compared in any doc.

### Agents step (J6, J7)

- Lists live agents from `useAgents()`, lead first, extensions excluded (`apps/ui/src/pages/setup/steps/agents/agent-models.tsx:205-212`).
- Levels and blurbs: Cheap "Lowest cost. Fine for routine work.", Optimal "The best balance of quality and cost.", Max "The strongest models, at the highest cost." (`agent-models.tsx:51-55`).
- Dial table (`apps/ui/src/lib/model-dial.ts:42-78`, same as `thoughts/taras/plans-yolo/2026-09-24-ui-onboarding.md:242-247`):

| Harness | Cheap | Optimal | Max |
|---|---|---|---|
| claude | claude-sonnet-5, medium | claude-opus-5-5, high | claude-fable-5-1, high |
| codex | gpt-6-luna, medium | gpt-6-sol, high | gpt-6-astra, xhigh |
| pi, opencode | deepseek-v4.1-flash, low | z-ai/glm-5.3, medium | anthropic/claude-opus-5.5, high |
| dsh | deepseek-v4.1-flash | deepseek-v4-pro | deepseek-v4-pro |

- Devin, Claude Managed, and ACP agents show "Managed by ..." instead of a dial (`agent-models.tsx:42-46`).

### Memory step (J8, J10)

- Presets: OpenAI (default), OpenRouter, Vercel AI Gateway, Custom (`apps/ui/src/pages/setup/steps/step-memory.tsx:69-129`).
- The first model chip carries "Recommended": `text-embedding-3-small` ("Cheapest, and faster than the large model."). Large: "Higher quality, slower, 6.5x the price of the recommended model."
- "Reuse key from step 3" appears when `OPENAI_API_KEY` or `OPENROUTER_API_KEY` exists (`step-memory.tsx:455-467`).
- Note on J10's premise: embeddings need an OpenAI API key. A ChatGPT subscription does not cover API embeddings.

### Secret inputs (J11)

- `SecretInput`: `type="password"` with an eye toggle that reveals the full value (`apps/ui/src/components/shared/secret-input.tsx:29-72`).
- `AutosaveSecretField`: after save, a read-only `"••••••••••••"` (fixed length) plus "Replace" (`apps/ui/src/components/onboarding/autosave-secret-field.tsx:218-243`).
- `KEY_RULES` check prefixes and minimum lengths and show hints like "Starts with sk-ant-oat01-" (`autosave-secret-field.tsx:38-68`).

### Integrations step (J12, J14, J15, J16)

- Copy: "Connect your tools", "All optional. Connect what your team already uses." (`page.tsx:67-70`).
- Groups (`apps/ui/src/pages/setup/steps/integrations/catalog.ts:197-200`): "Chat and code" (Slack, GitHub, GitLab, Linear, Jira) and "Business tools" (Gmail, Microsoft 365 inline over OAuth. Figma, Stripe, Salesforce, Shopify, Granola as "Soon").
- Slack pane: "Copy manifest", "Copy setup prompt", "Create the app at api.slack.com/apps" (`integrations/slack-pane.tsx:79-113`). The prompt tells a computer-use agent to create the app and report `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` (`slack-pane.tsx:21-40`). Connected state: "Connected. Mention the bot in a channel to send a task." (`integrations/pane-parts.tsx:34-53`).
- "Connected" is credential presence, not a probe (`src/be/automation-preflight.ts:284-291`).
- No "multiplayer" or "lives in your Slack" copy exists in `apps/ui/src`.
- Skip fires directly with no dialog. `SKIP_HINT` has an entry for `memory` only (`page.tsx:78-80`).

### First task step (J17)

- Composer placeholder "Describe a goal for the swarm", button "Send first task", suggestion chips from `new-session-view.tsx:21-26`.
- `send()` calls `api.createTask({ task, requestedByUserId, source: "ui" })`, records the step, minimizes onboarding, and navigates to the session (`apps/ui/src/pages/setup/steps/first-task/first-message-card.tsx:58-85`).
- The step completes when that task reaches `completed` (server signal).

## Code References

Permalink base: `https://github.com/desplega-ai/agent-swarm/blob/06e9e810630df0ca4f8b86c41eee6e42e5ef2066/`

| File | Line | Description |
|------|------|-------------|
| `apps/ui/src/api/hooks/use-onboarding.ts` | 18-26 | UI step order (`ONBOARDING_STEPS`) |
| `src/be/onboarding.ts` | 9-17 | API step id enum, same order |
| `src/be/onboarding.ts` | 193-197 | Skip action excludes `connect` |
| `src/be/onboarding.ts` | 367-384 | Existing-install rule bypasses /setup |
| `apps/ui/src/pages/setup/page.tsx` | 46-75 | Step titles and descriptions |
| `apps/ui/src/pages/setup/page.tsx` | 78-80 | `SKIP_HINT` (memory only) |
| `apps/ui/src/pages/setup/steps/step-connect.tsx` | 189-192, 223-377 | "Who are you?" and the connect form |
| `apps/ui/src/pages/setup/steps/step-name.tsx` | 320-369 | `SidebarPreview` (only preview in Identity) |
| `apps/ui/src/pages/setup/components/swarm-name.ts` | 2 | Default name "Your Swarm" |
| `apps/ui/src/pages/setup/steps/ai/open-harness-card.tsx` | 71-133 | Open harnesses card copy |
| `apps/ui/src/pages/setup/steps/ai/harness-switch.tsx` | 124-179 | Switch agents to a harness that has a key |
| `apps/ui/src/lib/model-dial.ts` | 42-78 | Cheap / Optimal / Max table |
| `apps/ui/src/pages/setup/steps/step-memory.tsx` | 69-129 | Embedding presets and model chips |
| `apps/ui/src/components/onboarding/autosave-secret-field.tsx` | 218-243 | Saved-secret display (12 dots) |
| `apps/ui/src/pages/setup/steps/integrations/catalog.ts` | 81-200 | Integration catalog and groups |
| `apps/ui/src/pages/setup/steps/integrations/business-panes.tsx` | 77-97 | "Soon" pane copy |
| `apps/ui/src/pages/setup/steps/integrations/slack-pane.tsx` | 21-113 | Slack manifest, prompt, link |
| `src/be/automation-preflight.ts` | 284-291 | Slack "configured" = credential presence |
| `src/slack/responses.ts` | 52-54, 100-101 | Slack persona overrides (agent name + emoji) |
| `src/be/memory/boot-reembed.ts` | 21 | Re-embed filter (NULL or wrong length only) |
| `src/be/memory/constants.ts` | 81 | `EMBEDDING_DIMENSIONS` default 512 |
| `src/telemetry.ts` | 29-31, 405-412 | Telemetry default on, org name in metadata |

## Open Questions

The review resolved the first round of questions (see Decisions). These remain for PR 3:

- Does the sign-in send the email when `ANONYMIZED_TELEMETRY=false`? It is an explicit user action, but an operator who turned telemetry off may not expect any outbound call.
- Who builds the Desplega-side receiver, Slack alert, and triage? It lives outside this repo.
- J15 (decide in PR 2): Teams waitlist as an email or as an anonymous vote event.

## Appendix

- **Architecture notes**: The step order lives in two hardcoded arrays (UI and API). Persisted state is keyed by step id (`swarm_config` key `onboarding_state`), so a reorder keeps saved progress. The `?step=N` URLs are index-based and change meaning after a reorder.
- **Historical context (from thoughts/)**:
  - `thoughts/taras/brainstorms/2026-09-17-ui-onboarding-experience.md`: Identity was placed at step 2 so the name could pre-fill the Slack manifest (`:93`). No login, SSO, email capture, Teams, or WhatsApp was discussed.
  - `thoughts/taras/research/2026-09-24-ui-onboarding-experience.md`: option B locked. Telemetry is opt-out (`:251`).
  - `thoughts/taras/plans-yolo/2026-09-24-ui-onboarding.md`: QA rounds 1 to 4. The Agents step split out in round 4 (`:236-240`). Slack HTTP mode was removed (`:232`). Business-tool presets were deferred (`:232`).
- **Related research**:
  - `thoughts/taras/research/2026-09-24-ui-onboarding-experience.md`: the original onboarding research.
