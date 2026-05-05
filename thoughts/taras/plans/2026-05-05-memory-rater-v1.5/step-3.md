---
id: step-3
name: Worker rating endpoints (`/api/memory/rate`, `/api/memory/retrievals`) + OpenAPI
depends_on: [step-1]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-3: Worker rating endpoints + OpenAPI

## Overview

Expose the rating pipeline over HTTP so worker-side raters (LlmRater in step-4, ExplicitSelfRatingRater in step-5) can write through `applyRating` without touching SQLite. Two new endpoints: `POST /api/memory/rate` (ingests `RatingEvent[]`) and `GET /api/memory/retrievals` (returns retrieval rows for a task/session, used by the worker to know which memories to rate). Both regenerated into `openapi.json` and the api-reference MDX.

## Changes Required:

#### 1. `POST /api/memory/rate` route handler

**File**: `src/http/memory.ts`

**Changes**:

- New `route()` handler at `POST /api/memory/rate`. Use the `route()` factory from `src/http/route-def.ts` — auto-registers in OpenAPI per `CLAUDE.md`.
- Auth: `X-Agent-ID` (existing pattern) + Bearer.
- Zod request schema:
  ```ts
  const RateRequestSchema = z.object({
    events: z.array(z.object({
      memoryId: z.string().min(1),
      signal: z.number().min(-1).max(1),
      weight: z.number().min(0).max(1),
      source: z.enum(["llm", "explicit-self"]),  // server enforces — no spoofing
      reasoning: z.string().max(500).optional(),
      taskId: z.string().uuid().optional(),
    })).min(1).max(50),  // 50-event cap matches the typical session retrieval set
  });
  ```
- Server validates `source ∈ {llm, explicit-self}` (only worker raters POST through HTTP; `implicit-citation` runs in-process and never hits this endpoint).
- For `source === "explicit-self"`: server-side validation enforces R6's "Reject IDs not present in `memory_retrieval` for that task" rule. If `taskId` is missing OR no `memory_retrieval` row exists for `(taskId, memoryId)` → return 400 with a clear error.
- Dispatch to `applyRating(events, { taskId })`.
- Return shape:
  ```ts
  { applied: number; rejected: { memoryId: string; reason: string }[] }
  ```
- 409 response when the partial unique index trips (caught by `applyRating`'s typed error → mapped to `409 Conflict` here).
- Idempotency: not enforced. Beta updates are commutative; duplicates just shift the posterior slightly. R6 spam-guard is enforced at the DB level for `explicit-self` only.
- Secret-scrubbing: any logged event payload routes through `scrubSecrets` per `CLAUDE.md`.

#### 2. `GET /api/memory/retrievals` route handler

**File**: `src/http/memory.ts`

**Changes**:

- New `route()` handler at `GET /api/memory/retrievals`.
- Zod query schema: at least one of `taskId` or `sessionId` must be present:
  ```ts
  const RetrievalsQuerySchema = z.object({
    taskId: z.string().uuid().optional(),
    sessionId: z.string().optional(),
  }).refine(q => q.taskId || q.sessionId, { message: "taskId or sessionId required" });
  ```
- Returns the matching `memory_retrieval` rows joined with the corresponding `agent_memory` rows (id, name, content snippet up to 500 chars, scope, similarity, retrievedAt). Limit 50 rows.
- Auth: `X-Agent-ID` + Bearer (existing pattern). Server filters by `agentId` from the header (an agent can only see its own retrievals — defence-in-depth even though the worker is trusted).

#### 3. Wire routes into the chain + OpenAPI generator

**File**: `src/http/index.ts`

**Changes**:

- Add the two new handlers to the route chain. Match the existing pattern used by `searchMemory`, `listMemory`, etc. (they're pulled from `src/http/memory.ts`).

**File**: `scripts/generate-openapi.ts`

**Changes**:

- Add the two new handler imports so the route metadata flows into the spec.

#### 4. OpenAPI + api-reference regen

**Commands** (run after the code changes land):

- `bun run docs:openapi` — must produce a non-empty diff in `openapi.json` AND in `docs-site/content/docs/api-reference/**`. Commit both.
- This runs automatically on the merge gate but the step is responsible for committing the regenerated files.

#### 5. Header-only addition: `X-Source-Task-ID` documented as optional on `/api/memory/search`

**File**: `src/http/memory.ts`

**Changes**:

- Step-2 already implements the read path. step-3 simply ensures the OpenAPI spec lists `X-Source-Task-ID` as an optional request header on `/api/memory/search` (via `route()` metadata). Regenerate spec.
- This is a no-op behaviour change vs. step-2 — it's a documentation/spec-freshness concern only.

#### 6. Unit + integration tests

**File**: `src/tests/memory-rate-endpoint.test.ts` (new)

**Changes**:

- POST one event with `source="llm"` → 200, `applied=1`, `agent_memory.alpha` moved.
- POST one event with `source="explicit-self"` and a valid `(taskId, memoryId)` in `memory_retrieval` → 200.
- POST same event twice → second call returns 409 (partial unique index trips).
- POST with `source="implicit-citation"` (worker spoof attempt) → 400 (server rejects — only `llm` and `explicit-self` allowed over HTTP).
- POST with `source="explicit-self"` and a `memoryId` NOT in `memory_retrieval` for the task → 400.
- POST 51 events → 400 (cap enforcement).
- GET `/api/memory/retrievals?taskId=…` returns the inserted rows in `retrievedAt DESC` order, joined with `agent_memory` content.
- GET `/api/memory/retrievals` with neither `taskId` nor `sessionId` → 400.
- Concurrency: `Promise.all` over 20 POST calls to the same memory with `signal=+1, weight=1.0` — final `alpha` increase ≈ 20 (within float rounding).

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
*(Low-level: runnable commands. Tests, lint, type-check, build.)*

- [ ] Tests pass: `bun test src/tests/memory-rate-endpoint.test.ts`.
- [ ] All other memory tests still pass: `bun test src/tests/memory-rater-store.test.ts src/tests/memory-rater-implicit-citation.test.ts src/tests/memory.test.ts src/tests/memory-e2e.test.ts`.
- [ ] Linting passes: `bun run lint:fix`.
- [ ] Typecheck passes: `bun run tsc:check`.
- [ ] DB-boundary check passes: `bash scripts/check-db-boundary.sh`.
- [ ] OpenAPI spec is fresh: `bun run docs:openapi` produces no diff after the commit.
- [ ] `openapi.json` includes `POST /api/memory/rate`, `GET /api/memory/retrievals`, and the `X-Source-Task-ID` header on `/api/memory/search` (grep the file).
- [ ] `docs-site/content/docs/api-reference/**` has matching MDX entries.

#### Automated QA:
*(Agent-driven proof of work: same job a human QA would do, but the agent does it.)*

- [ ] Agent runs the API server, then via `curl`:
  1. `POST /api/memory/rate` with one valid `llm` event → 200, `{applied: 1, rejected: []}`.
  2. Verifies via sqlite shell that `agent_memory.alpha` moved and one `memory_rating` row exists.
  3. `POST /api/memory/rate` with an `explicit-self` event whose `memoryId` was NOT retrieved for the task → 400.
  4. `POST /api/memory/rate` with the same `(taskId, memoryId)` `explicit-self` event twice → second returns 409.
  5. `GET /api/memory/retrievals?taskId=<uuid>` returns the expected rows.

#### Manual Verification:
*(Only what truly needs a human — visual judgment, real-device perf, things the agent genuinely cannot reach.)*

- [ ] Eyeball the regenerated MDX in `docs-site/content/docs/api-reference/**` to confirm the new endpoints are described readably.

**Implementation Note**: This step is a parallel-safe sibling to step-2 — both depend only on step-1 and touch disjoint files (modulo a shared import of `applyRating`). Worker-side hooks land in steps 4–5.
