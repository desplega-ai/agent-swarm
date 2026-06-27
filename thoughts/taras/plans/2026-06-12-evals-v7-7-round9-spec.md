---
date: 2026-06-12T21:45:00Z
topic: "Evals v7.7 (round 9) — config presets, quadrant 25% bands, searchable selectors, chart clipping audit, transcript live UX, task-chip metrics, outcome block"
status: in-progress
branch: feat/evals-subproject
pr: 737
---

# Evals v7.7 (round 9)

From Taras 2026-06-12 ~21:30 (screenshots: analytics scatter w/ broken quadrant overlay; transcript
task pills; task outcome block). Pure evals/ UI + config work — no infra, no root files.

## 1. Config presets (quick-run sets)

New `CONFIG_PRESETS` (configs module): named id-sets surfaced as one-click preset buttons in the
new-run config picker AND a CLI `--preset <name>` (expands to --configs; combinable with explicit ids).
Defaults (Taras delegated the picks):
- `frontier`: claude-fable, claude-opus, claude-sonnet, pi-deepseek-pro, pi-gemini-pro (NEW config —
  see below), codex-5.5
- `oss` (open-weight, newest, across pi+opencode — gemini excluded, proprietary): pi-deepseek-pro,
  pi-deepseek-flash, pi-gpt-oss-120b, pi-kimi-k2.5, pi-minimax-m2.5, pi-qwen-coder, pi-glm-flash,
  opencode-deepseek-flash, opencode-deepseek-pro, opencode-kimi-k2.5, opencode-minimax-m2.5,
  opencode-qwen-coder, opencode-glm-flash
- `claude-family` (same-family tier ladder): claude-haiku, claude-sonnet, claude-opus-4.7,
  claude-opus-4.8, claude-fable
- `budget` (cheap smoke set): claude-haiku, pi-deepseek-flash, pi-gemini-flash, codex-5.4-mini
NEW config `pi-gemini-pro`: openrouter Gemini 3.1 Pro Preview via pi (verify the exact OpenRouter
slug against modelsdev cache / openrouter; AA row "Gemini 3.1 Pro Preview" already in the TSV → wire
its aa mapping too). Registry test: every preset id resolves in the catalog.

## 2. Quadrant overlay → top/bottom 25% bands (screenshot 4 shows it broken)

Median-split put the green rect as a sliver and red over most of the chart. Replace with
quartile-of-axis-RANGE bands: green "most attractive" = best-25% region (top 25% of the Y range ×
best 25% of the X range, where best-X = left for lower-is-better axes), red "least attractive" =
opposite corner 25%×25%. Anchored to the rendered axis ranges, independent of point distribution.
Captions inside their rects, collision-safe with point labels.

## 3. Searchable top-level selectors

Harness + Config global filter dropdowns (and the shared multi-select component generally) get a
search input — type-ahead filtering of options, keyboard friendly (focus search on open, esc clears).

## 4. Chart text-clipping audit (STILL cut after round 8)

Top cards (MiniBarChart) still clip; Y-axis labels elsewhere clip too. Audit EVERY chart text:
axis titles, tick labels, slanted names, captions, legends — adjust margins/viewBox/overflow so
nothing clips at any current label length; hover recourse stays but clipping must be gone.

## 5. Top cards: equal height + hoverable

All three highlight cards (Accuracy/Speed/Price) identical height regardless of content; bars get
hover tooltips (full model name + exact value + attempts) and a visible hover state.

## 6. Transcript live UX

- Auto-scroll: while live rows stream, keep pinned to bottom; user scroll-up disengages; floating
  "Follow" button (with new-rows hint) re-engages. No scroll-jank on append.
- Collapse tool outputs/results by DEFAULT (they dominate the view); per-item expand + an
  expand/collapse-all affordance; remember nothing across reloads (simple).

## 7. Task chips carry the task economics (screenshot 5)

The All / Task-N pills get compact per-task metrics inline: status glyph + cost + duration + tokens
(e.g. "✓ Task 1 · $0.02 · 1m12s · 356k"), full breakdown on hover (existing per-task records from
/api/attempts/:id/tasks; duration from task record timestamps — contracts agent freezes the source).
All tab can show the attempt totals. ALSO: move the pills row INTO the first sticky row — caption
("● Live · Pi · 13 Events · 13 Messages") left, pills right, one row, still one opaque sticky stack
(keep B1 round-8 behavior, now one row shorter).

## 8. Outcome block: sticky, collapsible, differentiated (screenshot 6)

The per-task outcome/result block currently blends into the transcript flow. Make it:
- sticky directly under the (single-row) sticky header within the task sub-tab scroll,
- collapsible (chevron; default expanded but clamped as today; collapsed state shows status + cost
  one-liner),
- visually differentiated from transcript messages (distinct card treatment — accent border/bg
  consistent with status color, not another gray transcript bubble).

## 9. Checks tab tri-state icon (POST-WORKFLOW FIXUP — applied by the orchestrator after the
round-9 fleet lands, before commit; screenshot 7)

The "Checks N/M" tab label carries no status icon — today an OK icon appears only for agentic
checks. Derive a tri-state from ALL checks (deterministic + judge + agentic) and render it in the
tab label (reuse the glyph-status language):
- ok (green ✓): every check passed
- failure (red ✗): any check failed
- warning (amber): anything else (mixed pass/skip, pending)
Same derivation should apply anywhere a checks summary renders.

## Verification
- cd evals && bun run tsc:check && bun test src/ scenarios/ configs/; root bun run lint; ui:build;
  restart :4801. NO paid E2E this round (pure UI/config) — the 1.98 all-harness E2E follows separately.
- CLI: bun src/cli.ts run --help shows --preset; registry preset-resolution test green.
- Code-level UI checks per item; Taras manual-QAs visuals on :4801.

## Carry-over reminders (still open)
- Config presets brainstorm → THIS round covers the quick-run presets; deeper rethink pending.
- Scenario redesign (partial scores, multi-dimension weighted grading) → Taras brainstorms in a
  parallel session (prompt delivered 2026-06-12); implementation lands as its own round after.
