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
  - OpenRouter models → rows under `provider='opencode'`. Any `google/...`
    row additionally gets projected under `provider='gemini'` (both the
    stripped name and the full `google/...` id) so internal-ai callers find
    a hit either way.

- **Snapshot refresh procedure**:
  - Run `bun run scripts/refresh-modelsdev-pricing.ts` (Phase 2 — adds the
    script). It fetches the latest snapshot from models.dev, diffs against
    the vendored copy, prints a summary, and writes the new file.
  - Commit the regenerated `src/be/modelsdev-cache.json` together with a bump
    note in the PR description. This is no longer the pricing freshness path;
    use it when the fallback/UI catalog needs new labels or context-window data.

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

## Provider pricing caveats

- **Claude Sonnet 5 introductory rate:** Anthropic's pricing page lists
  $2/M input and $10/M output through 2026-08-31. The models.dev snapshot and
  server pricing table carry that introductory rate. Claude Code's bundled
  local rate table is stale-high, so treat its reported USD as advisory and
  use the server-recomputed row for the canonical total.
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

## When a model is missing

If `POST /api/session-costs` arrives with a `(provider, model)` pair that has
no input/output pricing rows at the lookup time, the row is persisted with
`costSource='unpriced'` (rather than 'harness'). The UI surfaces this as a
yellow badge.

To fix: first check whether the runtime refresh is failing. If the model must
also appear in the UI picker or cold-start fallback, add it to
`src/be/modelsdev-cache.json`; otherwise add a manual override row via the
existing admin route `POST /api/pricing`.
