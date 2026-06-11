---
date: 2026-06-11T16:22:16Z
topic: "Evals dashboard overhaul — file-by-file implementation spec"
status: ready
branch: feat/evals-subproject
pr: 737
tags: [evals, ui, vite, react, cost-tracking, e2b]
---

# Evals dashboard overhaul — implementation spec

Branch: `feat/evals-subproject` (PR #737). Package: `evals/` (self-contained Bun package; API server `evals/src/api/server.ts` on port 4801, libsql DB `evals/evals.db`, runner on E2B).

This spec is **self-contained**: implementer agents execute sections in parallel without other context. Every file path is relative to the repo root. Do NOT redesign the eval engine — only capture more data and present it better. Existing DB rows must keep rendering (all new data is nullable with graceful UI fallbacks).

**Architecture decision (fixed):** the single-file SPA `evals/ui/index.html` is REPLACED by a minimal Vite + React + TypeScript app under `evals/ui/`. Dependencies: `vite`, `react`, `react-dom`, `@vitejs/plugin-react` only (plus `@types/react`, `@types/react-dom`). No Tailwind, no component library, no router lib, no state lib. Plain CSS with variables, light/dark via `data-theme` (persisted in `localStorage["evals-theme"]`, seeded from `prefers-color-scheme`). Hash routing preserved (`#/runs`, `#/runs/:id`, `#/scenarios`, …) via a hand-rolled `useHashRoute` hook.

---

## 0. Route map (final)

| Hash | Page | Notes |
|---|---|---|
| `#/runs` (and empty/unknown hash) | `RunsPage` | 30/70: runs table left, rich detail pane right (selection = component state, newest run preselected) |
| `#/runs/:id` | `RunDetailsPage` | full details page; default selected attempt = first attempt of first cell |
| `#/runs/:id/attempts/:attemptId` | `RunDetailsPage` | with attempt selected |
| `#/runs/:id/cells/:scenarioId/:configId` | **legacy redirect** | App.tsx rewrites to `#/runs/:id/attempts/${id}_${scenarioId}_${configId}_0` (attempt ids are deterministic `${runId}_${scenarioId}_${configId}_${index}` — see `evals/src/runner/index.ts` `attemptId()`) |
| `#/scenarios` | `ScenariosPage` | list |
| `#/scenarios/:id` | `ScenariosPage` | detail |

---

## 1. BACKEND — data capture + schema

### 1.1 Schema additions — `evals/src/db/client.ts` (wave 0)

Follow the existing additive pattern: append to `COLUMN_MIGRATIONS` (line 99) ONLY (do not touch the `SCHEMA` string — `judge_model` sets the precedent of migration-only columns; never modify existing entries):

```ts
const COLUMN_MIGRATIONS = [
  "ALTER TABLE eval_runs ADD COLUMN judge_model TEXT",
  "ALTER TABLE attempts ADD COLUMN cost_source TEXT",
  "ALTER TABLE attempts ADD COLUMN tokens_json TEXT",
  "ALTER TABLE attempts ADD COLUMN sandbox_json TEXT",
  "ALTER TABLE attempts ADD COLUMN timings_json TEXT",
];
```

All four are nullable; old rows render with nulls. Artifact blobs continue to live in the `artifacts` table (the package's existing pattern — no filesystem storage).

### 1.2 New domain types — `evals/src/types.ts` (wave 0)

Add (exact names — backend and recompute module build against these):

```ts
export type CostSource = "harness" | "recomputed" | "unpriced";

export interface TokenTotals {
  model: string | null; // dominant concrete model id observed (e.g. "claude-opus-4-7")
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Everything known about the attempt's E2B stack. Taras explicitly OK'd storing the swarm API key. */
export interface SandboxInfo {
  apiSandboxId: string;
  workerSandboxId: string;
  apiTemplate: string;
  workerTemplate: string;
  apiUrl: string;
  swarmKey: string;
  workerAgentId: string;
  domain: string | null;
  apiStartedAt: string | null;
  workerStartedAt: string | null;
  expiresAt: string | null; // worker sandbox endAt/expiresAt
}

/** Per-phase wall-clock timings in ms. All nullable (phase may not have run). */
export interface PhaseTimings {
  bootMs: number | null;
  seedMs: number | null;
  tasksMs: number | null; // total across tasks
  perTask: { taskId: string; ms: number }[];
  logCaptureMs: number | null;
  costMs: number | null;
  checksMs: number | null;
  llmJudgeMs: number | null;
  agenticJudgeMs: number | null;
  artifactsMs: number | null;
}
```

Extend `AttemptRow` with:

```ts
costSource: CostSource | null;
tokens: TokenTotals | null;
sandbox: SandboxInfo | null;
timings: PhaseTimings | null;
```

Also add the recompute-module contract (types only — implementation is WP-DATA, §2):

```ts
export interface RecomputeInput {
  provider: HarnessProvider;
  configModel: string | null; // HarnessConfig.model (may be shortname/prefixed)
  logRows: { cli: string; content: string }[]; // raw swarm session-log rows
  sessionFiles: { path: string; content: string }[]; // harness-session file heads
}
export interface RecomputeResult {
  costUsd: number | null;
  tokens: TokenTotals | null;
}
```

### 1.3 Query layer — `evals/src/db/queries.ts` (wave 0)

- `rowToAttempt` (line 26): parse the new columns —
  `costSource: (r.cost_source as CostSource) ?? null`, and for each of `tokens_json` / `sandbox_json` / `timings_json`: `JSON.parse` inside try/catch → typed object or `null`.
- `updateAttempt` patch type + `map` (lines 124-169): add keys `costSource → cost_source`, `tokensJson → tokens_json`, `sandboxJson → sandbox_json`, `timingsJson → timings_json`. The three `*Json` patch fields are **pre-serialized strings** (callers `JSON.stringify`), passed through as-is; `costSource` is a plain string.

### 1.4 Capture changes — runner + sandbox + client (WP-DATA, wave 1)

**`evals/src/swarm/client.ts`:**

1. `SessionLogRow` (lines 5-13): add `createdAt: string` (the swarm API `GET /api/tasks/:id/session-logs` returns it — rows come from `src/be/db.ts` ordered `iteration ASC, lineNumber ASC` and include `createdAt`).
2. `SessionCostRow` (lines 15-21): add `cacheReadTokens: number | null; cacheWriteTokens: number | null;` (the wire JSON carries them; the current type drops them).
3. Replace `waitForTaskCost` (lines 142-168) with:
   ```ts
   /** Poll until cost rows are stable (two consecutive non-empty equal-length polls) or budget elapses. */
   async waitForSessionCostRows(taskId: string, timeoutMs = 60_000): Promise<SessionCostRow[]>
   ```
   Poll every 5s; the current first-non-empty-return bug (undercounts multi-iteration tasks) is fixed by requiring two equal polls. Delete the dead `task.totalCostUsd` fallback (lines 159-165 — the swarm `GET /api/tasks/:id` uses `SELECT *` and never carries the aggregate; confirmed dead code).
4. Keep `parseTranscriptEvents` / `flattenTranscript` untouched — they feed the LLM/agentic judges only (the UI no longer uses them; the new transcript endpoint returns raw rows, §4.5).

**`evals/src/swarm/sandbox.ts`:**

1. Change `collectHarnessSessionFiles` (lines 402-430) return type to
   ```ts
   Promise<{
     files: { path: string; content: string; truncated: boolean }[];
     listing: { path: string; sizeBytes: number; mtime: string; captured: boolean }[];
   }>
   ```
   The `find -printf '%T@ %s %p\n'` output already carries mtime + size — stop discarding them. `listing` includes ALL found files (drop the `head -N` so files past the 10-file cap appear with `captured: false`; still only read the newest 10); `files` keeps the existing 10 × 1.5 MB capped heads. Convert `%T@` epoch seconds to ISO for `mtime`.
2. No other changes — `StackHandle` already exposes everything `SandboxInfo` needs (`apiSandbox`/`workerSandbox` are `E2BSandboxInfo` from `src/e2b/dispatch.ts`: `templateID`, `sandboxID`, `domain`, `startedAt`, `endAt`, `expiresAt`).

**`evals/src/runner/index.ts`** — `runAttemptOnce` (lines 119-388):

1. **Stopwatch helper** (file-local): record ms per phase into a `PhaseTimings` object; persist via `timingsJson: JSON.stringify(timings)` in the final update (timings only persist on finished attempts; error paths skip it).
2. **Sandbox info** — right after `bootStack` (replace the update at lines 148-151):
   ```ts
   const sandboxInfo: SandboxInfo = {
     apiSandboxId: stack.apiSandbox.sandboxID,
     workerSandboxId: stack.workerSandbox.sandboxID,
     apiTemplate: stack.apiSandbox.templateID,
     workerTemplate: stack.workerSandbox.templateID,
     apiUrl: stack.apiUrl,
     swarmKey: stack.swarmKey,
     workerAgentId: stack.workerAgentId,
     domain: stack.workerSandbox.domain ?? null,
     apiStartedAt: stack.apiSandbox.startedAt ?? null,
     workerStartedAt: stack.workerSandbox.startedAt ?? null,
     expiresAt: stack.workerSandbox.endAt ?? stack.workerSandbox.expiresAt ?? null,
   };
   await updateAttempt(db, attempt.id, {
     sandboxId: stack.workerSandbox.sandboxID,
     apiUrl: stack.apiUrl,
     sandboxJson: JSON.stringify(sandboxInfo),
   });
   ```
   (Written at boot so the live run-details page shows sandbox info while the attempt runs. The swarmKey is deliberately stored/exposed — eval sandboxes are throwaway.)
3. **Seed output capture** (lines 157-165): collect `{ cmd, exitCode, durationMs, stdout, stderr }` per command (stdout/stderr clipped to 20 000 chars each); after the loop (on success, or before throwing on failure) write artifact `kind: "meta", name: "seed-output.json"` with the JSON array (only when `scenario.seed?.exec?.length`). Pass through `stack.redact()` like all artifacts.
4. **Stable log re-fetch** — after the cost wait (which adds up to 60s), re-fetch session logs once per task and use whichever set has more rows for the artifacts (fixes claude transcripts losing their tail to the 30s stability heuristic at line 183).
5. **Cost block** (replace lines 186-193) — see §2.3 for the exact logic. Also write artifact `kind: "meta", name: "session-costs.json"` with `[{ taskId, rows: SessionCostRow[] }]` (the raw rows, always — even when empty).
6. **Session-file listing artifact**: `collectHarnessSessionFiles` now returns `{ files, listing }` (adapt the call at line 331 — and move the capture earlier, before judging, so §2.3 can reuse `files` for cost recompute); after writing the `harness-session` artifacts, write `kind: "meta", name: "session-files.json"` with the `listing` array (skip when empty).
7. **raw-session-logs serialization** (lines 308-318): include `id: r.id` and `createdAt: r.createdAt` per line (the transcript transform needs `createdAt` for ordering and `id` as `recId` for message coalescing).
8. **Worker log**: bump `tail -n 300` → `tail -n 2000` (line 361). Add a second best-effort capture from the **API sandbox**: `tail -n 500 /tmp/agent-swarm-e2b-api.log` on `stack.apiSandbox.sandboxID` → artifact `kind: "sandbox-log", name: "api.log"` (the detached-process log path is `/tmp/agent-swarm-e2b-${role}.log`, see `src/e2b/dispatch.ts:337`).
9. **Final update** (lines 373-380): add `costSource`, `tokensJson`, `timingsJson` to the patch.

**`evals/src/judge/agentic.ts`** — capture judge tool **outputs**, not just inputs. Change `toolLog` from `string[]` to:

```ts
const toolLog: { tool: string; args: unknown; output: unknown }[] = [];
```

In each tool's `execute`, push `{ tool: "run_command", args: { command }, output: <the returned object, string fields clipped to 2_000 chars for the log copy> }` (same for `read_file`, `api_get`, `submit_verdict`). The `raw` judgment payload keeps shape `JSON.stringify({ model, steps: steps.length, toolLog, verdict })` — the UI JSON-pretty-prints it. Update the no-verdict error message to `toolLog.map((t) => t.tool).join("; ")`.

### 1.5 Backward compatibility

- Old attempts: `costSource`/`tokens`/`sandbox`/`timings` are `null` → UI renders "not captured" placeholders (§7).
- Old `raw-session-logs` artifacts lack `id`/`createdAt` per row → transcript endpoint synthesizes (§4.5); the ported parser's ordering is adapted to tolerate it (§7.3).
- `clearAttemptResults` already wipes artifacts on re-run — new artifact kinds need no special handling. The `judgments.kind` CHECK constraint is untouched (agentic judgments stay `kind='llm'`, `name='agentic-judge'`).

---

## 2. BACKEND — cost always tracked

### 2.1 Pricing module — `evals/src/cost/pricing.ts` (wave 0, fully implemented — shared by WP-DATA and WP-API)

Reads the repo-root models.dev snapshot `src/be/modelsdev-cache.json` (4 MB JSON: `Record<providerId, { id, name, models: Record<modelId, Model> }>`; `Model.cost` = `{ input, output, cache_read?, cache_write? }` in USD per 1M tokens; `Model.limit.context`; `Model.reasoning`; `Model.tool_call`; `Model.name`). It is in-repo and offline-safe. Load once, cache in module state:

```ts
import type { HarnessProvider, TokenTotals } from "../types.ts";

export interface PricedModel {
  id: string; // models.dev model id, e.g. "deepseek/deepseek-v4-pro" (openrouter section)
  name: string;
  reasoning: boolean;
  toolCall: boolean;
  context: number | null;
  inputPerM: number | null;
  outputPerM: number | null;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
}

/** All models of the models.dev `openrouter` section, sorted by name. Cached after first load. */
export async function listOpenrouterModels(): Promise<PricedModel[]>;

/**
 * Resolve a concrete model id observed in harness output (or a config MODEL_OVERRIDE)
 * to a priced model. Provider → models.dev section mapping:
 *   claude  → "anthropic" section, bare id; strip trailing date suffix /-\d{8}$/
 *             (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
 *   codex   → "openai" section, bare id
 *   pi / opencode → strip leading "openrouter/" then look up in the "openrouter" section
 *             (e.g. "openrouter/deepseek/deepseek-v4-flash" → "deepseek/deepseek-v4-flash");
 *             ids without the prefix (as emitted in harness session files) look up directly.
 * Returns null when not found (shortnames like "haiku"/"opus"/"fable" return null —
 * recompute prefers per-event concrete ids and only falls back to configModel).
 */
export async function lookupModelCost(
  provider: HarnessProvider,
  modelId: string,
): Promise<PricedModel | null>;

/**
 * USD for a usage block. `inputIncludesCacheRead` handles the codex semantic
 * (OpenAI input_tokens INCLUDE cached tokens → uncachedInput = input - cacheRead);
 * Anthropic/pi/opencode input EXCLUDES cache tokens → use input directly.
 * Returns null when inputPerM or outputPerM is null.
 */
export function priceUsage(
  model: PricedModel,
  usage: TokenTotals,
  opts: { inputIncludesCacheRead: boolean },
): number | null;
```

Formula: `((uncachedInput * inputPerM) + (cacheReadTokens * (cacheReadPerM ?? inputPerM)) + (cacheWriteTokens * (cacheWritePerM ?? 0)) + (outputTokens * outputPerM)) / 1e6`.

Cache file path: `new URL("../../../src/be/modelsdev-cache.json", import.meta.url)` read via `await Bun.file(url).json()` (Bun APIs, not `node:fs`). Add a wave-0 unit test `evals/src/cost/pricing.test.ts`: lookup `("pi", "openrouter/deepseek/deepseek-v4-flash")` → inputPerM 0.0983; `("claude", "claude-haiku-4-5-20251001")` resolves via date-strip; `priceUsage` under both semantics flags.

### 2.2 Recompute module — `evals/src/cost/recompute.ts` (WP-DATA, wave 1)

```ts
import type { RecomputeInput, RecomputeResult } from "../types.ts";
export async function recomputeCost(input: RecomputeInput): Promise<RecomputeResult>;
```

Per-provider extraction (read the real shapes in captured artifacts in `evals/evals.db` before coding; sources listed per provider):

- **claude**: parse `input.logRows[].content` as JSON; events `type === "assistant"` carry `message.model` + `message.usage` = `{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }` and `message.id`. **Dedupe by `message.id`** (multi-content-block messages repeat usage). Fallback source: `sessionFiles` from `~/.claude/projects/**/*.jsonl` (same `message.usage` shape + `requestId`; dedupe by `requestId`, keep last). Price each `(model, usage)` via `lookupModelCost("claude", model)` + `priceUsage(..., { inputIncludesCacheRead: false })`.
- **pi**: swarm logRows carry NO usage (the pi extension strips it). Use `sessionFiles` (`~/.pi/agent/sessions/**/*.jsonl`): assistant messages carry `message.usage` = `{ input, output, cacheRead, cacheWrite, cost: { total } }` plus `message.model`/`message.provider`. **Sum `usage.cost.total` directly** (provider-reported USD, highest fidelity); tokens×rates only as backstop when `cost` is absent.
- **opencode**: `sessionFiles` (`~/.local/share/opencode` storage): finalized message objects carry `tokens: { input, output, cache: { read, write } }`, `cost`, `modelID`. Sum `cost` when present; else tokens×rates (`inputIncludesCacheRead: false`).
- **codex**: session-cost rows normally exist (API-key path) so recompute rarely fires. Backstop: rollout files in `~/.codex/sessions` contain `token_count` events with `{ input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }`; use the LAST cumulative usage event per rollout; `inputIncludesCacheRead: true`. If extraction finds nothing → return nulls.

Result: sum USD across messages; aggregate `TokenTotals` (dominant model id = most frequent). If only tokens were extractable but no pricing matched → `{ costUsd: null, tokens }`. Nothing extractable → `{ costUsd: null, tokens: null }`. Must never throw (wrap per-line parsing in try/catch).

Add `evals/src/cost/recompute.test.ts` with inline fixtures for the claude and pi shapes above (copy real lines from `evals/evals.db` artifacts — `sqlite3 evals/evals.db "select content from artifacts where kind='raw-session-logs' limit 1"`).

### 2.3 Fallback chain — hook point in `evals/src/runner/index.ts` (WP-DATA)

Replace the cost block (lines 186-193). Note `collectHarnessSessionFiles` must be called BEFORE this block (moved up per §1.4.6; reuse the result for both cost and artifacts):

```ts
// 1. harness-reported
const costRowsByTask: { taskId: string; rows: SessionCostRow[] }[] = [];
let allRows: SessionCostRow[] = [];
for (const task of tasks) {
  const rows = await client.waitForSessionCostRows(task.id);
  costRowsByTask.push({ taskId: task.id, rows });
  allRows = allRows.concat(rows);
}
const priced = allRows.some(
  (r) => (r.totalCostUsd ?? 0) > 0 || (r.costSource && r.costSource !== "unpriced"),
);
let costUsd: number | null = null;
let costSource: CostSource | null = null;
let tokens: TokenTotals | null = null;
if (allRows.length > 0 && priced) {
  costUsd = allRows.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
  costSource = "harness";
  tokens = sumRowTokens(allRows); // file-local helper; model = first non-null r.model
} else {
  // 2. recomputed from tokens x models.dev
  const r = await recomputeCost({
    provider: config.provider,
    configModel: config.model ?? null,
    logRows,
    sessionFiles: sessionFiles.files,
  });
  tokens = r.tokens;
  if (r.costUsd !== null) {
    costUsd = r.costUsd;
    costSource = "recomputed";
  } else {
    costSource = "unpriced"; // 3. tag — tokens (if any) still stored
  }
}
```

`costSource` + `tokensJson` go into the final `updateAttempt` patch (§1.4.9). Error-path attempts keep `costSource = null` (cost never measured — UI shows "—").

### 2.4 Surfacing

- `AttemptRow.costSource` flows through every endpoint that returns attempts (§4) — no extra work beyond §1.3.
- `evals/src/results.ts` (wave 0): extend `RunSummary["totals"]` with
  ```ts
  totalDurationMs: number | null; // sum of non-null attempt durationMs
  passedAttempts: number;         // status === "passed"
  errorAttempts: number;          // status === "error"
  unpricedAttempts: number;       // finished attempts with costUsd === null or costSource === "unpriced"
  ```
  (computed in `summarizeRun`; cells unchanged).
- UI: `CostBadge` component (§5.4) renders the USD + a small source tag (`harness` plain, `recomputed` with `~` prefix + tooltip, `unpriced`/null as dim "—" + tooltip).

---

## 3. BACKEND — models endpoint + DeepSeek V4 Pro defaults

### 3.1 `GET /api/models` (WP-API, in `evals/src/api/server.ts`)

Serve the models.dev `openrouter` section for the new-run judge-model selector, via `listOpenrouterModels()` from `evals/src/cost/pricing.ts`. Exact shape in §4.7. Cached in memory after first call (the loader already caches).

### 3.2 Default judge model → DeepSeek V4 Pro

Judge model ids are **bare OpenRouter ids** (no `openrouter/` prefix — judges call OpenRouter directly via the AI SDK). The models.dev openrouter section has `deepseek/deepseek-v4-pro` ("DeepSeek V4 Pro", $0.435/$0.87 per 1M, ctx 1 048 576). **New default id: `deepseek/deepseek-v4-pro`.**

Every place the default changes (WP-DATA owns all of these):

1. `evals/src/judge/llm.ts:6` — `const DEFAULT_JUDGE_MODEL = "deepseek/deepseek-v4-pro";`
2. `evals/src/judge/agentic.ts:7` — `const DEFAULT_AGENTIC_MODEL = "deepseek/deepseek-v4-pro";`
3. `evals/README.md:56` — precedence line: `... > EVAL_JUDGE_MODEL > deepseek/deepseek-v4-pro`.

Harness-config worker models (`evals/configs/index.ts`, `MODEL_OVERRIDE`-prefixed ids like `openrouter/deepseek/deepseek-v4-flash`) are **unchanged** — the feedback targets the new-run dialog's model selector, which is the judge model. The UI default comes from the API (`defaultJudgeModel` in §4.7), so the dialog never hardcodes it.

### 3.3 `GET /api/configs` gains `isDefault`

WP-API: in the `/api/configs` handler, import `DEFAULT_CONFIG_IDS` from `evals/configs/index.ts` and add `isDefault: DEFAULT_CONFIG_IDS.includes(c.id)` to each serialized config (§4.6). The new-run dialog preselects `isDefault` configs.

---

## 4. BACKEND — API contracts (exact JSON)

All handlers live in `evals/src/api/server.ts` (WP-API owns this file exclusively, including the static-serving change in §4.9). Responses keep the existing `json()` helper (pretty-printed, CORS `*`).

Shared shapes referenced below:

```jsonc
// RunJson (EvalRunRow serialized — unchanged fields)
{ "id": "run-202606111530-ab12cd", "name": "nightly", "status": "running",
  "scenarioIds": ["hello-file"], "configIds": ["claude-haiku", "pi-deepseek-flash"],
  "attemptsPerCell": 1, "concurrency": 2, "judgeModel": null,
  "createdAt": "2026-06-11T15:30:00.000Z", "finishedAt": null }

// CellJson (CellSummary — unchanged)
{ "scenarioId": "hello-file", "configId": "claude-haiku", "attempts": 1, "finished": 1,
  "passedAny": true, "passedFirst": true, "bestScore": 1, "avgScore": 1,
  "totalCostUsd": 0.0123, "avgDurationMs": 184000, "errors": 0 }

// TotalsJson (extended — §2.4)
{ "attempts": 2, "finished": 2, "passedCells": 2, "totalCells": 2, "totalCostUsd": 0.0146,
  "totalDurationMs": 412000, "passedAttempts": 2, "errorAttempts": 0, "unpricedAttempts": 0 }

// AttemptJson (extended — new fields nullable; old rows return null)
{ "id": "run-..._hello-file_claude-haiku_0", "runId": "run-...", "scenarioId": "hello-file",
  "configId": "claude-haiku", "attemptIndex": 0, "status": "passed", "retries": 0,
  "sandboxId": "ixxyz...", "apiUrl": "https://3013-ixxyz....e2b.app",
  "taskIds": ["t1"], "score": 1, "passed": true, "error": null,
  "costUsd": 0.0123, "costSource": "recomputed",
  "tokens": { "model": "claude-haiku-4-5", "inputTokens": 14, "outputTokens": 446,
              "cacheReadTokens": 113392, "cacheWriteTokens": 39921 },
  "sandbox": { "apiSandboxId": "i...", "workerSandboxId": "i...",
               "apiTemplate": "agent-swarm-api-latest", "workerTemplate": "agent-swarm-worker-latest",
               "apiUrl": "https://3013-i....e2b.app", "swarmKey": "evals-<uuid>",
               "workerAgentId": "<uuid>", "domain": "e2b.app",
               "apiStartedAt": "...", "workerStartedAt": "...", "expiresAt": "..." },
  "timings": { "bootMs": 95000, "seedMs": 1200, "tasksMs": 60000,
               "perTask": [{ "taskId": "t1", "ms": 60000 }], "logCaptureMs": 12000,
               "costMs": 15000, "checksMs": 800, "llmJudgeMs": null, "agenticJudgeMs": 9000,
               "artifactsMs": 4000 },
  "durationMs": 184000, "startedAt": "...", "finishedAt": "..." }

// JudgmentJson (unchanged)
{ "id": "...", "attemptId": "...", "kind": "deterministic", "name": "tasks-completed",
  "pass": true, "score": null, "reasoning": "1 task(s) completed", "raw": null, "createdAt": "..." }

// ArtifactMetaJson (unchanged — listArtifacts without content)
{ "id": "...", "attemptId": "...", "kind": "raw-session-logs", "name": "session-logs.jsonl",
  "createdAt": "...", "size": 48213 }
```

### 4.1 `GET /api/runs` → `200`

```jsonc
[ { "run": RunJson, "cells": [CellJson], "totals": TotalsJson, "active": true } ]
```

(Same as today + extended totals; `active` = run executing in this server process.)

### 4.2 `POST /api/runs` → `201 {"runId": "..."}` / `400 {"error": "..."}`

Body unchanged: `{ name?, scenarioIds: string[], configIds: string[], attemptsPerCell?, concurrency?, judgeModel? }`. `judgeModel` remains free text (custom OpenRouter ids allowed — no validation against /api/models).

### 4.3 `GET /api/runs/:id` → `200`

```jsonc
{ "run": RunJson, "cells": [CellJson], "totals": TotalsJson, "attempts": [AttemptJson], "active": false }
```

`POST /api/runs/:id/resume` → `202 {"runId","resumed":true}`; `POST /api/runs/:id/cancel` → `202 {"runId","cancelled":true}` — unchanged.

### 4.4 `GET /api/attempts/:id` → `200`

```jsonc
{ "attempt": AttemptJson, "judgments": [JudgmentJson], "artifacts": [ArtifactMetaJson] }
```

This doubles as the **assets-listing endpoint** for the run-details assets tab (artifacts carry `size`, no content).

### 4.5 `GET /api/attempts/:id/transcript` → `200` (CHANGED — raw rows, client-side parsing)

```jsonc
{
  "source": "raw-session-logs",          // "raw-session-logs" | "transcript" | null
  "harness": "claude",                    // "claude"|"pi"|"codex"|"opencode"|null — registry config of attempt.configId
  "rows": [                               // only when source === "raw-session-logs", else null
    { "id": "0:1",                        // row id; synthesized as "<iteration>:<lineNumber>" for old artifacts
      "taskId": "t1", "sessionId": "s1", "iteration": 0, "cli": "claude",
      "content": "{\"type\":\"assistant\",...}", "lineNumber": 1,
      "createdAt": "2026-06-11T15:31:02.123Z" }  // "" when not captured (old artifacts)
  ],
  "text": null                            // only when source === "transcript": the flat legacy transcript string
}
```

Handler: load artifacts `withContent`; if `raw-session-logs` exists, parse each JSONL line, fill `id` (`row.id ?? \`${iteration}:${lineNumber}\``) and `createdAt` (`row.createdAt ?? ""`); `harness` = `loadRegistry().configs.get(attempt.configId)?.provider ?? null`. Else if a flat `transcript` artifact exists: `{ source: "transcript", harness, rows: null, text: content }`. Else `{ source: null, harness, rows: null, text: null }`. The server no longer calls `parseTranscriptEvents` for this endpoint.

### 4.6 `GET /api/scenarios`, `GET /api/scenarios/:id`, `GET /api/configs`

- `GET /api/scenarios` → `200 [SerializedScenario]` (unchanged shape — see `evals/src/registry.ts:14-52`: `{ id, name, description, tasks, seed, timeoutMs, outcome: { checks, llmJudge, agenticJudge, passThreshold } }`).
- `GET /api/scenarios/:id` → `200 { "scenario": SerializedScenario, "recentAttempts": [AttemptJson] }` (recentAttempts carry the new nullable fields automatically).
- `GET /api/configs` → `200`:
  ```jsonc
  [ { "id": "claude-haiku", "label": "Claude Code / haiku", "provider": "claude",
      "model": "haiku", "modelTier": null, "envKeys": [], "isDefault": true } ]
  ```

### 4.7 `GET /api/models` → `200` (NEW)

```jsonc
{
  "defaultJudgeModel": "deepseek/deepseek-v4-pro",
  "models": [
    { "id": "deepseek/deepseek-v4-pro", "name": "DeepSeek V4 Pro",
      "reasoning": true, "toolCall": true, "context": 1048576,
      "inputPerM": 0.435, "outputPerM": 0.87, "cacheReadPerM": 0.003625, "cacheWritePerM": null }
  ]
}
```

`models` = full openrouter section sorted by name (a few hundred entries; fine for one fetch). `defaultJudgeModel` is a literal in the handler — single source of truth for the UI.

### 4.8 `GET /api/artifacts/:id` (extended)

- Default: raw content. Content-type: `application/json; charset=utf-8` when `name` ends in `.json`, else `text/plain; charset=utf-8`.
- `?download=1`: add `Content-Disposition: attachment; filename="<name or id>"`.

### 4.9 Static UI serving (WP-API)

Replace the `"/"` route (currently `Bun.file(join(UI_DIR, "index.html"))`, `UI_DIR = ../../ui`):

```ts
const UI_DIST = join(import.meta.dir, "../../ui/dist");
```

- `"/"` route: serve `join(UI_DIST, "index.html")`; if `!(await Bun.file(...).exists())` → `500 { "error": "UI not built — run \`bun run ui:build\` in evals/" }`.
- In the `fetch()` fallback (before the 404): for `GET` requests whose path does not start with `/api/`, resolve `join(UI_DIST, pathname)`; reject any resolved path not under `UI_DIST` (traversal guard via `node:path` `normalize` + prefix check); if the file exists serve it with `new Response(Bun.file(p))` (Bun infers content-type). Unknown paths still → JSON 404. (Hash routing means the SPA only ever requests `/`, `/assets/*`, `/logo.png`.)

---

## 5. UI — scaffold + shared foundation (wave 0)

All files below are created in wave 0 with **full implementations** (components are not stubs; only the four page files are stubs to be replaced in wave 1). Page agents build against these exact signatures and MUST NOT edit any wave-0 shared file.

### 5.1 Packaging — `evals/package.json`

```jsonc
{
  "scripts": {
    "cli": "bun src/cli.ts",
    "run": "bun src/cli.ts run",
    "serve": "bun src/cli.ts serve",
    "ui:dev": "vite dev ui",            // dev server, proxies /api → :4801
    "ui:build": "vite build ui",        // → evals/ui/dist
    "tsc:check": "tsc --noEmit && tsc --noEmit -p ui",
    "test": "bun test"
  },
  "devDependencies": {
    "@types/bun": "^1.2.0",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^5.1.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "typescript": "^5.9.0",
    "vite": "^7.1.0"
  }
}
```

(React in devDependencies is fine — private package, everything is bundled by vite.) Run `bun install` in `evals/` to update `evals/bun.lock` and commit it.

- **CI** — `.github/workflows/merge-gate.yml`: after the existing "Type check evals" step (which now also covers `ui/` via the updated `tsc:check`) add:
  ```yaml
      - name: Build evals UI
        run: bun run ui:build
        working-directory: evals
  ```
- **gitignore**: root `.gitignore` already ignores `dist` and `node_modules` un-anchored — `evals/ui/dist` is covered; no change needed.
- **Biome**: root `bun run lint` = `biome check src evals` already covers `evals/ui/src` (and `dist` is excluded via `vcs.useIgnoreFile`). Decision: no `biome.json` change. All new UI code must be biome-clean: double quotes, 100-char lines, no `any`, organized imports.

### 5.2 Vite + TS config

`evals/ui/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  server: { proxy: { "/api": "http://localhost:4801" } },
});
```

(`vite dev ui` / `vite build ui` from `evals/` use the positional root `ui`, picking up this config; `outDir` resolves to `evals/ui/dist`; `evals/ui/public/` is copied into dist.)

`evals/ui/tsconfig.json` (separate program; root `evals/tsconfig.json` keeps `include: ["src","scenarios","configs"]` and is NOT edited):

```jsonc
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

(Deliberately no `noUncheckedIndexedAccess` — keeps the `ui/src/logs-parser` port near-verbatim.)

### 5.3 Entry + shell + branding

`evals/ui/index.html` (vite entry — REPLACES the old 549-line SPA):

```html
<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>swarm evals</title>
    <link rel="icon" type="image/png" href="/logo.png" />
    <meta name="theme-color" content="#18181b" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&family=Space+Mono:ital,wght@0,400;0,700;1,400;1,700&display=swap"
      rel="stylesheet"
    />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- **Logo/favicon**: copy `ui/public/logo.png` (12 377-byte PNG, 512×512 — the only brand mark in the repo; there is no SVG anywhere) → `evals/ui/public/logo.png`.
- `evals/ui/src/main.tsx`: createRoot, theme bootstrap (read `localStorage["evals-theme"]`, fall back to `prefers-color-scheme`, set `document.documentElement.dataset.theme`), render `<App />`, import `./styles.css`.
- `evals/ui/src/App.tsx`: sticky header — `<img src="/logo.png" width={22} height={22} />` + wordmark `swarm <span class="accent">evals</span>` (Space Grotesk), nav pills `runs` / `scenarios` (active by hash prefix), theme toggle button `◐` (persists to `localStorage["evals-theme"]`). Below: route switch per §0 (including the legacy `cells` redirect, implemented as a `navigate()` call in an effect). Imports the four page components from `./pages/*`.

### 5.4 Shared components — exact exported signatures

All in `evals/ui/src/components/`. Page agents import from these paths verbatim.

**`components/DataTable.tsx`** — the dense-table workhorse (sortable headers, fuzzy search, per-column dropdown filters):

```tsx
import type { ReactNode } from "react";

export interface Column<T> {
  key: string;                                    // unique column id
  header: string;
  headerTip?: string;                             // optional "i"-tooltip on the header
  width?: string;                                 // CSS width ("90px", "1fr"); default auto
  align?: "left" | "right" | "center";            // default "left"
  sortable?: boolean;                             // default true
  sortValue?: (row: T) => string | number | null; // default: searchText ?? rendered string
  filterOptions?: (rows: T[]) => string[];        // presence enables a dropdown filter
  filterValue?: (row: T) => string | string[];    // row's value(s) matched against selection
  searchText?: (row: T) => string;                // contributes to the fuzzy haystack
  render: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  rowHref?: (row: T) => string | null;            // renders row as link-row (takes precedence)
  selectedKey?: string | null;                    // highlights row
  searchable?: boolean;                           // default true — fuzzy input above the table
  searchPlaceholder?: string;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  emptyText?: string;                             // default "nothing here yet"
  maxHeight?: string;                             // scroll container, sticky header
}

export function DataTable<T>(props: DataTableProps<T>): ReactNode;
export function fuzzyMatch(query: string, haystack: string): boolean; // case-insensitive subsequence
```

Behavior: search input filters via `fuzzyMatch` over concatenated `searchText` of all columns that define it; each `filterOptions` column renders a `<select>` (options + "all") in a filter bar next to the search; header click toggles sort (▲/▼ glyph). No virtualization (datasets are small). Dense: `padding: 3px 8px`, 12.5px font.

**`components/JsonView.tsx`** — collapsible, syntax-tinted pretty-print:

```tsx
export function JsonView(props: {
  value: unknown;
  collapseDepth?: number; // depth at which objects/arrays start collapsed; default 2
  label?: string;         // optional root label
}): ReactNode;
```

Recursive renderer; `▸`/`▾` toggles on objects/arrays (collapsed shows `{…} 4 keys` / `[…] 12`); leaf classes `.jv-key .jv-str .jv-num .jv-bool .jv-null` colored via CSS vars; strings that themselves parse as JSON get a "parse" toggle. Long strings clipped at 600 chars with "show all".

**`components/Tooltip.tsx`**:

```tsx
export function Tooltip(props: { text: string; children: ReactNode }): ReactNode; // CSS hover/focus tooltip
export function InfoTip(props: { text: string }): ReactNode;                      // lowkey ⓘ glyph + Tooltip
```

**`components/Spinner.tsx`** — unicode animations:

```tsx
export const SPINNER_FRAMES: string[]; // ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]
export function Spinner(props: { label?: string }): ReactNode;        // braille frames, 80ms via useNow
export function PulseDot(): ReactNode;                                 // 8px accent dot, CSS opacity pulse
export function Elapsed(props: { since: string | null }): ReactNode;   // live-ticking "3m 12s" (useNow(1000))
```

All animations respect `prefers-reduced-motion` (static fallback glyph `◌` / frozen text). `Elapsed` fixes the old SPA's frozen-elapsed bug (it ticks independently of polling).

**`components/StatusBadge.tsx`**:

```tsx
export function StatusBadge(props: { status: string }): ReactNode;
// color map: passed/done/pass → green; failed/fail/error → red; running/judging/live → accent (+ PulseDot);
// pending/cancelled → dim; unknown → neutral. Lowercase pill, color-mix(... 16%) background.
export function CostBadge(props: { costUsd: number | null; source: string | null }): ReactNode;
// "$0.0123" plain (harness) | "~$0.0123" + InfoTip("recomputed from tokens × models.dev pricing") |
// "—" dim + InfoTip("unpriced — no cost rows and token recompute found nothing" / "not measured")
```

**`components/EntityLink.tsx`** — backlinking convention (every entity reference is a link):

```tsx
export function EntityLink(props: {
  kind: "run" | "scenario" | "attempt" | "config" | "artifact";
  id: string;
  runId?: string; // REQUIRED for kind="attempt"
  label?: string; // default: id (runs display with "run-" prefix stripped)
}): ReactNode;
// hrefs: run → `#/runs/${id}` · scenario → `#/scenarios/${id}` ·
// attempt → `#/runs/${runId}/attempts/${id}` · artifact → `/api/artifacts/${id}` (target=_blank) ·
// config → no page: renders a .chip span (Tooltip with id; not a link)
```

**`components/format.ts`**:

```ts
export function fmtCost(usd: number | null): string;    // "$0.0123" | "—" (4 decimals, >=1 → 2)
export function fmtDuration(ms: number | null): string; // "3m 04s" | "850ms" | "—"
export function fmtDate(iso: string | null): string;    // "Jun 11 15:30" (title attr = full ISO)
export function fmtAgo(iso: string | null): string;     // "4h ago" | "—"
export function fmtBytes(n: number | null): string;     // "47.1 KB"
export function fmtTokens(n: number | null): string;    // "113.4k" | "—"
export function fmtScore(score: number | null): string; // "0.85" | "—"
```

**`components/Matrix.tsx`** — shared scenario×config matrix (used by RunsPage detail pane AND RunDetailsPage; the ONLY in-flight presentation — no separate "in flight" section anywhere):

```tsx
import type { AttemptJson, CellJson } from "../types.ts";
export function Matrix(props: {
  scenarioIds: string[];
  configIds: string[];
  cells: CellJson[];
  attempts?: AttemptJson[]; // when given, cells with running/judging attempts render <Spinner/> + elapsed
  cellHref?: (scenarioId: string, configId: string) => string | null; // cell becomes a link
  selected?: { scenarioId: string; configId: string } | null;
}): ReactNode;
```

Cell rendering: best score (green pass / red fail / dim), ✓/✗, sub-line `finished/attempts · errors · cost · avg duration`; running cells: `<Spinner/>` + `<Elapsed since={...}/>` of the oldest running attempt; row headers are `EntityLink kind="scenario"`, column headers config chips.

### 5.5 Hooks + API client

**`evals/ui/src/hooks.ts`**:

```ts
export interface Route { parts: string[]; path: string; } // "#/runs/a/attempts/b" → ["runs","a","attempts","b"]
export function useHashRoute(): Route;        // subscribes to hashchange
export function navigate(path: string): void; // location.hash = path (path starts with "#/")
export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs: number | null, // null → fetch once
  deps: unknown[],
): { data: T | null; error: string | null; loading: boolean; refresh: () => void };
export function useNow(intervalMs: number): number; // ticking Date.now() — drives Spinner/Elapsed
```

`usePoll` must not flash: keep previous `data` while refreshing; pause polling when `document.hidden`.

**`evals/ui/src/types.ts`** — TypeScript mirrors of every §4 JSON shape. Exact exported names (deliberately duplicated from the backend — the UI never imports from `evals/src`):

```ts
export type RunStatus = "pending" | "running" | "done" | "failed" | "cancelled";
export type AttemptStatus = "pending" | "running" | "judging" | "passed" | "failed" | "error";
export interface RunJson { /* §4 RunJson */ }
export interface CellJson { /* §4 CellJson */ }
export interface TotalsJson { /* §4 TotalsJson */ }
export interface TokenTotalsJson { /* §4 tokens */ }
export interface SandboxInfoJson { /* §4 sandbox */ }
export interface PhaseTimingsJson { /* §4 timings */ }
export interface AttemptJson { /* §4 AttemptJson; costSource: string | null; tokens/sandbox/timings nullable */ }
export interface JudgmentJson { /* §4 JudgmentJson */ }
export interface ArtifactMetaJson { /* §4 ArtifactMetaJson */ }
export interface RunListItem { run: RunJson; cells: CellJson[]; totals: TotalsJson; active: boolean; }
export interface RunDetail extends RunListItem { attempts: AttemptJson[]; }
export interface AttemptDetail { attempt: AttemptJson; judgments: JudgmentJson[]; artifacts: ArtifactMetaJson[]; }
export interface TranscriptRow { id: string; taskId: string; sessionId: string; iteration: number;
  cli: string; content: string; lineNumber: number; createdAt: string; }
export interface TranscriptResponse { source: "raw-session-logs" | "transcript" | null;
  harness: string | null; rows: TranscriptRow[] | null; text: string | null; }
export interface ScenarioJson { /* SerializedScenario shape (§4.6) */ }
export interface ConfigJson { id: string; label: string | null; provider: string; model: string | null;
  modelTier: string | null; envKeys: string[]; isDefault: boolean; }
export interface ModelJson { id: string; name: string; reasoning: boolean; toolCall: boolean;
  context: number | null; inputPerM: number | null; outputPerM: number | null;
  cacheReadPerM: number | null; cacheWritePerM: number | null; }
export interface ModelsResponse { defaultJudgeModel: string; models: ModelJson[]; }
export interface CreateRunBody { name?: string; scenarioIds: string[]; configIds: string[];
  attemptsPerCell?: number; concurrency?: number; judgeModel?: string; }
```

**`evals/ui/src/api.ts`** — one typed function per endpoint (thin `fetch` wrapper throwing on `!res.ok` with the body's `error` field):

```ts
export function listRuns(): Promise<RunListItem[]>;
export function getRun(id: string): Promise<RunDetail>;
export function createRun(body: CreateRunBody): Promise<{ runId: string }>;
export function resumeRun(id: string): Promise<void>;
export function cancelRun(id: string): Promise<void>;
export function getAttempt(id: string): Promise<AttemptDetail>;
export function getTranscript(attemptId: string): Promise<TranscriptResponse>;
export function listScenarios(): Promise<ScenarioJson[]>;
export function getScenario(id: string): Promise<{ scenario: ScenarioJson; recentAttempts: AttemptJson[] }>;
export function listConfigs(): Promise<ConfigJson[]>;
export function getModels(): Promise<ModelsResponse>;
export function artifactUrl(id: string, opts?: { download?: boolean }): string;
```

### 5.6 Styles — `evals/ui/src/styles.css`

CSS custom properties mapping the **swarm dashboard brand** (zinc + amber, Space Grotesk/Space Mono — source of truth: `ui/src/styles/globals.css`). Dark is default:

```css
:root, :root[data-theme="dark"] {
  --bg: oklch(0.141 0.005 285.823);      /* dashboard background dark (zinc-950) */
  --panel: oklch(0.21 0.006 285.885);    /* card dark */
  --panel-2: oklch(0.274 0.006 286.033); /* secondary dark */
  --border: oklch(1 0 0 / 12%);
  --text: oklch(0.985 0 0);
  --dim: oklch(0.705 0.015 286.067);     /* muted-foreground dark */
  --accent: oklch(0.769 0.188 70.08);    /* brand primary — amber-500 */
  --green: #34d399; --red: #f87171; --yellow: #facc15; --blue: #38bdf8; --orange: #fb923c;
  --font-sans: "Space Grotesk", system-ui, sans-serif;
  --font-mono: "Space Mono", ui-monospace, SFMono-Regular, monospace;
}
:root[data-theme="light"] {
  --bg: #fafafa; --panel: #ffffff; --panel-2: #f4f4f5; --border: #e4e4e7;
  --text: oklch(0.141 0.005 285.823); --dim: #71717a;
  --accent: oklch(0.555 0.163 48.998);   /* brand primary light — amber ~700 */
  --green: #10b981; --red: #ef4444; --yellow: #eab308; --blue: #0ea5e9; --orange: #f97316;
}
```

Shared classes (full implementations in wave 0): header/nav pills; `.layout-30-70` (`display: grid; grid-template-columns: minmax(320px, 30%) 1fr; gap: 16px; align-items: start;`); `.panel` card; `table.data` dense table (sticky thead, hover row, `.selected` row accent border); `.badge`; `.chip`; `.btn .btn-primary .btn-danger`; form inputs + focus ring (accent); `.check-list` checkbox chips (`:has(input:checked)`); `dialog` + backdrop; `.jv-*` JSON tint classes (key=blue, string=green, number=orange, bool/null=accent/dim); `.tooltip` (pure CSS via `data-tip` pseudo-element); `.matrix` table; `.pulse` keyframes + `@media (prefers-reduced-motion: reduce)` overrides; `.meta-grid` (label/value pairs, uppercase 10px labels); `.tabs` strip. Icons stay lowkey text glyphs only: `◐ ✓ ✗ ← ▸ ▾ ⓘ ⠋…` — no icon set, no SVG icons. **No transcript-specific classes here** — WP-TRANSCRIPT owns `pages/transcript.css`.

### 5.7 Stub pages (wave 0 creates; wave 1 replaces)

`evals/ui/src/pages/RunsPage.tsx`, `RunDetailsPage.tsx`, `Transcript.tsx`, `ScenariosPage.tsx` — minimal compiling components with the EXACT default-export signatures of §6-§8 (body: `<div className="panel">… under construction</div>`). This makes wave 0 a bootable app (`ui:build` green) and freezes the props contracts.

---

## 6. UI — runs list page (WP-RUNS, wave 1)

**File:** `evals/ui/src/pages/RunsPage.tsx` (replaces stub; may also create `evals/ui/src/pages/runs.css` and import it). Signature: `export default function RunsPage(): ReactNode;` (no props).

Data: `usePoll(listRuns, 4000, [])`.

**Layout: `.layout-30-70`.**

**Left 30% — runs table** (`DataTable<RunListItem>`):
- Header row above the table: title "runs" + count, `+ new run` `.btn-primary` (opens dialog).
- Columns: `run` (render: name ?? shortened id — plain text, row click drives the pane; `searchText: r.run.id + " " + (r.run.name ?? "")`), `status` (StatusBadge + PulseDot when `active`; `filterOptions` = distinct statuses + "active"), `scenarios` (count; `filterOptions` from all scenarioIds, `filterValue: (r) => r.run.scenarioIds`), `configs` (same pattern), `cells` (`passedCells/totalCells`), `cost` (`fmtCost(totals.totalCostUsd)`, align right, sortable), `created` (`fmtAgo`, `sortValue` = ISO, default sort desc).
- `onRowClick` → `setSelected(run.id)`; `selectedKey` = selected id. Default selection: newest run.
- Fuzzy search across id/name/scenarioIds/configIds.

**Right 70% — detail pane** for the selected run (`usePoll(() => getRun(selectedId), 4000, [selectedId])` for attempts/matrix):
1. Header: run name/id, `StatusBadge`, `Spinner label="executing"` when `active`, and a prominent **`open details →`** button (`navigate(\`#/runs/${id}\`)`) — plus Cancel (confirm()) / Resume buttons mirroring server rules (cancel iff `active`; resume iff `!active` and any attempt pending/running/judging/error).
2. **Totals strip** (`.meta-grid`): `created` (fmtDate + fmtAgo), `finished`, `wall time` (finishedAt−createdAt, else live `Elapsed`), `total cost` (`CostBadge` of totals.totalCostUsd; tooltip notes `unpricedAttempts` when > 0), `attempts` (`finished/attempts`, passed, errors), `best@n`, `concurrency`, `judge model` (code chip; shows the default when null).
3. **`<Matrix>`** with `cellHref = (s, c) => \`#/runs/${id}/attempts/${id}_${s}_${c}_0\`` and `attempts` from the detail fetch (live cells animate).
4. **Per-scenario / per-config breakdown** — two small `DataTable`s (`searchable={false}`): rows = scenarioIds (resp. configIds) with pass-rate, cost, avg duration aggregated from `cells`. Scenario names are `EntityLink kind="scenario"`; configs are chips.
5. Empty state when no runs: panel with hint + `+ new run`.

**New-run dialog** — `evals/ui/src/pages/NewRunDialog.tsx` (NEW file, owned by WP-RUNS; imported only from RunsPage):

```tsx
export function NewRunDialog(props: { open: boolean; onClose: () => void }): ReactNode;
```

Native `<dialog>` (showModal). Fields:
- name (optional text);
- scenarios — checkbox chips from `listScenarios()`; first checked by default;
- configs — checkbox chips from `listConfigs()`; **preselect `isDefault === true`**; chip tooltip = label + model;
- attempts per cell (1-10, default 1); concurrency (1-8, default 2);
- **judge model — models.dev-driven selector**: text input + filtered dropdown from `getModels()` (`fuzzyMatch` over `id` + `name`; show top 12 with name, id, `$in/$out per 1M`, ctx via `fmtTokens(context)`); initial value = `models.defaultJudgeModel` (i.e. `deepseek/deepseek-v4-pro`); free text permitted (custom ids pass through); an `InfoTip` explains "bare OpenRouter id; scenario-level judge models still win".
- Submit → `createRun` → `navigate(\`#/runs/${runId}\`)`; inline error display on 400.

---

## 7. UI — run details page (WP-RUNDETAIL + WP-TRANSCRIPT, wave 1)

### 7.1 Page — `evals/ui/src/pages/RunDetailsPage.tsx` (WP-RUNDETAIL; may also create `pages/run-details.css`)

```tsx
export default function RunDetailsPage(props: { runId: string; attemptId: string | null }): ReactNode;
```

Data: `usePoll(() => getRun(runId), active ? 3000 : 15000, [runId])` (3s while `data.active`, slow poll otherwise); for the selected attempt: `usePoll(() => getAttempt(selId), attemptUnfinished ? 4000 : null, [selId])`. Selected attempt id = `props.attemptId ?? first attempt of first cell`; selecting an attempt calls `navigate(\`#/runs/${runId}/attempts/${id}\`)` (URL-driven, shareable).

**Top meta bar** (full-width `.panel`):
- Line 1: `← runs` backlink (`#/runs`), run name + id, `StatusBadge`, `Spinner label="live"` when active, Cancel/Resume buttons (same rules as §6).
- Line 2 `.meta-grid`: created / finished / wall time (live `Elapsed` when running) / total cost (`CostBadge` + `unpricedAttempts` tooltip) / attempts finished-passed-errored / best@n / concurrency / judge model / scenario+config counts.

**Below: `.layout-30-70`.**

**Left 30% — navigator + checks/judgments:**
1. **`<Matrix>`** (compact) with `attempts` (single source of in-progress display — there is NO separate "in flight" list; this dedupes the old duplication) and `cellHref` → attempt links; `selected` = selected attempt's cell.
2. **Attempt picker**: when the selected cell has >1 attempt, a row of small index buttons (`#0 #1 …` with status dot).
3. **Selected attempt summary** (`.meta-grid`): status, score (`fmtScore`), cost (`CostBadge(costUsd, costSource)`), duration (`fmtDuration`; live `Elapsed since={startedAt}` while running/judging), retries, started/finished, error text (red panel, `white-space: pre-wrap`, when present), task ids.
4. **Phase timings** — small two-column table from `attempt.timings` (boot / seed / tasks (+per-task rows) / log capture / cost wait / checks / llm judge / agentic judge / artifacts); when `timings === null` render one dim line `timings not captured (older run)`.
5. **Sandbox** — `.meta-grid` from `attempt.sandbox`: worker sandbox id, api sandbox id, templates, `apiUrl` as a real `<a>` (note: dead after teardown — `InfoTip`), swarm API key in a `<code>` with copy-on-click (exposing it is deliberate), worker agent id, started/expires. `sandbox === null` → `sandbox info not captured (older run)`.
6. **Checks & judgments** — one block per judgment (poll-updated): name, kind chip (`deterministic`/`llm`), pass/fail left border (green/red), score, `createdAt` (`fmtAgo`), reasoning (pre-wrap), and when `raw` is non-null a collapsed `<JsonView value={JSON.parse(raw)} collapseDepth={1}/>` (try/catch → render raw string). The agentic judge's `raw.toolLog` thus pretty-prints with tool inputs AND outputs.

**Right 70% — tabs** (`.tabs`): `transcript` | `assets`. Active tab in component state (default transcript).
- **Transcript tab**: `<Transcript attemptId={selId} live={attemptUnfinished} />` (contract in §7.2; remount on selection change via `key={selId}`).
- **Assets tab**: `DataTable<ArtifactMetaJson>` of `attemptDetail.artifacts` — columns: kind (filterOptions), name (mono, search), size (`fmtBytes`, align right, sortable), created (`fmtAgo`), actions (open → `artifactUrl(id)` target _blank; download → `artifactUrl(id, { download: true })`). Empty state: "no artifacts yet" (+ Spinner when attempt running).

**Running/empty-attempt states (the "in-progress page must be nicer" item):** an attempt with status `pending` renders the summary block with `<Spinner label="waiting for a pool slot…"/>`; `running` before sandbox info lands shows `<Spinner label="booting sandboxes…"/>`; once `sandbox` arrives (written at boot, §1.4.2) the sandbox block appears live; `judging` shows `<Spinner label="judging…"/>` over the judgments block. Partial data renders as it lands (poll-driven); never a blank pane.

### 7.2 Transcript component — `evals/ui/src/pages/Transcript.tsx` (WP-TRANSCRIPT)

```tsx
export default function Transcript(props: { attemptId: string; live?: boolean }): ReactNode;
```

Self-sufficient: fetches its own data via `usePoll(() => getTranscript(props.attemptId), props.live ? 5000 : null, [props.attemptId])`. Renders:

- `source === null` → empty state "no transcript captured".
- `source === "transcript"` (legacy flat artifact) → caption + `<pre class="t-flat">{text}</pre>`.
- `source === "raw-session-logs"` → run the **ported per-harness transform** (§7.3) over `rows`, then render `ParsedMessage[]`:
  - caption line: `{harness} · {rows.length} events · {messages.length} messages`;
  - `text` blocks → assistant/user bubbles (`white-space: pre-wrap`; no markdown lib — plain text);
  - `thinking` blocks → dim italic block, collapsed behind `▸ thinking (n chars)` when > 400 chars;
  - `tool_use` + paired `tool_result` → one mono tool card: header `⚙ {name}`, `<JsonView value={input} collapseDepth={1}/>`, result body clipped to 2 000 chars with "show all", red tint when `isError`. Pairing: build a `resultById` map from `ToolResultBlock.tool_use_id` across all messages; render results inline under their call; orphan results render standalone. (This reimplements only the pairing idea of the dashboard's `buildStream` — `ui/src/components/shared/session-log-viewer.tsx:497-670` — NOT the component.)
  - `provider_meta` blocks → one dim `.t-meta` line: `· {kind}{data.type ? ": " + data.type : ""}` with a `▸` toggle revealing `<JsonView/>`. Consecutive meta lines collapse into one `· n internal events` group (toggle expands the list).
  - iteration changes render a thin divider `— iteration n —`.
- `live` → footer `<Spinner label="streaming…"/>`.

Owns `evals/ui/src/pages/transcript.css` (message bubbles `.t-msg .t-assistant .t-user .t-thinking .t-tool .t-meta`, tool cards, dividers).

### 7.3 The ported transform — `evals/ui/src/logs-parser/` (WP-TRANSCRIPT)

Copy these four files from the main dashboard **near-verbatim** (pure TS, zero React/framework deps — verified):

| Source (read these) | Destination |
|---|---|
| `ui/src/logs-parser/types.ts` (143 lines) | `evals/ui/src/logs-parser/types.ts` |
| `ui/src/logs-parser/helpers.ts` (192 lines) | `evals/ui/src/logs-parser/helpers.ts` |
| `ui/src/logs-parser/adapters.ts` (477 lines) | `evals/ui/src/logs-parser/adapters.ts` |
| `ui/src/logs-parser/index.ts` (229 lines) | `evals/ui/src/logs-parser/index.ts` |

Also read for contracts/fixtures (do NOT copy): `ui/CLAUDE.md` § "Session Log Parser Runbook", `src/tests/ui-logs-parser.test.ts` (fixtures for all providers).

What the module does (orientation): `parseSessionLogs(logs: SessionLogRecord[]): ParsedMessage[]` — decode JSONL → order → pick adapter by `cli` (`claude`/`pi` → Anthropic stream-json, `codex` → `item.started/completed` pairing, `opencode` → `message.part.delta` reassembly, `claude-managed` → SSE; majority vote + shape-sniff fallback) → normalize to `NormalizedItem`s → coalesce into `ParsedMessage { id, role, content: ContentBlock[], iteration, timestamp }` with blocks `text | thinking | tool_use | tool_result | provider_meta`. The evals `TranscriptRow` (§4.5) is structurally a `SessionLogRecord` (`taskId` is optional there — compatible).

**The ONLY required adaptation** — `orderDecodedRecords` in the copied `helpers.ts` (source lines 43-55): evals rows may lack `createdAt` (old artifacts → `t` is `NaN`), and `lineNumber` resets per iteration, so the original sort (NaN→MAX_SAFE_INTEGER) would scramble multi-iteration transcripts. Replace with:

```ts
export function orderDecodedRecords(decoded: DecodedRecord[]): DecodedRecord[] {
  return [...decoded].sort((a, b) => {
    const t = safeTime(a.t) - safeTime(b.t);
    if (t !== 0) return t;
    const iter = a.rec.iteration - b.rec.iteration;
    if (iter !== 0) return iter;
    const line = a.rec.lineNumber - b.rec.lineNumber;
    if (line !== 0) return line;
    return a.fileIndex - b.fileIndex;
  });
}
function safeTime(value: number): number {
  return Number.isFinite(value) ? value : 0; // missing createdAt → fall through to (iteration, lineNumber)
}
```

(Opencode delta reassembly depends on correct order BEFORE the adapter — this is not optional.) Everything else copies unchanged; keep `index.ts` re-exports as-is.

Do NOT port `session-log-viewer.tsx` (2 411 lines, React-heavy: virtualization, streamdown, prism, lucide). The rendering in §7.2 is the evals-sized replacement.

---

## 8. UI — scenarios pages (WP-SCENARIOS, wave 1)

**File:** `evals/ui/src/pages/ScenariosPage.tsx` (replaces stub; may also create `pages/scenarios.css`).

```tsx
export default function ScenariosPage(props: { scenarioId: string | null }): ReactNode;
```

**List view (`scenarioId === null`)** — data `usePoll(listScenarios, null, [])`:
- Single `.panel` with `DataTable<ScenarioJson>`: columns — id (`EntityLink kind="scenario"`, search), name (search), tasks (count, align right), checks (count + names in Tooltip), judges (chips: `llm` / `agentic` when present, dim "—" otherwise), timeout (`fmtDuration(timeoutMs)`), pass ≥ (`passThreshold`), description (dim, clipped 120 chars, full text in Tooltip, search). Default sort: id asc. Dense table replaces the old cards.

**Detail view (`scenarioId` set)** — data `usePoll(() => getScenario(id), null, [id])`:
1. Header: `← scenarios` backlink, name, id chip, judge chips.
2. **The scenario, pretty-printed** — NO prose reconstruction (the old "What will happen" bloat is deleted; assume readers know the domain): `<JsonView value={scenario} collapseDepth={3}/>` of the full `SerializedScenario`. Exactly one `InfoTip` on the panel title: "checks always include the implicit tasks-completed check". Nothing else gets a description.
3. **Recent attempts table** (`DataTable<AttemptJson>` over `recentAttempts`): columns — started (`fmtAgo`, default sort desc), run (`EntityLink kind="run" id={runId}`), config (chip; `filterOptions` distinct configIds), status (StatusBadge; filterOptions), score (`fmtScore`, align right), cost (`CostBadge`, align right), duration (`fmtDuration`), attempt (`EntityLink kind="attempt" id runId label="open →"`).

(The new-run dialog is specced in §6 and owned by WP-RUNS.)

---

## 9. VERIFICATION

Each package runs the relevant subset; the integrator runs all of it after merging waves.

```bash
# from repo root
cd evals
bun install                       # updates evals/bun.lock — commit it
bun run tsc:check                 # tsc --noEmit (src/scenarios/configs) && tsc --noEmit -p ui
bun run ui:build                  # vite build ui → evals/ui/dist (must succeed)
bun test                          # includes src/cost/pricing.test.ts + src/cost/recompute.test.ts
cd ..
bun run lint                      # biome check src evals — covers evals/ui/src too
```

Server + endpoint smoke (kill anything on :4801 first):

```bash
cd evals && bun src/cli.ts serve &            # boots, applies COLUMN_MIGRATIONS against existing evals.db
sleep 2
curl -s localhost:4801/ | head -3             # built index.html (contains <div id="root">), NOT the 500 hint
curl -s localhost:4801/api/models | head -20  # {"defaultJudgeModel":"deepseek/deepseek-v4-pro","models":[...]}
curl -s localhost:4801/api/configs | grep -c isDefault   # > 0
curl -s localhost:4801/api/runs | head -30    # totals carry totalDurationMs/passedAttempts/errorAttempts/unpricedAttempts
RUN=$(curl -s localhost:4801/api/runs | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["run"]["id"])')
curl -s localhost:4801/api/runs/$RUN | python3 -m json.tool | grep -E 'costSource|sandbox|timings' | head
ATT=$(curl -s localhost:4801/api/runs/$RUN | python3 -c 'import json,sys; print(json.load(sys.stdin)["attempts"][0]["id"])')
curl -s "localhost:4801/api/attempts/$ATT" | head -40
curl -s "localhost:4801/api/attempts/$ATT/transcript" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["source"], d["harness"], len(d["rows"] or []))'
```

Migration safety: also boot once against a fresh DB (`EVALS_DB_PATH=/tmp/fresh-evals.db bun src/cli.ts serve`) — schema + migrations must apply cleanly on both fresh and existing DBs.

Backward-compat check (old rows): open `http://localhost:4801/#/runs`, select a pre-overhaul run → detail pane renders; open its details page → sandbox/timings blocks show "not captured", costs show `—` with tooltip, transcript still renders (legacy-ordering path in §7.3), assets table lists old artifacts. Legacy URL check: open `#/runs/<id>/cells/<scenario>/<config>` → redirects to the attempt view.

### Manual E2E (real run against E2B)

Requires `evals/.env` with `E2B_API_KEY` + `OPENROUTER_API_KEY` (copy from repo-root `.env`).

```bash
cd evals && bun src/cli.ts serve
# in the browser at http://localhost:4801:
# 1. #/runs → "+ new run" → scenario hello-file, config pi-deepseek-flash (preselected via isDefault),
#    judge model field shows deepseek/deepseek-v4-pro preselected from the models.dev list → start
# 2. watch #/runs/<id>: matrix cell animates (braille spinner + ticking elapsed), NO duplicate
#    in-flight section; sandbox block appears mid-boot with ids + swarm key + apiUrl
# 3. after finish: attempt costUsd non-null with costSource badge ("harness" for pi);
#    timings table populated; transcript tab renders pi messages with tool cards;
#    assets tab lists transcript / raw-session-logs / harness-session / tasks.json / worker.log /
#    api.log / session-costs.json / session-files.json (+ seed-output.json for seeded scenarios)
# 4. cost-fallback check: run claude-haiku (OAuth → no priced rows) → costSource "recomputed"
#    with ~$ badge and tokens populated (or "unpriced" + tokens if pricing lookup missed)
bun src/cli.ts show <runId>                   # CLI matrix still works (engine untouched)
# UI dev loop:
bun run ui:dev                                # vite on :5173 proxying /api → :4801; hot reload works
# theme: toggle ◐ in the header — light + dark both render; reload persists choice
```

---

## 10. PARALLEL EXECUTION PLAN

Rules: wave 0 is ONE package and lands first (it scaffolds files and freezes every shared contract). Wave-1 packages run fully parallel with **strictly disjoint file ownership among themselves**; a wave-1 package may replace/edit files scaffolded in wave 0 only where listed as "takes over". No wave-1 package edits another's files or any wave-0 shared file not listed for takeover. If an agent believes it must touch a file it doesn't own, STOP — the contract in this spec is wrong; escalate instead of editing.

### WP0 — scaffold (wave 0)

Spec sections: §0, §1.1-1.3, §2.1, §2.4 (results.ts), §5 (all).
Owns (creates/edits):
- `evals/package.json`, `evals/bun.lock` (via `bun install`), `.github/workflows/merge-gate.yml`
- `evals/src/db/client.ts`, `evals/src/db/queries.ts`, `evals/src/types.ts`, `evals/src/results.ts`
- `evals/src/cost/pricing.ts`, `evals/src/cost/pricing.test.ts`
- `evals/ui/index.html` (replaces the old SPA file), `evals/ui/vite.config.ts`, `evals/ui/tsconfig.json`, `evals/ui/public/logo.png` (copied from `ui/public/logo.png`)
- `evals/ui/src/main.tsx`, `evals/ui/src/App.tsx`, `evals/ui/src/styles.css`, `evals/ui/src/api.ts`, `evals/ui/src/types.ts`, `evals/ui/src/hooks.ts`
- `evals/ui/src/components/DataTable.tsx`, `JsonView.tsx`, `Tooltip.tsx`, `Spinner.tsx`, `StatusBadge.tsx`, `EntityLink.tsx`, `Matrix.tsx`, `format.ts` (full implementations)
- Stub pages: `evals/ui/src/pages/RunsPage.tsx`, `RunDetailsPage.tsx`, `Transcript.tsx`, `ScenariosPage.tsx`
Provides: every backend type/query/pricing contract + every UI shared-component/api/types contract above.
Verification: `bun run tsc:check`, `bun run ui:build`, `bun test src/cost/pricing.test.ts`, root `bun run lint`; `bun src/cli.ts serve` still boots (server serves the OLD path at `/` until WP-API lands — acceptable mid-flight; use `ui:dev` proxy for visual checks).

### Wave 1 (all parallel)

**WP-DATA — capture + cost + judge defaults.** Sections §1.4-1.5, §2.2-2.3, §3.2.
Owns: `evals/src/runner/index.ts`, `evals/src/swarm/sandbox.ts`, `evals/src/swarm/client.ts`, `evals/src/judge/llm.ts`, `evals/src/judge/agentic.ts`, `evals/src/cost/recompute.ts` (new), `evals/src/cost/recompute.test.ts` (new), `evals/README.md`.
Consumes: types/queries/pricing from WP0. Provides: populated `cost_source`/`tokens_json`/`sandbox_json`/`timings_json`, new `meta` artifacts, enriched raw-session-logs rows, judge default `deepseek/deepseek-v4-pro`.
Read first: this spec §1-§3; artifact samples in `evals/evals.db`; `src/be/pricing-normalize.ts` + `src/be/seed-pricing.ts:130-214` (provider→section mapping reference); `src/providers/codex-adapter.ts:566-604` (codex usage semantics).

**WP-API — server endpoints + static serving.** Sections §3.1, §3.3, §4 (all).
Owns: `evals/src/api/server.ts`.
Consumes: queries/types/results/pricing from WP0; `DEFAULT_CONFIG_IDS` from `evals/configs/index.ts` (read-only import). Provides: every §4 contract; serves `evals/ui/dist`.
Read first: this spec §4; current `evals/src/api/server.ts`; `evals/src/registry.ts`.

**WP-RUNS — runs list page + new-run dialog.** Sections §6, §8 (dialog cross-ref).
Owns: `evals/ui/src/pages/RunsPage.tsx` (takes over stub), `evals/ui/src/pages/NewRunDialog.tsx` (new), `evals/ui/src/pages/runs.css` (new, optional).
Consumes: §5.4 components, §5.5 api/types/hooks, §4 contracts.

**WP-RUNDETAIL — run details page.** Section §7.1.
Owns: `evals/ui/src/pages/RunDetailsPage.tsx` (takes over stub), `evals/ui/src/pages/run-details.css` (new, optional).
Consumes: §5.4 components, §5.5 api/types/hooks, `<Transcript>` contract (§7.2), §4 contracts.

**WP-TRANSCRIPT — ported transcript transform + renderer.** Sections §7.2-7.3.
Owns: `evals/ui/src/pages/Transcript.tsx` (takes over stub), `evals/ui/src/pages/transcript.css` (new), `evals/ui/src/logs-parser/types.ts`, `helpers.ts`, `adapters.ts`, `index.ts` (new, copied from `ui/src/logs-parser/*`).
Consumes: `getTranscript` + `TranscriptResponse` (§4.5), JsonView/Spinner/hooks from WP0.
Read first: `ui/src/logs-parser/*` (the four source files), `ui/CLAUDE.md` § Session Log Parser Runbook, `src/tests/ui-logs-parser.test.ts`.

**WP-SCENARIOS — scenarios list + detail.** Section §8 (minus dialog).
Owns: `evals/ui/src/pages/ScenariosPage.tsx` (takes over stub), `evals/ui/src/pages/scenarios.css` (new, optional).
Consumes: §5.4 components, §5.5 api/types/hooks, §4.6 contracts.

Disjointness check: WP-DATA {runner, swarm/*, judge/*, cost/recompute*, README} ∩ WP-API {api/server.ts} ∩ WP-RUNS {RunsPage, NewRunDialog, runs.css} ∩ WP-RUNDETAIL {RunDetailsPage, run-details.css} ∩ WP-TRANSCRIPT {Transcript, transcript.css, logs-parser/*} ∩ WP-SCENARIOS {ScenariosPage, scenarios.css} = ∅. ✓

---

## Feedback-item → spec-section traceability

| Feedback item | Spec section(s) |
|---|---|
| Runs list 1 — 30/70 split | §6 (`.layout-30-70`), §5.6 |
| Runs list 2 — table with fuzzy search/sort/filter by scenario etc. | §6 left pane, §5.4 DataTable |
| Runs list 3 — richer right pane (matrix, in-page details, button to details page) | §6 right pane (Matrix, breakdowns, `open details →`) |
| Runs list 4 — totals (time, cost, when run, …) | §6 totals strip; §2.4 results.ts totals; §4 TotalsJson |
| Runs list 5 — models.dev selector + DeepSeek V4 Pro default | §3.1-3.2, §4.7, §6 NewRunDialog judge-model selector |
| Scenario details 1 — pretty-printed JSON, kill bloat | §8 detail view (JsonView of SerializedScenario; prose "What will happen" deleted) |
| Scenario details 2 — recent runs as table with filters | §8 recent-attempts DataTable (config/status filters) |
| Run details 1 — 30/70 split | §7.1 layout |
| Run details 2 — left = checks, better printed, times + cost | §7.1 left pane (judgments blocks, phase timings, CostBadge), §1.4 timings capture |
| Run details 3 — right tabs: transcript / assets table | §7.1 right pane tabs; §4.4 assets listing; assets DataTable |
| Run details 4 — top meta + stored sandbox info (cost, ids, urls, api key OK) | §7.1 top bar + sandbox block; §1.1-1.2, §1.4.2 SandboxInfo (swarmKey stored/exposed) |
| Run details 5 — ported harness-aware transcript transform from ui/ | §7.2-7.3 (port of `ui/src/logs-parser/*`), §4.5 raw-rows endpoint, §1.4.7 id/createdAt capture |
| In-progress 1 — dedupe in-flight vs matrix | §7.1 left pane (Matrix is the only in-flight display; §5.4 Matrix `attempts` prop) |
| In-progress 2 — running details page not empty | §7.1 running/empty-attempt states (boot-time sandbox info, partial data as it lands) |
| In-progress 3 — animations for in-progress | §5.4 Spinner/PulseDot/Elapsed (braille frames, reduced-motion safe), §6/§7 usage |
| Scenarios list 1 — better formatted | §8 list view DataTable |
| General 1 — extreme data capture on ALL assets | §1.4 (seed output, session-cost rows, file listings, api+worker logs, judge tool outputs, sandbox meta, timings, log re-fetch) |
| General 2 — tables over cards | §5.4 DataTable; §6, §7.1 assets, §8 — every list is a table |
| General 3 — backlinking everywhere | §5.4 EntityLink + usage in §6-§8 (every run/scenario/attempt/artifact reference links) |
| General 4 — pretty-print raw JSON, tooltips over descriptions | §5.4 JsonView + InfoTip; §7.1 judgment raw; §8 scenario JSON |
| General 5 — lowkey icons + unicode animations | §5.6 (glyph-only icon policy), §5.4 Spinner |
| General 6 — swarm branding, logo, favicon | §5.3 (logo.png, favicon, wordmark), §5.6 (zinc+amber tokens, Space Grotesk/Mono) |
| General 7 — cost ALWAYS tracked | §2 (harness → recomputed → unpriced chain, stability polling, dead-fallback removal), §2.4 + CostBadge surfacing |
