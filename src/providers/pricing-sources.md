# Pricing sources

This page lists the sources that feed the `pricing` table at server boot.
Operators bumping a rate by hand should also update this file.

## Primary: vendored models.dev snapshot

- **Source-of-truth path**: `src/be/modelsdev-cache.json`
- **UI compatibility path**: `ui/src/lib/modelsdev-cache.json` symlinks to the
  backend snapshot so existing UI imports keep working.
- **Loaded by**: `src/be/modelsdev-cache.ts` → `src/be/seed-pricing.ts` →
  `seedPricingFromModelsDev()`,
  called from `src/server.ts` after `initDb`.
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

- **Refresh procedure** (the only place to update the snapshot):
  - Run `bun run scripts/refresh-modelsdev-pricing.ts` (Phase 2 — adds the
    script). It fetches the latest snapshot from models.dev, diffs against
    the vendored copy, prints a summary, and writes the new file.
  - Commit the regenerated `src/be/modelsdev-cache.json` together with a bump
    note in the PR description.

## Manual overrides

Two cost components models.dev doesn't carry are encoded in
`MANUAL_PRICING_OVERRIDES` inside `src/be/seed-pricing.ts`:

| Provider         | Model | Token class    | Rate         | Source                                                                         | Verified   |
|------------------|-------|----------------|--------------|---------------------------------------------------------------------------------|------------|
| `claude-managed` | `*`   | `runtime_hour` | $0.08 / hour | <https://docs.claude.com/en/api/agent-sdk/managed-runtime#pricing>             | 2026-04-28 |
| `devin`          | `*`   | `acu`          | $2.25 / ACU  | <https://devin.ai/pricing>                                                      | 2026-04-28 |

The `pricePerMillionUsd` column carries these as `rate * 1_000_000` so the
same schema fits — the adapter scales by the underlying unit (hours / ACUs),
not by tokens. The unit convention is specific to those `token_class` values.

## When a model is missing

If `POST /api/session-costs` arrives with a `(provider, model)` pair that has
no input/output pricing rows at the lookup time, the row is persisted with
`costSource='unpriced'` (rather than 'harness'). The UI surfaces this as a
yellow badge.

To fix: either add the model to `src/be/modelsdev-cache.json` (preferred — the
upstream snapshot probably needs refreshing) or add a manual override row via
the existing admin route `POST /api/pricing`.
