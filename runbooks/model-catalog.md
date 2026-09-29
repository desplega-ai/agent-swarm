# Model catalog: how a new model reaches tasks

A model released for Claude Code or Codex becomes usable by tasks with no code change and no redeploy. This runbook covers the flow. Tier resolution details live in [model-tiers.md](./model-tiers.md).

## Pieces

| Piece | Where | Role |
|---|---|---|
| `model_catalog` | SQLite, migration `177` | models.dev facts per provider and model: family, release date, context window, max output, reasoning efforts, pricing. |
| `model_catalog_overlay` | SQLite, migration `177` | Hand-verified rows for models models.dev lacks or has incomplete. Overlay wins over models.dev. A row with `expiresWhenUpstreamMatches` is dropped once models.dev agrees. |
| Catalog refresh | `src/be/pricing-refresh.ts` | Boot plus every 12h, and on demand. ETag-aware. Upserts `model_catalog`; pricing rows follow it. |
| Forced refresh | `POST /api/models-catalog/refresh { force }`, MCP `model-catalog-refresh` | Same as `pi update --models`. Lead agent or operator only (`models.catalog.write`); dashboard users are excluded until a UI needs it. A forced call is accepted once per minute; a second one inside that window returns `skipped-cooldown` with `retryAfterMs`. Concurrent refreshes share one fetch. |
| Overlay write | `PUT`/`DELETE /api/models-catalog/overlay`, MCP `model-catalog-overlay-upsert` | Used by the verify task when models.dev lags. Same access as the forced refresh. |
| Harness support write | `PUT /api/models-catalog/harness-support` | Workers record whether their pinned CLI version accepts a model (`models.harness-support.write`, registered agents and the operator only). An agent, the lead included, can only write the row for its own harness and the CLI version it registered; the operator can write any tuple, as the admin correction path. Dashboard users are denied. An `X-Agent-ID` always wins over the shared API key, so a worker never acts as the operator. |
| Shared resolver | `packages/model-catalog` | Overlay merge, family parsing, `latest:` grammar, soak and preview rules. Used by the API, workers, the UI and evals. |
| `harness_model_support` | SQLite, migration `177` | Whether a model runs on a given `claude`/`codex` CLI version. Workers report their CLI version on register and the outcome of a model's first run. |

Offline or with an empty table, every reader falls back to the committed `src/be/modelsdev-cache.json` snapshot.

## What reads the catalog

Model pickers, codex and Claude model lists, context windows, pricing, reasoning efforts, Claude shortnames (`opus` → newest Opus id) and `latest:` tier aliases. Workers keep a TTL-cached copy fetched from the API, so a model added after a worker booted is visible on its next poll.

## Flow when `model-release-watch` sees a new model

1. Call `model-catalog-refresh` with `force: true` for the vendor. If models.dev has the model with price, context window and reasoning efforts, it is now usable: an explicit task `model`, or a tier set to a `latest:` alias, picks it on the next claim.
2. If the refreshed catalog lacks the model or a required fact, dispatch one verify task per vendor. It checks the vendor's docs (positive control: a known model id must be found on the same page; check the deprecations page) and writes an overlay row with `model-catalog-overlay-upsert`. No repo, no PR.
3. If the first real run fails with the CLI's unknown-model error, `harness_model_support` records `unsupported` for that CLI version. Anything that came from an alias or a tier (an explicit `latest:` alias, a tier value, a tier default) falls back to the newest model of the family the CLI has not rejected (`modelSource = fallback:cli-unsupported`, one notification). Only a concrete id a task pinned fails fast at claim. The fix is a CLI bump in `Dockerfile.worker` (`CLAUDE_CODE_VERSION` / `CODEX_VERSION`), the one code change left per model. Automating that bump is deferred.

The watcher script and its verify brief live in the scripts catalog, not in this repo. Switch it to this flow only after the catalog, tier and CLI-support changes are deployed; until then it keeps dispatching the per-model code briefs. The old per-model `anthropic-models-version-monitor` schedule is retired at the same time.

## Checks

- Catalog content: `GET /api/models-catalog`.
- What each tier resolves to now, per provider: `GET /api/models-catalog/tiers`. The dashboard Configuration page reads it for the `MODEL_TIER_*` rows. Read-only, so previewing never records an alias resolution.
- Why a task ran a model: `agent_tasks.resolvedModel`, `modelSource`, `modelAlias`. The task detail page and the tasks table show them.
- Alias moves: `model_alias_resolutions`.
