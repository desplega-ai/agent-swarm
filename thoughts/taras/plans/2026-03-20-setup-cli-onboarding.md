---
date: 2026-03-20T12:00:00Z
topic: "Setup CLI Onboarding (agent-swarm onboard)"
type: plan
status: implemented
source: thoughts/taras/brainstorms/2026-03-20-setup-cli-onboarding.md
---

# Setup CLI Onboarding (`agent-swarm onboard`) Implementation Plan

## Overview

Add an `agent-swarm onboard` command — an interactive TUI wizard that takes a first-time user from zero to a running local swarm. The wizard collects credentials, generates `docker-compose.yml` + `.env`, starts the stack, verifies health, and optionally configures the local client. This is distinct from the existing `setup` command (client-config only); `onboard` handles server-side infrastructure provisioning.

**Brainstorm**: `thoughts/taras/brainstorms/2026-03-20-setup-cli-onboarding.md`

## Current State Analysis

### What exists:
- **`src/commands/setup.tsx`** (~600 lines): Client-only wizard. State machine: `check_dirs → input_token → input_agent_id → updating → done`. Uses `TextInput`, `Spinner` from `@inkjs/ui`. Supports `--dry-run`, `--restore`, `--yes`.
- **`templates-ui/src/lib/compose-generator.ts`**: Web-based compose generator. Takes a `ComposeConfig` object (services, images, ports, integrations) and produces `docker-compose.yml` + `.env` strings. Reference implementation — we'll rewrite for CLI with real credentials instead of placeholders.
- **`docker-compose.example.yml`**: Production compose with 7 services (API + lead + 5 workers). Hardcoded agent IDs, template IDs, volumes.
- **`docker-compose.local.yml`**: Dev compose with 3 services (API + lead + pi-worker). Builds from source.
- **Template system**: 9 official templates served by registry at `templates.agent-swarm.dev`. Schema in `templates/schema.ts`. Templates define role, capabilities, isLead, files (CLAUDE.md, SOUL.md, IDENTITY.md, TOOLS.md, start-up.sh).
- **`docker-entrypoint.sh`** (632 lines): Worker boot sequence. Validates auth, mounts volumes, fetches config, configures git, clones repos, runs startup scripts, launches agent binary.
- **No preset/composition concept exists** in the template system.

### Key Discoveries:
- `@inkjs/ui` v2.0.0 is installed but only `TextInput` and `Spinner` are used. `Select` and `ConfirmInput` are available but unused — we'll introduce them for the wizard (`src/commands/setup.tsx:3`).
- The existing setup state machine uses a `useRef<Set>` pattern to prevent duplicate execution of async effects — same pattern needed for onboard (`src/commands/setup.tsx:92`).
- CLI arg parsing is manual (`src/cli.tsx:39-106`), command routing via switch statement (`src/cli.tsx:545-599`).
- Compose generator uses line-by-line string building, not templates — straightforward to rewrite (`templates-ui/src/lib/compose-generator.ts:75-183`).
- The compose builder web UI defaults to lead + 2 coders (`templates-ui/src/components/compose-builder.tsx:54-66`).

## Desired End State

Running `agent-swarm onboard` in any directory walks the user through:
1. Choosing a swarm preset (Dev team, Content team, Research team, Solo, Custom)
2. Selecting a harness (Claude or Pi) with guided credential collection
3. Optionally configuring integrations (GitHub, Slack, GitLab, Sentry)
4. Generating `docker-compose.yml`, `.env`, and `.agent-swarm/config.json`
5. Starting the Docker stack and verifying health + agent registration
6. Optionally connecting the local client and/or opening the hosted dashboard

### Verification:
```bash
# Fresh directory, full interactive flow
agent-swarm onboard
# → Generates files, starts stack, agents register

# Non-interactive (CI/scripted)
API_KEY=xxx CLAUDE_CODE_OAUTH_TOKEN=xxx agent-swarm onboard --yes --preset=dev
# → Same result, no prompts

# Dry run
agent-swarm onboard --dry-run
# → Shows what would be generated, no files written
```

## Quick Verification Reference

Common commands:
- `bun run lint:fix` — Biome lint + format
- `bun run tsc:check` — TypeScript type check
- `bun test` — Unit tests
- `bun run src/cli.tsx onboard --dry-run` — Test the wizard in dry-run mode
- `bun run src/cli.tsx onboard --help` — Verify help text

Key files to check:
- `src/commands/onboard.tsx` — Main wizard component (new)
- `src/commands/onboard/` — Wizard sub-components and utilities (new)
- `src/cli.tsx` — Command registration
- `src/commands/setup.tsx` — Existing client-config (reused as sub-step)

## What We're NOT Doing

- **Remote/SSH deploy** (v2) — shown as "coming soon" in deploy type selector
- **Idempotent re-runs** (v2) — `.agent-swarm/config.json` is created for future use but not parsed on re-run yet
- **Registry-fetched presets** (v2) — presets are hardcoded in CLI for now
- **Template registry presets endpoint** — no backend changes
- **Modifying the existing `setup` command** — it stays as-is; `onboard` calls it as a sub-step
- **Multi-arch Docker images** — ARM/Apple Silicon compatibility is out of scope
- **Caddy/HTTPS** — no reverse proxy in v1
- **Pi-mono harness** — Pi requires `OPENROUTER_API_KEY` per worker and a different `HARNESS_PROVIDER` env var, which complicates the compose generator. Pi is shown as "coming soon" in the harness selector (same pattern as remote deploy). Users who need Pi can manually edit the generated `.env` and `docker-compose.yml` after generation.

## Implementation Approach

The wizard is a single Ink component (`Onboard`) with a DAG-based state machine (see Phase 1 for the full DAG definition). Each step renders a different UI (`Select`, `TextInput`, `Spinner`, or info screen). Steps that don't apply (e.g., skipped integrations) are resolved by the `nextStep()` function which walks the DAG edges filtered by current state. The state accumulates in a single `OnboardState` object.

File generation is a pure function: `OnboardState → { compose: string, env: string, manifest: object }`. This makes it testable without Ink.

The command structure:
```
src/commands/onboard.tsx          — Main component, state machine, step orchestrator
src/commands/onboard/
  types.ts                        — State types, step union, DAG definition, nextStep()
  presets.ts                      — Hardcoded preset configurations
  compose-generator.ts            — docker-compose.yml generator
  env-generator.ts                — .env file generator
  manifest.ts                     — .agent-swarm/config.json generator
  templates.ts                    — Template registry fetch utility
  steps/                          — One component per step (keeps onboard.tsx manageable)
    welcome.tsx                   — Welcome screen + detect existing setup
    deploy-type.tsx               — Local vs Remote selector
    preset.tsx                    — Preset picker
    custom-templates.tsx          — Custom template builder
    harness.tsx                   — Claude vs Pi selector
    harness-credentials.tsx       — OAuth / API key collection
    core-credentials.tsx          — Auto-gen API_KEY + Agent UUIDs
    integration-menu.tsx          — Integration toggle menu
    integration-github.tsx        — GitHub credential flow
    integration-slack.tsx         — Slack manifest + token flow
    integration-gitlab.tsx        — GitLab credential flow
    integration-sentry.tsx        — Sentry credential flow
    review.tsx                    — Summary + confirm
    generate.tsx                  — File generation
    prereq-check.tsx              — Docker prerequisites
    start.tsx                     — docker compose up
    health-check.tsx              — Health polling + registration
    post-connect.tsx              — Connect local client
    post-dashboard.tsx            — Open dashboard
    post-task.tsx                 — Send first task
src/commands/shared/
  client-config.ts                — Extracted from setup.tsx: createDefaultSettingsLocal,
                                    createDefaultMcpJson, createHooksConfig (shared by
                                    both setup and onboard)
```

Each step component receives `state` and an `onNext(partialState)` callback. The main `onboard.tsx` renders the active step and calls `nextStep()` from the DAG to determine transitions. This keeps each file under ~100 lines.

---

## Phase 1: Foundation — Command Shell + State Machine + Welcome

### Overview
Create the `onboard` command with the state machine skeleton, register it in the CLI, and implement the welcome + deploy type screens. This establishes the framework all subsequent phases build on.

### Changes Required:

#### 1. State types and step DAG
**File**: `src/commands/onboard/types.ts` (new)
**Changes**:
- Define `OnboardStep` union type with all steps:
  ```
  "welcome" | "deploy_type" | "preset" | "custom_templates" |
  "harness" | "harness_credentials" | "core_credentials" |
  "integration_menu" | "integration_github" | "integration_slack" |
  "integration_gitlab" | "integration_sentry" |
  "review" | "generate" | "prereq_check" | "start" | "health_check" |
  "post_connect" | "post_dashboard" | "post_task" | "done" | "error"
  ```
- Define the step transition DAG (each step knows its possible next steps):
  ```
  STEP_DAG: Record<OnboardStep, OnboardStep[]> = {
    welcome:              ["deploy_type"],
    deploy_type:          ["preset"],                       // "remote" → error/coming-soon
    preset:               ["harness", "custom_templates"],  // non-custom → harness, custom → custom_templates
    custom_templates:     ["harness"],
    harness:              ["harness_credentials"],
    harness_credentials:  ["core_credentials"],
    core_credentials:     ["integration_menu"],
    integration_menu:     ["integration_github", "integration_slack", "integration_gitlab", "integration_sentry", "review"],
                          // → first enabled integration, or review if none
    integration_github:   ["integration_slack", "integration_gitlab", "integration_sentry", "review"],
    integration_slack:    ["integration_gitlab", "integration_sentry", "review"],
    integration_gitlab:   ["integration_sentry", "review"],
    integration_sentry:   ["review"],
    review:               ["generate", "integration_menu"], // "go back" loops to integration_menu
    generate:             ["prereq_check"],
    prereq_check:         ["start", "done"],                // skip start if Docker missing + user chose "files only"
    start:                ["health_check"],
    health_check:         ["post_connect"],
    post_connect:         ["post_dashboard"],
    post_dashboard:       ["post_task"],
    post_task:            ["done"],
    done:                 [],
    error:                [],
  }
  ```
- Implement `nextStep(current: OnboardStep, state: OnboardState): OnboardStep` helper that resolves the DAG based on current state (e.g., skips disabled integrations, skips post-deploy steps the user declined). Each transition consults the DAG edges and filters by state to pick the correct next step.
- The DAG is the source of truth for all transitions — no hardcoded step names in the main component. The `nextStep()` function encapsulates all branching logic.
- Define `OnboardState` interface with all accumulated fields:
  - `step: OnboardStep`
  - `deployType: "local" | "remote"`
  - `presetId: string | null` (e.g., "dev", "content", "research", "solo", "custom")
  - `services: ServiceEntry[]` (resolved from preset or custom selection)
  - `harness: "claude" | "pi"`
  - `claudeOAuthToken: string`
  - `apiKey: string` (auto-generated or user-provided)
  - `agentIds: Record<string, string>` (service name → UUID)
  - `integrations: { github: boolean, slack: boolean, gitlab: boolean, sentry: boolean }`
  - `githubToken: string`, `githubEmail: string`, `githubName: string`
  - `slackBotToken: string`, `slackAppToken: string`
  - `gitlabToken: string`, `gitlabEmail: string`
  - `sentryToken: string`, `sentryOrg: string`
  - `outputDir: string` (defaults to cwd)
  - `error: string | null`
  - `logs: string[]`
- Define `OnboardProps` interface: `{ dryRun?: boolean, yes?: boolean, preset?: string }`

#### 2. Preset definitions
**File**: `src/commands/onboard/presets.ts` (new)
**Changes**:
- Define `Preset` interface: `{ id: string, name: string, description: string, services: ServiceEntry[] }`
- Define `ServiceEntry` (reuse concept from compose-generator): `{ template: string, displayName: string, count: number, role: string, isLead?: boolean }`
- Hardcode 5 presets:
  - **dev**: "Development Team" — 1 lead + 2 coders. "Build software with a lead coordinator and two coding agents."
  - **content**: "Content Team" — 1 lead + content-writer + content-reviewer + content-strategist. "Content creation pipeline with writing, review, and strategy."
  - **research**: "Research Team" — 1 lead + researcher + reviewer. "Research and analysis with peer review."
  - **solo**: "Solo Agent" — 1 coder (no lead). "Single agent, simplest setup."
  - **custom**: "Custom" — empty services, user picks templates. "Choose your own templates."

#### 3. Main onboard component (skeleton)
**File**: `src/commands/onboard.tsx` (new)
**Changes**:
- Export `Onboard` component accepting `OnboardProps`
- Implement state machine with `useState<OnboardState>` and `useRef<Set<OnboardStep>>` for dedup (same pattern as `setup.tsx`)
- Implement `welcome` step: ASCII banner + detect `.agent-swarm/config.json` existence. If exists, show "Existing setup detected" message (for now, just inform — no re-run logic yet). Transition to `deploy_type`.
- Implement `deploy_type` step: `Select` with two options:
  - "Local (Docker Compose)" — transitions to `preset`
  - "Remote (SSH) — Coming soon" — disabled/grayed, shows "Remote deploy will be available in a future release"
- Implement `error` and `done` step rendering (reuse pattern from setup.tsx)
- Implement `addLog` helper with dry-run prefix support
- Implement exit timer on done/error (500ms, same as setup.tsx)
- All other steps render a placeholder: `<Text dimColor>Step "{step}" not implemented yet</Text>`

#### 4. Register command in CLI
**File**: `src/cli.tsx`
**Changes**:
- Add import: `import { Onboard } from "./commands/onboard.tsx"`
- Add to `parseArgs`: handle `--preset` flag (string value)
- Add to switch statement: `case "onboard": return <Onboard dryRun={dryRun} yes={yes} preset={preset} />`
- Add to help text: `onboard` command with description "Set up a new swarm from scratch (local Docker Compose)"

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Command is reachable: `bun run src/cli.tsx onboard --help` shows help
- [ ] Dry run starts: `bun run src/cli.tsx onboard --dry-run` shows welcome screen

#### Manual Verification:
- [ ] Running `bun run src/cli.tsx onboard` shows the ASCII banner and deploy type selector
- [ ] Selecting "Local" transitions to the preset step (shows placeholder)
- [ ] Selecting "Remote" shows "coming soon" message
- [ ] `Ctrl+C` cleanly exits the wizard

**Implementation Note**: Pause after this phase for manual verification of the wizard shell.

---

## Phase 2: Preset Selection + Template Integration

### Overview
Implement the preset selection screen and the custom template picker. Users choose a team composition, which resolves to a list of services with template IDs.

### Changes Required:

#### 1. Preset selection step
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `preset` step: Render `Select` with the 5 preset options from `presets.ts`
- Each option shows: name + description + agent count summary (e.g., "1 lead + 2 coders")
- On selection:
  - If preset is not "custom": resolve services from preset, store in state, transition to `harness`
  - If preset is "custom": transition to `custom_templates`

#### 2. Custom template picker
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `custom_templates` step as a multi-phase sub-flow:
  1. Fetch template list from registry: `GET https://templates.agent-swarm.dev/api/templates` (hardcoded default, overridable via `TEMPLATE_REGISTRY_URL` env var)
  2. Show available templates grouped by role (lead vs worker)
  3. Let user add services one by one:
     - Select for template choice
     - TextInput for count (default 1)
     - "Add another" / "Done" selector
  4. Require at least 1 service. Warn if no lead is selected.
  5. On "Done": store services in state, transition to `harness`
- For `--yes` mode: skip custom_templates entirely, require `--preset` flag

#### 3. Template registry fetch utility
**File**: `src/commands/onboard/templates.ts` (new)
**Changes**:
- `fetchTemplateList(registryUrl: string): Promise<TemplateConfig[]>` — fetches available templates from the registry API
- Import `TemplateConfig` from `templates/schema.ts`
- Handle network errors gracefully (show error, allow retry or fallback to preset)

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Running wizard shows 5 preset options with descriptions
- [ ] Selecting "Development Team" resolves to correct services (1 lead + 2 coders) and advances
- [ ] Selecting "Solo Agent" resolves to 1 coder (no lead) and advances
- [ ] Selecting "Custom" enters the template picker flow
- [ ] Custom picker fetches templates from registry and displays them
- [ ] Adding multiple services works, count adjustment works
- [ ] "Done" with no services shows a validation error

**Implementation Note**: Pause for manual verification. Template registry must be reachable for custom mode testing.

---

## Phase 3: Harness Selection + Credential Collection

### Overview
Implement the harness (Claude vs Pi) selector and credential collection steps. Auto-generate API_KEY and Agent UUIDs. Guide users through OAuth token acquisition.

### Changes Required:

#### 1. Harness selection step
**File**: `src/commands/onboard/steps/harness.tsx` (new)
**Changes**:
- Implement `harness` step: `Select` with two options:
  - "Claude Code (Recommended)" — description: "Uses Claude CLI with OAuth token."
  - "Pi-mono — Coming soon" — disabled/grayed. Pi compose support is deferred to v2 (same pattern as remote deploy).
- On selection: store `harness: "claude"` in state, transition to `harness_credentials`
- Note: Pi is shown but not selectable in v1 since the compose generator only supports Claude env vars. When Pi is enabled in v2, this step will also branch the credential flow.

#### 2. Harness-specific credential step (Claude only for v1)
**File**: `src/commands/onboard/steps/harness-credentials.tsx` (new)
**Changes**:
- Implement `harness_credentials` step for Claude:
  - Show two sub-options via Select:
    1. "Run `claude setup-token` (recommended)" — spawn `claude setup-token` as a child process, capture the token from stdout, store in state. If Claude CLI is not found, show error with install instructions and fall back to manual paste.
    2. "Paste token manually" — show TextInput for `CLAUDE_CODE_OAUTH_TOKEN`
  - After credential collected: transition to `core_credentials`

#### 3. Core credential generation step
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `core_credentials` step (auto, no user input):
  - Auto-generate `API_KEY` using `crypto.randomBytes(32).toString('hex')` (or shorter, user-friendly string)
  - Auto-generate `AGENT_ID` UUIDs for each service using `crypto.randomUUID()`
  - Store both in state
  - Show summary: "Generated API key: `abc...xyz`" and "Generated {N} agent IDs"
  - Brief pause (1s with Spinner), then transition to `integration_menu`
- For `--yes` mode: read `API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from env vars, auto-generate agent IDs, skip to `integration_menu`

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Harness selector shows Claude and Pi options
- [ ] Selecting Claude shows OAuth sub-options
- [ ] "Run `claude setup-token`" spawns the command (or errors gracefully if Claude CLI not installed)
- [ ] "Paste manually" shows TextInput, accepts a token
- [ ] Core credentials step auto-generates API key and agent IDs, shows summary
- [ ] Selecting Pi shows OpenRouter / Anthropic sub-options with TextInput

**Implementation Note**: Pause for manual verification. Testing `claude setup-token` requires Claude CLI installed.

---

## Phase 4: Integration Setup

### Overview
Implement optional integration configuration for GitHub, Slack, GitLab, and Sentry. Each integration has a guided flow with explanations and can be skipped.

### Changes Required:

#### 1. Integration menu step
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `integration_menu` step: Multi-select or sequential yes/no for each integration:
  - "GitHub — Push code, create PRs, manage repos"
  - "Slack — Team notifications, task updates, chat"
  - "GitLab — Alternative to GitHub for code hosting"
  - "Sentry — Error tracking and monitoring"
- Use Select to toggle each on/off, with a "Continue" option to proceed
- Store selections in `state.integrations`
- Transition to the first enabled integration step (or `review` if none selected)

#### 2. GitHub integration step
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `integration_github` step:
  - Show explanatory text: "GitHub integration lets agents push code and create PRs."
  - Show instructions: "Create a Personal Access Token at github.com/settings/tokens with `repo` scope"
  - TextInput for `GITHUB_TOKEN` (required)
  - TextInput for `GITHUB_EMAIL` (required)
  - TextInput for `GITHUB_NAME` (required)
  - Transition to next enabled integration or `review`

#### 3. Slack integration step
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `integration_slack` step:
  - Show explanatory text: "Slack integration enables notifications and two-way chat with agents."
  - Step 1: "Copy the Slack app manifest to your clipboard" — offer two options:
    - "Copy manifest to clipboard" — read `slack-manifest.json` (embedded inline in the CLI), detect OS and use the appropriate clipboard command (`pbcopy` on macOS, `xclip -selection clipboard` on Linux, `clip.exe` on WSL/Windows). If clipboard fails, fall back to printing the manifest path.
    - "Show manifest URL" — display the raw GitHub URL for the manifest on `main` branch
  - Step 2: "Create a Slack app at api.slack.com/apps → 'From a manifest' → paste"
  - Step 3: "Install the app to your workspace"
  - Step 4: TextInput for `SLACK_BOT_TOKEN` (starts with `xoxb-`)
  - Step 5: TextInput for `SLACK_APP_TOKEN` (starts with `xapp-`)
  - Show "Press Enter when ready" gate between external steps
  - Transition to next enabled integration or `review`

#### 4. GitLab and Sentry steps
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `integration_gitlab` step:
  - TextInput for `GITLAB_TOKEN` with instructions for Personal Access Token creation
  - TextInput for `GITLAB_EMAIL`
- Implement `integration_sentry` step:
  - TextInput for `SENTRY_AUTH_TOKEN` with instructions
  - TextInput for `SENTRY_ORG`
- Each transitions to next enabled integration or `review`

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Integration menu shows all 4 options, allows toggling
- [ ] Selecting none and continuing skips to review
- [ ] GitHub flow asks for token, email, name with clear instructions
- [ ] Slack flow shows manifest instructions, clipboard copy works, collects tokens
- [ ] Each integration can be individually tested by selecting only that one
- [ ] Skipping all integrations works correctly

**Implementation Note**: Pause for manual verification. Slack manifest clipboard requires `pbcopy` (macOS) or equivalent.

---

## Phase 5: File Generation

### Overview
Implement the compose generator, env generator, and manifest generator. Write files to disk (or show preview in dry-run mode).

### Changes Required:

#### 1. Review step
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `review` step: Show a summary of all collected configuration:
  - Deploy type, preset name, number of services
  - Harness type
  - Enabled integrations
  - Output directory
  - API key (truncated)
- Select: "Generate files and start" / "Go back" / "Cancel"
- On "Generate": transition to `generate`
- On "Go back": transition to `integration_menu` (or earlier step)
- On "Cancel": transition to `done` with no file generation

#### 2. Compose generator
**File**: `src/commands/onboard/compose-generator.ts` (new)
**Changes**:
- `generateCompose(state: OnboardState): string` — produces a `docker-compose.yml`
- Generate API service with:
  - Image: `ghcr.io/desplega-ai/agent-swarm:latest`
  - Ports: `3013:3013`
  - Env: `API_KEY`, `MCP_BASE_URL=http://localhost:3013`, `APP_URL`
  - Slack env vars if integration enabled
  - Healthcheck: `curl -f http://localhost:3013/health || exit 1`
  - Volume: `swarm_api:/app`
- Generate agent services (lead + workers) from `state.services`:
  - Image: `ghcr.io/desplega-ai/agent-swarm-worker:latest`
  - `depends_on: api` with `condition: service_healthy`
  - Env: `CLAUDE_CODE_OAUTH_TOKEN`, `API_KEY`, `AGENT_ID` (real UUID from state), `AGENT_NAME`, `AGENT_ROLE`, `TEMPLATE_ID`, `MCP_BASE_URL=http://api:3013`, `YOLO=true`, `SWARM_URL`
  - Integration-specific env vars per integration config
  - Ports: sequential starting from 3020
  - Volumes: shared logs, shared workspace, personal volume per agent
- Generate volumes section

#### 3. Env generator
**File**: `src/commands/onboard/env-generator.ts` (new)
**Changes**:
- `generateEnv(state: OnboardState): string` — produces a `.env` file with actual values (not placeholders)
- Sections: Core (API_KEY, MCP_BASE_URL, APP_URL), Authentication (CLAUDE_CODE_OAUTH_TOKEN or Pi keys), Integrations (per enabled integration), Agent IDs (comments listing each agent's UUID for reference)
- Include explanatory comments for each section

#### 4. Manifest generator
**File**: `src/commands/onboard/manifest.ts` (new)
**Changes**:
- `generateManifest(state: OnboardState): object` — produces `.agent-swarm/config.json`
- Schema:
  ```json
  {
    "version": 1,
    "createdAt": "ISO date",
    "deployType": "local",
    "preset": "dev",
    "harness": "claude",
    "services": [{ "name": "lead", "templateId": "official/lead", "agentId": "uuid" }, ...],
    "integrations": { "github": true, "slack": false, ... },
    "composePath": "./docker-compose.yml",
    "envPath": "./.env",
    "apiUrl": "http://localhost:3013",
    "dashboardUrl": "https://app.agent-swarm.dev"
  }
  ```

#### 5. Generate step
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `generate` step:
  - Call `generateCompose(state)`, `generateEnv(state)`, `generateManifest(state)`
  - If `--dry-run`: show the generated files in the terminal (truncated preview), do not write
  - If not dry-run: write files to `state.outputDir`:
    - `docker-compose.yml`
    - `.env`
    - `.agent-swarm/config.json` (create `.agent-swarm/` dir)
  - Add both `.env` and `.agent-swarm/` to `.gitignore` in the output directory if in a git repo (the onboard command runs in arbitrary directories — can't assume `.env` is already gitignored)
  - Log each file written
  - Transition to `prereq_check`

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Unit test for compose generator: `bun test src/tests/onboard-compose.test.ts` — verifies correct YAML structure for each preset
- [ ] Unit test for env generator: `bun test src/tests/onboard-env.test.ts` — verifies all credentials appear correctly

#### Manual Verification:
- [ ] Review screen shows correct summary of all collected config
- [ ] Dry-run shows generated file previews without writing
- [ ] Normal run writes `docker-compose.yml`, `.env`, `.agent-swarm/config.json`
- [ ] Generated compose file is valid YAML: `docker compose -f docker-compose.yml config`
- [ ] Generated `.env` has real values (not placeholders) for provided credentials
- [ ] `.agent-swarm/` directory is created and added to `.gitignore`

**Implementation Note**: Pause for manual verification. Test generated compose with `docker compose config` to validate YAML syntax.

---

## Phase 6: Stack Start + Health Check

### Overview
Check Docker prerequisites, start the stack with `docker compose up`, poll for health, and verify agent registration.

### Changes Required:

#### 1. Prerequisite check step
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `prereq_check` step:
  - Check `docker --version` (require Docker installed)
  - Check `docker compose version` (require Compose v2)
  - Check available ports (3013, 3020-302N) using `lsof -i :PORT`
  - If Docker missing: show install instructions for macOS (`brew install --cask docker`) and Linux
  - If Compose missing: show install instructions
  - If ports occupied: show which ports are in use and by what process
  - If all good: transition to `start`
  - If issues: show errors with fix instructions and a "Retry" / "Skip and generate files only" option

#### 2. Stack start step
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `start` step:
  - Show Spinner: "Starting Docker stack..."
  - Run `docker compose --env-file .env up -d` in the output directory via `Bun.$`
  - Stream docker compose output to logs
  - On success: transition to `health_check`
  - On failure: show error, offer "Retry" / "View logs" / "Skip"

#### 3. Health check step
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `health_check` step:
  - Poll `http://localhost:3013/health` every 3 seconds, up to 60 seconds
  - Show Spinner with countdown: "Waiting for API server... (15s / 60s)"
  - Once healthy: check agent registration via `GET http://localhost:3013/api/agents` with `Authorization: Bearer {apiKey}`
  - Verify expected number of agents registered (retry up to 90 seconds — agents take time to boot)
  - Show registration summary: "Lead: registered, Worker 1: registered, Worker 2: registered"
  - On success: transition to `post_connect`
  - On timeout: show diagnostic info (docker compose logs excerpt), offer "Retry" / "Continue anyway" / "View full logs"

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Without Docker installed: shows clear install instructions
- [ ] With Docker: prereq check passes, shows green checkmarks
- [ ] Port conflict: shows which port is occupied and by what
- [ ] `docker compose up` starts the stack
- [ ] Health check polls and shows progress
- [ ] Agent registration shows each agent's status
- [ ] Timeout scenario: shows helpful diagnostics

**Implementation Note**: Pause for manual verification. This phase requires Docker Desktop running. Test with a clean state (`docker compose down -v` first).

---

## Phase 7: Post-Deploy Options

### Overview
After the stack is healthy, offer three optional post-deploy steps: connect local client, open dashboard, send first task.

### Changes Required:

#### 1. Connect client step
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `post_connect` step:
  - Ask: "Connect this project to the swarm now?" (Select: Yes / No / Skip all post-deploy)
  - If yes: extract `createDefaultSettingsLocal()`, `createDefaultMcpJson()`, and `createHooksConfig()` from `setup.tsx` into a shared module `src/commands/shared/client-config.ts` (export them, update `setup.tsx` to import from the shared module). Then call these from the onboard wizard:
    - Create/update `.mcp.json` with the local swarm URL (`http://localhost:3013`) and generated API key
    - Create/update `.claude/settings.local.json` with permissions, enabled MCP servers, and hooks
    - Show "Connected! Your local Claude Code is now linked to the swarm."
  - Transition to `post_dashboard`

#### 2. Open dashboard step
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `post_dashboard` step:
  - Ask: "Open the swarm dashboard?" (Select: Yes / No)
  - If yes: open `https://app.agent-swarm.dev?api_url=http://localhost:3013&api_key={apiKey}` in default browser via `Bun.$\`open URL\``
  - Transition to `post_task`

#### 3. First task step
**File**: `src/commands/onboard.tsx`
**Changes**:
- Implement `post_task` step:
  - **Skip this step entirely for "solo" preset** (no lead to assign to). The DAG's `nextStep()` should route `post_dashboard → done` when preset is solo.
  - Ask: "Send your first task to the swarm?" (Select: Yes / Skip)
  - If yes: show TextInput with placeholder "Say hello to the swarm"
  - On submit: POST to `http://localhost:3013/api/tasks` with `{ task: userInput, agentId: leadAgentId }` using the generated API key and `Authorization: Bearer {apiKey}` header. The `agentId` field assigns the task to the lead agent's UUID from `state.agentIds`. API schema: `src/http/tasks.ts:52-63`.
  - Show: "Task sent to the lead! Check the dashboard to see it get picked up."
  - Transition to `done`

#### 4. Done step
**File**: `src/commands/onboard.tsx`
**Changes**:
- Enhance `done` step with a completion summary:
  - "Your swarm is running!"
  - "API: http://localhost:3013"
  - "Dashboard: https://app.agent-swarm.dev?..."
  - "Agents: {N} registered"
  - "Files: docker-compose.yml, .env, .agent-swarm/config.json"
  - Helpful commands: `docker compose logs -f`, `docker compose down`, `agent-swarm setup` (if client not connected)

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] "Connect client" creates `.mcp.json` and `.claude/settings.local.json` correctly
- [ ] "Open dashboard" opens the browser with correct URL params
- [ ] "First task" sends a task and shows confirmation
- [ ] Skipping all post-deploy steps shows the completion summary
- [ ] Done screen shows all relevant info and helpful commands

**Implementation Note**: Pause for manual verification. Dashboard URL needs the hosted app running (or at least verify the URL is constructed correctly).

---

## Phase 8: --yes Mode + Polish

### Overview
Wire up the non-interactive `--yes` mode for CI/scripted usage, add `--preset` flag support, handle edge cases, and write tests.

### Changes Required:

#### 1. Non-interactive mode
**File**: `src/commands/onboard.tsx`
**Changes**:
- When `--yes` is passed:
  - Skip welcome, deploy_type (assume local)
  - Require `--preset` flag (error if missing)
  - Read credentials from env vars: `CLAUDE_CODE_OAUTH_TOKEN` (required), `API_KEY` (optional, auto-gen if missing)
  - Read integration credentials from env vars: `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, etc. — auto-enable integration if the token is present
  - Skip review step
  - Generate files, start stack, wait for health
  - Skip post-deploy options
- Error messages should list which required env vars are missing

#### 2. CLI argument handling
**File**: `src/cli.tsx`
**Changes**:
- Parse `--preset=<name>` flag in `parseArgs`
- Parse `--output-dir=<path>` flag (default: cwd)
- Add `onboard` to help text with all flags:
  ```
  onboard              Set up a new swarm from scratch (local Docker Compose)
    --dry-run          Preview what would be generated without writing files
    -y, --yes          Non-interactive mode (reads from env vars)
    --preset=<name>    Preset to use: dev, content, research, solo
    --output-dir=<dir> Directory for generated files (default: current)
  ```

#### 3. Edge case handling
**File**: `src/commands/onboard.tsx`
**Changes**:
- Handle `Ctrl+C` gracefully at every step (Ink's `useApp().exit()`)
- Handle Docker not running (socket error) vs not installed
- Handle network errors when fetching templates (for custom mode)
- Handle `claude setup-token` not found (Claude CLI not installed)
- Handle existing `docker-compose.yml` in output dir (warn before overwrite)
- Validate tokens have expected format where possible (e.g., `xoxb-` prefix for Slack)

#### 4. Unit tests
**File**: `src/tests/onboard-compose.test.ts` (new)
**Changes**:
- Test compose generation for each preset (dev, content, research, solo)
- Test compose generation with integrations enabled/disabled
- Test that generated compose has correct service count, ports, volumes
- Test that agent IDs from state are used (not placeholder UUIDs)

**File**: `src/tests/onboard-env.test.ts` (new)
**Changes**:
- Test env generation with Claude harness
- Test env generation with Pi harness
- Test env generation with various integration combinations
- Test that real credential values appear (not placeholders)

**File**: `src/tests/onboard-manifest.test.ts` (new)
**Changes**:
- Test manifest generation with various configs
- Test manifest schema matches expected shape

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Unit tests pass: `bun test src/tests/onboard-compose.test.ts`
- [ ] Unit tests pass: `bun test src/tests/onboard-env.test.ts`
- [ ] Unit tests pass: `bun test src/tests/onboard-manifest.test.ts`
- [ ] Non-interactive mode: `API_KEY=test CLAUDE_CODE_OAUTH_TOKEN=test bun run src/cli.tsx onboard --yes --preset=dev --dry-run`

#### Manual Verification:
- [ ] `--yes --preset=dev` with env vars generates correct files
- [ ] `--yes` without `--preset` shows clear error message
- [ ] `--yes` without `CLAUDE_CODE_OAUTH_TOKEN` shows clear error listing missing vars
- [ ] `--dry-run --yes --preset=dev` shows preview without writing files
- [ ] Existing `docker-compose.yml` warns before overwrite
- [ ] All edge cases handled gracefully (no unhandled promise rejections)

**Implementation Note**: Pause for manual verification and full E2E testing.

---

## Implementation Status

_Implemented: 2026-03-20 by Claude_

All 8 phases completed. 27 new files, 2 modified files (setup.tsx, cli.tsx).

### Automated Tests Executed
- `bun run tsc:check` — passes (0 errors)
- `bun run lint:fix` — passes (0 warnings in onboard files)
- `bun test src/tests/` — 1583 tests pass (all existing + 25 new)
- `bun test src/tests/onboard-compose.test.ts` — 8 tests (service counts, ports, integrations, healthcheck)
- `bun test src/tests/onboard-env.test.ts` — 8 tests (credentials, integrations, disable flags)
- `bun test src/tests/onboard-manifest.test.ts` — 9 tests (schema shape, presets, integration flags)
- `--yes --preset=dev --dry-run` — completes end-to-end, shows file previews
- `--yes` without `--preset` — shows clear error
- `--yes` without `CLAUDE_CODE_OAUTH_TOKEN` — shows clear error
- Generated `docker-compose.yml` validates with `docker compose config --quiet`
- Generated `.env` has real credential values
- Generated `.agent-swarm/config.json` has correct schema

### Key Deviations from Plan
- `generate.tsx` routes directly to `done` in dry-run mode (skips prereq/start/health)
- Added `nonInteractive` field to `OnboardState` for `--yes` mode to skip post-deploy steps
- `generate.tsx` has its own inline `generateManifest()` (agent wrote a simpler version than the shared `manifest.ts` — both exist, generate.tsx uses its own)

---

## Testing Strategy

### Unit Tests (25 tests, all passing)
- `src/tests/onboard-compose.test.ts` — 8 tests: preset service counts, port allocation, integrations, healthcheck, depends_on
- `src/tests/onboard-env.test.ts` — 8 tests: credential values, integration sections, disable flags, agent ID comments
- `src/tests/onboard-manifest.test.ts` — 9 tests: schema shape, preset propagation, integration flags, static paths

### Manual E2E Verification

**Setup**: Link the CLI binary locally so you can run `agent-swarm onboard` from any directory:

```bash
# From the worktree root
cd ~/worktrees/agent-swarm/2026-03-20-feat/cli-onboarding
bun link

# Now test from a clean temp directory (won't touch your project)
cd /tmp && rm -rf swarm-e2e && mkdir swarm-e2e && cd swarm-e2e
```

**Tests to run**:

```bash
# 1. Interactive dry-run (walk through every screen)
agent-swarm onboard --dry-run
# → Local → Dev Team → Claude → paste fake token → skip integrations → review → done

# 2. Non-interactive dry-run (instant, no prompts)
API_KEY=test123 CLAUDE_CODE_OAUTH_TOKEN=fake-token \
  agent-swarm onboard --yes --preset=dev --dry-run
# → Completes immediately with file previews

# 3. Error cases
agent-swarm onboard --yes --dry-run
# → "Onboard failed: --preset is required..."

agent-swarm onboard --yes --preset=dev --dry-run
# → "Onboard failed: CLAUDE_CODE_OAUTH_TOKEN..."

# 4. Actual file generation + validation
API_KEY=mykey123 CLAUDE_CODE_OAUTH_TOKEN=fake-token \
  agent-swarm onboard --yes --preset=dev
# → Writes files, then hits prereq check (Ctrl+C or let it run)
docker compose -f docker-compose.yml config --quiet  # Valid YAML
cat .env | head -10                                   # Real credentials
cat .agent-swarm/config.json | jq .                   # Valid manifest

# 5. Solo preset (no lead, skips post_task)
API_KEY=test CLAUDE_CODE_OAUTH_TOKEN=test \
  agent-swarm onboard --yes --preset=solo --dry-run
# → Shows 1 agent configured

# 6. With integrations
API_KEY=test CLAUDE_CODE_OAUTH_TOKEN=test GITHUB_TOKEN=ghp_xxx \
  GITHUB_EMAIL=you@example.com GITHUB_NAME="Your Name" \
  agent-swarm onboard --yes --preset=dev --dry-run
# → Shows "Integrations: github" in output

# 7. Full stack test (requires real OAuth token + Docker + free port 3013)
agent-swarm onboard
# → Complete wizard → verify agents register → send test task
curl -s -H "Authorization: Bearer <api-key>" http://localhost:3013/api/agents | jq '.agents[] | {name, status}'

# 8. Cleanup
docker compose down -v
cd /tmp && rm -rf swarm-e2e
bun unlink  # from worktree root if desired
```

## References
- Brainstorm: `thoughts/taras/brainstorms/2026-03-20-setup-cli-onboarding.md`
- Existing setup: `src/commands/setup.tsx`
- Compose generator (web): `templates-ui/src/lib/compose-generator.ts`
- Template schema: `templates/schema.ts`
- Docker entrypoint: `docker-entrypoint.sh`
- Env examples: `.env.example`, `.env.docker.example`

---

## Review Errata

_Reviewed: 2026-03-20 by Claude_

### All Resolved

- [x] **`SelectInput` → `Select`** — replaced all references throughout. `@inkjs/ui` v2.0.0 exports `Select`, not `SelectInput`. Also noted: `MultiSelect`, `ProgressBar`, `StatusMessage`, `ConfirmInput` are available.
- [x] **Task API schema** — fixed to `{ task: userInput, agentId: leadAgentId }` per `src/http/tasks.ts:52-63`.
- [x] **Solo preset + first task** — `post_task` now skips for solo preset (DAG routes `post_dashboard → done`).
- [x] **`setup.tsx` functions private** — Phase 7 extracts to `src/commands/shared/client-config.ts`. Command structure updated.
- [x] **`Map` → `Record`** — changed `agentIds` type to `Record<string, string>`.
- [x] **Pi harness UX contradiction** — Pi is now "coming soon" in harness selector. "What We're NOT Doing" updated.
- [x] **`.env` gitignore** — Phase 5 now adds both `.env` and `.agent-swarm/` to output dir's `.gitignore`.
- [x] **Cross-platform clipboard** — Phase 4 detects OS (`pbcopy`/`xclip`/`clip.exe`) with fallback.
- [x] **`onboard.tsx` size** — committed to step-per-file split in `src/commands/onboard/steps/`. Command structure updated.
- [x] **"Linear" → "DAG-based"** — Implementation Approach updated.
- [x] Frontmatter missing `planner` field — minor, not blocking.
