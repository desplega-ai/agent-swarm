---
date: 2026-03-21
topic: Memory TTL and Staleness Management — Implementation Plan
author: swarm-researcher
status: plan
issue: "#212"
pr: "#216"
---

# Memory TTL and Staleness Management — Implementation Plan

Based on the [research document](../../thoughts/swarm-researcher/research/2026-03-21-memory-ttl-staleness.md) and [Issue #212](https://github.com/desplega-ai/agent-swarm/issues/212).

## Overview

This plan implements five proposals across four phases, progressively enhancing the memory system with access tracking, reranking, TTL, cleanup tools, and staleness detection.

**Key principle**: each phase is independently shippable and provides value on its own. No phase depends on a later phase.

---

## Phase 1: Schema Migration + Access Tracking

**Goal**: Add all new columns in a single migration. Start collecting access data.
**Effort**: Small (~2-3 hours)
**Files changed**: 3 new, 2 modified

### 1.1 Database Migration

Create `src/be/migrations/014_memory_ttl_staleness.sql`:

```sql
-- New columns for memory TTL, access tracking, and staleness
ALTER TABLE agent_memory ADD COLUMN accessCount INTEGER DEFAULT 0;
ALTER TABLE agent_memory ADD COLUMN expiresAt TEXT;
ALTER TABLE agent_memory ADD COLUMN contentHash TEXT;
ALTER TABLE agent_memory ADD COLUMN stale INTEGER DEFAULT 0;

-- Partial index: only index rows that have an expiry set (file_index has no TTL)
CREATE INDEX IF NOT EXISTS idx_agent_memory_expires
  ON agent_memory(expiresAt) WHERE expiresAt IS NOT NULL;

-- Partial index: only index stale rows (expected to be rare)
CREATE INDEX IF NOT EXISTS idx_agent_memory_stale
  ON agent_memory(stale) WHERE stale = 1;
```

**Why a single migration for all columns**: SQLite `ALTER TABLE ADD COLUMN` is O(1) — it only modifies the schema table, not existing rows. Adding all four columns now avoids multiple migration files and ensures Phase 2-4 don't need their own schema changes.

**Existing data**: All existing rows get `accessCount=0`, `expiresAt=NULL` (never expire), `contentHash=NULL`, `stale=0`. This is the safest default — no existing memories are affected.

### 1.2 Access Tracking in `searchMemoriesByVector()`

**File**: `src/be/db.ts` (line ~5425, after the `results.sort()` and `slice`)

After computing and returning top-N results, batch-update `accessedAt` and increment `accessCount`:

```typescript
// After: return results.slice(0, limit);
// Add before the return:
const topResults = results.slice(0, limit);

if (topResults.length > 0) {
  const ids = topResults.map((m) => m.id);
  const now = new Date().toISOString();
  const placeholders = ids.map(() => "?").join(",");
  getDb()
    .prepare(
      `UPDATE agent_memory SET accessedAt = ?, accessCount = accessCount + 1 WHERE id IN (${placeholders})`,
    )
    .run(now, ...ids);
}

return topResults;
```

**Performance note**: This is a single UPDATE touching N rows (typically 5-10). SQLite handles this in <1ms even with thousands of memories. The partial indexes won't be affected since `accessCount` and `accessedAt` aren't indexed.

### 1.3 Update `AgentMemory` Type

**File**: `src/types.ts` (or wherever `AgentMemory` is defined)

Add optional fields to the type:

```typescript
accessCount?: number;
expiresAt?: string | null;
contentHash?: string | null;
stale?: boolean;
```

Also update `AgentMemoryRow` and `rowToAgentMemory()` in `src/be/db.ts` to map the new columns.

### Phase 1 Checklist

- [ ] Create migration `014_memory_ttl_staleness.sql`
- [ ] Update `AgentMemoryRow` type with new columns
- [ ] Update `rowToAgentMemory()` to map new columns
- [ ] Add batch `accessedAt`/`accessCount` update to `searchMemoriesByVector()`
- [ ] Test: fresh DB creates columns correctly
- [ ] Test: existing DB migration adds columns without data loss
- [ ] Test: search updates `accessCount` after returning results

---

## Phase 2: Reranking

**Goal**: Replace pure cosine similarity ranking with a weighted multi-signal score.
**Effort**: Medium (~3-4 hours)
**Files changed**: 2 modified, 1 new (config)
**Depends on**: Phase 1 (needs `accessCount` column)

### 2.1 Reranking Logic in `searchMemoriesByVector()`

**File**: `src/be/db.ts` (replace the sort + slice block at line ~5425)

```typescript
// --- Reranking pass ---
const HALF_LIFE_HOURS = 168; // 1 week
const MAX_EXPECTED_ACCESS = 50;
const WEIGHTS = { similarity: 0.50, recency: 0.20, access: 0.15, source: 0.15 };
const SOURCE_WEIGHTS: Record<string, number> = {
  manual: 1.0,
  file_index: 0.8,
  task_completion: 0.6,
  session_summary: 0.4,
};

// 1. Take top 2*limit candidates by cosine similarity
const candidateLimit = limit * 2;
const candidates = results
  .sort((a, b) => b.similarity - a.similarity)
  .slice(0, candidateLimit);

// 2. Compute composite score for each candidate
const reranked = candidates.map((m) => {
  const ageHours = (Date.now() - new Date(m.createdAt).getTime()) / 3600000;
  const recencyScore = Math.exp((-Math.LN2 / HALF_LIFE_HOURS) * ageHours);
  const accessBoost =
    Math.log(1 + (m.accessCount ?? 0)) / Math.log(1 + MAX_EXPECTED_ACCESS);
  const srcWeight = SOURCE_WEIGHTS[m.source] ?? 0.5;

  const finalScore =
    WEIGHTS.similarity * m.similarity +
    WEIGHTS.recency * recencyScore +
    WEIGHTS.access * accessBoost +
    WEIGHTS.source * srcWeight;

  return { ...m, finalScore, recencyScore, accessBoost };
});

// 3. Sort by composite score, return top N
reranked.sort((a, b) => b.finalScore - a.finalScore);
const topResults = reranked.slice(0, limit);
```

### 2.2 Return `finalScore` in Results

Update the return type to include `finalScore` alongside `similarity`:

```typescript
export function searchMemoriesByVector(
  queryEmbedding: Float32Array,
  agentId: string,
  options: SearchMemoriesOptions = {},
): (AgentMemory & { similarity: number; finalScore?: number })[] {
```

This is backward-compatible — `finalScore` is optional. The MCP tool (`memory-search.ts`) should include it in the response for transparency.

### 2.3 Configurable Weights (Optional Enhancement)

Store default weights in swarm config (`set-config` tool) so they can be tuned without code changes:

- Config key: `memory.reranking.weights`
- Config key: `memory.reranking.halfLifeHours`
- Config key: `memory.reranking.maxExpectedAccess`

**Implementation**: In `searchMemoriesByVector()`, try to load from config first, fall back to hardcoded defaults. Use `getConfig()` with caching to avoid per-query DB reads.

### Phase 2 Checklist

- [ ] Implement reranking logic in `searchMemoriesByVector()`
- [ ] Add `finalScore` to return type
- [ ] Update `memory-search.ts` MCP tool to include `finalScore` in response
- [ ] Optional: add configurable weights via swarm config
- [ ] Test: reranking promotes recent high-access memories over older ones
- [ ] Test: pure cosine order is preserved when all recency/access signals are equal
- [ ] Test: weights sum to 1.0 and final score is in 0-1 range

---

## Phase 3: TTL with Soft Expiry + Agent Cleanup

**Goal**: Memories expire based on source type. Agents can delete their own memories.
**Effort**: Medium (~4-5 hours)
**Files changed**: 3-4 modified, 1 new tool
**Depends on**: Phase 1 (needs `expiresAt` column)

### 3.1 TTL on Memory Creation

**File**: `src/be/db.ts`, in `createMemory()` (line ~5293)

```typescript
const DEFAULT_TTL_HOURS: Record<string, number | null> = {
  session_summary: 168,    // 7 days
  task_completion: 336,    // 14 days
  manual: 1440,            // 60 days
  file_index: null,        // no TTL — tied to files
};

// In createMemory(), compute expiresAt:
const ttlHours = data.ttlHours ?? DEFAULT_TTL_HOURS[data.source] ?? null;
const expiresAt = ttlHours != null
  ? new Date(Date.now() + ttlHours * 3600000).toISOString()
  : null;
```

Update the `INSERT` statement to include `expiresAt` in the column list and bind the computed value.

Add `ttlHours?: number | null` to `CreateMemoryOptions` type so callers can override the default.

### 3.2 Soft Expiry Filter in Search

**File**: `src/be/db.ts`, in `searchMemoriesByVector()` (line ~5375, in the WHERE clause builder)

Add two new conditions to the `conditions` array:

```typescript
conditions.push("(expiresAt IS NULL OR expiresAt > datetime('now'))");
conditions.push("stale = 0");
```

These filter out expired and stale memories **at the SQL level**, reducing the number of rows loaded for cosine computation. This is a performance improvement.

### 3.3 Hard Expiry Cleanup

**File**: `src/be/db.ts`, add a new function and call it from `initDb()`:

```typescript
export function cleanupExpiredMemories(): number {
  const result = getDb()
    .prepare(
      `DELETE FROM agent_memory
       WHERE expiresAt IS NOT NULL
       AND datetime(expiresAt, '+30 days') < datetime('now')`,
    )
    .run();
  return result.changes;
}
```

Call from `initDb()` after migrations:

```typescript
const cleaned = cleanupExpiredMemories();
if (cleaned > 0) {
  console.log(`[memory] Cleaned up ${cleaned} hard-expired memories`);
}
```

This runs once per API startup. Memories are kept for 30 days past their soft expiry before permanent deletion.

### 3.4 `memory-delete` MCP Tool

**File**: `src/tools/memory-delete.ts` (new)

```typescript
// Tool definition
{
  name: "memory-delete",
  description: "Delete a memory you own. Lead agents can delete any memory.",
  inputSchema: {
    type: "object",
    properties: {
      memoryId: { type: "string", format: "uuid", description: "ID of memory to delete" },
    },
    required: ["memoryId"],
  },
}

// Handler logic:
// 1. Fetch memory by ID
// 2. Verify ownership: memory.agentId === callingAgentId, OR callingAgent.isLead
// 3. DELETE FROM agent_memory WHERE id = ?
// 4. Return success/failure
```

**File**: `src/be/db.ts` — add `deleteMemoryById(id: string): boolean` function.

**File**: `src/http.ts` or tool registration — register the new tool.

### 3.5 Update `listMemoriesByAgent()` for Expired Visibility

`listMemoriesByAgent()` (line ~5436) should **still show** soft-expired memories (they're just excluded from search). Add an `includeExpired` option (default: true for list, false for search) so agents can browse their expired memories.

### Phase 3 Checklist

- [ ] Add TTL computation to `createMemory()`
- [ ] Add `ttlHours` to `CreateMemoryOptions`
- [ ] Add soft-expiry + stale filters to `searchMemoriesByVector()` WHERE clause
- [ ] Add `cleanupExpiredMemories()` function
- [ ] Call cleanup from `initDb()`
- [ ] Create `memory-delete` MCP tool
- [ ] Add `deleteMemoryById()` to `src/be/db.ts`
- [ ] Register tool in tool list
- [ ] Test: new memories get correct `expiresAt` based on source
- [ ] Test: expired memories excluded from search but visible in list
- [ ] Test: hard cleanup deletes memories 30d past expiry
- [ ] Test: `memory-delete` enforces ownership
- [ ] Test: lead can delete any memory

---

## Phase 4: Stale `file_index` Detection

**Goal**: Agents can mark memories as stale. Stale memories are deprioritized.
**Effort**: Small-Medium (~2-3 hours)
**Files changed**: 1 new tool, 1-2 modified
**Depends on**: Phase 1 (needs `stale` column), Phase 2 (stale filter in search)

### 4.1 `memory-mark-stale` MCP Tool

**File**: `src/tools/memory-mark-stale.ts` (new)

```typescript
{
  name: "memory-mark-stale",
  description: "Mark a memory as stale (e.g., when the referenced file no longer exists). Stale memories are excluded from search results.",
  inputSchema: {
    type: "object",
    properties: {
      memoryId: { type: "string", format: "uuid", description: "ID of memory to mark stale" },
      reason: { type: "string", description: "Why this memory is stale (e.g., 'file deleted', 'outdated info')" },
    },
    required: ["memoryId"],
  },
}
```

**File**: `src/be/db.ts` — add `markMemoryStale(id: string): boolean`:

```typescript
export function markMemoryStale(id: string): boolean {
  const result = getDb()
    .prepare("UPDATE agent_memory SET stale = 1 WHERE id = ?")
    .run(id);
  return result.changes > 0;
}
```

### 4.2 Content Hash on File Indexing (Optional)

**File**: `src/be/db.ts`, in `createMemory()` — when `source === 'file_index'`, compute and store `contentHash`:

```typescript
import { createHash } from "crypto";

const contentHash =
  data.source === "file_index"
    ? createHash("sha256").update(data.content).digest("hex")
    : null;
```

This enables future detection of content drift — when re-indexing, compare the new content hash against the stored one to determine if the file actually changed.

### 4.3 Agent Prompt Update

Update the base agent prompt (in `src/prompts/`) to instruct agents to mark memories as stale when they encounter a `file_index` memory referencing a file that no longer exists:

```
If you retrieve a memory that references a file (source: file_index) and discover
the file no longer exists or has substantially changed, use `memory-mark-stale`
to flag it.
```

### Phase 4 Checklist

- [ ] Create `memory-mark-stale` MCP tool
- [ ] Add `markMemoryStale()` to `src/be/db.ts`
- [ ] Register tool in tool list
- [ ] Optional: add `contentHash` computation in `createMemory()` for `file_index` source
- [ ] Update agent prompt to instruct stale marking behavior
- [ ] Test: stale memories excluded from search
- [ ] Test: stale marking requires valid memory ID
- [ ] Test: stale memories still visible via `memory-get`

---

## Migration Strategy

### Backward Compatibility

| Concern | Approach |
|---|---|
| Existing memories have no `expiresAt` | Leave as `NULL` — they never expire. Only new memories get TTL. |
| Existing memories have `accessCount = 0` | Correct default. Reranking will treat them neutrally (log(1+0)/log(51) = 0). |
| Old API clients don't send `ttlHours` | Default TTL applies automatically based on source type. |
| `finalScore` field in search results | Optional field — old clients can ignore it. |
| New columns on old DB | Migration runner handles this automatically on startup. |

### Rollback Plan

Each phase can be independently reverted:

- **Phase 1**: Drop columns via a new migration (or revert the migration file before it's applied in production)
- **Phase 2**: Remove reranking code; search reverts to pure cosine
- **Phase 3**: Remove expiry filter from WHERE clause; all memories become searchable again
- **Phase 4**: Remove stale filter; all memories become searchable

Since we use soft expiry (not hard delete) and the cleanup only runs 30 days after expiry, there's a large safety window for rollbacks.

### Data Impact Estimates

Based on typical agent-swarm deployments:

| Metric | Expected Impact |
|---|---|
| Migration time | <1 second (ALTER TABLE ADD COLUMN is O(1) in SQLite) |
| Storage overhead | ~20 bytes per row (4 new columns, mostly NULL) |
| Search latency | Negligible increase from reranking (~0.1ms for 20 candidates) |
| Search latency decrease | Meaningful if many expired memories are filtered at SQL level |
| Memory growth reduction | ~40-60% after TTL stabilizes (session_summary/task_completion churn) |

---

## Open Design Decisions

These should be resolved before or during implementation:

1. **TTL extension on access**: Should accessing a memory via search reset/extend its TTL?
   - **Recommendation**: Yes, implement TTL extension on access in Phase 3. Without this, memories could expire during idle periods — e.g., if no new `session_summary` memories are created for a week, all existing ones would disappear. TTL extension on access ensures that actively-used memories survive while truly unused ones still expire. To prevent immortal memories, cap renewals (e.g., max 3 extensions) or use diminishing extensions (each renewal adds half the original TTL).

2. **Per-agent vs global reranking weights**: Start global. If agents have very different memory usage patterns, add per-agent weight overrides via agent config.

3. **Memory count cap**: Not included in this plan. Consider as a follow-up if TTL alone doesn't control growth sufficiently. A simple `MAX_MEMORIES_PER_AGENT` config with LRU eviction would be straightforward.

4. **BM25 hybrid search**: Orthogonal to this plan. FTS5 integration would improve recall but is a separate effort. The reranking infrastructure built here would naturally accommodate an additional BM25 signal.

---

## Implementation Order & Dependencies

```
Phase 1 (Schema + Access Tracking)
  ├── Phase 2 (Reranking) — needs accessCount from Phase 1
  ├── Phase 3 (TTL + Cleanup) — needs expiresAt from Phase 1
  │     └── can start in parallel with Phase 2
  └── Phase 4 (Staleness) — needs stale column from Phase 1
        └── can start after Phase 2 (stale filter in search)
```

**Recommended implementation sequence**: Phase 1 → Phase 2 → Phase 3 → Phase 4

Phases 2 and 3 are independent and could be parallelized across two PRs after Phase 1 merges.

---

## Testing Strategy

### Unit Tests

Each phase should have unit tests in `src/tests/`:

- **Phase 1**: `memory-access-tracking.test.ts` — verify accessCount increments, accessedAt updates
- **Phase 2**: `memory-reranking.test.ts` — verify score computation, weight normalization, ordering
- **Phase 3**: `memory-ttl.test.ts` — verify TTL defaults, soft expiry filter, hard cleanup, memory-delete ownership
- **Phase 4**: `memory-staleness.test.ts` — verify stale marking, stale filter in search

### Integration Testing

Use the existing test pattern (isolated SQLite DB per test file):

```typescript
beforeAll(() => { initDb("./test-memory-ttl.sqlite"); });
afterAll(() => {
  closeDb();
  for (const ext of ["", "-wal", "-shm"]) {
    try { unlinkSync(`./test-memory-ttl.sqlite${ext}`); } catch {}
  }
});
```

### E2E Validation

After deploying each phase, verify in production:

- Phase 1: Check `accessCount` values are accumulating via `GET /api/memory/:id`
- Phase 2: Compare `similarity` vs `finalScore` in search results — finalScore should differ
- Phase 3: Create a test memory, wait for TTL, verify it's excluded from search
- Phase 4: Mark a memory stale, verify it's excluded from search

---

## Estimated Total Effort

| Phase | Effort | Can Parallelize |
|---|---|---|
| Phase 1: Schema + Access Tracking | 2-3 hours | — |
| Phase 2: Reranking | 3-4 hours | After Phase 1 |
| Phase 3: TTL + Cleanup | 4-5 hours | After Phase 1, parallel with Phase 2 |
| Phase 4: Staleness | 2-3 hours | After Phase 2 |
| **Total** | **11-15 hours** | |

Each phase should be its own PR for reviewability. Phase 1 is the critical path — everything else builds on it.
