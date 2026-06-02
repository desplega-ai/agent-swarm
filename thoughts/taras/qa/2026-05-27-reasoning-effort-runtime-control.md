---
date: 2026-05-27T00:00:00+02:00
author: Claude
git_commit: 5d34deaf8eb6872ea450f461007ab6cc8b7a5e02
branch: main
repository: agent-swarm
topic: "QA scenarios for reasoning/effort runtime control (Phase 5 UI + cross-harness verification)"
tags: [qa, runtime-settings, harness-providers, ui, reasoning-effort]
status: draft
last_updated: 2026-05-27
last_updated_by: Claude
related_plan: thoughts/taras/plans/2026-05-27-agent-reasoning-effort-runtime-control.md
related_research: thoughts/taras/research/2026-05-26-agent-reasoning-effort-runtime-control.md
---

# QA: Reasoning/Effort Runtime Control

## Context

Plan: `thoughts/taras/plans/2026-05-27-agent-reasoning-effort-runtime-control.md`. Phase 5 introduces a UI effort selector next to the model picker in `AgentRuntimeSettings`, with per-(harness, model) capability grey-out and persistence through `PATCH /api/agents/{id}/runtime`. This doc holds the cross-harness × level verification scenarios — referenced from the plan's Phase 5 QA Spec block.

Local environment per `runbooks/local-development.md`:
- API on `http://localhost:3013` (or `https://api.swarm.localhost:1355` via `bun run dev:http`)
- UI on `http://localhost:5274`
- Lead + worker via `bun run pm2-start`

## Scope

### In Scope

- The UI effort selector in `AgentRuntimeSettings` (segmented control, grey-out, tooltip, save flow).
- API behavior under `PATCH /api/agents/{id}/runtime` for the new `reasoning_effort` field (200, 400 on bad combos, null-clear).
- Adapter-level transport verification per harness (env / SDK config / session options / per-task JSON).
- Last-used effort surfaced in `HarnessCell` tooltip and agent-list view.
- Persistence: value survives page reload, harness change preserves effort if still valid.

### Out of Scope

- Telemetry accuracy of `reasoning_output_tokens` / `thinkingTokens` (existing cost telemetry path, unchanged by this feature).
- Devin / claude-managed harnesses (not in v1 surface).
- Programmatic reasoning level changes via task body (per-task overrides explicitly excluded).
- Numeric budget knobs (`MAX_THINKING_TOKENS`, etc. — out of scope per plan).

## Test Cases

> Each case: **Steps → Expected → Actual → Status**. Fill in Actual + Status during execution. Capture screenshots into `thoughts/taras/qa/screenshots/2026-05-27-reasoning-effort/` and reference by filename in Evidence.

### TC-01: Claude — set effort to `high`, persist, dispatch task, verify env

- **Steps**:
  1. Create or pick an existing agent with `harness=claude`, `model=claude-opus-4-7`.
  2. Open `/agents/<id>` → runtime editor.
  3. Set effort to `high` in the segmented control. Save.
  4. Reload the page.
  5. Dispatch a no-op task to the agent (e.g. "echo hi").
  6. Tail worker logs for the spawn env.
- **Expected**: (a) UI shows `high` selected after reload. (b) `swarm_config` has `REASONING_EFFORT_OVERRIDE=high` for the agent scope. (c) Worker logs show child env contains `CLAUDE_CODE_EFFORT_LEVEL=high`. (d) After task completion, `HarnessCell` tooltip / agent-list shows last-used effort `high`.
- **Actual**:
- **Status**:

### TC-02: Claude — `off` on Opus 4.7 is greyed out

- **Steps**:
  1. Same agent as TC-01 (Opus 4.7).
  2. Open the effort selector.
- **Expected**: `off` segment is greyed/disabled with a tooltip explaining "Claude Opus 4.7 doesn't support 'off' — use 'low' instead." Other segments (`low|medium|high|xhigh`) are selectable.
- **Actual**:
- **Status**:

### TC-03: Claude — `off` on Sonnet 4.6 sets `MAX_THINKING_TOKENS=0`

- **Steps**:
  1. Change agent model to a Sonnet 4.6 variant (or Opus 4.6 if available).
  2. Set effort to `off`. Save. Dispatch a task.
  3. Inspect worker logs for spawn env.
- **Expected**: Child env contains `MAX_THINKING_TOKENS=0` and no `CLAUDE_CODE_EFFORT_LEVEL` (or it's unset). `off` is selectable on this model.
- **Actual**:
- **Status**:

### TC-04: Codex — set effort to `high` on `gpt-5.1-codex`, verify SDK config

- **Steps**:
  1. Pick / create agent with `harness=codex`, `model=gpt-5.1-codex`.
  2. Set effort to `high`. Save. Dispatch task.
  3. Intercept the Codex SDK config (add temporary log in `codex-adapter.ts` if needed) and check the `config` map.
- **Expected**: SDK config map contains `model_reasoning_effort: 'high'`. Task runs normally.
- **Actual**:
- **Status**:

### TC-05: Codex — `xhigh` on `gpt-5.1-codex` (non-max) is greyed AND 400s

- **Steps**:
  1. Same agent as TC-04 (`gpt-5.1-codex`, non-max).
  2. UI: open effort selector — `xhigh` should be greyed with tooltip.
  3. API: `curl -X PATCH .../api/agents/{id}/runtime -d '{"reasoning_effort":"xhigh"}'`.
- **Expected**: (a) UI grey-out present. (b) API responds 400 with `{ error, harness, model: 'gpt-5.1-codex', level: 'xhigh', allowed: ['off','low','medium','high'] }`.
- **Actual**:
- **Status**:

### TC-06: Codex — `xhigh` on `gpt-5.1-codex-max` is allowed

- **Steps**:
  1. Change model to `gpt-5.1-codex-max`.
  2. Set effort to `xhigh`. Save. Dispatch task.
  3. Check SDK config.
- **Expected**: UI allows `xhigh`. API 200. SDK config contains `model_reasoning_effort: 'xhigh'`.
- **Actual**:
- **Status**:

### TC-07: Codex — `minimal` not exposed in UI

- **Steps**:
  1. With Codex harness, open the effort selector on any model.
- **Expected**: No `minimal` segment present (plan v1 doesn't expose it).
- **Actual**:
- **Status**:

### TC-08: Pi — set effort to `medium` on default Pi model, verify session options

- **Steps**:
  1. Pick / create agent with `harness=pi`, `model=openrouter/google/gemini-3-flash-preview`.
  2. Set effort to `medium`. Save. Dispatch task.
  3. Add temporary log around `createAgentSession` call in `pi-mono-adapter.ts` to capture options.
- **Expected**: `createAgentSession` options include `thinkingLevel: 'medium'`. Task runs.
- **Actual**:
- **Status**:

### TC-09: Pi — `off` clears thinking on a model that supports it

- **Steps**:
  1. Same Pi agent. Change to a reasoning-capable model (e.g. `openrouter/anthropic/claude-sonnet-4-6`).
  2. Set effort to `off`. Save. Dispatch task.
- **Expected**: `createAgentSession` options include `thinkingLevel: 'off'`. No `MAX_THINKING_TOKENS` (Pi handles internally).
- **Actual**:
- **Status**:

### TC-10: Opencode — set effort on Anthropic-backed model, verify per-task JSON

- **Steps**:
  1. Agent with `harness=opencode`, `model=anthropic/claude-sonnet-4-6`.
  2. Set effort to `high`. Save. Dispatch task.
  3. Inspect the generated per-task `opencode.json` (path in worker logs / workspace).
- **Expected**: `opencode.json` contains `provider.anthropic.models["claude-sonnet-4-6"].options.thinking = { type: "enabled", budgetTokens: <appropriate-int> }`.
- **Actual**:
- **Status**:

### TC-11: Opencode — set effort on OpenAI-backed model, verify per-task JSON

- **Steps**:
  1. Same agent, model `openai/gpt-5.1-codex-max` (or similar OpenAI reasoning model).
  2. Set effort to `xhigh`. Save. Dispatch task.
- **Expected**: `opencode.json` contains `provider.openai.models[...].options.reasoningEffort = "xhigh"`.
- **Actual**:
- **Status**:

### TC-12: Opencode — set effort on OpenRouter-backed model

- **Steps**:
  1. Same agent, model `openrouter/qwen/qwen3-coder-flash`.
  2. Set effort to `low`. Save. Dispatch task.
- **Expected**: `opencode.json` contains `provider.openrouter.models[...].options.reasoning = { effort: "low" }`.
- **Actual**:
- **Status**:

### TC-13: Persistence — value survives reload

- **Steps**:
  1. Set effort on any agent. Save.
  2. Hard-reload the page (Cmd-Shift-R).
- **Expected**: Selected level is restored after reload.
- **Actual**:
- **Status**:

### TC-14: Clearing — `PATCH reasoning_effort: null` removes row

- **Steps**:
  1. Set effort to `high` on an agent. Verify `swarm_config` row exists.
  2. `curl -X PATCH .../api/agents/{id}/runtime -d '{"reasoning_effort":null}'`.
  3. Reload UI. Inspect `swarm_config`.
- **Expected**: API 200. UI shows no effort selected. `swarm_config` row removed.
- **Actual**:
- **Status**:

### TC-15: Symmetric `MODEL_OVERRIDE` clearing (scope-expanded fix)

- **Steps**:
  1. PATCH agent with `model: 'custom-model-string'` then with `model: null`.
- **Expected**: API 200 on both. `MODEL_OVERRIDE` row removed after the `null` PATCH.
- **Actual**:
- **Status**:

### TC-16: Hot reconciliation — running worker picks up effort change without restart

- **Steps**:
  1. Worker running. PATCH agent with `reasoning_effort: 'high'`.
  2. Dispatch a task without restarting the worker.
  3. Tail worker logs.
- **Expected**: Worker resolves the new value from the next `/api/config/resolved` call (because `REASONING_EFFORT_OVERRIDE` is in `RELOADABLE_ENV_KEYS`). Adapter receives the level.
- **Actual**:
- **Status**:

### TC-17: Harness switch — model changes, effort cleared if no longer valid

- **Steps**:
  1. Agent with Codex + `gpt-5.1-codex-max` + effort `xhigh`.
  2. Change model to `gpt-5.1-codex` (non-max) in the UI without first clearing effort.
- **Expected**: UI clears the effort field (does not silently coerce). User must re-select a valid level. Tooltip on `xhigh` segment explains why it's no longer available.
- **Actual**:
- **Status**:

### TC-18: additionalArgs precedence — `--effort` wins over runtime UI (Claude)

- **Steps**:
  1. Claude agent with `reasoning_effort=low` set in UI.
  2. Add `--effort high` to `additionalArgs` (via agent config).
  3. Dispatch task. Inspect spawn args + env.
- **Expected**: Both `--effort high` in args AND `CLAUDE_CODE_EFFORT_LEVEL=low` in env. Claude CLI's documented precedence applies — `--effort high` wins. Worker logs show no warning (per plan choice: document the interaction, don't enforce).
- **Actual**:
- **Status**:

### TC-19: Last-used effort displayed in HarnessCell tooltip

- **Steps**:
  1. After TC-01 (Claude with `high`), navigate to `/agents`.
  2. Hover the harness cell for that agent.
- **Expected**: Tooltip shows model + source + effort line ("Effort: high").
- **Actual**:
- **Status**:

### TC-20: Light + dark mode visual check

- **Steps**:
  1. Toggle UI theme. Open runtime editor.
- **Expected**: Effort selector readable in both modes; grey-out tooltip visible.
- **Actual**:
- **Status**:

## Evidence

- Screenshots directory: `thoughts/taras/qa/screenshots/2026-05-27-reasoning-effort/`
  - Reference each TC's UI screenshots by filename here as they're captured (e.g. `tc-02-claude-off-greyed.png`).
- Worker log excerpts: capture relevant lines per TC; either inline as fenced blocks or link to a `qa/logs/` file.
- Curl response bodies for TC-05, TC-14, TC-15 (paste here).
- External links: link to the implementation PR(s) once opened.

## Verdict

_Filled after execution._

- **Overall status**: PENDING
- **Summary**: [one paragraph: what worked, what didn't, anything to revisit]
- **Blockers**: [list any TC failures that block ship]
- **Follow-ups**: [non-blocking issues spotted during QA]
