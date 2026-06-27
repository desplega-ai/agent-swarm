---
date: 2026-06-12T01:30:00Z
topic: "Evals overhaul round 5 — runs-table expand mode, analytics page, cost-wait speedup, ANSI-clean versions"
status: ready
branch: feat/evals-subproject
supersedes-sections-of: thoughts/taras/plans/2026-06-11-evals-overhaul-v4-spec.md
tags: [evals, analytics, charts, runs-table, cost-wait, ansi, round-5]
---

# Evals round 5 — spec (frozen contracts)

Taras's round-5 asks (every numbered clause is LAW):

1. Runs page: a button to EXPAND the runs table to full width with deeper columns, and one to
   COLLAPSE back to the 30/70 split. Mode persists across navigation within the session.
2. New ANALYTICS page (`#/analytics`, in the nav) answering THREE QUESTIONS: "Is the swarm
   improving over time (development)?", "What is the cost of running it in special tasks?",
   "What model is better while keeping performance?" — with (a) cost × scenario × config,
   (b) per-model average cost per run AND per minute of work, (c) version-aware time series
   with vertical marker lines at apiVersion/workerVersion changes.
3. Cost Wait phase is too slow: happy path ≈10 s, claude-OAuth attempts burn the full 60 s.
   Make it smart without making it wrong (cost rows trickle in late).
4. Worker version is stored dirty (`"agent-swarm v1.85.0\n[?25h"`) — strip
   ANSI/CSI/control sequences before extraction so new runs store a clean `1.85.0`.

Wave 0 (W50, this spec's author) has ALREADY LANDED everything marked IMPLEMENTED below:
the `cleanVersion` helper + sandbox fix (§5), the three chart components + `charts.css`
(§3), the Analytics route/nav + typed page stub, the analytics API client + UI type
mirrors, and the backend analytics types in `evals/src/types.ts`. Wave-1 packages implement
against the ACTUAL CODE in those files and MUST NOT edit them.

Global invariants carry over from rounds 1–4: old DB rows keep rendering (all new fields
nullable, analytics aggregates gracefully over partial data, nothing 500s, **no NaN /
Infinity ever serialized — null instead**), capitalized UI copy, unicode glyphs, single-line
ellipsis cells, portal tooltips, plain CSS variables (light/dark), NO new npm deps (charts
are hand-rolled SVG), biome-clean, Bun APIs server-side.

---

## 1. Analytics API (item 2 backend — WP-AAPI)

### 1.1 Endpoint (FROZEN)

```
GET /api/analytics
→ 200 AnalyticsResponse (JSON), no query params in v5 (client filters from the embedded data)
```

Pre-aggregated server-side. One slim SQL pass over `attempts JOIN eval_runs` — the response
contains ONLY aggregates (never the raw attempt list). Suggested SQL (columns frozen,
shaping free):

```sql
SELECT a.run_id, a.scenario_id, a.config_id, a.status, a.score, a.cost_usd, a.cost_source,
       a.judge_cost_usd, a.duration_ms,
       json_extract(a.tokens_json,  '$.model')         AS token_model,
       json_extract(a.sandbox_json, '$.apiVersion')    AS api_version,
       json_extract(a.sandbox_json, '$.workerVersion') AS worker_version,
       r.name AS run_name, r.created_at AS run_created_at
FROM attempts a JOIN eval_runs r ON r.id = a.run_id
ORDER BY r.created_at ASC, a.attempt_index ASC
```

### 1.2 Response types (FROZEN — IMPLEMENTED in `evals/src/types.ts`, mirrored in `evals/ui/src/types.ts`)

```ts
/** One scenario × config cell aggregated across ALL runs (analytics heat matrix). */
export interface AnalyticsCell {
  scenarioId: string;
  configId: string;
  attempts: number;                // every attempt row, any status
  graded: number;                  // status 'passed' | 'failed' (errors are infra, not graded)
  passed: number;                  // status 'passed'
  errors: number;                  // status 'error'
  passRate: number | null;         // passed / graded; null when graded === 0
  pricedAttempts: number;          // costUsd !== null
  totalCostUsd: number | null;     // Σ costUsd over priced attempts; null when 0 priced
  avgCostUsd: number | null;       // totalCostUsd / pricedAttempts
  judgePricedAttempts: number;     // judgeCostUsd !== null (additive, reconciliation round)
  totalJudgeCostUsd: number | null; // Σ judgeCostUsd over judge-priced attempts; null when 0
  avgJudgeCostUsd: number | null;  // mean over attempts with judgeCostUsd !== null
  avgDurationMs: number | null;    // mean over attempts with durationMs !== null
  avgScore: number | null;         // mean over attempts with score !== null
  lastRunAt: string | null;        // newest run.createdAt touching this cell
}

/** Per-model rollup (model key precedence: tokens.model → registry config.model → "(configId)"). */
export interface AnalyticsModel {
  model: string;
  providers: string[];             // distinct registry providers of contributing configs
  configIds: string[];             // distinct contributing config ids
  runs: number;                    // distinct runs touched (any attempt)
  attempts: number;
  graded: number;
  passed: number;
  errors: number;
  passRate: number | null;         // passed / graded; null when graded === 0
  avgScore: number | null;
  pricedAttempts: number;
  totalCostUsd: number | null;
  avgCostPerAttempt: number | null; // totalCostUsd / pricedAttempts
  avgCostPerRun: number | null;     // totalCostUsd / distinct runs with ≥1 priced attempt
  /** $ per minute of work: Σcost / (Σduration/60000) over attempts having BOTH fields. */
  costPerMinute: number | null;
  avgDurationMs: number | null;
}

/** One run's aggregate for a (scenario, config) cell — a time-series point. */
export interface AnalyticsSeriesPoint {
  runId: string;
  runName: string | null;
  createdAt: string;               // run createdAt — the series x value
  attempts: number;
  graded: number;
  passRate: number | null;
  avgScore: number | null;
  totalCostUsd: number | null;
  avgCostUsd: number | null;
  avgJudgeCostUsd: number | null;
  avgDurationMs: number | null;
  apiVersion: string | null;       // first non-null among the cell's attempts, cleanVersion()ed
  workerVersion: string | null;
}

/** A detected version change along a series (drawn as a vertical marker line). */
export interface AnalyticsVersionEvent {
  runId: string;                   // the point where the new version first appears
  createdAt: string;
  kind: "api" | "worker";
  from: string | null;             // null = first capture (older points had no version)
  to: string;
}

export interface AnalyticsSeries {
  scenarioId: string;
  configId: string;
  points: AnalyticsSeriesPoint[];          // ascending createdAt
  versionEvents: AnalyticsVersionEvent[];
}

export interface AnalyticsResponse {
  generatedAt: string;             // ISO
  scenarioIds: string[];           // every scenario id seen in attempts, first-seen order
  configIds: string[];
  matrix: AnalyticsCell[];         // only cells with ≥1 attempt
  models: AnalyticsModel[];        // sorted by attempts desc
  series: AnalyticsSeries[];       // every (scenario, config) pair with ≥1 attempt
}
```

### 1.3 Null-safety rules (FROZEN — old rows have null cost/duration/score/versions)

- **priced attempt** := `costUsd !== null` (unpriced attempts store null cost by
  construction; a genuine $0 harness cost counts as priced).
- Cost averages/totals aggregate ONLY priced attempts. Duration/score means aggregate only
  non-null values. `costPerMinute` uses the SAME subset for numerator and denominator:
  attempts where `costUsd !== null AND durationMs !== null` (null when the subset is empty
  or Σduration is 0).
- Pass rates count `graded = passed + failed`; `error` attempts are reported separately and
  NEVER lower a pass rate. Every ratio is `null` (not NaN/Infinity) on a zero denominator.
- Versions: apply `cleanVersion()` (§5) to BOTH stored `apiVersion` and `workerVersion`
  when reading `sandbox_json` — historical rows carry the dirty ANSI value and MUST come
  out clean (`"agent-swarm v1.85.0\n[?25h"` → `"1.85.0"`). Missing/uncleanable → null.
- versionEvents: walk each series' points ascending; track the last seen non-null version
  per kind; emit an event whenever a point's non-null version differs from the last seen
  (including the first non-null → `from: null`). Null-version points neither emit nor reset.
- Attempts with every metric null still contribute to `attempts/graded/passed/errors`.
- Unknown config ids (removed from the registry) keep aggregating: provider lookup skips,
  model key falls back to `"(<configId>)"`.

### 1.4 Implementation notes (WP-AAPI)

- New file `evals/src/api/analytics.ts` (owned by WP-AAPI): pure
  `buildAnalytics(rows: AnalyticsSourceRow[], registry: Registry): AnalyticsResponse` +
  the row type — unit-tested in `evals/src/api/analytics.test.ts` (fixtures: old null-field
  rows, dirty versions, zero-priced cells, single-run series). `server.ts` route handler =
  SQL fetch → `buildAnalytics(...)` → `json(...)`.
- Import `cleanVersion` from `../swarm/version.ts` (wave-0, IMPLEMENTED).
- Registry comes from `loadRegistry()` exactly as the other routes do.

### 1.5 Runs-list versions (needed by the expanded runs table — FROZEN, WP-AAPI)

`GET /api/runs` and `GET /api/runs/:id` items gain:

```ts
export interface RunVersions {
  api: string[];     // distinct cleanVersion()ed apiVersions across the run's attempts, first-seen order
  worker: string[];  // same for workerVersion
}
// RunListItem (and RunDetail, which extends it) gains: versions: RunVersions
```

Computed in the route handlers from the already-loaded attempts arrays (do NOT edit
`results.ts`). Empty arrays when nothing was captured. The UI mirror declares it
`versions?: RunVersions` (IMPLEMENTED) so WP-RUNS5 can land before/after WP-AAPI without
breaking — render "—" when absent.

---

## 2. Charts (IMPLEMENTED — `evals/ui/src/components/charts/`, read-only for wave 1)

Hand-rolled SVG, zero deps, theme-aware via the existing CSS variables (`--accent`,
`--blue`, `--green`, `--red`, `--orange`, `--yellow`, `--border`, `--dim`, `--panel-2`).
Responsive width via ResizeObserver. Styles in `charts.css` (import it once from any chart
consumer — each chart component already imports it itself). Default series palette (frozen
order): accent, blue, green, orange, red, yellow.

### 2.1 LineChart (`LineChart.tsx` — FROZEN props)

```tsx
export interface LinePoint { x: number; y: number | null }     // x = epoch ms; null y = gap
export interface LineSeries { id: string; name: string; color?: string; points: LinePoint[] }
export interface ChartMarker { x: number; label: string; color?: string }  // vertical line

export function LineChart(props: {
  series: LineSeries[];
  /** Vertical dashed marker lines with top labels — version changes (item 2c). */
  markers?: ChartMarker[];
  height?: number;                       // px, default 220
  yFormat?: (v: number) => string;       // ticks + tooltip values; default compact number
  xFormat?: (x: number) => string;       // ticks + tooltip header; default fmtDate
  /** y domain floor; default 0 (data min when negative). Max is auto (+5% headroom). */
  yMin?: number;
  emptyText?: string;                    // default "No data points"
}): ReactNode;
```

Behavior (implemented): time x-axis with 4–6 ticks, 4 y ticks, gaps at null y, point dots,
hover crosshair snapping to the nearest x across all series + an in-container tooltip
listing per-series values at that x, dashed vertical markers with 9px labels laid out to
avoid the chart edges, legend row when `series.length > 1`. Renders the empty state when
no series has a non-null point.

### 2.2 BarChart (`BarChart.tsx` — FROZEN props)

```tsx
export interface BarGroup { key: string; label: string; values: (number | null)[] }

export function BarChart(props: {
  groups: BarGroup[];
  /** One name per values index; legend shown when > 1. */
  series: string[];
  horizontal?: boolean;                  // default false (grouped vertical columns)
  height?: number;                       // vertical default 220; horizontal auto-derives from rows
  format?: (v: number) => string;        // value labels + tooltips; default compact number
  colors?: string[];                     // default palette
  emptyText?: string;                    // default "No data"
}): ReactNode;
```

Behavior: null values render as a dim "—" slot (never a zero-height lie). Horizontal mode =
label column + bars + inline value labels (best for model comparisons); vertical mode =
grouped columns with hover tooltip.

### 2.3 HeatTable (`HeatTable.tsx` — FROZEN props; standalone, Matrix-styled — NOT DataTable-based)

```tsx
export interface HeatCellData {
  value: number | null;   // drives the color scale; null = uncolored
  display: ReactNode;     // what the cell shows
  tip?: ReactNode;        // optional portal-Tooltip content
}

export function HeatTable(props: {
  rows: { key: string; label: ReactNode }[];
  cols: { key: string; label: ReactNode }[];
  /** null → "no data" cell (dim "—"). */
  cell: (rowKey: string, colKey: string) => HeatCellData | null;
  /** t ∈ [0,1] normalized linearly over the non-null value range → CSS color.
   *  Default: amber ramp `color-mix(in oklab, var(--accent), transparent N%)`. */
  colorFor?: (t: number) => string;
  emptyText?: string;     // when every cell is null/missing
}): ReactNode;
```

Single non-null value (min === max) normalizes to t = 0.5. Tips use the shared `Tooltip`.

---

## 3. Analytics page (item 2 frontend — WP-AUI; wave-0 stub IMPLEMENTED)

Route + nav (IMPLEMENTED in `App.tsx`): pill order Runs · Analytics · Scenarios · Configs;
`#/analytics` renders `AnalyticsPage`. The wave-0 `AnalyticsPage.tsx` is a typed stub
(fetches `getAnalytics()`, shows load/error/summary counts) — WP-AUI REPLACES its body and
adds `evals/ui/src/pages/analytics.css` (new file, WP-AUI-owned).

Data: `getAnalytics()` from `api.ts` (IMPLEMENTED), single fetch on mount (`usePoll(fn,
null, [])`), manual "↻ Refresh" button allowed. Creative latitude on layout/extras, but the
page MUST contain these three sections (each answers one of Taras's questions):

1. **Trends — "Is the swarm improving over time?"**
   Scenario + config selectors (default: the pair with the most points; options from
   `series`). A `LineChart` of the selected series' points with x = `createdAt`,
   y = selectable metric — segmented control `[Score | Pass Rate | Task Cost | Duration]`
   (default Score) — and `markers` built from `versionEvents`
   (label `api 1.85.0` / `w 1.85.0`; from→to in the marker's tooltip-ish title is optional).
   Points with a null metric become line gaps — never zeros.
2. **Cost Matrix — "What is the cost of running it in special tasks?"**
   `HeatTable` rows = scenarios, cols = configs (labels: `EntityLink`/`ConfigChip`), cell
   value/display = avg task cost — segmented control `[Avg Cost | Total Cost | Judge Cost]`
   (default Avg). Cell tip: attempts, graded, pass rate, priced count, avg duration,
   last run age. Cells without attempts → null.
3. **Models — "What model is better while keeping performance?"**
   A horizontal `BarChart` over `models` — metric control `[$ / Attempt | $ / Run | $ / Minute]`
   — PLUS a `DataTable` of the full rollups with columns (frozen set): Model (`ModelChip`),
   Providers (`HarnessIcon`s), Attempts, Pass Rate, Avg Score, $ / Attempt, $ / Run,
   $ / Minute, Avg Duration. Null cells render "—". Pass Rate + cost side by side IS the
   performance-vs-price answer.

Formatting: reuse `fmtCost`, `fmtDuration`, `fmtScore`, `fmtAgo`, `fmtDate`. Pass-rate
format: `Math.round(rate * 100) + "%"`. Empty DB → every section renders its empty state;
nothing throws, nothing NaNs.

---

## 4. Runs-table expand/collapse (item 1 — WP-RUNS5, `RunsPage.tsx` + `runs.css`)

- **Mode state (FROZEN):** `"split" | "wide"`, default `"split"`, persisted in
  `sessionStorage` under key `evals-runs-table-mode` (read lazily in `useState`, written on
  toggle). Survives hash navigation within the tab session.
- **Toggle button** in the `.runs-head` row next to "+ New Run" (class `btn`):
  split mode shows `⛶ Expand` (title "Full-width table with detailed columns"); wide mode
  shows `⊟ Collapse` (title "Back to the split view with the detail pane").
- **Split mode:** exactly today's behavior — `.layout-30-70`, 5 columns, row click selects
  the detail pane.
- **Wide mode:** single full-width section (no `.layout-30-70`, detail pane NOT rendered),
  same filters + search, deep column set, row click navigates to `#/runs/<id>`.
- **Deep columns (FROZEN order/content; widths are the suggestion):**

| # | Key | Header | Render | Width |
|---|---|---|---|---|
| 1 | run | Run | label; tooltip name+id (as today) | flex |
| 2 | status | Status | `StatusScore` + best score (as today) | 80px |
| 3 | scenarios | Scenarios | count; mini-Matrix tooltip (as today) | 80px |
| 4 | configs | Configs | `r.run.configIds.length`; tooltip = stacked `<ConfigChip>` list | 70px |
| 5 | attempts | Attempts | `{passedAttempts}/{finished}`, append dim ` · {errors}⚠` when errors > 0; tooltip "X Passed · Y Failed · Z Errors"; sort by passed/finished | 90px |
| 6 | cost | Task Cost | `fmtCost(totals.totalCostUsd)` right | 80px |
| 7 | judgeCost | Judge Cost | `fmtCost(totals.judgeCostUsd)` right | 80px |
| 8 | duration | Duration | wall time `finishedAt − createdAt`; `<Elapsed since={createdAt}/>` while `active`; else "—" | 80px |
| 9 | judgeModel | Judge Model | `<ModelChip model={judgeModel ?? defaultJudgeModel}/>` | 140px |
| 10 | versions | Versions | worker version: single → `1.85.0`; several → `1.85.0 +n`; tooltip `API: …\nWorker: …` (full lists); `versions` absent/empty → "—" | 90px |
| 11 | created | Created | `fmtAgo`, ISO title, right (as today) | 90px |

  Data: columns 5–9 come from the existing `RunListItem` fields; column 10 from the new
  `versions` field (§1.5, optional in the UI type until WP-AAPI lands).

---

## 5. ANSI-clean version capture (item 4 — IMPLEMENTED by wave 0)

**Root cause (verified in `evals.db`):** `agent-swarm version` writes
`"agent-swarm v1.85.0\n[?25h"` — the CLI restores the cursor (CSI `?25h`) on exit.
`sandbox.ts` ran `/\bv(\d+\S*)$/` on the *trimmed* stdout; the trailing escape defeats the
`$` anchor and the `out || null` fallback stored the dirty string verbatim.

**Fix (IMPLEMENTED):** new pure module `evals/src/swarm/version.ts`:

```ts
/** Strip ANSI escape sequences: CSI (incl. private modes like ESC[?25h), OSC, 2-char ESC. */
export function stripAnsi(text: string): string;
/** stripAnsi → control chars to spaces → trim → first vX.Y.Z[-pre] capture;
 *  no semver-ish token → the cleaned text (≤64 chars); empty/null → null. */
export function cleanVersion(raw: string | null | undefined): string | null;
```

Strip pattern covers `ESC [ … final` (CSI with `0-9;?` params + intermediates), `ESC ] …
BEL|ST` (OSC), and bare two-char `ESC @–_` sequences; remaining C0 controls + DEL become
spaces. Extraction regex: `/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/` (first capture).
`sandbox.ts` now sets `workerVersion = cleanVersion(res.stdout)`. Covered by
`evals/src/swarm/version.test.ts` (real dirty fixture included). Historical rows stay dirty
in the DB — the analytics/runs aggregation re-cleans on read (§1.3); the run-details
sandbox PrettyView may still show the raw stored value for old attempts (acceptable).

---

## 6. Cost-wait optimization (item 3 — WP-COST)

### 6.1 Findings (verified against `evals.db` + `src/commands/runner.ts` + claude adapter)

- Adapters POST `/api/session-costs` once per iteration on CLI exit (claude adapter only
  when the stream-json `result` event carries `total_cost_usd !== undefined`).
- **claude on an OAuth subscription manifests BOTH ways:** `claude-sonnet` attempts show
  **zero rows ever** (row never posted → the current loop's `rows.length > 0` gate never
  passes → full 60 s burn), `claude-fable` shows one `cost=0, costSource="unpriced"` row
  (stable in ~10 s, but it can never satisfy the runner's `priced` check). Either way the
  wait buys nothing — recompute is always the outcome.
- By the time the cost phase starts, the task is terminal AND `getStableSessionLogs`
  already idled ≥10 s — finished iterations' rows are almost always present on the FIRST
  poll. The 2×5 s stability dance is pure tax in the happy path.
- The per-task waits run **sequentially** (multi-task scenarios stack the tax), and
  `collectHarnessSessionFiles` (worker-sandbox exec, no API dependency) runs after them
  even though nothing orders the two.

### 6.2 `waitForSessionCostRows` — new contract (FROZEN, `evals/src/swarm/client.ts`)

Signature changes from positional `(taskId, timeoutMs?, signal?)` to an options object
(the runner + tests are the only callers):

```ts
async waitForSessionCostRows(
  taskId: string,
  opts: {
    timeoutMs?: number;       // default 25_000 — hard budget (was 60_000)
    emptyTimeoutMs?: number;  // default 12_000 — give up early when NO rows ever appear
    intervalMs?: number;      // default 2_000  (was 5_000)
    signal?: AbortSignal;
  } = {},
): Promise<SessionCostRow[]>
```

Algorithm (frozen):

1. Poll immediately, then every `intervalMs`.
2. `signal.aborted` → throw `"aborted"` (unchanged).
3. A failed poll keeps the previous snapshot (unchanged).
4. Return as soon as **two consecutive successful polls are non-empty with equal length**
   (stability requirement kept — never return the first non-empty poll).
5. If every successful poll so far returned 0 rows and elapsed ≥ `emptyTimeoutMs` →
   return `[]` (rows are posted before/with task completion; 12 s of silence after the
   log-capture idle means nothing is coming).
6. Elapsed ≥ `timeoutMs` → return the last snapshot (or `[]`).

Outcome: happy path ≈2–4 s (was ≈10 s); no-row harnesses 12 s (was 60 s); genuine
trickle-in still gets up to 25 s of stability polling.

### 6.3 Runner changes (FROZEN, `evals/src/runner/index.ts` — cost phase only)

1. **OAuth skip:** `const oauthSubscription = config.provider === "claude" &&
   !!process.env.CLAUDE_CODE_OAUTH_TOKEN;` — exactly mirrors `credentialsForConfig`'s
   precedence (OAuth wins when both creds exist, so this is what the worker actually got).
   When true, do a single `getSessionCosts(task.id).catch(() => [])` per task — NO
   stability polling (any rows are cost-0/unpriced and can never pass the `priced` check;
   they're still captured for the `session-costs.json` artifact). Frozen log line:
   `[cost] claude subscription (OAuth) — skipping priced-row wait`.
2. **Parallelize per-task waits:** `Promise.all` over `tasks` (replaces the serial loop);
   `costRowsByTask` keeps task order.
3. **Overlap session-file collection:** run the existing `collectHarnessSessionFiles`
   block concurrently with the cost wait (one `Promise.all([costWait, collect])`). Safe by
   construction: the collection execs the WORKER sandbox, cost rows come from the API
   sandbox, and `sessionFiles` is first consumed AFTER the join (recompute + artifacts).
   Keep timing attribution as-is (`costMs` = cost-wait wall, `artifactsMs` += collection
   wall) — phases may now overlap, sum-of-phases ≥ wall is acceptable.
4. The post-wait **log re-fetch stays after the join** (unchanged semantics — it banks
   whatever flush time the cost phase bought).
5. `setAttemptPhase(attempt.id, "cost")` continues to bracket the joint wait. The priced
   check, recompute fallback, and artifact writes are unchanged.

### 6.4 Tests (WP-COST — new `evals/src/swarm/cost-wait.test.ts`)

Subclass `SwarmClient` overriding `getSessionCosts` with scripted per-call responses; use
tiny budgets (`intervalMs: 5`–`10`). Required cases: (a) rows grow then stabilize → returns
the full set, not the first poll; (b) permanently empty → returns `[]` after
`emptyTimeoutMs`, well before `timeoutMs`; (c) abort mid-wait → throws `"aborted"`;
(d) never-stable growth → returns the last snapshot at `timeoutMs`.

---

## 7. Ownership matrix (wave 1 — disjoint; wave-0 layer is read-only)

| Package | Files (exclusive) | Implements |
|---|---|---|
| WP-AAPI | `evals/src/api/server.ts`, NEW `evals/src/api/analytics.ts` + `analytics.test.ts` | §1 (GET /api/analytics, RunListItem.versions) |
| WP-AUI | `evals/ui/src/pages/AnalyticsPage.tsx` (replaces the wave-0 stub), NEW `evals/ui/src/pages/analytics.css` | §3 |
| WP-RUNS5 | `evals/ui/src/pages/RunsPage.tsx`, `evals/ui/src/pages/runs.css` | §4 |
| WP-COST | `evals/src/swarm/client.ts`, `evals/src/runner/index.ts`, NEW `evals/src/swarm/cost-wait.test.ts` | §6 |

Wave-0 (ALREADY LANDED, read-only for wave 1): this spec,
`evals/src/swarm/version.ts` + `version.test.ts`, `evals/src/swarm/sandbox.ts` (cleanVersion
adoption), `evals/src/types.ts` (analytics types), `evals/ui/src/components/charts/{LineChart,BarChart,HeatTable}.tsx`
+ `charts.css`, `evals/ui/src/App.tsx`, `evals/ui/src/pages/AnalyticsPage.tsx` (stub),
`evals/ui/src/api.ts`, `evals/ui/src/types.ts`.

If you believe you must touch a file you don't own — STOP, the spec is wrong; escalate.

## 8. Verification (every wave-1 package)

```bash
cd /Users/taras/Documents/code/agent-swarm/evals
bun run tsc:check                          # zero errors in your files
bun test src/                              # all green (WP-COST: cost-wait.test.ts; WP-AAPI: analytics.test.ts)
cd .. && bunx biome check --write <your files>
cd evals && bun run ui:build               # integrator / UI packages
```

Manual E2E (integrator): `bun src/cli.ts serve` →
- `curl localhost:4801/api/analytics | jq '.models, .series[0].versionEvents'` — aggregates
  over the ~12 existing runs, versions come out CLEAN (`1.85.0`, no ``), no NaN/null
  crashes despite the old null-field attempts.
- `#/analytics`: trends chart with version markers, cost heat matrix, model bar chart +
  table; every section degrades to its empty state with an empty DB.
- `#/runs`: ⛶ Expand → full-width 11-column table (versions column populated for the
  2026-06-11 runs, "—" for older); navigate away and back → mode persisted; ⊟ Collapse
  restores the 30/70 split + detail pane.
- Start a 1×1 claude run with `CLAUDE_CODE_OAUTH_TOKEN` set: runner log shows the frozen
  OAuth skip line, the cost phase completes in seconds, `costSource` lands `recomputed`
  (or `unpriced`), and the new attempt's `sandbox_json.workerVersion` is exactly `1.85.0`-
  style clean. A pi run's cost phase finishes in ~2–4 s with `costSource: "harness"`.
