---
date: 2026-02-20
planner: Claude
branch: claw-memory
repository: agent-swarm
topic: "Memory System Implementation (Gap 2)"
tags: [plan, memory, embeddings, vector-search, hooks, mcp-tools]
status: complete
autonomy: autopilot
related_research: thoughts/taras/research/2026-02-19-swarm-gaps-implementation.md
last_updated: 2026-02-20
last_updated_by: Claude
---

# Memory System Implementation Plan (Gap 2)

## Overview

Implement a persistent memory system for agent-swarm that allows agents to accumulate knowledge across sessions. Today, agent data is scattered across 7 storage subsystems (see [research](../research/2026-02-19-swarm-gaps-implementation.md#gap-2-memory-system-fs--sqlite-vec--openai-embeddings)) with zero cross-system search. This plan adds:

1. An `agent_memory` table with embedding-based vector search
2. `memory-search` and `memory-get` MCP tools for agents to query their memories
3. File-based auto-indexing via PostToolUse hook (writes to `{personal|shared}/memory/` get indexed)
4. Session summarization at Stop hook (task output/progress → memory)
5. Task completion memory (completed tasks auto-indexed)

## Current State Analysis

**What exists:**
- Agent data scattered across `agents.claudeMd`, `agent_tasks.progress/output`, `agent_log`, `session_logs`, `session_costs`, `/workspace/personal/`, `/workspace/shared/thoughts/` — none searchable cross-system
- Base prompt (`src/prompts/base-prompt.ts:214-219`) tells agents to create `memory.txt` or `memory.db` locally — no server-side automation
- No `openai` package in dependencies — embedding API not available
- No sqlite-vec or FTS5 extensions loaded
- PostToolUse hook (`src/hooks/hook.ts:620-653`) already intercepts Write/Edit for identity file sync — pattern exists to extend

**Key patterns to follow:**
- DB table creation: `CREATE TABLE IF NOT EXISTS` inside `initSchema` transaction (`src/be/db.ts:329-349` for `swarm_config`)
- DB migrations: `try { ALTER TABLE ADD COLUMN } catch { /* exists */ }` (`src/be/db.ts:381-539`)
- Tool registration: `createToolRegistrar(server)` pattern with `inputSchema`/`outputSchema` zod schemas (`src/tools/utils.ts:86-114`)
- Tool return format: `{ content: [{type: "text", text}], structuredContent: {yourAgentId, success, message, ...} }`
- Capability gating: `hasCapability("memory")` check in `src/server.ts:62-64`
- Hook HTTP calls: fire-and-forget to API server (`src/hooks/hook.ts:632-636`)
- Test pattern: isolated SQLite DB per test file, `node:http` handler, `beforeAll`/`afterAll` cleanup (`src/tests/session-attach.test.ts:1-15`)

### Key Discoveries:
- `src/be/db.ts:329-349` — `swarm_config` table uses `CREATE TABLE IF NOT EXISTS` inside init transaction with separate index statements. Memory table should follow same pattern.
- `src/hooks/hook.ts:627-637` — PostToolUse already checks `toolName === "Write" || "Edit"` and `editedPath` for identity sync. Memory indexing extends this exact pattern.
- `src/hooks/hook.ts:666-695` — Stop hook syncs CLAUDE.md and identity files. Session summarization adds a new step here.
- `src/tools/store-progress.ts:104-112` — Task completion (`status === "completed"`) updates agent status. Memory indexing hooks into this point.
- `src/server.ts:55-64` — Capability flags system. Adding `"memory"` to `DEFAULT_CAPABILITIES` string at line 57.
- `src/types.ts:372-386` — `SwarmConfigSchema` is the newest Zod schema. `AgentMemorySchema` follows the same pattern.
- No OpenAI SDK in `package.json` — needs `bun add openai`.

## Desired End State

Agents can:
1. Call `memory-search` with a natural language query and get semantically similar past memories
2. Call `memory-get` to retrieve full details of a specific memory
3. Write files to `/workspace/personal/memory/` or `/workspace/shared/memory/` and have them automatically indexed with embeddings
4. Have their completed task outputs automatically indexed as memories
5. Have session summaries automatically captured at session end

Verified by:
- Unit tests for DB functions, embedding, cosine similarity
- Unit tests for MCP tools against isolated DB
- E2E test: write a file to memory directory → search for it → find it

## Quick Verification Reference

```bash
bun run tsc:check                    # Type check
bun run lint:fix                     # Lint & format
bun test src/tests/memory.test.ts    # Memory unit tests
```

Key files to check:
- `src/be/db.ts` — `agent_memory` table, CRUD functions, dedup
- `src/be/embedding.ts` — Embedding utility, cosine similarity
- `src/be/chunking.ts` — Two-stage markdown-aware text chunker
- `src/tools/memory-search.ts` — MCP search tool (lead-aware)
- `src/tools/memory-get.ts` — MCP get tool
- `src/hooks/hook.ts` — PostToolUse auto-indexing, Stop session summary
- `src/http.ts` — `POST /api/memory/index` ingestion endpoint (chunking + dedup)
- `src/server.ts` — Tool registration with "memory" capability
- `src/types.ts` — `AgentMemorySchema`
- `src/tests/memory.test.ts` — Unit tests

## What We're NOT Doing

- **NOT using sqlite-vec**: Using BLOB storage + JS cosine similarity for simplicity. Works identically on macOS and Linux. Good for <10K vectors. sqlite-vec can be added later as optimization.
- **NOT implementing BM25/hybrid search**: Pure vector search only. Keyword fallback can be added later.
- **NOT implementing memory garbage collection**: Just `createdAt` index for future cleanup.
- **NOT implementing cross-agent automatic propagation**: Agents explicitly choose scope (`agent` vs `swarm`) when writing to personal vs shared memory directories.
- **NOT implementing a `memory-save` MCP tool**: Memory creation happens through file writes (auto-indexed by hook) and automatic task completion indexing. Keeps the agent's workflow natural — write files, not call tools.
- **NOT implementing memory maintenance/curation**: OpenClaw has agents periodically review and curate their memories. We skip this for now — memories accumulate, agents search what they need.

## Implementation Approach

**Embedding strategy**: BLOB storage in regular SQLite table + brute-force cosine similarity in JS. At 512 dimensions (Float32Array), each embedding is 2KB. For 10K memories, that's 20MB of embeddings — fits easily in memory for O(n) search.

**Async indexing**: Hook calls API endpoint (`POST /api/memory/index`) which returns 202 immediately and processes embedding in background. Hooks stay fast, agent is never blocked.

**Scope model**: Memories have `scope: 'agent' | 'swarm'`. Files in `/workspace/personal/memory/` → agent scope. Files in `/workspace/shared/memory/` → swarm scope. **Lead agents see ALL memories (agent + swarm, across all agents)**. Workers see their own agent-scoped + all swarm-scoped memories.

**Embedding provider**: OpenAI `text-embedding-3-small` at 512 dimensions ($0.02/1M tokens). Simple, cheap, well-documented.

**Chunking strategy**: Two-stage markdown-aware splitter. Stage 1: split by markdown headers (`#`, `##`, `###`) to preserve document structure. Stage 2: if any section exceeds 2,000 chars (~500 tokens), apply recursive character splitting with separators `["\n\n", "\n", ". ", " "]`. Overlap of 100 chars between chunks. Files under 2,000 chars are embedded as a single chunk. Min chunk size 50 chars (skip trivially small chunks).

**Deduplication strategy**: When re-indexing a file (same `sourcePath`), use transaction-wrapped delete + re-insert: `DELETE FROM agent_memory WHERE sourcePath = ? AND agentId = ?` followed by batch INSERT of new chunks — all inside `getDb().transaction()`. This follows existing codebase patterns (`deleteServicesByAgentId` + `createSessionLogs`).

**OPENAI_API_KEY placement**: Only needed on the **API server** (`.env` on host). Workers never call OpenAI directly — they POST to the API server which handles embedding server-side. Session summarization uses `claude -p` with `CLAUDE_CODE_OAUTH_TOKEN` (already in worker containers).

---

## Phase 1: Database Schema & Embedding Infrastructure

### Overview
Create the `agent_memory` table, add the `openai` package, implement embedding generation and cosine similarity functions, and DB CRUD operations. This phase is pure infrastructure with no user-facing features.

### Changes Required:

#### 1. Add OpenAI dependency
**Command**: `bun add openai`

#### 2. Create embedding utility
**File**: `src/be/embedding.ts` (new file)
**Changes**: Implement `getEmbedding(text: string): Promise<Float32Array>` using OpenAI `text-embedding-3-small` at 512 dimensions. Implement `cosineSimilarity(a: Float32Array, b: Float32Array): number` for vector comparison. Implement `serializeEmbedding(embedding: Float32Array): Buffer` and `deserializeEmbedding(buffer: Buffer): Float32Array` for BLOB storage.

Key implementation details:
- Strip newlines from input text before embedding (`text.replace(/[\n\r]/g, " ")`)
- Handle API errors gracefully — return null on failure, let caller decide
- `OPENAI_API_KEY` env var required (skip embedding if not set — graceful degradation)

```typescript
// Pseudo-code structure
import OpenAI from "openai";

let openai: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

export async function getEmbedding(text: string): Promise<Float32Array | null> {
  const client = getClient();
  if (!client) return null;
  // Call API, return Float32Array
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number { ... }
export function serializeEmbedding(e: Float32Array): Buffer { ... }
export function deserializeEmbedding(b: Buffer): Float32Array { ... }
```

#### 3. Add `agent_memory` table to database
**File**: `src/be/db.ts`
**Changes**: Add `CREATE TABLE IF NOT EXISTS agent_memory` inside the `initSchema` transaction (after `swarm_config` table at line ~349). Add indexes.

```sql
CREATE TABLE IF NOT EXISTS agent_memory (
  id TEXT PRIMARY KEY,
  agentId TEXT,
  scope TEXT NOT NULL CHECK(scope IN ('agent', 'swarm')),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  embedding BLOB,
  source TEXT NOT NULL CHECK(source IN ('manual', 'file_index', 'session_summary', 'task_completion')),
  sourceTaskId TEXT,
  sourcePath TEXT,
  chunkIndex INTEGER DEFAULT 0,
  totalChunks INTEGER DEFAULT 1,
  tags TEXT DEFAULT '[]',
  createdAt TEXT NOT NULL,
  accessedAt TEXT NOT NULL
)
```

Indexes:
- `idx_agent_memory_agent ON agent_memory(agentId)`
- `idx_agent_memory_scope ON agent_memory(scope)`
- `idx_agent_memory_source ON agent_memory(source)`
- `idx_agent_memory_created ON agent_memory(createdAt)`
- `idx_agent_memory_source_path ON agent_memory(sourcePath)` — needed for deduplication on re-index

#### 4. Add DB CRUD functions
**File**: `src/be/db.ts`
**Changes**: Add functions following existing patterns (e.g., `createSwarmConfig` at line ~4468):

- `createMemory(data: CreateMemoryOptions): AgentMemory` — INSERT with UUID generation
- `getMemoryById(id: string): AgentMemory | null` — SELECT by ID, update `accessedAt`
- `searchMemoriesByVector(queryEmbedding: Float32Array, agentId: string, options?: { scope?, limit?, source?, isLead? }): AgentMemory[]` — Load all matching embeddings, compute cosine similarity in JS, return top-K. When `isLead: true`, return ALL memories across all agents (not just own + swarm).
- `listMemoriesByAgent(agentId: string, options?: { scope?, limit?, offset?, isLead? }): AgentMemory[]` — Paginated list. Lead sees all agents' memories.
- `deleteMemoriesBySourcePath(sourcePath: string, agentId: string): number` — Delete all chunks for a given source path (used for re-indexing)
- `deleteMemory(id: string): boolean` — DELETE by ID
- `getMemoryStats(agentId: string): { total: number, bySource: Record<string, number>, byScope: Record<string, number> }` — Aggregate stats

Internal helpers:
- `rowToAgentMemory(row: AgentMemoryRow): AgentMemory` — Convert DB row to typed object (following `rowToAgent` pattern at `db.ts:731-748`)
- `AgentMemoryRow` type for the raw DB row

#### 5. Add Zod types
**File**: `src/types.ts`
**Changes**: Add `AgentMemorySchema` and derived types after `SwarmConfigSchema` (line ~386):

```typescript
export const AgentMemoryScopeSchema = z.enum(["agent", "swarm"]);
export const AgentMemorySourceSchema = z.enum(["manual", "file_index", "session_summary", "task_completion"]);

export const AgentMemorySchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  scope: AgentMemoryScopeSchema,
  name: z.string().min(1).max(500),
  content: z.string(),
  summary: z.string().nullable(),
  source: AgentMemorySourceSchema,
  sourceTaskId: z.string().uuid().nullable(),
  sourcePath: z.string().nullable(),
  chunkIndex: z.number().int().min(0).default(0),
  totalChunks: z.number().int().min(1).default(1),
  tags: z.array(z.string()),
  createdAt: z.string(),
  accessedAt: z.string(),
});

export type AgentMemoryScope = z.infer<typeof AgentMemoryScopeSchema>;
export type AgentMemorySource = z.infer<typeof AgentMemorySourceSchema>;
export type AgentMemory = z.infer<typeof AgentMemorySchema>;
```

Note: `embedding` is NOT in the Zod schema — it's a BLOB that stays server-side, never serialized to JSON.

#### 6. Create chunking utility
**File**: `src/be/chunking.ts` (new file)
**Changes**: Implement a two-stage markdown-aware chunker.

```typescript
export interface MemoryChunk {
  content: string;
  chunkIndex: number;
  totalChunks: number;
  headings: string[]; // heading hierarchy for context
}

const MAX_CHUNK_SIZE = 2000;  // ~500 tokens
const CHUNK_OVERLAP = 100;    // chars
const MIN_CHUNK_SIZE = 50;    // skip trivially small chunks

export function chunkContent(text: string): MemoryChunk[] { ... }
```

**Stage 1**: Split by markdown headers (`#`, `##`, `###`). Each section under a heading becomes a candidate chunk, preserving heading hierarchy as metadata.

**Stage 2**: If any section exceeds `MAX_CHUNK_SIZE`, apply recursive character splitting with separators `["\n\n", "\n", ". ", " "]` and `CHUNK_OVERLAP` overlap.

**Small files**: If the entire text is under `MAX_CHUNK_SIZE`, return it as a single chunk (no splitting).

Key rules:
- Strip leading/trailing whitespace from chunks
- Skip chunks under `MIN_CHUNK_SIZE` (50 chars)
- Include heading hierarchy in the chunk content as a prefix (e.g., `"## Setup > Prerequisites\n\n..."`) so the embedding captures the section context

#### 7. Unit tests
**File**: `src/tests/memory.test.ts` (new file)
**Changes**: Test DB CRUD operations, cosine similarity, and chunking:

- Test `createMemory` with all fields (including `chunkIndex`, `totalChunks`)
- Test `getMemoryById` returns correct data
- Test `searchMemoriesByVector` with mock embeddings (known similarity values)
- Test `searchMemoriesByVector` with `isLead: true` returns ALL memories across agents
- Test `searchMemoriesByVector` with `isLead: false` returns only own + swarm
- Test `listMemoriesByAgent` pagination
- Test `deleteMemory`
- Test `deleteMemoriesBySourcePath` deletes all chunks for a path
- Test `getMemoryStats`
- Test `cosineSimilarity` with known vectors (orthogonal → 0, identical → 1, opposite → -1)
- Test `serializeEmbedding` / `deserializeEmbedding` roundtrip
- Test scope filtering: agent memories not visible to other agents, swarm memories visible to all
- Test `chunkContent` with small text (no split)
- Test `chunkContent` with markdown headers (splits on headers)
- Test `chunkContent` with oversized section (recursive split)
- Test `chunkContent` skips chunks under 50 chars
- Test `chunkContent` includes heading hierarchy as prefix

Test setup: isolated SQLite DB (`./test-memory.sqlite`), `initDb`/`closeDb` in `beforeAll`/`afterAll`.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Memory tests pass: `bun test src/tests/memory.test.ts`
- [x] All existing tests still pass: `bun test`

#### Manual Verification:
- [x] `agent_memory` table created when starting server: `bun run start:http` then `sqlite3 agent-swarm-db.sqlite ".tables"` shows `agent_memory`
- [x] Embedding function works with valid `OPENAI_API_KEY`: confirmed via POST /api/memory/index — embeddings are 2048 bytes (512 float32s)
- [x] Embedding function returns null when `OPENAI_API_KEY` is not set (graceful degradation) — code path verified via code review (getClient returns null)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 2: MCP Tools (memory-search, memory-get)

### Overview
Create two MCP tools that agents can call to search and retrieve their memories. Register them behind a "memory" capability flag.

### Changes Required:

#### 1. Create memory-search tool
**File**: `src/tools/memory-search.ts` (new file)
**Changes**: Following the tool pattern from `src/tools/get-task-details.ts`:

```typescript
// Input schema:
z.object({
  query: z.string().min(1).describe("Natural language search query."),
  scope: z.enum(["all", "agent", "swarm"]).default("all")
    .describe("Search scope: 'all' (own + swarm), 'agent' (own only), 'swarm' (shared only)."),
  limit: z.number().int().min(1).max(50).default(10)
    .describe("Max results to return."),
  source: z.enum(["file_index", "session_summary", "task_completion", "manual"]).optional()
    .describe("Filter by memory source type."),
})

// Output schema:
z.object({
  yourAgentId: z.string().uuid().optional(),
  success: z.boolean(),
  message: z.string(),
  results: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    summary: z.string().nullable(),
    source: AgentMemorySourceSchema,
    scope: AgentMemoryScopeSchema,
    similarity: z.number(),
    createdAt: z.string(),
  })).optional(),
})
```

Implementation:
1. Validate `requestInfo.agentId` exists
2. Look up agent to determine `isLead` status
3. Call `getEmbedding(query)` for the query
4. If embedding is null (no API key), fall back to listing recent memories
5. Call `searchMemoriesByVector(queryEmbedding, agentId, { scope, limit, source, isLead })`
   - Lead agents see ALL memories (agent-scoped from all agents + swarm)
   - Workers see own agent-scoped + all swarm-scoped
6. Return results with similarity scores, names, summaries (NOT full content — use `memory-get` for that)

#### 2. Create memory-get tool
**File**: `src/tools/memory-get.ts` (new file)
**Changes**: Simple retrieval tool:

```typescript
// Input schema:
z.object({
  memoryId: z.uuid().describe("The ID of the memory to retrieve."),
})

// Output schema:
z.object({
  yourAgentId: z.string().uuid().optional(),
  success: z.boolean(),
  message: z.string(),
  memory: AgentMemorySchema.optional(),
})
```

Implementation:
1. Call `getMemoryById(memoryId)` — this also updates `accessedAt`
2. Return full memory details including content

#### 3. Register tools in server.ts
**File**: `src/server.ts`
**Changes**:
- Add imports for `registerMemorySearchTool` and `registerMemoryGetTool`
- Add `"memory"` to `DEFAULT_CAPABILITIES` string (line 57): `"core,task-pool,messaging,profiles,services,scheduling,epics,memory"`
- Add capability-gated registration block:
  ```typescript
  if (hasCapability("memory")) {
    registerMemorySearchTool(server);
    registerMemoryGetTool(server);
  }
  ```

#### 4. Unit tests
**File**: `src/tests/memory.test.ts` (extend)
**Changes**: Add tests for MCP tool handlers via the HTTP test pattern (following `session-attach.test.ts`):

- Test `memory-search` returns results sorted by similarity
- Test `memory-search` with scope filter (agent-only, swarm-only, all)
- Test `memory-search` fallback when no OPENAI_API_KEY (returns recent memories)
- Test `memory-get` returns full content
- Test `memory-get` with invalid ID returns error
- Test `memory-search` without agentId returns error

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Memory tests pass: `bun test src/tests/memory.test.ts`
- [x] All existing tests still pass: `bun test`

#### Manual Verification:
- [x] Start server, call `memory-search` via MCP curl session — returns results with similarity scores (0.626 for exact match, 0.280 for related, 0.195 for unrelated)
- [x] Call `memory-get` with returned ID — returns full content, agentId, scope, source, timestamps
- [x] Verify "memory" appears in capabilities list — `tools/list` shows `memory-search` and `memory-get`

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 3: Memory Ingestion API & Hook Auto-Indexing

### Overview
Add a server-side API endpoint for memory ingestion (async embedding + storage), then extend the PostToolUse hook to detect file writes to memory directories and trigger indexing.

### Changes Required:

#### 1. Add memory ingestion API endpoint
**File**: `src/http.ts`
**Changes**: Add `POST /api/memory/index` endpoint (following the REST pattern used by existing endpoints):

Request body:
```json
{
  "agentId": "uuid",
  "content": "file content or text to index",
  "name": "human-readable label",
  "scope": "agent" | "swarm",
  "source": "file_index" | "session_summary" | "task_completion" | "manual",
  "sourceTaskId": "uuid (optional)",
  "sourcePath": "/workspace/personal/memory/something.md (optional)",
  "tags": ["optional", "tags"]
}
```

Response: `202 Accepted` with `{ queued: true, memoryIds: ["uuid1", "uuid2", ...] }`

Implementation:
1. Validate required fields
2. **Dedup**: If `sourcePath` is provided, delete all existing chunks for `(sourcePath, agentId)` inside a transaction
3. **Chunk**: Call `chunkContent(content)` to split into chunks (most files will be 1 chunk)
4. Create memory records in DB for each chunk (without embedding), inside same transaction
5. Kick off async embedding for each chunk: `processChunkEmbeddings(memoryIds, chunks)` — no `await`
6. Return 202 with the memory IDs

The dedup + insert transaction:
```typescript
const memoryIds = getDb().transaction(() => {
  // Delete old chunks if re-indexing same file
  if (sourcePath && agentId) {
    deleteMemoriesBySourcePath(sourcePath, agentId);
  }

  const chunks = chunkContent(content);
  const ids: string[] = [];
  for (const chunk of chunks) {
    const memory = createMemory({
      agentId, content: chunk.content, name,
      scope, source, sourcePath,
      chunkIndex: chunk.chunkIndex,
      totalChunks: chunk.totalChunks,
      tags,
    });
    ids.push(memory.id);
  }
  return ids;
})();
```

The async embedding function:
```typescript
async function processChunkEmbeddings(memoryIds: string[], chunks: MemoryChunk[]): Promise<void> {
  for (let i = 0; i < chunks.length; i++) {
    try {
      const embedding = await getEmbedding(chunks[i].content);
      if (embedding) {
        updateMemoryEmbedding(memoryIds[i], serializeEmbedding(embedding));
      }
    } catch (err) {
      console.error(`[memory] Failed to embed chunk ${memoryIds[i]}:`, (err as Error).message);
    }
  }
}
```

#### 2. Add `updateMemoryEmbedding` DB function
**File**: `src/be/db.ts`
**Changes**: Simple UPDATE for the embedding BLOB:
```typescript
export function updateMemoryEmbedding(id: string, embedding: Buffer): void {
  getDb().prepare("UPDATE agent_memory SET embedding = ? WHERE id = ?").run(embedding, id);
}
```

#### 3. Extend PostToolUse hook for memory auto-indexing
**File**: `src/hooks/hook.ts`
**Changes**: After the existing identity file sync block (line 637), add memory directory detection:

```typescript
// Auto-index files written to memory directories
if (
  (toolName === "Write" || toolName === "Edit") &&
  editedPath &&
  (editedPath.startsWith("/workspace/personal/memory/") ||
   editedPath.startsWith("/workspace/shared/memory/"))
) {
  try {
    const fileContent = await Bun.file(editedPath).text();
    const isShared = editedPath.startsWith("/workspace/shared/");
    const fileName = editedPath.split("/").pop() ?? "unnamed";

    await fetch(`${apiUrl}/api/memory/index`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Agent-ID": agentInfo.id,
      },
      body: JSON.stringify({
        agentId: agentInfo.id,
        content: fileContent,
        name: fileName.replace(/\.\w+$/, ""), // strip extension
        scope: isShared ? "swarm" : "agent",
        source: "file_index",
        sourcePath: editedPath,
      }),
    });
  } catch {
    // Non-blocking — don't interrupt the agent's workflow
  }
}
```

This means when an agent does `Write("/workspace/personal/memory/auth-fix.md", "...")`, the hook:
1. Reads the file content
2. POSTs to the API for async embedding + indexing
3. The agent is never blocked

#### 4. Ensure memory directories exist
**File**: `docker-entrypoint.sh`
**Changes**: Add `mkdir -p /workspace/personal/memory /workspace/shared/memory` in the workspace directory creation section (around line ~303-347).

#### 5. Unit tests
**File**: `src/tests/memory.test.ts` (extend)
**Changes**:
- Test `POST /api/memory/index` endpoint creates memory records (possibly multiple chunks)
- Test that memory is created even without OPENAI_API_KEY (just no embedding)
- Test `updateMemoryEmbedding` correctly stores and retrieves embedding BLOB
- Test dedup: POST same `sourcePath` twice → old chunks deleted, new chunks created
- Test chunking: POST large content → creates multiple chunk records with correct `chunkIndex`/`totalChunks`
- Test that small content (<2000 chars) creates a single chunk

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Memory tests pass: `bun test src/tests/memory.test.ts`
- [x] All existing tests still pass: `bun test`

#### Manual Verification:
- [x] Start server with `OPENAI_API_KEY` set, POST to `/api/memory/index` via curl — returns 202 with memoryIds
- [x] Verify embedding column is populated after async processing — all 8 test memories have 2048-byte embeddings
- [x] Dedup verified: re-POST same sourcePath replaces old record (count stays 1, content updated)
- [x] Large content chunking verified: 5-section markdown → 5 chunks with correct chunkIndex/totalChunks
- [x] In Docker: write a file to `/workspace/personal/memory/api-patterns.md` — auto-indexed as `file_index` memory with embedding (2048 bytes)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 4: Task Completion & Session Summarization

### Overview
Automatically index completed task outputs as memories and capture session summaries at Stop hook.

### Changes Required:

#### 1. Extend store-progress for task completion memory
**File**: `src/tools/store-progress.ts`
**Changes**: After the task completion block (line 104-112), add async memory indexing:

```typescript
if (status === "completed") {
  const result = completeTask(taskId, output);
  if (result) {
    updatedTask = result;
    if (existingTask.agentId) {
      updateAgentStatusFromCapacity(existingTask.agentId);
    }
    // Index completed task as memory (async, non-blocking)
    indexTaskCompletionMemory(existingTask, output).catch(() => {});
  }
}
```

The `indexTaskCompletionMemory` function (can be in `src/be/memory.ts` or inline):
1. Compose content from task description + output
2. Create memory with `source: 'task_completion'`, `sourceTaskId: task.id`
3. Generate embedding async

Note: This can also be done as an HTTP call to `/api/memory/index` (keeping the embedding logic centralized), or directly via DB functions since store-progress runs server-side.

#### 2. Extend Stop hook for session summarization (via Claude Haiku)
**File**: `src/hooks/hook.ts`
**Changes**: In the Stop handler (line 674-683), after syncing CLAUDE.md and identity files, add real session summarization using `claude -p --model haiku`.

The hook has access to `msg.transcript_path` (the full session transcript) and optionally `process.env.TASK_FILE` (the current task). This should work in ALL cases — even when there's no task file (e.g., lead agent sessions, ad-hoc sessions).

**Flow:**
1. Read the transcript from `msg.transcript_path` (truncate to last ~20K chars if too large)
2. Optionally read task context from `TASK_FILE` (if available)
3. Call `claude -p --model haiku` to generate a structured summary
4. POST the summary to `/api/memory/index` with `sourceTaskId` as optional

```typescript
// Session summarization via Claude Haiku
if (agentInfo?.id && msg.transcript_path) {
  try {
    // 1. Read transcript (truncated to last ~20K chars)
    let transcript = "";
    try {
      const fullTranscript = await Bun.file(msg.transcript_path).text();
      transcript = fullTranscript.length > 20000
        ? fullTranscript.slice(-20000)
        : fullTranscript;
    } catch { /* no transcript */ }

    if (transcript.length > 100) { // Skip trivial sessions
      // 2. Optionally read task context
      let taskContext = "";
      let taskId: string | undefined;
      const taskFile = process.env.TASK_FILE;
      if (taskFile) {
        try {
          const taskData = JSON.parse(await Bun.file(taskFile).text());
          taskContext = `Task: ${taskData.task || "Unknown"}`;
          taskId = taskData.id;
        } catch { /* no task file — that's fine */ }
      }

      // 3. Summarize with Claude Haiku (pipe transcript via stdin)
      const summarizePrompt = [
        "Summarize this agent session transcript concisely. Output ONLY the summary, no preamble.",
        "Format as 3-7 bullet points covering:",
        "- What was accomplished",
        "- Key decisions made",
        "- Problems encountered and solutions found",
        "- Learnings useful for future sessions",
        taskContext ? `\nTask context: ${taskContext}` : "",
        `\nTranscript:\n${transcript}`,
      ].filter(Boolean).join("\n");

      // Write prompt to temp file and pipe to claude (avoids shell arg length issues)
      const tmpFile = `/tmp/session-summary-${Date.now()}.txt`;
      await Bun.write(tmpFile, summarizePrompt);
      const result = await Bun.$`cat ${tmpFile} | claude -p --model haiku --output-format json`
        .quiet()
        .timeout(30000); // 30s timeout
      await Bun.$`rm -f ${tmpFile}`.quiet();

      const summaryOutput = JSON.parse(result.stdout.toString());
      const summary = summaryOutput.result ?? result.stdout.toString();

      if (summary && summary.length > 20) {
        // 4. Index as memory (async, non-blocking)
        await fetch(`${apiUrl}/api/memory/index`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "X-Agent-ID": agentInfo.id,
          },
          body: JSON.stringify({
            agentId: agentInfo.id,
            content: summary,
            name: taskContext
              ? `Session: ${taskContext.slice(0, 80)}`
              : `Session: ${new Date().toISOString().slice(0, 16)}`,
            scope: "agent",
            source: "session_summary",
            ...(taskId ? { sourceTaskId: taskId } : {}),
          }),
        });
      }
    }
  } catch {
    // Non-blocking — session summarization failure should never block shutdown
  }
}
```

**Key design decisions:**
- Uses `claude -p --model haiku` — fast (~2-5s), cheap, runs inside the container where Claude CLI is installed
- Prompt written to temp file and piped via stdin (avoids shell argument length limits with large transcripts)
- 30s timeout to avoid blocking shutdown indefinitely
- Works without a task file (for lead sessions, ad-hoc work, etc.)
- `sourceTaskId` is optional — null for sessions without a task
- Session memories are **always `scope: 'agent'`** and linked to the specific agent's ID. Lead agents can see all session memories from all agents via the `isLead` search path.
- Transcript truncated to last 20K chars to stay within haiku's context and keep cost minimal
- Output format is JSON to reliably extract the result
- Uses `CLAUDE_CODE_OAUTH_TOKEN` (already in container) — does NOT need `OPENAI_API_KEY` (that's on the API server side for embedding)

#### 3. Unit tests
**File**: `src/tests/memory.test.ts` (extend)
**Changes**:
- Test that completing a task via `store-progress` creates a memory with `source: 'task_completion'`
- Test that trivial task outputs (short content) are not indexed
- Test the memory ingestion API with optional `sourceTaskId` (null allowed)
- Test that the session summary content structure is correct (mock the claude call in tests)

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Memory tests pass: `bun test src/tests/memory.test.ts`
- [x] All existing tests still pass: `bun test`

#### Manual Verification:
- [x] Complete a task via `store-progress` MCP tool — `task_completion` memory created with embedding (2048 bytes)
- [x] Stop a Docker session, verify `session_summary` memory — Haiku generates bullet-point summaries (accomplishments, workflow, blockers)
- [x] Stop a session without a task file (lead agent) — summarization works, uses date-based name (`Session: 2026-02-20T11:39`), no sourceTaskId
- [x] Search for session content via `memory-search` — "Redis caching TTL" query returns task completion memory at 0.626 similarity
- [x] Summarization doesn't significantly delay shutdown — Haiku responds in ~5-10s, 30s timeout as safety net
- [x] **Bug found & fixed**: Stop hook spawning `claude -p --model haiku` triggered recursive hook invocation (fork bomb). Fixed with `SKIP_SESSION_SUMMARY` env var guard.

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 5: Prompt & Template Updates

### Overview
Update the agent prompts and templates to inform agents about the memory system and how to use it.

### Changes Required:

#### 1. Update base prompt memory section
**File**: `src/prompts/base-prompt.ts`
**Changes**: Replace the existing `#### Memory` section (lines 214-219) with updated instructions inspired by [OpenClaw's AGENTS.md](https://github.com/openclaw/openclaw/blob/main/docs/reference/templates/AGENTS.md) "Write It Down" philosophy:

```markdown
#### Memory

**Your memory is limited — if you want to remember something, WRITE IT TO A FILE.**
Mental notes don't survive session restarts. Files do. Text > Brain.

**Session boot:** At the start of each session, use `memory-search` to recall relevant context for your current task. Your past learnings are searchable.

**Saving memories:** Write important learnings, patterns, decisions, and solutions to files in your memory directories. They are automatically indexed and become searchable via `memory-search`:
- `/workspace/personal/memory/` — Private to you, searchable only by you
- `/workspace/shared/memory/` — Shared with all agents, searchable by everyone

When you solve a hard problem, fix a tricky bug, or learn something about the codebase — write it down immediately. Don't wait until the end of the session.

Example: `Write("/workspace/personal/memory/auth-header-fix.md", "The API requires Bearer prefix on all auth headers. Without it, you get a misleading 403 instead of 401.")`

**Memory tools:**
- `memory-search` — Search your memories with natural language queries. Returns summaries with IDs.
- `memory-get` — Retrieve full details of a specific memory by ID.

**What gets auto-indexed (no action needed from you):**
- Files written to the memory directories above (via PostToolUse hook)
- Completed task outputs (when you call store-progress with status: completed)
- Session summaries (captured automatically when your session ends)

**When to write memories:**
- You solved a problem → write the solution
- You learned a codebase pattern → write the pattern
- You made a mistake → write what went wrong and how to avoid it
- Someone says "remember this" → write it down
- You discovered an important configuration → write it

You also still have `/workspace/personal/` for general file persistence and `sqlite3` for local structured data.
```

#### 2. Update default CLAUDE.md template
**File**: `src/be/db.ts`
**Changes**: In `generateDefaultClaudeMd()` (line ~2200), add a memory section to the template. Inspired by OpenClaw's two-tier approach (daily logs + curated memory):

```markdown
### Memory
- Use `memory-search` to recall past experience before starting new tasks
- Write important learnings to `/workspace/personal/memory/` files
- Share useful knowledge to `/workspace/shared/memory/` for the swarm
```

#### 3. Add OPENAI_API_KEY to env documentation
**File**: `.env.example` (or `.env` if no `.env.example` exists)
**Changes**: Add `OPENAI_API_KEY=` with a comment:
```bash
# Memory system - OpenAI embeddings (API server only, NOT needed in workers)
# Optional: system works without it but memory search degrades to recency-based
OPENAI_API_KEY=
```

**Important**: This goes in the **API server's** `.env` only. Do NOT add to `.env.docker` or `.env.docker-lead` — workers don't call OpenAI directly. Workers POST to the API server which handles embedding server-side. Session summarization in workers uses `claude -p` with the existing `CLAUDE_CODE_OAUTH_TOKEN`.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test`

#### Manual Verification:
- [x] Start a fresh agent (join-swarm), verify the default CLAUDE.md includes memory instructions — confirmed: "Memory" section with `memory-search` guidance
- [x] Check the system prompt includes updated memory tool documentation — confirmed: base-prompt.ts has memory-search, memory-get, auto-indexed docs
- [x] Verify `.env.example` documents `OPENAI_API_KEY` — confirmed at line 44

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Testing Strategy

### Unit Tests (`src/tests/memory.test.ts`)
- Isolated SQLite DB (`./test-memory.sqlite`)
- Test all DB CRUD functions with known data
- Test cosine similarity with mathematically verifiable vectors
- Test embedding serialization/deserialization roundtrip
- Mock OpenAI API calls for tool tests (or use known pre-computed embeddings)
- Test scope filtering (agent vs swarm visibility)
- Test memory ingestion endpoint
- Test store-progress memory creation

### Integration Tests
- MCP tool tests via HTTP handler (following `session-attach.test.ts` pattern)
- Memory search with pre-seeded embeddings
- Memory get with valid/invalid IDs

### Manual E2E
```bash
# 1. Start API server
OPENAI_API_KEY=sk-... bun run start:http

# 2. Create a memory via API
curl -X POST http://localhost:3013/api/memory/index \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -H "X-Agent-ID: $(uuidgen)" \
  -d '{"agentId":"<agent-uuid>","content":"The auth header needs Bearer prefix","name":"auth-fix","scope":"agent","source":"manual"}'

# 3. Wait 2s for async embedding
sleep 2

# 4. Verify memory exists
sqlite3 agent-swarm-db.sqlite "SELECT id, name, source, length(embedding) FROM agent_memory"

# 5. Search via MCP tool (requires MCP session - see CLAUDE.md "MCP Tool Testing")
# Initialize session, then:
curl -s -X POST http://localhost:3013/mcp \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Agent-ID: <agent-uuid>" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory-search","arguments":{"query":"authentication header","limit":5}}}'

# 6. Docker E2E (full hook integration)
# Build worker: docker build -f Dockerfile.worker -t agent-swarm-worker:memory .
# Start worker, create a task that writes to /workspace/personal/memory/
# Verify memory appears in DB after task completes
```

## References

- **Research document**: [`thoughts/taras/research/2026-02-19-swarm-gaps-implementation.md`](../research/2026-02-19-swarm-gaps-implementation.md) — Gap 2: Memory System section (lines 88-221)
- **Related research**: [`thoughts/taras/research/2026-02-19-agent-native-swarm-architecture.md`](../research/2026-02-19-agent-native-swarm-architecture.md) — OpenClaw's self-learning loop analysis
- **Identity implementation (Gap 1)**: [`thoughts/taras/plans/2026-02-20-worker-identity.md`](2026-02-20-worker-identity.md) — Pattern reference for the identity system this builds on
- **Session attachment (Gap 3)**: [`thoughts/taras/plans/2026-02-20-session-attach.md`](2026-02-20-session-attach.md) — Session continuity that memory enhances
