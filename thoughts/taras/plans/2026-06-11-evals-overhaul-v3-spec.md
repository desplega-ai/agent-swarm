---
date: 2026-06-11T22:30:00Z
topic: "Evals overhaul round 3 — judge traces: full loop logs, LLM cost, live streaming"
status: ready
branch: feat/evals-subproject
supersedes-sections-of: thoughts/taras/plans/2026-06-11-evals-overhaul-v2-spec.md
tags: [evals, judges, traces, cost, live, round-3]
---

# Evals round 3 — judge traces mini-spec

Taras's ask (verbatim intent — every clause is LAW):

> "Store the whole thing (logs) for the agentic and LLM judge: all loop steps, to showcase
> nicely (streaming if possible while in progress), and ESPECIALLY the cost of the LLM.
> Also the elapsed times of those steps (deterministic too). The reasoning is important."

Interpreted requirements:

- **A. Full trace per judgment.** Agentic judge: every tool-loop step — model reasoning/text,
  tool call (name + args), tool output, per-step elapsed, per-step token usage. LLM judge:
  full reasoning/rationale, token usage, duration. Deterministic judge: per-check result +
  elapsed.
- **B. Judge LLM cost.** Tokens × models.dev pricing (judge models are OpenRouter ids →
  `openrouter` section of the snapshot, via `evals/src/cost/pricing.ts`), stored per
  judgment, surfaced in the UI, and aggregated in totals SEPARATELY from task cost. Judge
  cost is harness overhead — it is NEVER mixed into attempt `costUsd`.
- **C. Live streaming.** While an attempt is in its judging phase, the UI streams judge steps
  as they happen. The runner executes in-process with the API server → in-memory live
  registry (module shared by judges and server) + a polled endpoint, same pattern as the
  live transcript.
- **D. UI showcase.** Run-details "Checks & Judgments" tab: step timeline with reasoning
  blocks PROMINENT, tool call/result pairs (collapsible outputs), per-step elapsed badges,
  `ModelChip` + judge cost per judgment, per-check ms for deterministic. Old judgments
  without traces render with "Not captured (older run)" fallbacks.

Wave 0 (WJ0, this spec's author) has ALREADY LANDED everything in §1–§5 — the contracts
layer: shared types, DB columns + queries, the live registry, totals, UI types + API client.
Three wave-1 packages (§6–§8) implement against the ACTUAL CODE in those files and MUST NOT
edit them. Global invariants carry over from rounds 1–2: old DB rows keep rendering (all new
fields nullable, "Not captured" fallbacks, nothing 500s), capitalized UI copy, unicode glyphs
over chips, single-line ellipsis cells, portal tooltips, plain CSS, no new deps, biome-clean
(double quotes, 100-char lines, no `any`), Bun APIs server-side.

---

## 1. Shared types (`evals/src/types.ts` — IMPLEMENTED, read-only for wave 1)

```ts
export type JudgeKind = "deterministic" | "llm" | "agentic";

export type JudgeStepKind = "reasoning" | "tool" | "check" | "error";

/** One step of a judge trace. Field usage varies by kind — see the doc table below. */
export interface JudgeStep {
  /** Position in JudgeTrace.steps. Renumbered whenever a step is inserted mid-array. */
  index: number;
  kind: JudgeStepKind;
  /** reasoning: model reasoning + text · check: detail · error: failure message. */
  text: string | null;
  /** tool: tool name · check: check name. */
  tool: string | null;
  /** tool: the tool-call input object (small by construction). Null otherwise. */
  args: unknown;
  /** tool: clipped JSON string of the tool output (≤ ~8 KB). Null otherwise. */
  output: string | null;
  /** check: pass/fail. Null for every other kind. */
  pass: boolean | null;
  startedAt: string; // ISO
  durationMs: number | null;
  /** reasoning: the LLM call's usage. Null for tool/check/error steps. */
  tokens: TokenTotals | null;
  /** reasoning: priced usage (null when the model is unpriced). */
  costUsd: number | null;
}

export interface JudgeTrace {
  judge: JudgeKind;
  /** Resolved judge model id (OpenRouter id). Null for deterministic. */
  model: string | null;
  startedAt: string; // ISO
  finishedAt: string | null; // null while the judge is still running (live view)
  durationMs: number | null;
  /** Sum of step costUsd values; null when no step was priced. */
  costUsd: number | null;
  /** Summed usage across reasoning steps; null when there were none. */
  tokens: TokenTotals | null;
  /** Set when the judge crashed or never submitted a verdict. */
  error: string | null;
  steps: JudgeStep[];
}
```

Field-usage matrix (normative):

| kind | text | tool | args | output | pass | tokens/costUsd |
|---|---|---|---|---|---|---|
| reasoning | reasoningText + text of the LLM call (or null) | null | null | null | null | the call's usage / priced cost |
| tool | null | tool name | input object | clipped JSON string | null | null |
| check | check detail (or null) | check name | null | null | check result | null |
| error | failure message | null | null | null | null | null |

`JudgmentRow` gained four REQUIRED-but-nullable fields (old rows → null):

```ts
export interface JudgmentRow {
  // …existing fields unchanged (kind stays "llm" | "deterministic" — the DB CHECK
  // constraint is untouched; agentic judgments keep kind "llm" + name "agentic-judge")…
  durationMs: number | null;
  costUsd: number | null;
  tokens: TokenTotals | null;
  steps: JudgeStep[] | null;
}
```

`AttemptRow` gained:

```ts
  /** Aggregate judge LLM cost (harness overhead) — NEVER included in costUsd. */
  judgeCostUsd: number | null;
```

`RunSummary.totals` (in `evals/src/results.ts`) gained:

```ts
  /** Sum of non-null attempt judgeCostUsd; null when no attempt has one. */
  judgeCostUsd: number | null;
```

---

## 2. DB layer (`evals/src/db/client.ts`, `evals/src/db/queries.ts` — IMPLEMENTED)

Additive `COLUMN_MIGRATIONS` (try/catch-swallow pattern, applied on every `initDb`):

```sql
ALTER TABLE attempts  ADD COLUMN judge_cost_usd REAL;
ALTER TABLE judgments ADD COLUMN duration_ms INTEGER;
ALTER TABLE judgments ADD COLUMN cost_usd REAL;
ALTER TABLE judgments ADD COLUMN tokens_json TEXT;
ALTER TABLE judgments ADD COLUMN steps_json TEXT;
```

`queries.ts` changes:

- `insertJudgment(db, j)` accepts optional `durationMs?: number | null`,
  `costUsd?: number | null`, `tokensJson?: string | null`, `stepsJson?: string | null`.
  The `*Json` params are PRE-SERIALIZED JSON strings (callers `JSON.stringify`, stored
  as-is) — same convention as the attempts `tokensJson`/`sandboxJson`/`timingsJson`.
- `rowToJudgment` parses `duration_ms`/`cost_usd` as numbers and
  `tokens_json`/`steps_json` via `parseJsonColumn` (malformed/empty → null, never throws).
- `updateAttempt` patch gained `judgeCostUsd: number | null` → `judge_cost_usd`.
- `rowToAttempt` parses `judge_cost_usd`.

---

## 3. Live judge registry (`evals/src/judge/live-registry.ts` — IMPLEMENTED, NEW)

Pure in-memory data structure, shared by judges (writers) and the API server (reader) in
the same Bun process. No persistence, no timers, no imports beyond types.

```ts
export interface LiveJudgeSnapshot {
  judging: boolean;
  traces: JudgeTrace[];
}

export interface JudgeLiveHandle {
  /** Register a (mutable) trace for live reads. The judge keeps mutating the SAME object
   *  (pushing steps, setting finishedAt/costUsd/…) — readers see updates by reference. */
  attach(trace: JudgeTrace): void;
}

/** Runner calls when an attempt enters its judging phase. Resets any previous entry. */
export function beginJudging(attemptId: string): JudgeLiveHandle;

/** Runner calls after all judges finish: judging → false, traces stay readable. */
export function endJudging(attemptId: string): void;

/** Runner calls AFTER final persistence (in runAttemptOnce's finally). Deletes the entry. */
export function clearJudging(attemptId: string): void;

/** Server reads in-process. Unknown attemptId → { judging: false, traces: [] } (never null). */
export function getJudgeLive(attemptId: string): LiveJudgeSnapshot;
```

Semantics (normative):

- Traces are shared BY REFERENCE — Bun's single-threaded event loop makes mid-poll
  serialization safe (mutations only happen between awaits). Readers must serialize the
  snapshot immediately (the endpoint `JSON.stringify`s it) and never retain it.
- A handle stays bound to the entry created by its `beginJudging` call; `attach` after
  `clearJudging` is a harmless no-op on a dead entry (the entry is no longer in the map).
- Judges that receive no handle (`live` param undefined, e.g. in tests) work identically —
  the handle is optional everywhere.

---

## 4. Live endpoint contract (FROZEN — implemented by WP-RUNSRV3 in `evals/src/api/server.ts`)

```
GET /api/attempts/:id/judge-live
→ 200 { "judging": boolean, "traces": JudgeTrace[] }
```

- ALWAYS 200. Unknown attempt id, finished attempt, cleared registry entry, restarted
  server — all return `{ "judging": false, "traces": [] }`. No DB lookup, no 404 (frozen
  decision: the UI already has the attempt loaded; a registry-only read can never 500).
- Handler body is exactly `json(getJudgeLive(req.params.id))` plus the existing `json()`
  helper/CORS conventions.
- Finished attempts: the UI uses the persisted judgments instead (§8) — this endpoint is
  only meaningful while `attempt.status === "judging"`.

---

## 5. UI contracts layer (`evals/ui/src/types.ts`, `evals/ui/src/api.ts` — IMPLEMENTED)

```ts
// types.ts (mirrors, never imported from evals/src)
export type JudgeKindJson = "deterministic" | "llm" | "agentic";
export type JudgeStepKindJson = "reasoning" | "tool" | "check" | "error";
export interface JudgeStepJson { /* mirror of JudgeStep (tokens: TokenTotalsJson | null) */ }
export interface JudgeTraceJson { /* mirror of JudgeTrace */ }
export interface JudgeLiveResponse { judging: boolean; traces: JudgeTraceJson[] }

export interface JudgmentJson {
  // …existing fields…
  durationMs: number | null;   // NEW (old rows: null)
  costUsd: number | null;      // NEW — judge LLM cost for this judgment
  tokens: TokenTotalsJson | null; // NEW — tokens.model carries the judge model id
  steps: JudgeStepJson[] | null;  // NEW — full trace steps (llm/agentic); null for old rows
}

export interface AttemptJson { /* + judgeCostUsd: number | null */ }
export interface TotalsJson  { /* + judgeCostUsd: number | null */ }
```

```ts
// api.ts
export function getJudgeLive(attemptId: string): Promise<JudgeLiveResponse>;
// GET /api/attempts/:id/judge-live
```

---

## 6. WP-JUDGES3 — judge instrumentation (wave 1)

Owns: `evals/src/judge/agentic.ts`, `evals/src/judge/llm.ts`,
`evals/src/judge/deterministic.ts`, `evals/src/cost/pricing.ts` (ADDITIVE helper only —
existing exports and `bun test src/cost/` behavior must not change).

### 6.1 Pricing helper (`cost/pricing.ts`, additive)

```ts
/**
 * Price lookup for judge models (OpenRouter ids, e.g. "deepseek/deepseek-v4-pro").
 * Delegates to the pi mapping: "openrouter" section + optional "openrouter/" prefix strip.
 */
export async function lookupOpenrouterModel(modelId: string): Promise<PricedModel | null> {
  return lookupModelCost("pi", modelId);
}
```

### 6.2 Usage mapping + step pricing (both LLM and agentic judges)

AI SDK v6 (`ai@^6`) `LanguageModelUsage`: `inputTokens` is the TOTAL prompt tokens
(cache reads included); the breakdown lives in `inputTokenDetails.{noCacheTokens,
cacheReadTokens,cacheWriteTokens}`. Map and price like this (normative):

```ts
function usageToTokens(model: string | null, usage: LanguageModelUsage): TokenTotals {
  return {
    model,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}
// priced: PricedModel | null — resolve ONCE per judge call, before the LLM call(s):
//   const priced = await lookupOpenrouterModel(model);
// per-step cost (null when priced === null):
//   priced ? priceUsage(priced, stepTokens, { inputIncludesCacheRead: true }) : null
```

`inputIncludesCacheRead: true` because the AI SDK total includes cached tokens (matches the
codex semantic in `priceUsage`). Trace-level rollup: `tokens` = field-wise sum over
reasoning steps (model = the configured judge model id); `costUsd` = sum of non-null step
costs, null when ALL are null.

### 6.3 `llm.ts` (FROZEN signature)

```ts
export interface LlmJudgeInput {
  // …existing fields…
  live?: JudgeLiveHandle; // from ../judge/live-registry.ts
}
export async function judgeWithLlm(
  input: LlmJudgeInput,
): Promise<LlmVerdict & { raw: string; trace: JudgeTrace }>;
```

Behavior:

1. Build `trace = { judge: "llm", model, startedAt: new Date().toISOString(),
   finishedAt: null, durationMs: null, costUsd: null, tokens: null, error: null,
   steps: [] }` and `input.live?.attach(trace)` BEFORE calling `generateObject` (so the
   live view shows the judge as started).
2. Time the `generateObject` call. On success append ONE reasoning step:
   `text` = the result's `reasoning` (model thinking, may be undefined) when non-empty,
   else the verdict's `reasoning` rationale; `tokens` = `usageToTokens(model, result.usage)`;
   `costUsd` = priced step cost; `durationMs` = call elapsed; `startedAt` = call start ISO;
   `index: 0`. Then finish the trace (finishedAt, durationMs, costUsd, tokens rollup).
3. On `generateObject` throw: append an `error` step (text = message), set `trace.error`,
   finish the trace, RETHROW the original error (callers treat it as today).
4. Return `{ ...verdict, raw, trace }` — `raw` keeps today's exact shape
   (`JSON.stringify({ model, object })`).

### 6.4 `agentic.ts` (FROZEN signatures)

```ts
export interface AgenticJudgeInput {
  // …existing fields…
  live?: JudgeLiveHandle;
}

/** Thrown for ANY agentic-judge failure; carries the partial trace so cost is never lost. */
export class AgenticJudgeError extends Error {
  readonly trace: JudgeTrace;
  constructor(message: string, trace: JudgeTrace, options?: ErrorOptions);
}

export async function judgeAgentic(
  input: AgenticJudgeInput,
): Promise<LlmVerdict & { raw: string; trace: JudgeTrace }>;
```

Step-emission algorithm (normative — yields reading order reasoning(call N) →
tools(call N) → reasoning(call N+1) → …, while still streaming tool steps live as they
complete):

1. `trace = { judge: "agentic", model, startedAt, …, steps: [] }`;
   `input.live?.attach(trace)`. Resolve `priced` once (§6.2).
2. Maintain `let callStartIndex = 0; let callStartTime = Date.now();`.
3. **Tool wrappers** (the existing `toolLog` wrappers): around each inner execute, record
   `t0`, run, then push a tool step IMMEDIATELY into `trace.steps` (live visibility):
   `{ kind: "tool", tool: name, args: input, output: JSON.stringify(clipForLog(output)),
   startedAt: ISO(t0), durationMs: Date.now() - t0, tokens: null, costUsd: null,
   pass: null, text: null, index: trace.steps.length }`. Keep the existing `toolLog`
   side-array for `raw` — unchanged.
4. **`onStepFinish(step)`** (new `generateText` option; the event IS the `StepResult`):
   build the reasoning step for the finished LLM call —
   `text` = `[step.reasoningText, step.text].filter(non-empty).join("\n\n")` or null;
   `tokens` = `usageToTokens(step.model?.modelId ?? model, step.usage)`;
   `costUsd` = priced step cost; `startedAt` = ISO of `callStartTime`;
   `durationMs` = `max(0, (Date.now() - callStartTime) - sum(durationMs of tool steps at
   index ≥ callStartIndex))` (the call's own latency, tools excluded).
   INSERT it at `callStartIndex` (`trace.steps.splice(callStartIndex, 0, step)`), renumber
   every `steps[i].index = i`, then `callStartIndex = trace.steps.length;
   callStartTime = Date.now();`. ALWAYS emit the reasoning step (even with null text) — it
   carries the call's tokens/cost/elapsed.
5. On success (verdict submitted): finish the trace (finishedAt, durationMs, costUsd,
   tokens rollup) and return `{ ...verdict, raw, trace }` (`raw` keeps today's shape).
6. On failure — no verdict after the loop, OR `generateText` itself throws: append an
   `error` step (text = message), set `trace.error = message`, finish the trace, and throw
   `new AgenticJudgeError(message, trace)` (wrap the inner error via `options.cause`).
   `judgeAgentic` NEVER throws anything but `AgenticJudgeError`.

### 6.5 `deterministic.ts` (FROZEN signatures)

```ts
export interface CheckRunResult extends CheckResult {
  name: string;
  durationMs: number; // NEW — per-check elapsed
}
export async function runChecks(
  checks: DeterministicCheck[],
  ctx: JudgeContext,
  live?: JudgeLiveHandle,
): Promise<CheckRunResult[]>;
```

Behavior: build + attach `trace = { judge: "deterministic", model: null, … }`; per check,
time it and push a check step
`{ kind: "check", tool: check.name, text: detail ?? null, pass, startedAt, durationMs,
args: null, output: null, tokens: null, costUsd: null, index }` as it completes (thrown
checks stay failures with the `check threw: …` detail, as today); finish the trace
(durationMs total; costUsd/tokens stay null). Return results including `durationMs`.

Verify (WP-JUDGES3): `cd evals && bun run tsc:check` (clean in owned files);
`bun test src/cost/` still green; biome on owned files.

---

## 7. WP-RUNSRV3 — runner persistence + live endpoint (wave 1)

Owns: `evals/src/runner/index.ts`, `evals/src/api/server.ts`.

### 7.1 Runner (`runner/index.ts`) — inside `runAttemptOnce`

- Import `{ beginJudging, endJudging, clearJudging }` from `../judge/live-registry.ts` and
  `{ AgenticJudgeError }` from `../judge/agentic.ts`.
- Right after `updateAttempt(db, attempt.id, { status: "judging" })`:
  `const judgeLive = beginJudging(attempt.id);`.
- **Checks**: `runChecks(checks, ctx, judgeLive)`; each per-check `insertJudgment` gains
  `durationMs: result.durationMs` (steps/cost/tokens stay null for deterministic rows —
  the per-check data IS the row).
- **LLM judge**: pass `live: judgeLive`; persist
  `durationMs: verdict.trace.durationMs ?? llmTimed.ms`, `costUsd: verdict.trace.costUsd`,
  `tokensJson: verdict.trace.tokens ? JSON.stringify(verdict.trace.tokens) : null`,
  `stepsJson: JSON.stringify(verdict.trace.steps)`.
- **Agentic judge**: pass `live: judgeLive`. On `AgenticJudgeError`, keep
  `failedTrace = err.trace`, run the LLM fallback (also with `live: judgeLive` — it
  attaches a SECOND live trace) and persist the MERGED judgment on the existing
  `agentic-judge (llm fallback)` row:
  - `steps` = `[...failedTrace.steps, ...fallbackTrace.steps]`, indexes renumbered
    0..n-1 (the failed trace's `error` step is the natural divider);
  - `costUsd` = sum of the two traces' non-null costs (null when both null) — the failed
    agentic attempt's spend is real and MUST be counted;
  - `tokens` = field-wise sum of both traces' tokens (model = fallback's, else failed's;
    null when both null);
  - `durationMs` = the existing `Date.now() - agenticT0` wall clock.
  Non-fallback path persists the agentic trace's fields directly (same mapping as LLM).
  Errors that are NOT `AgenticJudgeError` cannot occur (§6.4) — no extra handling.
- **Attempt aggregate**: `judgeCostUsd` = sum of the non-null judgment-level `costUsd`
  values persisted above (null when none). Write it in the FINAL `updateAttempt` (the one
  setting passed/failed) via the new `judgeCostUsd` patch field. Do NOT add it to
  `costUsd` — task cost and judge cost stay separate everywhere.
- `endJudging(attempt.id)` immediately after the last judge finishes (before artifact
  persistence) — the live view flips `judging: false` but traces stay readable until clear.
- `clearJudging(attempt.id)` in `runAttemptOnce`'s `finally` (alongside `untrack()`)
  — i.e. AFTER final persistence on success, and on every error path (no registry leaks).
  Retries re-enter via `beginJudging`, which resets the entry.
- `PhaseTimings` is untouched (llmJudgeMs/agenticJudgeMs/checksMs as today).

### 7.2 Server (`api/server.ts`)

Add the §4 route — verbatim contract, nothing else changes:

```ts
"/api/attempts/:id/judge-live": (req) => json(getJudgeLive(req.params.id)),
```

(`listJudgments` already returns the new fields — the `/api/attempts/:id` wire shape gains
them automatically; same for `judgeCostUsd` via `rowToAttempt`/`summarizeRun`.)

Verify (WP-RUNSRV3): `cd evals && bun run tsc:check`; manual: trigger a 1-cell run,
`curl localhost:4801/api/attempts/<id>/judge-live` during judging → traces with steps
growing; after finish → `{judging:false,traces:[]}` and `/api/attempts/<id>` judgments
carry `durationMs/costUsd/tokens/steps`; attempt row carries `judgeCostUsd`; run summary
totals carry `judgeCostUsd`. Old attempts: judgments show the new fields as null.

---

## 8. WP-UI3 — judge-trace showcase (wave 1)

Owns: `evals/ui/src/pages/JudgeTrace.tsx` (NEW), `evals/ui/src/pages/RunDetailsPage.tsx`,
`evals/ui/src/pages/run-details.css`.

### 8.1 `pages/JudgeTrace.tsx` (FROZEN component contract)

```tsx
export default function JudgeTrace(props: {
  trace: JudgeTraceJson;
  /** True while the trace is still being appended (live registry stream). */
  live?: boolean;
}): ReactNode;
```

Rendering rules (requirement D):

- **Header row**: judge label ("Agentic Judge" / "LLM Judge" / "Checks" from `trace.judge`),
  `<ModelChip model={trace.model} />` (skip for deterministic), judge cost
  (`fmtCost(trace.costUsd)` with a tooltip "Judge LLM cost — not included in attempt
  cost"; dim `—` when null), total duration (`fmtDuration(trace.durationMs)`, or a live
  `<Elapsed since={trace.startedAt} />` while unfinished), token total
  (`fmtTokens` of input+output) when present. `trace.error` → a red error line.
- **Step timeline** (ordered by array position): one block per step —
  - `reasoning` steps are PROMINENT: full-width text body (pre-wrap), accent left border;
    meta badges: per-step elapsed (`fmtDuration`), tokens (`fmtTokens`), step cost
    (`fmtCost`). Null text → render just the meta line ("Model call").
  - `tool` steps: compact card — `⚙` glyph + tool name + args summary (single line,
    ellipsis, full args in a tooltip or expandable `PrettyView`); output COLLAPSED by
    default (`▸ Output (n chars)` toggle, mono pre-wrap body); elapsed badge.
  - `check` steps: pass/fail glyph (`✓`/`✗` toned) + check name + detail + elapsed badge.
  - `error` steps: red block with the message.
- **Live tail**: `props.live && !trace.finishedAt` → pulsing `Spinner` row at the end
  ("Judging…").
- All copy capitalized; glyphs over chips; tooltips via the shared portal `Tooltip`;
  styles go in `run-details.css` (suggested class prefix `jt-`).

### 8.2 `RunDetailsPage.tsx` integration

- **Live polling**: `const judging = attempt?.status === "judging";`
  `const livePoll = usePoll(() => (selId && judging ? getJudgeLive(selId) : Promise.resolve(null)), judging ? 2000 : null, [selId, judging]);`
- **ChecksTab routing** (frozen precedence):
  1. `judging` AND `livePoll.data` has ≥ 1 trace → render the LIVE view ONLY: each trace
     as `<JudgeTrace trace={t} live />` (the deterministic trace covers the checks — do
     NOT also render the persisted check judgments; that would double-display).
  2. `judging` with no live traces yet (registry warming, or server restarted and lost
     it) → today's behavior: persisted judgments so far + "Judging…" spinner.
  3. Terminal status → persisted judgments only (see below).
- **Persisted `JudgmentBlock` upgrades**: head row gains per-judgment duration
  (`fmtDuration(j.durationMs)`), judge cost (`fmtCost(j.costUsd)` + the harness-overhead
  tooltip) and `<ModelChip model={j.tokens?.model ?? null} />` for llm-kind judgments
  (fall back to the `model` field parsed from `j.raw` for old rows when tokens are null).
  Deterministic rows show their per-check ms badge. When `j.steps` is non-null, render the
  trace via `<JudgeTrace trace={judgmentToTrace(j)} />` and DEMOTE the raw `PrettyView` to
  an opt-in toggle; when `j.steps` is null on an llm-kind judgment, keep today's
  reasoning + raw rendering and add a dim "Trace not captured (older run)" note.
  Synthesis mapping (frozen):

  ```ts
  function judgmentToTrace(j: JudgmentJson): JudgeTraceJson {
    return {
      judge: j.name.startsWith("agentic") ? "agentic" : "llm",
      model: j.tokens?.model ?? null,
      startedAt: j.createdAt, finishedAt: j.createdAt,
      durationMs: j.durationMs, costUsd: j.costUsd, tokens: j.tokens,
      error: null, steps: j.steps ?? [],
    };
  }
  ```

- **Cost surfacing** (requirement B):
  - Run header meta grid gains `Judge Cost` →
    `fmtCost(totals.judgeCostUsd)` + `InfoTip "Judge LLM cost — not included in Total Cost"`
    (dim `—` when null).
  - `AttemptSummary` meta grid gains `Judge Cost` → `fmtCost(attempt.judgeCostUsd)` with
    the same tooltip (dim `—` when null — old attempts).
- Old-rows rule: everything above must render with ALL new fields null (old DB) without
  errors — nulls become `—` / "Not captured (older run)" notes.

Verify (WP-UI3): `cd evals && bun run tsc:check`; biome on owned files; visual pass via
`bun run ui:dev` against a DB with old + new attempts; live view exercised with a running
attempt in its judging phase.

---

## 9. Ownership matrix (wave 1 — disjoint; shared layer §1–§5 is read-only)

| Package | Files (exclusive) | Implements |
|---|---|---|
| WP-JUDGES3 | `evals/src/judge/agentic.ts`, `evals/src/judge/llm.ts`, `evals/src/judge/deterministic.ts`, `evals/src/cost/pricing.ts` (additive helper only) | §6 |
| WP-RUNSRV3 | `evals/src/runner/index.ts`, `evals/src/api/server.ts` | §7 |
| WP-UI3 | `evals/ui/src/pages/JudgeTrace.tsx` (NEW), `evals/ui/src/pages/RunDetailsPage.tsx`, `evals/ui/src/pages/run-details.css` | §8 |

Wave-0 (ALREADY LANDED): `evals/src/types.ts`, `evals/src/db/client.ts`,
`evals/src/db/queries.ts`, `evals/src/results.ts`, `evals/src/judge/live-registry.ts`,
`evals/ui/src/types.ts`, `evals/ui/src/api.ts`, this spec.

If you believe you must touch a file you don't own — STOP, the spec is wrong; escalate.

## 10. Verification (every wave-1 package)

```bash
cd /Users/taras/Documents/code/agent-swarm/evals
bun run tsc:check                  # zero errors in your files
bun test src/cost/                 # pricing tests stay green (WP-JUDGES3 especially)
cd .. && bunx biome check --write <your files>
```

Manual E2E (integrator): start `bun src/cli.ts serve`, create a 1-scenario × 1-config run
with an agentic-judge scenario; while the attempt is judging, watch the Checks & Judgments
tab stream reasoning/tool/check steps with elapsed badges; after finish, the tab shows the
persisted trace, per-judgment cost + ModelChip, per-check ms; the run header and attempt
summary show Judge Cost separately from Total Cost; open an OLD run — judgments render with
"Trace not captured (older run)" and no 500s anywhere;
`curl localhost:4801/api/attempts/<old-id>/judge-live` → `{"judging":false,"traces":[]}`.
