---
date: 2026-05-04
researcher: taras
git_commit: cf553c1d
branch: main
repository: agent-swarm
topic: "How could Bayesian learning fit into agent-swarm, especially memory usage?"
tags: [research, memory, bayesian, reranker, learning]
status: complete
last_updated: 2026-05-04
last_updated_by: taras
---

# Bayesian Learning in agent-swarm — Memory System

## Research Question

How could Bayesian learning fit into agent-swarm, especially around memory usage?

Scope: short / autopilot. Document what the memory system currently is, then map where Bayesian techniques could plug in.

## Summary

agent-swarm's memory system today scores results with a **deterministic, non-learning** formula:

```
score = similarity × recency_decay × access_boost
```

(`src/be/memory/reranker.ts:37-43`). There is **no feedback loop** that records whether a recalled memory was actually useful — `accessCount` increments only on explicit `get(id)`, not on `search()` recall (`src/be/memory/providers/sqlite-store.ts:200-213`), so the existing "access boost" mostly tracks manual fetches, not retrieval quality.

The clearest, smallest Bayesian fit is **per-memory Beta-Binomial usefulness posteriors** rerankered via **Thompson sampling**. Two new SQLite columns (`alpha`, `beta`), an implicit-feedback signal (was the memory ID cited in the agent's tool calls / output?), and ~20 LOC in the reranker. No new dependencies, fits the existing `bun:sqlite` + sqlite-vec stack. None of the comparable production frameworks (Mem0, Letta, Zep, LangChain, LlamaIndex) currently do this — they stop at vector + recency + LLM rerank.

## Detailed Findings

### 1. What the memory system currently does

**Reranker** (`src/be/memory/reranker.ts`)

- `recencyDecay(createdAt, now)` — exponential half-life: `2^(-ageDays / RECENCY_DECAY_HALF_LIFE_DAYS)`. Default half-life = 14 days (`src/be/memory/constants.ts:19`).
- `accessBoost(accessedAt, accessCount, now)` — `1.0` if `accessCount <= 0`; else `1 + min(accessCount/10, MAX-1) * recencyFactor`. `recencyFactor = 1.0` within 48h, else `0.5`. Capped at `ACCESS_BOOST_MAX_MULTIPLIER = 1.5` (`constants.ts:20-21`).
- `computeScore` multiplies the three. `rerank` overwrites `similarity` with the combined score, sorts desc, takes top `limit`.

**Storage** (`src/be/memory/providers/sqlite-store.ts`)

- `memory_vec` virtual table created via `vec0(memory_id TEXT PRIMARY KEY, embedding float[512])` (`sqlite-store.ts:80-123`).
- KNN search: over-fetches with `knnLimit = limit * 5`, computes `similarity = 1 - distance`, then applies `rerank` (`sqlite-store.ts:240-306`).
- Brute-force fallback uses `cosineSimilarity` from `src/be/embedding.ts` when sqlite-vec is unavailable.

**Schema** (`src/be/migrations/001_initial.sql:271-287` + later additions):

`agent_memory` columns: `id, agentId, scope (agent|swarm), name, content, summary, embedding BLOB, source (manual|file_index|session_summary|task_completion), sourceTaskId, sourcePath, chunkIndex, totalChunks, tags, createdAt, accessedAt, expiresAt, accessCount, embeddingModel`.

**No success/failure markers, no confidence, no weight, no prior, no learning-rate field exists on memory entries.**

**Write paths**

- `POST /api/memory/index` (`src/http/memory.ts:126-183`): chunk → dedupe by `sourcePath` → batch insert → async embed → `updateEmbedding`.
- `POST /api/memory/search` (`src/http/memory.ts:185-229`): embed query → `store.search()` over-fetch → rerank.
- `src/tools/store-progress.ts:295-359`: on task completion/failure, fire-and-forget memory store; auto-promotes research/`knowledge`/`shared`-tagged completions to swarm scope.

**Access-counter behaviour (important for any learning hook)**

- `SqliteMemoryStore.get(id)` increments `accessCount` + updates `accessedAt` (`sqlite-store.ts:200-202`).
- `peek(id)` reads without incrementing (`sqlite-store.ts:207-213`).
- `search()` does **not** touch counters. So today, "access boost" reflects explicit fetches, not retrieval frequency.

### 2. What's missing for any learning loop

A scan via `codebase-locator` for `bayes`, `posterior`, `prior`, `weight`, `confidence`, `decay`, `reinforce`, `experiment`, `ab_test`, `feature_flag` returned **no matches** outside the existing similarity/recency/access scoring. There is no:

- feedback path from the worker reporting "this recalled memory was actually used"
- success/failure correlation between a memory and a task outcome (although task outcomes themselves are tracked via `src/tools/update-task-status.ts` and `src/tools/complete-task.ts`)
- A/B / experimentation framework
- per-memory quality score that updates over time

### 3. Bayesian techniques and where each would plug in

Sourced from web research (full citations below). Ranked by fit for the existing stack.

> Adjacent direction (Taras): graph structure on memories — soft clusters and/or hard relations. See section 3.F below.

#### A. Beta-Binomial posterior per memory (best fit)

State per memory row: `alpha REAL DEFAULT 1, beta REAL DEFAULT 1` (uniform prior).

On every retrieval event, post-hoc — pluggable **rater** decides which counter to bump. Possible rater implementations:

- **Implicit citation rater** (cheapest): memory `id` (or content substring) appears in subsequent tool calls / final output → `alpha += 1`; else `beta += 1`.
- **LLM rater** (richer signal): on a sampling rate (say 10%), call a small model via OpenRouter / Claude Haiku / etc. with **structured output** (`{ useful: bool, score: 0..1 }`) given the query, retrieved memory, and the agent's response. Use the score to update `(alpha, beta)` with a weight (e.g., `alpha += score`, `beta += 1 - score`). Sampling keeps cost bounded; structured output keeps it deterministic to parse.
- **Task-outcome rater**: if the task that triggered retrieval succeeds, propagate a small positive update to all memories cited in that task; failure → small negative.
- **Explicit agent self-rating**: a new MCP tool the agent calls to mark a memory useful/useless mid-run.

Architecturally: a **`MemoryRater`** interface in `src/be/memory/`, structured the same way as the existing `EmbeddingProvider` and `MemoryStore` provider abstractions. **Fully backward compatible**: the default rater is a `NoopRater` (counters never move; behaviour identical to today). Multiple raters can compose — each emits a `{ memoryId, signal: -1..+1, weight: 0..1 }` event, the store applies a weighted Beta update. Sketch:

```ts
interface MemoryRater {
  name: string;                          // e.g. "implicit-citation", "llm", "task-outcome"
  rate(ctx: RatingContext): Promise<RatingEvent[]>;
}

type RatingEvent = {
  memoryId: string;
  signal: number;   // -1..+1 (positive = useful)
  weight: number;   // 0..1; multiplies the Beta update step
  source: string;   // rater name, for telemetry
};
```

Different raters carry different **intent weights**, reflecting how much trust each signal deserves (see comparison table below). The Beta update becomes:

```
alpha += max(0, signal) * weight
beta  += max(0, -signal) * weight
```

Pluggable via config: `MEMORY_RATERS=implicit-citation,llm:0.1,task-outcome` (rater name + optional sampling rate). Adding a new rater = implement `MemoryRater` + register; no changes to the reranker or store contract.

Posterior mean `alpha / (alpha + beta)` is a 0..1 usefulness score. Drop-in factor in `computeScore`:

```
score = similarity × recency_decay × access_boost × usefulness
```

Cost: 2 columns + 1 migration + ~20 LOC + a "did we cite memory X" detector.

#### B. Thompson sampling at retrieval time

Instead of using the posterior **mean**, **sample once** from each candidate's `Beta(alpha, beta)` and rank by sample. Naturally trades exploration (uncertain new memories occasionally jump to the top) against exploitation (proven memories dominate). Hooks into `rerank` directly — replace `accessBoost` factor with sampled value when `accessCount > 0`. ~10 LOC; no extra storage beyond A.

> **Concern noted (Taras): too probabilistic.** Reasonable. Two ways to dampen non-determinism without abandoning the approach:
>
> 1. **Default to posterior mean** (option A). Use Thompson sampling only behind a feature flag for offline experimentation, or only on a small fraction of retrievals (e.g., 10% — same idea as ε-greedy). Keeps production deterministic; still gathers exploration data.
> 2. **UCB instead of Thompson**: rank by `mean + c × stddev(Beta)` — same explore/exploit tradeoff, fully deterministic given `(alpha, beta)`. Same ~10 LOC.
>
> Recommendation: ship A's posterior mean first (deterministic, monotonic with evidence), revisit B only if exploration data shows mean-only is starving new memories.

#### C. PicHunter / BALAS-style Bayesian relevance feedback

`P(relevant | features)` over discretized features: similarity bucket, age bucket, agent role, source type, query type. Treat positive vs negative feedback asymmetrically (typical in IR — negatives carry less information). Implementable as a small Naive Bayes table in SQLite. Useful when per-memory data is too sparse to learn (B handles this via prior, but feature-conditional helps generalize across new memories).

#### D. Online Bayesian logistic regression for "useful vs not"

Same features as C but combined via log-odds with Gaussian posteriors per coefficient. ~50 LOC TypeScript, no deps. More expressive than C, more code, better when you have many features.

#### E. Two-tier hybrid (recommended sequencing)

Tier 1: vector similarity (top-50 over-fetch — already exists, `CANDIDATE_SET_MULTIPLIER = 3`).
Tier 2: Bayesian rerank `similarity × recency_decay × E[Beta posterior]` (or Thompson sample).

This mirrors the LlamaIndex / Pinecone two-stage retrieval pattern, with **learned** usefulness instead of an LLM reranker call (cheaper, deterministic latency).

#### F. Graph structure on memories (orthogonal, complements A–E)

Two flavours, not mutually exclusive:

- **Soft clusters**: periodic offline job clusters memory embeddings (k-means, HDBSCAN, or just connected components over a similarity threshold). Store `cluster_id` per memory. At retrieval, expand the candidate set: top-K by similarity **plus** all members of clusters those K belong to. Bayesian layer on top: maintain Beta posteriors at the **cluster** level too — solves cold-start (new memories inherit their cluster's prior).
- **Hard relations**: typed edges between memories (e.g., `derived_from`, `supersedes`, `contradicts`, `same_task`). Stored as a separate `agent_memory_edge` table (`from_id, to_id, type, weight`). Retrieval walks the graph 1–2 hops from initial top-K. Zep does something like this with a temporal knowledge graph; it's the closest production precedent.

Where Bayes plugs in here:

- Cluster-level priors: `Beta(alpha_cluster, beta_cluster)` blended with per-memory posterior via a Bayesian hierarchical model (memory inherits cluster prior, gradually overrides as evidence accumulates).
- Edge-weight learning: each edge has its own `(alpha, beta)` updated when traversal of that edge produces a useful memory. Effectively learns "which relations actually help retrieval."

Cost: a clustering job (one-shot or nightly), a new table for edges, and a wider candidate set in `searchWithVec`. Heavier than A/B; lighter than going full graph DB.

### 4. Where Bayes could fit beyond memory ranking

Out of scope for this short research, but flagged for future:

- **TTL / promotion**: instead of fixed `TTL_DEFAULTS` (`constants.ts:11-16`), promote memory to longer TTL or `swarm` scope when posterior usefulness crosses a threshold.
- **Embedding model selection**: bandit over candidate embedding models when re-embedding (`POST /api/memory/re-embed`).
- **Workflow node selection**: Thompson sampling over alternative workflow paths in `src/workflows/`.
- **Provider routing**: bandit over harness providers (claude vs codex vs pi) per task type, rather than the static `HARNESS_PROVIDER` env.

### 5. State of the art (for context)

- **Mem0, Zep, Letta, LangChain, LlamaIndex** — vector + recency + LLM rerankers, **no Bayesian usefulness tracking**.
- **Zep** — temporal knowledge graph with rule-based fact invalidation; closest to "learning from feedback" but not Bayesian.
- Bayesian relevance feedback is well-studied in classical IR (PicHunter 2000, BALAS 2005) but underused in LLM-agent memory.

So this is greenfield in the agent-memory space.

## Code References

- `src/be/memory/reranker.ts:15-19` — `recencyDecay`
- `src/be/memory/reranker.ts:25-32` — `accessBoost`
- `src/be/memory/reranker.ts:37-43` — `computeScore` (multiplicative scoring)
- `src/be/memory/reranker.ts:49-59` — `rerank` (sort + truncate)
- `src/be/memory/constants.ts:11-26` — TTLs, half-lives, multipliers, embedding defaults
- `src/be/memory/providers/sqlite-store.ts:80-123` — `ensureVecTable`, vec0 schema
- `src/be/memory/providers/sqlite-store.ts:200-213` — `get` (increments accessCount) vs `peek` (does not)
- `src/be/memory/providers/sqlite-store.ts:240-306` — `searchWithVec` (KNN + over-fetch + rerank)
- `src/be/memory/providers/sqlite-store.ts:308-353` — brute-force fallback
- `src/be/memory/providers/sqlite-store.ts:466-481` — `updateEmbedding`
- `src/be/embedding.ts` — `cosineSimilarity`, embedding generation
- `src/be/db.ts:117-137` — sqlite-vec extension loader
- `src/be/migrations/001_initial.sql:271-287` — `agent_memory` baseline schema
- `src/be/migrations/001_initial.sql:387-392` — memory indexes
- `src/http/memory.ts:13-229` — REST routes (`index`, `search`, `list`, `re-embed`, `delete`)
- `src/tools/memory-store.ts`, `src/tools/memory-search.ts`, `src/tools/memory-list.ts`, `src/tools/memory-delete.ts` — MCP tools
- `src/tools/store-progress.ts:295-359` — task-completion → memory write, scope auto-promotion
- `src/prompts/memories.ts` — memory injection into agent prompts
- `runbooks/memory-system.md` — runbook entry point

## Sources (web)

- [Russo et al., A Tutorial on Thompson Sampling (Stanford)](https://web.stanford.edu/~bvr/pubs/TS_Tutorial.pdf)
- [Glowacka, Bandit Algorithms in Information Retrieval](https://glowacka.org/files/bandit_book.pdf)
- [Beta-Binomial conjugate model (Navarro)](https://compcogsci-3016.djnavarro.net/technote_betabinomial.pdf)
- [BALAS: Empirical Bayesian Learning for Relevance Feedback](https://www.sciencedirect.com/science/article/pii/S026288560500199X)
- [PicHunter: Bayesian Relevance Feedback](https://www.academia.edu/21353247/PicHunter_Bayesian_relevance_feedback_for_image_retrieval)
- [Qdrant: Search Feedback Loop](https://qdrant.tech/articles/search-feedback-loop/)
- [LlamaIndex: Retrieval and Reranking](https://www.llamaindex.ai/blog/using-llms-for-retrieval-and-reranking-23cf2d3a14b6)
- [Pinecone: Rerankers and Two-Stage Retrieval](https://www.pinecone.io/learn/series/rag/rerankers/)
- [Zep: State of the Art in Agent Memory](https://blog.getzep.com/state-of-the-art-agent-memory/)
- [5 AI Agent Memory Systems Compared (2026)](https://dev.to/varun_pratapbhardwaj_b13/5-ai-agent-memory-systems-compared-mem0-zep-letta-supermemory-superlocalmemory-2026-benchmark-59p3)

## Open Questions & Decisions

### Feedback signal: option comparison

Each rater carries an **intent weight** — how much trust the signal deserves per event. Higher = more aggressive Beta updates per observation. Plugged into the `MemoryRater` abstraction above.

| Signal | Intent weight | How it works | Strengths | Drawbacks |
|---|---|---|---|---|
| **ID match in tool args** | 0.5 (medium-low) | Post-hoc grep agent's tool calls for the memory's `id` | Cheapest, deterministic, zero LLM cost | Precision but low recall — agents rarely cite IDs verbatim; may miss useful memories that informed reasoning indirectly |
| **Content substring match** | 0.3 (low) | Look for memory content (or n-grams) in agent's final output | Catches indirect use, still cheap | Noisy — common phrases match; chunked memories with shared boilerplate over-trigger; needs n-gram threshold tuning |
| **LLM rater (sampled)** | 0.8 (high) | Small model (Haiku / OpenRouter) given query + memory + response, returns `{ useful: bool, score: 0..1 }` | Best signal quality; captures "informed but not cited"; structured output is parse-stable | Cost — even sampled at 10% adds latency + $; rater bias drift; requires schema + retries |
| **Task-outcome correlation** | 0.4 (medium-low, propagated) | If task succeeds, propagate small + to all memories cited; failure → small − | Free, aligns with what we ultimately care about | Sparse + delayed; success is multi-causal so signal is weak per-memory; needs many trials to converge |
| **Explicit agent self-rating** | 1.0 (max — high intent) | New MCP tool: `rate_memory(id, useful: bool)` | Cleanest semantic signal — the agent took an action specifically to assert this | Agents rarely volunteer; requires prompt instructions; gameable if agent is sloppy |

(Weights are starting suggestions, not fixed — they should themselves be config-tunable per `MemoryRater` instance.)

Recommended starting mix: **ID match + content substring** as the always-on baseline (free, no extra calls), **LLM rater at 10% sample rate** behind a config flag for quality calibration, **task-outcome** as a slow-loop secondary update. Self-rating tool is opt-in, low-priority — but its weight is highest because the act of calling it is itself a strong intent signal.

### Decisions

- **Memory-scope priors → shared.** Swarm-scope memories share `(alpha, beta)` across agents (one row, many writers). More data, faster convergence. The consistency cost (API server has to serialize updates per row) is real but bounded — a single SQLite `UPDATE … SET alpha = alpha + ?, beta = beta + ?` is atomic; SQLite's WAL handles concurrent writers fine. Agent-scope memories keep per-agent posteriors.
- **Cold-start → similarity floor.** Add a minimum `similarity` threshold (e.g., 0.5) before Bayesian rerank can promote a candidate. Prevents brand-new low-relevance memories from being explored just because their `Beta(1,1)` posterior is wide.
