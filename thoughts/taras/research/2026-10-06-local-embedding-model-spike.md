---
date: 2026-10-06T13:55:00+02:00
researcher: Claude
git_commit: d317add096e8d7b372d11194e27b76550e8512f3
branch: main
repository: agent-swarm
topic: "Local embedding model for installs with no embedding API key: codebase map, runtime spike, quality eval"
tags: [research, memory, embeddings, onboarding, node-llama-cpp, docker, spike, eval]
status: complete
autonomy: verbose
last_updated: 2026-10-06
last_updated_by: Claude
---

# Research: local embedding model for installs with no embedding API key

**Date**: 2026-10-06
**Researcher**: Claude
**Git Commit**: d317add09
**Branch**: main

## Research Question

Can the swarm run an embedding model locally when the operator gives no embedding API key, for example in `/setup`?
The research covers three parts:

1. A map of the code that a local model touches (sections 1 to 9).
2. A spike: `node-llama-cpp` plus a GGUF model inside the published API image, on linux arm64 and x64 (section 10).
3. A retrieval-quality eval of local models against `text-embedding-3-small@512` on the prod memory corpus (section 11).

Design direction given by Taras (recorded as input, not evaluated here): a small isolated package owns local embeddings, it is easy to turn on and off, the model downloads lazily, and the model runs outside the API event loop.

## Summary

The API image can run a local embedding model today without an image change.
The published image ships a real `bun` binary (`Dockerfile:93`) and glibc 2.36.
The `node-llama-cpp` 3.22.1 prebuilt CPU binary loaded on linux arm64 and linux x64 with `build: "never"`, so no cmake build ran.
It worked through the shipped `bun` and through the compiled API binary run as Bun (`BUN_BE_BUN=1`).
A direct `import()` inside a compiled binary failed on both architectures.

On a Hetzner cpx22 (2 vCPU, 4 GB), `nomic-embed-text-v1.5` Q8 embedded 134 tokens in 198 ms and 1,037 tokens in 1.8 s.
Peak RSS was 306 MB with a 512-token context and 610 MB with a 2,048-token context.
`embeddinggemma-300m` Q8 peaked at 710 MB and 2,567 MB for the same two context sizes.

Two library defaults produce bad results with no error.
The default batch size (512) returns a wrong vector for any longer input.
The default thread count was 10 times slower on the 2 vCPU server, and about 200 times slower under a 2 CPU container quota.

The code has one embedding provider and one factory, so the seam is narrow.
Four as-is facts shape any local provider: the vector width is fixed at 512, `isConfigured()` means "an API key exists", the interface has no query or document role, and no code re-embeds rows when the model changes.

On the prod corpus (17,890 memories), with vectors cut to 512 dims, both local models scored at or above `text-embedding-3-small@512` on synthetic queries and on LLM-judged real tasks.
Judged vec P@5 useful was 0.362 for the baseline, 0.407 for nomic, and 0.417 for embeddinggemma.
Without the model-card task prefixes, nomic lost 0.086 hit@5 on task-style queries.

## Detailed Findings

### 1. Embedding provider seam

- `EmbeddingProvider` has `name`, `dimensions`, `embed(text)`, `embedBatch(texts)`, and `isConfigured()` (`src/be/memory/types.ts:7-14`). It has no query or document role, and no init, warmup, or dispose hook.
- `getEmbeddingProvider()` is a memoized singleton that always builds `OpenAIEmbeddingProvider` (`src/be/memory/index.ts:6-13`). `resetEmbeddingProvider()` clears it (`index.ts:23-25`). Its only non-test caller is the config reload (`src/http/core.ts:174`).
- `OpenAIEmbeddingProvider` reads its key once in the constructor: `EMBEDDING_API_KEY ?? OPENAI_API_KEY` (`src/be/memory/providers/openai-embedding.ts:20`). `isConfigured()` is `!!this.apiKey` (`:31-33`).
- `embed` and `embedBatch` return `null` on a missing key, empty text, a dimension mismatch, or any error (`:45-123`). They never throw.
- `EMBEDDING_API_BASE_URL` already points the provider at any OpenAI-compatible endpoint (`:39`).
- Env read timing differs per key. Key and model are read at provider construction. `EMBEDDING_DIMENSIONS` is read once at module load (`src/be/memory/constants.ts:97`).

Call sites (all in the API process):

| Kind | Sites | On `null` |
|---|---|---|
| Query, inline in the request | `src/tools/memory-search.ts:120-126`, `src/http/memory.ts:905-910`, `src/http/memory.ts:1024-1031`, `src/be/scripts/embeddings.ts:207-209` | Empty vector, store falls back to FTS or lexical match |
| Document, inline in the request | `src/tools/memory-edit.ts:185-187`, `src/http/memory.ts:1269-1271`, `src/be/memory/index-content.ts:74-94`, `src/tools/inject-learning.ts:75-79`, `src/be/scripts/embeddings.ts:79-104` | Row stays without a vector |
| Document, background | `src/be/memory/index-content.ts:144-160`, `src/tasks/task-terminal-effects.ts:40-101`, `src/http/memory.ts:1343-1378`, `src/be/memory/boot-reembed.ts`, `src/be/scripts/boot-reembed.ts:44-109` | Row skipped |
| `isConfigured()` only | `src/http/onboarding.ts:53`, `src/http/status.ts:429`, `src/http/core.ts:155,175` | n/a |

Config reload (`src/http/core.ts:149-232`): it records `isConfigured()` before and after it reloads env, and resets the provider.
Only an off-to-on change starts `runBootReembed()` and `runBootReembedScripts()` (`core.ts:187-197`).
A model, base URL, or dimension change with a key still set starts nothing.

Other places that assume a key:

- `src/telemetry.ts:296-298` reports `_hasEmbeddingKey` from the two env keys, not from the provider.
- `src/http/status.ts:424-443` shows the hint "Set OPENAI_API_KEY (or EMBEDDING_API_KEY)" when the provider is not configured.
- `src/be/memory/boot-reembed.ts:36-42` logs "no OpenAI key configured" when the probe embed returns `null`.

### 2. Vector storage and re-embedding

- `memory_vec` is a `vec0` table created at runtime with `embedding float[${EMBEDDING_DIMENSIONS}] distance_metric=cosine` (`src/be/memory/providers/sqlite-store.ts:315-320`). The default is 512. No code rebuilds the table when the constant changes.
- `updateEmbedding` always writes the blob and `embeddingModel` to `agent_memory`. It writes the `memory_vec` row only when the length equals `EMBEDDING_DIMENSIONS` (`sqlite-store.ts:1245-1269`).
- `search()` picks hybrid, then vec, then FTS, then a brute-force cosine scan (`sqlite-store.ts:530-605`). A query vector of the wrong length (including the empty vector used for `null`) selects the FTS path when query text exists.
- `embeddingModel` (migration `036_memory_ttl_staleness.sql:4`) is written by `updateEmbedding` and exposed in API and tool output. No code compares it with the current provider name. No SQL predicate filters on it.
- `provider.name` is `process.env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small"` (`openai-embedding.ts:26-28`).
- `runBootReembed` selects rows with `embedding IS NULL OR length(embedding) != VECTOR_BYTES` (`boot-reembed.ts:21`). It probes with `embed("test")`, then calls `embedBatch` in batches of 20 (`:56-65`). It sends the full stored `content`, not chunks.
- `POST` re-embed (`src/http/memory.ts:1343-1381`) re-embeds all rows in the background at a request-supplied batch size.
- Scripts: `script_embeddings` (migration 065) stores a blob of any length and `embeddingModel`. Search ranks in JS and skips rows whose length differs from the query (`src/be/scripts/embeddings.ts:201-232`). `runBootReembedScripts` handles missing and wrong-length rows (`src/be/scripts/boot-reembed.ts:44-109`).
- Text size reaching the embedder: `chunkContent` splits at 2,000 chars with 100 overlap (`src/be/chunking.ts:8-10`). Content under 50 chars, task-completion content, and boot re-embed content go to the embedder whole, with no length cap (`index-content.ts:63-71`).

### 3. `/setup` memory step

- Memory is step 5 of 7 (`src/be/onboarding.ts:10-18`). The step body is `StepMemory` (`apps/ui/src/pages/setup/steps/step-memory.tsx:205-215`). It renders `EmbeddingsSetup`, which the Memory integration page reuses (`apps/ui/src/components/integrations/memory-embeddings-section.tsx:12-24`).
- Presets are OpenAI, OpenRouter, Vercel AI Gateway, Azure, and Custom (`step-memory.tsx:85-162`). The comment at `:84` says: "R6: no Ollama preset. The stored vector size is fixed (EMBEDDING_DIMENSIONS)."
- The form has no Save button. It autosaves through `POST /api/onboarding/memory` (`src/http/onboarding.ts:97-109`).
- `handleMemoryProbe` builds its own `OpenAI` client and sends one embedding call with `dimensions: EMBEDDING_DIMENSIONS` and a 15 s timeout (`src/http/onboarding.ts:253-267`). It does not use `getEmbeddingProvider()`.
- The probe requires an API key. With no key it returns `errorClass: "auth"` (`:229-251`).
- An SSRF guard rejects `localhost` and private hosts unless `NODE_ENV` is `development` or `test`, or `ALLOW_PRIVATE_NETWORK_URLS=true` (`:216-227`).
- On success, `updateOnboardingMemory` writes `EMBEDDING_API_BASE_URL`, `EMBEDDING_MODEL`, and (as a secret) `EMBEDDING_API_KEY` to global `swarm_config`, then triggers the reload (`src/be/onboarding.ts:621-668`).
- Skip sets the step to `skipped` and changes no config (`src/be/onboarding.ts:542-550`). The skip hint reads "Memory stays off until you set it up." (`apps/ui/src/pages/setup/page.tsx:78-80`).
- Preset ids are a closed enum: `openai | openrouter | vercel | azure | custom | existing` (`src/be/onboarding.ts:233-241`).
- Progress reporting: step state holds only `status`, `at`, `method`, and `errorClass`. No step has a percentage or progress field. No step uses SSE or WebSocket.
- The one multi-step async flow is the Codex device login: start, then poll every 2 to 5 s, with flow state in KV (`apps/ui/src/pages/setup/steps/ai/codex-card.tsx:68-117`, `src/http/codex-oauth-device.ts:54-72`).

### 4. API image and runtime

- The image has two stages: `oven/bun:1.4.0` builder and `debian:bookworm-slim` runtime (`Dockerfile:5,77`).
- The server is one compiled binary: `bun build ./src/http.ts --compile` (`Dockerfile:74`), copied to `/usr/local/bin/agent-swarm-api`.
- The runtime stage also copies the real `bun` CLI to `/usr/local/bin/bun` (`Dockerfile:90-93`).
- Files that a child process or `dlopen` needs live on real disk, not in `/$bunfs/`: `vec0.so` (`Dockerfile:118`), script-runtime bundles (`Dockerfile:37-55`), migrations, TypeScript libs.
- Installed apt packages: `ca-certificates`, `wget`, `curl`, `jq`, `python3`, `fuse3`, `libfuse2` (`Dockerfile:81-88`). No compiler and no cmake.
- The container runs as root. `HOME` is not set.
- Persistent storage: `VOLUME /app/data` with `DATABASE_PATH=/app/data/agent-swarm-db.sqlite` (`Dockerfile:140,148`). Compose mounts `swarm_api_data:/app/data` (`docker-compose.example.yml:265`). The Helm chart mounts a 10Gi PVC there (`charts/agent-swarm/values.yaml:146-149`).
- `docker-compose.local.yml` mounts no API volume, so `/app/data` is an anonymous volume there.
- No compose file sets a memory or CPU limit on the API. The chart default is `api.resources: {}` (`values.yaml:128`).
- CI publishes `linux/amd64` and `linux/arm64` images (`.github/workflows/docker-and-deploy.yml:121,165`).
- `Dockerfile.worker:319-349` stubs `node-llama-cpp` and `onnxruntime-*` with `empty-npm-package` in the worker image. The comment gives their size as about 360 MB.

### 5. Child process patterns in the API

- `buildSandboxedCommand` wraps a command in `ulimit` limits and `env -i`, and adds `--no-orphans` to `bun` (`src/utils/sandboxed-process.ts:90-178`). The default virtual-memory limit is 512 MB, raised to 4096 MB for interpreters (`:58-75`).
- `registerProcessGroup` and `terminateProcessGroup` manage child lifetime, with a `process.once("exit")` kill as the last resort (`src/utils/process-group.ts:37-66,171`).
- One-shot children: the inline scripts runtime (`src/scripts-runtime/executors/native.ts:218-272`), the workflow `script` node (`src/workflows/executors/script.ts:203-216`), and the bounded DB query (`src/http/db-query-bounded.ts:246`).
- The only long-lived child is the script-workflow harness. It talks over a Unix socket and is stopped in `shutdown()` (`src/script-workflows/executor.ts:335-457`, `src/http/index.ts:485`).
- Entry scripts are found through env paths in compiled mode (`SCRIPT_RUNTIME_DIR`, `SCRIPT_WORKFLOW_RUNTIME_DIR`) and through `import.meta.url` in dev (`native.ts:165-169`, `executor.ts:58-70`).
- `db-query-bounded.ts:251-265` falls back to in-process when `bun` is not on `PATH`.
- No API code uses `new Worker`, Bun IPC, or `BUN_BE_BUN`.
- No API code downloads a file lazily on first use, and none verifies a download by sha256.

### 6. Packages and feature switches

Packages:

- Workspaces are `apps/ui`, `apps/templates-ui`, `apps/evals`, and `packages/*` (`package.json:59-64`). `bunfig.toml:12` sets `linker = "hoisted"`.
- `packages/model-catalog` and `packages/model-routing` are private, ESM, and source-only: `exports` points at `./src/index.ts`, with no build step. The root depends on them as `workspace:*` (`package.json:179-180`).
- Both Dockerfiles copy each package manifest before `bun install`, then the package source (`Dockerfile:15-23`, `Dockerfile.worker:35-43`). The compile step bundles the source into the binary.
- `packages/model-routing` has a dependency-cruiser rule that forbids imports from `src/`, `bun:sqlite`, and `fs` (`.dependency-cruiser.cjs:35-42`). It is the only package in `check:dep-graph` scope (`package.json:114`).
- Root `tsc:check` excludes `packages/` (`tsconfig.json:36-57`). The merge gate does not run the per-package `tsc` scripts.
- No existing package has a native, optional, or lazily downloaded dependency.

Switch patterns in use:

| Pattern | Example | Read | Restart |
|---|---|---|---|
| Env flag read per call | `MEMORY_HYBRID_SEARCH` (`src/be/memory/constants.ts:84-94`) | Each call | No |
| Lazy provider, reset on reload | Embedding provider (`src/be/memory/index.ts:6-25`), file storage (`src/fs/registry.ts:7-32`) | First use after reset | No |
| Flag plus a second condition, shown through `/status` | `COMB_ENABLED` (`src/utils/constants.ts:164-167`, `src/http/status.ts:704-732`) | Each call | No |
| Boot-only flag with lazy import | `HEARTBEAT_DISABLE` (`src/http/index.ts:766`) | Boot | Yes |

Operator-tunable keys are listed in `apps/ui/src/lib/configuration-catalog.ts` and validated in `VALIDATED_KEYS` (`src/be/swarm-config-guard.ts:205-421`). `EMBEDDING_MODEL` is in the catalog (`configuration-catalog.ts:239-247`).

### 7. Prior art: agent-fs local provider

- agent-fs ships a local provider: `node-llama-cpp` with `hf:nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0`, 768 dims (`agent-fs/packages/core/src/search/embeddings/local.ts:7-11`).
- It runs in the daemon process, with lazy init on first embed (`local.ts:18-42`). There is no child process.
- `resolveModelFile` downloads the model into `<AGENT_FS_HOME>/models` on first use (`local.ts:34-37`). The Docker image sets `AGENT_FS_HOME=/data` (`agent-fs/Dockerfile:37`).
- `embedBatch` loops over single calls (`local.ts:50-58`). No production code calls `dispose`.
- `local` is the default provider in config (`agent-fs/packages/core/src/config.ts:129-133`). Env keys for OpenAI and Gemini take priority (`embeddings/index.ts:39-80`).
- `node-llama-cpp` is a hard dependency, and the build marks it `--external` (`agent-fs/packages/cli/package.json:29,52`). The image runs `bun run packages/cli/dist/cli.js`, not a compiled binary (`agent-fs/Dockerfile:43`).
- No test or CI job exercises the local provider.
- An open question in agent-fs research asks whether `node-llama-cpp` loads in `oven/bun:1.4-slim` (`agent-fs/thoughts/taras/research/2026-08-21-sync-write-audit-raw-put.md:686-688`).
- A QA note records that the `node-llama-cpp` postinstall breaks `npm install -g` on Node 18.19 (`agent-fs/thoughts/taras/qa/2026-05-18-fuse-remote-mount.md:316-326`).

### 8. `node-llama-cpp` documented behavior

Sources: context7 `/withcatai/node-llama-cpp` and the repo on GitHub, read 2026-10-06, not pinned to a tag.

- Prebuilt packages exist for linux x64, arm64, armv7l, riscv64, and GPU variants (CUDA, Vulkan). The linux x64 package declares `libc: ["glibc"]`. No musl build is published. No minimum glibc version is documented.
- With no compatible prebuilt binary, `getLlama()` downloads llama.cpp and builds with cmake. `build: "never"` or `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true` turns that off.
- `createEmbeddingContext` takes `contextSize`, `batchSize`, and `threads`. `getEmbeddingFor` throws when the input reaches the context size. It has no truncation option.
- `getLlama({ maxThreads })`: with no GPU, the default is the CPU math core count or 4, whichever is higher.
- `resolveModelFile` and `createModelDownloader` accept `hf:` and `https:` URIs. They verify by file size only. No checksum option is documented.
- The docs state Bun support. They state nothing about Bun `--compile`. The Electron guide says to keep the package external and its native files on disk.
- The postinstall script checks the prebuilt binary and can start a source build. `NODE_LLAMA_CPP_POSTINSTALL=skip` disables it.
- Open upstream issues: #590 (segfault in batch embedding on arm64 Linux) and #554 (segfault on CPU fallback when the Vulkan prebuilt does not fit).

### 9. Model facts

File sizes and hashes come from the Hugging Face API on 2026-10-06. The LFS `oid` equals the sha256 of the file (checked for both downloaded files). Other columns come from search summaries of the model cards and are not checked against the full cards.

| Model | Params | Dims | Matryoshka dims | Context (GGUF) | License | GGUF size |
|---|---|---|---|---|---|---|
| `nomic-embed-text-v1.5` | 137M | 768 | 768, 512, 256, 128, 64 | 2,048 | Apache 2.0 (unconfirmed) | Q8_0 146.1 MB, Q4_K_M 84.1 MB |
| `embeddinggemma-300m` | 308M | 768 | 768, 512, 256, 128 | 2,048 | Gemma | Q8_0 333.6 MB (ggml-org) |
| `Qwen3-Embedding-0.6B` | 0.6B | 1,024 | 32 to 1,024 | 32k | Apache 2.0 | Q8_0 639 MB |
| `snowflake-arctic-embed-m-v1.5` | 109M | 768 | 256 documented | not found | Apache 2.0 | no official GGUF |

- sha256 `nomic-embed-text-v1.5.Q8_0.gguf`: `3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7`
- sha256 `nomic-embed-text-v1.5.Q4_K_M.gguf`: `d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac`
- sha256 `embeddinggemma-300M-Q8_0.gguf` (ggml-org): `b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63`

Task prefixes from the model cards:

- nomic: `search_query: ` for queries, `search_document: ` for documents.
- embeddinggemma: `task: search result | query: ` for queries, `title: none | text: ` for documents.

The nomic card reports MTEB 62.28 at 768 dims and 61.96 at 512 dims. The embeddinggemma card reports 69.67 at 768 and 69.18 at 512 (MTEB English v2).

### 10. Spike results

Setup:

- Image: `ghcr.io/desplega-ai/agent-swarm:latest` (arm64 build at revision a5f69b5cc, amd64 build at revision 535372e6a), Bun 1.4.0, glibc 2.36.
- Runtime: `node-llama-cpp@3.22.1`, installed inside the container with `bun add --linker=hoisted`.
- Model: `nomic-embed-text-v1.5` Q8_0 unless stated.
- Probe: `getLlama({ gpu: false, build: "never" })`, load model, create one embedding context, embed texts of 39 to 1,904 tokens.
- Hosts: linux/arm64 in OrbStack on Apple Silicon (10 cores), linux/amd64 under emulation on the same Mac, and two Hetzner cpx22 servers (2 vCPU AMD EPYC Genoa with AVX-512, 4 GB). Both servers were deleted after their runs.
- Scripts and raw output: `thoughts/taras/research/assets-2026-10-06-local-embedding/`.

#### 10.1 Load matrix

| Mode | linux/arm64 | linux/amd64 emulated | linux/amd64 cpx22 |
|---|---|---|---|
| Shipped `bun probe.ts` | ok, prebuilt | ok, prebuilt | ok, prebuilt |
| `BUN_BE_BUN=1 /usr/local/bin/agent-swarm-api run probe.ts` | ok, prebuilt | ok, prebuilt | ok, prebuilt |
| Compiled probe binary, `import()` of the on-disk package | fails | not run | fails |

- "prebuilt" is the library's own `buildType` value. No cmake build ran in any mode.
- The compiled-binary failure is `Cannot find package 'lifecycle-utils' imported from .../node-llama-cpp/dist/index.js`. The package is present in the same hoisted `node_modules`. The same failure occurred on macOS with Bun 1.4.2. A minimal two-package test (with and without an `exports` map) passed in the same image, so the cause is not identified.

#### 10.2 Batch size: the default context returns wrong vectors above 512 tokens

- `createEmbeddingContext()` with no options gave `contextSize` 2,048 and `batchSize` 512.
- With those defaults, an input over 512 tokens returned a vector with no error, but the vector was wrong.
- Check against an independent reference (the fp32 ONNX weights of `nomic-embed-text-v1.5`, mean pooling, no `node-llama-cpp`), on nine texts from the eval data:

| Context options | Texts under 512 tokens (8) | Text of 554 tokens (1) |
|---|---|---|
| Defaults (`batchSize` 512) | cosine 0.9986 to 0.9994 | cosine 0.68 |
| `contextSize: 2048, batchSize: 2048` | cosine 0.9986 to 0.9994 | cosine 0.9984 |

- embeddinggemma shows the same effect: cosine 0.53 between the two settings for a 539-token text.
- A string input and a pre-tokenized input gave identical vectors (cosine 1.0), so the library adds the BOS and EOS tokens in both cases.
- The first probe runs and the first eval run used the defaults. Their results for inputs over 512 tokens are kept only as `probe-results-default-batch512.jsonl`. All numbers below use `batchSize` equal to `contextSize`.
- agent-fs creates its context with the defaults (`agent-fs/packages/core/src/search/embeddings/local.ts:41`) and chunks at 900 tokens (`agent-fs/packages/core/src/search/chunker.ts:13`). agent-fs was not run in this spike.

#### 10.3 Latency

p50 in ms, one embedding context, cpx22, `contextSize` and `batchSize` 2,048:

| Model, limits, threads | 39 tok | 134 tok | 514 tok | 1,037 tok | 1,904 tok |
|---|---|---|---|---|---|
| nomic Q8, no limit, 2 threads | 71 | 198 | 794 | 1,804 | 3,961 |
| nomic Q8, 1 CPU, 1 thread | 132 | 401 | 1,453 | 3,232 | 7,417 |
| nomic Q4_K_M, no limit, 2 threads | 64 | 212 | 902 | 2,065 | 4,234 |
| nomic Q8, 512 MB container limit, 2 threads | 69 | 204 | 785 | 1,824 | 3,832 |
| embeddinggemma Q8, 3.5 GB limit, 2 threads | 63 | 264 | 1,226 | 1,776 | 3,576 |

Inputs up to 134 tokens are not affected by the batch size. These rows are from the first runs:

| Host, limits, threads | 39 tok | 134 tok |
|---|---|---|
| cpx22, no limit, library default (4 threads) | 679 | 716 |
| arm64, 2 CPUs, 2 threads | 27 | 107 |
| arm64, 1 CPU, 1 thread | 52 | 209 |
| arm64, 4 CPUs, 4 threads | 16 | 56 |
| arm64, 2 CPUs, library default (10 threads) | 5,584 | 4,890 |

- Eight concurrent calls of 134 tokens took 1,575 ms on the cpx22, against 198 ms for one. Calls on one context run in sequence.
- A smaller context does not change latency at a given input length (57 to 73 ms at 39 tokens, 175 to 198 ms at 134 tokens across context sizes 512, 1,024, and 2,048).
- For reference, the hosted `text-embedding-3-small@512` call measured p50 158 ms and p90 206 ms for short queries on 2026-09-25 (`scripts/embedding-eval/results/latency.md`).
- macOS with Metal: 17 ms per call at about 200 tokens (first probe, 3.17.1).

#### 10.4 Threads

- `os.availableParallelism()` and `navigator.hardwareConcurrency` followed the cgroup CPU quota (2 under `--cpus 2`).
- `os.cpus().length` and the library's `cpuMathCores` reported the host core count (10).
- The library default `maxThreads` was 10 under a 2 CPU quota, and 4 on the uncapped 2 vCPU server.

#### 10.5 Memory

Peak RSS in MB on the cpx22, 2 threads, by context size (`batchSize` equal to `contextSize`):

| Context size | nomic Q8 | embeddinggemma Q8 |
|---|---|---|
| After model load, before any embed | 247 to 264 | 535 to 538 |
| 512 | 306 | 710 |
| 1,024 | 389 | 1,127 |
| 2,048 | 610 | 2,567 |

- nomic Q4_K_M at context 2,048: 246 MB after load, 592 MB peak.
- RSS after `dispose` of context, model, and runtime: 139 to 163 MB for nomic, 255 to 281 MB for embeddinggemma.
- embeddinggemma at context 2,048 was killed under a 2 GB container limit.
- nomic at context 2,048 completed under a 512 MB container limit. Its RSS peak includes the memory-mapped model file.
- arm64 after model load: 373 to 381 MB for nomic Q8.

Cold start (model file already in the page cache): import 84 to 188 ms, `getLlama` 96 to 228 ms, model load 156 to 306 ms for nomic and about 1,050 ms for embeddinggemma, context creation 31 to 56 ms.

#### 10.6 Sizes on disk

| Item | Size |
|---|---|
| Default `bun add node-llama-cpp` on linux arm64 | 74 MB (`node-llama-cpp` 41 MB, `@node-llama-cpp/linux-arm64` 20 MB, 112 packages) |
| Default `bun add node-llama-cpp` on linux x64 | 723 MB (adds `linux-x64-cuda` 181 MB, `linux-x64-cuda-ext` 358 MB, `linux-x64-vulkan` 71 MB, `linux-arm64`, `linux-armv7l`) |
| x64 with `--omit=optional` plus `@node-llama-cpp/linux-x64` | 85 MB, 48.6 MB as `tar.gz` |
| nomic Q8 model | 146 MB |
| Published API image (arm64, `docker image inspect`) | 366 MB |

#### 10.7 Other observations

- Bun blocked the `node-llama-cpp` postinstall script by default. The runtime still loaded.
- Raw output vectors are not unit length. The L2 norm of one nomic vector was 22.4, and of one embeddinggemma vector 638.6.
- Both models report `trainContextSize` 2,048. A longer input throws `Input is longer than the usable context size`.
- The model download from Hugging Face to the Hetzner server took 2 s for 146 MB.
- On macOS, the first probe aborted in Metal teardown when the process exited without `dispose`. RSS there was 310 MB.
- Prod corpus size for scale: 17,890 memories and 11.2 million nomic tokens after the 2,048-token cap. 1,178 memories (6.6%) exceed the cap.

### 11. Retrieval-quality eval

Method:

- Harness: `scripts/embedding-eval/` from the 2026-09-25 research, plus a new `embed-local.ts` that embeds through `node-llama-cpp` and writes the same cache format.
- Corpus: 17,890 non-expired prod memories, exported read-only on 2026-10-06 with secrets scrubbed.
- Queries: 395 synthetic search-style, 395 synthetic task-style, and 471 real pre-task recalls. The query generator is `google/gemini-3-flash-preview`.
- Baseline: `text-embedding-3-small` at 512 dims (`oai-3s@512`), the prod setting.
- Local configs: `nomic-embed-text-v1.5` Q8 and `embeddinggemma-300m` Q8, each with the model-card task prefixes and without any prefix.
- Local vectors are stored at 768 dims. The scorer cuts them to the test width and applies L2 normalization, the same path as the hosted models.
- Local inputs are cut at 2,040 tokens. The baseline receives up to 24,000 chars. 1,178 corpus rows and 122 queries were cut for nomic.
- The local runs used the Mac with Metal. The Q8 GGUF output matched the fp32 reference at cosine 0.998 or higher (section 10.2).
- "Hybrid" is RRF of the vector arm and an FTS5 arm, as in prod, with no recency decay and no reranker.

Automatic metrics, hit@5, delta against `oai-3s@512`. `*` means the 95% bootstrap interval excludes zero.

Vector only:

| Config | Search-style (n=395) | Task-style (n=395) | Real pre-task (n=471) |
|---|---|---|---|
| oai-3s@512 | 0.704 | 0.668 | 0.454 |
| nomic-v15@512 | 0.732 (+0.028) | 0.661 (-0.008) | 0.403 (-0.051*) |
| nomic-v15@768 | 0.754 (+0.051*) | 0.651 (-0.018) | 0.403 (-0.051*) |
| nomic-v15@256 | 0.719 (+0.015) | 0.623 (-0.046*) | 0.384 (-0.070*) |
| nomic-v15-noprefix@512 | 0.711 (+0.008) | 0.582 (-0.086*) | 0.384 (-0.070*) |
| gemma-300m@512 | 0.797 (+0.094*) | 0.722 (+0.053*) | 0.418 (-0.036*) |
| gemma-300m@768 | 0.818 (+0.114*) | 0.732 (+0.063*) | 0.418 (-0.036) |
| gemma-300m@256 | 0.759 (+0.056*) | 0.676 (+0.008) | 0.403 (-0.051*) |
| gemma-300m-noprefix@512 | 0.722 (+0.018) | 0.671 (+0.003) | 0.420 (-0.034) |

Hybrid:

| Config | Search-style | Task-style | Real pre-task |
|---|---|---|---|
| oai-3s@512 | 0.800 | 0.514 | 0.590 |
| nomic-v15@512 | 0.813 (+0.013) | 0.577 (+0.063*) | 0.550 (-0.040*) |
| nomic-v15-noprefix@512 | 0.803 (+0.003) | 0.516 (+0.003) | 0.554 (-0.036*) |
| gemma-300m@512 | 0.820 (+0.020) | 0.539 (+0.025) | 0.554 (-0.036*) |
| gemma-300m-noprefix@512 | 0.835 (+0.035*) | 0.547 (+0.033) | 0.561 (-0.030) |

- The "real pre-task" positives are memories that prod recalled with `text-embedding-3-small` and that were rated positively. That label set favors the baseline. The judged stage below removes that bias.

LLM-judged real tasks (120 real pre-task queries, top 5 per config, 2,211 judged pairs, judge `anthropic/claude-haiku-4.5`):

| Config | Vec P@5 useful | Vec nDCG@5 | Hybrid P@5 useful | Hybrid nDCG@5 |
|---|---|---|---|---|
| oai-3s@512 | 0.362 | 0.531 | 0.397 | 0.577 |
| oai-3s@1536 | 0.367 (+0.005) | 0.541 (+0.010) | 0.413 (+0.017*) | 0.592 (+0.015) |
| nomic-v15@512 | 0.407 (+0.045*) | 0.563 (+0.032) | 0.430 (+0.033*) | 0.611 (+0.034) |
| nomic-v15-noprefix@512 | 0.408 (+0.047*) | 0.573 (+0.042) | 0.440 (+0.043*) | 0.613 (+0.036) |
| gemma-300m@512 | 0.417 (+0.055*) | 0.630 (+0.098*) | 0.423 (+0.027) | 0.614 (+0.038*) |

- "Any useful memory in the top 5" did not differ from the baseline for any config (vec 0.667 to 0.725 against 0.683).
- The baseline value differs from the September run (0.428 vec P@5 useful) because the corpus, the queries, and the judged pool are new.

Other measurements:

- Layer norm before truncation (the nomic model-card step) changed no nomic metric by more than 0.003.
- Cosine scale at 512 dims, synthetic queries:

| Config | Positive pair p50 | Random pair p50 |
|---|---|---|
| oai-3s@512 | 0.616 | 0.463 |
| nomic-v15@512 | 0.786 | 0.666 |
| gemma-300m@512 | 0.637 | 0.468 |

- The memory code uses fixed cosine thresholds (`minSimilarity()` default 0.1 in `src/be/memory/constants.ts:71-73`). nomic cosines sit in a higher and narrower band than the baseline.
- The first eval run used the default batch size and is invalid. For scale, it scored nomic-v15@512 at 0.562 on search-style vec hit@5, against 0.732 after the fix.
- Mac throughput with Metal: the 17,890-row corpus took 62 to 67 minutes per config with four configs sharing the GPU.
- Eval cost: about $6.30 (query generation $0.38, judge $5.87, baseline embedding under $0.10).

Where the eval files are:

- Harness: `scripts/embedding-eval/embed-local.ts` (new), with local model entries in `score.py` and `judge.ts`.
- Result files: `scripts/embedding-eval/results/local-2026-10-06/` (`models.json`, `models.md`, `judged.json`, `judged.md`). Copies of the two tables are in `thoughts/taras/research/assets-2026-10-06-local-embedding/`.
- The data cache (scrubbed prod export and vectors) is local scratch data and is not committed.

Commands (run from the repo root, after the export and query steps of the 2026-09-25 research):

```bash
# node-llama-cpp is not a repo dependency. Install it in a scratch directory.
mkdir -p /tmp/llama-runtime && cd /tmp/llama-runtime && bun add --linker=hoisted node-llama-cpp@3.22.1
export LLAMA_PKG=/tmp/llama-runtime/node_modules/node-llama-cpp/dist/index.js
export EMBED_EVAL_MODELS_DIR=/path/to/models   # nomic-v15-q8.gguf, embeddinggemma-300m-q8.gguf
bun scripts/embedding-eval/embed.ts oai-3s corpus,queries
bun scripts/embedding-eval/embed-local.ts nomic-v15 corpus,queries
bun scripts/embedding-eval/embed-local.ts gemma-300m corpus,queries
cd scripts/embedding-eval
EMBED_EVAL_OUT=$PWD/results/local-2026-10-06 uv run --no-project --with numpy --with regex score.py models nomic-v15,gemma-300m
EMBED_EVAL_OUT=$PWD/results/local-2026-10-06 bun judge.ts
```

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/be/memory/types.ts` | 7-14 | `EmbeddingProvider` interface |
| `src/be/memory/index.ts` | 6-25 | Provider factory and reset |
| `src/be/memory/providers/openai-embedding.ts` | 19-43 | Key, model, base URL, `isConfigured()` |
| `src/be/memory/constants.ts` | 97-99 | `EMBEDDING_DIMENSIONS`, default model name |
| `src/be/memory/providers/sqlite-store.ts` | 315-320 | `memory_vec` DDL with fixed width |
| `src/be/memory/providers/sqlite-store.ts` | 530-605 | Retrieval path selection |
| `src/be/memory/providers/sqlite-store.ts` | 1245-1269 | `updateEmbedding` writes blob, model name, vec row |
| `src/be/memory/boot-reembed.ts` | 21-65 | Re-embed predicate and batch loop |
| `src/http/core.ts` | 149-232 | Config reload, provider reset, off-to-on backfill |
| `src/http/onboarding.ts` | 198-292 | Memory probe |
| `src/be/onboarding.ts` | 621-668 | Memory config persistence |
| `apps/ui/src/pages/setup/steps/step-memory.tsx` | 84-162 | Presets and the R6 comment |
| `src/http/status.ts` | 424-443 | Embeddings setup milestone and hint |
| `Dockerfile` | 74, 90-93, 118, 136-148 | Compile step, shipped `bun`, `vec0.so`, data volume |
| `src/utils/sandboxed-process.ts` | 90-178 | Sandbox wrapper for child processes |
| `src/script-workflows/executor.ts` | 335-457 | The one long-lived child process |
| `src/http/db-query-bounded.ts` | 246-265 | `bun -e` child with in-process fallback |
| `.dependency-cruiser.cjs` | 35-42 | Purity rule for `packages/model-routing` |
| `Dockerfile.worker` | 319-349 | `node-llama-cpp` stubbed in the worker image |

## Open Questions

- Why does `import()` of `node-llama-cpp` fail inside a compiled Bun binary when the same package loads under `bun` and `BUN_BE_BUN=1`?
- Which glibc version is the minimum for the `node-llama-cpp` prebuilt binaries? The docs give no number.
- How does latency change on a cold disk, when the model file is not in the page cache?
- How does retrieval quality change with a context cap of 512 or 1,024 tokens? The eval used 2,040 tokens. The memory numbers in section 10.5 depend on this cap.
- Does the agent-fs local provider return wrong vectors for chunks over 512 tokens? The spike saw the effect in `node-llama-cpp`, but did not run agent-fs.
- Upstream issues #590 and #554 report segfaults. The spike saw none in about 150,000 embed calls on macOS and about 300 per Linux run.
- The nomic license and the model-card columns in section 9 come from search summaries, not from the full cards.

## Appendix

- **Architecture notes**: The API process is the sole owner of SQLite. All embedding calls run in that process today. The image already keeps a real `bun` on disk for child processes.
- **Historical context (from thoughts/)**:
  - R6 dropped the Ollama preset because the stored width is fixed and `nomic-embed-text` is natively 768 dims (`thoughts/taras/research/2026-09-24-ui-onboarding-experience.md:415`).
  - The 512 width dates from February 2026 and was chosen for cost and simplicity, without a benchmark (`thoughts/taras/research/2026-09-25-memory-embedding-model-dimensions-chunking.md:33`).
  - Earlier brainstorms mention a local provider as an idea: `thoughts/taras/brainstorms/2026-04-11-memory-ttl-staleness.md:125`, `thoughts/taras/brainstorms/2026-06-25-memory-system-enhancements.md:55`.
- **Related research**:
  - `thoughts/taras/research/2026-09-25-memory-embedding-model-dimensions-chunking.md`: hosted model, dimension, and chunking eval. Its `qwen3-8b` row is the 8B model over OpenRouter, not a small local model.
  - `thoughts/taras/research/2026-09-24-ui-onboarding-experience.md`: `/setup` design and the memory step.
  - `thoughts/taras/research/2026-06-25-memory-system.md`: memory system map.
