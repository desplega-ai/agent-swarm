# Onboarding mockups: shared spec

Static HTML mockups of a **full-page first-run onboarding** for the Agent Swarm dashboard (`apps/ui/`). Three directions, one per folder (`option-a-*`, `option-b-*`, `option-c-*`). No build, no server. Plain `index.html` + inline `<script>`, sharing `../../session-logs/demo-shared.css` for tokens (`--background`, `--card`, `--surface`, `--muted`, `--border`, `--primary`, `--success`, `--error`, `--info`, `--active`, `--font-sans`, `--font-mono`, `--radius`, `--shadow`; dark theme via `html.dark`). Fonts: Space Grotesk (sans) + Space Mono (mono) from Google Fonts, same `<link>` as `../../index.html`.

Design system: `apps/ui/DESIGN.md` ("Mission Control": zinc field, one amber accent for interactive/alive, flat border-defined depth, 36px controls, 6–8px radii, no gradients, no shimmer unless something is running). Read it before drawing.

## The flow (same content in every option)

Six steps. Each step has a status: `todo | done | skipped | failed`. A step is verified by a live check, not by "saved".

| # | Step | Content to show | Complete when |
|---|------|-----------------|---------------|
| 1 | **Connect** | Connection name, API URL, API key. "Test connection" probes `/health`. This replaces the current `WelcomeCard` and must look noticeably nicer than a bare form. | `/health` OK |
| 2 | **Name your swarm** | Swarm name (default `Your Swarm`), optional logo URL, optional brand color swatch. Live preview of the sidebar header with the chosen name/color. | name saved |
| 3 | **AI provider** | Three inline provider cards: **Claude** (API key OR `claude setup-token` token), **Codex** (device-code login: a big 8-char code like `ABCD-EFGH`, a link to `auth.openai.com/codex/device`, a polling spinner, note "enable 'Allow device code login' in ChatGPT Settings → Security", plus a collapsed "other ways: paste redirected URL / run `npx @desplega.ai/agent-swarm codex-login`"), **OpenRouter** (API key). Each card has a "Test" action and a verified state. Link "More providers (OpenAI, Bedrock, Claude Managed)" → Settings. | ≥1 provider verified |
| 4 | **Memory** | Preset picker: **OpenAI** (default, `text-embedding-3-small`), **OpenRouter**, **Vercel AI Gateway**, **Custom** (base URL + model). Key field. Clear line: "any OpenAI-compatible embeddings endpoint works". If step 3 stored an OpenAI/OpenRouter key: "Reuse that key" chip. "Test embedding" action. Skip → warning "Memory stays off; agents will not remember across tasks". | one embedding call succeeds |
| 5 | **Integrations** | Five cards, all optional: **Slack** (button "Create Slack app from manifest" pre-filled with the swarm name, then 3 token fields), **GitHub** (token), **GitLab** (token), **Linear** (OAuth "Connect" button), **Jira** (OAuth "Connect" button). Status chip per card. Link "More integrations" → Settings. "Skip for now" is explicit. | ≥1 connected OR skipped |
| 6 | **First task** | Two sub-states. (a) No worker alive: copyable `docker run …` snippet pre-filled with API URL, key and the provider chosen in step 3; a live "Waiting for a worker…" indicator (this is the ONE place the amber shimmer is allowed). (b) Worker alive: "Send a hello task" button; then a compact live task card (created → running → completed) and a small celebration on completion. | first task completed |

## Required interactions (JS, no framework)

- Clicking a step in the navigation switches the stage. Steps can be visited out of order.
- Each step has buttons that fake the verification: "Test" flips to `done` after ~800 ms with a check; a "Skip" flips to `skipped`. Provide a small hidden dev panel or query params (`?step=N`, `?theme=dark`, `?state=minimized`) so a screenshot can land on any step.
- **Minimize**: a top-right "Minimize" action collapses the full page into the **home dashboard checklist card** (mock the home page as a simple shell: sidebar + header + one "Finish setting up your swarm" card listing the six steps with status and a "Resume" button). Resume reopens the full page at the current step. Progress is per step, not per session.
- Light/dark toggle top-right.
- Deep-link: `?step=3&theme=dark` lands directly on step 3 in dark.
- Version gate is NOT part of the mockup.

## Copy rules

- Short sentences. No marketing. No "unleash". Verb-first buttons ("Test connection", "Connect Linear", "Send a hello task").
- Never show a real-looking secret; use `sk-…••••` style masking.
- No em dashes.

## Deliverables per option

- `option-<x>-<slug>/index.html` (self-contained apart from the shared CSS and fonts).
- Top of the file: an HTML comment stating the direction in two sentences and what it trades off.
- Must render at 1280×800 and at 390×844 without horizontal scroll.

---

## Round 2: iterate Option B only (2026-09-24)

Taras picked **B (Focused Flow)**. Apply everything below to `option-b-focused-flow/index.html` (round 1 is kept as `round-1.html` for reference). A and C stay as they are.

### Shell
- **Progress bar:** one linear bar across the top, no dot marker. Its fill animates (width transition, ~400 ms, opacity/transform or width only) each time a step verifies. Skipped steps count as progress but render as a hatched slice inside the bar.
- **Compact step overview:** directly under the bar, a single slim row with the six step names, each with a status glyph (check, hatched skip, red x, current ring, empty). Clickable. Truncates to numbers only under 640px. This replaces hover tooltips as the overview.
- **Column:** 800px content column (was 640). Tighter vertical rhythm: card padding 16px, section gaps 12-16px. Steps 3, 5 and 6 should fit 1280x800 with at most one screen of scroll.
- Everything else from round 1 stays (header with swarm name, theme toggle, Minimize, Back / Skip / Continue bar, deep links, dev panel on `d`).

### Icons and logos
Use real logos, not letter tiles. Available as files (relative from the option folder): `../../../apps/ui/public/harness-logos/{claude-code,codex,devin,opencode,pi,claude-managed}.svg` and `../../../apps/ui/public/provider-logos/{anthropic,openai,openrouter,deepseek}.svg`. For Slack, GitHub, GitLab, Linear, Jira, Vercel, Ollama: inline small monochrome SVG marks (Simple Icons paths are fine) that follow `currentColor`. 20-24px in cards, 16px in lists.

### Step 3: AI provider (four cards, accordion, first open)
1. **Claude** (logo claude-code). Two tabs, **Setup token** first and marked "Recommended": field `CLAUDE_CODE_OAUTH_TOKEN`, placeholder `sk-ant-oat01-...`, helper "Run `claude setup-token` on your machine and paste the token. Uses your Claude subscription." Second tab **API key**: `ANTHROPIC_API_KEY`, placeholder `sk-ant-api03-...`, helper "Billed per token through console.anthropic.com." Under both, an info note: "The swarm runs the unmodified Claude Code CLI. Anthropic documents setup tokens for CI and automation on your own subscription. Do not share a token across people or organizations." Test button: "Test Claude".
2. **Codex** (logo codex). Device code as in round 1. "Other ways to sign in" now holds ONLY the CLI command `npx @desplega.ai/agent-swarm codex-login --api-url <api url>`. Remove the paste-redirected-URL field.
3. **Open harnesses: opencode, pi, DeepSeek** (three small logos opencode, pi, deepseek in the card head). Subtitle "Model-agnostic harnesses. One OpenRouter key runs all three." Inside: `OPENROUTER_API_KEY` (placeholder `sk-or-v1-...`, logo openrouter), and a collapsed "Direct keys instead" with `DEEPSEEK_API_KEY` (placeholder `sk-...`, "for DeepSeek dsh without OpenRouter") and a note that Anthropic / OpenAI keys from above are reused by pi and opencode automatically. Test button: "Test OpenRouter".
4. **Devin** (logo devin). Fields `DEVIN_API_KEY` (placeholder `cog_...`) and `DEVIN_ORG_ID`. Helper "Service user key or personal access token from app.devin.ai." Test button "Test Devin".
- Footer link: "More providers (OpenAI, Bedrock, Claude Managed) in Settings". Rule line: "One verified provider finishes this step."

### Step 4: Memory
- Preset chips: **OpenAI** (default), **OpenRouter**, **Vercel AI Gateway**, **Ollama (local)**, **Custom**.
- Below the chips, three fields that are ALWAYS editable and get pre-filled by the preset: **Base URL**, **Model**, **API key**. Key label and placeholder follow the preset:
  - OpenAI: `https://api.openai.com/v1`, `text-embedding-3-small`, label "OpenAI API key", placeholder `sk-proj-...`
  - OpenRouter: `https://openrouter.ai/api/v1`, `openai/text-embedding-3-small`, label "OpenRouter API key", placeholder `sk-or-v1-...`
  - Vercel AI Gateway: `https://ai-gateway.vercel.sh/v1`, `openai/text-embedding-3-small`, label "AI Gateway API key", placeholder `vck_...`
  - Ollama (local): `http://localhost:11434/v1`, `nomic-embed-text`, key field shows "Not needed" and is disabled
  - Custom: empty fields, label "API key", placeholder `••••`
- Line under the chips: "Any OpenAI-compatible embeddings endpoint works." "Reuse key from step 3" chip when the same provider was verified there. Test button "Test embedding" runs one fake call and shows dimensions (for example "1536 dims, 210 ms").
- Skip hint stays: "Memory stays off. Agents will not remember across tasks."

### Step 5: Integrations, split view
- Layout inside the 800px column: **left list** (220px) of integrations with logo, name, status chip; **right pane** with the selected integration's config. Under 640px the list becomes horizontal chips above the pane.
- List: Slack, GitHub, GitLab, Linear, Jira, then a muted "More in Settings" row (Attio, Sentry, AgentMail, agent-fs, ...).
- Each pane has a header with logo, name, one-line purpose, a **Docs** link (`https://docs.agent-swarm.dev/docs/integrations/<id>`), and a status chip.
- **Slack:** (1) a read-only code block with the app manifest JSON (short but plausible: display_information name = swarm name from step 2, bot user display name, `chat:write`, `chat:write.customize`, `app_mentions:read`, `channels:history`, `reactions:write`, socket mode enabled, slash commands `/agent-swarm-*`), a **Copy manifest** button that copies it, and a link "Create the app at api.slack.com/apps (From a manifest)". (2) Fields: `SLACK_MODE` (Socket mode default), `SLACK_BOT_TOKEN` placeholder `xoxb-...` (required), `SLACK_APP_TOKEN` placeholder `xapp-...` (Socket mode), `SLACK_SIGNING_SECRET` (HTTP mode only, collapsed). Button "Test Slack".
- **GitHub:** `GITHUB_TOKEN` (`ghp_...`), `GITHUB_WEBHOOK_SECRET`, `GITHUB_EMAIL`, `GITHUB_NAME`. Collapsed "GitHub App (optional)": `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`. Button "Test GitHub".
- **GitLab:** `GITLAB_TOKEN` (`glpat-...`), `GITLAB_WEBHOOK_SECRET`, `GITLAB_EMAIL`, `GITLAB_NAME`, `GITLAB_URL` default `https://gitlab.com`. Button "Test GitLab".
- **Linear:** step list: (1) create an OAuth app at linear.app/settings/api, callback URL shown read-only with copy: `<api url>/api/trackers/linear/callback`; (2) fields `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_SIGNING_SECRET` (webhook); (3) button **Connect Linear** (OAuth, disabled until fields filled). After connect: "Connected as <workspace>" row.
- **Jira:** same shape: (1) create a 3LO app at developer.atlassian.com, redirect URI shown: `<api url>/api/trackers/jira/callback`; (2) `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_WEBHOOK_TOKEN`; (3) **Connect Jira**. After connect: "Connected to <site>.atlassian.net".
- Every secret placeholder is a realistic prefix, never a real-looking full value.
- Step completes when one integration is verified or the user hits "Skip for now".

### Step 6: First task (no worker snippet)
- Remove the `docker run` block entirely.
- Show a small **Agents** list (from `/api/agents`): rows with role badge (Lead / Worker), name, harness logo, status (idle / busy / offline / waiting for credentials), last heartbeat. Seed the mock with one lead and two workers.
- Sub-state (a) lead not ready: header row "Waiting for the lead to be ready" with the amber shimmer, agents shown as offline, and a link "How to deploy workers" to `https://docs.agent-swarm.dev/docs/guides/deployment`. Compose installs start one lead and workers by default, so the copy says "If you used Docker Compose, the lead usually appears within a minute."
- Sub-state (b) lead ready: the row turns green, "Send a hello task" button, then the live task card (created, running, completed) and the celebration from round 1.
- Deep link `?worker=1` (keep the name) switches to sub-state (b). Dev panel keeps "Simulate a worker joining".

### Minimized state
- The home shell header gets a **Setup pill** next to the notifications bell: small progress ring or bar plus "Setup 3/6". Clicking opens a popover with the six-step checklist and a **Resume** button. The "Finish setting up your swarm" home card stays as well.
- `?state=minimized` shows the home shell with the pill visible and the popover closed. `?state=minimized&popover=1` shows the popover open.

### Verification for the agent
Screenshots at 1280x800: `?step=3`, `?step=3&provider=codex&codex=polling`, `?step=4`, `?step=5`, `?step=6`, `?step=6&worker=1`, `?state=minimized&popover=1`; at 390x844: `?step=5`. No horizontal scroll anywhere, no console errors, no em dashes.
