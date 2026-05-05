---
id: step-1
name: Schema + MemoryRater spine + reranker `usefulness` factor
depends_on: []
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-1: Schema + MemoryRater spine + reranker `usefulness` factor

## Overview

Ship the inert framework: the brainstorm-spine migration (`agent_memory.alpha/beta` columns, `memory_retrieval` table, `memory_rating` audit table with the partial unique index for `explicit-self`), the `MemoryRater` interface + `NoopRater` default, the server-side `applyRating(events)` helper that owns all `(alpha, beta)` updates, and the reranker `usefulness` factor. With `MEMORY_RATERS` unset (default), the system behaves byte-for-byte identically to today — `Beta(1,1) → usefulness = 1.0` exactly.

This is the only true serial bottleneck in the DAG; everything downstream gates on it.

## Changes Required:

#### 1. New migration: `049_memory_posteriors_and_retrieval.sql`

**File**: `src/be/migrations/049_memory_posteriors_and_retrieval.sql`

**Changes**:

- `ALTER TABLE agent_memory ADD COLUMN alpha REAL NOT NULL DEFAULT 1.0;`
- `ALTER TABLE agent_memory ADD COLUMN beta  REAL NOT NULL DEFAULT 1.0;`
- Create `memory_retrieval`:
  ```sql
  CREATE TABLE IF NOT EXISTS memory_retrieval (
    id          TEXT PRIMARY KEY,
    taskId      TEXT,
    agentId     TEXT NOT NULL,
    sessionId   TEXT,
    memoryId    TEXT NOT NULL,
    similarity  REAL,
    retrievedAt TEXT NOT NULL,
    FOREIGN KEY (taskId) REFERENCES agent_tasks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_memret_task   ON memory_retrieval(taskId);
  CREATE INDEX IF NOT EXISTS idx_memret_agent  ON memory_retrieval(agentId);
  CREATE INDEX IF NOT EXISTS idx_memret_memory ON memory_retrieval(memoryId);
  ```
- Create `memory_rating` (audit table — separate from hot-path `(alpha, beta)`):
  ```sql
  CREATE TABLE IF NOT EXISTS memory_rating (
    id        TEXT PRIMARY KEY,
    memoryId  TEXT NOT NULL,
    taskId    TEXT,
    source    TEXT NOT NULL,         -- = rater.name
    signal    REAL NOT NULL,         -- -1..+1
    weight    REAL NOT NULL,         -- 0..1
    reasoning TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (taskId) REFERENCES agent_tasks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_memrat_memory ON memory_rating(memoryId);
  CREATE INDEX IF NOT EXISTS idx_memrat_task   ON memory_rating(taskId);
  -- DB-owned spam guard (R6): one explicit-self per (taskId, memoryId)
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_rating_explicit_unique
  ON memory_rating(taskId, memoryId)
  WHERE source = 'explicit-self';
  ```

> **Deviation A from brainstorm**: brainstorm references `tasks(id)` as the FK target. The actual table is `agent_tasks` (`src/be/migrations/001_initial.sql:195`). Migration uses the correct name. No semantic change — the cascade behaviour is what the brainstorm specified.

> Test against fresh DB AND existing DB per `CLAUDE.md` migration rule.

#### 2. `MemoryRater` interface + `RatingEvent` type + `NoopRater`

**File**: `src/be/memory/raters/types.ts` (new)

**Changes**: Define:
```ts
export interface MemoryRater {
  readonly name: string;
  rate(ctx: RatingContext): Promise<RatingEvent[]>;
}
export type RatingEvent = {
  memoryId: string;
  signal: number;     // -1..+1
  weight: number;     // 0..1
  source: string;     // framework-set; raters MUST NOT populate (see store.ts)
  reasoning?: string; // optional, used by LlmRater + ExplicitSelfRater
};
export type RatingContext = {
  taskId?: string;
  agentId: string;
  sessionId?: string;
  retrievedMemoryIds: string[];
  // server-side raters get session_logs content via the framework;
  // worker-side raters get the LLM summary text or explicit user input.
  evidence: string | null;
};
```

**File**: `src/be/memory/raters/noop.ts` (new)

**Changes**: `class NoopRater implements MemoryRater` with `name = "noop"` and `rate() → []`. No side effects, no DB calls.

#### 3. `applyRating(events)` helper — single chokepoint for posterior updates

**File**: `src/be/memory/raters/store.ts` (new)

**Changes**:

- Pure server-side function (imports from `src/be/db.ts` are allowed here — this file lives under `src/be/`).
- Signature: `applyRating(events: RatingEvent[], ctx: { taskId?: string }): { applied: number; rejected: { event: RatingEvent; reason: string }[] }`.
- For each event:
  - `UPDATE agent_memory SET alpha = alpha + ?, beta = beta + ? WHERE id = ?` with `alphaDelta = max(0, signal) * weight`, `betaDelta = max(0, -signal) * weight`.
  - `INSERT INTO memory_rating (id, memoryId, taskId, source, signal, weight, reasoning, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`.
  - Wrap the whole batch in one transaction (atomic via SQLite WAL).
- Reject (return in `rejected[]`, do not throw) when:
  - `signal` outside `[-1, +1]` or `weight` outside `[0, 1]`.
  - `memoryId` does not exist in `agent_memory`.
  - `source` is missing/empty (framework guarantees this — defence-in-depth).
- Idempotency: not enforced (Beta updates are commutative; duplicates just shift the posterior). The R6 spam guard for `source='explicit-self'` is enforced at the partial unique index level — duplicate `INSERT` raises `SQLITE_CONSTRAINT`, caught and surfaced as a typed error so the HTTP layer can return 409.

#### 4. Rater registry + `MEMORY_RATERS` env parsing

**File**: `src/be/memory/raters/registry.ts` (new)

**Changes**:

- `getRegisteredRaters(): MemoryRater[]` reads `process.env.MEMORY_RATERS`, splits on `,`, trims, filters empty. For each name, look up the rater impl in a `name → factory` map. Unset/empty → `[NoopRater]`.
- The map starts with `noop` only in step-1; step-2 wires in `implicit-citation`, step-4 wires in `llm`, step-5 wires in `explicit-self`. Each step touches only its line in this file.
- Optional weight overrides: `MEMORY_RATER_WEIGHTS=implicit-citation:0.5,llm:0.8` parsed into a `name → weightMultiplier` map. The framework multiplies the rater's emitted `RatingEvent.weight` by this multiplier before calling `applyRating`. Default multiplier = 1.0.

#### 5. Reranker `usefulness` factor

**File**: `src/be/memory/reranker.ts`

**Changes**: Add a new helper and use it in `computeScore`:

```ts
/**
 * Beta-Binomial usefulness factor for reranking.
 * At Beta(1,1) (default prior) returns 1.0 exactly — strict no-op vs.
 * pre-rater behaviour. Proven memories climb up to 2.0. Floored at the
 * value of MEMORY_DEMOTION_FLOOR (default 1.0 = no demotion) — the
 * default preserves brainstorm intent (memories are demoted but not
 * deleted at floor 1.0) and is configurable per deployment.
 */
const DEMOTION_FLOOR = (() => {
  const raw = process.env.MEMORY_DEMOTION_FLOOR;
  const n = raw == null || raw === "" ? 1.0 : Number(raw);
  return Number.isFinite(n) ? n : 1.0;
})();

export function usefulness(alpha: number, beta: number): number {
  const mean = alpha / (alpha + beta);
  return Math.max(DEMOTION_FLOOR, Math.min(2.0, 2 * mean));
}
```

Update `computeScore` to multiply `usefulness(candidate.alpha, candidate.beta)`. Read `alpha` and `beta` from the candidate (extend `MemoryCandidate` in `src/be/memory/types.ts` to carry them, default `1.0` each).

> **Q1 resolved (env-configurable demotion floor)**: `MEMORY_DEMOTION_FLOOR` env var (default `1.0`). Default preserves brainstorm intent — memories are demoted toward the floor but never deleted on the reranker path. Lower the floor (e.g. `0.5`) per deployment when telemetry shows reliable negative signal. Document in `runbooks/memory-system.md` (step-7) and `.env.example`.

#### 6. Plumb `alpha`/`beta` through `MemoryStore.search()`

**File**: `src/be/memory/providers/sqlite-store.ts`

**Changes**:

- Extend the `searchWithVec` SELECT (around `sqlite-store.ts:240-306`) and the brute-force fallback (around `sqlite-store.ts:308-353`) to read `alpha`, `beta` from `agent_memory` into each `MemoryCandidate`.
- No new query path; just additional columns.

**File**: `src/be/memory/types.ts`

**Changes**:

- Add `alpha: number; beta: number;` to `MemoryCandidate`. (Defaults written by the migration mean every existing row reads as `1.0, 1.0`.)

#### 7. Backward-compat snapshot test

**File**: `src/tests/memory-reranker.test.ts`

**Changes**:

- Add a snapshot/golden test: build N synthetic memories with default `alpha=1, beta=1`, run `rerank` against a known query, assert the produced order + scores match a pre-change baseline (capture the baseline from `main` before the reranker change, hard-code as expected values).
- Add unit tests for `usefulness(α, β)`:
  - `usefulness(1, 1) === 1.0` exactly (default floor).
  - `usefulness(10, 1) === clamp(2 * 10/11, 1, 2)` ≈ `1.818`.
  - `usefulness(1, 10) === 1.0` (floored at default `MEMORY_DEMOTION_FLOOR=1.0` — never demoted).
  - `usefulness(50, 1) === 2.0` (ceiling clamp).
  - With `MEMORY_DEMOTION_FLOOR=0.5` set (env-overridden in the test), `usefulness(1, 10) === 0.5` (floor lowers, demotion is now possible).

#### 8. Unit tests for `applyRating`

**File**: `src/tests/memory-rater-store.test.ts` (new)

**Changes**:

- Single event with `signal=+1, weight=1` → `alpha += 1`, `beta += 0`. Memory row updated, audit row inserted.
- Single event with `signal=-1, weight=0.5` → `alpha += 0`, `beta += 0.5`.
- Batch of events → all applied in one transaction (assert via temp DB rollback on a forced error mid-batch).
- Concurrency: spawn N parallel `applyRating` calls against the same `memoryId` from `Promise.all`, assert final `(alpha, beta)` equals the sum of inputs (commutativity invariant).
- Out-of-range `signal=2` or `weight=-1` → returned in `rejected[]`, no DB write.
- Missing `memoryId` → returned in `rejected[]`, no DB write.

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
*(Low-level: runnable commands. Tests, lint, type-check, build.)*

- [ ] Tests pass: `bun test src/tests/memory-rater-store.test.ts`.
- [ ] Tests pass: `bun test src/tests/memory-reranker.test.ts` (including the new `usefulness` cases AND the snapshot for default-prior no-op).
- [ ] Memory test suite still passes: `bun test src/tests/memory-store.test.ts src/tests/memory.test.ts src/tests/memory-e2e.test.ts`.
- [ ] Linting passes: `bun run lint:fix`.
- [ ] Typecheck passes: `bun run tsc:check`.
- [ ] DB-boundary check passes: `bash scripts/check-db-boundary.sh` (the new files all live under `src/be/` so this should be a no-op).
- [ ] Fresh-DB cold start: `rm agent-swarm-db.sqlite && bun run start:http` exits cleanly with migration 049 applied. Verify via sqlite shell:
  - `PRAGMA table_info(agent_memory);` includes `alpha REAL NOT NULL DEFAULT 1` and `beta REAL NOT NULL DEFAULT 1`.
  - `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memory_retrieval','memory_rating');` returns both rows.
  - `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_rating_explicit_unique';` returns one row.
- [ ] Existing-DB migration: against an existing dev DB with prior memories, run the migration and verify all existing rows read `alpha=1, beta=1`.

#### Automated QA:
*(Agent-driven proof of work: same job a human QA would do, but the agent does it.)*

- [ ] Agent runs the API server with no `MEMORY_RATERS` env set, hits `POST /api/memory/index` to insert a synthetic memory, then `POST /api/memory/search` and confirms the returned similarity scores are unchanged from a pre-change snapshot of the same DB+query (proves NoopRater default is strictly behaviour-preserving).
- [ ] Agent inserts `alpha=10, beta=1` directly via sqlite shell on a known memory, repeats the search, and confirms the score for that memory is multiplied by `usefulness(10,1) ≈ 1.818` (and that other memories' scores are unchanged).

#### Manual Verification:
*(Only what truly needs a human — visual judgment, real-device perf, things the agent genuinely cannot reach.)*

- [ ] Eyeball the migration `049_memory_posteriors_and_retrieval.sql` once for `IF NOT EXISTS` correctness and FK target.

**Implementation Note**: This step is the spine of the whole plan — every downstream step gates on it. After completion, pause for manual confirmation. No commit-per-step: this branch ships as one PR per Lead's call.
