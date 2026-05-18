---
date: 2026-05-15
researcher: Claude (on behalf of Taras)
git_commit: 79eb5690e2a8a4f9e39f417903cb19265af31d26
branch: main
repository: agent-swarm
topic: Context-window and cost computation across harnesses — surface map and observed gaps
tags: [research, providers, cost, context-window, pricing, harness, tokens]
status: complete
last_updated: 2026-05-15
---

# Context-window and cost computation across harnesses — surface map and observed gaps

## Research Question

How does context-window usage and cost get computed for each harness (claude, claude-managed, codex, pi, opencode, devin, gemini), and where are the gaps and inconsistencies?

## Summary

The system has **six providers** but **three independent pricing paths**, **three context-window calculators**, **three cost-source-of-truth conventions**, and **six different cost formatters in the UI**. The "off" feeling is well-founded.

Cost computation lives in three places:

1. **Harness-trusted pass-through** (`claude`, `pi`, `opencode`, `devin`) — whatever the underlying CLI/SDK says is what gets stored.
2. **Worker-local table compute** (`claude-managed`, `codex`) — `src/providers/{claude-managed-models.ts, codex-models.ts}` maps tokens to USD.
3. **API-side DB pricing-table recompute** (`codex` only) — `POST /api/session-costs` re-derives USD from the seeded `pricing` rows.

This means **the same provider can yield different USD figures depending on which call path** wrote the row, and **only `codex` is double-checked server-side**. The `costSource` column was added to record which path won but the UI never surfaces it.

Context-window usage has its own divergence: `claude-managed` hardcodes a 1M window, `codex` reports a "peak proxy" (`uncached input + output`), `claude` uses `input + cache_read + cache_creation`, `opencode` uses `turnInput + turnCacheRead + turnCacheWrite`, `pi` defers entirely to pi-ai's `ContextUsage`, and `devin` reports **no context data at all**. The `agent_tasks.totalContextTokensUsed` column is overwritten (not summed) on every snapshot despite its cumulative-sounding name.

The high-severity gaps the user is likely sensing:

- **claude** (Claude Code CLI) trusts `total_cost_usd` from the binary with zero validation — there's no DB pricing-table cross-check like Codex gets, despite the schema allowing `claude` rows.
- **claude** stale-session retry (`claude-adapter.ts:582-628`) silently discards the first attempt's cost — work done before a "session not found" error is unbilled.
- **claude** in-session context-percent compares against a static 200k default whenever `init.model` is a dated id (e.g., `claude-sonnet-4-5-20250929`) that doesn't match the shortname map at `src/utils/context-window.ts:7-16`. The real window is only learned at the terminal `result` event from `modelUsage[m].contextWindow`. `peakContextPercent` can therefore be wrong (and >100, since the percent isn't clamped).
- **claude** never extracts thinking-token usage — extended-thinking sessions are invisible to the cost model.
- **claude** stores `model = config.model || "opus"` (the requested model), not whatever the CLI actually selected via `init.model` — so backoff/fallback to a different model is invisible in `session_costs.model`.
- **codex** drops `reasoning_output_tokens` (so reasoning models are billed as if they did no reasoning).
- **codex** hardcodes `cacheWriteTokens = 0` and any unknown OpenAI model id silently yields `$0`.
- **claude-managed** hardcodes the context window to 1M for every model, computes context-used from `input + output` only (excluding cache), and bills a `$0.08/hour` wallclock runtime fee that keeps accruing during idle time.
- **claude-managed** does NOT set the `provider` field on its CostData, so the server cost-source path can never distinguish it.
- **devin** records token counts of `0` for every row, so any "input/output tokens" rollup mixes real numbers with structural zeros.
- The DB `pricing` table is only seeded with **Codex** rows; the `pricing.provider` CHECK forbids `claude-managed` and `opencode` entirely. The "single source of truth" is mostly empty.
- The UI uses **6 different cost formatters** with 2/3/4/6 decimal places depending on screen — same number renders differently per page.
- Dashboard "today" and "MTD" filters compare ISO-8601 strings (`YYYY-MM-DDTHH:MM:SS.SSSZ`) against `date('now')` (`YYYY-MM-DD`) — lexicographic comparison, not date-aware (the `budgets/page.tsx:346-349` comment acknowledges this).
- **MCP `store-progress`** lets the agent self-report cost as a parallel `session_costs` row (`sessionId = "mcp-..."`), bypassing the adapter and (for Codex) the recompute path. Same `taskId` can yield double-counted totals.
- The "context used" formula **differs between providers**: `claude` uses `input + cache_create + cache_read` (excludes output); `claude-managed` uses `input + output` (excludes cache); `codex` uses a "peak proxy" `(input - cached) + output`; `opencode` uses `turnInput + turnCacheRead + turnCacheWrite`; `pi` delegates to pi-ai. Cross-provider percent comparisons are apples-to-oranges.

There is **no `gemini` adapter** — `src/claude.ts` is a debug-only spawn helper, not a real provider. Gemini-named models can only flow in via OpenRouter through `internal-ai`, which has no pricing entry for them.

## Detailed findings

### 1. Pipeline overview

All adapters emit a normalized `ProviderEvent` stream (`src/providers/types.ts:27-55`) to `src/commands/runner.ts`:

- `result` carries terminal `CostData` (`src/providers/types.ts:1-22`).
- `context_usage` carries `{contextUsedTokens, contextTotalTokens, contextPercent, outputTokens}` (`src/providers/types.ts:43-49`).
- `compaction` carries `{preCompactTokens, compactTrigger, contextTotalTokens}` (`src/providers/types.ts:50-55`).

Persistence sinks:

| Event | HTTP endpoint | Table | Throttle |
|---|---|---|---|
| `result` | `POST /api/session-costs` | `session_costs` | none, awaited at completion (`src/commands/runner.ts:2141-2150`) |
| `context_usage`/`progress` | `POST /api/tasks/:id/context` | `task_context_snapshots` + `agent_tasks` aggregates | 30s (`src/commands/runner.ts:1893, 2015-2034`) |
| `compaction` | `POST /api/tasks/:id/context` | same | none |
| `completion` | `POST /api/tasks/:id/context` | same | once at end (`src/commands/runner.ts:2154-2169`) |

There's also a parallel MCP-tool path: `store-progress` lets the agent self-report via `src/tools/store-progress.ts:257-285`, which writes to `session_costs` directly with `sessionId = "mcp-<taskId>-<ts>"`, **bypassing the codex pricing-table recompute**.

### 2. Per-provider behavior

#### 2.1 `claude` (Claude Code CLI subprocess)

File: `src/providers/claude-adapter.ts`

- **Token fields**: pulled verbatim from `usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}` on `result` (`src/providers/claude-adapter.ts:483-501`).
- **Thinking tokens**: not extracted. Anthropic's extended-thinking responses can include separate thinking-token accounting; the adapter only reads the four standard fields. If Claude Code rolls thinking into `output_tokens` we capture it, otherwise it's invisible.
- **Context window**: `getContextWindowSize(model)` (`src/utils/context-window.ts:7-16`) called at `init` with `json.model`, refined to `result.modelUsage[modelKey].contextWindow` at terminal time (`src/providers/claude-adapter.ts:467-469, 516-521`).
  - The shortname map only contains 7 keys: `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `opus`, `sonnet`, `haiku`, plus a `default` of 200k. **Any dated/full model id (e.g. `claude-sonnet-4-5-20250929`) falls through to 200k** for the entire run until the terminal `result` arrives.
- **Context used**: per-assistant-message `input + cache_create + cache_read` via `computeContextUsed` (`src/utils/context-window.ts:32-42`). **Excludes `output_tokens`** — different formula from `claude-managed`.
- **Context percent**: `(used / total) * 100` (`src/providers/claude-adapter.ts:552`) — **not clamped to 100**. Combined with the 200k fallback above, mid-session percent can read >100 for tasks on a 1M-window model.
- **Cost**: `json.total_cost_usd` from the CLI is trusted as-is (`src/providers/claude-adapter.ts:497`). No DB pricing-table cross-check (`POST /api/session-costs` recompute gates on `provider === "codex"`).
- **`numTurns`**: `json.num_turns || 1` — **defaults to 1** if the CLI omits the field (`src/providers/claude-adapter.ts:503`).
- **`durationMs`**: `json.duration_ms` per invocation — wallclock idle time between prompts is not counted.
- **`model` field**: set once at session creation from `config.model || "opus"` (`src/providers/claude-adapter.ts:644`). The `init` event's `json.model` refines `contextWindowSize` but **never updates `this.model`**, so `session_costs.model` is always the requested model, not the model the CLI actually used.
- **`provider` tag**: `"claude"` (`src/providers/claude-adapter.ts:506`).
- **`costSource` outcome**: always `"harness"` (codex-recompute branch gated to `provider === "codex"`).
- **Compaction**: emitted with real `compact_metadata.{pre_tokens, trigger}` (`src/providers/claude-adapter.ts:473-480`).
- **Reset semantics**: per CLI invocation. Each `-p` call emits one `result`, so a multi-prompt task produces multiple `session_costs` rows (aggregated by SUM in dashboard queries).
- **Stale-session retry discards cost** (`src/providers/claude-adapter.ts:582-628`): on "session not found" with `--resume`, the adapter spawns a fresh `ClaudeSession` and returns its result; the first attempt's `lastCost` is dropped. If the first attempt did real model work before the error, that cost is unbilled.
- **Double-count risk via MCP `store-progress`**: an agent calling the `store-progress` tool with non-zero cost (`src/tools/store-progress.ts:262-281`) inserts a parallel row keyed `sessionId = "mcp-<taskId>-<ts>"`. With the same `taskId`, `SUM(totalCostUsd)` per-task queries can double-count.

#### 2.2 `claude-managed` (Anthropic Managed Agents cloud)

File: `src/providers/claude-managed-adapter.ts`

- **Token fields**: accumulated session-scoped from `span.model_request_end.model_usage` (`src/providers/claude-managed-adapter.ts:518-527`).
- **Context window**: **hardcoded 1,000,000** for all models (`DEFAULT_CONTEXT_TOTAL_TOKENS` at `src/providers/claude-managed-adapter.ts:122`). Never per-model.
- **Context used**: `inputTokens + outputTokens` (running sum, **excludes** cache_read and cache_create) (`src/providers/claude-managed-adapter.ts:529`). **Percent clamped** to 100 (`:535`).
- **Cost**: `computeClaudeManagedCostUsd(model, in, out, cacheR, cacheW)` from `src/providers/claude-managed-models.ts:94-117` + `(durationMs/3_600_000) * $0.08` runtime fee inline (`src/providers/claude-managed-adapter.ts:389`). The runtime fee is amortized to call-time and counts **idle time between turns**.
- **`provider` tag**: **unset** (`src/providers/claude-managed-adapter.ts:176-191` `emptyCost()` does not assign it).
- **`costSource` outcome**: always `"harness"` (no `provider` → recompute branch not entered; also `pricing.provider` CHECK at `src/be/migrations/046_budgets_and_pricing.sql:50` doesn't allow `"claude-managed"` anyway).
- **Compaction**: emitted but synthetic — `preCompactTokens = current inputTokens` (not a real pre-compact value), `compactTrigger` hardcoded `"auto"` (`src/providers/claude-managed-adapter.ts:504-517`).
- **`numTurns`**: count of `span.model_request_end` events, not user turns (`src/providers/claude-managed-adapter.ts:527`).
- **Reset semantics**: cumulative across all spans; resume **does not** replay history into `this.cost` (`src/providers/claude-managed-adapter.ts:789-807`).

#### 2.3 `codex` (OpenAI Codex SDK)

File: `src/providers/codex-adapter.ts`

- **Token fields**: from `turn.completed.usage.{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}` — adapter consumes the first three; **`reasoning_output_tokens` is read into `lastUsage` but never extracted into CostData** (no grep matches in `src/`). The `CostData` type (`src/providers/types.ts:1-22`) has no reasoning/thinking field.
- **Context window**: per-model `CODEX_MODEL_CONTEXT_WINDOWS` map (`src/providers/codex-models.ts:65-78`), default 200k for unknown models.
- **Context used (peak proxy)**: `max(0, input - cached) + output` (`src/providers/codex-adapter.ts:761-794`). Explicitly documented as a proxy because Codex SDK aggregates inputs across all model calls in the turn. Percent **clamped** to 100.
- **Cost (worker)**: `computeCodexCostUsd(model, input, cached, output)` (`src/providers/codex-models.ts:136-149`). `uncached = max(0, input - cached)` billed at full rate; cached billed at cached rate. **`cacheWriteTokens` hardcoded to `0`** (`src/providers/codex-adapter.ts:545`). Unknown model → **$0 silently** (`src/providers/codex-models.ts:142-143`).
- **Cost (server-side recompute)**: `src/http/session-data.ts:200-218` — for `provider:"codex"`, looks up active `pricing` rows for input / cached_input / output at `createdAt`, recomputes USD, tags `costSource="pricing-table"`. The recompute defaults model to `"opus"` if missing (`src/http/session-data.ts:189`) — would never match any seeded codex row.
- **`provider` tag**: `"codex"` (`src/providers/codex-adapter.ts:550`).
- **MODEL_OVERRIDE passthrough hazard** (`src/providers/codex-models.ts:51-55`): any unknown OpenAI model id flows through to the SDK. Cost computation returns `$0` for unknowns; the DB recompute also yields nothing → silently free.
- **Compaction**: **not emitted**. Context overflow surfaces as `turn.failed` mapped to `category: "context_overflow"` via regex (`src/providers/codex-adapter.ts:832-846`).
- **Reset semantics**: `lastUsage` overwrites on every `turn.completed`; final CostData uses **only the last turn**.

#### 2.4 `pi` (pi-mono)

File: `src/providers/pi-mono-adapter.ts`

- **Token fields**: from pi-ai `SessionStats.tokens.{input, output, cacheRead, cacheWrite}` (`src/providers/pi-mono-adapter.ts:494-510`).
- **Context window**: delegated entirely to `agentSession.getContextUsage()` (`src/providers/pi-mono-adapter.ts:359-369`).
- **Cost**: `stats.cost` from pi-ai trusted blindly (`src/providers/pi-mono-adapter.ts:499`).
- **`durationMs`**: **hardcoded `0`** (`src/providers/pi-mono-adapter.ts:504`) — "Not directly available from SessionStats".
- **`context_usage.outputTokens`**: **hardcoded `0`** (`src/providers/pi-mono-adapter.ts:368`).
- **`numTurns`**: `userMessages + assistantMessages` from pi-ai (`src/providers/pi-mono-adapter.ts:505`).
- **`provider` tag**: `"pi"` (`src/providers/pi-mono-adapter.ts:508`). No DB pricing rows seeded for `"pi"` so recompute would no-op even if enabled.
- **Compaction events**: **not emitted**.
- **Model id mismatch**: pi-mono internally maps shortnames at `src/providers/pi-mono-adapter.ts:157-159` (`anthropic/claude-opus-4`, etc.) and again at `:202-204` (`claude-opus-4-20250514`, etc.). Neither overlaps with the `CLAUDE_MANAGED_MODEL_PRICING` keys (`claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5`), and neither matches the `getContextWindowSize` shortname map at `src/utils/context-window.ts:7-16`.

#### 2.5 `opencode`

File: `src/providers/opencode-adapter.ts`

- **Token fields**: accumulated from `message.updated.info.tokens.{input, output, cache.read, cache.write}` (`src/providers/opencode-adapter.ts:240-245`).
- **Context window**: `getContextWindowSize(modelID)` from claude shortname map at `src/utils/context-window.ts:7-16` (default 200k for non-claude models like Gemini).
- **Context used**: per-turn `turnInput + turnCacheRead + turnCacheWrite` (`src/providers/opencode-adapter.ts:252-256`). **Percent not clamped**.
- **Cost**: accumulated SDK-reported `msg.cost` (`src/providers/opencode-adapter.ts:241`).
- **`provider` tag**: `"opencode"` (`src/providers/opencode-adapter.ts:387`). BUT `pricing.provider` CHECK does **not** allow `"opencode"` (`src/be/migrations/046_budgets_and_pricing.sql:50`) — there's no place to store opencode pricing rows in DB even though the API endpoint accepts `provider:"opencode"` in the request body (`src/http/session-data.ts:78`).
- **Compaction**: not emitted.
- **Resume**: not supported (`canResume` returns false at `src/providers/opencode-adapter.ts:592-594`).

#### 2.6 `devin`

File: `src/providers/devin-adapter.ts`

- **Token fields**: **all zero**. `inputTokens: 0`, `outputTokens: 0`, `cacheReadTokens`/`cacheWriteTokens` unset (`src/providers/devin-adapter.ts:779-792`).
- **Context window**: **not reported**. No `context_usage` event ever emitted. The completion-time snapshot from runner.ts still writes a row but `contextUsedTokens` is missing, so `agent_tasks.totalContextTokensUsed` is **never updated for Devin tasks** (`src/be/db.ts:8351-8355` requires non-null).
- **Cost**: `acus_consumed * DEFAULT_ACU_COST_USD` where `DEFAULT_ACU_COST_USD = 2.25` USD/ACU, overridable via env `DEVIN_ACU_COST_USD` (`src/providers/devin-adapter.ts:54, 57, 141-142, 784`). No source URL, no last-verified date in code.
- **`provider` tag**: **unset** (`src/providers/devin-adapter.ts:779-792`).
- **`costSource`**: always `"harness"`.
- **`numTurns`**: **poll count**, not actual turn count (`src/providers/devin-adapter.ts:788`).

#### 2.7 `gemini`

**There is no `gemini` adapter.**

- `src/providers/index.ts:27-45` only registers `claude`, `pi`, `codex`, `claude-managed`, `devin`, `opencode`.
- `src/claude.ts` is a debug-only `Bun.spawn` wrapper, no cost handling.
- The only Gemini surface is `internal-ai`'s default `openrouter/google/gemini-3-flash-preview` (`src/utils/internal-ai/models.ts:19-25`) — used internally for summarization/rating, with **no pricing entry anywhere**, no `gemini` provider in `PricingProviderSchema` (`src/types.ts:1433`), no rows in any pricing table.

### 3. Pricing surface

Three sources of truth:

#### 3.1 In-code map: `CODEX_MODEL_PRICING`

File: `src/providers/codex-models.ts:105-127`. Dated **2026-04-09** in comments (`codex-models.ts:3, 83-94`).

| Model | input/Mtok | cached/Mtok | output/Mtok |
|---|---|---|---|
| `gpt-5.4` (default) | $2.50 | $0.25 | $15.00 |
| `gpt-5.4-mini` | $0.75 | $0.075 | $4.50 |
| `gpt-5.3-codex` | $1.75 | $0.175 | $14.00 |
| `gpt-5.2-codex` (legacy, retiring) | $1.75 | $0.175 | $14.00 |

No cache-write, no reasoning-token rate.

#### 3.2 In-code map: `CLAUDE_MANAGED_MODEL_PRICING`

File: `src/providers/claude-managed-models.ts:55-74`. Dated **2026-04-28**. 5-minute cache TTL only.

| Model | input/Mtok | output/Mtok | cache-read/Mtok | cache-write/Mtok |
|---|---|---|---|---|
| `claude-sonnet-4-6` | $3.00 | $15.00 | $0.30 | $3.75 |
| `claude-opus-4-7` | $15.00 | $75.00 | $1.50 | $18.75 |
| `claude-haiku-4-5` | $1.00 | $5.00 | $0.10 | $1.25 |

`claude-opus-4-6` is in the context-window map (`src/utils/context-window.ts:7-16`) but **not in this pricing map**.

#### 3.3 DB `pricing` table

Schema: `src/be/migrations/046_budgets_and_pricing.sql:41-55`. CRUD: `src/be/db.ts:9351-9454`. Routes: `src/http/pricing.ts:45-116`.

- PK `(provider, model, token_class, effective_from)`.
- `provider` CHECK: `IN ('claude', 'codex', 'pi')` — **no `claude-managed`, no `opencode`, no `devin`, no `gemini`**.
- `token_class` CHECK: `IN ('input', 'cached_input', 'output')` — **no `cache_write`** despite Anthropic separately pricing it.
- Seed: 12 rows, **Codex-only** (`046_budgets_and_pricing.sql:75-87`).

#### 3.4 Devin: `DEFAULT_ACU_COST_USD = 2.25`

File: `src/providers/devin-adapter.ts:57`. Inline constant, no source URL, no date.

#### 3.5 `$0.08/hr` Anthropic Managed Agents runtime fee

File: `src/providers/claude-managed-adapter.ts:389`. Inline literal in `snapshotCost`; not in any pricing table; not separately tracked or reported.

### 4. Cost-computation paths

| Provider | Cost source | Cache rates | Runtime fee | DB recompute | `costSource` |
|---|---|---|---|---|---|
| `claude` | CLI `total_cost_usd` | by CLI | none | none | `harness` |
| `claude-managed` | local `computeClaudeManagedCostUsd` + `$0.08/hr` | yes (4 classes) | yes, amortized wallclock | none (provider tag unset, schema doesn't allow it anyway) | `harness` |
| `codex` | local `computeCodexCostUsd` | yes (cached only) | none | **yes** — `pricing` table when all 3 rows present | `pricing-table` if recompute hits, else `harness` |
| `pi` | `stats.cost` from pi-ai | by pi-ai | none | none | `harness` |
| `opencode` | accumulated `msg.cost` | by SDK | none | none (schema rejects `opencode` rows) | `harness` |
| `devin` | `acus × $2.25` | n/a | n/a | none | `harness` |

### 5. DB storage

#### 5.1 `session_costs` (`src/be/migrations/001_initial.sql:179-196`)

`totalCostUsd REAL NOT NULL` (USD as float, no cents-vs-dollars ambiguity). All token counts INTEGER. `costSource` added in `047_session_costs_cost_source.sql:15-16`.

#### 5.2 `task_context_snapshots` (`src/be/migrations/022_context_usage.sql`)

Columns: `contextUsedTokens`, `contextTotalTokens`, `contextPercent` (REAL, 0-100), `eventType` (`progress|compaction|completion`), `cumulativeInputTokens`, `cumulativeOutputTokens`, `preCompactTokens`, `compactTrigger`.

**`cumulativeInputTokens` / `cumulativeOutputTokens` are only ever populated by the terminal `completion` snapshot** (`src/commands/runner.ts:2154-2169`). All mid-session `progress` snapshots write `0` for these fields (`src/commands/runner.ts:2015-2034`).

#### 5.3 `agent_tasks` aggregate columns (added in `022_context_usage.sql:31-34`)

- `peakContextPercent` — monotonic max, correct.
- `totalContextTokensUsed` — **overwritten** with the latest snapshot's `contextUsedTokens`, NOT summed (`src/be/db.ts:8351-8354`). Name is misleading.
- `contextWindowSize` — **only set on `completion` event** when `contextTotalTokens != null` (`src/be/db.ts:8365-8368`). NULL during run.
- `compactionCount` — incremented on each compaction event, correct.

#### 5.4 Timestamp convention mismatch

- `session_costs.createdAt`, `task_context_snapshots.createdAt` — TEXT ISO 8601.
- `budgets.createdAt`, `budgets.lastUpdatedAt`, `pricing.effective_from`, `pricing.createdAt`, `pricing.lastUpdatedAt`, `budget_refusal_notifications.createdAt` — INTEGER **epoch ms**.

The divergence is documented in `src/be/migrations/046_budgets_and_pricing.sql:17-22` but it means date-range queries can't cross the two conventions trivially.

### 6. API endpoints

| Endpoint | File | Purpose |
|---|---|---|
| `POST /api/session-costs` | `src/http/session-data.ts:54-90, 181-241` | Ingestion (with codex recompute branch) |
| `GET /api/session-costs` | `src/http/session-data.ts:121-137, 262-286` | List/filter |
| `GET /api/session-costs/summary` | `src/http/session-data.ts:92-108, 243-254` | Aggregations |
| `GET /api/session-costs/dashboard` | `src/http/session-data.ts:110-119, 256-260` | `{costToday, costMtd}` |
| `POST /api/tasks/{id}/context` | `src/http/context.ts:15-39, 67-98` | Context-snapshot ingestion |
| `GET /api/tasks/{id}/context` | `src/http/context.ts:41-56, 100-115` | Per-task snapshots + summary |
| `GET /api/keys/costs` | `src/http/api-keys.ts:98-112, 193-206` | Per-API-key rollup |
| `GET/POST/DELETE /api/pricing/*` | `src/http/pricing.ts:45-116` | Pricing CRUD |
| `GET/PUT/DELETE /api/budgets/*` | `src/http/budgets.ts:48-116` | Budgets CRUD |

#### 6.1 Dashboard date filter quirk

`getDashboardCostSummary` (`src/be/db.ts:4112-4125`):

```sql
WHERE createdAt >= date('now')               -- 'YYYY-MM-DD'
WHERE createdAt >= date('now','start of month')
```

Compares ISO-8601 timestamp strings against `'YYYY-MM-DD'` lexicographically. Works in practice because `'2026-05-15T...'` ≥ `'2026-05-15'`, but it's a fragile coupling. `ui/src/pages/budgets/page.tsx:346-349` explicitly calls out the lex-comparison gotcha for end-date filters.

#### 6.2 API key cost INNER JOIN drops rows

`getKeyCostSummary` (`src/be/db.ts:8627-8653`) uses `JOIN agent_tasks t ON sc.taskId = t.id`. The `session_costs.taskId` FK is `SET NULL`, so any cost row with NULL `taskId` (e.g. orphaned session) is **dropped** from per-key totals.

### 7. UI display fragmentation

**Six different cost formatters**, plus inline `toFixed()` calls. Same dollar value renders differently across pages:

| Site | Formatter | Decimals |
|---|---|---|
| `ui/src/lib/utils.ts:138-145` `formatCurrency` | bucketed K/M | 3 for `<$1`, 2 for `<$10`, 0 for `<$1000` |
| `ui/src/components/shared/stats-bar.tsx:73-76` `formatCostCompact` | linear | 2 (`<0.01 → '$0'`) |
| `ui/src/pages/budgets/page.tsx:62-64` `formatUsd` | linear | 2 |
| `ui/src/components/dashboard/agent-node.tsx:37-42` `formatCost` | bucketed | 0/2 (`<0.01 → '<$0.01'`) |
| `ui/src/components/dashboard/agent-table.tsx:31-34` `formatCost` | bucketed | 4 for `<$1`, 2 otherwise |
| `ui/src/pages/sessions/[rootTaskId]/page.tsx:29-33` & `task-detail-sheet.tsx:41-45` | `Intl.NumberFormat` | up to 4 |
| `ui/src/pages/tasks/[id]/page.tsx:299` | inline `toFixed(4)` | 4 |
| `ui/src/pages/api-keys/page.tsx:298` (per-row), `:340` (total) | inline `toFixed(4)` / `toFixed(2)` | 4 then 2 |
| `ui/src/pages/budgets/page.tsx:684` (pricing column) | inline `toFixed(6)` | 6 |

**`costSource` is not exposed in the UI**. The `SessionCost` interface at `ui/src/api/types.ts:429-444` omits the field entirely (it's present in `src/types.ts` but not propagated to the UI type). Users cannot tell whether a Codex cost came from the harness or was recomputed from the DB pricing table.

`tasks/[id]/page.tsx:412` falls back from `latestSnapshot?.contextPercent ?? summary.peakContextPercent ?? 0` — "current" can be peak if the latest snapshot has no percent (e.g. Devin).

### 8. Cross-provider comparison

#### 8.1 Token fields actually populated

| Provider | input | output | cache_read | cache_write | reasoning | per-turn or cumulative |
|---|---|---|---|---|---|---|
| `claude` | yes | yes | yes | yes (as `cache_creation`) | dropped | per-result (last only) |
| `claude-managed` | yes (accumulated) | yes | yes | yes | dropped | cumulative session |
| `codex` | yes | yes | yes (as `cached_input`) | **hardcoded 0** | **dropped** | last-turn only |
| `pi` | yes | yes | yes | yes | n/a | cumulative session |
| `opencode` | yes | yes | yes | yes | n/a | cumulative session |
| `devin` | **0** | **0** | unset | unset | n/a | n/a |

#### 8.2 Context window size source

| Provider | Source | Value |
|---|---|---|
| `claude` | `src/utils/context-window.ts` map, refined by CLI `modelUsage` | per-model |
| `claude-managed` | hardcoded constant | **1,000,000 for all models** |
| `codex` | `CODEX_MODEL_CONTEXT_WINDOWS` | per-model (default 200k) |
| `pi` | pi-ai's `getContextUsage()` | per-model (from pi-ai) |
| `opencode` | `getContextWindowSize(modelID)` | claude shortname only, else default 200k |
| `devin` | n/a — no context_usage emitted | n/a |

#### 8.3 Context-used formula (apples to oranges)

| Provider | Formula | Includes output? | Includes cache_read? | Includes cache_write? | Window divisor |
|---|---|---|---|---|---|
| `claude` | `input + cache_read + cache_create` per assistant message | **no** | yes | yes | shortname-only map (falls to 200k for dated ids) |
| `claude-managed` | running `input + output` (no cache fields) | **yes** | **no** | **no** | hardcoded 1M |
| `codex` | "peak proxy" `(input - cached) + output` | yes | partial (subtracted) | n/a | per-model map |
| `pi` | provided by pi-ai | per pi-ai | per pi-ai | per pi-ai | per pi-ai |
| `opencode` | `turnInput + turnCacheRead + turnCacheWrite` (per turn) | **no** | yes | yes | claude shortname map (200k for non-claude) |
| `devin` | not emitted | — | — | — | — |

The same task running on different providers can report wildly different `contextPercent` values. None of these are wrong in isolation, but they are not comparable.

#### 8.4 `durationMs` / `numTurns` semantics

| Provider | durationMs | numTurns |
|---|---|---|
| `claude` | CLI `duration_ms` | CLI `num_turns` |
| `claude-managed` | wallclock since session start | count of `span.model_request_end` |
| `codex` | wallclock since session start | count of `turn.started` |
| `pi` | **0** (hardcoded) | `userMessages + assistantMessages` |
| `opencode` | wallclock since session start | count of `message.updated` |
| `devin` | wallclock since session start | **poll count** |

#### 8.5 `provider` tag on CostData (drives recompute path)

| Provider | `provider` field set? |
|---|---|
| `claude` | `"claude"` |
| `claude-managed` | **unset** |
| `codex` | `"codex"` — only one that triggers DB recompute |
| `pi` | `"pi"` |
| `opencode` | `"opencode"` (but schema rejects `opencode` rows) |
| `devin` | **unset** |

#### 8.6 Compaction emission

| Provider | Emits? | Real preCompactTokens? | Real trigger? |
|---|---|---|---|
| `claude` | yes | yes | yes |
| `claude-managed` | yes | **no** (uses current `inputTokens`) | **no** (hardcoded `"auto"`) |
| `codex` | no (overflow = error) | n/a | n/a |
| `pi` | no | n/a | n/a |
| `opencode` | no | n/a | n/a |
| `devin` | no | n/a | n/a |

### 9. Observed gaps (catalog — descriptive, not prescriptive)

The user asked specifically for "gaps". Below is what the research surfaces, classified by severity-of-impact-on-numbers, not by recommended fix.

#### 9.1 Provider-side data loss

- **Claude stale-session retry discards cost** (`src/providers/claude-adapter.ts:582-628`). On "session not found" with `--resume`, the first attempt's `lastCost` is thrown away. Real work done before the error is unbilled.
- **Claude doesn't extract thinking tokens** from `result.usage` — extended-thinking responses with separate thinking-token accounting are invisible.
- **Claude `model` field is the requested model, not the actual one** (`src/providers/claude-adapter.ts:644`). CLI fallback/backoff to a different model is invisible in `session_costs.model`.
- **Claude `numTurns` defaults to 1** when CLI omits `num_turns` (`src/providers/claude-adapter.ts:503`).
- **Codex `reasoning_output_tokens` is dropped**. Codex SDK's `Usage` type has the field; the adapter reads it into `lastUsage` but it never reaches `CostData`. Reasoning models effectively look free of reasoning cost.
- **Codex `cacheWriteTokens` hardcoded to `0`** (`src/providers/codex-adapter.ts:545`). Codex SDK doesn't surface cache writes; the field is always zero in the table.
- **claude-managed compaction has no real pre-token value**. The SDK emits the event without numbers, so the adapter substitutes the current `inputTokens` (`src/providers/claude-managed-adapter.ts:514`).
- **claude-managed context-used excludes cache** (`src/providers/claude-managed-adapter.ts:529` uses `input + output` only). Sessions with heavy prompt caching will under-report context usage.
- **pi `durationMs` always 0** (`src/providers/pi-mono-adapter.ts:504`). Any cost-per-minute or duration analysis treats pi runs as instantaneous.
- **pi `context_usage.outputTokens` always 0** (`src/providers/pi-mono-adapter.ts:368`). Output-token rate analysis is broken for pi.
- **Devin has no tokens at all** — every row stores `0` for input/output. Token rollups mixed across providers will under-count.
- **Devin has no context_usage emission**. `agent_tasks.totalContextTokensUsed` is never updated for Devin tasks.

#### 9.2 Context-window asymmetries

- **claude shortname-only lookup falls through to 200k** for any dated/full model id. `src/utils/context-window.ts:7-16` matches only 7 keys. The CLI's `init.model` may be `claude-sonnet-4-5-20250929` etc., which falls through to `default = 200k`. The real window is only learned at the terminal `result` event (`src/providers/claude-adapter.ts:516-521`). In-session `contextPercent` snapshots are computed against the wrong divisor for the entire run, so **`agent_tasks.peakContextPercent` can be wrong (and >100)**.
- **claude-managed uses a hardcoded 1M context window** regardless of model (`src/providers/claude-managed-adapter.ts:122`). Haiku-class models with 200k windows are reported as 5x bigger than reality, so context-percent looks artificially low.
- **codex uses a "peak proxy" formula** rather than the actual token count. Documented at `src/providers/codex-adapter.ts:763-786`.
- **`contextPercent` not clamped to 100** for `claude` (`src/providers/claude-adapter.ts:552`) and `opencode` (`src/providers/opencode-adapter.ts:263`). Percent ≥ 100 can appear in snapshots.
- **`agent_tasks.totalContextTokensUsed` is overwritten, not summed** (`src/be/db.ts:8351-8354`). Name suggests cumulative; behavior is "last value".
- **`agent_tasks.contextWindowSize` is NULL for in-flight tasks** (only set on completion). UI fallback chain is `snapshot.contextTotalTokens ?? agent_tasks.contextWindowSize ?? hardcoded default`.
- **"context used" formula differs per provider** — see comparison in §8.3. `claude` excludes output; `claude-managed` excludes cache; `codex` uses a "peak proxy"; `opencode` sums only the current turn. Cross-provider context-percent comparisons are not meaningful.

#### 9.3 Pricing-table coverage holes

- **Only Codex models are seeded** in the DB `pricing` table (`src/be/migrations/046_budgets_and_pricing.sql:75-87`). Claude / claude-managed / pi / opencode / devin all use pass-through, with no server-side cross-check.
- **`pricing.provider` CHECK doesn't include `"claude-managed"` or `"opencode"`** (`046_budgets_and_pricing.sql:50`). The API accepts `opencode` in session-costs body but couldn't lookup pricing for it even if rows existed.
- **`pricing.token_class` CHECK doesn't include `"cache_write"`** (`046_budgets_and_pricing.sql:51`). Anthropic's cache-write rate cannot be represented in DB.
- **No `gemini` provider anywhere** in pricing enum.
- **Codex `MODEL_OVERRIDE` passthrough is unbounded**: any unknown OpenAI model id silently bills `$0` (`src/providers/codex-models.ts:51-55, 142-143`).
- **`internal-ai`'s `openrouter/google/gemini-3-flash-preview`** (`src/utils/internal-ai/models.ts:19-25`) has no pricing entry — any call through this path is uncosted.
- **`openai-codex/gpt-5.4-mini` vs `codex/gpt-5.4-mini`** — internal-ai uses the former (`internal-ai/models.ts:23`), DB rows are seeded as the latter (`046_budgets_and_pricing.sql:79-81`). Two different `(provider, model)` keys.
- **`gpt-5.2-codex` retiring** — pricing inherited from `gpt-5.3-codex` (`src/providers/codex-models.ts:121-126`).
- **claude-managed table only covers `claude-opus-4-7`** — not `claude-opus-4-6` (which IS in the context-window map at `src/utils/context-window.ts:7-16`).

#### 9.4 Cost computation path inconsistencies

- **Only `codex` gets server-side DB recompute** (`src/http/session-data.ts:200`). Everyone else (including `claude`) stores `costSource="harness"` even when the schema would allow a `claude` pricing row.
- **Claude's `total_cost_usd` is trusted without validation** — there is no DB pricing-table for `claude` (the seed in `046_budgets_and_pricing.sql:75-87` only inserts Codex rows), and no in-code recompute. Whatever the CLI's binary computes — including any quirks in its own cache-rate handling — is what's persisted.
- **MCP `store-progress` path bypasses recompute entirely** (`src/tools/store-progress.ts:270-285`) — direct `createSessionCost(...)` call. For any provider, an agent self-reporting via this tool can yield a parallel row keyed `sessionId = "mcp-..."` and the same `taskId` — `SUM` aggregations double-count.
- **Codex recompute uses `model || "opus"` default** (`src/http/session-data.ts:189`) — hardcoded fallback would never match any codex pricing row.
- **`claude-managed` and `devin` don't set `provider` tag** on CostData, so even adding pricing rows for them wouldn't change anything without an adapter change.
- **`$0.08/hr` runtime fee** for claude-managed is an inline literal (`src/providers/claude-managed-adapter.ts:389`), not in any table; counts idle time between turns.
- **Devin's `$2.25/ACU`** is an inline default (`src/providers/devin-adapter.ts:57`), no source, no date, no pricing-table entry.

#### 9.5 UI display fragmentation

- **Six different cost formatters** with 2-, 3-, 4-, and 6-decimal renderings (see §7). Same number renders differently across pages.
- **`costSource` not exposed** — UI cannot show "recomputed" vs "as-reported".
- **Dashboard "today" filter uses lexicographic comparison** of ISO timestamp vs `'YYYY-MM-DD'` (`src/be/db.ts:4117-4120`). Works incidentally; documented gotcha at `ui/src/pages/budgets/page.tsx:346-349`.
- **`fetchSessionCosts` returns `costSource`** in the API response but the UI `SessionCost` interface omits it (`ui/src/api/types.ts:429-444`).

#### 9.6 Schema / convention drift

- **Timestamp mix**: `session_costs` uses TEXT ISO 8601; `budgets`/`pricing`/`budget_refusal_notifications` use INTEGER epoch ms (`046_budgets_and_pricing.sql:17-22`).
- **API key cost INNER JOIN** drops rows with NULL `taskId` (`src/be/db.ts:8638-8650`).
- **`cumulative*Tokens` only populated on completion** snapshot — every `progress` snapshot has them as 0 (`src/commands/runner.ts:2015-2034` vs `:2154-2169`).
- **No `task_runs` or `usage_events` aggregate table** — per-run grouping is via `session_costs.sessionId`; multiple sessions per task = multiple rows.

### 10. What WOULD be needed to "fix the feeling" (informational only — user did not ask for fixes)

Not enumerating fixes per skill constraints. Documenting only.

## Code references

### Adapter implementations
- `src/providers/claude-adapter.ts:459-628` — claude CLI session, cost/context emission
- `src/providers/claude-managed-adapter.ts:122, 176-191, 378-396, 429-582, 789-807` — managed-agents adapter, runtime fee, snapshot, resume
- `src/providers/codex-adapter.ts:521-552, 638-808, 832-846` — Codex SDK adapter, peak-proxy, overflow detection
- `src/providers/codex-models.ts:51-55, 65-78, 96-127, 136-149` — Codex resolver, context-window map, pricing, cost function
- `src/providers/pi-mono-adapter.ts:157-159, 202-204, 330-510` — pi-mono adapter, model-id maps, cost build
- `src/providers/pi-mono-extension.ts:423, 536-554, 642-698` — pi context-usage independent POST path
- `src/providers/opencode-adapter.ts:124-129, 229-355, 380-394` — opencode adapter, accumulators
- `src/providers/devin-adapter.ts:54-57, 141-142, 278-365, 779-792` — Devin adapter, ACU cost
- `src/providers/claude-managed-models.ts:36-117` — managed-Claude pricing & cost function
- `src/providers/types.ts:1-55` — CostData and ProviderEvent shapes
- `src/providers/swarm-events-shared.ts:168-219` — shared progress POSTers

### Runner / dispatch
- `src/commands/runner.ts:1143-1166` — `saveCostData` POST `/api/session-costs`
- `src/commands/runner.ts:1893, 2015-2055` — context POST throttle + compaction unthrottled
- `src/commands/runner.ts:2141-2170` — completion-time cost+context save
- `src/commands/runner.ts:1997-2013` — `session.end` business-use event
- `src/tools/store-progress.ts:27-49, 257-285` — MCP self-report path (bypasses recompute)

### Pricing / cost
- `src/providers/codex-models.ts:105-149` — `CODEX_MODEL_PRICING` + `computeCodexCostUsd`
- `src/providers/claude-managed-models.ts:55-117` — `CLAUDE_MANAGED_MODEL_PRICING` + `computeClaudeManagedCostUsd`
- `src/http/session-data.ts:181-241` — server-side recompute (codex-only branch)
- `src/http/pricing.ts:45-242` — pricing CRUD routes
- `src/be/db.ts:9320-9456` — pricing CRUD helpers

### DB / schema
- `src/be/migrations/001_initial.sql:179-196` — `session_costs`
- `src/be/migrations/022_context_usage.sql` — `task_context_snapshots` + aggregate columns
- `src/be/migrations/044_provider_meta.sql` — `agent_tasks.provider`, `providerMeta`
- `src/be/migrations/046_budgets_and_pricing.sql:30-87` — budgets, pricing, refusal notifications, seed
- `src/be/migrations/047_session_costs_cost_source.sql:15-16` — `costSource` column
- `src/be/db.ts:3856-3943, 3975-4125, 8318-8418` — `session_costs` / `task_context_snapshots` CRUD + summaries
- `src/be/db.ts:8627-8653` — `getKeyCostSummary` (INNER JOIN)
- `src/be/db.ts:9472, 9493` — daily-spend `substr(createdAt, 1, 10)`

### Context-window utilities
- `src/utils/context-window.ts:7-42` — shortname map + `computeContextUsed`
- `src/providers/codex-models.ts:65-78` — codex-specific window map

### API routes
- `src/http/session-data.ts` — session-costs ingestion + reads + recompute
- `src/http/context.ts:15-115` — context snapshot routes
- `src/http/budgets.ts` — budgets routes
- `src/http/pricing.ts` — pricing routes
- `src/http/api-keys.ts:98-206` — per-key cost summary

### UI surface
- `ui/src/api/types.ts:429-487, 985-991, 1088` — type definitions (note `costSource` missing on `SessionCost`)
- `ui/src/api/client.ts:496-539` — fetchers
- `ui/src/api/hooks/use-costs.ts` — query hooks
- `ui/src/lib/utils.ts:128-145` — `formatCurrency`
- `ui/src/components/shared/stats-bar.tsx:73-76` — `formatCostCompact`
- `ui/src/components/shared/usage-summary.tsx:90-158` — daily chart
- `ui/src/components/dashboard/agent-node.tsx:37-42` & `agent-table.tsx:31-34` — two different `formatCost` impls
- `ui/src/pages/usage/page.tsx` — usage dashboard
- `ui/src/pages/budgets/page.tsx:62-64, 346-349, 684` — `formatUsd`, lex-comparison warning, pricing decimals
- `ui/src/pages/tasks/[id]/page.tsx:241-450` — `TaskCostSection`, `TaskContextSection`
- `ui/src/pages/sessions/[rootTaskId]/page.tsx:29-33` — `Intl.NumberFormat` cost formatter
- `ui/src/pages/api-keys/page.tsx:296-340` — per-key cost columns
- `ui/src/components/sessions/task-detail-sheet.tsx:41-45` — fourth cost formatter

### Internal AI
- `src/utils/internal-ai/models.ts:19-25` — default model strings (including unpriced Gemini)

## Open questions

- Is anyone actively curating either of the two in-code pricing tables? Both have date stamps (codex: 2026-04-09; claude-managed: 2026-04-28), but the seed in `046_budgets_and_pricing.sql:75-87` would have to be regenerated on every pricing change.
- The codex server-side recompute path was added (Phase 6 per migration comments) but never extended to other providers — was that intentional, or just incomplete?
- Should the `pricing` table CHECK be relaxed to include `claude-managed` and `opencode`? The API accepts both as `provider` values but the schema doesn't.
- `agent_tasks.totalContextTokensUsed` name vs behavior — is this a known artifact, or a missed sum/overwrite distinction?
- The MCP `store-progress` self-report path: when does an agent legitimately call this? It writes a parallel `session_costs` row keyed `sessionId = "mcp-..."` that bypasses the codex recompute. If it duplicates the adapter's row, the per-task total would double-count.

## Related notes

None found in `thoughts/taras/` covering this topic directly. The Claude input-format document at `thoughts/taras/research/2026-03-28-claude-code-input-format-stream-json.md` references thinking-token plumbing but doesn't connect to cost computation.
