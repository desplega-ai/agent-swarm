---
date: 2026-07-01
author: Claude
topic: "Reasoning/effort runtime control — end-to-end Docker QA + UI verification across all four local harnesses"
tags: [qa, reasoning-effort, docker, harness-providers, ui]
status: pass
source_plan: thoughts/taras/plans/2026-07-01-agent-reasoning-effort-runtime-control.md
related_pr: https://github.com/desplega-ai/agent-swarm/pull/879
environment: local (Docker worker + lead containers for API/worker QA; UI dev server + agent-browser headless Chromium for dashboard QA; both on a scratch DB)
last_updated: 2026-07-01
last_updated_by: Claude
---

**Update (same day):** the ASCII `[|||]` badge and plain-text effort toggle described in TC-6/TC-7/TC-8 below were replaced with an icon-based design per follow-up feedback — see "UI Redesign Follow-up" at the end of this doc for what changed and how it was re-verified. The original TC-6/7/8 write-ups are kept as-is (historically accurate for what shipped and was tested at the time); `01-agents-list.png` is superseded by `01-agents-list-icons.png`.

# Reasoning/Effort Runtime Control — QA Report

Screenshots: [`2026-07-01-reasoning-effort-runtime-control-screens/`](./2026-07-01-reasoning-effort-runtime-control-screens/)

## Context

The 6-phase plan (PR #879) adds per-agent `reasoning_effort` runtime control across `claude`, `codex`, `pi`, `opencode`. The full backend/UI test suite was already green at merge time; this pass validates the **live wiring** — a real API server, a real Docker worker container, real task dispatch per harness, and the credential-status echo — which the unit tests can't exercise end-to-end.

## Scope

### In scope
- `PATCH /api/agents/{id}/runtime` with `reasoning_effort` against a live API server + scratch DB.
- One Docker worker container, switched between all four harnesses via live `HARNESS_PROVIDER` reconciliation (no container restart between legs, except where a different credential set was needed).
- Real task dispatch + completion per harness, with `reasoning_effort: "high"`.
- `agents.cred_status.latestModel.reasoningEffort` echo after each task (the adapter-confirmed value, Phase 4).
- Negative case: `xhigh` on Codex `gpt-5.1-codex` (non-max) → expect 400.

### Out of scope
- Inspecting the raw per-harness transport value in worker stdout (e.g. literally observing `CLAUDE_CODE_EFFORT_LEVEL=high` in the spawned process's env, or `model_reasoning_effort` in the Codex SDK config map) — these aren't printed to container stdout. Relied on the adapter-confirmed `cred_status.latestModel.reasoningEffort` echo as the strongest available signal instead (this field is set by each adapter's own `ProviderResult.appliedReasoningEffort`, so a correct echo implies the adapter's `applyReasoningEffort()` branch actually ran and returned non-noop).

## Environment setup

- Branch: `feat/agent-reasoning-effort-runtime-control` (PR #879, unmerged at QA time).
- API server: `bun run start:http` with `DATABASE_PATH` pointed at a throwaway `/tmp` scratch SQLite file (the real dev `agent-swarm-db.sqlite` was never touched).
- Worker image: rebuilt fresh via `bun run docker:build:worker` to pick up this branch's adapter changes.
- One lead container (`.env.docker-lead`) + one worker container (`.env.docker` + extra `-e` overrides), both with `MCP_BASE_URL=http://host.docker.internal:3013` pointed at the scratch API server.
- Credential gotchas hit and worked around:
  - `.env.docker`'s `CLAUDE_CODE_OAUTH_TOKEN` was stale/invalid ("Invalid API key · Fix external API key" from the live Claude CLI call, despite the boot-time presence check passing). Swapped in the OAuth token from `.env.docker-lead`, which passed the live credential test (`liveTest.ok: true`) and worked for the rest of the run.
  - Root `.env`'s `ANTHROPIC_API_KEY` returned `HTTP 401 invalid x-api-key` on live test — not usable; not this feature's concern (a real/expired-key issue), but worth flagging separately (see Gaps).
  - `.env.docker` lacks `OPENAI_API_KEY` (needed for `codex`) — injected from root `.env` via `docker run -e`, which turned out to be valid.
  - `openrouter/google/gemini-3-flash-preview` (the model used in this feature's own unit tests) 404'd against the real OpenRouter API (`model_not_found`) — switched to `openrouter/deepseek/deepseek-v4-flash` per the `feedback_e2e_test_model_choice` memory entry, which worked for both `pi` and `opencode`.
  - `gpt-5.1-codex` (used in the unit tests and the negative-case test) isn't recognized by the installed Codex CLI ("It may not exist or you may not have access to it") for an actual task dispatch — used `gpt-5.4` (the real default per `harness-configuration.mdx`) for the positive Codex leg instead. The negative case (validation-only, no live model call) still used `gpt-5.1-codex` successfully since that's a pure capability-lookup check against the vendored snapshot, not a live API call.

## Test Cases

### TC-1: Claude — `reasoning_effort: "high"` on `claude-opus-4-8`
**Steps:** PATCH runtime → confirm `REASONING_EFFORT_OVERRIDE=high` in `GET /api/config/resolved` → dispatch "Say hi and nothing else." → wait for completion.
**Result:** PASS. Task completed (`output: "Hi"`). `cred_status.latestModel` = `{model: "claude-opus-4-8", harnessProvider: "claude", reasoningEffort: "high"}`.

### TC-2: Codex — `reasoning_effort: "high"` on `gpt-5.4`
**Steps:** Same flow, harness switched to `codex` on the same worker container (with `OPENAI_API_KEY` injected).
**Result:** PASS. Task completed (`output: "Hi"`). `cred_status.latestModel` = `{model: "gpt-5.4", harnessProvider: "codex", reasoningEffort: "high"}`.

### TC-3: Pi — `reasoning_effort: "high"` on `openrouter/deepseek/deepseek-v4-flash`
**Result:** PASS. Task completed (`output: "Hi"`). `cred_status.latestModel` = `{model: "openrouter/deepseek/deepseek-v4-flash", harnessProvider: "pi", reasoningEffort: "high"}`.

### TC-4: Opencode — `reasoning_effort: "high"` on `openrouter/deepseek/deepseek-v4-flash`
**Steps:** Same as above. First attempt raced the harness-reconciliation window (see Findings below) and silently ran on the still-stale `pi` harness instead of `opencode` — caught by cross-checking `task.provider` in the response, not just `cred_status`. Re-dispatched after confirming the agent's top-level `harnessProvider` had actually flipped.
**Result:** PASS (on retry). Task completed (`output: "Hi"`, `task.provider: "opencode"`). `cred_status.latestModel` = `{model: "openrouter/deepseek/deepseek-v4-flash", harnessProvider: "opencode", reasoningEffort: "high"}`.

### TC-5: Negative case — Codex `xhigh` on `gpt-5.1-codex` (non-max)
**Steps:** `PATCH /api/agents/{id}/runtime` with `harness_provider: "codex", model: "gpt-5.1-codex", reasoning_effort: "xhigh"`.
**Result:** PASS. `400 {"error":"Unsupported reasoning_effort for this harness/model","harness":"codex","model":"gpt-5.1-codex","level":"xhigh","allowed":["low","medium","high"]}`. No `swarm_config` row was written for the rejected level (confirmed the validation runs before the DB transaction, so a rejected PATCH has zero side effects — also incidentally re-confirms Phase 2's transaction ordering).

### TC-6: UI — agents-list Model column badge (via `agent-browser`)
**Steps:** Seeded 4 agents (one per harness) with `reasoning_effort` set to `high`/`high`/`medium`/`low` and a matching `latest_model.reasoningEffort` echo via a direct `credential-status` PUT (no live task needed for pure display verification). Opened `/agents` in a headless browser, extracted grid row text via `eval`.
**Result:** PASS. Badges rendered exactly as expected: `high` → `[|||]` (claude, codex), `medium` → `[||]` (pi), `low` → `[|]` (opencode). Screenshot: `01-agents-list.png`.

### TC-7: UI — Model cell + HarnessCell tooltips
**Steps:** Hovered the Model cell and the Harness cell for the claude agent.
**Result:** PASS. Model cell tooltip shows `Model ID: claude-opus-4-8` / `Reasoning effort: high`. `HarnessCell` tooltip shows a `Latest model: claude-opus-4-8 · agent_config` row immediately followed by an `Effort: high` row, matching the Phase 6 implementation. Screenshots: `02-model-cell-tooltip.png`, `03-harness-cell-tooltip.png`.

### TC-8: UI — runtime editor effort toggle + per-model grey-out
**Steps:** Opened each seeded agent's detail page (Profile tab, Runtime section) and inspected the 5-segment toggle's `disabled` state via `eval`, plus hovered disabled segments for tooltip text.
**Result:** PASS across all four:
- Claude (`claude-opus-4-8`, effort `high`): "High" active; "Off" disabled with tooltip `Claude Opus 4.8 doesn't support "Off" — use "Low" instead.` (matches cache: this model has no `budget_tokens` entry, so the synthetic-off override never fires). Screenshots: `04-claude-runtime-editor.png`, `04b-claude-off-greyout-tooltip.png`.
- Codex (`gpt-5.3-codex`, effort `high`): "High" active; "X-High" disabled with tooltip `GPT-5.3 Codex doesn't support "X-High" — use "High" instead.`, matching the backend's `*-codex` (non-max) → no `xhigh` rule. Screenshots: `05-codex-runtime-editor.png`, `05-codex-runtime-editor-greyout.png`.
- Pi (`openrouter/google/gemini-3-flash-preview`, effort `medium`): "Medium" active; "Off" and "X-High" both disabled — matches this model's cache-sourced levels `[low, medium, high]` exactly (Phase 1's own unit-test fixture). Screenshot: `06-pi-runtime-editor.png`.
- Opencode (`anthropic/claude-opus-4-8`, effort `low`): "Low" active; only "Off" disabled (no synthetic-off applied, since the client mirror — matching the server — only adds it for `harness === "claude"`, not for an Anthropic model routed through a different harness). Screenshot: `07-opencode-runtime-editor.png`.

**Noteworthy (not a bug):** the first Codex UI check used `gpt-5.1-codex` (the model from the Docker QA pass above) and found **nothing** greyed out, including "X-High" — because `gpt-5.1-codex` isn't in the UI's hand-curated `DIRECT_MODELS` picker list (only `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2-codex` are), so the client-side `reasoningLevels` mirror has no capability data for it and — correctly, per its own documented "undefined means don't grey out anything" contract — renders every segment enabled. The backend still validates and would 400 an actual save attempt (confirmed separately: `PATCH` with `gpt-5.1-codex` + `xhigh` still returns `400` even though the UI wouldn't have greyed it out beforehand). Re-tested with `gpt-5.3-codex` (which IS in the curated list) to confirm the intended grey-out UX; see above. Worth knowing if an agent's already-configured model ever falls outside the UI's curated list (e.g. set via API/older config) — the effort selector won't warn ahead of save, but the API still enforces correctness on save.

## Findings

1. **(Not a bug, a timing characteristic worth documenting) Harness-switch race window**: dispatching a task immediately after a `PATCH .../runtime` harness switch can land on the **previous** harness if the worker's live-reconciliation poll (~10s cadence per `runbooks/harness-providers.md`) hasn't run yet. In this session, a ~12s wait wasn't always enough — one leg (TC-4, first attempt) silently ran under the old harness. This is pre-existing behavior (the same reconciliation mechanism `HARNESS_PROVIDER` already relied on before this feature), not something this feature introduced or needs to fix, but it's worth calling out for anyone else running a similar manual/scripted QA pass: **verify the agent's current `harnessProvider` via a fresh GET immediately before dispatching**, don't just sleep-and-hope. Not filing this as a plan follow-up since it's out of scope for the reasoning-effort feature itself.
2. Several model IDs present in the vendored `modelsdev-reasoning.json` snapshot (used by this feature's own unit tests) aren't currently resolvable against the real live APIs in this environment (`openrouter/google/gemini-3-flash-preview`, `gpt-5.1-codex` for an actual task dispatch). This is a snapshot-freshness/environment concern, not a reasoning-effort bug — the capability *validation* logic (which only reads the local snapshot, no live API call) worked correctly regardless in TC-5.

## Gaps

- Root `.env`'s `ANTHROPIC_API_KEY` is invalid/expired (`401 invalid x-api-key`) — unrelated to this feature, but worth a separate look since it'll block any local Anthropic-direct testing (Claude worked fine via `CLAUDE_CODE_OAUTH_TOKEN` instead).
- Did not verify the exact per-harness transport shape at the process level (e.g. grep the actual `CLAUDE_CODE_EFFORT_LEVEL` env var off a running container's `/proc/<pid>/environ`, or intercept the Codex SDK's in-memory config map) — relied on the adapter-confirmed `cred_status.latestModel.reasoningEffort` echo, which is one layer removed from the raw transport but is the same signal the dashboard itself surfaces to users.
- Did not exercise the "clear effort when switching to an unsupported model" behavior interactively (clicking through the model picker and watching the field reset) — only inspected the resulting `disabled` state on page load for a fixed model. Left for a human click-through if desired.
- ~~Light-mode / dark-mode visual eyeballing of the toggle and tooltips was not done~~ — done in the icon-redesign follow-up below (both themes checked).

## Summary

All 4 harnesses (claude, codex, pi, opencode) + the negative-validation case pass at the API/worker level, AND the UI (agents-list badge, both tooltips, and the runtime editor's effort toggle + per-model grey-out with tooltip) all pass visual/DOM inspection via `agent-browser`. `reasoning_effort` flows correctly end-to-end: API validation → `swarm_config` persistence → live worker reconciliation → adapter application → `cred_status.latestModel.reasoningEffort` echo → UI display. No regressions found in the reasoning-effort feature itself; all issues hit during this pass were pre-existing environment/credential/model-availability concerns, or (in the Codex `gpt-5.1-codex`-not-in-picker case) an already-documented client/server capability-list scoping tradeoff, unrelated to the PR's correctness.

## UI Redesign Follow-up (icons + explicit "Auto" state)

Feedback after the first UI pass: (1) the unset/default state needed an explicit "Auto" option rather than just "nothing selected", and (2) the effort levels should use icons rather than plain text, picked deliberately and kept theme-consistent.

### What changed

- New shared component `ui/src/components/shared/reasoning-effort-icon.tsx` — single source of truth for the effort → icon/label/description mapping, used everywhere effort is displayed.
- **Icon choice**: Lucide's signal-strength family — `SignalZero` (off) → `SignalLow` → `SignalMedium` → `SignalHigh` → `Signal` (xhigh, full bars) — chosen because it's a literal escalating-intensity gradient, echoing the "more bars = more effort" idea the old ASCII badge already established, so the visual language carries over instead of being replaced with something unrelated. `Sparkles` represents "Auto" (no override — harness default), distinct from all five real levels and reads as "automatic/smart" rather than "zero effort" (which `SignalZero`/off already means).
- **Runtime editor**: the 5-segment toggle is now 6 segments (`Auto | Off | Low | Medium | High | X-High`), icon-only with `aria-label`s, and **every** segment has a hover tooltip (name + one-line description) — previously only disabled segments had a tooltip. Clicking "Auto" explicitly clears the override (equivalent to re-clicking the active segment, which still works too, but "Auto" makes it discoverable). Icon size was bumped from the component's default 14px to 18px specifically inside the toggle (`h-[18px] w-[18px]`) after an initial pass showed the signal-bar detail was illegible at 14px in a button — the smaller default size is kept for compact contexts (list badge, tooltip rows).
- **Agents-list Model column**: the ASCII `[|||]` badge is replaced by the small signal icon directly (`reasoningEffortBadge()` ASCII helper removed as dead code, along with its unit tests, since nothing calls it anymore).
- **Tooltips** (Model cell "Reasoning effort" row, `HarnessCell` "Effort" row): icon prepended next to the text label.
- **Theme**: no new color tokens — icons inherit `currentColor` via Tailwind text-color classes (`text-foreground` / `text-primary-foreground` / `text-muted-foreground`, same tokens the rest of the component already used), so both dark and light mode "just work" with zero extra theming code.

### Re-verification

- `bun test` (full suite, 5592 tests), `cd ui && pnpm lint && pnpm exec tsc -b` — all clean after the change.
- Re-ran the same `agent-browser` QA flow against the new design, dark AND light mode:
  - Agents list: icons render at a legible size next to each model name; the no-override agent (`qa-auto-agent`) correctly shows no badge at all (icons only appear for a real level). Screenshot: `01-agents-list-icons.png` (dark), `05-agents-list-light.png` (light).
  - Runtime editor: "Auto" (Sparkles) renders and highlights correctly for an agent with no `REASONING_EFFORT_OVERRIDE` set. Screenshots: `02-auto-runtime-editor.png`, zoomed crop `02b-toggle-zoom.png`.
  - Active-level highlighting still correct after the redesign (Claude agent, effort `high`, 4th segment active): `03-claude-runtime-editor.png`.
  - Grey-out logic unaffected by the redesign — re-confirmed via `disabled` DOM attribute (not just visual) for Claude "Off" and Codex "X-High": `03b-claude-off-tooltip.png` (disabled-segment tooltip: `Off — Claude Opus 4.8 doesn't support "Off" — use "Low" instead.`), `03c-claude-low-tooltip.png` (enabled-segment tooltip, new behavior: `Low — Light reasoning effort`).
  - Light mode: `04-claude-runtime-editor-light.png`, `06-codex-runtime-editor-light.png` — same icons, contrast, and grey-out hold up; confirmed the Codex `X-High` segment's `disabled` attribute is still `true` in light mode via DOM inspection (not just eyeballing).

### Follow-up items (left for Taras, not blocking)

- The "clear effort when switching to an unsupported model" behavior still hasn't been exercised via an actual click-through (model picker → watch effort reset) — same gap as the first pass, unaffected by the icon change.
- Consider whether `Sparkles` reads as clearly "automatic default" vs. e.g. "AI-powered/magic" to a first-time user — it's a common enough icon-language convention (assistant/auto-pilot features) but is inherently a judgment call; an alternative like a dashed circle was considered and rejected as less recognizable.

### Second follow-up: icon + text label (not icon-only)

Feedback: the toggle should show human-readable text alongside the icon, not icon-only. Changed `ReasoningEffortSegment` from a fixed-width icon-only square button to an auto-width `icon + label` row (`flex items-center gap-1.5 px-3`); dropped the redundant `aria-label` since the visible text now IS the accessible name. Icon size settled back to the shared component's 14px default now that text carries the primary label (the 18px bump was specifically to compensate for icon-only illegibility, which no longer applies).

Re-verified: `pnpm lint` / `tsc -b` clean, `bun test src/tests/agents-list-model-display.test.ts src/tests/bedrock-model-groups.test.ts` (17/17 pass), and a fresh `agent-browser` pass in both themes:
- `01-claude-runtime-editor-with-text.png` (dark) — all 6 segments show icon + label, "High" active, "Off" still correctly disabled (confirmed via `button.disabled`, not just visually).
- `02-auto-runtime-editor-with-text.png` (dark) — "Auto" active for an agent with no override.
- `03-runtime-editor-light-with-text.png` (light) — same layout holds up in light mode.
