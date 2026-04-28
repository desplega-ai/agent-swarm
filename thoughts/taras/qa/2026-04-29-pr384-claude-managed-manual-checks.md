---
title: PR #384 — claude-managed harness provider, manual QA
pr: https://github.com/desplega-ai/repo/pull/384
branch: claude-managed-provider
date: 2026-04-29
qa-runner: Claude (interactive session, /desplega:qa)
autonomy: critical
---

# Summary

Ran the 8-checkbox manual verification list from PR #384's "Manual verification (needs Anthropic sandbox account — owed)" section against a live local stack: bare API server on `:3013`, ngrok tunnel `https://taras-swarm.ngrok.dev` → `:3013`, fresh swarm DB, freshly-built Docker worker, real Anthropic SDK calls.

**Result**: **Cannot ship in current state.** The PR landed claiming "all 7 phases done, 3114 unit tests pass" but the live-flow on a clean account hits **at least seven defects** before a single Anthropic-side LLM call succeeds. Five were strictly necessary fixes I applied inline so the verification could continue; two more are still open (one is environmental, one is a missing manual prereq the PR description doesn't flag).

The unit tests didn't catch any of these because they all live below the SDK call surface — the real-API contract was never exercised on a clean account before this PR was opened.

# Live infrastructure used

- **API server**: `bun run start:http` on `:3013` (uses `.env`, picks up `ANTHROPIC_API_KEY` from shell)
- **ngrok**: `ngrok http --url=taras-swarm.ngrok.dev 3013` — confirmed reachable from public internet
- **Worker**: `agent-swarm-worker:latest` rebuilt from this branch, run via `docker run --env-file .env.docker`
- **swarm_config**: started empty; populated by setup CLI run; final keys: `anthropic_api_key` (encrypted), `managed_agent_id`, `managed_environment_id`, `telemetry_installation_id`
- **Anthropic side**: 3 environments and 1 agent created (1 environment + 1 agent finally usable; 2 environments are orphans from failed first runs — should be archived)

# Checkbox-by-checkbox results

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | **Setup CLI** creates env + uploads skills + creates agent + persists IDs | ✅ PASS *after fixes #1, #2, #3* | First run on clean swarm hit 3 distinct API rejections in sequence. Re-run is now correctly idempotent (short-circuits via `managed_agent_id` lookup). |
| 2 | **Trivial task end-to-end** | ⚠️ PARTIAL — session created, SSE relayed, cost row written; **live LLM call rejected** by Anthropic billing limit + MCP-vault gap. | Session ID `sesn_011CaWv4zUfe7Yr1kuj3A4T6` persisted; cost row shows `model:""` (cosmetic — `span.model_request_end` doesn't carry model in the SDK shape we read). |
| 3 | **Cancel mid-run** | 🚫 BLOCKED | Needs a running session. Couldn't get one. |
| 4 | **Repo task with non-zero `runtimeFeeUsd`** | 🚫 BLOCKED | Same. |
| 5 | **Resume reuses sessionId + dedups events** | 🚫 BLOCKED | Same. |
| 6 | **Docker entrypoint smoke** (claude-managed branch) | ✅ PASS | All expected lines logged (`Restored claude-managed config from swarm_config: ANTHROPIC_API_KEY/MANAGED_AGENT_ID/MANAGED_ENVIRONMENT_ID`, `Skipping local .mcp.json`, `Harness Provider: claude-managed`). |
| 7 | **Worker restart re-reads swarm_config** | ✅ PASS | `docker restart swarm-worker` cleanly re-hydrates all 3 keys, registers, polls. |
| 8 | **Integrations UI qa-use** | ✅ PASS *after fix #5* | Tile renders under "LLM providers" filter chip (no explicit section header — minor UX nit). Configure flow is a dedicated `/integrations/claude-managed` page, NOT a modal. The "Test connection" button initially **crashed the page into a React error boundary** with `Objects are not valid as a React child (found: object with keys {id, speed})`; fixed inline. After fix, success state renders cleanly: "Connected to managed agent". Screenshots: `/tmp/qa-managed-pr384-tile.png`, `/tmp/qa-managed-pr384-test-result.png` (pre-fix crash), `/tmp/qa-managed-pr384-test-success.png` (post-fix). |

# Defects found

## Fixed inline during this QA

### #1 — Setup CLI: skill upload uses wrong path shape (HARD FAIL on clean account)

**Symptom**: First-ever `claude-managed-setup` run errors out with
```
400 invalid_request_error: SKILL.md file must be exactly in the top-level folder.
```

**Root cause**: `src/commands/claude-managed-setup.ts:216` calls `toFile(buf, "SKILL.md", …)`. The SDK type docstring says: *"All files must be in the same top-level directory and must include a SKILL.md file at the root of that directory."* The Anthropic API treats the upload as a folder bundle and demands a folder prefix. A bare filename is rejected.

**Fix applied**: change filename to `${slug}/SKILL.md` so each plugin/commands/*.md becomes one skill in its own top-level folder.

### #2 — Setup CLI: agent creation rejects mcp_servers without mcp_toolset (HARD FAIL)

**Symptom**: After skills upload succeeded, agent creation errored:
```
400 invalid_request_error: Agent has invalid configuration: mcp_servers [agent-swarm] declared but no mcp_toolset in tools references them
```

**Root cause**: `claude-managed-setup.ts:402` passes `tools: [{ type: "agent_toolset_20260401" }]` with `mcp_servers: [mcpServer]`. The API requires every entry in `mcp_servers` to be referenced by an `mcp_toolset` entry inside `tools`.

**Fix applied**: append `{ type: "mcp_toolset", mcp_server_name: mcpServer.name }` to the `tools` array.

### #3 — Setup CLI: skills returns 400 (not 409) on display_title collision; idempotency broken (HARD FAIL on rerun)

**Symptom**: Re-running setup after a previous partial-success errors out on each existing skill:
```
400 invalid_request_error: Skill cannot reuse an existing display_title: close-issue
```

**Root cause**: The setup CLI catches `ConflictError` (409) for "already exists", but Anthropic returns **400 BadRequestError** with `display_title` collision. Worse, the 400 error doesn't include the existing skill ID, so even catching it doesn't recover.

**Fix applied**: pre-fetch the full skills list via `client.beta.skills.list({ source: "custom" })`, build a `display_title → id` map, reuse existing IDs on rerun. Also broadened the error handler to catch `BadRequestError` with `display_title` in the message as a fallback for races.

### #4 — Test-connection endpoint: case mismatch with setup CLI (HARD FAIL)

**Symptom**: After successful setup, `POST /api/integrations/claude-managed/test` returns:
```json
{"ok":false,"error":"Missing required config: MANAGED_AGENT_ID. Run `bun run src/cli.tsx claude-managed-setup` to populate."}
```

…even though `swarm_config` clearly contains `managed_agent_id`.

**Root cause**: setup CLI persists keys in **lowercase** (`managed_agent_id`, `managed_environment_id`, `anthropic_api_key`). `docker-entrypoint.sh` correctly maps lowercase → uppercase env vars at boot. But `src/http/integrations.ts`'s `resolveConfigValue("MANAGED_AGENT_ID")` does a literal-case lookup in `swarm_config` and falls back to `process.env.MANAGED_AGENT_ID` — neither hits.

**Fix applied**: `resolveConfigValue` now tries `key`, `key.toLowerCase()`, and `key.toUpperCase()` against `swarm_config` before falling through to `process.env`.

### #5 — Adapter: events.send rejects unknown `cache_control` field (HARD FAIL on every live run)

**Symptom**: Every session — after surviving creation — instantly errors during `events.send`:
```
400 invalid_request_error: events.0.content.0.cache_control: Extra inputs are not permitted
```

**Root cause**: `src/providers/claude-managed-adapter.ts:144` (now line 124) attached `cache_control: { type: "ephemeral" }` to the first content block of the user message. The PR description and the source comment both claimed *"the type-level cache_control annotation is captured … the API does honor it"* — that's not true. The managed-agents `events.send` strict-validates and rejects unknown fields. The SDK type `BetaManagedAgentsTextBlock` has no `cache_control` member, and that's intentional.

**Fix applied**: removed `cache_control` from `composeManagedUserMessage`, retired the `ManagedTextBlockWithCache` extension type, updated the doc comment to call out the behaviour, and updated the 3 unit tests that previously asserted the field's presence (they were green only because they round-tripped `composeManagedUserMessage` → `events.send` against a fake spy that didn't validate the request shape — exactly the scenario the SDK type was warning about).

### #6 — UI: Test-connection crashes the React app (HARD FAIL)

**Symptom**: Clicking "Test connection" on `/integrations/claude-managed` crashes the page into a React error boundary:
```
Objects are not valid as a React child (found: object with keys {id, speed}).
```

**Root cause**: `src/http/integrations.ts:113` returned `model: agent.model ?? null`. The SDK's `BetaManagedAgentsAgent.model` is **`BetaManagedAgentsModelConfig` (`{id, speed}`), not a string**. The UI typed it as `model?: string | null` (`new-ui/src/components/integrations/claude-managed-section.tsx:45`) and rendered `{lastResult.model}` directly in JSX, which crashes on object children.

**Fix applied**: backend now flattens `model.id` to a string before returning. UI shape stays compatible.

## Open / not fixed

### #7 — MCP server cannot authenticate from Anthropic's sandbox (BLOCKER for live runs)

**Symptom**: Every session emits, before any model turn:
```
session.error: { mcp_server_name:"agent-swarm", message:"MCP server 'agent-swarm' initialize failed: no credential is stored for this server URL — check that the agent's MCP server URL matches the URL in the vault", type:"mcp_authentication_failed_error" }
```

**Root cause / why not fixed**: The setup CLI registers our MCP server with `{ name, type: "url", url: $MCP_BASE_URL/mcp }` only — it does NOT configure a credential entry in Anthropic's per-MCP vault. The PR's own source comment acknowledges this: *"the SDK does NOT accept `http_headers` here, so MCP auth is configured Anthropic-side via the dashboard / vault"*. **But the PR description and the runbook do not list "configure the vault" as a manual step** in the setup or run path. Without it, the agent has zero swarm tools available — it can't `join-swarm`, `store-progress`, `task-action`, or anything else, which means the trivial-task / cancel / repo / resume verifications can't succeed even with budget available.

**Decision**: This is a documentation + UX gap. The setup CLI should either: (a) call `client.beta.vaults.*` to configure credentials at agent-creation time, or (b) print a big "next-step: open Anthropic dashboard → MCP Vault → add Bearer ${API_KEY} for ${MCP_BASE_URL}/mcp" notice.

### #8 — Anthropic account: spending limit reached (ENVIRONMENTAL)

```
billing_error: You have reached your specified API usage limits. You will regain access on 2026-05-01 at 00:00 UTC.
```

**Decision**: Not a code defect. Blocks 4 of the 8 manual checks until the account quota resets in ~3 days OR the limit is raised.

## Side-findings (not strictly PR-blocking but worth flagging)

### Worker-side skill sync runs even for `claude-managed`

`src/commands/runner.ts:2780-2807` calls `${swarmUrl}/api/skills/sync-filesystem` unconditionally. For `claude-managed` this is wasted work (skills live Anthropic-side) and additionally fails in this environment because `SWARM_URL=swarm.desplega.sh` lacks a scheme — `fetch()` rejects it as an invalid URL and emits:

```
[worker] Skill sync failed: fetch() URL is invalid
```

The docker-entrypoint **does** skip its own skill sync for claude-managed, but the runner-process sync is a separate code path that doesn't check `HARNESS_PROVIDER`. Cosmetic (worker still polls and accepts tasks), but should be gated. Also: the missing-scheme bug is pre-existing — `swarmUrl` is constructed without enforcing a protocol — but it's now louder because of the new branch.

### Cost row records empty model name

After the live SSE flow completed, the `result` event carried `model:""`:
```json
{"type":"result","cost":{…,"model":"","…}}
```

The SDK's `BetaManagedAgentsSpanModelRequestEndEvent` doesn't expose the model in the spot the adapter reads from. Sub-issues: cost calc warns `Unknown model "" — returning $0 cost.` so all spans are billed at $0 — pricing layer is currently inert. The runtime-fee path (`$0.08/session-hour`) is independent and was not exercised because the session terminated immediately on the billing error.

# Code changes I'm leaving on the branch

If you want to keep these, they need a commit. If you want to redo them differently, all are local-only and easily reverted.

| File | Change |
|---|---|
| `src/commands/claude-managed-setup.ts` | Skill upload uses `${slug}/SKILL.md`; agent params include `mcp_toolset`; pre-fetches existing skills via `beta.skills.list` for proper idempotency; adds `BadRequestError` import + handling. |
| `src/providers/claude-managed-adapter.ts` | Removes `cache_control` from `composeManagedUserMessage`; replaces `ManagedTextBlockWithCache` usages with the SDK's `BetaManagedAgentsTextBlock`; updates doc comment. |
| `src/http/integrations.ts` | `resolveConfigValue` tries `key`, `lowercase(key)`, `uppercase(key)`; `agent.model` flattened to a string before returning. |
| `src/tests/claude-managed-adapter.test.ts` | 3 tests updated to drop `cache_control` assertions (now 42 pass, 0 fail). |
| `.env.docker` | `MCP_BASE_URL` switched to `https://taras-swarm.ngrok.dev`; `HARNESS_PROVIDER=claude-managed` added; the explicit `MANAGED_AGENT_ID/MANAGED_ENVIRONMENT_ID` lines removed (worker restores from `swarm_config`). Backup at `.env.docker.qa-backup`. |

`bun run tsc:check` clean. `bun test src/tests/claude-managed-adapter.test.ts src/tests/claude-managed-setup.test.ts src/tests/integrations*.test.ts` → 42 pass / 0 fail. `bun run lint` shows the same 1 pre-existing error + 11 warnings as `main`; my edits don't introduce new ones.

# Recommendations

1. **Don't merge as-is.** Even with my five inline fixes, the MCP-vault gap (#7) means the headline use-case ("worker runs swarm tasks in Anthropic cloud") fails on day 1 unless the operator manually configures the Anthropic MCP vault — and nothing in the PR points at that step.
2. **Decide on the cache-control story** before re-claiming "prompt-cache breakpoint" in the PR description. Either rely on Anthropic's server-side caching of byte-identical static prefixes (current state after fix #5) and update the docs, or push back on Anthropic's API team for a supported breakpoint primitive on managed-agents events.
3. **Wire the cost path properly**: read the model from the SDK event shape (probably `span.model_request_end.model_request.model`) instead of leaving it empty. As-is, cost reporting is a placebo.
4. **Add a real e2e test** that creates a session against a fake Anthropic SDK that round-trips a single iteration — the unit tests passed because each piece worked in isolation, but the live wiring failed at three different validation layers (skills, agent, events).
5. **Document the MCP-vault step** in the runbook + setup CLI output, or auto-configure the vault from the setup CLI.
6. **Re-run checks #2 #3 #4 #5** after #7 is resolved + the Anthropic quota resets on 2026-05-01.

# Artefacts

- Setup CLI logs: `/tmp/setup-run1.log` … `/tmp/setup-run5-idempotent.log` (5 runs showing each bug surfacing then disappearing)
- Worker session JSONL: `work/worker-1/logs/local_worker_1/2026-04-28T21-56-16-208Z-5296e1fa.jsonl`
- API server log: `/tmp/swarm-api-qa.log`
- ngrok log: `/tmp/ngrok-qa.log`
- UI screenshots: `/tmp/qa-managed-pr384-tile.png`, `/tmp/qa-managed-pr384-test-result.png` (crash), `/tmp/qa-managed-pr384-test-success.png` (post-fix)
- `.env.docker` backup: `.env.docker.qa-backup`
- Anthropic-side resources created during this run (orphans should be archived):
  - environments: `env_01Lj1kHVBuXhiZp6Vt7EQTfd`, `env_01A6re5sBrjehi9zxK9czEZ4`, `env_01GuMLjo4Uw25ryTCnKfFHBa` (last one is the active one)
  - agent: `agent_011CaWuXZKiYYNqTzyH9Xkhr` (active)
  - skills: 13 (named `close-issue`, `swarm-chat`, `review-offered-task`, `investigate-sentry-issue`, `respond-github`, `review-pr`, `user-management`, `work-on-task`, `start-worker`, `create-pr`, `todos`, `start-leader`, `implement-issue`)
