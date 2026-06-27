---
date: 2026-06-25
researcher: Claude (for Taras)
git_commit: 060c891107765dbb31704b81d2a21f539b35b55d
branch: main
repository: desplega-ai/agent-swarm
topic: "Memory subsystem — tools/APIs, FS-vs-DB storage, and how create / search / structure work"
tags: [research, codebase, memory, embeddings, sqlite-vec, reranker, memory-graph]
status: complete
autonomy: verbose
last_updated: 2026-06-25
last_updated_by: Claude (for Taras)
---

# Research: Memory subsystem — tools/APIs, storage, and the three maps

**Date**: 2026-06-25
**Researcher**: Claude (for Taras)
**Git Commit**: 060c891107765dbb31704b81d2a21f539b35b55d
**Branch**: main

## Research Question

1. What tools / APIs do we have for memory?
2. How does it work in terms of what comes to files from the FS vs what is stored in the DB?
3. Three maps:
   - **Map 1** — How memory is *created / updated*
   - **Map 2** — How memory is *searched* (all dimensions: semantic, words, name)
   - **Map 3** — How memory is *structured* (name/path structure, edges, etc.)

> Scope note (per Verbose check-in): name/path is documented in **both** senses (schema columns + any hierarchical naming), and the rater / usefulness-scoring system is **mentioned** where it touches ranking but not deep-dived.

---

## Summary

**Storage is 100% SQLite. Nothing in the memory subsystem is backed by the filesystem.** Content, summaries, tags, embeddings (both as a BLOB column *and* in a `sqlite-vec` virtual table), edges, the deterministic link graph, retrieval audit logs, and rating audit logs all live in the DB. The filesystem only appears as a *source*: when an agent edits a "memory file" in its workspace, a worker hook reads that file and POSTs its content to the API, which chunks and indexes it into the DB (`source='file_index'`). The only external dependency is the OpenAI embeddings HTTP API, whose responses are written straight back into SQLite — there is no on-disk embedding cache.

**The API server is the sole owner of the DB.** Workers never write SQLite directly; they go over HTTP with the swarm API key + `X-Agent-ID`. The MCP tools `memory-search` / `memory-get` / `memory-delete` / `inject-learning` are registered on the *API server's own* MCP instance, so they call the store in-process; only `memory_rate` makes an outbound HTTP call. There are **5 MCP tools** and **10 HTTP endpoints**.

**Two findings that matter most for your mental model:**
- **Search is vector-only.** There is *no* keyword / FTS5 / BM25 / substring search over memory content. The "words" dimension you asked about **does not exist**. Exact-match exists only as by-`id` lookup (`memory-get`) and an internal exact-`name` lookup used by the wikilink resolver. Everything else is cosine-similarity semantic search with an in-process reranker.
- **Creation is INSERT-only with no dedup** (except a path-based delete-then-insert when re-indexing a file). Every `store()` mints a fresh UUID; there is no `(name, scope, agentId)` uniqueness and no upsert.

The runbook (`runbooks/memory-system.md`) documents up to **v1.5**. The live code is **ahead of it**: migration `096_memory_graph_phase1` added a second, multi-type link graph (`memory_link`) plus `contextKey` columns, migration `097` added retrieval grouping (`retrievalId` + `rank`), and `boot-reembed.ts` + `link-resolver.ts` are newer than the runbook. This document treats the live code as primary source.

---

## The big picture: FS vs DB

```
┌─────────────────────────── FILESYSTEM (source only) ──────────────────────────┐
│  Agent workspace "memory files" (under /workspace/{personal,shared}/memory/)   │
│        │  worker hook detects edit (hook.ts:1200 / pi-mono-extension.ts:194)   │
└────────┼───────────────────────────────────────────────────────────────────────┘
         │  HTTP POST /api/memory/index  (Bearer + X-Agent-ID), source='file_index'
         ▼
┌─────────────────────────────── API SERVER (sole DB owner) ────────────────────┐
│                                                                                │
│   OpenAI Embeddings API  ◄──── embed(text) ────  (text-embedding-3-small, 512d)│
│        │ Float32Array                                                          │
│        ▼  serialized to Buffer, written back into DB (never to disk)           │
│                                                                                │
│   ┌──────────────────────────── SQLite (WAL) ────────────────────────────┐    │
│   │  agent_memory        content, summary, tags, embedding BLOB, scope,   │    │
│   │                      name, alpha/beta, expiresAt, accessCount, ...     │    │
│   │  memory_vec (vec0)   embedding float[512] cosine — KNN index          │    │
│   │  agent_memory_edge   v1.5 references-source edges (Beta posteriors)    │    │
│   │  memory_link         v096 multi-type deterministic link graph         │    │
│   │  memory_retrieval    read-side audit (which memory surfaced to whom)  │    │
│   │  memory_rating       rating audit (alpha/beta deltas)                 │    │
│   └────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Citations: file→DB ingest `src/http/memory.ts:283-381`; embedding serialize `src/be/embedding.ts:30-42`; vec table `src/be/memory/providers/sqlite-store.ts:116-121`. "No markdown-file / blob / `.jsonl` backing for any memory data in this layer" — confirmed by the structure agent.

### What are the "memory files"? (path/name structure + source) — *answers review comment*

The `file_index` source comes from agent **workspace memory files**. There is no special format — just files an agent writes/edits under two conventional directories, detected by a `PostToolUse` hook on every `Write`/`Edit`:

| Workspace path prefix | → scope | Detected by |
|---|---|---|
| `/workspace/personal/memory/…` | `agent` (private) | hook checks `editedPath.startsWith(...)` |
| `/workspace/shared/memory/…` | `swarm` (global) | same, shared prefix |

- It's a **directory-prefix** convention — *not* a `*.md` glob, and *not* `CLAUDE.md`/`AGENTS.md`. Any file an agent saves under those dirs gets indexed (per file save, not at session end).
- **Field mapping at index time:** `name` = filename with extension stripped (`fileName.replace(/\.\w+$/, "")`); `sourcePath` = full absolute path; `content` = the file's full text (`Bun.file(path).text()`); `source = "file_index"`; `scope = editedPath.startsWith("/workspace/shared/") ? "swarm" : "agent"`.
- Re-saving the same file **replaces** its prior chunks (`deleteBySourcePath` dedup, `src/http/memory.ts:323-325`).
- Implemented per harness — **Claude** `src/hooks/hook.ts:1186-1219`, **Pi** `src/providers/pi-mono-extension.ts:188-209` (guard `:599-603`), **OpenCode** `plugin/opencode-plugins/agent-swarm.ts:133-154` (guard `:246-252`). **Codex does NOT index files** — its only memory write is a `session_summary` at end-of-turn (`src/providers/codex-adapter.ts:1145-1223`).

---

## Tools & APIs catalogue

### MCP tools (5) — `src/tools/memory-*.ts` + `inject-learning.ts`

| Tool name (verbatim string) | File:line | Inputs | Does | DB access |
|---|---|---|---|---|
| `memory-search` | `src/tools/memory-search.ts:18` | `query` (req), `intent` (req), `scope` (`all`\|`agent`\|`swarm`, def `all`), `limit` (1–50, def 10), `source?` | Semantic search; returns summaries + IDs | **In-process** store |
| `memory-get` | `src/tools/memory-get.ts:11` | `memoryId` (uuid, req), `intent` (req) | Full content of one memory by ID | **In-process** store |
| `memory-delete` | `src/tools/memory-delete.ts:7` | `memoryId` (uuid, req) | Delete by ID (own; leads also swarm-scoped) | **In-process** store |
| `memory_rate` (underscore) | `src/tools/memory-rate.ts:34` | `id` (req), `useful` (bool, req), `note?` (≤280), `referencesSource?` (≤512) | Rate a retrieved memory useful/misleading | **HTTP** → `POST /api/memory/rate` |
| `inject-learning` | `src/tools/inject-learning.ts:14` | `agentId` (uuid target), `learning` (req), `category` (enum) | **Lead-only** — push a learning into a worker's memory as `swarm`/`manual` | **In-process** store (`store.store`) |

> **No glob/grep over memory (answers review comment).** There is **no search-by-name and no search-by-raw-content** — no `LIKE`, no FTS5/BM25, no substring match on `name` or `content` anywhere. The only non-semantic lookups are: exact by-`id` (`memory-get`), an *internal* exact-`name` match used only by the wikilink resolver (`link-resolver.ts:172-174`, not agent-facing), and a `sourcePath` substring filter exposed only on the admin `POST /api/memory/list` endpoint. Everything an agent can search is the cosine-similarity semantic path. See **Map 2** for the full breakdown.

Registration: all 5 inside one `if (hasCapability("memory"))` block — `src/server.ts:297-304`. No per-tool env gating (e.g. `memory_rate` is *not* behind `MEMORY_RATERS`; its guards are agent-ID + task-context presence). Permission gating is in-handler: `memory-delete` owner-or-lead, `inject-learning` lead-only.

Scripts-runtime exposure (`src/scripts-runtime/sdk-allowlist.ts:2-7`): all 5 are in `SDK_TOOL_NAME_MAP` and callable from user scripts as `memory_search`, `memory_get`, `memory_rate`, `memory_delete`, `inject_learning`.

### HTTP endpoints (10) — `src/http/memory.ts`

| Method + path | Auth | Route def | Purpose |
|---|---|---|---|
| `POST /api/memory/index` | none declared | `:25-47` | **Create/ingest**: chunk content → `storeBatch` → async embed. Returns `202 {queued, memoryIds}` (see input schema below) |
| `POST /api/memory/search` | apiKey + agentId | `:49-73` | Worker-facing semantic search (`isLead:false`) |
| `POST /api/memory/re-embed` | apiKey | `:75-93` | Re-embed all/agent memories with current provider |
| `POST /api/memory/list` | apiKey | `:95-125` | Debug/admin: semantic (if `query`) or recency list (`isLead:true`) |
| `GET /api/memory/health` | apiKey | `:127-137` | Vector index health + `retrievalMode` |
| `DELETE /api/memory/{id}` | apiKey | `:139-151` | Delete one memory |
| `GET /api/memory/{id}` | apiKey + agentId | `:153-174` | Get one memory by ID; logs a retrieval row |
| `POST /api/memory/rate` | apiKey + agentId | `:217-232` | Ingest `RateEvent[]` (`source` ∈ `{llm, explicit-self}` only) |
| `GET /api/memory/retrievals` | apiKey + agentId | `:234-253` | Which memories surfaced to a task/session |
| `GET /api/memory/edges` | apiKey + agentId | `:259-273` | List `references-source` edges for a memory |

> Routes 6 & 7 share pattern `["api","memory",null]`, disambiguated by HTTP method.

**`POST /api/memory/index` input (answers review comment)** — request body (`src/http/memory.ts:31-42`):

| Field | Type | Req | Notes |
|---|---|---|---|
| `content` | string (min 1) | ✅ | the text to index (gets chunked) |
| `name` | string (min 1) | ✅ | memory name |
| `scope` | `agent` \| `swarm` | ✅ | visibility |
| `source` | `manual`\|`file_index`\|`session_summary`\|`task_completion` | ✅ | provenance |
| `agentId` | uuid | — | owning agent |
| `sourceTaskId` | uuid | — | origin task |
| `sourcePath` | string | — | origin file path (also drives delete-then-insert dedup) |
| `tags` | string[] | — | stored as JSON (see tags note in Map 3) |
| `persistMemory` | boolean | — | opt-in override for the automatic-task memory gate |
| `contextKey` | string | — | grouping key; also read from `X-Context-Key` header |

Returns `202 {queued: true, memoryIds: string[]}`, or `{queued: false, skipped: "automatic_task_memory_disabled"}` when the automatic-task gate blocks a `session_summary`.

**Tool ↔ endpoint mapping:** the read/delete/inject MCP tools resolve `getMemoryStore()` in-process (they run *on* the API server) — they do **not** call the HTTP endpoints. The HTTP search/get/index endpoints are the worker/UI-facing equivalents. `memory_rate` is the sole tool that crosses HTTP (→ `POST /api/memory/rate`, `src/tools/memory-rate.ts:112-120`).

**Is there a generic "store memory" tool?** No. No `memory_store`/`memory_upsert` MCP tool and no bare `POST /api/memory` create route. Creation is only: (a) `inject-learning` MCP tool (lead-only, one memory), or (b) `POST /api/memory/index` (the ingest endpoint used by `store-progress` and file-indexing).

---

## Map 1 — How memory is CREATED / UPDATED

### Create entry points

| Trigger | Path | Source | Scope |
|---|---|---|---|
| **Task completion/failure** (server-side, inside `store-progress` MCP tool) | `src/tools/store-progress.ts:344-398` → `store.store()` | `task_completion` | `agent` (+ optional `swarm` auto-promote) |
| **HTTP ingest** | `src/http/memory.ts:283-381` → `store.storeBatch()` (`:335`) | caller-supplied | caller-supplied |
| **Lead injects learning** (MCP tool) | `src/tools/inject-learning.ts:73-79` → `store.store()` | `manual` | `swarm` |
| **Worker session summary** (HTTP client → ingest) | `src/hooks/hook.ts:368` (claude); codex/pi/opencode equivalents | `session_summary` | `agent` |
| **Worker memory-file edit** (HTTP client → ingest) | `src/hooks/hook.ts:1200`, `src/providers/pi-mono-extension.ts:194` | `file_index` | `agent`/`swarm` |

### Canonical CREATE flow (task completion via `store-progress`)

```
1. Agent calls MCP `store-progress` {taskId, status:"completed", output}   store-progress.ts:84
2. DB txn flips task status, emits BU "completed" event                    store-progress.ts:105-326
3. Gate: shouldRunTerminalSideEffects && shouldPersistTaskCompletionMemory  store-progress.ts:340-343
        (skips automatic/recurring tasks: schedule, heartbeat, monitor…)    automatic-task-gate.ts:2-47
4. (async, fire-and-forget) build content + name by STRING CONCAT (no LLM):
        content = `Task: …\n\nOutput:\n…`                                   store-progress.ts:346-349
        name    = `Task: ${task.slice(0,80)}`                               store-progress.ts:360
        (skip if content < 30 chars)                                        store-progress.ts:352
5. INSERT row: store.store(...)  id = crypto.randomUUID(), scope=agent,
        source=task_completion, expiresAt = now + 7d                        sqlite-store.ts:236-291
6. Embed: provider.embed(content)  → 512-d Float32Array (OpenAI)            openai-embedding.ts:41-70
7. Write embedding: store.updateEmbedding(id, embedding, model)
        UPDATE agent_memory SET embedding,embeddingModel
        + DELETE/INSERT memory_vec                                          sqlite-store.ts:659-683
8. (optional) auto-promote to swarm: if research task OR tags
        include "knowledge"/"shared" → 2nd store.store + embed              store-progress.ts:370-394
9. (separate async) server raters fire from retrievals → applyRating
        → alpha/beta bump                                                   store-progress.ts:413-434
```

Key facts:
- **No LLM is used to extract/name memories in `store-progress`** — content and name are deterministic string concatenations. The LLM rater only runs later in the rating path.
- **Embedding is deferred/async**: the row is inserted first and returned immediately; embedding is computed and written fire-and-forget afterward. The ingest endpoint literally returns `202 {queued}` before embedding (`src/http/memory.ts:335-379`).
- Provider/model: `text-embedding-3-small` by default (`EMBEDDING_MODEL` env override), **512 dimensions** (`EMBEDDING_DIMENSIONS`, `src/be/memory/constants.ts:63`). Key from `EMBEDDING_API_KEY ?? OPENAI_API_KEY`; if absent, embed returns `null` and the memory stays content-only (searchable only via recency fallback).

### Name / key generation (all deterministic, never a hash slug, never LLM)

| Path | Name template | File:line |
|---|---|---|
| task completion | `` `Task: ${task.slice(0,80)}` `` | `store-progress.ts:360` |
| swarm promote | `` `Shared: ${task.slice(0,80)}` `` | `store-progress.ts:382` |
| inject-learning | `` `Lead feedback: ${category} — ${learning.slice(0,60)}` `` | `inject-learning.ts:76` |
| session summary | `` `Session: ${ctx.slice(0,80)}` `` or ISO timestamp | `hook.ts:378-380` |
| file index | filename with extension stripped | `hook.ts:1210` |
| HTTP ingest | required request-body field `name` | `src/http/memory.ts:34` |

### Insert vs upsert / dedup

- **INSERT-only.** `store()` always mints `crypto.randomUUID()` and runs `INSERT … RETURNING *` (`sqlite-store.ts:237, 265`). No `ON CONFLICT`, no upsert.
- The *only* dedup is **path-based delete-then-insert**, only on the HTTP ingest path, only when `sourcePath` + `agentId` are present: `deleteBySourcePath()` wipes the file's prior chunks before re-inserting (`src/http/memory.ts:322-325`, `sqlite-store.ts:600-623`). So re-indexing a file replaces it; `store-progress`/`inject-learning` just accumulate rows.

### Update paths (existing rows)

| Update | Mechanism | File:line |
|---|---|---|
| Embedding write/refresh | `updateEmbedding()` → `agent_memory.embedding` + rewrite `memory_vec` row | `sqlite-store.ts:659-683` |
| Access-count bump | `get(id)`: `UPDATE … accessedAt=?, accessCount=accessCount+1` (note `peek()` does NOT bump; vector search does NOT bump) | `sqlite-store.ts:312-315` |
| alpha/beta posteriors | `applyRating()`: `UPDATE … alpha=alpha+?, beta=beta+?` + audit row in `memory_rating` (+ optional edge upsert) | `src/be/memory/raters/store.ts:96-134` |
| Expiry / GC | `expiresAt` set once at insert (never refreshed); `purgeExpired()` hard-deletes on 1-hour GC tick | `sqlite-store.ts:625-657`, `src/http/memory.ts:792-828` |

There is **no in-place content edit** path — content never gets `UPDATE`d; re-indexing uses delete-then-insert.

### Two startup/write-time helpers (newer than runbook)

- **`boot-reembed.ts`** — startup backfill (the "app-level forward-only migration"). On boot (`src/http/index.ts:567-571`) it counts rows whose `embedding` byte-length ≠ `VECTOR_BYTES` (512×4=2048), i.e. embedded under a *different dimension* (legacy 1536-d), and re-embeds them in batches of 20 at the current dimension. Idempotent no-op when zero mismatches or no API key.
- **`link-resolver.ts`** — runs at write time **only on the HTTP ingest path** (`src/http/memory.ts:351-363`). Regex-captures `[[wikilinks]]`, PR refs, agent-fs file paths, agent-UI URLs from content, resolves wikilink names → memory IDs via exact-name lookup, and writes `memory_link` rows (`INSERT OR IGNORE`). Capture-only — "no traversal tools, no reranker integration" yet.

---

## Map 2 — How memory is SEARCHED (all dimensions)

> **Dimension verdict:** Semantic/vector — **EXISTS** (only content-search path). Keyword/word/FTS/BM25 — **DOES NOT EXIST**. Name/exact — **EXISTS** only as by-`id` lookup + an internal exact-`name` lookup in the wikilink resolver.

### The pipeline (all dimensions funnel into `store.search()` + `rerank()`)

```
query text
   │  embed → 512-d Float32Array (OpenAI text-embedding-3-small)     openai-embedding.ts:41-70
   │        └─ if null (no API key) → fall back to recency list()    memory-search.ts:148-178
   ▼
SqliteMemoryStore.search()                                           sqlite-store.ts:328-359
   │  picks path by health.retrievalMode + query-dim match
   ├─► searchWithVec()  ── sqlite-vec KNN, cosine                    sqlite-store.ts:361-415
   │      SELECT m.*, v.distance FROM memory_vec v
   │      JOIN agent_memory m ON m.id = v.memory_id
   │      WHERE v.embedding MATCH ?  AND <scope/source/expiry>
   │            AND v.k = ?   ORDER BY v.distance  LIMIT ?
   │      similarity = 1 - distance ; drop < MIN_SIMILARITY (0.1)
   └─► searchBruteForce() ── JS cosine over all embedded rows        sqlite-store.ts:417-463
          (fallback when sqlite-vec unavailable or dim ≠ 512)
   │  candidates pulled = limit × CANDIDATE_SET_MULTIPLIER (×3)       constants.ts:60
   ▼
rerank(candidates, {limit})                                         reranker.ts:91-107
   │  composite = similarity
   │            × recencyDecay(createdAt, source)   2^(-ageDays/halfLife)
   │            × accessBoost(accessedAt, accessCount)
   │            × sourceQuality(source)
   │            × usefulness(alpha, beta)            ← rater posterior (mention-only)
   │  overwrite .similarity with composite, sort desc, slice to limit
   ▼
filter/scope  (already enforced in step-3 SQL; +MIN_SIMILARITY drop)
   ▼
top-K results out
   ▼
recordRetrievals()  (only if inside a task)                          raters/retrieval.ts:33-92
   one memory_retrieval row per result, shared retrievalId + per-row rank
```

### 1. Semantic / vector (the only content search)

- `memory_vec` is `vec0(memory_id TEXT PRIMARY KEY, embedding float[512] distance_metric=cosine)` (`sqlite-store.ts:116-121`).
- KNN uses `v.embedding MATCH ?` with `v.k = min(max(limit, vecCount), 4096)` (sqlite-vec 4096 ceiling), `ORDER BY v.distance` (`sqlite-store.ts:377, 396-405`).
- Similarity = `1 - distance`; candidates below `MIN_SIMILARITY` (0.1, `MEMORY_MIN_SIMILARITY` env) dropped (`:409-410`).
- sqlite-vec loaded at DB init via `loadSqliteVec()` (`src/be/db.ts:135-153`), preferring `SQLITE_VEC_EXTENSION_PATH` then the npm package; brute-force JS cosine (`src/be/embedding.ts:5-25`) is the fallback.

### 2. Keyword / word — **does not exist**

- No FTS5 / `USING fts` / BM25 virtual table in any migration (only `memory_vec`).
- No `LIKE`/`MATCH` against `content` or `name`.
- The only `instr()`/substring match in the whole subsystem is a `sourcePath` filter on the admin `POST /api/memory/list` endpoint (`sqlite-store.ts:515`) — that filters by file path, not memory content.
- The `v.embedding MATCH ?` operator is sqlite-vec's **vector** match, *not* FTS text matching.

### 3. Name / exact

- **By id** (exact): `get(id)` (`sqlite-store.ts:305-318`, bumps access) and `peek(id)` (`:320-326`, no bump). Backs `memory-get` tool + `GET /api/memory/{id}`.
- **By name** (exact, non-fuzzy): *only* inside the wikilink resolver — `SELECT id FROM agent_memory WHERE name = ? AND (agentId = ? OR scope = 'swarm') LIMIT 1` (`link-resolver.ts:172-174`). Capture-time only; not a user-facing search.
- **By sourcePath** (exact, for dedup): `deleteBySourcePath()` (`sqlite-store.ts:600-623`).

### Reranker factors (exact formula)

`score = similarity × recencyDecay × accessBoost × sourceQuality × usefulness` (`reranker.ts:76-84`):

| Factor | Formula | Constants |
|---|---|---|
| similarity | raw cosine from vector search | — |
| recencyDecay | `2^(-ageDays / halfLife)` | half-lives: `manual=∞`, `file_index=180d`, `task_completion=14d`, `session_summary=7d` (`constants.ts:27-40`); `MEMORY_RECENCY_HALF_LIFE_DAYS` overrides all |
| accessBoost | `1 + min(accessCount/10, max-1) × recencyFactor` | max 1.5 (`MEMORY_ACCESS_BOOST_MAX`); recencyFactor 1.0 if accessed ≤48h else 0.5 (`MEMORY_ACCESS_RECENCY_HOURS`) |
| sourceQuality | lookup | `manual=1.5`, `file_index=1.0`, `task_completion=0.7`, `session_summary=0.5` (`constants.ts:47-52`) |
| usefulness(α,β) | `clamp(2·α/(α+β), demotionFloor, 2.0)` | Beta(1,1) prior → 1.0 (no-op); `MEMORY_DEMOTION_FLOOR` def 1.0 (`reranker.ts:65-70`) |

`rawSimilarity` and `compositeScore` are preserved on each result (surfaced in HTTP responses).

### Scope filtering — `addScopeConditions()` (`sqlite-store.ts:465-491`)

- Non-lead: `scope='agent'` → `agentId=? AND scope='agent'`; `scope='swarm'` → `scope='swarm'`; `scope='all'` → `(agentId=? OR scope='swarm')`.
- Lead: `scope='all'` → no scope predicate (sees everything).
- `memory-search` MCP passes the agent's real `isLead`; HTTP `/search` hardcodes `isLead:false`; HTTP `/list` hardcodes `isLead:true`.
- TTL filter at query time (unless `includeExpired`): `(expiresAt IS NULL OR expiresAt > datetime('now'))`. No separate hard "staleness" cutoff — recency is the soft reranker multiplier.

### Automatic retrieval at task start

The system prompt (`src/prompts/session-templates.ts:437`) tells agents to run **`task-context-gathering`** first at every task start (`src/be/seed-scripts/catalog/task-context-gathering.ts`). That seed script fans out 2–4 `memory_search` calls, dedups by id keeping best similarity, and re-scores client-side as `similarity + 0.05 × hits`. `smart-recall` and `memory-dedup-check` seed scripts do the same multi-query pattern. The search itself still runs on the API server; only the dedup/re-rank merge is worker-side.

### Retrieval logging (read-side that feeds raters)

`recordRetrievals()` (`src/be/memory/raters/retrieval.ts:33-92`) writes one `memory_retrieval` row per returned memory (no-op unless inside a task), each with `taskId`, `agentId`, `sessionId`, `memoryId`, composite `similarity`, `contextKey`, `intent`, `eventType` (`search`|`get`), a shared `retrievalId`, and 0-based `rank`. Backs `GET /api/memory/retrievals`. `search` rows are GC'd after 90 days.

---

## Map 3 — How memory is STRUCTURED

### `agent_memory` table

Original CREATE (`src/be/migrations/001_initial.sql:271-287`) + later columns:

| Column | Type / constraint | Added in | Role |
|---|---|---|---|
| `id` | `TEXT PRIMARY KEY` | 001 | UUID, sole key |
| `agentId` | `TEXT` (nullable, no FK) | 001 | owning agent |
| `scope` | `TEXT NOT NULL CHECK(scope IN ('agent','swarm'))` | 001 | visibility |
| `name` | `TEXT NOT NULL` (≤500 chars per Zod) | 001 | human label (free-form) |
| `content` | `TEXT NOT NULL` | 001 | body |
| `summary` | `TEXT` | 001 | short form |
| `embedding` | `BLOB` | 001 | serialized Float32Array |
| `source` | `TEXT CHECK(source IN ('manual','file_index','session_summary','task_completion'))` | 001 | provenance |
| `sourceTaskId` / `sourcePath` | `TEXT` | 001 | origin refs |
| `chunkIndex` / `totalChunks` | `INTEGER` def 0 / 1 | 001 | chunking |
| `tags` | `TEXT` def `'[]'` (JSON string) | 001 | tags — **written + displayed, but logic-inert** (see note below) |
| `createdAt` / `accessedAt` | `TEXT NOT NULL` | 001 | timestamps (no `updatedAt`) |
| `expiresAt` | `TEXT` | 036 | TTL |
| `accessCount` | `INTEGER NOT NULL DEFAULT 0` | 036 | retrieval count |
| `embeddingModel` | `TEXT` | 036 | model that embedded it |
| `alpha` / `beta` | `REAL NOT NULL DEFAULT 1.0` | 051 | Beta(1,1) usefulness posterior |
| `created_by` / `updated_by` | `TEXT REFERENCES users(id)` | 082 | audit |
| `contextKey` | `TEXT` | 096 | "born-under" grouping (indexed, not unique) |

**Keys/indexes:** only `id` PK; **no UNIQUE on `(name, scope, agentId)`** → confirms INSERT-only. Indexes: `idx_agent_memory_expires(expiresAt)` (036), `idx_agent_memory_context_key(contextKey)` (096).

**`usefulness` is not stored** — it's computed at read time from `alpha`/`beta`.

**Are `tags` used? (answers review comment)** — written at insert (`JSON.stringify(input.tags ?? [])`, `sqlite-store.ts:280`), parsed on every read (`JSON.parse(row.tags)`, `sqlite-store.ts:59`), passed through the `/search` + `/list` JSON responses (`http/memory.ts:517,556`), and **rendered as badges in the UI memory detail sheet** (`ui/src/pages/memory/page.tsx:557-561`). But they are **never used to filter or rank** — there is no `WHERE tags …` in the memory store and the reranker ignores them entirely. (Note: the swarm auto-promotion in `store-progress` keys off the *task's* tags, not the memory row's `tags`.) So: displayed, never logic.

### Name / path / scope structure (both senses)

- **(a) Schema identity** = the tuple `(agentId, scope, name)`, optionally split across chunks (`chunkIndex`/`totalChunks`). There is **no `key` and no `namespace` column.** Addressable identity is the `id` UUID; `contextKey` records context but isn't part of identity.
- **(b) Hierarchical naming** = **there is none in the path sense.** No slash-delimited paths, no parser. The *only* hierarchy is the 2-value `scope` enum: `scope='agent'`+`agentId` (private) vs `scope='swarm'` (global). `name` is free-form `TEXT`; `sourcePath` is an arbitrary path string used only for substring filtering and dedup, **not** a namespace key. Enforced at read time in `addScopeConditions()` (`sqlite-store.ts:465-491`).

### Embedding storage (two DB locations, never disk)

1. `agent_memory.embedding BLOB` — `Float32Array` serialized little-endian (`src/be/embedding.ts:30-42`).
2. `memory_vec` vec0 virtual table — `embedding float[512] distance_metric=cosine`, keyed by `memory_id = agent_memory.id` (`sqlite-store.ts:116-121`). Not a managed FK; consistency maintained imperatively (delete/purge/populate reconcile).

### Edges & links — **two distinct structures**

**1. `agent_memory_edge`** (v1.5, migration `052`) — single-type, Beta posteriors:
```sql
agent_memory_edge(
  from_id TEXT NOT NULL,            -- memory id
  to_id   TEXT NOT NULL,            -- free-form external entity id
  type    TEXT CHECK (type = 'references-source'),  -- ONE type only
  alpha REAL DEFAULT 1.0, beta REAL DEFAULT 1.0, createdAt TEXT,
  PRIMARY KEY (from_id, to_id, type),
  FOREIGN KEY (from_id) REFERENCES agent_memory(id) ON DELETE CASCADE
)
```
- `to_id` is free-form `TEXT` (no enum, no parser). Convention `<source>:<id>` (`github:owner/repo#N`, `linear:KEY-N`, `customer:<slug>`, …), validated only at write (≤512, no NUL/control chars).
- Carries its own `(α,β)` → `usefulness = clamp(2·α/(α+β),1.0,2.0)` computed in `edges-store.ts:64-68`.
- Indexes on `from_id`, `to_id`, `type`. Read via `listEdgesForAgent` (visibility-checked); write/upsert in `raters/store.ts`.
- Backs `GET /api/memory/edges`.

**2. `memory_link`** (newer, migration `096`) — multi-type deterministic graph. **Yes, auto-populated** at ingest by `link-resolver.ts` (regex capture, `INSERT OR IGNORE`), but *only* on the `POST /api/memory/index` path — `store-progress` and `inject-learning` do **not** call it (answers review comment):
```sql
memory_link(
  id TEXT PRIMARY KEY,
  from_memory_id TEXT NOT NULL,
  linkType   TEXT CHECK (linkType IN ('wikilink','sequel','agent-fs-file','agent-ui','pr','external-source')),
  targetKind TEXT CHECK (targetKind IN ('memory','agent-fs-file','agent-ui','pr','external-source')),
  targetId   TEXT NOT NULL,
  strength REAL DEFAULT 1.0, resolver TEXT NOT NULL,
  sourceText TEXT, metadata TEXT, createdAt TEXT, updatedAt TEXT,
  UNIQUE (from_memory_id, linkType, targetKind, targetId, sourceText),
  FOREIGN KEY (from_memory_id) REFERENCES agent_memory(id) ON DELETE CASCADE
)
```
- `targetKind='memory'` enables **memory-to-memory** links (e.g. `wikilink`, `sequel`); other kinds link to external entities.
- Written at ingest time by `link-resolver.ts` (regex capture of `[[wikilinks]]`, PR refs, agent-fs paths, agent-UI URLs). Phase-1 capture-only: **not yet wired into the reranker** and **zero read consumers today** — a repo-wide grep for `FROM memory_link` returns nothing (confirmed; the only touchpoints are the two `INSERT OR IGNORE` writes).
- Indexes on `from_memory_id`, `(targetKind, targetId)`, `linkType`.

> So `agent_memory_edge` (Beta-weighted, external references, rater-driven) and `memory_link` (deterministic typed graph incl. memory↔memory) are separate systems. Per the runbook, edge-aware reranking, edge GC, multi-type edges, and supersedes/contradicts are all **v2 / out-of-scope** today.

### Auxiliary tables

- **`memory_retrieval`** (migration `051`, extended by `096` with `contextKey`/`intent`/`eventType`, by `097` with `retrievalId`/`rank`) — read-side audit.
- **`memory_rating`** (migration `051`, +`contextKey` in `096`) — rating audit; one row per applied `RatingEvent`.

### In-code types (`src/be/memory/types.ts`)

`EmbeddingProvider`, `MemoryStore` (the store contract), `MemoryInput` (write shape; exposes `contextKey` but not α/β), `MemoryCandidate` (adds `similarity`, `rawSimilarity`, `compositeScore`, `alpha`, `beta`), `MemorySearchOptions`, `MemoryListOptions`, `MemoryStats`, `MemoryHealth`, `RerankOptions`. The canonical public `AgentMemory` is the Zod schema in `src/types.ts:991-1013` — it does **not** model `embedding`, `alpha`, `beta`, `contextKey`, `created_by`, `updated_by` (SQL-only columns).

---

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/be/migrations/001_initial.sql` | 271-287 | `agent_memory` base table |
| `src/be/migrations/036_memory_ttl_staleness.sql` | 2-8 | `expiresAt`, `accessCount`, `embeddingModel` + expiry index |
| `src/be/migrations/051_memory_posteriors_and_retrieval.sql` | 29-50 | `alpha`/`beta`; `memory_retrieval` + `memory_rating` |
| `src/be/migrations/052_memory_edges.sql` | 24-36 | `agent_memory_edge` (single-type, Beta) |
| `src/be/migrations/096_memory_graph_phase1.sql` | 5-50 | `contextKey` cols; `memory_link` multi-type graph |
| `src/be/migrations/097_memory_retrieval_grouping.sql` | 7-10 | `retrievalId` + `rank` on `memory_retrieval` |
| `src/be/memory/providers/sqlite-store.ts` | 116-121 | `memory_vec` vec0 virtual table |
| `src/be/memory/providers/sqlite-store.ts` | 236-303 | `store()` / `storeBatch()` INSERT-only |
| `src/be/memory/providers/sqlite-store.ts` | 328-463 | `search()` → vec KNN / brute-force cosine |
| `src/be/memory/providers/sqlite-store.ts` | 465-491 | `addScopeConditions()` scope filter |
| `src/be/memory/providers/sqlite-store.ts` | 659-683 | `updateEmbedding()` → BLOB + `memory_vec` |
| `src/be/memory/providers/openai-embedding.ts` | 22-115 | OpenAI embed (`text-embedding-3-small`, 512d) |
| `src/be/memory/reranker.ts` | 19-107 | composite scoring + factors |
| `src/be/memory/constants.ts` | 11-65 | TTL, half-lives, source quality, dims, env overrides |
| `src/be/memory/edges-store.ts` | 42-68 | edge read + `usefulness` compute |
| `src/be/memory/link-resolver.ts` | 155-226 | regex capture → `memory_link` writes |
| `src/be/memory/boot-reembed.ts` | 17-84 | startup dimension-mismatch re-embed |
| `src/be/memory/raters/retrieval.ts` | 33-92 | `recordRetrievals()` |
| `src/be/memory/raters/store.ts` | 96-134 | `applyRating()` α/β update |
| `src/be/embedding.ts` | 5-42 | cosine + serialize/deserialize |
| `src/tools/store-progress.ts` | 340-398 | task-completion memory create |
| `src/tools/inject-learning.ts` | 73-90 | lead-only direct create |
| `src/tools/memory-search.ts` | 18-181 | search MCP tool |
| `src/tools/memory-get.ts` | 11-88 | get-by-id MCP tool |
| `src/tools/memory-delete.ts` | 7-68 | delete MCP tool |
| `src/tools/memory-rate.ts` | 34-120 | rate MCP tool (→ HTTP) |
| `src/http/memory.ts` | 25-273 | all 10 route defs |
| `src/http/memory.ts` | 283-381 | `POST /api/memory/index` ingest/create |
| `src/server.ts` | 297-304 | tool registration (`hasCapability("memory")`) |
| `src/scripts-runtime/sdk-allowlist.ts` | 2-7 | scripts-runtime tool exposure |
| `src/prompts/session-templates.ts` | 437 | auto-retrieval instruction at task start |
| `src/be/db.ts` | 135-153 | sqlite-vec extension loading |
| `src/types.ts` | 991-1013 | `AgentMemory` Zod schema |

## Resolved questions (was: Open Questions)

The two uncertainties flagged in the first draft were investigated and **confirmed** — both are "built but unused" today:

- **`memory_link` consumers → CONFIRMED write-only.** Repo-wide grep for `FROM memory_link` returns nothing. The table is populated at ingest (`link-resolver.ts`) and the three indexes exist, but no endpoint, traversal, reranker, or UI reads it. Pure capture.
- **`smart-recall` `dedupThreshold` → CONFIRMED dead code.** Declared in the Zod schema and destructured with default `0.92` (`smart-recall.ts:18-21,28`) but never referenced again. Dedup is strictly by memory `id` (a `Map<id, …>` keeping max similarity); the threshold is applied nowhere.
- **`agent_memory.tags` → CONFIRMED displayed-but-logic-inert** (see Map 3 note): written, surfaced in API responses, rendered as UI badges, never filtered/ranked on.

**Remaining genuine decision — raters depth.** This doc keeps the rater / usefulness-scoring framework *mention-only* (per the Verbose scope choice). The full 3-rater framework + `applyRating` chokepoint + HTTP `source` allow-listing is documented in `runbooks/memory-system.md` (v1.5). See the follow-up question below for whether to fold it in here.

## Appendix

- **Architecture notes**: API server is the sole DB owner (CLAUDE.md invariant); workers reach memory over HTTP with Bearer + `X-Agent-ID`. The `route()` factory is used for all endpoints (auto-OpenAPI). Migrations are forward-only. `memory_vec` requires the sqlite-vec extension (`SQLITE_VEC_EXTENSION_PATH` or npm package), with a JS brute-force cosine fallback.
- **Runbook drift**: `runbooks/memory-system.md` documents through v1.5 and does not mention `memory_link` (096), retrieval grouping (097), `boot-reembed.ts`, `link-resolver.ts`, `inject-learning`, or `contextKey`. Live code is primary source for this doc.
- **Tests** (per runbook): `bun test src/tests/memory-reranker.test.ts memory-store.test.ts memory.test.ts memory-e2e.test.ts` plus the 7 rater suites.
- **Related**: `runbooks/memory-system.md`; memory-system trigger paths in project `CLAUDE.md`.
