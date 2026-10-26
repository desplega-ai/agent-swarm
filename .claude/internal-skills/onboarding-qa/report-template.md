---
date: YYYY-MM-DD
topic: Onboarding QA, <install|ui> mode, persona <P1..P4|U1>
run: <run id>
swarm_version: <from /health>
status: <pass|friction|blocked>
---

# Onboarding QA: <mode>, <persona>

## Setup

| Field | Value |
|---|---|
| Box | Hetzner <type>, <image>, <location> (deleted at <HH:MM> BCN) |
| Entry point | <landing prompt / install.sh --tunnel / ...> |
| Inner agent | <Claude Code version, model> (install mode only) |
| Dashboard | <https://app.agent-swarm.dev or local apps/ui at <sha>> |
| Telemetry org | <org_...> |

## Metrics

| Metric | Value |
|---|---|
| First prompt or command to API healthy | <mm:ss> |
| To first agent registered | <mm:ss> |
| To first task completed | <mm:ss or never> |
| Inner-agent turns / questions asked / cost | <n> / <n> / $<x> |
| Rescues (persona stepped out) | <n> |
| /setup steps completed / skipped / failed | <n> / <n> / <n> |

## Timeline

| t+ | Step | What happened | Friction |
|---|---|---|---|
| 00:00 | ... | ... | - |

## Friction

Severity: **P0** blocks a real user (or needed a rescue). **P1** a real user would likely stop, or would need docs or support. **P2** polish.

### F1 (P?): <one-line title>

- **Seen:** <what happened, with the error text>
- **Expected:** <what a new user needed>
- **Evidence:** <turn summary, screenshot link, log line>
- **Fix idea:** <file or doc to change, one sentence>

## Telemetry check

| Expected event | Seen | Environment | Note |
|---|---|---|---|
| server.started | yes/no | production/onboarding-qa | first boot is untagged |
| onboarding.step_viewed (each step) | ... | ... | ... |

Gaps between what the tester did and what telemetry recorded: <list, or "none">.

## Teardown

- Box deleted: <yes, `box.sh list` empty>
- Local run dir removed: <yes>
- Browser closed: <yes>
