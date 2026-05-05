---
id: step-2
name: Retrieval bridge + `ImplicitCitationRater`
depends_on: [step-1]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-2: Retrieval bridge + `ImplicitCitationRater`

## Overview

Light up the first live rater. Plumb `X-Source-Task-ID` through both `/api/memory/search` paths so the server records `memory_retrieval` rows when search is task-scoped. Implement the server-side `ImplicitCitationRater` (pure ID-grep over `session_logs`) and wire it to fire from the existing memory-write hook in `src/tools/store-progress.ts:295`. After this step, retrieval → citation → posterior shift works end-to-end without any worker-side changes.

## Changes Required:

#### 1. Header plumbing on the HTTP search endpoint

**File**: `src/http/memory.ts`

**Changes**:

- In the `/api/memory/search` handler (currently around `184-228`), read `requestInfo.sourceTaskId` (already extracted by `getRequestInfo` per `src/tools/utils.ts:18-44`).
- After `rerank`, if `sourceTaskId` is present, INSERT one `memory_retrieval` row per returned memory: `(uuid, sourceTaskId, agentId, sessionId?, memoryId, similarity, retrievedAt=now)`.
- Inserts must be best-effort (try/catch with console.error) — a retrieval-bridge failure must never poison search.
- Header is OPTIONAL: when absent, behaviour is identical to today (no `memory_retrieval` row inserted).

#### 2. Header plumbing on the runner's HTTP search call

**File**: `src/commands/runner.ts`

**Changes**:

- In the `fetchRelevantMemories` call (around `runner.ts:1540-1560`), add `"X-Source-Task-ID": taskId` to the `headers` object whenever `taskId` is in scope.
- One-line change. The runner already has `taskId` available at this call site.

#### 3. In-process MCP-tool search path

**File**: `src/tools/memory-search.ts`

**Changes**:

- The MCP tool runs in-process on the API server with `requestInfo.sourceTaskId` already extracted. Thread `requestInfo.sourceTaskId` into the `MemoryStore.search()` call OR (simpler) write the same `memory_retrieval` row from the tool handler post-rerank.
- Match whichever shape `src/http/memory.ts` ends up using so we have one helper, not two — extract a shared `recordRetrievals(taskId, agentId, results)` function in `src/be/memory/raters/retrieval.ts` (new) that both paths call.

#### 4. `ImplicitCitationRater` implementation

**File**: `src/be/memory/raters/implicit-citation.ts` (new)

**Changes**:

- `class ImplicitCitationRater implements MemoryRater` with `name = "implicit-citation"`.
- `rate(ctx)`:
  - For each `memoryId` in `ctx.retrievedMemoryIds`:
    - If `ctx.evidence` (the concatenated `session_logs` text for the task) contains the literal `memoryId` → emit `{ memoryId, signal: +1, weight: 0.5, source: "<set by framework>" }`.
    - Else → emit `{ memoryId, signal: -1, weight: 0.25, source: "<set by framework>" }` (negative miss carries less info per IR convention from research §3.A and brainstorm Q4).
- ID-grep only — no n-gram, no content-substring (deferred per "What We're NOT Doing" in `root.md`).
- Pure function; deterministic; trivially unit-testable.

#### 5. Fire `ImplicitCitationRater` from `store-progress.ts`

**File**: `src/tools/store-progress.ts`

**Changes**:

- Inside the existing post-task memory-indexing block (`store-progress.ts:295-359`, the `if (status === "completed" || status === "failed") {...}` branch):
  - After (not before) the existing `store.store(...)` call, fire the server-side rater chain:
    1. Look up `memory_retrieval` rows for `taskId`.
    2. If empty → no-op.
    3. Read concatenated `session_logs` for `taskId` (existing helper or one-line query — `src/be/db.ts` already has `getSessionLogs(taskId)` or equivalent; fall back to a direct SQL query if not).
    4. For each rater in `getRegisteredRaters()` whose `name` is server-side (currently just `implicit-citation` — gate via a `SERVER_RATERS = new Set(["implicit-citation"])` constant in `src/be/memory/raters/registry.ts`):
       - Call `rater.rate({ taskId, agentId, retrievedMemoryIds, evidence: logsText })`.
       - Set `event.source = rater.name` on each emitted event (framework-owned).
       - Pass through `MEMORY_RATER_WEIGHTS` multiplier from the registry.
       - Call `applyRating(events, { taskId })`.
- Wrap in try/catch — rater failure must not affect task status (matches existing fire-and-forget pattern at `store-progress.ts:355-358`).

#### 6. Register `ImplicitCitationRater` in the registry

**File**: `src/be/memory/raters/registry.ts`

**Changes**:

- Add `implicit-citation: () => new ImplicitCitationRater()` to the registry map.
- Add `implicit-citation` to the `SERVER_RATERS` set (used by `store-progress.ts` to decide which raters fire server-side).

#### 7. Unit tests for `ImplicitCitationRater`

**File**: `src/tests/memory-rater-implicit-citation.test.ts` (new)

**Changes**:

- Pure-function tests: given `retrievedMemoryIds = ["mem-A", "mem-B"]` and `evidence = "...used mem-A here..."`, assert exactly one positive event for `mem-A` and one negative event for `mem-B`, with the documented `(signal, weight)` values.
- Edge cases: empty `evidence`, empty `retrievedMemoryIds`, identical `memoryId` substrings (e.g., `mem-A` is a prefix of `mem-AB`) — the test suite asserts the algorithm's chosen behaviour (literal substring match — document this in the rater file's comment and lock with a test).

#### 8. Integration test: retrieval → citation → posterior

**File**: `src/tests/memory-rater-implicit-citation.test.ts` (extend the file from #7)

**Changes**:

- Spin the API server in a test harness, insert a synthetic memory, simulate a search with `X-Source-Task-ID`, simulate `session_logs` content that cites the memory's id, call `store-progress.complete(taskId)`, and assert:
  - One `memory_retrieval` row exists for `taskId`.
  - One `memory_rating` row exists with `source='implicit-citation'`.
  - `agent_memory.alpha` for the cited memory increased by `0.5`; `beta` unchanged.
- Negative-path test: same setup but `session_logs` does NOT contain the memory id — assert `agent_memory.beta` increased by `0.25`.

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
*(Low-level: runnable commands. Tests, lint, type-check, build.)*

- [ ] Tests pass: `bun test src/tests/memory-rater-implicit-citation.test.ts`.
- [ ] All other memory tests still pass: `bun test src/tests/memory-reranker.test.ts src/tests/memory-store.test.ts src/tests/memory.test.ts src/tests/memory-e2e.test.ts src/tests/memory-rater-store.test.ts`.
- [ ] Linting passes: `bun run lint:fix`.
- [ ] Typecheck passes: `bun run tsc:check`.
- [ ] DB-boundary check passes: `bash scripts/check-db-boundary.sh` (rater + retrieval helpers are server-side only).
- [ ] No new unit tests fail when `MEMORY_RATERS=implicit-citation` is set in the env.
- [ ] Backward-compat: with `MEMORY_RATERS` unset, the snapshot test from step-1 still passes byte-for-byte.

#### Automated QA:
*(Agent-driven proof of work: same job a human QA would do, but the agent does it.)*

- [ ] Agent runs `MEMORY_RATERS=implicit-citation bun run start:http`, then via `curl`:
  1. Inserts a memory via `POST /api/memory/index`.
  2. Issues `POST /api/memory/search` with `X-Source-Task-ID: <uuid>` and confirms one `memory_retrieval` row was inserted.
  3. Inserts a synthetic `session_logs` row whose content contains the memory's id (or simulates the call path that does so).
  4. Calls `store-progress` with `status=completed` for the same `taskId`.
  5. Queries `agent_memory.alpha/beta` for the memory and confirms `alpha = 1.5, beta = 1.0`.
  6. Queries `memory_rating` and confirms one row with `source='implicit-citation', signal=+1, weight=0.5`.

#### Manual Verification:
*(Only what truly needs a human — visual judgment, real-device perf, things the agent genuinely cannot reach.)*

- [ ] Eyeball the `recordRetrievals` helper for any case where it could double-insert (idempotency is not required for v1, but obvious O(n²) inserts during a paginated search are a smell).

**Implementation Note**: This step lights up the first live rater end-to-end. After completion, pause for manual confirmation.
