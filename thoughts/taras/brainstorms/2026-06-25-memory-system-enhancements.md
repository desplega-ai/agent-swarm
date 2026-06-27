---
date: 2026-06-25
author: Taras (facilitated by Claude)
topic: "Memory system enhancements — search dimensions, structure, editing, creation model"
tags: [brainstorm, memory, search, hybrid-search, agent-fs, structure]
status: complete
exploration_type: idea
last_updated: 2026-06-26
last_updated_by: Claude
---

# Memory System Enhancements — Brainstorm

## Context

Follows the research doc `thoughts/taras/research/2026-06-25-memory-system.md`, which mapped the current memory subsystem. Key current-state facts that frame this brainstorm:

- **Search is vector-only.** No keyword/FTS/BM25/substring search over memory `name` or `content`. Exact-match exists only as by-`id` (`memory-get`) + an internal exact-`name` lookup in the wikilink resolver.
- **Structure is flat.** A memory is `(agentId, scope, name)` with `scope ∈ {agent, swarm}`. No hierarchical/path/namespace key; `name` and `sourcePath` are free-form text.
- **No editing.** Creation is INSERT-only (fresh UUID, no upsert/dedup). The only "update" of content is re-indexing a file via delete-then-insert. No in-place edit tool.
- **Two creation models coexist:** (a) file-based — agents edit files under `/workspace/personal/memory/` (→agent) or `/workspace/shared/memory/` (→swarm), auto-indexed by a `PostToolUse` hook (`source=file_index`); (b) tool/endpoint-based — `inject-learning` (lead-only) and the internal `store-progress`/`/api/memory/index` paths.
- **Graph captured, not used.** `memory_link` (S3-like external + memory↔memory links) and `agent_memory_edge` exist but nothing reads them yet (tracked in DES-639).

### Ideas on the table (Taras's list)

1. **glob/grep** — lexical search by name / raw content (the missing keyword dimension).
2. **Multi-search: fuzzy + semantic** — hybrid retrieval. *Check `../agent-fs` for how it does this* (sub-agent study in flight).
3. **Impose a key (S3-like)** on memories — give them a real structure / namespace instead of flat free-form names.
4. **Editing memories** — in-place update instead of INSERT-only / delete-then-insert.
5. **Remove file-based memories?** — enforce creation only via tool, drop the `/workspace/.../memory/` file-index path. (Tentative — "unsure about this, but idea?")

## Exploration

### Q: Before solutioning — what's the biggest pain with memory today that this list is reacting to?

Primary driver is **#4 (messy creation model)** — "it might get easier for the agents to reason around memory + it's more pluggable." Plus:
- On **#1 (glob/grep)**: it's less about grep per se, more about "adding a way to support more *complete* matching" — discuss gains/tradeoffs.
- **#3 (no structure)** matters too.
- On **editing**: wants "updatable memories, similar to the agents claude/soul files — which I think we should **simplify** too, e.g. to 1 or 2 files tops — instead having **'core' memory links** for the rest, like a **single index and then pointers**."

**Insights:**
- The center of gravity isn't search — it's the **creation/structure/editing model**. Taras wants memory to be something agents can *reason about* and that's *pluggable*, not a flat append-only pile.
- A concrete architecture is emerging: a **small, editable "core" memory** (analogous to a simplified soul/CLAUDE file, 1–2 max) that acts as an **index of pointers** to detail memories — rather than many free-form memories. This unifies ideas #3 (structure), #4 (editing), and #5 (creation model).
- Search (#1, #2) is a supporting capability ("more complete matching"), not the main event.
- Open tension: the analogy to soul/CLAUDE files suggests he may also want to **simplify the harness-level soul files themselves**, and have the memory index point outward from there — i.e. memory and the agent's identity files may converge.

### Reference: how `../agent-fs` does it (sub-agent study, 2026-06-25)

Borrowable patterns from the sibling repo (`/Users/taras/Documents/code/agent-fs`, v0.9.0 — the live one, not the plugin cache):
- **Hybrid search = RRF (k=60), not weighted sum.** FTS5 (BM25) + sqlite-vec KNN run in parallel, over-fetch 3×, fuse per-document with `score += 1/(60 + rank)`. Tuning-free, scale-invariant across BM25-rank vs vector-distance. (`ops/search.ts:29-112`)
- **Single SQLite store** holds FTS5 + sqlite-vec together — no separate vector DB; lexical+semantic stay transactionally co-located. (`db/raw.ts:125-136`)
- **S3-like key**: `<orgId>/drives/<driveId>/<path>`; PK is `(path, drive_id)` so path is unique *per drive* (drive = namespace). Folders are virtual S3 prefixes; list-by-prefix via `Delimiter`. Soft-delete, never hard-delete. (`ops/versioning.ts:11-14`, `db/raw.ts:52`)
- **Editing = copy-on-write + append-only version ledger.** `file_versions(path, drive_id, version, s3_version_id, operation∈{write,edit,append,delete,revert}, …)`, monotonic version, `UNIQUE(path,drive,version)` as optimistic-concurrency guard → typed `EditConflictError`; `expectedVersion` pre-flight; **revert writes forward a new version** (never rewinds). Edit matches `old_string` exactly-once. (`ops/versioning.ts`, `ops/edit.ts`, `ops/revert.ts`)
- **Content-addressed dedup**: SHA-256 the payload; if it equals the head hash, skip the S3 PUT + version row + re-embedding entirely. Cheapest "did this actually change?" gate. (`ops/write.ts:75-103`)
- **Embeddings**: provider-agnostic interface (OpenAI `text-embedding-3-small` / Gemini / local nomic-GGUF) all pinned to **768 dims**; FTS indexed synchronously, embeddings async behind a `Semaphore(2)`, per-item `embedding_status`. Caveat: their vec0 is **L2** (no `distance_metric=cosine`) — borrow with cosine set explicitly. (`search/embeddings/*`, `search/pipeline.ts`)

> Relevance to our ideas: RRF → idea #2; FTS5-in-same-SQLite → idea #1; S3 key + `(path,namespace)` PK → idea #3; COW version ledger + exact-match edit + content-hash dedup → idea #4.

### Q: Should the core memory BE the soul file, sit alongside it, or be pointed at by it?

"Let's think of a nice file structure we could follow for the agent files (they could be **pre-created**, so they're always there), wdyt?"

**Insights:**
- Taras is leaning **into files** (not idea #5's "remove file-based"): the interface should be a **pre-created, always-present file structure** agents edit. Idea #5 resolves toward *keeping files but making them structured + canonical*, not dropping them.
- "Pre-created / always there" removes the agent's "where do I put this?" ambiguity → directly serves the #4-creation-model goal ("easier to reason about + pluggable").
- This converges the whole brainstorm onto a **file-layout design**: a tiny always-loaded core/index per scope + a predictable place for detail memories. The path becomes the structured key (idea #3), wikilinks in the index become `memory_link` pointers (ties into DES-639), and the notes corpus is what hybrid search (#1/#2) runs over.
- **Unresolved fork to surface next:** *backing store*. Same layout can live on (a) the local workspace FS (current model — `PostToolUse` hook indexes into the swarm SQLite), or (b) **agent-fs** (S3-backed, versioned, RRF-hybrid-searchable — the #813 "agent-fs first-class" direction, which already solves ideas #1–#4). The layout proposal is store-agnostic; the store choice is the next decision.

### Q: Proposed file structure (options A/B/C) — which shape?

Didn't pick a layout — redirected to the full surface area: "we should think of: **what default memories we create** + **how we change the agent model** + **how the prompts are changed** + **migration**."

**Insights:**
- Zooming out from the filename micro-choice to the four workstreams that make this real. Layout (A/B/C) is secondary.
- Transition point: from "explore the idea" → "scope the change." Synthesis now organizes around these four dimensions + the open forks.

## Synthesis

### Direction (where we landed)

A **pre-created, always-present** per-scope memory layout: one slim, editable **core/index** (profile + auto pointer-index) + a `notes/` corpus of detail memories retrieved on demand. This unifies the ideas: path = structured key (#3); index wikilinks = `memory_link` pointers (feeds DES-639); the notes corpus is what hybrid search (#1/#2) runs over; files are individually editable + versioned (#4). Idea #5 resolves to **keep files as the interface but make them structured/canonical**, not "remove files."

### The pivotal fork — backing store (gates everything below)

- **Option L — local-FS (today's model):** files in `/workspace/{personal,shared}/memory/`, `PostToolUse` hook indexes into the swarm SQLite. We'd build FTS5 + COW versioning + a key column ourselves.
- **Option F — agent-fs-backed (#813 direction):** memory notes *are* agent-fs files (S3-backed). agent-fs already provides RRF hybrid search, S3-like keys, COW edit/revert, content-hash dedup. Swarm keeps retrieval-into-prompt + rating/usefulness + core-index injection.
- **DECIDED (Taras): Option L — swarm-native, "always."** Memory stays a first-class swarm concern in the swarm's own store — **NOT** agent-fs. We **borrow agent-fs's patterns** (RRF hybrid merge, COW version ledger, S3-like key, content-hash dedup) but build them into the swarm memory system (`bun:sqlite` FTS5 + sqlite-vec, `agent_memory` / `memory_link`). Rationale: keeps the rater/usefulness + retrieval-audit + agent/swarm scope machinery native; avoids cross-system coupling. *(Interpretation flagged back to Taras: "swarm-native store" vs "default to swarm scope" — confirm.)*

### Key Decisions (the four dimensions)

**1. Default memories (seed content)** — pre-create per scope: `index.md` (profile template + empty `## Index`). Possibly seed `shared/index.md` with swarm conventions. TBD: profile fields, seed pointers, the nudge language to keep the index maintained.

**2. Agent-model changes** — (a) mark **core/index** (always-loaded) vs **note** (on-demand): a `kind ∈ {core,note}` flag or `name='index'` convention; (b) **structured key/path** on `agent_memory` (#3) — or under Option F the agent-fs path *is* the key; (c) **pointers** = reuse `memory_link` (wikilinks already parsed → first real consumer); (d) **editing** = in-place update + versioning (#4: COW like agent-fs, or version/`updatedAt` on `agent_memory`); (e) **hybrid search** (#1/#2): add FTS5 (local) or use agent-fs RRF.

**3. Prompt changes** — inject the always-loaded **core/index** at task start (agent's own + swarm's). Instruct agents: read index → follow pointers / search for detail; write durable facts to `notes/` + update the index; **edit in place** instead of appending duplicates. Trim the current memory addendum + the always-loaded soul content (Taras's "simplify to 1–2").

**4. Migration** — backfill existing flat memories into `notes/<slug>` + generate per-scope `index.md` from them; backward-compat the hook (L) or dual-write during transition (F); reindex if going agent-fs (512-d cosine → 768-d).

### Open Questions
- ~~Backing store L vs F~~ — **RESOLVED: swarm-native (L), always.** (Confirm the "store vs scope" interpretation.)
- Layout A/B/C (one core file / two / index-only).
- Does "simplify soul files to 1–2" mean refactoring the **harness** CLAUDE/soul files, or only the memory core?
- Keep the rater/usefulness + retrieval-logging machinery as-is on top of the new structure?

### Constraints Identified
- API server is sole DB owner; workers go over HTTP (must keep).
- Memory embeddings are 512-d/cosine; agent-fs is 768-d/L2 — reconcile if merging.
- Only the **slim core** is always-loaded — pre-created files must not bloat context.
- Existing memory machinery (raters, retrieval audit, TTL/GC) should survive the change or be deliberately retired.

### Core Requirements (lightweight PRD)
- Pre-created, always-present per-scope layout: slim editable **core/index** + `notes/` corpus.
- In-place **editing + versioning** of memories.
- **Hybrid** (lexical + semantic) retrieval over notes.
- **Structured key/path** per memory.
- **Index → pointers** wiring (first `memory_link` consumer).
- Always-loaded core **injected into prompts**; agents instructed to maintain it.
- **Migration** path + chosen backing store.

## Research Findings (background)

### R1 — Prompt composition & always-loaded budget ✅

- **Always-loaded floor ≈ 5–6K tokens/task** for a default local worker (10 composite blocks ≈ 3.6K + the identity files ≈ 1.7K), higher for lead. Source `src/prompts/base-prompt.ts`, `session-templates.ts`.
- **The "soul files" Taras wants to simplify = four per-agent identity files**, all always-loaded for local agents: `SOUL.md` (~2.4KB), `IDENTITY.md`, `TOOLS.md`, `CLAUDE.md` (on disk at `/workspace/*.md`, synced to DB via `profile-sync.ts`; defaults in `src/prompts/defaults.ts`). "Simplify to 1–2" = consolidate these four → an injection slot already exists (`## Your Identity`, `base-prompt.ts:146-161`).
- **Today's memory addendum is per-task + conditional, NOT always-loaded**: `renderMemoriesPrompt` (`memories.ts:35-50`) injects top-5 memories with similarity > 0.4 into the *task* prompt (`runner.ts:4815-4826`). The always-on bit is just the *instruction to recall* (filesystem + seed_scripts templates).
- **Cost reality (confirms candor gap #4):** the system prompt is **rebuilt and re-sent every task** (`runner.ts:4972`); native session resume is deprecated, so prompt-cache reuse across tasks is not guaranteed — every always-loaded token is paid per-task-per-agent, multiplied by task volume. A per-swarm core is paid by *every agent's every task*. There is a 120K-char argv cap but **no token-cost budget enforcement** anywhere.
- **Injection points:** per-agent core → alongside `soulMd`/`identityMd` in `## Your Identity` (already always-loaded, no new gating). Per-swarm core → a new `system.agent.core` registered template added to the worker/lead composites.

### R2 — Hybrid search (FTS5 + RRF) feasibility ✅ — GREEN LIGHT, low-risk

- **FTS5 is native to bun:sqlite** — compiled in, no extension load, no guard (unlike `sqlite-vec`, which is conditional). agent-fs already runs FTS5 + vec0 in one bun:sqlite handle. Hybrid degrades cleanly: if vec is unavailable, FTS5 still works as the keyword path.
- **Shape:** add `memory_fts USING fts5(memory_id UNINDEXED, name, content, tokenize='porter unicode61')`; sync at the **same 4 mutation points** as `memory_vec` (`store`, `delete`, `deleteBySourcePath`, `purgeExpired` in `sqlite-store.ts`).
- **Merge:** a `searchHybrid()` runs the existing `searchWithVec` + a new `searchFts` (BM25 `rank`), over-fetches ~3×, fuses per memory id with RRF `score += 1/(60+rank)`, sets `similarity = RRF`, and hands to the **existing `rerank()` untouched** — keep all four factors (recency/access/source/usefulness); they're orthogonal multipliers.
- **Backfill is CHEAP** — content is already in `agent_memory`, so it's a synchronous SQL one-shot (`INSERT … SELECT id,name,content`), *no* OpenAI call (unlike `boot-reembed`). No data migration risk.
- **Gotchas (manageable):** sanitize NL → FTS MATCH (tokenize to quoted `OR` + try/catch → `[]`); tokenizer choice affects code-identifier recall (porter stemming vs unicode61; changing it later = new migration); FTS sync must be added at *all 4* sites or it drifts (boot `LEFT JOIN` reconciles); a memory is lexically searchable before its embedding lands (RRF handles single-arm hits fine).
- **Verdict:** this confirms candor gap #3 — hybrid search is **additive, no data migration, degrades cleanly, reuses the reranker**. It's the low-risk, high-value slice that should ship *before* the structural redesign.

### R3 — Editing + versioning + structured key ✅ — bigger lift, but well-precedented

- **Structured key = one nullable `key TEXT` column, orthogonal to scope.** Scope (`agent`/`swarm`) stays ACL-authoritative (`addScopeConditions`); `personal/notes/<slug>` is a *naming convention*, not the visibility gate. `name` (display) and `key` (addressable target) coexist. Uniqueness via partial index `(scope, COALESCE(agentId,''), key, chunkIndex) WHERE key IS NOT NULL`.
- **Editing = new `edit()` store method + `memory_edit` MCP tool**, two modes: `replace` (full body) and `exact` (single-occurrence `oldString`→`newString`, like the native Edit tool). One transaction updates content + `contentHash` + re-embed (`updateEmbedding` already syncs `memory_vec`) + `updatedAt` + version ledger + re-run `storeLinks`.
- **Versioning is NOT novel here — 3 precedents already in the repo**: `context_versions` (`db.ts:3677-3702`), `script_versions` (`064`), `page_versions` (`060`), plus a `contentSha256` helper (`profile-sync.ts:54`). New `agent_memory_version` table mirrors them: hash short-circuit (skip write+re-embed if unchanged), monotonic `version`, `UNIQUE(memory_id, version)` = optimistic-concurrency latch → 409 on race (reuse `applyRating`'s pattern).
- **Interaction decisions to make (R3's risk table):** (a) does `replace` reset the `alpha/beta` posterior or keep it? (b) does edit refresh TTL? (c) `PROTECTED_SOURCES=manual` should be *editable* (it's curated knowledge meant to be maintained — don't inherit "protected = immutable"); (d) `memory_link` re-resolve is additive — stale links linger (v1) until a v2 prune; (e) **v1 restricts edit to single-chunk rows** (`totalChunks=1`); multi-chunk re-chunk is v2.
- **Migration 098** (forward-only): add `key`/`contentHash`/`version`/`updatedAt` cols + the ledger table; backfill `key='legacy/'||id` (collision-free since id is the UUID PK), `version=1`, `updatedAt=createdAt`; `contentHash` filled app-side (boot routine like `boot-reembed`, or lazily on first edit).
- **Verdict:** this is the "bigger, harder-to-reverse" bet (schema migration + new table + new tool + several semantic decisions + chunking caveat), but the version-ledger machinery is **copy-the-existing-pattern**, not greenfield. Confirms candor gap #3's sequencing: do this *after* hybrid search.

### R4 — Usage data + rater/machinery fate ✅ — the most consequential

**Part A — do we have a scoreboard? (candor gap #1)**
- **`memory_retrieval` IS flowing today** (not gated) — every pre-task recall writes rows (`runner.ts:2345`). So retrieval *volume* is measurable right now.
- **`memory_rating` (citation/usefulness) is GATED on `MEMORY_RATERS`, which defaults to EMPTY/off** (`raters/registry.ts:46-49`). So **usefulness data is NOT flowing** unless explicitly enabled — we currently *cannot* measure whether memory is useful. R4 supplies a ready citation-rate SQL query + a "is anything flowing" sanity query, and notes an existing on-demand aggregator (`seed-scripts/catalog/memory-eval.ts`) that's never been productized into an endpoint/UI.

**Part B — what the redesign breaks/keeps:**
- **STABLE `agent_memory.id` is the linchpin.** All three raters + both audit tables key on `id`. **In-place `edit()` (R3) preserves `id` → keeps raters/audit/posteriors intact**; the *current* delete-then-reinsert path re-mints the UUID → resets `alpha/beta`, cascade-deletes `memory_link`, and orphans prior ratings/retrievals. → strong argument that R3's `edit()` should *replace* the lossy re-index path.
- **The always-injected "core" doc sits ENTIRELY OUTSIDE the retrieval/rating loop** (candor gap #2, reinforced): no `search`/`get` event → no `memory_retrieval` row → no rater input → **no usefulness signal at all**, and `eventType` is CHECK-constrained to `'search'|'get'`. So as built we'd have *zero* measurement on whether the core/index is pulling its weight (while paying its token cost every task per R1).
- **TTL trap:** `expiresAt` is set once at insert and never updated on edit — edited notes still hard-delete on their original schedule. Persistent core/notes need `source:'manual'` (TTL null, protected) or a new non-expiring source.
- **Reranker:** survives; a new `core`/`note` source ranks neutral 1.0 until added to `SOURCE_QUALITY_MULTIPLIER`. The automatic-task gate is orthogonal and untouched.

## Recommended Sequencing (post-research)

The four researches converge on a phased order that front-loads certainty and defers the risky/unmeasurable part:

- **Phase 0 — MEASURE (≈free, do first).** Run R4's sanity + citation queries. Turn on the `implicit-citation` rater (`MEMORY_RATERS=implicit-citation`) so usefulness data starts flowing. **We're currently blind on whether memory is even useful** — fix that before redesigning. Answers "is there a problem, and where."
- **Phase 1 — HYBRID SEARCH (low-risk, high-value).** R2: `memory_fts` + RRF, reuses the reranker, no data migration, degrades cleanly. Ship it, watch the Phase-0 citation rate move. This is the cheap win that shouldn't wait on the redesign.
- **Phase 2 — IN-PLACE EDITING + VERSIONING + KEY (structural, well-precedented).** R3: `edit()` / `memory_edit` + `agent_memory_version` + `key` column (migration 098). Must **preserve `id`** (R4 linchpin) — this also *fixes* the lossy delete-reinsert. Delivers "updatable memories" (idea #4) + structure (idea #3).
- **Phase 3 — CORE/INDEX + PRE-CREATED FILES (the big idea; design-gated).** The always-loaded core + pointer index. **Hold until Phase 0–2 data shows search alone isn't enough**, because R4 shows the core has no usefulness signal as built and R1 shows it's paid per-task-per-agent. Open question stands: does the index earn its keep over good hybrid search?
- **Parallel track — simplify the 4 identity files** (`SOUL/IDENTITY/TOOLS/CLAUDE` → 1–2, per R1) — separable, can ride alongside any phase.

## Next Steps

**Status: complete.** All four researches landed (R1–R4 above), the radical-candor gaps were ironed out, and the phased recommendation is set.

**Handoff (Taras): → `/create-plan` for Phases 0–2** (measure → hybrid search → editing/versioning/key). **Phase 3** (core/index + pre-created files) is deliberately **deferred/gated** on Phase 0–2 data (R4 shows the core has no usefulness signal as built; R1 shows it's paid per-task-per-agent).

Input context for the plan: this brainstorm + `thoughts/taras/research/2026-06-25-memory-system.md`. Related tracked items: DES-637 (delete dead `dedupThreshold`), DES-638 (auto-tag `tags`), DES-639 (finish `memory_link` read side).

Radical-candor gaps (all addressed by research): index-maintenance vs "just search" (gap #2, reinforced by R4's core-outside-the-loop finding); sequencing cheap-win-first (gap #3, confirmed by R2 vs R3); no success metric / unused usage data (gap #1, R4 — raters off by default); always-loaded cost + shared-core contention (gap #4, R1 — no token budget, rebuilt every task).
