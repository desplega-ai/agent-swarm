---
id: step-6
name: `references-source` edges, lite (v1.5 wedge)
depends_on: [step-3, step-4, step-5]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-6: `references-source` edges, lite (v1.5 wedge)

## Overview

Ship the SINGLE most useful edge type — `references-source` — with the smallest possible surface. New table `agent_memory_edge` constrained to `type='references-source'` only. Both the `memory_rate` MCP tool (step-5) and the LlmRater Zod schema (step-4) gain an optional `referencesSource: string` field. When present, `applyRating` upserts the corresponding edge row and updates its own `(alpha, beta)` identically to the memory's. New endpoint `GET /api/memory/edges?memoryId=` returns the edges for a memory (powers the homepage demo: "this memory references PR #377").

This is the "knowledge-not-data" wedge: memories anchored to external sources of truth instead of trying to BE the source of truth. The full synaptic graph (supersedes / contradicts / multi-type) is reserved for v2.

## Changes Required:

#### 1. New migration: `050_memory_edges.sql`

**File**: `src/be/migrations/050_memory_edges.sql`

**Changes**:

```sql
CREATE TABLE IF NOT EXISTS agent_memory_edge (
  from_id   TEXT NOT NULL,                                                -- memory id
  to_id     TEXT NOT NULL,                                                -- external entity id, e.g. "github:desplega-ai/agent-swarm#377"
  type      TEXT NOT NULL CHECK (type = 'references-source'),             -- v1.5: ONE type only; lifting this is a v2 migration
  alpha     REAL NOT NULL DEFAULT 1.0,
  beta      REAL NOT NULL DEFAULT 1.0,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, type),
  FOREIGN KEY (from_id) REFERENCES agent_memory(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memedge_from ON agent_memory_edge(from_id);
CREATE INDEX IF NOT EXISTS idx_memedge_to   ON agent_memory_edge(to_id);
CREATE INDEX IF NOT EXISTS idx_memedge_type ON agent_memory_edge(type);
```

- Composite primary key `(from_id, to_id, type)` doubles as the upsert key.
- `CHECK (type = 'references-source')` is the v1.5 guardrail — any future PR adding a new edge type MUST drop and recreate this constraint via a forward migration. The constraint is intentionally restrictive to make scope creep visible in code review.
- FK `from_id REFERENCES agent_memory(id) ON DELETE CASCADE` cleans up edges when a memory is deleted. `to_id` is an opaque external string with no FK (intentional — the swarm doesn't own GitHub PR IDs / Linear issue IDs / etc.).
- `idx_memedge_to` reserved for v2's "find all memories referencing this PR" query (not used in v1.5 but indexes don't hurt).

#### 2. Extend `RatingEvent` schema with `referencesSource?`

**File**: `src/be/memory/raters/types.ts` (touched in step-1)

**Changes**:

- Extend `RatingEvent`:
  ```ts
  export type RatingEvent = {
    memoryId: string;
    signal: number;
    weight: number;
    source: string;
    reasoning?: string;
    referencesSource?: string;  // NEW: opaque external id, v1.5 wedge
  };
  ```
- Validation rule: `referencesSource`, when present, must be a non-empty string ≤ 256 chars. Format guidance ("github:owner/repo#N", "linear:KEY-N", "notion:<page-id>", "customer:<slug>") is documentation-only — server does NOT validate the prefix in v1.5 (any non-empty string accepted).

#### 3. Extend `applyRating` to upsert edges

**File**: `src/be/memory/raters/store.ts` (created in step-1)

**Changes**:

- For each `RatingEvent` whose `referencesSource` is present, after applying the existing memory `(alpha, beta)` update:
  ```sql
  INSERT INTO agent_memory_edge (from_id, to_id, type, alpha, beta, createdAt)
  VALUES (?, ?, 'references-source', 1.0 + ?, 1.0 + ?, ?)
  ON CONFLICT(from_id, to_id, type) DO UPDATE SET
    alpha = alpha + excluded.alpha - 1.0,
    beta  = beta  + excluded.beta  - 1.0;
  ```
  where the deltas are `max(0, signal) * weight` and `max(0, -signal) * weight` respectively (identical math to the memory update).
  - The `- 1.0` corrections in the `DO UPDATE` arm undo the default-prior offset that the `INSERT` arm baked into `excluded.alpha`/`excluded.beta`. Net effect: on insert, alpha/beta start at `1 + delta`; on update, the existing `(alpha, beta)` simply gain `(delta_alpha, delta_beta)`.
  - Alternative: explicit "row exists?" check + branched UPDATE/INSERT — equally correct, slightly more code. Pick whichever the implementer finds cleaner; either form satisfies the success criteria.
- One transaction per `applyRating` call still — both memory update and edge upsert atomic together.

#### 4. Extend `POST /api/memory/rate` Zod request schema

**File**: `src/http/memory.ts` (touched in step-3)

**Changes**:

- Add `referencesSource: z.string().min(1).max(256).optional()` to the per-event schema.
- No other validation. Prefix-format documentation is in the OpenAPI description string only.

#### 5. Extend `memory_rate` MCP tool input

**File**: `src/tools/memory-rate.ts` (created in step-5)

**Changes**:

- Add `referencesSource: z.string().min(1).max(256).optional()` to `inputSchema`.
- Description string for the field:
  ```
  Optional external source ID this memory references. Format: "github:owner/repo#N" | "linear:KEY-N" | "notion:<page-id>" | "customer:<slug>". When present, an edge from this memory to the external source is created/updated.
  ```
- Pass `referencesSource` through into the POSTed `RatingEvent`.

#### 6. Extend LlmRater Zod schema

**File**: `src/be/memory/raters/llm.ts` (created in step-4)

**Changes**:

- Extend `SummaryWithRatingsSchema`:
  ```ts
  ratings: z.array(z.object({
    id: z.string(),
    score: z.number().min(0).max(1),
    reasoning: z.string().min(1).max(500),
    referencesSource: z.string().min(1).max(256).optional(),  // NEW
  })).default([]),
  ```
- `buildRatingsFromLlm(ratings, retrievals)` propagates `referencesSource` through to the constructed `RatingEvent`.
- Update the LLM prompt template (used in `src/hooks/hook.ts` summary call) to mention the optional field. Brief addition along the lines of:
  ```
  Optionally for each rating, if the memory clearly references a specific GitHub PR / Linear issue / Notion page / customer, include a `referencesSource` string with format "github:owner/repo#N" | "linear:KEY-N" | "notion:<page-id>" | "customer:<slug>". Omit the field if no clear external source.
  ```
- This is the only LLM-prompt change in v1.5.

#### 7. New endpoint `GET /api/memory/edges?memoryId=`

**File**: `src/http/memory.ts` (touched in step-3)

**Changes**:

- New `route()` handler at `GET /api/memory/edges`.
- Zod query schema: `{ memoryId: z.string().min(1) }`.
- Returns edges for the memory:
  ```ts
  { edges: Array<{
      to: string;          // = to_id
      type: "references-source";
      alpha: number;
      beta: number;
      usefulness: number;  // = clamp(2 * α/(α+β), 1.0, 2.0) — same formula as memory reranker
      createdAt: string;
  }> }
  ```
- Auth: `X-Agent-ID` + Bearer (existing pattern). Server filters by `agentId` on the joined `agent_memory` row (an agent can read swarm-scope memories' edges; agent-scope memories' edges only when the row is theirs — defence-in-depth).
- The response includes `usefulness` so the homepage demo can render "this memory references PR #377 (high-confidence)" without re-running the reranker math client-side.

#### 8. Wire route + OpenAPI regen

**File**: `src/http/index.ts`, `scripts/generate-openapi.ts`

**Changes**:

- Add the new handler to the route chain and to the OpenAPI generator.
- Run `bun run docs:openapi` and commit the regenerated `openapi.json` + `docs-site/content/docs/api-reference/**`.

#### 9. Tests

**File**: `src/tests/memory-edges.test.ts` (new)

**Changes**:

- `applyRating` with one event carrying `referencesSource="github:foo/bar#1"` → both `agent_memory.alpha` AND `agent_memory_edge.alpha` move by the same delta. New edge row exists.
- Same event POSTed twice → second call updates the existing edge row in place; final `(alpha, beta)` sum the two deltas. No duplicate edge row.
- Different `referencesSource` for the same memory → two edge rows.
- `agent_memory_edge.type` constraint trips when an explicit `INSERT` with `type='supersedes'` is attempted (assert via raw sqlite call — proves the v2 guardrail works).
- `GET /api/memory/edges?memoryId=` returns the rows correctly, including the computed `usefulness` field.
- `GET /api/memory/edges` without `memoryId` → 400.
- `memory_rate` tool with `referencesSource` field → tool succeeds, edge row exists.
- LlmRater path: mock the LLM response to include a `referencesSource`, run the hook end-to-end, assert the edge row exists.
- Negative path: `RatingEvent` without `referencesSource` (the v1 baseline) → no edge row created, behaviour identical to step-1.

#### 10. Out-of-scope hooks (reserved for v2)

Capture in code comments only — no implementation:

- **Edge-aware reranking**: `src/be/memory/reranker.ts` does NOT consult `agent_memory_edge`. Comment: `// v2: optional edge-aware boost — see thoughts/taras/plans/2026-05-05-memory-rater-v1.5/root.md`.
- **Edge GC**: edges with stale `to_id` (deleted PRs, archived Linear issues) live forever in v1.5. Comment in `runbooks/memory-system.md` (added in step-7).
- **Multi-type edges**: the `CHECK (type = 'references-source')` constraint is intentionally restrictive. Lifting it = a forward migration that drops + recreates the constraint with the v2 enum.

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
*(Low-level: runnable commands. Tests, lint, type-check, build.)*

- [ ] Tests pass: `bun test src/tests/memory-edges.test.ts`.
- [ ] All other memory tests still pass: `bun test src/tests/memory-reranker.test.ts src/tests/memory-store.test.ts src/tests/memory.test.ts src/tests/memory-e2e.test.ts src/tests/memory-rater-store.test.ts src/tests/memory-rater-implicit-citation.test.ts src/tests/memory-rate-endpoint.test.ts src/tests/memory-rater-llm.test.ts src/tests/memory-rate-tool.test.ts`.
- [ ] Linting passes: `bun run lint:fix`.
- [ ] Typecheck passes: `bun run tsc:check`.
- [ ] DB-boundary check passes: `bash scripts/check-db-boundary.sh`.
- [ ] Fresh-DB cold start applies migration 050: `rm agent-swarm-db.sqlite && bun run start:http` exits cleanly. Verify via sqlite shell:
  - `PRAGMA table_info(agent_memory_edge);` includes `from_id`, `to_id`, `type`, `alpha`, `beta`, `createdAt`.
  - `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_memedge%';` returns three rows.
  - `INSERT INTO agent_memory_edge (from_id, to_id, type, alpha, beta, createdAt) VALUES ('m1', 'foo', 'supersedes', 1, 1, datetime('now'));` raises `SQLITE_CONSTRAINT` (CHECK fails).
- [ ] OpenAPI is fresh: `bun run docs:openapi` produces no diff after the commit.
- [ ] `openapi.json` includes `GET /api/memory/edges` and the new `referencesSource` field on `POST /api/memory/rate`.

#### Automated QA:
*(Agent-driven proof of work: same job a human QA would do, but the agent does it.)*

- [ ] Agent runs `MEMORY_RATERS=explicit-self bun run pm2-start`, then via `curl` + MCP:
  1. Creates a task that retrieves a memory.
  2. Calls `memory_rate({id, useful: true, referencesSource: "github:desplega-ai/agent-swarm#377"})` from within the task.
  3. Verifies via sqlite shell that `agent_memory_edge` has one row with the expected `(from_id, to_id, type, alpha, beta)`.
  4. `GET /api/memory/edges?memoryId=<id>` returns that row with `usefulness` ≈ 1.0.
  5. Repeats step 2 with the same `referencesSource` → same edge row updated (alpha/beta moved further), no duplicate.
  6. Repeats step 2 with a different `referencesSource` (e.g., `linear:DES-294`) → second edge row appears.

#### Manual Verification:
*(Only what truly needs a human — visual judgment, real-device perf, things the agent genuinely cannot reach.)*

- [ ] Eyeball one mocked LlmRater response that includes a `referencesSource` to confirm the LLM prompt addition produces sensible PR/issue references (not hallucinated IDs).

**Implementation Note**: This is the v1.5 wedge step. After completion, pause for manual confirmation. step-7 (docs + capstone e2e) is the only remaining downstream step.
