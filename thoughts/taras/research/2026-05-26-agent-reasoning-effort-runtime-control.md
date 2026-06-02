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
last_updated: 2026-05-27
last_updated_by: Claude
---

# Research: Agent Model Reasoning/Effort Runtime Control

**Date**: 2026-05-26T23:09:50+02:00
**Researcher**: Codex
**Git Commit**: 5d34deaf8eb6872ea450f461007ab6cc8b7a5e02
**Branch**: main

## Research Question

Current codebase map for offering a way to control agent model reasoning/effort for the `claude`, `codex`, `pi`, and `opencode` harnesses, including proper harness wiring and UI control.

## Summary

The repo already has an end-to-end runtime settings path for per-agent harness and model control. Desired settings are stored as `agents.harness_provider` plus agent-scoped `swarm_config` rows for `HARNESS_PROVIDER` and `MODEL_OVERRIDE`; the edit API is `PATCH /api/agents/{id}/runtime`; workers resolve those settings before launching provider sessions; the dashboard has an agent-detail runtime editor and list/detail surfaces for the latest worker-reported model.

There is currently no first-class runtime setting for reasoning or effort. The runtime API body, `ProviderSessionConfig`, worker config resolution, provider adapters, and UI mutation payload currently carry `model`, but not a reasoning/effort option. Existing reasoning-related fields are telemetry/cost-facing: Codex captures `reasoning_output_tokens`, Claude captures thinking-token telemetry, and shared cost types expose `reasoningOutputTokens` / `thinkingTokens`.

The UI model registry already covers the four local harnesses requested here (`claude`, `codex`, `pi`, `opencode`) and uses a harness-aware model picker. The local `modelsdev-cache.json` snapshot includes a `reasoning` field, but `ui/src/lib/agent-runtime-models.ts` currently maps only ID/name/cost/context fields into model options.

## Detailed Findings

### Runtime Persistence And API

- Per-agent desired runtime settings are split between an agent column and scoped config. `swarm_config` is keyed by `(scope, scopeId, key)` in `src/be/migrations/001_initial.sql:246`, and `upsertSwarmConfig()` persists scoped config rows in `src/be/db.ts:5329`.
- `agents.harness_provider` is a nullable column added by `src/be/migrations/054_agent_harness_provider.sql:21`. Rows map to `Agent.harnessProvider` in `src/be/db.ts:594`, and `setAgentHarnessProvider()` updates the column in `src/be/db.ts:758`.
- `PATCH /api/agents/{id}/runtime` is defined in `src/http/agents.ts:84`. The request body accepts `harness_provider`, `model`, and optional `allow_custom_model` in `src/http/agents.ts:82`.
- The runtime handler updates `agents.harness_provider` and upserts agent-scoped `HARNESS_PROVIDER` plus `MODEL_OVERRIDE` rows inside one transaction in `src/http/agents.ts:510`.
- `allow_custom_model` currently affects the stored config row description for `MODEL_OVERRIDE`, not a separate persisted boolean flag (`src/http/agents.ts:526`).
- OpenAPI registration flows through `route()` and `routeRegistry` in `src/http/route-def.ts:148`; `scripts/generate-openapi.ts:1` imports `src/http/agents` so the runtime route appears in generated `openapi.json:464`.

### Worker Resolution And Latest Model Telemetry

- Workers fetch resolved config with `/api/config/resolved?agentId=...&includeSecrets=true` in `src/commands/runner.ts:248`.
- Config resolution order is repo > agent > global in `src/be/db.ts:5447`.
- Harness resolution uses resolved config, then process env, then `claude` in `src/utils/harness-provider.ts:5`.
- Runner boot selects the adapter from the resolved harness in `src/commands/runner.ts:3049`, and later reconciles harness/config drift in `src/commands/runner.ts:3924`.
- Model selection precedence is task `model` first, then resolved `MODEL_OVERRIDE`, then empty string in `src/commands/runner.ts:2158`. That value becomes `ProviderSessionConfig.model` in `src/commands/runner.ts:2198`.
- Task-specific model values are stored on `agent_tasks.model` from `src/be/migrations/001_initial.sql:102` and inserted by `createTaskExtended()` in `src/be/db.ts:2603`.
- Worker-reported latest model state lives in `agents.cred_status`, added by `src/be/migrations/055_agent_cred_status.sql:1`.
- `AgentLatestModelSchema` and `AgentCredStatusSchema` define `latestModel` as `{ model, source, taskId, harnessProvider, reportedAt }` in `src/types.ts:499`.
- `PUT /api/agents/{id}/credential-status` accepts optional `latest_model` in `src/http/agents.ts:216` and merges it without clobbering existing readiness/live-test data in `src/http/agents.ts:592`.
- `reportLatestModel()` posts worker telemetry to the credential-status endpoint in `src/commands/provider-credentials.ts:448`.
- `buildLatestModelReport()` classifies source as `task`, `agent_config`, `custom`, or `adapter_default` in `src/commands/provider-credentials.ts:471`.
- The runner reports an initial model after session creation in `src/commands/runner.ts:2259` and reports adapter-emitted `event.cost.model` on result in `src/commands/runner.ts:2504`.

### Provider Contract And Harness Behavior

- Supported harness names are `claude`, `codex`, `pi`, `devin`, `claude-managed`, and `opencode` in `src/types.ts:78`.
- `src/providers/index.ts:27` maps harness names to adapter implementations.
- `ProviderSessionConfig` currently has `prompt`, `systemPrompt`, `model`, `additionalArgs`, `env`, and `codexSlot`, but no reasoning/effort field (`src/providers/types.ts:80`).
- Claude uses `Bun.spawn`, defaults empty model to `opus`, and passes the selected model as `--model <model>` (`src/providers/claude-adapter.ts:382`, `src/providers/claude-adapter.ts:756`). Generic `additionalArgs` are appended to Claude CLI args in this adapter path.
- Claude records thinking-token telemetry from CLI output as `thinking_input_tokens` handling in `src/providers/claude-adapter.ts:565`; this is not a runtime control field.
- Codex resolves model defaults/aliases through `resolveCodexModel()` in `src/providers/codex-models.ts:43`, builds Codex SDK config with `model`, and passes the resolved model to thread options in `src/providers/codex-adapter.ts:1205`.
- Codex currently hard-codes `show_raw_agent_reasoning: false` in its config path (`src/providers/codex-adapter.ts:353`) and propagates `reasoning_output_tokens` into cost telemetry in `src/providers/codex-adapter.ts:545`.
- Pi resolves `config.model` via `resolveModel()` in `src/providers/pi-mono-adapter.ts:218`, then passes the resolved model into `createAgentSession` options in `src/providers/pi-mono-adapter.ts:712`.
- Pi reports canonical `provider/id` model strings for telemetry/cost in `src/providers/pi-mono-adapter.ts:574`.
- Opencode writes `model: config.model` into per-task config in `src/providers/opencode-adapter.ts:590`, captures `modelID` from events in `src/providers/opencode-adapter.ts:356`, and emits cost model data in `src/providers/opencode-adapter.ts:500`.
- Pi and Opencode credential gating are model-aware through `MODEL_OVERRIDE`, including provider-prefixed models (`src/providers/pi-mono-adapter.ts:43`, `src/providers/opencode-adapter.ts:36`).

### Reasoning/Effort Current State

- No current backend/API/storage field exists for per-agent reasoning/effort control. The runtime body is model-only plus harness/custom gating in `src/http/agents.ts:93`.
- No current provider session contract field exists for reasoning/effort. `ProviderSessionConfig` exposes only the fields listed in `src/providers/types.ts:80`.
- Shared cost telemetry exposes `reasoningOutputTokens` and `thinkingTokens` in `src/providers/types.ts:10`.
- Session cost schemas expose reasoning/thinking token fields in `src/types.ts:705`.
- The only exact `effort` field found in scoped code is skill metadata, not runtime model control (`src/types.ts:1538`, `src/be/skill-parser.ts:5`).
- `ui/src/lib/modelsdev-cache.json:12` contains model metadata fields including `reasoning`, but `ui/src/lib/agent-runtime-models.ts:27` maps cached models only into ID/name/cost/context-oriented `ModelOption` data.

### External Provider Reasoning/Effort Knobs

Cross-harness picture: each of the four local harnesses exposes a different shape — Claude is numeric-budget + adaptive, Codex/Pi are qualitative effort levels, Opencode is provider-gated pass-through. None offer a unified `effort` field that works across providers without adapter-side translation.

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
- Related orthogonal knobs in the same `config` map: `model_reasoning_summary` (`auto | concise | detailed | none`, default `auto`), `model_verbosity` (`low | medium | high`, default `medium`, Responses API only), `show_raw_agent_reasoning` (boolean — currently pinned `false` in `src/providers/codex-adapter.ts:353`; orthogonal to effort).
- Per-model gating (empirically validated):
  - `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-mini` — `low | medium | high` only; reject `minimal`.
  - `gpt-5.1-codex-max` — adds `xhigh`.
  - `gpt-5.1` (non-codex) — accepts `none` plus standard tiers.
  - Sending an invalid level fails the API call.
- `Thread.resume` persists the last `reasoning_effort` per thread; supplying `config.model_reasoning_effort` (or top-level `model`/`modelProvider`) disables the persisted fallback.

#### Pi (`@mariozechner/pi-coding-agent` / `pi-mono`)

- Normalized `thinkingLevel` on `SessionConfig` (the option flowing into `createAgentSession`). Values: `off | minimal | low | medium | high | xhigh`, plus `max` for Claude 4.6+.
- Separate `thinkingBudgets` map keys each level to a token budget (defaults from docs: `minimal=1024`, `low=4096`, `medium=10240`, `high=32768`). Honored by token-budget-native providers (Anthropic, OpenAI); qualitative pass-through for OpenRouter, xAI, Mistral, vLLM.
- `defaultThinkingLevel` sets the initial value; unknown/new models reset to `off` (issue badlogic/pi-mono#1789).
- For OpenRouter routes pi-mono normalizes `thinkingLevel` to OpenRouter's `reasoning: { effort: <level> }`. The OpenRouter `reasoning` object accepts `{ effort, max_tokens, exclude, enabled }`; `effort` and `max_tokens` are mutually exclusive.
- Reasoning capability per model is declared in pi-mono's model registry — non-reasoning models ignore the level.
- The exact placement of `thinkingLevel` in the `createAgentSession` argument (top-level vs nested under `sessionConfig`) should be confirmed against the installed `@mariozechner/pi-coding-agent` `.d.ts` before wiring it through `src/providers/pi-mono-adapter.ts:712`.

#### Opencode (`sst/opencode`)

- No unified reasoning key. Reasoning lives provider-gated under `provider.<id>.models.<model>.options` in `opencode.json` / `opencode.jsonc`, and the adapter must emit the right shape per provider:
  - OpenAI / Azure / OpenAI-compatible: `options.reasoningEffort: "none | minimal | low | medium | high | xhigh"` (plus `textVerbosity`, `reasoningSummary`).
  - Anthropic: `options.thinking: { type: "enabled", budgetTokens: N }` (min `1024`); some entries also accept `type: "adaptive"`.
  - OpenRouter: `options.reasoning: { effort | max_tokens, exclude, enabled }` (pass-through; same constraints as direct OpenRouter).
  - AWS Bedrock Anthropic: incomplete pass-through (sst/opencode#3428, sst/opencode#7357).
- Built-in variants ship as preset `options` bundles: Anthropic exposes `high` and `max`; OpenAI reasoning models expose `none / minimal / low / medium / high / xhigh`. Selected per-invocation via `--variant <name>`; there is no `--reasoning-effort` CLI flag (open request anomalyco/opencode#14611).
- Agent definitions accept the same `options` block, so reasoning can be pinned per-agent.
- No reasoning is sent unless the user sets it; provider defaults apply (OpenAI reasoning models default to `medium`, Anthropic does not enable extended thinking without `thinking`).
- For our adapter at `src/providers/opencode-adapter.ts:590`, a single normalized `reasoningEffort` field on the task config would need parsing of the model string (`anthropic/...` vs `openai/...` vs `openrouter/...`) to emit the correct provider-specific shape under `options`.

#### Cross-harness normalization

After the `/effort` finding, **all four harnesses now expose a qualitative effort level** as their primary user-facing knob. They diverge on the underlying transport and on the level vocabulary:

| Harness | Primary level vocabulary | Transport to adapter | Numeric-budget escape hatch |
|---|---|---|---|
| Claude | `low \| medium \| high \| xhigh \| max` (+ `auto`) | env var `CLAUDE_CODE_EFFORT_LEVEL` | `MAX_THINKING_TOKENS` (env), legacy models only |
| Codex | `none \| minimal \| low \| medium \| high \| xhigh` | SDK `config.model_reasoning_effort` (or `-c` CLI override) | n/a |
| Pi | `off \| minimal \| low \| medium \| high \| xhigh \| max` | `SessionConfig.thinkingLevel` | `thinkingBudgets` map (provider-gated) |
| Opencode | provider-gated — varies by provider, but each provider uses the same `low \| medium \| high \| xhigh`-ish vocabulary | per-task `opencode.json` under `provider.<id>.models.<model>.options.<reasoningEffort \| thinking \| reasoning>` | Anthropic `budgetTokens`, OpenRouter `max_tokens` |

Shared safe subset: **`low | medium | high`** — accepted by all four on at least their default models.

Restricted / gated levels: `minimal` (rejected by Codex `*-codex` models; not in Claude vocabulary); `xhigh` (Codex only on `gpt-5.1-codex-max`; Claude Opus 4.7-only; Pi/Opencode pass-through); `max` (Claude-only, persistence-buggy); `off`/`none` (semantics differ — Codex `none`, Pi `off`, Claude has no off, Opencode just omits).

#### Implications for our runtime contract

- A normalized `reasoning_effort` field on the runtime API body with closed enum `off | low | medium | high | xhigh` covers ~all real use cases. Adapter maps:
  - Claude: set `CLAUDE_CODE_EFFORT_LEVEL` env in the spawn; map `off` → unset + `MAX_THINKING_TOKENS=0` on legacy models, or refuse with a clear error on Opus 4.7 (no off semantics).
  - Codex: set `config.model_reasoning_effort` in the SDK config map; map `off` → `none`; refuse `minimal` (we're not exposing it); validate `xhigh` against model name.
  - Pi: set `thinkingLevel` on the `createAgentSession` options; map `off` → `off`.
  - Opencode: parse the model prefix, write the matching key under `provider.<id>.models.<model>.options` in the per-task config.
- This lives in `ProviderSessionConfig` next to `model` — same lifecycle, same precedence, same telemetry path. Resolved order would mirror model: task field → agent `swarm_config` (`REASONING_EFFORT_OVERRIDE`) → adapter default.
- Per-model gating belongs in the UI (greying out unsupported levels using a `supportsReasoning` / `reasoningLevels` field on `ModelOption`) plus a soft server-side validation that returns 400 on obviously invalid combos (e.g. `xhigh` on `gpt-5.1-codex` non-max).
- Last-used effort belongs in `agents.cred_status.latestModel` alongside `model` — adapters already emit the requested level, we can echo it back.

### Dashboard Runtime UI

- The agent detail route is mounted at `/agents/:id` in `ui/src/app/router.tsx:89`.
- `ui/src/pages/agents/[id]/page.tsx:323` renders `AgentRuntimeSettings` inside the agent profile runtime row.
- `AgentRuntimeSettings` reads resolved config, env-key presence, feature gate `1.77.2`, current harness, configured `MODEL_OVERRIDE`, and `credStatus.latestModel` in `ui/src/components/shared/agent-runtime-settings.tsx:44`.
- The runtime editor state controls `harness`, `model`, and `customMode` in `ui/src/components/shared/agent-runtime-settings.tsx:84`.
- Save calls `useUpdateAgentRuntime` with `harnessProvider`, `model`, and `allowCustomModel` in `ui/src/components/shared/agent-runtime-settings.tsx:92`.
- The harness selector is a `Select` over `LOCAL_HARNESSES` and renders `HarnessIcon` / `HARNESS_LABEL` in `ui/src/components/shared/agent-runtime-settings.tsx:127`.
- The model selector is an inline `ModelCombobox` using `Popover` + `Command`, with token filtering over label/id/provider and provider icon rendering (`ui/src/components/shared/agent-runtime-settings.tsx:307`).
- The runtime editor displays both configured model and last-used model strings in `ui/src/components/shared/agent-runtime-settings.tsx:183`.
- Agent list has a feature-gated `Model` column reading `credStatus.latestModel.model` and resolving display metadata through `findKnownModel` (`ui/src/pages/agents/page.tsx:32`, `ui/src/pages/agents/page.tsx:42`).
- `HarnessCell` displays harness/credential details and latest model/source in its tooltip (`ui/src/components/shared/harness-cell.tsx:60`, `ui/src/components/shared/harness-cell.tsx:161`).
- Harness logos exist as inline SVGs for Claude, Claude Managed, Codex, Pi, Opencode, and Devin in `ui/src/components/shared/harness-icon.tsx:108`.
- Provider logos exist for Anthropic, OpenAI, and OpenRouter in `ui/src/components/shared/provider-icon.tsx:43`.
- A generic fuzzy `SearchableSelect` component exists in `ui/src/components/ui/searchable-select.tsx:39`, but the runtime editor currently uses its own inline `ModelCombobox`.

### UI Model Registry

- Local editable harnesses are exactly `claude | codex | pi | opencode` in `ui/src/lib/agent-runtime-models.ts:4` and `ui/src/lib/agent-runtime-models.ts:42`.
- Direct registry entries exist for Claude and Codex in `ui/src/lib/agent-runtime-models.ts:64`.
- Pi and Opencode use snapshot-backed provider groups from `modelsdev-cache.json` for OpenRouter, Anthropic, and OpenAI in `ui/src/lib/agent-runtime-models.ts:134`.
- Fallback defaults are hardcoded per local harness: Claude `claude-opus-4-7`, Codex `gpt-5.4`, Pi `openrouter/google/gemini-3-flash-preview`, Opencode `openrouter/qwen/qwen3-coder-flash` in `ui/src/lib/agent-runtime-models.ts:102`.
- `ui/src/api/client.ts:215` sends the runtime route body, and `ui/src/api/hooks/use-agents.ts:64` invalidates `agents`, `agent`, and `configs` query caches after mutation.

### Tests, Docs, And Generated Artifacts

- Runtime route tests live in `src/tests/agents-harness-provider.test.ts:335`.
- Credential-status latest-model merge tests live in `src/tests/credential-status-api.test.ts:183`.
- Credential routing/status rollup tests cover related state in `src/tests/credential-status-routing.test.ts:12` and `src/tests/status.test.ts:214`.
- Provider credential/model conditional tests cover Pi/Opencode and dispatcher behavior in `src/tests/credential-check.test.ts:149`.
- Model config precedence tests live in `src/tests/model-control.test.ts:218`.
- Adapter model tests exist for Claude (`src/tests/claude-adapter.test.ts:38`), Codex (`src/tests/codex-adapter.test.ts:767`), Pi (`src/tests/pi-mono-adapter.test.ts:109`), and Opencode (`src/tests/opencode-adapter.test.ts:567`).
- No direct tests were found for `buildLatestModelReport()` or `reportLatestModel()` under `src/tests`.
- No UI test/spec files were found under `ui/`.
- `scripts/generate-openapi.ts:1` imports `src/http/agents` and regenerates both `openapi.json` and docs-site API reference content.
- Generated API reference includes runtime and credential-status operations in `docs-site/content/docs/api-reference/agents.mdx:7`.
- Related docs/runbooks include `runbooks/harness-providers.md:7`, `docs-site/content/docs/(documentation)/guides/harness-providers.mdx:210`, `docs-site/content/docs/(documentation)/guides/harness-configuration.mdx:21`, and `docs-site/content/docs/(documentation)/guides/worker-credential-recovery.mdx:76`.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/http/agents.ts` | 82 | Runtime update request schema with `harness_provider`, `model`, `allow_custom_model` |
| `src/http/agents.ts` | 510 | Runtime handler updates harness provider and scoped config |
| `src/types.ts` | 499 | `AgentLatestModelSchema` and credential latest-model shape |
| `src/providers/types.ts` | 80 | `ProviderSessionConfig` currently includes `model`, not reasoning/effort |
| `src/commands/runner.ts` | 2158 | Runtime model resolution from task model and `MODEL_OVERRIDE` |
| `src/commands/provider-credentials.ts` | 448 | Worker latest-model reporting endpoint call |
| `src/providers/claude-adapter.ts` | 756 | Claude adapter model handling and `--model` launch path |
| `src/providers/codex-adapter.ts` | 1205 | Codex adapter resolved model passed to SDK/thread options |
| `src/providers/pi-mono-adapter.ts` | 712 | Pi adapter resolved model passed to session options |
| `src/providers/opencode-adapter.ts` | 590 | Opencode adapter per-task config includes `model` |
| `ui/src/components/shared/agent-runtime-settings.tsx` | 44 | Runtime editor reads current config and latest model |
| `ui/src/components/shared/agent-runtime-settings.tsx` | 307 | Inline model combobox implementation |
| `ui/src/lib/agent-runtime-models.ts` | 4 | Local harness registry starts here |
| `ui/src/lib/agent-runtime-models.ts` | 102 | Per-harness fallback default model IDs |
| `ui/src/pages/agents/page.tsx` | 42 | Agent list model column reads `credStatus.latestModel` |
| `openapi.json` | 464 | Generated runtime route schema |

## Open Questions

- Cross-harness shape mismatch: Claude is numeric-budget + adaptive, Codex/Pi are qualitative effort levels, Opencode is provider-gated pass-through. Open question: expose one normalized `effort` level cross-harness (with adapter-side translation, the way pi-mono does it internally) or surface per-harness raw knobs (Codex `model_reasoning_effort`, Claude `MAX_THINKING_TOKENS`, etc.). The normalized path is more user-friendly but loses Claude's numeric budgets and Opencode's per-provider keys.
- Per-harness/per-model validity is non-trivial and provider-gated (e.g. Codex `*-codex` models reject `minimal`; `xhigh` only on `gpt-5.1-codex-max`; Anthropic `budget_tokens` min `1024`; OpenRouter `effort` vs `max_tokens` mutually exclusive). Open question: encode validation server-side at runtime-PATCH time, or pass-through and let the harness reject on first run.
- No existing persistence contract for custom reasoning/effort opt-in analogous to `allow_custom_model`. Open question: do we need an `allow_custom_effort` flag, or is the closed set of normalized levels safe to expose without opt-in?
- Default behavior: harnesses disagree on defaults (Claude → adaptive enabled; Codex → `medium`; Pi → `defaultThinkingLevel` setting, often `off`; Opencode → not sent at all). Open question: do we ship a single agent-swarm default (probably `medium`) or honor each harness's native default when the setting is unset.
- Persistence shape: store as another scoped `swarm_config` key (e.g. `REASONING_EFFORT`) alongside `MODEL_OVERRIDE`, or extend `agents.cred_status.latestModel` to also carry the last-used effort.
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
- Harness changes affect future sessions via runner config reconciliation; current sessions keep the provider config they were launched with.
- The runtime editor is agent-detail scoped; the agents list is a read surface for latest-used model.
- The dashboard already treats harness and model as one runtime settings unit.

### GitHub Permalinks

- `src/http/agents.ts` runtime route: https://github.com/desplega-ai/agent-swarm/blob/5d34deaf8eb6872ea450f461007ab6cc8b7a5e02/src/http/agents.ts#L82
- `src/providers/types.ts` provider session config: https://github.com/desplega-ai/agent-swarm/blob/5d34deaf8eb6872ea450f461007ab6cc8b7a5e02/src/providers/types.ts#L80
- `src/commands/runner.ts` model resolution: https://github.com/desplega-ai/agent-swarm/blob/5d34deaf8eb6872ea450f461007ab6cc8b7a5e02/src/commands/runner.ts#L2158
- `ui/src/components/shared/agent-runtime-settings.tsx` editor: https://github.com/desplega-ai/agent-swarm/blob/5d34deaf8eb6872ea450f461007ab6cc8b7a5e02/ui/src/components/shared/agent-runtime-settings.tsx#L44
- `ui/src/lib/agent-runtime-models.ts` model registry: https://github.com/desplega-ai/agent-swarm/blob/5d34deaf8eb6872ea450f461007ab6cc8b7a5e02/ui/src/lib/agent-runtime-models.ts#L4

### Historical Context

- Memory for the earlier runtime model-control rollout says the durable boundary is desired settings in agent-scoped `swarm_config` and worker-reported truth in `agents.cred_status`.
- That same rollout captured prior user decisions: future-only changes, all local harnesses, strict defaults with explicit custom-model opt-in, detail-page editing, and harness+model as one runtime unit.
