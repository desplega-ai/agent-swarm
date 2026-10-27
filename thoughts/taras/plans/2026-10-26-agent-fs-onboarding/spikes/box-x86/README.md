# Spike box-x86: TEI + agent-fs bundle on a 4 vCPU x86 box

Date: 2026-10-26, 02:00 to 02:35 BCN (CET). Box: Hetzner `cpx32` (4 vCPU AMD EPYC Genoa shared, 8 GB RAM, x86_64, fsn1), image `docker-ce`. Cost: one box for about 0.6 h, billed as 1 hour of cpx32 (about EUR 0.02). Box deleted, `hcloud server list -l purpose=onboarding-qa` is empty.
Swarm: v2.5.4, installed with the skill's `ui-install.sh` (= `install.sh --preset full --tunnel`): 1 API + lead + 10 workers. Install took 265 s (tunnel cert 42 s of it).

## Corrections to the brainstorm and research

1. **The one-shot installer compose has no agent-fs at all.** `agent-swarm onboard` writes `docker-compose.yml` with services `swarm-api`, `lead` and 10 workers only (service and container names `swarm-*`, not `api`/`agent-fs` as in `docker-compose.example.yml`). No `AGENT_FS_*` env, no volume. The bundle must add a service block to the onboard generator, not just env.
2. **Workers need no `AGENT_FS_API_URL`.** After I added agent-fs to the API only, all 11 agents still got agent-scoped `AGENT_FS_API_KEY` secrets (runner calls `POST /api/fs/agent-credentials` on the API, which talks to agent-fs). Seeder also set `AGENT_FS_SHARED_ORG_ID`, `AGENT_FS_DEFAULT_ORG_ID`, `AGENT_FS_DEFAULT_DRIVE_ID`.
3. **agent-fs `local` embeddings are not nomic.** The running image logs `local embedding model: embeddinggemma-2`, downloads a 331 MB ONNX model (`onnx-community/...`) into `/data/models` on first boot. `packages/core/src/search/embeddings/local.ts` (nomic GGUF via node-llama-cpp) is the old path. The brainstorm says "one TEI container with nomic serves both swarm memory and agent-fs (a new openai-compat provider)". This spike shows agent-fs local works out of the box with no extra container and is cheap (see numbers). An `openai-compat` provider would save only ~330 MB disk and ~300 MB RAM and costs a re-embed plus CPU contention on TEI.
4. **The agent-fs image has no curl and no wget.** `command -v curl; command -v wget` print nothing. It has `node` (bun fallback shim) and `bun`. The healthcheck in `docker-compose.example.yml:147-155` (`node -e fetch(...)`) works. The Dockerfile's own `HEALTHCHECK` uses `curl` (agent-fs `Dockerfile:40-41`) and cannot pass. The TEI image does have curl. Image sizes on disk: agent-fs 0.18.5 = 1.85 GB (amd64), TEI cpu-1.9.4 = 685 MB (239 MB compressed per research), API 419 MB, worker 8.17 GB.
5. **Memory vec table is fixed at the dimension of the FIRST boot.** `src/be/memory/providers/sqlite-store.ts:329-334` runs `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec ... float[${EMBEDDING_DIMENSIONS}]`. I added `EMBEDDING_DIMENSIONS=768` after the first boot (run 1). Result: every index failed with `[memory-vec] update failed ... Expected 512 dimensions but received 768`, search stayed on `retrieval_path=fts reason=memory_vec_empty|memory_vec_missing_embeddings`, and `boot-reembed` reported `remaining_wrong_dim=0` (it only checks the `agent_memory.embedding` blob, not the vec table). So the 768 env must be present in `.env`/compose BEFORE the first `docker compose up`. Confirms the brainstorm constraint; the plan must also make this fail loudly or rebuild for existing installs (out of scope for new-install-only, but the silent FTS fallback is a trap for anyone who flips the env later).
6. Run 2 (`docker compose down -v`, same override, first boot with 768): `vector_dimensions=768`, `retrievalMode: vec`, memory search `retrievalSource` = `hybrid`/`vec`, correct paraphrase hits (`verify-run2-fresh-768.txt`).

## TEI x86 numbers (`cpu-1.9.4`, nomic-ai/nomic-embed-text-v1.5)

Files: `s2-*.txt`, `bench.py`, `try.sh`.

| Item | Result |
|---|---|
| Image pull | 5.6 s (cached layers on a Hetzner box), 685 MB on disk |
| Model download | `onnx/model.onnx` 26.9 s, then ORT backend fails (`Failed to parse config.json: duplicate field hidden_size`), then `model.safetensors` 28.0 s. Both are downloaded: volume = **1.1 GB** (about half is wasted). Candle backend then runs NomicBert. |
| Cold start (download + load + warmup) | 182 s wall with default flags before the OOM (see below). In the stack, from `compose up` to healthy: ~60-80 s with `--max-batch-tokens 2048`. Load + warmup with a warm cache: **10 s** |
| **Default flags OOM** | With defaults (`max-batch-tokens` 16384) the warmup allocates >5.4 GB and the container is OOM-killed (exit 137, `OOMKilled=true`) on this 8 GB box. Reproduced twice (`s2-cold.txt`, `s2-default-warm.txt`). With `--max-batch-tokens 4096`: ready in 27 s, peak 2.7 GiB. With `--max-batch-tokens 2048`: ready in 10 s, peak ~1.0 GiB (coarse samples). **The compose service must pass `--max-batch-tokens 2048`.** |
| Idle memory | 560-680 MiB (`docker stats`; 674 MiB at stack idle, 659 MiB later) |
| Memory under load | 599 MiB (batch 1) to 765 MiB (batch 32 x 4 concurrent). Stable, no growth |
| CPU under load | 390-400% (all 4 vCPUs) at every setting |
| Short query latency (about 10 tokens, 100 sequential) | **p50 38.2 ms, p95 46.5 ms**, max 73.5 ms |
| Throughput, texts of 373 tokens (calibrated, a bit above the 300 asked) | see table |

| batch | concurrency | texts/s | tokens/s | request latency p50 |
|---|---|---|---|---|
| 1 | 1 | 1.38 | 514 | 0.73 s |
| 1 | 4 | 1.25 | 467 | 3.19 s |
| 8 | 1 | 1.12 | 416 | 7.26 s |
| 8 | 4 | 1.04 | 389 | 29.2 s |
| 32 | 1 | 1.03 | 383 | 31.4 s |
| 32 | 4 | 1.02 | 380 | 125.6 s |

Reading: this CPU embeds **about 1 document of 373 tokens per second (about 400 tokens/s)**, flat across batch size and concurrency (it is compute-bound, so batching and concurrency only add queueing). Short texts are fast (38 ms per query, memory notes of 20-60 tokens took 35-470 ms each in the TEI log). A backfill of 1,000 memories of ~370 tokens would take about 16 min and saturate all 4 vCPUs the whole time, starving the 11 agents. The research doc's "no numbers exist" gap is now closed. Not tested: ORT/ONNX backend (blocked by the config parse failure), quantized variants, the `dimensions` Matryoshka truncation, nomic prefixes (the swarm client sends none: `openai-embedding.ts:83-87` passes `dimensions` only).

## Bundle prototype

Applied: `docker-compose.override.after.yml` (diff in `override.diff`; `.env` unchanged). Added to the installer's compose project:

- `swarm-api` env: `AGENT_FS_API_URL=http://agent-fs:7433`, `COMB_ENABLED=true`, `EMBEDDING_API_BASE_URL=http://tei:80/v1`, `EMBEDDING_MODEL=nomic-ai/nomic-embed-text-v1.5`, `EMBEDDING_DIMENSIONS=768`, `EMBEDDING_API_KEY=<dummy>`, `DESPLEGA_TELEMETRY_ENV=onboarding-qa` (QA tagging only, not part of the product change), and `depends_on` agent-fs + tei healthy.
- `agent-fs` service: `ghcr.io/desplega-ai/agent-fs:0.18.5`, `AGENT_FS_STORAGE_PROVIDER=local`, `AGENT_FS_LOCAL_ROOT=/data/storage`, `EMBEDDING_PROVIDER=local`, named volume `agent_fs_data:/data`, node-fetch healthcheck, no ports published, no MinIO.
- `tei` service: `cpu-1.9.4`, `command: [--model-id, nomic-ai/nomic-embed-text-v1.5, --max-batch-tokens, "2048"]`, named volume `tei_data:/data`, curl healthcheck.

Results (run 2, fresh volumes, first boot with 768):

| Check | Result |
|---|---|
| Time `compose up` to api + agent-fs + tei healthy | **80 s** (images cached; includes 331 MB gemma + 1.1 GB TEI model downloads) |
| Seeder | `[seed:agent-fs-provision] created=1 failed=0` on the API's first boot. Org, drive (`AGENT_FS_DEFAULT_*`, `AGENT_FS_SHARED_ORG_ID`), and 11 agent-scoped `AGENT_FS_API_KEY` secrets (as workers register) all present. Admin account email `agent-fs-admin-swarm@swarm.local` |
| `GET /api/fs/capabilities` | `providerId agent-fs`, signedUrl supported, search/comments/versioning true |
| Memory semantic search | 12 notes via `POST /api/memory/index`, 6 paraphrase queries: all return the right note first or second, `retrievalSource` `hybrid`/`vec` |
| agent-fs semantic search | 20 files written with the lead's agent key (all 200) in 8-10 s, first `vec-search` hit right after. 7 paraphrase queries: correct file ranked #1 in 7/7 (`vec-search` scores 0.67-0.81; the hybrid `search` op also #1 in 6/7, and for "how do I publish a new version" it ranked `roadmap.md` first and `release.md` not in the top 3) |
| `GET /api/comb/status` | 404 (route does not exist on 2.5.4; I did not look for the right one) |

`docker stats --no-stream` (run 2):

| Container | Idle | Peak while embedding |
|---|---|---|
| swarm-api | 339 MiB | 346 MiB |
| swarm-agent-fs | 281 MiB | 334 MiB, cpu 159-192% for the 20 writes |
| swarm-tei | 654 MiB | 659 MiB (batch of short texts), 765 MiB at the heaviest standalone load |
| swarm-lead / each worker | 150-200 MiB | n/a |
| 11 agents total | about 1.8 GiB | |

`free -m` with everything running and idle: total 7745, used 3348, available 4383 (page cache 4.4 GB). Before the bundle (api + 11 agents only): used 2307. So the bundle costs about **1.0 GB RAM at idle** (tei 654 + agent-fs 281 + api growth 150) and **about 2.2 GB of image disk plus 1.5 GB of volumes** (agent-fs image 1.85 GB, TEI 685 MB, models 331 MB + 1.1 GB). Hetzner 8 GB boxes are fine. A 4 GB box would be tight with the `full` preset (3.3 GB used) once TEI is added, even before agent CPU work.

## What the plan must do

1. Add `agent-fs` and `tei` service blocks to the onboard compose generator (not only env). Pin `agent-fs:0.18.5` (same as the example compose) and `text-embeddings-inference:cpu-1.9.4`. Use a node-fetch healthcheck for agent-fs (no curl/wget) and curl for TEI.
2. TEI command MUST include `--max-batch-tokens 2048` (the default OOMs an 8 GB host). Consider also a `mem_limit` of 2 GB on tei to protect the other containers.
3. Write `EMBEDDING_DIMENSIONS=768` (and the other EMBEDDING_* envs) into `.env`/compose BEFORE the first `up`. Add a startup check or log line when `memory_vec` dimension differs from `EMBEDDING_DIMENSIONS` (today it is a silent FTS fallback). Existing installs stay untouched.
4. Do not build an `openai-compat` agent-fs provider on the strength of this spike: agent-fs local (`embeddinggemma-2`, CPU, in-process) indexes small files in well under a second each, ranks paraphrases correctly, and needs only ~280-330 MiB. Revisit only if sharing one model is a hard product goal. If TEI stays for swarm memory only, size it at ~1 text/s for 370-token documents on 4 shared vCPUs: bulk re-embeds (boot-reembed, backfills) will be slow and compete with agents. Note the 28 seeded scripts embedded during boot with no visible harm.
5. Add nomic task prefixes (`search_document:` / `search_query:`) in the swarm embedding client if nomic is used; the current client sends none. My toy eval ran without them and still ranked correctly, but the model card requires them.
6. The ORT backend of TEI fails on this model's `config.json` and TEI downloads both ONNX and safetensors. Volume is 1.1 GB for a 547 MB model. If first-boot download size matters, test a pre-seeded volume or `--model-id` of a safetensors-only mirror (not tested).
7. No step needs `AGENT_FS_API_URL` on workers.

## Teardown

`box.sh down afo-x86` ran at 02:3x BCN. `hcloud server list` shows only `taras-ts-1` (not mine, untouched). Hetzner firewall list shows only `taras-ts-1-fw` (not mine). Local `/tmp/onboarding-qa-afo-x86` and `/tmp/afo-spike-box-x86` removed. No DNS records were created (tunnel mode). Nothing left running.

## Files

`docker-compose.override.before.yml`, `docker-compose.override.after.yml`, `override.diff`, `bench.py`, `try.sh`, `verify.sh`, `s2-*.txt` (TEI), `verify-run1-512dim-vec-table.txt` (vec table bug, FTS fallback), `verify-run2-fresh-768.txt` (working), `final-stats.txt`. No keys were written: scripts read keys on the box and print only lengths.
