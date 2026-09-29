# Model Tiers

Model tiers let task authors express portable model intent without binding a task to one provider's model names. Use them when a task, schedule, or workflow should keep the same cost/capability intent across agents with different harnesses.

## Tier enum

The supported tiers are:

| Tier | Intent |
| --- | --- |
| `smol` | Cheapest/smallest capable model for routine work |
| `regular` | Default balanced model |
| `smart` | Higher-capability model for harder work |
| `ultra` | Highest-capability model for rare expensive work |

The canonical schema lives in `src/model-tiers.ts` as `ModelTierSchema`.

## Default mappings

Each harness/provider maps the same tier to its own concrete model:

| Harness provider | `smol` | `regular` | `smart` | `ultra` |
| --- | --- | --- | --- | --- |
| `claude` | `haiku` | `sonnet` | `opus` | `fable` |
| `claude-managed` | `claude-haiku-4-5` | `claude-sonnet-5` | `claude-opus-4-8` | `claude-fable-5` |
| `codex` | `gpt-5.6-luna` | `gpt-5.6-terra` | `gpt-5.6-sol` | `gpt-5.6-sol` |
| `pi` | `openrouter/deepseek/deepseek-v4.1-flash` | `openrouter/deepseek/deepseek-v4.1-flash` | `openrouter/deepseek/deepseek-v4-pro-0813` | `openrouter/anthropic/claude-opus-5.5` |
| `dsh` | `openrouter/deepseek/deepseek-v4.1-flash` | `openrouter/deepseek/deepseek-v4.1-flash` | `openrouter/deepseek/deepseek-v4-pro-0813` | `openrouter/anthropic/claude-opus-5.5` |
| `opencode` | `openrouter/deepseek/deepseek-v4.1-flash` | `openrouter/deepseek/deepseek-v4.1-flash` | `openrouter/deepseek/deepseek-v4-pro-0813` | `openrouter/anthropic/claude-opus-5.5` |
| `devin` | `devin` | `devin` | `devin` | `devin` |

Update `DEFAULT_MODEL_TIER_MAP` and this table together when defaults change.

## Overrides

Three layers can override the defaults. From highest to lowest:

1. **Worker env.** `MODEL_TIER_<TIER>` (for example `MODEL_TIER_SMART=gpt-5.6-sol`) or `MODEL_TIER_MAP` (JSON with tier keys, for example `{"smol":"gpt-5.6-luna","smart":"gpt-5.6-sol"}`) in the worker's own process env. Direct `MODEL_TIER_<TIER>` wins over `MODEL_TIER_MAP`. The worker sends the parsed values (`{provider: {tier: model}}`, values only) on register (`modelTierOverrides` body field) and on every poll (`X-Model-Tier-Overrides` header, URL-encoded JSON). The server stores them on `agents.modelTierOverrides`.
2. **Tier config.** Global `swarm_config` keys `MODEL_TIER_<PROVIDER>_<TIER>`, for example `MODEL_TIER_CLAUDE_SMART` or `MODEL_TIER_CLAUDE_MANAGED_ULTRA` (dashes become underscores). Settings → Configuration → Harness lists the `claude` and `codex` keys. The value is validated on write (`src/be/model-tier-keys.ts`).
3. **Built-in defaults.** `DEFAULT_MODEL_TIER_MAP`, the table above.

Any layer (and a task's `model`) may hold:

- a concrete model id (`claude-opus-5-5`, `gpt-5.6-sol`, `openrouter/deepseek/deepseek-v4-pro`),
- a CLI alias the harness resolves itself (`opus`, `sonnet`),
- a moving alias `latest:<anthropic|openai|openrouter>/<target>[@stable|@any]`, resolved by the server against the `model_catalog` table (plus overlay; the vendored snapshot when the table is empty). Grammar: `packages/model-catalog/src/resolve-alias.ts`.

### `latest:` guardrails

- `@stable` (the default channel) skips preview/experimental ids and models released fewer than `MODEL_LATEST_SOAK_DAYS` days ago (default 2, `0` disables the soak). `@any` skips neither.
- Models without a catalog price are never picked, on either channel.
- `MODEL_AUTO_UPGRADE=false` freezes each alias at its last recorded resolution. An alias never resolved before still resolves once.
- Each time an alias resolves to a different model than last time, the server writes a `model_alias_resolutions` row (`alias`, `previousModel`, `newModel`, `changedAt`) and logs one `[model-tiers] alias ... now resolves to ...` line after commit.
- An alias that resolves to nothing (unknown family, everything filtered) falls through to the next layer.
- Rollback: one Settings write (a concrete id in `MODEL_TIER_<PROVIDER>_<TIER>`, or `MODEL_AUTO_UPGRADE=false`).

### Default seeds

The defaults stay concrete ids and CLI aliases. `harness_model_support` now guards aliases (an alias skips a model the worker's CLI rejects, see [model-catalog.md](./model-catalog.md)), so an operator can opt a tier into a moving alias with one Settings write: `MODEL_TIER_<PROVIDER>_<TIER>=latest:anthropic/opus@stable`. Shipping `latest:` as the default is a separate decision.

## Legacy aliases

Existing `haiku`, `sonnet`, `opus`, and `fable` inputs are normalized at creation/update boundaries:

| Legacy model alias | Tier |
| --- | --- |
| `haiku` | `smol` |
| `sonnet` | `regular` |
| `opus` | `smart` |
| `fable` | `ultra` |

Concrete freeform model strings stay concrete. When both `model` and `modelTier` are present, `model` is the concrete override and wins at runtime.

## Claim-time resolution

`model`/`modelTier` only apply to schedules with `targetType: 'agent-task'` (the
default) — a `workflow`- or `script`-targeted schedule triggers directly with no
agent in the loop, so these fields are ignored for those targets.

Tasks, schedules, and workflow `agent-task` nodes store both optional fields:

- `model`: concrete provider/harness-specific override.
- `modelTier`: portable tier intent.

The API server resolves the model when a worker claims the task (`/api/poll`, both the directly-assigned and the pool-claim path; `src/be/model-tier-resolution.ts`), in this order:

1. `task.model` → `modelSource = model`.
2. The claiming worker's env override for its harness provider (`agents.modelTierOverrides`) → `worker-env`.
3. `swarm_config` `MODEL_TIER_<PROVIDER>_<TIER>` → `tier-config`.
4. `DEFAULT_MODEL_TIER_MAP` → `tier-default`.

It writes `resolvedModel`, `modelSource` and `modelAlias` (the `latest:` alias, when any) on `agent_tasks` and returns them on the trigger. A task with neither `model` nor `modelTier` records nothing. `modelSource = fallback:cli-unsupported` means the claiming worker's CLI version rejected the model an alias or a tier resolved to, so the newest model of the same family that the CLI has not rejected ran instead (`modelAlias` keeps the alias). An explicit `model: "latest:..."` counts as an alias and falls back the same way. Only a concrete id the task pinned (`model: "claude-opus-5-5"`) fails fast. A tier default that is a Claude CLI shortname (`opus`) is family-matched: if the CLI rejected `opus` itself it falls back to the newest usable `claude-opus-*`; if only a catalog id was rejected, `opus` stays, because the CLI resolves its own shortname. With no usable sibling the resolution stays and the run reports the CLI's error (see `runbooks/model-catalog.md`).

`GET /api/models-catalog/tiers` previews layers 3 and 4 for every provider and tier, with `latest:` aliases resolved against the current catalog and without recording a resolution. It ignores per-worker overrides and per-task models. The dashboard Configuration page uses it for the `MODEL_TIER_*` rows.

The worker still runs `resolveTaskModelSelection` locally. When the server sent a `resolvedModel`, the worker uses it; if its local result differs (for example a stale override sent before a restart, or a tier-config value the worker does not read), it logs `model resolution mismatch ... using server value`. Without a server value (older API) the worker keeps the local order: task `model`, `modelTier` with its env overrides, `MODEL_OVERRIDE`, then the adapter default.

This is deliberate: pool claims, delegations, workflow fan-out, and schedules resolve against the worker that actually runs the task, not the agent or API process that created it. Schedules and workflow steps store only `model`/`modelTier`; each spawned task records its own resolution.

## Explicit model ids are checked

A task, schedule, workflow `agent-task` node or agent runtime `model` must be in the catalog: a catalog id (bare or provider-qualified), a Claude CLI shortname, or a `latest:` alias that resolves. Anything else is rejected where it is written (HTTP 400, tool error, failed node) with a message that names the escape hatch. Escape hatch: `allowCustomModel: true` on `POST /api/tasks`, `send-task`, `task-action` create, `create-schedule`/`update-schedule`/`patch-schedule`, `POST`/`PUT /api/schedules`, the workflow node config, and `allow_custom_model` on `PATCH /api/agents/{id}/runtime`. A custom id is stored as given. Skipped without the flag when the caller names an `acp`, `devin` or `dsh` harness (the catalog does not describe their models). A schedule that already stores a model can be re-saved with it. Claim time does not re-check. An agent's default model (`MODEL_OVERRIDE`) cannot be a `latest:` alias: put the alias on a task or in a `MODEL_TIER_*` value.

## Effort levels

The levels an effort picker offers are the levels the API accepts and the harness applies, for one (harness, model): `reasoningLevelsFor` in `packages/model-catalog/src/reasoning.ts`, fed by the catalog's `reasoning` and `reasoning_options`. Claude CLI shortnames resolve to the newest model of their family first, so the tier defaults (`opus`) take effort like `claude-opus-5-5`. A model the catalog lacks, or a non-reasoning model, takes none.
