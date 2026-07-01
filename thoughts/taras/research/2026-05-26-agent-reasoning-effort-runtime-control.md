---
date: 2026-05-26T23:09:50+02:00
researcher: Codex
git_commit: 5d34deaf8eb6872ea450f461007ab6cc8b7a5e02
branch: main
repository: agent-swarm
topic: "Agent model reasoning/effort control across Claude, Codex, Pi, and Opencode"
tags: [research, codebase, runtime-settings, harness-providers, ui]
status: complete
autonomy: critical
last_updated: 2026-07-01
last_updated_by: Claude
refreshed_commit: 0a5384918c152c626e4f957964671a38c69ee455
---

# Research: Agent Model Reasoning/Effort Runtime Control

**Date**: 2026-05-26T23:09:50+02:00
**Researcher**: Codex
**Git Commit**: 5d34deaf8eb6872ea450f461007ab6cc8b7a5e02
**Branch**: main

**Refreshed**: 2026-07-01 against commit `0a538491` (~5 weeks and ~30+ commits after the original pass). Every file:line reference in this document has been re-verified against current `HEAD`; corrections are folded in below rather than appended as a diff. Two genuine behavior changes and one factual correction (to a claim introduced by a later, related draft plan) are called out inline where relevant — see the end of the Summary for the short version.

## Research Question

Current codebase map for offering a way to control agent model reasoning/effort for the `claude`, `codex`, `pi`, and `opencode` harnesses, including proper harness wiring and UI control.

## Summary

The repo already has an end-to-end runtime settings path for per-agent harness and model control. Desired settings are stored as `agents.harness_provider` plus agent-scoped `swarm_config` rows for `HARNESS_PROVIDER` and `MODEL_OVERRIDE`; the edit API is `PATCH /api/agents/{id}/runtime`; workers resolve those settings before launching provider sessions; the dashboard has an agent-detail runtime editor and list/detail surfaces for the latest worker-reported model. This whole shape is unchanged as of the refresh — only line numbers moved.

There is still no first-class runtime setting for reasoning or effort anywhere in the codebase — confirmed by fresh greps across `src/be/`, `src/http/`, `src/providers/`, and `src/commands/` for `reasoning_effort` / `reasoningEffort` / `REASONING_EFFORT` / `thinkingLevel` / `model_reasoning_effort`, all zero hits. Existing reasoning-related fields remain telemetry/cost-facing only: Codex captures `reasoning_output_tokens`, Claude captures thinking-token telemetry, and shared cost types expose `reasoningOutputTokens` / `thinkingTokens`.

The UI model registry still covers exactly the four local harnesses requested here (`claude`, `codex`, `pi`, `opencode`) via a harness-aware model picker. The local `modelsdev-cache.json` snapshot's `reasoning` field is a plain boolean support-gate, as previously understood — but the refresh surfaces a field that wasn't examined closely before: many models also carry a `reasoning_options` array that can enumerate actual effort levels (e.g. `{ type: "effort", values: ["none","low","medium","high","max"] }`). Neither the UI's `CachedModel` type nor this document's earlier draft accounted for that field — see "Reasoning/Effort Current State" below.

**What changed since the original pass, worth carrying into any plan:**
- **Harness default resolution is now credential-aware** (`src/utils/harness-provider.ts`, landed via PR #872 / commit `0a538491`): the default is no longer unconditionally `"claude"` — it picks `"pi"` when `OPENROUTER_API_KEY` is present and no Anthropic credential exists, else `"claude"`.
- **Model resolution now has an extra step**: the runner's precedence chain routes through `resolveTaskModelSelection()` (`src/types.ts:131`), which inserts a `modelTier` (`smol`/`regular`/`smart`/`ultra`, see `runbooks/model-tiers.md`) fallback between the task's `model` field and `MODEL_OVERRIDE`. `modelTier` picks *which model* runs a task; reasoning effort would control *how hard* that model thinks — genuinely orthogonal axes, but a future plan should say so explicitly since they now share a resolution path's neighborhood.
- **A factual correction**: `ui/src/components/shared/harness-cell.tsx`'s tooltip (`CredBreakdown`) *does* render a "Latest model" row with `latestModel.model` + `.source` (lines 161-169) — this document's original claim was right. A later, related draft plan's review pass asserted the opposite (claiming the tooltip has no model/source rows at all) and redirected a UI phase away from this surface on that basis. That assertion is wrong; both `HarnessCell` and the agents-list display (`ui/src/lib/agents-list-model-display.ts`, new since the original pass) are viable, independent homes for a future last-used-effort display.
- **`RELOADABLE_ENV_KEYS`** (`src/commands/runner.ts`) gained two unrelated keys since the original pass (`SWARM_USE_CLAUDE_BRIDGE`, `BEDROCK_AUTH_MODE`), alongside the original `MODEL_OVERRIDE` and `AGENT_FS_SHARED_ORG_ID`. Still nothing reasoning-related — a future `REASONING_EFFORT_OVERRIDE` key would need to be added here for workers to hot-reconcile without a restart, exactly as this doc originally anticipated for `MODEL_OVERRIDE`.
- Claude's UI fallback default model was bumped to `claude-opus-4-8` (was `claude-opus-4-7`); Codex/Pi/Opencode fallbacks unchanged.
- A 4th provider icon (Amazon Bedrock) was added to `provider-icon.tsx` — cosmetic, unrelated to this feature, noted only for completeness of the UI findings below.

## Detailed Findings

### Runtime Persistence And API

- Per-agent desired runtime settings are split between an agent column and scoped config. `swarm_config` is keyed by `(scope, scopeId, key)` — `CREATE TABLE swarm_config` at `src/be/migrations/001_initial.sql:246`, `UNIQUE(scope, scopeId, key)` at `:257`. `upsertSwarmConfig()` persists scoped config rows at `src/be/db.ts:6064` (was `:5329`).
- `agents.harness_provider` is a nullable column added by `src/be/migrations/054_agent_harness_provider.sql:21` (unchanged). Rows map to `Agent.harnessProvider` at `src/be/db.ts:664` (was `:594`), and `setAgentHarnessProvider()` updates the column at `src/be/db.ts:828` (was `:758`).
- `PATCH /api/agents/{id}/runtime` is defined at `src/http/agents.ts:85-104` (path field at `:87`). The request body accepts `harness_provider`, `model`, and optional `allow_custom_model` at `src/http/agents.ts:94-98` (was `:82`).
- The runtime handler updates `agents.harness_provider` and upserts agent-scoped `HARNESS_PROVIDER` plus `MODEL_OVERRIDE` rows inside one transaction at `src/http/agents.ts:517-550` (txn body `:520-543`, was `:510`).
- `allow_custom_model` still only affects the stored config row's description text, not a separate persisted boolean flag — `src/http/agents.ts:538-540` (was `:526`).
- OpenAPI registration flows through `route()` and `routeRegistry` in `src/http/route-def.ts:148` (unchanged). `scripts/generate-openapi.ts` imports `src/http/agents` at line 4 (not line 1 — line 1 imports `generateOpenApiSpec`), so the runtime route appears in generated `openapi.json:504` (was `:464`).
- **Gap confirmed still present**: only a row-id-based `deleteSwarmConfig(id): boolean` exists (`src/be/db.ts:6176`, was `:5712`). No `deleteSwarmConfigByKey(scope, scopeId, key)`-style helper exists anywhere in `src/` — `MODEL_OVERRIDE` (and any future `REASONING_EFFORT_OVERRIDE`) still cannot be cleared via the runtime PATCH endpoint.

### Worker Resolution And Latest Model Telemetry

- Workers fetch resolved config with `/api/config/resolved?agentId=...&includeSecrets=true` at `src/commands/runner.ts:403` (was `:248`).
- Config resolution order is repo > agent > global, per the comment at `src/be/db.ts:6183` (was `:5447`).
- **Harness resolution changed behavior**: resolution now lives at `src/utils/harness-provider.ts:47-61` (was `:5`, which is now inside an unrelated `hasEnvValue()` helper). The default is credential-aware — `credentialAwareDefault()` (`:21-30`) picks `"pi"` when `OPENROUTER_API_KEY` is present and no Anthropic credential exists, else `"claude"`. This landed via PR #872 (commit `0a538491`), after the original research.
- Runner boot selects the adapter from the resolved harness at `src/commands/runner.ts:3830` (`createProviderAdapter(bootProvider)`, was `:3049`), and later reconciles harness/config drift inside `applySwarmConfigDrift()` at `src/commands/runner.ts:4096` (was `:3924`).
- **Model selection precedence changed shape**: it's no longer a flat task→`MODEL_OVERRIDE`→empty chain. It now routes through `resolveTaskModelSelection()` (`src/types.ts:131`), which inserts a `modelTier` resolution step between the task's `model` field and empty: `opts.model → modelTier resolution → "" → configModel (MODEL_OVERRIDE) → ""`. The precedence call site is at `src/commands/runner.ts:2697-2704` (was `:2158`); the resolved value flows into `ProviderSessionConfig.model` at `src/commands/runner.ts:2735` (was `:2198`).
- Task-specific model values are stored on `agent_tasks.model` from `src/be/migrations/001_initial.sql:102` (unchanged) and inserted by `createTaskExtended()` at `src/be/db.ts:3070` (was `:2603`).
- Worker-reported latest model state lives in `agents.cred_status`, added by `src/be/migrations/055_agent_cred_status.sql:15` (the `ALTER TABLE` itself — line 1 is a file-header comment; was cited as `:1`).
- `AgentLatestModelSchema` is at `src/types.ts:694-701`; `AgentCredStatusSchema` is at `:722-737` (`latestModel` field at `:731`) — was cited as `:499`. Shape is unchanged: `{ model, source, taskId, harnessProvider, reportedAt }`.
- `PUT /api/agents/{id}/credential-status` accepts optional `latest_model` in its body at `src/http/agents.ts:210-226` (`latest_model` field at `:225`; the route itself, `updateAgentCredentialStatusRoute`, starts at `:228`) — was cited as `:216`.
- It merges into `cred_status` without clobbering existing readiness/live-test data at `src/http/agents.ts:602-632` (was `:592`): when `cred_status` is present, `latestModel` falls back through a `??` chain (parsed body → sent cred_status → existing `agent.credStatus?.latestModel` → null); when only `latest_model` is sent, it seeds from the existing `agent.credStatus` and overlays.
- `reportLatestModel()` posts worker telemetry to the credential-status endpoint at `src/commands/provider-credentials.ts:481` (was `:448`).
- `buildLatestModelReport()` classifies source as `task`, `agent_config`, `custom`, or `adapter_default` at `src/commands/provider-credentials.ts:504` (classification ternary at `:517-524`; was cited as `:471`).
- The runner reports an initial model after session creation at `src/commands/runner.ts:2794-2805` (`buildLatestModelReport()` call `:2794`, `reportLatestModel()` call `:2802`; was `:2259`) and reports adapter-emitted `event.cost.model` on result inside the `case "result":` handler at `src/commands/runner.ts:3082-3090` (was `:2504`).

### Provider Contract And Harness Behavior

- Supported harness names are `claude`, `codex`, `pi`, `devin`, `claude-managed`, and `opencode` — `ProviderNameSchema` at `src/types.ts:250-257` (was `:78`), values/order unchanged.
- `src/providers/index.ts:27` maps harness names to adapter implementations (unchanged).
- `ProviderSessionConfig` currently has `prompt`, `systemPrompt`, `model`, `additionalArgs`, `env`, and `codexSlot`, but still no reasoning/effort field — interface now at `src/providers/types.ts:84-114` (was `:80`). The shared cost fields `reasoningOutputTokens` / `thinkingTokens` are in the same file at `:16` / `:18` respectively.
- Claude's adapter was restructured into a `buildCommand()` method since the original pass: the empty-model-defaults-to-`opus` fallback is now in `createSession()` at `src/providers/claude-adapter.ts:910` (`config.model || "opus"`); `--model` is pushed onto argv inside `buildCommand()` at `:567-568`; `additionalArgs` are appended at `:580-582`. (The original doc's `:382`/`:756` no longer point at any of this — `:756` in particular was already flagged as wrong by a later document, pointing instead at credential validation; the correct current locations are the three above.)
- Claude records thinking-token telemetry from CLI output — the `thinking_input_tokens` type field is at `src/providers/claude-adapter.ts:766`, the assignment (`thinkingTokens: usage?.thinking_input_tokens ?? 0`) at `:780` (was cited as `:565`).
- Codex resolves model defaults/aliases through `resolveCodexModel()` at `src/providers/codex-models.ts:53` (was `:43`). It builds Codex SDK config with `model` inside `buildCodexConfig()` (field at `:378`) and passes the resolved model into `ThreadOptions` at `:1315-1321` (field at `:1320`), passed to `codex.startThread()` at `:1331` — was cited as a single `:1205`.
- Codex still hard-codes `show_raw_agent_reasoning: false`, now inside `buildCodexConfig()`'s returned object at `src/providers/codex-adapter.ts:382` (was `:353`), and propagates `reasoning_output_tokens` into cost telemetry via `buildCostData()` (`:566`) — computed at `:574`, assigned at `:592` (was cited as `:545`).
- Pi resolves `config.model` via `resolveModel()` at `src/providers/pi-mono-adapter.ts:374` (was `:218`), then passes the resolved model into `createAgentSession` options built at `:977-984` (fields: `cwd`, `model`, `customTools`, `resourceLoader`, `authStorage`, `modelRegistry` — no `thinkingLevel` wired in yet), call site at `:987` (was cited as a single `:712`).
  - **Settled**: `thinkingLevel?: ThinkingLevel` is confirmed a TOP-LEVEL sibling of `model` on `CreateAgentSessionOptions` per the installed `@mariozechner/pi-coding-agent` `.d.ts` (`node_modules/@mariozechner/pi-coding-agent/dist/core/sdk.d.ts:11-28`) — no nesting required. This closes an open question from the original research.
- Pi reports canonical `provider/id` model strings for telemetry/cost via `reportedModel()` at `src/providers/pi-mono-adapter.ts:551-554` (used at `:608`, `:646`, `:821`; was cited as `:574`).
- Opencode writes `model: config.model` into per-task config inside the `opencodeConfig` object at `src/providers/opencode-adapter.ts:681` (was `:590`), captures `modelID` from events at `:416` (was `:356`), and emits cost model data inside `buildCostData()` (`:556-572`) at `:568` (was `:500`).
- Pi and Opencode credential gating are model-aware through `modelToCredKeys` (`src/providers/pi-mono-adapter.ts:59`, was `:43`) and `opencodeModelToCredKey` (`src/providers/opencode-adapter.ts:43`, was `:36`), including provider-prefixed models — both confirmed still branching on `provider/model-id` prefixes.

### Reasoning/Effort Current State

- No current backend/API/storage field exists for per-agent reasoning/effort control — confirmed by a fresh grep across `src/be/` and `src/http/` for `reasoning_effort` / `reasoningEffort` / `REASONING_EFFORT`, zero hits. The runtime body remains harness/model/custom-gating only (`src/http/agents.ts:94-98`).
- No current provider session contract field exists for reasoning/effort. `ProviderSessionConfig` exposes only the fields listed above (`src/providers/types.ts:84-114`); a broad grep across `src/providers/` and `src/commands/` for `reasoningEffort`, `REASONING_EFFORT_OVERRIDE`, `thinkingLevel`, and `model_reasoning_effort` returns zero hits — the feature is genuinely unstarted.
- Shared cost telemetry exposes `reasoningOutputTokens` and `thinkingTokens` in `src/providers/types.ts:16` / `:18`. Session cost schemas expose the same reasoning/thinking token fields in `src/types.ts:705` area (unchanged).
- The only exact `effort` field found in scoped code is skill metadata, not runtime model control — `src/types.ts:2028` (was `:1538`) and `src/be/skill-parser.ts:10` (was `:5`).
- `RELOADABLE_ENV_KEYS` in `src/commands/runner.ts` is currently `Set(["MODEL_OVERRIDE", "AGENT_FS_SHARED_ORG_ID", "SWARM_USE_CLAUDE_BRIDGE", "BEDROCK_AUTH_MODE"])` — two keys added since the original pass, still nothing reasoning-related.
- **`modelsdev-cache.json`'s `reasoning` field, clarified**: the literal `reasoning` key is a plain boolean support-gate (`true`/`false` — 2000+ `true` occurrences confirmed, e.g. `xai/grok-4`, `google/gemini-2.5-pro`), as this document originally assumed. But many models *also* carry a `reasoning_options` array that this document did not previously examine: entries can be `{ type: "effort", values: [...] }` (e.g. `google/gemini-2.5-pro` → `["none","low","medium","high","max"]`) or `{ type: "budget_tokens", ... }`. This means models.dev may already enumerate valid effort levels for a meaningful subset of models — a future plan's assumption that levels must be *entirely* hand-authored in a static rule table should be revisited; a hybrid (read `reasoning_options` where present, fall back to a small hand-maintained table for the four local harnesses' known quirks — e.g. Codex `*-codex` rejecting `minimal`) may need much less bespoke data than assumed. `ui/src/lib/modelsdev-cache.json` remains a symlink to the canonical `src/be/modelsdev-cache.json` (confirmed). `ui/src/lib/agent-runtime-models.ts`'s `CachedModel` type still projects only `id`/`name`/`cost`/`limit` from this cache — neither `reasoning` nor `reasoning_options` is read by the UI today.

### External Provider Reasoning/Effort Knobs

Cross-harness picture: each of the four local harnesses exposes a different shape — Claude is numeric-budget + adaptive, Codex/Pi are qualitative effort levels, Opencode is provider-gated pass-through. None offer a unified `effort` field that works across providers without adapter-side translation. (This section documents external SDK/CLI behavior, not reverified in the refresh — treat as an assumption to confirm live during implementation, same caveat as the original research.)

#### Claude (Anthropic `claude` CLI)

Two orthogonal knobs: a **qualitative effort level** (`output_config.effort`, surfaced as `/effort`) and a **numeric thinking budget** (`thinking.budget_tokens`, surfaced as `MAX_THINKING_TOKENS`). On Opus 4.7 the budget knob is rejected and only effort applies; on Sonnet 4.x / Opus 4.6 both are usable.

- **`/effort` slash command** (Claude Code v2.1.76+): sets `output_config.effort` on the Messages API; influences both reasoning depth and output verbosity.
  - Values: `low | medium | high | xhigh | max` plus `auto` (reset to model default). `xhigh` is Opus-4.7-only (added v2.1.111).
  - Persists across sessions in `settings.json` under key `effortLevel`.
  - Non-interactive: env var `CLAUDE_CODE_EFFORT_LEVEL=<level>` is the reliable path — overrides `settings.json` and the `/effort` picker. CLI flag `--effort` exists but is buggy in `-p` (non-interactive) mode (anthropics/claude-code#41028, #50598), so `claude-adapter.ts` should set the env var when spawning.
  - `max` has known persistence/downgrade bugs in `settings.json` (#30726, #43322) — env var is the only reliable way to pin it.
  - Default on Opus 4.7 in Claude Code is `xhigh`.
- **`MAX_THINKING_TOKENS`** (env or `settings.json`): integer budget for fixed-budget thinking. `0` disables. Default `31999`. Honored on Sonnet 3.7 / 4.x and Opus 4.6; ignored on Opus 4.7 (adaptive-only).
- **`CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`**: reverts to fixed budget on 4.6 models; no-op on 4.7.
- In-prompt keyword tiers on pre-4.7 models (CLI lexical scan, community-documented): `think` → ~4k, `megathink` → ~10k, `ultrathink` → ~31999. On Opus 4.7 these collapse to one-turn effort hints.
- Underlying Messages API knobs: `thinking: { type: "enabled", budget_tokens: N }` (deprecated on 4.6, rejected on 4.7) or `thinking: { type: "adaptive" }` (current); plus `output_config: { effort: <level> }` (current). `budget_tokens` minimum `1024`, must be `< max_tokens`.
- Gating: thinking-capable models only — Sonnet 3.7+, Sonnet 4.x, Opus 4.x, Haiku 4.x where applicable. Non-thinking models ignore both fields.
- Default with no config: adaptive thinking enabled on supported models; Opus 4.7 defaults to effort `xhigh`. `showThinkingSummaries` is `false` by default in recent CLI versions.

#### Codex (`@openai/codex-sdk` + `codex` CLI)

- Canonical knob: `model_reasoning_effort` — values `none | minimal | low | medium | high | xhigh`. Default `medium`.
- Passed via `-c model_reasoning_effort="high"` (CLI) or `config: { model_reasoning_effort: "..." }` (SDK). NOT a typed `ThreadOptions` field and NOT an env var. Persistent form is `config.toml` profiles.
- Related orthogonal knobs in the same `config` map: `model_reasoning_summary` (`auto | concise | detailed | none`, default `auto`), `model_verbosity` (`low | medium | high`, default `medium`, Responses API only), `show_raw_agent_reasoning` (boolean — currently pinned `false` in `src/providers/codex-adapter.ts:382`; orthogonal to effort).
- Per-model gating (empirically validated, not reverified in this refresh):
  - `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-mini` — `low | medium | high` only; reject `minimal`.
  - `gpt-5.1-codex-max` — adds `xhigh`.
  - `gpt-5.1` (non-codex) — accepts `none` plus standard tiers.
  - Sending an invalid level fails the API call.
- `Thread.resume` persists the last `reasoning_effort` per thread; supplying `config.model_reasoning_effort` (or top-level `model`/`modelProvider`) disables the persisted fallback.

#### Pi (`@mariozechner/pi-coding-agent` / `pi-mono`)

- Normalized `thinkingLevel` on `SessionConfig` (the option flowing into `createAgentSession`) — confirmed top-level per the installed `.d.ts` (see Provider Contract findings above). Values: `off | minimal | low | medium | high | xhigh`, plus `max` for Claude 4.6+.
- Separate `thinkingBudgets` map keys each level to a token budget (defaults from docs: `minimal=1024`, `low=4096`, `medium=10240`, `high=32768`). Honored by token-budget-native providers (Anthropic, OpenAI); qualitative pass-through for OpenRouter, xAI, Mistral, vLLM.
- `defaultThinkingLevel` sets the initial value; unknown/new models reset to `off` (issue badlogic/pi-mono#1789).
- For OpenRouter routes pi-mono normalizes `thinkingLevel` to OpenRouter's `reasoning: { effort: <level> }`. The OpenRouter `reasoning` object accepts `{ effort, max_tokens, exclude, enabled }`; `effort` and `max_tokens` are mutually exclusive.
- Reasoning capability per model is declared in pi-mono's model registry — non-reasoning models ignore the level.

#### Opencode (`sst/opencode`)

- No unified reasoning key. Reasoning lives provider-gated under `provider.<id>.models.<model>.options` in `opencode.json` / `opencode.jsonc`, and the adapter must emit the right shape per provider:
  - OpenAI / Azure / OpenAI-compatible: `options.reasoningEffort: "none | minimal | low | medium | high | xhigh"` (plus `textVerbosity`, `reasoningSummary`).
  - Anthropic: `options.thinking: { type: "enabled", budgetTokens: N }` (min `1024`); some entries also accept `type: "adaptive"`.
  - OpenRouter: `options.reasoning: { effort | max_tokens, exclude, enabled }` (pass-through; same constraints as direct OpenRouter).
  - AWS Bedrock Anthropic: incomplete pass-through (sst/opencode#3428, sst/opencode#7357).
- Built-in variants ship as preset `options` bundles: Anthropic exposes `high` and `max`; OpenAI reasoning models expose `none / minimal / low / medium / high / xhigh`. Selected per-invocation via `--variant <name>`; there is no `--reasoning-effort` CLI flag (open request anomalyco/opencode#14611).
- Agent definitions accept the same `options` block, so reasoning can be pinned per-agent.
- No reasoning is sent unless the user sets it; provider defaults apply (OpenAI reasoning models default to `medium`, Anthropic does not enable extended thinking without `thinking`).
- For our adapter at `src/providers/opencode-adapter.ts:681`, a single normalized `reasoningEffort` field on the task config would need parsing of the model string (`anthropic/...` vs `openai/...` vs `openrouter/...`) to emit the correct provider-specific shape under `options`.

#### Cross-harness normalization

After the `/effort` finding, **all four harnesses now expose a qualitative effort level** as their primary user-facing knob. They diverge on the underlying transport and on the level vocabulary:

| Harness | Primary level vocabulary | Transport to adapter | Numeric-budget escape hatch |
|---|---|---|---|
| Claude | `low \| medium \| high \| xhigh \| max` (+ `auto`) | env var `CLAUDE_CODE_EFFORT_LEVEL` | `MAX_THINKING_TOKENS` (env), legacy models only |
| Codex | `none \| minimal \| low \| medium \| high \| xhigh` | SDK `config.model_reasoning_effort` (or `-c` CLI override) | n/a |
| Pi | `off \| minimal \| low \| medium \| high \| xhigh \| max` | `SessionConfig.thinkingLevel` (top-level option) | `thinkingBudgets` map (provider-gated) |
| Opencode | provider-gated — varies by provider, but each provider uses the same `low \| medium \| high \| xhigh`-ish vocabulary | per-task `opencode.json` under `provider.<id>.models.<model>.options.<reasoningEffort \| thinking \| reasoning>` | Anthropic `budgetTokens`, OpenRouter `max_tokens` |

Shared safe subset: **`low | medium | high`** — accepted by all four on at least their default models.

Restricted / gated levels: `minimal` (rejected by Codex `*-codex` models; not in Claude vocabulary); `xhigh` (Codex only on `gpt-5.1-codex-max`; Claude Opus 4.7-only; Pi/Opencode pass-through); `max` (Claude-only, persistence-buggy); `off`/`none` (semantics differ — Codex `none`, Pi `off`, Claude has no off, Opencode just omits).

#### Implications for our runtime contract

- A normalized `reasoning_effort` field on the runtime API body with closed enum `off | low | medium | high | xhigh` covers ~all real use cases. Adapter maps:
  - Claude: set `CLAUDE_CODE_EFFORT_LEVEL` env in the spawn; map `off` → unset + `MAX_THINKING_TOKENS=0` on legacy models, or refuse with a clear error on Opus 4.7 (no off semantics).
  - Codex: set `config.model_reasoning_effort` in the SDK config map (`buildCodexConfig()`, `src/providers/codex-adapter.ts:378`); map `off` → `none`; refuse `minimal`(we're not exposing it); validate `xhigh` against model name.
  - Pi: set `thinkingLevel` as a top-level key alongside `model` on the `createAgentSession` options object (`src/providers/pi-mono-adapter.ts:977-984`); map `off` → `off`.
  - Opencode: parse the model prefix, write the matching key under `provider.<id>.models.<model>.options` in the per-task config.
- This lives in `ProviderSessionConfig` next to `model` (`src/providers/types.ts:84-114`) — same lifecycle, same precedence, same telemetry path. Resolved order would mirror model: task field → agent `swarm_config` (`REASONING_EFFORT_OVERRIDE`) → adapter default. **Note**: unlike `model`, this resolution should stay independent of the `modelTier` fallback step now present in `resolveTaskModelSelection()` — reasoning effort and model tier are orthogonal, and conflating their resolution chains would make both harder to reason about.
- Per-model gating belongs in the UI (greying out unsupported levels using a `supportsReasoning` / `reasoningLevels` field on `ModelOption`) plus a soft server-side validation that returns 400 on obviously invalid combos (e.g. `xhigh` on `gpt-5.1-codex` non-max). Given the `reasoning_options` finding above, the capability table's source of truth should be reconsidered: read `reasoning_options.values` from the models.dev snapshot where present, and layer a small hand-maintained table on top only for the four local harnesses' known quirks — rather than authoring the whole thing by hand.
- Last-used effort belongs in `agents.cred_status.latestModel` alongside `model` — adapters already emit the requested level, we can echo it back. Both `HarnessCell`'s `CredBreakdown` tooltip (`ui/src/components/shared/harness-cell.tsx:100-194`) and the agents-list model display (`ui/src/lib/agents-list-model-display.ts`) are viable, already-existing homes for surfacing it.
- Any new persistence key (`REASONING_EFFORT_OVERRIDE`) needs adding to `RELOADABLE_ENV_KEYS` (`src/commands/runner.ts`) for workers to hot-reconcile without a restart, same as `MODEL_OVERRIDE`.

### Dashboard Runtime UI

- The agent detail route is mounted at `/agents/:id` — `ui/src/app/router.tsx:97` (`{ path: "agents/:id", element: <AgentDetailPage /> }`; was cited as `:89`, which is now just the route array's opening brace).
- `ui/src/pages/agents/[id]/page.tsx:330` renders `<AgentRuntimeSettings agent={agent} />` inside a "Runtime" `InfoRow`, sibling to a separate "Harness" `InfoRow` at `:323` (was cited as `:323` for the render itself).
- `AgentRuntimeSettings` reads resolved config, env-key presence, feature gate `1.77.2`, current harness, configured `MODEL_OVERRIDE`, and `credStatus.latestModel` across `ui/src/components/shared/agent-runtime-settings.tsx:45-87` (`RUNTIME_EDIT_MIN_VERSION="1.77.2"` at `:45`, `MODEL_OVERRIDE` lookup at `:56`, `configsQuery`/`envPresenceQuery`/`gate` at `:61`/`:62`/`:64`, `latestModel` at `:87`) — was cited as a single `:44`.
- The runtime editor state controls `harness`, `model`, and `customMode` via `useState` at `ui/src/components/shared/agent-runtime-settings.tsx:67-69` (was `:84`).
- Save calls `useUpdateAgentRuntime` with `harnessProvider`, `model`, and `allowCustomModel` inside a `save()` function at `ui/src/components/shared/agent-runtime-settings.tsx:114-128` (was `:92`).
- The harness selector is a `Select` over `LOCAL_HARNESSES` and renders `HarnessIcon` / `HARNESS_LABEL` at `ui/src/components/shared/agent-runtime-settings.tsx:152-166` (was `:127`).
- The model selector is an inline `ModelCombobox` using `Popover` + `Command`, used at `ui/src/components/shared/agent-runtime-settings.tsx:174` and defined at `:329` (was cited as a single `:307`).
- The runtime editor displays both configured and last-used model strings at `ui/src/components/shared/agent-runtime-settings.tsx:205-212` (`Configured: <code>{model || "unset"}</code>` / `Last used: <code>{latestModel?.model ?? "not reported"}</code>`) — was cited as `:183`.
- Agent list Model column logic was refactored since the original pass: it now reads `agent.credStatus?.latestModel?.model` and delegates to `getAgentModelDisplay()` / `getAgentModelPresentation()` (`ui/src/lib/agents-list-model-display.ts`) rather than calling `findKnownModel` inline, at `ui/src/pages/agents/page.tsx:61-93` (import `:24`, `valueGetter` `:69-73`, `cellRenderer` `:87-90`) — was cited as `:32`/`:42`.
- `HarnessCell` still displays harness/credential details and, inside its `CredBreakdown` tooltip (lines 100-194), a "Latest model" row (`credStatus.latestModel.model` + `.source`, lines 161-169) — confirmed unchanged at `ui/src/components/shared/harness-cell.tsx:60`/`:161`, the exact original line numbers. (See the Summary's factual-correction note — a related draft plan's review pass asserted otherwise; that assertion is wrong.)
- Harness logos exist as inline SVGs for Claude, Claude Managed, Codex, Pi, Opencode, and Devin in `ui/src/components/shared/harness-icon.tsx:108` (unchanged).
- Provider logos now cover 4 providers — Anthropic, OpenAI, OpenRouter, and (new) Amazon Bedrock — with the icon map at `ui/src/components/shared/provider-icon.tsx:53-58` (was `:43`, cited for 3 providers).
- A generic fuzzy `SearchableSelect` component still exists at `ui/src/components/ui/searchable-select.tsx:39` (unchanged), unused by the runtime editor, which keeps its own inline `ModelCombobox`.

### UI Model Registry

- Local editable harnesses are exactly `claude | codex | pi | opencode` — the type is at `ui/src/lib/agent-runtime-models.ts:4` (unchanged); the `LOCAL_HARNESSES` array itself is now at `:49` (was `:42`).
- Direct registry entries for Claude and Codex are now at `ui/src/lib/agent-runtime-models.ts:71` (was `:64`).
- Pi and Opencode use snapshot-backed provider groups from `modelsdev-cache.json`, built inside `modelGroupsForHarness()` now at `ui/src/lib/agent-runtime-models.ts:174` (`snapshotGroups` build at `:194-214`; was cited as `:134`).
- Fallback defaults are hardcoded per local harness at `ui/src/lib/agent-runtime-models.ts:129-134` (was `:102`): Codex `gpt-5.4`, Pi `openrouter/google/gemini-3-flash-preview`, Opencode `openrouter/qwen/qwen3-coder-flash` are unchanged, but **Claude's default was bumped to `claude-opus-4-8`** (was `claude-opus-4-7`).
- `ui/src/api/client.ts:231-252` sends the runtime route body (was `:215`), and `ui/src/api/hooks/use-agents.ts` — `useUpdateAgentRuntime()` is declared at `:61`, with its `invalidateQueries` calls for `agents`/`agent`/`configs` at `:72-74` (was cited as `:64`).

### Tests, Docs, And Generated Artifacts

- Runtime route tests live in `src/tests/agents-harness-provider.test.ts:335` — confirmed exact match on a spot check (unchanged).
- Credential-status latest-model merge tests live in `src/tests/credential-status-api.test.ts:183` — confirmed exact match (unchanged).
- Credential routing/status rollup tests cover related state in `src/tests/credential-status-routing.test.ts:12` and `src/tests/status.test.ts:214` — `:214` confirmed exact match on spot check.
- Provider credential/model conditional tests cover Pi/Opencode and dispatcher behavior in `src/tests/credential-check.test.ts:149`.
- Model config precedence tests live in `src/tests/model-control.test.ts:218`.
- Adapter model tests exist for Claude (`src/tests/claude-adapter.test.ts:38`), Codex (`src/tests/codex-adapter.test.ts:767`), Pi (`src/tests/pi-mono-adapter.test.ts:109`), and Opencode (`src/tests/opencode-adapter.test.ts:567`) — `:38` and `:767` confirmed exact matches on spot check. Test-file line drift is minimal to nonexistent, unlike the source-file drift above.
- Still no direct tests found for `buildLatestModelReport()` or `reportLatestModel()` under `src/tests` (confirmed via fresh grep).
- Still no UI test/spec files found under `ui/` (confirmed via fresh glob).
- `scripts/generate-openapi.ts` (import now at line 4) regenerates both `openapi.json` and docs-site API reference content.
- Generated API reference still includes runtime and credential-status operations in `docs-site/content/docs/api-reference/agents.mdx:7`.
- Related docs/runbooks all still exist and remain on-topic: `runbooks/harness-providers.md:7`, `docs-site/content/docs/(documentation)/guides/harness-providers.mdx:210`, `docs-site/content/docs/(documentation)/guides/harness-configuration.mdx:21`, `docs-site/content/docs/(documentation)/guides/worker-credential-recovery.mdx:76`.
- **New scope-boundary check**: `runbooks/model-tiers.md` documents `modelTier` (`smol`/`regular`/`smart`/`ultra`) as a portable, cross-harness selector for *which model* runs a task, with its own override precedence and claim-time resolution — it never mentions reasoning, thinking budgets, or effort levels. This confirms `modelTier` and reasoning effort are genuinely orthogonal axes (model *selection* vs. how hard the selected model *thinks*), which the original research didn't address. Worth stating explicitly in any implementation plan so the two resolution chains — which now sit right next to each other in `src/commands/runner.ts` — aren't conflated.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/http/agents.ts` | 94-98 | Runtime update request schema with `harness_provider`, `model`, `allow_custom_model` |
| `src/http/agents.ts` | 517-550 | Runtime handler updates harness provider and scoped config (txn `520-543`) |
| `src/be/db.ts` | 6176 | Row-id-based `deleteSwarmConfig(id)` — no key-based delete helper exists yet |
| `src/types.ts` | 694-701, 722-737 | `AgentLatestModelSchema` / `AgentCredStatusSchema` (`latestModel` field at `731`) |
| `src/providers/types.ts` | 84-114 | `ProviderSessionConfig` currently includes `model`, not reasoning/effort |
| `src/commands/runner.ts` | 2697-2735 | Runtime model resolution — now routes through `resolveTaskModelSelection()` (adds a `modelTier` fallback) before `MODEL_OVERRIDE` |
| `src/utils/harness-provider.ts` | 47-61 | Harness resolution — now credential-aware default (`pi` vs `claude`), not unconditional `claude` |
| `src/commands/provider-credentials.ts` | 481, 504 | `reportLatestModel()` (481) and `buildLatestModelReport()` (504) |
| `src/providers/claude-adapter.ts` | 567-568, 910 | `--model` launch path inside `buildCommand()` (567-568); default-to-`opus` fallback (910) |
| `src/providers/codex-adapter.ts` | 378, 1315-1321, 382 | `buildCodexConfig()` model field (378) and `ThreadOptions.model` (1315-1321); `show_raw_agent_reasoning: false` (382) |
| `src/providers/pi-mono-adapter.ts` | 977-987 | Resolved model + session options passed to `createAgentSession` (`thinkingLevel` would be a top-level sibling here) |
| `src/providers/opencode-adapter.ts` | 681 | Opencode adapter per-task config includes `model` |
| `ui/src/components/shared/agent-runtime-settings.tsx` | 45-87 | Runtime editor reads current config and latest model |
| `ui/src/components/shared/agent-runtime-settings.tsx` | 174, 329 | Model combobox usage / definition |
| `ui/src/components/shared/harness-cell.tsx` | 60, 161 | `HarnessCell`'s `CredBreakdown` tooltip — confirmed it does show `latestModel.model`/`.source` |
| `ui/src/lib/agent-runtime-models.ts` | 4, 49, 129-134 | Local harness type (4) / `LOCAL_HARNESSES` array (49) / fallback defaults (129-134, Claude now `claude-opus-4-8`) |
| `ui/src/lib/agents-list-model-display.ts` | 22, 37 | `getAgentModelPresentation()` (22) / `getAgentModelDisplay()` (37) — new helper backing the agents-list Model column |
| `ui/src/pages/agents/page.tsx` | 61-93 | Agent list model column, now via `agents-list-model-display.ts` helpers |
| `openapi.json` | 504 | Generated runtime route schema |

## Open Questions

- Cross-harness shape mismatch: Claude is numeric-budget + adaptive, Codex/Pi are qualitative effort levels, Opencode is provider-gated pass-through. Open question: expose one normalized `effort` level cross-harness (with adapter-side translation, the way pi-mono does it internally) or surface per-harness raw knobs (Codex `model_reasoning_effort`, Claude `MAX_THINKING_TOKENS`, etc.). The normalized path is more user-friendly but loses Claude's numeric budgets and Opencode's per-provider keys.
- Per-harness/per-model validity is non-trivial and provider-gated (e.g. Codex `*-codex` models reject `minimal`; `xhigh` only on `gpt-5.1-codex-max`; Anthropic `budget_tokens` min `1024`; OpenRouter `effort` vs `max_tokens` mutually exclusive). Open question: encode validation server-side at runtime-PATCH time, or pass-through and let the harness reject on first run.
- **Refined by this refresh**: given the `reasoning_options` field discovered in `modelsdev-cache.json` (see "Reasoning/Effort Current State"), should the capability table read `reasoning_options.values` from the models.dev snapshot where present, layering a small hand-maintained table on top only for known per-harness quirks — rather than authoring the full per-model capability table by hand as originally assumed? This meaningfully changes the estimated effort of the capability-table piece of any implementation plan.
- No existing persistence contract for custom reasoning/effort opt-in analogous to `allow_custom_model`. Open question: do we need an `allow_custom_effort` flag, or is the closed set of normalized levels safe to expose without opt-in?
- Default behavior: harnesses disagree on defaults (Claude → adaptive enabled; Codex → `medium`; Pi → `defaultThinkingLevel` setting, often `off`; Opencode → not sent at all). Open question: do we ship a single agent-swarm default (probably `medium`) or honor each harness's native default when the setting is unset.
- Persistence shape: store as another scoped `swarm_config` key (e.g. `REASONING_EFFORT`) alongside `MODEL_OVERRIDE`, or extend `agents.cred_status.latestModel` to also carry the last-used effort. Either way, remember to add the new key to `RELOADABLE_ENV_KEYS` (`src/commands/runner.ts`) for hot reconciliation, and to design its resolution independently of the now-present `modelTier` fallback step.
- Telemetry: `reasoningOutputTokens` / `thinkingTokens` already exist on cost types. Open question: is it worth recording the requested effort level alongside actual reasoning-token usage to validate that the level took effect.

## Appendix

### Focused Commands Identified

```bash
bun test src/tests/agents-harness-provider.test.ts
bun test src/tests/credential-status-api.test.ts
bun test src/tests/credential-status-routing.test.ts
bun test src/tests/status.test.ts
bun test src/tests/credential-check.test.ts
bun test src/tests/model-control.test.ts
bun test src/tests/claude-adapter.test.ts src/tests/codex-adapter.test.ts src/tests/pi-mono-adapter.test.ts src/tests/opencode-adapter.test.ts
bun run docs:openapi
cd ui && pnpm lint && pnpm exec tsc -b
```

### Architecture Notes

- Desired runtime settings live in agent-scoped config (`swarm_config`) plus `agents.harness_provider`.
- Worker-reported runtime truth uses `agents.cred_status.latestModel`, not a separate telemetry table.
- Harness changes affect future sessions via runner config reconciliation (`applySwarmConfigDrift()`, `src/commands/runner.ts:4096`); current sessions keep the provider config they were launched with.
- The runtime editor is agent-detail scoped; the agents list is a read surface for latest-used model, now backed by `ui/src/lib/agents-list-model-display.ts`.
- The dashboard already treats harness and model as one runtime settings unit.
- Harness default resolution is now credential-aware (`src/utils/harness-provider.ts`, PR #872) — a future reasoning-effort default should explicitly decide whether it needs similar credential-awareness or can stay a flat per-harness default.
- Model resolution now includes an intermediate `modelTier` step (`resolveTaskModelSelection()`, `src/types.ts:131`) — a genuinely separate axis from reasoning effort; keep their resolution chains independent in any future design.
- `RELOADABLE_ENV_KEYS` (`src/commands/runner.ts`) currently = `{MODEL_OVERRIDE, AGENT_FS_SHARED_ORG_ID, SWARM_USE_CLAUDE_BRIDGE, BEDROCK_AUTH_MODE}` — a future `REASONING_EFFORT_OVERRIDE` key needs adding here.

### GitHub Permalinks

- `src/http/agents.ts` runtime route: https://github.com/desplega-ai/agent-swarm/blob/0a5384918c152c626e4f957964671a38c69ee455/src/http/agents.ts#L85
- `src/providers/types.ts` provider session config: https://github.com/desplega-ai/agent-swarm/blob/0a5384918c152c626e4f957964671a38c69ee455/src/providers/types.ts#L84
- `src/commands/runner.ts` model resolution: https://github.com/desplega-ai/agent-swarm/blob/0a5384918c152c626e4f957964671a38c69ee455/src/commands/runner.ts#L2697
- `ui/src/components/shared/agent-runtime-settings.tsx` editor: https://github.com/desplega-ai/agent-swarm/blob/0a5384918c152c626e4f957964671a38c69ee455/ui/src/components/shared/agent-runtime-settings.tsx#L45
- `ui/src/lib/agent-runtime-models.ts` model registry: https://github.com/desplega-ai/agent-swarm/blob/0a5384918c152c626e4f957964671a38c69ee455/ui/src/lib/agent-runtime-models.ts#L4

### Historical Context

- Memory for the earlier runtime model-control rollout says the durable boundary is desired settings in agent-scoped `swarm_config` and worker-reported truth in `agents.cred_status`.
- That same rollout captured prior user decisions: future-only changes, all local harnesses, strict defaults with explicit custom-model opt-in, detail-page editing, and harness+model as one runtime unit.
- A related draft implementation plan exists at `thoughts/taras/plans/2026-05-27-agent-reasoning-effort-runtime-control.md` (status: draft, never implemented as of this refresh). It already underwent two internal review passes correcting earlier line drift, but was baselined at commit `6e6d82c2` — well behind the `0a538491` baseline of this refresh — and contains at least one factual error (the `HarnessCell` claim addressed above) plus a capability-table assumption worth revisiting given the `reasoning_options` finding. Treat it as a strong starting skeleton, not a ready-to-execute plan, when the next plan is authored.
