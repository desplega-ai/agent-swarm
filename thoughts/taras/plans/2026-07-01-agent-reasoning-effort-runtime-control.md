---
date: 2026-07-01T00:00:00+02:00
planner: Claude
git_commit: 0a5384918c152c626e4f957964671a38c69ee455
branch: main
repository: agent-swarm
topic: "Agent reasoning/effort runtime control implementation plan (refresh)"
tags: [plan, runtime-settings, harness-providers, ui, reasoning-effort]
status: completed
autonomy: critical
commit_per_phase: true
ref_baseline_commit: 0a5384918c152c626e4f957964671a38c69ee455
supersedes: thoughts/taras/plans/2026-05-27-agent-reasoning-effort-runtime-control.md
last_updated: 2026-07-01
last_updated_by: Claude (Phase 6 execution)
---

# Agent Reasoning/Effort Runtime Control Implementation Plan (Refresh)

_Scaffolded — sections fill in as planning proceeds. Supersedes the 2026-05-27 draft plan, which was baselined at a much older commit (6e6d82c2) and contains stale line references, one factual error (HarnessCell tooltip), and an outdated capability-table assumption. See `thoughts/taras/research/2026-05-26-agent-reasoning-effort-runtime-control.md` (refreshed 2026-07-01) for the full current-state research this plan is built on._

## Overview

Add per-agent reasoning/effort runtime control to the four local harnesses (`claude`, `codex`, `pi`, `opencode`) so users can pin an agent's reasoning intensity from the dashboard, persist it like the existing `MODEL_OVERRIDE`, and translate one normalized level into the harness-specific knob each tool actually accepts.

- **Motivation**: Each harness already exposes a reasoning knob (`/effort` for Claude, `model_reasoning_effort` for Codex, `thinkingLevel` for Pi, provider-gated options for Opencode), but there is no agent-swarm-side surface to set, persist, or display it.
- **Related**: `thoughts/taras/research/2026-05-26-agent-reasoning-effort-runtime-control.md` (refreshed 2026-07-01), `src/http/agents.ts:85-104` (runtime route), `src/providers/types.ts:84-114` (`ProviderSessionConfig`), `ui/src/components/shared/agent-runtime-settings.tsx:45-87` (runtime editor). Supersedes the stale draft at `thoughts/taras/plans/2026-05-27-agent-reasoning-effort-runtime-control.md`.

## Current State Analysis

_All references verified fresh against commit `0a5384918c152c626e4f957964671a38c69ee455` (2026-07-01); see the linked research doc for the full derivation._

- Runtime contract is model-only: `PATCH /api/agents/{id}/runtime` accepts `harness_provider`, `model`, `allow_custom_model` (body schema `src/http/agents.ts:94-98`, route `:85-104`, handler txn `:517-550`). No reasoning field anywhere in the request body, `ProviderSessionConfig` (`src/providers/types.ts:84-114`), or `AgentLatestModelSchema`/`AgentCredStatusSchema` (`src/types.ts:694-701`, `:722-737`).
- The runtime route requires a non-empty `model` string and always upserts — there is no way to clear `MODEL_OVERRIDE` via the API today. Only a row-id-based `deleteSwarmConfig(id)` exists (`src/be/db.ts:6176`); no key-based delete helper. This is a pre-existing gap we extend the fix for (Phase 2).
- Each adapter wires `model` into its harness-specific shape but never sees a reasoning value:
  - Claude — `--model` pushed inside `buildCommand()` (`src/providers/claude-adapter.ts:567-568`); empty-model-defaults-to-opus in `createSession()` (`:910`); `additionalArgs` appended at `:580-582`.
  - Codex — `buildCodexConfig()` sets `model` (`src/providers/codex-adapter.ts:378`) and pins `show_raw_agent_reasoning: false` (`:382`); resolved model also flows into `ThreadOptions` (`:1315-1321`).
  - Pi — `createAgentSession` options built at `src/providers/pi-mono-adapter.ts:977-984`, call site `:987`. Confirmed: `thinkingLevel?: ThinkingLevel` is a **top-level sibling** of `model` on `CreateAgentSessionOptions` per the installed `@mariozechner/pi-coding-agent` `.d.ts` — no nesting needed.
  - Opencode — per-task `opencode.json` `model` field (`src/providers/opencode-adapter.ts:681`).
- Runner resolves model precedence through `resolveTaskModelSelection()` (`src/types.ts:131`, call site `src/commands/runner.ts:2697-2704`), which now includes an intermediate `modelTier` fallback step (task `model` → `modelTier` resolution → `""` → `MODEL_OVERRIDE` → `""`) — **a new step since the original research, and an axis this plan must stay independent of**. Resolved value flows into `ProviderSessionConfig.model` at `runner.ts:2735`. Latest model is reported via `buildLatestModelReport()` (`src/commands/provider-credentials.ts:504`) / `reportLatestModel()` (`:481`), called from `runner.ts:2794-2805` (initial) and `:3082-3090` (post-result).
- `RELOADABLE_ENV_KEYS` (`src/commands/runner.ts`) currently = `{MODEL_OVERRIDE, AGENT_FS_SHARED_ORG_ID, SWARM_USE_CLAUDE_BRIDGE, BEDROCK_AUTH_MODE}` — a new `REASONING_EFFORT_OVERRIDE` key must be added here for hot reconciliation without a worker restart, mirroring `MODEL_OVERRIDE`.
- UI runtime editor (`ui/src/components/shared/agent-runtime-settings.tsx:45-87` reads, `:114-128` save) handles harness + model only; `ModelOption`/`CachedModel` types in `ui/src/lib/agent-runtime-models.ts` carry no reasoning data at all.
- **Capability data, corrected from the earlier draft**: `src/be/modelsdev-cache.json` (canonical; `ui/src/lib/modelsdev-cache.json` is a symlink) has a `reasoning` **boolean** (support gate only) — but many models *also* carry a `reasoning_options` array that can enumerate real levels, e.g. `{ type: "effort", values: ["none","low","medium","high","max"] }`. The prior draft assumed levels must be 100% hand-authored; that's no longer the right default assumption (see Implementation Approach).
- **Two UI surfaces already display `latestModel`, both viable for a last-used-effort echo** (the prior draft incorrectly ruled one out): `HarnessCell`'s `CredBreakdown` tooltip already renders a "Latest model" row (`ui/src/components/shared/harness-cell.tsx:161-169`), and the agents-list Model column now goes through `getAgentModelDisplay()`/`getAgentModelPresentation()` (`ui/src/lib/agents-list-model-display.ts:22`, `:37`, called from `ui/src/pages/agents/page.tsx:61-93`).
- Cost telemetry already exposes `reasoningOutputTokens` (`src/providers/types.ts:16`) / `thinkingTokens` (`:18`) — orthogonal to the requested level, reused as-is for validating a level "took effect."

## Desired End State

- `PATCH /api/agents/{id}/runtime` accepts `reasoning_effort` ∈ `{ off, low, medium, high, xhigh }`. Server validates `(harness, model, level)` against a hybrid capability lookup and 400s known-bad combos (e.g. `xhigh` on `gpt-5.1-codex` non-max).
- Resolved on the worker: task → agent `swarm_config[REASONING_EFFORT_OVERRIDE]` → unset. When unset, each adapter behaves exactly as it does today (no fleet-wide default injected) — this resolution is independent of the `modelTier` fallback step now present in `resolveTaskModelSelection()`.
- All four adapters translate the normalized level into harness-specific shape (env var / SDK config / session option / per-task JSON).
- `agents.cred_status.latestModel.reasoningEffort` echoes the level the adapter actually applied.
- UI: an effort selector sits next to the model picker in the agent detail runtime editor, with per-model grey-out. Last-used effort is visible in three places: the runtime editor (configured + last-used), the `HarnessCell` tooltip (new row next to "Latest model"), and the agents-list Model column (compact ASCII `[|||]`-style badge next to the model name, full detail on hover).
- Docs (`runbooks/harness-providers.md`, `docs-site/.../guides/harness-providers.mdx`) and `openapi.json` reflect the new field.

**How to verify**: spin up the API + UI locally, pick each harness in turn, set effort to `high` in the editor, dispatch a task, and confirm in the worker logs that the adapter forwarded the correct knob (Claude env, Codex config, Pi option, Opencode JSON). For `xhigh` on `gpt-5.1-codex` (non-max), the UI should grey out and the API should 400.

## What We're NOT Doing

- **`minimal` and `max`** levels — `minimal` is rejected by Codex `*-codex` models and `max` has known persistence bugs on Claude (anthropics/claude-code#30726). Skip for v1.
- **Numeric budget knobs** (`MAX_THINKING_TOKENS`, Anthropic `budget_tokens`, OpenRouter `max_tokens`) — qualitative-level surface only. Power users can still inject env via `additionalArgs`.
- **Per-task reasoning overrides** — effort is per-agent, mirroring `MODEL_OVERRIDE`.
- **`allow_custom_effort` opt-in flag** — the closed enum is safe to expose without per-agent opt-in.
- **Devin / claude-managed harnesses** — out of scope (research focused on the four local harnesses).
- **`show_raw_agent_reasoning`, `model_reasoning_summary`, `model_verbosity`** — separate Codex knobs not in this feature's surface.
- **A single agent-swarm-wide default** — when unset, harnesses keep their own native defaults (Claude adaptive, Codex `medium`, Pi `defaultThinkingLevel`, Opencode nothing sent); we don't inject a fleet-wide value.

## Implementation Approach

- Single normalized `ReasoningEffort` type and one helper module (`src/providers/reasoning-effort.ts`) own both capability lookup and per-harness translation — adapters consume a discriminated union and merge ~3 lines each.
- **Capability data is hybrid, cache-first**: read `reasoning_options.values` from a slim server-side snapshot (`src/providers/modelsdev-reasoning.json`, generated from the canonical `src/be/modelsdev-cache.json`) where a model has it; layer a small hand-authored override table on top only for per-harness quirks the cache doesn't encode (e.g. Codex `gpt-5.1-codex-max` adding `xhigh`). This replaces the earlier draft's "levels are 100% hand-authored" assumption — less bespoke data to maintain, and it improves automatically as models.dev adds `reasoning_options` to more models.
- **Default behavior is harness-native**: no fleet-wide override. Unset `reasoning_effort` means the adapter behaves exactly as it does today.
- Persistence reuses the existing `swarm_config` pattern — new key `REASONING_EFFORT_OVERRIDE` upserted in the same transaction as `MODEL_OVERRIDE`; no schema migration needed. Its resolution chain stays independent of the `modelTier` fallback step now present in model resolution — the two axes (which model vs. how hard it thinks) must not be conflated.
- Telemetry reuses `agents.cred_status` JSON column — `AgentLatestModelSchema` gets an optional `reasoningEffort` field; no migration.
- UI surfaces last-used effort in three places, all additive to surfaces that already show `latestModel` today: the runtime editor, the `HarnessCell` tooltip, and the agents-list Model column (compact ASCII `[|||]`-style badge, hover for full detail).
- Sequencing: helper → API contract → runner plumbing → adapters → UI editor → UI display surfaces + docs. Each phase is independently verifiable and produces a working slice.

## Quick Verification Reference

- Backend tests: `bun test src/tests/agents-harness-provider.test.ts src/tests/credential-status-api.test.ts src/tests/model-control.test.ts`
- Adapter tests: `bun test src/tests/claude-adapter.test.ts src/tests/codex-adapter.test.ts src/tests/pi-mono-adapter.test.ts src/tests/opencode-adapter.test.ts`
- Helper tests (new): `bun test src/tests/reasoning-effort.test.ts`
- Lint + types: `bun run lint && bun run tsc:check`
- DB boundary: `bash scripts/check-db-boundary.sh`
- OpenAPI drift: `bun run docs:openapi` (commit regenerated `openapi.json` + `docs-site/content/docs/api-reference/**`)
- UI: `cd ui && pnpm lint && pnpm exec tsc -b`

---

## Phase 1: Reasoning-effort helper module

### Overview

Create `src/providers/reasoning-effort.ts` exposing a normalized `ReasoningEffort` type, a hybrid (cache-first) per-(harness, model) capability lookup, and a translator that returns a discriminated union telling each adapter where to write what. No behavior changes elsewhere — pure module + unit tests.

### Changes Required:

#### 1. Normalized type + capability + translator

**File**: `src/providers/reasoning-effort.ts` (new)
**Changes**:
- Export `REASONING_EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const` and `ReasoningEffort` type.
- Export `reasoningCapability(harness, model): { supported, levels, default }`. Resolution order: (1) look up the model in `modelsdev-reasoning.json` — if `reasoning: false`, return `{ supported: false, levels: [], default: null }`; (2) if the model has a `reasoning_options` entry of `type: "effort"`, intersect its `values` with our exposed enum (map `"none"` → `"off"`, drop `minimal`/`max` — out of scope) to produce `levels`; (3) if `reasoning: true` but no usable `reasoning_options.effort` entry, fall back to the **shared-safe subset `{ low, medium, high }`** — the vocabulary the research doc's cross-harness normalization table confirms all four harnesses accept on their default models (not each harness's full native vocabulary, which the cache didn't confirm for this specific model); (4) apply a harness-specific override table on top for known quirks not captured by the cache (Codex `*-codex` non-max excludes `xhigh`; `gpt-5.1-codex-max` includes it; Claude Opus 4.7 excludes `off`).
- Export `applyReasoningEffort(harness, model, level)` returning a discriminated union: `claude-env { env }`, `codex-config { config }`, `pi-session { sessionOptions }`, `opencode-options { providerId, modelId, options }`, or `noop`.
- Per-harness mapping documented inline (Claude `off` → `MAX_THINKING_TOKENS=0` env + unset effort on legacy models, reject/noop on Opus 4.7; Codex `off` → `model_reasoning_effort: 'none'`; Pi `off` → `thinkingLevel: 'off'`; Opencode `off` → omit reasoning keys).

#### 2. Capability data + harness override table

**Files**: `src/providers/reasoning-effort.ts` + `src/providers/modelsdev-reasoning.json` (new slim snapshot) + `scripts/refresh-modelsdev-pricing.ts` (extend)
**Changes**:
- New `src/providers/modelsdev-reasoning.json` — slim subset of the canonical `src/be/modelsdev-cache.json` (NOT the `ui/` symlink) containing `{ id, reasoning: boolean, reasoningOptions?: Array<{ type: string; values?: string[] }> }` per model. A dedicated `src/providers/` snapshot keeps the helper self-contained: `src/providers/` reads neither `src/be/` nor `ui/` at runtime, and has no DB import (runs on workers).
- Extend `scripts/refresh-modelsdev-pricing.ts` — which already writes the canonical `src/be/modelsdev-cache.json` — to ALSO emit `src/providers/modelsdev-reasoning.json` from the same fetched data. Commit both snapshots together; CI drift check covers both.
- Harness override table encodes only what the cache can't: Codex `*-codex` (non-`max`) excludes `xhigh`; `gpt-5.1-codex-max` includes it; Claude Opus 4.7 excludes `off`. Keep this table small — it exists to patch cache gaps, not duplicate the cache.
- Helper loads `modelsdev-reasoning.json` lazily at module load (no DB import — runs on workers too).

#### 3. Unit tests

**File**: `src/tests/reasoning-effort.test.ts` (new)
**Changes**:
- Cache-sourced levels: a model with `reasoning_options: [{type:"effort", values:[...]}]` → `levels` come from that array (mapped/filtered), not the hand-authored fallback.
- Fallback levels: a model with `reasoning: true` but no `reasoning_options.effort` entry → `levels` come from the per-harness hand-authored fallback, then the override table.
- Boolean gate: a model with `reasoning: false` → `{ supported: false, levels: [] }` for every harness regardless of the override table.
- `applyReasoningEffort` shape assertions per harness for each level, including `off` and `xhigh` gating.
- `applyReasoningEffort` returns `noop` when `level` is `undefined`, OR when the `(harness, model)` pair has no capability data (custom-model strings, legacy stored configs predating the API validation in Phase 2) — defense-in-depth; primary rejection lives at the API layer (Phase 2).

### Success Criteria:

#### Automated Verification:
- [x] Helper tests pass: `bun test src/tests/reasoning-effort.test.ts`
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] DB boundary unchanged: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [x] Helper-only smoke script (one-off `bun run`) prints output for representative tuples: `(claude, claude-opus-4-8, high)`, `(codex, gpt-5.1-codex-max, xhigh)`, `(codex, gpt-5.1-codex, xhigh)`, `(pi, openrouter/google/gemini-3-flash-preview, medium)`, `(opencode, openrouter/qwen/qwen3-coder-flash, low)`. Confirm: shapes match the discriminated union; for the Codex `xhigh`-on-non-max case `applyReasoningEffort` returns `noop` AND `reasoningCapability` excludes `xhigh` from `levels`.

#### Manual Verification:
- [ ] Skim the override table for accuracy against the research doc's per-harness sections.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 1] add reasoning-effort helper module`.

---

## Phase 2: API contract + storage

### Overview

Extend `PATCH /api/agents/{id}/runtime` to accept `reasoning_effort`, validate against `reasoningCapability()`, and upsert the agent-scoped `swarm_config` row `REASONING_EFFORT_OVERRIDE` alongside `MODEL_OVERRIDE`. Add `reasoningEffort` to `AgentLatestModelSchema`. Regenerate OpenAPI.

### Changes Required:

#### 1. Request schema + handler

**File**: `src/http/agents.ts`
**Changes**:
- Add `reasoning_effort: ReasoningEffortSchema.nullable().optional()` to the runtime body at `src/http/agents.ts:94-98` (sibling of `model`). `null` = clear; omitted = leave unchanged; non-null = set.
- Relax the existing `model` field in the same schema to `z.string().trim().min(1).nullable().optional()` so `model: null` clears `MODEL_OVERRIDE` symmetrically (closes the pre-existing gap noted in Current State Analysis).
- In the handler (`src/http/agents.ts:517-550`), when `reasoning_effort` is a non-null string, call `reasoningCapability(harness, model)`; if the requested level isn't in `levels`, return 400 with `{ error, harness, model, level, allowed }`.
- On success with non-null value: upsert `swarm_config` row with key `REASONING_EFFORT_OVERRIDE`, scope `agent`, scopeId `agentId`. Same transaction as `HARNESS_PROVIDER` + `MODEL_OVERRIDE` (`:520-543`).
- On `reasoning_effort: null` (or `model: null`): call the new `deleteSwarmConfigByKey` helper (§4).
- **Note**: Until Phase 3 ships, a PATCH'd `REASONING_EFFORT_OVERRIDE` is a silent no-op on the worker side (runner doesn't read it yet). Acceptable given the contract-first phasing — call it out in the Phase 2 commit message.

#### 2. Latest-model schema extension

**File**: `src/types.ts`
**Changes**:
- Extend `AgentLatestModelSchema` at `src/types.ts:694-701` with optional `reasoningEffort: ReasoningEffortSchema.optional()`.
- Add `ReasoningEffortSchema` (Zod enum mirroring the helper constant) exported from this module.
- Extend `PUT /api/agents/{id}/credential-status` body to accept `reasoning_effort` inside `latest_model` (body schema at `src/http/agents.ts:210-226`, field at `:225`); merge into `cred_status` without clobbering in the merge block at `src/http/agents.ts:602-632`.

#### 3. Route tests

**File**: `src/tests/agents-harness-provider.test.ts`
**Changes**:
- Happy path: PATCH with `reasoning_effort: 'high'` for a supported (harness, model) — assert 200, `swarm_config` row present, response echoes value.
- Validation failure: PATCH `xhigh` on `gpt-5.1-codex` (non-max) — assert 400 with `allowed` array.
- Clearing: PATCH with `reasoning_effort: null` — assert `swarm_config` row removed.
- Symmetric `MODEL_OVERRIDE` clearing: PATCH with `model: null` — assert `MODEL_OVERRIDE` row removed (regression coverage for the scope-expanded fix).
- Credential-status echo: PUT `latest_model.reasoning_effort` — assert merged into `cred_status`.

#### 4. New `deleteSwarmConfigByKey` helper

**File**: `src/be/db.ts`
**Changes**:
- Add `deleteSwarmConfigByKey(scope: ConfigScope, scopeId: string, key: string): void` near `upsertSwarmConfig()` (`src/be/db.ts:6064`). The existing `deleteSwarmConfig(id)` (`src/be/db.ts:6176`) takes a row id, which the runtime handler doesn't have — this is the gap.
- Used by the runtime handler for both `model: null` and `reasoning_effort: null`. The fix scope-expands to cover `MODEL_OVERRIDE` clearing, which was previously impossible via the API.
- Unit-test the helper directly in `src/tests/agents-harness-provider.test.ts` (no-op on missing row, removes existing row).

#### 5. OpenAPI regeneration

**File**: `openapi.json` + `docs-site/content/docs/api-reference/agents.mdx`
**Changes**: Run `bun run docs:openapi` and commit regenerated files.

### Success Criteria:

#### Automated Verification:
- [x] Route tests pass: `bun test src/tests/agents-harness-provider.test.ts src/tests/credential-status-api.test.ts`
- [x] Type check + lint: `bun run tsc:check && bun run lint`
- [x] OpenAPI is up to date (no diff after regen): `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference/`

#### Automated QA:
- [x] Curl walkthrough script: `PATCH /api/agents/{id}/runtime` with each level (off/low/medium/high/xhigh) against a Claude agent → assert 200 and `GET /api/config/resolved?agentId=...` includes `REASONING_EFFORT_OVERRIDE` row with expected value. Repeat one negative case (`xhigh` on non-`max` Codex) → expect 400.

#### Manual Verification:
- [ ] Review the validation 400 error shape (field names, error message) — confirm the UI can render it cleanly.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 2] runtime API accepts reasoning_effort`.

---

## Phase 3: Runner resolution + ProviderSessionConfig wiring

### Overview

Plumb `reasoningEffort` through `ProviderSessionConfig`, the runner's config resolution path (kept independent of the `modelTier` fallback step), and the latest-model telemetry report. After this phase the wire carries the value end-to-end; adapters can read but still ignore it.

### Changes Required:

#### 1. ProviderSessionConfig

**File**: `src/providers/types.ts`
**Changes**: Add `reasoningEffort?: ReasoningEffort` to `ProviderSessionConfig` at `:84-114`.

#### 2. Runner resolution + live reconciliation

**File**: `src/commands/runner.ts`
**Changes**:
- **Confirmed clean insertion point** (verified by direct read during plan review): `freshEnv` — the resolved config blob — is already in scope at `:2675-2696`, immediately before the existing `configModel = (freshEnv.MODEL_OVERRIDE as string | undefined) || ""` line (`:2696`) and the `resolveTaskModelSelection()` call (`:2697-2704`). Add a sibling line there: `const reasoningEffortOverride = (freshEnv.REASONING_EFFORT_OVERRIDE as string | undefined) || undefined;`. Do NOT route it through `resolveTaskModelSelection()` (`src/types.ts:131`) — that function is a narrow, pure `{model, source}` resolver with no generic override mechanism to hook into, and no `modelTier`-equivalent for effort exists or is wanted (see Implementation Approach). The two axes resolve independently, side by side.
- Precedence: task field (if introduced later — currently always undefined) → `REASONING_EFFORT_OVERRIDE` → undefined. Add `reasoningEffort: reasoningEffortOverride` to the `ProviderSessionConfig` object literal at `src/commands/runner.ts:2732-2752` (confirmed exact object bounds).
- Add `'REASONING_EFFORT_OVERRIDE'` to the `RELOADABLE_ENV_KEYS` set at `src/commands/runner.ts:475-480` (currently `{MODEL_OVERRIDE, AGENT_FS_SHARED_ORG_ID, SWARM_USE_CLAUDE_BRIDGE, BEDROCK_AUTH_MODE}`). Without this, hot reconciliation won't pick up effort changes — workers would need a restart between PATCH and the next session.
- **In-flight sessions are unaffected by design, confirmed against the existing mechanism this mirrors**: the main poll loop's live `HARNESS_PROVIDER` reconciliation (`applySwarmConfigDrift()`, called at `:4782`) carries an explicit comment at `:4773-4776` — *"in-flight sessions hold their own `ProviderSession` references and continue on the old adapter unaffected. New spawns... read the current adapter binding and pick up the swap."* Because `ProviderSessionConfig` (including `env` and the new `reasoningEffort`) is captured once per task at `fetchResolvedEnv()` time (`:2675`) and never mutated afterward, a `REASONING_EFFORT_OVERRIDE` change behaves identically: it takes effect on the next task/session, never mid-flight. No rollback or live-patch handling is needed — this is the same trust boundary `MODEL_OVERRIDE` already relies on.
- **Harness-switch edge case**: if an agent's `harness_provider` changes while a `REASONING_EFFORT_OVERRIDE` is set to a level the new harness/model doesn't support, `applyReasoningEffort()` (Phase 1) returns `noop` for that pair — the stale value is silently ignored rather than erroring. This mirrors how `MODEL_OVERRIDE` already survives harness switches untouched today (the two `swarm_config` keys are independent; no cross-clearing logic exists or is needed).

#### 3. Latest-model telemetry

**File**: `src/commands/provider-credentials.ts`
**Changes**:
- Extend `buildLatestModelReport()` at `:504` to accept an optional `reasoningEffort` and include it in the payload.
- Extend `reportLatestModel()` at `:481` to forward the field.
- Runner calls at `src/commands/runner.ts:2794-2805` (initial report) pass the resolved level; `:3082-3090` (post-result) passes the adapter-applied level (from Phase 4's `ProviderResult.appliedReasoningEffort`).

#### 4. Tests

**File**: `src/tests/model-control.test.ts`
**Changes**:
- Resolution precedence test: agent `REASONING_EFFORT_OVERRIDE=high` with no task field → `ProviderSessionConfig.reasoningEffort === 'high'`.
- Independence test: setting both a `modelTier` and `REASONING_EFFORT_OVERRIDE` on the same agent resolves both correctly and independently — neither leaks into the other's resolution.
- Unset case: no override anywhere → `reasoningEffort === undefined`.

### Success Criteria:

#### Automated Verification:
- [x] Resolution tests pass: `bun test src/tests/model-control.test.ts`
- [x] Type check + lint: `bun run tsc:check && bun run lint`
- [x] Worker code does not import DB modules: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [ ] Local E2E (per swarm-local-e2e skill): start API + lead + worker, PATCH an agent with `reasoning_effort: 'high'`, dispatch a no-op task, grep worker logs for `reasoningEffort` in the initial latest-model report payload → expect `"reasoningEffort":"high"`. **Not run this phase** — a full Docker lead+worker dispatch wasn't attempted (background phase-agent, out of scope for spinning up containers). Substituted a scoped live check instead: started the real API server against a throwaway scratch DB, `POST /api/agents`, `PATCH /api/agents/{id}/runtime` with `{harness_provider:"claude", model:"claude-opus-4-8", reasoning_effort:"high"}`, then `GET /api/config/resolved?agentId=...` — confirmed a `REASONING_EFFORT_OVERRIDE` row with `value:"high"` at agent scope, which is the exact endpoint+shape `fetchResolvedEnv()` in `runner.ts` consumes into `freshEnv`. This exercises the real Phase 2 route handler and the Phase 3 consumption boundary end-to-end, but does not exercise a live worker process or confirm the `reportLatestModel()` HTTP call actually lands `reasoningEffort` in `cred_status` from a running worker. Left for human/orchestrator: full swarm-local-e2e dispatch + worker log grep.

#### Manual Verification:
- [ ] Confirm `ProviderSessionConfig.reasoningEffort` is set in worker logs even though no adapter consumes it yet (sanity check the wire).

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 3] runner resolves and reports reasoning_effort`.

---

## Phase 4: Adapter integrations (all four harnesses)

### Overview

Each adapter calls `applyReasoningEffort()` and merges the returned shape into its harness-specific transport. After this phase, dispatching a task with `reasoning_effort` set actually changes the harness's behavior on all four local harnesses.

### Changes Required:

#### 1. Claude adapter

**File**: `src/providers/claude-adapter.ts`
**Changes**:
- In `buildCommand()` (around `:567-568`, where `--model` is pushed onto argv) or the spawn-env construction it feeds into, call `applyReasoningEffort('claude', config.model, config.reasoningEffort)`; if `claude-env`, merge into the spawn env (sets `CLAUDE_CODE_EFFORT_LEVEL` and optionally `MAX_THINKING_TOKENS=0` for `off` on legacy models).
- No CLI flag changes — env-only path per research findings (`--effort` is buggy in `-p` mode).
- **`additionalArgs` precedence**: `additionalArgs` is appended to the Claude CLI args at `:580-582`. If an operator puts `--effort high` in `additionalArgs` while `reasoning_effort=low` is also set via the runtime UI, the CLI flag wins over `CLAUDE_CODE_EFFORT_LEVEL` (Claude CLI's documented precedence). Matches the project's existing "`additionalArgs` is an escape hatch" philosophy; document in Phase 6 rather than enforce in code.

#### 2. Codex adapter

**File**: `src/providers/codex-adapter.ts`
**Changes**:
- In `buildCodexConfig()` (model field at `:378`, `show_raw_agent_reasoning: false` pin at `:382`), call `applyReasoningEffort('codex', ...)`; if `codex-config`, spread `app.config` into the returned config map (sets `model_reasoning_effort`).
- **Reasoning-trace visibility note**: `show_raw_agent_reasoning` stays pinned `false`. Operators setting `reasoning_effort=high` get the cost of reasoning tokens but no visible trace in the UI (only `reasoning_output_tokens` surfaces in cost telemetry). Flag in Phase 6 docs.

#### 3. Pi adapter

**File**: `src/providers/pi-mono-adapter.ts`
**Changes**:
- In the `createAgentSession` options build (`:977-984`, call site `:987`), call `applyReasoningEffort('pi', ...)`; if `pi-session`, merge `app.sessionOptions` into the options object (sets `thinkingLevel` as a top-level key, confirmed sibling of `model` on `CreateAgentSessionOptions`).

#### 4. Opencode adapter

**File**: `src/providers/opencode-adapter.ts`
**Changes**:
- In the `opencodeConfig` build (`:679-689`, `model` field at `:681`), call `applyReasoningEffort('opencode', ...)`; if `opencode-options`, splice `app.options` into `provider[app.providerId].models[app.modelId].options`.
- Helper handles provider parsing (`anthropic/...` → `thinking`, `openai/...` → `reasoningEffort`, `openrouter/...` → `reasoning`).

#### 5. Adapter telemetry — applied-level feedback

**File**: `src/providers/types.ts` + each adapter
**Changes**:
- Extend the adapter return type (`ProviderResult`, in `src/providers/types.ts` — locate near the existing cost/model report fields) with `appliedReasoningEffort?: ReasoningEffort | null`. Mirrors how `event.cost.model` already flows back through the same return type.
- Each adapter, when `applyReasoningEffort` returned a non-noop application, sets `appliedReasoningEffort` to the value it actually used. `noop` cases set `null` (signals "didn't apply — capability rejected or no input").
- Runner reads `result.appliedReasoningEffort` and passes it into `reportLatestModel()` at `src/commands/runner.ts:3082-3090` (post-result report). The initial report at `:2794-2805` uses the resolved value from `ProviderSessionConfig.reasoningEffort`.

#### 6. Adapter tests

**File**: `src/tests/claude-adapter.test.ts`, `src/tests/codex-adapter.test.ts`, `src/tests/pi-mono-adapter.test.ts`, `src/tests/opencode-adapter.test.ts`
**Changes**:
- Each: assert the harness-specific transport carries the expected shape for `reasoningEffort: 'high'` on a representative model.
- Each: assert `undefined` produces unchanged transport.
- Codex: `xhigh` on `gpt-5.1-codex` (non-max) results in `noop` and the SDK config does NOT include `model_reasoning_effort`.

### Success Criteria:

#### Automated Verification:
- [x] All four adapter test files pass: `bun test src/tests/claude-adapter.test.ts src/tests/codex-adapter.test.ts src/tests/pi-mono-adapter.test.ts src/tests/opencode-adapter.test.ts`
- [x] Type check + lint: `bun run tsc:check && bun run lint`

#### Automated QA:
- [x] Per-harness transport assertions exercised at the unit-test level (not a live worker dispatch — see below): for each of `claude`, `codex`, `pi`, `opencode`, setting `reasoningEffort: 'high'` (or a representative level) on `ProviderSessionConfig` and building the transport carries the right knob:
  - Claude: `spyOn(Bun, "spawn")` confirms spawn env includes `CLAUDE_CODE_EFFORT_LEVEL=high` (and `MAX_THINKING_TOKENS=0`/no effort key for `off` on a legacy budget_tokens-capable model).
  - Codex: `buildCodexConfig()` (exported, directly callable) returns `model_reasoning_effort: 'high'`; confirmed `xhigh` on `gpt-5.1-codex` (non-max) is rejected (no key) while `gpt-5.1-codex-max` gets it.
  - Pi: `spyOn(piCodingAgent, "createAgentSession")` confirms the options object passed in includes `thinkingLevel: 'medium'`.
  - Opencode: `mock.module("@opencode-ai/sdk", ...)` + `driveSession()` confirms the config passed to `createOpencode` carries `provider.<providerId>.models.<modelId>.options` with the matching provider-keyed shape (openrouter `reasoning.effort`, anthropic `thinking.budgetTokens`).

#### Manual Verification:
- [ ] For at least one harness (recommend Claude — fastest), run a task that benefits from reasoning at `low` then `high` and eyeball that the output reflects the difference.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 4] adapters honor reasoning_effort`.

---

## Phase 5: UI runtime editor + grey-out

### Overview

Add an effort selector to `AgentRuntimeSettings` next to the model picker, with per-model level gating. Save flow extends `useUpdateAgentRuntime` to send `reasoning_effort`. Configured + last-used values are displayed.

### Changes Required:

#### 1. ModelOption extension

**File**: `ui/src/lib/agent-runtime-models.ts`
**Changes**:
- Extend the model option type with `reasoningLevels?: ReadonlyArray<'off'|'low'|'medium'|'high'|'xhigh'>`.
- Populate `reasoningLevels` via a client-side mirror of the server's hybrid capability logic: read `reasoning_options.values` from the cache where present, fall back to the same hand-authored table used server-side (same trade-off already accepted for the harness/model registry duplication — promote to a shared/server endpoint later if it drifts).
- Both direct registry entries (Claude/Codex) and snapshot-backed groups (Pi/Opencode) populated.

#### 2. Effort selector component

**File**: `ui/src/components/shared/agent-runtime-settings.tsx`
**Changes**:
- Add `effort` to the editor state alongside `harness`/`model`/`customMode` (the `useState` block at `:67-69`).
- Render a 5-segment toggle (off / low / medium / high / xhigh) between the model picker (`:174`/`:329`) and the save button (`:114-128`). Grey out segments not in the selected model's `reasoningLevels` with a tooltip explaining why (e.g. "Claude Opus 4.7 doesn't support 'off' — use 'low' instead").
- When the selected model changes and the current effort isn't in its `reasoningLevels`, clear the effort field (don't auto-coerce silently).
- Display the configured + last-used effort near the existing block at `:205-212`.

#### 3. Mutation payload

**File**: `ui/src/api/client.ts` + `ui/src/api/hooks/use-agents.ts`
**Changes**:
- Extend the runtime route body in `ui/src/api/client.ts:231-252` with `reasoning_effort`.
- `useUpdateAgentRuntime` (`ui/src/api/hooks/use-agents.ts:61`) passes the new field.
- Existing `invalidateQueries` calls (`:72-74`) already cover `agents`/`agent`/`configs` — no change needed.

### Success Criteria:

#### Automated Verification:
- [x] UI lint + types: `cd ui && pnpm lint && pnpm exec tsc -b`
- [x] Backend tests still pass: `bun test`

#### Automated QA:
- [ ] qa-use session per swarm-local-e2e skill: open `/agents/<id>`, change harness to each of the four, set effort to each valid level, save, reload, confirm value persists. For Codex with model `gpt-5.1-codex`, confirm `xhigh` is greyed out with the documented tooltip. Capture screenshots per harness × level matrix into `thoughts/taras/qa/`. **Not run this phase** — background phase-agent has no browser/qa-use access. Left for the orchestrating session to run via `desplega:qa` against the linked QA Spec doc.

#### Manual Verification:
- [ ] Eyeball the segmented control in light + dark mode; confirm the grey-out tooltip is readable and the last-used value updates after a real task.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 5] UI runtime editor surfaces reasoning_effort`.

### QA Spec (optional):

Cross-cutting visual evidence across all four harnesses + multiple models warrants a separate QA doc.

**QA Doc**: `thoughts/taras/qa/2026-07-01-reasoning-effort-runtime-control.md` (generate via `desplega:qa`; scenarios live in the doc, not here).

---

## Phase 6: Display surfaces (HarnessCell + agents-list) + docs + memory

### Overview

Surface last-used effort in the two remaining read surfaces that already show `latestModel` — the `HarnessCell` tooltip and the agents-list Model column — update runbooks/docs, and confirm no OpenAPI drift.

### Changes Required:

#### 1. `HarnessCell` tooltip

**File**: `ui/src/components/shared/harness-cell.tsx`
**Changes**: Add an "Effort" row next to the existing "Latest model" row inside `CredBreakdown` (`:100-194`, latest-model row at `:161-169`), sourced from `credStatus.latestModel.reasoningEffort`. Omit the row entirely when `reasoningEffort` is absent (native-default case).

#### 2. Agents-list Model column — compact ASCII badge

**File**: `ui/src/lib/agents-list-model-display.ts` + `ui/src/pages/agents/page.tsx`
**Changes**:
- Extend `getAgentModelDisplay()` (`:37`) / `getAgentModelPresentation()` (`:22`) to accept `reasoningEffort` and return a compact badge string alongside the existing model label.
- **Badge design** (per user preference — short, ASCII-only, near the model name, full detail on hover; revised during plan review to avoid a UX collision): a bare repeated `"."` (e.g. `gpt-5.5 ...`) reads as a data-grid truncation ellipsis, not an effort indicator — easy to miss or misread. Use bracketed pipes instead: map level → ordinal index `off=0 (no badge), low=1, medium=2, high=3, xhigh=4`; render `` `[${"|".repeat(index)}]` `` immediately after the model label (e.g. `gpt-5.5 [|||]` for `high`, `gpt-5.5 [||||]` for `xhigh`). No badge at all when unset or `off`. The brackets make it unambiguous this is a distinct badge, not truncated text, while staying ASCII-only and preserving the "more repetition = more intensity" gradient. Wrap the cell in a `title`/tooltip showing the full label (e.g. "Reasoning effort: high") plus existing model detail (provider, id) on hover — extend whatever tooltip mechanism `page.tsx` already uses for the Model column (`:61-93`).
- Confirm the badge reads sensibly at both 100% and truncated column widths; if AG Grid clips it, consider a fixed-width monospace cell for this column specifically.

#### 3. Docs

**File**: `runbooks/harness-providers.md` + `docs-site/content/docs/(documentation)/guides/harness-providers.mdx` + `docs-site/content/docs/(documentation)/guides/harness-configuration.mdx`
**Changes**:
- Add a "Reasoning / effort" subsection per harness with: the agent-swarm normalized levels, what each harness does under the hood, gating notes (Claude Opus 4.7 no `off`, Codex `*-codex` no `minimal`/`xhigh` on non-max).
- **Claude section**: explicit precedence note — `--effort` in `additionalArgs` overrides `CLAUDE_CODE_EFFORT_LEVEL`.
- **Codex section**: explicit note — `show_raw_agent_reasoning` stays `false`; high effort costs reasoning tokens but produces no visible trace in the dashboard.
- Cross-link to `thoughts/taras/research/2026-05-26-agent-reasoning-effort-runtime-control.md`.

#### 4. Memory

**File**: `/Users/taras/.claude/projects/-Users-taras-Documents-code-agent-swarm/memory/`
**Changes**:
- Add a project memory entry noting: `REASONING_EFFORT_OVERRIDE` is the persistence key (added to `RELOADABLE_ENV_KEYS` for hot reconciliation); closed enum is `off|low|medium|high|xhigh`; capability gating is hybrid (models.dev `reasoning_options` first, hand-authored override table for known quirks) in `src/providers/reasoning-effort.ts`; last-used effort is in `cred_status.latestModel.reasoningEffort`, surfaced in the runtime editor + `HarnessCell` tooltip + agents-list `[|||]`-style badge; `deleteSwarmConfigByKey` is the new general-purpose clearing helper.

#### 5. OpenAPI no-drift check

**File**: `openapi.json` + `docs-site/content/docs/api-reference/agents.mdx`
**Changes**: Phases 3-5 don't touch routes, so no regen is expected. Run `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference/` and confirm clean. If there is drift, investigate before merging.

### Success Criteria:

#### Automated Verification:
- [x] UI lint + types: `cd ui && pnpm lint && pnpm exec tsc -b`
- [x] No drift: `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference/`

#### Automated QA:
- [ ] qa-use: navigate `/agents`, hover the harness cell of an agent that ran with `reasoning_effort: 'high'`, screenshot confirming the tooltip shows the effort row. (Skipped — no browser access in this session; also see `feedback_ui_tests_qa_use` memory: this repo's convention is Taras manual-QAs the SPA rather than automated qa-use sessions.)
- [ ] qa-use: navigate `/agents` list view, screenshot the Model column for an agent with `reasoning_effort: 'high'` set — confirm the `[|||]` badge renders next to the model name (not confusable with a truncation ellipsis) and the hover tooltip shows the full label. (Skipped — same reason as above.)
- [x] Read the runbook + guide additions back to confirm they accurately describe each harness's behavior (cross-checked against `thoughts/taras/research/2026-05-26-agent-reasoning-effort-runtime-control.md` and `src/providers/reasoning-effort.ts` — terminology, env var names, and gating rules all match).

#### Manual Verification:
- [ ] Skim the docs in browser preview; confirm code samples use the four normalized levels consistently.
- [ ] Eyeball the `[|||]`-style badge for legibility at actual column width — adjust design if it reads as noise rather than signal.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 6] surface and document reasoning_effort`.

---

## Appendix

- **Plan review (2026-07-01)**: gap-analysis pass applied directly (no separate errata list, per preference) — fixed an unpinned capability fallback default (Phase 1, now `{low,medium,high}`), fixed an ASCII badge design that would've collided visually with truncation ellipsis (Phase 6, now `[|||]`-style), and tightened Phase 3's runner-resolution steps with line numbers confirmed by direct code read (`freshEnv` scope, `ProviderSessionConfig` object bounds, the `applySwarmConfigDrift()` in-flight-session-safety comment). No Critical findings; structure independently verified via `grep` after an automated Haiku structure-check produced a false negative.
- **Follow-up plans**: none planned — feature ships in one plan. If `minimal` / `max` / numeric budgets become needed, they're additive surface extensions to the helper module and editor.
- **Derail notes**:
  - Consider promoting the UI capability lookup to a `/api/runtime/reasoning-capabilities` endpoint if the duplicated table (server hybrid logic vs. client mirror) drifts. Not v1.
  - `show_raw_agent_reasoning` is currently pinned `false` for Codex — surfacing it as a separate per-agent runtime field is a candidate follow-up, unrelated to effort.
  - Surfacing `MAX_THINKING_TOKENS` as an advanced numeric escape hatch in the UI — would let power users dial Claude budgets on legacy Sonnet/Opus 4.6 models. Out of scope but easy follow-up.
  - The Phase 2 `deleteSwarmConfigByKey` fix scope-expands to also patch the latent `MODEL_OVERRIDE` clear gap (PATCH `model: null` now clears the row via the same new helper) — a long-standing UX paper-cut, fixed as a side effect.
- **References**:
  - Research (refreshed 2026-07-01): `thoughts/taras/research/2026-05-26-agent-reasoning-effort-runtime-control.md`
  - Superseded draft: `thoughts/taras/plans/2026-05-27-agent-reasoning-effort-runtime-control.md` (stale line refs, one factual error on `HarnessCell`, outdated capability-table assumption — corrected in this plan)
  - Prior memory entry: runtime model-control rollout (durable boundary: `swarm_config` desired settings + `cred_status` worker-reported truth).
  - Anthropic effort docs: `platform.claude.com/docs/en/build-with-claude/effort`
  - Codex config reference: `developers.openai.com/codex/config-reference`
  - pi-mono SDK: `github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md`
  - Opencode config: `opencode.ai/docs/config/`
