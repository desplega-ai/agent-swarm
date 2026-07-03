---
date: 2026-07-02
author: Claude (autopilot; commissioned by Taras)
topic: "Memory retrieval v2 — measurement readout + memory_link read side (DES-639) + ride-alongs"
tags: [plan, memory, hybrid-search, graph, measurement, DES-639, DES-637, DES-638]
status: in-progress
autonomy: autopilot
last_updated: 2026-07-03
last_updated_by: Claude (phase-4 agent)
---

# Memory Retrieval v2 (Measurement + Graph Read Side) Implementation Plan

## Overview

Make the shipped Phases 1–2 (PR #829: hybrid FTS5+RRF search, in-place editing/versioning/structured key) pay off: record the prod usefulness baseline and productize the citation-rate readout, then build the `memory_link` read side (DES-639: graph-walk reranking + traversal + stale-link pruning), with DES-637/638 as cheap ride-alongs.

- **Motivation**: Phases 1–2 are live in prod (`MEMORY_HYBRID_SEARCH=1`, `MEMORY_RATERS=implicit-citation` both set) but nothing *reads* the data or the graph yet; the Phase 3 (core/index) go/no-go is gated on exactly this readout.
- **Related**: `thoughts/taras/brainstorms/2026-06-25-memory-system-enhancements.md`, `thoughts/taras/plans/2026-06-26-memory-enhancements-phases-0-2.md`, `thoughts/taras/research/2026-06-25-memory-system.md`, PR #829, DES-639, DES-637, DES-638.

## Current State Analysis

### Search + rerank path (Phase 1 shipped, flag-gated)

- Two search entry points, same shape (overfetch → rerank → record provenance): HTTP `POST /api/memory/search` (`src/http/memory.ts:446-519`, `store.search` at `:463`, `rerank` at `:470`, `recordRetrievals` at `:483-499`) and the MCP `memory-search` tool (`src/tools/memory-search.ts:66-135`).
- `SqliteMemoryStore.search()` (`src/be/memory/providers/sqlite-store.ts:486-550`) dispatches four ways — **hybrid** (RRF fusion, `searchHybrid` `:552-600`, `computeRrfScore` `:116-118`), **vec** (`searchWithVec` `:678-732`), **fts** (`searchFts` `:602-665`), **fallback** cosine scan — each tagging `retrievalSource` (`vec|fts|hybrid|fallback`, TS union at `src/be/memory/types.ts:79`). Hybrid requires `isHybridSearchEnabled()` (`src/be/memory/constants.ts:63-66`, `MEMORY_HYBRID_SEARCH=1`; **set in prod**).
- `rerank()` (`src/be/memory/reranker.ts:94-110`) is a **pure function** — `similarity × recencyDecay × accessBoost × sourceQuality × usefulness` (`computeScore` `:76-87`), no DB access.

### Link graph (captured, write-only)

- `memory_link` (`src/be/migrations/096_memory_graph_phase1.sql:22-50`): directed `from_memory_id → targetId`, `linkType ∈ {wikilink, sequel, agent-fs-file, agent-ui, pr, external-source}`, `strength`, `resolver`, `UNIQUE(from_memory_id, linkType, targetKind, targetId, sourceText)`, `ON DELETE CASCADE` on the *from* side only (no FK on `targetId` — inbound links to a deleted memory linger). Unresolved wikilinks keep the raw `[[Name]]` as `targetId` (`link-resolver.ts:182`).
- Writer: `storeLinks()` (`src/be/memory/link-resolver.ts:186-216`), `INSERT OR IGNORE` = purely additive. Called from `src/http/memory.ts:371,418,667` and `src/tools/memory-edit.ts:106`. `storeSequelLink()` (`:218-226`) exists but has **zero call sites**.
- **Confirmed write-only**: no SELECT on `memory_link` anywhere in `src/` or `apps/ui/`. (`agent_memory_edge` has one reader: `listEdgesForAgent`, `src/be/memory/edges-store.ts:35-62`, serving `GET /api/memory/edges` — not used in search.)

### Edit path + stale links

- `edit()` (`sqlite-store.ts:873-957`) never touches `memory_link`; callers re-run `storeLinks()` on the new content (`src/http/memory.ts:662-674`, `src/tools/memory-edit.ts:101-113`) — additive, so **links derived from deleted content linger** (confirmed). No delete helper for `memory_link` exists. Content-derived links are re-derivable (resolvers `wikilink|pr-*|agent-fs-path|agent-ui-*`); `sequel` links are NOT — pruning must exclude `linkType='sequel'`. The UNIQUE key is the natural diff identity.

### Retrieval provenance (measurement plumbing already exists)

- `memory_retrieval` accreted columns: base (`051`), `contextKey`/`intent`/`eventType` (`096`), `retrievalId`/`rank` per search call — enables precision@k/MRR (`097`), `retrievalSource` TEXT, nullable, no CHECK (`100`). Writer `recordRetrievals()` (`src/be/memory/raters/retrieval.ts:34-94`); worker recall goes through the HTTP endpoint with `X-Source-Task-ID` (`src/commands/runner.ts:2381-2419`), so the server records everything.
- ⇒ Measuring whether graph-sourced results get cited needs **only a new `retrievalSource` union member** (`types.ts:79`, `retrieval.ts:25`) — no migration.

### Where a graph boost hooks in (decision, see Implementation Approach)

- Inside `rerank()`: would break its purity (needs link data).
- Inside `searchHybrid()`: only covers the flag-gated hybrid path; post-slice candidates are already gone.
- **Between `store.search()` and `rerank()` at the two call sites**: covers all four retrieval paths, has full candidates + ids, sits before `recordRetrievals` so graph provenance is free. ← chosen seam.

### Test coverage today

`memory-hybrid.test.ts` (RRF + dispatch), `memory-reranker.test.ts` (per-factor), `memory-link-resolver.test.ts` (pure matchers only — **`storeLinks` DB writes + wikilink→id resolution are untested**), `memory-edges.test.ts` (`agent_memory_edge` only), `memory-edit.test.ts` (edit modes/versioning — not the caller-side link re-run).

### Measurement surface (memory-eval, endpoint/UI conventions)

- **The aggregator is a swarm seed script, not a server module**: `src/be/seed-scripts/catalog/memory-eval.ts` (registered `src/be/seed-scripts/index.ts:183-190`) runs in the scripts runtime via `ctx.swarm.db_query`. Three axes — carry-forward context (`:214-271`), preference adherence incl. a `memory_rating`-by-source breakdown (`:275-357`), freshness (`:363-445`) — plus store snapshot, KV history (`namespace "memory-eval"`), agent-fs markdown, and an authed HTML page (slug `memory-eval`). **It does not compute a general per-source citation rate** (no join on `memory_rating WHERE source='implicit-citation'` across all sources).
- **The R4 baseline SQL does not exist anywhere** — the prior plan's "quoted verbatim in the brainstorm (R4 §A.2)" reference is dangling (brainstorm `:148-158` only *describes* the queries; the R4 sub-agent report was never persisted). No baseline was ever captured (`thoughts/taras/qa/` has nothing). ⇒ **This plan must write the SQL fresh**, and a pure pre-hybrid baseline is no longer possible — only trend-from-now. Schema inputs: `memory_retrieval` (051/096/097/100: `taskId, agentId, sessionId, memoryId, similarity, contextKey, intent, eventType, retrievalId, rank, retrievalSource`), `memory_rating` (051, +`contextKey` 096), `agent_memory` α/β posteriors.
- **Route conventions**: `route()` factory (`src/http/route-def.ts:14-35`), self-registering; OpenAPI generator requires an explicit import per handler file (`scripts/generate-openapi.ts:1-54`). ⚠️ Pre-existing drift: `src/http/metrics.ts` (dashboard routes `:195-309`) is **missing from `generate-openapi.ts`** — its routes are absent from `openapi.json`. Don't copy; fix in the same PR.
- **Memory HTTP surface**: `GET /api/memory/health` (`src/http/memory.ts:155-165,685-691`) is a cheap synchronous index-integrity probe — the usefulness readout should be a **sibling endpoint** (windowed analytics with `days`/`threshold` params), precedent: `GET /api/memory/retrievals` (`:262`).
- **UI**: a memory page already exists — `apps/ui/src/pages/memory/page.tsx`, routed at `/memory` (`apps/ui/src/app/router.tsx:52,151`). Conventions: TanStack react-query hooks (`apps/ui/src/api/hooks/use-metrics.ts:18-27` is the simple exemplar; graceful `null` on non-2xx per `apps/ui/src/api/client.ts:403-410`), nivo `SharedLineChart`/`SharedBarChart` (`apps/ui/src/components/shared/charts/nivo-charts`).
- **Alternative considered**: ship the readout as a migration-seeded metrics-dashboard definition (like `091`, SELECT-only widget SQL) — zero new endpoint/UI code. Rejected as primary (see Implementation Approach) but the SQL should be reusable.

### Ride-alongs: DES-637 dedupThreshold / DES-638 tags

- **DES-637 confirmed dead**: `dedupThreshold` exists only in `src/be/seed-scripts/catalog/smart-recall.ts:18-21` (argsSchema field) and `:28` (destructure default `0.92`) — never read after the destructure; actual dedup is by-id (`:40-49`). No test, doc, or manifest references it. Re-seeding is contentHash-versioned (pristine installs update automatically; user-modified copies preserved).
- **DES-638**: `tags TEXT DEFAULT '[]'` (`001_initial.sql:284`, JSON string array). **Accepted but never populated** — the only write is `store()`'s INSERT (`sqlite-store.ts:398,414`); no production client sends tags (hooks, pi/codex adapters, `store-progress`, `inject-learning` all omit it). Not filterable and **not returned by search** (`src/http/memory.ts:501-513`, `src/tools/memory-search.ts:120-132`); returned by list/get; rendered as badges in the UI detail sheet (`apps/ui/src/pages/memory/page.tsx:557-561`).
- **Choke point**: 100% of creations funnel through `MemoryStore.store()` (`sqlite-store.ts:385-449`); callers are `POST /api/memory/index` (`src/http/memory.ts:396`), `store-progress` (`src/tools/store-progress.ts:357,379`), `inject-learning` (`src/tools/inject-learning.ts:73`).
- **Cheapest viable producer** (no LLM): `inject-learning`'s `category` enum (`mistake-pattern|best-practice|codebase-knowledge|preference`, `inject-learning.ts:7-12`) is a ready-made tag currently only folded into the name/content prefix — threading it through `MemoryInput.tags` is zero-cost. An LLM auto-tagger (via the reusable `completeStructured()` abstraction, `src/utils/internal-ai/complete-structured.ts:176-309`, fire-and-forget post-insert like embeddings `src/http/memory.ts:429-440`) is possible but unjustified while nothing filters/ranks on tags — **deferred** (see Appendix).

## Desired End State

- A **usefulness readout** exists as a first-class API: `GET /api/memory/usefulness` returns windowed citation rate per memory-source, per retrieval-arm (`retrievalSource`) breakdown, retrieval volume, and posterior-movement stats — visible as a panel on the existing `/memory` dashboard page. A prod snapshot is recorded in `thoughts/taras/qa/` as the trend anchor.
- **`memory_link` has a read side (DES-639)**: search results are expanded with 1-hop graph neighbors (tagged `retrievalSource: "graph"`, so their citation rate is measurable), and links are traversable via the memory-get surface. Edits prune stale content-derived links instead of accreting them.
- **DES-637** dead `dedupThreshold` deleted; **DES-638** `agent_memory.tags` has a producer.
- Verification: full memory test suites green; the usefulness endpoint returns real numbers against a seeded DB; a graph-linked memory demonstrably surfaces in search results it wouldn't have reached by similarity alone.

## What We're NOT Doing

- **Phase 3** (always-loaded core/index + pre-created file structure) — still gated on the data this plan produces.
- **Intent-weighted posterior on edit** — needs its own formula/signal design conversation.
- **Identity-file simplification** (`SOUL/IDENTITY/TOOLS/CLAUDE` → 1–2) — separate parallel track.

## Implementation Approach

- **Measurement before graph** — the readout ships first so the graph work's impact is visible from day one (graph-sourced retrievals get their own `retrievalSource` and show up in the per-arm breakdown).
- **Readout = sibling endpoint + panel on the existing `/memory` page**, not an extension of `/api/memory/health` (cheap probe vs. windowed aggregate) and not only a seeded dashboard definition (the endpoint makes it consumable by tools/scripts too; the SQL is shared).
- **Graph boost = candidate expansion between `store.search()` and `rerank()`** — covers all four retrieval paths, keeps `rerank()` pure, gets provenance for free. Expansion is depth-1, resolved `wikilink`→memory targets only, score derived from the parent candidate (damped), deduped against existing candidates, and **feature-flagged** (`MEMORY_GRAPH_EXPANSION`, default off — same rollout pattern as `MEMORY_HYBRID_SEARCH`).
- **Stale-link pruning = diff-by-UNIQUE-key on edit**, content-derived resolvers only (`linkType != 'sequel'`), in the same place `storeLinks` is re-run today.
- **Ride-alongs ride last** — DES-637/638 are isolated commits at the end; they must not block the main track.
- Commit per phase (`[phase N] …`), pause for manual verification between phases.

## Quick Verification Reference

```bash
bun run tsc:check && bun run lint
bun test src/tests/memory-hybrid.test.ts src/tests/memory-reranker.test.ts \
  src/tests/memory-link-resolver.test.ts src/tests/memory-edit.test.ts \
  src/tests/memory.test.ts src/tests/memory-store.test.ts src/tests/memory-e2e.test.ts
bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh
bun run docs:openapi   # after any route change; commit openapi.json + docs-site api-reference
# fresh-DB boot: rm -f agent-swarm-db.sqlite* && bun run start:http
```

---

## Phase 1: Usefulness readout endpoint (`GET /api/memory/usefulness`)

### Overview

A windowed usage-analytics endpoint that answers "is memory useful, per source and per retrieval arm" — the citation-rate SQL written fresh (the R4 originals were never persisted), exposed via the `route()` factory as a sibling of `/api/memory/health`.

### Changes Required:

#### 1. Stats module
**File**: `src/be/memory/usefulness-stats.ts` (new; API-side, sibling of `retrieval-store.ts` / `edges-store.ts`)
**Changes**: `getUsefulnessStats({ days = 30, threshold = 0.6 })` returning:
- **Volume**: `memory_retrieval` rows in window, distinct memories, distinct `retrievalId` groups, split by `eventType`.
- **Per-arm breakdown**: counts + citation stats grouped by `retrievalSource` (`vec|fts|hybrid|fallback`, NULL = pre-100 legacy; `graph` appears after Phase 4).
- **Citation rate per memory-source**: join `memory_rating` (`source='implicit-citation'`) → `agent_memory`, `AVG(signal)` + counts grouped by `agent_memory.source`. Sketch (validate column names against migrations 051/096 at implementation time):
  ```sql
  SELECT am.source, COUNT(*) AS ratings, AVG(mr.signal) AS citationRate
  FROM memory_rating mr JOIN agent_memory am ON am.id = mr.memoryId
  WHERE mr.source = 'implicit-citation' AND mr.createdAt > :cutoff
  GROUP BY am.source;
  ```
- **Posterior movement**: `COUNT(*) FILTER (WHERE alpha <> 1.0 OR beta <> 1.0)`, avg posterior mean `alpha/(alpha+beta)`, count above `threshold`.
- **Sanity block** (the reconstructed R4 sanity query): total `memory_retrieval` rows, total `memory_rating` rows by `mr.source` — "is anything flowing".

#### 2. Route
**File**: `src/http/memory.ts`
**Changes**: `GET /api/memory/usefulness` via `route()` (`src/http/route-def.ts:14-35`), query params `days`/`threshold` (zod-coerced), auth apiKey. Wire in the memory dispatch alongside `/api/memory/health` (`:685-691`).

#### 3. OpenAPI (incl. drift fix)
**File**: `scripts/generate-openapi.ts`
**Changes**: confirm `../src/http/memory` import present; **add the missing `../src/http/metrics` import** (pre-existing drift — dashboard routes absent from `openapi.json`). Run `bun run docs:openapi`, commit `openapi.json` + regenerated `docs-site/content/docs/api-reference/**`.

#### 4. Tests
**File**: `src/tests/memory-usefulness-endpoint.test.ts` (new)
**Changes**: seed `agent_memory` + `memory_retrieval` + `memory_rating` rows (mixed sources/arms/signals); assert per-source rates, per-arm counts, window filtering, empty-DB shape (zeros, not errors), param validation (400 on bad `days`).

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] New + adjacent suites pass: `bun test src/tests/memory-usefulness-endpoint.test.ts src/tests/memory-health-endpoint.test.ts src/tests/memory.test.ts`
- [x] Boundaries intact: `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh`
- [x] OpenAPI regenerated + committed (now including metrics routes): `bun run docs:openapi` then `git diff --exit-code openapi.json` is non-empty pre-commit, clean post-commit

#### Automated QA:
- [x] Against a fresh local server (`rm -f agent-swarm-db.sqlite* && bun run start:http`): seed two memories via `POST /api/memory/index`, search them with `X-Source-Task-ID` set, then `curl -H "Authorization: Bearer 123123" "http://localhost:3013/api/memory/usefulness?days=7"` returns volume ≥ 2 with per-arm provenance populated.

#### Manual Verification:
- [ ] Numbers read as plausible/self-consistent (volume ≥ ratings; rates ∈ [0,1]).

**Implementation Note**: After this phase, pause for manual confirmation; commit `[phase 1] memory usefulness readout endpoint`.

---

## Phase 2: `/memory` dashboard panel

### Overview

A "Usefulness" section on the existing `/memory` UI page rendering the Phase 1 endpoint: summary tiles (volume, overall citation rate, posterior movement) + per-source and per-arm bar charts.

### Changes Required:

#### 1. API client + hook
**File**: `apps/ui/src/api/client.ts`, `apps/ui/src/api/hooks/use-memory-usefulness.ts` (new)
**Changes**: client method `fetchMemoryUsefulness(days)` following the graceful-`null`-on-non-2xx pattern (`client.ts:403-410`); react-query hook mirroring `use-metrics.ts:18-27` (no 5s polling — 60s `staleTime` is enough for analytics).

#### 2. Panel
**File**: `apps/ui/src/pages/memory/page.tsx`
**Changes**: add a Usefulness section (Card + tiles + nivo `SharedBarChart` for per-source citation rate and per-arm counts). Hide the section gracefully when the hook returns `null` (older server).

### Success Criteria:

#### Automated Verification:
- [x] UI deps + lint + build: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`

#### Automated QA:
- [x] With the local API (seeded as in Phase 1 QA) + `cd apps/ui && bun run dev`: drive agent-browser (browser-use skill — local URL) to `http://localhost:5274/memory`, screenshot the Usefulness panel showing non-zero tiles and both charts. (Evidence: `thoughts/taras/qa/2026-07-03-memory-usefulness-panel.md` + screenshots.)

#### Manual Verification:
- [ ] Taras eyeballs the panel layout and visual harmony with the existing page (he manual-QAs the SPA).

**Implementation Note**: Pause + commit `[phase 2] memory usefulness dashboard panel`. This phase touches `apps/ui/` — the merge gate expects QA evidence on frontend PRs; the agent-browser screenshots from Automated QA serve as that evidence.

---

## Phase 3: Prod baseline snapshot

### Overview

The trend anchor: run the readout against prod and persist it as a QA doc — `thoughts/taras/qa/2026-07-XX-memory-usefulness-baseline.md` (a pure pre-hybrid baseline is no longer possible; this records "state at readout-ship time").

### Changes Required:

#### 1. Snapshot doc
**File**: `thoughts/taras/qa/2026-07-XX-memory-usefulness-baseline.md` (new; date of execution)
**Changes**: capture (a) the deployed endpoint output — `curl -H "Authorization: Bearer $PROD_KEY" "https://<prod-api>/api/memory/usefulness?days=30"` — or, if the release hasn't deployed yet, the equivalent read-only SQL via `ssh swarm-new "sqlite3 -readonly /var/lib/docker/volumes/swarm-new-22yjmi_swarm_db/_data/agent-swarm-db.sqlite '<phase-1 SQL>'"`; (b) the interpretation: which sources are cited, whether hybrid/fts arms appear, posterior movement since raters went live.

### Success Criteria:

#### Automated Verification:
- [ ] Snapshot file exists and embeds the raw JSON/rows plus the command used: `test -s thoughts/taras/qa/2026-07-*-memory-usefulness-baseline.md`

#### Automated QA:
- [ ] The captured output parses (JSON valid / row counts non-negative) and `memory_rating` rows with `source='implicit-citation'` are > 0 (raters have been live since ~06-27 — if 0, that's a finding to raise, not to paper over).

#### Manual Verification:
- [ ] Taras authorizes the prod access (SSH/API key) — my earlier read-only SSH attempt was auto-denied, so this phase is gated on him running or approving the command.

**Implementation Note**: No repo code changes beyond the QA doc. Pause + commit `[phase 3] prod memory usefulness baseline`.

---

## Phase 4: Graph candidate expansion (DES-639a)

### Overview

Search results gain 1-hop `memory_link` neighbors — the first reader of the graph — behind a `MEMORY_GRAPH_EXPANSION` flag (default off), with `retrievalSource: "graph"` provenance so Phase 1's readout measures whether graph hits get cited.

### Changes Required:

#### 1. Types
**File**: `src/be/memory/types.ts:79`, `src/be/memory/raters/retrieval.ts:25`
**Changes**: add `"graph"` to the `MemoryRetrievalSource` union (column is free TEXT — no migration).

#### 2. Expansion module
**File**: `src/be/memory/graph-expansion.ts` (new)
**Changes**: `expandCandidatesWithGraph(candidates, agentId, { cap = 5, damping = 0.7 })`:
- SELECT outgoing `memory_link` rows for the candidate ids where `targetKind='memory'` AND `targetId` resolves to an existing, non-expired `agent_memory` row (skip unresolved wikilinks whose `targetId` is still raw `[[Name]]` text — `link-resolver.ts:182`).
- **Enforce scope ACL** on fetched neighbors (same visibility rules as search: own-agent or swarm scope — reuse the store's scope conditions).
- Neighbor similarity = `parentCandidate.similarity × strength × damping`; set `retrievalSource: "graph"`, `recencyDecayApplied: false` (let the reranker apply decay); dedupe against existing candidate ids (keep the higher-scored entry); cap total additions.
- Flag: `isGraphExpansionEnabled()` in `src/be/memory/constants.ts` (`MEMORY_GRAPH_EXPANSION=1|true`, default off — mirrors `isHybridSearchEnabled()` `:63-66`).

#### 3. Wire at the chosen seam
**File**: `src/http/memory.ts:463-470`, `src/tools/memory-search.ts:87-95`
**Changes**: between `store.search()` and `rerank()`, when flag on: `candidates = expandCandidatesWithGraph(candidates, agentId, …)`. `recordRetrievals` downstream picks up the `graph` provenance unchanged.

#### 4. Tests
**File**: `src/tests/memory-graph-expansion.test.ts` (new)
**Changes**: linked memory surfaces in results it would not reach by similarity alone; unresolved-wikilink targets skipped; cross-agent `agent`-scoped neighbor NOT leaked (ACL); flag off ⇒ byte-identical results; dedupe keeps max score; `memory_retrieval` rows carry `retrievalSource='graph'`; damping/cap respected.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] Suites pass: `bun test src/tests/memory-graph-expansion.test.ts src/tests/memory-hybrid.test.ts src/tests/memory-reranker.test.ts src/tests/memory.test.ts src/tests/memory-e2e.test.ts`
- [x] Boundary intact: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [x] Local walkthrough with `MEMORY_GRAPH_EXPANSION=1`: index memory A containing `[[B-name]]` wikilink + memory B with lexically/semantically distant content; `POST /api/memory/search` for A's topic returns B tagged `graph` in results; re-run with flag off ⇒ B absent. Capture both result lists. (2026-07-03: flag on → A `fts` 1.5 + B `graph` 1.05, `memory_retrieval` rows `fts`/`graph`; flag off → A only, B absent; distractor C never surfaced.)

#### Manual Verification:
- [ ] Spot-check that graph additions don't crowd out organic hits on a handful of real queries (relevance judgment).

**Implementation Note**: Pause + commit `[phase 4] graph candidate expansion behind MEMORY_GRAPH_EXPANSION`.

---

## Phase 5: Link traversal + stale-link pruning (DES-639b)

### Overview

Links become visible (memory-get returns them) and self-maintaining (edits prune content-derived links instead of accreting) — closing the write-only gap and the known stale-link wart.

### Changes Required:

#### 1. Traversal read surface
**File**: `src/be/memory/link-resolver.ts` (or new `links-store.ts`), `src/http/memory.ts`, `src/tools/memory-get.ts`
**Changes**: `getLinksForMemory(memoryId)` → outgoing links (+ inbound `targetKind='memory'` links as a `backlinks` array — cheap, same table). Include a `links`/`backlinks` block in `GET /api/memory/{id}` (`:886`) and the `memory-get` tool output schema. ACL: filter linked-memory metadata through the same scope rules; unresolved links returned with `resolved: false`.

#### 2. Pruning on edit
**File**: `src/be/memory/link-resolver.ts`, callers `src/http/memory.ts:361-369,662-674`, `src/tools/memory-edit.ts:101-113`
**Changes**: new `refreshLinks(memoryId, agentId, content)` — resolve links from the new content, then in one transaction `DELETE FROM memory_link WHERE from_memory_id = ? AND linkType != 'sequel'` for rows whose UNIQUE identity `(linkType,targetKind,targetId,sourceText)` is not in the new set, then `INSERT OR IGNORE` the new set. Replace the additive `storeLinks()` calls on the **edit/re-index** paths (fresh-store keeps plain `storeLinks`). `sequel` links preserved (not content-derivable, `resolver='sequel-auto'`).

#### 3. Tests
**File**: `src/tests/memory-link-resolver.test.ts` (extend — DB-write surface is currently untested), `src/tests/memory-edit.test.ts` (extend)
**Changes**: `storeLinks` persists + resolves wikilinks to ids; `refreshLinks` drops removed links, keeps surviving + sequel links; edit-path callers prune (regression for the lingering-links bug); get endpoint/tool return links + backlinks; ACL on backlinks.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] Suites pass: `bun test src/tests/memory-link-resolver.test.ts src/tests/memory-edit.test.ts src/tests/memory-get-tool.test.ts src/tests/memory.test.ts`
- [ ] OpenAPI regenerated for the get-response change: `bun run docs:openapi` (commit regenerated files)

#### Automated QA:
- [ ] Local walkthrough: store memory A with `[[B]]` + `[[C]]`; `memory_edit` A removing `[[C]]`; `GET /api/memory/{A}` shows links = {B}, not C; B's response shows A in backlinks; sqlite spot-check confirms the C row is deleted while any sequel row survives.

#### Manual Verification:
- [ ] None beyond phase review.

**Implementation Note**: Pause + commit `[phase 5] memory_link traversal + stale-link pruning`.

---

## Phase 6: Ride-alongs — DES-637 + DES-638

### Overview

Two isolated cleanups: delete the dead `dedupThreshold` from smart-recall, and give `agent_memory.tags` its first real producer (deterministic — `inject-learning`'s category) plus visibility in search results.

### Changes Required:

#### 1. DES-637 — dead arg deletion
**File**: `src/be/seed-scripts/catalog/smart-recall.ts:18-21,28`
**Changes**: remove the `dedupThreshold` argsSchema field and the destructure default. Nothing else references it (manifest description already threshold-free; re-seed is contentHash-automatic).

#### 2. DES-638 — deterministic tag producer
**File**: `src/tools/inject-learning.ts:73-79`
**Changes**: pass `tags: [category]` through to `store.store()` (schema field exists end-to-end; UI badges already render it).

#### 3. DES-638 — surface tags in search results
**File**: `src/http/memory.ts:501-513`, `src/tools/memory-search.ts:44-64,120-132`
**Changes**: include `tags` in the search response mapping + tool output schema (currently omitted; list/get already return them).

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] Suites pass: `bun test src/tests/seed-scripts.test.ts src/tests/memory.test.ts src/tests/memory-e2e.test.ts`
- [ ] OpenAPI regenerated (search response change): `bun run docs:openapi`

#### Automated QA:
- [ ] Local: call `inject-learning` (lead capability) with `category: "best-practice"`, then `POST /api/memory/list` + `POST /api/memory/search` both show `tags: ["best-practice"]`; UI detail sheet renders the badge.

#### Manual Verification:
- [ ] None beyond phase review.

**Implementation Note**: Commit `[phase 6] DES-637 dead dedupThreshold + DES-638 tags producer`. Close DES-637/DES-638 in Linear; DES-639 closes after Phases 4–5.

---

## Manual E2E

Against a local clean-DB server (`rm -f agent-swarm-db.sqlite* && MEMORY_HYBRID_SEARCH=1 MEMORY_GRAPH_EXPANSION=1 bun run start:http`; auth `Authorization: Bearer 123123` + `X-Agent-ID: <id>`):

1. **Seed**: `POST /api/memory/index` × 3 — memory A (`content` containing `[[B-name]]`), memory B (`name: "B-name"`, lexically distant content), memory C (throwaway).
2. **Graph arm**: `POST /api/memory/search` `{query: "<A's topic>", intent: "e2e", limit: 5}` with `X-Source-Task-ID: <task>` → B appears with `retrievalSource: "graph"`; flag off ⇒ absent.
3. **Traversal**: `GET /api/memory/{A-id}` → `links` contains B (resolved); `GET /api/memory/{B-id}` → `backlinks` contains A.
4. **Pruning**: `POST /api/memory/edit` `{memoryId: A, mode: "replace", content: "<no wikilinks>", intent: "e2e prune"}` → re-`GET` A shows empty links; `sqlite3 agent-swarm-db.sqlite "SELECT COUNT(*) FROM memory_link WHERE from_memory_id='<A>'"` → 0.
5. **Readout**: `curl "http://localhost:3013/api/memory/usefulness?days=1" -H "Authorization: Bearer 123123"` → volume from step 2, per-arm breakdown includes `graph`.
6. **UI**: open `http://localhost:5274/memory` → Usefulness panel renders tiles + charts; memory detail sheet shows the `best-practice` tag badge after an `inject-learning` call.
7. **Prod (Phase 3, Taras-gated)**: deployed-endpoint curl or read-only `ssh swarm-new "sqlite3 -readonly /var/lib/docker/volumes/swarm-new-22yjmi_swarm_db/_data/agent-swarm-db.sqlite '<sanity SQL>'"` — captured into the baseline QA doc.

## Open Questions (autopilot — flagged, not blocking)

1. **Inbound expansion**: Phase 4 expands outgoing links only (v1). Include backlink-direction expansion too? (Backlinks *are* exposed read-only in Phase 5.)
2. **Damping/cap defaults**: `0.7` damping × `strength`, cap 5 added neighbors — gut-feel starting points; tune after Phase 1 data shows graph-arm citation rates.
3. **Traversal shape**: chose embedding `links`/`backlinks` in `memory-get` over a separate `/api/memory/{id}/links` endpoint — cheaper for agents (one call). Veto if you'd rather keep get-payloads slim.
4. **Prod rollout**: enable `MEMORY_GRAPH_EXPANSION=1` in prod immediately after Phase 4 deploys, or soak locally first? (Readout makes either measurable.)

## Appendix

- **Follow-up plans / deferred**:
  - **Phase 3 of the original brainstorm** (always-loaded core/index + pre-created files) — go/no-go once this plan's readout has ≥2–3 weeks of trend data.
  - **LLM auto-tagger** for DES-638 — `completeStructured()` (`src/utils/internal-ai/complete-structured.ts:176-309`) + fire-and-forget post-insert is the ready-made shape, but unjustified while tags do no retrieval work; revisit if tags become a search filter (`MemorySearchOptions` + store SQL change).
  - **Intent-weighted posterior on edit**; **identity-file simplification** — separate tracks (unchanged from prior plan).
- **Derail notes** (found during research, out of scope):
  - `src/http/favorites.ts` is also missing from `scripts/generate-openapi.ts` (same drift as metrics — fix opportunistically or ticket it).
  - `storeSequelLink()` (`link-resolver.ts:218-226`) has zero call sites — dead until something creates sequel links; don't delete (Phase 5 pruning deliberately preserves the type), but ticket the missing producer.
  - Unresolved wikilinks never retry resolution — a memory created *after* a link pointing at its name stays unresolved. Candidate v2: re-resolve on target-name store.
  - Inbound `memory_link` rows pointing at a deleted memory linger (`targetId` has no FK) — Phase 5's traversal should tolerate dangling backlinks; a GC sweep is a v2.
  - `memory_retrieval.retrievalSource` has no CHECK constraint — TS-union-enforced only; fine for now, worth a CHECK if more arms accrete.
- **References**:
  - Brainstorm: `thoughts/taras/brainstorms/2026-06-25-memory-system-enhancements.md`
  - Prior plan (Phases 0–2, shipped as PR #829): `thoughts/taras/plans/2026-06-26-memory-enhancements-phases-0-2.md`
  - Research: `thoughts/taras/research/2026-06-25-memory-system.md`
  - Tickets: DES-639 (Phases 4–5), DES-637/DES-638 (Phase 6)
  - Split option: if one session can't carry all six phases, the clean seam is after Phase 3 (measurement plan) / before Phase 4 (graph plan).
