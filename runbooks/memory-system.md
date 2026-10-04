# Memory system runbook

Architecture, tests, and key files for the agent memory subsystem.

## Architecture

Provider abstractions live in `src/be/memory/`:

- `EmbeddingProvider` — OpenAI embeddings.
- `MemoryStore` — SQLite + sqlite-vec for vector search.
- Reranker scores `similarity × recency_decay × access_boost × source_quality × path_weight × usefulness(α, β)`.

Tuning constants are env-overridable in `src/be/memory/constants.ts`.

## Logical paths (`key`)

The curated memory tree lives under `/longterm`. A memory's `key` column holds the
path, for example `/longterm/facts/swarm-runtime/slug`. Every other key is **inbox
material**: auto keys `<scope>/<source>/<id>` and file-index keys
(`/workspace/...`) stay untouched and carry no path weight. All chunks of a document
share the key. The helpers live in `src/be/memory/key-paths.ts`.

Roots: `/longterm/company-story`, `/longterm/entities/{people,customers}/...`,
`/longterm/facts/...`, `/longterm/decisions/...`, `/longterm/workstreams/...`,
`/longterm/timeline/...`.

The root list is **closed**. A key under `/longterm` whose second segment is not one of
those roots is refused, and so is a key under `/longterm/entities` whose third segment
is not `people` or `customers` (agent profiles and `get-repos` own agents and repos).
The error lists the allowed roots. A typo such as `/longterm/fact/x` would otherwise
store and silently get no path weight. Leaf slugs stay free-form within the key shape;
canonical entity slugs belong to the dreaming lane, not the server. Keys outside
`/longterm` are unchanged. `LONGTERM_ROOTS`, `LONGTERM_ENTITY_TYPES` and
`longtermKeyError` live in `key-paths.ts`; the check runs in the `memory-store` and
`memory-edit` tools, next to the shape regex.

**The key is the tier, `source` stays provenance.** There is no `longterm` source. A
memory whose key is under `/longterm` follows `manual`'s lifecycle whatever its
`source` (`tierSource` in `key-paths.ts`):

- `expiresAt` is NULL on every chunk: set on store with a `/longterm` key, cleared by a
  `memory-edit` `newKey` move into `/longterm`. Search filters `expiresAt > now`, so
  without this a `task_completion` memory moved to `/longterm/facts/x` would vanish 7
  days after it was created.
- No recency decay and quality multiplier 1.5, the same as `manual`. The global
  `MEMORY_RECENCY_HALF_LIFE_DAYS` override applies to it exactly as it does to `manual`.
- Protected from automated cleanup like `PROTECTED_SOURCES`: `isSourceProtected` takes
  the key, and `listForCuration` skips every `/longterm` row.

A move **out** of `/longterm` does not restore a TTL. The expiry the memory had is
gone, so it never expires; decay, quality and protection revert to its `source`
because they are read from the key on every call.

- **Write:** `memory-store` `key` (shape `^/[a-z0-9-]+(/[a-z0-9._-]+)*$`, ≤200 chars).
  When `key` is absent and `name` starts with `/longterm/`, the name is the key, so an
  agent sets one field; an invalid name of that form is refused, never stored under an
  auto key. A key already used by the same owner in the same scope fails.
- **Move:** `memory-edit` `newKey` rewrites every chunk in one transaction and keeps
  id, α/β, `accessCount` and author. It bumps `version` and writes a version row per
  chunk. A legacy multi-chunk doc whose chunks carry a key each is refused, not split.
- **Filter:** `memory-search` and `POST /api/memory/search` `keyPrefix` is a literal,
  case-sensitive prefix. It is applied in the SQL of the FTS, vec and fallback arms and
  in graph expansion, so it narrows candidates before the top-K cut. The vec arm still
  has its pre-existing 4,096-neighbour KNN ceiling, same as `scope` and `source`.
- **Rank:** `PATH_WEIGHT` in `constants.ts`, longest root wins (`/longterm/company-story`
  1.4, `/longterm/entities` 1.3, `/longterm/facts` 1.2, `/longterm/decisions` 1.1,
  `/longterm/timeline` 0.8). A `/longterm/decisions` doc tagged `superseded` weighs 0.3.
  Keys under no listed root weigh 1.0.
- **Guard:** only the lead may write or move a key under `/longterm/company-story`,
  `/longterm/entities` or `/longterm/timeline`, by `key`, `newKey`, a `/longterm/`
  name, or a `sourcePath` sent to `POST /api/memory/index`. The decision is `can()` with
  the lead-only verb `memory.write.consolidated`; `isConsolidatedKey` only says whether
  a key is under those roots. One function, `assertKeyWritable` in
  `src/be/memory/key-guard.ts`, checks the key shape, the closed root list and that
  permission, and throws `MemoryKeyError` (`invalid` → 400, `forbidden` → 403). Every
  route that can put a key on a row passes through it: `indexMemoryContent` runs it on
  the key every chunk will carry (`key`, else `sourcePath`) before it reads or writes
  anything, so `memory-store` and `POST /api/memory/index` share one gate; `memory-edit`
  runs it on `newKey`. It is not in the store layer. The caller's writer comes from the
  route (MCP: the calling agent; HTTP: the session token, else `X-Agent-ID`, else the
  shared key alone). A call with no writer has no authority, and an operator or user
  principal is not the lead, so neither reaches a lead-only root. A `sourcePath` outside
  `/longterm` stays a free-form file path and confers no tier.
- **File-index re-sync:** it matches and deletes by the `sourcePath` column
  (`deleteBySourcePath`, the single-chunk `list` match), never by `key` or `name`. A
  `/longterm/` doc written through `memory-store` has no `sourcePath`, so a re-sync
  cannot delete or overwrite it. `manual` rows carry no TTL, so GC skips them.

## Edit authorization

The `memory-edit` MCP tool and `POST /api/memory/edit` require the memory owner
or a Lead. By-ID edits evaluate `memory.edit.any`; key+scope edits are already
filtered to the caller's ownership by the store. Lead may edit another agent's
private (`agent`) scope by ID. This intentionally differs from `memory.delete.any`,
which permits Lead to delete another agent's memory only in `swarm` scope.

## Delete and list authorization

`memory.delete.any` gates the `memory-delete` MCP tool, `DELETE /api/memory/{id}`,
and the script SDK's `memory_delete` (which calls that route with `X-Agent-ID`).
The operator key and users may delete any memory. Lead may delete its own memories
and any `swarm`-scope memory. Any other agent may delete only its own `agent`-scope
memories; a `swarm`-scope memory is shared, so a worker cannot delete one, even its own.

`POST /api/memory/list` shows the operator key, users, and Lead every agent's rows.
Any other agent (an `aseph_` session token, or the shared key with `X-Agent-ID`)
sees its own rows plus `swarm`-scope rows. A request that carries the shared key
with no agent identity is the operator: these gates stop an agent that identifies
itself, not one that sends the bare key.

Authorization stays at these entrypoints. Internal `indexMemoryContent()`
re-indexing, boot and HTTP re-embedding, and link refresh retain their cross-agent
store access.

## Memory raters (v1.5)

The v1.5 wedge adds a small framework that lets the swarm learn which memories
are actually useful. Three independent raters write `RatingEvent`s to the
single chokepoint `applyRating` (`src/be/memory/raters/store.ts`); each event
nudges a Beta-distribution posterior `(α, β)` per memory. The reranker then
folds that posterior into the score so over time good memories rank higher
and bad ones get demoted.

### The three raters

| Rater | Side | Trigger | Source string |
|---|---|---|---|
| `ImplicitCitationRater` | server | `store-progress` on task completion — ID-greps the task's `session_logs` for retrieved memory IDs and emits a `+0.5` for each cited memory and a `-0.25` for each retrieved-but-not-cited memory. | `implicit-citation` |
| `LlmRater` | worker | Piggybacks the existing `claude -p` summary call in `src/hooks/hook.ts` — the prompt now asks for a `ratings[]` array (`{id, score, reasoning, referencesSource?}`) which is POSTed to `/api/memory/rate`. | `llm` |
| `ExplicitSelfRatingRater` | worker | The `memory_rate` MCP tool — agents flag a retrieved memory as useful or misleading mid-task. Spam-guarded by a partial unique index on `(taskId, memoryId) WHERE source='explicit-self'`. | `explicit-self` |

Source strings travel with each `RatingEvent` and are required by
`applyRating` (events with an empty `event.source` are rejected — see
`src/be/memory/raters/store.ts`'s `validate()`). Where the value comes
from depends on which path the event takes:

- **Server-side raters** (`ImplicitCitationRater`) typically leave
  `event.source = ""` and let `runServerRaters` stamp
  `event.source = rater.name` before calling `applyRating` — that's
  the "framework standardizes the source string" guarantee.
- **Worker-side raters** (`LlmRater`, `ExplicitSelfRatingRater`) set
  `event.source` explicitly before POSTing to `/api/memory/rate` —
  `"llm"` or `"explicit-self"` respectively.

The HTTP boundary additionally restricts incoming `source` to
`{"llm", "explicit-self"}`, so a worker cannot impersonate the
server-side `implicit-citation` source.

### Env vars

| Var | Default | Purpose |
|---|---|---|
| `MEMORY_RATERS` | `implicit-citation,explicit-self` | Comma-separated allow-list, e.g. `implicit-citation,llm,explicit-self`. Unset enables citation ratings and self-rating hints, including on existing deployments. An explicitly empty value disables all raters. Deleting a swarm config override restores the deployment value, or the runtime default when unset. |
| `MEMORY_RATER_WEIGHTS` | unset (all multipliers = 1.0) | Optional `name:multiplier,...` per-rater weight overrides clamped into `[0, 1]`. Used to dial down a noisy rater without yanking it from the allow-list. |
| `MEMORY_DEMOTION_FLOOR` | `1.0` (no demotion) | Lower bound for `usefulness(α, β)` in the reranker. Default `1.0` means a thoroughly-disliked memory never ranks below baseline; lower it (e.g. `0.5`) per deployment once telemetry shows the negative signal is reliable (Q1 resolution from the v1.5 plan). |

### Reranker formula

```
usefulness(α, β) = clamp(2 × α / (α + β), MEMORY_DEMOTION_FLOOR, 2.0)
score             = similarity × recency_decay × access_boost × source_quality × path_weight × usefulness(α, β)
```

A fresh memory has `(α=1, β=1)` so `usefulness = 1.0` — it ranks identically
to a pre-v1.5 memory until ratings start flowing in. Rating events are
commutative (Beta updates compose by addition) so racing applies converge
without idempotency checks.

### New endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/memory/rate` | Worker-side `RatingEvent[]` ingest. Accepts `source` ∈ `{llm, explicit-self}` only — `implicit-citation` runs in-process server-side via `applyRating` and must never arrive over HTTP (defence against worker spoofing). Each event takes optional `referencesSource`. |
| `GET /api/memory/retrievals?taskId=&sessionId=` | Read-side: which memories were surfaced to a given task / session, with similarity. Used by raters and by the e2e test. |
| `GET /api/memory/edges?memoryId=` | Read-side: external references attached to a memory (see "edges" below). |

### `references-source` edges (v1.5 wedge)

Optional `referencesSource` field on `memory_rate` (HTTP and MCP) and on each
LlmRater rating creates / upserts an edge in `agent_memory_edge`:

```sql
agent_memory_edge(from_id, to_id, type, alpha, beta, createdAt)
PRIMARY KEY (from_id, to_id, type)
CHECK (type = 'references-source')
FOREIGN KEY (from_id) REFERENCES agent_memory(id) ON DELETE CASCADE
```

Edges carry their own `(α, β)` and `usefulness`, updated with the same Beta
math as the source memory.

#### Q2 / Q3 free-form `to_id` contract

`to_id` is a free-form string with the **convention** (not the schema):

- `github:owner/repo#N`
- `linear:KEY-N`
- `customer:<slug>`
- `slack:<channel>:<ts>`
- `agentmail:<thread-id>`

**No closed enum, no parser, no `CHECK` constraint on prefixes.** Pick any
prefix that fits — adding a new integration requires zero swarm-side code.
Validation = non-empty + `≤ 512` chars + control-char strip + no NUL byte.
Storage = plain `TEXT`, indexed by plain B-tree.

Compare with `src/tasks/context-key.ts`, which uses a closed enum because
tasks are core scheduling primitives where typo'd keys silently break
dedup. `references-source.to_id` is deliberately the opposite — telemetry
data flows here, not control flow.

### Out of scope (v2)

- **Edge-aware reranking.** v1.5's reranker still scores against
  `agent_memory.(α, β)` only — edges are recorded but don't yet influence
  retrieval. Wiring them in is a deliberate v2 step so the v1.5 floor
  remains "byte-identical when off."
- **Edge GC.** Stale edges accumulate forever today. v2.
- **Multi-type edges.** The `CHECK (type='references-source')` deliberately
  blocks `supersedes`, `contradicts`, etc. v2.
- **Supersedes / contradicts.** Memory-vs-memory edges (instead of
  memory-vs-external-source) need a different math model and will land as
  a separate edge type in v2.

## Tests

Run all four after any change to the memory subsystem:

```bash
bun run test:root -- src/tests/memory-reranker.test.ts
bun run test:root -- src/tests/memory-store.test.ts
bun run test:root -- src/tests/memory.test.ts
bun run test:root -- src/tests/memory-e2e.test.ts
bun run test:root -- src/tests/memory-key-paths.test.ts   # key / newKey / keyPrefix / lead-only guard (MCP and POST /api/memory/index) / root allowlist / /longterm tier
```

Plus the v1.5 rater suites:

```bash
bun run test:root -- src/tests/memory-rater-store.test.ts            # step-1: applyRating chokepoint
bun run test:root -- src/tests/memory-rater-implicit-citation.test.ts # step-2: ID-grep + retrieval bridge
bun run test:root -- src/tests/memory-rate-endpoint.test.ts           # step-3: POST /api/memory/rate
bun run test:root -- src/tests/memory-rater-llm.test.ts               # step-4: LlmRater piggyback
bun run test:root -- src/tests/memory-rate-tool.test.ts               # step-5: memory_rate MCP tool
bun run test:root -- src/tests/memory-edges.test.ts                   # step-6: references-source edges
bun run test:root -- src/tests/memory-rater-e2e.test.ts               # step-7: cross-cutting end-to-end
```

## Key files

- `src/be/memory/types.ts` — interfaces.
- `src/be/memory/providers/` — OpenAI embeddings + SQLite/sqlite-vec store.
- `src/be/memory/reranker.ts` — scoring + `usefulness(α, β)` and `pathWeight` factors.
- `src/be/memory/key-paths.ts` — logical-path key pattern, the closed `/longterm` root allowlist, the lead-only roots and `tierSource`.
- `src/be/memory/key-guard.ts` — `assertKeyWritable`: the shared key gate for MCP and HTTP writes.
- `src/be/memory/constants.ts` — env-overridable tuning.
- `src/be/memory/index.ts` — singletons.
- `src/be/memory/index-content.ts` — `indexMemoryContent()`: chunk, re-index by
  `sourcePath`, batch store, link resolution, background embed. Shared by
  `POST /api/memory/index` and the `memory-store` tool; it gates the row key first.
- `src/tools/memory-store.ts` — the agent-facing write path (`memory_store` in
  the scripts SDK goes through the MCP bridge to the same tool).
- `src/be/memory/raters/` — rater framework (registry, store, retrieval bridge,
  three rater implementations, edges store).
- `src/prompts/memories.ts` — prompt addendum gated on `MEMORY_RATERS`
  including `explicit-self`.
- `src/hooks/hook.ts` — LlmRater piggyback in the summary path.

## Pre-task recall query

The runner marks pre-task searches with `X-Memory-Consumption: prompt`. Only
that search branch removes sibling-task blocks and reduces the default worker
completed/failed follow-up wrappers to task description and output (or failure
reason), preserving `<thread_context>`. The task description itself is unchanged.
Input is capped at 65536 UTF-8 bytes before sibling removal or wrapper parsing.
Wrapper content uses linear delimiter searches; oversized or malformed wrappers
fall back to bounded text. The query uses a conservative 8191 UTF-8 byte cap,
preserving Unicode code points,
to stay below the embedding input token limit without a tokenizer dependency.
An empty content query returns no results without recording retrievals.

## Trigger paths

This runbook applies when modifying:

- `src/be/memory/`
- `src/be/embedding.ts`
- `src/tools/memory-*.ts`
- `src/http/memory.ts`
- `src/tools/store-progress.ts` (memory sections)
- `src/be/memory/raters/` (rater framework)
- `src/prompts/memories.ts` (rater-aware prompt addendum)
