---
date: 2026-10-24T10:30:00Z
planner: Claude
topic: "Conversion push in the agent-swarm repo: README, skill fastest path, demo bar (Plan B)"
tags: [plan, conversion, readme, skill, demo]
status: draft
autonomy: critical
commit_per_phase: true
related_plan: "~/Documents/code/agent-swarm-landing/thoughts/taras/plans/2026-10-24-conversion-landing.md (Plan A)"
---

# Conversion push in the agent-swarm repo (Plan B) Implementation Plan

## Overview

Raise installs and GitHub stars from the surfaces outside the landing: the repo README and settings, the operator skill (`/skill.md`), and the demo app.

- **Motivation**: in 14 days, 635 unique visitors opened the repo front page and only 53 came from the landing. The README has no star ask and the install starts at line 65 of 145. An agent fetches 6 to 9 files before its first install command. The demo is the largest landing exit (128 visitors in 30 days) and asks for nothing.
- **Related**:
  - `~/Documents/code/agent-swarm-landing/thoughts/taras/research/2026-10-22-conversion-audit.md` (audit synthesis, binding decisions)
  - Plan A: `~/Documents/code/agent-swarm-landing/thoughts/taras/plans/2026-10-24-conversion-landing.md`

### Binding decisions (Taras, 2026-10-23 to 2026-10-24)

1. The canonical install path is the agent prompt and the skill. The wizard stays. The skill fastest path may tell the agent to run `install.sh`, which wraps `agent-swarm onboard --yes`.
2. Show Taras the exact README first screen, repo description, and topics before any change to GitHub repo settings.
3. Never publish install counts. No install aggregate in the public stats script.
4. Out of scope: `INSTALL_METHOD=skill`, acquisition-source telemetry, a private install count.
5. (2026-10-24) The fastest path uses the `full` preset.
6. (2026-10-24) Public copy is harness-agnostic: never "for Claude Code". The category line is "the open-source, AI-native system of work".
7. (2026-10-25) The skill may say, once, after a verified install, that a star helps other teams find the project. The agent never stars the repo itself.
8. (2026-10-25) One-click deploy targets (Railway, Render, DigitalOcean, and others) are a follow-up, not part of this plan. Background research on the top providers runs first.

## Current State Analysis

Checked at agent-swarm `dd1ac9f1d` (= `origin/main`, 2026-10-24). Full notes: `~/Documents/code/agent-swarm-landing/thoughts/taras/research/2026-10-24-conversion-plan-current-state.md`.

### README and repo settings

- `README.md` has 147 lines and no H1. Line 1 is a badge row (stars, license, PRs). Line 2 is the tagline: `<a href="https://swar.am">Agent Swarm</a> is the open-source, self-hosted AI company operating system built by Desplega Labs.`
- Lines 5-6: the only ask is a `[!TIP]` to **Watch** the repo. No star ask (`grep -i star` hits only the badge and "Star History" at `:131`).
- Lines 7-9: demo video, video links, a badge row with Website (`agent-swarm.dev`), Docs, Dashboard, Discord, X, LinkedIn, YouTube. Line 11: one-paragraph description.
- `## Quick Start` starts at line 65. The first command is `npx skills add desplega-ai/agent-swarm` (`:67-71`). The installer is at `:90-94`: `curl -fsSL https://raw.githubusercontent.com/desplega-ai/agent-swarm/main/install.sh | bash -s -- --preset full`.
- Repo settings (`gh api`, GET): description "Your Company Agentic Operating System", homepage `https://agent-swarm.dev`, 937 stars, 20 topics (the maximum): agent-coordination, agent-infrastructure, agent-os, agent-runtime, agent-swarm, agent-teams, agentic-os, agentic-workflows, ai-operating-system, ai-orchestration, ai-os, claude-agent-sdk, company-brain, company-os, llm-orchestration, multi-agent-orchestration, openai-codex, parallel-agents, slack-bot, subagents.
- CI for a README-only change runs only the secret scan and the PR Body check (`.github/pull_request_template.md` needs **Why:** and **Risk:** lines).

### Operator skill and installer

- `skills/agent-swarm/SKILL.md` has 38 lines: `## Install` is a 15-item checklist (`:11-28`), then `## Use, in this order` (`:30-38`). Item 1 says to deploy every agent in the Compose example (1 lead, 11 workers).
- `install.sh` is not mentioned in `SKILL.md` or `references/`. The wizard appears once, as an alternative (`:25`). The first install command sits in `references/compose.md:5-11`, behind about 7 fetched files if the checklist is followed.
- Links: 22 `blob/main` GitHub links (HTML pages) and about 21 docs URLs. `scripts/check-operator-skill.ts` (CI job `operator-skill`, `merge-gate.yml:1300-1318`) checks that each `blob/main` link points to a tracked file and that each docs URL answers HEAD 200.
- `install.sh` (400 lines, repo root): checks Docker and Compose v2, installs Bun when missing, runs `agent-swarm onboard --yes --preset <preset>` with stdin from `/dev/null`, waits up to 180 s for `/health`, and prints the dashboard `/setup?apiUrl=...&apiKey=...` link. No prompts. Default preset `solo`. Credentials pass through env vars: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `HARNESS_PROVIDER`, `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`. Without a credential, workers wait for one on `/setup`.
- The generated deployment mounts the API volume at `/app/data` (`src/commands/onboard/compose-generator.ts:176`) but leaves `AGENT_SWARM_VERSION=` blank, which tracks `latest` (`env-generator.ts:19-24`). So after the installer, the skill's "pin the image version" item still applies.
- Presets (`src/commands/onboard/presets.ts`): `full` = 1 lead + 10 workers (one coder where the Compose example runs two), `dev` = lead + 2 coders, `solo` = 1 coder.
- Docs getting-started (`docs-site/content/docs/(documentation)/getting-started.mdx:44`) labels the wizard "Recommended". It stays.
- The landing mirrors `SKILL.md` from `main` (`agent-swarm-landing/src/lib/skill-source.ts:14-15`). Any byte change changes the landing digest, so Plan A Phase 10 refreshes the mirror after this plan merges.

### Demo app (`apps/ui`)

- Demo mode is the build-time flag `VITE_DEMO_MODE` (`src/lib/deployment-config.ts:20-24,42`), exported as `isDemoMode` (`:47`). No hostname check.
- Indicators: a "Live demo" corner ribbon on md+ (`src/app/App.tsx:12-21`, `z-[60]`, top-left) and a "Demo" chip below md (`src/components/layout/app-header.tsx:38-42`). The sidebar header adds `pl-20` in demo mode (`app-sidebar.tsx:425`).
- Shell (`src/components/layout/root-layout.tsx:111-139`): `SidebarProvider h-svh overflow-hidden` > `AppSidebar` + `SidebarInset` > `AppHeader`, `<main>`, `AppFooter`. A bar above `AppHeader` inside `SidebarInset` spans the content column on every size and does not collide with the ribbon.
- The header GitHub icon (`app-header.tsx:93-115`) is hidden below sm and uses `rel="noopener noreferrer"`. No star count anywhere in the app.
- Stack: React 19, Vite 7, Tailwind 4, shadcn-style `src/components/ui/button.tsx`, lucide icons (`Github`, `Star` available). `apps/ui/CLAUDE.md` allows design tokens only; `bun run check:tokens` enforces it.
- Analytics: Plausible only, injected at build time when `VITE_PLAUSIBLE_ANALYTICS` is set (`vite.config.ts:19-55`). Whether the demo project sets it is not verified. The landing links the demo with `utm_source=landing&utm_medium=cta&utm_campaign=company-landing` (`agent-swarm-landing/src/lib/landing-demo.ts:1-4`).
- `apps/ui` is shared by the hosted app and self-host builds. Anything not gated on `isDemoMode` ships to every user.

## Desired End State

1. The README opens with `# Agent Swarm`, the harness-agnostic tagline, a star ask, and the install prompt, all in the first screen. Links use `www.agent-swarm.dev`, not `swar.am`.
2. The repo description and topics match the text Taras approved.
3. `SKILL.md` starts with a "Fastest path" that an agent can run after reading one file: the installer with `--preset full`, the list of human inputs, the follow-up items the installer does not cover (version pin, backups, HTTPS), and verification. `bun run check:operator-skill` passes.
4. The demo shows a thin bar on every screen size with "Install on your infra" (to `www.agent-swarm.dev/install` with UTM) and "Star on GitHub". The bar exists only when `isDemoMode` is true.

## What We're NOT Doing

- No telemetry changes.
- No docs restructure. Docs keep the wizard as "Recommended".
- No change to `install.sh` behavior or its default preset.
- No conversion of the skill's 22 `blob/main` links to raw links (the CI checker validates `blob/main` only). The fastest path itself needs no extra fetch.
- No star count in the demo bar (no client call to `api.github.com` from demo visitors). Add it later if Taras asks.
- No demo analytics events. Landing Plausible sees demo-bar traffic through `utm_source=demo`, and GitHub's referrer report sees `demo.agent-swarm.dev` once the bar's star link drops `noreferrer`.
- No landing changes. Plan A owns those, including the `public/skill.md` mirror refresh.

## Implementation Approach

- Text first, behind approval gates. Phases 1 and 2 put exact text in front of Taras before anything changes on GitHub. Writing this copy is design work, so it stays in the main session.
- The fastest path reuses the installer that exists today. It adds no new install mechanism.
- The demo bar is one small component gated on `isDemoMode`, placed inside `SidebarInset` above `AppHeader`. Executor: Opus (UI).
- One PR for README + SKILL.md (they change together, like `a5dadffd9`), one PR for the demo bar. Repo settings change through `gh repo edit` after approval.

## Quick Verification Reference

- Skill checker (needs network): `bun run check:operator-skill`
- Root checks: `bun run lint`, `bun run tsc:check`, `bun run test:root`
- PR body: `bun scripts/check-pr-body.ts --title "<title>" --body-file <file>`
- UI: `cd apps/ui && bun run lint && bun run check:tokens && bunx tsc -b && bun run build`
- UI tests: `bun test apps/ui/src` (from the repo root)

---

## Phase 1: README first screen

### Overview

The README's first screen carries the H1, the tagline, the star ask, and the install prompt. Taras approves the exact text before the edit.

### Changes Required:

#### 1. Draft for approval (replace lines 1-6, keep the video and the badge rows)
**File**: `README.md`
**Changes**: Draft text:

````markdown
# Agent Swarm

<p align="center">[existing badge row from line 1, unchanged]</p>
<p align="center"><b>The open-source, AI-native system of work.</b> A lead agent plans the work and routes every team task to AI agents that run on your own infrastructure. Built by <a href="https://desplega.sh">Desplega Labs</a>. <a href="https://www.agent-swarm.dev">www.agent-swarm.dev</a></p>
<!-- [existing "not OpenAI Swarm" comment, unchanged] -->

> [!TIP]
> ⭐ **If Agent Swarm is useful to you, star this repo.** It helps other teams find it. To follow every release, [watch it →](https://github.com/desplega-ai/agent-swarm/subscription).

**Install with one prompt.** Paste this into Claude Code, Codex, or any coding agent:

```text
Read https://agent-swarm.dev/skill.md and help me install and operate Agent Swarm on our infra. Ask about my setup before running anything.
```

Prefer a terminal? Run the installer from the [Quick Start](#quick-start) (Docker and Compose v2 required).
````

The prompt text matches the landing's `PROMPT_TEXT` byte for byte. The tagline keeps a list of harnesses as examples only.

#### 2. Apply after approval
**File**: `README.md`
**Changes**: Apply the approved text. Replace `https://swar.am` with `https://www.agent-swarm.dev` everywhere in the README.

### Success Criteria:

#### Automated Verification:
- [ ] H1 on line 1: `head -1 README.md` prints `# Agent Swarm`
- [ ] No `swar.am`: `! grep -n "swar.am" README.md`
- [ ] Prompt matches the landing: `grep -F "Read https://agent-swarm.dev/skill.md and help me install and operate Agent Swarm on our infra. Ask about my setup before running anything." README.md`
- [ ] PR body check passes: `bun scripts/check-pr-body.ts --title "docs(readme): star ask and install prompt on the first screen" --body-file /tmp/conv-readme-pr.md`

#### Automated QA:
- [ ] Render the README with `gh api -X POST /markdown -f mode=gfm -f context=desplega-ai/agent-swarm -f text="$(head -30 README.md)"` and check that the H1, the tip, and the code block render.

#### Manual Verification:
- [ ] **Checkpoint: Taras approves the exact README text** before the edit.

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 1] readme: star ask and install prompt`.

---

## Phase 2: Repo description and topics

### Overview

The GitHub description and topics match the approved text. This is a direct settings change outside the PR flow.

### Changes Required:

#### 1. Draft for approval
**Changes**:
- Description (112 chars): "The open-source, AI-native system of work. A lead agent routes your team's tasks to AI agents on your own infra."
- Homepage: `https://www.agent-swarm.dev`
- Topics: remove `agentic-os`, `ai-os`, `agent-runtime`, `company-brain`, `subagents`. Add `ai-agents`, `self-hosted`, `mcp`, `docker`, `coding-agents`. The count stays at 20.
- Record the current values first (`gh api repos/desplega-ai/agent-swarm --jq '{description,homepage,topics}' > /tmp/conv-repo-settings-before.json`) so the change can be reverted.

#### 2. Apply after approval
**Changes**: `gh repo edit desplega-ai/agent-swarm --description "<approved>" --homepage "https://www.agent-swarm.dev" --remove-topic <5 topics> --add-topic <5 topics>`.

### Success Criteria:

#### Automated Verification:
- [ ] Settings match: `gh api repos/desplega-ai/agent-swarm --jq '{description,homepage,topics}'` shows the approved values and 20 topics

#### Automated QA:
- [ ] `curl -s https://github.com/desplega-ai/agent-swarm | grep -o "<title>[^<]*"` shows the new description in the page title.

#### Manual Verification:
- [ ] **Checkpoint: Taras approves the exact description and topic list** before `gh repo edit` runs.

**Implementation Note**: After this phase, pause for manual confirmation. No commit (settings only). Delete `/tmp/conv-repo-settings-before.json` after Taras confirms.

---

## Phase 3: Fix the installer's agent volume paths

*(Added 2026-10-25 after the deploy research, `~/Documents/code/agent-swarm-landing/thoughts/taras/research/2026-10-25-one-click-deploy-providers.md`. Taras to confirm.)*

### Overview

A swarm made by `install.sh` persists each agent's personal workspace, shared directory and logs, as the Compose example does. Today the fastest path in Phase 4 would send users to an installer whose agents lose memory, todos and cloned repos when a container is recreated.

### Changes Required:

#### 1. Mount paths
**File**: `src/commands/onboard/compose-generator.ts:246-248`
**Changes**: Mount `swarm_logs:/logs`, `swarm_shared:/workspace/shared`, and `swarm_<agent>:/workspace/personal`, the paths the worker image uses (`docker-entrypoint.sh:486`, `docker-compose.example.yml:342-344`). Before the edit, confirm with `grep -rn "/app/agent\|/app/shared\|/app/logs" Dockerfile.worker docker-entrypoint.sh src` that nothing reads the old paths.

#### 2. Test
**File**: `src/tests/onboard-compose.test.ts`
**Changes**: Assert that every generated agent service mounts `/logs`, `/workspace/shared` and `/workspace/personal`, and no `/app/*` agent path.

#### 3. Existing installs
**Changes**: Note in the PR and in `CHANGELOG.md`: installs made before the fix keep their old compose file. To keep agent memory from now on, re-run `agent-swarm onboard` or edit the three mount lines by hand. The old volumes held no data the image used, so nothing needs migration.

### Success Criteria:

#### Automated Verification:
- [ ] Test passes: `bun test src/tests/onboard-compose.test.ts`
- [ ] Root checks pass: `bun run lint && bun run tsc:check && bun run test:root`
- [ ] No old paths left: `! grep -n "/app/agent\|/app/shared\|/app/logs" src/commands/onboard/compose-generator.ts`

#### Automated QA:
- [ ] On a Docker host (not Taras's laptop), run `install.sh --preset dev`, write a file to `/workspace/personal` in the lead container, run `docker compose up -d --force-recreate lead`, and confirm the file is still there. Then `docker compose down -v` and delete the install directory.

#### Manual Verification:
- [ ] Taras confirms the fix belongs in this plan.

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 3] onboard: mount agent volumes at the image paths`.

---

## Phase 4: Skill fastest path

### Overview

`SKILL.md` opens with a "Fastest path" section that an agent can run from this one file. The checklist stays for custom setups.

### Changes Required:

#### 1. Fastest path section
**File**: `skills/agent-swarm/SKILL.md` (new section between the intro at `:6-9` and `## Install` at `:11`)
**Changes**: Draft:

```markdown
## Fastest path

Use this path for one Docker host. For Kubernetes or a custom agent set, use the Install checklist.

1. Ask the operator for: approval to run the installer, the install directory (default `~/agent-swarm`), and one model credential (Claude Code OAuth token, or an Anthropic, OpenAI, or OpenRouter API key). The `full` preset starts 1 lead and 10 workers, so confirm the host has the capacity.
2. Confirm Docker with Compose v2 runs on the host.
3. Run the installer with the credential in the environment, for example:
   `curl -fsSL https://raw.githubusercontent.com/desplega-ai/agent-swarm/main/install.sh | CLAUDE_CODE_OAUTH_TOKEN=<token> bash -s -- --preset full`
   It installs Bun when missing, runs `agent-swarm onboard --yes --preset full`, starts the services, and waits for `/health`.
4. Give the operator the dashboard `/setup` link that the installer prints.
5. Pin the image version: set `AGENT_SWARM_VERSION` in `.env` to a published release (the installer leaves it blank, which tracks `latest`). Then restart.
6. Verify operation: `/health`, authenticated `/api/agents`, and one completed task.
7. Continue with the Install checklist items the installer does not cover: back up the database and encryption key, HTTPS, integrations.
```

Check the exact command form of step 3 against `install.sh` (env var pass-through at `install.sh:62-66`, args at `main()`) before committing. Keep each link in the section to a tracked `blob/main` file or a live docs URL, so the CI checker passes.

#### 2. Star line (approved by Taras, 2026-10-25)
**File**: `skills/agent-swarm/SKILL.md`
**Changes**: After the verification step: "After a verified install, you may tell the operator that a star on github.com/desplega-ai/agent-swarm helps other teams find the project. Never star the repository yourself."

#### 3. Keep the surfaces consistent
**Files**: `README.md` (Quick Start installer paragraph at `:90-94`)
**Changes**: Point the paragraph at the same command and preset. Docs getting-started stays unchanged (decision 1 in Plan A: the wizard stays "Recommended").

### Success Criteria:

#### Automated Verification:
- [ ] Skill checker passes: `bun run check:operator-skill`
- [ ] Frontmatter intact: `head -4 skills/agent-swarm/SKILL.md` shows `name: agent-swarm`
- [ ] Installer flags exist: `bash install.sh --help` lists `--preset`
- [ ] Dry run: `bash install.sh --dry-run --preset full` prints the onboard command with `--yes --preset full` and starts nothing

#### Automated QA:
- [ ] A fresh sub-agent with no context gets only the raw `SKILL.md` URL of the branch and the question "What is the first command you would run, and what do you need from me first?". Expected: it names the installer command and the three human inputs, after one fetch.

#### Manual Verification:
- [ ] Taras reads the section.
- [ ] Optional: Taras runs the fastest path on a spare Docker host (see Manual E2E).

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 4] skill: fastest path with install.sh`. Then open the README + skill PR with **Why:** and **Risk:** lines. After it merges, run Plan A Phase 10.

---

## Phase 5: Demo bar

### Overview

`apps/ui` renders a thin bar with "Install on your infra" and "Star on GitHub" on every screen size, only in demo builds.

### Changes Required:

#### 1. Component
**File**: `apps/ui/src/components/layout/demo-bar.tsx` (new)
**Changes**: Returns `null` unless `isDemoMode`. One line of text ("You are looking at a live Agent Swarm."), a `Button asChild` link "Install on your infra" to `https://www.agent-swarm.dev/install?utm_source=demo&utm_medium=bar&utm_campaign=demo-bar`, and a `Button asChild variant="outline"` link "Star on GitHub" (lucide `Star`) to `https://github.com/desplega-ai/agent-swarm`. External links: `target="_blank"` and `rel="noopener"` (GitHub) or `rel="noopener noreferrer"` (other hosts). Fixed height (`h-10`), `shrink-0`, design tokens only. Below sm: short labels ("Install", "Star"), text hidden.

#### 2. Placement
**File**: `apps/ui/src/components/layout/root-layout.tsx:113-114`
**Changes**: Render `<DemoBar />` above `<AppHeader />` inside `SidebarInset`. Keep the ribbon and the mobile chip.

#### 3. Header GitHub icon
**File**: `apps/ui/src/components/layout/app-header.tsx:104-108`
**Changes**: `rel="noopener"` (github.com exception, same rule as the landing).

#### 4. Test
**File**: `apps/ui/src/components/layout/demo-bar.test.tsx` (new)
**Changes**: Renders nothing when `isDemoMode` is false. Renders both links with the right `href` and `rel` when it is true.

### Success Criteria:

#### Automated Verification:
- [ ] Unit test passes: `bun test apps/ui/src/components/layout/demo-bar.test.tsx`
- [ ] Lint passes: `cd apps/ui && bun run lint`
- [ ] Tokens pass: `cd apps/ui && bun run check:tokens`
- [ ] Typecheck and build pass: `cd apps/ui && bunx tsc -b && bun run build`
- [ ] Non-demo build has no bar: `cd apps/ui && VITE_DEMO_MODE= bun run build && ! grep -rl "Install on your infra" dist/assets`

#### Automated QA:
- [ ] `cd apps/ui && VITE_DEMO_MODE=true bun run dev`, then `agent-browser` at 390, 768 and 1280 px: the bar is visible, does not overlap the ribbon or the header, and `main` still scrolls. Screenshots to agent-fs `qa/agent-swarm/<date>-demo-bar/`.
- [ ] The Install link opens `www.agent-swarm.dev/install` with the UTM parameters.

#### Manual Verification:
- [ ] Taras checks the screenshots.
- [ ] None for analytics: the demo already runs Plausible (site `demo.agent-swarm.dev`, 146 visitors from `utm_source=landing` in the 30 days to 2026-10-24).

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 5] ui: demo bar with install and star`. Open the PR with **Why:** and **Risk:** lines.

---

## Appendix

- **Follow-up plans**: Plan A (landing repo). Plan A Phase 10 refreshes the landing skill mirror after the Phase 4 PR merges. One-click deploy targets: research report at `~/Documents/code/agent-swarm-landing/thoughts/taras/research/2026-10-25-one-click-deploy-providers.md` (in progress 2026-10-25), then a separate plan.
- **Derail notes**:
  - No CI check keeps README, getting-started, `SKILL.md`, and `install.sh` consistent.
  - The README video sub-line and badge row repeat links that are also in the footer of the docs.
- **References**: `~/Documents/code/agent-swarm-landing/thoughts/taras/research/2026-10-24-conversion-plan-current-state.md`.

---

## Manual E2E

```bash
# 1. README and repo settings (after merge and gh repo edit)
curl -s https://raw.githubusercontent.com/desplega-ai/agent-swarm/main/README.md | head -15
gh api repos/desplega-ai/agent-swarm --jq '{description,homepage,topics}'

# 2. Skill as an agent sees it
curl -s https://raw.githubusercontent.com/desplega-ai/agent-swarm/main/skills/agent-swarm/SKILL.md | sed -n '/## Fastest path/,/## Install/p'

# 3. Fastest path on a spare Docker host (not Taras's laptop: full = 11 agents)
ssh <spare-docker-host>
curl -fsSL https://raw.githubusercontent.com/desplega-ai/agent-swarm/main/install.sh | CLAUDE_CODE_OAUTH_TOKEN=<token> bash -s -- --preset full --dir ~/agent-swarm-e2e
curl -s <api-url-printed-by-installer>/health
# open the printed /setup link, run one task, confirm it completes
cd ~/agent-swarm-e2e && docker compose down -v && cd ~ && rm -rf ~/agent-swarm-e2e

# 4. Demo bar in production (after the demo deploy)
agent-browser open https://demo.agent-swarm.dev/ && agent-browser set viewport 390 844
agent-browser screenshot /tmp/conv-e2e-demo-390.png
agent-browser close
```

Expected: README first screen as approved, settings as approved, the fastest path section first in the skill, a working swarm with one completed task on the spare host (then removed), and the demo bar on a 390 px screen. Delete `/tmp/conv-e2e-*` afterwards.
