---
date: 2026-03-21
topic: Memory TTL and Staleness Management
author: swarm-researcher
status: research
issue: "#212"
---

# Memory TTL and Staleness Management

Research for [GitHub Issue #212](https://github.com/desplega-ai/agent-swarm/issues/212) — improving agent memory with TTL, access tracking, reranking, and stale detection.

## Table of Contents

1. [Current System Analysis](#1-current-system-analysis)
2. [Industry Landscape](#2-industry-landscape)
3. [Proposal Analysis](#3-proposal-analysis)
4. [Recommended Implementation](#4-recommended-implementation)
5. [Migration Plan](#5-migration-plan)
6. [Open Questions](#6-open-questions)

---

## 1. Current System Analysis

### Schema (`agent_memory` table)

The memory table is defined in `src/be/migrations/001_initial.sql:271-287`:

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | UUID primary key |
| `agentId` | TEXT | Nullable, owner agent |
| `scope` | TEXT | `'agent'` or `'swarm'` |
| `name` | TEXT | Short identifier |
| `content` | TEXT | Full memory content |
| `summary` | TEXT | Nullable, unused in search |
| `embedding` | BLOB | 512-dim float32 vector (OpenAI text-embedding-3-small) |
| `source` | TEXT | `'manual'`, `'file_index'`, `'session_summary'`, `'task_completion'` |
| `sourceTaskId` | TEXT | Nullable, links to originating task |
| `sourcePath` | TEXT | Nullable, file path for file_index memories |
| `chunkIndex` | INTEGER | Default 0, for multi-chunk content |
| `totalChunks` | INTEGER | Default 1 |
| `tags` | TEXT | JSON array, default `'[]'` |
| `createdAt` | TEXT | ISO timestamp |
| `accessedAt` | TEXT | ISO timestamp, **exists but underused** |

**Indexes:** `agentId`, `scope`, `source`, `createdAt`, `sourcePath`

### Search Implementation (`src/be/db.ts`)

**`searchMemoriesByVector()` (line ~5367):**
1. Builds WHERE clause based on scope, source, agent visibility
2. Fetches **all matching rows** with embeddings into memory
3. Computes cosine similarity in-app via `cosineSimilarity()` (dot-product / norms)
4. Sorts descending, returns top N

This is pure semantic similarity — no recency, no access frequency, no source weighting.

**`getMemoryById()` (line ~5342):**
- Fetches single memory and **updates `accessedAt`** as a side effect
- This is the only place `accessedAt` is written post-creation

**`listMemoriesByAgent()` (line ~5436):**
- Fallback when embeddings are unavailable
- Orders by `createdAt DESC` with pagination

### Memory Creation Paths

| Path | Source Type | Scope |
|---|---|---|
| Task completion (`store-progress.ts:211-266`) | `task_completion` | `agent` (+ `swarm` for research/shared tasks) |
| File write to memory dir (hook, `hook.ts:927-961`) | `file_index` | `agent` or `swarm` based on path |
| Lead injection (`inject-learning.ts:72-78`) | `manual` | `swarm` |
| HTTP index endpoint (`/api/memory/index`) | varies | varies |

### Key Gaps

1. **No TTL or expiry** — memories accumulate indefinitely
2. **No reranking** — pure cosine similarity, ignoring recency and usage
3. **`accessedAt` exists but isn't used for ranking** — only updated by `memory-get`, not by search results
4. **No staleness detection** — `file_index` memories persist even if source files change or are deleted
5. **No cleanup tools** — agents can't delete or archive their own memories
6. **Full table scan** — all matching embeddings loaded into memory for cosine computation

---

## 2. Industry Landscape

### Production Agent Memory Systems

#### Mem0 (41K+ GitHub stars)
- LLM-based memory extraction + vector storage with 24+ backend options
- **Conflict detection**: new memories are checked against existing ones; contradictions trigger updates rather than duplicates
- **TTL support**: configurable per-memory expiry
- 66.9% on LOCOMO benchmark
- **Relevance**: closest analog to agent-swarm's approach. Their conflict detection is notable — we could benefit from deduplication.

#### Letta/MemGPT
- **Tiered memory**: core (always in context), buffer (working memory), recall (searchable archive), archival (long-term)
- Agents self-edit memory via tool calls — they can delete, update, or restructure their own memories
- #1 model-agnostic on Terminal-Bench
- **Relevance**: the tiered approach is interesting but heavyweight for our use case. Agent-initiated cleanup (proposal #5) aligns with their philosophy.

#### Zep/Graphiti
- **Temporal knowledge graph** with bi-temporal model (valid time + transaction time)
- No LLM at retrieval time — pre-processed graph queries
- 94.8% DMR benchmark
- **Relevance**: bi-temporal modeling is the gold standard for "what was true when?" but significantly more complex than our SQLite approach. The temporal decay concept is directly applicable.

#### Cognee
- **Memify layer**: prunes stale memories, strengthens frequently accessed ones, derives new facts
- 14 retrieval modes
- **Relevance**: the "strengthen on access" pattern directly maps to our access tracking proposal.

#### Lightweight Systems (closer to our architecture)
- **Engram**: Single Go binary, SQLite + FTS5, zero dependencies. Similar simplicity.
- **Claude-Mem**: Auto-captures observations, categorizes (decision/bugfix/feature/discovery), SQLite + FTS
- **QMD** (Tobi Lutke): Rust CLI, hybrid BM25 + vectors on local markdown. Cuts token usage ~95%.

### Research Consensus on Best Retrieval Architecture

The literature converges on a multi-stage pipeline:

1. **Pre-filter** by metadata (source type, scope, status)
2. **Dual retrieval**: BM25 (keyword) + vector search in parallel
3. **RRF fusion** (Reciprocal Rank Fusion) — 8-15% accuracy improvement over single method
4. **Temporal decay** (exponential with configurable half-life)
5. **Optional**: cross-encoder reranking for final precision

Key papers: Reflexion, Voyager, SICA, A-MEM, CoALA, Generative Agents, Mem^p.

---

## 3. Proposal Analysis

### Proposal 1: Memory Freshness via Access Tracking

**What**: Update `accessedAt` whenever a memory is returned by `memory-search` (not just `memory-get`).

**Current state**: `accessedAt` column exists, only updated by `getMemoryById()`. Search results don't touch it.

**Implementation**:
```sql
-- After search returns top N results, batch-update accessedAt
UPDATE agent_memory SET accessedAt = ? WHERE id IN (?, ?, ...)
```

**Trade-offs**:
| Pro | Con |
|---|---|
| Zero schema change needed | Adds N writes per search call |
| Natural "warmth" signal | Popular memories get artificially boosted (rich-get-richer) |
| `accessedAt` already indexed could be added | Batch UPDATE for top-N is cheap in SQLite |

**Assessment**: Low-risk, high-value. The column already exists. The main concern is the rich-get-richer effect, mitigable by using logarithmic access boosting rather than linear.

**Recommendation**: **Implement.** Update `accessedAt` in `searchMemoriesByVector()` after computing the top-N results. Add an `accessCount` column for frequency tracking.

### Proposal 2: Reranking on Retrieval

**What**: After cosine similarity produces a candidate set, rerank using recency and access signals.

**Formulas investigated**:

#### Exponential Recency Decay
```
recency_score = exp(-ln(2) / half_life_hours * age_hours)
```
With `half_life_hours = 168` (1 week): a 1-week-old memory scores 0.5, a 2-week-old scores 0.25.

#### Access Frequency Boost
```
access_boost = 1 + log(1 + access_count) * access_weight
```
Logarithmic scaling prevents runaway boosting.

#### Combined Score
```
final_score = (w_sim * cosine_sim) + (w_rec * recency_score) + (w_acc * access_boost) + (w_src * source_weight)
```

**Recommended weights** (based on literature and our use case):

| Signal | Weight | Rationale |
|---|---|---|
| `cosine_sim` | 0.50 | Semantic relevance remains primary |
| `recency_score` | 0.20 | Recent memories are more likely current |
| `access_boost` | 0.15 | Frequently useful memories should rank higher |
| `source_weight` | 0.15 | Some sources are inherently more reliable |

**Source type weights**:

| Source | Weight | Rationale |
|---|---|---|
| `manual` (lead injection) | 1.0 | Curated, high-signal |
| `file_index` | 0.8 | Tied to actual code/files |
| `task_completion` | 0.6 | Useful but often noisy |
| `session_summary` | 0.4 | Most ephemeral |

**Implementation approach**:
1. Expand candidate set from top-N to top-2N (e.g., fetch top 20, rerank to return top 10)
2. Compute `recency_score`, `access_boost`, `source_weight` for each candidate
3. Compute `final_score` using weighted combination
4. Re-sort and return top N

**Trade-offs**:
| Pro | Con |
|---|---|
| Dramatically better relevance | Adds computation per search |
| Configurable weights | Weights need tuning per deployment |
| No external dependencies | More complex than pure cosine |

**Assessment**: High-value. The rerank pass operates on a small candidate set (10-20 items) so computational overhead is negligible. This addresses the core complaint in the issue.

**Recommendation**: **Implement.** Start with the weights above, make them configurable via swarm config.

### Proposal 3: Memory TTL with Soft Expiry

**What**: Add `expiresAt` column with default TTLs by source type. Expired memories are excluded from search but still retrievable via `memory-get`.

**Recommended default TTLs**:

| Source | Default TTL | Rationale |
|---|---|---|
| `session_summary` | 3 days | Highly ephemeral, context-specific |
| `task_completion` | 7 days | Task context decays quickly |
| `manual` | 30 days | Curated content, longer relevance |
| `file_index` | No TTL | Tied to files that may still exist |

**Soft vs Hard expiry**:
- **Soft expiry** (default): `expiresAt < now()` → excluded from `searchMemoriesByVector()` but still returned by `memory-get` and `listMemoriesByAgent()`
- **Hard expiry**: `expiresAt + 30d < now()` → deleted by periodic cleanup

**Implementation**:
```sql
-- Migration: add expiresAt column
ALTER TABLE agent_memory ADD COLUMN expiresAt TEXT;
CREATE INDEX idx_agent_memory_expires ON agent_memory(expiresAt) WHERE expiresAt IS NOT NULL;

-- In searchMemoriesByVector(), add to WHERE clause:
AND (expiresAt IS NULL OR expiresAt > datetime('now'))

-- Periodic cleanup (on API startup or scheduled):
DELETE FROM agent_memory
WHERE expiresAt IS NOT NULL
AND datetime(expiresAt, '+30 days') < datetime('now');
```

**SQLite considerations**:
- `ALTER TABLE ... ADD COLUMN` is O(1) in SQLite — only modifies schema, not existing rows
- Partial index on `expiresAt WHERE expiresAt IS NOT NULL` keeps overhead minimal for permanent memories (file_index)
- Cleanup can run on API startup via `initDb()` — no need for a separate scheduler

**Trade-offs**:
| Pro | Con |
|---|---|
| Prevents unbounded memory growth | TTL defaults may discard useful memories |
| Soft expiry preserves content | Adds column and index maintenance |
| Source-based defaults are intuitive | Agents can't override TTL per-memory (without UI) |

**Assessment**: Medium complexity, high value. The biggest risk is discarding useful memories too early. Soft expiry mitigates this — agents can still retrieve expired memories explicitly.

**Recommendation**: **Implement with conservative defaults.** Start with longer TTLs (7d/14d/60d) and tune down based on observed memory growth. Allow TTL override per-memory via an optional parameter in `createMemory()`.

### Proposal 4: Stale `file_index` Detection

**What**: Detect when a `file_index` memory's `sourcePath` no longer exists or has changed.

**Approaches investigated**:

#### A. File existence check on retrieval
```typescript
// In searchMemoriesByVector(), for file_index results:
if (memory.source === 'file_index' && memory.sourcePath) {
  const exists = await Bun.file(memory.sourcePath).exists();
  if (!exists) memory.stale = true;
}
```

**Problem**: Agents run in Docker containers with different filesystems. `sourcePath` is relative to the writing agent's container, not the searching agent's.

#### B. Content hash on indexing
```sql
ALTER TABLE agent_memory ADD COLUMN contentHash TEXT;
```
Store `sha256(content)` on creation. On re-index, compare hashes to detect changes. If the hash differs, replace; if the file is gone, mark stale.

**Problem**: Re-indexing only happens when the file is edited (via hook). If the file is deleted, no hook fires.

#### C. Periodic staleness sweep
Run a background check (on API startup or via scheduled task) that verifies `sourcePath` files still exist. Since the API server has access to the filesystem, this could work — but only for memories created from files on the API server's filesystem.

**Problem**: In distributed deployments, the API server may not have access to agent containers' filesystems.

#### D. Mark-on-miss (lazy invalidation)
When an agent tries to use a `file_index` memory and discovers the referenced file doesn't exist, the agent can report it as stale via a new `memory-mark-stale` tool.

**Assessment**: This is the hardest proposal due to the distributed filesystem challenge. Option D (lazy invalidation) is the most practical.

**Recommendation**: **Implement lazily.** Add a `stale` boolean column (default false). Provide a `memory-mark-stale` tool for agents. Stale memories get lowest reranking weight. Don't attempt filesystem checks from the API server.

### Proposal 5: Agent-Initiated Cleanup

**What**: Let agents delete or archive their own memories.

**Implementation**: Add `memory-delete` MCP tool:
- Input: `memoryId` (UUID)
- Validates the calling agent owns the memory (or memory is swarm-scoped and agent is lead)
- Soft-delete via a `deletedAt` column, or hard-delete

**Assessment**: Simple, low-risk, directly addresses agent autonomy. Letta/MemGPT demonstrates that agent self-management of memory is valuable.

**Recommendation**: **Implement.** Start with hard-delete (simplest). Add `memory-archive` later if needed.

---

## 4. Recommended Implementation

### Priority Order

| Priority | Proposal | Effort | Impact |
|---|---|---|---|
| P0 | #1 Access tracking | Small | Medium |
| P0 | #2 Reranking | Medium | High |
| P1 | #3 TTL with soft expiry | Medium | High |
| P1 | #5 Agent-initiated cleanup | Small | Medium |
| P2 | #4 Stale file_index detection | Medium | Low-Medium |

### Concrete Changes

#### Migration (single SQL file)

```sql
-- Add new columns
ALTER TABLE agent_memory ADD COLUMN accessCount INTEGER DEFAULT 0;
ALTER TABLE agent_memory ADD COLUMN expiresAt TEXT;
ALTER TABLE agent_memory ADD COLUMN contentHash TEXT;
ALTER TABLE agent_memory ADD COLUMN stale INTEGER DEFAULT 0;

-- Indexes
CREATE INDEX idx_agent_memory_expires
  ON agent_memory(expiresAt) WHERE expiresAt IS NOT NULL;
CREATE INDEX idx_agent_memory_stale
  ON agent_memory(stale) WHERE stale = 1;
```

#### `searchMemoriesByVector()` Changes

```typescript
// 1. Add WHERE clause for soft expiry
whereClause += " AND (expiresAt IS NULL OR expiresAt > datetime('now'))";
whereClause += " AND stale = 0";

// 2. Expand candidate set (fetch 2x limit)
const candidateLimit = limit * 2;

// 3. After cosine similarity sort, rerank top candidates:
const reranked = candidates.map(m => {
  const ageHours = (Date.now() - new Date(m.createdAt).getTime()) / 3600000;
  const recencyScore = Math.exp(-Math.LN2 / 168 * ageHours); // 1-week half-life

  const accessBoost = 1 + Math.log(1 + (m.accessCount ?? 0)) * 0.15;

  const sourceWeights = { manual: 1.0, file_index: 0.8, task_completion: 0.6, session_summary: 0.4 };
  const srcWeight = sourceWeights[m.source] ?? 0.5;

  const finalScore = (0.50 * m.similarity) + (0.20 * recencyScore) + (0.15 * accessBoost) + (0.15 * srcWeight);
  return { ...m, finalScore };
});

// 4. Sort by finalScore, take top limit
reranked.sort((a, b) => b.finalScore - a.finalScore);

// 5. Batch-update accessedAt and accessCount for returned results
const ids = reranked.slice(0, limit).map(m => m.id);
db.run(`UPDATE agent_memory SET accessedAt = ?, accessCount = accessCount + 1 WHERE id IN (${ids.map(() => '?').join(',')})`,
  [new Date().toISOString(), ...ids]);
```

#### `createMemory()` Changes

```typescript
// Set expiresAt based on source type defaults
const DEFAULT_TTL_HOURS = {
  session_summary: 72,    // 3 days
  task_completion: 168,   // 7 days
  manual: 720,            // 30 days
  file_index: null,       // no TTL
};

const ttlHours = options.ttlHours ?? DEFAULT_TTL_HOURS[options.source];
const expiresAt = ttlHours
  ? new Date(Date.now() + ttlHours * 3600000).toISOString()
  : null;
```

#### New MCP Tools

| Tool | Purpose |
|---|---|
| `memory-delete` | Agent deletes own memory by ID |
| `memory-mark-stale` | Agent marks a memory as stale |

---

## 5. Migration Plan

### Phase 1: Schema + Access Tracking (P0)

1. Add migration file with new columns (`accessCount`, `expiresAt`, `contentHash`, `stale`)
2. Update `searchMemoriesByVector()` to batch-update `accessedAt` and `accessCount`
3. No behavior change yet — just start collecting data

### Phase 2: Reranking (P0)

1. Implement reranking pass in `searchMemoriesByVector()`
2. Make weights configurable via swarm config (`set-config` tool)
3. Add `finalScore` to search results alongside `similarity` for transparency

### Phase 3: TTL + Cleanup (P1)

1. Update `createMemory()` to set `expiresAt` based on source defaults
2. Add soft-expiry filter to `searchMemoriesByVector()` WHERE clause
3. Add hard-expiry cleanup to `initDb()` (delete memories >30d past expiry)
4. Add `memory-delete` MCP tool

### Phase 4: Staleness (P2)

1. Add `memory-mark-stale` MCP tool
2. Add `stale = 0` filter to search WHERE clause
3. Optionally add `contentHash` computation on `file_index` creation
4. Update agent prompt to instruct agents to mark stale memories when discovered

---

## 6. Open Questions

1. **Weight tuning**: Should reranking weights be per-agent or global? Starting global is simpler, but agents with different roles (researcher vs coder) may benefit from different weights.

2. **TTL extension on access**: Should accessing a memory extend its TTL? This would keep frequently-used memories alive indefinitely, which may or may not be desirable.

3. **Backward compatibility**: Existing memories have no `expiresAt`. Options:
   - Leave them NULL (never expire) — safest
   - Backfill based on `createdAt` + source TTL — risks losing useful old memories
   - **Recommendation**: leave NULL, only new memories get TTL

4. **Embedding refresh**: If a memory's content is updated (e.g., file re-indexed), should the embedding be regenerated? Currently yes (dedup-and-replace in `/api/memory/index`). This should continue.

5. **Memory count limits**: Should there be a per-agent memory cap in addition to TTL? This would provide a hard bound on memory growth regardless of TTL settings.

6. **Cross-encoder reranking**: The literature recommends an optional cross-encoder pass for final precision. This adds latency and an external model dependency. Worth it only if the simpler weighted reranking proves insufficient.

7. **BM25 hybrid search**: Adding FTS5-based keyword search alongside vector search could improve recall (RRF fusion shows 8-15% improvement). This is orthogonal to TTL/staleness but worth considering as a follow-up.
