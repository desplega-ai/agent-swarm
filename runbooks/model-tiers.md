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
| `claude-managed` | `claude-haiku-4-5` | `claude-sonnet-4-6` | `claude-opus-4-8` | `claude-fable-5` |
| `codex` | `gpt-5.6-luna` | `gpt-5.6-terra` | `gpt-5.6-sol` | `gpt-5.6-sol` |
| `pi` | `openrouter/deepseek/deepseek-v4-flash` | `openrouter/deepseek/deepseek-v4-flash` | `openrouter/deepseek/deepseek-v4-pro` | `openrouter/anthropic/claude-opus-4.8` |
| `dsh` | `openrouter/deepseek/deepseek-v4-flash` | `openrouter/deepseek/deepseek-v4-flash` | `openrouter/deepseek/deepseek-v4-pro` | `openrouter/anthropic/claude-opus-4.8` |
| `opencode` | `openrouter/deepseek/deepseek-v4-flash` | `openrouter/deepseek/deepseek-v4-flash` | `openrouter/deepseek/deepseek-v4-pro` | `openrouter/anthropic/claude-opus-4.8` |
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

The defaults stay concrete ids and CLI aliases. Seeding `claude` `smart`/`ultra` and `codex` `regular`/`smart` as `latest:...@stable` waits for phase 4 of the model-catalog plan: until `harness_model_support` exists, the server cannot tell whether the pinned `claude`/`codex` CLI in the worker image accepts the newest catalog model, so an alias could move a whole tier onto a model the CLI rejects. Operators can opt in per tier today with `MODEL_TIER_<PROVIDER>_<TIER>`.

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

It writes `resolvedModel`, `modelSource` and `modelAlias` (the `latest:` alias, when any) on `agent_tasks` and returns them on the trigger. A task with neither `model` nor `modelTier` records nothing. `fallback:cli-unsupported` is reserved for phase 4.

The worker still runs `resolveTaskModelSelection` locally. When the server sent a `resolvedModel`, the worker uses it; if its local result differs (for example a stale override sent before a restart, or a tier-config value the worker does not read), it logs `model resolution mismatch ... using server value`. Without a server value (older API) the worker keeps the local order: task `model`, `modelTier` with its env overrides, `MODEL_OVERRIDE`, then the adapter default.

This is deliberate: pool claims, delegations, workflow fan-out, and schedules resolve against the worker that actually runs the task, not the agent or API process that created it. Schedules and workflow steps store only `model`/`modelTier`; each spawned task records its own resolution.
