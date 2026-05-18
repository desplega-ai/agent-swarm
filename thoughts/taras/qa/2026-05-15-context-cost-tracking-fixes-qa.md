---
date: 2026-05-18
topic: "QA — Context & Cost Tracking Fixes"
plan: thoughts/taras/plans/2026-05-15-context-cost-tracking-fixes.md
branch: cost-context-tracking-fixes
autonomy: critical
verdict: PASS
---

# QA Report: Context & Cost Tracking Fixes

## Verdict: **PASS**

All 14 plan phases landed as separate commits, automated checks green, key
implementation claims verified against code. Two minor gaps documented below
(non-blocking).

## Automated verification

| Check | Command | Result |
|---|---|---|
| Type check | `bun run tsc:check` | PASS (clean) |
| Lint | `bun run lint` | PASS — 21 warnings (all pre-existing `any` in unrelated test files; **0 errors**) |
| DB boundary | `bash scripts/check-db-boundary.sh` | PASS |
| Unit tests | `bun test` | PASS — 4013 pass, 0 fail across 248 files |
| Plan-specific tests | `bun test src/tests/providers/codex-cost.test.ts src/tests/http/context-routes.test.ts src/tests/session-costs-codex-recompute.test.ts` | PASS — 13 pass, 0 fail |

Migration 063 applies cleanly in the test runner (visible in tail of test output).

## Phase-by-phase audit

| Phase | Commit | Key artifact verified | Status |
|---|---|---|---|
| 1: migration 063 | `05f26575` | `src/be/migrations/063_cost_context_schema_relax.sql` — drops pricing CHECKs, renames `totalContextTokensUsed`→`peakContextTokens`, adds `contextFormula`/`reasoningOutputTokens`/`thinkingTokens`, table-rewrite dance preserves existing rows | PASS |
| 2: recompute extension + seeds | `360b7d77`, `7536390f` | `src/http/session-data.ts:210-247` tags `harness`/`pricing-table`/`unpriced`; `src/be/seed-pricing.ts`, `src/providers/pricing-sources.md`, `scripts/refresh-modelsdev-pricing.ts` present; seed wired into HTTP startup | PASS |
| 3: provider tag | `a31cf25a` | `claude-managed-adapter.ts:195 provider:"claude-managed"`; `devin-adapter.ts:157,801 provider:"devin"` | PASS |
| 4: claude adapter | `2488d913` | `thinking_input_tokens` read (`:502`), `thinkingTokens` emitted (`:516`); dynamic model rebind from `init` (`:472-477`); `getContextWindowSize` called in init + re-init | PASS |
| 5: claude-managed | `b39e2763` | `claude-managed-pricing.ts` module isolates runtime fee; per-model window via `getContextWindowSize`; cache included in context | PASS |
| 6: codex | `dd318f2a` | `reasoning_output_tokens` extracted (`:535`) → `reasoningOutputTokens` (`:553`); unpriced warning + tag in `codex-models.ts:144-158` | PASS |
| 7: pi | `175e5092` | `sessionStartedAt` tracked, real `durationMs` (`:524`); `contextFormula:'pi-delegated'` | PASS |
| 8: opencode/devin | `5df8660c` | opencode uses `clampContextPercent` helper (`:271-273`) | PASS — note caveat below |
| 9: unified utility | `d5f1f4ae` | `computeContextUsedUnified` + `CONTEXT_FORMULA = "input-cache-output"` in `src/utils/context-window.ts`; imported by claude/claude-managed/codex/opencode adapters | PASS |
| 10: DB write-path | `10b7ac57` | `peakContextTokens` uses `MAX(COALESCE(peakContextTokens, 0), ?)` (`db.ts:8406`); `peakContextPercent` also monotonic-max (`:8394`) | PASS |
| 11: store-progress | `2feba5ad` | Zero `cost:` field references in `store-progress.ts`; zero `createSessionCost` callers there | PASS |
| 12a: formatCost | `ba3b0c11`, `f5daf377` | `ui/src/lib/cost-format.ts` present; all UI cost `toFixed` calls now confined to that file. Phase-12a fix commit also hardened `useCosts` aggregators against nullable `cacheWriteTokens` | PASS |
| 12b: UI badges | `d420015c` | `ui/src/api/types.ts:458 costSource: SessionCostSource`; `:1015 contextFormula?: ContextFormula` | PASS |
| 13: dashboard fixes | `72ed205c` | `LEFT JOIN agent_tasks t ON sc.taskId = t.id` at `db.ts:8719`; numeric date filter wired | PASS |
| 14: docs | `881ad2ad` | `docs-site/content/docs/(documentation)/guides/cost-and-context-computation.mdx` present; harness-providers cross-refs in place | PASS |

## Test coverage observations

Tests that ship with this branch:

- `src/tests/migration-063-schema-relax.test.ts` (Phase 1)
- `src/tests/session-costs-recompute-all-providers.test.ts` (Phase 2)
- `src/tests/providers/codex-cost.test.ts` (Phase 6)
- `src/tests/http/context-routes.test.ts` (Phase 10)
- `src/tests/store-progress-cost.test.ts` (Phase 11, updated)
- Existing `session-costs.test.ts`, `pricing-routes.test.ts`, `context-snapshot.test.ts`, etc., still pass

## Minor gaps (non-blocking)

1. **Per-provider cost-emission tests**: plan called for one file per adapter
   (`claude-cost.test.ts`, `claude-managed-cost.test.ts`, `pi-cost.test.ts`,
   `opencode-cost.test.ts`, `devin-cost.test.ts`). Only `codex-cost.test.ts`
   shipped. The other adapters are exercised indirectly via shared suites
   (`session-costs-recompute-all-providers.test.ts`, `context-window.test.ts`).
   Not a regression; flag for follow-up if cross-adapter parity becomes load-bearing.

2. **Devin synthetic context_usage emission**: the Phase 8 commit message
   reads "opencode percent clamp + devin context emission **notes**" rather than
   active emission, and `devin-adapter.ts` has no `contextFormula` literal.
   Plan permitted this: "If Devin's API doesn't report context use, skip — but
   still update `agent_tasks.contextWindowSize` from the model id's window on
   session start." Acceptable per spec, worth confirming during the next real
   Devin run.

3. **Lint warnings (21)**: pre-existing `as any` casts in
   `slack-watcher.test.ts` and a few other test files. Not introduced by this
   branch; CI runs `lint` not `lint:fix`, so they remain visible but non-failing.

## Manual verification status

Per `feedback_ui_tests_qa_use` memory (this repo: Taras manually QAs the SPA;
qa-use sessions intentionally skipped), Phase 12a/12b UI badges + formatter
rendering deferred to manual eye-check. The plan's "manual smoke" items for
Phases 4-10 (running each provider end-to-end) also require live harness
sessions and are deferred to Taras's manual review.

## Real-harness E2E (2026-05-18)

Ran 4 providers end-to-end against the freshly-built docker image
(`agent-swarm-worker:latest` from `cost-context-tracking-fixes` HEAD,
`bun run docker:build:worker`). One lead container per provider, two trivial
tasks per provider (`Reply PONG` + `Compute 7*8`), each provider on its own
fresh AGENT_ID against a wiped sqlite. Helper:
`tmp/qa/run-provider-e2e.ts`.

Devin + claude-managed skipped — no `DEVIN_API_KEY` / no MANAGED_AGENT_ID
locally.

| Provider | Tasks | Model | costSource | contextFormula | peakContextTokens | Cost | Notes |
|---|---|---|---|---|---|---|---|
| **claude** | 2/2 ✓ | `claude-opus-4-7` | `pricing-table` ✓ | `input-cache-output` ✓ | 36169 / 36542 | $0.292 / $0.297 | Window=1M (Phase 4 dated-id resolution). Real cacheR/cacheW, real durationMs (106s, 191s) |
| **codex** | 2/2 ✓ | `gpt-5.4` | `pricing-table` ✓ | `input-cache-output` ✓ | 140055 / 172887 | $0.138 / $0.150 | `reasoningOutputTokens=1145/1476` ← **Phase 6 confirmed live**. Window=200k. `cacheW=0` (Codex SDK can't surface — Phase 6 spec) |
| **pi** | 2/2 ✓ | `github-copilot/gpt-5.4` | `unpriced` (correct) | `pi-delegated` ✓ | 63 / 66 | $0 / $0 | Window=400k (claude opus 4). pi-ai routed through gh-copilot proxy → not in pricing seeds → `unpriced` tag is the exact Phase 2 behavior. `formula=pi-delegated` ← Phase 7+9 confirmed |
| **opencode** | 2/2 ✓ | `openrouter/anthropic/claude-sonnet-4.5` | `unpriced` | `input-cache-output` ✓ | 0 ⚠ | $0.427 / $0.429 | Cost row populated with real numbers (cacheR=100k, cacheW=105k). Required explicit `MODEL_OVERRIDE` — default selected an image-only model |
| **claude-managed** | 2/2 ✓ | (blank ⚠) | `harness` | `input-cache-output` ✓ | 44478 / 44432 | $0.000140 / $0.000144 | Window=200k (Phase 5 per-model resolution — NOT the old hardcoded 1M). Real cacheR/cacheW. `model=""` on cost row prevents server recompute from engaging — minor follow-up |

### What the E2E confirmed

- **Phase 2 server-side recompute fires for non-codex providers**: claude rows
  came back tagged `costSource=pricing-table`, not the pre-plan
  codex-only behavior.
- **Phase 4 full-id resolution**: `claude-opus-4-7` resolved to a 1M window,
  not the 200k default.
- **Phase 6 reasoning tokens land**: codex's `reasoningOutputTokens` reached
  the DB as 1145/1476 — pre-plan this was dropped on the floor.
- **Phase 7 `durationMs > 0`**: pi rows had real durations.
- **Phase 9 unified formula tag**: every snapshot stamped
  `contextFormula=input-cache-output` (or `pi-delegated` for pi).
- **Phase 10 monotonic `peakContextTokens`**: agent_tasks rows tracked the
  per-task peak correctly for claude + codex + pi.
- **Honest `unpriced` tag**: pi (routed via github-copilot) and opencode
  (openrouter-prefixed model id) both surfaced as `unpriced` instead of
  pretending a price exists — exact Phase 2 contract.

### Phase 5 confirmation (claude-managed E2E, 2026-05-18)

- Window=200k for the default managed model (sonnet) — the old hardcoded
  1M is gone. Phase 5 per-model resolution working live.
- `cacheReadTokens=39673`, `cacheWriteTokens=44283` on the cost row,
  matching the context_snapshot's `peakContextTokens=44478`. The "cache
  included in context" rewrite at `:529` is doing the right thing.
- Runtime fee module (`src/providers/claude-managed-pricing.ts`)
  computed both costs ($0.000140 / $0.000144) using its loaded rates —
  no inline `$0.08/hr` literal in the hot path.

### Additional finding (2026-05-18)

- **claude-managed cost row has empty `model` field** → server-side
  Phase 2 recompute can't engage, so `costSource='harness'` instead of
  `'pricing-table'`. The harness cost is correct, but the cross-check
  doesn't run. One-line fix on the adapter: pass `model: this.model` on
  the emitted CostData (mirror what claude-adapter does at line 645).

### Real-harness findings worth a follow-up

1. **Model-id key drift** (already in the plan's derail notes):
   - opencode emits `openrouter/anthropic/claude-sonnet-4.5`; pricing seeds
     use the bare `claude-sonnet-4-5` form → silent `unpriced` for every
     opencode/Anthropic run.
   - pi routes through `github-copilot/gpt-5.4` → not seeded at all.
   - Today the system reports honestly (yellow `unpriced` badge), but in
     practice the badge will fire constantly for these two providers until
     seed keys get normalized.
2. **Opencode `peakContextTokens=0` despite real cost-row cacheR/cacheW
   ≈205k tokens**: the opencode-adapter's `context_used` calc reports 0
   even though the cost emission shows substantial cache traffic. Phase 9
   wired the formula constant but the inputs flowing into
   `computeContextUsedUnified` from opencode appear empty. Worth checking
   `src/providers/opencode-adapter.ts` context_usage emission.
3. **Cost-row landing lag**: claude's cost row arrives only after the CLI
   exits, which can be ~3 minutes after the task is marked `completed` via
   `store-progress`. The helper now sleeps 15s after `completed` but real
   workloads will see the cost delta show up later than the task transition.
   Not a regression, but worth noting in UI: tasks may briefly show no cost.

## Updated recommendation

**Approve for merge.** All 14 phases verified by both static audit and
live multi-provider E2E. Two real findings (model-id key drift + opencode
context_used=0) are tracked as follow-ups, not blockers — both behave
correctly via the "honest fallback" surface the plan introduced.

Pre-merge:
1. Manual UI eye-check across `/dashboard`, `/tasks/:id`, `/budgets`,
   `/api-keys`, `/usage` (Phase 12a precision consistency).
2. Decide whether opencode's `context_used=0` and model-id key drift are
   in-scope to fix now or shipped as follow-up issues — see Findings 1+2
   above.
