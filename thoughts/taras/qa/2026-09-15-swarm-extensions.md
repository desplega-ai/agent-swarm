---
date: 2026-09-15
author: Claude (with Taras)
topic: "Swarm extensions v1: real agents discover, author, install, and rely on extensions"
tags: [qa, extensions, hooks, slack, mcp, dashboard, rbac]
status: pass
source_plan: thoughts/taras/plans/2026-09-12-swarm-extensions/root.md
related_pr: https://github.com/desplega-ai/agent-swarm/pull/1441
environment: desplega-labs VPS (Docker compose built from the PR branch), Slack mock, real Claude lead, Claude worker, pi worker
last_updated: 2026-09-15
last_updated_by: Claude
---

# Swarm extensions v1: QA report

## Context

PR #1441 adds trusted TypeScript hook bundles that run inside the API server. Unit and e2e suites were green before this QA. This session answers two questions with real agents on a real deployment: do agents know how to use extensions, and do extensions work in realistic flows.

Deployment: `docker-compose.local.yml` plus a QA override on the desplega-labs VPS (API, Claude lead, Claude worker, pi worker with deepseek-v4-flash, agent-fs). Slack runs through `@desplega.ai/slack-mock` on the host, so the Slack handler code path is real and every channel can be screenshotted. The dashboard ran locally (Vite) against an SSH tunnel to the box.

Five fixes landed in the PR as a result of this QA (see Issues Found). Each was re-verified on the box after an API image rebuild.

## Scope

### In Scope
- Agent discoverability: an agent receives a natural-language request and produces a valid, installed extension.
- Task policy guard across origins (REST, MCP, Slack) with config changes from the dashboard.
- Slack channel routing plus a completion notification posted by an extension.
- Tool-call guard enforced on real agent sessions.
- Dashboard pages (list, detail, versions, run log, enable, activate) with screenshots.
- Failure handling (auto-disable), versioning and rollback, API restart persistence.
- Example extensions shipped as templates plus a seeded skill.

### Out of Scope
- Worker runtime hooks (not in v1). The manifest already allows `runtime: "worker"` and the contract defines `WorkerCtx` (`worker.agentId`, `worker.taskId`, `worker.harness`), but install rejects it. A v2 would ship a loader inside the worker process so hooks can run around harness events (session start, tool use inside the harness, file writes) with the worker's own credentials. That is the next thing to build if extensions should shape what happens inside a session rather than only at the API boundary.
- Multi-replica coordination.
- Production deployment and the real Slack workspace (the handler ignores bot-authored messages, so an automated run cannot post as a human through the real dev bot).

## Test Cases

### TC-1: Deploy the branch on the VPS
**Steps:**
1. Clone the PR branch, build the API and worker images, start compose with a QA override (Slack mock env, extra Claude worker).
2. Check `/health`, agents, Slack socket mode, and the empty Extensions page.

**Expected Result:** API healthy, three agents idle, Slack connected to the mock, Extensions page empty.
**Actual Result:** As expected. Two host-level obstacles: Docker on the box lacked the buildx plugin (installed `docker-buildx`), and the host `inet sandboxd` nftables forward chain drops bridge traffic, so two accept rules for the compose bridge were added (see Appendix for teardown).
**Status:** pass

### TC-2: Discoverability baseline (before the skill fix)
**Steps:**
1. Pin a task to the Claude worker: write and install `require-ticket-ref` (block REST and MCP tasks without a `DES-<n>` reference), do not enable it.
2. Read the session.

**Expected Result:** Documents how far an agent gets with only the two MCP tools.
**Actual Result:** The worker (claude-opus-5) found the contract on its own in about 2.5 minutes: it pulled `/openapi.json`, found `GET /api/extensions/type-defs`, read the d.ts, and produced a valid bundle with `origins` and `exemptTags` config. The MCP `extension-install` tool refused its worker role. It then called the REST install route with the shared API key and no agent header, which succeeded, and it flagged that inconsistency in its report. The stored extension had no creator agent.
**Status:** pass (with findings 1 and 3)

### TC-3: Discoverability after the fix (seeded skill plus tool descriptions)
**Steps:**
1. Rebuild the API with the `swarm-extensions` seeded skill and the updated tool descriptions.
2. Delete the worker's memory about type-defs. Pin a new task: write and install `notify-on-complete` (post a summary to Slack channel `CRBNR2PZR` on completion or failure, channel configurable).

**Expected Result:** The agent loads the skill, fetches type-defs, produces a valid bundle first try, and reports the enable step.
**Actual Result:** The worker listed and invoked the `swarm-extensions` skill, fetched type-defs, cross-checked `slack_post` against the tool schema, and wrote a bundle with a Zod config. It noticed `swarm-sdk` types are not in the extension type-defs (finding 5). MCP install refused the worker role again. This time the worker refused to bypass through REST, filed an approval request with three options, and completed with clear operator steps. The operator answered "a lead installs" in the dashboard. The worker then handed the bundle to the lead through `send-task` (with `DES-777` in the title so the ticket guard passed), and the lead installed it through MCP `extension-install`. Result: `notify-on-complete` v1, disabled, `createdByAgentId` = lead.
**Status:** pass

### TC-4: Task policy guard across origins
**Steps:**
1. Enable the agent-authored `require-ticket-ref` from the dashboard.
2. Create tasks without a ticket through REST, through `send-task` from the pi worker's MCP session, and through a Slack mention. Create one with `DES-123` and one with the `no-ticket` exempt tag.
3. Add `slack` to `origins` in the dashboard Config editor and post again.

**Expected Result:** REST 422 with the reason, MCP error result with the reason, Slack reply with the reason, ticketed and exempt tasks created, run log shows one row per attempt.
**Actual Result:** REST returned 422 with the reason and the extension id. MCP returned `isError` with the reason. The ticketed and exempt tasks were created (cancelled right after). The Config edit saved from the dashboard reloaded live (no restart). The first Slack attempt produced "Could not assign to: lead — error" with the reason swallowed (finding 2). After the fix the thread shows the block reason. The guard survived an API restart.
**Status:** pass (after fix 2)

### TC-5: Slack channel routing plus completion notification
**Steps:**
1. Enable `route-channel-to-agent` (`#general` to the pi worker) and the lead-installed `notify-on-complete`.
2. Post a ticketed mention in `#general` through the mock.

**Expected Result:** The task is pinned to the pi worker, completes, and a summary lands in `#swarm-done` posted on behalf of `ext:notify-on-complete`.
**Actual Result:** Routing worked on the first try (thread shows `worker-cfecf31f`). The notification did not land: the extension log said "posted task summary" but the channel stayed empty. Root cause: the `ext:<name>` identity is not a lead and `slack-post` is lead-only, and the SDK returns `{ success: false }` without throwing (finding 4). After the RBAC fix and rebuild, a second mention produced the `✅ DES-779 ... completed ... pong` message in `#swarm-done`, plus one for the lead's review task.
**Status:** pass (after fix 4)

### TC-6: Tool-call guard on real agent sessions
**Steps:**
1. Enable the `require-verification-note` template (blocks `store-progress` with `status: completed` unless the output contains `Verified:`).
2. Let the in-flight lead and worker tasks complete, and pin `DES-780` to the Claude worker.

**Expected Result:** The first completion call is blocked with the reason, the agent adds the line, the second call succeeds, and the run log shows block then continue.
**Actual Result:** The lead's follow-up task was blocked twice (18:07:40 and 18:07:43) and completed at 18:07:54 with a `Verified:` line in its output. The pinned worker task `DES-780` was blocked at 18:16:42 and 18:17:00, then completed with the output "Created /workspace/personal/qa-tc6.txt ... Verified: `cat /workspace/personal/qa-tc6.txt` returned `hello-qa`." Both agents corrected themselves from the block reason alone.
**Status:** pass

### TC-7: Dashboard
**Steps:**
1. Open Settings, Extensions, a detail page, the versions grid, and the run log.
2. Enable from the detail page, edit Config JSON and save, activate an older version.

**Expected Result:** DataGrid lists match the API, actions reflect immediately, run log rows show event, action, duration, and message.
**Actual Result:** All pages render with DataGrid. Enable, Config save, and Activate took effect on the next API call without a restart. The approval request page rendered the worker's three-option question and accepted the answer. Note: the API image does not serve the SPA, the dashboard must be hosted separately or run with Vite; connecting the dashboard to `http://localhost:3013` from another origin failed with "Failed to fetch" (CORS) and worked through the Vite proxy origin.
**Status:** pass

### TC-8: Failure handling and versioning
**Steps:**
1. Install the `throws` fixture, enable it, create five backlog tasks.
2. Install the `require-ticket-ref` template as version 2 of the agent's extension, then activate v1 from the dashboard.

**Expected Result:** Auto-disable after five failures with the error visible. Version activation and rollback reload handlers without restart.
**Actual Result:** `throws` went to `auto-disabled` with 5 consecutive failures and `lastError: fixture failure`; the list shows the AUTO-DISABLED badge; uninstall worked. The operator REST install of v2 on an enabled extension activated v2 immediately (documented behavior), the REST block message switched to the template text, and activating v1 from the dashboard reverted it.
**Status:** pass

## Edge Cases & Exploratory Testing
- The Slack failure line for a blocked task still reads "Could not assign to: lead-...", which frames a policy block as an assignment failure (minor, finding 6).
- Extension run rows for tool events do not record the calling agent id, so the run log cannot say which agent was blocked (minor, finding 7).
- Workers cannot install extensions (extension.write = lead, operator, user). The seeded skill now tells workers to hand the bundle to their lead instead of bypassing through REST.
- Memory carries over between authoring sessions: the baseline worker stored "where the hook contract lives" and later sessions recalled it. Realistic, but it means a second run is never a clean baseline.

## Evidence

### Screenshots
- ![Extensions list with the agent-authored extension](https://fly.storage.tigris.dev/agent-fs-taras-storage/648a5f3c-35c8-4f11-8673-b89de52cd6bd/drives/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/qa/agent-swarm/2026-09-15-extensions-qa/shot-ext-list.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=tid_HmeSWgYTsPMlIrxsHowzHXHDjaeoDuEISZtTlyZVAXApPgFSNu%2F20260915%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260915T180845Z&X-Amz-Expires=604800&X-Amz-Signature=7f0c393c1b9f72b939164263d469a13c3a79b266f18f222ee7ac86e76c9aff6e&X-Amz-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27shot-ext-list.png&response-content-type=image%2Fpng&x-amz-checksum-mode=ENABLED&x-id=GetObject)
- ![Extension detail after enabling from the dashboard](https://fly.storage.tigris.dev/agent-fs-taras-storage/648a5f3c-35c8-4f11-8673-b89de52cd6bd/drives/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/qa/agent-swarm/2026-09-15-extensions-qa/shot-ext-detail-enabled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=tid_HmeSWgYTsPMlIrxsHowzHXHDjaeoDuEISZtTlyZVAXApPgFSNu%2F20260915%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260915T180845Z&X-Amz-Expires=604800&X-Amz-Signature=08386128669f5f793863242ab3de88bdf88d4a2046431800a7f53b3c17b69c26&X-Amz-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27shot-ext-detail-enabled.png&response-content-type=image%2Fpng&x-amz-checksum-mode=ENABLED&x-id=GetObject)
- ![Run log with block and continue rows](https://fly.storage.tigris.dev/agent-fs-taras-storage/648a5f3c-35c8-4f11-8673-b89de52cd6bd/drives/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/qa/agent-swarm/2026-09-15-extensions-qa/shot-ext-runs.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=tid_HmeSWgYTsPMlIrxsHowzHXHDjaeoDuEISZtTlyZVAXApPgFSNu%2F20260915%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260915T180846Z&X-Amz-Expires=604800&X-Amz-Signature=e2bf171f232efcac34806ef8e5d34d896c8c571ec10a6db46d66300ff9a88040&X-Amz-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27shot-ext-runs.png&response-content-type=image%2Fpng&x-amz-checksum-mode=ENABLED&x-id=GetObject)
- ![Versions grid after rolling back to v1](https://fly.storage.tigris.dev/agent-fs-taras-storage/648a5f3c-35c8-4f11-8673-b89de52cd6bd/drives/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/qa/agent-swarm/2026-09-15-extensions-qa/shot-ext-versions.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=tid_HmeSWgYTsPMlIrxsHowzHXHDjaeoDuEISZtTlyZVAXApPgFSNu%2F20260915%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260915T180846Z&X-Amz-Expires=604800&X-Amz-Signature=ffd19492440589c50dd7c01be65ed8f239cc0ad7294a1d623070a9d22b515412&X-Amz-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27shot-ext-versions.png&response-content-type=image%2Fpng&x-amz-checksum-mode=ENABLED&x-id=GetObject)
- ![List with four enabled extensions and the auto-disabled fixture](https://fly.storage.tigris.dev/agent-fs-taras-storage/648a5f3c-35c8-4f11-8673-b89de52cd6bd/drives/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/qa/agent-swarm/2026-09-15-extensions-qa/shot-ext-list-final.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=tid_HmeSWgYTsPMlIrxsHowzHXHDjaeoDuEISZtTlyZVAXApPgFSNu%2F20260915%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260915T180846Z&X-Amz-Expires=604800&X-Amz-Signature=15e6a0c42303eaff6721122b38a86cfb97aef32ccb85e5b9261c9ce4dc1771e4&X-Amz-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27shot-ext-list-final.png&response-content-type=image%2Fpng&x-amz-checksum-mode=ENABLED&x-id=GetObject)
- ![Run log after fix 7, with Agent and Subject columns](https://fly.storage.tigris.dev/agent-fs-taras-storage/648a5f3c-35c8-4f11-8673-b89de52cd6bd/drives/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/qa/agent-swarm/2026-09-15-extensions-qa/shot-ext-runs-agent.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=tid_HmeSWgYTsPMlIrxsHowzHXHDjaeoDuEISZtTlyZVAXApPgFSNu%2F20260915%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260915T182732Z&X-Amz-Expires=604800&X-Amz-Signature=bc9800d9ecb48bd960d80f7775e01be522031d244ded82c44ba82cf962205ede&X-Amz-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27shot-ext-runs-agent.png&response-content-type=image%2Fpng&x-amz-checksum-mode=ENABLED&x-id=GetObject)
- ![Worker's approval request answered by the operator](https://fly.storage.tigris.dev/agent-fs-taras-storage/648a5f3c-35c8-4f11-8673-b89de52cd6bd/drives/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/qa/agent-swarm/2026-09-15-extensions-qa/shot-approval.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=tid_HmeSWgYTsPMlIrxsHowzHXHDjaeoDuEISZtTlyZVAXApPgFSNu%2F20260915%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260915T180847Z&X-Amz-Expires=604800&X-Amz-Signature=0029737c3179d23048ab97c630c2488e088a69e5d5b2a95609a2cddeb0152622&X-Amz-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27shot-approval.png&response-content-type=image%2Fpng&x-amz-checksum-mode=ENABLED&x-id=GetObject)
- ![Slack mock #general with blocked and routed tasks](https://fly.storage.tigris.dev/agent-fs-taras-storage/648a5f3c-35c8-4f11-8673-b89de52cd6bd/drives/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/qa/agent-swarm/2026-09-15-extensions-qa/shot-slack-general.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=tid_HmeSWgYTsPMlIrxsHowzHXHDjaeoDuEISZtTlyZVAXApPgFSNu%2F20260915%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260915T180847Z&X-Amz-Expires=604800&X-Amz-Signature=51f5054e3338de908db3fd435d87e9c7d281a07caaed2c26c204bae15349484e&X-Amz-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27shot-slack-general.png&response-content-type=image%2Fpng&x-amz-checksum-mode=ENABLED&x-id=GetObject)
- ![Slack mock #swarm-done with notifications posted by ext:notify-on-complete](https://fly.storage.tigris.dev/agent-fs-taras-storage/648a5f3c-35c8-4f11-8673-b89de52cd6bd/drives/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/qa/agent-swarm/2026-09-15-extensions-qa/shot-slack-swarm-done.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=tid_HmeSWgYTsPMlIrxsHowzHXHDjaeoDuEISZtTlyZVAXApPgFSNu%2F20260915%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260915T180847Z&X-Amz-Expires=604800&X-Amz-Signature=36e07d71c9381e7234bc3b059a22da157e2110fdc73c060e2668833fd44c9b1b&X-Amz-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27shot-slack-swarm-done.png&response-content-type=image%2Fpng&x-amz-checksum-mode=ENABLED&x-id=GetObject)

Signed URLs expire in 7 days. Files live in agent-fs under `qa/agent-swarm/2026-09-15-extensions-qa/`.

### Logs & Output
```
REST without ticket
422 {"error":"Task description must reference a ticket id matching DES-<number> ...","extension":{"id":"748f7f72...","name":"require-ticket-ref"}}

MCP send-task as pi worker
isError: true, message: "Task description must reference a ticket id matching DES-<number> ... Blocked origin: mcp."

Slack thread after fix 2
"⚠️ Could not assign to: *lead-23b94e8e* — Task description must reference a ticket id matching DES-<number> ..."

slack-post as ext:notify-on-complete before fix 4
"Posting to Slack channels requires lead privileges."   (isError: true)
after fix 4
"Message posted successfully."   (isError: false)

throws fixture after five tasks
status: auto-disabled, consecutiveFailures: 5, lastError: fixture failure
```

### External Links
- [PR #1441](https://github.com/desplega-ai/agent-swarm/pull/1441)
- Baseline authoring task `38f3b5ee`, post-fix authoring task `bfc81a7b`, lead install task from the worker handoff, approval request `c9c2b711` (all on the QA box database)

## Issues Found
- [x] 1. Agents had no path to the hook contract: no seeded skill mentioned extensions and the tool descriptions did not point at `GET /api/extensions/type-defs`. severity: major. Fixed: seeded `swarm-extensions` skill (`templates/skills/swarm-extensions`), tool descriptions reference the route.
- [x] 2. A Slack-origin block reported "Could not assign to: lead — error" and swallowed the reason. severity: major. Fixed in `src/slack/handlers.ts` (catch surfaces `TaskCreationBlockedError.reason`), covered by a new e2e assertion.
- [ ] 3. MCP `extension-install` denies workers while REST with the bare shared API key accepts (operator principal). Same identity, two answers. severity: major, by design of the repo identity model (DES-717). Not fixed here, tracked in [#1505](https://github.com/desplega-ai/agent-swarm/issues/1505). The seeded skill tells workers not to bypass and to hand off to a lead.
- [x] 4. `ext:<name>` identities were denied lead-only tools (`slack-post` and friends), so the flagship notification use case failed silently. severity: critical. Fixed: `src/rbac/elevated-agents.ts` registry, `actsAsLead()` in the legacy policy, dispatcher grants on load and revokes on dispose, unit test `extensions-lead-equivalence.test.ts`. Design call for Taras: an operator-enabled extension now acts with lead privileges for tool calls while enabled. `isLead` on the agent row stays false so lead selection never picks it.
- [x] 5. `swarm-sdk` types (the `ctx.swarm` surface) are not part of the extension type-defs, and SDK calls resolve with `{ success, status, data }` instead of throwing. severity: minor. Documented in the skill, the guide, and the `notify-on-complete` template now checks `success`.
- [ ] 6. Slack wording for a policy block reuses the assignment-failure line. severity: minor. Not fixed.
- [x] 7. Extension run rows carried no agent id or subject, so the run log could not say who was blocked on what. severity: minor. Fixed: `extension_runs` gained `agentId` and `subject` (migration 153, unreleased), the dispatcher fills them per event (tool name, task origin plus description snippet, channel, task id), and the dashboard run log shows Agent and Subject columns. Full payloads are still not stored (secrets, size); the Message column carries the block or error text.

## Verdict
**Status**: PASS
**Summary**: With the five fixes in this PR, real agents discover, author, hand off, and install extensions through the intended roles, and the policy, routing, notification, tool-guard, versioning, and auto-disable flows all behave as designed on a real deployment. Issues 3 (#1505) and 6 remain as follow-ups.

## Appendix

- **Plan**: `thoughts/taras/plans/2026-09-12-swarm-extensions/root.md`
- **Templates shipped**: `templates/extensions/require-ticket-ref`, `notify-on-complete`, `require-verification-note` (validated offline with `bun scripts/extensions/install-template.ts <name> --validate-only`).
- **Box teardown**: `docker compose -f docker-compose.local.yml -f docker-compose.qa.yml down -v` in `/root/agent-swarm-qa`, kill the `slack-mock serve` process, and remove the two `inet sandboxd forward` accept rules for `br-79446c73d448` (`nft -a list chain inet sandboxd forward`, then `nft delete rule inet sandboxd forward handle <n>`).
- **Notes**: The QA stack on the box was left running with `require-verification-note` disabled again; the other three extensions stay enabled for a look at the dashboard through an SSH tunnel (`ssh -L 3013:localhost:3013 -L 4040:172.17.0.1:4040 desplega-labs`, then `cd apps/ui && bunx vite --port 5175` and connect the dashboard to `http://localhost:5175`).
