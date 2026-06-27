---
date: 2026-06-12T18:10:00Z
topic: "Evals v7.6 (round 8) — Turso DB, guard cleanup + EMBEDDING_* envs, transcript sticky, per-task tokens/outcome, analytics filters + quadrant, AA benchmark config data"
status: in-progress
branch: feat/evals-subproject
pr: 737
---

# Evals v7.6 (round 8)

Items from Taras 2026-06-12 ~18:00 (two annotated screenshots: run-details transcript + analytics page).
PR #754 (E2B `-latest` cache fix) is merging separately; templates already manually republished at 1.97.0.

## A. Infra

### A1. Turso primary database
Move the evals DB to Turso DB `swarm-evals-local` (already created; ALL current data pushed — verified
102 attempts / 57 runs remote). Frozen env names (already set in `evals/.env`, gitignored):
- `EVALS_DB_SYNC_URL=libsql://swarm-evals-local-desplega.aws-eu-west-1.turso.io`
- `EVALS_DB_AUTH_TOKEN=<set>`
Preferred design: `@libsql/client` **embedded replica** — local file (NEW path, e.g. `evals/evals-replica.db`,
gitignored) + `syncUrl`/`authToken`, periodic + post-write sync; local file MUST be WAL (assert
`PRAGMA journal_mode` = wal). The old `evals/evals.db` stays untouched on disk as a frozen backup —
never delete it. Wave 0 must verify @libsql/client works under Bun (embedded replica needs the native
binding) and freeze the client API shape (async refactor blast radius through db/queries + call sites);
if embedded replica is genuinely unworkable under Bun, fallback = keep bun:sqlite on the local WAL file
+ a background/post-attempt push-sync to Turso — but the requirement either way: harness reads+writes
flow to Turso, and `cd evals && bun src/cli.ts serve` works against it with no env = clear error.

### A2. Interim guard cleanup + differentiated embedding envs
Templates are now 1.97.0 (republished today), so remove:
- the `EMBEDDING_DIMENSIONS: "512"` injection (≤1.85-template workaround) in `evals/src/swarm/sandbox.ts`,
- the interim `OPENROUTER_API_KEY` injection into claude worker sandboxes (R6 sign-off "keep for now").
Memory seeding / embedding becomes EMBEDDING_*-differentiated: pass through `EMBEDDING_API_KEY`
(+ `EMBEDDING_MODEL`, `EMBEDDING_API_BASE_URL` when set) to the API sandbox; stop relying on the
`OPENAI_API_KEY` fallback for embeddings (the API resolves `EMBEDDING_API_KEY ?? OPENAI_API_KEY` —
src/be/memory/providers/openai-embedding.ts). `evals/.env` already sets `EMBEDDING_API_KEY`.
KEEP the opencode `INFRA_FAILURE_SIGNATURES` net (lasting scoring-integrity value: infra flakes → `error`,
not a scored fail) — flag in the final report for Taras to overrule.

## B. Run details (screenshot 1)

### B1. Transcript tab rows sticky as one stack
The All / Task-1 / Task-2 pill row must be sticky, anchored directly beneath the right-panel tab row
(Transcript / Checks / Timings / Logs / Assets), as ONE sticky stack with opaque backgrounds —
currently scrolled content (caption row "Claude · 93 Events · 93 Messages", timestamps) bleeds above /
behind the pills. The Live indicator stays in the sticky stack. Get the sticky context right: sticky
breaks when the scroll container differs from the offset ancestor.

### B2. Per-task info completeness
The left TASKS rows show cost only. Add per task (data already in `AttemptTaskJson` from v7.5):
- token usage (compact, e.g. total + in/out on hover like the attempt Tokens row),
- the RAW outcome/error text reachable from the row (expand or click-through to the task sub-tab —
  raw means full text available, not only a clamp preview; keep clamp+expand pattern, add copy).

## C. Analytics (screenshot 2)

### C1. No cut legend/label texts anywhere
- MiniBarChart slanted x-names truncate ("de Opus 4~", "ni 3 Flas~") — give label room (height/rotation/
  font) and full name via tooltip; never clip mid-word without tooltip recourse.
- ScatterChart inline point labels collide catastrophically (top row of screenshot 2) — collision-aware
  placement (offset/leader/hide-with-tooltip when too dense).
- Trends footer/series legend and highlight captions: same rule.

### C2. Cost matrix: sticky first column
In the "what it cost" matrix (HeatTable), scenario-name first column sticky on horizontal scroll
(opaque bg, z-order above cells).

### C3. Global filters + sticky header
Page-level filter bar: by harness AND by config (multi-select, pretty chips), applied to ALL sections
(highlights, trends, matrix, rollups, scatter). Keep/extend per-graph controls where they exist
(trends Scenario/Config, scatter Y/color) — per-graph filters where applicable. The header row with the
global filters is sticky to the top of the page. Server side may need filter params on /api/analytics
(or client-side filtering if payload granularity allows — wave 0 freezes which).

### C4. Quadrant (scatter) improvements
- Bigger/clearer green ("most attractive") and red (worst) quadrant rectangles.
- Label collision avoidance (see C1).
- X-axis selector: Tokens | Price (avg cost) | Time (avg duration) — quadrant logic + caption adapt
  (lower-is-better stays left-good).
- Score vs Pass Rate as Y look near-identical (both cluster at 1.00): differentiate — design freedom,
  e.g. distinct Y domain/zoom, jitter/bee-swarm for ties, or encode the second metric simultaneously
  (score = dot position, pass-rate = ring/fill), pick ONE clean approach and document it.

### C5. Selector & config-list polish sweep
ALL selectors and config lists across the app (analytics multi-selects, runs new-run config picker,
configs page lists): pretty-printed entries (harness icon + ModelChip-style label, not raw ids) with
the usual hover tooltip (full config: id, harness, provider, model). Reuse ConfigChip/portal tooltip.

## D. AA benchmark data in configs

Source of record: `evals/configs/aa-benchmarks-2026-06-12.tsv` (committed; transcribed from
artificialanalysis.ai by Taras today). Columns: model, context_window, creator, aa_intelligence_index,
blended_usd_per_1m, median_tokens_per_s, latency_first_chunk_s, total_response_s. `--` = null;
`35*` = provisional (keep number, flag provisional). Duplicate AA rows (reasoning vs non-reasoning
variants) got `(variant 2)` suffixes on the LOWER-index duplicate during transcription.
Work:
- typed `aa` block attached to catalog configs (evals/configs/index.ts or a sibling aa module keyed by
  config id / model): { contextWindow, creator, intelligenceIndex, blendedUsdPer1M, medianTokensPerS,
  latencyFirstChunkS, totalResponseS, sourceRow, matchedVariant } — null-safe.
- explicit mapping for our catalog models (fable→"Claude Fable 5 (with fallback)", opus→"Claude Opus 4.8
  (max)", sonnet→Sonnet 4.6 row, haiku→"Claude 4.5 Haiku" (pick variant matching how we run it; document),
  gpt-5.5 configs→effort-matching row, deepseek v4 pro/flash→(High) rows for API usage, gemini flash→
  "Gemini 3.5 Flash", gpt-oss-120b→(high), etc.). Unmatched configs → no aa block (UI renders nothing).
- surface on Configs page (columns/expandable: Intelligence, Blended $/1M, Tok/s, First-chunk, E2E) +
  config hover tooltip gets the AA highlights. Degrade gracefully when absent.

## REMIND TARAS AT NEXT "READY FOR QA" REPORT (his words, 2026-06-12 ~18:45)

1. **Config presets**: rethink config defaults — named presets for quick runs, e.g. "oss models",
   "frontier", "multiple from same family", etc.
2. **Scenario redesign via file-review**: current scenarios mostly "just work" (binary 1.00s);
   design more complex ones with genuine partial scores (1 > x > 0) and multi-dimension grading —
   e.g. grade 5 dimensions with weights, then weighted average. Walk through the scenario catalog
   together in file-review.

## Verification
- cd evals && bun run tsc:check && bun test src/ scenarios/ configs/; root bun run lint; ui:build; restart :4801.
- Static smoke on existing data THROUGH the Turso-backed client (back-compat sacred; zero NaN).
- E2E (≤$1): memory-seeded-recall × claude-haiku — proves EMBEDDING_* path (scenario seeds memories →
  embeddings required), guards-removed boot, Turso write path; assert remote row counts grew via
  `turso db shell swarm-evals-local`; captured versions should now read 1.97.0; per-task tokens visible.
- UI checks code-level (Taras manual-QAs visuals).
