---
date: 2026-07-30
researcher: Claude (for Taras)
git_commit: 0c15fc28
branch: research/profile-files-memory-integration (worktree off origin/main)
repository: desplega-ai/agent-swarm
topic: "Integrating agent profile files (soul, claude, tools, …) into the memory system — agent-scoped native queryability"
tags: [research, codebase, memory, agent-profile, soul, identity, file-index, embeddings]
status: complete
autonomy: critical
last_updated: 2026-07-30
last_updated_by: Claude (for Taras)
---

# Research: Agent profile files → memory system integration

**Date**: 2026-07-30
**Git Commit**: `0c15fc28` (latest `origin/main` at research time)
**Worktree**: `/Users/taras/worktrees/agent-swarm/2026-07-30-research-profile-memory`

## Research Question

How could the agent profile files (SOUL.md, CLAUDE.md, TOOLS.md, etc.) be integrated into the memory system so they are queryable (agent-scoped) in a native way?

## Summary

**The profile files are already server-side; they are just not in the memory index.** All six profile fields (`soulMd`, `identityMd`, `toolsMd`, `heartbeatMd`, `claudeMd`, `setupScript`) live as `TEXT` columns on the `agents` table with full append-only version history (`context_versions`), and every write path — worker hooks, pi extension, runner-level sync, the `update-profile` MCP tool, and the dashboard UI — converges on a **single chokepoint**: `PUT /api/agents/{id}/profile` → `updateAgentProfile()` (`src/be/db.ts:5030-5146`), which already SHA-256-diffs content on every write.

Meanwhile the memory system already has a **generic file-ingestion path**: `POST /api/memory/index` chunks arbitrary text, dedups re-indexes by `sourcePath`, embeds asynchronously, and serves it back through hybrid FTS5+vec search with strict agent/swarm scoping. Workspace files under `/workspace/{personal,shared}/memory/` are auto-indexed through it today (`source='file_index'`).

The gap is precisely that these two pipelines are **disjoint**, even though they fire from the *same* `PostToolUse` dispatch in `src/hooks/hook.ts`: an edit to `/workspace/SOUL.md` takes the profile-PUT branch; an edit to `/workspace/personal/memory/x.md` takes the memory-index branch. Nothing bridges `agents.soulMd` (et al.) into `agent_memory`, so `memory-search` cannot see profile content.

Because all profile writes funnel through one server-side function that already computes content hashes, the natural integration surface is a **server-side fan-in at `updateAgentProfile()`** — index the changed field into memory on genuine content change, reusing the existing `sourcePath`/`key` dedup machinery. This covers all five write paths and all harnesses (including Codex/OpenCode, which have no file-indexing hooks) with zero worker-side changes. Alternatives (worker-side hook extension; query-time federation over `agents` columns) are documented in §5 with their trade-offs as found in the code.

---

## Detailed Findings

### 1. Agent profile file system (as-is)

#### 1.1 Inventory

| File | Workspace path | DB column | Prompt injection |
|---|---|---|---|
| SOUL.md | `/workspace/SOUL.md` | `agents.soulMd` | verbatim, `## Your Identity` |
| IDENTITY.md | `/workspace/IDENTITY.md` | `agents.identityMd` | verbatim, `## Your Identity` |
| TOOLS.md | `/workspace/TOOLS.md` | `agents.toolsMd` | budgeted, `## Your Tools & Capabilities` |
| HEARTBEAT.md | `/workspace/HEARTBEAT.md` | `agents.heartbeatMd` | not injected (agent reads file) |
| CLAUDE.md | `/workspace/CLAUDE.md` / `~/.claude/CLAUDE.md` | `agents.claudeMd` | budgeted, `## Agent Instructions` |
| start-up.sh | `/workspace/start-up.sh` (agent-managed block) | `agents.setupScript` | not injected (executed at boot) |
| todos.md | `/workspace/personal/todos.md` | **none** | none — purely workspace-local |

- Versionable field list: `VERSIONABLE_FIELDS` at `src/be/db.ts:424-431`; zod side `VersionableFieldSchema` at `src/types.ts:993-1000`.
- Default content generators: `src/prompts/defaults.ts:9-196` (`generateDefaultClaudeMd` / `SoulMd` / `IdentityMd` / `ToolsMd`).
- `todos.md` is created by `docker-entrypoint.sh:662-674` and has **no** DB column, HTTP route, or sync code anywhere under `src/` — it is the only profile-adjacent file that is invisible server-side. The `todos` skill (`plugin/commands/todos.md`) is file-only.
- Codex's `AGENTS.md` is not an identity file — it is a transport vehicle: the fully-assembled system prompt (already containing soul/identity/tools/claude content) is written into a delimited `<swarm_system_prompt>` block (`src/providers/codex-agents-md.ts`).

#### 1.2 Storage & versioning (server-side, already exists)

- Columns on `agents`: `src/be/migrations/001_initial.sql:20-24` (original four) + `027_heartbeat_md.sql` (`heartbeatMd`); defensive `ensureAgentProfileColumns` at `src/be/db.ts:433-450`.
- **`context_versions`** (`001_initial.sql:310-325`): append-only history — `field`, `content`, `version`, `changeSource` (`self_edit` / `lead_coaching` / `api` / `system` / `session_sync`), `changedByAgentId`, `changeReason`, `contentHash`, `previousVersionId`. New row only when SHA-256 differs (`computeContentHash`, `src/be/db.ts:5057-5065`).
- Read surfaces: `GET /me` (`src/http/core.ts:386-419`), `GET /api/agents/{id}`, `GET /api/agents` (slim by default — profile blobs excluded unless `?fields=full`, `src/http/agents.ts:115-131`), `GET /api/agents/{id}/setup-script` (used by `docker-entrypoint.sh:567-656`), and the `context-history` MCP tool (metadata only, RBAC `agent.context.read.any`, `src/tools/context-history.ts`).

#### 1.3 Write paths — five, all converging on one endpoint

All flow through `PUT /api/agents/{id}/profile` (`src/http/agents.ts:161-189`, handler `441-506`) → `updateAgentProfile()` (`src/be/db.ts:5030-5146`), the **sole DB write path**:

1. **`update-profile` MCP tool** (`src/tools/update-profile.ts`) — self or lead (RBAC `agent.profile.update.any`); `bash -n` validation for `setupScript`; also dual-writes `/workspace/*` files when caller is the live agent (guard at `:312`).
2. **Claude hooks** (`src/hooks/hook.ts`) — `syncClaudeMdToServer` (:529-552), `syncIdentityFilesToServer` (:567-643), `syncSetupScriptToServer` (:649-689); fired on `PostToolUse` path-match (:1092-1117, `change source: self_edit`) and unconditionally on `Stop` (:1204-1214, `session_sync`).
3. **Pi extension** (`src/providers/pi-mono-extension.ts:93-166`) — same idea; covers soul/identity/tools only (no heartbeat).
4. **Harness-agnostic runner sync** (`src/commands/profile-sync.ts`, called from `src/commands/runner.ts:4106-4138`) — HTTP-only backstop that gives **Codex/OpenCode** (no hooks of their own) a sync path; runs once per finished local-session batch.
5. **Dashboard UI** (`apps/ui/src/pages/agents/[id]/page.tsx:55-73`) — tabbed editor, PUTs the same endpoint.

Anti-clobber: boot-time SHA-256 baselines (`/tmp/identity-baselines.json`, `writeIdentityBaselines` at `src/commands/runner.ts:4993-5008`, read helpers in `profile-sync.ts:50-72`) let session-end sync skip unmodified files so a lead's concurrent DB edit isn't overwritten. Guards: 500-char min for soul/identity (`IDENTITY_FILE_MIN_LENGTH`, `hook.ts:557`), 65536-char max skip.

#### 1.4 Lifecycle (pull side)

- `join-swarm` writes generated defaults for `claudeMd`/`soulMd`/`identityMd` at registration (`src/tools/join-swarm.ts:110-144`).

  **What the defaults contain** (`src/prompts/defaults.ts`, pure functions parameterized on `{name, description?, role?, capabilities?}`):
  - `generateDefaultClaudeMd` (:9-54) — `# Agent: <name>` + optional description/Role/Capabilities sections, a "Your Identity Files" primer (lists SOUL/IDENTITY/TOOLS/start-up.sh and states they auto-sync to DB), a "Memory" section teaching `memory-search` + the `/workspace/{personal,shared}/memory/` convention, and empty `### Learnings` / `### Preferences` / `### Important Context` note stubs.
  - `generateDefaultSoulMd` (:56-114) — "You're not a chatbot. You're becoming someone." persona seed: Who You Are (persistent entity), Core Truths (genuine helpfulness, self-sufficiency, personality, earned trust), How You Operate, Boundaries, Growth Mindset (reflect → evolve start-up.sh/TOOLS.md/CLAUDE.md), Self-Evolution (files are yours, persist across sessions).
  - `generateDefaultIdentityMd` (:116-152) — name/role/"Vibe: (discover and fill in)" stub + optional About/Expertise from description/capabilities + empty Working Style / Quirks / Self-Evolution scaffolding.
  - `generateDefaultToolsMd` (:154-196) — empty scaffolding with HTML-comment placeholders: Repos / Services / Infrastructure / APIs & Integrations / Tools & Shortcuts / Notes.
  - `toolsMd`/`heartbeatMd`/`setupScript` get **no** default at join time; `toolsMd` default is applied later by the runner if still missing. Templates (`templates/official/*/config.json` `files.*` maps) take precedence over the generic generators at runner boot (`runner.ts:4822-4854`).
- Runner boot: `GET /me` → template-file fallback → generic defaults (pushed back to server), then `Bun.write` to `/workspace/*` (`src/commands/runner.ts:4784-4991`).
- Prompt assembly: `getBasePrompt` (`src/prompts/base-prompt.ts:107-403`) injects soul/identity verbatim (gated on `traits.hasLocalEnvironment`), claude/tools under budgets (`BOOTSTRAP_MAX_CHARS`=20K per section, `BOOTSTRAP_TOTAL_MAX_CHARS`=120K total, `truncateSection` :424-444).

### 2. Memory system (as-is)

#### 2.1 Schema

`agent_memory` (`src/be/migrations/001_initial.sql:271-287` + additive migrations):
- Scoping: `agentId` (nullable) + `scope CHECK IN ('agent','swarm')` — strict two-value enum; **no task/project scope**. `sourceTaskId` is provenance only, not an ACL dimension.
- Taxonomy: `source CHECK IN ('manual','file_index','session_summary','task_completion')` (`AgentMemorySourceSchema`, `src/types.ts:1399-1404`); free-form `tags` JSON array; no other "kind" axis.
- Structured identity (migration `099_memory_structured_key_versioning.sql`): `key`, `contentHash`, `version`, `updatedAt` + **unique index on `(scope, COALESCE(agentId,''), key, chunkIndex)`** — memories are addressable by `key+scope`, with edit history in `agent_memory_version`.
- Posteriors: `alpha`/`beta` (migration 051) driven exclusively by `applyRating()` (`src/be/memory/raters/store.ts:47-208`).
- Graph: `memory_link` (wikilinks/PR/agent-fs/agent-ui links, migration 096) + `agent_memory_edge` (rater-driven `references-source` edges, migration 052).
- Indexes: `memory_fts` (FTS5, porter) and `memory_vec` (sqlite-vec, cosine) — created/healed by `SqliteMemoryStore` at boot (`src/be/memory/providers/sqlite-store.ts:169-378`).

#### 2.2 Ingestion — `POST /api/memory/index` (`src/http/memory.ts:343-483`)

- Chunks via `chunkContent()` (`src/be/chunking.ts`: header-split → recursive split, `MAX_CHUNK_SIZE` 2000 chars, 100-char overlap).
- **Re-index dedup by `sourcePath`**: single-chunk → in-place `store.edit()` (preserves id/posterior, bumps `agent_memory_version`); multi-chunk/ambiguous → `deleteBySourcePath()` + re-insert (`memory.ts:389-425`).
- `edit()` short-circuits (`changed: false`) when the new `contentHash` matches (`sqlite-store.ts:910-919`).
- Deterministic links extracted into `memory_link` (`storeLinks`/`refreshLinks`, `src/be/memory/link-resolver.ts`).
- Embedding is **async fire-and-forget server-side** after a 202 (`memory.ts:467-479`); provider `text-embedding-3-small` @ 512 dims (`src/be/memory/providers/openai-embedding.ts`), graceful no-op without a key (FTS fallback). Backfills: `POST /api/memory/re-embed` + boot-time `runBootReembed()`.
- Current callers: Stop-hook session summaries (`src/hooks/hook.ts:274-392`) and the memory-dir file auto-index (`hook.ts:1119-1152`; pi `src/providers/pi-mono-extension.ts:188-209`; opencode `plugin/opencode-plugins/agent-swarm.ts:133-154`). **Codex has no file-indexing hook** — its only memory write is the end-of-turn `session_summary` (`src/providers/codex-adapter.ts:1145-1223`).
- `store-progress` writes `task_completion` memories directly in-process (`src/tools/store-progress.ts:330-395`), with auto-promotion of research/knowledge tasks to `swarm` scope.

#### 2.3 Retrieval & agent scoping (the "native queryability" that already exists)

- `memory-search` MCP tool (`src/tools/memory-search.ts`): `query`, required `intent`, `scope: all|agent|swarm`, `limit`, optional `source` filter. Agent identity is **server-derived** from the `x-agent-id` transport header (`getRequestInfo`, `src/tools/utils.ts:29-61`) — never client-passed.
- Scope enforcement in `addScopeConditions()` (`sqlite-store.ts:786-812`): non-lead sees own `agent`-scoped rows + all `swarm` rows; **leads see everything** (all agents' agent-scoped memories) — which matches the lead-coaching use case for profile content.
- Ranking: hybrid vec+FTS via RRF (k=60) → optional 1-hop graph expansion (`MEMORY_GRAPH_EXPANSION`, default on) → reranker: `similarity × recencyDecay × accessBoost × sourceQuality × usefulness(α,β)` (`src/be/memory/reranker.ts`). Source-dependent knobs: half-lives (manual=∞, file_index=180d, task_completion=14d, session_summary=7d), quality (1.5 / 1.0 / 0.7 / 0.5), TTLs (`TTL_DEFAULTS`: manual=null, file_index=30d, …), `PROTECTED_SOURCES` shields `manual` from automated deletion (`src/be/memory/constants.ts`).
- Automatic recall: `fetchRelevantMemories()` (`src/commands/runner.ts:2759-2797`) runs a 5-result search on task assignment/resume; `renderMemoriesPrompt()` (`src/prompts/memories.ts:35-50`) injects a `### Relevant Past Knowledge` block for results with similarity > 0.4 (300-char previews).
- Access ACL on direct reads: `canReadMemory()` (`src/be/memory/access.ts:3-5`).

### 3. The gap — two disjoint pipelines off the same events

The same `PostToolUse` dispatch in `src/hooks/hook.ts:1092-1152` routes:
- exact-path match (`/workspace/SOUL.md` etc.) → `PUT /api/agents/{id}/profile` (agents columns; **not searchable**),
- prefix match (`/workspace/{personal,shared}/memory/`) → `POST /api/memory/index` (searchable; **not versioned in `context_versions`**).

Consequences observable in code today:
- `memory-search` cannot return anything from SOUL.md / TOOLS.md / CLAUDE.md content — profile knowledge is only reachable via full-blob reads (`GET /me`, `GET /api/agents/{id}?fields=full`) or the on-disk files.
- A lead coaching an agent via `update-profile` produces a `context_versions` row but nothing memory-searchable.
- Two parallel version stores exist for file-shaped content: `context_versions` (profile) and `agent_memory_version` (memory) — structurally similar (hash-diffed, append-only) but unconnected.
- TOOLS.md/CLAUDE.md are truncated at 20K chars in the system prompt with a "read the file" notice (`base-prompt.ts:367-399`) — the overflow content is exactly the part that is *only* reachable by reading the whole file, since it isn't indexed.

### 4. Existing mechanics an integration can reuse (as found)

| Mechanism | Where | Relevance |
|---|---|---|
| Single profile-write chokepoint, already hash-diffing | `updateAgentProfile`, `src/be/db.ts:5030-5146` | one place sees *every* profile change, from every harness + UI, with change deduplication already done |
| `sourcePath`-keyed re-index (edit-in-place or delete+reinsert) | `src/http/memory.ts:389-425`, `deleteBySourcePath` | idempotent upsert semantics for file-shaped content already exist |
| `key` + unique `(scope, agentId, key, chunkIndex)` | migration 099, `sqlite-store.ts` | stable addressable identity (e.g. `profile:soul`) independent of path |
| `contentHash` short-circuit on edit | `sqlite-store.ts:910-919` | no-op on redundant syncs |
| Per-source TTL / half-life / quality / protection knobs | `src/be/memory/constants.ts` | a profile-shaped source can be tuned (or `manual`-like: no TTL, protected) without touching the reranker formula |
| Agent/swarm scoping + lead full visibility | `addScopeConditions`, `sqlite-store.ts:786-812` | `scope='agent'` rows are natively agent-scoped; leads can query any agent's profile memories |
| Chunking with header awareness | `src/be/chunking.ts` | markdown profile files split on `#`/`##` sections naturally |
| Async embed + re-embed backfill | `memory.ts:467-479`, `/api/memory/re-embed`, `boot-reembed.ts` | initial backfill of existing agents' profiles has a precedent path |
| Source enum CHECK + zod schema pairing | `001_initial.sql:279`, `src/types.ts:1399-1404` | adding a new `source` value requires a migration **and** the zod update (CLAUDE.md sync rule) |

### 5. Integration surfaces (options, grounded in the as-is)

> Explicitly requested by the research question; these are surfaces the current architecture exposes, with trade-offs as evidenced in code — not a design decision.

**Option A — server-side fan-in at the profile chokepoint (`updateAgentProfile`). ✅ Chosen in review — with bidirectional sync (see Review Decisions).**
On a genuine content change (the function already knows, via `computeContentHash` diff), index the changed field into `agent_memory` — either by calling the memory store in-process (the API server owns both) or by reusing the `POST /api/memory/index` handler logic. Natural parameters given existing machinery: `scope:'agent'`, `sourcePath:'/workspace/SOUL.md'` (reuses the existing dedup path verbatim), `key:'profile:<field>'`, `name` = filename, `contextKey` from the write's request context.
- Covers **all five** write paths (hooks, pi, runner sync, MCP tool, UI/lead edits) and **all harnesses** including Codex/OpenCode — because it sits below them all.
- Zero worker-side changes; no new transport; no per-harness duplication.
- Choice-point surfaced by the code: which `source` value. Reusing `'file_index'` inherits TTL 30d / half-life 180d / quality 1.0 (profile rows would age and expire); `'manual'` semantics (TTL null, protected, quality 1.5) match "canonical identity content" but overload provenance; a new `'profile'` source needs a CHECK-constraint migration + `AgentMemorySourceSchema` update + entries in `TTL_DEFAULTS`/half-life/quality maps.
- Backfill for existing agents has precedent: a boot-time or admin-triggered sweep over `agents` rows, mirroring `runBootReembed()` / `POST /api/memory/re-embed`.

**Option B — worker-side: extend the hook path-match to also POST `/api/memory/index` for profile paths.**
Mechanically identical to the existing memory-dir auto-index (`hook.ts:1119-1152`).
- Requires touching every harness surface separately (Claude hook, pi extension, opencode plugin) and **still misses Codex** (no hooks) plus all non-worker writers (UI, lead `update-profile`, `join-swarm` defaults, runner-generated defaults).
- Duplicates transport for content the server already receives via the profile PUT.
- The as-is codebase already demonstrates this fragmentation cost: the pi extension covers only 3 of 4 identity files, and `profile-sync.ts` exists precisely as a backstop for hooks that "can silently not-fire".

**Option C — query-time federation (no copy): make search read `agents` columns directly.**
E.g. an FTS index / view over the six profile columns consulted by `memory-search` alongside `agent_memory`.
- Avoids duplication/staleness entirely (single source of truth stays the `agents` row).
- But bypasses everything that makes memory retrieval "native": no chunking (whole 16-65K blobs), no embeddings/vec arm, no RRF/reranker participation, no `memory_retrieval` audit → no rater signal, no graph links. Would need a parallel index + merge layer inside `search()` — the most invasive change to the read path, and the only option that adds a second retrieval code path rather than reusing the existing one.

**Cross-cutting observations (from the as-is, whichever surface is chosen):**
- **Prompt duplication**: soul/identity are already injected verbatim into every system prompt (`base-prompt.ts:220-235`); if indexed, pre-task recall (`renderMemoriesPrompt`, similarity > 0.4) could surface the same content redundantly. The existing `source` filter on `memory-search` and the reranker's source-quality knob are the in-place levers for tuning that.
- **Dual version history**: `context_versions` would coexist with `agent_memory_version` for the same content; `context_versions` remains the richer record (`changeSource`, `changedByAgentId`, `changeReason`).
- **Multi-chunk edits**: `memory-edit` rejects multi-chunk rows (`sqlite-store.ts:877-961`); large profile files (CLAUDE.md up to 65K accepted by sync guards) will be multi-chunk and take the delete+reinsert path on every change — which resets `alpha`/`beta` posteriors and `accessCount` for those rows.
- **`todos.md` is out of band**: it has no server-side representation at all; bringing it in requires new plumbing regardless of option (either a tracked path in the hooks, a memory-dir move, or a new profile field).
- **Lead visibility comes for free**: `addScopeConditions` already grants leads cross-agent reads of `agent`-scoped rows, so "lead queries a worker's soul/tools" needs no new ACL.

## Code References

- `src/be/db.ts:5030-5146` — `updateAgentProfile()`, the single profile write path (hash-diff + `context_versions`)
- `src/http/agents.ts:161-189, 441-506` — `PUT /api/agents/{id}/profile`
- `src/hooks/hook.ts:1092-1152` — the forked `PostToolUse` dispatch (profile PUT vs memory index)
- `src/hooks/hook.ts:559-689` — identity/setup sync helpers; `:1204-1214` Stop-hook sweep
- `src/commands/profile-sync.ts` — harness-agnostic push sync (+ baselines at `:50-72`)
- `src/commands/runner.ts:4784-4991` — boot pull + materialization; `:2759-2797` pre-task memory recall
- `src/http/memory.ts:343-483` — `POST /api/memory/index` (chunk, dedup-by-sourcePath, async embed)
- `src/be/memory/providers/sqlite-store.ts:786-812` — scope enforcement; `:490-604` hybrid retrieval; `:877-961` single-chunk edit constraint
- `src/be/memory/constants.ts` — TTL / half-life / source-quality / `PROTECTED_SOURCES`
- `src/be/chunking.ts` — markdown-aware chunker
- `src/types.ts:993-1000` (`VersionableFieldSchema`), `:1398-1404` (memory scope/source schemas)
- `src/be/migrations/001_initial.sql:271-287, 310-325`; `099_memory_structured_key_versioning.sql` — schema foundations
- `src/prompts/base-prompt.ts:107-403` — profile → system-prompt injection + truncation budgets
- `src/prompts/defaults.ts:9-196` — default profile generators
- `src/tools/update-profile.ts`, `src/tools/join-swarm.ts:110-144`, `src/tools/context-history.ts` — MCP surfaces
- `src/tools/memory-search.ts`, `src/tools/memory-get.ts`, `src/be/memory/access.ts` — read surfaces + ACL
- `docker-entrypoint.sh:567-656` (setup-script compose), `:662-674` (`todos.md`, no sync)

## Historical Context (thoughts/)

- `thoughts/taras/research/2026-06-25-memory-system.md` — prior full memory-subsystem map (pre-retrieval-v2; already documented the `file_index` hook path and the "storage is 100% SQLite" invariant this research confirms on latest main).

## Review Decisions (Taras, 2026-07-30 file-review)

1. **Option A confirmed — server-side fan-in at `updateAgentProfile()` — extended to be bidirectional.** Not just profile → memory: when the memory-side edit methods (`memory-edit` tool / `POST /api/memory/edit`) touch a profile-derived memory, they must **automatically write back** to the profile (`agents` column via `updateAgentProfile`, hence `context_versions` too). As-is mechanics that support this:
   - Both sides already hash-short-circuit (`computeContentHash` diff in `updateAgentProfile`; `edit()` `changed:false` on identical `contentHash` in `sqlite-store.ts:910-919`), so a fan-in→write-back→fan-in ping-pong converges to a no-op after one hop — but the implementation still needs an explicit re-entrancy guard (or an internal "origin" flag) so the two automatic paths don't call each other on the *same* change.
   - Workspace-file propagation of a server-side write-back is already handled by the existing pull model: files re-materialize from `GET /me` at next boot, and the boot-time baseline hashes (`writeIdentityBaselines`) prevent session-end sync from clobbering the DB-side change mid-session — same mechanism that today protects lead `update-profile` edits.
   - Caveat to design around: `memory-edit` currently rejects multi-chunk rows (`sqlite-store.ts:877-961`), and large profile files chunk into multiple rows — write-back needs a defined behavior for chunked profile memories (e.g. reassemble from all chunks by `key`, or restrict profile memories' editability to whole-field replace).
2. **New `profile` source value** (not `file_index`, not `manual`) — it's a special case. Requires: CHECK-constraint migration on `agent_memory.source`, `AgentMemorySourceSchema` in `src/types.ts` (kept in sync per CLAUDE.md rule), and entries in `TTL_DEFAULTS` / half-life / source-quality maps + `PROTECTED_SOURCES` (`src/be/memory/constants.ts`).
3. **Index all six fields**, including `setupScript` and `heartbeatMd`. (Note: shell content tokenizes/embeds worse than prose under the porter FTS tokenizer and text embeddings — harmless, just lower-recall.)
4. **`context_versions` ↔ `agent_memory_version` duplication is acceptable** — no cross-referencing scheme required.
5. **Profile memories should rank high.** The new `profile` source should get top-tier reranker treatment (source quality ≥ `manual`'s 1.5, TTL null, protected from automated deletion). **How "ratable" they should be is open** — see Open Questions.

6. **Agent graph relation: `memory_link` external target.** Each profile memory gets a `memory_link` row targeting the agent entity (e.g. external target `agent:<id>`) — fits the existing schema without migration (`memory_link` already supports external-entity targets). Known limitation accepted: external-entity links do not participate in graph expansion today (`expandCandidatesWithGraph` follows `targetKind='memory'` only), so the link is informational (`memory-get` links/backlinks) until agents become graph nodes. (`agent_memory_edge` stays untouched — CHECK-locked to `references-source`.)
7. **Profile memories are NOT ratable — and attempts must fail loudly.** Rating a `source='profile'` memory (via `memory_rate` tool, `POST /api/memory/rate`, or server-side raters reaching `applyRating()`) must return a clear error, not a silent no-op. Rationale from the as-is: implicit-citation demotes any retrieved-but-uncited memory (-1×0.25), which would systematically drag down profile rows; and chunked re-index (delete+reinsert) resets posteriors anyway. Rank comes from pinned source semantics (quality ≥ 1.5, TTL null, `PROTECTED_SOURCES`), not from posteriors.
8. **Prompt/recall shape: hybrid.** SOUL.md + IDENTITY.md stay verbatim in the system prompt (behavioral core must be unconditionally present; pointer-notes rely on the agent opting in to read them, and remote providers have no local files). `claudeMd`/`toolsMd` keep their existing 20K budgets, but the truncation notice is upgraded to point at `memory-search` (and the file) for the overflow — the pointer pattern already exists there today. Automatic pre-task recall (`fetchRelevantMemories` → `renderMemoriesPrompt`) excludes the owning agent's own soul/identity profile memories (already verbatim in prompt); everything else stays recallable, and explicit `memory-search` + lead cross-agent queries see all profile content.
9. **`todos.md` is deprecated.** Not brought into the profile/memory system at all — it was an early experiment, unused in practice; its role is covered by existing profile fields + the task system (+ memory dirs). Removal (docker-entrypoint creation block + `todos` skill) is a separate cleanup, direction decided.

## Open Questions (implementation-level, for the plan)

1. Write-back mechanics for **multi-chunk** profile memories: reassemble the full field from all chunks by `key` on memory-edit write-back, or restrict profile memories to whole-field replace? (`memory-edit` currently rejects multi-chunk rows outright, `sqlite-store.ts:877-961`.)
2. Re-entrancy guard shape for the bidirectional sync (origin flag vs. hash-convergence reliance) at `updateAgentProfile()` ↔ memory index/edit.
3. Exact failure surface for "rating a profile memory fails clearly": reject at `applyRating()` (covers all callers) and/or pre-filter profile rows out of rater candidate lists (`dedupeRetrievalsForRater`, `runServerRaters`) so LLM/implicit raters never attempt it and only explicit `memory_rate` gets the error.
