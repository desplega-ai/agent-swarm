---
date: 2026-08-06T14:30:00Z
topic: "Audit: task/session stored cost vs transcript (harness) cost mismatch"
status: complete
tags: [cost-tracking, pricing, session-costs, providers, prod-audit]
---

# Audit: why task/session stored cost ≠ transcript (harness) cost

- **Trigger:** task `aef117fe-19ef-4519-839a-f1c6303e4340` — transcript RESULT shows **$9.463**, session cost stores **$8.7144** (claude/opus-5). Same class of mismatch suspected on other harnesses.
- **Method:** read-only queries against prod SQLite (`ssh swarm`, `/var/lib/docker/volumes/swarm-new-22yjmi_swarm_db/_data/agent-swarm-db.sqlite`) joining `session_costs` against harness-reported costs parsed from raw `session_logs` result lines; code audit of `src/http/session-data.ts`, `src/be/seed-pricing.ts`, `src/be/pricing-refresh.ts`, and the four adapters.

## TL;DR — the mechanism

The two numbers are produced by two independent systems and are **never expected to agree**:

- **Transcript RESULT card** (`session-log-viewer.tsx:1574`) renders the harness's self-reported `total_cost_usd` parsed from the raw result line.
- **Session/task cost** (`usage-summary.tsx`, tasks table) sums `session_costs.totalCostUsd`. On `POST /api/session-costs` (`src/http/session-data.ts:224-277`), whenever `provider` is tagged and pricing rows exist, the API **discards the harness dollar figure** and recomputes `tokens × pricing-table rates`, tagging `costSource='pricing-table'` (the "PRICED" badge). The harness value survives nowhere except the raw log line.

The recompute is systematically wrong in several independent ways. Prod scale (clean-join subset: 8,996 claude tasks, single-model, row-counts matching, all rows `pricing-table`):

| | |
|---|---|
| Harness-reported total | **$22,044** |
| Stored (recomputed) total | **$17,798** |
| Delta | **$4,246 under-reported (19.3%)** |
| Tasks harness>stored / stored>harness | 7,411 / **0** |

## Root causes, ranked

### 1. 1-hour cache-write TTL priced at the 5-minute rate (~$5.1k on the subset — dominant)

**98.9%** of all prod claude cache-write tokens are `ephemeral_1h` (2,470,659,201 of 2,496,939,574). Anthropic bills 1h writes at **2× base input**; the pricing table has a single `cache_write` class seeded from models.dev at the 5m rate (**1.25×**). The claude adapter (`claude-adapter.ts:953-954`) reads only the aggregate `cache_creation_input_tokens` and drops the `usage.cache_creation.ephemeral_1h/5m` split entirely; the schema has no column for it and the pricing table no token class.

The example task reconciles **to the cent** on this alone:
- stored `8.7144345` = (12,276,769 cr × 0.5 + 199,428 cw × **6.25** + 53,185 out × 25) / 1e6 (input zeroed, see #4)
- harness `9.4629795` = (138 in × 5 + 12,276,769 cr × 0.5 + 199,428 cw × **10.00** + 53,185 out × 25) / 1e6
- delta `0.748545` = 199,428 × $3.75/M + 138 × $5/M. Exact.

All writes in that task were 1h TTL (`ephemeral_1h_input_tokens: 199428, ephemeral_5m: 0`).

### 2. Adapter token counts exclude subagent/sidechain usage (multi-model sessions)

The result event's `usage` covers only the main thread; `modelUsage` covers everything and `total_cost_usd == Σ modelUsage[*].costUSD` (verified). The adapter stores `usage`, so the recompute never even sees sidechain tokens. Verified on task `f9769315` (opus-4-8 + haiku subagents):

- `usage`: in 8,538 / out 34,536 / cacheRead 1.94M / cacheWrite 194k
- `modelUsage` sum: in **783,583** / out **165,173** / cacheRead **2.40M** / cacheWrite **365k**, costUSD sum = 13.0517 = `total_cost_usd`
- stored ended up $10.0 below harness.

2,769 / 27,842 claude tasks had multi-model result events. Additionally, whatever tokens *are* counted get priced at the single stored model's rate (haiku tokens at opus rates, etc.).

### 3. Rate-table disagreements — including one where the **harness** is the wrong side

Three rate tables are in play: the harness's internal one (Claude Code's bundled table; codex's `codex-models.ts` build-time vendored snapshot + hardcoded fallback), the server's `pricing` table (seed snapshot + `pricing-refresh.ts` from live models.dev), and Anthropic/OpenAI's actual billing.

- **Sonnet-5**: Anthropic's docs list **introductory pricing $2/$10 (cr 0.2, cw 2.5) through 2026-08-31**, then $3/$15. The prod refresh picked this up on 2026-06-30 (`effective_from=1782851729864`). Claude Code still bills itself at $3/$15/0.3/**6.0** — verified exactly on task `28943d8a` ($30.9174 harness vs $19.8854 stored). **For sonnet-5 the swarm number is the more correct one; the transcript over-reports ~50%.** Expect the sign to flip after Aug 31.
- **Opus-5**: refresh row (2026-07-25) 5/25/0.5/6.25 matches CC's own accounting (verified exactly) — only the 1h-TTL gap (#1) remains.
- **Codex**: adapter prices from the **build-time** vendored `modelsdev-cache.json` (falling back to a hardcoded map), server from the **runtime-refreshed** table → guaranteed drift between image releases. Current: terra adapter-fallback 2.5/15 vs table 2/12; luna fallback 1/6 vs table 0.2/1.2 (**5×**, cut on 2026-07-31).
- **Codex context tiers**: models.dev shows the GPT-5.6 family bills **2× above 272k context** (e.g. sol 10/45). Neither the adapter nor the recompute is tier-aware, and codex windows are configured at 1.05M — both swarm numbers under-report true OpenAI billing on big-context sessions. Token totals can't reconstruct per-request tiers precisely; this is a known bound, worth documenting.

### 4. Anthropic input-token semantics: uncached input is zeroed

`session-data.ts:262`: `uncachedInputTokens = max(0, inputTokens - cachedInputTokens)` assumes OpenAI semantics (input includes cached). Anthropic (and pi) report input **exclusive** of cache reads, and cacheRead ≈ always > input, so claude's uncached input prices at $0 on essentially every task. Only ~$111 on the subset, but it's on every row.

### 5. Opencode adapter double-counts (~2× inflation, opposite direction)

`opencode-adapter.ts:446` accumulates `msg.cost`/tokens on every **finalized** `message.updated` event with no message-id dedup. Prod raw logs show duplicate finalized events in **37/42** opencode tasks: adapter-style sum $34.36 vs deduped truth $18.08. Smoking gun: `unpriced` opencode rows (which keep the harness value) store *exactly 2×* the deduped truth (e.g. 0.5074 vs 0.2537). Token counts are equally inflated, so even the recompute path over-reports.

### 6. Residual / minor

- Net unexplained residual on the subset is −$967 (−4%): positive residuals from #2/#3 offset by likely older-harness-version accounting differences (e.g. cache writes at 1.25× before CC accounted TTL) — not individually chased.
- `costSource='unpriced'` rows ($3,428, mostly claude-opus-4-7) keep the harness dollars (accurate!) — all historical (last 2026-05-29); current prod pricing covers those models now.
- Web-search/server-tool charges are inside `total_cost_usd` but invisible to tokens — currently $0 in prod data (no searches), a latent gap only.
- Pi: raw logs contain only `assistant` events (no cost-bearing stats), so its harness number can't be audited from logs; it shares the #4 semantics bug. Small spend.
- One `GPT-5.4` (capitalized) stored row — `normalizeModelKey` case miss, cosmetic.

## Recommendations (priority order)

1. **Persist both numbers.** Add `harnessCostUsd` to `session_costs` (the POST body already carries it — it's simply overwritten today). Cheap, makes every future drift auditable, lets the UI show the delta instead of two silently different numbers.
2. **TTL-aware cache-write pricing** (kills ~$5.1k/period): adapter parses `usage.cache_creation.ephemeral_{5m,1h}_input_tokens`; add a `cache_write_1h` token class (2× input) to seed/refresh + recompute.
3. **Aggregate from `modelUsage`, not `usage`**: emit per-model token totals (sidechains included) and price each model at its own rate. Fixes #2 and the blending error; `Σ modelUsage costUSD == total_cost_usd` makes this verifiable.
4. **Provider-aware input semantics**: for anthropic-style providers (claude, claude-managed, pi) price `inputTokens` as-is instead of subtracting `cacheReadTokens`.
5. **Opencode: dedup by message id** (keep last finalized snapshot per id, sum at end).
6. **Codex: one rate source.** Have the adapter stop pricing (or mark its number advisory) and let the server recompute be canonical; document the >272k tier bound in `pricing-sources.md`.
7. **No action on sonnet-5** — swarm is right, harness is stale until Aug 31; revisit after.

Doc-sync note (per CLAUDE.md same-PR rule): any of these changes must update `docs-site/.../guides/cost-and-context-computation.mdx` + `src/providers/pricing-sources.md`.

## Reproduction snippets

```bash
# stored vs pricing rows
ssh swarm "sqlite3 -readonly /var/lib/docker/volumes/swarm-new-22yjmi_swarm_db/_data/agent-swarm-db.sqlite \
  \"SELECT totalCostUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, model, costSource \
     FROM session_costs WHERE taskId='aef117fe-19ef-4519-839a-f1c6303e4340'\""
# harness truth incl. TTL split
ssh swarm "sqlite3 -readonly ... \"SELECT content FROM session_logs \
  WHERE taskId='aef117fe-...' AND content LIKE '%total_cost_usd%'\"" | jq '.usage.cache_creation, .modelUsage'
```

Full analysis script used for the prod sweep: `/tmp/cost-audit-prod.py` (host-side python over the readonly DB; parses result lines, joins per task, attributes the delta per cause).
