---
date: 2026-06-11T20:30:00Z
topic: "Evals dashboard overhaul round 2 — shared contracts + wave-1 packages"
status: ready
branch: feat/evals-subproject
pr: 737
supersedes-sections-of: thoughts/taras/plans/2026-06-11-evals-overhaul-spec.md
tags: [evals, ui, vite, react, round-2]
---

# Evals dashboard round 2 — mini-spec

Round-2 QA feedback on the v1 overhaul (see the v1 spec for architecture background). Wave 0
(WV0, this spec's author) has ALREADY LANDED every shared-layer change described in §2-§5 —
wave-1 agents build against the actual code in `evals/ui/src/{components,App.tsx,api.ts,types.ts,hooks.ts,styles.css}` and MUST NOT edit those files. The five wave-1
packages run fully parallel with disjoint file ownership (§7).

Global invariants (unchanged from v1): plain CSS + variables, hash routing, no new deps,
old DB rows must keep rendering (null fallbacks everywhere), biome-clean (double quotes,
100-char lines, no `any`), Bun APIs server-side.

---

## 1. Feedback items (LAW — numbered references used throughout)

1. Live transcript for in-progress attempts (sandbox apiUrl + swarmKey + taskIds).
2. Unicode glyphs over chips — consistent everywhere.
3. Capitalized texts by default (labels/headings/buttons). Never CSS-capitalize identifiers
   (model ids, run ids, file names stay verbatim).
4. Run details: checks & judgments move into a TAB whose name carries information
   (e.g. `Checks 3/4 · Judge ✓`).
5. Tooltips escape containers (fixed/portal positioning, viewport-edge aware).
6. New-run modal: kill the horizontal scrollbar.
7. Phase timings → run-details TAB, waterfall diagram with hover.
8. Status words ("Done") → glyphs + hover info.
9. Runs page left panel: row 1 = multi-select dropdown filters, row 2 = full-width search.
10. ALL table cells single-line: ellipsis + hover reveals full value.
11. Runs table columns: name (truncated), status, scenarios, cost, created.
12. New CONFIGS page; config references link to it.
13. Runs: status + score joined into one compact representation (glyph + best score).
14. Raw JSON views → humanized pretty view by default, Raw JSON toggle.
15. Transcript: custom components per event type; render ALL rows (unparseable → raw fallback).
16. Asset names truncated; kind column becomes an icon with hover info.
17. Run details: left/right columns scroll independently; header fixed.
18. Reusable Model component (models.dev display name + hover card). Use everywhere.
19. Harness icons (ported from main `ui/` dashboard) instead of bare text.

---

## 2. Style rules (apply in EVERY wave-1 file)

- **Unicode over chips (items 2, 8).** Statuses, judge kinds, booleans, asset kinds render as
  glyphs with a `Tooltip` carrying the label. Reference glyphs: pass `✓`, fail `✗`, error `⚠`,
  pending `○`, cancelled `⊘`, running = braille spinner `⠋…`, judging `◔`, unknown `•`.
  Use `StatusBadge` / `statusGlyphInfo` — do not hand-roll glyph maps in pages.
  `.chip` is reserved for identifier-like values (ids, file names, keys), not for status/kind words.
- **Capitalization (item 3).** All UI copy is sentence-cased: panel titles ("Matrix",
  "Checks & Judgments"), buttons ("New Run", "Cancel", "Resume", "Open Details →"), form labels
  ("Judge Model"), empty states ("No runs yet…"), tab names, tooltips. Identifiers (run ids,
  model ids, config ids, artifact names) stay verbatim — never `text-transform` them.
  Table headers keep the existing small-caps CSS (that's styling a label, fine).
  The header wordmark `swarm evals` is brand and stays lowercase.
- **Single-line cells (item 10).** `table.data` is now `table-layout: fixed` with a `<colgroup>`
  generated from `Column.width`. Every cell is wrapped in `.dt-cell`
  (nowrap + ellipsis) and gets a `title` attribute (from `Column.titleText` →
  `searchText` → string render). Wave-1 pages MUST give every column an explicit `width`
  except the one flexible column per table, and provide `titleText`/`searchText` for any
  cell whose render output isn't plain text.
- **Tooltips (item 5).** `Tooltip`/`InfoTip` are now portal-based (`position: fixed`,
  viewport-edge aware). Never add CSS-only tooltips; never rely on `overflow: visible`.
  `Tooltip` accepts `text: ReactNode` so hover cards (model info, sandbox info) are plain
  `Tooltip` usages.
- **Pretty over raw (item 14).** Anywhere a JSON blob is shown (judgment `raw`, scenario
  definition, sandbox info, provider_meta payloads if desired), use `PrettyView` (pretty by
  default, Raw JSON toggle built in). Plain `JsonView` is for inside-PrettyView raw mode and
  genuinely code-like values only.
- **Models & harnesses (items 18, 19).** Every model id render goes through `ModelChip`;
  every harness/provider render goes through `HarnessIcon`. No bare model-id `<code>` chips,
  no bare provider text.

---

## 3. Shared layer — exact contracts (IMPLEMENTED in wave 0; import paths verbatim)

### 3.1 `components/Tooltip.tsx` (CHANGED — portal positioning, item 5)

```tsx
export function Tooltip(props: {
  text: ReactNode;            // string (renders pre-line) or rich node (hover cards)
  children: ReactNode;
  wide?: boolean;             // max-width 420px instead of 320px (hover cards)
}): ReactNode;
export function InfoTip(props: { text: ReactNode }): ReactNode; // ⓘ glyph + Tooltip
```

Behavior: hover/focus renders a `position: fixed` floating box via `createPortal` into
`document.body`, anchored to the trigger's `getBoundingClientRect()`. Default placement above
center; flips below when there's no headroom; x clamped to `[8, vw-8]`. Closes on
mouseleave/blur/scroll. Class names: trigger `.tooltip`, floating box `.tip-box` (+`.wide`).
The old `.tooltip::after` CSS tooltip is GONE — content can never be clipped by containers.

### 3.2 `components/StatusBadge.tsx` (CHANGED — glyphs, items 2/8/13)

```tsx
export interface StatusGlyphInfo {
  glyph: string;                                   // "✓" | "✗" | "⚠" | "○" | "⊘" | "◔" | "•" | "" (live → spinner)
  tone: "green" | "red" | "accent" | "dim" | "neutral";
  label: string;                                   // Capitalized: "Passed", "Running", …
  live: boolean;                                   // running/judging/live → animated
}
export function statusGlyphInfo(status: string): StatusGlyphInfo;
export function StatusBadge(props: { status: string; tip?: string }): ReactNode;
// glyph (or braille Spinner when live) + Tooltip(tip ?? label); aria-label = label. NO text chip.
export function StatusScore(props: {
  status: string;
  score: number | null;
  tip?: string;                                    // extra tooltip line(s)
}): ReactNode;
// item 13: one compact token — glyph + fmtScore(score) colored by tone; spinner while live;
// score null → glyph only. Tooltip: "<Label> · Score 0.85" (+ tip).
export function CostBadge(props: { costUsd: number | null; source: string | null }): ReactNode;
// unchanged semantics; tooltips capitalized.
```

Status → glyph map: passed/pass/done → `✓` green · failed/fail → `✗` red · error → `⚠` red ·
running/live → spinner accent · judging → `◔` accent (pulsing) · pending → `○` dim ·
cancelled → `⊘` dim · unknown → `•` neutral. Pages MUST NOT print raw status words.

### 3.3 `components/PrettyView.tsx` (NEW, item 14)

```tsx
export interface PrettyCtx { path: string; key: string } // path = dot-path from root, e.g. "outcome.llmJudge.rubric"
export interface PrettyViewProps {
  value: unknown;
  labels?: Record<string, string>;   // dot-path OR bare key → display label override
  renderers?: Record<string, (value: unknown, ctx: PrettyCtx) => ReactNode>; // dot-path OR bare key
  hide?: string[];                   // dot-paths or bare keys to omit
  defaultRaw?: boolean;              // default false (pretty first)
  rawLabel?: string;                 // label passed to JsonView in raw mode
}
export function PrettyView(props: PrettyViewProps): ReactNode;
```

Pretty mode renders humanized key/value sections — NOT JSON syntax:
- keys → `humanizeKey()` labels (camelCase split, ID/URL/API uppercased, `…Ms` suffix dropped);
- ISO date strings → `fmtDate` + `fmtAgo` (full ISO in title);
- numbers: key `…Ms` → `fmtDuration`, key matches cost/usd → `fmtCost`, key matches token → `fmtTokens`, else `toLocaleString`;
- booleans → `✓` / `✗` glyph; null/undefined → dim `—`; http(s) strings → external `<a>`;
- long strings (> 280 chars) → collapsed `▸ Show (n chars)` toggle with pre-wrap body;
- arrays of primitives → `.chip` row; arrays of objects → numbered nested sections;
- nested objects → indented section with small-caps heading.
A top-right toggle (`{ } Raw` / `≡ Pretty`) swaps the body to `<JsonView value collapseDepth={2}/>`.
CSS: `.pv`, `.pv-row`, `.pv-key`, `.pv-val`, `.pv-section`, `.pv-toggle` (in `styles.css`).

### 3.4 `components/ModelChip.tsx` (NEW, item 18)

```tsx
export function ModelChip(props: {
  model: string | null;       // any id shape: "deepseek/deepseek-v4-pro",
                              // "openrouter/deepseek/deepseek-v4-flash", "claude-haiku-4-5-20251001",
                              // shortnames ("haiku") — unresolved ids fall back gracefully
  dim?: boolean;
}): ReactNode;
```

Resolves via `useModels().resolve(id)` (§3.8). Resolved → human display name (e.g.
"DeepSeek V4 Pro") + wide hover card: name, mono id, In/Out/Cache-read/Cache-write $ per 1M
(`fmtPerM`), Context (`fmtTokens`), Capabilities (Reasoning ✓/✗ · Tools ✓/✗). Unresolved →
mono raw id + tooltip "Not in the models.dev catalog". `model === null` → dim `—`.

### 3.5 `components/HarnessIcon.tsx` (NEW, item 19)

```tsx
export const HARNESS_LABELS: Record<string, string>; // claude → "Claude", pi → "Pi", codex → "Codex",
                                                     // opencode → "OpenCode", devin → "Devin",
                                                     // "claude-managed" → "Claude Managed"
export function HarnessIcon(props: {
  harness: string | null | undefined;
  size?: number;              // px, default 14
  showLabel?: boolean;        // icon + text label; default false → icon + Tooltip(label)
}): ReactNode;
```

Inline SVGs ported from `ui/src/components/shared/harness-icon.tsx` (claude, claude-managed,
codex, pi, opencode, devin; `fill="currentColor"`). Unknown harness → text fallback in a
`.chip` (still tooltipped). `null`/`undefined` → `null`.

### 3.6 `components/DataTable.tsx` (CHANGED — items 9, 10)

```tsx
export interface Column<T> {
  key: string;
  header: string;
  headerTip?: string;
  width?: string;                                  // feeds the <colgroup>; table-layout is FIXED now
  align?: "left" | "right" | "center";
  sortable?: boolean;
  sortValue?: (row: T) => string | number | null;
  filterOptions?: (rows: T[]) => string[];         // presence enables a MULTI-SELECT dropdown filter
  filterValue?: (row: T) => string | string[];
  filterRender?: (option: string) => ReactNode;    // NEW: custom option rendering (e.g. HarnessIcon)
  searchText?: (row: T) => string;
  titleText?: (row: T) => string;                  // NEW: hover-reveal title; default searchText → string render
  render: (row: T) => ReactNode;
}
export interface DataTableProps<T> {
  rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string;
  onRowClick?: (row: T) => void; rowHref?: (row: T) => string | null;
  selectedKey?: string | null;
  searchable?: boolean; searchPlaceholder?: string;          // default "Search…"
  toolbarLayout?: "inline" | "stacked";            // NEW: "stacked" = row 1 filters, row 2 full-width search (item 9)
  defaultSort?: { key: string; dir: "asc" | "desc" };
  emptyText?: string;                              // default "Nothing here yet"
  maxHeight?: string;
}
export function DataTable<T>(props: DataTableProps<T>): ReactNode;
export function fuzzyMatch(query: string, haystack: string): boolean;
export function MultiSelect(props: {                // exported for standalone use
  label: string; options: string[]; selected: string[];
  onChange: (next: string[]) => void; renderOption?: (option: string) => ReactNode;
}): ReactNode;
```

Filter semantics: each `filterOptions` column renders a `MultiSelect` (button `Label · n ▾`,
portal dropdown with checkboxes + "Clear", outside-click/Escape to close, viewport-aware).
Empty selection = no filter; otherwise row passes when `filterValue` intersects the selection.
Cells: every `<td>` content is wrapped in `.dt-cell` (single line, ellipsis) with a `title`.
RunsPage uses `toolbarLayout="stacked"` (item 9); everything else default `"inline"`.

### 3.7 `components/EntityLink.tsx` (CHANGED, item 12)

`kind="config"` now renders a REAL link to `#/configs/${id}` (was a tooltip chip). All other
kinds unchanged. Pages may keep using it everywhere a config id appears.

### 3.8 `hooks.ts` (ADDED)

```ts
export interface ModelLookup {
  models: ModelJson[];
  defaultJudgeModel: string | null;
  resolve: (id: string | null) => ModelJson | null; // exact → strip "openrouter/" → strip date
                                                    // suffix → "/"-suffix match → dash→dot version match
  loaded: boolean;                                  // false while the one-shot fetch is in flight
}
export function useModels(): ModelLookup;           // module-level cache; fetches /api/models ONCE per session
```

`useHashRoute` / `navigate` / `usePoll` / `useNow` unchanged.

### 3.9 `api.ts` + `types.ts` (CHANGED — live transcript, item 1)

```ts
// api.ts
export function getTranscript(
  attemptId: string,
  opts?: { live?: boolean },                        // live → "?live=1"
): Promise<TranscriptResponse>;

// types.ts
export interface TranscriptResponse {
  source: "raw-session-logs" | "transcript" | null;
  harness: string | null;
  rows: TranscriptRow[] | null;
  text: string | null;
  live?: boolean;                                   // NEW — true when rows came fresh from the sandbox
}
```

Everything else in `api.ts`/`types.ts` is unchanged.

### 3.10 `App.tsx` (CHANGED, item 12)

- Nav pills capitalized: `Runs` / `Scenarios` / `Configs`.
- New route: `#/configs` and `#/configs/:id` → `ConfigsPage({ configId: string | null })`
  (default export of `pages/ConfigsPage.tsx`; wave 0 ships a typed stub, WP-SCENARIOS2
  replaces the body — the props contract is FROZEN).

### 3.11 `styles.css` (CHANGED)

New/changed shared classes wave-1 pages can rely on:
- `.tip-box` (+`.wide`) — fixed-position tooltip box; `.tooltip` is just the inline trigger wrapper.
- `table.data { table-layout: fixed }` + `.dt-cell` (nowrap/ellipsis) + `.dt-bar.stacked`
  (two-row toolbar) + `.ms-btn` / `.ms-menu` / `.ms-option` (MultiSelect).
- `.status-glyph` (+ `.tone-green/.tone-red/.tone-accent/.tone-dim/.tone-neutral`) and
  `.status-score`.
- `.pv*` PrettyView classes; `.model-chip`; `.tip-card` / `.tip-card-row` (hover-card layout
  used by ModelChip — reuse for any rich tooltip); `.harness-icon`.
- `.scroll-col` — `overflow-y: auto; max-height: var(--scroll-col-max, calc(100vh - 230px))`
  utility for item 17 (set `--scroll-col-max` in page CSS if the default offset is wrong).
- `dialog { max-width: min(640px, calc(100vw - 32px)); overflow-x: hidden }` guard (item 6 —
  WP-RUNS2 still owns the root-cause fix in `runs.css`, see §6.2).
- `.badge` no longer lowercases; `.chip` unchanged.

---

## 4. Live-transcript API contract (item 1 — WP-API2 implements in `evals/src/api/server.ts`)

`GET /api/attempts/:id/transcript?live=1`

Decision tree in the handler:

1. Load the attempt. If `live=1` AND attempt status ∈ {pending, running, judging} AND
   `attempt.sandbox` (parsed `sandbox_json`) is non-null → **live path**:
   - `const client = new SwarmClient(attempt.sandbox.apiUrl, attempt.sandbox.swarmKey)`
     (`evals/src/swarm/client.ts` — already knows session-log fetching).
   - Task ids: `attempt.taskIds` when non-empty; otherwise list tasks from the sandbox
     (`GET /api/tasks` via `client.get`; every task in the throwaway sandbox belongs to this
     attempt; tolerate both `{tasks:[…]}` and bare-array response shapes).
   - For each task id: `client.getSessionLogs(taskId)` (single shot — NO stability polling;
     this endpoint is called every 5s by the UI). Concatenate rows in task order; rows already
     carry `id/taskId/sessionId/iteration/cli/content/lineNumber/createdAt` — exactly the
     `TranscriptRow` wire shape.
   - `harness` from the registry as today. Respond
     `{ source: "raw-session-logs", harness, rows, text: null, live: true }`.
   - **Fail-safe**: wrap the whole live path; cap it with `AbortSignal.timeout(8000)`-guarded
     fetches (pass through `client.get` failures); on ANY error or timeout fall through to the
     stored path (never 5xx because a sandbox died mid-poll).
2. **Stored path** (default, also `live=1` on finished attempts): exactly today's behavior
   (raw-session-logs artifact → flat transcript artifact → nulls) plus `live: false` in the
   response.

Notes for WP-API2: the swarm key is deliberately stored/exposed (eval sandboxes are
throwaway). Keep the `json()` helper + CORS. No schema change. Old attempts have
`sandbox === null` → always stored path.

Consumer (WP-TRANSCRIPT2): `usePoll(() => getTranscript(attemptId, { live }), live ? 5000 : null, [attemptId, live])`;
when `data.live === true` show a "● Live" caption chip-glyph; rows render identically either way.

---

## 5. Wave-0 deliverables (DONE — listed for orientation)

- All §3 contracts implemented in `evals/ui/src/{components/*,App.tsx,api.ts,types.ts,hooks.ts,styles.css}`.
- `pages/ConfigsPage.tsx` typed stub (`{ configId: string | null }` props, default export).
- Capitalization pass over all shared-component copy.
- `format.ts` additions: `fmtPerM(v: number | null): string` ("$0.435" per-1M price) and
  `humanizeKey(key: string): string`.

---

## 6. Wave-1 packages (parallel; strictly disjoint ownership)

If you believe you must touch a file you don't own — STOP, the spec is wrong; escalate.
Shared-layer files (§3) are read-only for all wave-1 packages.

### 6.1 WP-API2 — live transcript endpoint

Owns: `evals/src/api/server.ts`.
Implements: item 1 server side (§4). Nothing else changes in the file.
Read first: §4; `evals/src/swarm/client.ts`; `evals/src/db/queries.ts` (`getAttempt` already
parses `sandbox_json` → `attempt.sandbox`).
Verify: `bun run tsc:check`; manual: boot serve, `curl "localhost:4801/api/attempts/<finished>/transcript?live=1"`
→ `live: false` stored rows; old attempts unaffected.

### 6.2 WP-RUNS2 — runs page + new-run dialog

Owns: `pages/RunsPage.tsx`, `pages/NewRunDialog.tsx`, `pages/runs.css`.
Implements: items 9, 11, 13 (+ 2/3/8/10/18 via shared components), 6.
- Left panel (item 9): `DataTable toolbarLayout="stacked"` — row 1: MultiSelect filters
  (Status incl. "active", Scenarios, Configs), row 2: full-width search.
- Columns (item 11, exactly five): Run (flexible width, truncated name — `titleText` full
  name+id), Status+Score joined via `<StatusScore status score={bestScoreOfRun}>` (item 13;
  best score = max non-null `cells[].bestScore`, null when none), Scenarios (count, title
  lists ids), Cost, Created (`fmtAgo`, ISO sortValue, default sort desc). Give every column
  except Run an explicit `width`.
- Detail pane: replace judge-model `<code>` chip with `<ModelChip>`; statuses via glyphs;
  capitalize all copy ("New Run", "Open Details →", "Cancel", "Resume", "Matrix",
  "By Scenario", "By Config"); config references are `EntityLink kind="config"` (links to
  the new Configs page).
- NewRunDialog (item 6): fix the horizontal scrollbar — audit `runs.css` dialog styles
  (`.new-run-dialog`, `.model-menu`, `.form-row-2`) for fixed widths/overflow; content must
  fit `max-width: min(640px, calc(100vw - 32px))`; `overflow-x` must never engage. Config
  chips in the dialog get `HarnessIcon` + label; model selector options can reuse
  `.tip-card`-style layout; capitalize labels ("Name (optional)", "Scenarios", "Configs",
  "Attempts Per Cell", "Concurrency", "Judge Model", "Start Run").

### 6.3 WP-RUNDETAIL2 — run details page

Owns: `pages/RunDetailsPage.tsx`, `pages/run-details.css`, `pages/Waterfall.tsx` (NEW).
Implements: items 4, 7, 17 (+ 2/3/8/10/14/16/18/19 in-page).
- Layout (item 17): top meta `.panel` stays fixed (sticky below the app header); below it the
  30/70 grid where BOTH columns are independent scroll containers — use the shared
  `.scroll-col` utility on each side (tune `--scroll-col-max` in `run-details.css`).
- Right pane tabs (items 4, 7): `Transcript` | `Checks <passed>/<total> · Judge <glyph>` |
  `Timings` | `Assets`.
  - Checks tab name carries info: deterministic-check pass ratio + the LLM/agentic judge
    verdict glyph (✓/✗; omit the "· Judge" suffix when no judge ran; while judging show a
    spinner glyph in the tab). Tab body = today's JudgmentsPanel content, with judgment
    `raw` rendered via `PrettyView` (pretty default, raw toggle — item 14) and judgment
    `kind` as a glyph + tooltip instead of a chip (deterministic → `⚙`? no — use `✓`-style
    kind glyphs: deterministic `≡`, llm/agentic `✶`; tooltip carries the word).
  - Timings tab (item 7): `<Waterfall timings={attempt.timings} totalMs={attempt.durationMs}>`
    — horizontal waterfall: one row per phase (Boot, Seed, Tasks (+ per-task sub-rows),
    Log Capture, Cost Wait, Checks, LLM Judge, Agentic Judge, Artifacts), bars offset by
    cumulative start, width ∝ duration, hover highlights the bar and shows a Tooltip with
    phase name + `fmtDuration` + % of total. Null phases render a dim "not measured" row;
    `timings === null` → "Timings not captured (older run)". Define
    `export default function Waterfall(props: { timings: PhaseTimingsJson; totalMs: number | null }): ReactNode`
    in `pages/Waterfall.tsx`; styles in `run-details.css`.
  - Assets tab (item 16): kind column → icon glyph with Tooltip (map: raw-session-logs `≋`,
    transcript `☰`, harness-session `⌂`, meta `ⓘ`, sandbox-log `▤`, default `▢`), name column
    truncated (`.dt-cell` does it — provide `titleText`), Open/Download actions stay.
- Left column: attempt summary (statuses via `StatusBadge`/glyphs, model via `ModelChip`,
  config via `EntityLink kind="config"` + `HarnessIcon`), sandbox panel rendered with
  `PrettyView` (labels prop for nice names; swarmKey keeps copy-on-click via a custom
  renderer). The old inline TimingsPanel and JudgmentsPanel panels MOVE into the right-pane
  tabs (left column = matrix + attempt picker + summary + sandbox only).
- Pass `live` into `<Transcript attemptId live={attemptUnfinished} />` as today (Transcript
  itself handles the live fetch — §6.4).
- Capitalize everything ("← Runs", "Attempt #0", "Waiting for a pool slot…", etc.).

### 6.4 WP-TRANSCRIPT2 — transcript renderer

Owns: `pages/Transcript.tsx`, `pages/transcript.css`, `evals/ui/src/logs-parser/*`.
Implements: items 1 (client side), 15.
- Live: `usePoll(() => getTranscript(props.attemptId, { live: props.live }), props.live ? 5000 : null, …)`;
  caption shows `● Live` (pulsing, accent) when `data.live`, plus harness icon via
  `HarnessIcon` instead of the bare harness word (item 19).
- Item 15 — render ALL rows: today `parseSessionLogs` silently drops rows that fail JSONL
  decode and `MessageCard` returns null for empty renders. Required: compute
  `parsedRowIds` coverage — any input row whose content never contributed to a parsed
  message must still render, as a `.t-raw` fallback block (mono, pre-wrap, dim header
  "Unparsed · <cli>"). Practical approach: extend the local transform around
  `parseSessionLogs` — try/catch JSON.parse per row first; rows that parse but normalize to
  nothing surface through the adapter's provider_meta path already; rows that don't parse
  go straight to `.t-raw`. Keep ordering (insert raw rows by their position).
- Custom components per event type (item 15): distinct visual treatments for assistant text,
  user text, thinking (collapsed), tool card (⚙ name + PrettyView/JsonView input + result
  body, red when error), provider_meta line, iteration divider, raw fallback. Most exist —
  polish + ensure every `ContentBlock` type has a dedicated component; capitalize captions
  ("Thinking (1 234 chars)", "Show All", "N Internal Events").
- Tool inputs may use `JsonView` (code-like), but consider `PrettyView` for flat objects.

### 6.5 WP-SCENARIOS2 — scenarios + configs pages

Owns: `pages/ScenariosPage.tsx`, `pages/scenarios.css`, `pages/ConfigsPage.tsx` (replaces stub
body; props contract `{ configId: string | null }` is frozen), `pages/configs.css` (NEW).
Implements: items 12 (+ 2/3/10/14/18/19 in-page).
- ConfigsPage list: `DataTable<ConfigJson>` over `listConfigs()` — columns: Id (EntityLink
  config — on this page link is self-referential, render plain), Harness (`HarnessIcon`
  showLabel, `filterOptions` by provider with `filterRender` icon), Model (`ModelChip`),
  Tier, Env Keys (count + tooltip), Default (`✓`/dim `—` glyph). Row click → `#/configs/:id`.
- ConfigsPage detail (`configId` set): header (icon + label + id), `PrettyView` of the config,
  and a "Recent Attempts" table IF cheaply available — there is NO per-config attempts
  endpoint; do NOT add one (server is WP-API2's and frozen to §4). Either omit the table or
  derive from `listRuns()` cells client-side (pass-rate per scenario for this config).
- ScenariosPage: scenario definition switches from `JsonView` to `PrettyView`
  (labels for outcome fields; `defaultRaw={false}`); judges column → glyphs with tooltips
  (llm `✶`, agentic `✶✶` or distinct glyph — keep consistent with WP-RUNDETAIL2: deterministic
  `≡`, llm/agentic `✶`); recent-attempts table: config column → `HarnessIcon` + EntityLink,
  status+score may join via `StatusScore`; all cells single-line with titles; capitalize copy.

---

## 7. Ownership matrix (wave 1)

| Package | Files (exclusive) | Items |
|---|---|---|
| WP-API2 | `evals/src/api/server.ts` | 1 (server) |
| WP-RUNS2 | `pages/RunsPage.tsx`, `pages/NewRunDialog.tsx`, `pages/runs.css` | 6, 9, 11, 13 |
| WP-RUNDETAIL2 | `pages/RunDetailsPage.tsx`, `pages/run-details.css`, `pages/Waterfall.tsx` (NEW) | 4, 7, 16, 17 |
| WP-TRANSCRIPT2 | `pages/Transcript.tsx`, `pages/transcript.css`, `logs-parser/*` | 1 (client), 15 |
| WP-SCENARIOS2 | `pages/ScenariosPage.tsx`, `pages/scenarios.css`, `pages/ConfigsPage.tsx`, `pages/configs.css` (NEW) | 12 |

Cross-cutting items 2, 3, 5, 8, 10, 14, 18, 19 are delivered by the wave-0 shared layer and
applied by every page package within its own files. Disjointness: pairwise file
intersections are empty. ✓

## 8. Verification (every wave-1 package)

```bash
cd /Users/taras/Documents/code/agent-swarm/evals
bun run tsc:check            # zero errors in your files
bun run ui:build             # integrator runs this after merging; safe to run if you're last
cd .. && bunx biome check --write <your files>
```

Manual E2E (integrator): boot `bun src/cli.ts serve`, open `#/runs` — filters row + search
row on the left, five columns, glyph statuses; open a run — fixed header, independently
scrolling columns, tabs `Transcript | Checks n/m · Judge ✓ | Timings | Assets`; timings tab
waterfall hover; assets kind icons; `#/configs` lists configs with harness icons and model
chips; new-run dialog has no horizontal scrollbar; tooltips never clip at viewport edges;
trigger a live run and watch the transcript grow while the attempt runs (`live: true`
responses), then settle to stored artifacts after finish.
