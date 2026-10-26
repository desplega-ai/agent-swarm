# Spike: TEI + nomic-embed-text-v1.5 on this Mac, wired to swarm memory

Run on 2026-10-26 (BCN, about 02:00 to 02:45). Host: arm64 Mac, OrbStack, Docker 29.8.2, 10 CPUs, 15.7 GiB given to the VM. This is NOT a server. Treat throughput as a floor.

Image: `ghcr.io/huggingface/text-embeddings-inference:cpu-arm64-1.9.4`. Model: `nomic-ai/nomic-embed-text-v1.5`. Swarm: detached origin/main 860dd9cb9 worktree, never edited.

Files: `scripts/` (benchmark, Matryoshka and swarm scripts, Bun preload), `results/` (raw numbers). No credentials stored. No source diff exists because no repo file was edited.

## 1. Does it start on 1.9.4

Yes. `/health` is OK and `/info` shows version 1.9.4, `model_dtype=float32`, mean pooling, `max_input_length=8192`.

Two odd log lines the plan should know:

- The ORT (ONNX) backend fails on this model: `Failed to parse config.json: duplicate field hidden_size`. TEI then falls back to the Candle backend (`Starting NomicBert model on Cpu`). It works, but TEI first downloads `onnx/model.onnx` (547 MB) for nothing, then `model.safetensors` (547 MB). The data dir is 1.0 GB, not 0.55 GB.
- `Backend does not support a batch size > 4 ... forcing max_batch_requests=4`.

## 2. Size, start time, memory, speed

| Metric | Value |
|---|---|
| Image on disk (`docker images`) | 343 MB (342,635,250 bytes). The research doc said about 117 MB compressed. Compressed pull size was not measured |
| Weights on disk | 1.0 GB (2 x 547 MB, see above) |
| Cold start total | about 104 s (to `/health` OK) |
| Cold: ONNX download | 30.8 s |
| Cold: safetensors download | 31.5 s |
| Cold: model load | 0.4 s |
| Cold: warmup | 34.5 s |
| Warm start (weights cached) | 30 s, of which warmup 28.5 s |
| Idle RAM | 675 MiB |
| RAM under load | 676 to 678 MiB, no growth (sampled during every run) |
| Short query (11 tokens), 100 sequential | p50 41 ms, p95 48 ms, p99 54 ms, min 36 ms |

Image pull took 9.7 s on this link.

Throughput, texts of about 287 tokens (216 to 412), all 10 CPUs visible:

| Batch size | Concurrency | Texts per second | Request p50 |
|---|---|---|---|
| 1 | 1 | 1.97 | 0.44 s |
| 1 | 4 | 1.82 | 1.76 s |
| 8 | 1 | 1.86 | 3.68 s |
| 8 | 4 | 2.31 | 13.4 s |
| 32 | 1 | 2.23 | 14.3 s |
| 32 | 4 | 2.29 | 53.3 s |

Reading: about 2 texts/s of 300 tokens, flat across batch size and concurrency. Container CPU showed only 100 to 180 percent, so Candle does not use the 10 cores well here. Batching and concurrency do not help. A real 139-chunk document (larger chunks) embedded in 108 s through swarm. Plan for roughly 0.5 s per 300-token chunk.

Implication: a first-run memory backfill of N chunks costs about N / 2 seconds on a laptop. Short queries are fine (41 ms). Do not promise fast bulk indexing on arm64 Docker. Not measured: an x86_64 server, or a different thread setting.

## 3. Matryoshka and prefixes

`/v1/embeddings` with `dimensions` 768, 512, 256 returns exactly that many floats, each with L2 norm 1.0 (also with no `dimensions`: 768, norm 1.0). TEI 512 equals `l2(first 512 of the 768 vector)` to 1e-8. `dimensions` above 768 or 0 returns 422 (`should be smaller than the maximum embedding dimension` / `should be positive`). `/embed` also takes `dimensions`.

Card recipe check (POST `/embed` with `normalize=false` at 768, parameterless layer norm, truncate, L2-normalize), 20 chunk texts of about 120 tokens, `search_document: ` prefix:

| Dim | Mean cosine, TEI vs card | Min |
|---|---|---|
| 512 | 0.999968 | 0.999951 |
| 256 | 0.999971 | 0.999954 |

This corrects the research doc worry (research doc line 63): TEI's raw pooled output is already near zero mean (mean about 0.006 against std about 0.78, norm about 21), so the layer norm is only a global rescale and the L2-normalize removes it. TEI `dimensions=512` is the card recipe for practical purposes. No client-side layer norm is needed.

Retrieval check: 10 queries over 50 short docs (10 topics x 5 docs, 5 relevant per query). Synthetic and small, so the numbers are indicative only.

| Comparison | Result |
|---|---|
| Top-5 overlap, TEI 512 vs card 512 | 1.00 |
| Top-5 overlap, TEI 256 vs card 256 | 1.00 |
| Top-5 overlap, prefixed 768 vs unprefixed 768 | 0.86 |
| Top-5 overlap, TEI 512 vs TEI 768 | 0.92 |
| Recall@5 vs topic truth: 512 prefixed (TEI and card) | 0.70 |
| Recall@5: 768 prefixed / 768 unprefixed | 0.74 / 0.76 |
| Recall@5: 256 prefixed (TEI and card) | 0.76 |

Reading: the truncation recipe makes no difference. On this tiny set, prefixes did not help (0.74 vs 0.76) and dimension did not matter. The corpus is too small and too easy to rank prefix or dimension choices. Swarm sends no prefix today (see 4), and that works acceptably.

## 4. Swarm memory against TEI

Boot: worktree run, `DATABASE_PATH` in temp, telemetry test, integrations disabled, random API key, `EMBEDDING_API_BASE_URL=http://localhost:8091/v1`, `EMBEDDING_MODEL=nomic-ai/nomic-embed-text-v1.5`, `EMBEDDING_DIMENSIONS=768`, `EMBEDDING_API_KEY` set to a dummy value.

Results:

- 5 memories stored through `POST /api/memory/index` (202). All 5 rows hold 768-dim blobs (3072 bytes), L2 norm 1.0000, `embeddingModel` = `nomic-ai/nomic-embed-text-v1.5`.
- On boot the API also embedded its 28 seeded scripts through TEI (`embedded=28 failed=0`).
- Semantic search works: 5 of 5 queries had the right memory at rank 1 with paraphrased queries (for example "how do I change the api key" -> rotate-api-key 0.972; "what should I cook tonight" -> pasta-recipe 0.841). Latency 34 to 157 ms. See `results/swarm_search_vec.txt`.
- The server sends `dimensions: <EMBEDDING_DIMENSIONS>` and `encoding_format: "float"` on every request (`src/be/memory/providers/openai-embedding.ts:83-90`). TEI accepts both. It ignores the `model` field. It accepts `dimensions` equal to 768 and truncates for smaller values. No prefixes are added in `embed` / `embedBatch` (`openai-embedding.ts:127-186`).

### Findings the plan must act on

1. **Batch size above 32 silently fails.** TEI defaults to `--max-client-batch-size 32` and answers 422 `batch size 33 > maximum allowed batch size 32`. Swarm groups inputs by characters (200,000 per request, `openai-embedding.ts:15`, `:142-156`), not by count. The retry path only handles HTTP 400 (`isInputRejection`, `:31-33`, `:170`). A 422 only logs `[memory] Batch embedding failed: 422 status code (no body)` and leaves the vector null (`:170-172`). Repro: indexing a 150 KB file produced 139 chunks, 139 rows, 0 embeddings (`src/be/memory/index-content.ts:165` embeds all chunks in one call). Fix A (no swarm change): start TEI with `--max-client-batch-size 256` or higher. I did this, and the same file embedded 139 of 139 in 108 s. Fix B: cap the group size in `embedBatch` and treat 422 like 400. The plan should do A in the new-install compose and consider B. Boot re-embed uses batches of 20 (`boot-reembed.ts:20`), so it is not affected.
2. **Default dimension is 512, not 768.** `EMBEDDING_DIMENSIONS` defaults to 512 (`src/be/memory/constants.ts:97`) and is read once at module load. The sqlite-vec table is created with that size (`sqlite-store.ts:332`). TEI truncates to 512 correctly (section 3). So new-install tooling can leave `EMBEDDING_DIMENSIONS` unset, keep the same vec schema as today's installs, and avoid a dimension mismatch. Only set 768 if the plan wants full size. Mismatched vectors are rejected (`openai-embedding.ts:95-101`, `sqlite-store.ts:442`). Not run: switching an install that already holds OpenAI 512 vectors to TEI. The vectors live in a different model space, so the plan needs a re-embed (`/api/memory/re-embed`, `src/http/memory.ts:1381`) after any model switch. Also unverified at runtime: constants.ts says swarm_config values load after memory modules import, so a dashboard-saved `EMBEDDING_DIMENSIONS` may be inert until restart.
3. **A key must be non-empty.** `isConfigured()` is `!!apiKey` (`openai-embedding.ts:50-66`). TEI without `--api-key` ignores the bearer, so a dummy `EMBEDDING_API_KEY` is enough. Without one, memory silently does nothing.
4. **Vector search needs a SQLite that can load extensions.** Bun's bundled macOS SQLite cannot: `[db] sqlite-vec not available ... does not support dynamic extension loading` (`src/be/db/runtime.ts:53-72`). Search then falls back to FTS only (`retrieval_path=fts reason=sqlite_vec_extension_unavailable`, `sqlite-store.ts:623-628`, `:1464`), so "semantic hits" there are keyword hits. I got true hybrid vec search by preloading `Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib")` (`scripts/preload.ts`, outside the repo). Docker/Linux images are not affected. A host-run Mac QA of this feature needs that preload.
5. **The ONNX double download.** `--model-id` alone downloads 1.0 GB. Not blocking. If disk or first-boot time matters, pre-seed the data volume or look for a TEI flag or revision that skips ONNX (not tested).

### Corrections to brainstorm and research facts

- Image size: 343 MB on disk for arm64 (research said about 117 MB compressed). RAM: 675 MiB idle (the research doc had no number).
- The layer norm concern in the research doc (lines 63 and 122) is resolved: no practical effect.
- Cold start is about 100 s, mostly download plus a 30 s warmup. Warm restart is 30 s. Compose healthchecks need a start period of at least 120 s on first boot.

## 5. State left behind

Container `afo-spike-tei` is running on host port 8091 with `--model-id nomic-ai/nomic-embed-text-v1.5 --max-client-batch-size 256` (the first run, without the batch flag, was recreated for finding 1). Weights are in `/tmp/afo-spike-tei/data` (1.0 GB, needed by the container). The swarm API was stopped. All other temp files were deleted.

## 6. What the plan must do

- TEI service in the new-install compose: image pinned to 1.9.4 (earlier versions crash), `--max-client-batch-size 256`, a persistent volume for `/data`, healthcheck on `/health` with a start period of 120 s or more, about 1 GB RAM.
- Swarm env for new installs: `EMBEDDING_API_BASE_URL=http://tei:80/v1`, `EMBEDDING_MODEL=nomic-ai/nomic-embed-text-v1.5`, a placeholder `EMBEDDING_API_KEY`. Leave `EMBEDDING_DIMENSIONS` unset (512). Unset envs keep today's OpenAI behavior.
- Optional small swarm fix: cap `embedBatch` group size and treat 422 as an input rejection, so a TEI left on defaults does not drop vectors silently.
- Set expectations: about 2 chunks/s on arm64 Docker. No client prefixes are needed for acceptable retrieval.
