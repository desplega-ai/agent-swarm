---
date: 2026-06-26
author: Taras (planned by Claude)
topic: "Memory Enhancements (Phases 0–2) Implementation Plan"
tags: [plan, memory, hybrid-search, fts5, versioning, editing]
status: ready
plan_phases: [0, 1, 2]
last_updated: 2026-06-26
last_updated_by: Claude
related:
  - thoughts/taras/brainstorms/2026-06-25-memory-system-enhancements.md
  - thoughts/taras/research/2026-06-25-memory-system.md
---

# Memory Enhancements (Phases 0–2) Implementation Plan

## Overview

Make swarm memory measurable, searchable by keyword, and editable — without the risky structural redesign. Three de-risked phases: **(0)** baseline whether memory is even useful today, **(1)** add hybrid lexical+semantic search, **(2)** add id-preserving in-place editing + versioning + a structured key. The "core/index + pre-created files" idea (Phase 3) is explicitly deferred and gated on Phase 0–2 data.

- **Motivation**: Memory is vector-only (no keyword search), INSERT-only (no editing; the only "update" re-mints the row id and silently resets usefulness posteriors), and its usefulness signal is **off by default** so we're flying blind. Driven by the 2026-06-25 brainstorm + research.
- **Related**:
  - Brainstorm: `thoughts/taras/brainstorms/2026-06-25-memory-system-enhancements.md` (decisions, R1–R4 findings, phased recommendation)
  - Research: `thoughts/taras/research/2026-06-25-memory-system.md` (current-state map with file:line)
  - Pattern source: `/Users/taras/Documents/code/agent-fs` (RRF hybrid search, COW version ledger)
  - Tickets: DES-637, DES-638, DES-639

## Current State Analysis

- **Search is vector-only.** `SqliteMemoryStore.search()` (`src/be/memory/providers/sqlite-store.ts:328-359`) dispatches to `searchWithVec` (`:361-415`, sqlite-vec KNN cosine) or `searchBruteForce` (`:417-463`). No FTS5/BM25/`LIKE` over `name`/`content` exists anywhere. `rerank()` (`src/be/memory/reranker.ts:91-107`) multiplies `similarity × recencyDecay × accessBoost × sourceQuality × usefulness`.
- **Creation is INSERT-only.** `store()` (`sqlite-store.ts:236-291`) always mints `crypto.randomUUID()`; no upsert, no content-hash dedup, no `edit`. The only content-replacement path is `deleteBySourcePath()` then re-insert (`src/http/memory.ts:322-325`) — which **re-mints the id**.
- **Stable `agent_memory.id` is the linchpin.** All 3 raters + both audit tables key on `id` (`raters/store.ts:96-98`, `raters/retrieval.ts:43-71`). Re-minting on edit resets `alpha/beta`, cascade-deletes `memory_link` (`096:46`), and orphans prior `memory_rating`/`memory_retrieval` rows.
- **Usefulness signal is OFF by default.** `memory_retrieval` flows (every pre-task recall writes rows, `runner.ts:2345`), but `memory_rating` is gated on `MEMORY_RATERS`, which defaults empty → `NoopRater` (`raters/registry.ts:46-49`). So `alpha/beta` never move and we cannot currently measure citation/usefulness.
- **No structured key.** `agent_memory` PK is only `id` (UUID); `name` is free-text, non-unique (`src/types.ts:995`). `contextKey` (096) is a born-under grouping id, NOT an address. No `updatedAt`, no `version`, no `contentHash`.
- **Version-ledger precedent already exists** in the repo: `context_versions` (`src/be/db.ts:3677-3702`), `script_versions` (`064_scripts.sql:24-39`), `page_versions` (`060`), plus a `contentSha256()` helper (`src/commands/profile-sync.ts:54-56`).
- **FTS5 is available in bun:sqlite** with no extension load (unlike sqlite-vec, which is conditional — `src/be/db.ts:131-153`). agent-fs runs FTS5 + vec0 in one bun:sqlite handle (`agent-fs/packages/core/src/db/raw.ts:125-134`).
- **Prod DB**: deployed swarm runs on host `swarm-new`; SQLite at `/var/lib/docker/volumes/swarm-new-22yjmi_swarm_db/_data/agent-swarm-db.sqlite` (host has `sqlite3`, `-readonly` works; `docker exec` is classifier-blocked, host-level reads work). *(Per the 15-day-old prod-hosts memory — confirm the host/volume path still holds before querying.)*

## Desired End State

- A baseline measurement (citation rate per source, retrieval volume) recorded, with `implicit-citation` enabled in prod so usefulness data accrues. (Phase 0)
- `memory-search` returns hybrid (lexical BM25 + semantic cosine, RRF-fused) results, reusing the existing reranker; degrades to vector-only or keyword-only cleanly. (Phase 1)
- A `memory_edit` MCP tool + `POST /api/memory/edit` that edits a memory **in place (id preserved)**, captures an `intent`, writes a version-ledger audit row, content-hash-dedups, re-embeds, and keeps the usefulness posterior. Every memory carries a structured `key`. (Phase 2)
- All memory test suites green on a fresh DB **and** an existing one.

## What We're NOT Doing

- **Phase 3** — the always-loaded "core/index" doc, pre-created file structure, and pointer/wikilink navigation. Deferred; gated on Phase 0–2 data (R4: a core doc sits outside the retrieval/rating loop → no usefulness signal; R1: it's paid per-task-per-agent).
- **agent-fs as the backing store** — memory stays swarm-native (Taras's decision); we borrow agent-fs *patterns* only.
- **Multi-chunk edit** — Phase 2 `edit()` is restricted to single-chunk rows (`totalChunks=1`); multi-chunk docs keep using the existing delete-by-sourcePath re-index path.
- **Edge-aware reranking** (`memory_link` graph walk, DES-639), **`memory_link` link-pruning on edit**, and **simplifying the 4 identity files** — separate tracks.
- **Intent-weighted posterior formula** — Phase 2 keeps the posterior on edit; an intent-weighted adjustment is captured as a follow-up (see Appendix).

## Implementation Approach

- **Sequencing front-loads certainty.** Phase 0 (measure, ~free) → Phase 1 (hybrid search: additive, no data migration, reuses reranker) → Phase 2 (editing/versioning/key: schema migration, but copy-the-existing-ledger-pattern).
- **Preserve `agent_memory.id` across edits** — this single constraint keeps all raters + audit + posteriors intact and is why Phase 2 replaces the lossy delete-reinsert.
- **Borrow agent-fs patterns**: RRF (k=60) per-document fusion; content-hash dedup short-circuit; monotonic version + `UNIQUE(memory_id, version)` optimistic concurrency.
- **Honor architecture invariants**: API server stays sole DB owner (all changes in `src/be/`, `src/http/`, `src/tools/`); new HTTP route via the `route()` factory; new prompt text (if any) via `src/prompts/` registry; read the swarm key via `getApiKey()`.
- **Capture `intent` on create + edit** (mirroring the existing `intent` requirement on `memory-search`/`memory-get`) and use the version ledger as the audit trail.

## Quick Verification Reference

```bash
bun run tsc:check
bun run lint                       # read-only (CI runs `lint`, not lint:fix)
bun test src/tests/memory-store.test.ts
bun test src/tests/memory-reranker.test.ts
bun test src/tests/memory.test.ts
bun test src/tests/memory-e2e.test.ts
# fresh-DB migration check:
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm && bun run start:http
bash scripts/check-db-boundary.sh
```

---

## Phase 0: Baseline memory usefulness (measure before building)

### Overview

Establish whether memory is retrieved and cited today, and turn on the cheap `implicit-citation` rater in prod so usefulness data starts accruing. **Deliverable**: a baseline-metrics record in `thoughts/taras/qa/` + `MEMORY_RATERS=implicit-citation` live in prod.

### Changes Required:

#### 1. Read-only baseline query against prod
**Where**: host `swarm-new`, DB `/var/lib/docker/volumes/swarm-new-22yjmi_swarm_db/_data/agent-swarm-db.sqlite`
**Changes**: Run R4's two read-only queries via `sqlite3 -readonly` (do NOT mutate): (a) the "is anything flowing" sanity counts (`memory_retrieval`/`memory_rating` row counts, moved posteriors); (b) the per-source citation-rate query (joins `memory_retrieval` + `memory_rating` source=`implicit-citation` + `agent_memory`). Both are quoted verbatim in the brainstorm doc (R4 §A.2). Confirm the host alias / volume path first (Taras referred to it as `ssh swarm`; prod-hosts memory says `swarm-new`).

#### 2. Enable the implicit-citation rater in prod
**Where**: Dokploy env for `swarm-new-22yjmi-api-1` (+ worker if the rater path needs it)
**Changes**: Set `MEMORY_RATERS=implicit-citation`. This is server-side, cheap (substring ID-grep of `session_logs`), and byte-identical-off today (`raters/registry.ts:43-49`). No LLM cost (that's the `llm` rater, not enabled here).

#### 3. Record the baseline
**File**: `thoughts/taras/qa/2026-06-26-memory-baseline.md` (new)
**Changes**: Capture the query outputs (citation rate per source, retrieval volume, distinct memories, avg posterior mean) as the pre-change baseline to compare against after Phase 1.

### Success Criteria:

#### Automated Verification:
- [ ] Sanity query returns without error and the row counts are recorded: `ssh swarm-new "sqlite3 -readonly /var/lib/docker/volumes/swarm-new-22yjmi_swarm_db/_data/agent-swarm-db.sqlite '<R4 sanity query>'"`
- [ ] Citation-rate query runs and is captured: `ssh swarm-new "sqlite3 -readonly /var/lib/docker/volumes/swarm-new-22yjmi_swarm_db/_data/agent-swarm-db.sqlite '<R4 citation-rate query>'" | tee thoughts/taras/qa/2026-06-26-memory-baseline.md`
- [ ] `MEMORY_RATERS` confirmed set on the prod API container: `ssh swarm-new "docker inspect swarm-new-22yjmi-api-1 --format '{{json .Config.Env}}'" | grep MEMORY_RATERS` (host-level inspect; not `docker exec`).

#### Automated QA:
- [ ] After ~1 day of prod traffic, re-run the sanity query and confirm `memory_rating` rows with `source='implicit-citation'` are now > 0 and some posteriors have moved (`alpha<>1.0 OR beta<>1.0`).

#### Manual Verification:
- [ ] Taras confirms the prod host/volume path is current and that enabling the rater in prod is acceptable.

**Implementation Note**: Read-only + config only — no repo code changes, so no commit for this phase (commit-per-phase resumes at Phase 1). Pause for Taras's confirmation before touching prod env.

---

## Phase 1: Hybrid search (FTS5 + RRF)

### Overview

Add a `memory_fts` FTS5 index over `name`+`content`, fuse BM25 lexical ranks with the existing vector KNN via RRF (k=60), and hand the fused candidates to the unchanged reranker. **Deliverable**: `memory-search` / `POST /api/memory/search` return hybrid results; a new `memory-hybrid` test suite passes.

### Changes Required:

#### 1. FTS5 table + lifecycle
**File**: `src/be/memory/providers/sqlite-store.ts`
**Changes**: Add `ensureFtsTable()` (peer of `ensureVecTable()` `:94-137`), called from the constructor (`:90-92`): `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, name, content, tokenize='porter unicode61')`. Add `ftsInitialized`/`getFtsTableSchema()` guards mirroring the vec guards. In-process backfill (mirror `populateVecTable` `:161-225`): `INSERT INTO memory_fts(memory_id,name,content) SELECT id,name,content FROM agent_memory am WHERE NOT EXISTS (SELECT 1 FROM memory_fts f WHERE f.memory_id=am.id)` — synchronous, no OpenAI call.

#### 2. FTS sync at the four mutation sites
**File**: `src/be/memory/providers/sqlite-store.ts`
**Changes**: Add FTS writes guarded by `ftsInitialized` at the **same** sites that sync `memory_vec`: `store()` (`:265-287`, INSERT fts row), `delete()` (`:591-598`), `deleteBySourcePath()` (`:600-623`, reuse the id batch), `purgeExpired()` (`:625-657`, same batches). (`updateEmbedding()` is a no-op for FTS — name/content don't change there.)

#### 3. `searchFts()` + `searchHybrid()` + RRF merge
**File**: `src/be/memory/providers/sqlite-store.ts`, `src/be/memory/types.ts`
**Changes**: Add `searchFts(queryText, agentId, options)` modeled on `searchWithVec` (`:361-415`): `memory_fts MATCH ? ... ORDER BY rank`, join `memory_fts f → agent_memory m ON m.id=f.memory_id`, reuse `addScopeConditions(...,"m")` (`:465-491`) + source/expiry filters verbatim. Sanitize the NL query → `terms.map(t => '"'+t.replace(/"/g,'""')+'"').join(' OR ')` wrapped in try/catch → `[]` (agent-fs `ops/search.ts:179-207`). Add `searchHybrid()`: run `searchWithVec` + `searchFts` (both over-fetched), fuse per `memory_id` with `score += 1/(60+rank)`, set `candidate.similarity = RRF score`. Extend `MemorySearchOptions` (`types.ts:72-78`) with `queryText?: string`. `search()` (`:328-359`) calls `searchHybrid` when both arms are available, else falls back to the current single-arm path.

#### 4. Thread query text through callers; keep the reranker
**File**: `src/tools/memory-search.ts` (`:80-93`), `src/http/memory.ts` (`:404-411`, `:478-494`)
**Changes**: Pass the raw `query` text into `store.search(...)` alongside the embedding. `rerank(candidates,{limit})` is **unchanged** — the four factors stay; only `candidate.similarity` now carries the RRF score (preserve raw cosine in a separate field if diagnostics need it). Keep `MIN_SIMILARITY` gating inside `searchWithVec` (pre-fusion).

#### 5. Tests
**File**: `src/tests/memory-hybrid.test.ts` (new), extend `src/tests/memory-store.test.ts`
**Changes**: FTS table created alongside vec; sync on store/delete/deleteBySourcePath/purgeExpired; keyword-only query finds an exact-string memory that vector search misses; RRF merge dedups per id and a doc hit by both arms outranks single-arm hits; malformed FTS query degrades to `[]` not a throw; backfill populates `memory_fts` for pre-existing rows.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] New + existing memory suites pass: `bun test src/tests/memory-hybrid.test.ts src/tests/memory-store.test.ts src/tests/memory-reranker.test.ts src/tests/memory.test.ts src/tests/memory-e2e.test.ts`
- [ ] DB boundary intact: `bash scripts/check-db-boundary.sh`
- [ ] Fresh-DB boot applies cleanly: `rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm && bun run start:http` (server reaches ready, `memory_fts` exists)

#### Automated QA:
- [ ] Agent walkthrough on a seeded local DB: index two memories — one whose exact phrase isn't semantically close to a query, one that is — then `POST /api/memory/search` and confirm the keyword-exact memory now appears (it would NOT under vector-only). Capture the before/after result lists.
- [ ] Confirm `GET /api/memory/health` still reports the vec index healthy and search returns when sqlite-vec is force-disabled (FTS-only degrade path).

#### Manual Verification:
- [ ] Spot-check that hybrid ordering "feels" right on a handful of real queries (relevance judgment).

**Implementation Note**: After verification passes, commit `[phase 1] hybrid memory search (FTS5 + RRF)`. Pause for manual confirmation.

---

## Phase 2: In-place editing + versioning + structured key

### Overview

Add an id-preserving `edit()` + `memory_edit` MCP tool, an `agent_memory_version` audit ledger (capturing `intent` + author), content-hash dedup, and a structured `key` column (path-derived). Replace the lossy delete-reinsert index path with the id-preserving edit. **Deliverable**: migration `098`, `memory_edit` tool + `POST /api/memory/edit`, version ledger, and a `memory-edit` test suite.

### Changes Required:

#### 1. Migration 098 (schema + backfill)
**File**: `src/be/migrations/098_memory_structured_key_versioning.sql` (new)
**Changes**: `ALTER TABLE agent_memory ADD COLUMN key TEXT / contentHash TEXT / version INTEGER NOT NULL DEFAULT 1 / updatedAt TEXT`. Backfill: `updatedAt = createdAt`; `key` = path-derived where natural — for rows with `sourcePath`, `key = sourcePath` (already structured, e.g. `personal/memory/notes/<file>`), else `key = scope || '/' || source || '/' || id` (collision-free via the UUID). Create `agent_memory_version(id PK, memory_id REFERENCES agent_memory(id) ON DELETE CASCADE, version INT, content TEXT, contentHash TEXT, intent TEXT, operation TEXT CHECK(operation IN ('create','edit','replace')), changedByAgentId TEXT, createdAt TEXT, UNIQUE(memory_id, version))` + `idx_amv_memory(memory_id, version DESC)` + `idx_amv_hash(contentHash)`. Add `CREATE UNIQUE INDEX idx_agent_memory_key ON agent_memory(scope, COALESCE(agentId,''), key, chunkIndex) WHERE key IS NOT NULL` **after** the backfill. `contentHash` filled app-side (Change #6).

#### 2. Types + interface
**File**: `src/types.ts` (`AgentMemorySchema` `:991-1013`), `src/be/memory/types.ts` (`:18-56`)
**Changes**: Add `key`, `contentHash`, `version`, `updatedAt` to `AgentMemorySchema` and the row/candidate types. Add `intent` to `MemoryInput`. Add `edit(input: MemoryEditInput): MemoryEditResult` to `MemoryStore` with `MemoryEditInput { id?|key+scope+agentId, mode:'replace'|'exact', content?|oldString+newString, intent: string, expectedVersion?, changedByAgentId? }`. Keep `AgentTaskSourceSchema`-style sync between the ledger `operation` CHECK enum and any TS union.

#### 3. Store: `store()` ledger seed + `edit()`
**File**: `src/be/memory/providers/sqlite-store.ts`
**Changes**: `store()` (`:236-291`) also sets `key`/`contentHash`/`version=1` and writes a `version=1` `agent_memory_version` row (operation `create`, with `intent`). Add `edit()`: resolve target by `id` or `(scope,agentId,key)`; compute `newHash = contentSha256(content)` (`profile-sync.ts:54`); **short-circuit if unchanged** (`return {changed:false}`); else `version = row.version + 1`, INSERT ledger row (UNIQUE collision → 409, reuse `applyRating`'s pattern `raters/store.ts:226-230`), `UPDATE agent_memory SET content,contentHash,version,updatedAt`; re-embed via `getEmbeddingProvider().embed()` → `updateEmbedding()` (syncs `memory_vec`) and resync `memory_fts`; re-run `storeLinks()`. **Keep `alpha/beta`** (id preserved). `mode:'exact'` requires `oldString` to occur exactly once. Restrict to `totalChunks=1`. Allow editing `PROTECTED_SOURCES` (manual is curated, meant to be maintained).

#### 4. MCP tool + HTTP route
**File**: `src/tools/memory-edit.ts` (new), `src/http/memory.ts`, `src/server.ts`
**Changes**: New `memory_edit` MCP tool (sibling of `memory-get`/`memory-delete`), `intent` required (mirrors search/get). New `POST /api/memory/edit` via the `route()` factory (`src/http/route-def.ts`), auth `apiKey + agentId`. Register the tool in the `hasCapability("memory")` block (`src/server.ts:297-304`). Add to `SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts`). Run `bun run docs:openapi` and commit `openapi.json` + regenerated api-reference.

#### 5. Replace the lossy re-index path with id-preserving edit
**File**: `src/http/memory.ts` (`:322-349`)
**Changes**: When ingesting content whose `(sourcePath/key, agentId)` already exists, route through `edit()` (id preserved) instead of `deleteBySourcePath()`+reinsert — so re-indexing a memory file no longer resets posteriors / cascade-deletes links. (Multi-chunk docs keep the existing path.)

#### 6. contentHash backfill
**File**: `src/be/memory/boot-fts-backfill.ts` or extend `src/be/memory/boot-reembed.ts`; wired in `src/http/index.ts:564-571`
**Changes**: Boot routine fills `contentHash` for legacy rows (`contentSha256(content)`), idempotent no-op when none missing. (Or lazy: treat NULL hash as "always differs" so the first edit writes it.)

#### 7. Tests
**File**: `src/tests/memory-edit.test.ts` (new)
**Changes**: `edit()` preserves `id` (a prior `memory_retrieval`/`memory_rating` row still resolves); hash short-circuit skips re-embed + ledger; `version` increments + ledger row carries `intent`+`operation`; `mode:'exact'` rejects ambiguous/missing `oldString`; concurrent edits → one 409; posterior (`alpha/beta`) unchanged after edit; `key` uniqueness holds per `(scope,agentId,key,chunkIndex)`; re-index of a same-path memory keeps the id; migration applies on fresh **and** populated DB.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] Memory suites pass: `bun test src/tests/memory-edit.test.ts src/tests/memory-store.test.ts src/tests/memory.test.ts src/tests/memory-e2e.test.ts`
- [ ] Rater suites still green (id-preservation): `bun test src/tests/memory-rater-store.test.ts src/tests/memory-rate-endpoint.test.ts src/tests/memory-rater-e2e.test.ts`
- [ ] OpenAPI regenerated + committed: `bun run docs:openapi` (clean git diff afterward)
- [ ] DB boundary + API-key boundary intact: `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh`
- [ ] Migration applies on a **fresh** DB: `rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm && bun run start:http`
- [ ] Migration applies on an **existing** DB (copy a pre-098 sqlite file in place, then `bun run start:http`, confirm backfill + index).

#### Automated QA:
- [ ] Agent walkthrough: create a memory (capture id), `memory_rate` it (with `MEMORY_RATERS` incl. explicit-self) so `alpha/beta` move, then `memory_edit` its content; confirm the **same id**, an incremented `version`, a new `agent_memory_version` row with the `intent`, **unchanged `alpha/beta`**, and an updated embedding. Capture the row before/after.
- [ ] Re-`POST /api/memory/index` the same `sourcePath` and confirm the id is preserved (not re-minted) and `memory_link`/ratings survive.

#### Manual Verification:
- [ ] Review the `key` values assigned to a sample of migrated rows look sensible (path-derived where expected).

**Implementation Note**: After verification passes, commit `[phase 2] in-place memory editing + versioning + structured key`. Pause for manual confirmation.

---

## Manual E2E

Run against a local server with a clean DB (`rm -f agent-swarm-db.sqlite* && bun run start:http`), using the swarm API key (`Authorization: Bearer ${AGENT_SWARM_API_KEY}`, default `123123`) + `X-Agent-ID`. Substitute a real agent id where noted.

1. **Index two memories** (one with a distinctive exact phrase): `POST /api/memory/index` with `{content, name, scope:"agent", source:"manual", agentId:"<id>"}` for each.
2. **Hybrid search (Phase 1)**: `POST /api/memory/search` `{query:"<the exact phrase>", intent:"e2e", limit:5}` → the exact-phrase memory ranks top (keyword arm); repeat with a semantically-related-but-lexically-different query → the other memory surfaces (vector arm). Confirm both arms contribute.
3. **Edit in place (Phase 2)**: grab a memory id from the search result, `POST /api/memory/edit` `{memoryId:"<id>", mode:"replace", content:"<new body>", intent:"correct a stale fact"}` → `200 {version:2, changed:true}`. `GET /api/memory/{id}` shows new content, same id, `version:2`, `updatedAt` set.
4. **Audit trail**: confirm an `agent_memory_version` row exists for v1 (create) and v2 (edit) with the `intent` captured (`sqlite3 -readonly agent-swarm-db.sqlite "SELECT version,operation,intent FROM agent_memory_version WHERE memory_id='<id>' ORDER BY version"`).
5. **Idempotent edit**: repeat the same `memory_edit` with identical content → `{changed:false}`, no new version (hash short-circuit).
6. **Posterior survival**: if `MEMORY_RATERS` includes `explicit-self`, `memory_rate` the memory before the edit, then confirm `alpha/beta` are unchanged after the edit (`SELECT alpha,beta FROM agent_memory WHERE id='<id>'`).
7. **Prod baseline (Phase 0)**: `ssh swarm-new` + `sqlite3 -readonly <volume path>` run the R4 citation query; record the numbers; confirm `MEMORY_RATERS=implicit-citation` is set on the API container.

## Appendix

- **Follow-up plans / deferred**:
  - **Phase 3** — core/index + pre-created file structure (gated on Phase 0–2 data); layout A/B/C still open in the brainstorm.
  - **Intent-weighted posterior on edit** — Taras's idea: derive a posterior nudge from edit `intent` ("high intent to edit" signal) rather than just keeping it. Needs a formula + signal design; the `intent` column added in Phase 2 makes it possible later.
  - **`memory_link` link-pruning on edit** (currently additive re-resolve, stale links linger) + **edge-aware reranking** (DES-639).
  - **Simplify the 4 identity files** (`SOUL/IDENTITY/TOOLS/CLAUDE` → 1–2, per R1) — parallel track.
  - **Productize the memory-eval dashboard** (`seed-scripts/catalog/memory-eval.ts`) into an endpoint/UI so citation rate is visible, not just queryable.
- **Derail notes**:
  - DES-637 (delete dead `dedupThreshold`) and DES-638 (auto-tag `tags`) are cheap and adjacent — could ride along in Phase 1/2 commits.
  - Tokenizer choice (`porter unicode61`) affects code-identifier recall; changing it later requires a new migration (drop+rebuild `memory_fts`).
  - Confirm the prod host alias (`swarm` vs `swarm-new`) + volume path before Phase 0 (prod-hosts memory is 15 days old).
- **References**:
  - Brainstorm: `thoughts/taras/brainstorms/2026-06-25-memory-system-enhancements.md`
  - Research: `thoughts/taras/research/2026-06-25-memory-system.md`
  - Pattern source: `/Users/taras/Documents/code/agent-fs` (`ops/search.ts` RRF, `ops/versioning.ts` ledger)
  - Tickets: DES-637, DES-638, DES-639
