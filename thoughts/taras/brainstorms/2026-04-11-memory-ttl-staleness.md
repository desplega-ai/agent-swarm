---
date: 2026-04-11T12:00:00-04:00
author: Taras & Claude
topic: "Memory TTL, Staleness Management & Provider Abstraction"
tags: [brainstorm, memory, ttl, staleness, reranking, provider-abstraction, issue-212]
status: complete
exploration_type: problem
last_updated: 2026-04-11
last_updated_by: Claude
---

# Memory TTL, Staleness Management & Provider Abstraction — Brainstorm

## Context

**Source:** [GitHub Issue #212](https://github.com/desplega-ai/agent-swarm/issues/212)

Agent memories in `agent_memory` accumulate indefinitely with no cleanup or relevance signal. Stale memories cause agents to waste time acting on outdated context (e.g., re-checking already-resolved auth issues), and frequently-useful memories aren't prioritized over one-off noise.

### Current Implementation

- **Schema:** `agent_memory` table with embedding BLOB, source types (manual, file_index, session_summary, task_completion), scopes (agent, swarm)
- **Search:** Fetches ALL rows with embeddings, computes cosine similarity in JS — pure similarity ranking, no recency/access weighting
- **Embeddings:** OpenAI text-embedding-3-small (512-dim), async generation
- **MCP Tools:** Only `memory-search` and `memory-get` exist — no store or delete tools for agents
- **accessedAt:** Column exists and is updated on `memory-get`, but never used for ranking or cleanup

### Proposed Improvements (from issue + comments)

1. **Memory freshness via access tracking** — use accessedAt for ranking
2. **Reranking on retrieval** — `final_score = cosine_sim * recency_decay(createdAt) * access_boost(accessedAt, accessCount)`
3. **Memory TTL with soft expiry** — expiresAt column, source-based defaults
4. **Stale file_index detection** — mark stale when sourcePath gone
5. **Agent-initiated cleanup** — memory-delete/archive tools
6. **Provider abstraction** — swappable memory backends (store, embed, search)
7. **SQLite vector search** (sqlite-vec) for DB-level performance

## Exploration

### Q: Of the 7 proposed improvements, which are you most motivated to tackle now — and is there a specific pain point driving priority?
All of it — wants to tackle the full scope and figure out the right sequencing.

**Insights:** This means we need to think about dependency ordering carefully. Some improvements are prerequisites for others (e.g., provider abstraction affects where reranking logic lives). The sequencing question is as important as the design of each feature.

### Q: Should provider abstraction come first, or ship improvements against current impl and extract later?
Abstraction first — first principles approach. The abstraction will ensure we're building in the correct direction from the start, avoiding double refactoring.

**Insights:** This is a strong architectural choice. It means Phase 1 is defining the `MemoryProvider` interface and migrating the existing SQLite+OpenAI implementation behind it. All subsequent features (reranking, TTL, cleanup) get built against the interface. This also means we need to be careful about what belongs in the interface vs. what's provider-specific.

### Q: Should the provider abstraction be one unified interface or split by concern?
Split: EmbeddingProvider (embed text→vector) separate from MemoryStore (store, search, delete). Can swap embedding model independently of storage backend.

**Insights:** Good separation of concerns. This mirrors what LangChain/LlamaIndex do. The EmbeddingProvider is a pure function (text→vector), while MemoryStore handles persistence + retrieval. The reranking logic could live either in the MemoryStore (DB-level) or as a post-processing layer on top. This split also means we could swap OpenAI embeddings for a local model without touching storage at all.

### Q: Where should the reranking logic live — inside MemoryStore, as a layer on top, or configurable?
Leaning toward inside MemoryStore (option 1). Asked for Claude's opinion.

**Claude's take:** I'd actually push back slightly here, Taras. I think option 2 (layer on top) is the better call, and here's why:

1. **Reranking is an application-level policy**, not a storage concern. The formula `cosine_sim * recency_decay(createdAt) * access_boost(accessedAt, accessCount)` is a business decision about what "relevant" means. Different use cases might want different decay curves or boost weights.

2. **Consistency across backends.** If you ever add a second MemoryStore (e.g., Postgres+pgvector, or an external service like Pinecone), you'd need to reimplement the exact same reranking logic. A layer on top guarantees identical behavior regardless of backend.

3. **The store's job is retrieval, not ranking.** The store should return a candidate set (top-K by similarity), and the reranker narrows it. This keeps the store interface simple: `search(embedding, limit) → candidates with similarity scores`. The reranker adds `createdAt`, `accessedAt` signals.

4. **Testability.** Reranking logic is pure function territory — easy to unit test independently. Coupling it into the store means testing it through DB integration tests.

That said, I understand the appeal of option 1 — it's simpler from the consumer's perspective (just call `search()` and get ranked results). But that simplicity comes at the cost of duplicating logic across backends.

**Compromise:** The store returns candidates with raw similarity + metadata (createdAt, accessedAt). A `MemoryReranker` module (which could be swapped too) does the scoring. The MCP tools and HTTP endpoints just call `reranker.search(store, query, options)`.

**Decision:** Agreed — reranking as a separate layer on top. Store returns candidates with raw similarity + metadata, Reranker module applies scoring.

### Q: How flexible should the TTL system be?
Source-based defaults only. Keep it simple — each source type has a hardcoded default TTL, no per-memory overrides.

**Insights:** This simplifies both the migration (just add `expiresAt` column, compute from source type on creation) and the cleanup logic (query by expiresAt). The defaults from the issue: task_completion ~7d, session_summary ~3d, file_index no TTL, manual no TTL. We can always add per-memory overrides later if needed — YAGNI applies here.

### Q: Should sqlite-vec be part of the initial scope or a follow-up optimization?
Include in initial scope — performance win from day one.

**Insights:** This means the SQLite MemoryStore will use sqlite-vec for KNN search from the start. We'll need to: (1) add the sqlite-vec extension to the Docker image, (2) verify Bun compatibility with the native extension, (3) create a migration to set up the vec0 virtual table alongside the existing agent_memory table. The provider abstraction helps here — if sqlite-vec causes issues, we can fall back to in-memory cosine without changing the consumer code.

### Q: How should agent-initiated cleanup work? Delete, archive, or both?
Simple hard delete. Agents can delete their own memories (any type). Leads can also delete swarm-scoped memories. No archive concept.

**Insights:** KISS principle. A `memory-delete` MCP tool is straightforward to implement. The existing `deleteMemory()` function in db.ts already exists, we just need to wire it up as an MCP tool with permission checks. The TTL system handles automatic cleanup; memory-delete handles intentional cleanup. No need for archive complexity.

### Q: How should stale file_index detection work given the server/worker architecture split?
Access-based decay — no filesystem check needed. file_index memories that haven't been accessed in N days get auto-demoted in ranking. Simpler, works across architectures.

**Insights:** This elegantly sidesteps the architecture constraint. The reranker already applies access_boost — file_index memories that stop being accessed will naturally sink in ranking. Combined with TTL (file_index currently proposed as "no TTL"), we might want a longer but non-infinite TTL for file_index too, or just let the access-based decay handle it. This means stale detection is essentially "free" once reranking is implemented.

### Q: How should reranking tuning parameters be handled?
Hardcoded defaults in a standalone constants file, overridable via environment variables. Keeps it simple but tunable without code changes.

**Insights:** A dedicated constants file (e.g., `src/be/memory-constants.ts`) with all reranking params: `RECENCY_DECAY_HALF_LIFE_DAYS`, `ACCESS_BOOST_WINDOW_HOURS`, `ACCESS_BOOST_MULTIPLIER`, `CANDIDATE_SET_MULTIPLIER`, etc. Each reads from env var with fallback to default. Clean, greppable, and any operator can tune without touching code.

### Q: What's the realistic scope for non-SQLite backends?
External services possible (Pinecone, Weaviate, etc.). Interface should be generic enough for hosted vector DBs.

**Insights:** This confirms the provider abstraction needs to be genuinely backend-agnostic. The MemoryStore interface can't leak SQLite-isms (e.g., BLOB storage, transactions). It needs to work over HTTP/gRPC for external services. Key implication: the interface should deal in domain types (Float32Array for embeddings, plain objects for memories), not DB-specific formats. The serialization concern (Float32Array ↔ Buffer) stays inside the SQLite implementation.

### Q: When should expired memories actually get deleted?
Lazy only — no proactive cleanup. Expired memories get filtered from search results but accumulate in DB.

**Insights:** Simplest approach. The `WHERE expiresAt IS NULL OR expiresAt > datetime('now')` clause in search queries handles it. Memories are soft-expired by default — `memory-get` by ID still returns them. If DB size becomes a concern later, add a manual cleanup endpoint or startup purge. This avoids any background job complexity and keeps the server stateless between requests.

### Q: Anything else to explore? Embedding provider details, migration strategy?
Wants to explore embedding provider details. Migration: fine with a single yolo PR migration.

**Insights on migration:** Single PR that adds: `expiresAt TEXT`, `accessCount INTEGER DEFAULT 0` columns to `agent_memory`, plus sets up sqlite-vec virtual table. Existing memories get `expiresAt = NULL` (no expiry) and `accessCount = 0`. Simple ALTER TABLE + new migration file.

### Q: What should the EmbeddingProvider interface look like?
With batch: `embed(text)`, `embedBatch(texts)`, and `dimensions` property. No full model metadata.

**Insights:** The interface shape:
```typescript
interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array | null>;
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
}
```
`embedBatch` is important for bulk ingestion (file indexing, re-embedding after model change). The `| null` return handles graceful degradation when the API is unavailable. The existing OpenAI implementation maps directly to this — single embed uses the API, batch uses the batch endpoint. A local model provider (e.g., using transformers.js or ollama) would also fit this interface.

### Q: How to handle embedding model changes (dimension mismatches)?
Store model name per memory for tracking. Provide a manual "re-embed all" endpoint/tool. No automatic re-embedding.

**Insights:** Migration adds `embeddingModel TEXT` column to `agent_memory`. Set on embedding creation (e.g., `"openai/text-embedding-3-small"`). A new HTTP endpoint `POST /api/memory/re-embed` triggers batch re-embedding using the current EmbeddingProvider. This is useful for: (1) model upgrades, (2) switching providers, (3) fixing corrupted embeddings. Uses `embedBatch` from the provider interface.

## Synthesis

### Key Decisions

1. **Abstraction first.** Provider abstraction is Phase 1 — all subsequent features build against the new interfaces, not the raw SQLite/OpenAI code.
2. **Two-interface split.** `EmbeddingProvider` (text→vector) and `MemoryStore` (persist + retrieve) are separate interfaces. Embedding model can be swapped independently of storage backend.
3. **Reranking is a separate layer**, not part of the store. Store returns candidates with raw similarity + metadata. A `MemoryReranker` module applies the scoring formula: `cosine_sim * recency_decay(createdAt) * access_boost(accessedAt, accessCount)`.
4. **TTL: source-based defaults only.** No per-memory overrides. `task_completion` ~7d, `session_summary` ~3d, `file_index` ~30d, `manual` no TTL.
5. **Lazy expiry only.** Expired memories filtered from search, no proactive cleanup. `memory-get` by ID still returns expired memories.
6. **sqlite-vec included in initial scope.** DB-level KNN search from day one in the SQLite MemoryStore.
7. **Simple hard delete.** `memory-delete` MCP tool for agents. Own memories only; leads can also delete swarm-scoped.
8. **Access-based staleness.** No filesystem checks. Unused file_index memories decay naturally via the reranker's access_boost.
9. **Reranking constants in standalone file**, overridable via env vars.
10. **Embedding model tracking.** `embeddingModel` column stored per memory. Manual `POST /api/memory/re-embed` endpoint for model migrations.
11. **EmbeddingProvider supports batch.** `embed()`, `embedBatch()`, and `dimensions` property.
12. **Single PR migration.** One migration file adds all new columns + sqlite-vec virtual table.

### Core Requirements

**Interfaces:**
```typescript
interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array | null>;
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
}

interface MemoryStore {
  store(memory: MemoryInput): Promise<string>;           // returns memory ID
  get(id: string): Promise<Memory | null>;
  search(embedding: Float32Array, options: SearchOptions): Promise<MemoryCandidate[]>;
  delete(id: string): Promise<boolean>;
  updateAccessedAt(id: string): Promise<void>;
  updateEmbedding(id: string, embedding: Float32Array, model: string): Promise<void>;
}

// MemoryCandidate includes: memory fields + similarity score + createdAt + accessedAt + accessCount
// Reranker consumes these and produces final ranked results
```

**New DB columns** (single migration):
- `expiresAt TEXT` — computed from source type on creation
- `accessCount INTEGER DEFAULT 0` — incremented on access
- `embeddingModel TEXT` — e.g., `"openai/text-embedding-3-small"`
- sqlite-vec virtual table for vector index

**New MCP tools:**
- `memory-delete` — delete memory by ID with permission checks

**New HTTP endpoints:**
- `POST /api/memory/re-embed` — trigger batch re-embedding with current provider

**New files:**
- `src/be/memory/types.ts` — EmbeddingProvider + MemoryStore interfaces
- `src/be/memory/reranker.ts` — MemoryReranker module
- `src/be/memory/constants.ts` — tuning parameters (env var overridable)
- `src/be/memory/providers/openai-embedding.ts` — OpenAI EmbeddingProvider impl
- `src/be/memory/providers/sqlite-store.ts` — SQLite+sqlite-vec MemoryStore impl

### Suggested Phasing (single PR, but logical phases)

1. **Interfaces + constants** — Define types, interfaces, constants file
2. **EmbeddingProvider** — Extract current OpenAI logic into provider, add batch support
3. **MemoryStore** — Extract current SQLite logic into provider, add sqlite-vec, new columns
4. **Reranker** — Implement scoring formula as standalone module
5. **Wire up** — Update MCP tools and HTTP endpoints to use new abstractions
6. **New tools** — Add `memory-delete` MCP tool, `re-embed` HTTP endpoint
7. **Tests** — Unit tests for reranker (pure function), integration tests for store + provider

### Open Questions

- **sqlite-vec + Bun compatibility:** ✅ Resolved — fully compatible. See spike results below.
- **Candidate set size:** ✅ Resolved — tunable via constants file. Store must always fetch more candidates than the final requested limit (e.g., 3-5x) to give the reranker enough headroom.
- **file_index TTL:** ✅ Resolved — add a default TTL (e.g., 30d). Access-based decay handles ranking; TTL handles eventual cleanup.
- **Backward compatibility:** ✅ Resolved — starting with `accessCount=0` is acceptable. No special migration handling needed.

### Constraints Identified

- **Architecture boundary:** API server owns DB, workers can't query directly. All memory operations go through HTTP/MCP.
- **Async embedding:** Embeddings are generated after HTTP 202. The store must handle `embedding = NULL` rows gracefully.
- **No breaking changes to existing MCP tools.** `memory-search` and `memory-get` should continue working with the same input/output shape.
- **sqlite-vec maturity risk.** Include fallback path (in-memory cosine) if extension fails to load.

### Spike: sqlite-vec + Bun Compatibility

**Verdict: Production-viable today.**

**bun:sqlite extension loading:**
- `Database.prototype.loadExtension()` works on Linux/Windows out of the box
- macOS requires `Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib")` before creating any DB (Apple disables extensions)
- Docker (Linux): zero extra work

**sqlite-vec (v0.1.8, 2026-03-30):**
- npm package with pre-built binaries for linux-x64, linux-arm64, darwin-x64, darwin-arm64 (including musl/Alpine)
- Bun is explicitly supported — official example exists at `examples/simple-bun/demo.ts`
- Convenience loader: `sqliteVec.load(db)` handles platform detection + `loadExtension()`

**Integration pattern:**
```typescript
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

const db = new Database("agent-swarm-db.sqlite");
sqliteVec.load(db);  // that's it
```

**vec0 virtual table API:**
```sql
-- Create with cosine distance
CREATE VIRTUAL TABLE memory_vec USING vec0(
  embedding float[512] distance_metric=cosine
);

-- KNN search
SELECT rowid, distance
FROM memory_vec
WHERE embedding MATCH ?1 AND k = 20
ORDER BY distance;
```

**Key notes:**
- Float32Array can be passed directly as bind parameters from Bun
- Auxiliary columns (prefixed `+`) can store metadata alongside vectors
- Still 0.x but backed by Mozilla Builders, Fly.io, Turso — API stable since v0.1.0 (Aug 2024)
- Docker: just `bun add sqlite-vec` — postinstall gets the right binary
