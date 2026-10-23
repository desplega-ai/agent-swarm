---
date: 2026-10-21
topic: Onboarding QA, ui mode, persona U1 (first live run of the onboarding-qa skill)
run: 1021-2338-ui
swarm_version: 2.4.5
status: blocked
---

# Onboarding QA: ui mode, U1

First live run of `.claude/internal-skills/onboarding-qa`. The one-shot installer failed on a fresh box. After that, `/setup` ran smoothly to step 6. Step 7 (first task) is a dead end on the default install, because the `solo` preset has no lead.

## Setup

| Field | Value |
|---|---|
| Box | Hetzner cx33, `docker-ce` app image (Ubuntu 24.04.1 + Docker), fsn1. Up 23:38, deleted 23:55 BCN |
| Entry point | `curl -fsSL .../main/install.sh \| bash -s -- --tunnel` (default preset `solo`), then the printed `/setup` link |
| Dashboard | https://app.agent-swarm.dev (as shipped) |
| Telemetry org | `org_a349295f4b0c05ad` |

## Metrics

| Metric | Value |
|---|---|
| Installer start to API healthy | 6:00 (second attempt, after F1). First attempt failed in 2 s |
| To first agent registered | 2:17 after the second attempt started |
| `/setup` steps 1-6 | 5:13 (23:47:43 to 23:52:56) |
| To first task completed | Never through `/setup`. 23:55:04 through Sessions, 16 s after send |
| Rescues | 0. Installing `unzip` is a normal user action |
| `/setup` steps completed / skipped / blocked | 5 / 1 (integrations) / 1 (first_task) |

## Timeline (BCN)

| Time | Step | What happened | Friction |
|---|---|---|---|
| 23:40:16 | install | `install.sh --tunnel` exits 1: `error: unzip is required to install bun` | F1 |
| 23:40:57 | install | `apt-get update && apt-get install -y unzip`, then the installer again | - |
| 23:46:57 | install | Installer done (360 s). Stack = `swarm-api` + `swarm-worker-coder`. No lead | F2 |
| 23:47:10 | tag | `DESPLEGA_TELEMETRY_ENV=onboarding-qa` set, stack restarted | - |
| 23:47:43 | connect | Link opens a "Name This Connection" dialog (random name `swift-prism`) before it connects | F6 |
| 23:48:00 | connect | "Who are you?": name derived from `qa+1021-2338-ui@desplega.ai` is "Qa+1021 2338 Ui" | F4 |
| 23:48:32 | name | Name and website prefilled from the email domain. After the name and team size autosaved, the website field was empty | F3 |
| 23:49:20 | ai | Token typed (not pasted) and Tab: nothing saved, Continue stays disabled, no hint | F5 |
| 23:51:45 | ai | After a real blur: "Saved. Waiting for a worker to check this key", verified 25 s later | - |
| 23:52:23 | memory | Needs an embeddings key (default OpenAI). U1 has none. OpenRouter key: "Memory works" in 5 s | F7 |
| 23:52:56 | integrations | Skipped. Clear | - |
| 23:52:56 | first_task | "Waiting for the lead to come online…" forever. The only agent is an idle Coder worker | F2 |
| 23:54:28 | home | "All systems go" next to "Setup 5/7" and "Lead not ready yet" | F2 |
| 23:54:48 | sessions | "Ask the swarm", send the prefilled goal. Routes to Coder, completes in 16 s. The composer says "Routes to Lead" | F9 |
| 23:55:20 | onboarding | `first_task` still `todo`, onboarding not completed | F2 |

## Friction

Severity: **P0** blocks a real user (or needed a rescue). **P1** a real user would likely stop, or would need docs or support. **P2** polish.

### F2 (P0): `/setup` first task never completes on the default one-shot install

- **Seen:** `install.sh` defaults to preset `solo` = one `official/coder` worker, no lead. Step 7 gates the composer on `leadReady`, so it shows "Waiting for the lead to come online…" forever. The worker can run tasks (the Sessions path completed one in 16 s), but that task does not complete step 7. Home says "All systems go".
- **Expected:** a new user on the default path finishes `/setup`.
- **Evidence:** `15-first-task-no-lead.png`, `16-home-after-setup.png`, `19-session-done.png`. `GET /api/onboarding`: `leadsOnline 0, workersOnline 1, first_task todo` after a completed task.
- **Fix idea:** make `solo` a single lead (or lead + worker) in `src/commands/onboard/presets.ts`, or let step 7 route to any online agent and complete on any finished user task when no lead exists (`apps/ui/src/pages/setup/steps/first-task/first-message-card.tsx`, first-task signal in `src/be/onboarding.ts`). Real-user telemetry fits this: 21 installs viewed `first_task`, 7 completed it.

### F1 (P1): one-shot installer fails on a fresh Hetzner Docker image

- **Seen:** `error: unzip is required to install bun`, exit 1 after 2 s. The image has curl, git, openssl and Docker, but no unzip and no jq. `apt-get install unzip` also fails until `apt-get update` runs.
- **Expected:** the installer checks every prerequisite it needs, like it does for Docker.
- **Evidence:** `~/install.log` first attempt. `ensure_bun` in `install.sh` pipes the Bun installer without an unzip check.
- **Fix idea:** in `install.sh`, check `unzip` next to `check_docker` and print `sudo apt-get update && sudo apt-get install -y unzip`.

### F3 (P1): prefilled company website disappears

- **Seen:** the Identity step showed `desplega.ai` (from the email domain) in the website field. After the swarm name and team size autosaved, the field was empty and "Your logo, filled from your website" stayed locked. U1 had to notice and type it again.
- **Expected:** a prefill stays, or is saved, until the user changes it.
- **Evidence:** snapshot value `desplega.ai` at 23:48:32, empty value (`get value`) less than a minute later (`05-identity-filled.png`).
- **Fix idea:** keep the prefilled draft across the identity autosave in the name step (`apps/ui/src/pages/setup/steps/name/`).

### F7 (P1): memory needs a second paid key

- **Seen:** the step defaults to OpenAI and keeps Continue disabled without a key. A Claude-only user must skip it. OpenRouter worked at once.
- **Expected:** the user knows before the step that it needs an OpenAI-compatible key, and that skipping is fine.
- **Evidence:** `11-memory.png`. Real users: 14 of 21 skip memory, 6 fail it.
- **Fix idea:** say "needs an OpenAI or OpenRouter key, you can add it later" in the step header, and reuse an OpenRouter key from step 3 when one exists.

### F5 (P2): typed secrets do not save on Tab

- **Seen:** a secret field commits on paste, or when focus leaves the whole field group. Tab moves focus to the eye toggle inside the group, so a typed token is not saved and Continue stays disabled without a hint.
- **Fix idea:** commit when the input itself blurs, or show "not saved yet" (`apps/ui/src/components/onboarding/autosave-secret-field.tsx`, `onGroupBlur`).

### F6 (P2): the `/setup` link asks for a connection name first

- **Seen:** a modal "Name This Connection" with a random name and Skip / Save & Connect, before anything else. The docs say the link auto-connects.
- **Fix idea:** connect with the generated name and allow a rename later.

### F4 (P2): name from a plus-addressed email keeps the tag

- **Seen:** `qa+1021-2338-ui@desplega.ai` became "Qa+1021 2338 Ui".
- **Fix idea:** drop the `+tag` before the name is derived.

### F8 (P2): installer output is a TUI in a log file

- **Seen:** `install.sh > file` writes Ink redraw sequences (cursor moves, spinners) to the log. Hard to read, hard to paste into an issue.
- **Fix idea:** plain line output from `onboard --yes` when stdout is not a TTY.

### F9 (P2): "Routes to Lead" with no lead

- **Seen:** the Sessions composer says "Routes to Lead", but the task went to the Coder worker.
- **Fix idea:** show the real route when no lead is online.

## Telemetry check

| Expected event | Seen | Environment | Note |
|---|---|---|---|
| server.started, agent.registered, telemetry.enabled, org.snapshot (first boot) | yes | production | Before tagging: 6 events left as production (accepted) |
| server.started, agent.registered (after restart) | yes | onboarding-qa | Tagging works: hot reload for the API, restart for the worker |
| onboarding.started | yes, 23:47:54 | onboarding-qa | Fires at connect, not at page open |
| step_viewed connect | **no** | - | Only `step_completed connect`. This explains the real-user "connect viewed 8, completed 60" |
| step_viewed / step_completed name, ai, agents, memory | yes | onboarding-qa | Match the UI actions to the second |
| step_skipped integrations | yes | onboarding-qa | - |
| step_viewed first_task | yes | onboarding-qa | No completion (F2) |
| task.created / claimed / completed | yes | onboarding-qa | Task from Sessions, not from step 7 |
| onboarding.first_task_completed, onboarding.completed | no | - | Correct for the end state (F2) |

Gaps: `connect` has no `step_viewed`, so dashboards must not read "connect viewed" as a real count.

## Teardown

- Box deleted 23:55 BCN, `box.sh list` empty.
- Browser session `onboarding-qa-1021-2338-ui` closed.
- Screenshots kept in agent-fs `qa/agent-swarm/2026-10-21-onboarding-qa-1021-2338-ui/` (7 files). Local run dir removed.
