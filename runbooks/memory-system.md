# Memory system runbook

Architecture, tests, and key files for the agent memory subsystem.

## Architecture

Provider abstractions live in `apps/swarm/src/be/memory/`:

- `EmbeddingProvider` — OpenAI embeddings.
- `MemoryStore` — SQLite + sqlite-vec for vector search.
- Reranker scores `similarity × recency_decay × access_boost × usefulness(α, β)`.

Tuning constants are env-overridable in `apps/swarm/src/be/memory/constants.ts`.

## Memory raters (v1.5)

The v1.5 wedge adds a small framework that lets the swarm learn which memories
are actually useful. Three independent raters write `RatingEvent`s to the
single chokepoint `applyRating` (`apps/swarm/src/be/memory/raters/store.ts`); each event
nudges a Beta-distribution posterior `(α, β)` per memory. The reranker then
folds that posterior into the score so over time good memories rank higher
and bad ones get demoted.

### The three raters

| Rater | Side | Trigger | Source string |
|---|---|---|---|
| `ImplicitCitationRater` | server | `store-progress` on task completion — ID-greps the task's `session_logs` for retrieved memory IDs and emits a `+0.5` for each cited memory and a `-0.25` for each retrieved-but-not-cited memory. | `implicit-citation` |
| `LlmRater` | worker | Piggybacks the existing `claude -p` summary call in `apps/swarm/src/hooks/hook.ts` — the prompt now asks for a `ratings[]` array (`{id, score, reasoning, referencesSource?}`) which is POSTed to `/api/memory/rate`. | `llm` |
| `ExplicitSelfRatingRater` | worker | The `memory_rate` MCP tool — agents flag a retrieved memory as useful or misleading mid-task. Spam-guarded by a partial unique index on `(taskId, memoryId) WHERE source='explicit-self'`. | `explicit-self` |

Source strings travel with each `RatingEvent` and are required by
`applyRating` (events with an empty `event.source` are rejected — see
`apps/swarm/src/be/memory/raters/store.ts`'s `validate()`). Where the value comes
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
| `MEMORY_RATERS` | `` (empty — no raters fire) | Comma-separated allow-list, e.g. `implicit-citation,llm,explicit-self`. Unset/empty means the framework no-ops and `applyRating` is never called from the rater paths — by-design "byte-identical when off" guarantee. |
| `MEMORY_RATER_WEIGHTS` | unset (all multipliers = 1.0) | Optional `name:multiplier,...` per-rater weight overrides clamped into `[0, 1]`. Used to dial down a noisy rater without yanking it from the allow-list. |
| `MEMORY_DEMOTION_FLOOR` | `1.0` (no demotion) | Lower bound for `usefulness(α, β)` in the reranker. Default `1.0` means a thoroughly-disliked memory never ranks below baseline; lower it (e.g. `0.5`) per deployment once telemetry shows the negative signal is reliable (Q1 resolution from the v1.5 plan). |

### Reranker formula

```
usefulness(α, β) = clamp(2 × α / (α + β), MEMORY_DEMOTION_FLOOR, 2.0)
score             = similarity × recency_decay × access_boost × usefulness(α, β)
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

Compare with `apps/swarm/src/tasks/context-key.ts`, which uses a closed enum because
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
bun test apps/swarm/src/tests/memory-reranker.test.ts
bun test apps/swarm/src/tests/memory-store.test.ts
bun test apps/swarm/src/tests/memory.test.ts
bun test apps/swarm/src/tests/memory-e2e.test.ts
```

Plus the v1.5 rater suites:

```bash
bun test apps/swarm/src/tests/memory-rater-store.test.ts            # step-1: applyRating chokepoint
bun test apps/swarm/src/tests/memory-rater-implicit-citation.test.ts # step-2: ID-grep + retrieval bridge
bun test apps/swarm/src/tests/memory-rate-endpoint.test.ts          # step-3: POST /api/memory/rate
bun test apps/swarm/src/tests/memory-rater-llm.test.ts              # step-4: LlmRater piggyback
bun test apps/swarm/src/tests/memory-rate-tool.test.ts              # step-5: memory_rate MCP tool
bun test apps/swarm/src/tests/memory-edges.test.ts                  # step-6: references-source edges
bun test apps/swarm/src/tests/memory-rater-e2e.test.ts              # step-7: cross-cutting end-to-end
```

## Key files

- `apps/swarm/src/be/memory/types.ts` — interfaces.
- `apps/swarm/src/be/memory/providers/` — OpenAI embeddings + SQLite/sqlite-vec store.
- `apps/swarm/src/be/memory/reranker.ts` — scoring + `usefulness(α, β)` factor.
- `apps/swarm/src/be/memory/constants.ts` — env-overridable tuning.
- `apps/swarm/src/be/memory/index.ts` — singletons.
- `apps/swarm/src/be/memory/raters/` — rater framework (registry, store, retrieval bridge,
  three rater implementations, edges store).
- `apps/swarm/src/prompts/memories.ts` — prompt addendum gated on `MEMORY_RATERS`
  including `explicit-self`.
- `apps/swarm/src/hooks/hook.ts` — LlmRater piggyback in the summary path.

## Trigger paths

This runbook applies when modifying:

- `apps/swarm/src/be/memory/`
- `apps/swarm/src/be/embedding.ts`
- `apps/swarm/src/tools/memory-*.ts`
- `apps/swarm/src/http/memory.ts`
- `apps/swarm/src/tools/store-progress.ts` (memory sections)
- `apps/swarm/src/be/memory/raters/` (rater framework)
- `apps/swarm/src/prompts/memories.ts` (rater-aware prompt addendum)
