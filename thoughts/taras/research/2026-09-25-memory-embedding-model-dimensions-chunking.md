---
date: 2026-09-25T21:32:00+02:00
researcher: Claude
git_commit: 06e9e810630df0ca4f8b86c41eee6e42e5ef2066
branch: worktree-embedding-research
repository: agent-swarm
topic: "Why memory embeddings default to text-embedding-3-small, and what changes with other models, dimensions, and chunking"
tags: [research, memory, embeddings, chunking, retrieval, eval]
status: complete
autonomy: critical
last_updated: 2026-09-25
last_updated_by: Claude
---

# Research: memory embedding model, dimensions, and chunking

**Date**: 2026-09-25
**Researcher**: Claude (for Taras)
**Git Commit**: 06e9e8106
**Branch**: worktree-embedding-research
**Harness**: `scripts/embedding-eval/` (research-only code, not imported by the app)

## Research Question

Why does the memory system embed with OpenAI `text-embedding-3-small`? Run a comparison on the prod memory corpus:

1. What happens with another model (for example `text-embedding-3-large` or the Gemini models)?
2. What happens when the vector dimensions change?
3. What happens with other chunking strategies?

## Summary

**Why 3-small at 512 dims.** The choice dates from the first memory plan (2026-02-19/20). The plan cites cost ($0.02 per 1M tokens), simplicity, and a 2 KB vector that fit brute-force JS search. It calls 512 dims "likely sufficient". No doc compares vendors, and no benchmark was ever run. Later work kept 512 as a fixed substrate. The 2026-09-24 onboarding decision dropped non-512 presets because the `memory_vec` table is dimension-locked.

**Models.** On the prod corpus (16,087 memories), `gemini-embedding-2` and `voyage-4` retrieve clearly better than the incumbent. For task-style queries (the shape of pre-task recall), vector hit@5 goes from 0.621 (3-small@512) to 0.824 (gemini-embedding-2@768) and 0.796 (voyage-4). On real prod tasks with LLM-judged relevance, useful memories in the vector top-5 go from 0.43 to 0.53 (gemini-embedding-2) and 0.51 (voyage-4). Hybrid search mutes these gains to about +0.06. `text-embedding-3-large`, `gemini-embedding-001`, and `qwen3-embedding-8b` show gains on synthetic queries but no measurable gain on judged real tasks. `gemini-embedding-2` needs no code change beyond the dimension: it ignores `taskType`, so the OpenAI-compatible path returns identical vectors.

**Dimensions.** For 3-small, 256 dims is measurably worse than 512, and 1024 or 1536 dims add +0.03 to +0.045 hit@5 on task-style queries only. For 3-large and gemini-embedding-2, quality plateaus at 768 to 1024 dims. A better model at 512 dims beats 3-small at 1536 dims. Local truncation plus re-normalization reproduces the API output exactly (cosine 1.00000), so any width can be derived from one full-width vector.

**Chunking.** Chunking is the largest effect measured. `task_completion` memories (49% of rows, the long ones) are stored as one unchunked vector. For long docs (4k to 24k chars), a query about a specific passage finds the doc in the vector top-5 12.7% of the time when the doc is one vector. With the existing `chunkContent` (2000 chars), it finds it 41.1% of the time. 1000-char chunks reach 46.7%. LLM contextual prefixes (Anthropic "contextual retrieval") give the best whole-doc ("gist") retrieval and the best hybrid results. The chunking effect is larger than any model change.

**Side findings (as-is facts with evidence):**
- In the last 30 days, 20% of pre-task recalls (1,511 of 7,547 tasks) used no embeddings at all. Their task text is over 32k chars, the OpenAI call fails, and search falls back to FTS only.
- 177 `task_completion` memories have no vector. All are over ~32k chars. OpenAI rejects inputs over 8192 tokens, and a single over-limit item fails the whole batch request.
- In hybrid mode, the `similarity` that pre-task recall compares against the 0.4 render threshold is an RRF score (max about 0.15 after reranking). In the last 30 days, 0 of 12,859 hybrid/vec recalls crossed 0.4. 94% of rendered memories came from graph expansion.
- `chunkContent` in `src/be/chunking.ts` never returns when a text over 2000 chars contains an unbroken run over 2000 chars (no space or newline). `hardSplit` cannot reach its exit condition. 16 prod `task_completion` rows contain such a run today. They bypass chunking, so they did not trigger it.

## Detailed Findings

### 1. Why text-embedding-3-small at 512 dims

| Date | Source | What it says |
|---|---|---|
| 2026-02-19 | `thoughts/taras/research/2026-02-19-agent-native-swarm-architecture.md:380` | Open question: "OpenClaw supports OpenAI, Gemini, Voyage AI, and local models. Which would work best?" Never answered. |
| 2026-02-19 | `thoughts/taras/research/2026-02-19-swarm-gaps-implementation.md:175-178,578` | Compares only OpenAI 3-small vs 3-large. "512 dims is plenty for task/message similarity." Decision: "3-small at 512 dimensions." |
| 2026-02-20 | `thoughts/taras/plans/2026-02-20-memory-system.md:99,105` | "Simple, cheap, well-documented." 512 dims = 2 KB per vector, 20 MB for 10k memories, brute-force JS search. |
| 2026-02-20 | commit `605b63e51` | First implementation: "OpenAI text-embedding-3-small (512-dim), graceful degradation without key." |
| 2026-04-12 | PR #327 | Provider abstraction, `EMBEDDING_MODEL` / `EMBEDDING_API_BASE_URL` / `EMBEDDING_API_KEY`, `embeddingModel` column, manual `/api/memory/re-embed`. Default unchanged. |
| 2026-06-05 | PR #676 | `EMBEDDING_DIMENSIONS` becomes env-overridable (default 512). |
| 2026-06-08 | PR #696 | 1,634 rows with 1536-dim vectors came from a custom base URL that ignored `dimensions`. Adds response validation and `boot-reembed.ts`. |
| 2026-09-24 | `thoughts/taras/research/2026-09-24-ui-onboarding-experience.md:197,213` | Drops the Ollama preset because storage is fixed at 512 dims. Verifies OpenAI, OpenRouter, and Vercel all return 512 dims for 3-small. |

No source compares vendors, runs a retrieval benchmark, or revisits the default after February.

### 2. How embeddings work today

- **Provider**: `src/be/memory/providers/openai-embedding.ts:11-124`. Model `config.model ?? EMBEDDING_MODEL ?? "text-embedding-3-small"` (`:22`). Key `EMBEDDING_API_KEY ?? OPENAI_API_KEY` (`:20`). Base URL `EMBEDDING_API_BASE_URL` (`:39`). Request `{ model, input, dimensions, encoding_format: "float" }` (`:45-77`). Newlines become spaces (`:50`). No truncation. A response of the wrong width is logged and dropped (`:65-70`, `:108-113`).
- **Defaults**: `EMBEDDING_DIMENSIONS = numEnv("EMBEDDING_DIMENSIONS", 512)` and `DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small"` (`src/be/memory/constants.ts:81-83`).
- **Chunking**: `chunkContent` (`src/be/chunking.ts:18-57`): header split, then recursive split on `\n\n`, `\n`, `. `, space at 2000 chars with 100-char overlap, heading path prefix. Only `indexMemoryContent` (`src/be/memory/index-content.ts:44`) uses it: memory-store tool, file_index hook, session summaries via `/api/memory/index`.
- **Unchunked paths**: `task_completion` writes `"Task: …\n\nOutput:\n…"` through `store.store()` as one vector (`src/tasks/task-terminal-effects.ts:43-61`). Memory edits re-embed the whole new content.
- **Storage**: `agent_memory.embedding` BLOB of float32, `embeddingModel` per row, no per-row dimension. `memory_vec` is a runtime-created `vec0(... float[EMBEDDING_DIMENSIONS] distance_metric=cosine)` table (`sqlite-store.ts:242-285`). `memory_fts` is FTS5 over `(name, content)` with porter/unicode61 (`sqlite-store.ts:169-175`).
- **Search**: hybrid by default (`sqlite-store.ts:479-596`). Vec arm: cosine, `MEMORY_MIN_SIMILARITY` floor 0.1 (`:719`). FTS arm: first 12 query terms, quoted, OR-joined, bm25 order (`:661-670`). RRF k=60 with recency decay (`:116-118`, `:572-596`). Then 1-hop graph expansion (`graph-expansion.ts:72-166`) and the reranker (`reranker.ts:75-109`). The reranker writes the composite score back into `similarity`.
- **Pre-task recall**: `runner.ts:3224-3263` sends `task.task` verbatim as the query with `limit: 5`. `renderMemoriesPrompt` keeps results with `similarity > 0.4` (`src/prompts/memories.ts:23,38`).
- **Name not embedded**: the memory `name` goes to FTS but not into the embedded text.

### 3. Prod corpus and traffic (read-only, 2026-09-25)

- 16,087 non-expired rows: task_completion 7,935, manual 3,324, session_summary 3,030, file_index 1,779. 12 agents plus one null. Scope: agent 11,921, swarm 4,166.
- All stored vectors are 512 dims. `embeddingModel` is `openai/text-embedding-3-small` or null (legacy rows).
- Content length: p50 1,331 chars, p90 4,550, p99 32,647, max 417,857. 4,276 task_completion rows exceed 2,000 chars.
- **Missing vectors**: 177 rows have no vector. All are task_completion, p10 length 32,432 chars. OpenAI returns `400 Invalid 'input[0]': maximum input length is 8192 tokens` for one over-limit item and rejects the whole batch.
- **FTS-only recall for long tasks** (last 30 days): 1,511 of 7,547 pre-task-recall tasks have task text over 32k chars. Their recall rows are `fts` 7,496 and `graph` 59, with zero `vec` or `hybrid`. Tasks at or under 32k chars get vec 1,946, hybrid 10,942, fts 11,421, graph 5,881.
- **Render threshold vs score scale** (last 30 days, pre-task recall): max `similarity` is 0.136 for hybrid rows and 0.238 for vec rows. 0 of 12,859 crossed 0.4. Graph rows (raw-cosine based) crossed 3,808 times, fts rows 241 times. 1,857 of 7,537 tasks (24.6%) got at least one memory rendered.
- Explicit agent searches: 10,194 search events across 1,371 tasks in 30 days. The query text is not logged. Only the free-text `intent` is logged.

### 4. Eval method

**Corpus.** A full read-only export of the 16,087 rows (`export.ts`). Every name, content, and query passes through `scrubSecrets` before any API call (96 rows had a redaction). Docs are capped at 24,000 chars so no input exceeds 8192 OpenAI tokens. No embedding call failed.

**Fidelity checks** (`fidelity.py`, 100 random prod rows):
- Our 3-small@512 vectors vs the prod-stored blobs: cosine min 0.99993, p50 1.00000.
- Local truncation of the 1536-dim vector to 512 dims, then L2 re-normalization, vs API `dimensions: 512`: cosine min 0.99999.
- Same check for Gemini `outputDimensionality: 768`: cosine 1.00000 for both Gemini models.
- `chunk.ts` asserts that its parametrized chunker copy returns exactly the `chunkContent` output at 2000/100.

**Query sets** (`gen-queries.ts`, `google/gemini-3-flash-preview`):

| Set | n | What it is | Relevant item |
|---|---|---|---|
| synthetic-task | 398 | A realistic task assignment written from one target memory (100 targets per source). Paraphrased. | The target row (plus exact-duplicate rows) |
| synthetic-search | 398 | A 4 to 12 word memory-search query for the same targets | Same |
| real-pretask | 390 | Real `task.task` text from prod pre-task recalls in the last 90 days | Memories with a positive `memory_rating` for that task that still exist |
| real-pretask, judged | 120 | A random sample of real-pretask | Pooled top-5 from 8 configs × vec/hybrid (3,128 pairs), judged 0/1/2 by `anthropic/claude-haiku-4.5` |
| chunk-detail | 197 | A task that needs one passage from 30% to 85% into a long doc | The doc |
| chunk-gist | 198 | A task that needs the long doc as a whole | The doc |

**Simulation** (`score.py`) mirrors the model-dependent parts of prod search. Candidates are the query agent's own rows plus swarm rows. Real queries also see only rows created before the recall. The vec arm applies the 0.1 floor and takes the top 60. The FTS arm uses the same tokenizer and 12-term OR match. Hybrid is RRF k=60 of both arms. Recency decay, graph expansion, and reranker multipliers are left out. They are model-independent but change absolute numbers.

**Metrics.** hit@k (a relevant item in the top k), MRR@10, and for judged sets P@5 and nDCG@5. The deltas use a 2,000-sample paired bootstrap against 3-small@512. `*` marks a 95% CI that excludes 0.

**Label caveats.**
- *real-pretask (incumbent labels)* only rates memories that the incumbent pipeline (3-small@512 hybrid plus graph) already showed. It favors the incumbent by construction. Every model scores lower than the incumbent on it, including 3-small at other widths.
- *Judged* removes that bias. The judge agrees with prod ratings: 86% of prod-positive memories got score 2, vs 31% of other pooled memories.
- *Synthetic* queries come from a Gemini LLM. That can favor Gemini embeddings. The judged set uses a Claude judge and shows the same ranking.
- In the simulation, 62 of 390 real tasks exceed 24k chars. The simulation embeds them truncated. Prod does not embed them (see section 3).

### 5. Results: other models

Hit@5, delta vs 3-small@512 (bold). Task-style queries match pre-task recall. Search-style queries match the memory-search tool.

| config | task-style, vec | search-style, vec | task-style, hybrid | search-style, hybrid | $/1M tok | bytes/vec |
|---|---|---|---|---|---|---|
| **oai-3s@512 (prod)** | **0.621** | **0.754** | **0.472** | **0.852** | 0.02 | 2048 |
| oai-3s@1536 | 0.666 (+0.045*) | 0.774 (+0.020) | 0.485 (+0.013) | 0.864 (+0.013) | 0.02 | 6144 |
| oai-3l@3072 | 0.724 (+0.103*) | 0.794 (+0.040*) | 0.480 (+0.008) | 0.854 (+0.003) | 0.13 | 12288 |
| gem-001@3072 | 0.714 (+0.093*) | 0.781 (+0.028) | 0.525 (+0.053*) | 0.862 (+0.010) | 0.15 | 12288 |
| gem-2@768 | 0.824 (+0.204*) | 0.814 (+0.060*) | 0.608 (+0.136*) | 0.872 (+0.020) | 0.20 | 3072 |
| gem-2@3072 | 0.827 (+0.206*) | 0.817 (+0.063*) | 0.611 (+0.138*) | 0.862 (+0.010) | 0.20 | 12288 |
| voyage-4@1024 | 0.796 (+0.176*) | 0.822 (+0.068*) | 0.553 (+0.080*) | 0.867 (+0.015) | 0.06 | 4096 |
| qwen3-8b@4096 | 0.716 (+0.095*) | 0.656 (-0.098*) | 0.482 (+0.010) | 0.796 (-0.055*) | 0.01 | 16384 |
| oai-3s@512, name + content | 0.648 (+0.028) | 0.756 (+0.003) | 0.465 (-0.008) | 0.857 (+0.005) | 0.02 | 2048 |

Real prod tasks, LLM-judged pool (n=120), delta vs 3-small@512:

| config | vec P@5 useful | vec any useful in top-5 | vec nDCG@5 | hybrid P@5 useful | hybrid any useful | hybrid nDCG@5 |
|---|---|---|---|---|---|---|
| **oai-3s@512 (prod)** | **0.428** | **0.708** | **0.535** | **0.440** | **0.708** | **0.544** |
| oai-3s@1536 | 0.430 (+0.002) | 0.708 (+0.000) | 0.547 (+0.012) | 0.440 (-0.000) | 0.733 (+0.025) | 0.548 (+0.004) |
| oai-3l@3072 | 0.443 (+0.015) | 0.725 (+0.017) | 0.554 (+0.019) | 0.448 (+0.008) | 0.725 (+0.017) | 0.562 (+0.018) |
| gem-001@3072 | 0.428 (-0.000) | 0.650 (-0.058) | 0.533 (-0.002) | 0.438 (-0.002) | 0.692 (-0.017) | 0.540 (-0.003) |
| gem-2@768 | 0.528 (+0.100*) | 0.808 (+0.100*) | 0.654 (+0.120*) | 0.503 (+0.063*) | 0.792 (+0.083*) | 0.610 (+0.066*) |
| voyage-4@1024 | 0.507 (+0.078*) | 0.775 (+0.067*) | 0.628 (+0.093*) | 0.498 (+0.058*) | 0.808 (+0.100*) | 0.626 (+0.082*) |
| qwen3-8b@4096 | 0.425 (-0.003) | 0.650 (-0.058) | 0.535 (+0.000) | 0.443 (+0.003) | 0.717 (+0.008) | 0.541 (-0.003) |

Observations:
- **gemini-embedding-2** is the best on every unbiased set. On judged real tasks it adds 0.5 useful memories per top-5 list (vec). It raises "at least one useful memory" from 71% to 81%.
- **voyage-4** is close to gemini-embedding-2, at 30% of its price and a 1024-dim vector.
- **3-large** helps synthetic task-style queries (+0.10) but not judged real tasks (+0.015, CI includes 0). The same holds for gemini-embedding-001.
- **qwen3-embedding-8b** was called without its query instruction prefix (the drop-in path). It loses on short search queries (-0.10).
- **Hybrid dilutes model gains.** For task-style queries, hybrid is *worse* than vec alone for every model (3-small: 0.472 vs 0.621). The FTS arm ORs the first 12 words of a long task and adds noisy candidates with equal RRF weight. For short search queries, hybrid helps every model (3-small: 0.852 vs 0.754).
- **Embedding `name + content`** changes little (+0.028, CI includes 0).
- **gemini-embedding-2 and task types**: `RETRIEVAL_DOCUMENT`, `RETRIEVAL_QUERY`, and no task type return identical vectors (cosine 1.00000 over 100 docs and 1,186 queries). The OpenRouter/OpenAI-compatible path therefore loses nothing.

Operational differences:

| Model | Input limit | Over-limit behavior | Width options | Normalized at reduced width | Query latency p50 / p90 (ms, from this Mac) |
|---|---|---|---|---|---|
| text-embedding-3-small | 8192 tok | HTTP 400, whole batch fails | 256 to 1536 (`dimensions`) | Yes | 158 / 206 (@512, direct) |
| text-embedding-3-large | 8192 tok | HTTP 400 | 256 to 3072 | Yes | 270 / 310 |
| gemini-embedding-001 | 2048 tok | Silent truncation | 128 to 3072 (`outputDimensionality`) | **No** (norm 0.58 at 768) | 274 / 333 |
| gemini-embedding-2 | 8192 tok | Silent truncation (tested at ~50k tok) | 128 to 3072 | Yes | 380 / 560 direct, 324 / 344 via OpenRouter |
| voyage-4 (OpenRouter) | 32k tok | not tested | 1024 default | n/a | 177 / 203 |
| qwen3-embedding-8b (OpenRouter) | 32k tok | not tested | up to 4096 | n/a | 222 / 988 |

- Gemini batch requests accept at most 100 items (`at most 100 requests can be in one batch`).
- **Cosine scale differs by model.** The median cosine between two random memories is 0.45 for 3-small@512, 0.65 for gemini-embedding-2@768, and 0.75 for gemini-embedding-001. The gap between a target and a random pair is 0.16 for 3-small, 0.13 for gemini-embedding-2, and 0.02 to 0.03 for gemini-embedding-001. The fixed thresholds (`MEMORY_MIN_SIMILARITY` 0.1, render threshold 0.4) filter nothing for the Gemini models. For 3-small, 98% of targets and more than half of random pairs exceed 0.4 as well.
- Full re-embed of today's corpus (~9M tokens at the 24k-char cap): 3-small ~$0.18, voyage-4 ~$0.54, 3-large ~$1.18, gemini-embedding-2 ~$1.81.

### 6. Results: dimensions

Vector hit@5, task-style / search-style (delta vs 3-small@512):

| model | 256 | 512 | 768 / 1024 | 1536 | 3072 / 4096 |
|---|---|---|---|---|---|
| oai-3s | 0.580 (-0.040*) / 0.729 | **0.621 / 0.754** | 0.653 (+0.033*) / 0.761 @1024 | 0.666 (+0.045*) / 0.774 | n/a |
| oai-3l | 0.608 / 0.704 (-0.050*) | 0.663 (+0.043*) / 0.766 | 0.696 (+0.075*) / 0.781 @1024 | 0.704 (+0.083*) / 0.779 | 0.724 (+0.103*) / 0.794 (+0.040*) |
| gem-001 | 0.646 / 0.729 | 0.701 (+0.080*) / 0.766 | 0.711 (+0.090*) / 0.779 @768 | 0.706 / 0.784 | 0.714 / 0.781 |
| gem-2 | 0.761 (+0.141*) / 0.764 | 0.799 (+0.178*) / 0.799 (+0.045*) | 0.824 (+0.204*) / 0.814 (+0.060*) @768 | 0.819 / 0.817 | 0.827 / 0.817 |
| qwen3-8b | n/a | 0.691 / 0.611 | 0.721 / 0.638 @1024 | n/a | 0.716 / 0.656 @4096 |

- Going below 512 costs quality for every model.
- 3-small gains +0.03 to +0.045 on task-style queries from 1024 or 1536 dims. On judged real tasks, 1536 gives +0.002 P@5 (not significant).
- gemini-embedding-2 plateaus at 768. gemini-embedding-2@512 (same 2 KB as today) scores 0.799 vs the incumbent's 0.621.
- Storage today: 16,087 × 2 KB = 33 MB. At 768 dims: 49 MB. At 3072: 198 MB. `memory_vec` is a `vec0` brute-force KNN table, so scan cost grows linearly with width. That cost was not measured in the DB.
- Any width change needs a `memory_vec` rebuild, because `float[EMBEDDING_DIMENSIONS]` is baked into the virtual table DDL. `boot-reembed.ts` treats rows with a byte length other than `EMBEDDING_DIMENSIONS × 4` as invalid.

### 7. Results: chunking

Docs: 198 random task_completion memories of 4k to 24k chars (stored unchunked today). Two were excluded because they trigger the `hardSplit` hang (section 8). Each strategy replaces the doc's single row with its chunk rows. The rest of the corpus stays as distractors. A doc counts as found when any of its rows is in the top k, as in prod.

Strategies:
- `whole`: one vector per doc (today's task_completion behavior)
- `prod-2000`: today's `chunkContent`, 7.4 rows per doc
- `rec-1000` / `rec-4000`: the same algorithm at 1000/100 and 4000/200 chars
- `prod-2000-title`: prod-2000 with the memory name prefixed to each chunk
- `prod-2000-ctx`: prod-2000 with a 50 to 100 token LLM context prefix per chunk (Anthropic contextual retrieval prompt, `gemini-3-flash-preview`, $1.71 for 1,461 chunks)
- `whole+prod-2000`: both the whole vector and the chunks

Vector hit@5 (delta vs `whole`):

| model | strategy | detail | gist | distinct docs in top-5 |
|---|---|---|---|---|
| oai-3s@512 | whole | 0.127 | 0.249 | 5.00 |
| oai-3s@512 | prod-2000 | 0.411 (+0.284*) | 0.386 (+0.137*) | 4.70 |
| oai-3s@512 | rec-1000 | **0.467 (+0.340*)** | 0.381 (+0.132*) | 4.57 |
| oai-3s@512 | rec-4000 | 0.371 (+0.244*) | 0.365 (+0.117*) | 4.78 |
| oai-3s@512 | prod-2000-title | 0.386 (+0.259*) | 0.416 (+0.168*) | 4.50 |
| oai-3s@512 | prod-2000-ctx | 0.381 (+0.254*) | **0.447 (+0.198*)** | 4.42 |
| oai-3s@512 | whole+prod-2000 | 0.426 (+0.299*) | 0.396 (+0.147*) | 4.55 |
| gem-2@768 | whole | 0.178 | 0.360 | 5.00 |
| gem-2@768 | prod-2000 | 0.401 (+0.223*) | 0.396 (+0.036) | 4.52 |
| gem-2@768 | rec-1000 | 0.447 (+0.269*) | 0.411 (+0.051*) | 4.33 |
| gem-2@768 | prod-2000-ctx | 0.411 (+0.234*) | 0.442 (+0.081*) | 4.47 |

Hybrid hit@5 (delta vs `whole`):

| model | strategy | detail | gist |
|---|---|---|---|
| oai-3s@512 | whole | 0.218 | 0.269 |
| oai-3s@512 | prod-2000 | 0.401 (+0.183*) | 0.305 (+0.036) |
| oai-3s@512 | rec-1000 | 0.396 (+0.178*) | 0.294 (+0.025) |
| oai-3s@512 | prod-2000-title | 0.401 (+0.183*) | 0.345 (+0.076*) |
| oai-3s@512 | prod-2000-ctx | **0.457 (+0.239*)** | **0.437 (+0.168*)** |
| gem-2@768 | whole | 0.274 | 0.335 |
| gem-2@768 | prod-2000-ctx | 0.426 (+0.152*) | 0.447 (+0.112*) |

Observations:
- Any chunking beats one vector per long doc by a wide margin. The detail gain (+0.28) is larger than the best model swap on whole docs (gem-2 whole: +0.05).
- Smaller chunks help detail queries most (rec-1000 is best in vec mode). Title and LLM-context prefixes help gist queries most.
- In hybrid mode, only the LLM-context prefix lifts gist queries clearly (+0.168). It is the best hybrid strategy for both query types.
- 3-small with chunks (0.411 detail) beats gemini-embedding-2 with chunks (0.401). Once docs are chunked, the model gap on long docs mostly closes.
- Chunks of one doc take several top-5 slots. Distinct docs in the top-5 fall from 5.0 to 4.4 to 4.8.
- Full tables for 3-small@1536 and 3-large@3072: `scripts/embedding-eval/results/report.md`.

### 8. `chunkContent` hangs on long unbroken runs

- `hardSplit` (`src/be/chunking.ts:164-174`) sets `start = end - CHUNK_OVERLAP` and exits only when `start >= text.length - MIN_CHUNK_SIZE`. Once `end` reaches `text.length`, `start` stays at `length - 100`. That is always below `length - 50`, so the loop never exits and pushes chunks until memory runs out.
- `recursiveSplitWithSeparators` calls `hardSplit` for any part over 2000 chars that has no `\n\n`, `\n`, `. `, or space (`:122-125`, `:147-148`). Examples: base64, minified JSON, or long URLs.
- Repro: `chunkContent("word ".repeat(600) + "\n\n" + "x".repeat(2500))` does not return (killed by a 10s timeout). The first eval run hung at 100% CPU and 5 GB RSS on one prod doc.
- Callers: `indexMemoryContent` (memory-store tool, `POST /api/memory/index` for file_index and session summaries). The call is synchronous on the API server.
- Prod exposure today: 16 rows over 2000 chars contain such a run. All are task_completion, which does not chunk.
- Filed as #1638. Fix and regression tests: PR #1639.

## Code References

| File | Line | Description |
|---|---|---|
| `src/be/memory/constants.ts` | 81-83 | `EMBEDDING_DIMENSIONS` (512) and `DEFAULT_EMBEDDING_MODEL` |
| `src/be/memory/providers/openai-embedding.ts` | 20-77 | Key, model, base URL, request body, newline cleaning, width check |
| `src/be/chunking.ts` | 8-10, 18-57, 164-174 | Chunk constants, `chunkContent`, `hardSplit` |
| `src/be/memory/index-content.ts` | 44 | Only caller of `chunkContent` |
| `src/tasks/task-terminal-effects.ts` | 43-61 | task_completion memory, embedded unchunked |
| `src/be/memory/providers/sqlite-store.ts` | 116-118, 242-285, 479-724 | RRF, `memory_vec` DDL, hybrid / FTS / vec search |
| `src/be/memory/reranker.ts` | 75-109 | Composite score written back into `similarity` |
| `src/commands/runner.ts` | 3224-3263 | Pre-task recall query = `task.task`, limit 5 |
| `src/prompts/memories.ts` | 23, 38 | 0.4 render threshold |
| `src/be/memory/boot-reembed.ts` | 19-85 | Backfill for missing or wrong-width vectors |
| `apps/ui/src/lib/configuration-catalog.ts` | 175-184 | `EMBEDDING_MODEL` catalog entry |

## Open Questions

- The simulation leaves out recency decay, graph expansion, and reranker multipliers. The end-to-end effect on rendered pre-task memories is not measured. That effect interacts with the 0.4 threshold finding in section 3.
- `vec0` scan latency at 768 or 3072 dims on the prod corpus is not measured.
- The judged set has 120 tasks and one judge model. A second judge or a human spot-check would tighten the real-task numbers.
- The chunking experiment covers task_completion docs only. file_index and manual docs are already chunked at 2000 chars.
- Voyage was reached through OpenRouter only. `input_type` (query vs document) was not tested.

## Appendix

**Reproduce** (from the repo root, needs SSH to the prod host, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`):

```bash
EMBED_EVAL_SSH_HOST=<alias> EMBED_EVAL_DB_PATH=<db path> \
  bun scripts/embedding-eval/export.ts                   # prod snapshot -> /tmp/embedding-eval (scrubbed)
bun scripts/embedding-eval/gen-queries.ts                # query sets
bun scripts/embedding-eval/embed.ts oai-3s,oai-3l,gem-001,gem-2,qwen3-8b,voyage-4 corpus,queries,chunk-queries
bun scripts/embedding-eval/embed.ts gem-2-or queries,chunk-queries
bun scripts/embedding-eval/embed.ts oai-3s corpus-named
bun scripts/embedding-eval/embed.ts oai-3s,oai-3s-512api,gem-001,gem-001-768api,gem-2,gem-2-768api,gem-2-or prodcheck
(cd scripts/embedding-eval && uv run --no-project --with numpy fidelity.py)
(cd scripts/embedding-eval && uv run --no-project --with numpy --with regex score.py models)
bun scripts/embedding-eval/judge.ts
bun scripts/embedding-eval/chunk.ts
bun scripts/embedding-eval/embed.ts oai-3s,oai-3l,gem-2 chunks
(cd scripts/embedding-eval && uv run --no-project --with numpy --with regex score.py chunking oai-3s@512 oai-3s@1536 oai-3l@3072 gem-2@768)
uv run --no-project --with numpy scripts/embedding-eval/report.py
bun scripts/embedding-eval/latency.ts
```

**Cost of this run**: about $18 in total. Embeddings were about $6. Query generation was $0.37. Chunk context was $1.71. The judge was $9.72.

**Data handling**: raw prod text lives only in `/tmp/embedding-eval/` (about 1.5 GB with vectors). It was sent, after `scrubSecrets`, to OpenAI, Google (Gemini API), and OpenRouter (Voyage, Qwen, Gemini Flash, Claude Haiku). `scripts/embedding-eval/results/` holds only aggregate metrics.

**Related research**:
- `thoughts/taras/research/2026-06-25-memory-system.md`: as-is memory architecture
- `thoughts/taras/research/2026-09-24-ui-onboarding-experience.md`: embedding presets and the 512-dim lock
