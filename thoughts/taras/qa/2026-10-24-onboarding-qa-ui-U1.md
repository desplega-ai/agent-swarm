---
date: 2026-10-24
topic: Onboarding QA, ui mode, persona U1 (feedback round on latest main)
run: 1024-2104-ui (bare installer) and 1024-2130-ui2 (documented installer, preset full)
swarm_version: 2.5.3
status: friction
---

# Onboarding QA: ui mode, U1, two passes

Two passes on fresh boxes against latest `main` (`dd1ac9f1d`, release v2.5.3).

- **Pass A** ran the bare installer (`install.sh --tunnel`, default preset `solo`). The tunnel never served its URL, because the tunnel host could not get a TLS certificate. With a workaround tunnel, `/setup` steps 1-6 took 2:30. Step 7 cannot finish, because `solo` has no lead.
- **Pass B** ran the documented installer (`--preset full --tunnel`, as in the README and getting-started). Everything worked. `/setup` reached 7/7 in 2:29. But the first task got a question back instead of a result. The first real output came 6:30 later, after one human round trip, for $1.29.

Compared with 2026-10-21: F3 is fixed. F1, F2, F4, F6, F7 and F9 are still open. F10 to F19 are new.

## Setup

| Field | Pass A | Pass B |
|---|---|---|
| Box | Hetzner cpx32 (4 vCPU, 8 GB), `docker-ce`, fsn1. Deleted 21:30 BCN | Same type. Deleted 21:50 BCN |
| Entry point | `install.sh --tunnel` | `install.sh --preset full --tunnel` |
| Agents | Coder only (no lead) | Lead and 10 workers. 12 containers used 2.4 GB of 8 GB |
| Dashboard | https://app.agent-swarm.dev | Same |
| Telemetry org | `org_c5035509b492955d` | `org_f9db645cf9a2d42c` |

## Metrics

| Metric | Pass A | Pass B |
|---|---|---|
| Installer start to ready | 1 s fail (F1), then 6:33 | 6:54 (unzip installed first) |
| Tunnel serves its URL | Never during the run (F10) | Yes, at once |
| `/setup` steps 1-6 | 2:30, after a 7 min detour for F10 | 1:17 |
| First task completed | 0:15 through Sessions, by the Coder. Step 7 stays "To do" | 0:43, but the result is a question (F13) |
| First real result | Not tried | 6:30 after the first send, 6 tasks, $1.29 |
| `/setup` completed / skipped / blocked | 5 / 1 / 1 | 6 / 1 / 0 (7/7) |
| Rescues | 1: a Cloudflare quick tunnel instead of the broken one | 0 |

## Friction

Severity: **P0** blocks a real user. **P1** a real user would likely stop or need support. **P2** polish.

### F10 (P0, new): the install tunnel waits on a per-name certificate, and tonight it never came

- **Seen:** `https://silent-flowers-show.lt.desplega.ai` hung in the TLS handshake. The installer printed only `warning: tunnel warm-up did not get a 200 (last: 000)`. Then the `/setup` link opened to "Can't reach the API server". After Save & Connect, the page showed a blank card and "Disconnected" with no explanation.
- **Cause:** Caddy on `desplega-main` gets a new certificate for each tunnel name on demand, from ZeroSSL only (`*.lt.desplega.ai` block in `/etc/caddy/Caddyfile`). ZeroSSL's ACME endpoint timed out from that host and from my laptop. ZeroSSL answered again at about 21:30 BCN.
- **Scale (Caddy log, last 14 days):** 55 tunnel names. Time to certificate: median 33 s, p90 138 s, 17 over 60 s, 2 over 10 min (max 35 h). On 18-20 Oct most attempts failed. So many users likely see the "Can't reach" screen on their first click, even on a good day.
- **Telemetry cannot see this:** a dashboard that cannot reach the API sends no events.
- **Fix ideas:**
  - Infra, the real fix: one wildcard certificate for `*.lt.desplega.ai` through a DNS-01 challenge. Then no tunnel waits for a certificate. DNS is at Namecheap, so this needs the `caddy-dns/namecheap` module or a move of the `lt` zone.
  - Short term: put Let's Encrypt first and ZeroSSL second in that block. That is 11 certs a week, far under the Let's Encrypt limit of 50 a week per registered domain. Note that this limit is shared with every other `desplega.ai` certificate.
  - `install.sh`: wait up to 3 min for a 200 through the tunnel (today it is 8 tries). If it still fails, say clearly that the link will work in a few minutes.
- **Evidence:** `qa/agent-swarm/2026-10-24-onboarding-qa-1024-2104-ui/01-open.png`

### F2 (P0, still open, narrower): the bare installer makes a swarm that can never finish `/setup`

- **Seen:** `install.sh` without `--preset` installs `solo` (one Coder, no lead). Step 7 says "Waiting for the lead" forever. "How to deploy workers" links to the general deployment guide. A task from Sessions completed in 15 s on the Coder, but step 7 stayed "To do". The setup pill stayed at 5/7.
- **Scope:** README and getting-started use `--preset full`, so only users who run the script with no flags hit this. The onboarding-qa skill was one of them (fixed in that skill, see below).
- **Fix idea:** step 7 should accept any online agent when no lead is online, and count the first completed task from any surface. Or `solo` gets a lead. `install.sh` default stays per Plan B.

### F11 (P1, new): an error banner shows before the user connects

- **Seen:** under the "Name This Connection" dialog, a red "Can't reach the API server / Failed to fetch" banner shows on every pass, also when the API is fine. If the connect fails, the app drops `/setup` and goes to `/` with a blank card.
- **Fix idea:** hide the banner while the connect dialog is open. On a failed connect, stay on `/setup` with "Your swarm is not reachable yet" and a Retry button (`apps/ui/src/pages/home/unified-home.tsx`).

### F12 (P1, new): health says "All systems go" with no lead

- **Seen:** in pass A, the health badge said "All systems go / All checks pass" while setup could not finish.
- **Cause:** `computeHealth` (`src/http/status.ts:707`) ignores `workers` in state `configured`. That is the state with no live lead. The milestone already has the hint "Lead has no recent heartbeat".
- **Fix idea:** `workers.state === "configured"` gives `degraded`, so the badge shows the hint.

### F13 (P1, new): the first-task starters need context a fresh swarm does not have

- **Seen:** for "Ship features" the starters are "Draft a tech spec for a feature idea", "Build a small feature from the issue list" and "Add tests for the feature we shipped last". A fresh swarm has no repo and no issues. The first send got a question back ("which feature?") and an approval request. A useful result came 6:30 later, after the user answered.
- **Fix idea:** every use case in `apps/ui/src/pages/setup/steps/first-task/starters.ts` gets at least one starter that works with zero context and gives a visible result in under 1 min. For example: "Introduce the swarm: list each agent and what it is good at", or "Research <topic> and write a one-page summary". Taras approves the copy.

### F1 (P1, still open): the installer fails without `unzip`

- **Seen:** `error: unzip is required to install bun` after 1 s on the Hetzner `docker-ce` image.
- **Fix idea:** check for `unzip` with the other prerequisites in `install.sh`. Print the install command for the user's package manager, or use it when running as root.

### F7 (P1, still open): memory needs a second paid key

- **Seen:** the step opens on OpenAI with an empty key field. There is no keyless option.
- **Fix idea:** offer the local embeddings that agent-fs already ships, or write "Skip: memory works later" next to the key field.

### F14 (P2, new): a second tour starts right after setup

Sending the first task leaves `/setup` for the Sessions page. A 4-step "Sessions live in the sidebar" tour with example sessions then covers the user's own first task. The same tour opens from "Ask the swarm" on home. Fix idea: do not auto-open the tour while the onboarding first task runs.

### F15 (P2, new): the session cost counts only the first task

The session header showed $0.2051 for 6 tasks. The tasks cost $1.29 in total.

### F16 (P2, new): integrations says "All optional", but Continue is disabled

The user must find Skip. Fix idea: enable Continue when nothing is connected, with the same effect as Skip.

### F17 (P2, new): 32 warnings at each worker boot

`[entrypoint] Warning: complex skill <id> has no sourceRepo; skipping npx install` is printed once for each seeded skill, on a clean swarm (`docker-entrypoint.sh`). Fix idea: debug level, or one summary line.

### F18 (P2, new): the logo from the website shows as a thin line

In the sidebar, the `desplega.ai` logo shows as a thin blue line. A wide wordmark probably got squeezed into a square slot. Not checked with other sites.

### F19 (P2, new): the lead says "in progress" and the badge says COMPLETED

After the lead asked its question, its reply ended with "This task stays in progress until then". The badge showed COMPLETED, and the sidebar showed "Needs you".

### Still open from 2026-10-21

- **F4:** the name from a plus-addressed email keeps the tag ("Qa+1024 2104 Ui").
- **F6:** the `/setup` link still opens with "Name This Connection".
- **F9:** the composer says "Routes to Lead" with no lead.
- **F5 and F8:** not checked again.
- **F3 is fixed:** the website prefill stays.

### To check (not confirmed)

In headless Chromium, `https://app.agent-swarm.dev` could not reach an API at `http://localhost:13013` ("Failed to fetch"). This is probably Chrome's local network access rule. A laptop user without `--tunnel` may get a permission prompt or a block. Check this in a headed Chrome.

## Telemetry check

Both passes recorded every step that was viewed, completed and skipped, tagged `onboarding-qa` after the tag. Pass B recorded `onboarding.first_task_completed` and `onboarding.completed`, 61 s after the first send. Pass A has neither, which matches what happened.

The gaps:
- `connect` still sends no `step_viewed`. This is known.
- No event covers F10, so the tunnel failure rate cannot be seen. Fix idea: the installer sends an event with the warm-up result.

## Skill changes from this run (onboarding-qa, PR #2362)

- `ui-install.sh`: default to the documented `--preset full --tunnel`, not the bare default.
- Gotcha: the `lt` tunnel can take minutes to get a certificate. When it does not work, use a Cloudflare quick tunnel as the workaround (`docker run -d --network host cloudflare/cloudflared tunnel --url http://localhost:3013`). Log it as a rescue.

## Teardown

- Both boxes deleted. `box.sh list` is empty.
- Browser sessions closed.
- Screenshots: agent-fs `qa/agent-swarm/2026-10-24-onboarding-qa-1024-2104-ui/` and `.../2026-10-24-onboarding-qa-1024-2130-ui2/`.
- Local run directories deleted.
