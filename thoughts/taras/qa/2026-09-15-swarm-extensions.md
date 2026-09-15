---
date: 2026-09-15
author: Claude (with Taras)
topic: "Swarm extensions v1: real agents discover, author, install, and rely on extensions"
tags: [qa, extensions, hooks, slack, mcp, dashboard]
status: in-progress
source_plan: thoughts/taras/plans/2026-09-12-swarm-extensions/root.md
related_pr: https://github.com/desplega-ai/agent-swarm/pull/1441
environment: desplega-labs VPS (Docker compose built from the PR branch), Slack mock, real Claude and pi workers
last_updated: 2026-09-15
last_updated_by: Claude
---

# Swarm extensions v1: QA report

## Context

PR #1441 adds trusted TypeScript hook bundles that run inside the API server. Unit and e2e suites are green. This QA answers two questions with real agents on a real deployment: do agents know how to use extensions, and do extensions work as expected in realistic flows.

Deployment: `docker-compose.local.yml` from the branch on the desplega-labs VPS (API, Claude lead, Claude worker, pi worker, agent-fs). Slack goes through `@desplega.ai/slack-mock` on the host, so the handler code path is the real one and every channel can be screenshotted.

## Scope

### In Scope
- Agent discoverability: an agent receives a natural-language request and produces a valid, installed extension.
- Task policy guard across origins (REST, MCP, Slack, follow-up).
- Slack channel routing and a post-completion notification.
- Tool-call guard enforced on a real worker session.
- Dashboard pages (list, detail, versions, run log) with screenshots.
- Failure handling (auto-disable), versioning and rollback.
- Example extensions shipped as templates.

### Out of Scope
- Worker runtime hooks (not in v1).
- Multi-replica coordination.
- Production deployment.

## Test Cases

### TC-1: Deploy the branch on the VPS
**Steps:**
1. Clone the PR branch, build API and worker images, start compose with a Slack mock override.
2. Check `/health`, migration 153, agents online, Slack socket mode connected to the mock.

**Expected Result:** API healthy, three agents online, Extensions page empty.
**Actual Result:** pending
**Status:** pending

### TC-2: Discoverability baseline (before the skill fix)
**Steps:**
1. Send the lead a task: "Write and install a swarm extension that blocks REST and MCP tasks without a DES-### ticket reference."
2. Read the session: did the agent find the hook contract, install a valid bundle, and report the enable step?

**Expected Result:** Documents how far an agent gets with only the two MCP tools.
**Actual Result:** pending
**Status:** pending

### TC-3: Discoverability after the fix (seeded skill + tool descriptions)
**Steps:**
1. Rebuild the API image with the `swarm-extensions` seeded skill and updated tool descriptions.
2. Repeat TC-2 on a fresh worker session.

**Expected Result:** The agent loads the skill, fetches type-defs, installs a valid bundle first try, and tells the operator to enable it.
**Actual Result:** pending
**Status:** pending

### TC-4: Task policy guard across origins
**Steps:**
1. Enable `require-ticket-ref`.
2. Create tasks without a ticket via REST, via `send-task` from a worker MCP session, and via Slack mock. Create one with `DES-123` via REST.
3. Check that schedule and follow-up origins are unaffected.

**Expected Result:** REST returns 422 with the reason, MCP returns an error result, Slack replies with the block reason, the `DES-123` task is created, and the run log shows one `block` per attempt.
**Actual Result:** pending
**Status:** pending

### TC-5: Slack channel routing + completion notification
**Steps:**
1. Enable `route-channel-to-agent` for `#general` to the pi worker and `notify-on-complete` for a `#swarm-done` channel.
2. Post a mention in `#general` through the mock.
3. Wait for completion.

**Expected Result:** The task is pinned to the pi worker, completes, and a summary appears in `#swarm-done` posted by the bot on behalf of `ext:notify-on-complete`.
**Actual Result:** pending
**Status:** pending

### TC-6: Tool-call guard on a real worker session
**Steps:**
1. Enable `require-verification-note` (blocks `store-progress` with status completed unless the output contains a `Verified:` line).
2. Give the Claude worker a small task and watch its session.

**Expected Result:** The first completion call is blocked with the reason, the worker adds the line, the second call succeeds, and the run log shows block then continue.
**Actual Result:** pending
**Status:** pending

### TC-7: Dashboard
**Steps:**
1. Open Settings, Extensions, the detail page, versions, run log.
2. Toggle enable/disable, activate an older version.

**Expected Result:** DataGrid lists match the API, actions reflect within one reload, run log rows show event, result, duration, and error text.
**Actual Result:** pending
**Status:** pending

### TC-8: Failure handling and versioning
**Steps:**
1. Install a throwing extension via an agent, enable it, create five tasks.
2. Install v2 of `require-ticket-ref`, activate, then roll back to v1.

**Expected Result:** The throwing extension auto-disables after five failures with the error visible in the run log. Version activation and rollback reload the handlers without restart.
**Actual Result:** pending
**Status:** pending

## Edge Cases & Exploratory Testing
- pending

## Evidence

### Screenshots
- pending

### Logs & Output
```
pending
```

### External Links
- [PR #1441](https://github.com/desplega-ai/agent-swarm/pull/1441)

## Issues Found
- [ ] Agents have no path to the hook contract: no seeded skill mentions extensions and the tool descriptions do not point at `GET /api/extensions/type-defs`. severity: major (fixed in this PR, see TC-3)

## Verdict
**Status**: IN PROGRESS
**Summary**: pending

## Appendix

- **Plan**: `thoughts/taras/plans/2026-09-12-swarm-extensions/root.md`
- **Notes**: Slack runs against the mock because the handler ignores bot-authored messages, so an automated run cannot post as a human through the real dev bot.
