---
id: step-4
name: `LlmRater` + `hook.ts` summary-call piggyback
depends_on: [step-2, step-3]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-4: `LlmRater` + `hook.ts` summary-call piggyback

## Overview

Light up the second live rater. Extend the existing session-summary LLM call in `src/hooks/hook.ts:1080-1145` so the same Haiku invocation that produces the summary ALSO emits a Zod-validated `ratings: [{ id, score, reasoning }]` array. The worker GETs `/api/memory/retrievals?taskId=` (step-3) to know which memories the LLM should consider, builds a structured prompt, and POSTs the resulting `RatingEvent[]` to `/api/memory/rate` (step-3). Default LLM client = `claude -p` shell-out (zero new deps).

## Changes Required:

#### 1. `LlmRaterClient` interface + Claude-CLI default impl

**File**: `src/be/memory/raters/llm-client.ts` (new)

> File lives under `src/be/memory/raters/` for type re-use, but the **runtime implementation must not import `bun:sqlite` or `src/be/db.ts`** so it can be invoked from worker-side `hook.ts`. The DB-boundary check enforces this — the file should only export a pure interface + a shell-out impl.

**Changes**:

- Define:
  ```ts
  export interface LlmRaterClient {
    rate(input: { query: string; memory: { id: string; name: string; content: string }; response: string }): Promise<{ score: number; reasoning: string } | null>;
  }
  ```
- `class ClaudeCliLlmRaterClient implements LlmRaterClient` — shells to `claude -p --model $MEMORY_LLM_RATER_MODEL --output-format json` exactly like `hook.ts:1097` does today. Reads `MEMORY_LLM_RATER_PROVIDER` (default `claude-cli`) and `MEMORY_LLM_RATER_MODEL` (default `haiku`).
- Returns `null` on parse failure / non-JSON output / timeout (worker treats `null` as "skip this rating", no posterior change).

#### 2. `LlmRater` framework wrapper

**File**: `src/be/memory/raters/llm.ts` (new)

**Changes**:

- `class LlmRater implements MemoryRater` with `name = "llm"`.
- The worker-side flow does NOT call `rater.rate(ctx)` directly because the LLM call is piggybacked on the existing summary call (cost optimization). Instead, the worker constructs `RatingEvent[]` from the parsed structured output and POSTs them.
- This file is small — it carries the Zod schema for the summary's `ratings` array and a helper `buildRatingsFromLlm(ratings, retrievals): RatingEvent[]` that the hook calls.

#### 3. Extend `hook.ts` summary call to emit ratings

**File**: `src/hooks/hook.ts`

**Changes**:

- Around `hook.ts:1080-1145` (the existing summary block):
  - Before the LLM call, GET `/api/memory/retrievals?taskId=<taskId>` (when `taskId` is in scope and `MEMORY_RATERS` includes `llm`).
  - If retrievals are non-empty, embed them into the summary prompt with a structured-output instruction. The LLM must return JSON matching:
    ```ts
    const SummaryWithRatingsSchema = z.object({
      summary: z.string(),
      ratings: z.array(z.object({
        id: z.string(),
        score: z.number().min(0).max(1),
        reasoning: z.string().min(1).max(500),
      })).default([]),
    });
    ```
  - Continue using `claude -p --model haiku --output-format json` — same shell-out as today (`hook.ts:1097`).
  - Parse output; if it parses against the schema, build `RatingEvent[]` via:
    ```ts
    {
      memoryId: r.id,
      signal: 2 * r.score - 1,    // 0..1 → -1..+1
      weight: 0.8,                 // research doc's LLM intent_weight
      source: "llm",               // framework-set; server validates
      reasoning: r.reasoning,
    }
    ```
  - POST to `/api/memory/rate` with `{events}`. Best-effort: 4xx/5xx caught + logged via `console.error`; never blocks summary indexing.
- The existing summary-text indexing path (`POST /api/memory/index`) is unchanged.
- If `MEMORY_RATERS` does NOT include `llm`, OR `retrievals` is empty → fall back to the existing summary-only prompt; no rating extraction. Strict opt-in.
- Rationale for piggybacking: the LLM call already happens (cost is paid). Adding a structured `ratings` array is ~20 extra output tokens per retrieved memory.

#### 4. Register `LlmRater` in the registry

**File**: `src/be/memory/raters/registry.ts`

**Changes**:

- Add `llm: () => new LlmRater()` to the registry map.
- The `SERVER_RATERS` set introduced in step-2 stays the same (LlmRater is worker-side; it does NOT fire from `store-progress.ts`).

#### 5. Mock `LlmRaterClient` for tests

**File**: `src/tests/mocks/mock-llm-rater-client.ts` (new)

**Changes**:

- `MockLlmRaterClient` returns a deterministic `{ score, reasoning }` per-call lookup. Used by step-4's tests AND step-7's cross-cutting e2e.

#### 6. Unit tests for `LlmRater` schema + event construction

**File**: `src/tests/memory-rater-llm.test.ts` (new)

**Changes**:

- `SummaryWithRatingsSchema.parse` accepts a valid response and rejects invalid ones (out-of-range `score`, missing `reasoning`, etc.).
- `buildRatingsFromLlm` correctly maps `score=0 → signal=-1`, `score=1 → signal=+1`, `score=0.5 → signal=0`.
- `MockLlmRaterClient` plus a sample call to `LlmRater.rate(ctx)` produces the expected `RatingEvent[]`.
- `weight` is exactly `0.8` per research-doc convention.

#### 7. Integration test: hook-piggyback dry-run

**File**: `src/tests/memory-rater-llm.test.ts` (extend the file from #6)

**Changes**:

- Mock the `claude -p` shell-out (e.g., via a `MOCK_LLM_OUTPUT` env var the hook respects in test mode, or a small abstraction in the `ClaudeCliLlmRaterClient` that consults a global testing hook).
- Synthesize `memory_retrieval` rows for a known `taskId`, run the hook's summary block end-to-end, and assert:
  - `POST /api/memory/rate` was called with the expected `RatingEvent[]`.
  - `agent_memory.alpha/beta` moved per the mocked `score`.
- Negative path: `MEMORY_RATERS` unset → no `/api/memory/rate` call, summary-only behaviour preserved.

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
*(Low-level: runnable commands. Tests, lint, type-check, build.)*

- [ ] Tests pass: `bun test src/tests/memory-rater-llm.test.ts`.
- [ ] All other memory tests still pass.
- [ ] Linting passes: `bun run lint:fix`.
- [ ] Typecheck passes: `bun run tsc:check`.
- [ ] DB-boundary check passes: `bash scripts/check-db-boundary.sh` — `src/hooks/hook.ts` and `src/be/memory/raters/llm.ts` MUST NOT import `bun:sqlite` or `src/be/db.ts`. **This is the key invariant for this step.**
- [ ] No new SDK dependencies in `package.json` (LlmRater shells to `claude -p` only).

#### Automated QA:
*(Agent-driven proof of work: same job a human QA would do, but the agent does it.)*

- [ ] Agent runs `MEMORY_RATERS=llm bun run pm2-start` (lead + worker), creates a task that retrieves one memory, lets the worker complete and run its session-summary hook. Inspects:
  1. `agent_memory.alpha` for the retrieved memory moved (positive or negative depending on the LLM's chosen score).
  2. One `memory_rating` row with `source='llm'` and a non-empty `reasoning`.
  3. `MEMORY_RATERS` unset reproduces the pre-change summary behaviour byte-for-byte.

#### Manual Verification:
*(Only what truly needs a human — visual judgment, real-device perf, things the agent genuinely cannot reach.)*

- [ ] Eyeball one or two `reasoning` strings in `memory_rating` to confirm Haiku is producing useful, debuggable explanations (not just "this memory was useful").

**Implementation Note**: This step depends on step-2 (memory_retrieval rows must populate first) and step-3 (POST /rate + GET /retrievals endpoints must exist). Sibling to step-5 — both can land in parallel.
