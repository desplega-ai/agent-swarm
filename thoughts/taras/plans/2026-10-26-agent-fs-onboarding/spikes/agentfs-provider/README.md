# Spike: agent-fs `openai-compat` embedding provider

Worktree: /Users/taras/worktrees/agent-fs/2026-10-26-afo-spike (branch spike/afo-openai-compat, base aecd4c8, uncommitted).
Files here: `provider.patch` (full diff incl. new files), `openai-compat-tests.spike.ts` (renamed from `openai-compat.test.ts` so the repo test run skips it), `live-check.py` (live driver, run on 2026-10-26).

## What changed (about 85 lines plus tests)
- New `packages/core/src/search/embeddings/openai-compat.ts`: `OpenAICompatEmbeddingProvider({baseURL, model, apiKey?, queryPrefix?, documentPrefix?})`.
  - Uses the `openai` SDK with explicit `baseURL`. Sends `encoding_format: "float"`. Sends no `dimensions`. `dimensions = 768` fixed.
  - Batches documents at 32 inputs (and 250k chars) via the existing `requestBatches`. Sorts by `index`.
  - No `supportsMime` / `embedParts`, so images and PDF pages are skipped.
  - `name = openai-compat-<sha256(model, queryPrefix, documentPrefix)[0:8]>`. The re-embed fingerprint (`<name>:v2`) therefore changes with model or prefix, and not with base URL. No change to embedding-migration.ts.
- `config.ts`: provider union and env cast widened; new env-only getter `getEmbeddingCompatSettings()` for `AGENT_FS_EMBEDDING_BASE_URL`, `AGENT_FS_EMBEDDING_QUERY_PREFIX`, `AGENT_FS_EMBEDDING_DOCUMENT_PREFIX`.
- `embeddings/index.ts`: `case "openai-compat"`. Throws (so the env wrapper logs once and returns null) when base URL or `EMBEDDING_MODEL` is missing. Key optional (`EMBEDDING_API_KEY`).

## Results
- New test file: 7 pass, 23 expects, ~60 ms. Fake server is `Bun.serve({port: 0})`. It asserts path `/v1/embeddings`, body exactly `{model, input, encoding_format:"float"}` (no `dimensions`), prefixes on every input, batches `[32,32,6]` for 70 docs, reversed responses re-sorted, `Authorization` header absent without a key and `Bearer <key>` with one, fingerprint changes with model/prefix and not with base URL, factory null on missing base URL or model.
- Regression: embedding-factory, config, embedding-migration, cli embedding-config, server embedding-errors: 160 pass, 0 fail (with new file). `bun run typecheck` clean.
- Live: agent-fs server from the worktree, local storage, `EMBEDDING_PROVIDER=openai-compat`, TEI at localhost:8091 (nomic-embed-text-v1.5), prefixes `search_query: ` / `search_document: `. 3 text files written, `vec-search` top hit correct for all 3 queries:
  - "how do I make pasta sauce" -> cooking.md 0.808 (next 0.419)
  - "memory safety in systems programming" -> rust.md 0.670 (next 0.377)
  - "walking up a mountain" -> hiking.md 0.666 (next 0.454)
  - Op latency 45-87 ms per search including the TEI call. All 3 files `indexed` within the 5 s wait.
  - Stored: `chunk_vectors` is `vec0(embedding float[768])`, `meta.embedding_format = openai-compat-6628a8f9:v2`. No `models/` dir was created, so nothing local was downloaded.

## TEI facts measured on cpu-1.9.4 (corrects the research doc)
- `/info`: `max_client_batch_size` is 256, not 32. `max_batch_requests` 4, `max_batch_tokens` 16384, `max_input_length` 8192, `auto_truncate` true. A 33-input request succeeded. The 32 cap in the provider is conservative, not required for this build. Keep it as a safe default (older TEI builds used 32) or raise it via an env if throughput matters.
- `encoding_format: "base64"` works but the SDK decode path is bypassed when set explicitly. Always send `float`.
- Sending `dimensions: 768` is accepted (ignored). Not needed.

## What the plan must do
1. Ship the provider as written: env-only config, explicit-only selection (implicit OPENAI/GEMINI order untouched), hashed name for the fingerprint.
2. Add doctor branch in `packages/cli/src/commands/config-cmd.ts:147-175` (not done in this spike), docs (DEPLOYMENT.md, docs/deployment.md, .env.example), and extend config.test.ts / embedding-migration.test.ts as listed in the research doc.
3. Compose passes `AGENT_FS_EMBEDDING_BASE_URL`, prefixes with empty defaults; TEI service needs a healthcheck and `depends_on: service_healthy` for agent-fs, because the boot warmup embeds one query.
4. Trap seen: empty-string `AGENT_FS_EMBEDDING_QUERY_PREFIX` is a valid "no prefix", so Compose defaults of empty are safe. `EMBEDDING_MODEL` must be set or the provider is silently off (logged once).
5. Use `@/` imports: index.ts now value-imports from config.js (was type-only). No cycle problem seen (typecheck and tests pass).
6. Release only after merge; then swarm bump PR must also touch package.json and bun.lock (see research doc).
