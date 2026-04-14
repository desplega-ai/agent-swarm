---
date: 2026-04-12T10:00:00Z
author: Claude
topic: "Memory TTL, Staleness Management & Provider Abstraction"
tags: [plan, memory, ttl, staleness, reranking, provider-abstraction, issue-212]
status: reviewed
source_brainstorm: thoughts/taras/brainstorms/2026-04-11-memory-ttl-staleness.md
issue: "#212"
---

# Memory TTL, Staleness Management & Provider Abstraction — Implementation Plan

## Overview

Implement memory TTL, staleness management, and provider abstraction for the agent memory system (issue #212). This replaces the current brute-force cosine similarity search with sqlite-vec KNN, introduces reranking with recency/access signals, adds TTL-based expiry, and extracts the embedding and storage logic behind swappable provider interfaces.

**Single PR. 7 phases. Commit after each phase passes verification.**

## Current State Analysis

The memory system lives across 5 files with no abstraction layer:

- **`src/be/embedding.ts`** (81 lines): OpenAI `text-embedding-3-small` (512-dim), cosine similarity, Float32Array↔Buffer serialization. Hardcoded to OpenAI.
- **`src/be/db.ts:4691-4940`**: 9 exported functions — `createMemory`, `getMemoryById`, `updateMemoryEmbedding`, `searchMemoriesByVector`, `listMemoriesByAgent`, `deleteMemory`, `deleteMemoriesBySourcePath`, `getMemoryStats`, plus internal `AgentMemoryRow` type and `rowToAgentMemory` mapper.
- **`src/http/memory.ts`** (168 lines): `POST /api/memory/index` (chunking + async embed) and `POST /api/memory/search`.
- **`src/tools/memory-search.ts`**, **`memory-get.ts`**, **`inject-learning.ts`**: MCP tools, all import directly from `db.ts` and `embedding.ts`.
- **`src/tools/store-progress.ts:249-303`**: Auto-indexes completed/failed tasks as memories.
- **`src/types.ts:572-599`**: `AgentMemory` Zod schema, scope/source enums.

**Key problems:**
1. `searchMemoriesByVector` (`db.ts:4857-4859`) loads ALL rows into JS for cosine similarity — no DB-level vector search.
2. `accessedAt` is updated only in `getMemoryById` (`db.ts:4798-4801`), never used for ranking.
3. No TTL, no access counting, no embedding model tracking.
4. Embedding and storage logic tightly coupled to OpenAI and SQLite respectively.

### Key Discoveries:
- Latest migration is `035_api_key_name_provider.sql` → new migration will be `036`
- No native SQLite extensions loaded anywhere — sqlite-vec will be the first
- `initDb()` at `db.ts:1-92` is where PRAGMA setup and migrations run — sqlite-vec will load here
- `AgentMemorySchema` in `types.ts:580-595` does not include `embedding` (BLOB is internal)
- The `store-progress.ts:261-272` auto-memory calls `createMemory` + `getEmbedding` + `updateMemoryEmbedding` inline
- Worker-side code (`runner.ts:1482-1504`, `hooks/hook.ts:952-981`) uses HTTP endpoints, not DB imports — no changes needed there
- Provider adapter pattern exists at `src/providers/types.ts` (interface + factory + per-impl files)
- MCP tool pattern: each file exports `register*Tool(server)` using `createToolRegistrar` from `src/tools/utils.ts`
- Route factory at `src/http/route-def.ts` auto-registers in OpenAPI

## Desired End State

After this PR:

1. **Provider abstraction**: `EmbeddingProvider` (text→vector) and `MemoryStore` (persist+retrieve) are separate interfaces in `src/be/memory/types.ts`. Current implementations: `OpenAIEmbeddingProvider` and `SqliteMemoryStore`.
2. **sqlite-vec KNN**: Vector search uses `WHERE embedding MATCH ? AND k = ?` on a `memory_vec` virtual table instead of loading all rows into JS.
3. **Reranking**: `MemoryReranker` module scores candidates: `similarity * recency_decay(createdAt) * access_boost(accessedAt, accessCount)`. Fetches `limit * CANDIDATE_SET_MULTIPLIER` candidates, narrows to final `limit`.
4. **TTL**: `expiresAt` column computed from source type on creation. Expired memories filtered from search (lazy — no proactive cleanup). `memory-get` by ID still returns expired memories.
5. **Access tracking**: `accessCount` column incremented on `get()`. Used by reranker's access_boost.
6. **Embedding model tracking**: `embeddingModel` column set when embedding is generated. Enables future model migrations.
7. **memory-delete MCP tool**: Agents delete own memories; leads can also delete swarm-scoped.
8. **re-embed endpoint**: `POST /api/memory/re-embed` triggers batch re-embedding with current provider.
9. **Old db.ts memory functions removed**: All 5 consumers updated to use new abstractions.

### Verification:
```bash
bun run tsc:check           # No type errors
bun run lint:fix             # Clean lint
bun test                     # All tests pass (existing + new)
bash scripts/check-db-boundary.sh  # No boundary violations
```

Manually verify:
- Fresh DB: `rm agent-swarm-db.sqlite && bun run start:http` — server starts, memory_vec table created
- Existing DB: `bun run start:http` — migration applies cleanly, existing memories still searchable
- MCP tools: `memory-search`, `memory-get`, `memory-delete` all work via MCP session
- HTTP: `POST /api/memory/index`, `POST /api/memory/search`, `POST /api/memory/re-embed` all respond correctly

## Quick Verification Reference

Common commands:
- `bun run tsc:check` — type check
- `bun run lint:fix` — lint & format
- `bun test` — all unit tests
- `bun test src/tests/memory.test.ts` — memory tests
- `bash scripts/check-db-boundary.sh` — DB boundary check

Key files (new):
- `src/be/memory/types.ts` — interfaces
- `src/be/memory/constants.ts` — tuning params
- `src/be/memory/reranker.ts` — scoring module
- `src/be/memory/index.ts` — singleton getters
- `src/be/memory/providers/openai-embedding.ts` — OpenAI impl
- `src/be/memory/providers/sqlite-store.ts` — SQLite+sqlite-vec impl
- `src/be/migrations/036_memory_ttl_staleness.sql` — schema changes
- `src/tools/memory-delete.ts` — new MCP tool

Key files (modified):
- `src/be/db.ts` — remove memory functions (~250 lines)
- `src/be/embedding.ts` — keep only `cosineSimilarity`, `serializeEmbedding`, `deserializeEmbedding` as internal utils
- `src/types.ts` — add new fields to `AgentMemorySchema`
- `src/http/memory.ts` — use new store/provider
- `src/tools/memory-search.ts` — use store + reranker
- `src/tools/memory-get.ts` — use store
- `src/tools/inject-learning.ts` — use store + provider
- `src/tools/store-progress.ts` — use store + provider
- `src/server.ts` — register memory-delete tool
- `src/tests/memory.test.ts` — rewrite to use new store

## What We're NOT Doing

- **No proactive cleanup**: Expired memories accumulate in DB, filtered at query time only.
- **No per-memory TTL overrides**: Source-based defaults only.
- **No archive concept**: Hard delete only via `memory-delete`.
- **No automatic re-embedding**: `re-embed` endpoint is manual/on-demand.
- **No non-SQLite backends in this PR**: Interface is generic, but only SQLite+sqlite-vec is implemented.
- **No changes to worker-side code**: `runner.ts` and `hooks/hook.ts` use HTTP endpoints — they're unaffected.
- **No changes to MCP tool input/output shapes**: New fields are additive (nullable), existing consumers won't break.

## Implementation Approach

Abstraction first, then migrate. Each phase builds on the previous and is independently verifiable:

1. Define interfaces + constants (pure types, no behavior)
2. Implement EmbeddingProvider (extract + add batch)
3. Implement MemoryStore + migration (extract + sqlite-vec + new columns)
4. Implement Reranker (pure functions, depends on types/constants)
5. Wire up all consumers (tools + HTTP → new abstractions, remove old code)
6. Add new capabilities (memory-delete tool + re-embed endpoint)
7. Tests (unit + integration)

---

## Phase 1: Interfaces & Constants

### Overview
Define the provider interfaces and tuning constants. Pure types and config — no implementation code.

### Changes Required:

#### 1. Memory types
**File**: `src/be/memory/types.ts` (new)
**Changes**: Define the two core interfaces and supporting types:

```typescript
// EmbeddingProvider — text to vector, swappable
interface EmbeddingProvider {
  readonly name: string;           // e.g. "openai/text-embedding-3-small"
  readonly dimensions: number;     // e.g. 512
  embed(text: string): Promise<Float32Array | null>;
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
}

// MemoryStore — persist and retrieve memories, swappable
interface MemoryStore {
  store(input: MemoryInput): AgentMemory;                                         // sync, returns created memory
  storeBatch(inputs: MemoryInput[]): AgentMemory[];                               // atomic batch insert (used by chunked indexing)
  get(id: string): AgentMemory | null;                                            // updates accessedAt + accessCount
  peek(id: string): AgentMemory | null;                                           // read-only, no side effects (for permission checks)
  search(embedding: Float32Array, agentId: string, options: MemorySearchOptions): MemoryCandidate[];
  list(agentId: string, options: MemoryListOptions): AgentMemory[];
  listForReembedding(options?: { agentId?: string }): { id: string; content: string }[];  // admin: list memories needing re-embed
  delete(id: string): boolean;
  deleteBySourcePath(sourcePath: string, agentId: string): number;
  updateEmbedding(id: string, embedding: Float32Array, model: string): void;
  getStats(agentId: string): MemoryStats;
}

// MemoryInput — what callers pass to store()
interface MemoryInput {
  agentId: string | null;
  scope: AgentMemoryScope;
  name: string;
  content: string;
  summary?: string | null;
  source: AgentMemorySource;
  sourceTaskId?: string | null;
  sourcePath?: string | null;
  chunkIndex?: number;
  totalChunks?: number;
  tags?: string[];
}

// MemoryCandidate — search result with raw similarity + metadata for reranking
interface MemoryCandidate extends AgentMemory {
  similarity: number;
  accessCount: number;
  expiresAt: string | null;
  embeddingModel: string | null;
}

// MemorySearchOptions
interface MemorySearchOptions {
  scope?: 'agent' | 'swarm' | 'all';
  limit?: number;
  source?: AgentMemorySource;
  isLead?: boolean;
  includeExpired?: boolean;  // default false
}

// MemoryListOptions
interface MemoryListOptions {
  scope?: 'agent' | 'swarm' | 'all';
  limit?: number;
  offset?: number;
  isLead?: boolean;
}

// MemoryStats
interface MemoryStats {
  total: number;
  bySource: Record<string, number>;
  byScope: Record<string, number>;
  withEmbeddings: number;
  expired: number;
}

// RerankOptions — passed to the reranker
interface RerankOptions {
  limit: number;
  now?: Date;  // for testing, defaults to new Date()
}
```

#### 2. Memory constants
**File**: `src/be/memory/constants.ts` (new)
**Changes**: Define TTL defaults and reranking parameters, each overridable via env var:

```typescript
// TTL defaults (in days) — null means no expiry
export const TTL_DEFAULTS: Record<AgentMemorySource, number | null> = {
  task_completion: 7,
  session_summary: 3,
  file_index: 30,
  manual: null,
};

// Reranking parameters
export const RECENCY_DECAY_HALF_LIFE_DAYS = numEnv('MEMORY_RECENCY_HALF_LIFE_DAYS', 14);
export const ACCESS_BOOST_MAX_MULTIPLIER = numEnv('MEMORY_ACCESS_BOOST_MAX', 1.5);
export const ACCESS_BOOST_RECENCY_WINDOW_HOURS = numEnv('MEMORY_ACCESS_RECENCY_HOURS', 48);
export const CANDIDATE_SET_MULTIPLIER = numEnv('MEMORY_CANDIDATE_MULTIPLIER', 3);

// Embedding defaults
export const DEFAULT_EMBEDDING_DIMENSIONS = 512;
export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
```

Each constant uses a `numEnv` helper that reads from `process.env` with a typed numeric fallback.

#### 3. Update AgentMemory type
**File**: `src/types.ts:580-595`
**Changes**: Add three new optional fields to `AgentMemorySchema`:

```typescript
// Add after accessedAt (line 594):
expiresAt: z.string().nullable().optional(),
accessCount: z.number().int().min(0).default(0).optional(),
embeddingModel: z.string().nullable().optional(),
```

These are `.optional()` for backward compatibility with existing code that constructs `AgentMemory` objects. After the migration, the `SqliteMemoryStore` will always populate them, so `MemoryCandidate` can safely declare them as required. The `get()` and `peek()` methods should also always populate them from the DB.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Existing tests still pass: `bun test`
- [ ] New files exist: `ls src/be/memory/types.ts src/be/memory/constants.ts`

#### Manual Verification:
- [ ] Review interfaces match brainstorm decisions (split providers, reranker as separate layer)
- [ ] Constants match brainstorm values (7d/3d/30d/null TTLs, 14d half-life)
- [ ] No circular imports between new files and existing code

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 2: EmbeddingProvider Extraction + Batch

### Overview
Extract the OpenAI embedding logic from `src/be/embedding.ts` into an `OpenAIEmbeddingProvider` class implementing the `EmbeddingProvider` interface. Add `embedBatch` support. Create the singleton getter.

### Changes Required:

#### 1. OpenAI embedding provider
**File**: `src/be/memory/providers/openai-embedding.ts` (new)
**Changes**: Implement `EmbeddingProvider`:

- Constructor takes optional `{ apiKey, model, dimensions }` config (defaults from constants + env)
- `embed(text)`: Extract logic from `embedding.ts:15-37` — clean text, call OpenAI, return Float32Array
- `embedBatch(texts)`: Use the OpenAI embeddings API with multiple inputs in a single call. The API supports batch: `client.embeddings.create({ input: texts, ... })` returns an array of embeddings. Map results by index. Handle partial failures (return null for failed items).
- `name` getter: returns `"openai/text-embedding-3-small"` (or configured model)
- `dimensions` getter: returns 512 (or configured)
- Lazy OpenAI client initialization (same pattern as `embedding.ts:3-9`)
- Returns `null` if no API key (graceful degradation)

#### 2. Singleton getter
**File**: `src/be/memory/index.ts` (new)
**Changes**: Export `getEmbeddingProvider()`:

```typescript
let embeddingProvider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!embeddingProvider) {
    embeddingProvider = new OpenAIEmbeddingProvider();
  }
  return embeddingProvider;
}
```

#### 3. Keep embedding.ts intact (for now)
**File**: `src/be/embedding.ts`
**Changes**: Do NOT remove `getEmbedding` or `getClient` yet — they're still imported by 4 consumers. We'll update consumers in Phase 5 and clean up then. For now, the new provider exists alongside the old code.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Existing tests still pass: `bun test`
- [ ] New files exist: `ls src/be/memory/providers/openai-embedding.ts src/be/memory/index.ts`

#### Manual Verification:
- [ ] `OpenAIEmbeddingProvider` implements `EmbeddingProvider` interface from `types.ts`
- [ ] `embedBatch` correctly maps multiple inputs to results by index
- [ ] Provider returns `null` gracefully when `OPENAI_API_KEY` is missing
- [ ] No changes to existing consumers (they still use old `embedding.ts`)

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 3: MemoryStore Extraction + sqlite-vec + Migration

### Overview
Create the database migration adding new columns and the sqlite-vec virtual table. Load sqlite-vec in `initDb()`. Extract all memory DB functions from `db.ts` into `SqliteMemoryStore` implementing the `MemoryStore` interface.

### Changes Required:

#### 1. Install sqlite-vec
**Command**: `bun add sqlite-vec`

#### 2. Database migration
**File**: `src/be/migrations/036_memory_ttl_staleness.sql` (new)
**Changes**: Only ALTER TABLE + index — no vec0 table here (that's conditional on sqlite-vec availability and lives in the store constructor):

```sql
-- New columns for TTL, access tracking, and embedding model
ALTER TABLE agent_memory ADD COLUMN expiresAt TEXT;
ALTER TABLE agent_memory ADD COLUMN accessCount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_memory ADD COLUMN embeddingModel TEXT;

-- Index for TTL queries (filtering expired memories)
CREATE INDEX IF NOT EXISTS idx_agent_memory_expires
  ON agent_memory(expiresAt);
```

The `memory_vec` virtual table creation and initial population from existing embeddings happens in `SqliteMemoryStore` constructor (conditional on `isSqliteVecAvailable()`). This split ensures the migration never fails due to missing sqlite-vec.

#### 3. Load sqlite-vec in initDb()
**File**: `src/be/db.ts` (modify `initDb()` function, around lines 10-30)
**Changes**: After the PRAGMA setup and before `runMigrations(db)`, add sqlite-vec loading:

```typescript
// Load sqlite-vec extension for vector search
let sqliteVecAvailable = false;
try {
  const sqliteVec = require("sqlite-vec");
  sqliteVec.load(db);
  sqliteVecAvailable = true;
} catch (err) {
  console.warn("[db] sqlite-vec not available, falling back to in-memory cosine:", (err as Error).message);
}
```

Also export a function to check availability:
```typescript
export function isSqliteVecAvailable(): boolean {
  return sqliteVecAvailable;
}
```

**Important**: `sqliteVec.load(db)` is synchronous — no need to make `initDb` async. The extension load MUST happen before `runMigrations(db)` so the DB is ready for any future migration that might reference vec0.

**macOS note**: The `sqlite-vec` npm package's `load()` convenience function handles platform detection including macOS (which requires `Database.setCustomSQLite` due to Apple disabling extensions). Verify this works locally during Phase 3 manual verification.

This is more robust — the migration won't fail if sqlite-vec isn't installed.

#### 4. SQLite memory store
**File**: `src/be/memory/providers/sqlite-store.ts` (new)
**Changes**: Implement `MemoryStore` interface. Extract and adapt logic from `db.ts:4691-4940`:

**Constructor**: Creates `memory_vec` virtual table if it doesn't exist and sqlite-vec is available. Populates it from existing embeddings on first run.

**`store(input)`**: Based on `createMemory` (`db.ts:4743-4790`).
- Computes `expiresAt` from `input.source` using `TTL_DEFAULTS` from constants: `expiresAt = source has TTL ? new Date(Date.now() + ttlDays * 86400000).toISOString() : null`
- Sets `accessCount = 0`, `embeddingModel = null`
- INSERT includes the three new columns

**`storeBatch(inputs)`**: Wraps multiple `store()` calls in a `getDb().transaction()` for atomicity. Used by the HTTP index handler for chunked content — ensures either all chunks are stored or none (no partial indexing on crash).

**`peek(id)`**: Same as `get(id)` but does NOT update `accessedAt` or increment `accessCount`. Used for permission checks (e.g., memory-delete tool) where reading shouldn't be a side effect.

**`get(id)`**: Based on `getMemoryById` (`db.ts:4792-4804`).
- Updates both `accessedAt` AND increments `accessCount` atomically:
  ```sql
  UPDATE agent_memory SET accessedAt = ?, accessCount = accessCount + 1 WHERE id = ?
  ```

**`search(embedding, agentId, options)`**: Two-path strategy:
- **sqlite-vec path** (when available):
  1. KNN query on `memory_vec` to get candidate IDs + distances:
     ```sql
     SELECT memory_id, distance FROM memory_vec
     WHERE embedding MATCH ? AND k = ?
     ```
  2. Hydrate from `agent_memory` with scope/source/expiry filtering:
     ```sql
     SELECT * FROM agent_memory
     WHERE id IN (?,?,...) AND [scope filters] AND [expiry filter]
     ```
  3. Map distances to similarity scores (sqlite-vec cosine distance = 1 - cosine_similarity, so `similarity = 1 - distance`)
  4. Return as `MemoryCandidate[]`
- **Fallback path** (no sqlite-vec): Use existing brute-force from `db.ts:4857-4876` — load all rows, compute cosine in JS, sort, slice. Add expiry filtering.

**`list(agentId, options)`**: Based on `listMemoriesByAgent` (`db.ts:4886-4924`). No changes needed beyond adding new columns to SELECT.

**`delete(id)`**: Based on `deleteMemory` (`db.ts:4933-4936`). Also `DELETE FROM memory_vec WHERE memory_id = ?` if sqlite-vec available.

**`deleteBySourcePath(sourcePath, agentId)`**: Based on `deleteMemoriesBySourcePath` (`db.ts:4926-4931`). First SELECT matching IDs, then DELETE from both tables.

**`updateEmbedding(id, embedding, model)`**: Based on `updateMemoryEmbedding` (`db.ts:4806-4808`).
- `UPDATE agent_memory SET embedding = ?, embeddingModel = ? WHERE id = ?`
- `INSERT OR REPLACE INTO memory_vec(memory_id, embedding) VALUES (?, ?)` if sqlite-vec available

**`getStats(agentId)`**: Based on `getMemoryStats` (`db.ts:4938+`). Add `expired` count:
  ```sql
  SELECT COUNT(*) FROM agent_memory WHERE expiresAt IS NOT NULL AND expiresAt <= datetime('now')
  ```

**`listForReembedding(options?)`**: Admin method for the re-embed endpoint. Returns `{ id, content }[]` for all memories (optionally filtered by `agentId`). Lightweight query — only fetches id and content, not embeddings or full metadata.

**Internal types**: Define `AgentMemoryRow` (extended with new columns) and `rowToAgentMemory` mapper internally.

#### 5. Register store singleton
**File**: `src/be/memory/index.ts` (modify)
**Changes**: Add `getMemoryStore()`:

```typescript
let memoryStore: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore {
  if (!memoryStore) {
    memoryStore = new SqliteMemoryStore();
  }
  return memoryStore;
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Existing tests still pass: `bun test`
- [ ] sqlite-vec installs: `bun add sqlite-vec && ls node_modules/sqlite-vec`
- [ ] Migration file exists: `ls src/be/migrations/036_memory_ttl_staleness.sql`
- [ ] Store file exists: `ls src/be/memory/providers/sqlite-store.ts`

#### Manual Verification:
- [ ] Fresh DB test: `rm -f agent-swarm-db.sqlite* && bun run start:http` — server starts without errors, check logs for sqlite-vec loading
- [ ] Existing DB test: `bun run start:http` — migration 036 applies cleanly
- [ ] Verify new columns: `sqlite3 agent-swarm-db.sqlite ".schema agent_memory"` shows expiresAt, accessCount, embeddingModel
- [ ] Verify vec table exists (if sqlite-vec loaded): `sqlite3 agent-swarm-db.sqlite "SELECT COUNT(*) FROM memory_vec;"` matches non-null embedding count
- [ ] Verify fallback: Temporarily break sqlite-vec import, server should start with warning and use brute-force search

**Implementation Note**: This is the highest-risk phase (native extension loading, migration, vec table sync). After completing, pause for thorough manual verification. Create commit after verification passes.

---

## Phase 4: Reranker Module

### Overview
Implement the memory reranker as a standalone pure-function module. Takes candidates from the store and applies recency decay + access boost scoring.

### Changes Required:

#### 1. Reranker module
**File**: `src/be/memory/reranker.ts` (new)
**Changes**: Export a `rerank` function and individual scoring helpers:

**`rerank(candidates, options)`**:
```typescript
export function rerank(candidates: MemoryCandidate[], options: RerankOptions): MemoryCandidate[] {
  const { limit, now = new Date() } = options;
  
  const scored = candidates.map(candidate => ({
    ...candidate,
    similarity: computeScore(candidate, now),  // overwrite similarity with final score
  }));
  
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}
```

**`recencyDecay(createdAt, now)`**: Exponential decay based on age.
```
ageDays = (now.getTime() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24)
decay = Math.pow(2, -ageDays / RECENCY_DECAY_HALF_LIFE_DAYS)
```
A memory at exactly `HALF_LIFE_DAYS` (14d) old gets multiplied by 0.5. Fresh memories get ~1.0.

**`accessBoost(accessedAt, accessCount, now)`**: Boost for frequently/recently accessed memories.
```
hoursSinceAccess = (now.getTime() - new Date(accessedAt).getTime()) / (1000 * 60 * 60)
recencyFactor = hoursSinceAccess <= ACCESS_BOOST_RECENCY_WINDOW_HOURS ? 1.0 : 0.5
boost = 1 + Math.min(accessCount / 10, ACCESS_BOOST_MAX_MULTIPLIER - 1) * recencyFactor
```
Range: [1.0, ACCESS_BOOST_MAX_MULTIPLIER]. Memories accessed recently AND frequently get the full boost.

**`computeScore(candidate, now)`**: Combines all signals:
```
finalScore = candidate.similarity * recencyDecay(candidate.createdAt, now) * accessBoost(candidate.accessedAt, candidate.accessCount, now)
```

Export `recencyDecay`, `accessBoost`, and `computeScore` individually for unit testing.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Existing tests still pass: `bun test`
- [ ] File exists: `ls src/be/memory/reranker.ts`

#### Manual Verification:
- [ ] Review scoring formula matches brainstorm decisions
- [ ] Verify edge cases: accessCount=0 → boost=1.0, very old memories → decay near 0, fresh memories → decay near 1.0
- [ ] Constants are imported from `constants.ts`, not hardcoded

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 5: Wire Up MCP Tools + HTTP Endpoints

### Overview
Update all 5 consumers to use the new abstractions (MemoryStore, EmbeddingProvider, reranker). Remove old memory functions from `db.ts`. This is the largest phase — it touches every file that interacts with the memory system.

### Changes Required:

#### 1. Update memory-search MCP tool
**File**: `src/tools/memory-search.ts`
**Changes**:
- Replace imports: `searchMemoriesByVector, listMemoriesByAgent` from `@/be/db` → `getMemoryStore, getEmbeddingProvider` from `@/be/memory`
- Import `rerank` from `@/be/memory/reranker` and `CANDIDATE_SET_MULTIPLIER` from `@/be/memory/constants`
- Keep `getAgentById` import from `@/be/db` (not a memory function)
- Update vector search path (lines 63-97):
  ```typescript
  const provider = getEmbeddingProvider();
  const store = getMemoryStore();
  const embedding = await provider.embed(query);
  
  if (embedding) {
    const candidateLimit = limit * CANDIDATE_SET_MULTIPLIER;
    const candidates = store.search(embedding, requestInfo.agentId, {
      scope, limit: candidateLimit, source, isLead,
    });
    const ranked = rerank(candidates, { limit });
    // map ranked to output shape (use ranked.similarity which is now the final score)
  }
  ```
- Update fallback path (lines 99-128): `store.list(requestInfo.agentId, { scope, limit, isLead })`
- Output shape unchanged — the `similarity` field now contains the reranked score

#### 2. Update memory-get MCP tool
**File**: `src/tools/memory-get.ts`
**Changes**:
- Replace import: `getMemoryById` from `@/be/db` → `getMemoryStore` from `@/be/memory`
- Update handler (line 27): `const memory = getMemoryStore().get(memoryId);`
- `get()` now automatically increments `accessCount` in addition to updating `accessedAt`

#### 3. Update inject-learning MCP tool
**File**: `src/tools/inject-learning.ts`
**Changes**:
- Replace imports: `createMemory, updateMemoryEmbedding` from `@/be/db` → `getMemoryStore, getEmbeddingProvider` from `@/be/memory`
- Remove imports: `getEmbedding, serializeEmbedding` from `@/be/embedding`
- Keep `getAgentById` import from `@/be/db`
- Update memory creation (lines 72-78): `const memory = getMemoryStore().store({ ... })`
- Update embedding (lines 81-88):
  ```typescript
  const provider = getEmbeddingProvider();
  const embedding = await provider.embed(content);
  if (embedding) {
    getMemoryStore().updateEmbedding(memory.id, embedding, provider.name);
  }
  ```

#### 4. Update HTTP memory handler
**File**: `src/http/memory.ts`
**Changes**:
- Replace imports: `createMemory, deleteMemoriesBySourcePath, searchMemoriesByVector, updateMemoryEmbedding` from `../be/db` → `getMemoryStore, getEmbeddingProvider` from `../be/memory`
- Remove imports: `getEmbedding, serializeEmbedding` from `../be/embedding`
- Remove `getDb` import (used only for the transaction wrapper)
- Import `rerank` from `../be/memory/reranker` and `CANDIDATE_SET_MULTIPLIER` from `../be/memory/constants`
- Update index handler (lines 65-124):
  - Replace `getDb().transaction()` with `store.storeBatch()` + `store.deleteBySourcePath()`:
    ```typescript
    const store = getMemoryStore();
    const provider = getEmbeddingProvider();
    
    // Dedup — delete old chunks for this source path
    if (sourcePath && agentId) {
      store.deleteBySourcePath(sourcePath, agentId);
    }
    
    // Atomic batch insert — all chunks or none (uses transaction internally)
    const memories = store.storeBatch(contentChunks.map(chunk => ({
      agentId: agentId || null, content: chunk.content, name, scope, source,
      sourcePath: sourcePath || null, sourceTaskId: sourceTaskId || null,
      chunkIndex: chunk.chunkIndex, totalChunks: chunk.totalChunks, tags: tags || [],
    })));
    
    // Async batch embed (fire and forget)
    (async () => {
      const embeddings = await provider.embedBatch(contentChunks.map(c => c.content));
      for (let i = 0; i < embeddings.length; i++) {
        if (embeddings[i]) {
          store.updateEmbedding(memories[i].id, embeddings[i]!, provider.name);
        }
      }
    })();
    
    json(res, { queued: true, memoryIds: memories.map(m => m.id) }, 202);
    ```
- Update search handler (lines 126-165):
  ```typescript
  const provider = getEmbeddingProvider();
  const store = getMemoryStore();
  const embedding = await provider.embed(query);
  
  if (!embedding) { json(res, { results: [] }); return true; }
  
  const candidateLimit = Math.min(limit, 20) * CANDIDATE_SET_MULTIPLIER;
  const candidates = store.search(embedding, myAgentId, {
    scope: "all", limit: candidateLimit, isLead: false,
  });
  const ranked = rerank(candidates, { limit: Math.min(limit, 20) });
  
  json(res, {
    results: ranked.map(r => ({
      id: r.id, name: r.name, content: r.content,
      similarity: r.similarity, source: r.source, scope: r.scope,
    })),
  });
  ```

#### 5. Update store-progress auto-memory
**File**: `src/tools/store-progress.ts:249-303`
**Changes**:
- Replace imports: `createMemory, updateMemoryEmbedding` from `@/be/db` → `getMemoryStore, getEmbeddingProvider` from `@/be/memory`
- Remove imports: `getEmbedding, serializeEmbedding` from `@/be/embedding`
- Update the async IIFE (lines 251-302):
  ```typescript
  const store = getMemoryStore();
  const provider = getEmbeddingProvider();
  
  const memory = store.store({
    agentId: requestInfo.agentId,
    content: taskContent,
    name: `Task: ${result.task!.task.slice(0, 80)}`,
    scope: "agent",
    source: "task_completion",
    sourceTaskId: taskId,
  });
  const embedding = await provider.embed(taskContent);
  if (embedding) {
    store.updateEmbedding(memory.id, embedding, provider.name);
  }
  
  // Swarm promotion — same pattern with store.store() + provider.embed()
  ```

#### 6. Remove old memory functions from db.ts
**File**: `src/be/db.ts:4691-4940+`
**Changes**: Remove the following entirely (~250 lines):
- `type AgentMemoryRow` (line 4691)
- `function rowToAgentMemory` (line 4709)
- `interface CreateMemoryOptions` (line 4728)
- `function createMemory` (line 4743)
- `function getMemoryById` (line 4792)
- `function updateMemoryEmbedding` (line 4806)
- `interface SearchMemoriesOptions` (line 4810)
- `function searchMemoriesByVector` (line 4817)
- `interface ListMemoriesOptions` (line 4879)
- `function listMemoriesByAgent` (line 4886)
- `function deleteMemoriesBySourcePath` (line 4926)
- `function deleteMemory` (line 4933)
- `function getMemoryStats` (line 4938)

Also remove the `AgentMemory`, `AgentMemoryScope`, `AgentMemorySource` type imports if they're no longer needed in db.ts (they may still be used elsewhere in the file — verify before removing).

#### 7. Update seed script
**File**: `scripts/seed.ts:663-665`
**Changes**: Update the `INSERT INTO agent_memory` to include the three new columns:
```sql
INSERT OR IGNORE INTO agent_memory (id, agentId, scope, name, content, source, tags, createdAt, accessedAt, expiresAt, accessCount, embeddingModel)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
```
Compute `expiresAt` per row based on the source type using TTL_DEFAULTS (or pass `null` for manual sources).

#### 8. Clean up embedding.ts
**File**: `src/be/embedding.ts`
**Changes**: Remove `getEmbedding` and `getClient` (lines 1-37). Keep only:
- `cosineSimilarity` (lines 43-63) — used by SqliteMemoryStore fallback
- `serializeEmbedding` (lines 68-70) — used by SqliteMemoryStore
- `deserializeEmbedding` (lines 75-80) — used by SqliteMemoryStore

Remove the `openai` import if no longer needed.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] All tests pass: `bun test`
- [ ] DB boundary check: `bash scripts/check-db-boundary.sh`
- [ ] No remaining imports of removed db functions: `grep -rn "from.*@/be/db" src/tools/memory-*.ts src/tools/inject-learning.ts src/tools/store-progress.ts src/http/memory.ts | grep -v "getAgentById\|getDb\|isSqliteVec"`
- [ ] No remaining imports of old getEmbedding: `grep -rn "getEmbedding" src/tools/ src/http/ | grep -v node_modules`

#### Manual Verification:
- [ ] Start server: `bun run start:http` — no import errors
- [ ] Test HTTP search: `curl -X POST -H "Authorization: Bearer 123123" -H "X-Agent-ID: <uuid>" -H "Content-Type: application/json" -d '{"query":"test","limit":5}' http://localhost:3013/api/memory/search`
- [ ] Test HTTP index: `curl -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d '{"content":"test memory content","name":"test","scope":"agent","source":"manual","agentId":"<uuid>"}' http://localhost:3013/api/memory/index`
- [ ] Verify reranking affects result order (search for something where recency should matter)

**Implementation Note**: This is the riskiest wiring phase. Run full test suite AND manual verification. Create commit after verification passes.

---

## Phase 6: memory-delete Tool + Re-embed Endpoint

### Overview
Add the `memory-delete` MCP tool for agent-initiated cleanup and the `POST /api/memory/re-embed` HTTP endpoint for batch re-embedding after model changes.

### Changes Required:

#### 1. memory-delete MCP tool
**File**: `src/tools/memory-delete.ts` (new)
**Changes**: Follow the MCP tool pattern from `memory-get.ts`:

- Input: `{ memoryId: z.uuid() }`
- Output: `{ yourAgentId, success, message }`
- Permission check:
  1. Require `requestInfo.agentId`
  2. Fetch memory via `getMemoryStore().peek(memoryId)` — uses `peek()` (no side effects) since we're only checking permissions, not "accessing" the memory.
  3. Check: agent can delete if `memory.agentId === requestInfo.agentId`. Lead agents (checked via `getAgentById`) can also delete swarm-scoped memories.
  4. Call `getMemoryStore().delete(memoryId)`
- Annotations: `{ destructiveHint: true }`

#### 2. Register memory-delete in server + tool config
**File**: `src/server.ts:237-241`
**Changes**: Import `registerMemoryDeleteTool` and add to the `memory` capability block:

```typescript
if (hasCapability("memory")) {
  registerMemorySearchTool(server);
  registerMemoryGetTool(server);
  registerInjectLearningTool(server);
  registerMemoryDeleteTool(server);  // new
}
```

**File**: `src/tools/tool-config.ts:31-32`
**Changes**: Add `"memory-delete"` to the bootstrap tool set alongside `memory-search` and `memory-get`:
```typescript
"memory-search", // recall relevant context
"memory-get",    // retrieve full memory content
"memory-delete", // delete own memories
```

#### 3. Re-embed HTTP endpoint
**File**: `src/http/memory.ts`
**Changes**: Add a new route definition and handler:

```typescript
const reEmbed = route({
  method: "post",
  path: "/api/memory/re-embed",
  pattern: ["api", "memory", "re-embed"],
  summary: "Re-embed all memories using the current embedding provider",
  tags: ["Memory"],
  auth: { apiKey: true },
  body: z.object({
    agentId: z.string().uuid().optional().describe("Re-embed only this agent's memories. Omit for all."),
    batchSize: z.number().int().min(1).max(100).default(20).describe("Memories per batch"),
  }),
  responses: {
    202: { description: "Re-embedding started" },
  },
});
```

Handler in `handleMemory`:
1. Match route
2. Use `store.listForReembedding({ agentId })` to get memory IDs + content (keeps the abstraction — no raw `getDb()` in the handler)
3. Respond HTTP 202 with `{ started: true, totalMemories: count }`
4. Fire async: batch through memories using `provider.embedBatch()` in chunks of `batchSize`, update each via `store.updateEmbedding(id, embedding, provider.name)`
5. Log progress: `[memory] Re-embedded batch ${n}/${total}`

#### 4. Regenerate OpenAPI spec
**Command**: `bun run docs:openapi`

#### 5. Update MCP.md
**File**: `MCP.md`
**Changes**: Add `memory-delete` to the tool reference section (around line 62-68).

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] All tests pass: `bun test`
- [ ] DB boundary check: `bash scripts/check-db-boundary.sh`
- [ ] OpenAPI regenerated: `bun run docs:openapi`
- [ ] Tool file exists: `ls src/tools/memory-delete.ts`

#### Manual Verification:
- [ ] Start server and test memory-delete flow:
  1. Create a memory: `curl -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d '{"content":"deletable test","name":"test delete","scope":"agent","source":"manual","agentId":"<uuid>"}' http://localhost:3013/api/memory/index`
  2. Delete it via MCP `memory-delete` tool (requires MCP session)
  3. Verify `memory-get` returns not found
- [ ] Test re-embed: `curl -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d '{"batchSize":5}' http://localhost:3013/api/memory/re-embed` — returns 202
- [ ] Verify permission: non-lead agent cannot delete another agent's memory

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 7: Tests + E2E + CLAUDE.md

### Overview
Add comprehensive tests for the new modules: reranker (pure functions), store (integration), update existing memory tests, add a dedicated memory E2E test script, and update CLAUDE.md so future contributors know to run it.

### Changes Required:

#### 1. Reranker unit tests
**File**: `src/tests/memory-reranker.test.ts` (new)
**Changes**: Test the pure scoring functions:

- **`recencyDecay`**:
  - Fresh memory (created now) → ~1.0
  - Memory at half-life (14d) → ~0.5
  - Memory at 2× half-life (28d) → ~0.25
  - Very old memory (365d) → near 0
- **`accessBoost`**:
  - accessCount=0 → exactly 1.0 (no boost)
  - accessCount=10, accessed within window → ACCESS_BOOST_MAX_MULTIPLIER
  - accessCount=10, accessed outside window → partial boost (recencyFactor=0.5)
  - accessCount=100 (capped) → same as accessCount=10+ (capped at max)
- **`computeScore`**: Verify multiplication of similarity × decay × boost
- **`rerank`**:
  - Sorts by finalScore descending
  - Respects limit parameter
  - Handles empty candidate array
  - Handles all candidates with same similarity (tiebreaker by recency)
  - Handles candidates with zero accessCount
  - `now` parameter works for deterministic testing

#### 2. Store integration tests
**File**: `src/tests/memory-store.test.ts` (new)
**Changes**: Test `SqliteMemoryStore` against a real SQLite DB:

- Setup: `initDb('./test-memory-store.sqlite')` in `beforeAll`, `closeDb()` + cleanup in `afterAll`
- **store()**: Creates memory, computes expiresAt from source type, returns full AgentMemory
  - task_completion → expiresAt ≈ now + 7d
  - session_summary → expiresAt ≈ now + 3d
  - manual → expiresAt is null
- **get()**: Returns memory, increments accessCount (call twice, verify count=2), updates accessedAt
- **search()**: With test embeddings (create dummy Float32Array):
  - Returns candidates sorted by similarity
  - Respects scope filtering (agent/swarm/all)
  - Filters expired memories by default
  - Includes expired with `includeExpired: true`
  - isLead=true sees all memories
- **delete()**: Removes from agent_memory (and memory_vec if available)
- **deleteBySourcePath()**: Removes all matching
- **updateEmbedding()**: Updates BLOB, sets embeddingModel
- **getStats()**: Returns correct counts including expired

#### 3. Update existing memory tests
**File**: `src/tests/memory.test.ts`
**Changes**: Rewrite tests to use `getMemoryStore()` instead of the removed `db.ts` functions. Keep the same test scenarios to verify behavioral compatibility:
- Create memory
- Get memory by ID
- Update embedding
- Search by vector
- Delete memory
- Delete by source path
- Chunking + memory ingestion

#### 4. Update HTTP integration tests
**File**: `src/tests/http-api-integration.test.ts`
**Changes**: Existing tests for `POST /api/memory/index` and `POST /api/memory/search` should still pass (HTTP interface unchanged). Add:
- Test `POST /api/memory/re-embed` returns 202
- Verify search excludes expired memories
- Verify new fields in search response (if exposed)

#### 5. Memory E2E test script
**File**: `src/tests/memory-e2e.test.ts` (new)
**Changes**: A dedicated E2E test that stands up a real HTTP server (using the minimal `node:http` handler pattern from existing tests) and exercises the full memory lifecycle through HTTP:

- **Setup**: `initDb` with test DB, start minimal HTTP server with `handleMemory` handler
- **Test: Index → Search → Get → Delete lifecycle**:
  1. `POST /api/memory/index` with test content → 202, get memoryIds
  2. Wait briefly for async embedding (or mock `getEmbeddingProvider` to return synchronously)
  3. `POST /api/memory/search` with query → verify results include the indexed memory
  4. Verify reranking: index two memories with different ages, search, verify newer one ranks higher (with similar embeddings)
  5. `GET` memory by ID → verify accessCount incremented
  6. Delete memory → verify search no longer returns it
- **Test: TTL expiry filtering**:
  1. Create a `session_summary` memory (3d TTL)
  2. Manually set `expiresAt` to past via raw SQL (test helper)
  3. Search → verify expired memory is excluded
  4. Get by ID → verify it's still returned (lazy expiry, get still works)
- **Test: Re-embed endpoint**:
  1. `POST /api/memory/re-embed` → 202
  2. Verify embeddingModel column is updated after re-embed completes
- **Test: sqlite-vec vector search**:
  1. Create multiple memories with known embeddings (skip async, use `store.updateEmbedding` directly)
  2. Search with a query embedding that's closest to one specific memory
  3. Verify that memory is the top result
- **Cleanup**: Close DB, remove test sqlite files

This test file serves as the canonical "does the memory system work end-to-end" verification.

#### 6. Update CLAUDE.md
**File**: `CLAUDE.md` (project root)
**Changes**: Add a new `<important>` block for memory system changes:

```markdown
<important if="you are modifying memory system code (src/be/memory/, src/be/embedding.ts, src/tools/memory-*.ts, src/http/memory.ts, or src/tools/store-progress.ts memory sections)">

## Memory system

The memory system uses provider abstractions (`EmbeddingProvider`, `MemoryStore`) in `src/be/memory/` with sqlite-vec for vector search and a reranker for scoring.

**When changing memory-related code, always run:**
```bash
bun test src/tests/memory-reranker.test.ts   # Reranker unit tests
bun test src/tests/memory-store.test.ts      # Store integration tests
bun test src/tests/memory-e2e.test.ts        # Full memory E2E lifecycle
bun test src/tests/memory.test.ts            # Legacy compatibility tests
```

**Key architecture:**
- `src/be/memory/types.ts` — `EmbeddingProvider` + `MemoryStore` interfaces
- `src/be/memory/providers/` — Implementations (OpenAI embeddings, SQLite+sqlite-vec store)
- `src/be/memory/reranker.ts` — Scoring: `similarity × recency_decay × access_boost`
- `src/be/memory/constants.ts` — Tuning params (env-overridable)
- `src/be/memory/index.ts` — Singleton getters (`getMemoryStore()`, `getEmbeddingProvider()`)

</important>
```

### Success Criteria:

#### Automated Verification:
- [ ] All tests pass: `bun test`
- [ ] New test files exist: `ls src/tests/memory-reranker.test.ts src/tests/memory-store.test.ts src/tests/memory-e2e.test.ts`
- [ ] E2E test specifically passes: `bun test src/tests/memory-e2e.test.ts`
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Review reranker tests cover all edge cases from the scoring formula
- [ ] Store tests verify both sqlite-vec and fallback paths
- [ ] E2E test covers full lifecycle: index → search → get → delete → expiry → re-embed
- [ ] Existing HTTP integration tests pass without modification (backward compat)
- [ ] CLAUDE.md has the new `<important>` block for memory system changes

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Manual E2E Verification

After all phases are complete, run these commands to verify end-to-end:

```bash
# 1. Fresh database
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &
SERVER_PID=$!

# 2. Verify server started with sqlite-vec
# Check logs for "[db] sqlite-vec loaded" or similar

# 3. Create a test memory
curl -s -X POST \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"content":"The deployment pipeline uses GitHub Actions with a staging environment on Fly.io","name":"deployment info","scope":"agent","source":"manual","agentId":"00000000-0000-0000-0000-000000000001"}' \
  http://localhost:3013/api/memory/index | jq .

# 4. Wait for async embedding
sleep 2

# 5. Search for it
curl -s -X POST \
  -H "Authorization: Bearer 123123" \
  -H "X-Agent-ID: 00000000-0000-0000-0000-000000000001" \
  -H "Content-Type: application/json" \
  -d '{"query":"deployment","limit":5}' \
  http://localhost:3013/api/memory/search | jq .

# 6. Verify expiresAt=null for manual source in response

# 7. Test re-embed endpoint
curl -s -X POST \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"batchSize":5}' \
  http://localhost:3013/api/memory/re-embed | jq .

# 8. Verify sqlite-vec table has data
sqlite3 agent-swarm-db.sqlite "SELECT COUNT(*) FROM memory_vec;"

# 9. Verify new columns
sqlite3 agent-swarm-db.sqlite "SELECT id, expiresAt, accessCount, embeddingModel FROM agent_memory LIMIT 5;"

# 10. Cleanup and run full checks
kill $SERVER_PID
bun test
bun run tsc:check
bun run lint:fix
bash scripts/check-db-boundary.sh
```

## Testing Strategy

| Layer | What | How |
|-------|------|-----|
| Unit | Reranker scoring functions | Pure function tests with known inputs/outputs |
| Unit | Constants env override | Set env vars, verify values change |
| Integration | SqliteMemoryStore | Real SQLite DB with sqlite-vec loaded |
| Integration | OpenAIEmbeddingProvider | Mock OpenAI API (or skip if no key) |
| Integration | HTTP endpoints | Existing `http-api-integration.test.ts` pattern |
| E2E | Full flow | Manual curl commands above |

## References

- Brainstorm: `thoughts/taras/brainstorms/2026-04-11-memory-ttl-staleness.md`
- Issue: #212
- sqlite-vec docs: https://alexgarcia.xyz/sqlite-vec/
- Existing provider pattern: `src/providers/types.ts`, `src/providers/index.ts`
- Original memory plan: `thoughts/taras/plans/2026-02-20-memory-system.md`

## Review Errata

_Reviewed: 2026-04-12 by Claude_

### Applied
- [x] **MemoryStore interface incomplete** — Added `storeBatch()` (atomic batch insert for chunked indexing), `peek()` (read-only get without side effects), and `listForReembedding()` (admin listing for re-embed endpoint). These close gaps where the original interface forced callers to bypass the abstraction or accept unwanted side effects.
- [x] **HTTP index handler lost transaction atomicity** — Phase 5 replaced `getDb().transaction()` with sequential `store()` calls, risking partial chunk indexing on crash. Fixed: now uses `store.storeBatch()` which wraps in a transaction internally.
- [x] **Re-embed endpoint bypassed store abstraction** — Phase 6 handler used raw `getDb()` to list memories. Fixed: now uses `store.listForReembedding()` to stay within the provider interface.
- [x] **Missing `tool-config.ts` registration** — `memory-delete` was registered in `server.ts` but not added to the bootstrap tool set in `tool-config.ts:31-32`. Without this, agents wouldn't see the tool. Fixed: added to Phase 6.
- [x] **Missing `seed.ts` update** — The seed script's INSERT for `agent_memory` doesn't include the three new columns. While defaults handle it, explicit is better. Fixed: added to Phase 5 as step 7.
- [x] **memory-delete used `get()` for permission check** — `get()` increments accessCount as a side effect. Fixed: now uses `peek()` for the permission check before delete.
- [x] **Migration showed conflicting approaches** — Phase 3 showed both the full migration (with vec0 in SQL) and the revised split approach. Fixed: removed old approach, only shows final design (columns in SQL, vec0 in store constructor).
- [x] **macOS sqlite-vec note missing** — Added note about macOS platform handling to Phase 3 for local dev awareness.
