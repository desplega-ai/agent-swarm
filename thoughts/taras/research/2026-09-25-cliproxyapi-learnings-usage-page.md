---
date: 2026-09-25T18:10:00Z
researcher: Claude
git_commit: b2082abb56420bfd9eb8a66888764bbd79f0e850
branch: jackknife/usage-subscription-savings
repository: agent-swarm
topic: "CLIProxyAPI learnings, automatic subscription tier, usage page UX and query performance (PR #1617)"
tags: [research, usage-page, session-costs, credentials, cliproxyapi, performance]
status: complete
autonomy: critical
last_updated: 2026-09-25
last_updated_by: Claude
---

# Research: CLIProxyAPI learnings, automatic subscription tier, usage page UX and query performance

**Date**: 2026-09-25
**Researcher**: Claude
**Git Commit**: b2082abb5 (PR #1617 branch with main merged in, local only)
**Branch**: jackknife/usage-subscription-savings

## Research Question

Taras, on PR #1617 (usage page: subscription savings vs API pricing):

1. Research how router-for-me/CLIProxyAPI works, and what we can learn from it.
2. Get the subscription type automatically.
3. Make the usage page nicer (UX/UI audit).
4. Improve the performance of the page queries (caching, partial caching, indices, or other).

## Summary

CLIProxyAPI is a Go proxy that pools Claude, Codex, Gemini and other OAuth logins behind one OpenAI/Claude-compatible API. It is strong on routing and quota handling, and deliberately thin on usage analytics: since v6.10.0 it keeps no usage history, rollups, prices or dashboard, and points operators at two external SQLite projects. So it offers no ready answer for a usage page, but three ideas carry over: read the plan from what the credential already carries (the Codex JWT), treat quota as provider-reported state rather than something computed from local counts, and normalize token accounting per provider before anything else reads it.

It does not detect Claude plans at all, and it reads the Codex plan from the unverified `chatgpt_plan_type` JWT claim. The swarm can do the same for Codex with no network call. For Claude, the endpoint Claude Code itself uses (`GET /api/oauth/profile`) needs the `user:profile` scope, and a live probe on 2026-09-25 (approved by Taras) showed that a `claude setup-token` token gets `403 OAuth token does not meet scope requirement any_of(user:profile, user:office)`. The swarm only takes setup tokens, so the Claude plan cannot be detected and needs a one-time choice per credential.

On production, one poll of the usage page costs about 1.4 s of DB time, every 10 s, mostly a recursive CTE that scans every task and reads through each 20 KB prompt. One covering index plus a single join instead of four correlated `EXISTS` probes cut `/summary` from 861 ms to about 160 ms on a production-shaped copy. The UX audit found 10 issues, led by missing thousands separators, a manual plan price, charts that disagree with their tables, and a filter row that overflows on mobile.

## Detailed Findings

### CLIProxyAPI: plan tier, quota and routing

- **Claude plan.** Not detected. `ClaudeTokenStorage` (`internal/auth/claude/token.go`) has no plan field and no profile call exists. Its Claude login uses the full OAuth flow (`https://claude.ai/oauth/authorize`, token at `https://platform.claude.com/v1/oauth/token`, client `9d1c250a-...`, `internal/auth/claude/anthropic_auth.go`), so it would have the scope, but it does not use it.
- **Codex plan.** Read from the `https://api.openai.com/auth` JWT claim `chatgpt_plan_type`, with no signature check (`internal/auth/codex/jwt_parser.go:22,42-52`). The device login stores it as `Metadata["plan_type"]` (`sdk/auth/codex_device.go:265,291`). The file watcher derives it again on every auth-file load (`internal/watcher/synthesizer/file.go:250-261`). It picks the model catalog per plan (`sdk/cliproxy/service_models.go:136-151`: `pro`, `plus`, `team`/`business`/`go`, `free`) and can exclude free accounts from routing (`conductor_selection.go:119`). No prices.
- **Other providers.** Antigravity reads `paidTier` and credits from `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`, at most every 10 minutes per credential, in memory only (`internal/runtime/executor/antigravity_executor_credits.go:430-520`). Meta returns `subs_tier_name` / `subs_tier_id` when it mints a key (`internal/auth/meta/meta.go`).
- **Quota windows.** Passive only. For Claude it reads the `Anthropic-Ratelimit-Unified-*` headers (`-5h-`, `-7d-`, `-7d_oi-` status, reset and utilization, `internal/runtime/executor/helps/claude_ratelimit.go`). A 5h or 7d rejection blocks the credential. An overage-only rejection does not. The cooldown ends at the latest reset among the rejected windows plus 1 to 30 s of jitter. For Codex it reads `x-codex-primary-*` / `x-codex-secondary-*` headers and the `codex.rate_limits` websocket event. No `/api/oauth/usage` or `wham/usage` polling.
- **Routing.** Four selectors (`sdk/cliproxy/auth/selector.go`): round robin by ID successor (stable when cooldowns shrink the pool), smooth weighted round robin, fill-first (drains one account to stagger rolling windows), and session affinity (1 h TTL, explicit harness session IDs, else a longest-prefix match over recent request bodies). Selection filters by provider and model, so one account can be cooling for one model and free for another. Priority tiers, retryable statuses (403, 408, 429, 5xx) and a jittered wait when every account cools down.
- **Token refresh.** Lazy, on demand, deduplicated with singleflight per refresh token, 3 tries with linear backoff. A Claude refresh 429 blocks that refresh token until `Retry-After`. A Codex `refresh_token_reused` error stops the retries.

### What agent-swarm can take from it

1. **Plan from the token, not from a probe.** Codex: decode `chatgpt_plan_type` where the worker already decodes the JWT. Claude: no detectable source for setup tokens, so a per-credential plan choice.
2. **Quota is provider state.** The swarm already follows this (`rateLimitWindows` from the Claude CLI `rate_limit_event`). CLIProxyAPI's split between credential-wide and overage-only rejection, and its "latest reset among rejected windows" cooldown, match what `model-rate-limit-windows.ts` does.
3. **Normalize token accounting once.** Its per-provider semantics table (subset, independent, separate reasoning) is the same problem `computeContextUsedUnified` and the cost adapters solve per harness.
4. **Fill-first routing** is an idea the swarm pool does not have: draining one subscription before the next staggers the 5 h and weekly windows.
5. **What not to copy.** Its usage stats live in a 60 s in-memory buffer. The swarm already persists every session in SQLite, which is the part CLIProxyAPI outsourced.

### CLIProxyAPI: usage statistics, storage and cost

- **Capture.** One `usage.Record` per request (`sdk/cliproxy/usage/manager.go:23-89`): provider, model, alias, auth index, API key, session IDs, latency, TTFT, failure, and a token `Detail` (input, output, reasoning, cached, cache read, cache creation).
- **Normalization.** "Token Accounting Schema v2" (`sdk/cliproxy/usage/accounting.go:253-364`) maps each provider to one semantic: `Subset` (OpenAI, Codex, OpenRouter: cached and reasoning are inside input and output), `Independent` (Claude: separate counters), or `SeparateReasoning` (Gemini). It then writes one non-overlapping breakdown and a `Quality` flag (`Complete`, `Inconsistent`, `Unclassified`).
- **Streaming.** `StreamUsageBuffer` (`internal/runtime/executor/helps/usage_helpers.go:840-957`) keeps the last usage snapshot of a stream ("last usage wins", never a sum) and publishes exactly one record per request (`sync.Once`).
- **Storage.** None. Since v6.10.0 the project ships no usage persistence, rollups, cost, or dashboard (`README.md:141-151`). Records go through an in-process pub/sub (`usage.Manager`, `manager.go:291-481`) into an in-memory ring buffer with 60 s default retention (`internal/redisqueue/queue.go`). `GET /v0/management/usage-queue` pops records from that buffer. Two external projects persist them: CPA Usage Keeper (SQLite + dashboard) and CPA-Manager-Plus (SQLite + editable prices synced from LiteLLM).
- **Cost.** No price table and no money math in the repository. `QuotaMetric` with `Format: "currency"` (`sdk/pluginapi/types.go:1627-1634`) only relays a balance that a provider endpoint returns.
- **Per-credential counters.** Lifetime success and failure counts, plus a 20 x 10-minute ring of recent requests per credential (`sdk/cliproxy/auth/types.go:151-164`). All in memory. They reset on restart.
- **Quota.** Two paths. Passive: the latest provider rate-limit headers per credential replace the previous snapshot (`sdk/cliproxy/auth/quota_signals.go:37-89`), for Claude, Codex and Devin only. Codex windows arrive as `primary` (about 5 hours) and `secondary` (about weekly) with used percent, window minutes and reset time (`internal/runtime/executor/helps/codex_quota.go:180-205`). Active: `POST /v0/management/quota/fetch` runs a plugin or a declarative HTTP probe against the provider usage endpoint and maps the reply to `{Subscription{Plan, TierName, TierID}, Buckets[{Window, RemainingFraction, ResetTime}]}` (`internal/api/handlers/management/plugin_quota.go:59-132`, `sdk/pluginapi/types.go:1593-1642`). Quota always comes from the provider. It is never derived from local usage counts.

### agent-swarm: what the swarm knows about a credential today

- **Task to credential link.** `agent_tasks.credentialKeySuffix` (migration 028) and `credentialKeyType` (migration 029). The worker posts `POST /api/keys/report-usage` (`src/commands/runner.ts:1715-1740`). `recordKeyUsage()` (`src/be/db.ts:11268-11304`) is the only writer of the two columns.
- **Suffix.** The last 5 characters of the secret for plain keys and `CLAUDE_CODE_OAUTH_TOKEN` (`src/utils/credentials.ts:197,229`). For `CODEX_OAUTH`, the last 5 characters of the `chatgpt_user_id` JWT claim (`src/providers/codex-oauth/auth-json.ts:38-48`).
- **Per-credential state.** `api_key_status` (`src/be/db.ts:11133-11154`): status, rate-limit state, usage counts, name, provider, and `rateLimitWindows` JSON (migration 095). The worker fills the windows from the Claude CLI `rate_limit_event` stream (`src/utils/error-tracker.ts:232-289`). There is no plan, tier or subscription field.
- **Anthropic calls.** The swarm calls no Anthropic account endpoint. The OAuth token gets a presence-only check (`src/commands/provider-credentials.ts:242-244,332-334`).
- **Codex JWT.** The swarm decodes the Codex JWT for `chatgpt_account_id` and `chatgpt_user_id` (`src/providers/codex-oauth/flow.ts:84,176-199`). It does not read `chatgpt_plan_type`.
- **Who holds the raw token.** The worker (env, or `GET /api/config/resolved?includeSecrets=true`, `runner.ts:776-830`). The API decrypts pool secrets for that endpoint (`src/http/config.ts:128-148`) and holds a fresh Codex token during the device login (`src/http/codex-oauth-device.ts:187-228`).
- **UI.** The API Keys page (`apps/ui/src/pages/api-keys/page.tsx`) lists credentials with windows and costs, and has no plan column. The PR #1617 savings card uses one manual "Plan price $/mo" (default $200) for every OAuth credential (`apps/ui/src/components/shared/usage-summary.tsx:41-104`).

### Plan tier sources that exist (verified 2026-09-25)

- **Claude.** Claude Code 2.1.282 calls `GET ${BASE_API_URL}/api/oauth/profile` with `Authorization: Bearer <token>`. It maps `organization.organization_type` (`claude_max` to `max`, `claude_pro` to `pro`, `claude_team` to `team`, `claude_enterprise` to `enterprise`) and reads `organization.rate_limit_tier` (`default_claude_max_5x`, `default_claude_max_20x`), `seat_tier`, `billing_type` and `has_extra_usage_enabled` (strings in the CLI binary). The Agent SDK exposes the result as `AccountInfo.subscriptionType` through `query.accountInfo()` (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:23-33,2841`).
- **Setup tokens cannot read the profile.** The swarm gets Claude tokens from `claude setup-token` (`apps/ui/src/pages/setup/steps/ai/claude-card.tsx:26-83`). Probe on 2026-09-25 with the local token (approved by Taras): `GET /api/oauth/profile` returned `403 permission_error: OAuth token does not meet scope requirement any_of(user:profile, user:office)`, with and without `anthropic-beta: oauth-2025-04-20`. `GET /api/oauth/usage` returned 429.
- **Codex.** Both the `id_token` and the `access_token` carry `https://api.openai.com/auth.chatgpt_plan_type` (value `pro` on the local login), plus `chatgpt_subscription_active_until`. No network call is needed.
- **List prices.** claude.com/pricing (fetched 2026-09-25): Pro $20 monthly ($17 annual), Max from $100 (5x) and $200 (20x), Team standard $25 monthly ($20 annual), Team premium $125 monthly ($100 annual), Enterprise $20 per seat plus usage at API rates. chatgpt.com/pricing renders prices with JavaScript, so the fetch returned no numbers.

### Usage page: data flow and polling

- One route, `/usage` (`apps/ui/src/app/router.tsx:155-164`), content in `apps/ui/src/pages/usage/usage-content.tsx`.
- Four queries on load, all polled: `GET /api/session-costs/summary` and `GET /api/attribution/by-person` and `GET /api/agents` every 10 s (global default, `apps/ui/src/app/providers.tsx:11-19`), `GET /api/users` every 5 s (`use-users.ts:26`). `/api/users` runs 4 queries per user (`src/http/users.ts:65-79`).
- `/summary` runs 4 SQL statements (`src/be/db.ts:4840-5028`). Totals and byUser evaluate the recursive `human_free_tasks` CTE over all of `agent_tasks`, not only the window. Each statement used 4 correlated `EXISTS` probes into it.
- No server cache. No rollup table.

### Usage page: query performance on production (read-only)

Production DB: 34.7 GB file, `agent_tasks` 38,100 rows in 849 MB, `session_costs` 44,874 rows in 11 MB. The average `task` text is 19.9 KB. Column order puts `task` (col 3) before `source`, `taskType`, `tags` and far before `parentTaskId` (26), `credentialKeyType` (50), `requestedByUserId` (51) and `requestedByUserIdInherited` (72). So every column read past `task` follows the row's overflow pages.

| Statement (30d window) | Prod time |
|---|---|
| `human_free_tasks` CTE alone | 0.48 s |
| totals | 0.67 s |
| daily | 0.01 s |
| byAgent | 0.015 s |
| byUser | 0.48 s |
| attribution rootRows + reachRows | 0.17 s + 0.12 s |

All time: totals 1.0 s, byUser 0.66 s. So one poll of the page costs about 1.4 s of DB time on prod, every 10 s.

A synthetic local DB with the same shape (same row counts, prompt sizes and distributions, `/tmp/usage-perf/seed.ts`) reproduces it: CTE 0.36 s, totals 0.50 s, byUser 0.38 s.

| Change (synthetic DB) | CTE | totals | byUser | `/summary` via HTTP, 30d | all time |
|---|---|---|---|---|---|
| Baseline | 0.36 s | 0.50 s | 0.38 s | 861 ms | about 1,100 ms |
| One `LEFT JOIN human_free_tasks` instead of 4 `EXISTS`, skip the CTE in daily and byAgent without a user filter | | | | 650-720 ms | 1,040-1,120 ms |
| Plus a covering index on `agent_tasks(id, parentTaskId, requestedByUserId, requestedByUserIdInherited, taskType, source, tags, workflowRunId, credentialKeyType, credentialKeySuffix)` (4.8 MB, built in 1.7 s) | 0.05 s | 0.08 s | 0.07 s | 157-213 ms | 346-363 ms |

`EXPLAIN QUERY PLAN` with the index: `SCAN task USING COVERING INDEX` for the CTE and `SEARCH t USING COVERING INDEX (id=?)` for the join, so no task row is read. A second covering index for the recursive step, `(parentTaskId, requestedByUserId, requestedByUserIdInherited)`, saved only 7 ms more.

In `getAttributionByPerson`, `report_tasks` selected `t.*`. Explicit columns took reachRows from 0.155 s to 0.13 s (warm).

### Usage page: UX audit (synthetic data, 1440 px and 390 px)

Screenshots: `/tmp/usage-audit/02-usage-30d-tall.png`, `/tmp/usage-audit/03-usage-mobile.png`.

1. **Numbers.** No thousands separators (`$26325.31`, `7526`). "Total time 984h 59m" wraps to two lines. "Attributed spend" label wraps.
2. **Stat strip.** Six equal cards. Total time and Avg/session add little. Token total hides the cache split (2.5 B cache-read tokens in the window).
3. **Savings card.** It sits apart from the totals, with a long formula sentence and a manual price input on its own row. It assumes one tier for all credentials and covers only Claude OAuth. Codex subscriptions (`CODEX_OAUTH`, 2 credentials on prod) count as API spend.
4. **Daily cost.** A smoothed line (`type="monotone"`) for daily totals. No split between subscription and pay-as-you-go spend, and no session count in the tooltip.
5. **Cost by agent.** The chart shows the top 10 while the table lists all 16. The chart height uses all 16 rows, so the bars float in empty space. Chart and table repeat the same numbers.
6. **Cost by user.** "Unattributed (autonomous)" is 78% of spend, so its bar sets the scale and the other bars are slivers. Table headers are cramped.
7. **By person.** "First-pass yield" is always "not yet computed", and that column overflows the card. The note uses an em dash.
8. **Filters.** "Last 30 day" is truncated in a 130 px trigger. On mobile the filter row overflows to the right and hides the user filter.
9. **Mobile.** Six stacked stat cards fill the first screen. The agent chart plus the 16-row table fill the next two.
10. **Loading.** A filter change shows skeletons for the whole page (`isLoading` only), because the query key changes and there is no `placeholderData`.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/be/db.ts` | 4845-4878 | `HUMAN_FREE_TASKS_CTE` and the human-free predicate |
| `src/be/db.ts` | 4896-5090 | `getSessionCostSummary` (4 statements) |
| `src/be/db.ts` | 5127-5290 | `getAttributionByPerson` |
| `src/be/db.ts` | 11268-11304 | `recordKeyUsage`, writer of the task credential columns |
| `src/http/session-data.ts` | 207-243, 425-454 | `/summary` and `/attribution/by-person` routes |
| `src/commands/runner.ts` | 1715-1740, 1763-1863 | worker usage report, Codex credential resolution |
| `src/utils/credentials.ts` | 5-33, 197, 229 | credential pool vars, suffix derivation |
| `src/providers/codex-oauth/flow.ts` | 33, 84, 176-199 | Codex JWT decoding |
| `apps/ui/src/pages/usage/usage-content.tsx` | 59-443 | usage page |
| `apps/ui/src/components/shared/usage-summary.tsx` | 41-279 | stat strip, savings card, daily chart |
| `apps/ui/src/app/providers.tsx` | 11-19 | global 10 s refetch default |

## Open Questions

- ChatGPT list prices were not machine-readable on chatgpt.com on 2026-09-25. The catalog uses third-party guides checked in September 2026: Go $8, Plus $20, Pro $100 (5x) or $200 (20x), Business $25 or $125 per seat monthly. The `pro` claim does not say which Pro tier, so it maps to Pro 20x.
- A Claude plan could be inferred from rate-limit utilization against spend per 5 h window (Max 20x has 4x the limit of Max 5x). That is a heuristic and is not built.

## Appendix

- **Tooling.** `/tmp/usage-perf/`: `build.ts` and `build-attr.ts` extract the live SQL from `src/be/db.ts`. `seed.ts` builds the synthetic DB. `api/start.sh` runs a second API on port 3113 against it.
- **Prior research.** `thoughts/taras/research/2026-09-24-ui-onboarding-experience.md` (the dashboard onboarding that sets up these credentials).

## Follow-up 2026-09-25: Claude plan from session logs

Taras asked whether the Claude session logs carry the plan. Checked on production (`session_logs`, read-only, the last 24 h of `cli = 'claude'` events):

- `system/init` has `apiKeySource` (always `none`), `fast_mode_state`, `fast_mode_disabled_reason` (`sdk_opt_in_required`) and capabilities. No plan, tier or subscription field.
- `result` has cost, usage, `modelUsage` and timings. No plan field.
- `rate_limit_event.rate_limit_info` has `rateLimitType`, `status`, `overageStatus` (`rejected`), `overageDisabledReason` (`org_level_disabled`), and `unifiedWindows` with `utilization` and `resetsAt` for `five_hour` and `seven_day` on every event. The swarm already stores this per credential in `api_key_status.rateLimitWindows`.

So the plan is not named anywhere, but utilization gives a capacity signal: API-priced spend in a window divided by the used share. Over 7 days of production windows (3 Claude credentials, all Max 20x per Taras):

| Window | Windows with utilization >= 25% | Capacity (median, USD of API-priced spend) | Classified as Max 20x |
|---|---|---|---|
| 5 hours | 53 | about $310 to $345 | 45 of 53 (8 read as Max 5x) |
| 7 days | 8 | about $1,700 to $2,400 | 8 of 8 |

The 5-hour window reads lower as it fills up (at utilization >= 0.7, all 4 windows read as Max 5x), so only the 7-day window is used. Decision (Taras): apply the estimate automatically as `planSource = 'estimated'`, below a detected or manual plan (`estimateClaudePlan` in `src/utils/subscription-plans.ts`, run when a worker reports rate-limit windows).
