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

The canonical schema lives in `apps/swarm/src/model-tiers.ts` as `ModelTierSchema`.

## Default mappings

Each harness/provider maps the same tier to its own concrete model:

| Harness provider | `smol` | `regular` | `smart` | `ultra` |
| --- | --- | --- | --- | --- |
| `claude` | `haiku` | `sonnet` | `opus` | `fable` |
| `claude-managed` | `claude-haiku-4-5` | `claude-sonnet-4-6` | `claude-opus-4-8` | `claude-fable-5` |
| `codex` | `gpt-5.4-mini` | `gpt-5.4` | `gpt-5.5` | `gpt-5.5` |
| `pi` | `openrouter/deepseek/deepseek-v4-flash` | `openrouter/deepseek/deepseek-v4-flash` | `openrouter/deepseek/deepseek-v4-pro` | `openrouter/anthropic/claude-opus-4.8` |
| `opencode` | `openrouter/deepseek/deepseek-v4-flash` | `openrouter/deepseek/deepseek-v4-flash` | `openrouter/deepseek/deepseek-v4-pro` | `openrouter/anthropic/claude-opus-4.8` |
| `devin` | `devin` | `devin` | `devin` | `devin` |

Update `DEFAULT_MODEL_TIER_MAP` and this table together when defaults change.

## Overrides

Tier mappings can be overridden in the claiming worker's resolved environment:

- `MODEL_TIER_<TIER>` overrides one tier, for example `MODEL_TIER_SMART=gpt-5.6`.
- `MODEL_TIER_MAP` accepts a JSON object with tier keys, for example `{"smol":"gpt-5.4-mini","smart":"gpt-5.5"}`.

Direct `MODEL_TIER_<TIER>` variables win over `MODEL_TIER_MAP`; both win over the built-in defaults.

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

Workers resolve the model at claim/spawn time in this order:

1. Use `task.model` when set.
2. Resolve `task.modelTier` with the claiming worker's `harnessProvider` and env overrides.
3. Fall back to existing agent/provider config such as `MODEL_OVERRIDE`.
4. Fall back to the adapter default.

This is deliberate: pool claims, delegations, workflow fan-out, and schedules should resolve against the worker that actually runs the task, not the agent or API process that created it.
