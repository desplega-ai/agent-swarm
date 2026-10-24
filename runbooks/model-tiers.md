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

The canonical schema lives in `src/types.ts` as `ModelTierSchema`.

## Default mappings

Each harness/provider maps the same tier to its own concrete model:

| Harness provider | `smol` | `regular` | `smart` | `ultra` |
| --- | --- | --- | --- | --- |
| `claude` | `haiku` | `sonnet` | `opus` | `fable` |
| `claude-managed` | `claude-haiku-4-5` | `claude-sonnet-5` | `claude-opus-4-8` | `claude-fable-5` |
| `codex` | `gpt-5.6-luna` | `gpt-5.6-terra` | `gpt-5.6-sol` | `gpt-5.6-sol` |
| `pi` | `openrouter/deepseek/deepseek-v4.1-flash` | `openrouter/deepseek/deepseek-v4.1-flash` | `openrouter/deepseek/deepseek-v4-pro-0813` | `openrouter/anthropic/claude-opus-5.5` |
| `dsh` | `openrouter/deepseek/deepseek-v4.1-flash` | `openrouter/deepseek/deepseek-v4.1-flash` | `openrouter/deepseek/deepseek-v4-pro-0813` | `openrouter/anthropic/claude-opus-5.5` |
| `amp` | `low` | `medium` | `high` | `ultra` |
| `opencode` | `openrouter/deepseek/deepseek-v4.1-flash` | `openrouter/deepseek/deepseek-v4.1-flash` | `openrouter/deepseek/deepseek-v4-pro-0813` | `openrouter/anthropic/claude-opus-5.5` |
| `cursor` | `gpt-5.4-mini` | `claude-sonnet-5-5` | `claude-opus-5-5` | `claude-fable-5-1` |
| `grok` | `grok-build-0.1` | `grok-4.3` | `grok-4.6` | `grok-4.7` |
| `devin` | `devin` | `devin` | `devin` | `devin` |

Update `DEFAULT_MODEL_TIER_MAP` and this table together when defaults change.

### NaN- or Helmcode-only swarms

The `pi` and `opencode` defaults are `openrouter/...` models. A worker whose only LLM credential is a NaN or Helmcode key defaults to `pi`, but a `modelTier` task still resolves to the OpenRouter default and fails because `OPENROUTER_API_KEY` is missing. Set the tier config keys for both harnesses to models the key can run, for example:

```
MODEL_TIER_PI_SMOL=nan/glm5.3-flash
MODEL_TIER_PI_REGULAR=nan/glm5.3-flash
MODEL_TIER_PI_SMART=nan/qwen3.6
MODEL_TIER_PI_ULTRA=nan/qwen3.6
MODEL_TIER_OPENCODE_SMOL=nan/glm5.3-flash
MODEL_TIER_OPENCODE_REGULAR=nan/glm5.3-flash
MODEL_TIER_OPENCODE_SMART=nan/qwen3.6
MODEL_TIER_OPENCODE_ULTRA=nan/qwen3.6
```

For Helmcode, use `helmcode/<id>` values (`helmcode/glm5.3-flash`, `helmcode/deepseek-v4-flash`, ...). `latest:` aliases cannot target these providers, so the values must be concrete ids. A task with neither `model` nor `modelTier` runs the agent's `MODEL_OVERRIDE`, so set that to a `nan/` or `helmcode/` model as well.

## Overrides

Three layers can override the defaults. From highest to lowest:

1. **Worker env.** `MODEL_TIER_<TIER>` (for example `MODEL_TIER_SMART=gpt-5.6-sol`) or `MODEL_TIER_MAP` (JSON with tier keys, for example `{"smol":"gpt-5.6-luna","smart":"gpt-5.6-sol"}`) in the worker's own process env. Direct `MODEL_TIER_<TIER>` wins over `MODEL_TIER_MAP`. The worker sends the parsed values (`{provider: {tier: model}}`, values only) on register (`modelTierOverrides` body field) and on every poll (`X-Model-Tier-Overrides` header, URL-encoded JSON). The server stores them on `agents.modelTierOverrides`.
2. **Tier config.** Global `swarm_config` keys `MODEL_TIER_<PROVIDER>_<TIER>`, for example `MODEL_TIER_CLAUDE_SMART` or `MODEL_TIER_CLAUDE_MANAGED_ULTRA` (dashes become underscores). Settings → Configuration → Harness lists the `claude` and `codex` keys. The value is validated on write (`src/be/model-tier-keys.ts`).
3. **Built-in defaults.** `DEFAULT_MODEL_TIER_MAP`, the table above.

Any layer (and a task's `model`) may hold:

- a concrete model id (`claude-opus-5-5`, `gpt-5.6-sol`, `openrouter/deepseek/deepseek-v4-pro`),
- a CLI alias the harness resolves itself (`opus`, `sonnet`),
- a moving alias `latest:<anthropic|openai|openrouter>/<target>[@stable|@any]`, resolved by the server against the `model_catalog` table (plus overlay; the vendored snapshot when the table is empty). Grammar: `packages/model-catalog/src/resolve-alias.ts`. There is no `latest:` form for `nan` or `helmcode` models.

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

`model`/`modelTier`/`profile` only apply to schedules with `targetType: 'agent-task'` (the
default) — a `workflow`- or `script`-targeted schedule triggers directly with no
agent in the loop, so these fields are ignored for those targets.

Tasks, schedules, and workflow `agent-task` nodes store these optional fields:

- `profile`: a named harness + model + effort (preferred; see [Model profiles](#model-profiles)). Exclusive with the other two.
- `model`: concrete provider/harness-specific override.
- `modelTier`: portable tier intent. Deprecated: pass `profile: "<harness>-<tier>"` for the same model.

The API server resolves the model when a worker claims the task (`/api/poll`, both the directly-assigned and the pool-claim path; `src/be/model-tier-resolution.ts`), in this order:

1. `task.model` → `modelSource = model`.
2. `task.profile` → `profile:task` (see [Model profiles](#model-profiles)).
3. The claiming worker's env override for its harness provider (`agents.modelTierOverrides`) → `worker-env`. Deprecated: logs `[model-tier] deprecated: worker-env override for <h>-<t>; edit profile <h>-<t> instead`.
4. `swarm_config` `MODEL_TIER_<PROVIDER>_<TIER>` → `tier-config`. Deprecated, with the same log line.
5. The seeded `<harness>-<tier>` profile → `profile:tier-alias` (see [Model profiles](#model-profiles)); `DEFAULT_MODEL_TIER_MAP` → `tier-default` when that profile is missing or does not apply.
6. With no `model`, `profile` or `modelTier`: the claiming agent's default profile → `profile:agent-default`.

Each layer's value is judged against the claiming worker's harness (see [Harness compatibility](#harness-compatibility)). A worker-env, tier-config or tier-default value that does not run on the harness is skipped with the log line `[model-tiers] <source> value <value> does not run on <harness>; trying next layer`. A task `model` that does not run on it is not skipped: the claim returns `modelUnsupported` with a `[model-harness-mismatch]` reason and the worker fails the task without starting a CLI.

It writes `resolvedModel`, `modelSource` and `modelAlias` (the `latest:` alias, when any) on `agent_tasks` and returns them on the trigger. A profile also writes `resolvedProfile`. A task with no `model`, `modelTier` or applicable profile records nothing. `modelSource = fallback:cli-unsupported` means the claiming worker's CLI version rejected the model an alias or a tier resolved to, so the newest model of the same family that the CLI has not rejected ran instead (`modelAlias` keeps the alias). An explicit `model: "latest:..."` counts as an alias and falls back the same way, recorded as `modelSource = fallback:cli-unsupported:model` so a resume can tell the task's own alias (a pin it carries) from a tier's. Only a concrete id the task pinned (`model: "claude-opus-5-5"`) fails fast. A tier default that is a Claude CLI shortname (`opus`) is family-matched: if the CLI rejected `opus` itself it falls back to the newest usable `claude-opus-*`; if only a catalog id was rejected, `opus` stays, because the CLI resolves its own shortname. With no usable sibling the resolution stays and the run reports the CLI's error (see `runbooks/model-catalog.md`).

`GET /api/models-catalog/tiers` previews layers 3 and 4 for every provider and tier, with `latest:` aliases resolved against the current catalog and without recording a resolution. It ignores per-worker overrides and per-task models. The dashboard Configuration page uses it for the `MODEL_TIER_*` rows.

A claim reads the task's own pin (`taskModelPin` in `src/tasks/model-pin.ts`), not the `model` column: the session report overwrites `model` with the model that ran, so a row claimed again (or a paused task resumed after a restart) would otherwise replay its previous run's model over the agent's current `MODEL_OVERRIDE`. Without a pin the trigger carries no `model`, and a claim that resolves nothing clears the previous run's `resolvedModel`, `modelSource`, `modelAlias` and `resolvedProfile`. A `profile:*` source is not a pin, so a re-claim resolves the profile again.

The session report also records `resolvedEffort`: the reasoning effort the session ran at (task `effort`, else the agent's `REASONING_EFFORT_OVERRIDE`, null when the harness or model cannot take it). `effort` stays the requested value.

The worker still runs `resolveTaskModelSelection` locally. When the server sent a `resolvedModel`, the worker uses it; if its local result differs (for example a stale override sent before a restart, or a tier-config value the worker does not read), it logs `model resolution mismatch ... using server value`. Without a server value (older API) the worker keeps the local order: task `model`, `modelTier` with its env overrides, `MODEL_OVERRIDE`, then the adapter default.

This is deliberate: pool claims, delegations, workflow fan-out, and schedules resolve against the worker that actually runs the task, not the agent or API process that created it. Schedules and workflow steps store only `profile`/`model`/`modelTier`; each spawned task records its own resolution.

## Model profiles

A model profile is a named harness, model and effort (`model_profiles`, `src/be/db/model-profiles.ts`). Lead picks one per task with `send-task profile=<name>`; an agent can hold one as its default. Claim stamps the profile on the task.

- **Seeds.** Every boot inserts one `<harness>-<tier>` profile per harness and tier that `DEFAULT_MODEL_TIER_MAP` maps (`src/be/seed-model-profiles.ts`). The model is the global `MODEL_TIER_<HARNESS>_<TIER>` row when one exists, else the map's value; effort is null. An existing name is never overwritten, so an operator's edit survives. `seededFrom = tier:<tier>`.
- **From agent overrides.** Migration `220` turns each agent's `MODEL_OVERRIDE` (plus `REASONING_EFFORT_OVERRIDE`) into a profile named `<harness>-<model>[-<effort>]` (`seededFrom = agent-config`) and makes it that agent's default. Claim then supplies the model and effort the worker read from its env before. A row with `exportToEnv = 0` never reached the worker, so it is not carried over: a withheld model makes no default, a withheld effort leaves the profile's effort empty. ACP agents and `latest:` overrides are skipped and keep `MODEL_OVERRIDE`.
- **Agent default.** `PATCH /api/agents/{id}/runtime { profile }` stores the name as agent-scoped `MODEL_PROFILE` with `exportToEnv = 0`; workers never read it. The profile must exist and run on the agent's `harness_provider`. `profile: null` clears it. Sending `model`, or changing what `MODEL_OVERRIDE` or `REASONING_EFFORT_OVERRIDE` does to the worker env (its value, its `exportToEnv`, or deleting it) by any path, also clears it, so a stale default never beats a fresh override. The default applies only to a task with no `model`, `profile` or `modelTier`; a default for another harness is ignored. It is agent-scoped config, so a repo-scoped override on the task's `vcsRepo` still wins on its axis (repo > agent): a repo `MODEL_OVERRIDE` row skips the default, and a repo `REASONING_EFFORT_OVERRIDE` row keeps the profile's effort off the trigger. A task's own `profile` beats repo config.
- **Claim.** A task's own profile that is missing, on another harness, or a `latest:` alias that resolves to nothing returns `modelUnsupported` (`[model-profile-missing]`, `[model-harness-mismatch]`, `[model-profile-unresolved]`) and the worker fails the task without a spawn. The CLI-version check still swaps the model on an unsupported CLI but keeps the `profile:*` source. The profile's effort goes on the trigger only when the task set no `effort`. Pool claims skip a task whose profile runs on another harness, and the poll scan and automatic pool routing skip a worker that fails the task's profile check. A paused task's recovery re-reads its profile's allowlist from `GET /api/paused-tasks`.
- **OpenAI-compatible providers.** A profile's `harness` is always the harness that runs it, never the provider. NaN, Helmcode and Vercel AI Gateway models are ordinary `pi` / `opencode` profiles with the provider-qualified catalog id as `model` (`nan/glm5.3`, `helmcode/deepseek-v4-flash`, `vercel/anthropic/claude-sonnet-4.6`), validated by the same catalog and harness checks as a raw `model`. Claim hands that id to the worker as `resolvedModel`, and the worker picks the provider's key (`NAN_API_KEY`, `HELMCODE_API_KEY`, `AI_GATEWAY_API_KEY`) from it. Migration `220` names a converted override by flattening the id: `pi-vercel-anthropic-claude-sonnet-4.6-medium`.
- **Tier alias.** `modelTier` is an alias for the seeded `<harness>-<tier>` profile. Where the tier chain lands on `tier-default`, claim resolves that profile instead: `modelSource = profile:tier-alias`, `resolvedProfile = <harness>-<tier>`, and its credential allowlist on the trigger. The seeds copy the tier map, so the model is the same unless an operator edited the seed. A `worker-env` or `tier-config` override still wins. A missing or unresolved seed keeps the `tier-default` result, and so does a seed whose model does not run on the harness (a stale global `MODEL_TIER_*` row the seeder copied), as the tier chain skips that value. A tier still beats the agent default. `send-task`, `task-action` create and `create-schedule` / `update-schedule` / `patch-schedule` return `modelTierDeprecated: { tier, suggestedProfile }` and a nudge when the input carries `modelTier` (`suggestedProfile` is null for a pool task or a harness with no seed).
- **Validation where a profile is written.** `send-task`, `POST /api/tasks`, schedules (`POST`/`PUT`/`PATCH /api/schedules`, `create-schedule` / `update-schedule` / `patch-schedule`) and workflow `agent-task` nodes reject an unknown profile, and, when the target agent is known, a profile that fails `checkProfileForAgent` (HTTP 400, tool error). The check reads the task's `vcsRepo` config over the agent's (repo > agent), the pool the worker loads. `profile` cannot be combined with `model` or `modelTier`. A schedule update that sets `profile` clears `model` and `modelTier`, and one that sets `model` or `modelTier` clears `profile`; moving a profiled schedule to another agent re-runs the check. A schedule's profile blocks its deletion (409, migration `240` triggers). Workflow saves judge a static `profile` (and a static `agentId`), including a `foreach` body, and an update that only moves the workflow to another `vcsRepo` judges the stored definition against that repo; the node re-checks the interpolated value at run and fails with the check's message. Workflow JSON has no reference guard: deleting a profile a definition names fails that node at run.
- **Resume.** A task's own `profile` travels to its resume like `modelTier`. An agent default (`resolvedProfile` only) does not; the child's claim resolves it again.
- **API.** `GET /api/model-profiles` and `GET /api/model-profiles/{name}` are open to any caller; `list-model-profiles` is the tool. `POST`, `PATCH` and `DELETE` need `models.profiles.write` (operator only: profiles are shared, so a dashboard user or agent editing one would change what other people's queued tasks run). A profile's `effort` must be a level the harness and model accept (`supportedReasoningLevels`), including one with no transport effect such as Opencode `off`. Delete is a 409 for a `<harness>-<tier>` seed, and while an agent's default names the profile or a task holds it, as its `profile` or as its `resolvedProfile` (a paused task's resume re-reads that profile's credential allowlist): unfinished, or superseded and still owed its resume (the resume copies the profile in a later write, or the heartbeat's orphan repair makes it after a restart, within 24 hours). Each reference check and its write are one statement, so a create and a delete cannot both win a race: Migration `220`'s triggers refuse a task or agent default naming a missing profile (400 at the API), and the DELETE itself skips a profile still named (409).

Not yet: fallbacks and a dashboard editor. `modelTier` is not rejected yet; the two-release clock starts when the editor ships.

## Explicit model ids are checked

A task, schedule, workflow `agent-task` node or agent runtime `model` must be in the catalog: a catalog id (bare or provider-qualified), a Claude CLI shortname, or a `latest:` alias that resolves. Anything else is rejected where it is written (HTTP 400, tool error, failed node) with a message that names the escape hatch. Escape hatch: `allowCustomModel: true` on `POST /api/tasks`, `send-task`, `task-action` create, `create-schedule`/`update-schedule`/`patch-schedule`, `POST`/`PUT /api/schedules`, the workflow node config, and `allow_custom_model` on `PATCH /api/agents/{id}/runtime`. A custom id is stored as given. Skipped without the flag when the caller names an `acp`, `devin` or `dsh` harness (the catalog does not describe their models). A schedule that already stores a model can be re-saved with it. Claim time does not re-check catalog membership; it re-checks harness compatibility (below). An agent's default model (`MODEL_OVERRIDE`) cannot be a `latest:` alias: put the alias on a task or in a `MODEL_TIER_*` value.

### Harness compatibility

A concrete `model` or `latest:` alias must also run on the harness that will run it. The rule lives in one pure function, `harnessModelMismatch` in `packages/model-catalog/src/harness-models.ts` (re-exported as `harnessModelError` from `src/be/model-validation.ts`). It uses the per-harness catalog rules the harness model lists already use; there is no second list.

| Harness | Catalog section | Accepted `model` values | Accepted `latest:` kinds |
| --- | --- | --- | --- |
| `claude` | `anthropic` | an `anthropic` id that passes `isHarnessCatalogModel("claude", id)`, a Claude CLI shortname (`opus`, `sonnet`, ...), an optional `[1m]` suffix | `latest:anthropic/...` |
| `claude-managed` | `anthropic` | same as `claude` | `latest:anthropic/...` |
| `codex` | `openai` | an `openai` id that passes `isHarnessCatalogModel("codex", id)` | `latest:openai/...` |
| `grok` | `xai` | a `grok-*` or `xai` id, bare or `xai/`-qualified (the adapter drops the prefix; the API catalog has no `xai` section, so `xai/<id>` needs `allowCustomModel`), or `openrouter/<vendor>/<id>`; another vendor's catalog id or namespace is refused | `latest:openrouter/...` |
| `pi`, `opencode` | none pinned | any catalog model, bare or provider-qualified, including `nan/<id>` and `helmcode/<id>` | any |
| `dsh`, `cursor`, `devin`, `acp` | free-form | any string | any |
| `amp` | none (`src/utils/amp-models.ts`) | a mode (`low`, `medium`, `high`, `ultra`) or a `provider/model` pin (for example `openai/gpt-5-nano`) | none |

A provider-qualified id on a pinned harness must name the harness section: `anthropic/claude-opus-5-5` runs on `claude`, `openrouter/anthropic/claude-opus-5.5` does not. Likewise `nan/<id>` and `helmcode/<id>` run only on `pi` and `opencode`; `claude` and `codex` reject them with the mismatch message below. An id the catalog does not know in any section passes this check (the catalog membership check above decides it). This includes an uncatalogued id in the harness's own namespace: `openai/private-deployment-1` on `codex` passes with `allowCustomModel` and fails without it. A known id that the harness does not run (`openai/gpt-4o` on `codex`) fails even with the flag. A bare shortname such as `opus` on `codex` therefore passes; legacy shortnames become `modelTier` before any create-time check anyway, and `modelTier` is never rejected.

Where the rule applies:

- **Directed task, schedule, workflow node** (the assignee is known): rejected at the write with `Model "<model>" does not run on the <harness> harness of agent "<name>" (<id>). The <harness> harness accepts <section> catalog models, for example: ... Use modelTier ...`. `send-task` judges the parent auto-route target. A schedule whose `targetAgentId` changes re-judges its stored model against the new agent. A workflow save judges `agent-task` nodes (and `foreach` bodies) that set both `model` and `agentId`; the executor judges again at run time.
- **Pool task** (no assignee): a concrete `model` is accepted only if at least one registered, non-extension agent runs a harness that accepts it; else `Model "<model>" does not run on any registered agent harness (<harnesses>)`. With no registered agents the check passes. At claim, `/api/poll` and the heartbeat auto-assign skip a worker whose harness cannot run the model, so a compatible worker takes the task. The starvation escalation counts only compatible agents as eligible.
- **Claim backstop**: every claim re-judges the model (tasks created before the guard, reassigned tasks, schedules whose agent changed harness). A pinned task `model` fails fast with `[model-harness-mismatch] Model "<model>" does not run on the <harness> harness of this worker. ...`. The tag is deterministic and is not `[auth-error]`, so failure triage can keep it out of the Codex pool auth signal. No CLI runs, so no `harness_model_support` row is written.
- **Worker spawn**: the worker judges the final model against its own harness with the runtime catalog. An agent-scope `MODEL_OVERRIDE` from another family is dropped with `[<role>] MODEL_OVERRIDE <model> does not run on the <harness> harness; using the adapter default`. A task model from another family (an older API that sent no `modelUnsupported`) fails the task with the `[model-harness-mismatch]` reason before any spawn. When a worker re-registers with a new harness and its `MODEL_OVERRIDE` does not run on it, the API logs one warning and keeps the row for a human to fix.
- **Tier config**: a `MODEL_TIER_<PROVIDER>_<TIER>` value that does not run on the key's provider is rejected on write: `Invalid <key>: model "<value>" does not run on the <provider> harness.` Worker env tier overrides are not judged at register; the claim skips them.
- **`allowCustomModel` limit**: the flag skips the catalog membership check only. It does not let a model the catalog files under another harness family through (`claude-opus-5-5` on `codex` is refused even with the flag), because the flag means "the catalog does not know this id yet".

## Effort levels

The levels an effort picker offers are the levels the API accepts and the harness applies, for one (harness, model): `reasoningLevelsFor` in `packages/model-catalog/src/reasoning.ts`, fed by the catalog's `reasoning` and `reasoning_options`. Claude CLI shortnames resolve to the newest model of their family first, so the tier defaults (`opus`) take effort like `claude-opus-5-5`. A model the catalog lacks, or a non-reasoning model, takes none.
