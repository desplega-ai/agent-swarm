# Pricing sources

This page lists the sources that feed the `pricing` table. Operators bumping a
rate by hand should also update this file.

## Primary pricing freshness: runtime models.dev refresh

- **Runtime module**: `src/be/pricing-refresh.ts`
- **Upstream**: `https://models.dev/api.json`, fetched with `If-None-Match`.
- **Boot wiring**: after `seedPricingFromModelsDev()`, the API server starts one
  non-blocking refresh and then repeats every 12 hours with `setInterval`.
- **Update rule**: project upstream through `buildModelsDevSeedRows()` and insert
  a new `effective_from=Date.now()` row only when the model/token class is new
  or the active price changed. Identical prices are no-ops.
- **Growth bound**: after each refresh, keep only the latest two rows per
  `(provider, model, token_class)` triple.
- **Pinned local entries**: safe by construction. The runtime refresh only adds
  pricing rows; it does not rewrite or delete the committed snapshot.

## Live UI catalog: GET /api/models-catalog

- **Runtime module**: `src/be/models-catalog.ts`; route in
  `src/http/models-catalog.ts`.
- Every successful models.dev fetch in the runtime refresh above also updates
  an in-memory slim catalog (openrouter / anthropic / openai / amazon-bedrock
  only, picker-relevant fields only). The UI model picker
  (`apps/ui/src/lib/agent-runtime-models.ts` via `useModelsCatalog()`) prefers
  this over its build-time snapshot, so new models appear without a deploy.
- Pinned limited-availability entries (`PINNED_MODELSDEV_ENTRIES`) are
  re-merged from the vendored snapshot when models.dev doesn't list them yet.
- Until the first successful fetch (or when models.dev is unreachable) the
  endpoint serves the vendored snapshot with `source: "snapshot"`.

## Fallback/UI catalog: vendored models.dev snapshot

- **Fallback path**: `src/be/modelsdev-cache.json`
- **UI compatibility path**: `apps/ui/src/lib/modelsdev-cache.json` symlinks to the
  backend snapshot so existing UI imports keep working.
- **Loaded by**: `src/be/modelsdev-cache.ts` → `src/be/seed-pricing.ts` →
  `seedPricingFromModelsDev()`,
  called from `src/server.ts` after `initDb`.
- **Role**: cold-start fallback seed for pricing when models.dev is unavailable,
  plus the fallback for the UI model picker while `GET /api/models-catalog`
  hasn't resolved (names, labels, and context windows).
- **Projection rules** (see the same module for code-level detail):
  - Anthropic models → rows under `provider='claude'` AND `provider='claude-managed'`.
    Shortnames (`opus`, `sonnet`, `haiku`) ALSO get rows keyed by the current
    default full id (e.g. `opus → claude-opus-4-7`). Pi-mono uses the same
    shortname forms, so they're projected under `provider='pi'` as well.
  - OpenAI models → rows under `provider='codex'`.
  - OpenRouter models → rows under `provider='opencode'`, `provider='pi'` and
    `provider='dsh'` (dsh strips `openrouter/` at lookup). Any `google/...`
    row additionally gets projected under `provider='gemini'` (both the
    stripped name and the full `google/...` id) so internal-ai callers find
    a hit either way.
  - DeepSeek direct-API models (models.dev `deepseek` section, bare ids) →
    rows under `provider='dsh'`. dsh's `deepseek-flash` id is not in that
    section and stays `unpriced`.
  - Anthropic, OpenAI, Google and Fireworks models (models.dev `anthropic`,
    `openai`, `google`, `fireworks-ai` sections, the vendor's own ids) → rows
    under `provider='amp'`. Amp reports the model it routed a mode to
    (`claude-opus-5-5`, `gpt-5-nano-2025-08-07`,
    `accounts/fireworks/models/glm-5p3-flash`); the lookup strips a
    `provider/` pin prefix and an OpenAI `-YYYY-MM-DD` snapshot date. A model
    outside these sections stays `unpriced`. An `amp` row without a per-model
    breakdown (the thread export failed) is `estimated`: its stream totals are
    priced at the pin, else the model its mode is known to run
    (`AMP_ESTIMATE_MODELS`), else the `medium` model, never recorded as $0.
    When the adapter reports what Amp billed (`amp threads usage`, only when
    every request was billed through Amp), that harness cost wins and the
    rows above only fill the per-model breakdown.
  - xAI models (models.dev `xai` section, bare ids such as `grok-4.6`) → rows
    under `provider='grok'`. Base rates only; the `context_over_200k` tier is
    not projected (no provider projects context tiers yet). The adapter sends
    what xAI billed (`_meta.usage.costUsdTicks`), which wins over these rows
    as for amp. OpenRouter models also project under `provider='grok'` for
    `openrouter/<id>` models, which report no USD.
  - OpenAI, Anthropic, Google and xAI models (bare vendor ids) → rows under
    `provider='cursor'`. Cursor bills the vendor's API rates and reports the
    vendor's own id. The adapter subtracts cache reads and writes from SDK
    `inputTokens`, clamped to zero, so fresh input is priced separately.
    Cursor's own models are not in models.dev: see
    `CURSOR_FIRST_PARTY_PRICING` below.

- **Snapshot refresh procedure**:
  - Run `bun run scripts/refresh-modelsdev-pricing.ts` (Phase 2 — adds the
    script). It fetches the latest snapshot from models.dev, diffs against
    the vendored copy, prints a summary, and writes the new file.
  - Commit the regenerated `src/be/modelsdev-cache.json` together with a bump
    note in the PR description. This is no longer the pricing freshness path;
    use it when the fallback/UI catalog needs new labels or context-window data.

## Cursor first-party rates

`CURSOR_FIRST_PARTY_PRICING` in `src/be/seed-pricing.ts` seeds the Composer
models from Cursor's published per-token prices
(https://cursor.com/docs/models-and-pricing, verified 2026-10-05):

| Model | Input | Cache read | Output | Note |
|---|---|---|---|---|
| `composer-2.5` | $3.00 | $0.50 | $15.00 | Composer 2.5 (Fast). Fast is the default variant and the adapter never sets the `fast` param |
| `composer-2` | $3.00 | $0.50 | $15.00 | Retired; Cursor reroutes it to Composer 2.5 (https://cursor.com/docs/sdk/typescript) |

Cursor publishes no cache-write rate for Composer. `default` (Auto) has no rate
of its own: Cursor bills it at the list price of the model each request is
routed to, so it stays `unpriced`. `agent.getUsage()` (Cursor's billed cents)
would be the exact figure, but it answers `feature_unavailable` for local agents
on our account (re-checked 2026-10-05), so these rows are an estimate from
list prices. They do not include plan discounts, included usage, or the $0.25
per million Cursor Token Rate that Teams and Enterprise plans add to
third-party (not Composer) requests.

## Manual overrides

Cost components models.dev doesn't carry are encoded in
`MANUAL_PRICING_OVERRIDES` inside `src/be/seed-pricing.ts`:

| Provider         | Model | Token class    | Rate                 | Source                                                                         | Verified   |
|------------------|-------|----------------|----------------------|---------------------------------------------------------------------------------|------------|
| `claude`         | `*`   | `web_search`   | $10 / 1,000 requests | <https://docs.claude.com/en/docs/about-claude/pricing>                         | 2026-08-06 |
| `claude-managed` | `*`   | `web_search`   | $10 / 1,000 requests | <https://docs.claude.com/en/docs/about-claude/pricing>                         | 2026-08-06 |
| `claude-managed` | `*`   | `runtime_hour` | $0.08 / hour         | <https://docs.claude.com/en/api/agent-sdk/managed-runtime#pricing>             | 2026-04-28 |
| `devin`          | `*`   | `acu`          | $2.25 / ACU          | <https://devin.ai/pricing>                                                      | 2026-04-28 |

The `pricePerMillionUsd` column carries these as `rate * 1_000_000` so the
same schema fits — the adapter scales by the underlying unit (hours / ACUs /
requests), not by tokens. `web_search` stores $0.01/request as
`pricePerMillionUsd = 10_000` (USD per million requests). The unit convention
is specific to those `token_class` values.

Unlike token rates — where a missing rate marks the whole row
`costSource='unpriced'` — a missing `web_search` rate prices searches at $0.
That asymmetry is deliberate (a small request fee shouldn't unprice an entire
session) and is documented in the cost-and-context-computation guide.

## Attribution reporting contract

Usage reporting keeps total spend separate from the cost population that can
truthfully carry a human requester:

- `attributableCostUsd` is total cost minus structurally human-free work;
  coverage is `attributedCostUsd / attributableCostUsd`.
- `excludedCostUsd` and `excludedTaskCount` retain visibility into the removed
  population. A stale requester id on structurally human-free work does not put
  that cost back into either side of the coverage ratio.
- Human-free seeds are the `heartbeat`, `heartbeat-checklist`, and
  `boot-triage` task types; legacy JSON tag rows matched by the `heartbeat`
  tags `LIKE` check; creatorless schedules (including their workflow roots);
  and requester-less system follow-ups of requester-less parents.
- The classification propagates through requester-less descendants. An
  explicitly attributed child is a human handoff and stops propagation down
  that branch.

The per-person report uses the same requester data model without grouping the
cost denominator or turning it into a leaderboard. Human-requested root tasks
determine Problems Initiated and Problems Shipped; their full task trees
determine Agents, Repos, and Surfaces Reached. Requester-less autonomous roots
and heartbeat-classified roots are omitted, and the metrics remain separate.

## Provider pricing caveats

- **Claude Sonnet 5 standard rate:** Anthropic's pricing page lists $2/M input
  and $10/M output as the standard rate. Anthropic cancelled the previously
  scheduled increase to $3/M input and $15/M output on 2026-09-01. Claude
  Code's bundled local rate table may be stale-high, so treat its reported USD
  as advisory and use the server-recomputed row for the canonical total.
- **GPT-5.6 context tier:** above 272k context, the GPT-5.6 family bills
  2× input/cache rates and 1.5× output rates. The current recompute receives
  aggregate session token counts, not enough per-request context information
  to attribute that tier. It can therefore under-count sessions containing
  over-272k requests; this is a documented bound, not a tier-aware
  implementation. Per-turn context/usage accumulation is needed before that
  can be fixed accurately.
- **Codex worker fallback:** `FALLBACK_CODEX_MODEL_PRICING` in
  `src/providers/codex-models.ts` is advisory only. The canonical price is the
  server-side recompute against the runtime-refreshed pricing table;
  `agentswarm.cost.drift.usd` watches for divergence between the two.
- **Codex usage:** the app-server reports cumulative token counters, including cache writes.
  The adapter calculates each turn's delta before adding it to the session total.
  This prevents repeated billing of earlier turns when the adapter processes queued input.
  Context occupancy is separate: it comes from the per-request `tokenUsage.last`
  snapshot (and `modelContextWindow` when present), never from the turn delta.
- **Claude breakdown validity is all-or-nothing:** the claude adapter drops the
  entire `modelUsage` breakdown when any entry carries a missing, non-finite,
  or negative token counter — zero-filling would let the server price a
  fabricated $0 `pricing-table` row, and a partial list would undercount.
  Such sessions are priced from top-level usage (main-thread only) instead of
  per-model sums; the harness total is preserved in `harnessCostUsd`, so the
  divergence surfaces in `agentswarm.cost.drift.usd`. Advisory fields
  (`webSearchRequests`, per-model `costUSD`) degrade per-field without
  invalidating the entry.

- **ACP usage:** optional `session/prompt` response usage supplies `inputTokens`,
  `outputTokens`, `cachedReadTokens`, and `cachedWriteTokens`. The adapter maps
  those counters directly; absent counters remain `undefined` only at the adapter
  boundary. The session-cost API and DB coalesce missing input/output/cache
  counters to zero, so persisted costs and UI displays lose unknown-vs-zero. The scrubbed
  `acp_prompt_response` session log preserves the payload and optional `_meta`.
  Context-window `usage_update` totals are not billing token estimates.
  A target may report `usage_update.cost`, the session's cumulative cost. The
  adapter sends the latest USD amount as `totalCostUsd` and the API stores it as
  `costSource: 'harness'`. With no cost or a non-USD cost, `totalCostUsd` is 0
  and unresolved `(acp, model)` pricing identity stays `unpriced`. A target may
  fall back after rejecting the requested model, so that requested ID alone
  cannot justify a rate alias.

## When a model is missing

If `POST /api/session-costs` arrives with a `(provider, model)` pair that has
no input/output pricing rows at the lookup time, the row is persisted with
`costSource='unpriced'` (rather than 'harness'). The UI surfaces this as a
yellow badge.

To fix: first check whether the runtime refresh is failing. If the model must
also appear in the UI picker or cold-start fallback, add it to
`src/be/modelsdev-cache.json`; otherwise add a manual override row via the
existing admin route `POST /api/pricing`.
