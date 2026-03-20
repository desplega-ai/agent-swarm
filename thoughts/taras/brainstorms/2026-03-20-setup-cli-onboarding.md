---
topic: Setup CLI onboarding experience
status: complete
exploration_type: workflow-to-improve
date: 2026-03-20
---

# Setup CLI Onboarding Experience

## Context

The current `agent-swarm setup` CLI command configures a **client-side** agent to connect to an existing swarm. It:

1. Creates `.claude/` dir and `settings.local.json`
2. Creates `.mcp.json` with server config
3. Asks for API token and Agent ID interactively (or `--yes` mode from env vars)
4. Adds hooks config (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop)
5. Updates `.gitignore`
6. Supports `--dry-run`, `--restore`, `-y/--yes`

**What it does NOT do:** It doesn't set up the server-side infrastructure. There's no guided way for a new user to go from zero to a running swarm. The docker-compose files (`docker-compose.example.yml` and `docker-compose.local.yml`) exist but require manual `.env` file creation, UUID generation, and understanding of the architecture.

**Goal:** Explore what a great onboarding experience looks like with two variants:
1. **Local** — docker compose on the user's machine
2. **Remote** — deploying to a server via SSH

## Exploration

### Q: What kind of exploration is this?
Workflow to improve — evolve the existing `setup` command to handle both client config AND server provisioning.

**Insights:** The user sees this as a natural extension of the existing `setup` command rather than a separate concept. This means the current `setup` flow (client-side config for connecting to a swarm) should remain, but the command should also be able to bootstrap the server infrastructure itself. Two entry points from the same command.

### Q: Who is the target user?
Developer first-timer — someone who found the repo, wants to try agent-swarm, needs guidance on what API keys to get, what the architecture looks like, etc.

**Insights:** This is a critical framing. First-timers don't know what `API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `AGENT_ID`, or `MCP_BASE_URL` mean. The setup needs to explain *why* each piece is needed, not just ask for values. The current setup just says "Enter your API token:" with no context. We need to either generate things for them (UUIDs, API keys) or guide them to get what they need (OAuth tokens).

### Q: What's the desired end state for the Local variant?
Configurable — ask how many workers they want and generate the compose file dynamically.

**Insights:** This means the setup wizard needs to:
1. Ask "how many workers?" (with a sensible default like 1 lead + 1 worker)
2. Ask which templates each worker should use (from the templates registry)
3. Generate UUIDs for each agent automatically
4. Generate a `docker-compose.yml` and `.env` file
5. Optionally start the stack immediately

The docker-compose.example.yml has hardcoded agent IDs and a fixed topology — the setup would need to be a compose file *generator*, not just a copier.

### Q: What credentials should the setup wizard handle?
Full guided flow — walk through every credential with explanations and skip options. Reference: `../agent-swarm-internal` onboarding process.

**Insights:** The user wants a thorough, hand-holding experience. Every credential should be explained: what it's for, where to get it, and whether it's required or optional. Auto-generate what we can (API_KEY, UUIDs), guide for what we can't (OAuth token, GitHub token). The internal onboarding process is a reference for how this should feel. (Researching that now.)

### Q: What's the mental model for the Remote (SSH) variant?
Deploy to a server — user has a fresh VPS (Hetzner, DigitalOcean, etc.) and wants the CLI to SSH in, install Docker, deploy the stack, and configure everything.

**Insights:** This is a significant scope expansion. The CLI would need to:
1. Accept SSH credentials (host, user, key/password)
2. SSH into the server and check prerequisites (Docker installed? Docker Compose? Disk space?)
3. Install Docker if missing
4. Transfer the generated docker-compose.yml and .env to the server
5. Run `docker compose up -d`
6. Verify the stack is healthy (hit `/health` endpoint)
7. Configure the user's local client to point at the remote server

This is closer to what tools like Kamal (formerly MRSK) or CapRover do. It's ambitious but very compelling for the first-timer persona.

### Q: Should the remote deploy handle DNS/domain + HTTPS?
IP first, domain optional — deploy works with just an IP. Optionally ask "do you have a domain?" and if yes, set up Caddy + auto-HTTPS.

**Insights:** This is the right pragmatic middle ground. The compose file would include a Caddy service by default (it's lightweight), but it only activates HTTPS when a domain is provided. Without a domain, the API runs on plain HTTP on the IP. This keeps the "just try it" path fast while allowing production-grade setup for users who are ready.

### Q: What UX format for the expanded wizard?
Ink TUI wizard — multi-step wizard with select menus, progress bars, colored output, explanations between steps. Keep everything in the terminal.

**Insights:** This aligns with the current tech stack (Ink + React). The wizard needs to be designed as a state machine with clear steps. Key UX patterns to borrow:
- `gh auth login` style: explanatory text before each prompt
- `create-next-app` style: select menus for choices (not free text where possible)
- Progress indicators for long operations (Docker pull, SSH commands)
- Clear "you need to do this externally" steps with "press Enter when done" gates

### Q: What's the "wow moment" after setup completes?
Custom answer: The first task should be a prompt from the TUI (skippable), and the dashboard open should be optional — it should open `app.agent-swarm.dev` with query params for auto-config (not the local new-ui).

**Insights:** This is a great UX decision:
1. **Hosted dashboard** (`app.agent-swarm.dev?api_url=...&api_key=...`) — no need to self-host the UI. The hosted app auto-configures via query params. This removes a whole service from the local/remote stack.
2. **TUI task prompt** — after the stack is healthy, the wizard shows "Try sending your first task:" with a text input. User types something like "Say hello to the swarm" and sees it get picked up. Skippable for people who just want to finish setup.
3. **Both are optional** — the setup can complete without either. Clean exit with "your swarm is running at X, dashboard at Y".

This means the compose file doesn't need the `new-ui` service at all — the hosted dashboard handles it. Simplifies the stack significantly.

### Q: Should the wizard also handle client-side config (connecting local Claude Code)?
Wizard offers it — at the end of infra setup, ask "Want to connect this project to the swarm now?" If yes, run the client config inline; if no, show the command to do it later.

**Insights:** This is the best of both worlds. The existing `setup` command logic gets reused as a sub-step within the wizard. The wizard orchestrates: infra → health check → (optional) client config → (optional) first task → (optional) dashboard. Each post-deploy step is skippable. The current `setup` command remains available standalone for people who already have a swarm running.

### Q: What about updates/upgrades after initial setup?
Idempotent re-run — running setup again detects existing infra and offers to modify it (add workers, update images). No separate upgrade command needed.

**Insights:** This is elegant but adds complexity. The setup needs to:
1. Detect if a `docker-compose.yml` / `.env` already exists locally (or on the remote server)
2. Parse the existing config to understand current state (how many workers, which templates, what version)
3. Show "your swarm is currently: API + 1 lead + 2 workers" and ask what to change
4. Diff the new compose against the old, show what changes, and apply

This is doable because the compose file is generated (not hand-edited), so we control the format. We could store metadata in a `.agent-swarm-setup.json` manifest alongside the compose file to make detection easier.

### Q: How should the template system be presented?
Presets first — "What kind of swarm?" → "Development team" (lead + 2 coders), "Content team" (lead + writer + reviewer + strategist), "Custom". Presets map to templates under the hood.

**Insights:** This is excellent for first-timers. They don't need to understand the template system to get started. The presets encode best-practice team compositions. Possible presets:
- **Development team**: 1 lead + 2 coders (the default "get stuff done" config)
- **Content team**: 1 lead + content-writer + content-reviewer + content-strategist
- **Research team**: 1 lead + researcher + reviewer
- **Solo**: 1 worker only (simplest possible, no lead)
- **Custom**: pick templates individually

Presets could be defined in the templates registry itself (a new concept: "compositions" or "presets"), making them extensible without CLI updates.

### Q: What's the MVP slice for a first ship?
Local compose generator — wizard asks questions, generates docker-compose.yml + .env, runs `docker compose up`. Remote comes later.

**Insights:** This scopes the first iteration cleanly:
- **In scope**: TUI wizard, credential collection with explanations, preset selection, compose + .env generation, `docker compose up`, basic health check
- **Out of scope (v2)**: Remote/SSH deploy, client-side config integration, first-task prompt, idempotent re-run, dashboard auto-open
- The compose generator is the hardest new capability. Once that works, layering remote deploy on top (transfer files via SSH, run compose remotely) is incremental.

### Q: Where should generated files live?
Current directory by default, with fallback to `~/.agent-swarm/`. A `.agent-swarm/config.json` acts as a "pointer" that stores where things are and references file paths (env files, compose location, etc.). Subsequent runs use this config to find the existing setup.

**Insights:** This is a smart design:
- **First run in a fresh dir**: generates `docker-compose.yml`, `.env`, and `.agent-swarm/config.json` in cwd
- **Subsequent runs**: checks `.agent-swarm/config.json` first (in cwd, then `~/.agent-swarm/`) to find existing setup
- **The config.json manifest** stores: compose file path, env file path, swarm URL, API key reference, agent topology, version info, deploy type (local/remote)
- This enables the idempotent re-run behavior: config.json tells us what exists, we offer to modify it
- For the remote variant later, config.json stores SSH host + paths on the remote server

This is similar to how Terraform uses `.terraform/` or how Pulumi uses `Pulumi.yaml` — a state file that tracks what was deployed.

### Q: Is the proposed step flow right for v1?
Approved with additions:
1. **DAG format** instead of linear steps (some steps can run in parallel or have branches)
2. **Harness selector**: Claude vs Pi, each with sub-paths:
   - Claude → OAuth (can run `claude setup-token` for the user) or API key
   - Pi → OpenRouter or other providers
3. **Integrations section**: Slack, GitHub, GitLab, Linear — each with provider-specific instructions (e.g. Slack: generate manifest, copy to clipboard, checkpoint to verify)
4. **"Create first task"** as a final step (skippable TUI prompt)

**Insights:** The harness selector is crucial — it determines which credentials are needed downstream. The Claude OAuth flow can be automated via `claude setup-token`, which is a much better UX than "go to this URL, copy the token, paste it here". The integrations section with clipboard operations and checkpoints is a pattern borrowed from tools like Clerk's setup wizard — very effective for first-timers. The DAG structure means we can parallelize independent setup steps (e.g. Docker pull while waiting for user to set up Slack).

## Synthesis

### Setup Wizard DAG (v1 — Local Compose Generator)

```
                    ┌─────────────────────┐
                    │  1. Welcome/Detect   │
                    │  ─────────────────   │
                    │  Check .agent-swarm/ │
                    │  config.json exists? │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ 2. Deploy Type      │
                    │ ─────────────────   │
                    │ [Local] / [Remote]  │
                    │ (remote: "soon")    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ 3. Swarm Preset     │
                    │ ─────────────────   │
                    │ • Dev team          │
                    │ • Content team      │
                    │ • Research team     │
                    │ • Solo              │
                    │ • Custom            │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ 4. Harness Select   │
                    │ ─────────────────   │
                    │ [Claude] or [Pi]    │
                    └────┬───────────┬────┘
                         │           │
              ┌──────────▼──┐  ┌────▼───────────┐
              │ 4a. Claude  │  │ 4b. Pi-mono    │
              │ ──────────  │  │ ───────────    │
              │ OAuth (run  │  │ OpenRouter key │
              │ claude      │  │ or Anthropic   │
              │ setup-token)│  │ API key        │
              │ OR API key  │  │                │
              └──────┬──────┘  └───────┬────────┘
                     │                 │
                     └────────┬────────┘
                              │
                   ┌──────────▼──────────┐
                   │ 5. Core Credentials │
                   │ ─────────────────── │
                   │ API_KEY (auto-gen)  │
                   │ Agent IDs (auto-gen)│
                   └──────────┬──────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
┌─────────▼────────┐ ┌───────▼────────┐ ┌────────▼───────┐
│ 6a. GitHub       │ │ 6b. Slack      │ │ 6c. GitLab/    │
│ (optional)       │ │ (optional)     │ │ Linear (opt)   │
│ ──────────       │ │ ──────────     │ │ ────────────   │
│ GITHUB_TOKEN     │ │ Create app     │ │ Provider-      │
│ GITHUB_EMAIL     │ │ manifest →     │ │ specific       │
│ GITHUB_NAME      │ │ clipboard      │ │ instructions   │
│                  │ │ BOT_TOKEN      │ │                │
│                  │ │ APP_TOKEN      │ │                │
└────────┬─────────┘ └───────┬────────┘ └────────┬───────┘
         │                   │                    │
         └───────────────────┼────────────────────┘
                             │
                  ┌──────────▼──────────┐
                  │ 7. Generate Files   │
                  │ ─────────────────── │
                  │ • docker-compose.yml│
                  │ • .env              │
                  │ • .agent-swarm/     │
                  │   config.json       │
                  └──────────┬──────────┘
                             │
                  ┌──────────▼──────────┐
                  │ 8. Start Stack      │
                  │ ─────────────────── │
                  │ docker compose up   │
                  │ Health check        │
                  │ Agent registration  │
                  └──────────┬──────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
┌─────────▼────────┐ ┌──────▼───────┐ ┌────────▼───────┐
│ 9a. Connect      │ │ 9b. Open     │ │ 9c. First Task │
│ Client (opt)     │ │ Dashboard    │ │ (optional)     │
│ ──────────       │ │ (optional)   │ │ ──────────     │
│ Configure local  │ │ ──────────   │ │ TUI prompt:    │
│ .mcp.json +      │ │ Open browser │ │ "Send your     │
│ settings.local   │ │ to app.      │ │ first task"    │
│                  │ │ agent-swarm  │ │ (skippable)    │
│                  │ │ .dev?params  │ │                │
└──────────────────┘ └──────────────┘ └────────────────┘
```

### Key Decisions

- **Evolve `setup` command** — not a new command. The existing client-config flow becomes a sub-step.
- **First-timer focused** — explain every credential, auto-generate what's possible.
- **Presets over templates** — users pick a team composition, not individual templates.
- **Harness selector** — Claude (OAuth via `claude setup-token` or API key) vs Pi (OpenRouter/Anthropic key). Determines which credentials flow activates.
- **Integration checkpoints** — Slack/GitHub/GitLab/Linear each have provider-specific guided setup with clipboard operations.
- **Hosted dashboard** — `app.agent-swarm.dev` with query params, not self-hosted new-ui.
- **Idempotent re-runs** — `.agent-swarm/config.json` manifest tracks state for modifications.
- **MVP = Local only** — remote (SSH) deploy is v2, shown but grayed out.

### Open Questions (Resolved)

1. **`claude setup-token`** → Run as a bash command (`claude setup-token`), skippable. Immediate fallback: paste the token directly.
2. **Presets source** → Fetch from the templates registry API (not hardcoded). Needs a new "compositions" or "presets" endpoint.
3. **Idempotent re-run safety** → Still open. Need to figure out which operations are safe (adding workers is easy, removing needs in-flight task handling).
4. **Slack manifest** → Already in repo at `slack-manifest.json`. Offer two options: copy manifest to clipboard, or open the raw GitHub URL from main branch.
5. **config.json secrets** → Just references, no secrets in config.json. The `.env` file lives in `.agent-swarm/` dir alongside config.json. (Mirrors the pattern from `.env.example` which has comments explaining each var.)
6. **Docker Compose version** → Docker Compose v2 (current: v2.40.3). Check with `docker compose version` during setup; guide installation if missing.

### Constraints Identified

- **Docker required** — local variant needs Docker + Docker Compose v2 installed. Setup should check and guide installation if missing.
- **OAuth token expiry** — Claude OAuth tokens have a TTL. The setup can't just store them forever. Need a refresh mechanism or warn the user.
- **Platform images** — `linux/amd64` only currently. ARM users (Apple Silicon) will need Rosetta or we need multi-arch images.
- **Port conflicts** — setup should check if ports 3013, 3020-3028 are available before starting.
- **Ink TUI limitations** — complex multi-step wizards in Ink can get unwieldy. May need a state machine library or careful component composition.

### Core Requirements

- **R1**: TUI wizard with DAG-structured steps (detect → type → preset → harness → credentials → integrations → generate → start → post-deploy)
- **R2**: Compose file generator that produces `docker-compose.yml` from preset + credentials + integrations
- **R3**: `.env` file generator with all collected values
- **R4**: `.agent-swarm/config.json` manifest for idempotent re-runs and state tracking
- **R5**: Harness selector (Claude vs Pi) with provider-specific credential flows
- **R6**: Integration setup guides with clipboard operations and verification checkpoints
- **R7**: Health check + agent registration verification after `docker compose up`
- **R8**: Post-deploy options: connect client, open dashboard, send first task (all skippable)
- **R9**: `--dry-run` support (show what would be generated without writing)
- **R10**: `--yes` mode for CI/scripted usage (all values from env vars)

### External Research

**OpenClaw `onboard` command** (150K+ stars):
- Interactive wizard with QuickStart vs Advanced modes — validates wizard pattern at scale
- Does NOT generate docker-compose (ships pre-built) — we're going further by generating compose dynamically
- No SSH deploy — manual tunnel or Tailscale. Our remote variant would be differentiated.
- Has `--non-interactive` mode for CI — we should match this (`--yes` flag)

**agent-swarm-internal cloud onboarding** (4-step web wizard):
- Step order maps 1:1: Harness → Integrations → Swarm Config → Deploy
- Template picker with model selector and pricing estimates — port to TUI
- OAuth + manual credential entry per integration — same pattern needed
- Persistent progress tracking (Convex) — our `.agent-swarm/config.json` is the CLI equivalent
- Provider-specific credential forms already designed — reuse the logic/validation

