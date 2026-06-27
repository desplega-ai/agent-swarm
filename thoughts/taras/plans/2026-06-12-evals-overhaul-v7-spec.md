---
date: 2026-06-12
topic: "Evals round 7 — transcript per-task tabs, run-header cell aggregates, scenario-detail layout, fable pin, dummy-scenario cleanup, analytics v2 (multi-select, min/max cost, harness/vendor rollups, scatter, highlights), claude alias resolution, worker templates, roster + per-worker cost, universal tokens, heterogeneous rosters + lead"
author: Claude (W70 design+wave-0 agent)
git_commit_at_design: 4c87730c
branch: feat/evals-subproject
status: ready-for-implementation (wave 0 landed in-tree, uncommitted)
---

# Evals v7 implementation spec

Round-7 asks (items 1–12) from Taras, designed against commit `4c87730c` plus the
wave-0 changes ALREADY IN THE WORKING TREE (see §0). Written for blind parallel
implementation: every cross-package contract is **FROZEN**. Implementers must not
deviate from frozen shapes without going back to Taras. *Implementation note*
sections are advisory.

Reference screenshots (artificialanalysis.ai):
- `~/.claude/image-cache/d90b7981-dfcf-4814-aaf0-f576fdd153bf/4.png` — highlights
  row: three side-by-side mini bar charts (Intelligence / Speed / Price), one
  colored bar per model, value labels on top, slanted model names below.
- `…/6.png` — Coding Agents scatter: "Index vs. Total Tokens", shaded green
  "most attractive quadrant" (top-left = high index, low tokens), color-by
  Model/Agent toggle, provider color legend.

**Hard rules carried over:** old rows/blobs render gracefully everywhere; no
NaN/Infinity in any aggregate (null on empty denominators, per v5 §1.3); no E2B
spend during implementation; `evals/evals.db` back-compat is sacred.

---

## 0. Wave 0 — already landed in the working tree (do NOT re-implement)

The following is implemented, tested, and tsc/ui-build green. Later WPs **consume**
these; they do not change them.

| Area | File(s) | What landed |
|---|---|---|
| Alias util (§8) | `evals/src/cost/model-alias.ts` (+ `.test.ts`) | `buildClaudeAliasMap` / `resolveClaudeAlias` — pure, frozen rule |
| Alias adoption | `evals/src/cost/pricing.ts` | `getClaudeAliasMap()` (cached); `lookupModelCost("claude", …)` resolves bare aliases FIRST |
| Alias → UI | `evals/src/api/server.ts` `/api/models` | response gains `aliases: Record<string,string>` |
| Alias in UI | `evals/ui/src/hooks.ts` `useModels()` | `resolve()` maps bare aliases through `aliases` before candidate matching — ModelChip now resolves "fable" etc. with zero changes |
| Fable pin (item 4) | `evals/configs/index.ts` | `claude-fable` config model = `"claude-fable-5"`, label "Claude Code / fable 5" |
| WorkerSpec + lead types (items 9/12) | `evals/src/types.ts` | `WorkerSpec` (template/name/systemPrompt/configId/model/env), `Scenario.workers: number \| WorkerSpec[]`, `Scenario.lead?: WorkerSpec`, `TaskSpec.worker: number \| "lead"`, helpers `scenarioWorkerCount` / `scenarioWorkerSpec` / `totalTokenCount`, `SandboxWorkerInfo` + `WorkerRosterEntry` v7 fields |
| Validation + serialization | `evals/src/registry.ts` (+ `registry.test.ts`) | member-spec rules (§9.2/§12.2), `SerializedScenario` v4 (`workerSpecs`, `lead`), reserved-env set |
| Runner staging | `evals/src/runner/index.ts` | `scenarioWorkerCount` at the `bootStack` call; `resolveWorker` throws a clear error on `worker:"lead"` until WP-CORE wires it |
| Analytics v2 types | `evals/src/types.ts`, `evals/ui/src/types.ts` | `AnalyticsTokenSums`, `AnalyticsGroupRollup`, `AnalyticsScatterPoint`, v7 fields on `AnalyticsCell`/`AnalyticsModel`/`AnalyticsSeriesPoint`/`AnalyticsResponse`, `CellJson.passed?/avgCostUsd?`, roster/sandbox JSON mirrors, `WorkerSpecJson`, `ScenarioJson.lead` |
| Chart primitives | `evals/ui/src/components/charts/` | `ScatterChart.tsx` (§C2), `MiniBarChart.tsx` (§C3), `chart-utils.ts` `HARNESS_COLORS`/`VENDOR_COLORS`/`colorForGroup` (§C1), `charts.css` classes |

Everything below that says "wave 0" refers to this table.

---

## A. Research findings (Task A — verified against the root repo, read-only)

### A.1 Worker template / identity env contract (item 9)

Consumed by `src/commands/runner.ts` (worker side) + `docker-entrypoint.sh`:

| Env var | Effect (verified location) |
|---|---|
| `TEMPLATE_ID` | `runner.ts` ~3791: fetched from the registry via `fetchTemplate(id, registryUrl, "/workspace/.template-cache")`. Applies `config.agentDefaults` as fallbacks: `role` (free-form profile role), `capabilities[]`, `maxTasks`, `isLead` — plus the template's identity files (claudeMd/soulMd/identityMd/toolsMd/setupScript/heartbeatMd, see `templates/schema.ts`). Env/config values take precedence over template defaults. Fetch failure is non-fatal (warn + continue). |
| `TEMPLATE_REGISTRY_URL` | Default `https://templates.agent-swarm.dev`. |
| `AGENT_NAME` | Registered agent name. Precedence: `AGENT_NAME` > template `displayName` > `${role}-${agentId.slice(0,8)}`. |
| `SYSTEM_PROMPT` / `SYSTEM_PROMPT_FILE` | Additional system prompt appended after the base prompt. |
| `AGENT_ROLE` | `docker-entrypoint.sh` ~280: `worker` (default) or `lead`. YOLO resolves from `LEAD_YOLO` / `WORKER_YOLO` per role; evals passes `YOLO=true` which both branches honor. |
| `MAX_CONCURRENT_TASKS` | `resolveMaxConcurrent(...)`; default 1 for workers, **2 for leads**. |

Template slugs: `templates/official/` + `templates/community/` (e.g. coding/research
agents); `agentDefaults.isLead` exists in the schema — a template can make a lead.

### A.2 `GET /api/agents` (item 10)

`src/http/agents.ts` `listAgents` → `{ agents: (Agent & { capacity })[] }`, slim by
default (no identity-markdown blobs). Relevant fields per `AgentSchema`
(`src/types.ts`): `id`, `name`, `isLead: boolean`, `status` (`idle | busy | offline |
waiting_for_credentials`), `role?` (free-form), `capabilities: string[]`,
`maxTasks?`, `lastActivityAt?`, `provider?`, `harnessProvider?` (worker-pushed),
`credStatus?`, `createdAt`, `lastUpdatedAt`, plus `capacity: { current, max,
available }`. Auth: `Authorization: Bearer <swarmKey>` (same as the rest of the
eval stack's calls).

### A.3 Claude alias rule (item 8) — verified output against the committed snapshot

From `src/be/modelsdev-cache.json` `anthropic` section, the frozen rule (see
`model-alias.ts` header) yields today:
`opus → claude-opus-4-8`, `sonnet → claude-sonnet-4-6`, `haiku → claude-haiku-4-5`,
`fable → claude-fable-5`, `mythos → claude-mythos-5`. "Latest" = max
`release_date`, ties broken by lexicographically greatest id; dated (`-YYYYMMDD`)
and `-latest` ids never win; families are derived from purely-alphabetic dash
tokens (future families alias automatically). Resolution happens at READ time only
— never persisted onto rows.

### A.4 Token availability today (item 11) — the gap

`runAttemptOnce` cost block (`evals/src/runner/index.ts` ~line 730): when ≥1
priced session-cost row exists → `costSource="harness"`, `tokens =
sumRowTokens(allRows)`. `SessionCostRow` token columns are nullable — harnesses
can post priced rows with NULL tokens, leaving `tokens_json` all-zero. The
recompute extractor (`evals/src/cost/recompute.ts`) only runs on the UNPRICED
branch. Fix contract in §11.

### A.5 Lead boot + routing (item 12)

- `src/commands/e2b.ts`: a lead is E2B `SwarmRole:"worker"` (same worker template
  + `/docker-entrypoint.sh`) with `AGENT_ROLE=lead` pinned by the LEAD spec
  (`agentRole:"lead"`, env scope `"lead"`, metadata `swarmRole:"lead"`,
  id prefix `e2b-lead`). `start-stack` boots API + lead + workers natively.
- `src/commands/runner.ts` ~3816: `isLead = config.role === "lead" ||
  template.agentDefaults.isLead` → registers with `isLead: true`, default
  maxTasks 2.
- **Routing confirmed** — `src/http/tasks.ts` ~374: `POST /api/tasks` without
  `agentId` defaults to `getLeadAgent().id` (first agent with `isLead`). This is
  the lead-orchestration entry point; yesterday's "unassigned tasks rot" gotcha
  only applies to lead-less stacks.

### A.6 Per-member harness/model env + credential isolation (item 12)

`evals/src/swarm/sandbox.ts` already builds env PER SANDBOX:
`workerRuntimeEnv({ config })` sets `HARNESS_PROVIDER`, `MODEL_OVERRIDE`, and
merges `credentialsForConfig(config)` — claude → `CLAUDE_CODE_OAUTH_TOKEN` else
`ANTHROPIC_API_KEY`; codex → `OPENAI_API_KEY`; pi/opencode → key chosen by the
model's prefix (`anthropic`/`openai`/else `OPENROUTER_API_KEY`). Because env is
per-sandbox, heterogeneous rosters get credential isolation for free: each member
receives ONLY its effective config's keys (the known claude-creds-win-inside-
the-harness gotcha stays confined to claude members). The host (evals runner env)
must carry the union of keys for every provider in the roster — missing keys
throw the existing per-key error at boot, fail-fast before E2B spend.

---

## 1. §1 — Transcript per-task sub-tabs (item 1)

**Owner: WP-RD7** (`evals/ui/src/pages/Transcript.tsx`, `transcript.css`,
`RunDetailsPage.tsx` call site).

Frozen contract:

```ts
// Transcript props (additive — both optional, existing call sites keep compiling)
export default function Transcript(props: {
  attemptId: string;
  live?: boolean;
  /** v7 §1: attempt.taskIds in creation order — fixes sub-tab order + labels. */
  taskIds?: string[];
  /** v7 §1: taskId → display title (from the tasks.json artifact when loaded). */
  taskTitles?: Record<string, string>;
}): ReactNode;
```

Rules (frozen):
- Sub-tabs render **only when** the loaded transcript has `rows` (not the legacy
  flat-`text` source) **and** the rows span **> 1 distinct non-empty `taskId`**.
  Otherwise the component renders exactly as today.
- Tab bar: `All` (default, current behavior) + one tab per task. Task order =
  `props.taskIds` order, falling back to first-appearance order in rows. Label =
  `Task ${n}` (1-based); when `taskTitles[taskId]` exists append ` · <title>`
  (truncate title at ~32 chars); tab tooltip = full task id.
- Selecting a task tab filters rows client-side on `row.taskId`; rows with an
  empty `taskId` (synthesized fallback rows from old artifacts) appear ONLY in
  `All`.
- Live mode: filtering is reapplied on every poll; the selected tab persists
  across refreshes (component state).
- RunDetailsPage passes `taskIds={attempt.taskIds}`; `taskTitles` is optional
  (may be wired from the `tasks.json` artifact if already fetched — do not add a
  new fetch just for titles).

---

## 2. §2 — Run-header per-cell aggregates (item 2)

**Owners: WP-AAPI7** (`evals/src/results.ts` + its assertions in server tests),
**WP-RD7** (header band UI).

### 2.1 CellSummary v7 (results.ts — FROZEN, additive)

```ts
export interface CellSummary {
  // …existing fields unchanged (scenarioId, configId, attempts, finished,
  // passedAny, passedFirst, bestScore, avgScore, totalCostUsd, avgDurationMs, errors)
  /** v7 §2: COUNT of passed attempts in the cell. */
  passed: number;
  /** v7 §2: attempts with costUsd !== null. */
  pricedAttempts: number;
  /** v7 §2: totalCostUsd / pricedAttempts; null when 0 priced. */
  avgCostUsd: number | null;
}
```

UI mirror `CellJson` already declares `passed?` / `avgCostUsd?` (wave 0);
WP-AAPI7 adds `pricedAttempts?: number` to `CellJson` too (one-line UI types
edit is granted to WP-AAPI7 for this field only). Old cached payloads lack the
fields → UI renders "—" (never NaN).

### 2.2 Header band (WP-RD7) — semantics frozen, layout advisory

- When `run.attemptsPerCell > 1`, render a **Cell Summary** band in the
  `rd-top` panel (below the meta grid): one row per cell with ≥1 attempt:
  `scenario × config · passed/attempts · best score · avg score · Σ cost ·
  avg cost · avg duration`, each cell row linking to its first attempt (same
  href scheme as the Matrix). Data source: `run.cells` — it already aggregates
  across the N attempts; no new endpoint.
- When `attemptsPerCell === 1`, the band is omitted (the matrix already tells
  the story).
- Number rules: scores via `fmtScore`, costs via `fmtCost`, duration via
  `fmtDuration`; null → "—". Sort: scenarioId then configId (stable).
- Collapsible when > 8 cells (`details`-style toggle), default collapsed at
  > 8, expanded otherwise.

---

## 3. §3 — Scenario detail layout (item 3)

**Owners: WP-SCEN7** (`evals/ui/src/pages/ScenariosPage.tsx`, `scenarios.css`),
**WP-AAPI7** (the unregistered-scenario response change, §5.3).

Frozen rules:
- The Definition panel becomes a **two-column layout** (CSS grid,
  `grid-template-columns: minmax(260px, 1fr) 2fr`, stacking to one column under
  900px):
  - **Left — facts:** id, judges, worker count + member chips (from
    `workerSpecs` / `lead`, §9.4), timeout, pass threshold, checks list, seed
    summary (sqlDump name, memory count).
  - **Right — prose:** Description, then one block per judge rubric (LLM /
    agentic), then Tasks (title + description per task, worker/lead badge +
    dependsOn), then Seed exec commands.
- **Auto-expanded with clamp**: description and each rubric render as styled
  text (NOT inside PrettyView), auto-expanded; when the rendered block exceeds
  **320px** it clamps (`max-height: 320px; overflow: hidden`) with a bottom
  fade and a `Show more / Show less` toggle. Class names frozen: `.sc-clamp`,
  `.sc-clamp.expanded`, `.sc-clamp-toggle`.
- **Exec overflow fix (frozen):** seed exec commands render in
  `.sc-exec pre { overflow-x: auto; white-space: pre; max-width: 100%; }` —
  never overflow the panel. Same treatment for any `<code>` block in the task
  descriptions.
- `PrettyView` survives ONLY as a collapsed "Raw JSON" toggle at the bottom of
  the Definition panel. **Do not modify `PrettyView.tsx`** (shared component;
  out of every WP's ownership this round).

---

## 4. §4 — Fable config (item 4) — DONE (wave 0)

`evals/configs/index.ts`: `claude-fable` → `model: "claude-fable-5"`. Historical
rows that stored bare `fable` resolve at read time via §8. No other WP action.

---

## 5. §5 — Dummy-scenario cleanup + smoke designation (item 5)

**Owner: WP-CORE** (scenarios/), **WP-AAPI7 + WP-SCEN7** (graceful fallback).

### 5.1 Decision (wave 0 decides — this is it)

- **Remove `hello-file` and `quick-reasoning`** from the registry: delete
  `evals/scenarios/hello-file.ts` + `evals/scenarios/quick-reasoning.ts`, drop
  both from `evals/scenarios/index.ts`.
- **`memory-seeded-recall` is the designated smoke scenario**: 1 worker, 1 task,
  deterministic-only (zero judge LLM spend), ~cheapest possible run, AND it
  meaningfully exercises a real swarm capability (seeded-memory embed +
  retrieval — the F2 E2E gate). `DEFAULT_SCENARIO_IDS = ["memory-seeded-recall"]`.
- WP-CORE appends to its description: *"Designated smoke scenario — cheapest
  meaningful end-to-end verification (run this first after harness changes)."*
  and notes the EMBEDDING_API_KEY / OPENAI_API_KEY requirement in
  `evals/README.md` (smoke section).

### 5.2 Graceful unregistered-scenario rendering — consumer-by-consumer (frozen)

Historical runs referencing `hello-file` / `quick-reasoning` MUST keep rendering:

| Consumer | Behavior (verified + required) |
|---|---|
| Runs list / run details / Matrix / analytics heat rows | Use stored `scenarioId` strings, no registry lookup — **already safe**, no change. |
| `EntityLink kind="scenario"` | Renders the bare id as the label and links to the detail route — **already safe**. |
| Runner resume (`executeAttempt`) | `registry.scenarios.get` miss → attempt errors cleanly with `unknown scenario <id>` (verified ~line 1141) — **already safe**. |
| `POST /api/runs` | 400 `unknown scenario "<id>"` — already correct; the NewRunDialog surfaces it. |
| `GET /api/scenarios/:id` | **CHANGED (WP-AAPI7, frozen):** unknown id now returns **200** `{ scenario: null, scenarioId: string, recentAttempts: AttemptJson[] }` (recentAttempts still queried by the bare id — `listAttemptsByScenario` is registry-independent). Known ids keep the existing `{ scenario, recentAttempts }` shape. |
| ScenariosPage detail | **WP-SCEN7:** when `scenario === null`, render a fallback header — bare id chip + dim note `Unregistered scenario (removed from the registry — historical attempts below)` — plus the Recent Attempts table. No Definition panel. |
| NewRunDialog | Lists only registered scenarios — removed ids simply aren't offered (no change). |

UI `ScenarioDetailResponse` type: WP-AAPI7 updates the UI mirror
(`getScenario` return type) to `{ scenario: ScenarioJson | null; scenarioId?: string;
recentAttempts: AttemptJson[] }`.

---

## 6. §6 — Analytics selectors + cost min/max + metric options (item 6)

**Owners: WP-AAPI7** (server fields), **WP-AUI7** (page).

### 6.1 Server (WP-AAPI7) — frozen, all fields ALWAYS populated by the v7 server

Aggregation source gains tokens: `ANALYTICS_SQL` adds
`json_extract(a.tokens_json,'$.inputTokens') AS token_input` (likewise
`output/cacheRead/cacheWrite`) and `AnalyticsSourceRow` gains
`tokenInput/tokenOutput/tokenCacheRead/tokenCacheWrite: number | null`
(`evals/src/api/analytics.ts` owns the row interface).

Frozen aggregate rules (apply to cells, series points, models, group rollups):
- `minCostUsd` / `maxCostUsd` = min/max over the group's priced attempts
  (`costUsd !== null`); null when 0 priced.
- `tokens: AnalyticsTokenSums | null` — see wave-0 type. An attempt is
  **token-bearing** iff `(tokenInput ?? 0) + (tokenOutput ?? 0) +
  (tokenCacheRead ?? 0) + (tokenCacheWrite ?? 0) > 0`. Sums are over
  token-bearing attempts only; `avgTotalTokens = totalTokens / tokenAttempts`,
  null when none; the whole object is null when the group has 0 token-bearing
  attempts. Never NaN/Infinity.
- These land on `AnalyticsCell`, `AnalyticsSeriesPoint`, `AnalyticsModel`
  (wave-0 optional fields — the server always fills them).

### 6.2 Page (WP-AUI7) — frozen semantics

- **Trends selectors become `MultiSelect`** (the existing component in
  `DataTable.tsx`): one MultiSelect for scenarios, one for configs. The plotted
  series = every (scenario, config) pair in the cartesian product of the
  selections that has a series, **capped at 8 series** (cap frozen; excess pairs
  dropped in series-size order with a dim note `showing 8 of N`). Default
  selection: the single best pair (today's default). Colors: `seriesColor(i)`;
  legend = LineChart's existing multi-series legend; version markers render
  only when exactly 1 series is plotted (markers are per-series).
- **Cost section metric seg** adds `Min Cost` (`cell.minCostUsd`) and
  `Max Cost` (`cell.maxCostUsd`) after `Avg/Total/Judge`. Cell tooltip gains
  Min/Max rows.
- **Models section metric seg** adds `Duration` (`avgDurationMs`, fmtDuration)
  and `Accuracy` (`avgScore`, fmtScore) — bar chart sorts ascending for
  Duration (faster = better at the top in horizontal layout), descending
  otherwise. Models table adds a `Tokens` column (`tokens.totalTokens`
  compact-formatted, title = in/out/cacheR/cacheW breakdown; "—" when null).

---

## 7. §7 — Harness / vendor rollups + scatter (item 7, screenshots)

**Owners: WP-AAPI7** (payload), **WP-AUI7** (sections).

### 7.1 Vendor + harness keys (frozen)

- `harness` group key = registry harness provider(s) of the attempt's configId
  (`registry.configs.get(configId).provider`); when the config is no longer in
  the catalog, fall back to the configId prefix before the first `-`
  (`"claude-fable" → "claude"`); final fallback `"(unknown)"`.
- `vendor(modelKey)` (frozen rule, server-side only — UI receives it):
  1. modelKey contains `/` → first segment lowercased (`"deepseek/x" → "deepseek"`,
     openrouter-style ids);
  2. starts with `claude` → `anthropic`;
  3. matches `/^(gpt|o\d|codex|davinci)/` → `openai`;
  4. starts with `gemini` → `google`;
  5. parenthesized config fallback key `"(configId)"` → `"(unknown)"`;
  6. else `"(unknown)"`.
- Model key precedence is unchanged (tokens.model → registry config model →
  `"(configId)"`). Bare claude aliases in tokenModel are resolved through the
  §8 alias map BEFORE vendor/model grouping, so historical `fable` rows group
  under `claude-fable-5` / `anthropic`.

### 7.2 Payload (frozen — wave-0 types)

`AnalyticsResponse` gains:
- `harnesses: AnalyticsGroupRollup[]` — one rollup per harness key, sorted by
  attempts desc;
- `vendors: AnalyticsGroupRollup[]` — same per vendor key;
- `scatter: AnalyticsScatterPoint[]` — **one point per model key**, fields per
  the wave-0 type: `x` material = `avgTotalTokens`, `y` material = `avgScore` and
  `passRate` (both shipped; UI picks), plus `vendor`, `harnesses[]`, `attempts`,
  `graded`, `avgCostUsd`, `avgDurationMs`, `totalTokens`.

`AnalyticsGroupRollup` aggregation = same MetricAcc rules as models (passRate =
passed/graded, means over non-null, min/max cost per §6.1, tokens per §6.1;
`models[]` = distinct contributing model keys, `configIds[]`, `runs` = distinct
runIds).

### 7.3 UI sections (WP-AUI7) — semantics frozen, layout advisory

- **Highlights row** (top of the page, à la screenshot 4): three `.an-highlight`
  cards in one grid row — `Accuracy` (avgScore per model), `Speed`
  (avgDurationMs per model — subtitle "lower is better"), `Price`
  (avgCostPerAttempt per model — "lower is better"). Each card = `MiniBarChart`
  (§C3) over the top **8** models by attempts; bar color =
  `colorForGroup(vendor, VENDOR_COLORS)`; value formats: fmtScore / fmtDuration
  / fmtCost. Cards with no data render the chart's empty state.
- **Scatter section** ("Efficiency — score vs tokens", screenshot 6):
  `ScatterChart` (§C2) with `x = avgTotalTokens` (label "Avg total tokens per
  attempt"), `y` toggled by a Seg control `Score | Pass Rate` (default Score),
  point dropped when its x or selected y is null. `colorBy` Seg `Harness |
  Vendor` (default Vendor): color = `colorForGroup(harnesses[0] ?? "(unknown)",
  HARNESS_COLORS)` or `colorForGroup(vendor, VENDOR_COLORS)`; `group` = the same
  key (legend). Quadrant: `{ x: "low", y: "high", label: "most attractive
  quadrant" }`. `showLabels` when ≤ 14 points. Point radius:
  `4 + min(4, sqrt(attempts))` (advisory). Tooltip: model label (resolved via
  `useModels`), score/passRate, tokens, avg cost, attempts.
- **Rollup table**: one section with a Seg `By Harness | By Vendor` rendering a
  DataTable over `harnesses` / `vendors`: group (with `HarnessIcon` for
  harnesses), models count (tooltip lists them), runs, attempts, pass rate,
  avg score, Σ cost, avg / min / max cost, avg duration, total tokens.

---

## 8. §8 — Bare claude alias resolution (item 8) — DONE (wave 0)

Frozen design (already implemented — listed for reference):
- **Shared util:** `evals/src/cost/model-alias.ts` — pure, no IO. The server is
  the single computer of the map; the **UI receives it** via `GET /api/models`
  → `aliases` and applies it inside `useModels().resolve` (UI never duplicates
  the rule). Pre-v7 cached payloads without `aliases` degrade to the old
  raw-id behavior.
- **Pricing:** `lookupModelCost("claude", id)` tries the alias-resolved id
  first, then the dated-suffix strip, then the raw id — so historical rows and
  `configModel` fallbacks price correctly.
- **Display:** no ModelChip change needed; `resolve("fable")` now returns the
  models.dev entry for `claude-fable-5` (name, pricing card).
- Applies at read/display time for ALL rows, historical included; nothing is
  rewritten in the DB.

---

## 9. §9 — Worker configuration (item 9)

**Owner: WP-CORE** (`evals/src/swarm/sandbox.ts`, `evals/src/runner/index.ts`,
demo scenario; types/validation landed wave 0).

### 9.1 Schema (FROZEN — landed wave 0)

`Scenario.workers?: number | WorkerSpec[]` (number = homogeneous back-compat;
array = one member per entry; 1..3 either way). `WorkerSpec`:

```ts
export interface WorkerSpec {
  template?: string;      // → TEMPLATE_ID (registry slug; A.1)
  name?: string;          // → AGENT_NAME
  systemPrompt?: string;  // → SYSTEM_PROMPT
  configId?: string;      // §12 member config override (catalog id)
  model?: string;         // §12 model override on top of the base config
  env?: Record<string, string>; // merged LAST; reserved keys rejected
}
```

### 9.2 Validation (FROZEN — landed wave 0, `evals/src/registry.ts`)

- array length 1..3; `template` matches `/^[a-z0-9][a-z0-9-]*$/`; `name`
  non-empty + unique across workers AND the lead; env keys
  `/^[A-Z][A-Z0-9_]*$/` and not in `WORKER_SPEC_RESERVED_ENV` (which includes
  the boot-path-owned keys + `TEMPLATE_ID`/`TEMPLATE_REGISTRY_URL`/
  `AGENT_NAME`/`SYSTEM_PROMPT`/`SYSTEM_PROMPT_FILE` — those are set FROM the
  typed fields); `configId` must exist in the config catalog; `model`
  non-empty when present.

### 9.3 Boot wiring (WP-CORE — FROZEN env mapping)

`bootStack` opts change `workers?: number` → `members: BootMember[]` (the
runner resolves them; count semantics unchanged):

```ts
export interface BootMember {
  index: number;                 // 0..N-1 workers; lead = N (§12.4)
  role: "lead" | "worker";
  spec: WorkerSpec;              // {} for default members
  config: HarnessConfig;         // EFFECTIVE config (§12.3)
  /** True iff spec.configId or spec.model overrode the cell config. */
  overridden: boolean;
}
```

Per-member env = today's `workerRuntimeEnv` built from the member's EFFECTIVE
config, with these additions (frozen merge order, later wins):
1. base runtime env (unchanged keys; `AGENT_ROLE` = member role,
   `MAX_CONCURRENT_TASKS` = `"1"` for workers / `"2"` for the lead);
2. `credentialsForConfig(effectiveConfig)`;
3. `effectiveConfig.env ?? {}`;
4. identity envs from the spec: `TEMPLATE_ID` (when `spec.template`),
   `AGENT_NAME` (when `spec.name`), `SYSTEM_PROMPT` (when `spec.systemPrompt`);
5. `spec.env ?? {}` (validated non-reserved).

Sandbox metadata: `swarmRole` = member role (`"lead"` for the lead — matches the
root `e2b.ts` convention), `workerIndex` = member index. The claude
OPENROUTER_API_KEY summary-guard injection keys off the member's effective
provider.

`SandboxWorkerInfo` persistence (wave-0 fields): `name`, `agentTemplate`
(= spec.template), `role`, and — ONLY when `overridden` — `configId`,
`provider`, `model` of the effective config (null/absent otherwise; readers
fall back to the cell config).

### 9.4 UI display (WP-SCEN7 / WP-RD7)

- ScenariosPage member chips: per member `worker <i>` / `lead` + template slug +
  name + (override badge `configId[:model]` when present, styled distinctly —
  `.sc-member-override`).
- Run details: §10.3.

### 9.5 Demo (WP-CORE, advisory)

Extend `two-workers` OR add one scenario using `workers: [{ template: …,
name: … }, {}]` so serialization/boot paths get real coverage at the next
verify phase. Choose a real template slug from `templates/official/` at
implementation time; the template fetch failing must stay non-fatal (A.1).

---

## 10. §10 — Run-details roster + per-worker cost (item 10)

**Owners: WP-CORE** (capture + persistence), **WP-RD7** (display).

### 10.1 Capture (WP-CORE — FROZEN)

- New attempts column: `"ALTER TABLE attempts ADD COLUMN workers_json TEXT"`
  appended to the additive migration list in `evals/src/db/client.ts`;
  `db/queries.ts` maps it to `AttemptRow.workers` (parse with the existing
  `parseJsonColumn`, null-safe).
- `SwarmClient` gains `listAgents(): Promise<AgentJson[]>` calling
  `GET /api/agents` (slim) with the stack's bearer; `AgentJson` = the A.2
  subset the roster consumes (id, name, isLead, status, role, capabilities,
  maxTasks, lastActivityAt, provider, harnessProvider).
- Roster snapshot is taken in `runAttemptOnce` during the **cost phase**, after
  the session-cost rows are fetched and BEFORE judging: one `listAgents()` call;
  failure → log + `workers_json` stays null (non-fatal; UI falls back to the
  sandboxJson workers).
- One `WorkerRosterEntry` per boot member (wave-0 type, §0). Field sourcing:
  `index/memberRole/agentId/sandboxId/agentTemplate/configId/model/version`
  from the boot member + WorkerHandle; `name/role/isLead/provider/capabilities/
  maxTasks/lastActivityAt` from the matched agent row (`agentId` match; all null
  + `capabilities: []`, `isLead: memberRole === "lead"` when no match);
  `provider` = `agent.harnessProvider ?? agent.provider ?? effective provider`.
- **Per-member cost rule (FROZEN):** `taskIds` = the attempt's tasks created
  for that member (creation-time mapping; `worker:"lead"` tasks → the lead).
  `costUsd` = Σ `totalCostUsd` over those tasks' session-cost rows (null when
  no priced row); `tokens` = field-wise Σ over those rows (null when the rows
  carry no token data — all-null columns). The Σ of member costs may be less
  than attempt `costUsd` when recompute priced the attempt (recompute is
  per-attempt); that mismatch is allowed and the UI labels member cost as
  "harness-reported".
- Also write a `meta` artifact `roster.json` (redacted) with the same array.

### 10.2 API passthrough (WP-AAPI7)

Attempt serialization in `server.ts` includes `workers` (null on pre-v7 rows) —
shape per `WorkerRosterEntryJson` (wave 0). No new endpoint.

### 10.3 Display (WP-RD7 — semantics frozen)

`SandboxPanel` becomes **Workers & Sandboxes**: per member block (lead first
when present, badge `LEAD`):
- name (roster `name` ?? `worker <index>`), template slug chip, free-form role,
  status-at-capture, capabilities (dim, truncated), maxTasks;
- effective config: ConfigChip of `configId ?? attempt.configId` + ModelChip;
  when the member overrode the cell, an explicit `override` badge
  (`.rd-member-override`) — cell config stays what the attempt row shows;
- per-member cost (`CostBadge`, title "harness-reported Σ over this member's
  tasks") + tokens compact + task count (links: each taskId chips into the
  transcript sub-tab via §1);
- sandbox id (copyable, existing `SbMono`), worker build version, started/
  expires (from the sandboxJson entry joined on `index`).
Fallback: `attempt.workers == null` → render today's sandbox blocks unchanged
(pre-v7 attempts).

---

## 11. §11 — Universal token capture (item 11)

**Owner: WP-CORE** (runner), **WP-AAPI7** (analytics §6.1), **WP-RD7** (attempt
display).

### 11.1 Runner rule (FROZEN)

In `runAttemptOnce`'s cost block: after the harness-priced branch sets
`tokens = sumRowTokens(allRows)` — if `totalTokenCount(tokens) === 0`
(`totalTokenCount` landed wave 0), run the recompute extractor **for tokens
only**: `recomputeCost({...})` exactly as the unpriced branch does, then
`tokens = recompute.result.tokens` when that is non-null and
`totalTokenCount(...) > 0`. `costUsd` and `costSource = "harness"` are NOT
touched. (Heterogeneous rosters: per §12.5 the extractor runs per member and
merges.) Result: every attempt that produced any parseable harness output
carries `tokens_json` regardless of costSource — closing the A.4 gap.

### 11.2 Surfacing

- **Attempt UI (WP-RD7):** `AttemptSummary` adds a `Tokens` meta row:
  `total (in X · out Y · cacheR Z · cacheW W)` compact-formatted, "—" when
  null; title carries exact numbers + dominant model.
- **Analytics:** §6.1 sums + §7 scatter x-axis (`avgTotalTokens`) + models/
  rollup token columns. Total = input + output + cacheRead + cacheWrite
  (matches the root repo's unified context formula).

---

## 12. §12 — Heterogeneous rosters + lead (item 12)

**Owner: WP-CORE** (boot/runner), **WP-RD7/WP-SCEN7/WP-AUI7** (labeling),
types landed wave 0.

### 12.1 Scope (frozen)

Roster **plumbing** lands now: boot a lead, per-member config overrides,
attribution, display. Full lead-driven orchestration **scenarios** (lead
decomposing work, multi-agent delegation rubrics) stay backlog.

### 12.2 Scenario surface (landed wave 0)

`Scenario.lead?: WorkerSpec` — boots ONE extra member with `AGENT_ROLE=lead`
(A.5: registers `isLead`, maxTasks default 2, same worker E2B template +
entrypoint). The lead does NOT count toward the 3-worker cap. `TaskSpec.worker:
"lead"` ⇒ the task is created **WITHOUT `agentId`** — the swarm API routes it
to the lead (A.5), turning the routing default into the orchestration entry
point. Validation (wave 0): `"lead"` tasks require `scenario.lead`.

### 12.3 Member config resolution (FROZEN)

```
base   = spec.configId ? catalog[spec.configId] : cellConfig
model  = spec.model ?? base.model
effective = { ...base, model }          // provider/env/tier from base
overridden = spec.configId !== undefined || spec.model !== undefined
```

- The **cell config remains the primary axis**: `attempts.config_id` is ALWAYS
  the cell's id; analytics cells/series/heat keep grouping by it. Overridden
  members surface through: sandboxJson worker fields (§9.3), roster entries
  (§10), per-member cost/token attribution, and the attempt-level
  `tokens.model` (dominant ACTUAL model observed — so the §7 model scatter and
  model rollups attribute by what actually ran).
- Credential rule (FROZEN, from A.6): each member sandbox receives ONLY
  `credentialsForConfig(effective)` for its own provider; the runner host env
  must carry the union (missing key → existing fail-fast boot error, zero E2B
  spend). `waitForAgentReady` applies per member unchanged.

### 12.4 Boot + indices (FROZEN)

- `BootMember.index`: workers keep 0..N-1 (task `worker: i` semantics
  unchanged); the lead is index **N** with `role: "lead"` and is **appended**
  to `StackHandle.workers` / sandboxJson `workers[]` (readers distinguish by
  `role`, pre-v7 readers see it as an extra worker — acceptable degradation).
- The lead's sandbox/log/artifact capture is identical to workers (sandbox-log
  artifact named by its index; `workerLogIndices` picks it up automatically).

### 12.5 Attribution (FROZEN)

- Session-file capture: `collectHarnessSessionFiles(sandboxId,
  member.effective.provider)` per member (today it wrongly assumes the cell
  provider for all — fix in the same WP-CORE change).
- Recompute fallback: when the roster is heterogeneous (any member overridden
  or a lead with a different provider), the extractor runs **per member** —
  that member's session files + the log rows of that member's tasks, with
  `provider = member.effective.provider`, `configModel =
  member.effective.model ?? null` — and the attempt result is the Σ of member
  costs (null if none priced) and the field-wise Σ of member tokens;
  `TokenTotals.model` = dominant model across ALL members' events. Homogeneous
  rosters keep the existing single-pass path bit-for-bit.
- Per-member roster cost/tokens (§10.1) follow each member's ACTUAL tasks and
  rows — i.e. each member's actual model.

### 12.6 UI labeling (frozen semantics)

- Run details: §10.3 override badge + LEAD badge.
- Scenarios: §9.4 member chips incl. `lead`.
- Analytics: no per-member analytics this round (explicit non-goal); the
  model-keyed views already reflect actual models via `tokens.model`.

---

## C. Component contracts (landed wave 0 — consumers code against these)

### C1 Group colors (`evals/ui/src/components/charts/chart-utils.ts`)

`HARNESS_COLORS` (claude=orange, pi=blue, opencode=green, codex=accent),
`VENDOR_COLORS` (anthropic=orange, openai=accent, google=blue, deepseek=red,
z-ai=yellow, qwen=green), `colorForGroup(group, fixed?)` — fixed map hit
(case-insensitive) else deterministic djb2-hash pick from `CHART_PALETTE`.

### C2 `ScatterChart.tsx` (FROZEN props)

```ts
interface ScatterPoint { key; label; x: number; y: number; color?; group?; r?; tip?: ReactNode }
interface ScatterQuadrant { x: "low"|"high"; y: "low"|"high"; label? }
ScatterChart(props: {
  points: ScatterPoint[]; height?; xLabel?; yLabel?;
  xFormat?; yFormat?; quadrant?: ScatterQuadrant | null;
  showLabels?: boolean; emptyText?: string;
})
```

Behavior: theme-aware hand-rolled SVG, no deps; quadrant = MEDIAN split of the
plotted points on both axes, shaded toward the named corner with a corner
caption (default "most attractive quadrant"); legend from distinct `group`s
(>1); nearest-point hover (≤18px) tooltip — default card shows label + x/y,
`tip` overrides. Callers pre-filter null coordinates and resolve colors.

### C3 `MiniBarChart.tsx` (FROZEN props)

```ts
interface MiniBar { key; label; value: number; color? }
MiniBarChart(props: { bars: MiniBar[]; height?; format?; emptyText? })
```

Vertical mini bars à la screenshot 4: per-bar color, value label on top,
slanted (-28°) truncated name labels below, `<title>` hover with the full
label+value. Order = caller's order; nulls filtered by the caller.

---

## Ownership matrix (disjoint; wave 0 files are FROZEN inputs)

| WP | Owns (create/edit) | Implements |
|---|---|---|
| **WAVE 0 (done)** | `evals/src/types.ts`, `evals/src/registry.ts` (+`registry.test.ts`), `evals/src/cost/model-alias.ts` (+test), `evals/src/cost/pricing.ts` (+test deltas), `evals/src/api/server.ts` (`/api/models` aliases only), `evals/ui/src/hooks.ts`, `evals/ui/src/types.ts`, `evals/ui/src/components/charts/*` (ScatterChart, MiniBarChart, chart-utils, charts.css), `evals/configs/index.ts`, mechanical runner/scenarios-test staging | §0 table |
| **WP-CORE** | `evals/src/swarm/sandbox.ts`, `evals/src/swarm/client.ts`, `evals/src/runner/index.ts`, `evals/src/cost/recompute.ts`, `evals/src/db/client.ts`, `evals/src/db/queries.ts`, `evals/scenarios/*`, `evals/README.md`, their tests | §5.1 removal+smoke, §9.3/9.5 boot, §10.1 roster capture, §11.1 tokens, §12.3–12.5 lead+overrides+attribution |
| **WP-AAPI7** | `evals/src/api/server.ts`, `evals/src/api/analytics.ts`, `evals/src/results.ts`, their tests (+ the single `CellJson.pricedAttempts?` UI-types line) | §2.1 cells, §5.2 scenario-null contract, §6.1 analytics SQL+sums, §7.1/7.2 rollups+scatter payload, §10.2 passthrough |
| **WP-AUI7** | `evals/ui/src/pages/AnalyticsPage.tsx`, `evals/ui/src/pages/analytics.css` | §6.2 selectors+metrics, §7.3 highlights+scatter+rollup sections |
| **WP-RD7** | `evals/ui/src/pages/RunDetailsPage.tsx`, `evals/ui/src/pages/Transcript.tsx`, `run-details.css`, `transcript.css` | §1 sub-tabs, §2.2 header band, §10.3 roster panel, §11.2 tokens row, §12.6 badges |
| **WP-SCEN7** | `evals/ui/src/pages/ScenariosPage.tsx`, `evals/ui/src/pages/scenarios.css` | §3 layout+clamp+overflow, §5.2 unregistered fallback, §9.4 member chips |

Collision rules: `PrettyView.tsx`, `DataTable.tsx`, `EntityLink.tsx`,
`ModelChip.tsx`, `lib/sandbox.ts` are read-only for everyone this round (the
contracts above were designed so no change is needed; if one becomes necessary,
stop and escalate to Taras). `evals/ui/src/api.ts`: WP-AAPI7 may adjust the
`getScenario` return type only.

## Verification plan

### Static / unit (no E2B cost — every WP, every commit)

```bash
cd /Users/taras/Documents/code/agent-swarm/evals && bun run tsc:check   # zero errors
cd /Users/taras/Documents/code/agent-swarm/evals && bun test src/ scenarios/
cd /Users/taras/Documents/code/agent-swarm/evals && bun run ui:build
cd /Users/taras/Documents/code/agent-swarm && bunx biome check evals/<owned files>
```

Required new unit coverage: analytics token sums + min/max + vendor rule +
scatter (synthetic rows incl. null-token and zero-denominator groups — assert
no NaN anywhere via `JSON.stringify` scan); results.ts cell additions;
roster-entry builder (agent-match + no-match); member-config resolution +
credential selection per effective provider; recompute per-member merge;
serialize/validate round-trips (wave 0 already covers registry rules).

### Manual E2E (verify phase — REAL E2B spend, Taras-gated)

```bash
# smoke (designated): memory-seeded-recall × claude-haiku
cd evals && bun run cli run --scenarios memory-seeded-recall --configs claude-haiku

# heterogeneous roster + lead plumbing (once WP-CORE lands its demo scenario)
bun run cli run --scenarios <roster-demo-id> --configs claude-haiku

# then, with `bun run serve` on :4801, eyeball:
#  - run details: cell-summary band (attemptsPerCell>1 run), Workers panel
#    (roster, per-member cost, override + LEAD badges), Tokens row,
#    transcript sub-tabs on a multi-task attempt (e.g. old relay-handoff runs)
#  - analytics: highlights row, scatter (quadrant + color-by toggle),
#    By Harness / By Vendor, Min/Max cost, multi-select trends overlay
#  - scenarios: two-column detail, clamps, exec overflow,
#    #/scenarios/hello-file → unregistered fallback with historical attempts
#  - old v1-era runs (~50 rows in evals/evals.db) still render everywhere
curl -s localhost:4801/api/analytics | python3 -m json.tool | grep -c NaN  # → 0
curl -s localhost:4801/api/models | python3 -c 'import json,sys; print(json.load(sys.stdin)["aliases"])'
curl -s localhost:4801/api/scenarios/hello-file | python3 -m json.tool      # scenario: null + attempts
```
